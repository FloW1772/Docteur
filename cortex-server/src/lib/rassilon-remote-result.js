import crypto from 'node:crypto';
import { getRassilonDevice } from './sqlite.js';
import { signWithDeviceKey, verifyWithPublicKey } from './rassilon-identity.js';

export const MAX_REMOTE_RESULT_BYTES = 512 * 1024;
export const REMOTE_RESULT_STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
const RESULT_KEYS = Object.freeze([
  'jobId', 'workerId', 'status', 'output', 'metrics', 'errorReason',
  'completionTimestamp', 'resultHash', 'signature',
]);
const METRIC_KEYS = Object.freeze(['startedAt', 'completedAt']);

export class RassilonResultError extends Error {
  constructor(code) { super(code); this.name = 'RassilonResultError'; this.code = code; }
}

function stable(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function assertSafeJson(value, depth = 0) {
  if (depth > 10) throw new RassilonResultError('result_too_deep');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RassilonResultError('result_number_invalid');
  if (typeof value === 'string' && value.length > 100_000) throw new RassilonResultError('result_string_too_large');
  if (Array.isArray(value)) {
    if (value.length > 200_000) throw new RassilonResultError('result_array_too_large');
    for (const item of value) assertSafeJson(item, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(stdout|stderr|environment|credentials|filesystem|fileDump)$/i.test(key)) throw new RassilonResultError('result_field_forbidden');
      assertSafeJson(item, depth + 1);
    }
  }
}

export function canonicalResultBytes(result) {
  const { signature: _signature, ...material } = result;
  return Buffer.from(stable(material), 'utf8');
}

export function createSignedRemoteResult({ job, workerDeviceId }) {
  if (!job || typeof job.jobId !== 'string') throw new RassilonResultError('job_result_missing');
  if (!REMOTE_RESULT_STATUSES.includes(job.status)) throw new RassilonResultError('result_status_invalid');
  const output = ['COMPLETED'].includes(job.status) ? (job.resultSummary ?? {}) : {};
  assertSafeJson(output);
  const unsigned = {
    jobId: job.jobId,
    workerId: workerDeviceId,
    status: job.status,
    output,
    metrics: { startedAt: job.startedAt ?? null, completedAt: job.completedAt ?? null },
    errorReason: job.errorReason ?? null,
    completionTimestamp: job.completedAt ?? null,
  };
  const unsignedBytes = Buffer.from(stable(unsigned), 'utf8');
  if (unsignedBytes.length > MAX_REMOTE_RESULT_BYTES) throw new RassilonResultError('result_too_large');
  const resultHash = crypto.createHash('sha256').update(unsignedBytes).digest('base64');
  const envelope = { ...unsigned, resultHash };
  return { ...envelope, signature: signWithDeviceKey(workerDeviceId, canonicalResultBytes(envelope)).toString('base64') };
}

export function verifyRemoteResult(result, { expectedWorkerId, expectedJobId, publicKeyPem = null } = {}) {
  try {
    // Job binding is mandatory: without an expected jobId a result signed for
    // job A could be accepted as the result of job B.
    if (typeof expectedJobId !== 'string' || expectedJobId.length === 0) return false;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    if (Object.keys(result).some(key => !RESULT_KEYS.includes(key))) return false;
    if (typeof result.jobId !== 'string' || result.jobId !== expectedJobId) return false;
    if (result.workerId !== expectedWorkerId || !REMOTE_RESULT_STATUSES.includes(result.status)) return false;
    if (!result.metrics || typeof result.metrics !== 'object' || Array.isArray(result.metrics)) return false;
    if (Object.keys(result.metrics).some(key => !METRIC_KEYS.includes(key))) return false;
    assertSafeJson(result.output);
    const unsigned = {
      jobId: result.jobId, workerId: result.workerId, status: result.status, output: result.output,
      metrics: result.metrics, errorReason: result.errorReason, completionTimestamp: result.completionTimestamp,
    };
    const unsignedBytes = Buffer.from(stable(unsigned), 'utf8');
    if (unsignedBytes.length > MAX_REMOTE_RESULT_BYTES) return false;
    const expectedHash = crypto.createHash('sha256').update(unsignedBytes).digest('base64');
    if (result.resultHash !== expectedHash) return false;
    const key = publicKeyPem ?? getRassilonDevice(expectedWorkerId)?.publicKeyPem;
    return !!key && verifyWithPublicKey(key, canonicalResultBytes(result), result.signature);
  } catch { return false; }
}
