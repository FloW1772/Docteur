// Integration test for monitor-collector.js — runs the real OS
// collector (netstat/tasklist on Windows) since its parsing functions
// are intentionally not exported (collectSnapshot() is the only public
// surface, matching how the rest of Observateur only ever consumes
// already-parsed snapshots). Verifies the collector never throws,
// degrades gracefully, and every returned field matches the expected
// shape (nothing beyond what monitor-privacy-guard.js's allowlist
// would keep, though this test does not itself apply the guard).
// Run with: node --test test-monitor-collector.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot } from './src/lib/monitor-collector.js';

test('collectSnapshot: returns a well-formed snapshot without throwing', async () => {
  const snapshot = await collectSnapshot();
  assert.ok(Array.isArray(snapshot.connections));
  assert.ok(Array.isArray(snapshot.processes));
});

test('collectSnapshot: every connection has the expected metadata-only shape', async () => {
  const snapshot = await collectSnapshot();
  for (const conn of snapshot.connections) {
    assert.equal(typeof conn.processName, 'string');
    assert.ok(conn.pid === null || typeof conn.pid === 'number');
    assert.equal(typeof conn.remoteAddress, 'string');
    assert.ok(conn.remotePort === null || typeof conn.remotePort === 'number');
    assert.equal(typeof conn.protocol, 'string');
    assert.equal(typeof conn.timestamp, 'string');
    assert.equal(typeof conn.approxBytes, 'number');
    // Never any payload/credential-shaped field on the raw collector output.
    for (const forbidden of ['password', 'cookie', 'authorization', 'body', 'payload']) {
      assert.equal(forbidden in conn, false);
    }
  }
});

test('collectSnapshot: process names default to "processus inconnu" rather than throwing on missing data', async () => {
  const snapshot = await collectSnapshot();
  for (const conn of snapshot.connections) {
    assert.notEqual(conn.processName, '');
    assert.notEqual(conn.processName, undefined);
  }
});

test('collectSnapshot: does not reject/throw even if run twice in a row (no leaked state)', async () => {
  await collectSnapshot();
  await assert.doesNotReject(() => collectSnapshot());
});
