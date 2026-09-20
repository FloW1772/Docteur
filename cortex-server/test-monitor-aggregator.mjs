// Unit tests for the Observateur aggregator — pure functions, no OS
// shell-out. Verifies window-bucket upsert keying produces bounded row
// growth (one row per distinct process/destination/hour, not one per
// sample).
// Run with: node --test test-monitor-aggregator.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowBucketFor, buildConnectionRows, buildProcessRows } from './src/lib/monitor-aggregator.js';

function sample(overrides = {}) {
  return {
    processName: 'chrome.exe', pid: 100, remoteAddress: '93.184.216.34', remotePort: 443,
    localPort: 51000, protocol: 'TCP', state: 'ESTABLISHED', timestamp: new Date().toISOString(), approxBytes: 0,
    ...overrides,
  };
}

test('windowBucketFor: returns an hourly bucket key (YYYY-MM-DDTHH)', () => {
  const bucket = windowBucketFor(new Date('2026-09-20T14:37:12.000Z'));
  assert.equal(bucket, '2026-09-20T14');
});

test('buildConnectionRows: one row per sample (upsert key handled by sqlite ON CONFLICT, not here)', () => {
  const rows = buildConnectionRows([sample(), sample()], '2026-09-20T14');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].window_bucket, '2026-09-20T14');
  assert.equal(rows[0].remote_address, '93.184.216.34');
});

test('buildProcessRows: bounded row growth — 1000 samples from one process to one destination produce ONE process row', () => {
  const samples = Array.from({ length: 1000 }, () => sample());
  const rows = buildProcessRows(samples, '2026-09-20T14');
  assert.equal(rows.length, 1, 'row count must be O(distinct processes), not O(samples)');
  assert.equal(rows[0].connection_count, 1000);
  assert.equal(rows[0].distinct_destinations, 1);
});

test('buildProcessRows: distinct destinations are counted correctly across processes', () => {
  const samples = [
    sample({ processName: 'chrome.exe', remoteAddress: '1.1.1.1' }),
    sample({ processName: 'chrome.exe', remoteAddress: '2.2.2.2' }),
    sample({ processName: 'node.exe', remoteAddress: '3.3.3.3' }),
  ];
  const rows = buildProcessRows(samples, '2026-09-20T14');
  const chrome = rows.find(r => r.process_name === 'chrome.exe');
  const node = rows.find(r => r.process_name === 'node.exe');
  assert.equal(chrome.distinct_destinations, 2);
  assert.equal(chrome.connection_count, 2);
  assert.equal(node.distinct_destinations, 1);
});

test('buildProcessRows: unknown process name is grouped, never dropped', () => {
  const rows = buildProcessRows([sample({ processName: null })], '2026-09-20T14');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].process_name, 'processus inconnu');
});
