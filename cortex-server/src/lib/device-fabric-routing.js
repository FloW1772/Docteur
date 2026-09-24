/**
 * DEVICE FABRIC Phase 3 — safe RASSILON routing (exact target, no fallback).
 *
 * The only Fabric module allowed to reach RASSILON's controller. It routes
 * one explicit, user-initiated semantic action to the ONE RASSILON worker
 * linked to a Fabric device, and nothing else:
 *
 *   request (closed enum + strict schema)
 *   → fabricDeviceId → active RASSILON link → exact rassilonDeviceId
 *   → link intact, identity TRUSTED, fingerprint unchanged, worker direction
 *   → SUPPORTED = AUTHORIZED = AVAILABLE = YES (UNKNOWN is never YES)
 *   → dispatchRassilonRemoteJob({ devices: [thatWorker] }): RASSILON signs
 *     and the worker revalidates session, signature, permission, executor
 *     allowlist, schema, resources, battery/idle guards, STOP, revocation,
 *     replay — Fabric grants nothing
 *   → the job must have been sent to that exact worker
 *   → bounded retrieval of the signed result, re-verified here against the
 *     expected worker key/id and jobId, then checked against a strict output
 *     schema. Only then COMPLETED.
 *
 * Deliberately absent: OMEGA routing (OMEGA V1 has no outbound client),
 * retargeting to another worker, automatic re-dispatch, cancellation (RASSILON
 * V1 has no certified controller-side cancel primitive), STOP ALL, and any
 * credential storage. The outbound session id is read only to hand it to
 * RASSILON's own poll/refresh functions; it is never stored, logged or
 * returned (reports/DEVICE_FABRIC_ARCHITECTURE_2026-09.md §8, §19).
 */
import crypto from 'node:crypto';
import {
  getFabricDevice, getFabricOperation, getRassilonDevice, getRassilonLocalDevice, getRassilonOutboundSession, insertFabricAudit,
  insertFabricOperation, listFabricOperations, listFabricOperationsByStatus, transitionFabricOperation,
} from './sqlite.js';
import { DeviceFabricError, getFabricDeviceView, isFabricDeviceId } from './device-fabric.js';
import { dispatchRassilonRemoteJob, pollRassilonRemoteResult, refreshRassilonWorkerStatus } from './rassilon-controller.js';
import { verifyRemoteResult } from './rassilon-remote-result.js';

export const FABRIC_ROUTABLE_ACTIONS = Object.freeze({
  RASSILON_SAFE_CPU: 'SAFE_CPU_TASK',
  RASSILON_EMBEDDING: 'EMBEDDING_BATCH',
});
export const FABRIC_NOT_ROUTABLE_ACTIONS = Object.freeze(['OMEGA_VIEW', 'OMEGA_INTERACTIVE', 'OMEGA_ADMIN']);
export const FABRIC_OPERATION_STATES = Object.freeze(['PENDING', 'ROUTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'NOT_AVAILABLE']);
// Mirror of RASSILON's EMBEDDING_MODEL_ALLOWLIST (asserted equal by the tests).
export const FABRIC_EMBEDDING_MODELS = Object.freeze(['nomic-embed-text']);

// Fabric bounds are deliberately tighter than RASSILON's own schema so a
// routed job always fits the worker's 256 KiB LAN body limit.
export const FABRIC_LIMITS = Object.freeze({
  hashHexMax: 65_536,
  jsonItemsMax: 1_000,
  jsonStringMax: 256,
  vectorCountMax: 16,
  vectorLengthMax: 1_024,
  embeddingTextsMax: 16,
  embeddingTextCharsMax: 2_000,
  embeddingTotalCharsMax: 16_000,
});
const DEFAULT_BUDGET = Object.freeze({ cpuPercent: 10, ramMb: 256, maxDurationSec: 60 });
const BUDGET_LIMITS = Object.freeze({ cpuPercent: [1, 50], ramMb: [64, 2048], maxDurationSec: [1, 120] });
const MAX_ACTIVE_OPERATIONS = 4;
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'NOT_AVAILABLE']);
// Same tolerance RASSILON applies to request timestamps between machines.
const RESULT_CLOCK_SKEW_MS = 60_000;

/**
 * Operation state machine: target state → states it may be entered from.
 * PENDING → ROUTING → RUNNING → COMPLETED | FAILED | CANCELLED, with
 * NOT_AVAILABLE / FAILED possible before dispatch. Terminal states have no
 * exit, so nothing can move COMPLETED back to RUNNING or complete twice.
 */
export const FABRIC_OPERATION_TRANSITIONS = Object.freeze({
  ROUTING: Object.freeze(['PENDING']),
  RUNNING: Object.freeze(['ROUTING']),
  COMPLETED: Object.freeze(['RUNNING']),
  CANCELLED: Object.freeze(['RUNNING']),
  FAILED: Object.freeze(['PENDING', 'ROUTING', 'RUNNING']),
  NOT_AVAILABLE: Object.freeze(['PENDING', 'ROUTING']),
});

// Field names that can never appear anywhere in a routing request: execution
// vocabulary, executable file types and any attempt to supply authority or a
// target from outside.
const FORBIDDEN_FIELD = /^(command|cmd|cmdline|commandline|shell|powershell|pwsh|bash|sh|script|scripts|exec|execute|executable|executablepath|process|spawn|binary|bin|dll|exe|bat|ps1|psm1|vbs|msi|path|paths|file|files|filepath|url|uri|href|src|endpoint|host|port|javascript|js|python|py|wasm|plugin|module|library|code|eval|args|argv|tool|tools|toolcall|tool_call|rpc|sessionid|session|token|nonce|signature|permission|permissions|permissionlevel|preferreddeviceid|devices|device|targetdeviceid|workerid|issuerid|jobid|__proto__|constructor|prototype)$/i;

export class FabricRouteRejection extends DeviceFabricError {
  constructor(code, status, operation = null) {
    super(code, status);
    this.name = 'FabricRouteRejection';
    this.operation = operation;
  }
}

function fail(code, status = 400) {
  throw new DeviceFabricError(code, status);
}

function safeCode(value, fallback) {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function onlyKeys(value, allowed, code) {
  if (!isPlainObject(value)) fail(code);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(code);
}

function assertNoForbiddenFields(value, depth = 0) {
  if (depth > 6) fail('payload_too_deep');
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenFields(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_FIELD.test(key)) fail('forbidden_payload_field');
      assertNoForbiddenFields(value[key], depth + 1);
    }
  }
}

const intIn = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;

// ── Request schema ─────────────────────────────────────────────────────────

function validateSafeCpu(payload) {
  onlyKeys(payload, ['kind', 'data'], 'safe_cpu_payload_invalid');
  const { kind, data } = payload;
  if (kind === 'HASH_BUFFER') {
    onlyKeys(data, ['hex', 'algorithm'], 'safe_cpu_payload_invalid');
    const algorithm = data.algorithm ?? 'sha256';
    if (typeof data.hex !== 'string' || data.hex.length === 0 || data.hex.length > FABRIC_LIMITS.hashHexMax
        || data.hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(data.hex)) fail('hash_buffer_invalid');
    if (!['sha256', 'sha512'].includes(algorithm)) fail('hash_algorithm_invalid');
    return {
      payload: { kind, data: { hex: data.hex.toLowerCase(), algorithm } },
      summary: { kind, algorithm, inputBytes: data.hex.length / 2 },
    };
  }
  if (kind === 'JSON_TRANSFORM_BENCH') {
    onlyKeys(data, ['items'], 'safe_cpu_payload_invalid');
    const { items } = data;
    if (!Array.isArray(items) || items.length === 0 || items.length > FABRIC_LIMITS.jsonItemsMax) fail('json_items_invalid');
    for (const item of items) {
      const ok = (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && item.length <= FABRIC_LIMITS.jsonStringMax);
      if (!ok) fail('json_items_invalid');
    }
    return { payload: { kind, data: { items } }, summary: { kind, itemCount: items.length } };
  }
  if (kind === 'VECTOR_MATH') {
    onlyKeys(data, ['vectors', 'operation'], 'safe_cpu_payload_invalid');
    const operation = data.operation ?? 'dot_sum';
    const { vectors } = data;
    if (!['dot_sum', 'magnitude_sum'].includes(operation)) fail('vector_operation_invalid');
    if (!Array.isArray(vectors) || vectors.length === 0 || vectors.length > FABRIC_LIMITS.vectorCountMax) fail('vectors_invalid');
    const length = Array.isArray(vectors[0]) ? vectors[0].length : 0;
    if (length === 0 || length > FABRIC_LIMITS.vectorLengthMax) fail('vectors_invalid');
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length !== length || !vector.every(n => typeof n === 'number' && Number.isFinite(n))) fail('vectors_invalid');
    }
    return { payload: { kind, data: { vectors, operation } }, summary: { kind, operation, vectorCount: vectors.length, vectorLength: length } };
  }
  fail('safe_cpu_kind_invalid');
}

function validateEmbedding(payload) {
  onlyKeys(payload, ['texts', 'model'], 'embedding_payload_invalid');
  const { texts, model } = payload;
  if (!FABRIC_EMBEDDING_MODELS.includes(model)) fail('embedding_model_not_allowed');
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > FABRIC_LIMITS.embeddingTextsMax) fail('embedding_texts_invalid');
  let totalChars = 0;
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0 || text.length > FABRIC_LIMITS.embeddingTextCharsMax) fail('embedding_texts_invalid');
    totalChars += text.length;
  }
  if (totalChars > FABRIC_LIMITS.embeddingTotalCharsMax) fail('embedding_texts_invalid');
  // Texts are data for the fixed embedding executor; they are never executed.
  return { payload: { texts, model }, summary: { model, textCount: texts.length, totalChars } };
}

function validateBudget(budget) {
  if (budget === undefined) return { ...DEFAULT_BUDGET };
  onlyKeys(budget, ['cpuPercent', 'ramMb', 'maxDurationSec'], 'resource_budget_invalid');
  const merged = { ...DEFAULT_BUDGET, ...budget };
  for (const [key, range] of Object.entries(BUDGET_LIMITS)) if (!intIn(merged[key], range)) fail('resource_budget_invalid');
  return merged;
}

/** Validates a routing request. Throws DeviceFabricError on anything unexpected. */
export function validateRouteRequest(body) {
  onlyKeys(body, ['fabricDeviceId', 'actionType', 'semanticPayload', 'resourceBudget'], 'unknown_field');
  const { fabricDeviceId, actionType, semanticPayload, resourceBudget } = body;
  if (typeof actionType !== 'string') fail('action_type_required');
  if (FABRIC_NOT_ROUTABLE_ACTIONS.includes(actionType)) fail('not_routable', 409);
  const jobType = FABRIC_ROUTABLE_ACTIONS[actionType];
  if (!Object.hasOwn(FABRIC_ROUTABLE_ACTIONS, actionType)) fail('action_not_supported');
  if (typeof fabricDeviceId !== 'string') fail('fabric_device_id_invalid');
  assertNoForbiddenFields(semanticPayload);
  assertNoForbiddenFields(resourceBudget);
  const validated = jobType === 'SAFE_CPU_TASK' ? validateSafeCpu(semanticPayload) : validateEmbedding(semanticPayload);
  return { fabricDeviceId, actionType, jobType, ...validated, budget: validateBudget(resourceBudget) };
}

// ── Exact target resolution ────────────────────────────────────────────────

function outboundSessionState(workerDeviceId, now = Date.now()) {
  const session = getRassilonOutboundSession(workerDeviceId);
  if (!session || session.revokedAt || !(Date.parse(session.expiresAt) > now)) return null;
  return session;
}

/**
 * Resolves fabricDeviceId to the ONE RASSILON worker linked to it, or throws
 * a NOT_AVAILABLE reason. Nothing here ever looks at another worker.
 */
export function resolveExactRassilonTarget(fabricDeviceId, jobType) {
  const device = getFabricDeviceView(fabricDeviceId);
  const link = device.agents.RASSILON;
  if (!link) fail('rassilon_not_linked', 409);
  if (link.linkState === 'MISSING') fail('rassilon_identity_missing', 409);
  if (link.linkState === 'FINGERPRINT_MISMATCH') fail('rassilon_fingerprint_mismatch', 409);
  if (link.linkState === 'AGENT_ERROR') fail('agent_projection_error', 409);
  if (link.linkState !== 'OK') fail('rassilon_link_unsafe', 409);
  if (link.trust === 'REVOKED') fail('rassilon_identity_revoked', 409);
  if (link.trust !== 'TRUSTED') fail('rassilon_identity_untrusted', 409);
  const block = link.directions.find(d => d.direction === 'THIS_PC_SENDS_COMPUTE');
  if (!block) fail('rassilon_target_not_a_worker', 409);
  const cap = block.capabilities.find(c => c.name === jobType);
  if (!cap || cap.supported === 'NO') fail('capability_not_supported', 409);
  if (cap.supported !== 'YES') fail('capability_support_unknown', 409);
  if (cap.authorized !== 'YES') fail('capability_not_authorized', 409);
  if (cap.available === 'NO') fail('target_not_available', 409);
  if (cap.available !== 'YES' || !cap.routable) fail('target_availability_unknown', 409);

  // Re-read the exact worker record (public key + TLS pin) that RASSILON
  // itself will use, and re-check it is still the identity the user linked.
  const worker = getRassilonDevice(link.agentDeviceId);
  if (!worker || worker.revokedAt) fail('rassilon_identity_revoked', 409);
  if (String(worker.fingerprint).toLowerCase() !== link.linkedFingerprint) fail('rassilon_fingerprint_mismatch', 409);
  if (!['WORKER', 'BOTH'].includes(worker.role)) fail('rassilon_target_not_a_worker', 409);
  if (!outboundSessionState(worker.deviceId)) fail('target_not_available', 409);
  // RASSILON signs with this PC's existing identity; Fabric never causes one to be created.
  if (!getRassilonLocalDevice()) fail('local_rassilon_identity_missing', 409);
  return { device, link, worker };
}

// ── Result verification ────────────────────────────────────────────────────

const finite = value => typeof value === 'number' && Number.isFinite(value);
const exactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Returns a bounded safe summary of a COMPLETED output, or null if it does not match the request. */
export function summarizeVerifiedOutput(jobType, request, output) {
  if (jobType === 'EMBEDDING_BATCH') {
    if (!exactKeys(output, ['kind', 'model', 'vectorCount', 'dimensions', 'vectors', 'durationMs'])) return null;
    const { kind, model, vectorCount, dimensions, vectors, durationMs } = output;
    if (kind !== 'EMBEDDING_BATCH' || model !== request.payload.model) return null;
    if (vectorCount !== request.payload.texts.length || !Array.isArray(vectors) || vectors.length !== vectorCount) return null;
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8_192 || !finite(durationMs) || durationMs < 0) return null;
    if (!vectors.every(vector => Array.isArray(vector) && vector.length === dimensions && vector.every(finite))) return null;
    // Vectors are verified, then deliberately not kept by Fabric.
    return { kind, model, vectorCount, dimensions, durationMs };
  }
  const { kind } = request.payload;
  if (!isPlainObject(output) || output.kind !== kind) return null;
  if (kind === 'HASH_BUFFER') {
    if (!exactKeys(output, ['kind', 'algorithm', 'inputBytes', 'digest'])) return null;
    const { algorithm, hex } = request.payload.data;
    if (output.algorithm !== algorithm || output.inputBytes !== hex.length / 2) return null;
    // Cheap to recompute locally: a signed but wrong digest is still rejected.
    const expected = crypto.createHash(algorithm).update(Buffer.from(hex, 'hex')).digest('hex');
    if (output.digest !== expected) return null;
    return { kind, algorithm, inputBytes: output.inputBytes, digest: output.digest };
  }
  if (kind === 'JSON_TRANSFORM_BENCH') {
    const keys = ['kind', 'itemCount', 'numericCount', 'numericSum', 'numericAvg', 'stringCount', 'stringLengthAvg'];
    if (!exactKeys(output, keys) || output.itemCount !== request.payload.data.items.length) return null;
    if (![output.numericCount, output.numericSum, output.stringCount].every(finite)) return null;
    if (![output.numericAvg, output.stringLengthAvg].every(v => v === null || finite(v))) return null;
    return Object.fromEntries(keys.map(key => [key, output[key]]));
  }
  if (kind === 'VECTOR_MATH') {
    const keys = ['kind', 'operation', 'vectorCount', 'vectorLength', 'result'];
    const { vectors, operation } = request.payload.data;
    if (!exactKeys(output, keys) || output.operation !== operation || output.vectorCount !== vectors.length
        || output.vectorLength !== vectors[0].length || !finite(output.result)) return null;
    return Object.fromEntries(keys.map(key => [key, output[key]]));
  }
  return null;
}

/**
 * The binding check applied to every result: signed by the expected worker's
 * key, for the expected jobId, from the expected workerId. A result that is
 * cryptographically valid but comes from another worker or another job is
 * rejected.
 */
export function isResultBoundToTarget(result, { worker, jobId }) {
  return !!result && result.workerId === worker.deviceId && result.jobId === jobId
    && verifyRemoteResult(result, { expectedWorkerId: worker.deviceId, expectedJobId: jobId, publicKeyPem: worker.publicKeyPem });
}

// ── Operations ─────────────────────────────────────────────────────────────

const activeOperations = new Map();

function audit(eventType, operation, reason = null) {
  insertFabricAudit({
    eventType, fabricDeviceId: operation?.fabricDeviceId ?? null, agentType: operation ? 'RASSILON' : null,
    agentDeviceId: operation?.agentDeviceId ?? null, reason, operationId: operation?.operationId ?? null,
    correlationId: operation?.correlationId ?? null,
  });
}

// A refused request that never became an operation is still audited, with
// whatever it safely names: an existing Fabric device and the agent family.
function auditRejectedRequest(body, reason) {
  const candidate = body?.fabricDeviceId;
  const fabricDeviceId = isFabricDeviceId(candidate) && getFabricDevice(candidate) ? candidate : null;
  const actionType = typeof body?.actionType === 'string' ? body.actionType : '';
  const agentType = actionType.startsWith('OMEGA_') ? 'OMEGA' : actionType.startsWith('RASSILON_') ? 'RASSILON' : null;
  insertFabricAudit({ eventType: 'FABRIC_ROUTE_REJECTED', fabricDeviceId, agentType, reason });
}

/**
 * Applies one state-machine transition. Returns the operation when applied,
 * null when the operation was not in an allowed source state (it is then
 * left untouched and nothing is audited).
 */
export function transitionOperation(operationId, status, fields = {}) {
  const { applied, operation } = transitionFabricOperation(operationId, FABRIC_OPERATION_TRANSITIONS[status] ?? [], { status, ...fields });
  return applied ? operation : null;
}

function finish(operationId, status, fields) {
  const operation = transitionOperation(operationId, status, { completedAt: new Date().toISOString(), ...fields });
  if (!operation) return getFabricOperation(operationId);
  const event = { COMPLETED: 'FABRIC_ROUTE_COMPLETED', CANCELLED: 'FABRIC_ROUTE_CANCELLED', NOT_AVAILABLE: 'FABRIC_ROUTE_REJECTED' }[status] ?? 'FABRIC_ROUTE_FAILED';
  audit(event, operation, fields.safeError ?? null);
  return operation;
}

// Not unref'd: each wait is short and bounded by the operation deadline, and
// the process must not exit while an operation is still being followed.
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function followOperation(operationId, ctx) {
  const { worker, jobId, jobType, request, deadline, transport, pollIntervalMs, sleep, dispatchedAt } = ctx;
  let interval = pollIntervalMs;
  let transientFailures = 0;
  while (Date.now() < deadline) {
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), 4_000);
    // The exact worker only. Revocation or a local STOP (which revokes the
    // outbound session) ends the operation — never a retry elsewhere.
    const current = getRassilonDevice(worker.deviceId);
    if (!current || current.revokedAt) return finish(operationId, 'FAILED', { safeError: 'target_revoked' });
    const session = outboundSessionState(worker.deviceId);
    if (!session) return finish(operationId, 'FAILED', { safeError: 'session_unavailable' });
    let result;
    try {
      result = await pollRassilonRemoteResult({ worker, jobId, sessionId: session.sessionId, transport });
    } catch (error) {
      if (error?.code === 'result_authenticity_invalid') return finish(operationId, 'FAILED', { safeError: 'result_authenticity_invalid' });
      transientFailures += 1;
      if (transientFailures >= 3) return finish(operationId, 'FAILED', { safeError: safeCode(error?.code, 'result_unreachable') });
      continue;
    }
    transientFailures = 0;
    if (!isResultBoundToTarget(result, { worker, jobId })) return finish(operationId, 'FAILED', { safeError: 'result_binding_invalid' });
    if (['QUEUED', 'RUNNING'].includes(result.status)) continue;
    if (result.status === 'COMPLETED') {
      // A signed completion that claims to predate this dispatch is a
      // replayed/stale result, never this operation's outcome.
      const completedAt = Date.parse(result.completionTimestamp);
      if (!Number.isFinite(completedAt) || completedAt > Date.now() + RESULT_CLOCK_SKEW_MS) {
        return finish(operationId, 'FAILED', { safeError: 'result_timestamp_invalid' });
      }
      if (completedAt < dispatchedAt - RESULT_CLOCK_SKEW_MS) return finish(operationId, 'FAILED', { safeError: 'result_stale' });
      const summary = summarizeVerifiedOutput(jobType, request, result.output);
      if (!summary) return finish(operationId, 'FAILED', { safeError: 'result_schema_invalid' });
      return finish(operationId, 'COMPLETED', { resultSummary: summary });
    }
    if (result.status === 'CANCELLED') return finish(operationId, 'CANCELLED', { safeError: safeCode(result.errorReason, 'cancelled_by_worker') });
    return finish(operationId, 'FAILED', { safeError: safeCode(result.errorReason, 'job_failed') });
  }
  return finish(operationId, 'FAILED', { safeError: 'result_timeout' });
}

/**
 * Routes one explicit request. Returns the operation once the exact worker
 * accepted the job (RUNNING); the result is then followed in the background.
 * Throws FabricRouteRejection (with the recorded operation when one exists).
 */
export async function routeFabricAction(body, {
  transport, pollIntervalMs = 500, deadlineMarginMs = 30_000, sleep = defaultSleep,
} = {}) {
  let request;
  try {
    request = validateRouteRequest(body);
  } catch (error) {
    auditRejectedRequest(body, safeCode(error?.code, 'route_request_invalid'));
    throw error;
  }
  if (activeOperations.size >= MAX_ACTIVE_OPERATIONS) {
    auditRejectedRequest(body, 'fabric_operation_limit_reached');
    fail('fabric_operation_limit_reached', 429);
  }

  let target;
  try {
    target = resolveExactRassilonTarget(request.fabricDeviceId, request.jobType);
  } catch (error) {
    // Unknown/invalid Fabric device: no operation to record against it.
    if (['fabric_device_id_invalid', 'fabric_device_not_found'].includes(error?.code)) {
      auditRejectedRequest(body, error.code);
      throw error;
    }
    const linked = getFabricDeviceView(request.fabricDeviceId).agents.RASSILON;
    const operation = insertFabricOperation({
      operationId: `fop-${crypto.randomUUID()}`, correlationId: `fcor-${crypto.randomUUID()}`,
      fabricDeviceId: request.fabricDeviceId, agentDeviceId: linked?.agentDeviceId ?? 'unlinked',
      actionType: request.actionType, jobType: request.jobType, status: 'PENDING',
      inputSummary: { ...request.summary, resourceBudget: request.budget },
    });
    audit('FABRIC_ROUTE_REQUESTED', operation);
    const code = safeCode(error?.code, 'target_not_available');
    throw new FabricRouteRejection(code, 409, finish(operation.operationId, 'NOT_AVAILABLE', { safeError: code }));
  }

  const { worker } = target;
  let operation = insertFabricOperation({
    operationId: `fop-${crypto.randomUUID()}`, correlationId: `fcor-${crypto.randomUUID()}`,
    fabricDeviceId: request.fabricDeviceId, agentDeviceId: worker.deviceId, actionType: request.actionType,
    jobType: request.jobType, status: 'PENDING', inputSummary: { ...request.summary, resourceBudget: request.budget },
  });
  audit('FABRIC_ROUTE_REQUESTED', operation);
  const { operationId } = operation;
  operation = transitionOperation(operationId, 'ROUTING');
  const dispatchedAt = Date.now();

  let dispatched;
  try {
    // `devices: [worker]` is the exact-target guarantee: RASSILON's scheduler
    // only ever sees this one worker, so its preferredDeviceId fallback to
    // "any worker" (architecture F7) cannot trigger.
    dispatched = await dispatchRassilonRemoteJob({
      jobType: request.jobType, payload: request.payload, resourceBudget: request.budget,
      preferredDeviceId: worker.deviceId, devices: [worker], ...(transport ? { transport } : {}),
    });
  } catch (error) {
    const code = safeCode(error?.code, 'dispatch_failed');
    // RASSILON's own scheduler/policy refused the exact worker: not available.
    const status = code === 'no_eligible_worker' || code === 'session_required' ? 'NOT_AVAILABLE' : 'FAILED';
    throw new FabricRouteRejection(code, status === 'NOT_AVAILABLE' ? 409 : 502, finish(operationId, status, { safeError: code }));
  }
  if (dispatched?.worker?.deviceId !== worker.deviceId || dispatched?.job?.targetDeviceId !== worker.deviceId) {
    throw new FabricRouteRejection('target_mismatch', 502, finish(operationId, 'FAILED', { safeError: 'target_mismatch' }));
  }

  const jobId = dispatched.job.jobId;
  operation = transitionOperation(operationId, 'RUNNING', { agentOperationId: jobId, startedAt: new Date().toISOString() });
  audit('FABRIC_ROUTE_STARTED', operation);
  const deadline = Date.now() + request.budget.maxDurationSec * 1_000 + deadlineMarginMs;
  const completion = followOperation(operationId, {
    worker, jobId, jobType: request.jobType, request, deadline, transport, pollIntervalMs, sleep, dispatchedAt,
  }).catch(() => finish(operationId, 'FAILED', { safeError: 'internal_error' }))
    .finally(() => activeOperations.delete(operationId));
  activeOperations.set(operationId, completion);
  return operation;
}

/** Test/diagnostic helper: resolves when a background operation settles. */
export async function waitForFabricOperation(operationId) {
  await activeOperations.get(operationId);
  return getFabricOperation(operationId);
}

export function getFabricOperationView(operationId) {
  if (typeof operationId !== 'string' || !/^fop-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) {
    fail('operation_id_invalid');
  }
  const operation = getFabricOperation(operationId);
  if (!operation) fail('operation_not_found', 404);
  return operation;
}

export function listFabricOperationViews({ limit = 50, offset = 0 } = {}) {
  const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
  const boundedOffset = Number.isInteger(offset) ? Math.min(Math.max(offset, 0), 100_000) : 0;
  return listFabricOperations({ limit: boundedLimit, offset: boundedOffset });
}

/**
 * Explicit, user-triggered availability check of the exact linked worker via
 * RASSILON's own authenticated status call. One request, no loop, no other worker.
 */
export async function probeRassilonWorker(fabricDeviceId, { transport } = {}) {
  const device = getFabricDeviceView(fabricDeviceId);
  const link = device.agents.RASSILON;
  if (!link) fail('rassilon_not_linked', 409);
  if (link.linkState !== 'OK') fail('rassilon_link_unsafe', 409);
  if (link.trust !== 'TRUSTED') fail('rassilon_identity_revoked', 409);
  const worker = getRassilonDevice(link.agentDeviceId);
  if (!worker || String(worker.fingerprint).toLowerCase() !== link.linkedFingerprint) fail('rassilon_fingerprint_mismatch', 409);
  if (!['WORKER', 'BOTH'].includes(worker.role)) fail('rassilon_target_not_a_worker', 409);
  const session = outboundSessionState(worker.deviceId);
  if (!session) fail('session_unavailable', 409);
  if (!getRassilonLocalDevice()) fail('local_rassilon_identity_missing', 409);
  try {
    await refreshRassilonWorkerStatus({ worker, sessionId: session.sessionId, ...(transport ? { transport } : {}) });
  } catch (error) {
    fail(safeCode(error?.code, 'probe_failed'), 502);
  }
  return getFabricDeviceView(fabricDeviceId);
}

/**
 * Called once at boot: operations left non-terminal by a previous process
 * are marked FAILED. Their RASSILON job is not resumed or re-dispatched.
 */
export function recoverInterruptedFabricOperations() {
  let recovered = 0;
  for (const operation of listFabricOperationsByStatus(['PENDING', 'ROUTING', 'RUNNING'])) {
    if (activeOperations.has(operation.operationId)) continue;
    finish(operation.operationId, 'FAILED', { safeError: 'interrupted_by_restart' });
    recovered += 1;
  }
  return recovered;
}

export function isTerminalFabricOperation(status) {
  return TERMINAL.has(status);
}
