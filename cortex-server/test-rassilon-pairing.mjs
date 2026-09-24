import './test-setup.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  getRassilonDevice, initSqlite, setRassilonLocalDevice, upsertRassilonIdentity,
} from './src/lib/sqlite.js';
import { computeFingerprint, generateDeviceIdentity } from './src/lib/rassilon-identity.js';
import {
  canonicalPairingComplete, canonicalPairingRequest, completeRassilonPairing, confirmRassilonPairing,
  rejectRassilonPairing, requestRassilonPairing, startRassilonPairing,
} from './src/lib/rassilon-pairing.js';

const TEST_DB = './data-test-rassilon-pairing/test.db';
const controllerKeys = crypto.generateKeyPairSync('ed25519');
const controllerPublicKeyPem = controllerKeys.publicKey.export({ type: 'spki', format: 'pem' });
const controllerFingerprint = computeFingerprint(controllerPublicKeyPem);

before(() => {
  fs.rmSync('./data-test-rassilon-pairing', { recursive: true, force: true });
  initSqlite(TEST_DB);
  const worker = generateDeviceIdentity('worker-pairing-001');
  setRassilonLocalDevice({ deviceId: 'worker-pairing-001', displayName: 'Worker' });
  upsertRassilonIdentity({ deviceId: 'worker-pairing-001', publicKeyPem: worker.publicKeyPem, fingerprint: worker.fingerprint });
});

function requestFor(offer, overrides = {}) {
  const unsigned = {
    pairingId: offer.pairingId, code: offer.code, workerNonce: offer.workerNonce,
    expectedWorkerFingerprint: offer.worker.fingerprint, controllerDeviceId: 'controller-pairing-001',
    controllerPublicKeyPem, controllerFingerprint, controllerNonce: crypto.randomBytes(24).toString('base64url'),
    controllerDisplayName: 'Controller', requestedPermissions: ['RASSILON_COMPUTE_SAFE'], ...overrides,
  };
  return { ...unsigned, signature: crypto.sign(null, canonicalPairingRequest(unsigned), controllerKeys.privateKey).toString('base64') };
}

test('valid mutual pairing requires request proof, local confirmation, then one-time completion', () => {
  const offer = startRassilonPairing();
  const request = requestFor(offer);
  const response = requestRassilonPairing(request);
  assert.equal(response.state, 'AWAITING_LOCAL_CONFIRMATION');
  assert.throws(() => completeRassilonPairing({ pairingId: offer.pairingId, controllerNonce: request.controllerNonce, signature: 'invalid' }), /local_confirmation_required/);
  confirmRassilonPairing(offer.pairingId, { approvedPermissions: ['RASSILON_COMPUTE_SAFE'] });
  const completion = { pairingId: offer.pairingId, controllerNonce: request.controllerNonce };
  completion.signature = crypto.sign(null, canonicalPairingComplete(completion), controllerKeys.privateKey).toString('base64');
  const session = completeRassilonPairing(completion);
  assert.equal(session.controllerDeviceId, request.controllerDeviceId);
  assert.deepEqual(getRassilonDevice(request.controllerDeviceId).permissionSet, ['RASSILON_COMPUTE_SAFE']);
  assert.throws(() => completeRassilonPairing(completion), /pairing_already_used/);
});

test('expired pairing challenge is rejected', () => {
  const now = Date.now();
  const offer = startRassilonPairing({ ttlMs: 10_000, now });
  assert.throws(() => requestRassilonPairing(requestFor(offer), { now: now + 10_001 }), /pairing_expired/);
});

test('wrong worker fingerprint and mutated worker challenge are rejected', () => {
  const offerA = startRassilonPairing();
  assert.throws(() => requestRassilonPairing(requestFor(offerA, { expectedWorkerFingerprint: '0'.repeat(64) })), /worker_fingerprint_mismatch/);
  const offerB = startRassilonPairing();
  assert.throws(() => requestRassilonPairing(requestFor(offerB, { workerNonce: 'mutated-challenge-value' })), /worker_challenge_mismatch/);
});

test('wrong controller key proof is rejected', () => {
  const offer = startRassilonPairing();
  const request = requestFor(offer);
  request.signature = crypto.sign(null, canonicalPairingRequest(request), crypto.generateKeyPairSync('ed25519').privateKey).toString('base64');
  assert.throws(() => requestRassilonPairing(request), /controller_proof_invalid/);
});

test('local user rejection permanently cancels the token', () => {
  const offer = startRassilonPairing();
  const request = requestFor(offer);
  requestRassilonPairing(request);
  assert.equal(rejectRassilonPairing(offer.pairingId).state, 'CANCELLED');
  assert.throws(() => confirmRassilonPairing(offer.pairingId, { approvedPermissions: [] }), /pairing_cancelled/);
});

test('worker cannot grant a permission that controller did not request', () => {
  const offer = startRassilonPairing();
  requestRassilonPairing(requestFor(offer));
  assert.throws(() => confirmRassilonPairing(offer.pairingId, { approvedPermissions: ['RASSILON_EMBEDDING'] }), /permission_not_requested/);
});
