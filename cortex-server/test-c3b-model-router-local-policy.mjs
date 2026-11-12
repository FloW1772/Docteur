// C3b — POST /api/model-router/run asks Root Policy (AI_LOCAL_REQUEST, module `ai`) before every local model request,
// exactly like the Companion local model already does. A denial (kill switch, lockdown, disabled `ai` module) answers
// 403 ROOT_POLICY_DENIED and the local model is never called. The dry-run decision and the cloud path are unchanged.
// Run: node --test test-c3b-model-router-local-policy.mjs
//
// Isolation: a fake Ollama client (no local runtime, no network), Root Policy loaded read-only from ./policy with an
// in-memory audit (no dataDir), no database, no server started.
import './test-setup.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelRouterRoute } from './src/routes/model-router.js';
import { initRootPolicy } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIB = 1024 ** 3;
const INSTALLED = [{ name: 'llama3.2:3b', size: 2_019_393_189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } }];
const SHOWS = { 'llama3.2:3b': { capabilities: ['completion'], model_info: { 'llama.context_length': 131_072 } } };
const HARDWARE = { gpus: [{ name: 'Test GPU', vramBytes: 8 * GIB }], totalRamBytes: 32 * GIB, freeRamBytes: 20 * GIB, freeDiskBytes: 200 * GIB, logicalCores: 8 };
const STRICT = { strict_local_mode: true, cloud_enabled: false, fallback_model: 'llama3.2:3b' };

function setup({ enforcePolicy } = {}) {
  const calls = [];
  const policyCalls = [];
  const client = {
    list: async () => ({ models: INSTALLED }), show: async ({ model }) => SHOWS[model], ps: async () => ({ models: [] }),
    chat: async (req) => { calls.push(req); return { message: { content: 'Réponse locale.' } }; },
  };
  const deps = { client, getSettings: () => STRICT, getKeys: () => ({}), getHardware: async () => HARDWARE };
  if (enforcePolicy) deps.enforcePolicy = (req) => { policyCalls.push(req); return enforcePolicy(req); };
  const app = createModelRouterRoute(deps);
  const post = (url, body) => app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { calls, policyCalls, post };
}
const denied = () => { const e = new Error('denied'); e.rootPolicyDenied = true; e.decisionCode = 'DENY_KILL_SWITCH'; throw e; };

before(() => { initRootPolicy({ policyDir: path.join(HERE, 'policy'), trustAnchors: TRUST_ANCHORS }); });

test('the real signed Root Policy allows a local run: one AI_LOCAL_REQUEST decision, one local call', async () => {
  const { calls, post } = setup();
  const res = await post('/model-router/run', { prompt: 'Bonjour.' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.text, 'Réponse locale.');
  assert.equal(calls.length, 1);
});

test('the policy request is the local-AI one (module ai, provider ollama, loopback)', async () => {
  const { policyCalls, post } = setup({ enforcePolicy: () => ({ decision: 'ALLOW' }) });
  assert.equal((await post('/model-router/run', { prompt: 'Bonjour.' })).status, 200);
  assert.equal(policyCalls.length, 1);
  assert.deepEqual(policyCalls[0], { action: 'AI_LOCAL_REQUEST', module: 'ai', trustDomain: 'AI', context: { provider: 'ollama', networkClass: 'loopback' } });
});

test('a Root Policy denial answers 403 ROOT_POLICY_DENIED and the local model is never called', async () => {
  const { calls, post } = setup({ enforcePolicy: denied });
  const res = await post('/model-router/run', { prompt: 'Bonjour.' });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'ROOT_POLICY_DENIED');
  assert.doesNotMatch(JSON.stringify(body), /DENY_KILL_SWITCH|denied/, 'no raw policy text in the answer');
  assert.equal(calls.length, 0);
});

test('the dry-run decision never asks the policy and never calls a model', async () => {
  const { calls, policyCalls, post } = setup({ enforcePolicy: denied });
  const res = await post('/model-router/route', {});
  assert.equal(res.status, 200);
  assert.equal(policyCalls.length, 0);
  assert.equal(calls.length, 0);
});

test('input validation still answers first (400) without a policy decision', async () => {
  const { policyCalls, post } = setup({ enforcePolicy: denied });
  assert.equal((await post('/model-router/run', { prompt: '' })).status, 400);
  assert.equal(policyCalls.length, 0);
});
