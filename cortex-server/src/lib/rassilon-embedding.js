/**
 * RASSILON V1 Phase 3 — EMBEDDING_BATCH executor. Local-only adapter over
 * this codebase's existing Ollama embedding client (`ollama.js`'s
 * `embedText`, `verifyModelAvailability`, `createOllamaClient`) — no new
 * embedding engine written (mission §3: "Ne pas écrire un nouveau moteur
 * d'embedding si un adapter local propre existe déjà").
 *
 * LOCAL ONLY, no cloud fallback (mission §4): the only client this module
 * ever talks to is the local Ollama instance's Ollama client object,
 * injected by the caller (rassilon-worker.js, wired from server.js's
 * existing module-level `ollamaClient`/`env.EMBEDDING_MODEL` — the exact
 * same objects every other embedding call site in this codebase already
 * uses). There is no OpenAI/Gemini/Mistral/remote-endpoint code path
 * anywhere in this file, and none is reachable from it.
 *
 * NO MODEL AUTO-DOWNLOAD (mission §5): if the requested model is not
 * already installed, verifyModelAvailability() reports false and this
 * module returns NOT_AVAILABLE — it never calls Ollama's /pull endpoint
 * or any install path.
 */
import { verifyModelAvailability, embedText } from './ollama.js';

export class RassilonEmbeddingError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'RassilonEmbeddingError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new RassilonEmbeddingError(code, detail);
}

// Output bounds (mission §8) — a vector's dimension count is sanity-capped
// so a malformed/adversarial provider response can't balloon the result
// past what any of the allowlisted embedding models actually produce
// (nomic-embed-text is 768-dim; this ceiling has generous headroom for
// any future allowlisted model without being unbounded).
const MAX_VECTOR_DIMENSIONS = 8_192;

function checkAborted(signal) {
  if (signal?.aborted) fail('job_cancelled');
}

/**
 * Validates a single embedding vector returned by the provider (mission
 * §41 — never trust the local provider blindly): must be a finite-number
 * array within the dimension ceiling. Throws on NaN/Infinity/wrong shape.
 */
function validateVector(vector, index) {
  if (!Array.isArray(vector) || vector.length === 0) fail('provider_output_invalid', { index, reason: 'not_an_array_or_empty' });
  if (vector.length > MAX_VECTOR_DIMENSIONS) fail('provider_output_invalid', { index, reason: 'dimensions_too_large', dimensions: vector.length });
  for (const n of vector) {
    if (typeof n !== 'number' || !Number.isFinite(n)) fail('provider_output_invalid', { index, reason: 'non_finite_value' });
  }
  return vector;
}

/**
 * Executes an EMBEDDING_BATCH job. `deps.ollamaClient` and
 * `deps.embeddingModel` are always injected by the caller (never a module-
 * level import here) so tests can supply a mock client without a real
 * Ollama server (mission §49 — "provider injectable/mock").
 *
 * Cancellation limitation, documented honestly (mission §27): Ollama's
 * JS client's embed() call has no AbortSignal parameter in the version
 * this codebase depends on (`ollama.js` calls `client.embed({...})` with
 * no signal option) — a cancellation request checked BETWEEN texts stops
 * further texts from being submitted, but an embed() call already in
 * flight for the current text cannot be physically aborted mid-request;
 * this executor can only discard that one in-flight result once it
 * resolves/rejects, not sever the actual HTTP request early. This is a
 * real, disclosed limitation, not claimed as hard cancellation.
 */
export async function executeEmbeddingBatch(payload, { signal, ollamaClient, embeddingModel } = {}) {
  checkAborted(signal);

  if (!ollamaClient) fail('provider_unavailable', { reason: 'ollama_client_not_configured' });

  // Model allowlist was already enforced at schema-validation time
  // (rassilon-job-schema.js's EMBEDDING_MODEL_ALLOWLIST); this re-check
  // confirms the SPECIFIC requested model is actually installed right
  // now, mirroring the existing server.js/routes/ollama.js pattern
  // (verifyModelAvailability) rather than assuming allowlisted ==
  // installed. No auto-pull on a miss (mission §5).
  let available;
  try {
    available = await verifyModelAvailability(ollamaClient, payload.model);
  } catch (err) {
    fail('provider_unavailable', { reason: 'availability_check_failed', message: err?.message });
  }
  if (!available) fail('model_not_available', { model: payload.model });

  const vectors = [];
  const startedAt = Date.now();

  for (let i = 0; i < payload.texts.length; i++) {
    checkAborted(signal);
    let vector;
    try {
      vector = await embedText(ollamaClient, payload.model, payload.texts[i]);
    } catch (err) {
      fail('provider_request_failed', { index: i, message: err?.message });
    }
    vectors.push(validateVector(vector, i));
  }

  const durationMs = Date.now() - startedAt;
  const dimensions = vectors[0]?.length ?? 0;

  // Bounded output (mission §8): vectors/dimensions/counts/model
  // identifier/timings only — never raw input text, never a system path,
  // never provider internals.
  const result = {
    kind: 'EMBEDDING_BATCH',
    model: payload.model,
    vectorCount: vectors.length,
    dimensions,
    vectors,
    durationMs,
  };

  const MAX_RESULT_BYTES = 512 * 1024; // embedding vectors are inherently larger than SAFE_CPU_TASK's bound; still finite and enforced
  const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (resultBytes > MAX_RESULT_BYTES) fail('result_too_large', { bytes: resultBytes });

  return result;
}
