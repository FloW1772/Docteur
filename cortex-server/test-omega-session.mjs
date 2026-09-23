// OMEGA V1 Phase 2 — session token / binding / anti-replay / revocation
// tests. Run with: node --test test-omega-session.mjs
import './test-setup.mjs';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initSqlite } from './src/lib/sqlite.js';
import {
  startPairing, verifyPairingCode, approvePairing, _resetPairingRateLimitForTests,
  OMEGA_PERMISSION_LEVELS,
} from './src/lib/omega-pairing.js';
import { generateDeviceIdentity, deleteDeviceKey } from './src/lib/omega-identity.js';
import { revokeDevice } from './src/lib/omega-devices.js';
import {
  createSession, validateAndAdvanceSession, endSession, getSession, OmegaSessionError,
} from './src/lib/omega-session.js';

initSqlite(':memory:');
beforeEach(() => { _resetPairingRateLimitForTests(); });

const createdDeviceIds = [];
function freshDeviceId() {
  const id = `test-session-${randomUUID()}`;
  createdDeviceIds.push(id);
  return id;
}
after(() => { for (const id of createdDeviceIds) deleteDeviceKey(id); });

function pairedDevice({ permission = OMEGA_PERMISSION_LEVELS.OMEGA_VIEW } = {}) {
  const testKeyId = freshDeviceId();
  const identity = generateDeviceIdentity(testKeyId);
  const started = startPairing({ initiatorDeviceName: `Session Test Device ${testKeyId}`, requestedPermission: permission });
  verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem });
  const approved = approvePairing(started.pairingId);
  return { deviceId: approved.deviceId, testKeyId, identity };
}

// ── Session creation + binding (mission §14/§15) ───────────────────

test('session is created with the device\'s server-assigned permission level, not a client value', () => {
  const { deviceId } = pairedDevice({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE });
  const session = createSession({ deviceId });
  assert.equal(session.permissionLevel, OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE);
});

test('createSession ignores any attempt to pass a permissionLevel directly (function has no such parameter)', () => {
  const { deviceId } = pairedDevice({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_VIEW });
  // Simulate a caller trying to smuggle a higher level — extra
  // properties are simply not read by createSession()'s destructuring.
  const session = createSession({ deviceId, permissionLevel: OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN });
  assert.equal(session.permissionLevel, OMEGA_PERMISSION_LEVELS.OMEGA_VIEW);
});

test('creating a session for an unknown device fails', () => {
  assert.throws(() => createSession({ deviceId: 'nonexistent-device' }),
    (err) => err instanceof OmegaSessionError && err.code === 'device_not_found');
});

test('creating a session for a revoked device fails', () => {
  const { deviceId } = pairedDevice();
  revokeDevice(deviceId);
  assert.throws(() => createSession({ deviceId }),
    (err) => err instanceof OmegaSessionError && err.code === 'device_revoked');
});

// ── Validation + device binding (mission §15/T6) ────────────────────

test('a valid session validates successfully with its own nonce', () => {
  const { deviceId } = pairedDevice();
  const session = createSession({ deviceId });
  const result = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(result.valid, true);
  assert.equal(typeof result.nextNonce, 'string');
  assert.notEqual(result.nextNonce, session.nonce);
});

test('a session token presented with the WRONG deviceId is rejected (device binding)', () => {
  const { deviceId: deviceA } = pairedDevice();
  const { deviceId: deviceB } = pairedDevice();
  const session = createSession({ deviceId: deviceA });
  const result = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId: deviceB, presentedNonce: session.nonce });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'wrong_device');
});

test('wrong sessionId (nonexistent) is rejected', () => {
  const result = validateAndAdvanceSession({ sessionId: 'nonexistent-session-id', deviceId: 'x', presentedNonce: 'y' });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'session_not_found');
});

// ── Anti-replay (mission §16) ───────────────────────────────────────

test('replaying the exact same request (same nonce twice) is rejected on the second attempt', () => {
  const { deviceId } = pairedDevice();
  const session = createSession({ deviceId });
  const first = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(first.valid, true);
  const replay = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(replay.valid, false);
  assert.equal(replay.reason, 'nonce_invalid_or_replayed');
});

test('an old/stale nonce (never the current expected one) is rejected', () => {
  const { deviceId } = pairedDevice();
  const session = createSession({ deviceId });
  const step1 = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(step1.valid, true);
  // step1.nextNonce is now current; presenting the ORIGINAL nonce again is stale.
  const stale = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(stale.valid, false);
  // Using the correct current nonce succeeds.
  const step2 = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: step1.nextNonce });
  assert.equal(step2.valid, true);
});

test('a copied token used by a second "attacker" after the legitimate holder already advanced the nonce fails', () => {
  const { deviceId } = pairedDevice();
  const session = createSession({ deviceId });
  // Legitimate holder advances first.
  const legit = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(legit.valid, true);
  // Attacker who copied the ORIGINAL sessionId+nonce pair (e.g. from a
  // sniffed first request) tries to replay it — fails because the
  // nonce already advanced.
  const attacker = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(attacker.valid, false);
});

// ── Expiration ───────────────────────────────────────────────────────

test('an expired session is rejected', async () => {
  const db = await import('./src/lib/sqlite.js');
  const { deviceId } = pairedDevice();
  const session = createSession({ deviceId });
  const past = new Date(Date.now() - 60_000).toISOString();
  db.getDatabase().prepare('UPDATE omega_sessions SET expires_at = ? WHERE id = ?').run(past, session.sessionId);
  const result = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'session_expired');
});

// ── Revocation invalidates active sessions immediately (mission §17/§18) ──

test('revoking a device invalidates its active session on the NEXT validation call, not just at natural expiry', () => {
  const { deviceId } = pairedDevice();
  const session = createSession({ deviceId });
  const before = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(before.valid, true);

  revokeDevice(deviceId);

  const after_ = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: before.nextNonce });
  assert.equal(after_.valid, false);
  assert.ok(['session_revoked', 'device_revoked'].includes(after_.reason));
});

test('revoked device cannot create a NEW session even with a previously-valid deviceId', () => {
  const { deviceId } = pairedDevice();
  revokeDevice(deviceId);
  assert.throws(() => createSession({ deviceId }), (err) => err.code === 'device_revoked');
});

// ── endSession / manual termination ─────────────────────────────────

test('endSession makes the session unusable immediately', () => {
  const { deviceId } = pairedDevice();
  const session = createSession({ deviceId });
  endSession(session.sessionId);
  const result = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'session_ended');
});

test('endSession is a global STOP for VIEW and INTERACTIVE state', async () => {
  const { deviceId } = pairedDevice({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN });
  const session = createSession({ deviceId });
  const db = await import('./src/lib/sqlite.js');
  db.insertOmegaViewSession({ session_id: session.sessionId, device_id: deviceId, screen_index: 0 });
  db.insertOmegaInteractiveSession({ session_id: session.sessionId, device_id: deviceId });

  endSession(session.sessionId);

  assert.ok(db.getOmegaViewSession(session.sessionId).stopped_at);
  assert.ok(db.getOmegaInteractiveSession(session.sessionId).stopped_at);
});

test('endSession on a nonexistent session throws session_not_found', () => {
  assert.throws(() => endSession('nonexistent-session-id'), /session_not_found/);
});

// ── getSession never leaks the nonce material ───────────────────────

test('getSession never includes nonce fields in its returned shape', () => {
  const { deviceId } = pairedDevice();
  const session = createSession({ deviceId });
  const fetched = getSession(session.sessionId);
  assert.equal('nonce' in fetched, false);
  assert.equal('last_used_nonce' in fetched, false);
  assert.equal(fetched.live, true);
});

// ── Permission tampering (mission §27) ──────────────────────────────

test('a VIEW-level session cannot present itself as INTERACTIVE — permission is read from the session record, not the request', () => {
  const { deviceId } = pairedDevice({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_VIEW });
  const session = createSession({ deviceId });
  // validateAndAdvanceSession has no "requestedPermission" input at
  // all — the ONLY permission value ever returned is the one stored on
  // the session row at creation time, so there is no code path by
  // which a caller can tamper with it via this API.
  const result = validateAndAdvanceSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce });
  assert.equal(result.permissionLevel, OMEGA_PERMISSION_LEVELS.OMEGA_VIEW);
});
