import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from './src/lib/free-ai-catalog.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  catalog.clearCatalogCache();
});

// Small synthetic dataset mirroring the real schema shape — never the real
// (large, changing) upstream dump. Covers: ongoing/perpetual no-card,
// trial/card-required, phone-required, and an unknown/missing-fields entry.
const FIXTURE = {
  version: '1.0.0',
  generated: '2026-01-01',
  source: 'https://github.com/pacocartones/free-llm-api-hub',
  providers: [
    {
      slug: 'provider-a', name: 'Provider A', category: 'ongoing', free_type: 'perpetual',
      free_tier: 'Some free tier', docs_url: 'https://provider-a.example/docs',
      phone_required: false, card_required: false, commercial_ok: true,
      openai_compatible: true, modalities: ['text'], verified: true, last_verified: '2026-01-01',
    },
    {
      slug: 'provider-b', name: 'Provider B', category: 'trial', free_type: 'trial-credit',
      free_tier: '$10 credit for 30 days', docs_url: 'https://provider-b.example/docs',
      phone_required: false, card_required: true, commercial_ok: false,
      openai_compatible: false, modalities: ['text', 'vision'], verified: true, last_verified: '2026-01-01',
    },
    {
      slug: 'provider-c', name: 'Provider C', category: 'ongoing', free_type: 'renewing-quota',
      free_tier: 'Renewing monthly quota', docs_url: 'https://provider-c.example/docs',
      phone_required: true, card_required: false, commercial_ok: null,
      openai_compatible: null, modalities: [], verified: false, last_verified: null,
    },
    {
      // Minimal entry: only the schema-required fields present.
      slug: 'provider-d', name: 'Provider D', category: 'ongoing', free_type: 'perpetual',
      free_tier: 'Unknown extras', docs_url: '', verified: false,
    },
  ],
};

function fixtureResponse(body = FIXTURE, status = 200) {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('fetches, validates and normalizes the catalog without inventing fields', async () => {
  globalThis.fetch = fixtureResponse();
  const { result, fromCache, stale } = await catalog.getCatalog();
  assert.equal(fromCache, false);
  assert.equal(stale, false);
  assert.equal(result.providers.length, 4);

  const a = result.providers.find(p => p.id === 'provider-a');
  assert.deepEqual(a, {
    id: 'provider-a', name: 'Provider A', category: 'ongoing', freeType: 'perpetual',
    freeTier: 'Some free tier', rateLimits: null, notes: null, bestFor: null,
    modalities: ['text'], modelsFree: null, expires: null,
    cardRequired: false, phoneRequired: false, commercialUse: true,
    openAICompatible: true, openAIBaseUrl: null, docsUrl: 'https://provider-a.example/docs',
    verified: true, lastVerified: '2026-01-01', added: null,
    nativeDocteurProvider: null,
  });
});

test('provider missing required schema fields is skipped, not guessed', async () => {
  globalThis.fetch = fixtureResponse({
    ...FIXTURE,
    providers: [...FIXTURE.providers, { name: 'No slug here' }],
  });
  const { result } = await catalog.getCatalog();
  assert.equal(result.providers.length, 4); // the malformed 5th entry is dropped, not fabricated
});

test('unknown/absent optional fields normalize to null, never a guessed value', async () => {
  globalThis.fetch = fixtureResponse();
  const { result } = await catalog.getCatalog();
  const c = result.providers.find(p => p.id === 'provider-c');
  assert.equal(c.commercialUse, null);
  assert.equal(c.openAICompatible, null);
  assert.equal(c.lastVerified, null);
  assert.equal(c.verified, false);

  const d = result.providers.find(p => p.id === 'provider-d');
  assert.equal(d.rateLimits, null);
  assert.equal(d.modalities.length, 0);
});

test('rejects a dataset without a providers array', async () => {
  globalThis.fetch = fixtureResponse({ version: '1.0.0' });
  await assert.rejects(() => catalog.getCatalog(), /providers manquant/);
});

test('rejects a dataset with an empty providers array', async () => {
  globalThis.fetch = fixtureResponse({ version: '1.0.0', providers: [] });
  await assert.rejects(() => catalog.getCatalog(), /providers vide/);
});

test('rejects non-JSON payload', async () => {
  globalThis.fetch = async () => new Response('not json', { status: 200 });
  await assert.rejects(() => catalog.getCatalog(), /JSON invalide/);
});

test('rejects an oversized response before parsing', async () => {
  const huge = 'x'.repeat(9 * 1024 * 1024);
  globalThis.fetch = async () => new Response(huge, {
    status: 200,
    headers: { 'content-length': String(huge.length) },
  });
  await assert.rejects(() => catalog.getCatalog(), /volumineuse/);
});

test('propagates HTTP error status as provider-unavailable', async () => {
  globalThis.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(() => catalog.getCatalog(), /indisponible/);
});

test('times out cleanly on a hanging fetch', async () => {
  globalThis.fetch = async () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    throw err;
  };
  await assert.rejects(() => catalog.getCatalog(), /indisponible/);
});

test('falls back to previous cache when a later fetch fails', async () => {
  globalThis.fetch = fixtureResponse();
  const first = await catalog.getCatalog();
  assert.equal(first.result.providers.length, 4);

  globalThis.fetch = async () => new Response('', { status: 500 });
  const second = await catalog.getCatalog({ force: true });
  assert.equal(second.stale, true);
  assert.equal(second.fromCache, true);
  assert.equal(second.result.providers.length, 4); // stale cache, not empty
  assert.ok(second.error);
});

test('serves from cache within TTL without a new fetch', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return fixtureResponse()(); };
  await catalog.getCatalog();
  await catalog.getCatalog();
  assert.equal(calls, 1);
});

test('force=true bypasses a fresh cache and fetches again', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return fixtureResponse()(); };
  await catalog.getCatalog();
  await catalog.getCatalog({ force: true });
  assert.equal(calls, 2);
});

test('maps only verified native Docteur providers, never by name guessing', () => {
  assert.equal(catalog.NATIVE_PROVIDER_MAP.groq, 'groq');
  assert.equal(catalog.NATIVE_PROVIDER_MAP['google-gemini'], 'gemini');
  assert.equal(catalog.NATIVE_PROVIDER_MAP.openrouter, 'openrouter');
  assert.equal(catalog.NATIVE_PROVIDER_MAP.anthropic, 'anthropic');
  assert.equal(catalog.NATIVE_PROVIDER_MAP.openai, 'openai');
  assert.equal(catalog.NATIVE_PROVIDER_MAP['some-unrelated-slug'], undefined);
});

test('unmapped provider slug normalizes with nativeDocteurProvider: null', async () => {
  globalThis.fetch = fixtureResponse();
  const { result } = await catalog.getCatalog();
  const b = result.providers.find(p => p.id === 'provider-b');
  assert.equal(b.nativeDocteurProvider, null);
});

test('mapped provider slug (groq) resolves nativeDocteurProvider', async () => {
  globalThis.fetch = fixtureResponse({
    ...FIXTURE,
    providers: [{ ...FIXTURE.providers[0], slug: 'groq', name: 'Groq' }],
  });
  const { result } = await catalog.getCatalog();
  assert.equal(result.providers[0].nativeDocteurProvider, 'groq');
});

test('getCacheInfo reflects empty then populated then stale cache', async () => {
  assert.equal(catalog.getCacheInfo().cached, false);
  globalThis.fetch = fixtureResponse();
  await catalog.getCatalog();
  const info = catalog.getCacheInfo();
  assert.equal(info.cached, true);
  assert.equal(info.stale, false);
});

// ── Remote schema drift / adversarial payloads must never crash Settings ──

test('upstream schema drift (new unknown fields, changed types) does not crash normalization', async () => {
  globalThis.fetch = fixtureResponse({
    version: '9.9.9',
    generated: '2030-01-01',
    providers: [
      {
        slug: 'future-provider', name: 'Future Provider', category: 'ongoing', free_type: 'perpetual',
        free_tier: 'Something new', docs_url: 'https://future.example/docs', verified: true, last_verified: '2030-01-01',
        // Fields the current schema doesn't know about yet — must be ignored, not crash.
        pricing_tiers: [{ name: 'free', quota: 1000 }],
        regions: ['eu', 'us'],
        // A field that changed shape upstream (object instead of the expected string).
        rate_limits: { rpm: 60 },
      },
    ],
  });
  const { result } = await catalog.getCatalog();
  assert.equal(result.providers.length, 1);
  const p = result.providers[0];
  assert.equal(p.id, 'future-provider');
  // rate_limits arrived as an object, not a string — normalizer must drop it to null, not throw or pass the object through.
  assert.equal(p.rateLimits, null);
  assert.equal('pricing_tiers' in p, false);
  assert.equal('regions' in p, false);
});

test('providers field with wrong type (not an array) is rejected cleanly', async () => {
  globalThis.fetch = fixtureResponse({ version: '1.0.0', providers: { slug: 'not-an-array' } });
  await assert.rejects(() => catalog.getCatalog(), /providers manquant/);
});

test('a provider entry that is itself not an object is skipped, not crashed on', async () => {
  globalThis.fetch = fixtureResponse({
    version: '1.0.0',
    providers: [null, 'a string', 42, { slug: 'ok-provider', name: 'OK Provider', category: 'ongoing', free_type: 'perpetual', free_tier: 'x', docs_url: 'https://ok.example', verified: true, last_verified: '2026-01-01' }],
  });
  const { result } = await catalog.getCatalog();
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].id, 'ok-provider');
});

test('modalities containing unknown/future values keeps only recognized ones', async () => {
  globalThis.fetch = fixtureResponse({
    ...FIXTURE,
    providers: [{ ...FIXTURE.providers[0], modalities: ['text', 'video-3d-holographic', 'vision'] }],
  });
  const { result } = await catalog.getCatalog();
  assert.deepEqual(result.providers[0].modalities, ['text', 'vision']);
});

test('non-HTTPS docs_url is still passed through by the catalog layer (the UI layer is responsible for refusing to open it)', async () => {
  globalThis.fetch = fixtureResponse({
    ...FIXTURE,
    providers: [{ ...FIXTURE.providers[0], docs_url: 'javascript:alert(1)' }],
  });
  const { result } = await catalog.getCatalog();
  // The catalog module normalizes the raw string verbatim (it has no concept
  // of "safe to open") — enforcement of https-only lives in the frontend's
  // isSafeExternalUrl() gate before window.open(), covered separately.
  assert.equal(result.providers[0].docsUrl, 'javascript:alert(1)');
});

test('dataset is only ever JSON-parsed, never treated as executable content', async () => {
  globalThis.fetch = async () => new Response('<script>window.pwned = true</script>', { status: 200 });
  await assert.rejects(() => catalog.getCatalog(), /JSON invalide/);
  assert.equal(globalThis.pwned, undefined);
});
