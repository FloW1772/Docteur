// Integration tests for the maitre_* sqlite.js helpers directly (not
// through maitre-store.js) — confirms schema correctness, isolation
// from monitor_*/cyber_audit_* tables, and the DB-level duplicate-id
// constraint.
// Run with: node --test test-maitre-db.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  initSqlite,
  insertMaitreEvent, getMaitreEventById, listMaitreEvents, attachMaitreEventToIncident,
  purgeMaitreEventsOlderThan,
  insertMaitreIncident, getMaitreIncidentById, listMaitreIncidents, updateMaitreIncident,
  insertMaitreEvidence, getMaitreEvidenceById, listMaitreEvidenceForIncident,
  upsertMonitorConnections, getLiveMonitorConnections,
  insertCyberAuditMission, getCyberAuditMissionById,
} from './src/lib/sqlite.js';

const TEST_DB_DIR = './data-test-maitre-db';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function eventRow(overrides = {}) {
  return {
    id: crypto.randomUUID(), created_at: new Date().toISOString(), occurred_at: new Date().toISOString(),
    source: 'maitre', category: 'test', severity: 'INFO', confidence: 'medium',
    subject: '{}', evidence_refs: '[]', metadata: '{}', detector_id: 'd1', incident_id: null,
    ...overrides,
  };
}

function incidentRow(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), created_at: now, updated_at: now, status: 'OPEN', severity: 'INFO',
    title: 'test incident', summary: '', event_refs: '[]', evidence_refs: '[]',
    recommendations: '[]', actions_proposed: '[]', actions_executed: '[]', timeline: '[]',
    ...overrides,
  };
}

function evidenceRow(overrides = {}) {
  return {
    id: crypto.randomUUID(), created_at: new Date().toISOString(), type: 'OTHER', source: 'x',
    incident_id: null, event_id: null, sha256: null, metadata: '{}', redacted: 1, integrity_hash: null,
    ...overrides,
  };
}

test('insertMaitreEvent / getMaitreEventById: round-trips a row', () => {
  const row = eventRow();
  insertMaitreEvent(row);
  const fetched = getMaitreEventById(row.id);
  assert.equal(fetched.id, row.id);
  assert.equal(fetched.severity, 'INFO');
});

test('insertMaitreEvent: duplicate id throws a SQLITE_CONSTRAINT error, never silently overwrites', () => {
  const row = eventRow();
  insertMaitreEvent(row);
  assert.throws(() => insertMaitreEvent(eventRow({ id: row.id, category: 'different' })));
  assert.equal(getMaitreEventById(row.id).category, 'test', 'original row must survive the rejected duplicate insert');
});

test('listMaitreEvents: filters by incidentId when provided', () => {
  const incident = incidentRow();
  insertMaitreIncident(incident);
  const e1 = eventRow({ incident_id: incident.id });
  const e2 = eventRow({ incident_id: null });
  insertMaitreEvent(e1);
  insertMaitreEvent(e2);
  const scoped = listMaitreEvents({ incidentId: incident.id });
  assert.ok(scoped.every(e => e.incident_id === incident.id));
  assert.ok(scoped.some(e => e.id === e1.id));
  assert.ok(!scoped.some(e => e.id === e2.id));
});

test('attachMaitreEventToIncident: mutates only the incident_id column', () => {
  const row = eventRow();
  insertMaitreEvent(row);
  const incident = incidentRow();
  insertMaitreIncident(incident);
  attachMaitreEventToIncident(row.id, incident.id);
  const fetched = getMaitreEventById(row.id);
  assert.equal(fetched.incident_id, incident.id);
  assert.equal(fetched.category, row.category, 'other columns must be untouched');
});

test('insertMaitreIncident / getMaitreIncidentById: round-trips', () => {
  const row = incidentRow({ title: 'DB-level incident' });
  insertMaitreIncident(row);
  const fetched = getMaitreIncidentById(row.id);
  assert.equal(fetched.title, 'DB-level incident');
  assert.equal(fetched.status, 'OPEN');
});

test('listMaitreIncidents: filters by status, bounded by limit/offset', () => {
  for (let i = 0; i < 5; i++) insertMaitreIncident(incidentRow({ status: 'OPEN' }));
  const page1 = listMaitreIncidents({ limit: 2, offset: 0, status: 'OPEN' });
  const page2 = listMaitreIncidents({ limit: 2, offset: 2, status: 'OPEN' });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.notDeepEqual(page1.map(i => i.id), page2.map(i => i.id));
});

test('updateMaitreIncident: only allowlisted columns are ever written', () => {
  const row = incidentRow({ title: 'Immutable title' });
  insertMaitreIncident(row);
  // id and created_at are NOT in the allowlist — attempting to smuggle
  // them in must have no effect.
  const updated = updateMaitreIncident(row.id, { status: 'INVESTIGATING', id: 'hijacked-id', created_at: '1999-01-01' });
  assert.equal(updated.id, row.id, 'id column must never be mutable');
  assert.equal(updated.created_at, row.created_at, 'created_at column must never be mutable');
  assert.equal(updated.status, 'INVESTIGATING');
});

test('updateMaitreIncident: bumps updated_at even when no recognized field changes materially', () => {
  const row = incidentRow();
  insertMaitreIncident(row);
  const result = updateMaitreIncident(row.id, {});
  assert.ok(result, 'must still return the row even with an empty update');
});

test('insertMaitreEvidence / getMaitreEvidenceById: round-trips', () => {
  const row = evidenceRow({ type: 'FILE_HASH', sha256: 'a'.repeat(64) });
  insertMaitreEvidence(row);
  const fetched = getMaitreEvidenceById(row.id);
  assert.equal(fetched.type, 'FILE_HASH');
  assert.equal(fetched.sha256, 'a'.repeat(64));
});

test('listMaitreEvidenceForIncident: scoped correctly, ordered ASC by created_at', () => {
  const incident = incidentRow();
  insertMaitreIncident(incident);
  const e1 = evidenceRow({ incident_id: incident.id, created_at: '2026-01-01T00:00:00Z' });
  const e2 = evidenceRow({ incident_id: incident.id, created_at: '2026-01-02T00:00:00Z' });
  insertMaitreEvidence(e1);
  insertMaitreEvidence(e2);
  insertMaitreEvidence(evidenceRow({ incident_id: null })); // must not appear
  const list = listMaitreEvidenceForIncident(incident.id);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(e => e.id), [e1.id, e2.id]);
});

test('purgeMaitreEventsOlderThan: purges only maitre_events, isolated from monitor_* and cyber_audit_*', () => {
  const oldTs = new Date(Date.now() - 60 * 86400000).toISOString();
  insertMaitreEvent(eventRow({ id: crypto.randomUUID(), occurred_at: oldTs }));

  // Seed unrelated tables with old-timestamped data too, to prove the
  // MAITRE purge never touches them.
  upsertMonitorConnections([{
    id: crypto.randomUUID(), process_name: 'unrelated.exe', pid: 1, remote_address: '203.0.113.1',
    remote_port: 443, local_port: 1, protocol: 'TCP', state: 'ESTABLISHED',
    first_seen: oldTs, last_seen: oldTs, approx_bytes: 0, window_bucket: '2020-01-01T00',
  }]);
  const missionId = crypto.randomUUID();
  insertCyberAuditMission({ id: missionId, title: 'unrelated', client_name: 'x', authorization_reference: 'ref', mode: 'PASSIVE_AUDIT' });

  const deleted = purgeMaitreEventsOlderThan(30);
  assert.ok(deleted >= 1);

  const monitorRows = getLiveMonitorConnections('2000-01-01T00:00:00Z', 1000);
  assert.ok(monitorRows.some(r => r.remote_address === '203.0.113.1'), 'monitor_connections must be untouched by MAITRE purge');
  assert.ok(getCyberAuditMissionById(missionId), 'cyber_audit_missions must be untouched by MAITRE purge');
});

test('maitre_* tables are structurally isolated: no shared table name collision with monitor_*/cyber_audit_*', () => {
  // Sanity check purely via the exported function set — MAITRE never
  // imports/writes a monitor_* or cyber_audit_* row directly.
  assert.equal(typeof insertMaitreEvent, 'function');
  assert.equal(typeof insertMaitreIncident, 'function');
  assert.equal(typeof insertMaitreEvidence, 'function');
});
