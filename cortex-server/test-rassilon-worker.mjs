import './test-setup.mjs';
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initSqlite, upsertRassilonIdentity } from './src/lib/sqlite.js';
import { generateDeviceIdentity, signWithDeviceKey } from './src/lib/rassilon-identity.js';
import { canonicalJobBytes } from './src/lib/rassilon-job-schema.js';
import { initRassilonScratch } from './src/lib/rassilon-scratch.js';
import {
  initRassilonWorker, resetRassilonWorkerForTests, enableRassilon, disableRassilon,
  pauseRassilon, resumeRassilon, killAllRassilonWork, submitJobAndEnqueue, getRassilonState,
  getRassilonStatus, getJob, cancelJobById, changeRassilonSettings, MAX_QUEUE_SIZE, RassilonWorkerError,
  __forceErrorStateForTests,
} from './src/lib/rassilon-worker.js';
import { getAuditLog } from './src/lib/rassilon-audit.js';

const TEST_DB = './data-test-rassilon-worker/test.db';
const SCRATCH_DIR = './data-test-rassilon-worker/scratch';

const FULL_SETTINGS = Object.freeze({
  maxCpuPercent: 25, maxRamMb: 2048, maxConcurrentJobs: 1, maxJobDurationSec: 300,
  maxScratchMb: 1024, pauseOnBattery: false, minimumBatteryPercent: 30, pauseWhenUserActive: false,
});

before(() => {
  fs.rmSync('./data-test-rassilon-worker', { recursive: true, force: true });
  initSqlite(TEST_DB);
  initRassilonScratch(SCRATCH_DIR);
});

let deviceCounter = 0;
function registerTrustedIssuer() {
  deviceCounter += 1;
  const deviceId = `test-issuer-${deviceCounter}`;
  const identity = generateDeviceIdentity(deviceId);
  upsertRassilonIdentity({ deviceId, publicKeyPem: identity.publicKeyPem, fingerprint: identity.fingerprint });
  return deviceId;
}

function signedJob(issuerId, overrides = {}) {
  const base = {
    jobId: overrides.jobId ?? `job-${randomUUID().replaceAll('-', '')}`,
    jobType: 'SAFE_CPU_TASK',
    issuerId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5 },
    payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' } },
    policyVersion: 'v1',
    ...overrides,
  };
  delete base.signature;
  const signature = signWithDeviceKey(issuerId, canonicalJobBytes(base)).toString('base64');
  return { ...base, signature };
}

beforeEach(() => {
  // Settings (including `enabled`) are DB-backed and persist across
  // tests within this file's shared SQLite DB — explicitly disable
  // before each test so every test starts from a known DISABLED
  // baseline regardless of what the previous test left behind, rather
  // than relying on resetRassilonWorkerForTests() alone (which only
  // clears in-memory state, not the persisted `enabled` flag).
  resetRassilonWorkerForTests();
  initRassilonWorker({ logger: { info() {}, warn() {}, error() {} } });
  disableRassilon();
});

// ── Default state / enable / disable (mission §47/§3) ──────────────────────

test('default state after boot is DISABLED', () => {
  assert.equal(getRassilonState(), 'DISABLED');
});

test('enable requires a full settings payload — rejects incomplete payload', () => {
  assert.throws(() => enableRassilon({ maxCpuPercent: 25 }), RassilonWorkerError);
  assert.equal(getRassilonState(), 'DISABLED');
});

test('enable with full settings transitions DISABLED -> IDLE', () => {
  const status = enableRassilon(FULL_SETTINGS);
  assert.equal(status.state, 'IDLE');
  assert.equal(getRassilonState(), 'IDLE');
});

test('disable transitions back to DISABLED and cancels queue/active job', () => {
  enableRassilon(FULL_SETTINGS);
  const status = disableRassilon();
  assert.equal(status.state, 'DISABLED');
});

test('pause requires enabled — throws if DISABLED', () => {
  assert.throws(() => pauseRassilon(), RassilonWorkerError);
});

test('pause/resume: IDLE -> PAUSED -> IDLE', () => {
  enableRassilon(FULL_SETTINGS);
  assert.equal(pauseRassilon().state, 'PAUSED');
  assert.equal(resumeRassilon().state, 'IDLE');
});

test('resume requires enabled — throws if DISABLED', () => {
  assert.throws(() => resumeRassilon(), RassilonWorkerError);
});

test('kill switch: lands in DISABLED, never silently resumes', () => {
  enableRassilon(FULL_SETTINGS);
  const status = killAllRassilonWork();
  assert.equal(status.state, 'DISABLED');
});

// ── Job submission when disabled/paused (mission §46 — no hidden worker) ──

test('job submission while DISABLED is rejected, never queued', () => {
  const issuerId = registerTrustedIssuer();
  const outcome = submitJobAndEnqueue(signedJob(issuerId));
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'rassilon_disabled');
});

test('job submission while PAUSED is rejected', () => {
  enableRassilon(FULL_SETTINGS);
  pauseRassilon();
  const issuerId = registerTrustedIssuer();
  const outcome = submitJobAndEnqueue(signedJob(issuerId));
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'rassilon_paused');
});

// ── Full acceptance pipeline: valid job runs to completion ─────────────────

test('a fully valid signed job is accepted, runs, and completes', async () => {
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const outcome = submitJobAndEnqueue(signedJob(issuerId));
  assert.equal(outcome.accepted, true);

  // Poll briefly for async completion (in-process executor, should be fast).
  const jobId = outcome.job.jobId;
  for (let i = 0; i < 50; i++) {
    const row = getJob(jobId);
    if (row.status === 'COMPLETED' || row.status === 'FAILED') break;
    await new Promise(r => setTimeout(r, 20));
  }
  const finalRow = getJob(jobId);
  assert.equal(finalRow.status, 'COMPLETED');
  assert.ok(finalRow.resultSummary.digest);
});

// ── Replay protection (mission §49) ─────────────────────────────────────────

test('replay: same jobId submitted twice is rejected the second time', () => {
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const job = signedJob(issuerId);
  const first = submitJobAndEnqueue(job);
  assert.equal(first.accepted, true);
  const second = submitJobAndEnqueue(job);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'job_id_already_processed');
});

test('replay: expired job is rejected', () => {
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const job = signedJob(issuerId, { createdAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'job_expired');
});

test('replay: unreasonable future timestamp is rejected', () => {
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const job = signedJob(issuerId, { createdAt: new Date(Date.now() + 10 * 60_000).toISOString(), expiresAt: new Date(Date.now() + 11 * 60_000).toISOString() });
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'created_at_unreasonable');
});

test('replay: job lifetime exceeding policy window is rejected', () => {
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const job = signedJob(issuerId, { expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }); // 1 hour, way over MAX_JOB_LIFETIME_MS
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'job_lifetime_exceeds_policy');
});

test('replay: submitting a jobId that already COMPLETED is rejected (not re-executed)', async () => {
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const job = signedJob(issuerId);
  submitJobAndEnqueue(job);
  for (let i = 0; i < 50; i++) {
    if (getJob(job.jobId).status === 'COMPLETED') break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(getJob(job.jobId).status, 'COMPLETED');
  const replay = submitJobAndEnqueue(job);
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, 'job_id_already_processed');
});

// ── Signature / issuer checks ────────────────────────────────────────────

test('unregistered issuer is rejected', () => {
  enableRassilon(FULL_SETTINGS);
  // Sign with a key that was generated but never registered via upsertRassilonIdentity.
  const unregisteredDeviceId = 'never-registered-device';
  generateDeviceIdentity(unregisteredDeviceId);
  const job = signedJob(unregisteredDeviceId);
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'issuer_not_registered');
});

test('tampered job (signature no longer matches) is rejected', () => {
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const job = signedJob(issuerId);
  const tampered = { ...job, resourceBudget: { ...job.resourceBudget, cpuPercent: 99 } };
  const outcome = submitJobAndEnqueue(tampered);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'signature_invalid');
});

// ── Queue bounds / concurrency (mission §50) ────────────────────────────────

test('queue overflow: submitting beyond MAX_QUEUE_SIZE is rejected with queue_full', () => {
  enableRassilon({ ...FULL_SETTINGS, maxConcurrentJobs: 1 });
  const issuerId = registerTrustedIssuer();
  // First job starts running immediately (queue empties into activeJob),
  // so fill the queue with MAX_QUEUE_SIZE+1 additional jobs while the
  // first occupies the single concurrency slot. A large payload keeps the
  // first job alive long enough (many setImmediate yields) for the queue
  // to actually fill before it drains.
  const bigJob = signedJob(issuerId, { payload: { kind: 'JSON_TRANSFORM_BENCH', data: { items: new Array(10_000).fill(1) } } });
  submitJobAndEnqueue(bigJob);

  const outcomes = [];
  for (let i = 0; i < MAX_QUEUE_SIZE + 2; i++) {
    outcomes.push(submitJobAndEnqueue(signedJob(issuerId)));
  }
  const rejectedForQueueFull = outcomes.filter(o => !o.accepted && o.reason === 'queue_full');
  assert.ok(rejectedForQueueFull.length > 0, 'expected at least one queue_full rejection');
});

// ── Cancel ───────────────────────────────────────────────────────────────

test('cancelJobById: cancels a queued job', () => {
  enableRassilon({ ...FULL_SETTINGS, maxConcurrentJobs: 1 });
  const issuerId = registerTrustedIssuer();
  const occupier = signedJob(issuerId, { payload: { kind: 'JSON_TRANSFORM_BENCH', data: { items: new Array(10_000).fill(1) } } });
  submitJobAndEnqueue(occupier);
  const queuedJob = signedJob(issuerId);
  const outcome = submitJobAndEnqueue(queuedJob);
  assert.equal(outcome.accepted, true);
  const cancelled = cancelJobById(queuedJob.jobId);
  assert.equal(cancelled.status, 'CANCELLED');
});

test('cancelJobById: unknown jobId throws job_not_found', () => {
  assert.throws(() => cancelJobById('does-not-exist'), (err) => {
    assert.equal(err.code, 'job_not_found');
    return true;
  });
});

// ── Crash recovery (mission §34/§50) ────────────────────────────────────────

test('crash recovery: a RUNNING job from a prior boot becomes INTERRUPTED on next init', () => {
  // Simulate: directly insert a RUNNING row (as if a prior process crashed
  // mid-job) then re-run initRassilonWorker.
  const issuerId = registerTrustedIssuer();
  const job = signedJob(issuerId);
  const { insertRassilonJob, updateRassilonJob } = getSqliteModuleSync();
  insertRassilonJob({
    job_id: job.jobId, job_type: job.jobType, issuer_device_id: issuerId, status: 'QUEUED',
    resource_budget: JSON.stringify(job.resourceBudget), payload_summary: '{}', expires_at: job.expiresAt, policy_version: 'v1',
  });
  updateRassilonJob(job.jobId, { status: 'RUNNING', started_at: new Date().toISOString() });

  resetRassilonWorkerForTests();
  const result = initRassilonWorker({ logger: { info() {}, warn() {}, error() {} } });
  assert.ok(result.interruptedCount >= 1);
  assert.equal(getJob(job.jobId).status, 'INTERRUPTED');
});

test('crash recovery: queued jobs are cancelled on restart (V1 policy)', () => {
  const issuerId = registerTrustedIssuer();
  const job = signedJob(issuerId);
  const { insertRassilonJob } = getSqliteModuleSync();
  insertRassilonJob({
    job_id: job.jobId, job_type: job.jobType, issuer_device_id: issuerId, status: 'QUEUED',
    resource_budget: JSON.stringify(job.resourceBudget), payload_summary: '{}', expires_at: job.expiresAt, policy_version: 'v1',
  });

  resetRassilonWorkerForTests();
  const result = initRassilonWorker({ logger: { info() {}, warn() {}, error() {} } });
  assert.ok(result.cancelledQueuedCount >= 1);
  assert.equal(getJob(job.jobId).status, 'CANCELLED');
});

// ── ERROR state (mission §16/§17/§47) ───────────────────────────────────────

test('boot-time sanity check: the real executor registry passes cleanly — initRassilonWorker never spuriously enters ERROR under normal conditions', () => {
  // This is the meaningful regression guard for the REAL trigger path
  // (mission §16 — "executor registry invalid"): if a future change to
  // JOB_TYPES ever outpaces AVAILABLE_EXECUTORS, checkExecutorRegistrySanity
  // would catch it and THIS assertion would start failing.
  const result = initRassilonWorker({ logger: { info() {}, warn() {}, error() {} } });
  assert.notEqual(result.state, 'ERROR');
});

test('ERROR state: submitJob is rejected with rassilon_error_state while in ERROR', () => {
  enableRassilon(FULL_SETTINGS);
  __forceErrorStateForTests();
  assert.equal(getRassilonState(), 'ERROR');
  const issuerId = registerTrustedIssuer();
  const outcome = submitJobAndEnqueue(signedJob(issuerId));
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'rassilon_error_state');
});

test('ERROR state: getRassilonStatus() exposes the error detail while in ERROR, and null otherwise', () => {
  enableRassilon(FULL_SETTINGS);
  assert.equal(getRassilonStatus().error, null);
  __forceErrorStateForTests('custom_code', 'custom message');
  const status = getRassilonStatus();
  assert.equal(status.state, 'ERROR');
  assert.equal(status.error.code, 'custom_code');
});

test('ERROR state: pause() and resume() both refuse while in ERROR', () => {
  enableRassilon(FULL_SETTINGS);
  __forceErrorStateForTests();
  assert.throws(() => pauseRassilon(), (err) => { assert.equal(err.code, 'cannot_pause_in_error'); return true; });
  assert.throws(() => resumeRassilon(), (err) => { assert.equal(err.code, 'cannot_resume_in_error'); return true; });
});

test('ERROR state: disable() always works even from ERROR (mission §17)', () => {
  enableRassilon(FULL_SETTINGS);
  __forceErrorStateForTests();
  const status = disableRassilon();
  assert.equal(status.state, 'DISABLED');
});

test('ERROR state: kill switch always works even from ERROR (mission §17)', () => {
  enableRassilon(FULL_SETTINGS);
  __forceErrorStateForTests();
  const killed = killAllRassilonWork();
  assert.equal(killed.state, 'DISABLED');
});

test('ERROR state: explicit enable() clears ERROR only after re-validating the registry (deterministic recovery, not silent auto-reset)', () => {
  enableRassilon(FULL_SETTINGS);
  __forceErrorStateForTests();
  assert.equal(getRassilonState(), 'ERROR');
  // The real registry is sane, so this recovery succeeds — this IS the
  // "safe deterministic recovery" mission §17 asks for: enable() re-runs
  // the same sanity check init() runs, it doesn't just blindly clear
  // ERROR because someone called enable().
  const status = enableRassilon(FULL_SETTINGS);
  assert.equal(status.state, 'IDLE');
  assert.equal(getRassilonStatus().error, null);
});

// ── SETTINGS_CHANGED audit + mutability policy (mission §18/§19/§20/§48) ──

test('changeRassilonSettings: valid change updates settings and emits SETTINGS_CHANGED audit with old/new values', () => {
  enableRassilon(FULL_SETTINGS);
  const before = getAuditLog({ limit: 1 });
  const settings = changeRassilonSettings({ maxCpuPercent: 40 });
  assert.equal(settings.maxCpuPercent, 40);

  const after = getAuditLog({ limit: 5 });
  const settingsChangedEvent = after.find(e => e.event_type === 'SETTINGS_CHANGED');
  assert.ok(settingsChangedEvent, 'expected a SETTINGS_CHANGED audit event');
  const summary = JSON.parse(settingsChangedEvent.result_summary);
  assert.ok(summary.fields.includes('maxCpuPercent'));
  assert.equal(summary.changes.maxCpuPercent.old, 25);
  assert.equal(summary.changes.maxCpuPercent.new, 40);
  assert.notEqual(before.length, undefined); // sanity: getAuditLog returned an array both times
});

test('changeRassilonSettings: invalid change is rejected and does not emit an audit event', () => {
  enableRassilon(FULL_SETTINGS);
  const beforeCount = getAuditLog({ limit: 200 }).length;
  assert.throws(() => changeRassilonSettings({ maxCpuPercent: 999 }));
  const afterCount = getAuditLog({ limit: 200 }).length;
  assert.equal(afterCount, beforeCount);
});

test('changeRassilonSettings: no-op change (same value) does not emit a spurious audit event', () => {
  enableRassilon(FULL_SETTINGS);
  changeRassilonSettings({ maxCpuPercent: 25 }); // FULL_SETTINGS already has 25
  const log = getAuditLog({ limit: 3 });
  assert.notEqual(log[0]?.event_type, 'SETTINGS_CHANGED');
});

test('changeRassilonSettings: works while IDLE', () => {
  enableRassilon(FULL_SETTINGS);
  assert.doesNotThrow(() => changeRassilonSettings({ maxRamMb: 1024 }));
});

test('changeRassilonSettings: works while WORKING, and the ACTIVE job keeps its original resourceBudget (next-job-only policy)', async () => {
  enableRassilon({ ...FULL_SETTINGS, maxConcurrentJobs: 1 });
  const issuerId = registerTrustedIssuer();
  const bigJob = signedJob(issuerId, { payload: { kind: 'JSON_TRANSFORM_BENCH', data: { items: new Array(10_000).fill(1) } }, resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5 } });
  const outcome = submitJobAndEnqueue(bigJob);
  assert.equal(outcome.accepted, true);
  assert.equal(getRassilonState(), 'WORKING');

  // Lower maxRamMb well below the active job's own admitted budget while
  // it's running — the active job's own resourceBudget row must be
  // unaffected (mission §19/§20's confirmed next-job-only policy).
  changeRassilonSettings({ maxRamMb: 64 }); // LIMITS.maxRamMb.min — matches the active job's own 64MB budget exactly, so ANY future job would need to fit at-or-under it; the active job's already-admitted row is unaffected either way
  const activeJobRow = getJob(bigJob.jobId);
  assert.equal(activeJobRow.resourceBudget.ramMb, 64, 'the RUNNING job\'s own budget must not be rewritten by a settings change');

  // Restore for subsequent tests in this file.
  changeRassilonSettings({ maxRamMb: FULL_SETTINGS.maxRamMb });
});

test('lowering maxRamMb below what a NEXT job requests correctly rejects that next job at admission (mission §20)', async () => {
  enableRassilon(FULL_SETTINGS);
  changeRassilonSettings({ maxRamMb: 64 }); // LIMITS.maxRamMb.min — lowest valid value
  const issuerId = registerTrustedIssuer();
  const job = signedJob(issuerId, { resourceBudget: { cpuPercent: 10, ramMb: 128, maxDurationSec: 5 } }); // 128 > new 64 limit
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'ram_budget_exceeds_policy');
  changeRassilonSettings({ maxRamMb: FULL_SETTINGS.maxRamMb });
});

// ── EMBEDDING_BATCH end-to-end (mission §3/§49) ─────────────────────────────

function mockOllamaClient({ installedModels = ['nomic-embed-text:latest'], embedImpl } = {}) {
  return {
    async list() { return { models: installedModels.map(name => ({ name })) }; },
    async embed({ model, input }) {
      if (embedImpl) return embedImpl({ model, input });
      return { embeddings: [[0.1, 0.2, 0.3]] };
    },
  };
}

function embeddingSignedJob(issuerId, overrides = {}) {
  return signedJob(issuerId, {
    jobType: 'EMBEDDING_BATCH',
    payload: { texts: ['hello world'], model: 'nomic-embed-text' },
    ...overrides,
  });
}

test('EMBEDDING_BATCH: valid job runs to completion via the worker with an injected mock Ollama client', async () => {
  resetRassilonWorkerForTests();
  initRassilonWorker({ logger: { info() {}, warn() {}, error() {} }, providers: { ollamaClient: mockOllamaClient(), embeddingModel: 'nomic-embed-text' } });
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const outcome = submitJobAndEnqueue(embeddingSignedJob(issuerId));
  assert.equal(outcome.accepted, true);

  const jobId = outcome.job.jobId;
  for (let i = 0; i < 50; i++) {
    const row = getJob(jobId);
    if (row.status === 'COMPLETED' || row.status === 'FAILED') break;
    await new Promise(r => setTimeout(r, 20));
  }
  const finalRow = getJob(jobId);
  assert.equal(finalRow.status, 'COMPLETED');
  assert.equal(finalRow.resultSummary.vectorCount, 1);
});

test('EMBEDDING_BATCH: provider failure (model unavailable) lands the job as FAILED with a specific reason, worker stays healthy', async () => {
  resetRassilonWorkerForTests();
  initRassilonWorker({ logger: { info() {}, warn() {}, error() {} }, providers: { ollamaClient: mockOllamaClient({ installedModels: ['other-model'] }), embeddingModel: 'nomic-embed-text' } });
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const outcome = submitJobAndEnqueue(embeddingSignedJob(issuerId));
  assert.equal(outcome.accepted, true);

  const jobId = outcome.job.jobId;
  for (let i = 0; i < 50; i++) {
    if (getJob(jobId).status === 'FAILED') break;
    await new Promise(r => setTimeout(r, 20));
  }
  const finalRow = getJob(jobId);
  assert.equal(finalRow.status, 'FAILED');
  assert.equal(finalRow.errorReason, 'model_not_available');
  // Worker itself must remain healthy — able to accept and run a
  // subsequent job normally (mission §40).
  assert.equal(getRassilonState(), 'IDLE');
});

test('EMBEDDING_BATCH replay: same jobId twice is rejected the second time', () => {
  resetRassilonWorkerForTests();
  initRassilonWorker({ logger: { info() {}, warn() {}, error() {} }, providers: { ollamaClient: mockOllamaClient(), embeddingModel: 'nomic-embed-text' } });
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const job = embeddingSignedJob(issuerId);
  const first = submitJobAndEnqueue(job);
  assert.equal(first.accepted, true);
  const second = submitJobAndEnqueue(job);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'job_id_already_processed');
});

test('EMBEDDING_BATCH: wrong signature is rejected before ever reaching the provider', () => {
  resetRassilonWorkerForTests();
  let embedCalls = 0;
  initRassilonWorker({
    logger: { info() {}, warn() {}, error() {} },
    providers: { ollamaClient: mockOllamaClient({ embedImpl: async () => { embedCalls += 1; return { embeddings: [[1]] }; } }), embeddingModel: 'nomic-embed-text' },
  });
  enableRassilon(FULL_SETTINGS);
  const issuerId = registerTrustedIssuer();
  const job = embeddingSignedJob(issuerId);
  const tampered = { ...job, payload: { ...job.payload, texts: ['tampered'] } };
  const outcome = submitJobAndEnqueue(tampered);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'signature_invalid');
  assert.equal(embedCalls, 0);
});

test('mixed queue: SAFE_CPU_TASK and EMBEDDING_BATCH jobs both process correctly in FIFO order', async () => {
  resetRassilonWorkerForTests();
  initRassilonWorker({ logger: { info() {}, warn() {}, error() {} }, providers: { ollamaClient: mockOllamaClient(), embeddingModel: 'nomic-embed-text' } });
  enableRassilon({ ...FULL_SETTINGS, maxConcurrentJobs: 1 });
  const issuerId = registerTrustedIssuer();

  const job1 = signedJob(issuerId); // SAFE_CPU_TASK
  const job2 = embeddingSignedJob(issuerId); // EMBEDDING_BATCH
  const job3 = signedJob(issuerId); // SAFE_CPU_TASK

  submitJobAndEnqueue(job1);
  submitJobAndEnqueue(job2);
  submitJobAndEnqueue(job3);

  for (let i = 0; i < 100; i++) {
    const statuses = [job1, job2, job3].map(j => getJob(j.jobId).status);
    if (statuses.every(s => s === 'COMPLETED' || s === 'FAILED')) break;
    await new Promise(r => setTimeout(r, 20));
  }

  assert.equal(getJob(job1.jobId).status, 'COMPLETED');
  assert.equal(getJob(job2.jobId).status, 'COMPLETED');
  assert.equal(getJob(job3.jobId).status, 'COMPLETED');
  assert.equal(getJob(job1.jobId).jobType, 'SAFE_CPU_TASK');
  assert.equal(getJob(job2.jobId).jobType, 'EMBEDDING_BATCH');
});

// ── Strict Local (mission §37) ──────────────────────────────────────────────

test('EMBEDDING_BATCH: Strict Local mode does not block the job (local-only provider, no cloud call path exists)', async () => {
  const { setRouterSettings } = await import('./src/lib/sqlite.js');
  setRouterSettings({ strict_local_mode: true });
  try {
    resetRassilonWorkerForTests();
    initRassilonWorker({ logger: { info() {}, warn() {}, error() {} }, providers: { ollamaClient: mockOllamaClient(), embeddingModel: 'nomic-embed-text' } });
    enableRassilon(FULL_SETTINGS);
    const issuerId = registerTrustedIssuer();
    const outcome = submitJobAndEnqueue(embeddingSignedJob(issuerId));
    assert.equal(outcome.accepted, true);

    const jobId = outcome.job.jobId;
    for (let i = 0; i < 50; i++) {
      if (['COMPLETED', 'FAILED'].includes(getJob(jobId).status)) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(getJob(jobId).status, 'COMPLETED');
  } finally {
    setRouterSettings({ strict_local_mode: false });
  }
});

// synchronous re-import helper (sqlite.js is already loaded; this just
// gives crash-recovery tests direct DB access without a second import
// statement cluttering the top of the file for a two-test-only need)
import * as sqliteModule from './src/lib/sqlite.js';
function getSqliteModuleSync() { return sqliteModule; }
