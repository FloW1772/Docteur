/**
 * MAÎTRE — signal intake. The single entry point that turns every raw
 * source (Observateur SECURITY SIGNAL, Defender detection, Windows
 * Event, process/file/persistence observation) into a persisted
 * SecurityEvent, via the EXISTING pure converters (MA-3/MA-4) and the
 * EXISTING store (MA-2) — no second persistence layer, no new
 * validation format.
 *
 * READ-ONLY toward Observateur: this file only ever calls
 * getMonitorAnomalies() (an existing sqlite.js getter) to READ already-
 * persisted anomaly rows. It never writes to monitor_*, never imports
 * monitor-anomaly.js's internals, never becomes a second collector.
 *
 * Deduplication: every ingest function computes a deterministic
 * fingerprint (SHA-256 of source+detectorId+subject+time-bucket+
 * evidenceRef) and uses it AS the event's id. Re-ingesting the same
 * underlying signal twice collides on the same row id — the second
 * call is a no-op (returns the already-persisted event), never a
 * duplicate, and never an unhandled throw. No LLM, no fuzzy matching —
 * pure hashing.
 */
import crypto from 'node:crypto';
import { createSecurityEvent, getSecurityEvent } from './maitre-store.js';
import { MaitreValidationError, EVENT_SOURCES, SEVERITIES } from './maitre-models.js';
import { getMonitorAnomalies } from './sqlite.js';
import { defenderDetectionToSecurityEvent } from './maitre-defender-adapter.js';
import { windowsEventToSecurityEvent } from './maitre-eventlog-adapter.js';
import { processObservationToSecurityEvent } from './maitre-process-inspector.js';
import { fileObservationToSecurityEvent } from './maitre-file-inspector.js';
import { persistenceChangeToSecurityEvent } from './maitre-persistence-inspector.js';

// Fingerprint bucket: events within the same 5-minute window with the
// same (source, detectorId, subject, evidenceRef) collapse to one row.
// Coarser than the underlying poll interval of any source (Observateur
// polls every 10s by default) so a burst of identical signals within a
// short window naturally dedups; a genuinely new occurrence 5+ minutes
// later gets its own row (a fresh timestamp bucket), which is the
// intended "same event twice -> one persisted event, but a truly
// recurring event over time still gets tracked" behavior.
const DEDUP_BUCKET_MS = 5 * 60_000;

function timeBucket(occurredAt) {
  const ms = new Date(occurredAt ?? Date.now()).getTime();
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return Math.floor(safeMs / DEDUP_BUCKET_MS);
}

/**
 * Deterministic fingerprint — never includes a random UUID, never
 * calls an LLM. Stable ordering (JSON.stringify with sorted keys via a
 * simple replacer) so the same logical signal always hashes the same
 * way regardless of object key insertion order.
 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeEventFingerprint({ source, detectorId, subject, occurredAt, evidenceRefs }) {
  const bucket = timeBucket(occurredAt);
  const material = `${source}|${detectorId}|${stableStringify(subject ?? {})}|${bucket}|${stableStringify(evidenceRefs ?? [])}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * The one true ingestion path — validates via maitre-store.js's
 * existing buildSecurityEventRow (inside createSecurityEvent), assigns
 * the deterministic fingerprint as the row id, and persists. If a row
 * with that id already exists (same signal, same time bucket), returns
 * the EXISTING event rather than throwing or creating a duplicate.
 *
 * Invalid input (bad enum, missing field, oversized payload) is
 * rejected — this function surfaces the MaitreValidationError to the
 * caller rather than silently swallowing it, so a misbehaving adapter
 * is visible; callers that want "ignore safely" (per mission §4 for
 * raw external signals) should catch MaitreValidationError themselves
 * (see ingestObservateurSignal below, which does exactly that for the
 * less-trusted external signal shape).
 */
export function ingestSecurityEvent(eventInput) {
  const fingerprint = computeEventFingerprint({
    source: eventInput.source,
    detectorId: eventInput.detectorId,
    subject: eventInput.subject,
    occurredAt: eventInput.occurredAt,
    evidenceRefs: eventInput.evidenceRefs,
  });

  const existing = getSecurityEvent(fingerprint);
  if (existing) {
    return { event: existing, deduplicated: true };
  }

  const event = createSecurityEvent({ ...eventInput, id: fingerprint });
  return { event, deduplicated: false };
}

// ── Observateur SECURITY SIGNAL validation ────────────────────────────────

const OBSERVATEUR_CONFIDENCE_MAP = { low: 'low', medium: 'medium', high: 'high' };

/**
 * Validates the exact conceptual shape Observateur's monitor-anomaly.js
 * already produces: { source: 'observateur', category, severity,
 * confidence, evidenceRef }. Invalid data is REJECTED SAFELY (returns
 * null, never throws) — this consumes external-ish data (even though
 * it's from Docteur's own Observateur module, it crossed a module
 * boundary) so malformed input must degrade gracefully, not crash
 * intake for every other source.
 */
export function validateObservateurSignal(signal) {
  if (!signal || typeof signal !== 'object') return null;
  if (signal.source !== 'observateur') return null;
  if (typeof signal.category !== 'string' || signal.category.trim().length === 0) return null;
  // Observateur's own severities (OBSERVATION/SUSPICIOUS/REQUIRES_REVIEW)
  // are a DIFFERENT enum than MAÎTRE's (see OBSERVATEUR_SEVERITY_MAP
  // below) — validate against Observateur's set here, map afterward.
  if (!['OBSERVATION', 'SUSPICIOUS', 'REQUIRES_REVIEW'].includes(signal.severity)) return null;
  if (!OBSERVATEUR_CONFIDENCE_MAP[signal.confidence]) return null;
  if (signal.evidenceRef !== undefined && signal.evidenceRef !== null && typeof signal.evidenceRef !== 'object') return null;
  return signal;
}

// Observateur severity -> MAÎTRE severity. Documented, fixed, never an
// arbitrary escalation (mission §17): Observateur's REQUIRES_REVIEW
// (its strongest signal, reserved for its
// new-external-destination-from-docteur-component rule) maps to
// MAÎTRE's SUSPICIOUS, not HIGH/CRITICAL — a single Observateur signal
// alone never reaches HIGH/CRITICAL; only MA-5's correlation engine
// (multiple corroborating signals) can escalate further.
const OBSERVATEUR_SEVERITY_MAP = Object.freeze({
  OBSERVATION: 'OBSERVATION',
  SUSPICIOUS: 'SUSPICIOUS',
  REQUIRES_REVIEW: 'SUSPICIOUS',
});

/**
 * Pure conversion: a validated Observateur signal becomes a
 * SecurityEvent input. Not persisted here — ingestObservateurSignal
 * does that.
 */
export function observateurSignalToSecurityEvent(signal) {
  return {
    source: 'observateur',
    category: signal.category,
    severity: OBSERVATEUR_SEVERITY_MAP[signal.severity] ?? 'OBSERVATION',
    confidence: OBSERVATEUR_CONFIDENCE_MAP[signal.confidence] ?? 'low',
    occurredAt: new Date().toISOString(),
    subject: {},
    metadata: { evidenceRef: signal.evidenceRef ?? {} },
    detectorId: 'observateur',
  };
}

/**
 * Reads Observateur's already-persisted monitor_anomalies rows (via
 * the EXISTING getMonitorAnomalies getter — never a new query, never a
 * write) and ingests every row that carries a non-null security_signal
 * — the exact contract Observateur's own module comment documents
 * ("stored/displayed for a future MAITRE module to eventually
 * consume"). Malformed/invalid signals are skipped, not thrown.
 */
export function ingestObservateurSignals({ limit = 200 } = {}) {
  const anomalies = getMonitorAnomalies(limit);
  const results = [];

  for (const anomaly of anomalies) {
    if (!anomaly.security_signal) continue;

    let signal;
    try {
      signal = JSON.parse(anomaly.security_signal);
    } catch {
      continue; // malformed JSON — skip safely, never throw
    }

    const validated = validateObservateurSignal(signal);
    if (!validated) continue;

    const eventInput = observateurSignalToSecurityEvent(validated);
    // Anchor the fingerprint's time bucket to the anomaly's own
    // detected_at (not "now") so re-running this ingest against the
    // same anomaly rows is idempotent across process restarts.
    eventInput.occurredAt = anomaly.detected_at;
    eventInput.subject = { anomalyId: anomaly.id, ruleId: anomaly.rule_id, processName: anomaly.process_name, remoteAddress: anomaly.remote_address };

    try {
      results.push(ingestSecurityEvent(eventInput));
    } catch (err) {
      if (!(err instanceof MaitreValidationError)) throw err;
      // Reject-safely per mission §4 — a malformed anomaly row must
      // never take down intake for every other row.
    }
  }

  return results;
}

// ── Adapter-specific ingestion wrappers ──────────────────────────────────
// Each wraps an existing pure converter (MA-3/MA-4) + ingestSecurityEvent.
// No new validation format, no new severity enum, no system access.

export function ingestDefenderDetection(detection) {
  return ingestSecurityEvent(defenderDetectionToSecurityEvent(detection));
}

export function ingestWindowsEvent(event) {
  return ingestSecurityEvent(windowsEventToSecurityEvent(event));
}

export function ingestProcessObservation(process) {
  return ingestSecurityEvent(processObservationToSecurityEvent(process));
}

export function ingestFileObservation(inspectedFile) {
  return ingestSecurityEvent(fileObservationToSecurityEvent(inspectedFile));
}

export function ingestPersistenceChange(changeType, item) {
  return ingestSecurityEvent(persistenceChangeToSecurityEvent(changeType, item));
}

export { EVENT_SOURCES, SEVERITIES };
