// Integration tests for the monitor_* sqlite.js helpers — verifies the
// hourly window_bucket upsert actually bounds row growth at the
// database level (not just in the pure aggregator functions), and that
// retention purge touches only monitor_* tables.
// Run with: node --test test-monitor-db.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  initSqlite, upsertMonitorConnections, upsertMonitorProcesses,
  getLiveMonitorConnections, getMonitorProcesses, purgeMonitorDataOlderThan,
  insertMonitorAnomaly, getMonitorAnomalies, insertMonitorReport, getMonitorReports,
  getLastMonitorReport, insertMonitorEvent, getMonitorEvents,
  insertCyberAuditMission, getCyberAuditMissionById,
} from './src/lib/sqlite.js';

const TEST_DB_DIR = './data-test-monitor-db';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function connRow(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), process_name: 'chrome.exe', pid: 100, remote_address: '93.184.216.34',
    remote_port: 443, local_port: 51000, protocol: 'TCP', state: 'ESTABLISHED',
    first_seen: now, last_seen: now, approx_bytes: 0, window_bucket: '2026-09-20T14',
    ...overrides,
  };
}

test('upsertMonitorConnections: repeated upserts for the same (process, dest, bucket) update ONE row', () => {
  for (let i = 0; i < 50; i++) upsertMonitorConnections([connRow({ id: crypto.randomUUID() })]);
  const rows = getLiveMonitorConnections(new Date(Date.now() - 60_000).toISOString(), 1000);
  const matching = rows.filter(r => r.process_name === 'chrome.exe' && r.remote_address === '93.184.216.34');
  assert.equal(matching.length, 1, 'bounded growth: one row per (process, destination, hour), not one per upsert');
  assert.equal(matching[0].sample_count, 50);
});

test('upsertMonitorConnections: a different destination creates a new row', () => {
  upsertMonitorConnections([connRow({ id: crypto.randomUUID(), remote_address: '8.8.8.8' })]);
  const rows = getLiveMonitorConnections(new Date(Date.now() - 60_000).toISOString(), 1000);
  assert.ok(rows.some(r => r.remote_address === '8.8.8.8'));
});

test('upsertMonitorProcesses: repeated upserts update ONE row per (process, bucket)', () => {
  const row = { id: crypto.randomUUID(), process_name: 'node.exe', pid: 1, first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), connection_count: 1, distinct_destinations: 1, window_bucket: '2026-09-20T14' };
  for (let i = 0; i < 20; i++) upsertMonitorProcesses([{ ...row, connection_count: i + 1 }]);
  const rows = getMonitorProcesses(new Date(Date.now() - 60_000).toISOString(), 1000);
  const matching = rows.filter(r => r.process_name === 'node.exe');
  assert.equal(matching.length, 1);
  assert.equal(matching[0].connection_count, 20);
});

test('insertMonitorAnomaly / getMonitorAnomalies: round-trips a row', () => {
  insertMonitorAnomaly({
    id: crypto.randomUUID(), detected_at: new Date().toISOString(), rule_id: 'new-listening-port',
    severity: 'SUSPICIOUS', process_name: 'node.exe', remote_address: null,
    description: 'test', evidence_ref: '{}', status: 'OPEN', security_signal: null,
  });
  const anomalies = getMonitorAnomalies(10);
  assert.ok(anomalies.some(a => a.rule_id === 'new-listening-port'));
});

test('insertMonitorReport / getMonitorReports / getLastMonitorReport: round-trip', () => {
  const id = crypto.randomUUID();
  insertMonitorReport({
    id, report_type: 'SUMMARY', period_start: new Date(Date.now() - 3600_000).toISOString(),
    period_end: new Date().toISOString(), mode: 'ON_SUMMARY', event_count: 5, anomaly_count: 0,
    summary_json: '{}', llm_narrative: null, created_at: new Date().toISOString(),
  });
  const reports = getMonitorReports(10);
  assert.ok(reports.some(r => r.id === id));
  const last = getLastMonitorReport();
  assert.equal(last.id, id);
});

test('insertMonitorEvent / getMonitorEvents: round-trip', () => {
  insertMonitorEvent({ id: crypto.randomUUID(), event_type: 'start', detail: '{}', created_at: new Date().toISOString() });
  const events = getMonitorEvents(10);
  assert.ok(events.some(e => e.event_type === 'start'));
});

test('purgeMonitorDataOlderThan: purges only monitor_* tables, never cyber_audit_*', () => {
  // Seed an old monitor_connections row and an old-ish cyber_audit_missions row.
  const oldTs = new Date(Date.now() - 60 * 86400000).toISOString();
  upsertMonitorConnections([connRow({ id: crypto.randomUUID(), remote_address: '203.0.113.5', first_seen: oldTs, last_seen: oldTs, window_bucket: '2020-01-01T00' })]);
  const missionId = crypto.randomUUID();
  insertCyberAuditMission({
    id: missionId, title: 'unrelated mission', client_name: 'x',
    authorization_reference: 'ref', mode: 'PASSIVE_AUDIT',
  });
  assert.ok(getCyberAuditMissionById(missionId), 'seeded mission must exist before purge');

  const deleted = purgeMonitorDataOlderThan(7);
  assert.ok(deleted >= 1);
  const remaining = getLiveMonitorConnections('2000-01-01T00:00:00Z', 1000);
  assert.equal(remaining.some(r => r.remote_address === '203.0.113.5'), false, 'old monitor row must be purged');
});
