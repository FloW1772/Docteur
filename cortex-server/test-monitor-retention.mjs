// Unit tests for monitor-retention.js — purge only removes rows older
// than the cutoff, only from monitor_* tables, and is throttled to run
// at most once per PURGE_CHECK_INTERVAL_MS (cheap timestamp check, not
// a purge on every tick).
// Run with: node --test test-monitor-retention.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, upsertMonitorConnections, getLiveMonitorConnections, getMeta, setMeta } from './src/lib/sqlite.js';
import { updateMonitorSettings } from './src/lib/monitor-config.js';
import { maybeRunRetentionPurge } from './src/lib/monitor-retention.js';

const TEST_DB_DIR = './data-test-monitor-retention';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('maybeRunRetentionPurge: purges connections older than retentionDays', () => {
  updateMonitorSettings({ retentionDays: 7 });
  setMeta('monitor_last_purge_at', null); // force the throttle check to allow a run
  const oldTs = new Date(Date.now() - 30 * 86400000).toISOString();
  upsertMonitorConnections([{
    id: 'old-1', process_name: 'legacy.exe', pid: 1, remote_address: '203.0.113.9', remote_port: 443,
    local_port: 1, protocol: 'TCP', state: 'ESTABLISHED', first_seen: oldTs, last_seen: oldTs,
    approx_bytes: 0, window_bucket: '2020-01-01T00',
  }]);
  const deleted = maybeRunRetentionPurge();
  assert.ok(deleted >= 1);
  const remaining = getLiveMonitorConnections('2000-01-01T00:00:00Z', 1000);
  assert.equal(remaining.some(r => r.id === 'old-1'), false);
});

test('maybeRunRetentionPurge: is throttled — a second call right after the first is a no-op', () => {
  const deleted = maybeRunRetentionPurge();
  assert.equal(deleted, 0, 'must not re-run within PURGE_CHECK_INTERVAL_MS of the last purge');
});

test('maybeRunRetentionPurge: keeps recent rows within the retention window', () => {
  setMeta('monitor_last_purge_at', null);
  const recentTs = new Date().toISOString();
  upsertMonitorConnections([{
    id: 'recent-1', process_name: 'active.exe', pid: 2, remote_address: '203.0.113.10', remote_port: 443,
    local_port: 2, protocol: 'TCP', state: 'ESTABLISHED', first_seen: recentTs, last_seen: recentTs,
    approx_bytes: 0, window_bucket: recentTs.slice(0, 13),
  }]);
  maybeRunRetentionPurge();
  const remaining = getLiveMonitorConnections('2000-01-01T00:00:00Z', 1000);
  assert.ok(remaining.some(r => r.id === 'recent-1'), 'recent rows within retention must survive purge');
});

test('maybeRunRetentionPurge: records a last-purge timestamp', () => {
  const lastPurgeAt = getMeta('monitor_last_purge_at');
  assert.ok(lastPurgeAt);
});
