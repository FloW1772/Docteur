// Unit tests for monitor-anomaly.js — one test per deterministic rule,
// plus the hard invariant that no rule may ever emit an "attack"/
// "malware" verdict string; only the three defined severities exist.
// Run with: node --test test-monitor-anomaly.mjs
import './test-setup.mjs';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, upsertMonitorConnections, getMonitorAnomalies } from './src/lib/sqlite.js';
import { evaluateConnection, SEVERITIES, _resetAnomalyState } from './src/lib/monitor-anomaly.js';

const TEST_DB_DIR = './data-test-monitor-anomaly';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

beforeEach(() => { _resetAnomalyState(); });

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function conn(overrides = {}) {
  return {
    processName: 'chrome.exe', pid: 100, remoteAddress: '1.1.1.1', remotePort: 443,
    localPort: 51000, protocol: 'TCP', state: 'ESTABLISHED', timestamp: new Date().toISOString(), approxBytes: 0,
    ...overrides,
  };
}

const VALID_SEVERITIES = new Set(Object.values(SEVERITIES));

test('SEVERITIES: only OBSERVATION/SUSPICIOUS/REQUIRES_REVIEW exist — never an attack/malware verdict', () => {
  assert.deepEqual([...VALID_SEVERITIES].sort(), ['OBSERVATION', 'REQUIRES_REVIEW', 'SUSPICIOUS']);
  for (const v of VALID_SEVERITIES) {
    assert.doesNotMatch(v, /attaque|attack|malware|confirmed/i);
  }
});

test('rule: new-process-with-network-activity fires once per process name', () => {
  const first = evaluateConnection(conn({ processName: 'unique-app.exe' }));
  assert.ok(first.some(a => a.ruleId === 'new-process-with-network-activity'));
  const second = evaluateConnection(conn({ processName: 'unique-app.exe' }));
  assert.equal(second.some(a => a.ruleId === 'new-process-with-network-activity'), false, 'must not re-fire for the same process');
});

test('rule: new-listening-port fires once per (process, port) and is SUSPICIOUS', () => {
  const candidates = evaluateConnection(conn({ processName: 'server.exe', state: 'LISTENING', localPort: 9999 }));
  const hit = candidates.find(a => a.ruleId === 'new-listening-port');
  assert.ok(hit);
  assert.equal(hit.severity, SEVERITIES.SUSPICIOUS);
  const again = evaluateConnection(conn({ processName: 'server.exe', state: 'LISTENING', localPort: 9999 }));
  assert.equal(again.some(a => a.ruleId === 'new-listening-port'), false);
});

test('rule: new-unusual-destination does not fire with an empty baseline (first sighting is not an anomaly)', () => {
  const candidates = evaluateConnection(conn({ processName: 'fresh-app.exe', remoteAddress: '9.9.9.9' }));
  assert.equal(candidates.some(a => a.ruleId === 'new-unusual-destination'), false);
});

test('rule: new-unusual-destination fires once a baseline of known destinations exists', () => {
  const processName = 'baseliner.exe';
  const bucket = new Date().toISOString().slice(0, 13);
  // Seed a baseline: many prior samples to a known destination.
  for (let i = 0; i < 10; i++) {
    upsertMonitorConnections([{
      id: `seed-${i}`, process_name: processName, pid: 1, remote_address: '1.1.1.1', remote_port: 443,
      local_port: 50000, protocol: 'TCP', state: 'ESTABLISHED',
      first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), approx_bytes: 0, window_bucket: bucket,
    }]);
  }
  const candidates = evaluateConnection(conn({ processName, remoteAddress: '203.0.113.99' }));
  const hit = candidates.find(a => a.ruleId === 'new-unusual-destination');
  assert.ok(hit, 'a new destination not in the baseline must be flagged once a baseline exists');
  assert.equal(hit.severity, SEVERITIES.OBSERVATION);
});

test('rule: unusual-repetitive-connection fires only above the sample-count threshold', () => {
  const below = evaluateConnection(conn({ processName: 'repeater.exe' }), { sampleCount: 10 });
  assert.equal(below.some(a => a.ruleId === 'unusual-repetitive-connection'), false);
  const above = evaluateConnection(conn({ processName: 'repeater.exe' }), { sampleCount: 100 });
  assert.ok(above.some(a => a.ruleId === 'unusual-repetitive-connection'));
});

test('rule: new-external-destination-from-docteur-component is REQUIRES_REVIEW and stamps a security_signal', () => {
  const candidates = evaluateConnection(conn({ processName: 'node.exe', remoteAddress: '198.51.100.7' }));
  const hit = candidates.find(a => a.ruleId === 'new-external-destination-from-docteur-component');
  assert.ok(hit);
  assert.equal(hit.severity, SEVERITIES.REQUIRES_REVIEW);

  const anomalies = getMonitorAnomalies(50);
  const persisted = anomalies.find(a => a.rule_id === 'new-external-destination-from-docteur-component' && a.remote_address === '198.51.100.7');
  assert.ok(persisted);
  assert.ok(persisted.security_signal, 'REQUIRES_REVIEW rows must carry a security_signal for a future MAITRE module');
  const signal = JSON.parse(persisted.security_signal);
  assert.equal(signal.source, 'observateur');
  assert.equal(signal.severity, 'REQUIRES_REVIEW');
});

test('rule: new-external-destination-from-docteur-component does not fire for known/local hosts', () => {
  const candidates = evaluateConnection(conn({ processName: 'node.exe', remoteAddress: '127.0.0.1' }));
  assert.equal(candidates.some(a => a.ruleId === 'new-external-destination-from-docteur-component'), false);
});

test('rule: non-REQUIRES_REVIEW anomalies never carry a security_signal', () => {
  evaluateConnection(conn({ processName: 'observation-only.exe', state: 'LISTENING', localPort: 12345 }));
  const anomalies = getMonitorAnomalies(50);
  const listeningPortAnomaly = anomalies.find(a => a.rule_id === 'new-listening-port' && a.process_name === 'observation-only.exe');
  assert.ok(listeningPortAnomaly);
  assert.equal(listeningPortAnomaly.security_signal, null);
});
