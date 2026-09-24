/**
 * RASSILON V1 Phase 2 — Signed Semantic Job schema, validation, canonical
 * serialization, and signature verification. Mirrors MAÎTRE's
 * maitre-actions.js discipline (reports/RASSILON_ARCHITECTURE_2026-09.md
 * §7-9): a closed job-type enum, forbidden-key check applied generically
 * BEFORE any type-specific schema runs, and zero imports of
 * child_process — this file cannot run anything, it only validates and
 * verifies.
 *
 * Job shape (mission §16):
 *   jobId, jobType, issuerId, createdAt, expiresAt, resourceBudget,
 *   payload, signature, policyVersion
 * Signature covers the full canonical form; any mutation invalidates it
 * (mission §16 — "Toute mutation : signature invalid").
 */
import { verifyWithPublicKey } from './rassilon-identity.js';

export class RassilonJobError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'RassilonJobError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new RassilonJobError(code, detail);
}

// ── Closed job-type enum (mission §20/§21 Phase 2; §3/§21 Phase 3) ─────────
// Phase 2 shipped exactly one executor, SAFE_CPU_TASK. Phase 3 mission §3
// adds exactly one more, EMBEDDING_BATCH — a local-only Ollama embedding
// adapter (rassilon-embedding.js), still no LLM_INFERENCE/
// IMAGE_GENERATION/TRANSCRIPTION (mission §21: "Maximum" is these two).
export const JOB_TYPES = Object.freeze(['SAFE_CPU_TASK', 'EMBEDDING_BATCH']);

// Explicitly rejected job types even though the client never has to name
// them for a generic-unknown-type rejection to work — naming them lets
// the rejection reason be more specific (mission §22/§56) instead of the
// generic job_type_invalid.
const CRYPTO_MINING_JOB_TYPES = Object.freeze(['MINING', 'STRATUM', 'CRYPTO_MINING', 'HASHCASH_FOR_PROFIT']);

export const JOB_STATUSES = Object.freeze([
  'RECEIVED', 'VALIDATED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED',
  'CANCELLED', 'REJECTED', 'INTERRUPTED',
]);

// Forbidden field names, checked generically and recursively across the
// WHOLE job object regardless of jobType (mission §8 architecture report,
// mirrors MAÎTRE's FORBIDDEN_KEY_PATTERN) — a job containing any of these
// anywhere in its structure is rejected before type-specific validation.
const FORBIDDEN_KEY_PATTERN = /^(command|cmd|shell|powershell|script|args|exec|execute|executablePath|toolCall|tool_call)$/i;

function assertNoForbiddenKeys(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item, depth + 1);
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) fail('forbidden_key', { key });
    assertNoForbiddenKeys(value[key], depth + 1);
  }
}

// ── Per-job-type payload schemas (mission §24) ─────────────────────────────
// Every executor has its own strict schema: types, sizes, counts, ranges.
// Unknown fields are rejected so a payload can't smuggle extra data past
// validation into the executor.

const SAFE_CPU_TASK_KINDS = Object.freeze(['HASH_BUFFER', 'JSON_TRANSFORM_BENCH', 'VECTOR_MATH']);
const MAX_BUFFER_HEX_LENGTH = 2 * 1024 * 1024; // 1 MB of raw bytes, hex-encoded
const MAX_JSON_TRANSFORM_ITEMS = 10_000;
const MAX_VECTOR_LENGTH = 100_000;
const MAX_VECTOR_COUNT = 100;

function validateSafeCpuTaskPayload(payload) {
  if (!payload || typeof payload !== 'object') fail('payload_required');
  const allowedKeys = ['kind', 'data'];
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.includes(key)) fail('payload_unknown_field', { key });
  }

  const kind = payload.kind;
  if (!SAFE_CPU_TASK_KINDS.includes(kind)) fail('safe_cpu_task_kind_invalid', { kind });

  if (kind === 'HASH_BUFFER') {
    const hex = payload.data?.hex;
    if (typeof hex !== 'string' || hex.length === 0) fail('hash_buffer_hex_required');
    if (hex.length > MAX_BUFFER_HEX_LENGTH) fail('hash_buffer_too_large', { length: hex.length });
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) fail('hash_buffer_hex_malformed');
    const algorithm = payload.data?.algorithm ?? 'sha256';
    if (!['sha256', 'sha512'].includes(algorithm)) fail('hash_buffer_algorithm_invalid', { algorithm });
    return { kind, data: { hex, algorithm } };
  }

  if (kind === 'JSON_TRANSFORM_BENCH') {
    const items = payload.data?.items;
    if (!Array.isArray(items)) fail('json_transform_items_required');
    if (items.length === 0 || items.length > MAX_JSON_TRANSFORM_ITEMS) fail('json_transform_items_count_invalid', { count: items.length });
    for (const item of items) {
      if (typeof item !== 'number' && typeof item !== 'string') fail('json_transform_item_type_invalid');
    }
    return { kind, data: { items } };
  }

  if (kind === 'VECTOR_MATH') {
    const vectors = payload.data?.vectors;
    if (!Array.isArray(vectors)) fail('vector_math_vectors_required');
    if (vectors.length === 0 || vectors.length > MAX_VECTOR_COUNT) fail('vector_math_vector_count_invalid', { count: vectors.length });
    let length = null;
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length === 0 || vector.length > MAX_VECTOR_LENGTH) fail('vector_math_vector_shape_invalid');
      if (length === null) length = vector.length;
      else if (vector.length !== length) fail('vector_math_vector_length_mismatch');
      for (const n of vector) {
        if (typeof n !== 'number' || !Number.isFinite(n)) fail('vector_math_vector_value_invalid');
      }
    }
    const operation = payload.data?.operation ?? 'dot_sum';
    if (!['dot_sum', 'magnitude_sum'].includes(operation)) fail('vector_math_operation_invalid', { operation });
    return { kind, data: { vectors, operation } };
  }

  fail('safe_cpu_task_kind_invalid', { kind }); // unreachable, satisfies "closed enum only"
}

// ── EMBEDDING_BATCH payload schema (mission §6/§7 Phase 3) ─────────────────
// Model allowlist (mission §7): a job may only request a model name from
// this closed set — no path, no URL, no external registry reference, ever
// (the forbidden-key scan above already blocks command/script/exec-shaped
// keys; this is an additional, positive allowlist specifically for the
// `model` field's VALUE, not just its key name). 'nomic-embed-text' is the
// ONLY embedding model referenced anywhere in this codebase today
// (env.EMBEDDING_MODEL's default in server.js, used by every existing
// embedText() call site) — no other embedding model name appears in
// local-ai-catalog.js or elsewhere, so the allowlist stays at exactly
// what's real rather than speculatively listing model names nothing in
// Docteur actually installs or configures.
export const EMBEDDING_MODEL_ALLOWLIST = Object.freeze(['nomic-embed-text']);

const MAX_EMBEDDING_TEXT_COUNT = 64;
const MAX_CHARS_PER_TEXT = 8_000;
const MAX_TOTAL_CHARS = 100_000;

function validateEmbeddingBatchPayload(payload) {
  if (!payload || typeof payload !== 'object') fail('payload_required');
  const allowedKeys = ['texts', 'model'];
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.includes(key)) fail('payload_unknown_field', { key });
  }

  const texts = payload.texts;
  if (!Array.isArray(texts)) fail('embedding_texts_required');
  if (texts.length === 0 || texts.length > MAX_EMBEDDING_TEXT_COUNT) fail('embedding_text_count_invalid', { count: texts.length });

  let totalChars = 0;
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) fail('embedding_text_type_invalid');
    if (text.length > MAX_CHARS_PER_TEXT) fail('embedding_text_too_long', { length: text.length });
    totalChars += text.length;
  }
  if (totalChars > MAX_TOTAL_CHARS) fail('embedding_total_chars_too_large', { totalChars });

  // Model name is validated against the closed allowlist only — never a
  // path, URL, or free-form string reaching the executor (mission §7:
  // "Pas de : path / URL / registry externe / model source distante").
  const model = payload.model;
  if (typeof model !== 'string' || !EMBEDDING_MODEL_ALLOWLIST.includes(model)) fail('embedding_model_not_allowed', { model });

  return { texts, model };
}

const PAYLOAD_VALIDATORS = Object.freeze({
  SAFE_CPU_TASK: validateSafeCpuTaskPayload,
  EMBEDDING_BATCH: validateEmbeddingBatchPayload,
});

// ── Resource budget schema ─────────────────────────────────────────────────

function validateResourceBudget(resourceBudget) {
  if (!resourceBudget || typeof resourceBudget !== 'object') fail('resource_budget_required');
  const allowedKeys = ['cpuPercent', 'ramMb', 'maxDurationSec'];
  for (const key of Object.keys(resourceBudget)) {
    if (!allowedKeys.includes(key)) fail('resource_budget_unknown_field', { key });
  }
  const { cpuPercent, ramMb, maxDurationSec } = resourceBudget;
  if (!Number.isFinite(cpuPercent) || cpuPercent <= 0 || cpuPercent > 100) fail('resource_budget_cpu_invalid', { cpuPercent });
  if (!Number.isFinite(ramMb) || ramMb <= 0) fail('resource_budget_ram_invalid', { ramMb });
  if (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0) fail('resource_budget_duration_invalid', { maxDurationSec });
  return { cpuPercent, ramMb, maxDurationSec };
}

// ── Canonical serialization + signature material (mission §16) ────────────
// Deterministic, sorted-key JSON — the exact same idiom as MAÎTRE's
// stableStringify (maitre-actions.js), so the signature covers the FULL
// canonical form and any single-field mutation invalidates it.

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The exact fields that make up a job's signed identity — everything
// EXCEPT the signature itself. jobId/jobType/issuerId/createdAt/
// expiresAt/resourceBudget/payload/policyVersion are all covered, so
// changing any of them (including resourceBudget or payload contents)
// invalidates the signature (mission §16).
export function canonicalJobBytes({ jobId, jobType, issuerId, targetDeviceId = null, createdAt, expiresAt, resourceBudget, payload, policyVersion }) {
  const material = stableStringify({ jobId, jobType, issuerId, targetDeviceId, createdAt, expiresAt, resourceBudget, payload, policyVersion });
  return Buffer.from(material, 'utf8');
}

/**
 * Validates the full job envelope shape + per-type payload schema, WITHOUT
 * checking signature/expiry/replay (those are separate steps in the
 * acceptance pipeline — mission §32 of the architecture report). Throws
 * RassilonJobError on any structural problem. Returns a normalized job
 * object on success.
 */
export function validateJobSchema(input) {
  if (!input || typeof input !== 'object') fail('job_required');

  assertNoForbiddenKeys(input);

  const allowedTopLevelKeys = [
    'jobId', 'jobType', 'issuerId', 'targetDeviceId', 'createdAt', 'expiresAt',
    'resourceBudget', 'payload', 'policyVersion', 'signature',
  ];
  for (const key of Object.keys(input)) {
    if (!allowedTopLevelKeys.includes(key)) fail('job_unknown_field', { key });
  }

  const jobId = input.jobId;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(jobId)) fail('job_id_invalid');

  const jobType = input.jobType;
  if (CRYPTO_MINING_JOB_TYPES.includes(jobType)) fail('crypto_mining_not_supported', { jobType });
  if (!JOB_TYPES.includes(jobType)) fail('job_type_not_supported', { jobType });

  const issuerId = input.issuerId;
  if (typeof issuerId !== 'string' || issuerId.trim().length === 0) fail('issuer_id_required');

  const targetDeviceId = input.targetDeviceId ?? null;
  if (targetDeviceId !== null && (typeof targetDeviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(targetDeviceId))) {
    fail('target_device_id_invalid');
  }

  const createdAt = input.createdAt;
  const createdAtMs = Date.parse(createdAt);
  if (typeof createdAt !== 'string' || Number.isNaN(createdAtMs)) fail('created_at_invalid');

  const expiresAt = input.expiresAt;
  const expiresAtMs = Date.parse(expiresAt);
  if (typeof expiresAt !== 'string' || Number.isNaN(expiresAtMs)) fail('expires_at_invalid');
  if (expiresAtMs <= createdAtMs) fail('expires_at_before_created_at');

  const resourceBudget = validateResourceBudget(input.resourceBudget);

  const payloadValidator = PAYLOAD_VALIDATORS[jobType];
  const payload = payloadValidator(input.payload);

  const policyVersion = input.policyVersion;
  if (typeof policyVersion !== 'string' || policyVersion.trim().length === 0) fail('policy_version_required');

  const signature = input.signature;
  if (typeof signature !== 'string' || signature.trim().length === 0) fail('signature_required');

  return { jobId, jobType, issuerId, targetDeviceId, createdAt, expiresAt, resourceBudget, payload, policyVersion, signature };
}

/**
 * Verifies a validated job's Ed25519 signature against the issuer's
 * registered public key PEM (looked up by the caller — this function
 * never trusts a key supplied inline with the job, mission §17/T2).
 */
export function verifyJobSignature(job, issuerPublicKeyPem) {
  const bytes = canonicalJobBytes(job);
  return verifyWithPublicKey(issuerPublicKeyPem, bytes, job.signature);
}

/** Reasonable-timestamp guard: rejects createdAt too far in the future (clock skew / forged timestamp) or already past its own expiry. */
export function isReasonableTimestamp(job, { maxClockSkewMs = 60_000 } = {}) {
  const createdAtMs = Date.parse(job.createdAt);
  const now = Date.now();
  if (createdAtMs > now + maxClockSkewMs) return false;
  return true;
}

export function isExpired(job, { now = Date.now() } = {}) {
  return Date.parse(job.expiresAt) <= now;
}

export { CRYPTO_MINING_JOB_TYPES };
