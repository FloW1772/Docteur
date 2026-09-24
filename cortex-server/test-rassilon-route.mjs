// Route-level tests (mission §57): loopback/origin guard, oversized
// body, disabled-state job submission, and a full valid signed-job round
// trip through the actual Hono app, mirroring test-maitre-route.mjs's
// isLocal-injection pattern.
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';
import { initSqlite, upsertRassilonIdentity } from './src/lib/sqlite.js';
import { generateDeviceIdentity, signWithDeviceKey } from './src/lib/rassilon-identity.js';
import { canonicalJobBytes } from './src/lib/rassilon-job-schema.js';
import { initRassilonScratch } from './src/lib/rassilon-scratch.js';
import { initRassilonWorker, resetRassilonWorkerForTests, disableRassilon } from './src/lib/rassilon-worker.js';
import { createRassilonRoute } from './src/routes/rassilon.js';

const TEST_DB = './data-test-rassilon-route/test.db';
const SCRATCH_DIR = './data-test-rassilon-route/scratch';

const FULL_SETTINGS = {
  maxCpuPercent: 25, maxRamMb: 2048, maxConcurrentJobs: 1, maxJobDurationSec: 300,
  maxScratchMb: 1024, pauseOnBattery: false, minimumBatteryPercent: 30, pauseWhenUserActive: false,
};

let deviceId;

test.before(() => {
  fs.rmSync('./data-test-rassilon-route', { recursive: true, force: true });
  initSqlite(TEST_DB);
  initRassilonScratch(SCRATCH_DIR);
  resetRassilonWorkerForTests();
  initRassilonWorker({ logger: { info() {}, warn() {}, error() {} } });
  disableRassilon();

  deviceId = 'route-test-device';
  const identity = generateDeviceIdentity(deviceId);
  upsertRassilonIdentity({ deviceId, publicKeyPem: identity.publicKeyPem, fingerprint: identity.fingerprint });
});

const localApp = new Hono().route('/api', createRassilonRoute({ isLocal: () => true, logger: { info() {}, warn() {}, error() {} } }));
const remoteApp = new Hono().route('/api', createRassilonRoute({ isLocal: () => false, logger: { info() {}, warn() {}, error() {} } }));

function signedJobBody(overrides = {}) {
  const base = {
    jobId: `job-route${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    jobType: 'SAFE_CPU_TASK',
    issuerId: deviceId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5 },
    payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' } },
    policyVersion: 'v1',
    ...overrides,
  };
  delete base.signature;
  const signature = signWithDeviceKey(deviceId, canonicalJobBytes(base)).toString('base64');
  return { ...base, signature };
}

test('non-loopback caller: every /rassilon/* route is denied 403', async () => {
  const res = await remoteApp.request('/api/rassilon/status', { headers: { host: 'localhost' } });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'local_access_required');
});

test('bad Origin header: denied 403 even from a loopback caller', async () => {
  const res = await localApp.request('/api/rassilon/status', { headers: { host: 'localhost', origin: 'https://evil.example.com' } });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'origin_denied');
});

test('good Origin (localhost) from loopback caller: allowed through', async () => {
  const res = await localApp.request('/api/rassilon/status', { headers: { host: 'localhost', origin: 'http://localhost:5173' } });
  assert.equal(res.status, 200);
});

test('oversized body: POST /rassilon/jobs with a body over the bodyLimit is rejected 413', async () => {
  const hugePayload = { kind: 'JSON_TRANSFORM_BENCH', data: { items: new Array(20_000).fill('padding-string-to-inflate-body-size') } };
  const res = await localApp.request('/api/rassilon/jobs', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(signedJobBody({ payload: hugePayload })),
  });
  assert.equal(res.status, 413);
});

test('GET /rassilon/status reflects DISABLED by default', async () => {
  const res = await localApp.request('/api/rassilon/status', { headers: { host: 'localhost' } });
  const body = await res.json();
  assert.equal(body.state, 'DISABLED');
  assert.equal(body.enabled, false);
});

test('POST /rassilon/jobs while DISABLED is denied', async () => {
  const res = await localApp.request('/api/rassilon/jobs', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(signedJobBody()),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'rassilon_disabled');
});

test('POST /rassilon/enable with incomplete settings is rejected', async () => {
  const res = await localApp.request('/api/rassilon/enable', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ maxCpuPercent: 25 }),
  });
  assert.equal(res.status, 400);
});

test('full flow: enable -> submit valid signed job -> 202 accepted -> poll status COMPLETED', async () => {
  const enableRes = await localApp.request('/api/rassilon/enable', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(FULL_SETTINGS),
  });
  assert.equal(enableRes.status, 200);
  const enableBody = await enableRes.json();
  assert.equal(enableBody.state, 'IDLE');

  const job = signedJobBody();
  const submitRes = await localApp.request('/api/rassilon/jobs', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(job),
  });
  assert.equal(submitRes.status, 202);
  const submitBody = await submitRes.json();
  assert.equal(submitBody.ok, true);

  let finalStatus = null;
  for (let i = 0; i < 50; i++) {
    const jobRes = await localApp.request(`/api/rassilon/jobs/${job.jobId}`, { headers: { host: 'localhost' } });
    const jobBody = await jobRes.json();
    if (jobBody.job.status === 'COMPLETED' || jobBody.job.status === 'FAILED') { finalStatus = jobBody.job.status; break; }
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(finalStatus, 'COMPLETED');

  // Clean up: disable so later test files in the same run (if ever
  // executed in-process together) don't inherit an enabled worker.
  await localApp.request('/api/rassilon/disable', { method: 'POST', headers: { host: 'localhost' } });
});

test('job with a forbidden key is denied with a 400 and a specific reason, never a 500/stack trace', async () => {
  await localApp.request('/api/rassilon/enable', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(FULL_SETTINGS),
  });
  const badPayload = { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' }, command: 'cmd.exe' };
  const res = await localApp.request('/api/rassilon/jobs', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(signedJobBody({ payload: badPayload })),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'forbidden_key');
  await localApp.request('/api/rassilon/disable', { method: 'POST', headers: { host: 'localhost' } });
});

test('no /shell, /exec, /run, or /script route exists', async () => {
  for (const path of ['/api/rassilon/shell', '/api/rassilon/exec', '/api/rassilon/run', '/api/rassilon/script']) {
    const res = await localApp.request(path, { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 404, `${path} should not exist`);
  }
});

// ── PUT /rassilon/settings (mission §34/§48 Phase 3) ────────────────────────

test('PUT /rassilon/settings: valid change is applied and reflected in a subsequent GET', async () => {
  await localApp.request('/api/rassilon/enable', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(FULL_SETTINGS),
  });
  const patchRes = await localApp.request('/api/rassilon/settings', {
    method: 'PUT', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ maxCpuPercent: 50 }),
  });
  assert.equal(patchRes.status, 200);
  const patchBody = await patchRes.json();
  assert.equal(patchBody.settings.maxCpuPercent, 50);

  const getRes = await localApp.request('/api/rassilon/settings', { headers: { host: 'localhost' } });
  const getBody = await getRes.json();
  assert.equal(getBody.settings.maxCpuPercent, 50);

  await localApp.request('/api/rassilon/disable', { method: 'POST', headers: { host: 'localhost' } });
});

test('PUT /rassilon/settings: invalid change (out of range) is rejected with 400', async () => {
  const res = await localApp.request('/api/rassilon/settings', {
    method: 'PUT', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ maxCpuPercent: 999 }),
  });
  assert.equal(res.status, 400);
});

test('PUT /rassilon/settings: attempting to set `enabled` via PATCH is rejected', async () => {
  const res = await localApp.request('/api/rassilon/settings', {
    method: 'PUT', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 400);
});
