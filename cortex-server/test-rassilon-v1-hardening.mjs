import './test-setup.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  createRassilonSession, getRassilonLanSettings, getRassilonSession, initSqlite, revokeRassilonDevice,
  setRassilonLanSettings, upsertRassilonDevice, upsertRassilonIdentity,
} from './src/lib/sqlite.js';
import {
  authenticateLanRequest, canonicalRequestBytes, createRateLimiter, requiredPermissionForJob, sha256Base64,
} from './src/lib/rassilon-lan-auth.js';
import { computeFingerprint } from './src/lib/rassilon-identity.js';
import {
  canonicalPairingRequest, requestRassilonPairing, startRassilonPairing,
} from './src/lib/rassilon-pairing.js';
import { canonicalJobBytes, JOB_TYPES, validateJobSchema } from './src/lib/rassilon-job-schema.js';
import { AVAILABLE_EXECUTORS } from './src/lib/rassilon-executors.js';
import {
  __forceErrorStateForTests, __runSafetyGuardSweepForTests, enableRassilon, getJob, getRassilonStatus,
  initRassilonWorker, resetRassilonWorkerForTests,
} from './src/lib/rassilon-worker.js';
import { createRassilonLanRoute } from './src/routes/rassilon-lan.js';
import { createRassilonRoute } from './src/routes/rassilon.js';
import { pollRassilonRemoteResult, requestOutboundRassilonPairing } from './src/lib/rassilon-controller.js';
import { createSignedRemoteResult, verifyRemoteResult } from './src/lib/rassilon-remote-result.js';
import { validateSettingsPatch } from './src/lib/rassilon-settings.js';
import { configureRassilonLanServer, startRassilonLanServer } from './src/lib/rassilon-lan-server.js';
import { initRassilonScratch } from './src/lib/rassilon-scratch.js';

const TEST_ROOT = './data-test-rassilon-v1-hardening';
const TEST_DB = `${TEST_ROOT}/test.db`;
const controllerId = 'controller-v1-hardening';
const controllerKeys = crypto.generateKeyPairSync('ed25519');
const controllerPublicKeyPem = controllerKeys.publicKey.export({ type: 'spki', format: 'pem' });
let worker;

const FULL_SETTINGS = {
  maxCpuPercent: 25, maxRamMb: 2048, maxConcurrentJobs: 1, maxJobDurationSec: 300,
  maxScratchMb: 1024, pauseOnBattery: false, minimumBatteryPercent: 30,
  pauseWhenUserActive: false, acceptedJobTypes: ['SAFE_CPU_TASK', 'EMBEDDING_BATCH'],
  approvalMode: 'ASK_EACH_JOB',
};

before(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  initSqlite(TEST_DB);
  initRassilonScratch(`${TEST_ROOT}/scratch`);
  const { ensureLocalRassilonDevice } = await import('./src/lib/rassilon-pairing.js');
  worker = ensureLocalRassilonDevice({ deviceId: 'worker-v1-hardening', displayName: 'Worker V1' });
  upsertRassilonDevice({
    deviceId: controllerId, displayName: 'Controller V1', publicKeyPem: controllerPublicKeyPem,
    fingerprint: computeFingerprint(controllerPublicKeyPem), role: 'CONTROLLER',
    permissionSet: ['RASSILON_COMPUTE_SAFE', 'RASSILON_EMBEDDING'], status: 'ONLINE', capabilities: {},
  });
  upsertRassilonIdentity({ deviceId: controllerId, publicKeyPem: controllerPublicKeyPem, fingerprint: computeFingerprint(controllerPublicKeyPem) });
});

function signedHeaders({ deviceId, sessionId, privateKey, method, path, body = Buffer.alloc(0), timestamp, nonce = crypto.randomBytes(18).toString('base64url') }) {
  const bodyHash = sha256Base64(body);
  const material = { deviceId, sessionId, timestamp, nonce, method, path, bodyHash };
  return new Headers({
    'x-rassilon-device-id': deviceId,
    'x-rassilon-session-id': sessionId,
    'x-rassilon-timestamp': timestamp,
    'x-rassilon-nonce': nonce,
    'x-rassilon-body-sha256': bodyHash,
    'x-rassilon-signature': crypto.sign(null, canonicalRequestBytes(material), privateKey).toString('base64'),
  });
}

function pairingRequest(offer, keys, deviceId) {
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const unsigned = {
    pairingId: offer.pairingId, code: offer.code, workerNonce: offer.workerNonce,
    expectedWorkerFingerprint: offer.worker.fingerprint, controllerDeviceId: deviceId,
    controllerPublicKeyPem: publicKeyPem, controllerFingerprint: computeFingerprint(publicKeyPem),
    controllerNonce: crypto.randomBytes(24).toString('base64url'),
    controllerDisplayName: 'Parallel Controller', requestedPermissions: ['RASSILON_COMPUTE_SAFE'],
  };
  return { ...unsigned, signature: crypto.sign(null, canonicalPairingRequest(unsigned), keys.privateKey).toString('base64') };
}

test('settings backend rejects every executor outside the frozen V1 registry', () => {
  assert.throws(() => validateSettingsPatch({ acceptedJobTypes: ['LLM_INFERENCE'] }), /accepted_job_type_invalid/);
  assert.deepEqual(JSON.parse(validateSettingsPatch({ acceptedJobTypes: ['SAFE_CPU_TASK', 'SAFE_CPU_TASK'] }).accepted_job_types), ['SAFE_CPU_TASK']);
});

test('session boundary accepts just before expiry, rejects after expiry, and revocation is immediate', () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const deviceId = 'controller-session-boundary';
  const base = Date.now();
  upsertRassilonDevice({ deviceId, displayName: 'Boundary', publicKeyPem, fingerprint: computeFingerprint(publicKeyPem), role: 'CONTROLLER', permissionSet: ['RASSILON_COMPUTE_SAFE'], status: 'ONLINE', capabilities: {} });
  createRassilonSession({ sessionId: 'session-before-expiry', deviceId, expiresAt: new Date(base + 1_000).toISOString() });
  const beforeTimestamp = new Date(base + 999).toISOString();
  assert.equal(authenticateLanRequest({ headers: signedHeaders({ deviceId, sessionId: 'session-before-expiry', privateKey: keys.privateKey, method: 'GET', path: '/rassilon-lan/status', timestamp: beforeTimestamp }), method: 'GET', path: '/rassilon-lan/status', bodyBytes: Buffer.alloc(0), now: base + 999 }).device.deviceId, deviceId);
  assert.throws(() => authenticateLanRequest({ headers: signedHeaders({ deviceId, sessionId: 'session-before-expiry', privateKey: keys.privateKey, method: 'GET', path: '/rassilon-lan/status', timestamp: new Date(base + 1_001).toISOString() }), method: 'GET', path: '/rassilon-lan/status', bodyBytes: Buffer.alloc(0), now: base + 1_001 }), /session_invalid/);

  createRassilonSession({ sessionId: 'session-revoked-midflight', deviceId, expiresAt: new Date(base + 60_000).toISOString() });
  revokeRassilonDevice(deviceId);
  assert.throws(() => authenticateLanRequest({ headers: signedHeaders({ deviceId, sessionId: 'session-revoked-midflight', privateKey: keys.privateKey, method: 'GET', path: '/rassilon-lan/status', timestamp: new Date(base).toISOString() }), method: 'GET', path: '/rassilon-lan/status', bodyBytes: Buffer.alloc(0), now: base }), /session_invalid|device_unknown_or_revoked/);
});

test('parallel pairing attempts have a single winner for one challenge', () => {
  const offer = startRassilonPairing();
  const firstKeys = crypto.generateKeyPairSync('ed25519');
  const secondKeys = crypto.generateKeyPairSync('ed25519');
  const first = requestRassilonPairing(pairingRequest(offer, firstKeys, 'parallel-controller-one'));
  assert.equal(first.state, 'AWAITING_LOCAL_CONFIRMATION');
  assert.throws(() => requestRassilonPairing(pairingRequest(offer, secondKeys, 'parallel-controller-two')), /pairing_wrong_state/);
});

test('all configured rate-limit buckets stay bounded under hostile bursts', () => {
  const limiter = createRateLimiter();
  for (const [name, limit] of [['pair', 8], ['auth', 60], ['jobs', 20], ['status', 120], ['result', 120]]) {
    for (let index = 0; index < limit; index += 1) assert.equal(limiter.check(name, { limit, windowMs: 60_000 }, 100), true);
    assert.equal(limiter.check(name, { limit, windowMs: 60_000 }, 100), false);
  }
});

test('TLS startup and pairing pins fail closed for unknown profile, missing/invalid material and a wrong pin', async () => {
  configureRassilonLanServer({ allowLoopbackForTests: true, tlsKeyPath: `${TEST_ROOT}/missing.key`, tlsCertPath: `${TEST_ROOT}/missing.pem` });
  await assert.rejects(() => startRassilonLanServer({ bindAddress: '127.0.0.1', port: 38447, networkProfile: 'Unknown' }), /private_network_profile_required/);
  await assert.rejects(() => startRassilonLanServer({ bindAddress: '127.0.0.1', port: 38447, networkProfile: 'Private' }), /tls_material_missing/);
  fs.writeFileSync(`${TEST_ROOT}/invalid.key`, 'not a private key');
  fs.writeFileSync(`${TEST_ROOT}/invalid.pem`, 'not a certificate');
  await assert.rejects(() => startRassilonLanServer({ bindAddress: '127.0.0.1', port: 38447, networkProfile: 'Private', tlsKeyPath: `${TEST_ROOT}/invalid.key`, tlsCertPath: `${TEST_ROOT}/invalid.pem` }), /tls_material_invalid/);

  const remoteKeys = crypto.generateKeyPairSync('ed25519');
  const remotePublicKeyPem = remoteKeys.publicKey.export({ type: 'spki', format: 'pem' });
  await assert.rejects(() => requestOutboundRassilonPairing({
    offer: {
      pairingId: crypto.randomUUID(), code: '12345678', workerNonce: 'worker-nonce-long-enough', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      worker: { deviceId: 'worker-pin-test', displayName: 'Pin test', publicKeyPem: remotePublicKeyPem, fingerprint: computeFingerprint(remotePublicKeyPem) },
    },
    endpointHost: '192.168.1.50', endpointPort: 3443,
    tlsCertificatePem: 'not a certificate', tlsCertificateFingerprint: 'wrong-pin',
    requestedPermissions: ['RASSILON_COMPUTE_SAFE'], transport: async () => { throw new Error('must not connect'); },
  }), /pairing_pin_mismatch/);
});

test('remote EMBEDDING_BATCH integration: authenticated route -> worker -> local adapter -> signed result -> controller verification', async () => {
  resetRassilonWorkerForTests();
  initRassilonWorker({
    logger: { info() {}, warn() {}, error() {} },
    providers: {
      embeddingModel: 'nomic-embed-text',
      ollamaClient: {
        async list() { return { models: [{ name: 'nomic-embed-text' }] }; },
        async embed({ input }) { return { embeddings: [[input.length, 0.25, 0.5]] }; },
      },
    },
  });
  enableRassilon(FULL_SETTINGS);
  const sessionId = 'session-embedding-integration';
  createRassilonSession({ sessionId, deviceId: controllerId, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const unsigned = {
    jobId: crypto.randomUUID(), jobType: 'EMBEDDING_BATCH', issuerId: controllerId, targetDeviceId: worker.deviceId,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 256, maxDurationSec: 30 },
    payload: { texts: ['fixture locale distante'], model: 'nomic-embed-text' }, policyVersion: 'rassilon-v1',
  };
  const job = { ...unsigned, signature: crypto.sign(null, canonicalJobBytes(unsigned), controllerKeys.privateKey).toString('base64') };
  const body = Buffer.from(JSON.stringify(job));
  const app = createRassilonLanRoute({ allowLoopbackForTests: true, remoteAddress: () => '127.0.0.1' });
  const submit = await app.request('https://127.0.0.1/rassilon-lan/jobs', {
    method: 'POST', headers: signedHeaders({ deviceId: controllerId, sessionId, privateKey: controllerKeys.privateKey, method: 'POST', path: '/rassilon-lan/jobs', body, timestamp: new Date().toISOString() }), body,
  });
  assert.equal(submit.status, 202, await submit.clone().text());
  for (let index = 0; index < 80 && getJob(job.jobId)?.status !== 'COMPLETED'; index += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(getJob(job.jobId)?.status, 'COMPLETED');

  const resultPath = `/rassilon-lan/jobs/${job.jobId}`;
  const resultResponse = await app.request(`https://127.0.0.1${resultPath}`, {
    headers: signedHeaders({ deviceId: controllerId, sessionId, privateKey: controllerKeys.privateKey, method: 'GET', path: resultPath, timestamp: new Date().toISOString() }),
  });
  assert.equal(resultResponse.status, 200);
  const { result } = await resultResponse.json();
  assert.equal(result.output.vectorCount, 1);
  assert.equal(verifyRemoteResult(result, { expectedWorkerId: worker.deviceId, expectedJobId: job.jobId, publicKeyPem: worker.publicKeyPem }), true);
  assert.equal(verifyRemoteResult(result, { expectedWorkerId: worker.deviceId, expectedJobId: crypto.randomUUID(), publicKeyPem: worker.publicKeyPem }), false);
  assert.equal(verifyRemoteResult({ ...result, extra: 'not allowed' }, { expectedWorkerId: worker.deviceId, expectedJobId: job.jobId, publicKeyPem: worker.publicKeyPem }), false);
  assert.equal(verifyRemoteResult({ ...result, output: { vector: [NaN] } }, { expectedWorkerId: worker.deviceId, expectedJobId: job.jobId, publicKeyPem: worker.publicKeyPem }), false);
  assert.equal(verifyRemoteResult({ ...result, output: { vector: [Infinity] } }, { expectedWorkerId: worker.deviceId, expectedJobId: job.jobId, publicKeyPem: worker.publicKeyPem }), false);
  assert.equal(verifyRemoteResult({ ...result, output: { value: 'x'.repeat(600 * 1024) } }, { expectedWorkerId: worker.deviceId, expectedJobId: job.jobId, publicKeyPem: worker.publicKeyPem }), false);
  await assert.rejects(() => pollRassilonRemoteResult({ worker: { deviceId: worker.deviceId, publicKeyPem: worker.publicKeyPem }, jobId: 'wrong-job-id', sessionId: 'unused', transport: async () => ({ result }) }), /result_authenticity_invalid/);
});

test('executor allowlist accepts only SAFE_CPU_TASK and EMBEDDING_BATCH everywhere', () => {
  assert.deepEqual([...JOB_TYPES], ['SAFE_CPU_TASK', 'EMBEDDING_BATCH']);
  assert.deepEqual([...AVAILABLE_EXECUTORS], ['SAFE_CPU_TASK', 'EMBEDDING_BATCH']);
  for (const accepted of [['SAFE_CPU_TASK'], ['EMBEDDING_BATCH'], ['SAFE_CPU_TASK', 'EMBEDDING_BATCH'], []]) {
    assert.deepEqual(JSON.parse(validateSettingsPatch({ acceptedJobTypes: accepted }).accepted_job_types), accepted);
  }
  for (const bad of ['GENERIC', 'GENERIC_EXECUTOR', 'SHELL', 'EXEC', 'SCRIPT', 'LLM_INFERENCE', 'safe_cpu_task', ' SAFE_CPU_TASK', '', '*', '__proto__', 'constructor']) {
    assert.throws(() => validateSettingsPatch({ acceptedJobTypes: ['SAFE_CPU_TASK', bad] }), /accepted_job_type_invalid/, bad);
    assert.throws(() => validateJobSchema({ jobType: bad }), /job_type_not_supported|job_field|job_/, bad);
    assert.equal(requiredPermissionForJob(bad), null, bad);
  }
  assert.throws(() => validateSettingsPatch({ acceptedJobTypes: [42] }), /setting_type_invalid/);
  assert.throws(() => validateSettingsPatch({ acceptedJobTypes: 'SAFE_CPU_TASK' }), /setting_type_invalid/);
});

test('remote result job binding: a result signed for job A is never accepted for job B', async () => {
  const at = '2026-09-24T12:00:00.000Z';
  const jobA = { jobId: 'binding-job-a', status: 'COMPLETED', resultSummary: { vectorCount: 1 }, startedAt: at, completedAt: at };
  const jobB = { jobId: 'binding-job-b', status: 'COMPLETED', resultSummary: { vectorCount: 2 }, startedAt: at, completedAt: at };
  const resultA = createSignedRemoteResult({ job: jobA, workerDeviceId: worker.deviceId });
  const resultB = createSignedRemoteResult({ job: jobB, workerDeviceId: worker.deviceId });
  const opts = expectedJobId => ({ expectedWorkerId: worker.deviceId, expectedJobId, publicKeyPem: worker.publicKeyPem });

  assert.equal(verifyRemoteResult(resultA, opts('binding-job-a')), true, 'valid jobId');
  assert.equal(verifyRemoteResult(resultA, opts('binding-job-b')), false, 'wrong expected jobId');
  assert.equal(verifyRemoteResult(resultA, opts(undefined)), false, 'missing expected jobId');
  assert.equal(verifyRemoteResult(resultA, opts('')), false, 'empty expected jobId');
  assert.equal(verifyRemoteResult({ ...resultA, jobId: 'binding-job-b' }, opts('binding-job-b')), false, 'mutated jobId');
  assert.equal(verifyRemoteResult({ ...resultA, jobId: 'binding-job-b', signature: resultB.signature }, opts('binding-job-b')), false, 'signature of another job');
  assert.equal(verifyRemoteResult({ ...resultA, jobId: 'binding-job-b', resultHash: resultB.resultHash, signature: resultB.signature }, opts('binding-job-b')), false, 'hash+signature of another job');
  assert.equal(verifyRemoteResult({ ...resultA, signature: resultB.signature }, opts('binding-job-a')), false, 'transplanted signature');
  assert.equal(verifyRemoteResult(resultA, { ...opts('binding-job-a'), expectedWorkerId: 'another-worker' }), false, 'wrong worker id');
  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyRemoteResult(resultA, { ...opts('binding-job-a'), publicKeyPem: otherKey }), false, 'wrong worker key');
  assert.equal(verifyRemoteResult({ ...resultA, workerId: 'another-worker' }, { ...opts('binding-job-a'), expectedWorkerId: 'another-worker' }), false, 'mutated workerId');
  assert.equal(verifyRemoteResult({ ...resultA, output: { vectorCount: 99 } }, opts('binding-job-a')), false, 'tampered output');
  assert.equal(verifyRemoteResult({ ...resultA, status: 'FAILED' }, opts('binding-job-a')), false, 'tampered status');
  assert.equal(verifyRemoteResult({ ...resultA, errorReason: 'x' }, opts('binding-job-a')), false, 'tampered errorReason');
  assert.equal(verifyRemoteResult({ ...resultA, completionTimestamp: '2030-01-01T00:00:00.000Z' }, opts('binding-job-a')), false, 'tampered timestamp');

  const workerRef = { deviceId: worker.deviceId, publicKeyPem: worker.publicKeyPem };
  await assert.rejects(() => pollRassilonRemoteResult({ worker: workerRef, jobId: 'binding-job-b', sessionId: 'unused', transport: async () => ({ result: resultA }) }), /result_authenticity_invalid/);
  await assert.rejects(() => pollRassilonRemoteResult({ worker: { ...workerRef, deviceId: 'another-worker' }, jobId: 'binding-job-a', sessionId: 'unused', transport: async () => ({ result: resultA }) }), /result_authenticity_invalid/);
});

test('LAN route rejects a signed job whose jobType is outside the allowlist', async () => {
  const sessionId = 'session-allowlist-route';
  createRassilonSession({ sessionId, deviceId: controllerId, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const unsigned = {
    jobId: crypto.randomUUID(), jobType: 'GENERIC_EXECUTOR', issuerId: controllerId, targetDeviceId: worker.deviceId,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 256, maxDurationSec: 30 }, payload: { command: 'whoami' }, policyVersion: 'rassilon-v1',
  };
  const job = { ...unsigned, signature: crypto.sign(null, canonicalJobBytes(unsigned), controllerKeys.privateKey).toString('base64') };
  const body = Buffer.from(JSON.stringify(job));
  const app = createRassilonLanRoute({ allowLoopbackForTests: true, remoteAddress: () => '127.0.0.1' });
  const response = await app.request('https://127.0.0.1/rassilon-lan/jobs', {
    method: 'POST', headers: signedHeaders({ deviceId: controllerId, sessionId, privateKey: controllerKeys.privateKey, method: 'POST', path: '/rassilon-lan/jobs', body, timestamp: new Date().toISOString() }), body,
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'permission_denied');
  assert.equal(getJob(job.jobId), null);
});

test('STOP end-to-end: local route -> worker -> queue + active job cancelled -> sessions revoked -> LAN off -> no auto-resume', async () => {
  resetRassilonWorkerForTests();
  let embedCalls = 0;
  initRassilonWorker({
    logger: { info() {}, warn() {}, error() {} },
    providers: {
      embeddingModel: 'nomic-embed-text',
      ollamaClient: {
        async list() { return { models: [{ name: 'nomic-embed-text' }] }; },
        async embed() { embedCalls += 1; await new Promise(resolve => setTimeout(resolve, 40)); return { embeddings: [[0.1, 0.2, 0.3]] }; },
      },
    },
  });
  enableRassilon(FULL_SETTINGS);
  const sessionId = 'session-stop-e2e';
  createRassilonSession({ sessionId, deviceId: controllerId, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const app = createRassilonLanRoute({ allowLoopbackForTests: true, remoteAddress: () => '127.0.0.1' });
  const submit = async (sid, texts) => {
    const unsigned = {
      jobId: crypto.randomUUID(), jobType: 'EMBEDDING_BATCH', issuerId: controllerId, targetDeviceId: worker.deviceId,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
      resourceBudget: { cpuPercent: 10, ramMb: 256, maxDurationSec: 60 },
      payload: { texts, model: 'nomic-embed-text' }, policyVersion: 'rassilon-v1',
    };
    const job = { ...unsigned, signature: crypto.sign(null, canonicalJobBytes(unsigned), controllerKeys.privateKey).toString('base64') };
    const body = Buffer.from(JSON.stringify(job));
    const response = await app.request('https://127.0.0.1/rassilon-lan/jobs', {
      method: 'POST', headers: signedHeaders({ deviceId: controllerId, sessionId: sid, privateKey: controllerKeys.privateKey, method: 'POST', path: '/rassilon-lan/jobs', body, timestamp: new Date().toISOString() }), body,
    });
    return { job, response };
  };
  const texts = Array.from({ length: 20 }, (_, index) => `texte neutre ${index}`);
  const active = await submit(sessionId, texts);
  assert.equal(active.response.status, 202);
  const queued = await submit(sessionId, ['en attente']);
  assert.equal(queued.response.status, 202);
  for (let index = 0; index < 50 && getJob(active.job.jobId)?.status !== 'RUNNING'; index += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(getJob(active.job.jobId)?.status, 'RUNNING');
  assert.equal(getJob(queued.job.jobId)?.status, 'QUEUED');
  setRassilonLanSettings({ enabled: true, bindAddress: '192.168.1.2', port: 3443 });

  const local = createRassilonRoute({ isLocal: () => true });
  const stop = await local.request('http://localhost/rassilon/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(stop.status, 200);
  const stopBody = await stop.json();
  assert.equal(stopBody.state, 'DISABLED');
  assert.equal(stopBody.enabled, false);
  assert.equal(getJob(queued.job.jobId)?.status, 'CANCELLED', 'queue cancelled');
  for (let index = 0; index < 50 && getJob(active.job.jobId)?.status === 'RUNNING'; index += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(getJob(active.job.jobId)?.status, 'CANCELLED', 'active job received the cancellation signal');
  assert.ok(embedCalls < texts.length, `active job stopped early (${embedCalls}/${texts.length})`);
  assert.equal(getRassilonSession(sessionId)?.revokedAt != null, true, 'remote session invalidated');
  assert.equal(getRassilonLanSettings().enabled, false, 'LAN compute disabled');

  // The remote controller cannot resume anything: its session is dead, a fresh session still hits a disabled worker,
  // and there is no enable/resume/settings route on the LAN surface.
  const replayed = await submit(sessionId, ['après stop']);
  assert.equal(replayed.response.status, 401);
  createRassilonSession({ sessionId: 'session-after-stop', deviceId: controllerId, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const fresh = await submit('session-after-stop', ['après stop']);
  assert.equal(fresh.response.status, 400);
  assert.equal((await fresh.response.json()).error, 'rassilon_disabled');
  for (const path of ['/rassilon-lan/enable', '/rassilon-lan/resume', '/rassilon-lan/settings', '/rassilon-lan/lan/enable']) {
    const response = await app.request(`https://127.0.0.1${path}`, { method: 'POST' });
    assert.ok([401, 404].includes(response.status), `${path} -> ${response.status}`);
  }
  const healthy = { powerProvider: async () => ({ status: 'AC', batteryPercent: null }), idleProvider: async () => ({ idleMs: 3_600_000 }) };
  for (let index = 0; index < 3; index += 1) await __runSafetyGuardSweepForTests(healthy);
  assert.equal(getRassilonStatus().state, 'DISABLED', 'STOP never auto-resumes');

  __forceErrorStateForTests();
  for (let index = 0; index < 3; index += 1) await __runSafetyGuardSweepForTests(healthy);
  assert.equal(getRassilonStatus().state, 'ERROR', 'ERROR never auto-resumes silently');
  resetRassilonWorkerForTests();
});

test('network isolation: the LAN app answers no Cortex API (every route prefix under src/routes, with and without /api)', async () => {
  const prefixes = new Set();
  for (const file of fs.readdirSync('./src/routes')) {
    const source = fs.readFileSync(`./src/routes/${file}`, 'utf8');
    for (const match of source.matchAll(/\.(?:get|post|put|patch|delete|all)\(\s*'\/([a-z0-9-]+)/g)) prefixes.add(match[1]);
  }
  prefixes.delete('rassilon-lan');
  for (const required of ['omega', 'maitre', 'monitor', 'cyber-audit', 'voice', 'local-ai', 'code-intel', 'metagpt', 'sherlock', 'investment', 'rassilon']) {
    assert.ok(prefixes.has(required), `route prefix ${required} discovered`);
  }
  const app = createRassilonLanRoute({ allowLoopbackForTests: true, remoteAddress: () => '127.0.0.1' });
  let probed = 0;
  for (const prefix of prefixes) {
    for (const path of [`/api/${prefix}`, `/api/${prefix}/status`, `/${prefix}`, `/${prefix}/status`]) {
      for (const method of ['GET', 'POST']) {
        const response = await app.request(`https://127.0.0.1${path}`, { method });
        assert.equal(response.status, 404, `${method} ${path}`);
        probed += 1;
      }
    }
  }
  assert.ok(probed >= 200, `probed ${probed} paths`);
});

test('local UX projections omit keys, certificates, session IDs, nonces and audit payload summaries', async () => {
  const route = createRassilonRoute({ isLocal: () => true });
  const devicesResponse = await route.request('http://localhost/rassilon/devices');
  const devicesBody = await devicesResponse.json();
  assert.ok(devicesBody.devices.length > 0);
  const serializedDevices = JSON.stringify(devicesBody);
  assert.doesNotMatch(serializedDevices, /publicKeyPem|tlsCertificatePem|sessionId|workerNonce|controllerNonce|PRIVATE KEY/);
  const auditResponse = await route.request('http://localhost/rassilon/audit?limit=10');
  const serializedAudit = JSON.stringify(await auditResponse.json());
  assert.doesNotMatch(serializedAudit, /result_summary|payload|texts|vectors|signature|token/);
});
