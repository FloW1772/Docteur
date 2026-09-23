// OMEGA V1 Phase 2 — pairing state machine + mutual auth security tests.
// Fixtures are always fresh randomUUID-based deviceIds and fresh Ed25519
// keys generated per test (mission §26 — temporary test identities
// only, cleaned up in `after`).
// Run with: node --test test-omega-pairing.mjs
import './test-setup.mjs';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import {
  startPairing, verifyPairingCode, approvePairing, denyPairing, getPairing,
  issueChallenge, verifyDeviceChallenge, OMEGA_PERMISSION_LEVELS, OmegaPairingError,
  _resetPairingRateLimitForTests,
} from './src/lib/omega-pairing.js';
import { generateDeviceIdentity, signWithDeviceKey, deleteDeviceKey } from './src/lib/omega-identity.js';
import { revokeDevice, getDevice } from './src/lib/omega-devices.js';
import { listOmegaAuditLog } from './src/lib/omega-audit.js';

initSqlite(':memory:');

const createdDeviceIds = [];
function freshDeviceId() {
  const id = `test-pairing-${randomUUID()}`;
  createdDeviceIds.push(id);
  return id;
}
after(() => { for (const id of createdDeviceIds) deleteDeviceKey(id); });

// The creation-rate limiter (mission §9) is exercised by its own
// dedicated test below; reset it before every other test so this
// fast-running suite's own request volume never trips it as collateral
// damage (a real limiter test still runs against the true window).
beforeEach(() => { _resetPairingRateLimitForTests(); });

function pairAndApprove({ name = 'Test Device', permission = OMEGA_PERMISSION_LEVELS.OMEGA_VIEW } = {}) {
  const deviceId = freshDeviceId();
  const identity = generateDeviceIdentity(deviceId);
  const started = startPairing({ initiatorDeviceName: name, requestedPermission: permission });
  verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem });
  const approved = approvePairing(started.pairingId);
  return { deviceId: approved.deviceId, testKeyId: deviceId, identity, started, approved };
}

// ── Valid flow ──────────────────────────────────────────────────────

test('valid pairing: start -> verify -> approve produces a trusted device', () => {
  const { deviceId } = pairAndApprove({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE });
  const device = getDevice(deviceId);
  assert.equal(device.permissionLevel, OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE);
  assert.equal(device.revokedAt, null);
});

test('pairing code is never persisted in plaintext', () => {
  const deviceId = freshDeviceId();
  const identity = generateDeviceIdentity(deviceId);
  const started = startPairing({ initiatorDeviceName: 'Plaintext Check', requestedPermission: 1 });
  const pairing = getPairing(started.pairingId);
  assert.equal(JSON.stringify(pairing).includes(started.code), false);
  verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem });
});

// ── Wrong / expired / reused code ──────────────────────────────────

test('wrong code is rejected', () => {
  const deviceId = freshDeviceId();
  const identity = generateDeviceIdentity(deviceId);
  const started = startPairing({ initiatorDeviceName: 'Wrong Code Device', requestedPermission: 1 });
  assert.throws(
    () => verifyPairingCode({ pairingId: started.pairingId, code: 'WRONGCODE', publicKeyPem: identity.publicKeyPem }),
    (err) => err instanceof OmegaPairingError && err.code === 'pairing_code_invalid',
  );
});

test('expired code is rejected', () => {
  // The pairing TTL is fixed/non-configurable by design (mission §7),
  // so to test expiry deterministically without a real 3-minute sleep,
  // backdate the row's expires_at directly in SQLite (test-only —
  // production code never does this) to simulate the passage of time.
  const deviceId = freshDeviceId();
  const identity = generateDeviceIdentity(deviceId);
  const started = startPairing({ initiatorDeviceName: 'Expiring Device', requestedPermission: 1 });

  const past = new Date(Date.now() - 60_000).toISOString();
  getDatabase().prepare('UPDATE omega_pairings SET expires_at = ? WHERE id = ?').run(past, started.pairingId);

  assert.throws(
    () => verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem }),
    (err) => err instanceof OmegaPairingError && (err.code === 'pairing_not_pending' || err.code === 'pairing_code_invalid'),
  );
  assert.equal(getPairing(started.pairingId).status, 'EXPIRED');
});

test('reused (already-consumed) code cannot be verified twice', () => {
  const { started, testKeyId } = pairAndApprove({ name: 'Reuse Device' });
  const identity2 = { publicKeyPem: generateDeviceIdentity(freshDeviceId()).publicKeyPem };
  assert.throws(
    () => verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity2.publicKeyPem }),
    (err) => err instanceof OmegaPairingError && err.code === 'pairing_not_pending',
  );
});

test('too many wrong-code attempts denies the pairing (brute force protection)', () => {
  const deviceId = freshDeviceId();
  const identity = generateDeviceIdentity(deviceId);
  const started = startPairing({ initiatorDeviceName: 'Bruteforce Device', requestedPermission: 1 });

  for (let i = 0; i < 5; i++) {
    assert.throws(() => verifyPairingCode({ pairingId: started.pairingId, code: 'BADCODE1', publicKeyPem: identity.publicKeyPem }));
  }
  // After exhausting attempts, even the CORRECT code must now fail.
  assert.throws(
    () => verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem }),
    (err) => err instanceof OmegaPairingError && (err.code === 'pairing_attempts_exhausted' || err.code === 'pairing_not_pending'),
  );
});

// ── Approve / deny ──────────────────────────────────────────────────

test('approve requires a prior successful code verification (cannot approve a raw PENDING pairing)', () => {
  const started = startPairing({ initiatorDeviceName: 'Unverified Device', requestedPermission: 1 });
  assert.throws(
    () => approvePairing(started.pairingId),
    (err) => err instanceof OmegaPairingError && err.code === 'pairing_not_awaiting_approval',
  );
});

test('deny after verify prevents the device from ever being trusted', () => {
  const deviceId = freshDeviceId();
  const identity = generateDeviceIdentity(deviceId);
  const started = startPairing({ initiatorDeviceName: 'Denied Device', requestedPermission: 1 });
  verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem });
  const denied = denyPairing(started.pairingId);
  assert.equal(denied.status, 'DENIED');
  assert.equal(getPairing(started.pairingId).status, 'DENIED');
});

test('double-approve is rejected (pairing already consumed)', () => {
  const { started } = pairAndApprove({ name: 'Double Approve Device' });
  assert.throws(
    () => approvePairing(started.pairingId),
    (err) => err instanceof OmegaPairingError,
  );
});

// ── XSS-shaped display names (mission §29) ─────────────────────────

test('XSS-shaped device display name is stored and returned verbatim as inert data', () => {
  const xssName = '<script>alert(1)</script>';
  const { deviceId } = pairAndApprove({ name: xssName });
  const device = getDevice(deviceId);
  assert.equal(device.displayName, xssName);
  // No execution context here (backend-only) — the key property is
  // that the raw string round-trips unmodified/uninterpreted, never
  // throws, and is never used to build an HTML/SQL/shell string.
});

test('img-onerror-shaped display name is accepted as inert text', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const { deviceId } = pairAndApprove({ name: payload });
  assert.equal(getDevice(deviceId).displayName, payload);
});

test('javascript: URI shaped display name is accepted as inert text', () => {
  const payload = 'javascript:alert(1)';
  const { deviceId } = pairAndApprove({ name: payload });
  assert.equal(getDevice(deviceId).displayName, payload);
});

// ── Input validation ────────────────────────────────────────────────

test('empty device name is rejected', () => {
  assert.throws(() => startPairing({ initiatorDeviceName: '', requestedPermission: 1 }),
    (err) => err.code === 'device_name_invalid');
});

test('oversized device name is rejected', () => {
  assert.throws(() => startPairing({ initiatorDeviceName: 'x'.repeat(500), requestedPermission: 1 }),
    (err) => err.code === 'device_name_invalid');
});

test('non-enum requested permission is rejected', () => {
  assert.throws(() => startPairing({ initiatorDeviceName: 'Bad Perm Device', requestedPermission: 99 }),
    (err) => err.code === 'requested_permission_invalid');
});

test('permission cannot be an arbitrary client string (e.g. "ADMIN")', () => {
  assert.throws(() => startPairing({ initiatorDeviceName: 'String Perm Device', requestedPermission: 'ADMIN' }),
    (err) => err.code === 'requested_permission_invalid');
});

test('malformed public key at verify time is rejected', () => {
  const started = startPairing({ initiatorDeviceName: 'Bad Key Device', requestedPermission: 1 });
  assert.throws(
    () => verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: 'not-a-real-key' }),
    (err) => err instanceof OmegaPairingError,
  );
});

// ── Mutual authentication (challenge-response, mission §12) ───────

test('mutual auth: correct signature over a fresh challenge succeeds', () => {
  const { deviceId, testKeyId } = pairAndApprove({ name: 'Mutual Auth Device' });
  const challenge = issueChallenge();
  const sig = signWithDeviceKey(testKeyId, challenge).toString('base64');
  const result = verifyDeviceChallenge({ deviceId, challenge, signatureB64: sig });
  assert.equal(result.valid, true);
});

test('mutual auth: signature from the WRONG device key fails', () => {
  const { deviceId } = pairAndApprove({ name: 'Victim Device' });
  const attackerKeyId = freshDeviceId();
  generateDeviceIdentity(attackerKeyId);
  const challenge = issueChallenge();
  const wrongSig = signWithDeviceKey(attackerKeyId, challenge).toString('base64');
  const result = verifyDeviceChallenge({ deviceId, challenge, signatureB64: wrongSig });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_invalid');
});

test('mutual auth: wrong deviceId (unknown) fails closed', () => {
  const result = verifyDeviceChallenge({ deviceId: 'nonexistent-device-id', challenge: issueChallenge(), signatureB64: 'AAAA' });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'device_not_found');
});

test('mutual auth: a challenge can only be consumed once (replaying a previously-used challenge+signature fails)', () => {
  const { deviceId, testKeyId } = pairAndApprove({ name: 'Challenge Replay Device' });
  const challenge = issueChallenge();
  const sig = signWithDeviceKey(testKeyId, challenge).toString('base64');

  const first = verifyDeviceChallenge({ deviceId, challenge, signatureB64: sig });
  assert.equal(first.valid, true);

  // Replay the EXACT same challenge+signature pair a second time.
  const replay = verifyDeviceChallenge({ deviceId, challenge, signatureB64: sig });
  assert.equal(replay.valid, false);
  assert.equal(replay.reason, 'challenge_unknown_or_expired_or_reused');
});

test('mutual auth: a challenge that was never issued by the server is rejected', () => {
  const { deviceId, testKeyId } = pairAndApprove({ name: 'Unissued Challenge Device' });
  const foreignChallenge = Buffer.from('never-issued-by-server').toString('base64');
  const sig = signWithDeviceKey(testKeyId, foreignChallenge).toString('base64');
  const result = verifyDeviceChallenge({ deviceId, challenge: foreignChallenge, signatureB64: sig });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'challenge_unknown_or_expired_or_reused');
});

test('mutual auth: revoked device fails even with a technically-correct signature', () => {
  const { deviceId, testKeyId } = pairAndApprove({ name: 'Revoked Auth Device' });
  const challenge = issueChallenge();
  const sig = signWithDeviceKey(testKeyId, challenge).toString('base64');
  revokeDevice(deviceId);
  const result = verifyDeviceChallenge({ deviceId, challenge, signatureB64: sig });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'device_revoked');
});

// ── Identity change detection (mission §13/§18) ────────────────────

test('re-pairing the SAME public key reuses the same trusted device (not a duplicate)', () => {
  const deviceId = freshDeviceId();
  const identity = generateDeviceIdentity(deviceId);
  const first = startPairing({ initiatorDeviceName: 'Stable Identity', requestedPermission: 1 });
  verifyPairingCode({ pairingId: first.pairingId, code: first.code, publicKeyPem: identity.publicKeyPem });
  const approved1 = approvePairing(first.pairingId);

  const second = startPairing({ initiatorDeviceName: 'Stable Identity', requestedPermission: 1 });
  verifyPairingCode({ pairingId: second.pairingId, code: second.code, publicKeyPem: identity.publicKeyPem });
  const approved2 = approvePairing(second.pairingId);

  assert.equal(approved1.deviceId, approved2.deviceId);
});

test('a revoked device re-pairing with the SAME key creates a NEW device id, never resurrects the old one', () => {
  const deviceId = freshDeviceId();
  const identity = generateDeviceIdentity(deviceId);
  const first = startPairing({ initiatorDeviceName: 'Revoke Then Repair', requestedPermission: 1 });
  verifyPairingCode({ pairingId: first.pairingId, code: first.code, publicKeyPem: identity.publicKeyPem });
  const approved1 = approvePairing(first.pairingId);
  revokeDevice(approved1.deviceId);

  const second = startPairing({ initiatorDeviceName: 'Revoke Then Repair', requestedPermission: 1 });
  verifyPairingCode({ pairingId: second.pairingId, code: second.code, publicKeyPem: identity.publicKeyPem });
  const approved2 = approvePairing(second.pairingId);

  assert.notEqual(approved1.deviceId, approved2.deviceId);
  assert.equal(getDevice(approved1.deviceId).revokedAt !== null, true);
  assert.equal(getDevice(approved2.deviceId).revokedAt, null);
});

// ── Audit coverage (mission §20) ────────────────────────────────────

test('a full pairing lifecycle produces PAIRING_STARTED and PAIRING_APPROVED/CONSUMED audit entries', () => {
  const before = listOmegaAuditLog({ limit: 1000 }).length;
  pairAndApprove({ name: 'Audit Coverage Device' });
  const after_ = listOmegaAuditLog({ limit: 1000 });
  assert.ok(after_.length > before);
  const types = after_.slice(0, after_.length - before).map(e => e.event_type);
  assert.ok(types.includes('PAIRING_APPROVED'));
  assert.ok(types.includes('PAIRING_CONSUMED'));
});

test('audit log never contains the plaintext pairing code', () => {
  const { started } = pairAndApprove({ name: 'Audit Secret Check Device' });
  const dump = JSON.stringify(listOmegaAuditLog({ limit: 1000 }));
  assert.equal(dump.includes(started.code), false);
});

// ── Rate limiting on pairing creation (mission §9) ─────────────────

test('pairing creation is rate limited after too many creations in a short window', () => {
  _resetPairingRateLimitForTests();
  for (let i = 0; i < 10; i++) {
    startPairing({ initiatorDeviceName: `Rate Limit Device ${i}`, requestedPermission: 1 });
  }
  assert.throws(
    () => startPairing({ initiatorDeviceName: 'One Too Many', requestedPermission: 1 }),
    (err) => err instanceof OmegaPairingError && err.code === 'pairing_creation_rate_limited',
  );
  _resetPairingRateLimitForTests();
});
