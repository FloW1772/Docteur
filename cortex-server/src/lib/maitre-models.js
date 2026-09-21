/**
 * MAÎTRE (defensive security) — data model. Deterministic validators for
 * SecurityEvent / Incident / Evidence. No system access, no adapters, no
 * actions here — MA-2 is data-model-only. Mirrors the enum-in-JS
 * convention already used by monitor-anomaly.js (SEVERITIES) and
 * monitor-config.js (REPORT_MODES/REPORT_FREQUENCIES/NOTIFY_MODES):
 * validated here, before a row is ever built, never as a SQL CHECK
 * constraint.
 *
 * Severity is intentionally never "MALWARE"/"ATTACK"/"COMPROMISED" — a
 * detector's free-text description MAY contain those words (they are
 * DATA, e.g. quoting an antivirus product's own label), but no
 * MAÎTRE-assigned severity value can ever be one of them. This is
 * enforced structurally: SEVERITIES below is the only closed set MAÎTRE
 * itself may assign.
 */
import crypto from 'node:crypto';

export class MaitreValidationError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'MaitreValidationError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new MaitreValidationError(code, detail);
}

// ── Enums ───────────────────────────────────────────────────────────────

export const SEVERITIES = Object.freeze(['INFO', 'OBSERVATION', 'SUSPICIOUS', 'HIGH', 'CRITICAL']);

// Forbidden as a severity VALUE specifically — never blocks these words
// from appearing inside free-text fields like description/summary/title,
// which are legitimately sourced from external detectors (e.g. Windows
// Defender's own threat name may literally be "Trojan:Win32/...").
const FORBIDDEN_SEVERITY_VALUES = new Set(['MALWARE', 'ATTACK', 'COMPROMISED', 'MALWARE_CONFIRMED', 'ATTACK_CONFIRMED']);

export const EVENT_SOURCES = Object.freeze([
  'observateur', 'windows-defender', 'windows-event-log', 'process-monitor',
  'persistence-monitor', 'integrity-monitor', 'firewall-monitor', 'maitre',
]);

export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);

export const INCIDENT_STATUSES = Object.freeze([
  'OPEN', 'INVESTIGATING', 'AWAITING_APPROVAL', 'CONTAINED', 'RESOLVED', 'DISMISSED',
]);

export const EVIDENCE_TYPES = Object.freeze([
  'PROCESS_SNAPSHOT', 'FILE_METADATA', 'FILE_HASH', 'DEFENDER_RESULT',
  'EVENT_LOG_EXCERPT', 'NETWORK_REFERENCE', 'PERSISTENCE_METADATA',
  'FIREWALL_STATE', 'DOCTEUR_INTEGRITY', 'OTHER',
]);

// Incident status transition graph — mirrors cyber-orchestrator.js's
// isValidCyberMissionTransition shape (FORWARD_EDGES/ESCAPE_EDGES,
// terminal states never leave). RESOLVED/DISMISSED are terminal.
const TERMINAL_STATUSES = new Set(['RESOLVED', 'DISMISSED']);

const FORWARD_EDGES = {
  // OPEN -> AWAITING_APPROVAL added in MA-7: a freshly-created incident
  // (MA-5 always creates OPEN, never auto-transitions) can go straight
  // to AWAITING_APPROVAL once an action proposal exists for it, without
  // forcing an artificial INVESTIGATING step first. INVESTIGATING
  // remains available as the manual "someone is looking into this"
  // state and is not required before a proposal can be made.
  OPEN: ['INVESTIGATING', 'AWAITING_APPROVAL', 'DISMISSED'],
  INVESTIGATING: ['AWAITING_APPROVAL', 'CONTAINED', 'RESOLVED', 'DISMISSED'],
  AWAITING_APPROVAL: ['CONTAINED', 'INVESTIGATING', 'DISMISSED'],
  CONTAINED: ['RESOLVED', 'INVESTIGATING'],
};

export function isValidIncidentTransition(fromStatus, toStatus) {
  if (!INCIDENT_STATUSES.includes(fromStatus)) return false;
  if (!INCIDENT_STATUSES.includes(toStatus)) return false;
  if (fromStatus === toStatus) return false;
  if (TERMINAL_STATUSES.has(fromStatus)) return false;
  return (FORWARD_EDGES[fromStatus] || []).includes(toStatus);
}

// ── Size bounds (defends against local DoS via oversized payloads, not
// a security boundary against a hostile actor with disk write access) ──

export const MAITRE_LIMITS = Object.freeze({
  TITLE_MAX: 200,
  SUMMARY_MAX: 5_000,
  DESCRIPTION_MAX: 2_000,
  METADATA_JSON_MAX: 32_000,
  EVIDENCE_METADATA_JSON_MAX: 32_000,
  TIMELINE_MAX_ENTRIES: 500,
  ARRAY_FIELD_MAX_ENTRIES: 200,
  SOURCE_MAX: 100,
  CATEGORY_MAX: 100,
  DETECTOR_ID_MAX: 100,
});

function assertNonEmptyString(value, field, maxLen) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${field}_required`, { field });
  if (value.length > maxLen) fail(`${field}_too_long`, { field, maxLen, actualLen: value.length });
  return value;
}

function assertBoundedJson(value, field, maxLen) {
  let serialized;
  try {
    serialized = JSON.stringify(value ?? {});
  } catch {
    fail(`${field}_not_serializable`, { field });
  }
  if (serialized.length > maxLen) fail(`${field}_too_large`, { field, maxLen, actualLen: serialized.length });
  return serialized;
}

function assertBoundedArray(value, field, maxEntries) {
  const arr = Array.isArray(value) ? value : [];
  if (arr.length > maxEntries) fail(`${field}_too_many_entries`, { field, maxEntries, actualLen: arr.length });
  return arr;
}

// Parses a JSON column back out gracefully — never throws on a corrupt
// row, always returns a safe fallback (mirrors getMeta()'s try/catch
// fallback convention in sqlite.js).
export function safeParseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ── SecurityEvent ────────────────────────────────────────────────────────

/**
 * Validates and normalizes a SecurityEvent creation input into the exact
 * row shape sqlite.js's insertMaitreEvent() expects. Throws
 * MaitreValidationError on any invalid field — never silently coerces a
 * bad enum to a default (unlike monitor-config.js's settings sanitizer,
 * which is allowed to clamp/default because it's user-editable
 * configuration; a SecurityEvent is evidence-adjacent and must fail
 * loudly on malformed input instead).
 */
export function buildSecurityEventRow(input) {
  if (!input || typeof input !== 'object') fail('event_input_required');

  const source = assertNonEmptyString(input.source, 'source', MAITRE_LIMITS.SOURCE_MAX);
  if (!EVENT_SOURCES.includes(source)) fail('event_source_invalid', { source });

  const category = assertNonEmptyString(input.category, 'category', MAITRE_LIMITS.CATEGORY_MAX);

  const severity = input.severity;
  if (!SEVERITIES.includes(severity)) fail('event_severity_invalid', { severity });
  if (FORBIDDEN_SEVERITY_VALUES.has(String(severity).toUpperCase())) fail('event_severity_forbidden', { severity });

  const confidence = input.confidence ?? 'medium';
  if (!CONFIDENCE_LEVELS.includes(confidence)) fail('event_confidence_invalid', { confidence });

  const detectorId = assertNonEmptyString(input.detectorId, 'detectorId', MAITRE_LIMITS.DETECTOR_ID_MAX);

  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (Number.isNaN(new Date(occurredAt).getTime())) fail('event_occurred_at_invalid', { occurredAt });

  const evidenceRefs = assertBoundedArray(input.evidenceRefs, 'evidenceRefs', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES);
  const subjectJson = assertBoundedJson(input.subject ?? {}, 'subject', MAITRE_LIMITS.METADATA_JSON_MAX);
  const metadataJson = assertBoundedJson(input.metadata ?? {}, 'metadata', MAITRE_LIMITS.METADATA_JSON_MAX);

  return {
    id: input.id ?? crypto.randomUUID(),
    created_at: new Date().toISOString(),
    occurred_at: occurredAt,
    source,
    category,
    severity,
    confidence,
    subject: subjectJson,
    evidence_refs: JSON.stringify(evidenceRefs),
    metadata: metadataJson,
    detector_id: detectorId,
    incident_id: input.incidentId ?? null,
  };
}

export function parseSecurityEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    occurredAt: row.occurred_at,
    source: row.source,
    category: row.category,
    severity: row.severity,
    confidence: row.confidence,
    subject: safeParseJson(row.subject, {}),
    evidenceRefs: safeParseJson(row.evidence_refs, []),
    metadata: safeParseJson(row.metadata, {}),
    detectorId: row.detector_id,
    incidentId: row.incident_id,
  };
}

// ── Incident ─────────────────────────────────────────────────────────────

export function buildIncidentRow(input) {
  if (!input || typeof input !== 'object') fail('incident_input_required');

  const title = assertNonEmptyString(input.title, 'title', MAITRE_LIMITS.TITLE_MAX);
  const summary = typeof input.summary === 'string' ? input.summary : '';
  if (summary.length > MAITRE_LIMITS.SUMMARY_MAX) fail('summary_too_long', { maxLen: MAITRE_LIMITS.SUMMARY_MAX });

  const severity = input.severity;
  if (!SEVERITIES.includes(severity)) fail('incident_severity_invalid', { severity });
  if (FORBIDDEN_SEVERITY_VALUES.has(String(severity).toUpperCase())) fail('incident_severity_forbidden', { severity });

  const status = input.status ?? 'OPEN';
  if (!INCIDENT_STATUSES.includes(status)) fail('incident_status_invalid', { status });

  const eventRefs = assertBoundedArray(input.eventRefs, 'eventRefs', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES);
  const evidenceRefs = assertBoundedArray(input.evidenceRefs, 'evidenceRefs', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES);
  const recommendations = assertBoundedArray(input.recommendations, 'recommendations', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES);
  const actionsProposed = assertBoundedArray(input.actionsProposed, 'actionsProposed', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES);
  const actionsExecuted = assertBoundedArray(input.actionsExecuted, 'actionsExecuted', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES);
  const timeline = assertBoundedArray(input.timeline, 'timeline', MAITRE_LIMITS.TIMELINE_MAX_ENTRIES);

  const now = new Date().toISOString();
  return {
    id: input.id ?? crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    status,
    severity,
    title,
    summary,
    event_refs: JSON.stringify(eventRefs),
    evidence_refs: JSON.stringify(evidenceRefs),
    recommendations: JSON.stringify(recommendations),
    actions_proposed: JSON.stringify(actionsProposed),
    actions_executed: JSON.stringify(actionsExecuted),
    timeline: JSON.stringify(timeline),
  };
}

export function parseIncidentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    eventRefs: safeParseJson(row.event_refs, []),
    evidenceRefs: safeParseJson(row.evidence_refs, []),
    recommendations: safeParseJson(row.recommendations, []),
    actionsProposed: safeParseJson(row.actions_proposed, []),
    actionsExecuted: safeParseJson(row.actions_executed, []),
    timeline: safeParseJson(row.timeline, []),
  };
}

/**
 * Validates a proposed incident update against the current row before
 * any DB write — status transitions must be structurally valid, and
 * only status/severity/summary/array-field appends are ever mutable
 * (title, created_at, id are permanently fixed at creation).
 */
export function buildIncidentUpdate(currentRow, updates) {
  if (!currentRow) fail('incident_not_found');
  const current = parseIncidentRow(currentRow);
  const fields = {};

  if (updates.status !== undefined && updates.status !== current.status) {
    if (!isValidIncidentTransition(current.status, updates.status)) {
      fail('incident_status_transition_invalid', { from: current.status, to: updates.status });
    }
    fields.status = updates.status;
  }

  if (updates.severity !== undefined) {
    if (!SEVERITIES.includes(updates.severity)) fail('incident_severity_invalid', { severity: updates.severity });
    if (FORBIDDEN_SEVERITY_VALUES.has(String(updates.severity).toUpperCase())) fail('incident_severity_forbidden', { severity: updates.severity });
    fields.severity = updates.severity;
  }

  if (updates.summary !== undefined) {
    if (typeof updates.summary !== 'string' || updates.summary.length > MAITRE_LIMITS.SUMMARY_MAX) {
      fail('summary_too_long', { maxLen: MAITRE_LIMITS.SUMMARY_MAX });
    }
    fields.summary = updates.summary;
  }

  for (const [inputKey, column, limit] of [
    ['eventRefs', 'event_refs', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES],
    ['evidenceRefs', 'evidence_refs', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES],
    ['recommendations', 'recommendations', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES],
    ['actionsProposed', 'actions_proposed', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES],
    ['actionsExecuted', 'actions_executed', MAITRE_LIMITS.ARRAY_FIELD_MAX_ENTRIES],
    ['timeline', 'timeline', MAITRE_LIMITS.TIMELINE_MAX_ENTRIES],
  ]) {
    if (updates[inputKey] !== undefined) {
      fields[column] = JSON.stringify(assertBoundedArray(updates[inputKey], inputKey, limit));
    }
  }

  return fields;
}

// ── Evidence ─────────────────────────────────────────────────────────────

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export function buildEvidenceRow(input) {
  if (!input || typeof input !== 'object') fail('evidence_input_required');

  const type = input.type;
  if (!EVIDENCE_TYPES.includes(type)) fail('evidence_type_invalid', { type });

  const source = assertNonEmptyString(input.source, 'source', MAITRE_LIMITS.SOURCE_MAX);

  if (input.sha256 !== undefined && input.sha256 !== null && !SHA256_PATTERN.test(input.sha256)) {
    fail('evidence_sha256_invalid');
  }

  const metadataJson = assertBoundedJson(input.metadata ?? {}, 'metadata', MAITRE_LIMITS.EVIDENCE_METADATA_JSON_MAX);

  return {
    id: input.id ?? crypto.randomUUID(),
    created_at: new Date().toISOString(),
    type,
    source,
    incident_id: input.incidentId ?? null,
    event_id: input.eventId ?? null,
    sha256: input.sha256 ?? null,
    metadata: metadataJson,
    redacted: input.redacted === false ? 0 : 1,
    integrity_hash: input.integrityHash ?? null,
  };
}

export function parseEvidenceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    type: row.type,
    source: row.source,
    incidentId: row.incident_id,
    eventId: row.event_id,
    sha256: row.sha256,
    metadata: safeParseJson(row.metadata, {}),
    redacted: row.redacted === 1,
    integrityHash: row.integrity_hash,
  };
}
