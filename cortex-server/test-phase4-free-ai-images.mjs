// PHASE 4 — Free AI Finder / FreeLLMAPI normalization + "already configured"
// correctness. No fuzzy matching: NATIVE_PROVIDER_MAP is an exact-slug
// allowlist, and every id in it must be a real router.js CLOUD_PROVIDER_ID.
// Run: node --test test-phase4-free-ai-images.mjs
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings } from './src/lib/sqlite.js';
import { setSecret, deleteSecret } from './src/lib/secret-store.js';
import { createFreeAiRoute, __testables } from './src/routes/free-ai.js';
import { NATIVE_PROVIDER_MAP } from './src/lib/free-ai-catalog.js';
import { CLOUD_PROVIDER_IDS } from './src/lib/router.js';

initSqlite(':memory:');

const app = new Hono();
app.route('/api', createFreeAiRoute({ logger: null }));

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __testables.clearCatalogCache();
  setRouterSettings({ strict_local_mode: false, freellmapi: { enabled: false, baseUrl: '', freeOnly: false } });
  for (const id of ['groq', 'gemini', 'openrouter', 'anthropic', 'openai', 'freellmapi']) deleteSecret(id);
});

// ── No fuzzy matching: every NATIVE_PROVIDER_MAP value must be a real,
// exact router provider id — never inferred from name similarity. ──────────

test('NATIVE_PROVIDER_MAP: every mapped value is a real router.js CLOUD_PROVIDER_ID (no invented ids)', () => {
  for (const [slug, docteurId] of Object.entries(NATIVE_PROVIDER_MAP)) {
    assert.ok(CLOUD_PROVIDER_IDS.includes(docteurId), `NATIVE_PROVIDER_MAP['${slug}'] = '${docteurId}' must be a real CLOUD_PROVIDER_ID`);
  }
});

test('NATIVE_PROVIDER_MAP: keys are exact catalog slugs, not name-derived — near-miss slugs do not accidentally match', () => {
  // These near-miss variants must NOT be present as keys — proves the map is
  // a hand-curated allowlist, not a fuzzy/normalized lookup that could
  // silently match unintended catalog entries.
  const nearMisses = ['Groq', 'GROQ', 'groq-cloud', 'groqai', 'google_gemini', 'gemini', 'Gemini', 'open-router', 'OpenRouter', 'Anthropic', 'open-ai', 'OpenAI'];
  for (const nearMiss of nearMisses) {
    assert.equal(NATIVE_PROVIDER_MAP[nearMiss], undefined, `'${nearMiss}' must not be a recognized alias — only exact catalog slugs are`);
  }
});

test('NATIVE_PROVIDER_MAP: CLI-subscription and gateway providers (claude-oauth, codex, freellmapi) are deliberately absent — they have no catalog-slug equivalent, not a bug', () => {
  const mappedIds = new Set(Object.values(NATIVE_PROVIDER_MAP));
  assert.equal(mappedIds.has('claude-oauth'), false);
  assert.equal(mappedIds.has('codex'), false);
  assert.equal(mappedIds.has('freellmapi'), false);
  // freellmapi is handled through the separate availableViaFreeLLMAPI/
  // maybe_via_freellmapi state (routes/free-ai.js attachDocteurState),
  // which is a "potentially compatible" signal, not a hard "configured"
  // claim tied to one specific catalog entry — see test below.
});

// ── docteurState matrix ─────────────────────────────────────────────────────

const FIXTURE = {
  version: '1.0.0',
  generated: '2026-01-01',
  providers: [
    { slug: 'groq', name: 'Groq', category: 'ongoing', free_type: 'perpetual', free_tier: 'Free tier', docs_url: 'https://groq.example/docs', phone_required: false, card_required: false, commercial_ok: true, openai_compatible: true, modalities: ['text'], verified: true, last_verified: '2026-01-01' },
    { slug: 'google-gemini', name: 'Google Gemini', category: 'ongoing', free_type: 'perpetual', free_tier: 'Free tier', docs_url: 'https://gemini.example/docs', phone_required: false, card_required: false, commercial_ok: true, openai_compatible: false, modalities: ['text'], verified: true, last_verified: '2026-01-01' },
    { slug: 'some-openai-compatible-gateway', name: 'Some Gateway', category: 'ongoing', free_type: 'renewing-quota', free_tier: 'Free quota', docs_url: 'https://gateway.example/docs', phone_required: false, card_required: false, commercial_ok: true, openai_compatible: true, modalities: ['text'], verified: true, last_verified: '2026-01-01' },
  ],
};

function fixtureFetch() {
  return async () => new Response(JSON.stringify(FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('docteurState matrix: configured, native_not_configured, maybe_via_freellmapi, not_integrated are each reachable and mutually exclusive', async () => {
  globalThis.fetch = fixtureFetch();
  setSecret('groq', 'gsk_fake_configured');
  setRouterSettings({ freellmapi: { enabled: true, baseUrl: 'https://fake-gateway.example.com/v1', freeOnly: false } });
  setSecret('freellmapi', 'fake-freellmapi-key');

  const res = await app.request('/api/free-ai/providers');
  const body = await res.json();

  const groq = body.providers.find(p => p.id === 'groq');
  assert.equal(groq.docteurState, 'configured', 'groq has a valid native key stored');

  const gemini = body.providers.find(p => p.id === 'google-gemini');
  assert.equal(gemini.docteurState, 'native_not_configured', 'gemini maps natively but has no key stored');

  const gateway = body.providers.find(p => p.id === 'some-openai-compatible-gateway');
  assert.equal(gateway.nativeDocteurProvider, null, 'unmapped slug — no native id');
  assert.equal(gateway.docteurState, 'maybe_via_freellmapi', 'unmapped but FreeLLMAPI itself is configured');
});

test('docteurState: an unmapped provider with FreeLLMAPI NOT configured falls back to not_integrated, never falsely "maybe_via_freellmapi"', async () => {
  globalThis.fetch = fixtureFetch();
  // FreeLLMAPI left unconfigured (afterEach clears secrets/settings).
  const res = await app.request('/api/free-ai/providers');
  const body = await res.json();
  const gateway = body.providers.find(p => p.id === 'some-openai-compatible-gateway');
  assert.equal(gateway.docteurState, 'not_integrated');
});

// ── "Already configured" providers must be identifiable for the UI's
// Déjà configurés / À découvrir split (routes/free-ai.js already computes
// docteurState server-side; FreeAiFinder.tsx filters on it — see manual UI
// verification in this phase's report for the actual rendered split). ─────

test('a configured provider carries enough server-side signal (docteurState==="configured") for the frontend to exclude it from "À découvrir" without any fuzzy client-side matching', async () => {
  globalThis.fetch = fixtureFetch();
  setSecret('groq', 'gsk_fake_configured');
  const res = await app.request('/api/free-ai/providers');
  const body = await res.json();
  const configuredCount = body.providers.filter(p => p.docteurState === 'configured').length;
  const discoverableCount = body.providers.filter(p => p.docteurState !== 'configured').length;
  assert.equal(configuredCount, 1);
  assert.equal(discoverableCount, 2);
  assert.equal(configuredCount + discoverableCount, body.providers.length);
});
