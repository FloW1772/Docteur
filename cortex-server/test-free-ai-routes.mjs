import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings } from './src/lib/sqlite.js';
import { setSecret, deleteSecret } from './src/lib/secret-store.js';
import { createFreeAiRoute, __testables } from './src/routes/free-ai.js';

initSqlite(':memory:');

const app = new Hono();
app.route('/api', createFreeAiRoute({ logger: null }));

const originalFetch = globalThis.fetch;

const FIXTURE = {
  version: '1.0.0',
  generated: '2026-01-01',
  providers: [
    {
      slug: 'groq', name: 'Groq', category: 'ongoing', free_type: 'perpetual',
      free_tier: 'Free tier', docs_url: 'https://groq.example/docs',
      phone_required: true, card_required: false, commercial_ok: true,
      openai_compatible: true, modalities: ['text'], verified: true, last_verified: '2026-01-01',
    },
    {
      slug: 'unmapped-provider', name: 'Unmapped Provider', category: 'trial', free_type: 'trial-credit',
      free_tier: '$5 credit', docs_url: 'https://unmapped.example/docs',
      phone_required: false, card_required: true, commercial_ok: false,
      openai_compatible: false, modalities: [], verified: true, last_verified: '2026-01-01',
    },
  ],
};

function fixtureFetch() {
  return async () => new Response(JSON.stringify(FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __testables.clearCatalogCache();
  setRouterSettings({ strict_local_mode: false });
  deleteSecret('groq');
});

test('GET /api/free-ai/providers returns normalized providers with Docteur state', async () => {
  globalThis.fetch = fixtureFetch();
  const res = await app.request('/api/free-ai/providers');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers.length, 2);
  assert.equal(body.source, 'free-llm-api-hub');

  const groq = body.providers.find(p => p.id === 'groq');
  assert.equal(groq.nativeDocteurProvider, 'groq');
  assert.equal(groq.configuredInDocteur, false);
  assert.equal(groq.docteurState, 'native_not_configured');

  const unmapped = body.providers.find(p => p.id === 'unmapped-provider');
  assert.equal(unmapped.nativeDocteurProvider, null);
  assert.equal(unmapped.docteurState, 'not_integrated');
});

test('configured native provider is reported without ever leaking the key', async () => {
  globalThis.fetch = fixtureFetch();
  setSecret('groq', 'gsk_fake_test_key_value');
  const res = await app.request('/api/free-ai/providers');
  const body = await res.json();
  const groq = body.providers.find(p => p.id === 'groq');
  assert.equal(groq.configuredInDocteur, true);
  assert.equal(groq.docteurState, 'configured');
  assert.equal(JSON.stringify(body).includes('gsk_fake_test_key_value'), false);
});

test('configured field is a plain boolean, never the secret value or presence of apiKey field', async () => {
  globalThis.fetch = fixtureFetch();
  setSecret('groq', 'gsk_fake_test_key_value');
  const res = await app.request('/api/free-ai/providers');
  const body = await res.json();
  const groq = body.providers.find(p => p.id === 'groq');
  assert.equal(typeof groq.configuredInDocteur, 'boolean');
  assert.equal('apiKey' in groq, false);
  assert.equal('key' in groq, false);
});

test('Strict Local blocks refresh=1 and serves cache instead, with zero network calls', async () => {
  globalThis.fetch = fixtureFetch();
  await app.request('/api/free-ai/providers'); // warm cache while unrestricted
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network call should not happen under strict local'); };

  setRouterSettings({ strict_local_mode: true });
  const res = await app.request('/api/free-ai/providers?refresh=1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.strictLocalActive, true);
  assert.equal(body.strictLocalBlockedRefresh, true);
  assert.equal(body.providers.length, 2); // served from cache, not empty
  assert.equal(calls, 0); // the mock must never even be invoked
});

test('Strict Local with no cache at all returns a clean empty state, not an error, with zero network calls', async () => {
  setRouterSettings({ strict_local_mode: true });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network call should not happen under strict local'); };
  const res = await app.request('/api/free-ai/providers');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers.length, 0);
  assert.ok(body.warning);
  assert.equal(calls, 0);
});

test('Strict Local: GET without refresh also never fetches, even with a stale-but-present cache', async () => {
  globalThis.fetch = fixtureFetch();
  await app.request('/api/free-ai/providers'); // warm cache
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('should not be called'); };
  setRouterSettings({ strict_local_mode: true });
  const res = await app.request('/api/free-ai/providers'); // no ?refresh=1 at all
  assert.equal(res.status, 200);
  assert.equal(calls, 0);
  const body = await res.json();
  assert.equal(body.providers.length, 2);
});

test('Strict Local never auto-tests any provider — the route only ever calls the catalog fetch, no /router/test/* logic exists in this file', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('./src/routes/free-ai.js', import.meta.url), 'utf8');
  assert.equal(source.includes('/router/test/'), false);
  assert.equal(source.includes('testConnection'), false);
});

test('POST /api/free-ai/refresh is blocked by Strict Local (503)', async () => {
  setRouterSettings({ strict_local_mode: true });
  const res = await app.request('/api/free-ai/refresh', { method: 'POST' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.strict_local, true);
});

test('POST /api/free-ai/refresh fetches fresh data when Strict Local is off', async () => {
  globalThis.fetch = fixtureFetch();
  const res = await app.request('/api/free-ai/refresh', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.providers.length, 2);
});

test('remote source outage with existing cache: refresh reports stale but keeps data', async () => {
  globalThis.fetch = fixtureFetch();
  await app.request('/api/free-ai/providers');
  globalThis.fetch = async () => new Response('', { status: 500 });
  const res = await app.request('/api/free-ai/refresh', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stale, true);
  assert.equal(body.providers.length, 2);
});

test('remote source outage with no cache at all: GET returns empty state with 502, no crash', async () => {
  globalThis.fetch = async () => new Response('', { status: 500 });
  const res = await app.request('/api/free-ai/providers');
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.deepEqual(body.providers, []);
  assert.ok(body.warning);
});

test('GET /api/free-ai/cache-info reports cache presence without leaking data', async () => {
  globalThis.fetch = fixtureFetch();
  const before = await (await app.request('/api/free-ai/cache-info')).json();
  assert.equal(before.cached, false);

  await app.request('/api/free-ai/providers');
  const after = await (await app.request('/api/free-ai/cache-info')).json();
  assert.equal(after.cached, true);
});
