// OMEGA V1 Phase 2 — device identity + private key storage tests.
// Uses isolated in-memory SQLite + real DPAPI (Windows CurrentUser) via
// secret-store.js, under the omega-device-key: namespace, which is
// harmless to exercise for real in a test since it's scoped to this
// test's own throwaway device ids (mission §26 — temporary test
// identities only, never real user OMEGA keys).
// Run with: node --test test-omega-identity.mjs
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initSqlite, setMeta } from './src/lib/sqlite.js';
import {
  generateDeviceIdentity, getDeviceKeyStatus, signWithDeviceKey,
  verifyWithPublicKey, computeFingerprint, deleteDeviceKey,
} from './src/lib/omega-identity.js';

initSqlite(':memory:');

const createdDeviceIds = [];
function freshDeviceId() {
  const id = `test-identity-${randomUUID()}`;
  createdDeviceIds.push(id);
  return id;
}

after(() => {
  // Cleanup: never leave test key material in the real DPAPI store.
  for (const id of createdDeviceIds) deleteDeviceKey(id);
});

test('generateDeviceIdentity returns only public material, never the private key', () => {
  const deviceId = freshDeviceId();
  const identity = generateDeviceIdentity(deviceId);
  assert.ok(identity.publicKeyPem.includes('PUBLIC KEY'));
  assert.equal(typeof identity.fingerprint, 'string');
  assert.equal(identity.fingerprint.length, 64); // sha256 hex
  assert.equal('privateKey' in identity, false);
  assert.equal('privateKeyPem' in identity, false);
  assert.equal(JSON.stringify(identity).includes('PRIVATE KEY'), false);
});

test('private key is retrievable for signing but status API never returns key material', () => {
  const deviceId = freshDeviceId();
  generateDeviceIdentity(deviceId);
  const status = getDeviceKeyStatus(deviceId);
  assert.equal(status, 'valid');
});

test('missing key reports absent status, not an error', () => {
  const status = getDeviceKeyStatus('never-created-device-id');
  assert.equal(status, 'absent');
});

test('corrupted blob reports invalid status, not a crash', () => {
  // Deliberately never call generateDeviceIdentity()/setSecret() for
  // this deviceId first — secret-store.js caches a successful
  // encrypt/decrypt in-process (decryptedCache), so corrupting the
  // blob AFTER a successful round-trip would just be served from that
  // cache rather than genuinely exercising the corrupted-blob path.
  // Writing a garbage ciphertext directly for a device id that was
  // NEVER read/written in this process simulates a blob corrupted at
  // rest (or written by a different Windows user/machine) before
  // Docteur ever touches it this session.
  const deviceId = freshDeviceId();
  const provider = `omega-device-key:${deviceId}`;
  setMeta(`secret_dpapi:${provider}`, { ciphertext: 'not-valid-base64-ciphertext!!' });
  const status = getDeviceKeyStatus(deviceId);
  assert.equal(status, 'invalid');
});

test('sign + verify round-trip succeeds with the correct key', () => {
  const deviceId = freshDeviceId();
  const { publicKeyPem } = generateDeviceIdentity(deviceId);
  const message = 'omega-challenge-12345';
  const signature = signWithDeviceKey(deviceId, message);
  assert.equal(verifyWithPublicKey(publicKeyPem, message, signature), true);
});

test('verify fails with a different device\'s public key (wrong key)', () => {
  const deviceA = freshDeviceId();
  const deviceB = freshDeviceId();
  generateDeviceIdentity(deviceA);
  const { publicKeyPem: pubB } = generateDeviceIdentity(deviceB);
  const message = 'shared-challenge-value';
  const sigA = signWithDeviceKey(deviceA, message);
  assert.equal(verifyWithPublicKey(pubB, message, sigA), false);
});

test('verify fails for a tampered message', () => {
  const deviceId = freshDeviceId();
  const { publicKeyPem } = generateDeviceIdentity(deviceId);
  const signature = signWithDeviceKey(deviceId, 'original-message');
  assert.equal(verifyWithPublicKey(publicKeyPem, 'tampered-message', signature), false);
});

test('signWithDeviceKey throws for a device with no stored key', () => {
  assert.throws(() => signWithDeviceKey('no-such-device-id', 'msg'), /device_key_unavailable/);
});

test('computeFingerprint is deterministic for the same public key', () => {
  const deviceId = freshDeviceId();
  const { publicKeyPem, fingerprint } = generateDeviceIdentity(deviceId);
  assert.equal(computeFingerprint(publicKeyPem), fingerprint);
});

test('two generated identities never collide in fingerprint', () => {
  const d1 = freshDeviceId();
  const d2 = freshDeviceId();
  const i1 = generateDeviceIdentity(d1);
  const i2 = generateDeviceIdentity(d2);
  assert.notEqual(i1.fingerprint, i2.fingerprint);
});

test('deleteDeviceKey makes the key status absent again', () => {
  const deviceId = freshDeviceId();
  generateDeviceIdentity(deviceId);
  assert.equal(getDeviceKeyStatus(deviceId), 'valid');
  deleteDeviceKey(deviceId);
  assert.equal(getDeviceKeyStatus(deviceId), 'absent');
});
