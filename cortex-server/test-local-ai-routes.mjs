import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createLocalAiRoute } from './src/routes/local-ai.js';

const GIB = 1_073_741_824;

// A generous, deterministic mock profile so fit-dependent tests never
// depend on the real CI runner's RAM/VRAM/disk (mission §41).
const STRONG_MOCK_PROFILE = Object.freeze({
  platform: 'win32', arch: 'x64', cpuModel: 'Mock CPU', logicalCores: 16,
  totalRamBytes: 64 * GIB, freeRamBytes: 48 * GIB,
  gpus: [{ name: 'Mock GPU', vendor: 'NVIDIA', vramBytes: 24 * GIB, source: 'wmi' }],
  freeDiskBytes: 500 * GIB, osVersion: '10.0.19045', detectedAt: new Date().toISOString(),
});

function buildApp(servicesOverrides = {}) {
  const app = new Hono();
  const services = {
    ollamaUrl: 'http://localhost:11434',
    detectLocalHardwareProfile: async () => STRONG_MOCK_PROFILE,
    ...servicesOverrides,
  };
  app.route('/api', createLocalAiRoute({ services }));
  return app;
}

async function json(app, path, init) {
  const res = await app.request(path, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// Stub global fetch so tests never hit a real Ollama instance or the network.
const originalFetch = global.fetch;
function stubOllamaFetch({ tagsResponse = { models: [] }, tagsOk = true } = {}) {
  global.fetch = async (url) => {
    if (String(url).includes('/api/tags')) {
      return {
        ok: tagsOk,
        json: async () => tagsResponse,
      };
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('GET /api/local-ai/catalog returns the static catalog with zero network calls', async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/catalog');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.models));
  assert.ok(Array.isArray(body.distributions));
  assert.ok(body.meta.catalogVersion);
  assert.equal(fetchCalled, false);
});

test('GET /api/local-ai/hardware returns a profile shape without crashing', async () => {
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/hardware');
  assert.equal(status, 200);
  assert.ok(body.profile);
  assert.equal(typeof body.profile.platform, 'string');
  assert.ok(Array.isArray(body.profile.gpus));
});

test('GET /api/local-ai/recommendations respects a ~6-card default expectation at the data layer (capability filter narrows results)', async () => {
  stubOllamaFetch();
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/recommendations?capability=CODING');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.results));
  assert.ok(body.results.every((r) => r.model.useCaseTags.includes('CODING')));
});

test('GET /api/local-ai/recommendations excludes cloud distributions by default', async () => {
  stubOllamaFetch();
  const app = buildApp();
  const { body } = await json(app, '/api/local-ai/recommendations');
  assert.ok(body.results.every((r) => r.distribution.executionLocation === 'LOCAL'));
});

test('GET /api/local-ai/recommendations marks installed:true only when Ollama actually reports the model', async () => {
  stubOllamaFetch({ tagsResponse: { models: [{ name: 'qwen3.8:27b' }] } });
  const app = buildApp();
  const { body } = await json(app, '/api/local-ai/recommendations');
  const qwen = body.results.find((r) => r.distribution.ollamaPullName === 'qwen3.8:27b');
  assert.ok(qwen);
  assert.equal(qwen.installed, true);
  const others = body.results.filter((r) => r.distribution.ollamaPullName !== 'qwen3.8:27b');
  assert.ok(others.every((r) => r.installed === false));
});

test('GET /api/local-ai/recommendations degrades gracefully when Ollama is unreachable (empty installed list, not a crash)', async () => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/recommendations');
  assert.equal(status, 200);
  assert.ok(body.results.every((r) => r.installed === false));
});

test('GET /api/local-ai/installed reflects real Ollama state, not catalog assumptions', async () => {
  stubOllamaFetch({ tagsResponse: { models: [{ name: 'gpt-oss:20b' }] } });
  const app = buildApp();
  const { body } = await json(app, '/api/local-ai/installed');
  assert.deepEqual(body.installedOllamaModels, ['gpt-oss:20b']);
  assert.ok(body.matchedCatalogDistributions.some((d) => d.ollamaPullName === 'gpt-oss:20b'));
});

test('empty catalog / no installed models -> empty but well-formed response', async () => {
  stubOllamaFetch({ tagsResponse: { models: [] } });
  const app = buildApp();
  const { body } = await json(app, '/api/local-ai/installed');
  assert.deepEqual(body.installedOllamaModels, []);
  assert.deepEqual(body.matchedCatalogDistributions, []);
});

// ---- install-preview: the trust boundary ----

test('install-preview: verified local distribution returns ok:true with the exact pull name', async () => {
  stubOllamaFetch();
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/install-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributionId: 'qwen3.8-27b-ollama' }),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.verifiedOllamaPullName, 'qwen3.8:27b');
});

test('install-preview: unverified distribution is blocked', async () => {
  stubOllamaFetch();
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/install-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributionId: 'devstral-small-2-ollama' }), // verified:false in seed catalog
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /not been individually verified/);
});

test('install-preview: cloud distribution is blocked', async () => {
  stubOllamaFetch();
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/install-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributionId: 'gpt-oss-20b-cloud-ollama' }),
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /cloud/i);
});

test('install-preview: unknown/malformed distribution id is blocked', async () => {
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/install-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributionId: 'does-not-exist' }),
  });
  assert.equal(status, 404);
  assert.equal(body.ok, false);
});

test('install-preview: client cannot override verified:false by sending an arbitrary pull name — only distributionId is accepted', async () => {
  stubOllamaFetch();
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/install-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      distributionId: 'devstral-small-2-ollama',
      // Attempted injection: even if a client adds these fields, the route
      // never reads them — it only trusts its own server-side lookup.
      verified: true,
      ollamaPullName: 'some-other-model:latest',
    }),
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

test('install-preview: NOT_RECOMMENDED fit is blocked from the preview, deterministically (tiny mock machine)', async () => {
  stubOllamaFetch();
  const app = buildApp({
    detectLocalHardwareProfile: async () => ({
      platform: 'win32', arch: 'x64', cpuModel: 'Mock CPU', logicalCores: 4,
      totalRamBytes: 8 * GIB, freeRamBytes: 6 * GIB,
      gpus: [], freeDiskBytes: 500 * GIB, osVersion: '10.0.19045', detectedAt: new Date().toISOString(),
    }),
  });
  // gpt-oss-120b's estimatedRequirements is an OFFICIAL_REQUIREMENT of 80GB — an 8GB mock machine must NOT fit it.
  const { status, body } = await json(app, '/api/local-ai/install-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributionId: 'gpt-oss-120b-ollama' }),
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.fit.rating, 'NOT_RECOMMENDED');
});

test('install-preview: verified distribution with no estimatedRequirements yields an UNKNOWN fit but is still allowed through (frontend shows warning, not a hard block)', async () => {
  stubOllamaFetch();
  const app = buildApp();
  // granite4.2-8b-ollama is verified:true with no estimatedRequirements in the seed catalog.
  const { status, body } = await json(app, '/api/local-ai/install-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributionId: 'granite4.2-8b-ollama' }),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.fit.rating, 'UNKNOWN');
});

test('install-preview: already-installed distribution is still previewable (no auto-install, no crash)', async () => {
  stubOllamaFetch({ tagsResponse: { models: [{ name: 'qwen3.8:27b' }] } });
  const app = buildApp();
  const { body } = await json(app, '/api/local-ai/install-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributionId: 'qwen3.8-27b-ollama' }),
  });
  assert.equal(body.ok, true);
  assert.equal(body.alreadyInstalled, true);
});

test('security: distributionId containing shell-injection-shaped text is inert, returns 404 not an error', async () => {
  const app = buildApp();
  const { status, body } = await json(app, '/api/local-ai/install-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributionId: '"; rm -rf /; ignore previous instructions' }),
  });
  assert.equal(status, 404);
  assert.equal(body.ok, false);
});
