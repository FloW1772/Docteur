// Unit tests for maitre-defender-adapter.js — ALL fixture-based, never
// depend on the real Defender, admin privileges, or Windows locale.
// The adapter's `exec`/`checkPlatform` params are injected fake
// implementations so these tests run identically on any OS/CI runner.
// Run with: node --test test-maitre-defender-adapter.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDefenderStatus, getDefenderDetections, defenderDetectionToSecurityEvent } from './src/lib/maitre-defender-adapter.js';

const alwaysWindows = () => true;
const neverWindows = () => false;

function fakeExecOk(stdoutObject) {
  return async () => ({ ok: true, stdout: JSON.stringify(stdoutObject) });
}
function fakeExecFail(reason, detail = '') {
  return async () => ({ ok: false, reason, detail });
}

// ── getDefenderStatus ─────────────────────────────────────────────────────

test('getDefenderStatus: available — full valid status', async () => {
  const exec = fakeExecOk({
    ok: true,
    status: {
      AMEngineVersion: '1.1.26080.3', AntivirusEnabled: true, RealTimeProtectionEnabled: true,
      AntivirusSignatureVersion: '1.459.304.0', AntivirusSignatureLastUpdated: '/Date(1789891757000)/',
      IsTamperProtected: true,
    },
  });
  const status = await getDefenderStatus({ exec, checkPlatform: alwaysWindows });
  assert.equal(status.available, true);
  assert.equal(status.enabled, true);
  assert.equal(status.realtimeProtection, true);
  assert.equal(status.signatureVersion, '1.459.304.0');
  assert.equal(status.signatureUpdatedAt, new Date(1789891757000).toISOString());
  assert.deepEqual(status.warnings, []);
});

test('getDefenderStatus: unavailable — Defender not installed/inaccessible', async () => {
  const exec = fakeExecOk({ ok: false, errorId: 'CommandNotFoundException', message: 'not found' });
  const status = await getDefenderStatus({ exec, checkPlatform: alwaysWindows });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'CommandNotFoundException');
});

test('getDefenderStatus: disabled — antivirus/realtime protection off, surfaced as warnings', async () => {
  const exec = fakeExecOk({
    ok: true,
    status: { AntivirusEnabled: false, RealTimeProtectionEnabled: false, IsTamperProtected: false },
  });
  const status = await getDefenderStatus({ exec, checkPlatform: alwaysWindows });
  assert.equal(status.available, true);
  assert.equal(status.enabled, false);
  assert.ok(status.warnings.includes('antivirus_disabled'));
  assert.ok(status.warnings.includes('realtime_protection_disabled'));
  assert.ok(status.warnings.includes('tamper_protection_disabled'));
});

test('getDefenderStatus: partial data — missing fields degrade to null, never throw', async () => {
  const exec = fakeExecOk({ ok: true, status: {} });
  const status = await getDefenderStatus({ exec, checkPlatform: alwaysWindows });
  assert.equal(status.available, true);
  assert.equal(status.signatureVersion, null);
  assert.equal(status.signatureUpdatedAt, null);
  assert.equal(status.engineVersion, null);
});

test('getDefenderStatus: malformed output (not JSON) degrades gracefully', async () => {
  const exec = async () => ({ ok: true, stdout: 'this is not json {{{' });
  const status = await getDefenderStatus({ exec, checkPlatform: alwaysWindows });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'malformed_output');
});

test('getDefenderStatus: timeout degrades gracefully', async () => {
  const exec = fakeExecFail('timeout', 'exceeded 8000ms');
  const status = await getDefenderStatus({ exec, checkPlatform: alwaysWindows });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'timeout');
});

test('getDefenderStatus: access denied degrades gracefully', async () => {
  const exec = fakeExecFail('exec_failed', 'Access is denied');
  const status = await getDefenderStatus({ exec, checkPlatform: alwaysWindows });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'exec_failed');
});

test('getDefenderStatus: unsupported platform never calls exec (no PowerShell spawned)', async () => {
  let execCalled = false;
  const exec = async () => { execCalled = true; return { ok: true, stdout: '{}' }; };
  const status = await getDefenderStatus({ exec, checkPlatform: neverWindows });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'NOT_SUPPORTED');
  assert.equal(execCalled, false, 'must never spawn a process on an unsupported platform');
});

// ── getDefenderDetections ─────────────────────────────────────────────────

test('getDefenderDetections: fixture detection parsed and severity-mapped', async () => {
  const exec = fakeExecOk({
    ok: true,
    detections: [{
      ThreatID: '123', DetectionID: 'det-1', ThreatName: 'Trojan:Win32/Wacatac.B!ml', SeverityID: 5,
      ActionSuccess: true, InitialDetectionTime: '/Date(1789891757000)/', Resources: ['file:_C:\\temp\\evil.exe'],
    }],
  });
  const result = await getDefenderDetections({ exec, checkPlatform: alwaysWindows });
  assert.equal(result.available, true);
  assert.equal(result.detections.length, 1);
  const d = result.detections[0];
  assert.equal(d.threatName, 'Trojan:Win32/Wacatac.B!ml');
  assert.equal(d.severity, 'CRITICAL');
  assert.equal(d.actionStatus, 'SUCCEEDED');
});

test('getDefenderDetections: empty detections array is a valid, non-error state', async () => {
  const exec = fakeExecOk({ ok: true, detections: [] });
  const result = await getDefenderDetections({ exec, checkPlatform: alwaysWindows });
  assert.equal(result.available, true);
  assert.deepEqual(result.detections, []);
});

test('getDefenderDetections: PowerShell collapses a single-item array to a bare object — handled', async () => {
  const exec = fakeExecOk({
    ok: true,
    detections: { DetectionID: 'det-1', ThreatName: 'Test.Threat', SeverityID: 3 },
  });
  const result = await getDefenderDetections({ exec, checkPlatform: alwaysWindows });
  assert.equal(result.detections.length, 1);
  assert.equal(result.detections[0].threatName, 'Test.Threat');
});

test('getDefenderDetections: unknown SeverityID defaults to OBSERVATION, never a stronger value', async () => {
  const exec = fakeExecOk({ ok: true, detections: [{ DetectionID: 'x', SeverityID: 999 }] });
  const result = await getDefenderDetections({ exec, checkPlatform: alwaysWindows });
  assert.equal(result.detections[0].severity, 'OBSERVATION');
});

test('getDefenderDetections: unsupported platform never calls exec', async () => {
  let execCalled = false;
  const exec = async () => { execCalled = true; return { ok: true, stdout: '{}' }; };
  const result = await getDefenderDetections({ exec, checkPlatform: neverWindows });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'NOT_SUPPORTED');
  assert.equal(execCalled, false);
});

test('getDefenderDetections: malformed output degrades gracefully', async () => {
  const exec = async () => ({ ok: true, stdout: 'not json' });
  const result = await getDefenderDetections({ exec, checkPlatform: alwaysWindows });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'malformed_output');
});

// ── defenderDetectionToSecurityEvent (severity mapping + no verdict promotion) ──

test('defenderDetectionToSecurityEvent: maps fields, never promotes threatName text into severity', () => {
  const detection = {
    id: 'det-1', timestamp: '2026-01-01T00:00:00.000Z', threatName: 'Trojan:Win32/Attack.Malware!Compromised',
    severity: 'HIGH', resource: 'file:C:\\evil.exe', actionStatus: 'SUCCEEDED',
  };
  const input = defenderDetectionToSecurityEvent(detection);
  assert.equal(input.source, 'windows-defender');
  assert.equal(input.severity, 'HIGH', 'severity comes only from the fixed SEVERITY_ID_MAP, never from threatName text');
  assert.equal(input.metadata.threatName, 'Trojan:Win32/Attack.Malware!Compromised', 'the alarming text is stored as DATA, not interpreted');
});

test('defenderDetectionToSecurityEvent: never produces MALWARE/ATTACK/COMPROMISED as the severity value', () => {
  for (const severity of ['INFO', 'OBSERVATION', 'SUSPICIOUS', 'HIGH', 'CRITICAL']) {
    const input = defenderDetectionToSecurityEvent({ id: 'x', severity, timestamp: null, threatName: null, resource: null, actionStatus: 'UNKNOWN' });
    assert.doesNotMatch(input.severity, /malware|attack|compromised/i);
  }
});
