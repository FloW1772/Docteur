/**
 * MAÎTRE — persistence API (MA-2). Small, direct functions — no
 * repository abstraction, matching this repo's existing style
 * (cyber-orchestrator.js, monitor-orchestrator.js are themselves plain
 * function modules, not classes/repositories).
 *
 * This file is data-model-only: it validates input (maitre-models.js),
 * redacts evidence (maitre-evidence.js), and persists via sqlite.js's
 * maitre_* row functions. No Defender/Event Log/process/firewall
 * access, no child_process, no network, no Ollama, no cloud — those
 * belong to later MA phases.
 */
import {
  insertMaitreEvent, getMaitreEventById, listMaitreEvents, attachMaitreEventToIncident,
  purgeMaitreEventsOlderThan,
  insertMaitreIncident, getMaitreIncidentById, listMaitreIncidents, updateMaitreIncident,
  insertMaitreEvidence, getMaitreEvidenceById, listMaitreEvidenceForIncident,
} from './sqlite.js';
import {
  buildSecurityEventRow, parseSecurityEventRow,
  buildIncidentRow, parseIncidentRow, buildIncidentUpdate,
  buildEvidenceRow, parseEvidenceRow,
  MAITRE_LIMITS,
} from './maitre-models.js';
import { redactMaitreEvidenceMetadata, computeEvidenceIntegrityHash } from './maitre-evidence.js';

const LIST_LIMIT_MAX = 500;

function clampLimit(limit, fallback = 100) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, LIST_LIMIT_MAX);
}

function clampOffset(offset) {
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// ── SecurityEvent ────────────────────────────────────────────────────────

export function createSecurityEvent(input) {
  const row = buildSecurityEventRow(input);
  insertMaitreEvent(row);
  return parseSecurityEventRow(row);
}

export function getSecurityEvent(id) {
  return parseSecurityEventRow(getMaitreEventById(id));
}

export function listSecurityEvents({ limit = 100, offset = 0, incidentId = null } = {}) {
  const rows = listMaitreEvents({ limit: clampLimit(limit), offset: clampOffset(offset), incidentId });
  return rows.map(parseSecurityEventRow);
}

export function assignSecurityEventToIncident(eventId, incidentId) {
  if (!getMaitreEventById(eventId)) throw Object.assign(new Error('event_not_found'), { code: 'event_not_found' });
  if (!getMaitreIncidentById(incidentId)) throw Object.assign(new Error('incident_not_found'), { code: 'incident_not_found' });
  attachMaitreEventToIncident(eventId, incidentId);
  return getSecurityEvent(eventId);
}

// Retention helper only — no scheduler wired in MA-2 (per mission scope:
// "implémenter seulement le helper interne testable, pas de scheduler").
// Scope is strictly maitre_events; never touches monitor_*/cyber_audit_*.
export function purgeSecurityEventsOlderThan(days) {
  return purgeMaitreEventsOlderThan(days);
}

// ── Incident ─────────────────────────────────────────────────────────────

export function createIncident(input) {
  const row = buildIncidentRow(input);
  insertMaitreIncident(row);
  return parseIncidentRow(row);
}

export function getIncident(id) {
  return parseIncidentRow(getMaitreIncidentById(id));
}

export function listIncidents({ limit = 100, offset = 0, status = null } = {}) {
  const rows = listMaitreIncidents({ limit: clampLimit(limit), offset: clampOffset(offset), status });
  return rows.map(parseIncidentRow);
}

/**
 * Controlled incident update — status transitions validated against
 * the current row (never an arbitrary column set), array fields
 * replaced wholesale by the caller-supplied (already-intended) new
 * array rather than appended here, matching maitre-models.js's
 * buildIncidentUpdate contract. Throws on an invalid transition or
 * unknown incident id rather than silently no-oping.
 */
export function updateIncident(id, updates) {
  const currentRow = getMaitreIncidentById(id);
  if (!currentRow) throw Object.assign(new Error('incident_not_found'), { code: 'incident_not_found' });
  const fields = buildIncidentUpdate(currentRow, updates);
  const updatedRow = updateMaitreIncident(id, fields);
  return parseIncidentRow(updatedRow);
}

// ── Evidence ─────────────────────────────────────────────────────────────

/**
 * Always redacts metadata before persistence — createEvidence() never
 * accepts a caller-supplied "already redacted, trust me" bypass. This
 * matches cyber-evidence.js's own "schema does not re-redact, it trusts
 * the caller" contract inverted for safety: here the STORE itself is
 * the redaction boundary, since MAÎTRE evidence sources (process/file/
 * persistence metadata) are far more varied and less centrally produced
 * than Cyber Audit's single gateway chokepoint.
 */
export function createEvidence(input) {
  const redactedMetadata = redactMaitreEvidenceMetadata(input?.metadata);
  const integrityHash = computeEvidenceIntegrityHash(redactedMetadata);
  const row = buildEvidenceRow({ ...input, metadata: redactedMetadata, redacted: true, integrityHash });
  insertMaitreEvidence(row);
  return parseEvidenceRow(row);
}

export function getEvidence(id) {
  return parseEvidenceRow(getMaitreEvidenceById(id));
}

export function listEvidenceForIncident(incidentId, { limit = 200, offset = 0 } = {}) {
  const rows = listMaitreEvidenceForIncident(incidentId, { limit: clampLimit(limit, 200), offset: clampOffset(offset) });
  return rows.map(parseEvidenceRow);
}

export { MAITRE_LIMITS };
