import './test-setup.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  initSqlite, createRassilonSession, revokeRassilonDevice, upsertRassilonDevice,
} from './src/lib/sqlite.js';
import {
  authenticateLanRequest, assertDevicePermission, canonicalRequestBytes, isPrivateIpv4, sha256Base64,
} from './src/lib/rassilon-lan-auth.js';
import { computeFingerprint } from './src/lib/rassilon-identity.js';
import { canonicalJobBytes, verifyJobSignature } from './src/lib/rassilon-job-schema.js';
import { deriveDevicePresence, selectRassilonWorker } from './src/lib/rassilon-scheduler.js';
import { canonicalResultBytes, verifyRemoteResult } from './src/lib/rassilon-remote-result.js';
import { createRassilonLanRoute } from './src/routes/rassilon-lan.js';

const TEST_DB = './data-test-rassilon-lan-security/test.db';
const controllerKeys = crypto.generateKeyPairSync('ed25519');
const controllerPublicPem = controllerKeys.publicKey.export({ type: 'spki', format: 'pem' });
const controllerId = 'controller-device-001';

before(() => {
  fs.rmSync('./data-test-rassilon-lan-security', { recursive: true, force: true });
  initSqlite(TEST_DB);
  upsertRassilonDevice({
    deviceId: controllerId, displayName: 'Controller', publicKeyPem: controllerPublicPem,
    fingerprint: computeFingerprint(controllerPublicPem), role: 'CONTROLLER',
    permissionSet: ['RASSILON_COMPUTE_SAFE'], status: 'ONLINE', capabilities: {},
  });
  createRassilonSession({ sessionId: 'session-security-001', deviceId: controllerId, expiresAt: new Date(Date.now() + 600_000).toISOString() });
});

function signedHeaders({
  deviceId = controllerId, sessionId = 'session-security-001', method = 'POST', path = '/rassilon-lan/jobs',
  body = Buffer.from('{}'), timestamp = new Date().toISOString(), nonce = crypto.randomBytes(18).toString('base64url'),
  privateKey = controllerKeys.privateKey,
} = {}) {
  const bodyHash = sha256Base64(body);
  const signature = crypto.sign(null, canonicalRequestBytes({ deviceId, sessionId, timestamp, nonce, method, path, bodyHash }), privateKey).toString('base64');
  return new Headers({
    'x-rassilon-device-id': deviceId, 'x-rassilon-session-id': sessionId,
    'x-rassilon-timestamp': timestamp, 'x-rassilon-nonce': nonce,
    'x-rassilon-body-sha256': bodyHash, 'x-rassilon-signature': signature,
  });
}

test('request auth accepts a valid device/session signature', () => {
  const body = Buffer.from('{"safe":true}');
  const auth = authenticateLanRequest({ headers: signedHeaders({ body }), method: 'POST', path: '/rassilon-lan/jobs', bodyBytes: body });
  assert.equal(auth.device.deviceId, controllerId);
});

test('request anti-replay rejects the same nonce twice', () => {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const body = Buffer.from('{}');
  const headers = signedHeaders({ body, nonce });
  authenticateLanRequest({ headers, method: 'POST', path: '/rassilon-lan/jobs', bodyBytes: body });
  assert.throws(() => authenticateLanRequest({ headers, method: 'POST', path: '/rassilon-lan/jobs', bodyBytes: body }), /request_replay/);
});

test('request auth rejects stale and future timestamps', () => {
  for (const timestamp of [new Date(Date.now() - 61_000).toISOString(), new Date(Date.now() + 61_000).toISOString()]) {
    assert.throws(() => authenticateLanRequest({ headers: signedHeaders({ timestamp }), method: 'POST', path: '/rassilon-lan/jobs', bodyBytes: Buffer.from('{}') }), /timestamp_/);
  }
});

test('request auth rejects a mutated body', () => {
  const headers = signedHeaders({ body: Buffer.from('{"a":1}') });
  assert.throws(() => authenticateLanRequest({ headers, method: 'POST', path: '/rassilon-lan/jobs', bodyBytes: Buffer.from('{"a":2}') }), /body_hash_mismatch/);
});

test('request auth rejects wrong signature and wrong session device binding', () => {
  const wrong = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => authenticateLanRequest({ headers: signedHeaders({ privateKey: wrong.privateKey }), method: 'POST', path: '/rassilon-lan/jobs', bodyBytes: Buffer.from('{}') }), /request_signature_invalid/);
  assert.throws(() => authenticateLanRequest({ headers: signedHeaders({ deviceId: 'different-device-01' }), method: 'POST', path: '/rassilon-lan/jobs', bodyBytes: Buffer.from('{}') }), /session_device_mismatch/);
});

test('executor permission is per type, never generic', () => {
  const device = { permissionSet: ['RASSILON_COMPUTE_SAFE'] };
  assert.equal(assertDevicePermission(device, 'SAFE_CPU_TASK'), 'RASSILON_COMPUTE_SAFE');
  assert.throws(() => assertDevicePermission(device, 'EMBEDDING_BATCH'), /permission_denied/);
});

test('private LAN ACL accepts RFC1918 only and rejects public/unspecified/IPv6', () => {
  for (const value of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.8', '::ffff:192.168.1.8']) assert.equal(isPrivateIpv4(value), true);
  for (const value of ['0.0.0.0', '8.8.8.8', '172.32.0.1', '127.0.0.1', '::', 'fe80::1']) assert.equal(isPrivateIpv4(value), false);
});

test('targetDeviceId is covered by the job signature', () => {
  const unsigned = {
    jobId: 'target-job-001', jobType: 'SAFE_CPU_TASK', issuerId: controllerId, targetDeviceId: 'worker-device-001',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 128, maxDurationSec: 10 },
    payload: { kind: 'HASH_BUFFER', data: { hex: '00', algorithm: 'sha256' } }, policyVersion: 'v1',
  };
  const job = { ...unsigned, signature: crypto.sign(null, canonicalJobBytes(unsigned), controllerKeys.privateKey).toString('base64') };
  assert.equal(verifyJobSignature(job, controllerPublicPem), true);
  assert.equal(verifyJobSignature({ ...job, targetDeviceId: 'worker-device-002' }, controllerPublicPem), false);
});

test('scheduler is deterministic and filters offline, permission, model and resources', () => {
  const now = Date.now();
  const base = {
    role: 'WORKER', permissionSet: ['RASSILON_COMPUTE_SAFE'], status: 'ONLINE', lastSeenAt: new Date(now).toISOString(),
    capabilities: { safeExecutorTypes: ['SAFE_CPU_TASK'], availableLocalModelIds: [], availableCpuBudgetPercent: 50, availableRamBudgetMb: 1024, queueDepth: 1 },
  };
  const chosen = selectRassilonWorker({ devices: [{ ...base, deviceId: 'worker-b' }, { ...base, deviceId: 'worker-a' }], jobType: 'SAFE_CPU_TASK', resourceBudget: { cpuPercent: 10, ramMb: 128 }, now });
  assert.equal(chosen.deviceId, 'worker-a');
  assert.equal(selectRassilonWorker({ devices: [{ ...base, deviceId: 'worker-offline', lastSeenAt: new Date(now - 100_000).toISOString() }], jobType: 'SAFE_CPU_TASK', resourceBudget: { cpuPercent: 10, ramMb: 128 }, now }), null);
  assert.equal(deriveDevicePresence({ ...base, lastSeenAt: new Date(now - 60_000).toISOString() }, now), 'STALE');
});

test('signed result verifies and mutations/wrong worker/NaN are rejected', () => {
  const workerKeys = crypto.generateKeyPairSync('ed25519');
  const workerPublicPem = workerKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const unsigned = {
    jobId: 'result-job-001', workerId: 'worker-result-001', status: 'COMPLETED', output: { value: 42 },
    metrics: { startedAt: null, completedAt: '2026-09-24T00:00:00.000Z' }, errorReason: null,
    completionTimestamp: '2026-09-24T00:00:00.000Z',
  };
  const stable = value => value === null || value === undefined ? 'null' : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
  const resultHash = crypto.createHash('sha256').update(Buffer.from(stable(unsigned))).digest('base64');
  const envelope = { ...unsigned, resultHash };
  envelope.signature = crypto.sign(null, canonicalResultBytes(envelope), workerKeys.privateKey).toString('base64');
  assert.equal(verifyRemoteResult(envelope, { expectedWorkerId: unsigned.workerId, expectedJobId: unsigned.jobId, publicKeyPem: workerPublicPem }), true);
  assert.equal(verifyRemoteResult({ ...envelope, output: { value: 43 } }, { expectedWorkerId: unsigned.workerId, expectedJobId: unsigned.jobId, publicKeyPem: workerPublicPem }), false);
  assert.equal(verifyRemoteResult(envelope, { expectedWorkerId: 'worker-other-001', expectedJobId: unsigned.jobId, publicKeyPem: workerPublicPem }), false);
  assert.equal(verifyRemoteResult({ ...envelope, output: { value: NaN } }, { expectedWorkerId: unsigned.workerId, expectedJobId: unsigned.jobId, publicKeyPem: workerPublicPem }), false);
});

test('dedicated LAN app exposes no Cortex /api, shell, exec, files or upload routes', async () => {
  const app = createRassilonLanRoute({ allowLoopbackForTests: true, remoteAddress: () => '127.0.0.1' });
  for (const path of ['/api/omega/status', '/api/maitre/status', '/api/local-ai/status', '/shell', '/exec', '/files', '/upload', '/rassilon-lan/enable', '/rassilon-lan/settings', '/rassilon-lan/resume']) {
    const response = await app.request(`https://127.0.0.1${path}`);
    assert.equal(response.status, 404, path);
  }
});

test('LAN body and pairing-attempt rate limits are enforced before work', async () => {
  const app = createRassilonLanRoute({ allowLoopbackForTests: true, remoteAddress: () => '127.0.0.1' });
  const oversized = await app.request('https://127.0.0.1/rassilon-lan/pair/request', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(300_000) }),
  });
  assert.equal(oversized.status, 413);
  let last;
  for (let i = 0; i < 9; i += 1) {
    last = await app.request('https://127.0.0.1/rassilon-lan/pair/request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingId: `missing-${i}` }),
    });
  }
  assert.equal(last.status, 429);
});

test('revoked device is denied on subsequent authenticated requests', () => {
  revokeRassilonDevice(controllerId);
  assert.throws(() => authenticateLanRequest({ headers: signedHeaders(), method: 'POST', path: '/rassilon-lan/jobs', bodyBytes: Buffer.from('{}') }), /session_invalid|device_unknown_or_revoked/);
});
