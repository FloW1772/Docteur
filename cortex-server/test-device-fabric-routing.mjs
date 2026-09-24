// DEVICE FABRIC Phase 3 — safe RASSILON routing: exact target, no fallback,
// result binding, capability gating, RASSILON revalidation, OMEGA
// NOT_ROUTABLE, hostile payloads, STOP, recovery, privacy.
//
// Fixture workers run RASSILON's real executors (runJobExecutor), verify the
// job signature against this PC's RASSILON identity, check they are the
// addressed target, and sign results with their own Ed25519 key. Everything
// goes through RASSILON's real dispatchRassilonRemoteJob / pollRassilonRemoteResult;
// only the TLS transport is replaced by an in-memory call log.
// Run with: node --test test-device-fabric-routing.mjs
import './test-setup.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  getDatabase, getRassilonSettings, initSqlite, insertFabricOperation, insertOmegaDevice, revokeOmegaDevice,
  revokeRassilonDevice, updateRassilonDevicePresence, upsertRassilonDevice, upsertRassilonOutboundSession,
} from './src/lib/sqlite.js';
import { createFabricDevice, getFabricDeviceView, linkAgent, listFabricAuditEvents, listFabricDeviceViews, listAgentsForFabric } from './src/lib/device-fabric.js';
import {
  FABRIC_EMBEDDING_MODELS, getFabricOperationView, isResultBoundToTarget, listFabricOperationViews, probeRassilonWorker,
  recoverInterruptedFabricOperations, routeFabricAction, waitForFabricOperation,
} from './src/lib/device-fabric-routing.js';
import { ensureLocalRassilonDevice } from './src/lib/rassilon-pairing.js';
import { EMBEDDING_MODEL_ALLOWLIST, verifyJobSignature } from './src/lib/rassilon-job-schema.js';
import { runJobExecutor } from './src/lib/rassilon-executors.js';
import { canonicalResultBytes } from './src/lib/rassilon-remote-result.js';
import { killAllRassilonWork } from './src/lib/rassilon-worker.js';
import { initRassilonScratch } from './src/lib/rassilon-scratch.js';
import { createDeviceFabricRoute } from './src/routes/device-fabric.js';

const TEST_ROOT = './data-test-device-fabric-routing';
const CAPS = Object.freeze({
  safeExecutorTypes: ['SAFE_CPU_TASK', 'EMBEDDING_BATCH'], availableLocalModelIds: ['nomic-embed-text'],
  availableCpuBudgetPercent: 50, availableRamBudgetMb: 4096, queueDepth: 0,
});
const HEX = Buffer.from('docteur fabric exact target').toString('hex');
const SAFE_CPU = { kind: 'HASH_BUFFER', data: { hex: HEX, algorithm: 'sha256' } };
const EMBED = { texts: ['phrase confidentielle alpha', 'phrase confidentielle beta'], model: 'nomic-embed-text' };
const fastRouting = { pollIntervalMs: 1, sleep: () => new Promise(resolve => setImmediate(resolve)) };

let local;
const workers = new Map();
const calls = [];
let seq = 0;

function stable(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function signResult({ keys, workerId, jobId, status, output, errorReason = null, at = new Date().toISOString() }) {
  const unsigned = { jobId, workerId, status, output, metrics: { startedAt: at, completedAt: at }, errorReason, completionTimestamp: at };
  const resultHash = crypto.createHash('sha256').update(Buffer.from(stable(unsigned), 'utf8')).digest('base64');
  const envelope = { ...unsigned, resultHash };
  return { ...envelope, signature: crypto.sign(null, canonicalResultBytes(envelope), keys.privateKey).toString('base64') };
}

function makeWorker(name, { executors = CAPS.safeExecutorTypes, permissions = ['RASSILON_COMPUTE_SAFE', 'RASSILON_EMBEDDING'], caps = {} } = {}) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const deviceId = `rassilon-worker-${name}-${++seq}`;
  upsertRassilonDevice({
    deviceId, displayName: `Worker ${name}`, publicKeyPem, fingerprint, role: 'WORKER', permissionSet: permissions,
    endpointHost: '192.168.1.60', endpointPort: 3443, tlsCertificatePem: 'fixture', tlsCertificateFingerprint: 'fixture',
    capabilities: {}, status: 'OFFLINE',
  });
  const worker = { deviceId, keys, publicKeyPem, fingerprint, jobs: new Map(), polls: 0, behavior: {} };
  workers.set(deviceId, worker);
  setOnline(worker, { ...CAPS, safeExecutorTypes: executors, ...caps });
  upsertRassilonOutboundSession({ workerDeviceId: deviceId, sessionId: `session-${name}-${seq}-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  return worker;
}

function setOnline(worker, caps = CAPS, at = new Date().toISOString()) {
  updateRassilonDevicePresence(worker.deviceId, { status: 'ONLINE', capabilities: caps, lastSeenAt: at });
}

async function fixtureTransport({ device, method, path, body = null }) {
  calls.push({ deviceId: device.deviceId, method, path });
  const worker = workers.get(device.deviceId);
  const error = code => Object.assign(new Error(code), { code });
  if (!worker) throw error('connection_failed');
  if (method === 'GET' && path === '/rassilon-lan/status') return { ok: true, capabilities: worker.statusCaps ?? CAPS };
  if (method === 'POST' && path === '/rassilon-lan/jobs') {
    if (worker.behavior.reject) throw error(worker.behavior.reject);
    if (body.targetDeviceId !== worker.deviceId) throw error('job_target_mismatch');
    if (!verifyJobSignature(body, local.publicKeyPem)) throw error('job_signature_invalid');
    worker.jobs.set(body.jobId, body);
    return { ok: true, job: { jobId: body.jobId, status: 'QUEUED' } };
  }
  const match = method === 'GET' && path.match(/^\/rassilon-lan\/jobs\/([^/]+)$/);
  if (match) {
    const jobId = decodeURIComponent(match[1]);
    const job = worker.jobs.get(jobId);
    if (!job) throw error('job_not_found');
    worker.polls += 1;
    const b = worker.behavior;
    if (b.neverFinish || worker.polls === 1) return { ok: true, result: signResult({ keys: worker.keys, workerId: worker.deviceId, jobId, status: 'RUNNING', output: {} }) };
    if (b.finalStatus) return { ok: true, result: signResult({ keys: worker.keys, workerId: worker.deviceId, jobId, status: b.finalStatus, output: {}, errorReason: b.errorReason ?? null }) };
    const output = await runJobExecutor(
      { jobType: job.jobType, payload: job.payload, resourceBudget: job.resourceBudget },
      { providers: { embeddingModel: 'nomic-embed-text', ollamaClient: { async list() { return { models: [{ name: 'nomic-embed-text' }] }; }, async embed({ input }) { return { embeddings: [[input.length, 0.5, -0.25]] }; } } } },
    );
    let result;
    if (b.tamper === 'signAsOther') result = signResult({ keys: b.other.keys, workerId: b.other.deviceId, jobId, status: 'COMPLETED', output });
    else if (b.tamper === 'otherJob') result = signResult({ keys: worker.keys, workerId: worker.deviceId, jobId: `${jobId}-other`, status: 'COMPLETED', output });
    else if (b.tamper === 'mutateJobId') result = { ...signResult({ keys: worker.keys, workerId: worker.deviceId, jobId, status: 'COMPLETED', output }), jobId: crypto.randomUUID() };
    else if (b.tamper === 'wrongDigest') result = signResult({ keys: worker.keys, workerId: worker.deviceId, jobId, status: 'COMPLETED', output: { ...output, digest: '0'.repeat(64) } });
    else if (b.tamper === 'extraField') result = signResult({ keys: worker.keys, workerId: worker.deviceId, jobId, status: 'COMPLETED', output: { ...output, note: '<script>x</script>' } });
    else if (b.tamper === 'staleTimestamp') result = signResult({ keys: worker.keys, workerId: worker.deviceId, jobId, status: 'COMPLETED', output, at: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    else if (b.tamper === 'futureTimestamp') result = signResult({ keys: worker.keys, workerId: worker.deviceId, jobId, status: 'COMPLETED', output, at: new Date(Date.now() + 2 * 3_600_000).toISOString() });
    else if (b.tamper === 'replay') result = b.replayResult;
    else if (b.tamper === 'missingVectors') result = signResult({ keys: worker.keys, workerId: worker.deviceId, jobId, status: 'COMPLETED', output: { ...output, vectorCount: 1, vectors: output.vectors.slice(0, 1) } });
    else result = signResult({ keys: worker.keys, workerId: worker.deviceId, jobId, status: 'COMPLETED', output });
    worker.lastCompleted = result;
    return { ok: true, result };
  }
  throw error('route_not_found');
}

const routing = { ...fastRouting, transport: fixtureTransport };
const jobsReceived = worker => worker.jobs.size;
const callsTo = worker => calls.filter(c => c.deviceId === worker.deviceId);

function fabricFor(worker, name = 'Target') {
  const device = createFabricDevice({ displayName: `${name} ${++seq}` });
  linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: worker.deviceId, confirmFingerprint: worker.fingerprint });
  return device.fabricDeviceId;
}

async function route(fabricDeviceId, actionType = 'RASSILON_SAFE_CPU', semanticPayload = SAFE_CPU, extra = {}) {
  return routeFabricAction({ fabricDeviceId, actionType, semanticPayload, ...extra }, routing);
}

async function routeAndWait(...args) {
  const operation = await route(...args);
  return waitForFabricOperation(operation.operationId);
}

async function rejected(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected rejection');
}

function fabricTablesDump() {
  const db = getDatabase();
  return JSON.stringify(['fabric_devices', 'fabric_agent_links', 'fabric_audit', 'fabric_operations'].map(name => db.prepare(`SELECT * FROM ${name}`).all()));
}

before(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  initSqlite(`${TEST_ROOT}/test.db`);
  initRassilonScratch(`${TEST_ROOT}/scratch`);
  getRassilonSettings();
  // This PC's RASSILON identity exists once RASSILON pairing has happened;
  // created here by RASSILON's own function, never by Fabric.
  local = ensureLocalRassilonDevice({ displayName: 'Fabric routing controller' });
});

test('model allowlist mirror equals RASSILON\'s', () => {
  assert.deepEqual([...FABRIC_EMBEDDING_MODELS], [...EMBEDDING_MODEL_ALLOWLIST]);
});

test('SAFE_CPU_TASK end-to-end: exact worker, signed result verified, COMPLETED with digest; other worker untouched', async () => {
  const a = makeWorker('a');
  const b = makeWorker('b');
  const fabricDeviceId = fabricFor(a);
  const started = await route(fabricDeviceId);
  assert.equal(started.status, 'RUNNING');
  assert.match(started.correlationId, /^fcor-/);
  assert.ok(started.agentOperationId);
  const done = await waitForFabricOperation(started.operationId);
  assert.equal(done.status, 'COMPLETED', done.safeError);
  const digest = crypto.createHash('sha256').update(Buffer.from(HEX, 'hex')).digest('hex');
  assert.deepEqual(done.resultSummary, { kind: 'HASH_BUFFER', algorithm: 'sha256', inputBytes: HEX.length / 2, digest });
  assert.equal(done.agentDeviceId, a.deviceId);
  assert.equal(done.fabricDeviceId, fabricDeviceId);
  assert.equal(jobsReceived(a), 1);
  assert.equal(jobsReceived(b), 0);
  assert.equal(callsTo(b).length, 0);
  assert.equal([...a.jobs.values()][0].jobId, done.agentOperationId, 'Fabric operation ↔ RASSILON jobId correlation');
  const rassilonRow = getDatabase().prepare('SELECT worker_device_id, status FROM rassilon_remote_jobs WHERE job_id = ?').get(done.agentOperationId);
  assert.deepEqual({ ...rassilonRow }, { worker_device_id: a.deviceId, status: 'COMPLETED' }, 'RASSILON recorded its own job');
  const events = listFabricAuditEvents({ limit: 20 }).filter(e => e.operationId === done.operationId).map(e => e.eventType).reverse();
  assert.deepEqual(events, ['FABRIC_ROUTE_REQUESTED', 'FABRIC_ROUTE_STARTED', 'FABRIC_ROUTE_COMPLETED']);
  assert.ok(listFabricAuditEvents({ limit: 20 }).filter(e => e.operationId === done.operationId).every(e => e.correlationId === done.correlationId));
});

test('JSON_TRANSFORM_BENCH and VECTOR_MATH route and verify against the request', async () => {
  const worker = makeWorker('bench');
  const fabricDeviceId = fabricFor(worker);
  const json = await routeAndWait(fabricDeviceId, 'RASSILON_SAFE_CPU', { kind: 'JSON_TRANSFORM_BENCH', data: { items: [1, 2, 3, 'abc'] } });
  assert.equal(json.status, 'COMPLETED', json.safeError);
  assert.equal(json.resultSummary.itemCount, 4);
  assert.equal(json.resultSummary.numericSum, 6);
  const vec = await routeAndWait(fabricDeviceId, 'RASSILON_SAFE_CPU', { kind: 'VECTOR_MATH', data: { vectors: [[3, 4], [0, 1]], operation: 'magnitude_sum' } });
  assert.equal(vec.status, 'COMPLETED', vec.safeError);
  assert.equal(vec.resultSummary.result, 6);
});

test('EMBEDDING_BATCH end-to-end: vectors validated, then not kept; texts never stored by Fabric', async () => {
  const worker = makeWorker('embed');
  const fabricDeviceId = fabricFor(worker);
  const done = await routeAndWait(fabricDeviceId, 'RASSILON_EMBEDDING', EMBED);
  assert.equal(done.status, 'COMPLETED', done.safeError);
  assert.deepEqual(Object.keys(done.resultSummary).sort(), ['dimensions', 'durationMs', 'kind', 'model', 'vectorCount']);
  assert.equal(done.resultSummary.vectorCount, 2);
  assert.equal(done.resultSummary.dimensions, 3);
  assert.deepEqual(done.inputSummary.model, 'nomic-embed-text');
  assert.equal(done.inputSummary.textCount, 2);
  const dump = fabricTablesDump();
  assert.doesNotMatch(dump, /confidentielle/, 'input texts never stored in fabric_*');
  assert.doesNotMatch(dump, /-0\.25|"vectors"/, 'vectors never stored in fabric_*');
});

test('CRITICAL exact target: A unavailable, B healthy → NOT_AVAILABLE and B receives nothing', async () => {
  const a = makeWorker('a-down');
  const b = makeWorker('b-up');
  const fabricDeviceId = fabricFor(a);
  setOnline(a, CAPS, new Date(Date.now() - 45_000).toISOString()); // stale presence → AVAILABLE unknown
  const before = calls.length;
  const error = await rejected(route(fabricDeviceId));
  assert.equal(error.code, 'target_availability_unknown');
  assert.equal(error.operation.status, 'NOT_AVAILABLE');
  assert.equal(error.operation.agentDeviceId, a.deviceId);
  assert.equal(calls.length, before, 'no transport call at all');
  assert.equal(jobsReceived(b), 0);
  assert.equal(jobsReceived(a), 0);
});

test('revoked target: A revoked, B healthy → rejected, B receives nothing', async () => {
  const a = makeWorker('a-revoked');
  const b = makeWorker('b-healthy');
  const fabricDeviceId = fabricFor(a);
  revokeRassilonDevice(a.deviceId);
  const before = calls.length;
  const error = await rejected(route(fabricDeviceId));
  assert.equal(error.code, 'rassilon_identity_revoked');
  assert.equal(calls.length, before);
  assert.equal(jobsReceived(b), 0);
  assert.equal(getFabricDeviceView(fabricDeviceId).agents.RASSILON.routable, false);
});

test('stale link (identity missing) and fingerprint change → routing denied, no fallback', async () => {
  const missing = makeWorker('missing');
  const bystander = makeWorker('bystander');
  const missingDevice = fabricFor(missing);
  getDatabase().prepare('DELETE FROM rassilon_outbound_sessions WHERE worker_device_id = ?').run(missing.deviceId);
  getDatabase().prepare('DELETE FROM rassilon_devices WHERE device_id = ?').run(missing.deviceId);
  const before = calls.length;
  assert.equal((await rejected(route(missingDevice))).code, 'rassilon_identity_missing');

  const rekeyed = makeWorker('rekeyed');
  const rekeyedDevice = fabricFor(rekeyed);
  const other = crypto.generateKeyPairSync('ed25519').publicKey;
  upsertRassilonDevice({
    deviceId: rekeyed.deviceId, displayName: 'Worker rekeyed', publicKeyPem: other.export({ type: 'spki', format: 'pem' }),
    fingerprint: crypto.createHash('sha256').update(other.export({ type: 'spki', format: 'der' })).digest('hex'),
    role: 'WORKER', permissionSet: ['RASSILON_COMPUTE_SAFE', 'RASSILON_EMBEDDING'], capabilities: CAPS, status: 'ONLINE', lastSeenAt: new Date().toISOString(),
  });
  assert.equal((await rejected(route(rekeyedDevice))).code, 'rassilon_fingerprint_mismatch');
  assert.equal(calls.length, before);
  assert.equal(jobsReceived(bystander), 0);
});

test('capability gating: SUPPORTED NO, AUTHORIZED NO, AVAILABLE UNKNOWN, AVAILABLE NO all denied; all YES routes', async () => {
  const unsupported = makeWorker('unsupported', { executors: ['EMBEDDING_BATCH'] });
  assert.equal((await rejected(route(fabricFor(unsupported)))).code, 'capability_not_supported');

  const unknownSupport = makeWorker('unknown-support');
  updateRassilonDevicePresence(unknownSupport.deviceId, { status: 'ONLINE', capabilities: {}, lastSeenAt: new Date().toISOString() });
  assert.equal((await rejected(route(fabricFor(unknownSupport)))).code, 'capability_support_unknown');

  const unauthorized = makeWorker('unauthorized', { permissions: ['RASSILON_EMBEDDING'] });
  assert.equal((await rejected(route(fabricFor(unauthorized)))).code, 'capability_not_authorized');

  const unknownAvail = makeWorker('unknown-avail');
  const unknownDevice = fabricFor(unknownAvail);
  setOnline(unknownAvail, CAPS, new Date(Date.now() - 60_000).toISOString());
  assert.equal((await rejected(route(unknownDevice))).code, 'target_availability_unknown');

  const noSession = makeWorker('no-session');
  const noSessionDevice = fabricFor(noSession);
  upsertRassilonOutboundSession({ workerDeviceId: noSession.deviceId, sessionId: `expired-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() - 1_000).toISOString() });
  assert.equal((await rejected(route(noSessionDevice))).code, 'target_not_available');

  for (const w of [unsupported, unknownSupport, unauthorized, unknownAvail, noSession]) assert.equal(jobsReceived(w), 0);
  const ok = makeWorker('all-yes');
  assert.equal((await routeAndWait(fabricFor(ok))).status, 'COMPLETED');
});

test('RASSILON revalidates: its scheduler refuses an over-budget request and the worker refuses an unpermitted job', async () => {
  const lowCpu = makeWorker('low-cpu', { caps: { availableCpuBudgetPercent: 5 } });
  const before = calls.length;
  const scheduler = await rejected(route(fabricFor(lowCpu)));
  assert.equal(scheduler.code, 'no_eligible_worker');
  assert.equal(scheduler.operation.status, 'NOT_AVAILABLE');
  assert.equal(calls.length, before, 'RASSILON\'s own scheduler refused before any network call');

  const refusing = makeWorker('refusing');
  const bystander = makeWorker('bystander-2');
  refusing.behavior.reject = 'permission_denied';
  const worker = await rejected(route(fabricFor(refusing)));
  assert.equal(worker.code, 'permission_denied');
  assert.equal(worker.operation.status, 'FAILED');
  assert.equal(callsTo(refusing).filter(c => c.method === 'POST').length, 1, 'exactly one attempt, no automatic retry');
  assert.equal(callsTo(bystander).length, 0, 'never retargeted');
});

test('result confusion: other worker\'s signature, other job, mutated jobId, wrong digest, extra field, bad vectors → FAILED; exact → COMPLETED', async () => {
  const other = makeWorker('other-signer');
  const cases = [
    ['signAsOther', 'result_authenticity_invalid'], ['otherJob', 'result_authenticity_invalid'], ['mutateJobId', 'result_authenticity_invalid'],
    ['wrongDigest', 'result_schema_invalid'], ['extraField', 'result_schema_invalid'],
  ];
  for (const [tamper, expected] of cases) {
    const worker = makeWorker(`tamper-${tamper}`);
    worker.behavior = { tamper, other };
    const done = await routeAndWait(fabricFor(worker));
    assert.equal(done.status, 'FAILED', tamper);
    assert.equal(done.safeError, expected, tamper);
    assert.equal(done.resultSummary, null, `${tamper}: nothing presented`);
  }
  const vectors = makeWorker('tamper-vectors');
  vectors.behavior = { tamper: 'missingVectors' };
  const bad = await routeAndWait(fabricFor(vectors), 'RASSILON_EMBEDDING', EMBED);
  assert.equal(bad.safeError, 'result_schema_invalid');
  assert.equal(jobsReceived(other), 0);
  const exact = makeWorker('exact');
  assert.equal((await routeAndWait(fabricFor(exact))).status, 'COMPLETED');
});

test('binding check: a cryptographically valid result from worker B is rejected for a job sent to worker A', () => {
  const a = makeWorker('bind-a');
  const b = makeWorker('bind-b');
  const job = 'job-binding-000001';
  const fromB = signResult({ keys: b.keys, workerId: b.deviceId, jobId: job, status: 'COMPLETED', output: {} });
  const fromA = signResult({ keys: a.keys, workerId: a.deviceId, jobId: job, status: 'COMPLETED', output: {} });
  const workerA = { deviceId: a.deviceId, publicKeyPem: a.publicKeyPem };
  assert.equal(isResultBoundToTarget(fromB, { worker: { deviceId: b.deviceId, publicKeyPem: b.publicKeyPem }, jobId: job }), true, 'B\'s result is valid for B');
  assert.equal(isResultBoundToTarget(fromB, { worker: workerA, jobId: job }), false, 'but never for A');
  assert.equal(isResultBoundToTarget(fromA, { worker: workerA, jobId: job }), true);
  assert.equal(isResultBoundToTarget(fromA, { worker: workerA, jobId: 'job-binding-000002' }), false, 'A\'s result for job B rejected');
  assert.equal(isResultBoundToTarget({ ...fromA, jobId: 'job-binding-000002' }, { worker: workerA, jobId: 'job-binding-000002' }), false, 'mutated jobId rejected');
});

test('worker-reported FAILED / CANCELLED are shown as such, never COMPLETED', async () => {
  const failing = makeWorker('failing');
  failing.behavior = { finalStatus: 'FAILED', errorReason: '<b>provider_unavailable</b>' };
  const failed = await routeAndWait(fabricFor(failing));
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.safeError, 'job_failed', 'unsafe worker error text replaced by a code');
  const cancelling = makeWorker('cancelling');
  cancelling.behavior = { finalStatus: 'CANCELLED', errorReason: 'kill_switch' };
  const cancelled = await routeAndWait(fabricFor(cancelling));
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.safeError, 'kill_switch');
});

test('timeout: a worker that never finishes ends FAILED result_timeout after one job, no re-dispatch', async () => {
  const slow = makeWorker('slow');
  slow.behavior = { neverFinish: true };
  const operation = await routeFabricAction(
    { fabricDeviceId: fabricFor(slow), actionType: 'RASSILON_SAFE_CPU', semanticPayload: SAFE_CPU, resourceBudget: { maxDurationSec: 1 } },
    { transport: fixtureTransport, pollIntervalMs: 20, deadlineMarginMs: 0 },
  );
  const done = await waitForFabricOperation(operation.operationId);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.safeError, 'result_timeout');
  assert.equal(callsTo(slow).filter(c => c.method === 'POST').length, 1);
});

test('local RASSILON STOP: routing immediately unavailable, in-flight operation ends without retry elsewhere', async () => {
  const worker = makeWorker('stop');
  const bystander = makeWorker('stop-bystander');
  worker.behavior = { neverFinish: true };
  const fabricDeviceId = fabricFor(worker);
  const operation = await routeFabricAction(
    { fabricDeviceId, actionType: 'RASSILON_SAFE_CPU', semanticPayload: SAFE_CPU },
    { transport: fixtureTransport, pollIntervalMs: 20 },
  );
  killAllRassilonWork(); // RASSILON's own local STOP: revokes every session, incl. outbound
  const done = await waitForFabricOperation(operation.operationId);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.safeError, 'session_unavailable');
  const after = await rejected(route(fabricDeviceId));
  assert.equal(after.code, 'target_not_available');
  assert.equal(jobsReceived(bystander), 0);
  assert.equal(callsTo(bystander).length, 0);
});

test('OMEGA actions are NOT_ROUTABLE; unknown actions NOT_SUPPORTED; nothing recorded, nothing sent', async () => {
  const worker = makeWorker('omega-check');
  const fabricDeviceId = fabricFor(worker);
  const before = calls.length;
  const operations = listFabricOperationViews({ limit: 100 }).length;
  for (const actionType of ['OMEGA_VIEW', 'OMEGA_INTERACTIVE', 'OMEGA_ADMIN']) {
    const error = await rejected(routeFabricAction({ fabricDeviceId, actionType, semanticPayload: {} }, routing));
    assert.equal(error.code, 'not_routable');
    assert.equal(error.status, 409);
  }
  for (const actionType of ['EXEC', 'SHELL', 'COMMAND', 'RUN', 'rassilon_safe_cpu', '__proto__', 'constructor', 'toString', 'RASSILON_*']) {
    assert.equal((await rejected(routeFabricAction({ fabricDeviceId, actionType, semanticPayload: SAFE_CPU }, routing))).code, 'action_not_supported', actionType);
  }
  assert.equal(calls.length, before);
  assert.equal(listFabricOperationViews({ limit: 100 }).length, operations);
});

test('trust separation: a TRUSTED OMEGA ADMIN link never makes RASSILON routable', async () => {
  const omegaKey = crypto.generateKeyPairSync('ed25519').publicKey;
  const omegaFp = crypto.createHash('sha256').update(omegaKey.export({ type: 'spki', format: 'der' })).digest('hex');
  insertOmegaDevice({ id: 'omega-admin-trust', display_name: 'Admin', public_key_pem: omegaKey.export({ type: 'spki', format: 'pem' }), fingerprint: omegaFp, permission_level: 3 });
  const onlyOmega = createFabricDevice({ displayName: `Omega only ${++seq}` }).fabricDeviceId;
  linkAgent(onlyOmega, { agentType: 'OMEGA', agentDeviceId: 'omega-admin-trust', confirmFingerprint: omegaFp });
  assert.equal((await rejected(route(onlyOmega))).code, 'rassilon_not_linked');

  const revokedWorker = makeWorker('trust-revoked');
  const both = fabricFor(revokedWorker, 'Both');
  const omegaKey2 = crypto.generateKeyPairSync('ed25519').publicKey;
  const omegaFp2 = crypto.createHash('sha256').update(omegaKey2.export({ type: 'spki', format: 'der' })).digest('hex');
  insertOmegaDevice({ id: 'omega-admin-trust-2', display_name: 'Admin 2', public_key_pem: omegaKey2.export({ type: 'spki', format: 'pem' }), fingerprint: omegaFp2, permission_level: 3 });
  linkAgent(both, { agentType: 'OMEGA', agentDeviceId: 'omega-admin-trust-2', confirmFingerprint: omegaFp2 });
  revokeRassilonDevice(revokedWorker.deviceId);
  assert.equal(getFabricDeviceView(both).agents.OMEGA.trust, 'TRUSTED');
  assert.equal((await rejected(route(both))).code, 'rassilon_identity_revoked');
  revokeOmegaDevice('omega-admin-trust-2');
  assert.equal(jobsReceived(revokedWorker), 0);
});

test('hostile payloads: execution/authority fields, oversized and malformed inputs are all refused before dispatch', async () => {
  const worker = makeWorker('hostile');
  const fabricDeviceId = fabricFor(worker);
  const before = calls.length;
  const hostileKeys = ['command', 'shell', 'script', 'executable', 'path', 'url', 'powershell', 'cmd', 'javascript', 'python', 'wasm', 'binary', 'plugin', 'sessionId', 'token', 'preferredDeviceId', 'devices', 'targetDeviceId'];
  for (const key of hostileKeys) {
    const nested = await rejected(routeFabricAction({ fabricDeviceId, actionType: 'RASSILON_SAFE_CPU', semanticPayload: { kind: 'HASH_BUFFER', data: { hex: HEX, [key]: 'x' } } }, routing));
    assert.match(nested.code, /forbidden_payload_field|safe_cpu_payload_invalid/, key);
    const top = await rejected(routeFabricAction({ fabricDeviceId, actionType: 'RASSILON_SAFE_CPU', semanticPayload: SAFE_CPU, [key]: 'x' }, routing));
    assert.equal(top.code, 'unknown_field', key);
  }
  for (const kind of ['cmd.exe', 'powershell -Command x', 'javascript:alert(1)', 'python -c x', 'WASM', 'BINARY']) {
    assert.equal((await rejected(route(fabricDeviceId, 'RASSILON_SAFE_CPU', { kind, data: {} }))).code, 'safe_cpu_kind_invalid', kind);
  }
  const invalid = [
    ['RASSILON_SAFE_CPU', { kind: 'HASH_BUFFER', data: { hex: 'zz' } }, 'hash_buffer_invalid'],
    ['RASSILON_SAFE_CPU', { kind: 'HASH_BUFFER', data: { hex: 'ab'.repeat(40_000) } }, 'hash_buffer_invalid'],
    ['RASSILON_SAFE_CPU', { kind: 'HASH_BUFFER', data: { hex: HEX, algorithm: 'md5' } }, 'hash_algorithm_invalid'],
    ['RASSILON_SAFE_CPU', { kind: 'JSON_TRANSFORM_BENCH', data: { items: [{ nested: true }] } }, 'json_items_invalid'],
    ['RASSILON_SAFE_CPU', { kind: 'VECTOR_MATH', data: { vectors: [[1, 2], [3]] } }, 'vectors_invalid'],
    ['RASSILON_EMBEDDING', { texts: ['a'], model: 'llama3.2:3b' }, 'embedding_model_not_allowed'],
    ['RASSILON_EMBEDDING', { texts: ['a'], model: 'https://evil.example/model' }, 'embedding_model_not_allowed'],
    ['RASSILON_EMBEDDING', { texts: Array.from({ length: 17 }, () => 'a'), model: 'nomic-embed-text' }, 'embedding_texts_invalid'],
    ['RASSILON_EMBEDDING', { texts: ['x'.repeat(2_001)], model: 'nomic-embed-text' }, 'embedding_texts_invalid'],
    ['RASSILON_EMBEDDING', { texts: ['a'], model: 'nomic-embed-text', provider: 'cloud' }, 'embedding_payload_invalid'],
  ];
  for (const [actionType, semanticPayload, code] of invalid) {
    assert.equal((await rejected(route(fabricDeviceId, actionType, semanticPayload))).code, code, JSON.stringify(semanticPayload).slice(0, 60));
  }
  for (const resourceBudget of [{ cpuPercent: 90 }, { ramMb: 100_000 }, { maxDurationSec: 3_600 }, { gpu: 1 }, { cpuPercent: 1.5 }]) {
    assert.equal((await rejected(route(fabricDeviceId, 'RASSILON_SAFE_CPU', SAFE_CPU, { resourceBudget }))).code, 'resource_budget_invalid');
  }
  assert.equal(calls.length, before, 'nothing ever reached a worker');
  // Text content is data for the fixed embedding executor, never code.
  const data = await routeAndWait(fabricDeviceId, 'RASSILON_EMBEDDING', { texts: ['powershell -Command Remove-Item C:\\', 'rm -rf /'], model: 'nomic-embed-text' });
  assert.equal(data.status, 'COMPLETED');
});

test('no routing without an explicit request: reads, listings and refreshes never dispatch', async () => {
  const worker = makeWorker('passive');
  fabricFor(worker);
  const before = calls.length;
  const operations = listFabricOperationViews({ limit: 100 }).length;
  listFabricDeviceViews();
  listAgentsForFabric();
  listFabricOperationViews();
  const api = createDeviceFabricRoute({ isLocal: () => true, routing });
  for (const path of ['/devices', '/agents', '/operations', '/audit', '/route']) await api.request(`http://localhost/device-fabric${path}`);
  assert.equal(calls.length, before);
  assert.equal(listFabricOperationViews({ limit: 100 }).length, operations);
});

test('explicit probe: one authenticated status call to the exact worker only, then routing may become available', async () => {
  const worker = makeWorker('probe');
  const bystander = makeWorker('probe-bystander');
  const fabricDeviceId = fabricFor(worker);
  setOnline(worker, CAPS, new Date(Date.now() - 60_000).toISOString());
  assert.equal(getFabricDeviceView(fabricDeviceId).agents.RASSILON.routable, false);
  const before = calls.length;
  const view = await probeRassilonWorker(fabricDeviceId, { transport: fixtureTransport });
  assert.deepEqual(calls.slice(before), [{ deviceId: worker.deviceId, method: 'GET', path: '/rassilon-lan/status' }]);
  assert.equal(view.agents.RASSILON.routingStatus, 'READY');
  assert.equal(callsTo(bystander).length, 0);
  revokeRassilonDevice(worker.deviceId);
  await assert.rejects(probeRassilonWorker(fabricDeviceId, { transport: fixtureTransport }), /rassilon_identity_revoked/);
});

test('privacy: no session id, text, vector or key in any fabric_* row, audit or operation view', async () => {
  const dump = fabricTablesDump();
  const sessions = getDatabase().prepare('SELECT session_id FROM rassilon_outbound_sessions').all().map(r => r.session_id);
  assert.ok(sessions.length > 5);
  for (const sessionId of sessions) assert.ok(!dump.includes(sessionId), 'no outbound session id in fabric tables');
  assert.doesNotMatch(dump, /confidentielle|PUBLIC KEY|PRIVATE KEY|signature|resultHash/);
  const views = JSON.stringify(listFabricOperationViews({ limit: 100 }));
  for (const sessionId of sessions) assert.ok(!views.includes(sessionId));
});

test('boot recovery: operations left non-terminal become FAILED interrupted_by_restart, never resumed', () => {
  const worker = makeWorker('recover');
  const fabricDeviceId = fabricFor(worker);
  const stale = insertFabricOperation({
    operationId: `fop-${crypto.randomUUID()}`, correlationId: `fcor-${crypto.randomUUID()}`, fabricDeviceId,
    agentDeviceId: worker.deviceId, actionType: 'RASSILON_SAFE_CPU', jobType: 'SAFE_CPU_TASK', status: 'RUNNING', inputSummary: {},
  });
  const before = calls.length;
  assert.ok(recoverInterruptedFabricOperations() >= 1);
  const recovered = getFabricOperationView(stale.operationId);
  assert.equal(recovered.status, 'FAILED');
  assert.equal(recovered.safeError, 'interrupted_by_restart');
  assert.equal(calls.length, before);
});

test('operations API is read-only, bounded and validated', () => {
  assert.throws(() => getFabricOperationView('fop-nope'), /operation_id_invalid/);
  assert.throws(() => getFabricOperationView(`fop-${crypto.randomUUID()}`), /operation_not_found/);
  assert.ok(listFabricOperationViews({ limit: 10_000 }).length <= 100);
  const ops = listFabricOperationViews({ limit: 100 });
  for (const op of ops) {
    assert.deepEqual(Object.keys(op).sort(), ['actionType', 'agentDeviceId', 'agentOperationId', 'agentType', 'completedAt', 'correlationId', 'createdAt', 'fabricDeviceId', 'inputSummary', 'jobType', 'operationId', 'resultSummary', 'safeError', 'startedAt', 'status', 'updatedAt']);
    assert.ok(['PENDING', 'ROUTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'NOT_AVAILABLE'].includes(op.status));
    if (op.status === 'COMPLETED') assert.ok(op.resultSummary && op.agentOperationId);
  }
});

// ── Phase 4 hardening ──────────────────────────────────────────────────────

test('state machine: only legal transitions apply; terminal states never move; no duplicate completion', async () => {
  const { transitionOperation, FABRIC_OPERATION_TRANSITIONS } = await import('./src/lib/device-fabric-routing.js');
  const worker = makeWorker('fsm');
  const fabricDeviceId = fabricFor(worker);
  const op = insertFabricOperation({
    operationId: `fop-${crypto.randomUUID()}`, correlationId: `fcor-${crypto.randomUUID()}`, fabricDeviceId,
    agentDeviceId: worker.deviceId, actionType: 'RASSILON_SAFE_CPU', jobType: 'SAFE_CPU_TASK', status: 'PENDING', inputSummary: {},
  });
  assert.equal(transitionOperation(op.operationId, 'COMPLETED'), null, 'PENDING → COMPLETED refused');
  assert.equal(transitionOperation(op.operationId, 'RUNNING'), null, 'PENDING → RUNNING refused (must route first)');
  assert.equal(transitionOperation(op.operationId, 'ROUTING').status, 'ROUTING');
  assert.equal(transitionOperation(op.operationId, 'RUNNING').status, 'RUNNING');
  assert.equal(transitionOperation(op.operationId, 'COMPLETED', { resultSummary: { kind: 'HASH_BUFFER' } }).status, 'COMPLETED');
  for (const target of Object.keys(FABRIC_OPERATION_TRANSITIONS)) {
    assert.equal(transitionOperation(op.operationId, target), null, `COMPLETED → ${target} refused`);
  }
  assert.equal(getFabricOperationView(op.operationId).status, 'COMPLETED');
  recoverInterruptedFabricOperations();
  assert.equal(getFabricOperationView(op.operationId).status, 'COMPLETED', 'recovery never touches a terminal operation');

  const done = await routeAndWait(fabricFor(makeWorker('fsm-real')));
  const completions = listFabricAuditEvents({ limit: 500 }).filter(e => e.operationId === done.operationId && e.eventType === 'FABRIC_ROUTE_COMPLETED');
  assert.equal(completions.length, 1, 'exactly one completion audit');
});

test('stale / future / replayed results never complete an operation', async () => {
  const stale = makeWorker('stale-result');
  stale.behavior = { tamper: 'staleTimestamp' };
  const staleDone = await routeAndWait(fabricFor(stale));
  assert.equal(staleDone.status, 'FAILED');
  assert.equal(staleDone.safeError, 'result_stale');

  const future = makeWorker('future-result');
  future.behavior = { tamper: 'futureTimestamp' };
  const futureDone = await routeAndWait(fabricFor(future));
  assert.equal(futureDone.safeError, 'result_timestamp_invalid');

  // A result already consumed by operation 1 is replayed for operation 2.
  const replaying = makeWorker('replaying');
  const fabricDeviceId = fabricFor(replaying);
  const first = await routeAndWait(fabricDeviceId);
  assert.equal(first.status, 'COMPLETED');
  replaying.polls = 0;
  replaying.behavior = { tamper: 'replay', replayResult: replaying.lastCompleted };
  const second = await routeAndWait(fabricDeviceId);
  assert.equal(second.status, 'FAILED');
  assert.equal(second.safeError, 'result_authenticity_invalid');
  assert.notEqual(second.agentOperationId, first.agentOperationId);
  assert.equal(getFabricOperationView(first.operationId).status, 'COMPLETED', 'first operation unaffected');
});

test('refused routes are audited with the device and agent family, and never launch a job', async () => {
  const worker = makeWorker('audit-reject');
  const fabricDeviceId = fabricFor(worker);
  const before = calls.length;
  await rejected(routeFabricAction({ fabricDeviceId, actionType: 'OMEGA_VIEW', semanticPayload: {} }, routing));
  await rejected(routeFabricAction({ fabricDeviceId, actionType: 'RASSILON_SAFE_CPU', semanticPayload: { kind: 'HASH_BUFFER', data: { hex: HEX, dll: 'x' } } }, routing));
  const events = listFabricAuditEvents({ limit: 5 }).filter(e => e.eventType === 'FABRIC_ROUTE_REJECTED').slice(0, 2);
  assert.deepEqual(events.map(e => [e.fabricDeviceId, e.agentType, e.reason]), [
    [fabricDeviceId, 'RASSILON', 'forbidden_payload_field'],
    [fabricDeviceId, 'OMEGA', 'not_routable'],
  ]);
  assert.equal(calls.length, before);
});

test('hostile executable/file-type fields are refused (endpoint, dll, exe, bat, ps1, process, spawn, cmdline)', async () => {
  const worker = makeWorker('hostile-2');
  const fabricDeviceId = fabricFor(worker);
  const before = calls.length;
  for (const key of ['endpoint', 'dll', 'exe', 'bat', 'ps1', 'process', 'spawn', 'cmdline', 'library', 'msi']) {
    const error = await rejected(routeFabricAction({ fabricDeviceId, actionType: 'RASSILON_EMBEDDING', semanticPayload: { texts: ['a'], model: 'nomic-embed-text', [key]: 'x' } }, routing));
    assert.equal(error.code, 'forbidden_payload_field', key);
  }
  for (const kind of ['DLL', 'EXE', 'BAT', 'PS1', 'SHELL']) {
    assert.equal((await rejected(route(fabricDeviceId, 'RASSILON_SAFE_CPU', { kind, data: {} }))).code, 'safe_cpu_kind_invalid', kind);
  }
  assert.equal(calls.length, before);
});

test('presence, session and routing reason are explicit: VERIFIED/STALE, VALID/EXPIRING/EXPIRED, OMEGA reason', () => {
  const worker = makeWorker('status');
  const fabricDeviceId = fabricFor(worker);
  let link = getFabricDeviceView(fabricDeviceId).agents.RASSILON;
  const block = link.directions[0];
  assert.equal(link.routingStatus, 'READY');
  assert.equal(link.routingReason, null);
  assert.equal(block.presence.state, 'VERIFIED');
  assert.equal(block.presence.freshnessWindowMs, 30_000);
  assert.ok(block.presence.ageMs >= 0 && block.presence.ageMs < 5_000);
  assert.equal(block.session.state, 'VALID');
  assert.ok(block.session.expiresInMs > 0);
  assert.doesNotMatch(JSON.stringify(link), /session-status-/, 'no session identifier in the view');

  setOnline(worker, CAPS, new Date(Date.now() - 45_000).toISOString());
  link = getFabricDeviceView(fabricDeviceId).agents.RASSILON;
  assert.equal(link.directions[0].presence.state, 'STALE');
  assert.ok(link.directions[0].presence.ageMs >= 45_000);
  assert.equal(link.availability, 'UNKNOWN', 'a stale verification is never AVAILABLE');
  assert.equal(link.routingReason, 'presence_not_verified');

  setOnline(worker);
  upsertRassilonOutboundSession({ workerDeviceId: worker.deviceId, sessionId: `s-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 120_000).toISOString() });
  link = getFabricDeviceView(fabricDeviceId).agents.RASSILON;
  assert.equal(link.directions[0].session.state, 'EXPIRING');
  assert.equal(link.routingStatus, 'READY', 'an expiring session is still valid');

  upsertRassilonOutboundSession({ workerDeviceId: worker.deviceId, sessionId: `s-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() - 1_000).toISOString() });
  link = getFabricDeviceView(fabricDeviceId).agents.RASSILON;
  assert.equal(link.directions[0].session.state, 'EXPIRED');
  assert.equal(link.availability, 'UNAVAILABLE');
  assert.equal(link.routingReason, 'session_expired');

  const omegaKey = crypto.generateKeyPairSync('ed25519').publicKey;
  const omegaFp = crypto.createHash('sha256').update(omegaKey.export({ type: 'spki', format: 'der' })).digest('hex');
  insertOmegaDevice({ id: 'omega-reason', display_name: 'Reason', public_key_pem: omegaKey.export({ type: 'spki', format: 'pem' }), fingerprint: omegaFp, permission_level: 3 });
  linkAgent(fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: 'omega-reason', confirmFingerprint: omegaFp });
  const omega = getFabricDeviceView(fabricDeviceId).agents.OMEGA;
  assert.equal(omega.availability, 'UNKNOWN');
  assert.equal(omega.routingStatus, 'NOT_ROUTABLE');
  assert.equal(omega.routingReason, 'omega_outbound_client_not_implemented');
  assert.equal(omega.routable, false);
});

test('agent projection error: that link alone shows AGENT_ERROR, inventory still lists, routing refused', async () => {
  const worker = makeWorker('projection');
  const fabricDeviceId = fabricFor(worker);
  const db = getDatabase();
  db.exec('ALTER TABLE rassilon_devices RENAME TO rassilon_devices_hidden');
  try {
    const views = listFabricDeviceViews();
    const view = views.find(v => v.fabricDeviceId === fabricDeviceId);
    assert.equal(view.agents.RASSILON.linkState, 'AGENT_ERROR');
    assert.equal(view.agents.RASSILON.availability, 'ERROR');
    assert.equal(view.agents.RASSILON.routingReason, 'agent_projection_error');
    assert.equal(view.state, 'ERROR');
    const before = calls.length;
    assert.equal((await rejected(route(fabricDeviceId))).code, 'agent_projection_error');
    assert.equal(calls.length, before);
    const api = createDeviceFabricRoute({ isLocal: () => true, routing });
    const agents = await (await api.request('http://localhost/device-fabric/agents')).json();
    assert.equal(agents.agentErrors.RASSILON, 'agent_projection_error');
    assert.ok(Array.isArray(agents.agents.OMEGA));
  } finally {
    db.exec('ALTER TABLE rassilon_devices_hidden RENAME TO rassilon_devices');
  }
});
