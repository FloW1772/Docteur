// Resource guard tests (mission §51): job budget over max is rejected
// before execution; live RAM guard exercised with real os.* telemetry
// (deterministic enough for admission-check math — no PowerShell/mocked
// provider needed here since checkAdmission/checkRuntimeBudget take
// their inputs as plain arguments, already injectable).
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, upsertRassilonIdentity } from './src/lib/sqlite.js';
import { generateDeviceIdentity, signWithDeviceKey } from './src/lib/rassilon-identity.js';
import { canonicalJobBytes } from './src/lib/rassilon-job-schema.js';
import { initRassilonScratch } from './src/lib/rassilon-scratch.js';
import { initRassilonWorker, enableRassilon, submitJobAndEnqueue, resetRassilonWorkerForTests } from './src/lib/rassilon-worker.js';
import { checkAdmission, checkRuntimeBudget, sampleSystemCpuPercent, sampleProcessCpuPercent, getSystemRamStatus } from './src/lib/rassilon-resource-guard.js';

const TEST_DB = './data-test-rassilon-resources/test.db';
const SCRATCH_DIR = './data-test-rassilon-resources/scratch';

const FULL_SETTINGS = Object.freeze({
  maxCpuPercent: 25, maxRamMb: 2048, maxConcurrentJobs: 1, maxJobDurationSec: 300,
  maxScratchMb: 1024, pauseOnBattery: false, minimumBatteryPercent: 30, pauseWhenUserActive: false,
});

let deviceId;

test.before(() => {
  fs.rmSync('./data-test-rassilon-resources', { recursive: true, force: true });
  initSqlite(TEST_DB);
  initRassilonScratch(SCRATCH_DIR);
  resetRassilonWorkerForTests();
  initRassilonWorker({ logger: { info() {}, warn() {}, error() {} } });
  enableRassilon(FULL_SETTINGS);

  deviceId = 'resource-test-device';
  const identity = generateDeviceIdentity(deviceId);
  upsertRassilonIdentity({ deviceId, publicKeyPem: identity.publicKeyPem, fingerprint: identity.fingerprint });
});

function sign(base) {
  const signature = signWithDeviceKey(deviceId, canonicalJobBytes(base)).toString('base64');
  return { ...base, signature };
}

// ── checkAdmission unit tests (deterministic, injected systemRam) ─────────

test('checkAdmission: rejects CPU budget above policy', () => {
  const result = checkAdmission({
    resourceBudget: { cpuPercent: 50, ramMb: 64, maxDurationSec: 5 },
    settings: FULL_SETTINGS,
    systemRam: { totalBytes: 16e9, freeBytes: 8e9, usedPercent: 50 },
  });
  assert.equal(result.admitted, false);
  assert.ok(result.reasons.includes('cpu_budget_exceeds_policy'));
});

test('checkAdmission: rejects RAM budget above policy', () => {
  const result = checkAdmission({
    resourceBudget: { cpuPercent: 10, ramMb: 4096, maxDurationSec: 5 },
    settings: FULL_SETTINGS,
    systemRam: { totalBytes: 16e9, freeBytes: 8e9, usedPercent: 50 },
  });
  assert.equal(result.admitted, false);
  assert.ok(result.reasons.includes('ram_budget_exceeds_policy'));
});

test('checkAdmission: rejects duration budget above policy', () => {
  const result = checkAdmission({
    resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 9999 },
    settings: FULL_SETTINGS,
    systemRam: { totalBytes: 16e9, freeBytes: 8e9, usedPercent: 50 },
  });
  assert.equal(result.admitted, false);
  assert.ok(result.reasons.includes('duration_budget_exceeds_policy'));
});

test('checkAdmission: rejects when insufficient free system RAM (mocked provider)', () => {
  const result = checkAdmission({
    resourceBudget: { cpuPercent: 10, ramMb: 1000, maxDurationSec: 5 },
    settings: FULL_SETTINGS,
    systemRam: { totalBytes: 2e9, freeBytes: 500 * 1024 * 1024, usedPercent: 75 }, // only 500MB free, job wants 1000MB
  });
  assert.equal(result.admitted, false);
  assert.ok(result.reasons.includes('insufficient_free_ram'));
});

test('checkAdmission: admits a job within budget and with sufficient free RAM', () => {
  const result = checkAdmission({
    resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5 },
    settings: FULL_SETTINGS,
    systemRam: { totalBytes: 16e9, freeBytes: 8e9, usedPercent: 50 },
  });
  assert.equal(result.admitted, true);
  assert.deepEqual(result.reasons, []);
});

test('checkRuntimeBudget: flags RAM over budget (mocked processRamMb)', () => {
  const result = checkRuntimeBudget({ resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5 }, processRamMb: 200 });
  assert.equal(result.withinBudget, false);
  assert.equal(result.reason, 'ram_over_budget');
});

test('checkRuntimeBudget: within budget when processRamMb is under the limit', () => {
  const result = checkRuntimeBudget({ resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5 }, processRamMb: 30 });
  assert.equal(result.withinBudget, true);
});

// ── End-to-end: worker rejects an over-budget job before execution ────────

test('end-to-end: job with CPU budget above policy is rejected before execution, never queued', () => {
  const job = sign({
    jobId: `job-res${Date.now()}1`,
    jobType: 'SAFE_CPU_TASK',
    issuerId: deviceId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceBudget: { cpuPercent: 99, ramMb: 64, maxDurationSec: 5 }, // 99 > policy's 25
    payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' } },
    policyVersion: 'v1',
  });
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'cpu_budget_exceeds_policy');
});

test('end-to-end: job with RAM budget above policy is rejected before execution', () => {
  const job = sign({
    jobId: `job-res${Date.now()}2`,
    jobType: 'SAFE_CPU_TASK',
    issuerId: deviceId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 99999, maxDurationSec: 5 },
    payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' } },
    policyVersion: 'v1',
  });
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'ram_budget_exceeds_policy');
});

test('end-to-end: job with duration budget above policy is rejected before execution', () => {
  const job = sign({
    jobId: `job-res${Date.now()}3`,
    jobType: 'SAFE_CPU_TASK',
    issuerId: deviceId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 99999 },
    payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' } },
    policyVersion: 'v1',
  });
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'duration_budget_exceeds_policy');
});

// ── Live telemetry sanity (real os.* sampling — bounded, no crash) ────────

test('sampleSystemCpuPercent: returns a number in [0,100]', async () => {
  const pct = await sampleSystemCpuPercent({ windowMs: 100 });
  assert.equal(typeof pct, 'number');
  assert.ok(pct >= 0 && pct <= 100);
});

test('sampleProcessCpuPercent: returns a non-negative number', async () => {
  const pct = await sampleProcessCpuPercent({ windowMs: 100 });
  assert.equal(typeof pct, 'number');
  assert.ok(pct >= 0);
});

test('getSystemRamStatus: reports plausible totals', () => {
  const status = getSystemRamStatus();
  assert.ok(status.totalBytes > 0);
  assert.ok(status.freeBytes >= 0);
  assert.ok(status.usedPercent >= 0 && status.usedPercent <= 100);
});
