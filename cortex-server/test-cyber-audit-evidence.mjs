// Persistence tests for the Cyber Audit Agent (SENTINEL V1, CA-5) —
// evidence, findings, redaction, duplicate handling, firstSeen/lastSeen,
// status workflow, DB isolation, and write-error handling.
// Run with: node --test test-cyber-audit-evidence.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { initSqlite, insertCyberAuditMission, insertCyberAuditRequest, getCyberAuditRequestsForMission } from './src/lib/sqlite.js';
import {
  recordEvidence, getEvidenceById, getEvidenceForMission, verifyEvidenceIntegrity, MAX_EXCERPT_LENGTH,
  recordFinding, getFindingById, getFindingsForMission, transitionFindingStatus,
} from './src/lib/cyber-evidence.js';
import { finding } from './src/lib/cyber-finding.js';

const TEST_DB_DIR = './data-test-cyber-audit';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedMission(id) {
  insertCyberAuditMission({ id, title: 'Test mission', client_name: 'Acme', authorization_reference: 'ref-1' });
  return id;
}

let missionCounter = 0;
function newMissionId() { return `mission-${++missionCounter}`; }

// ── Evidence persistence ───────────────────────────────────────────────

test('evidence persistence: recordEvidence stores and getEvidenceById retrieves an identical shape', () => {
  const missionId = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-1', mission_id: missionId, url: 'http://example.invalid/ok', method: 'GET', status: 200 });
  const { id, sha256 } = recordEvidence({
    missionId, requestId: 'req-1', url: 'http://example.invalid/ok', method: 'GET', responseStatus: 200,
    headers: { 'content-type': 'text/html' }, bodyExcerpt: '<html>hello</html>',
  });
  const stored = getEvidenceById(id);
  assert.ok(stored);
  assert.equal(stored.mission_id, missionId);
  assert.equal(stored.request_id, 'req-1');
  assert.equal(stored.url, 'http://example.invalid/ok');
  assert.equal(stored.response_status, 200);
  assert.equal(stored.sha256, sha256);
  assert.equal(stored.relevant_headers['content-type'], 'text/html');
});

test('evidence persistence: getEvidenceForMission returns all evidence rows for that mission only', () => {
  const missionA = seedMission(newMissionId());
  const missionB = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-a1', mission_id: missionA, url: 'http://x.invalid/a', method: 'GET' });
  insertCyberAuditRequest({ id: 'req-b1', mission_id: missionB, url: 'http://x.invalid/b', method: 'GET' });
  recordEvidence({ missionId: missionA, requestId: 'req-a1', url: 'http://x.invalid/a', method: 'GET', headers: {} });
  recordEvidence({ missionId: missionB, requestId: 'req-b1', url: 'http://x.invalid/b', method: 'GET', headers: {} });
  const evidenceA = getEvidenceForMission(missionA);
  assert.equal(evidenceA.length, 1);
  assert.equal(evidenceA[0].mission_id, missionA);
});

test('evidence: never stores a full response body — excerpt is capped at MAX_EXCERPT_LENGTH', () => {
  const missionId = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-big', mission_id: missionId, url: 'http://x.invalid/big', method: 'GET' });
  const hugeBody = 'x'.repeat(MAX_EXCERPT_LENGTH * 5);
  const { id } = recordEvidence({ missionId, requestId: 'req-big', url: 'http://x.invalid/big', method: 'GET', headers: {}, bodyExcerpt: hugeBody });
  const stored = getEvidenceById(id);
  assert.ok(stored.excerpt.length <= MAX_EXCERPT_LENGTH + 50); // + truncation marker
  assert.ok(stored.excerpt.includes('[...tronqué...]'));
});

test('evidence: only an explicit allowlist of headers is persisted — an unexpected target header is silently dropped, not stored', () => {
  const missionId = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-hdr', mission_id: missionId, url: 'http://x.invalid/h', method: 'GET' });
  const { id } = recordEvidence({
    missionId, requestId: 'req-hdr', url: 'http://x.invalid/h', method: 'GET',
    headers: { 'content-type': 'text/html', 'x-totally-unexpected-vendor-header': 'some-value' },
  });
  const stored = getEvidenceById(id);
  assert.ok(!('x-totally-unexpected-vendor-header' in stored.relevant_headers));
  assert.equal(stored.relevant_headers['content-type'], 'text/html');
});

// ── Evidence integrity hash ───────────────────────────────────────────────

test('evidence integrity hash: verifyEvidenceIntegrity returns true for an untouched row', () => {
  const missionId = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-int', mission_id: missionId, url: 'http://x.invalid/i', method: 'GET' });
  const { id } = recordEvidence({ missionId, requestId: 'req-int', url: 'http://x.invalid/i', method: 'GET', headers: { 'content-type': 'text/html' }, bodyExcerpt: 'hello' });
  const stored = getEvidenceById(id);
  assert.equal(verifyEvidenceIntegrity(stored), true);
});

test('evidence integrity hash: verifyEvidenceIntegrity detects a tampered excerpt', () => {
  const missionId = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-tamper', mission_id: missionId, url: 'http://x.invalid/t', method: 'GET' });
  const { id } = recordEvidence({ missionId, requestId: 'req-tamper', url: 'http://x.invalid/t', method: 'GET', headers: {}, bodyExcerpt: 'original' });
  const stored = getEvidenceById(id);
  const tampered = { ...stored, excerpt: 'MODIFIED' };
  assert.equal(verifyEvidenceIntegrity(tampered), false);
});

test('evidence integrity hash: verifyEvidenceIntegrity returns false for null/missing row without throwing', () => {
  assert.equal(verifyEvidenceIntegrity(null), false);
  assert.doesNotThrow(() => verifyEvidenceIntegrity(undefined));
});

// ── Secret redaction (enforced unconditionally, even if caller forgets) ──

test('secret redaction: recordEvidence redacts Authorization/Cookie/Set-Cookie/API keys/JWT even if the caller passes raw values', () => {
  const missionId = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-secret', mission_id: missionId, url: 'http://x.invalid/s', method: 'GET' });
  const { id } = recordEvidence({
    missionId, requestId: 'req-secret', url: 'http://x.invalid/s', method: 'GET',
    headers: {
      authorization: 'Bearer sk-abcdefghijklmno1234567890',
      'set-cookie': ['session_id=super-secret-value-123; Path=/; Secure'],
    },
    bodyExcerpt: 'Leaked token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U and key sk-abcdefghijklmnopqrstuvwxyz1234567890',
  });
  const stored = getEvidenceById(id);
  const serialized = JSON.stringify(stored);
  assert.ok(!serialized.includes('sk-abcdefghijklmno1234567890'));
  assert.ok(!serialized.includes('super-secret-value-123'));
  assert.ok(!serialized.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.equal(stored.relevant_headers.authorization, '[REDACTED]');
  assert.ok(stored.relevant_headers['set-cookie'][0].startsWith('session_id=[REDACTED];'));
  assert.ok(serialized.includes('[REDACTED_JWT]'));
});

test('secret redaction: cookie NAME and attributes remain legible after redaction (only the value is hidden)', () => {
  const missionId = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-cookie-attrs', mission_id: missionId, url: 'http://x.invalid/c', method: 'GET' });
  const { id } = recordEvidence({
    missionId, requestId: 'req-cookie-attrs', url: 'http://x.invalid/c', method: 'GET',
    headers: { 'set-cookie': ['tracking=abc123; Path=/; Domain=x.invalid; SameSite=Lax; Max-Age=3600'] },
  });
  const stored = getEvidenceById(id);
  const cookieOut = stored.relevant_headers['set-cookie'][0];
  assert.ok(cookieOut.startsWith('tracking=[REDACTED]'));
  assert.ok(cookieOut.includes('Path=/'));
  assert.ok(cookieOut.includes('Domain=x.invalid'));
  assert.ok(cookieOut.includes('SameSite=Lax'));
  assert.ok(cookieOut.includes('Max-Age=3600'));
});

// ── Finding persistence ────────────────────────────────────────────────

test('finding persistence: recordFinding stores a finding and getFindingById retrieves it', () => {
  const missionId = seedMission(newMissionId());
  const f = finding({
    id: 'f-headers-missing-hsts', title: 'Missing HSTS', category: 'headers', severity: 'MEDIUM', confidence: 'HIGH',
    asset: 'example.invalid', observed: 'no HSTS header', interpretation: 'downgrade risk', recommendation: 'add HSTS',
    evidence: ['ev-1'],
  });
  recordFinding({ missionId, finding: f });
  const stored = getFindingById('f-headers-missing-hsts', missionId);
  assert.ok(stored);
  assert.equal(stored.severity, 'MEDIUM');
  assert.equal(stored.status, 'OPEN');
  assert.deepEqual(stored.evidence_ids, ['ev-1']);
});

test('finding persistence: rejects a finding whose severity/confidence violate the CRITICAL-requires-HIGH invariant', () => {
  const missionId = seedMission(newMissionId());
  assert.throws(() => recordFinding({
    missionId,
    finding: { id: 'f-bad', title: 't', category: 'c', severity: 'CRITICAL', confidence: 'LOW', asset: 'a', observed: 'o', evidenceIds: [] },
  }), /critical_requires_high_confidence/);
});

// ── Finding ↔ evidence relation ────────────────────────────────────────

test('finding/evidence relation: a finding\'s evidenceIds reference real evidence rows retrievable from the same mission', () => {
  const missionId = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-rel', mission_id: missionId, url: 'http://x.invalid/r', method: 'GET' });
  const { id: evidenceId } = recordEvidence({ missionId, requestId: 'req-rel', url: 'http://x.invalid/r', method: 'GET', headers: {} });
  const f = finding({ id: 'f-rel', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o', evidence: [evidenceId] });
  recordFinding({ missionId, finding: f });
  const stored = getFindingById('f-rel', missionId);
  assert.deepEqual(stored.evidence_ids, [evidenceId]);
  const evidenceRow = getEvidenceById(stored.evidence_ids[0]);
  assert.ok(evidenceRow);
  assert.equal(evidenceRow.mission_id, missionId);
});

// ── Duplicate finding handling ─────────────────────────────────────────

test('duplicate handling: re-recording the same finding id for the same mission updates instead of duplicating', () => {
  const missionId = seedMission(newMissionId());
  const f1 = finding({ id: 'f-dup', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o', evidence: ['ev-a'] });
  const first = recordFinding({ missionId, finding: f1 });
  assert.equal(first.outcome, 'created');
  const f2 = finding({ id: 'f-dup', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o', evidence: ['ev-b'] });
  const second = recordFinding({ missionId, finding: f2 });
  assert.equal(second.outcome, 'updated');
  const all = getFindingsForMission(missionId).filter(f => f.id === 'f-dup');
  assert.equal(all.length, 1, 'must never create a second row for the same finding id');
  assert.deepEqual(all[0].evidence_ids.sort(), ['ev-a', 'ev-b']);
});

test('duplicate handling: the SAME finding id in a DIFFERENT mission is a separate row, not merged', () => {
  const missionA = seedMission(newMissionId());
  const missionB = seedMission(newMissionId());
  const f = finding({ id: 'f-shared-id', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o' });
  recordFinding({ missionId: missionA, finding: f });
  recordFinding({ missionId: missionB, finding: f });
  assert.ok(getFindingById('f-shared-id', missionA));
  assert.ok(getFindingById('f-shared-id', missionB));
});

// ── firstSeen / lastSeen ───────────────────────────────────────────────

test('firstSeen/lastSeen: first_seen is set on creation and never changes on a later touch; last_seen advances', async () => {
  const missionId = seedMission(newMissionId());
  const f = finding({ id: 'f-seen', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o' });
  recordFinding({ missionId, finding: f });
  const initial = getFindingById('f-seen', missionId);
  await new Promise(r => setTimeout(r, 10));
  recordFinding({ missionId, finding: f });
  const touched = getFindingById('f-seen', missionId);
  assert.equal(touched.first_seen, initial.first_seen);
  assert.ok(new Date(touched.last_seen).getTime() >= new Date(initial.last_seen).getTime());
});

// ── Status transitions ─────────────────────────────────────────────────

test('status workflow: OPEN -> CONFIRMED -> RESOLVED is a valid path', () => {
  const missionId = seedMission(newMissionId());
  const f = finding({ id: 'f-status-1', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o' });
  recordFinding({ missionId, finding: f });
  assert.equal(transitionFindingStatus('f-status-1', missionId, 'CONFIRMED'), true);
  assert.equal(getFindingById('f-status-1', missionId).status, 'CONFIRMED');
  assert.equal(transitionFindingStatus('f-status-1', missionId, 'RESOLVED'), true);
  assert.equal(getFindingById('f-status-1', missionId).status, 'RESOLVED');
});

test('status workflow: RESOLVED is terminal — no further transition is permitted', () => {
  const missionId = seedMission(newMissionId());
  const f = finding({ id: 'f-status-2', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o' });
  recordFinding({ missionId, finding: f });
  transitionFindingStatus('f-status-2', missionId, 'CONFIRMED');
  transitionFindingStatus('f-status-2', missionId, 'RESOLVED');
  assert.throws(() => transitionFindingStatus('f-status-2', missionId, 'OPEN'), /invalid_finding_transition/);
});

test('status workflow: an arbitrary jump (OPEN -> RESOLVED directly) is denied', () => {
  const missionId = seedMission(newMissionId());
  const f = finding({ id: 'f-status-3', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o' });
  recordFinding({ missionId, finding: f });
  assert.throws(() => transitionFindingStatus('f-status-3', missionId, 'RESOLVED'), /invalid_finding_transition/);
});

test('status workflow: FALSE_POSITIVE and ACCEPTED_RISK are both reopenable back to OPEN', () => {
  const missionId = seedMission(newMissionId());
  const f1 = finding({ id: 'f-status-4a', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o' });
  recordFinding({ missionId, finding: f1 });
  transitionFindingStatus('f-status-4a', missionId, 'FALSE_POSITIVE');
  assert.equal(transitionFindingStatus('f-status-4a', missionId, 'OPEN'), true);

  const f2 = finding({ id: 'f-status-4b', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o' });
  recordFinding({ missionId, finding: f2 });
  transitionFindingStatus('f-status-4b', missionId, 'ACCEPTED_RISK');
  assert.equal(transitionFindingStatus('f-status-4b', missionId, 'OPEN'), true);
});

test('status workflow: transitioning a non-existent finding throws finding_not_found', () => {
  const missionId = seedMission(newMissionId());
  assert.throws(() => transitionFindingStatus('does-not-exist', missionId, 'CONFIRMED'), /finding_not_found/);
});

// ── DB isolation ───────────────────────────────────────────────────────

test('DB isolation: findings/evidence for one mission are never returned when querying another mission', () => {
  const missionA = seedMission(newMissionId());
  const missionB = seedMission(newMissionId());
  const fa = finding({ id: 'f-iso', title: 't', category: 'headers', severity: 'LOW', confidence: 'HIGH', asset: 'a', observed: 'o' });
  recordFinding({ missionId: missionA, finding: fa });
  assert.ok(getFindingById('f-iso', missionA));
  assert.equal(getFindingById('f-iso', missionB), null);
  assert.equal(getFindingsForMission(missionB).filter(f => f.id === 'f-iso').length, 0);
});

test('DB isolation: cyber_audit_requests rows are scoped per mission_id', () => {
  const missionA = seedMission(newMissionId());
  const missionB = seedMission(newMissionId());
  insertCyberAuditRequest({ id: 'req-iso-a', mission_id: missionA, url: 'http://x.invalid/a', method: 'GET' });
  insertCyberAuditRequest({ id: 'req-iso-b', mission_id: missionB, url: 'http://x.invalid/b', method: 'GET' });
  const requestsA = getCyberAuditRequestsForMission(missionA);
  assert.equal(requestsA.length, 1);
  assert.equal(requestsA[0].id, 'req-iso-a');
});

// ── Rollback / write-error handling ────────────────────────────────────

test('write-error handling: recordEvidence throws (not silently no-ops) when required fields are missing, and persists nothing', () => {
  const missionId = seedMission(newMissionId());
  const before = getEvidenceForMission(missionId).length;
  assert.throws(() => recordEvidence({ missionId, requestId: '', url: 'http://x.invalid', method: 'GET', headers: {} }), /evidence_request_id_required/);
  assert.equal(getEvidenceForMission(missionId).length, before);
});

test('write-error handling: recordFinding throws and persists nothing when the finding object is malformed', () => {
  const missionId = seedMission(newMissionId());
  const before = getFindingsForMission(missionId).length;
  assert.throws(() => recordFinding({ missionId, finding: null }), /finding_object_required/);
  assert.equal(getFindingsForMission(missionId).length, before);
});

test('write-error handling: inserting evidence for a request_id that does not exist does not corrupt the evidence table (no FK enforced, but no crash either — documents current behavior)', () => {
  const missionId = seedMission(newMissionId());
  assert.doesNotThrow(() => recordEvidence({ missionId, requestId: 'never-inserted-request', url: 'http://x.invalid/orphan', method: 'GET', headers: {} }));
});
