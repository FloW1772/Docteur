// OMEGA V1 Phase 2 — remaining §27/§28/§30 security/secret/performance
// scenarios not already covered by test-omega-identity.mjs/
// test-omega-pairing.mjs/test-omega-session.mjs/test-omega-route.mjs:
//   - cloned DB without the private key cannot complete authentication
//   - corrupted private key blob fails closed, not a crash
//   - 100 device records / many expired pairings / concurrent pairing
//     attempts stay bounded and correct
// Run with: node --test test-omega-security.mjs
import './test-setup.mjs';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initSqlite, getDatabase, setMeta } from './src/lib/sqlite.js';
import {
  startPairing, verifyPairingCode, approvePairing, issueChallenge, verifyDeviceChallenge,
  _resetPairingRateLimitForTests,
} from './src/lib/omega-pairing.js';
import {
  generateDeviceIdentity, signWithDeviceKey, deleteDeviceKey, getDeviceKeyStatus,
} from './src/lib/omega-identity.js';
import { listDevices } from './src/lib/omega-devices.js';

initSqlite(':memory:');
beforeEach(() => { _resetPairingRateLimitForTests(); });

const createdDeviceIds = [];
function freshDeviceId() {
  const id = `test-security-${randomUUID()}`;
  createdDeviceIds.push(id);
  return id;
}
after(() => { for (const id of createdDeviceIds) deleteDeviceKey(id); });

function pairedDevice() {
  const testKeyId = freshDeviceId();
  const identity = generateDeviceIdentity(testKeyId);
  const started = startPairing({ initiatorDeviceName: `Security Test ${testKeyId}`, requestedPermission: 1 });
  verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem });
  const approved = approvePairing(started.pairingId);
  return { deviceId: approved.deviceId, testKeyId };
}

// ── Cloned DB without private key (mission §18/§27) ────────────────

test('a cloned public device record (deviceId + public key, no private key) cannot complete mutual auth', () => {
  const { deviceId, testKeyId } = pairedDevice();

  // Simulate "cloning the database": an attacker who copies the
  // omega_devices row (deviceId, publicKey, fingerprint, etc. — all
  // public/non-secret data) but does NOT possess the private key
  // (which never left the original machine's DPAPI store under
  // testKeyId's namespace) cannot produce a valid signature.
  const challenge = issueChallenge();
  // The clone has no private key at all for a NEW identity claiming to
  // be this same deviceId — simulate by using a namespace the clone
  // was never granted (i.e. it simply doesn't have testKeyId's key).
  // Deleting the real key here stands in for "the clone never had it".
  const originalStatus = getDeviceKeyStatus(testKeyId);
  assert.equal(originalStatus, 'valid');

  // A clone attempting to forge a signature without the private key
  // has nothing to sign with — attempting to sign with a DIFFERENT
  // freshly-generated key (the only thing the "clone" could do without
  // the real private key) still fails verification against the
  // REGISTERED public key.
  const forgedKeyId = freshDeviceId();
  generateDeviceIdentity(forgedKeyId);
  const forgedSignature = signWithDeviceKey(forgedKeyId, challenge).toString('base64');

  const result = verifyDeviceChallenge({ deviceId, challenge, signatureB64: forgedSignature });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_invalid');
});

test('deleting a device\'s private key (simulating a DB-only clone with no key material) makes future signing impossible', () => {
  const { testKeyId } = pairedDevice();
  assert.equal(getDeviceKeyStatus(testKeyId), 'valid');
  deleteDeviceKey(testKeyId);
  assert.equal(getDeviceKeyStatus(testKeyId), 'absent');
  assert.throws(() => signWithDeviceKey(testKeyId, 'anything'), /device_key_unavailable/);
});

// ── Corrupted private key blob (mission §27/§4) ─────────────────────

test('a corrupted private key blob fails closed on sign attempts, never crashes the process', () => {
  const deviceId = freshDeviceId();
  generateDeviceIdentity(deviceId);
  const provider = `omega-device-key:${deviceId}`;
  // Corrupt the ciphertext directly, same technique as
  // test-omega-identity.mjs's corrupted-blob test, but here exercised
  // through signWithDeviceKey() specifically (the actual usage path
  // rather than just the status check).
  setMeta(`secret_dpapi:${provider}`, { ciphertext: 'garbage-not-real-ciphertext' });
  // The in-process decrypt cache from generateDeviceIdentity() would
  // normally still serve the good key; to genuinely exercise the
  // corrupted path we use a device id that was never cached.
  const uncachedDeviceId = freshDeviceId();
  setMeta(`secret_dpapi:omega-device-key:${uncachedDeviceId}`, { ciphertext: 'garbage-not-real-ciphertext' });
  assert.throws(() => signWithDeviceKey(uncachedDeviceId, 'msg'), /device_key_unavailable|device_key_corrupted/);
});

// ── Performance / bounded scans (mission §30) ───────────────────────

test('100 device records: listDevices() completes quickly and returns exactly that many', async () => {
  // Real generateDeviceIdentity() shells out to PowerShell/DPAPI per
  // call (~200ms each — see omega-identity.js/secret-store.js), so
  // generating 100 REAL device keys here would only measure subprocess
  // spawn overhead, not the thing mission §30 actually asks about:
  // whether listDevices()'s SQL query is a bounded, indexed read at
  // scale. Insert device rows directly at the DB layer (same shape
  // insertOmegaDevice() itself writes — public data only, no key
  // material involved either way since omega_devices never stores a
  // private key) to isolate query performance from key-generation cost.
  const { insertOmegaDevice } = await import('./src/lib/sqlite.js');
  const before = listDevices().length;
  const { randomBytes, createHash } = await import('node:crypto');
  for (let i = 0; i < 100; i++) {
    const fakePub = randomBytes(32).toString('hex');
    insertOmegaDevice({
      id: randomUUID(),
      display_name: `Perf Device ${i}`,
      public_key_pem: fakePub,
      fingerprint: createHash('sha256').update(fakePub).digest('hex'),
      permission_level: 1,
    });
  }
  const start = Date.now();
  const all = listDevices();
  const elapsedMs = Date.now() - start;
  assert.equal(all.length, before + 100);
  assert.ok(elapsedMs < 500, `listDevices() took ${elapsedMs}ms for ${all.length} rows`);
});

test('many expired pairings: expireStaleOmegaPairings-driven cleanup keeps PENDING lookups bounded', () => {
  const db = getDatabase();
  const now = new Date();
  const past = new Date(now.getTime() - 60_000).toISOString();

  for (let i = 0; i < 50; i++) {
    const started = startPairing({ initiatorDeviceName: `Expiring Bulk ${i}`, requestedPermission: 1 });
    _resetPairingRateLimitForTests();
    db.prepare('UPDATE omega_pairings SET expires_at = ? WHERE id = ?').run(past, started.pairingId);
  }

  // Starting one more pairing triggers the opportunistic cleanup
  // (expireStaleOmegaPairings) inside startPairing() itself.
  const t0 = Date.now();
  startPairing({ initiatorDeviceName: 'Trigger Cleanup', requestedPermission: 1 });
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 500, `startPairing() cleanup took ${elapsedMs}ms`);

  const stillPending = db.prepare("SELECT COUNT(*) as n FROM omega_pairings WHERE status = 'PENDING' AND expires_at < ?").get(now.toISOString());
  assert.equal(stillPending.n, 0);
});

test('concurrent pairing attempts (same code, parallel verify calls) only let exactly one succeed', async () => {
  const testKeyId = freshDeviceId();
  const identity = generateDeviceIdentity(testKeyId);
  const started = startPairing({ initiatorDeviceName: 'Concurrent Verify Device', requestedPermission: 1 });

  // better-sqlite3 is synchronous, so "concurrent" here means
  // interleaved synchronous calls within the same microtask batch —
  // still a meaningful test that a second verify on an
  // already-AWAITING_APPROVAL pairing cannot ALSO succeed.
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem })),
    Promise.resolve().then(() => verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem })),
  ]);

  const fulfilled = attempts.filter(a => a.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent verify should succeed, the other must fail (already AWAITING_APPROVAL/consumed)');
});
