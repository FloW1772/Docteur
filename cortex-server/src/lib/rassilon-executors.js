/**
 * RASSILON V1 Phase 2 — closed executor registry. Fixed jobType →
 * executor-function mapping, no generic dispatch (mission §23): there is
 * no run(command)/execute(command)/spawn(job.executable) anywhere in this
 * file or reachable from it. Every executor is pure, deterministic,
 * in-process Node computation — no child_process, no filesystem writes
 * outside what the caller explicitly manages (this phase's SAFE_CPU_TASK
 * needs none), no network.
 *
 * Cooperative cancellation (mission §35): each executor accepts an
 * AbortSignal and checks it between chunks of work rather than running
 * to completion unconditionally — this is Phase 2's realistic mechanism
 * since there is no subprocess to kill for these in-process tasks.
 */
import crypto from 'node:crypto';
import { executeEmbeddingBatch, RassilonEmbeddingError } from './rassilon-embedding.js';

export class RassilonExecutionError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'RassilonExecutionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new RassilonExecutionError(code, detail);
}

// Bounded output — a job result is always small structured JSON, never
// unbounded stdout/arbitrary files (mission §37).
const MAX_RESULT_BYTES = 64 * 1024;

function boundResult(result) {
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json, 'utf8') > MAX_RESULT_BYTES) {
    fail('result_too_large', { bytes: Buffer.byteLength(json, 'utf8') });
  }
  return result;
}

function checkAborted(signal) {
  if (signal?.aborted) fail('job_cancelled');
}

// HASH_BUFFER — hashes a bounded hex-encoded buffer with a fixed,
// allowlisted algorithm (sha256/sha512, validated upstream by
// rassilon-job-schema.js). Useful for exercising CPU without doing
// anything that resembles proof-of-work mining (mission §22 — no nonce
// search, no difficulty target, single fixed-size digest of the exact
// input the caller supplied).
async function executeHashBuffer(payload, { signal } = {}) {
  checkAborted(signal);
  const buffer = Buffer.from(payload.data.hex, 'hex');
  const hash = crypto.createHash(payload.data.algorithm).update(buffer).digest('hex');
  return boundResult({ kind: 'HASH_BUFFER', algorithm: payload.data.algorithm, inputBytes: buffer.length, digest: hash });
}

// JSON_TRANSFORM_BENCH — deterministic transform/aggregation over a
// bounded array (sort + basic stats for numbers, length stats for
// strings). Chunked with a cooperative-cancellation checkpoint every N
// items so a long-running job can actually be cancelled mid-flight
// rather than only between whole-job boundaries.
async function executeJsonTransformBench(payload, { signal } = {}) {
  const items = payload.data.items;
  const CHUNK = 1000;
  let numericSum = 0;
  let numericCount = 0;
  let stringLengthSum = 0;
  let stringCount = 0;

  for (let i = 0; i < items.length; i++) {
    if (i % CHUNK === 0) {
      checkAborted(signal);
      // Yield to the event loop between chunks — cooperative scheduling
      // (mission §9: "V1 acceptable : cooperative scheduling... pause
      // between chunks"), not a real CPU quota, documented as such.
      await new Promise(resolve => setImmediate(resolve));
    }
    const item = items[i];
    if (typeof item === 'number') { numericSum += item; numericCount += 1; }
    else { stringLengthSum += item.length; stringCount += 1; }
  }

  return boundResult({
    kind: 'JSON_TRANSFORM_BENCH',
    itemCount: items.length,
    numericCount,
    numericSum,
    numericAvg: numericCount > 0 ? numericSum / numericCount : null,
    stringCount,
    stringLengthAvg: stringCount > 0 ? stringLengthSum / stringCount : null,
  });
}

// VECTOR_MATH — bounded dot-product-sum or magnitude-sum over a small set
// of equal-length numeric vectors. Deliberately NOT a general linear-
// algebra engine — fixed operation enum, fixed shape constraints
// (rassilon-job-schema.js caps vector count/length before this ever runs).
async function executeVectorMath(payload, { signal } = {}) {
  const { vectors, operation } = payload.data;
  const CHUNK = 10;
  let result = 0;

  for (let i = 0; i < vectors.length; i++) {
    if (i % CHUNK === 0) {
      checkAborted(signal);
      await new Promise(resolve => setImmediate(resolve));
    }
    const vector = vectors[i];
    if (operation === 'magnitude_sum') {
      result += Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
    } else {
      const other = vectors[(i + 1) % vectors.length];
      result += vector.reduce((sum, n, idx) => sum + n * other[idx], 0);
    }
  }

  return boundResult({ kind: 'VECTOR_MATH', operation, vectorCount: vectors.length, vectorLength: vectors[0].length, result });
}

const SAFE_CPU_TASK_HANDLERS = Object.freeze({
  HASH_BUFFER: executeHashBuffer,
  JSON_TRANSFORM_BENCH: executeJsonTransformBench,
  VECTOR_MATH: executeVectorMath,
});

async function executeSafeCpuTask(payload, options) {
  const handler = SAFE_CPU_TASK_HANDLERS[payload.kind];
  if (!handler) fail('safe_cpu_task_kind_unroutable', { kind: payload.kind }); // unreachable given upstream schema validation; defensive only
  return handler(payload, options);
}

// EMBEDDING_BATCH needs an injected local Ollama client/model (mission
// §49 — provider injectable/mock, never a hardcoded live server
// dependency inside this closed-registry file). The signature stays
// (payload, options) like every other executor — options now optionally
// carries { ollamaClient, embeddingModel } alongside { signal }.
async function executeEmbeddingBatchExecutor(payload, options) {
  try {
    return await executeEmbeddingBatch(payload, options);
  } catch (err) {
    // The embedding module signals cancellation with its own error class;
    // map it to the shared cancellation error so STOP/revoke/cancel land the
    // job as CANCELLED and runJobExecutor can still tell a timeout apart.
    if (err instanceof RassilonEmbeddingError && err.code === 'job_cancelled') fail('job_cancelled');
    throw err;
  }
}

// ── Fixed jobType → executor mapping (mission §23; §21 Phase 3 — registry
// stays closed at SAFE_CPU_TASK + EMBEDDING_BATCH, maximum) ────────────────
// This is the ENTIRE dispatch surface. A jobType string selects one of
// these fixed functions — there is no other code path by which a job's
// fields can select what runs.
const EXECUTORS = Object.freeze({
  SAFE_CPU_TASK: executeSafeCpuTask,
  EMBEDDING_BATCH: executeEmbeddingBatchExecutor,
});

/**
 * Runs the executor for a validated job's jobType/payload, enforcing the
 * job's own maxDurationSec via AbortController (mission §36 — hard
 * wall-clock timeout) on top of the executor's own cooperative
 * cancellation checkpoints. Returns the executor's bounded result, or
 * throws RassilonExecutionError('job_timed_out') / ('job_cancelled').
 *
 * `providers` ({ ollamaClient, embeddingModel }) is forwarded to whichever
 * executor needs it — SAFE_CPU_TASK's handlers ignore it entirely, only
 * EMBEDDING_BATCH consumes it (mission §49).
 */
export async function runJobExecutor(job, { externalSignal, providers = {} } = {}) {
  const executor = EXECUTORS[job.jobType];
  if (!executor) fail('executor_not_found', { jobType: job.jobType }); // unreachable given schema validation; defensive only

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }

  const timeoutMs = job.resourceBudget.maxDurationSec * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await executor(job.payload, { signal: controller.signal, ...providers });
  } catch (err) {
    if (err instanceof RassilonExecutionError && err.code === 'job_cancelled' && controller.signal.aborted && !externalSignal?.aborted) {
      fail('job_timed_out', { timeoutMs });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

export { JOB_TYPES as EXECUTOR_JOB_TYPES } from './rassilon-job-schema.js';
export const AVAILABLE_EXECUTORS = Object.freeze(Object.keys(EXECUTORS));
