// Unit tests for monitor-baseline.js — bounded growth (capped
// destinations) and explainability (returns human-readable destinations
// and active hours, never an opaque score).
// Run with: node --test test-monitor-baseline.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, upsertMonitorConnections } from './src/lib/sqlite.js';
import { getBaseline, isKnownDestination } from './src/lib/monitor-baseline.js';

const TEST_DB_DIR = './data-test-monitor-baseline';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('getBaseline: empty history returns an explainable, empty baseline (no opaque score)', () => {
  const baseline = getBaseline('never-seen.exe');
  assert.deepEqual(baseline.destinations, []);
  assert.equal(baseline.activeHours.length, 24);
  assert.equal(baseline.sampleCount, 0);
  assert.equal(typeof baseline.avgBytesPerSample, 'number');
});

test('getBaseline: aggregates destinations and active hours from persisted history, human-readable', () => {
  const bucket = new Date().toISOString().slice(0, 13);
  const now = new Date().toISOString();
  upsertMonitorConnections([
    { id: 'a', process_name: 'app.exe', pid: 1, remote_address: '1.1.1.1', remote_port: 443, local_port: 1, protocol: 'TCP', state: 'ESTABLISHED', first_seen: now, last_seen: now, approx_bytes: 100, window_bucket: bucket },
    { id: 'b', process_name: 'app.exe', pid: 1, remote_address: '2.2.2.2', remote_port: 443, local_port: 2, protocol: 'TCP', state: 'ESTABLISHED', first_seen: now, last_seen: now, approx_bytes: 200, window_bucket: bucket },
  ]);
  const baseline = getBaseline('app.exe');
  assert.equal(baseline.destinations.length, 2);
  assert.ok(baseline.destinations.includes('1.1.1.1:443'));
  assert.ok(baseline.destinations.includes('2.2.2.2:443'));
  assert.equal(baseline.sampleCount, 2);
});

test('getBaseline: caps destinations at MAX_BASELINE_DESTINATIONS (bounded, never unbounded growth)', () => {
  const bucket = new Date().toISOString().slice(0, 13);
  const now = new Date().toISOString();
  const rows = Array.from({ length: 250 }, (_, i) => ({
    id: `dest-${i}`, process_name: 'chatty.exe', pid: 1, remote_address: `10.0.${Math.floor(i / 255)}.${i % 255}`,
    remote_port: 443, local_port: i, protocol: 'TCP', state: 'ESTABLISHED', first_seen: now, last_seen: now,
    approx_bytes: 0, window_bucket: bucket,
  }));
  upsertMonitorConnections(rows);
  const baseline = getBaseline('chatty.exe');
  assert.ok(baseline.destinations.length <= 200, 'baseline destinations must be capped, never unbounded');
});

test('isKnownDestination: true only for destinations already in the baseline', () => {
  const baseline = { destinations: ['1.1.1.1:443'] };
  assert.equal(isKnownDestination(baseline, '1.1.1.1', 443), true);
  assert.equal(isKnownDestination(baseline, '9.9.9.9', 443), false);
});
