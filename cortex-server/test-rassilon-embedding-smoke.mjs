// Real local embedding smoke test (mission §50 Phase 3): only runs
// against an ACTUAL local Ollama instance if one is already reachable AND
// already has an allowlisted embedding model installed. Never downloads,
// pulls, or installs anything, and never changes any config. If no
// provider/model is available, every test in this file reports NOT_RUN
// (via test.skip) — this is explicitly NOT a failure per the mission
// ("Si aucun modèle disponible : NOT_RUN et ce n'est pas un FAIL").
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaClient, verifyModelAvailability } from './src/lib/ollama.js';
import { executeEmbeddingBatch } from './src/lib/rassilon-embedding.js';
import { EMBEDDING_MODEL_ALLOWLIST } from './src/lib/rassilon-job-schema.js';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const PROBE_TIMEOUT_MS = 3_000;

async function probeOllamaReachable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

const ollamaReachable = await probeOllamaReachable();
const client = ollamaReachable ? createOllamaClient(OLLAMA_URL) : null;

let availableModel = null;
if (client) {
  for (const model of EMBEDDING_MODEL_ALLOWLIST) {
    try {
      if (await verifyModelAvailability(client, model)) { availableModel = model; break; }
    } catch { /* treat as unavailable, keep checking the rest of the allowlist */ }
  }
}

const canRunSmoke = ollamaReachable && availableModel !== null;

test('real local embedding smoke test — 2 neutral texts through the actual local Ollama provider', { skip: !canRunSmoke ? 'NOT_RUN: no local Ollama instance reachable with an allowlisted embedding model installed (mission §50 — this is not a failure)' : false }, async () => {
  const result = await executeEmbeddingBatch(
    { texts: ['the quick brown fox', 'a neutral test sentence'], model: availableModel },
    { ollamaClient: client },
  );
  assert.equal(result.vectorCount, 2);
  assert.ok(result.dimensions > 0);
  assert.ok(Array.isArray(result.vectors[0]));
  assert.ok(result.vectors[0].every(n => typeof n === 'number' && Number.isFinite(n)));
});

if (!canRunSmoke) {
  console.log(`[test-rassilon-embedding-smoke] NOT_RUN — ${ollamaReachable ? 'Ollama reachable but no allowlisted model installed' : 'Ollama not reachable at ' + OLLAMA_URL}. This is expected/acceptable, not a failure (mission §50).`);
}
