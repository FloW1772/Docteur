// Security-focused tests (mission §54/§55/§56/§58): shell/command-shaped
// payloads, path traversal, crypto mining job types — all must be
// refused by the schema layer before anything resembling execution.
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, upsertRassilonIdentity } from './src/lib/sqlite.js';
import { generateDeviceIdentity, signWithDeviceKey } from './src/lib/rassilon-identity.js';
import { canonicalJobBytes, validateJobSchema, RassilonJobError } from './src/lib/rassilon-job-schema.js';
import { initRassilonScratch, getJobScratchDir, RassilonScratchError } from './src/lib/rassilon-scratch.js';
import { initRassilonWorker, enableRassilon, submitJobAndEnqueue, resetRassilonWorkerForTests } from './src/lib/rassilon-worker.js';

const TEST_DB = './data-test-rassilon-security/test.db';
const SCRATCH_DIR = './data-test-rassilon-security/scratch';

const FULL_SETTINGS = Object.freeze({
  maxCpuPercent: 25, maxRamMb: 2048, maxConcurrentJobs: 1, maxJobDurationSec: 300,
  maxScratchMb: 1024, pauseOnBattery: false, minimumBatteryPercent: 30, pauseWhenUserActive: false,
});

let deviceId;

test.before(() => {
  fs.rmSync('./data-test-rassilon-security', { recursive: true, force: true });
  initSqlite(TEST_DB);
  initRassilonScratch(SCRATCH_DIR);
  resetRassilonWorkerForTests();
  initRassilonWorker({ logger: { info() {}, warn() {}, error() {} } });
  enableRassilon(FULL_SETTINGS);

  deviceId = 'security-test-device';
  const identity = generateDeviceIdentity(deviceId);
  upsertRassilonIdentity({ deviceId, publicKeyPem: identity.publicKeyPem, fingerprint: identity.fingerprint });
});

function sign(base) {
  const signature = signWithDeviceKey(deviceId, canonicalJobBytes(base)).toString('base64');
  return { ...base, signature };
}

function baseEnvelope(payload, jobId) {
  return {
    jobId: jobId ?? `job-sec${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    jobType: 'SAFE_CPU_TASK',
    issuerId: deviceId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5 },
    payload,
    policyVersion: 'v1',
  };
}

// ── Command/shell-shaped payloads (mission §54) ────────────────────────────

const DANGEROUS_SHAPES = [
  { command: 'cmd.exe' },
  { shell: 'powershell' },
  { script: 'Invoke-Expression (New-Object Net.WebClient).DownloadString(...)' },
  { executablePath: 'C:\\Windows\\System32\\cmd.exe' },
  { args: ['/c', 'del', '/f', '/q', 'C:\\*'] },
  { exec: 'rm -rf /' },
  { toolCall: { name: 'shell', arguments: { cmd: 'whoami' } } },
];

for (const shape of DANGEROUS_SHAPES) {
  test(`dangerous payload shape ${JSON.stringify(shape)} is refused at schema validation`, () => {
    const payload = { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' }, ...shape };
    assert.throws(() => validateJobSchema(baseEnvelope(payload)), RassilonJobError);
  });
}

test('end-to-end: a job carrying a forbidden key is rejected by the worker, never queued', () => {
  const payload = { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' }, command: 'cmd.exe' };
  const job = sign(baseEnvelope(payload));
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'forbidden_key');
});

test('path-shaped strings embedded as HASH_BUFFER hex data are inert (never interpreted as a path)', () => {
  // A path-traversal-shaped string can't even reach HASH_BUFFER's hex
  // field validly (it's not valid hex), so this exercises that the field
  // is rejected as malformed hex rather than being silently accepted and
  // treated as a path anywhere downstream.
  const payload = { kind: 'HASH_BUFFER', data: { hex: '..\\..\\Windows\\System32', algorithm: 'sha256' } };
  assert.throws(() => validateJobSchema(baseEnvelope(payload)), (err) => {
    assert.equal(err.code, 'hash_buffer_hex_malformed');
    return true;
  });
});

test('literal C:\\Windows\\System32\\cmd.exe string anywhere in payload is refused (executablePath key match, checked recursively before payload schema runs)', () => {
  const payload = { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' }, target: { executablePath: 'C:\\Windows\\System32\\cmd.exe' } };
  assert.throws(() => validateJobSchema(baseEnvelope(payload)), (err) => {
    assert.equal(err.code, 'forbidden_key'); // caught by the recursive forbidden-key scan before payload-specific validation ever runs
    return true;
  });
});

// ── Filesystem / path safety (mission §55) ──────────────────────────────

test('scratch dir: refuses jobId containing path traversal', () => {
  assert.throws(() => getJobScratchDir('../../etc/passwd'), RassilonScratchError);
});

test('scratch dir: refuses absolute path as jobId', () => {
  assert.throws(() => getJobScratchDir('/etc/passwd'), RassilonScratchError);
  assert.throws(() => getJobScratchDir('C:\\Windows\\System32'), RassilonScratchError);
});

test('scratch dir: refuses UNC-shaped jobId', () => {
  assert.throws(() => getJobScratchDir('\\\\attacker-host\\share'), RassilonScratchError);
});

test('scratch dir: refuses jobId with embedded null-like or separator characters', () => {
  assert.throws(() => getJobScratchDir('job/../../escape'), RassilonScratchError);
  assert.throws(() => getJobScratchDir('job\\..\\..\\escape'), RassilonScratchError);
});

test('scratch dir: valid jobId resolves inside the scratch root', () => {
  const dir = getJobScratchDir('job-valid-0000001');
  const root = fs.realpathSync(SCRATCH_DIR);
  const resolved = fs.realpathSync(dir);
  assert.ok(resolved.startsWith(root), `${resolved} should be inside ${root}`);
});

// ── Crypto mining (mission §56) ─────────────────────────────────────────

for (const jobType of ['MINING', 'STRATUM', 'CRYPTO_MINING', 'HASHCASH_FOR_PROFIT']) {
  test(`jobType=${jobType}: rejected as crypto_mining_not_supported, never queued`, () => {
    const job = sign(baseEnvelope({ kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' } }));
    job.jobType = jobType; // bypass baseEnvelope's default, simulating a forged envelope
    const outcome = submitJobAndEnqueue(job);
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.reason, 'crypto_mining_not_supported');
  });
}

test('unknown job type (not mining, just unrecognized) is refused distinctly from mining', () => {
  const job = sign(baseEnvelope({ kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' } }));
  job.jobType = 'SOME_FUTURE_TYPE_NOT_YET_SUPPORTED';
  const outcome = submitJobAndEnqueue(job);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'job_type_not_supported');
});
