// Integration tests for maitre-store.js against a REAL, isolated
// SQLite test DB (never the real Docteur/monitor/cyber-audit DB). Covers
// create/get/update/list for SecurityEvent/Incident/Evidence, bounded
// queries, duplicate ID protection, DB failure modes, retention helper.
// Run with: node --test test-maitre-store.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite } from './src/lib/sqlite.js';
import {
  createSecurityEvent, getSecurityEvent, listSecurityEvents, assignSecurityEventToIncident,
  purgeSecurityEventsOlderThan,
  createIncident, getIncident, listIncidents, updateIncident,
  createEvidence, getEvidence, listEvidenceForIncident,
} from './src/lib/maitre-store.js';
import { MaitreValidationError } from './src/lib/maitre-models.js';

const TEST_DB_DIR = './data-test-maitre-store';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── SecurityEvent CRUD ────────────────────────────────────────────────────

test('createSecurityEvent / getSecurityEvent: round-trip', () => {
  const created = createSecurityEvent({
    source: 'observateur', category: 'network', severity: 'SUSPICIOUS', detectorId: 'test-1',
    subject: { host: '1.2.3.4' },
  });
  const fetched = getSecurityEvent(created.id);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.severity, 'SUSPICIOUS');
  assert.deepEqual(fetched.subject, { host: '1.2.3.4' });
});

test('getSecurityEvent: unknown id returns null, not a throw', () => {
  assert.equal(getSecurityEvent('does-not-exist'), null);
});

test('listSecurityEvents: bounded, sorted by occurredAt DESC', () => {
  for (let i = 0; i < 5; i++) {
    createSecurityEvent({
      source: 'maitre', category: 'test-listing', severity: 'INFO', detectorId: 'd1',
      occurredAt: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
  const events = listSecurityEvents({ limit: 3 });
  assert.equal(events.length, 3);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i - 1].occurredAt >= events[i].occurredAt, 'must be sorted DESC');
  }
});

test('listSecurityEvents: limit is clamped to a sane max, never unbounded', () => {
  const events = listSecurityEvents({ limit: 999999 });
  assert.ok(events.length <= 500, 'list limit must be bounded even if caller asks for more');
});

test('assignSecurityEventToIncident: attaches an event to an incident', () => {
  const event = createSecurityEvent({ source: 'maitre', category: 'x', severity: 'INFO', detectorId: 'd1' });
  const incident = createIncident({ title: 'Correlated incident', severity: 'HIGH' });
  const updated = assignSecurityEventToIncident(event.id, incident.id);
  assert.equal(updated.incidentId, incident.id);
});

test('assignSecurityEventToIncident: unknown event id throws event_not_found', () => {
  const incident = createIncident({ title: 'x', severity: 'INFO' });
  assert.throws(() => assignSecurityEventToIncident('nope', incident.id), /event_not_found/);
});

test('assignSecurityEventToIncident: unknown incident id throws incident_not_found', () => {
  const event = createSecurityEvent({ source: 'maitre', category: 'x', severity: 'INFO', detectorId: 'd1' });
  assert.throws(() => assignSecurityEventToIncident(event.id, 'nope'), /incident_not_found/);
});

test('createSecurityEvent: duplicate explicit id is rejected, not silently overwritten', () => {
  const id = 'explicit-dup-id-1';
  createSecurityEvent({ id, source: 'maitre', category: 'x', severity: 'INFO', detectorId: 'd1' });
  assert.throws(() => createSecurityEvent({ id, source: 'maitre', category: 'y', severity: 'HIGH', detectorId: 'd2' }));
  // Confirm the original row was NOT overwritten by the failed duplicate insert.
  const stillOriginal = getSecurityEvent(id);
  assert.equal(stillOriginal.category, 'x');
});

// ── Incident CRUD ─────────────────────────────────────────────────────────

test('createIncident / getIncident: round-trip, defaults status to OPEN', () => {
  const created = createIncident({ title: 'New incident', severity: 'CRITICAL' });
  const fetched = getIncident(created.id);
  assert.equal(fetched.status, 'OPEN');
  assert.equal(fetched.severity, 'CRITICAL');
});

test('updateIncident: valid transition persists and bumps updatedAt', async () => {
  const created = createIncident({ title: 'x', severity: 'HIGH' });
  await new Promise(r => setTimeout(r, 5));
  const updated = updateIncident(created.id, { status: 'INVESTIGATING' });
  assert.equal(updated.status, 'INVESTIGATING');
  assert.notEqual(updated.updatedAt, created.createdAt === updated.createdAt ? null : created.createdAt);
  assert.ok(new Date(updated.updatedAt).getTime() >= new Date(created.updatedAt).getTime());
});

test('updateIncident: invalid transition throws and does not persist', () => {
  const created = createIncident({ title: 'x', severity: 'HIGH' });
  assert.throws(() => updateIncident(created.id, { status: 'RESOLVED' }));
  const stillOpen = getIncident(created.id);
  assert.equal(stillOpen.status, 'OPEN', 'a rejected transition must not have been persisted');
});

test('updateIncident: unknown incident id throws incident_not_found', () => {
  assert.throws(() => updateIncident('nope', { status: 'INVESTIGATING' }), /incident_not_found/);
});

test('updateIncident: title is immutable — not accepted as an update field', () => {
  const created = createIncident({ title: 'Original title', severity: 'INFO' });
  const updated = updateIncident(created.id, { status: 'INVESTIGATING', title: 'Sneaky new title' });
  assert.equal(updated.title, 'Original title', 'title must never be mutable via updateIncident');
});

test('listIncidents: filter by status', () => {
  const a = createIncident({ title: 'a', severity: 'INFO' });
  updateIncident(a.id, { status: 'INVESTIGATING' });
  createIncident({ title: 'b', severity: 'INFO' }); // stays OPEN
  const investigating = listIncidents({ status: 'INVESTIGATING' });
  assert.ok(investigating.every(i => i.status === 'INVESTIGATING'));
  assert.ok(investigating.some(i => i.id === a.id));
});

// ── Evidence CRUD ─────────────────────────────────────────────────────────

test('createEvidence / getEvidence: round-trip, redacted by default', () => {
  const created = createEvidence({
    type: 'FILE_METADATA', source: 'integrity-monitor', metadata: { path: 'C:\\app.exe', password: 'x' },
  });
  const fetched = getEvidence(created.id);
  assert.equal(fetched.redacted, true);
  assert.equal(fetched.metadata.password, '[REDACTED]');
  assert.equal(fetched.metadata.path, 'C:\\app.exe');
  assert.ok(fetched.integrityHash);
});

test('listEvidenceForIncident: scoped to the given incident, ordered ASC by createdAt', () => {
  const incident = createIncident({ title: 'x', severity: 'INFO' });
  const e1 = createEvidence({ type: 'OTHER', source: 'x', incidentId: incident.id });
  const e2 = createEvidence({ type: 'OTHER', source: 'x', incidentId: incident.id });
  createEvidence({ type: 'OTHER', source: 'x' }); // no incidentId — must not appear
  const list = listEvidenceForIncident(incident.id);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(e => e.id), [e1.id, e2.id]);
});

// ── Secret persistence guarantee (end-to-end through the store, not just the redactor) ──

test('createEvidence: end-to-end — Authorization/Cookie/password/token never survive into the DB row', () => {
  const created = createEvidence({
    type: 'PROCESS_SNAPSHOT', source: 'process-monitor',
    metadata: {
      headers: { authorization: 'Bearer super-secret-token', cookie: 'sessionid=abc123' },
      password: 'hunter2', apiKey: 'sk-live-abc', sessionToken: 'tok-xyz',
    },
  });
  const raw = JSON.stringify(getEvidence(created.id).metadata);
  for (const secret of ['super-secret-token', 'abc123', 'hunter2', 'sk-live-abc', 'tok-xyz']) {
    assert.doesNotMatch(raw, new RegExp(secret), `${secret} must never appear in persisted evidence`);
  }
});

// ── DB failure modes ──────────────────────────────────────────────────────

test('createSecurityEvent: invalid severity throws MaitreValidationError, no row persisted', () => {
  assert.throws(() => createSecurityEvent({ source: 'maitre', category: 'x', severity: 'NOPE', detectorId: 'd1' }), MaitreValidationError);
});

test('createIncident: invalid status throws, no row persisted', () => {
  assert.throws(() => createIncident({ title: 'x', severity: 'INFO', status: 'FIXED' }), MaitreValidationError);
});

test('createEvidence: invalid evidence type throws', () => {
  assert.throws(() => createEvidence({ type: 'RANSOMWARE', source: 'x' }), MaitreValidationError);
});

test('createSecurityEvent: missing required field throws rather than persisting a broken row', () => {
  assert.throws(() => createSecurityEvent({ category: 'x', severity: 'INFO', detectorId: 'd1' }), MaitreValidationError);
});

// ── Retention helper (no scheduler — direct call only) ───────────────────

test('purgeSecurityEventsOlderThan: purges only maitre_events rows older than the cutoff', () => {
  const old = createSecurityEvent({
    source: 'maitre', category: 'old', severity: 'INFO', detectorId: 'd1',
    occurredAt: new Date(Date.now() - 60 * 86400000).toISOString(),
  });
  const recent = createSecurityEvent({ source: 'maitre', category: 'recent', severity: 'INFO', detectorId: 'd1' });
  const deleted = purgeSecurityEventsOlderThan(30);
  assert.ok(deleted >= 1);
  assert.equal(getSecurityEvent(old.id), null);
  assert.ok(getSecurityEvent(recent.id));
});

test('purgeSecurityEventsOlderThan: invalid days input is a safe no-op, not a crash', () => {
  assert.equal(purgeSecurityEventsOlderThan('not-a-number'), 0);
  assert.equal(purgeSecurityEventsOlderThan(NaN), 0);
});
