// Unit tests for the Observateur privacy guard — the single choke point
// enforcing "never persist payload/credentials/cookies/tokens". Every
// injected extra field on a crafted malicious-shaped input must be
// stripped.
// Run with: node --test test-monitor-privacy-guard.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeConnection, sanitizeProcess, sanitizeSnapshot } from './src/lib/monitor-privacy-guard.js';

test('sanitizeConnection: keeps only allowlisted fields', () => {
  const raw = {
    processName: 'chrome.exe', pid: 100, remoteAddress: '1.2.3.4', remotePort: 443,
    localPort: 5000, protocol: 'TCP', state: 'ESTABLISHED', timestamp: '2026-01-01T00:00:00Z', approxBytes: 10,
    password: 'hunter2', cookie: 'session=abc', authorization: 'Bearer xyz', body: '<html>secret</html>',
    formData: { username: 'bob' }, payload: Buffer.from('binary'), document: 'contract.pdf',
  };
  const clean = sanitizeConnection(raw);
  assert.deepEqual(Object.keys(clean).sort(), [
    'approxBytes', 'localPort', 'pid', 'processName', 'protocol', 'remoteAddress', 'remotePort', 'state', 'timestamp',
  ].sort());
  assert.equal(clean.processName, 'chrome.exe');
  for (const secretField of ['password', 'cookie', 'authorization', 'body', 'formData', 'payload', 'document']) {
    assert.equal(secretField in clean, false, `${secretField} must never survive the privacy guard`);
  }
});

test('sanitizeProcess: keeps only allowlisted fields', () => {
  const raw = { processName: 'node.exe', pid: 42, timestamp: '2026-01-01T00:00:00Z', commandLine: '--secret-token=abc', env: { API_KEY: 'x' } };
  const clean = sanitizeProcess(raw);
  assert.deepEqual(Object.keys(clean).sort(), ['pid', 'processName', 'timestamp']);
  assert.equal('commandLine' in clean, false);
  assert.equal('env' in clean, false);
});

test('sanitizeSnapshot: sanitizes every connection and process in a full snapshot', () => {
  const snapshot = {
    connections: [{ processName: 'a', remoteAddress: '1.1.1.1', password: 'x' }],
    processes: [{ processName: 'a', commandLine: 'y' }],
  };
  const clean = sanitizeSnapshot(snapshot);
  assert.equal('password' in clean.connections[0], false);
  assert.equal('commandLine' in clean.processes[0], false);
});

test('sanitizeSnapshot: tolerates missing arrays without throwing', () => {
  assert.deepEqual(sanitizeSnapshot({}), { connections: [], processes: [] });
});
