/**
 * Evidence + finding persistence gateway for the Cyber Audit Agent
 * (SENTINEL V1, CA-5). This is the ONLY module allowed to write to the
 * cyber_audit_evidence/cyber_audit_findings tables — every caller (future
 * CA-6 crawler, CA-8 routes) must go through recordEvidence()/
 * recordFinding() here, never call sqlite.js's cyber-audit CRUD directly
 * for evidence/findings, so redaction can never be accidentally skipped.
 *
 * Hard rule enforced here, not merely documented: recordEvidence() ALWAYS
 * redacts headers/excerpt before they ever reach sqlite.js, regardless of
 * whether the caller already redacted. Redacting twice is idempotent and
 * harmless; skipping it once is not — so this module never trusts the
 * caller on that point, unlike sqlite.js's own comment which (correctly,
 * for its own layer) treats redaction as an upstream contract.
 *
 * Storage minimalism (mission requirement — "ne pas stocker
 * inutilement"): only a capped excerpt is ever persisted, never a full
 * response body; only a redacted header subset, never the full raw
 * header set (arbitrary target-controlled headers can carry data we have
 * no need to keep); no cookie value, no credential, no personal data
 * beyond what a security header/cookie-attribute observation requires.
 */

import crypto from 'node:crypto';
import {
  insertCyberAuditEvidence, getCyberAuditEvidenceById, getCyberAuditEvidenceForMission,
  upsertCyberAuditFinding, updateCyberAuditFindingStatus, getCyberAuditFindingById, getCyberAuditFindingsForMission,
} from './sqlite.js';
import { redactHeaders, redactBodyExcerpt } from './cyber-redact.js';
import { SEVERITY, CONFIDENCE } from './cyber-finding.js';

export const MAX_EXCERPT_LENGTH = 2000;

// Only these headers are ever relevant to CA-4's detectors and worth
// keeping as evidence — an explicit allowlist (not "everything except
// what we redact") so an unexpected target-controlled header can never
// bloat storage or leak something we didn't intend to keep at all.
//
// "authorization"/"www-authenticate" are kept (always redacted to
// "[REDACTED]" by redactHeaders before persistence, see below) because
// their mere PRESENCE is itself a meaningful fact for a report ("this
// endpoint requires authentication") — only their VALUE is ever secret.
const RELEVANT_HEADER_NAMES = [
  'strict-transport-security', 'content-security-policy', 'x-content-type-options',
  'referrer-policy', 'permissions-policy', 'x-frame-options',
  'cross-origin-opener-policy', 'cross-origin-resource-policy',
  'set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials',
  'server', 'x-powered-by', 'content-type', 'location',
  'authorization', 'www-authenticate',
];

function pickRelevantHeaders(headers) {
  if (typeof headers !== 'object' || headers === null) return {};
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const picked = {};
  for (const name of RELEVANT_HEADER_NAMES) {
    if (lower[name] !== undefined) picked[name] = lower[name];
  }
  return picked;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Records one piece of evidence for a mission. Always redacts headers and
 * excerpt before persisting, always truncates the excerpt, always computes
 * a sha256 of the (redacted, truncated) excerpt for integrity/dedup.
 *
 * @param {object} params
 * @param {string} params.missionId
 * @param {string} params.requestId - the cyber_audit_requests row id this evidence is attached to
 * @param {string} params.url
 * @param {string} params.method
 * @param {number|null} params.responseStatus
 * @param {object} params.headers - RAW headers as returned by the gateway (this function redacts them)
 * @param {string} [params.bodyExcerpt] - RAW body excerpt, if any (this function redacts + truncates it)
 * @returns {{id: string, sha256: string}}
 */
export function recordEvidence({ missionId, requestId, url, method, responseStatus = null, headers, bodyExcerpt = '' }) {
  if (typeof missionId !== 'string' || !missionId) throw new Error('evidence_mission_id_required');
  if (typeof requestId !== 'string' || !requestId) throw new Error('evidence_request_id_required');
  if (typeof url !== 'string' || !url) throw new Error('evidence_url_required');
  if (typeof method !== 'string' || !method) throw new Error('evidence_method_required');

  const relevantHeaders = redactHeaders(pickRelevantHeaders(headers));
  const truncated = typeof bodyExcerpt === 'string' && bodyExcerpt.length > MAX_EXCERPT_LENGTH
    ? `${bodyExcerpt.slice(0, MAX_EXCERPT_LENGTH)}\n[...tronqué...]`
    : (bodyExcerpt || '');
  const redactedExcerpt = redactBodyExcerpt(truncated);

  const id = crypto.randomUUID();
  const integrityHash = sha256(JSON.stringify({ url, method, relevantHeaders, excerpt: redactedExcerpt }));

  insertCyberAuditEvidence({
    id, mission_id: missionId, request_id: requestId, url, method,
    response_status: responseStatus, relevant_headers: relevantHeaders,
    excerpt: redactedExcerpt, sha256: integrityHash,
  });

  return { id, sha256: integrityHash };
}

export function getEvidenceById(id) {
  return getCyberAuditEvidenceById(id);
}

export function getEvidenceForMission(missionId) {
  return getCyberAuditEvidenceForMission(missionId);
}

/**
 * Verifies an evidence row's excerpt still matches its stored sha256 —
 * detects accidental/unexpected mutation of persisted evidence (evidence
 * rows have no UPDATE path in sqlite.js by design, but this gives an
 * explicit, testable integrity check rather than relying on that
 * omission alone).
 */
export function verifyEvidenceIntegrity(evidenceRow) {
  if (!evidenceRow) return false;
  const expected = sha256(JSON.stringify({
    url: evidenceRow.url, method: evidenceRow.method,
    relevantHeaders: evidenceRow.relevant_headers, excerpt: evidenceRow.excerpt,
  }));
  return expected === evidenceRow.sha256;
}

/**
 * Records (or, for a deterministic id already seen in this mission,
 * touches last_seen on) a finding produced by a CA-4 detector. The
 * detector's own `finding()` shape (cyber-finding.js) is translated to
 * the persistence shape here — this is the ONLY place a detector finding
 * becomes a database row.
 */
export function recordFinding({ missionId, finding }) {
  if (typeof missionId !== 'string' || !missionId) throw new Error('finding_mission_id_required');
  if (!finding || typeof finding !== 'object') throw new Error('finding_object_required');
  if (!SEVERITY.includes(finding.severity)) throw new Error(`invalid_severity:${finding.severity}`);
  if (!CONFIDENCE.includes(finding.confidence)) throw new Error(`invalid_confidence:${finding.confidence}`);
  if (finding.severity === 'CRITICAL' && finding.confidence !== 'HIGH') {
    throw new Error('critical_requires_high_confidence');
  }

  const outcome = upsertCyberAuditFinding({
    id: finding.id,
    mission_id: missionId,
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    asset: finding.asset,
    // "description" in the persisted shape corresponds to the detector's
    // combined observed+interpretation text — both are already
    // hedged/non-exploit-asserting by cyber-finding.js's own contract.
    description: finding.observed,
    evidence_ids: finding.evidenceIds || [],
    impact: finding.interpretation || '',
    recommendation: finding.recommendation || '',
    references: finding.references || [],
  });

  return { id: finding.id, outcome };
}

export function getFindingById(id, missionId) {
  return getCyberAuditFindingById(id, missionId);
}

export function getFindingsForMission(missionId) {
  return getCyberAuditFindingsForMission(missionId);
}

const VALID_STATUS_TRANSITIONS = {
  OPEN: new Set(['CONFIRMED', 'FALSE_POSITIVE', 'ACCEPTED_RISK']),
  CONFIRMED: new Set(['RESOLVED', 'ACCEPTED_RISK']),
  FALSE_POSITIVE: new Set(['OPEN']), // reopenable if judged wrong later
  ACCEPTED_RISK: new Set(['OPEN']), // reopenable if risk posture changes
  RESOLVED: new Set([]), // terminal
};

/**
 * Transitions a finding's status. Unlike cyber-policy.js's mission state
 * machine (which is enforced inside the policy layer), this workflow is
 * enforced here in the evidence/finding layer since findings are a
 * persistence-only concept with no network-safety implication — but the
 * same "explicit edges, no arbitrary jump" discipline applies.
 */
export function transitionFindingStatus(id, missionId, toStatus) {
  const current = getCyberAuditFindingById(id, missionId);
  if (!current) throw new Error('finding_not_found');
  const allowed = VALID_STATUS_TRANSITIONS[current.status];
  if (!allowed || !allowed.has(toStatus)) {
    throw new Error(`invalid_finding_transition:${current.status}->${toStatus}`);
  }
  const changed = updateCyberAuditFindingStatus(id, missionId, toStatus);
  return changed;
}
