import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test, { before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, setRouterSettings, setImageGenSettings, setImageCloudKey } from './src/lib/sqlite.js';
import { isLoopbackEndpoint } from './src/lib/providers/comfyui.js';
import { assertImageCloudAllowed, assertImageProviderFreeAllowed, routeImageGeneration } from './src/lib/image-router.js';

const TEST_DB = './data-test-image-generation/test.db';

before(() => {
  fs.rmSync('./data-test-image-generation', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

beforeEach(() => {
  setRouterSettings({ strict_local_mode: false });
  setImageGenSettings({ comfyui_endpoint: 'http://127.0.0.1:8188', priority: 'local', free_cloud_only: true });
  setImageCloudKey('cloudflare_account_id', null);
  setImageCloudKey('cloudflare_api_token', null);
  setImageCloudKey('huggingface_token', null);
  setImageCloudKey('pollinations_key', null);
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

// ── ComfyUI endpoint classification ───────────────────────────────────────────

test('isLoopbackEndpoint: recognizes 127.0.0.1/localhost as local, rejects remote hosts', () => {
  assert.equal(isLoopbackEndpoint('http://127.0.0.1:8188'), true);
  assert.equal(isLoopbackEndpoint('http://localhost:8188'), true);
  assert.equal(isLoopbackEndpoint('http://192.168.1.50:8188'), false);
  assert.equal(isLoopbackEndpoint('http://example.com:8188'), false);
});

// ── Strict Local gate ──────────────────────────────────────────────────────────

test('assertImageCloudAllowed: blocks when strict_local_mode is on', () => {
  setRouterSettings({ strict_local_mode: true });
  const result = assertImageCloudAllowed();
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'strict_local');
});

test('assertImageCloudAllowed: allows when strict_local_mode is off', () => {
  setRouterSettings({ strict_local_mode: false });
  assert.equal(assertImageCloudAllowed().allowed, true);
});

// ── Free-only gate ─────────────────────────────────────────────────────────────

test('assertImageProviderFreeAllowed: refuses an unconfirmed provider under free-only', () => {
  const result = assertImageProviderFreeAllowed('some-payant-provider', { freeOnly: true });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'IMAGE_PROVIDER_NOT_CONFIRMED_FREE');
});

test('assertImageProviderFreeAllowed: allows a confirmed free provider under free-only', () => {
  assert.equal(assertImageProviderFreeAllowed('cloudflare', { freeOnly: true }).allowed, true);
});

test('assertImageProviderFreeAllowed: free-only off allows anything (gate not applied)', () => {
  assert.equal(assertImageProviderFreeAllowed('anything', { freeOnly: false }).allowed, true);
});

// ── Router: Strict Local forces local_only regardless of requested provider ──

test('routeImageGeneration: strict local mode routes to comfyui even if cloudflare requested, and reports 0 cloud attempts', async () => {
  setRouterSettings({ strict_local_mode: true });
  let cloudCalled = false;
  global.fetch = async (url) => {
    if (String(url).includes('127.0.0.1:8188')) {
      throw new Error('simulated: comfyui not running'); // still local, not cloud
    }
    cloudCalled = true;
    throw new Error('should never be called under strict local');
  };

  const result = await routeImageGeneration({ prompt: 'test', provider: 'cloudflare' });
  assert.equal(result.ok, false);
  assert.equal(result.providerRequested, 'comfyui');
  assert.equal(cloudCalled, false, 'no cloud network attempt should occur under Strict Local');
});

// ── Router: manual cloud provider blocked by strict local ─────────────────────

test('routeImageGeneration: manual cloud provider selection is redirected to comfyui under strict local, not to the cloud provider', async () => {
  setRouterSettings({ strict_local_mode: true });
  const result = await routeImageGeneration({ prompt: 'test', provider: 'huggingface' });
  assert.equal(result.ok, false);
  assert.equal(result.providerRequested, 'comfyui');
});

// ── Router: manual cloud provider without confirmed free status is refused ───

test('routeImageGeneration: unconfigured cloud provider fails safe (provider_unavailable), never silently uses payant', async () => {
  const result = await routeImageGeneration({ prompt: 'test', provider: 'cloudflare' });
  assert.equal(result.ok, false);
  // Not configured (no keys set in beforeEach) -> provider_unavailable, not a fabricated success
  assert.equal(result.providerRequested, 'cloudflare');
});

// ── Router: AUTO mode with local priority tries comfyui first ────────────────

test('routeImageGeneration: AUTO mode with priority=local tries comfyui before any cloud provider', async () => {
  setImageGenSettings({ priority: 'local' });
  let firstHost = null;
  global.fetch = async (url) => {
    if (firstHost === null) firstHost = new URL(String(url)).hostname;
    throw new Error('simulated network failure');
  };
  await routeImageGeneration({ prompt: 'test' });
  assert.equal(firstHost, '127.0.0.1');
});

// ── ComfyUI status: no model assumed present without real detection ──────────

test('getComfyUiStatus: server unreachable reports available:false, not a fabricated model list', async () => {
  const { getComfyUiStatus } = await import('./src/lib/providers/comfyui.js');
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const status = await getComfyUiStatus('http://127.0.0.1:8188');
  assert.equal(status.available, false);
  assert.equal(status.error, 'provider_unavailable');
});

test('getComfyUiStatus: server reachable but no checkpoints installed reports hasCompatibleModel:false', async () => {
  const { getComfyUiStatus } = await import('./src/lib/providers/comfyui.js');
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/system_stats')) {
      return new Response(JSON.stringify({ system: { comfyui_version: '1.0' }, devices: [] }), { status: 200 });
    }
    if (u.includes('/object_info/CheckpointLoaderSimple')) {
      return new Response(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const status = await getComfyUiStatus('http://127.0.0.1:8188');
  assert.equal(status.available, true);
  assert.equal(status.hasCompatibleModel, false);
});

test('generateWithComfyUi: refuses to generate when no compatible checkpoint is installed', async () => {
  const { generateWithComfyUi } = await import('./src/lib/providers/comfyui.js');
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/system_stats')) return new Response(JSON.stringify({ system: {}, devices: [] }), { status: 200 });
    if (u.includes('/object_info/CheckpointLoaderSimple')) {
      return new Response(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const result = await generateWithComfyUi({ prompt: 'test' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'model_unavailable');
});

test('generateWithComfyUi: classifies CUDA OOM history error as gpu_memory, never crashes the process', async () => {
  const { generateWithComfyUi } = await import('./src/lib/providers/comfyui.js');
  const promptId = 'fake-prompt-id';
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/system_stats')) return new Response(JSON.stringify({ system: {}, devices: [] }), { status: 200 });
    if (u.includes('/object_info/CheckpointLoaderSimple')) {
      return new Response(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model.safetensors']] } } } }), { status: 200 });
    }
    if (u.endsWith('/prompt') && opts?.method === 'POST') {
      return new Response(JSON.stringify({ prompt_id: promptId }), { status: 200 });
    }
    if (u.includes(`/history/${promptId}`)) {
      return new Response(JSON.stringify({
        [promptId]: { outputs: {}, status: { status_str: 'error', completed: false, messages: ['CUDA out of memory'] } },
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const result = await generateWithComfyUi({ prompt: 'test' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'gpu_memory');
});

// ── Route: settings never return raw secrets ──────────────────────────────────

test('image-generation settings route never returns raw key values, only configured/status booleans', async () => {
  const { createImageGenerationRoute } = await import('./src/routes/image-generation.js');
  setImageCloudKey('huggingface_token', 'hf_super_secret_value_12345');
  const app = createImageGenerationRoute({ logger: { info(){}, warn(){}, error(){} } });
  const res = await app.request('/image-generation/settings');
  const body = await res.json();
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('hf_super_secret_value_12345'), false);
  assert.equal(body.keys.huggingface_token.configured, true);
});

// ── Route: strict local blocks manual cloud provider generation over HTTP ────

test('POST /image-generation/generate: strict local forces provider_requested=comfyui for a manual cloud provider request, and never calls the cloud provider', async () => {
  const { createImageGenerationRoute } = await import('./src/routes/image-generation.js');
  setRouterSettings({ strict_local_mode: true });
  const app = createImageGenerationRoute({ logger: { info(){}, warn(){}, error(){} } });
  let cloudHostSeen = false;
  global.fetch = async (url) => {
    const hostname = new URL(String(url)).hostname;
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') cloudHostSeen = true;
    throw new Error('simulated: no comfyui running in test env');
  };
  const res = await app.request('/image-generation/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'un petit robot', provider: 'huggingface' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.provider_requested, 'comfyui');
  assert.equal(cloudHostSeen, false, 'no cloud network attempt should occur under Strict Local');
});

test('POST /image-generation/generate: missing prompt returns 400', async () => {
  const { createImageGenerationRoute } = await import('./src/routes/image-generation.js');
  const app = createImageGenerationRoute({ logger: { info(){}, warn(){}, error(){} } });
  const res = await app.request('/image-generation/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

// ── Adversarial secrets: synthetic tokens must never surface anywhere ─────────

test('adversarial secrets: synthetic cloud tokens never appear in settings GET, generate error responses, or logs', async () => {
  const { createImageGenerationRoute } = await import('./src/routes/image-generation.js');
  const CF_SECRET = 'CF_SECRET_TEST_123';
  const HF_SECRET = 'HF_SECRET_TEST_456';
  const POLL_SECRET = 'POLL_SECRET_TEST_789';
  setImageCloudKey('cloudflare_api_token', CF_SECRET);
  setImageCloudKey('huggingface_token', HF_SECRET);
  setImageCloudKey('pollinations_key', POLL_SECRET);

  const loggedPayloads = [];
  const logger = {
    info: (obj) => loggedPayloads.push(obj),
    warn: (obj) => loggedPayloads.push(obj),
    error: (obj) => loggedPayloads.push(obj),
  };
  const app = createImageGenerationRoute({ logger });

  const settingsRes = await app.request('/image-generation/settings');
  const settingsBody = await settingsRes.json();
  const settingsSerialized = JSON.stringify(settingsBody);
  assert.equal(settingsSerialized.includes(CF_SECRET), false);
  assert.equal(settingsSerialized.includes(HF_SECRET), false);
  assert.equal(settingsSerialized.includes(POLL_SECRET), false);

  setRouterSettings({ strict_local_mode: true });
  global.fetch = async () => { throw new Error('simulated: no comfyui running'); };
  const genRes = await app.request('/image-generation/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'test', provider: 'huggingface' }),
  });
  const genBody = await genRes.json();
  const genSerialized = JSON.stringify(genBody);
  assert.equal(genSerialized.includes(CF_SECRET), false);
  assert.equal(genSerialized.includes(HF_SECRET), false);
  assert.equal(genSerialized.includes(POLL_SECRET), false);

  const logSerialized = JSON.stringify(loggedPayloads);
  assert.equal(logSerialized.includes(CF_SECRET), false);
  assert.equal(logSerialized.includes(HF_SECRET), false);
  assert.equal(logSerialized.includes(POLL_SECRET), false);
});

test('POST /image-generation/keys/:id: rejects an unknown key id without storing anything', async () => {
  const { createImageGenerationRoute } = await import('./src/routes/image-generation.js');
  const app = createImageGenerationRoute({ logger: { info(){}, warn(){}, error(){} } });
  const res = await app.request('/image-generation/keys/not_a_real_provider_key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'CF_SECRET_TEST_123' }),
  });
  assert.equal(res.status, 400);
});

// ── ComfyUI install/lifecycle routes ──────────────────────────────────────────

test('GET /image-generation/comfyui/install: reports not_installed by default', async () => {
  const { createImageGenerationRoute } = await import('./src/routes/image-generation.js');
  const { setMeta } = await import('./src/lib/sqlite.js');
  setMeta('comfyui_install', {});
  const app = createImageGenerationRoute({ logger: { info(){}, warn(){}, error(){} } });
  const res = await app.request('/image-generation/comfyui/install');
  const body = await res.json();
  assert.equal(body.install.status, 'not_installed');
});

test('POST /image-generation/comfyui/install: rejects a dangerous destination via the HTTP layer too', async () => {
  const { createImageGenerationRoute } = await import('./src/routes/image-generation.js');
  const { setMeta } = await import('./src/lib/sqlite.js');
  setMeta('comfyui_install', {});
  const app = createImageGenerationRoute({ logger: { info(){}, warn(){}, error(){} } });
  const res = await app.request('/image-generation/comfyui/install', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination: 'C:\\Windows' }),
  });
  assert.equal(res.status, 400);
});

test('POST /image-generation/models/download: rejects a non-catalog model id via HTTP', async () => {
  const { createImageGenerationRoute } = await import('./src/routes/image-generation.js');
  const app = createImageGenerationRoute({ logger: { info(){}, warn(){}, error(){} } });
  const res = await app.request('/image-generation/models/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'unlisted-model' }),
  });
  assert.equal(res.status, 400);
});
