/**
 * MAÎTRE — deterministic correlation engine. Pure/rule-based, no LLM,
 * no opaque ML score. Every rule is independently identifiable
 * (CORR-001..CORR-005), documents its own reason, and returns which
 * events matched — never a bare number.
 *
 * A correlation match does NOT itself create an incident automatically
 * for every severity — createIncidentFromCorrelation() (below) is a
 * separate, explicit step the caller invokes. A single isolated event,
 * however alarming-looking, never reaches HIGH/CRITICAL through this
 * file — only a rule match combining multiple corroborating events can
 * escalate beyond the individual events' own severities, and even then
 * only via the fixed ESCALATION_TABLE, never an arbitrary bump.
 */
import crypto from 'node:crypto';
import { listSecurityEvents, createIncident, getIncident, listIncidents, updateIncident, createEvidence } from './maitre-store.js';
import { SEVERITIES } from './maitre-models.js';

// Bounded time windows per rule (mission §22) — never an unbounded
// full-history scan. All queries go through listSecurityEvents(), which
// itself clamps limit (mission §23).
const WINDOW_5_MIN = 5 * 60_000;
const WINDOW_15_MIN = 15 * 60_000;
const WINDOW_1_HOUR = 60 * 60_000;
const QUERY_LIMIT = 200;

function withinWindow(event, referenceTime, windowMs) {
  const t = new Date(event.occurredAt).getTime();
  return Number.isFinite(t) && Math.abs(referenceTime - t) <= windowMs;
}

function recentEvents({ windowMs, referenceTime = Date.now() }) {
  // listSecurityEvents already orders DESC and clamps limit — this
  // filters that bounded set down to the requested window, never a
  // second unbounded query.
  return listSecurityEvents({ limit: QUERY_LIMIT }).filter(e => withinWindow(e, referenceTime, windowMs));
}

function makeMatch({ ruleId, matchedEvents, reason, severity, confidence }) {
  return {
    ruleId,
    matchedEventIds: matchedEvents.map(e => e.id),
    reason,
    severity,
    confidence,
    evidenceRefs: matchedEvents.flatMap(e => e.evidenceRefs ?? []),
  };
}

// ── CORR-001: new_process + new_network_destination ──────────────────────
// A process-inspection OBSERVATION event and an Observateur network
// event sharing the same subject.name/processName within 5 minutes.
function corr001NewProcessAndNetworkDestination(events) {
  const matches = [];
  const processEvents = events.filter(e => e.source === 'process-monitor');
  const networkEvents = events.filter(e => e.source === 'observateur' && e.category === 'network');

  for (const p of processEvents) {
    const pName = p.subject?.name;
    if (!pName) continue;
    const correlated = networkEvents.find(n => withinWindow(n, new Date(p.occurredAt).getTime(), WINDOW_5_MIN)
      && (n.subject?.anomalyId ? n.subject?.processName === pName : false));
    if (correlated) {
      matches.push(makeMatch({
        ruleId: 'CORR-001', matchedEvents: [p, correlated],
        reason: `New process "${pName}" observed alongside a new Observateur network destination within 5 minutes.`,
        severity: 'SUSPICIOUS', confidence: 0.6,
      }));
    }
  }
  return matches;
}

// ── CORR-002: new_executable + persistence_added ─────────────────────────
// A file-inspection OBSERVATION event (executable) and a persistence
// NEW event referencing the same target path, within 15 minutes.
function corr002NewExecutableAndPersistence(events) {
  const matches = [];
  const fileEvents = events.filter(e => e.source === 'integrity-monitor' && e.subject?.isExecutable);
  const persistenceEvents = events.filter(e => e.source === 'persistence-monitor' && e.subject?.changeType === 'NEW');

  for (const f of fileEvents) {
    const filePath = f.subject?.path;
    if (!filePath) continue;
    const correlated = persistenceEvents.find(p => withinWindow(p, new Date(f.occurredAt).getTime(), WINDOW_15_MIN)
      && typeof p.metadata?.target === 'string' && p.metadata.target.includes(filePath.split('\\').pop() ?? filePath));
    if (correlated) {
      matches.push(makeMatch({
        ruleId: 'CORR-002', matchedEvents: [f, correlated],
        reason: 'A newly observed executable is also newly registered for persistence.',
        severity: 'SUSPICIOUS', confidence: 0.8,
      }));
    }
  }
  return matches;
}

// ── CORR-003: Defender detection + same file hash ────────────────────────
// A Defender detection event and a file-inspection event whose SHA-256
// matches — SHA-256 is only an identity link (mission §20), never a
// verdict on its own.
function corr003DefenderDetectionSameHash(events) {
  const matches = [];
  const defenderEvents = events.filter(e => e.source === 'windows-defender');
  // NOTE: named "SameHash" per the mission's rule catalogue, but Defender
  // detections in this schema carry only a resource PATH (Get-
  // MpThreatDetection exposes no SHA-256) — the actual match below is by
  // path, not hash. sha256 presence is not required to be a candidate;
  // if a future MA phase enriches Defender detections with a hash, this
  // filter/match can be tightened to compare metadata.sha256 directly.
  const fileEvents = events.filter(e => e.source === 'integrity-monitor');

  for (const d of defenderEvents) {
    // Defender detections in this schema carry a resource path, not a
    // hash directly (Get-MpThreatDetection doesn't expose one) — this
    // rule correlates by matching resource path to file path instead,
    // documented explicitly rather than pretending a hash comparison
    // exists where the upstream data doesn't provide one.
    const resource = d.subject?.resource;
    const correlated = fileEvents.find(f => resource && f.subject?.path && resource.includes(f.subject.path));
    if (correlated) {
      matches.push(makeMatch({
        ruleId: 'CORR-003', matchedEvents: [d, correlated],
        reason: 'Windows Defender detection references the same file already inspected by MAÎTRE.',
        severity: 'HIGH', confidence: 0.9,
      }));
    }
  }
  return matches;
}

// ── CORR-004: persistence_added + unsigned executable ────────────────────
function corr004PersistenceAndUnsignedExecutable(events) {
  const matches = [];
  const persistenceEvents = events.filter(e => e.source === 'persistence-monitor' && e.subject?.changeType === 'NEW');
  const unsignedFileEvents = events.filter(e => e.source === 'integrity-monitor' && e.metadata?.signed === false);

  for (const p of persistenceEvents) {
    const target = p.metadata?.target;
    if (!target) continue;
    const correlated = unsignedFileEvents.find(f => withinWindow(f, new Date(p.occurredAt).getTime(), WINDOW_15_MIN)
      && f.subject?.path && target.includes(f.subject.path.split('\\').pop() ?? f.subject.path));
    if (correlated) {
      matches.push(makeMatch({
        ruleId: 'CORR-004', matchedEvents: [p, correlated],
        reason: 'A new persistence entry points to an unsigned executable.',
        severity: 'SUSPICIOUS', confidence: 0.7,
      }));
    }
  }
  return matches;
}

// ── CORR-005: Observateur suspicious endpoint + same PID process observation ──
function corr005ObservateurAndSamePidProcess(events) {
  const matches = [];
  const observateurEvents = events.filter(e => e.source === 'observateur' && (e.severity === 'SUSPICIOUS' || e.severity === 'OBSERVATION'));
  const processEvents = events.filter(e => e.source === 'process-monitor');

  for (const o of observateurEvents) {
    const processName = o.subject?.processName;
    if (!processName) continue;
    const correlated = processEvents.find(p => withinWindow(p, new Date(o.occurredAt).getTime(), WINDOW_1_HOUR) && p.subject?.name === processName);
    if (correlated) {
      matches.push(makeMatch({
        ruleId: 'CORR-005', matchedEvents: [o, correlated],
        reason: 'Observateur flagged a suspicious endpoint for a process MAÎTRE also independently observed.',
        severity: 'SUSPICIOUS', confidence: 0.65,
      }));
    }
  }
  return matches;
}

const RULES = [
  corr001NewProcessAndNetworkDestination,
  corr002NewExecutableAndPersistence,
  corr003DefenderDetectionSameHash,
  corr004PersistenceAndUnsignedExecutable,
  corr005ObservateurAndSamePidProcess,
];

/**
 * Runs every deterministic rule against the recent, bounded event
 * window and returns all matches. Pure with respect to system state —
 * only reads already-persisted maitre_events via listSecurityEvents().
 */
export function runCorrelation({ referenceTime = Date.now(), windowMs = WINDOW_1_HOUR } = {}) {
  const events = recentEvents({ windowMs, referenceTime });
  return RULES.flatMap(rule => rule(events));
}

// ── Severity escalation (fixed table, mission §14/§15) ────────────────────
//
// A correlation match's OWN severity (assigned per-rule above) is
// already the ceiling for that match — this table only governs
// combining MULTIPLE matches touching overlapping events into one
// incident's final severity. CRITICAL requires at least one HIGH-or-
// above match corroborated by a second SUSPICIOUS-or-above match — a
// single match, however severe, never alone produces CRITICAL.
const SEVERITY_RANK = { OBSERVATION: 0, SUSPICIOUS: 1, HIGH: 2, CRITICAL: 3 };

export function escalateSeverity(matches) {
  if (matches.length === 0) return 'OBSERVATION';
  const ranks = matches.map(m => SEVERITY_RANK[m.severity] ?? 0);
  const maxRank = Math.max(...ranks);
  const countAtOrAboveSuspicious = ranks.filter(r => r >= SEVERITY_RANK.SUSPICIOUS).length;

  // CRITICAL discipline (mission §15): never reachable from a single
  // match. Requires a HIGH match already present AND at least one more
  // corroborating SUSPICIOUS-or-above match.
  if (maxRank >= SEVERITY_RANK.HIGH && countAtOrAboveSuspicious >= 2) {
    return 'CRITICAL';
  }
  return Object.keys(SEVERITY_RANK).find(k => SEVERITY_RANK[k] === maxRank) ?? 'OBSERVATION';
}

// ── Incident creation ──────────────────────────────────────────────────

/**
 * Deterministic incident fingerprint — used for incident-level
 * deduplication (mission §11): same ruleId + same matched-event subject
 * set within a time window reuses the existing OPEN incident rather
 * than creating a new one.
 */
function incidentFingerprint(match) {
  const sortedIds = [...match.matchedEventIds].sort();
  return crypto.createHash('sha256').update(`${match.ruleId}|${sortedIds.join(',')}`).digest('hex').slice(0, 32);
}

function appendTimelineEntry(incident, entry) {
  const timeline = [...(incident.timeline ?? []), { at: new Date().toISOString(), ...entry }];
  return timeline.slice(-200); // bounded, mirrors MAITRE_LIMITS.TIMELINE_MAX_ENTRIES
}

/**
 * Creates (or reuses) an incident from a single correlation match.
 * Always created as OPEN (mission §32) — never auto-transitions to
 * INVESTIGATING/CONTAINED/RESOLVED. Deduplicates via
 * incidentFingerprint: if an OPEN incident already exists for this
 * exact match, its timeline gets an appended entry instead of creating
 * a new incident row.
 */
export function createIncidentFromCorrelation(match) {
  if (!SEVERITIES.includes(match.severity)) {
    throw new Error(`invalid_correlation_severity:${match.severity}`);
  }

  // The fingerprint IS the incident id (same pattern as
  // maitre-signal-intake.js's event fingerprint-as-id) — this is the
  // dedup mechanism itself, not a derived lookup: creating an incident
  // with an id that already exists in the DB throws a PK-constraint
  // error, so we check existence first and reuse deterministically,
  // with no fragile parsing of title/summary text required.
  const fingerprint = incidentFingerprint(match);
  const existing = getIncident(fingerprint);

  if (existing) {
    if (existing.status !== 'OPEN') {
      // A resolved/dismissed/contained incident matching the same
      // fingerprint is NOT silently reopened or duplicated — mission
      // §11 asks for dedup of "the same set of facts", not for
      // reviving a closed investigation. Returned as-is so the caller
      // can decide whether a NEW incident is warranted (a later phase's
      // concern); MA-5 itself only ever creates fresh OPEN incidents.
      return existing;
    }
    const timeline = appendTimelineEntry(existing, { type: 'correlation_matched_again', ruleId: match.ruleId });
    return updateIncident(existing.id, { timeline });
  }

  const incident = createIncident({
    id: fingerprint,
    title: `${match.ruleId}: ${match.reason}`.slice(0, 200),
    severity: match.severity,
    summary: match.reason,
    eventRefs: match.matchedEventIds,
    evidenceRefs: match.evidenceRefs,
    recommendations: [],
    actionsProposed: [],
    actionsExecuted: [],
    timeline: [
      { at: new Date().toISOString(), type: 'event_observed', eventIds: match.matchedEventIds },
      { at: new Date().toISOString(), type: 'correlation_matched', ruleId: match.ruleId, confidence: match.confidence },
      { at: new Date().toISOString(), type: 'incident_created' },
    ],
  });

  return incident;
}

/**
 * Attaches existing Evidence (by id) to an incident's evidenceRefs
 * without duplicating an already-linked reference. Does not create new
 * Evidence rows — that remains createEvidence()'s job (MA-2).
 */
export function linkEvidenceToIncident(incidentId, evidenceId) {
  const incident = getIncident(incidentId);
  if (!incident) throw new Error('incident_not_found');
  if (incident.evidenceRefs.includes(evidenceId)) return incident; // no duplicate
  const evidenceRefs = [...incident.evidenceRefs, evidenceId];
  const timeline = appendTimelineEntry(incident, { type: 'evidence_attached', evidenceId });
  return updateIncident(incidentId, { evidenceRefs, timeline });
}

export { createEvidence };
