// EMBEDDING_BATCH executor unit tests (mission §3-§9, §41, §49): local
// Ollama client is always a mock here — this file never depends on a
// real running Ollama server. Covers valid batches, provider-failure
// modes (unavailable/timeout/malformed response/wrong dimensions/empty
// vectors), output validation (NaN/Infinity/non-array rejection), and
// the honest cancellation-limitation documented in rassilon-embedding.js.
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeEmbeddingBatch, RassilonEmbeddingError } from './src/lib/rassilon-embedding.js';

function mockClient({ installedModels = ['nomic-embed-text:latest'], embedImpl } = {}) {
  return {
    async list() {
      return { models: installedModels.map(name => ({ name })) };
    },
    async embed({ model, input }) {
      if (embedImpl) return embedImpl({ model, input });
      // Deterministic fixed-dimension fake vector by default.
      return { embeddings: [[0.1, 0.2, 0.3]] };
    },
  };
}

function payload(overrides = {}) {
  return { texts: ['hello world'], model: 'nomic-embed-text', ...overrides };
}

test('valid batch: single text produces one vector with expected shape', async () => {
  const client = mockClient();
  const result = await executeEmbeddingBatch(payload(), { ollamaClient: client });
  assert.equal(result.kind, 'EMBEDDING_BATCH');
  assert.equal(result.model, 'nomic-embed-text');
  assert.equal(result.vectorCount, 1);
  assert.equal(result.dimensions, 3);
  assert.deepEqual(result.vectors, [[0.1, 0.2, 0.3]]);
  assert.equal(typeof result.durationMs, 'number');
});

test('valid batch: multiple texts produce one vector per text, in order', async () => {
  const client = mockClient({
    embedImpl: async ({ input }) => ({ embeddings: [[input.length, 0, 0]] }),
  });
  const result = await executeEmbeddingBatch(payload({ texts: ['a', 'bb', 'ccc'] }), { ollamaClient: client });
  assert.equal(result.vectorCount, 3);
  assert.deepEqual(result.vectors.map(v => v[0]), [1, 2, 3]);
});

test('model_not_available: requested model not in the installed list', async () => {
  const client = mockClient({ installedModels: ['some-other-model:latest'] });
  await assert.rejects(
    executeEmbeddingBatch(payload(), { ollamaClient: client }),
    (err) => { assert.ok(err instanceof RassilonEmbeddingError); assert.equal(err.code, 'model_not_available'); return true; },
  );
});

test('provider_unavailable: no ollamaClient injected at all', async () => {
  await assert.rejects(
    executeEmbeddingBatch(payload(), {}),
    (err) => { assert.equal(err.code, 'provider_unavailable'); return true; },
  );
});

test('provider_unavailable: client.list() throws (availability check itself fails)', async () => {
  const client = { async list() { throw new Error('ECONNREFUSED'); } };
  await assert.rejects(
    executeEmbeddingBatch(payload(), { ollamaClient: client }),
    (err) => { assert.equal(err.code, 'provider_unavailable'); return true; },
  );
});

test('provider_request_failed: client.embed() throws mid-batch (simulated timeout)', async () => {
  const client = mockClient({ embedImpl: async () => { throw new Error('timeout'); } });
  await assert.rejects(
    executeEmbeddingBatch(payload(), { ollamaClient: client }),
    (err) => { assert.equal(err.code, 'provider_request_failed'); return true; },
  );
});

test('provider_request_failed: partial-batch failure — second text fails after first succeeded', async () => {
  let call = 0;
  const client = mockClient({
    embedImpl: async () => {
      call += 1;
      if (call === 2) throw new Error('mid-batch failure');
      return { embeddings: [[1, 2, 3]] };
    },
  });
  await assert.rejects(
    executeEmbeddingBatch(payload({ texts: ['first', 'second', 'third'] }), { ollamaClient: client }),
    (err) => { assert.equal(err.code, 'provider_request_failed'); assert.equal(err.detail.index, 1); return true; },
  );
});

// ── Output validation — never trust the provider blindly (mission §41) ────

test('provider_output_invalid: empty vector array is rejected', async () => {
  const client = mockClient({ embedImpl: async () => ({ embeddings: [[]] }) });
  await assert.rejects(
    executeEmbeddingBatch(payload(), { ollamaClient: client }),
    (err) => { assert.equal(err.code, 'provider_output_invalid'); return true; },
  );
});

test('provider_output_invalid: non-array vector is rejected', async () => {
  const client = mockClient({ embedImpl: async () => ({ embeddings: ['not-an-array'] }) });
  // ollama.js's embedText itself throws if the vector isn't an array
  // (its own "Ollama embeddings response missing vector" guard) — that
  // surfaces as provider_request_failed here since it happens inside the
  // embedText() call this executor awaits, not inside this executor's
  // own validateVector() step. Documented via this test rather than
  // assumed.
  await assert.rejects(
    executeEmbeddingBatch(payload(), { ollamaClient: client }),
    (err) => { assert.equal(err.code, 'provider_request_failed'); return true; },
  );
});

test('provider_output_invalid: NaN in vector is rejected', async () => {
  const client = mockClient({ embedImpl: async () => ({ embeddings: [[0.1, NaN, 0.3]] }) });
  await assert.rejects(
    executeEmbeddingBatch(payload(), { ollamaClient: client }),
    (err) => { assert.equal(err.code, 'provider_output_invalid'); assert.equal(err.detail.reason, 'non_finite_value'); return true; },
  );
});

test('provider_output_invalid: Infinity in vector is rejected', async () => {
  const client = mockClient({ embedImpl: async () => ({ embeddings: [[0.1, Infinity, 0.3]] }) });
  await assert.rejects(
    executeEmbeddingBatch(payload(), { ollamaClient: client }),
    (err) => { assert.equal(err.code, 'provider_output_invalid'); assert.equal(err.detail.reason, 'non_finite_value'); return true; },
  );
});

test('provider_output_invalid: dimension count over the sanity ceiling is rejected', async () => {
  const client = mockClient({ embedImpl: async () => ({ embeddings: [new Array(9000).fill(0.1)] }) });
  await assert.rejects(
    executeEmbeddingBatch(payload(), { ollamaClient: client }),
    (err) => { assert.equal(err.code, 'provider_output_invalid'); assert.equal(err.detail.reason, 'dimensions_too_large'); return true; },
  );
});

test('wrong dimensions across a batch (inconsistent vector sizes) still validates each vector independently, no crash', async () => {
  let call = 0;
  const client = mockClient({
    embedImpl: async () => {
      call += 1;
      return { embeddings: [call === 1 ? [1, 2, 3] : [1, 2]] };
    },
  });
  // The executor does not itself enforce cross-vector dimension
  // consistency (each text is embedded independently) — this documents
  // that today's behavior accepts inconsistent per-text dimensions
  // rather than silently crashing or producing a malformed result.
  const result = await executeEmbeddingBatch(payload({ texts: ['a', 'b'] }), { ollamaClient: client });
  assert.equal(result.vectors[0].length, 3);
  assert.equal(result.vectors[1].length, 2);
});

// ── Cancellation (mission §27 — honest limitation) ─────────────────────────

test('cancellation: an already-aborted signal stops before the first request is even made', async () => {
  const controller = new AbortController();
  controller.abort();
  let embedCalls = 0;
  const client = mockClient({ embedImpl: async () => { embedCalls += 1; return { embeddings: [[1]] }; } });
  await assert.rejects(
    executeEmbeddingBatch(payload(), { ollamaClient: client, signal: controller.signal }),
    (err) => { assert.equal(err.code, 'job_cancelled'); return true; },
  );
  assert.equal(embedCalls, 0);
});

test('cancellation: aborting between texts stops further texts from being submitted (checked before each text)', async () => {
  const controller = new AbortController();
  let embedCalls = 0;
  const client = mockClient({
    embedImpl: async () => {
      embedCalls += 1;
      if (embedCalls === 1) controller.abort(); // simulate cancellation arriving after the first text starts
      return { embeddings: [[1]] };
    },
  });
  await assert.rejects(
    executeEmbeddingBatch(payload({ texts: ['a', 'b', 'c'] }), { ollamaClient: client, signal: controller.signal }),
    (err) => { assert.equal(err.code, 'job_cancelled'); return true; },
  );
  assert.equal(embedCalls, 1, 'only the first text\'s request should have been made — cancellation stops the second');
});
