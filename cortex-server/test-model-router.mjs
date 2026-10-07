// Model Router V1 — registry, deterministic routing, Strict Local, cloud opt-in, no silent
// local → cloud fallback, low-VRAM facts, failure classification. Fake runtime fixtures only:
// no real Ollama, no network, no model download, no real database.
import './test-setup.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSqlite, setRouterSettings, setCloudKey } from './src/lib/sqlite.js';
import { runAiTask } from './src/lib/router.js';
import { _resetAllForTests } from './src/lib/provider-state.js';
import {
  CAPABILITIES, PENDING_IDENTITY_TARGETS, buildRegistry, selectRoute, executeRoute, classifyModelError,
  validateRuntimeOptions, collectOllamaInventory, collectCloudProviders, isCloudTag, capabilitiesFromRuntime,
} from './src/lib/model-router.js';
import { createModelRouterRoute } from './src/routes/model-router.js';

initSqlite(':memory:');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIB = 1_073_741_824;

// ── Fixtures: what a real Ollama returns for /api/tags, /api/show, /api/ps ────
const INSTALLED = [
  { name: 'llama3.2:3b', size: 2_019_393_189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
  { name: 'llava:7b', size: 4_733_363_377, details: { family: 'llama', parameter_size: '7B', quantization_level: 'Q4_0' } },
  { name: 'nomic-embed-text:latest', size: 274_302_450, details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' } },
  { name: 'qwen2.5:14b-instruct-q3_K_M', size: 7_339_204_710, details: { family: 'qwen2', parameter_size: '14.8B', quantization_level: 'Q3_K_M' } },
  { name: 'mystery:latest', size: 1_000_000_000 },
  { name: 'gpt-oss:20b-cloud', details: { remote_host: 'https://ollama.com:443' } },
  { name: 'qwen3.5:4b', size: Math.round(3.4 * GIB), details: {} },
];
const SHOWS = {
  'llama3.2:3b': { capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 131_072 }, parameters: 'num_gpu 20\nstop "<|eot_id|>"' },
  'llava:7b': { capabilities: ['completion', 'vision'], model_info: { 'llama.context_length': 4_096 } },
  'nomic-embed-text:latest': { capabilities: ['embedding'], model_info: { 'nomic-bert.context_length': 2_048 } },
  'qwen2.5:14b-instruct-q3_K_M': { capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32_768 } },
  'mystery:latest': null,
  'gpt-oss:20b-cloud': { capabilities: ['completion', 'tools'] },
  'qwen3.5:4b': null,
};
const LOADED = [{ name: 'llama3.2:3b', size: 3_000_000_000, size_vram: 2_000_000_000 }];
const HARDWARE = { gpus: [{ name: 'Test GPU', vramBytes: 8 * GIB }], totalRamBytes: 32 * GIB, freeRamBytes: 20 * GIB, freeDiskBytes: 200 * GIB, logicalCores: 8 };
const STRICT = { strict_local_mode: true, cloud_enabled: false, chat_model: 'mistral-nemo:12b-instruct-2407-q4_K_M', powerful_model: 'qwen2.5:14b-instruct-q3_K_M', fallback_model: 'llama3.2:3b' };
const CLOUD_ON = { ...STRICT, strict_local_mode: false, cloud_enabled: true };
const runtimeUp = (installed = INSTALLED) => ({ reachable: true, installed, shows: SHOWS, loaded: LOADED });
// What collectOllamaInventory really returns when Ollama is stopped: nothing can be listed.
const runtimeDown = { reachable: false, error: 'ECONNREFUSED', installed: [], shows: {}, loaded: [] };
const CLOUD = [{ providerId: 'gemini', paid: false }, { providerId: 'groq', paid: false }];
const reg = (settings = STRICT, runtime = runtimeUp(), cloud = null) => buildRegistry({ runtime, hardware: HARDWARE, settings, cloud });
const model = (registry, name) => registry.models.find(m => m.name === name);

beforeEach(() => _resetAllForTests());

// ── Registry ──────────────────────────────────────────────────────────────────

test('registry: runtime facts with their source; nothing invented when unknown', () => {
  const r = reg();
  const llama = model(r, 'llama3.2:3b');
  assert.deepEqual(llama.capabilities.sort(), ['LONG_CONTEXT', 'STRUCTURED_OUTPUT', 'TEXT', 'TOOL_USE']);
  assert.equal(llama.capabilitiesSource, 'runtime');
  assert.deepEqual(llama.contextLength, { value: 131_072, source: 'runtime' });
  assert.deepEqual(llama.lowVram.quantization, { value: 'Q4_K_M', source: 'runtime' });
  assert.deepEqual(llama.lowVram.sizeBytes, { value: 2_019_393_189, source: 'runtime' });
  assert.deepEqual(llama.lowVram.gpuLayers, { value: 20, source: 'runtime' }, 'num_gpu only when the model parameters set it');
  assert.deepEqual(llama.lowVram.loaded, { sizeBytes: 3_000_000_000, vramBytes: 2_000_000_000, ramOffloadBytes: 1_000_000_000 }, 'real offload from /api/ps');
  const llava = model(r, 'llava:7b');
  assert.deepEqual(llava.lowVram.gpuLayers, { value: null, source: 'unknown' });
  assert.equal(llava.lowVram.loaded, null);
  assert.ok(llava.capabilities.includes('VISION') && !llava.capabilities.includes('LONG_CONTEXT'));
  assert.deepEqual(model(r, 'nomic-embed-text:latest').capabilities, ['EMBEDDING'], 'an embedding model cannot chat');
  const mystery = model(r, 'mystery:latest');
  assert.equal(mystery.capabilitiesKnown, false);
  assert.deepEqual(mystery.capabilities, []);
  assert.deepEqual(mystery.lowVram.quantization, { value: null, source: 'unknown' }, 'no quantization guessed from the tag');
  assert.deepEqual(mystery.contextLength, { value: null, source: 'unknown' });
  assert.equal(mystery.lowVram.fit, null);
});

test('registry: catalog facts and hardware fit only for catalogued distributions; -cloud tags are CLOUD', () => {
  const r = reg();
  const q35 = model(r, 'qwen3.5:4b');
  assert.equal(q35.capabilitiesSource, 'catalog', 'no runtime capabilities → official catalog');
  assert.ok(q35.capabilities.includes('VISION'));
  assert.equal(q35.catalog.license, null, 'license stays UNKNOWN — never invented');
  assert.equal(q35.lowVram.fit.source, 'local-model-fit');
  assert.ok(['EXCELLENT', 'GOOD', 'TIGHT', 'NOT_RECOMMENDED', 'UNKNOWN'].includes(q35.lowVram.fit.rating));
  assert.equal(model(r, 'llama3.2:3b').lowVram.fit, null, 'not catalogued → no fit estimate');
  const cloudTag = model(r, 'gpt-oss:20b-cloud');
  assert.equal(cloudTag.location, 'CLOUD');
  assert.equal(cloudTag.available, false, 'an Ollama cloud tag is never available under Strict Local');
  assert.ok(isCloudTag('model:cloud') && isCloudTag('x-cloud:latest') && !isCloudTag('qwen2.5:7b'));
  assert.deepEqual(capabilitiesFromRuntime(undefined), null);
  assert.deepEqual(r.hardware, { gpus: [{ name: 'Test GPU', vramBytes: 8 * GIB }], totalVramBytes: 8 * GIB, ramBytes: 32 * GIB });
});

test('registry: providers, Strict Local, cloud opt-in, pending identities', () => {
  const strict = reg();
  assert.equal(strict.providers.find(p => p.id === 'ollama').status, 'AVAILABLE');
  for (const id of ['gemini', 'groq', 'anthropic', 'openai', 'codex']) assert.equal(strict.providers.find(p => p.id === id).status, 'DISABLED_BY_STRICT_LOCAL');
  assert.equal(strict.providers.find(p => p.id === 'comfyui').kind, 'image');
  assert.equal(strict.providers.find(p => p.id === 'pollinations-image').status, 'DISABLED_BY_STRICT_LOCAL');
  const off = reg({ ...STRICT, strict_local_mode: false, cloud_enabled: false });
  assert.equal(off.providers.find(p => p.id === 'gemini').status, 'CLOUD_DISABLED', 'cloud requires an explicit opt-in');
  const on = reg(CLOUD_ON, runtimeUp(), CLOUD);
  assert.equal(on.providers.find(p => p.id === 'gemini').status, 'AVAILABLE');
  assert.equal(on.providers.find(p => p.id === 'openai').status, 'NOT_CONFIGURED');
  assert.equal(reg(STRICT, runtimeDown).providers.find(p => p.id === 'ollama').status, 'RUNTIME_UNAVAILABLE');
  assert.deepEqual(PENDING_IDENTITY_TARGETS.map(t => t.status), ['MODEL_IDENTITY_REQUIRED', 'MODEL_IDENTITY_REQUIRED']);
  assert.deepEqual(strict.pendingIdentity, PENDING_IDENTITY_TARGETS);
  assert.ok(!JSON.stringify(strict).toLowerCase().includes('kolibri":{'), 'Kolibri is never registered as a model');
});

test('cloud providers are not probed under Strict Local or without opt-in', async () => {
  assert.equal(await collectCloudProviders({ keys: { gemini_key: 'x' }, settings: STRICT }), null);
  assert.equal(await collectCloudProviders({ keys: { gemini_key: 'x' }, settings: { strict_local_mode: false, cloud_enabled: false } }), null);
});

// ── Routing ───────────────────────────────────────────────────────────────────

test('AUTO capability routing picks the right local model (preference, then fit, then id)', () => {
  const r = reg();
  const pick = (caps) => selectRoute(r, { capabilities: caps, settings: STRICT });
  assert.equal(pick(['TEXT']).decision.model, 'qwen2.5:14b-instruct-q3_K_M', 'configured powerful_model preferred (chat_model not installed)');
  assert.equal(pick(['VISION']).decision.model, 'llava:7b');
  assert.equal(pick(['EMBEDDING']).decision.model, 'nomic-embed-text:latest');
  assert.equal(pick(['TEXT', 'LONG_CONTEXT', 'TOOL_USE']).decision.model, 'qwen2.5:14b-instruct-q3_K_M');
  assert.equal(pick(['TEXT', 'VISION', 'TOOL_USE']).ok, false, 'no model claims both');
  const audio = pick(['AUDIO']);
  assert.equal(audio.ok, false);
  assert.equal(audio.error.code, 'NO_MODEL_FOR_CAPABILITIES');
  assert.ok(pick(['TEXT']).rejected.some(x => x.id === 'ollama:mystery:latest' && x.reason === 'CAPABILITIES_UNKNOWN'), 'unknown capabilities never chosen by AUTO');
  assert.ok(pick(['TEXT']).rejected.some(x => x.id === 'ollama:nomic-embed-text:latest' && x.reason.startsWith('MISSING:')));
  assert.throws(() => pick(['TELEPATHY']), (e) => e.code === 'UNKNOWN_CAPABILITY');
  assert.deepEqual([...CAPABILITIES], ['TEXT', 'VISION', 'AUDIO', 'EMBEDDING', 'TOOL_USE', 'STRUCTURED_OUTPUT', 'IMAGE_GENERATION', 'LONG_CONTEXT']);
});

test('AUTO is deterministic: same inputs (any order) → same decision', () => {
  const first = JSON.stringify(selectRoute(reg(), { capabilities: ['TEXT'], settings: STRICT }).decision);
  for (let i = 0; i < 25; i += 1) {
    const shuffled = [...INSTALLED].sort(() => Math.random() - 0.5);
    assert.equal(JSON.stringify(selectRoute(reg(STRICT, runtimeUp(shuffled)), { capabilities: ['TEXT'], settings: STRICT }).decision), first);
  }
});

test('Strict Local: the cloud is never chosen, even when it is the only provider with the capability', () => {
  const noVisionLocally = runtimeUp(INSTALLED.filter(m => m.name !== 'llava:7b' && m.name !== 'qwen3.5:4b'));
  const strictWithCloud = buildRegistry({ runtime: noVisionLocally, hardware: HARDWARE, settings: STRICT, cloud: CLOUD });
  const r = selectRoute(strictWithCloud, { capabilities: ['VISION'], settings: STRICT });
  assert.equal(r.ok, false);
  assert.ok(r.rejected.filter(x => x.id.startsWith('gemini')).every(x => x.reason === 'DISABLED_BY_STRICT_LOCAL'));
  const manual = selectRoute(strictWithCloud, { mode: 'manual', provider: 'gemini', model: 'gemini:default', capabilities: ['TEXT'], settings: STRICT });
  assert.equal(manual.error.code, 'STRICT_LOCAL_BLOCKS_CLOUD');
  const cloudTag = selectRoute(reg(), { mode: 'manual', provider: 'ollama', model: 'gpt-oss:20b-cloud', settings: STRICT });
  assert.equal(cloudTag.error.code, 'STRICT_LOCAL_BLOCKS_CLOUD', 'an Ollama -cloud tag is cloud');
});

test('cloud opt-in: AUTO uses the cloud only for a capability no local model has', () => {
  const noVisionLocally = runtimeUp(INSTALLED.filter(m => m.name !== 'llava:7b' && m.name !== 'qwen3.5:4b'));
  const on = buildRegistry({ runtime: noVisionLocally, hardware: HARDWARE, settings: CLOUD_ON, cloud: CLOUD });
  const vision = selectRoute(on, { capabilities: ['VISION'], settings: CLOUD_ON });
  assert.equal(vision.decision.provider, 'gemini');
  assert.match(vision.decision.reason, /aucun modèle local/);
  assert.equal(selectRoute(on, { capabilities: ['TEXT'], settings: CLOUD_ON }).decision.location, 'LOCAL', 'local stays preferred when it can do the task');
  assert.equal(selectRoute(on, { capabilities: ['VISION'], settings: CLOUD_ON, allowCloud: false }).ok, false, 'caller can forbid cloud');
  const off = buildRegistry({ runtime: noVisionLocally, hardware: HARDWARE, settings: { ...CLOUD_ON, cloud_enabled: false }, cloud: CLOUD });
  assert.equal(selectRoute(off, { mode: 'manual', provider: 'gemini', model: 'gemini:default', settings: off }).error.code, 'CLOUD_DISABLED');
});

test('NO silent local → cloud: runtime stopped → reported, never replaced by the cloud (even for VISION, cloud on)', () => {
  const down = buildRegistry({ runtime: runtimeDown, hardware: HARDWARE, settings: CLOUD_ON, cloud: CLOUD });
  for (const caps of [['TEXT'], ['VISION']]) {
    const r = selectRoute(down, { capabilities: caps, settings: CLOUD_ON });
    assert.equal(r.ok, false, caps.join());
    assert.equal(r.error.code, 'RUNTIME_UNAVAILABLE');
    assert.match(r.error.hint, /explicitement un provider cloud/);
  }
  const strictDown = selectRoute(buildRegistry({ runtime: runtimeDown, hardware: HARDWARE, settings: STRICT }), { capabilities: ['TEXT'], settings: STRICT });
  assert.match(strictDown.error.hint, /n’envoie jamais au cloud/);
  // A stopped runtime with a capable model also never yields to the cloud (model listed, provider down).
  const listedButDown = buildRegistry({ runtime: { ...runtimeUp(), reachable: false, error: 'x' }, hardware: HARDWARE, settings: CLOUD_ON, cloud: CLOUD });
  assert.equal(selectRoute(listedButDown, { capabilities: ['TEXT'], settings: CLOUD_ON }).error.code, 'RUNTIME_UNAVAILABLE');
  // Explicit manual cloud choice stays possible (opt-in).
  assert.equal(selectRoute(down, { mode: 'manual', provider: 'gemini', model: 'gemini:default', settings: CLOUD_ON }).decision.provider, 'gemini');
});

test('manual selection: exactly the chosen model, never substituted', () => {
  const r = reg();
  const ok = selectRoute(r, { mode: 'manual', provider: 'ollama', model: 'llama3.2:3b', capabilities: ['TEXT'], settings: STRICT });
  assert.equal(ok.decision.model, 'llama3.2:3b', 'manual wins over the preference order');
  assert.equal(ok.decision.reason, 'sélection manuelle');
  const absent = selectRoute(r, { mode: 'manual', provider: 'ollama', model: 'qwen2.5:72b', settings: STRICT });
  assert.equal(absent.error.code, 'MODEL_NOT_INSTALLED');
  assert.match(absent.error.hint, /ne télécharge jamais/);
  assert.equal(selectRoute(r, { mode: 'manual', provider: 'ollama', model: 'nomic-embed-text:latest', capabilities: ['TEXT'], settings: STRICT }).error.code, 'CAPABILITY_UNSUPPORTED');
  const unknown = selectRoute(r, { mode: 'manual', provider: 'ollama', model: 'mystery:latest', settings: STRICT });
  assert.equal(unknown.ok, true);
  assert.match(unknown.warnings[0], /non vérifiées/);
  assert.equal(selectRoute(reg(STRICT, runtimeDown), { mode: 'manual', provider: 'ollama', model: 'llama3.2:3b', settings: STRICT }).error.code, 'RUNTIME_UNAVAILABLE');
  assert.equal(selectRoute(r, { mode: 'manual', provider: 'nope', model: 'x', settings: STRICT }).error.code, 'PROVIDER_NOT_FOUND');
  assert.equal(selectRoute(r, { mode: 'manual', provider: 'ollama', settings: STRICT }).error.code, 'MANUAL_SELECTION_INCOMPLETE');
});

// ── Execution and failures ────────────────────────────────────────────────────

const route = (name = 'llama3.2:3b') => selectRoute(reg(), { mode: 'manual', provider: 'ollama', model: name, settings: STRICT });
function fakeClient(behaviour) {
  const calls = [];
  return { calls, chat: async (req) => { calls.push(req); return behaviour(req); } };
}

test('execution: exactly one call on the decided route; runtime options validated and passed', async () => {
  const client = fakeClient(() => ({ message: { content: 'Bonjour.' } }));
  let cloudCalls = 0;
  const out = await executeRoute(route(), { messages: [{ role: 'user', content: 'Salut' }], runtimeOptions: { num_ctx: 8_192, num_gpu: 12 }, registry: reg() }, { client, cloudCall: async () => { cloudCalls += 1; return 'x'; } });
  assert.equal(out.text, 'Bonjour.');
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, 'llama3.2:3b');
  assert.equal(client.calls[0].options.num_ctx, 8_192);
  assert.equal(client.calls[0].options.num_gpu, 12);
  assert.equal(client.calls[0].options.temperature, 0.2, 'existing defaults kept');
  assert.equal(cloudCalls, 0);
  assert.throws(() => validateRuntimeOptions({ num_ctx: 200_000 }, { contextLength: 131_072 }), (e) => e.code === 'INVALID_RUNTIME_OPTIONS', 'num_ctx bounded by the real context length');
  assert.throws(() => validateRuntimeOptions({ num_thread: 4 }), (e) => e.code === 'INVALID_RUNTIME_OPTIONS');
  await assert.rejects(executeRoute(route(), { messages: [], runtimeOptions: { num_gpu: -1 }, registry: reg() }, { client }), (e) => e.code === 'INVALID_RUNTIME_OPTIONS');
  assert.equal(client.calls.length, 1, 'invalid options never reach the runtime');
  const json = await executeRoute(route(), { messages: [], responseFormat: 'json', registry: reg() }, { client: fakeClient((req) => ({ message: { content: req.format === 'json' ? '{"ok":true}' : 'x' } })) });
  assert.deepEqual(json.json, { ok: true });
});

test('failures: model absent, runtime stopped, OOM, timeout, invalid response, cloud disabled — clear codes, no retry elsewhere', async () => {
  const cases = [
    ['MODEL_NOT_FOUND', () => { throw new Error('model "llama3.2:3b" not found, try pulling it first'); }],
    ['RUNTIME_UNAVAILABLE', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }],
    ['OUT_OF_MEMORY', () => { throw new Error('llama runner process has terminated: error loading model: cudaMalloc failed: out of memory'); }],
    ['INVALID_RESPONSE', () => ({ message: { content: '   ' } })],
  ];
  for (const [code, behaviour] of cases) {
    const client = fakeClient(behaviour);
    await assert.rejects(executeRoute(route(), { messages: [], registry: reg() }, { client }), (e) => e.code === code && typeof e.message === 'string' && e.message.length > 0, code);
    assert.equal(client.calls.length, 1, `${code}: no retry`);
  }
  await assert.rejects(executeRoute(route(), { messages: [], responseFormat: 'json', registry: reg() }, { client: fakeClient(() => ({ message: { content: 'pas du json' } })) }), (e) => e.code === 'INVALID_RESPONSE' && /JSON/.test(e.message));
  const started = Date.now();
  await assert.rejects(executeRoute(route(), { messages: [], timeoutMs: 1_000, registry: reg() }, { client: fakeClient(() => new Promise(() => {})) }), (e) => e.code === 'TIMEOUT');
  assert.ok(Date.now() - started < 3_000);
  const blocked = selectRoute(reg({ ...STRICT, strict_local_mode: false, cloud_enabled: false }), { mode: 'manual', provider: 'groq', model: 'groq:default', settings: STRICT });
  await assert.rejects(executeRoute(blocked, { messages: [] }, { client: fakeClient(() => ({ message: { content: 'x' } })) }), (e) => e.code === 'CLOUD_DISABLED');
  assert.equal(classifyModelError(new Error('CUDA error: out of memory')).code, 'OUT_OF_MEMORY');
  assert.equal(classifyModelError(new Error('model requires more system memory (12.1 GiB) than is available')).code, 'OUT_OF_MEMORY');
  assert.equal(classifyModelError(Object.assign(new Error('x'), { name: 'TimeoutError' })).code, 'TIMEOUT');
  assert.equal(classifyModelError(new Error('connect ECONNREFUSED 127.0.0.1:11434')).code, 'RUNTIME_UNAVAILABLE');
});

test('runtime inventory: unreachable runtime reported, never thrown; nothing is pulled', async () => {
  const down = await collectOllamaInventory({ list: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); } });
  assert.equal(down.reachable, false);
  assert.match(down.error, /\(Ollama\) ne répond pas/);
  const calls = [];
  const up = await collectOllamaInventory({
    list: async () => { calls.push('list'); return { models: INSTALLED.slice(0, 2) }; },
    show: async ({ model }) => { calls.push(`show:${model}`); return SHOWS[model]; },
    ps: async () => { calls.push('ps'); return { models: LOADED }; },
    pull: async () => { calls.push('pull'); throw new Error('must never be called'); },
  });
  assert.equal(up.reachable, true);
  assert.deepEqual(calls, ['list', 'show:llama3.2:3b', 'show:llava:7b', 'ps']);
});

// ── runAiTask (existing facade): no more silent local → cloud fallback ─────────

test('runAiTask: a failing local model is reported — no cloud call even with cloud enabled and configured', async () => {
  setCloudKey('groq', 'gsk_test_model_router');
  setRouterSettings({ strict_local_mode: false, cloud_enabled: true, paying_apis_enabled: false });
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 500 }); };
  try {
    for (const preferredProvider of [null, 'local']) {
      await assert.rejects(runAiTask({
        feature: 'model_router_test', taskType: 'test', preferredProvider, messages: [{ role: 'user', content: 'x' }],
        client: { chat: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); } },
        installedNames: ['llama3.2:3b'], logger: { info() {}, warn() {} },
      }), /ECONNREFUSED/);
    }
    assert.equal(fetchCalls, 0, 'no cloud request after a local failure');
  } finally {
    globalThis.fetch = realFetch;
    setCloudKey('groq', '');
  }
});

// ── HTTP route ────────────────────────────────────────────────────────────────

test('route: registry, dry-run decision and a single run with clear errors', async () => {
  let settings = STRICT;
  const chat = fakeClient((req) => (req.model === 'llava:7b' ? { message: { content: 'Je vois un phare.' } } : { message: { content: 'Réponse.' } }));
  const client = {
    list: async () => ({ models: INSTALLED }), show: async ({ model: m }) => SHOWS[m], ps: async () => ({ models: LOADED }), chat: chat.chat,
  };
  const app = createModelRouterRoute({ client, getSettings: () => settings, getKeys: () => ({}), getHardware: async () => HARDWARE });
  const call = (method, url, body) => app.request(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const registry = await (await call('GET', '/model-router/registry')).json();
  assert.equal(registry.ok, true);
  assert.equal(registry.strictLocal, true);
  assert.equal(registry.models.find(m => m.name === 'llama3.2:3b').lowVram.quantization.value, 'Q4_K_M');
  assert.deepEqual(registry.pendingIdentity.map(t => t.status), ['MODEL_IDENTITY_REQUIRED', 'MODEL_IDENTITY_REQUIRED']);
  const dry = await (await call('POST', '/model-router/route', { capabilities: ['VISION'] })).json();
  assert.equal(dry.decision.model, 'llava:7b');
  assert.equal(chat.calls.length, 0, 'dry run never calls a model');
  const ran = await (await call('POST', '/model-router/run', { capabilities: ['VISION'], prompt: 'Décris.' })).json();
  assert.equal(ran.result.text, 'Je vois un phare.');
  assert.equal(chat.calls.length, 1);
  const bad = await call('POST', '/model-router/run', { mode: 'manual', provider: 'ollama', model: 'absent:1b', prompt: 'x' });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, 'MODEL_NOT_INSTALLED');
  assert.equal((await call('POST', '/model-router/run', { prompt: '' })).status, 400);
  assert.equal((await call('POST', '/model-router/run', { prompt: 'x'.repeat(4_001) })).status, 400);
  assert.equal((await call('POST', '/model-router/route', { capabilities: ['TELEPATHY'] })).status, 400);
  settings = { ...STRICT, strict_local_mode: false, cloud_enabled: false };
  const cloudBlocked = await (await call('POST', '/model-router/route', { mode: 'manual', provider: 'gemini', model: 'gemini:default' })).json();
  assert.equal(cloudBlocked.error.code, 'CLOUD_DISABLED');
  assert.equal(chat.calls.length, 1, 'refused routes never reach a model');
});

// ── Static audit ──────────────────────────────────────────────────────────────

test('static audit: no download, no process, no network of its own; reuses router.js', () => {
  for (const file of ['src/lib/model-router.js', 'src/routes/model-router.js']) {
    const src = fs.readFileSync(path.join(HERE, file), 'utf8');
    assert.doesNotMatch(src, /\.pull\(|\/api\/pull|\.create\(|child_process|\bspawn\(|\bexec\(|\bfetch\(/, `${file}`);
  }
  const lib = fs.readFileSync(path.join(HERE, 'src/lib/model-router.js'), 'utf8');
  assert.match(lib, /import \{ TASK_CAPABILITIES, CLOUD_PROVIDER_IDS, cloudCandidates \} from '\.\/router\.js'/, 'cloud configuration comes from router.js, not duplicated');
  assert.doesNotMatch(lib, /kolibri['"]?\s*:/i, 'Kolibri never declared as a supported model');
});
