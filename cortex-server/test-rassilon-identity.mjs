import './test-setup.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { initSqlite, upsertRassilonIdentity, getRassilonIdentity } from './src/lib/sqlite.js';
import {
  generateDeviceIdentity, getDeviceKeyStatus, signWithDeviceKey, verifyWithPublicKey,
  deleteDeviceKey, computeFingerprint, rassilonDeviceKeyProvider,
} from './src/lib/rassilon-identity.js';
import { canonicalJobBytes, verifyJobSignature } from './src/lib/rassilon-job-schema.js';

const TEST_DB = './data-test-rassilon-identity/test.db';

before(() => {
  fs.rmSync('./data-test-rassilon-identity', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

test('generateDeviceIdentity: returns only public material, never the private key', () => {
  const identity = generateDeviceIdentity('device-a');
  assert.equal(typeof identity.publicKeyPem, 'string');
  assert.equal(typeof identity.fingerprint, 'string');
  assert.equal(identity.privateKey, undefined);
  assert.equal(identity.privateKeyPem, undefined);
});

test('identity creation: key status transitions absent -> valid', () => {
  assert.equal(getDeviceKeyStatus('device-fresh'), 'absent');
  generateDeviceIdentity('device-fresh');
  assert.equal(getDeviceKeyStatus('device-fresh'), 'valid');
});

test('public key fingerprint is stable across repeated computation', () => {
  const identity = generateDeviceIdentity('device-stable');
  const fp1 = computeFingerprint(identity.publicKeyPem);
  const fp2 = computeFingerprint(identity.publicKeyPem);
  assert.equal(fp1, fp2);
  assert.equal(fp1, identity.fingerprint);
});

test('namespace is distinct from OMEGA (rassilon-device-key: prefix, never omega-device-key:)', () => {
  const provider = rassilonDeviceKeyProvider('device-x');
  assert.equal(provider, 'rassilon-device-key:device-x');
  assert.ok(!provider.startsWith('omega-'));
});

test('signature valid: message signed with device key verifies against its own public key', () => {
  const identity = generateDeviceIdentity('device-signer');
  const message = Buffer.from('hello rassilon', 'utf8');
  const signature = signWithDeviceKey('device-signer', message);
  assert.equal(verifyWithPublicKey(identity.publicKeyPem, message, signature), true);
});

test('wrong key: signature does not verify against a different device\'s public key', () => {
  const identityA = generateDeviceIdentity('device-a2');
  generateDeviceIdentity('device-b2');
  const message = Buffer.from('hello', 'utf8');
  const signature = signWithDeviceKey('device-a2', message);
  const identityBWrong = generateDeviceIdentity('device-b2'); // regenerate to get its PEM
  assert.equal(verifyWithPublicKey(identityBWrong.publicKeyPem, message, signature), false);
  assert.notEqual(identityA.fingerprint, identityBWrong.fingerprint);
});

test('mutated job: any single field change invalidates the signature', () => {
  const identity = generateDeviceIdentity('device-job-signer');
  upsertRassilonIdentity({ deviceId: 'device-job-signer', publicKeyPem: identity.publicKeyPem, fingerprint: identity.fingerprint });

  const baseJob = {
    jobId: 'job-0000000000000001',
    jobType: 'SAFE_CPU_TASK',
    issuerId: 'device-job-signer',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5 },
    payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' } },
    policyVersion: 'v1',
  };
  const signature = signWithDeviceKey('device-job-signer', canonicalJobBytes(baseJob)).toString('base64');
  const signedJob = { ...baseJob, signature };

  assert.equal(verifyJobSignature(signedJob, identity.publicKeyPem), true);

  const mutated = { ...signedJob, resourceBudget: { ...signedJob.resourceBudget, cpuPercent: 99 } };
  assert.equal(verifyJobSignature(mutated, identity.publicKeyPem), false);

  const mutatedPayload = { ...signedJob, payload: { ...signedJob.payload, data: { ...signedJob.payload.data, hex: 'cafebabe' } } };
  assert.equal(verifyJobSignature(mutatedPayload, identity.publicKeyPem), false);
});

test('invalid signature: garbage signature value never verifies, never throws', () => {
  const identity = generateDeviceIdentity('device-garbage');
  const message = Buffer.from('x', 'utf8');
  assert.equal(verifyWithPublicKey(identity.publicKeyPem, message, 'not-a-real-signature'), false);
  assert.equal(verifyWithPublicKey('not-a-real-pem', message, 'AAAA'), false);
});

test('revocation: deleteDeviceKey removes the private key, status returns to absent', () => {
  generateDeviceIdentity('device-revoke');
  assert.equal(getDeviceKeyStatus('device-revoke'), 'valid');
  deleteDeviceKey('device-revoke');
  assert.equal(getDeviceKeyStatus('device-revoke'), 'absent');
});

test('rassilon_identity table stores PUBLIC key only — public_key_pem does not contain PRIVATE KEY marker', () => {
  const identity = generateDeviceIdentity('device-db-check');
  upsertRassilonIdentity({ deviceId: 'device-db-check', publicKeyPem: identity.publicKeyPem, fingerprint: identity.fingerprint });
  const row = getRassilonIdentity('device-db-check');
  assert.ok(row.public_key_pem.includes('PUBLIC KEY'));
  assert.ok(!row.public_key_pem.includes('PRIVATE KEY'));
});
