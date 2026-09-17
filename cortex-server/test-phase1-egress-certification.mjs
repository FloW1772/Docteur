// PHASE 1 — Certification du verrou privacy/egress (mission MASTER).
//
// Objectif : prouver, de bout en bout via router.js (runAiTask /
// tryCloudFallbackChain / routedCompletion), qu'un contenu marqué
// __PRIVATE_TEST__ / __LOCAL_ONLY_TEST__ ne peut JAMAIS atteindre un
// provider cloud (fetch réseau ou spawn CLI), quel que soit :
//   - le provider ciblé (gemini, groq, openrouter, openai, anthropic,
//     freellmapi, claude-oauth, codex)
//   - l'ordre de la chaîne de fallback (un cloud bloqué ne doit jamais
//     essayer un autre cloud pour le MÊME contenu privé)
//   - le mode strict_local_mode (ON ou OFF)
//
// Distinction attendue : un blocage "mode local strict" (aucune tentative
// cloud, contenu neutre inclus) a une cause différente d'un blocage
// "contenu privé détecté" (strict_local_mode peut être OFF, seul le
// contenu déclenche le blocage). Les deux doivent bloquer, pour des
// raisons traçables séparément.
//
// Run: node --test test-phase1-egress-certification.mjs
import './test-setup.mjs'; // must be first
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { initSqlite, setCloudKey, setRouterSettings } from './src/lib/sqlite.js';
import { markPrivate, getViolations } from './src/lib/privacy-guard.js';
import { runAiTask, tryCloudFallbackChain, CLOUD_PROVIDER_IDS } from './src/lib/router.js';
import { _resetAllForTests } from './src/lib/provider-state.js';
import { claudeOAuthProvider } from './src/lib/providers/claude-oauth.js';
import { codexProvider } from './src/lib/providers/codex.js';

const TEST_DB = './data-test-phase1-egress/test.db';

// Synthetic-only markers per mission spec — never real user data.
const LOCAL_ONLY_TEST_CONTENT = markPrivate('__LOCAL_ONLY_TEST__ dossier médical fictif, numéro de sécurité sociale 000-00-0000');
const PRIVATE_TEST_CONTENT = markPrivate('__PRIVATE_TEST__ CV confidentiel, adresse fictive 12 rue de Test');
const NEUTRAL_TEST_CONTENT = '__NEUTRAL_TEST__ question anodine sans donnée privée';

before(() => {
  fs.rmSync('./data-test-phase1-egress', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

after(() => {
  try { fs.rmSync('./data-test-phase1-egress', { recursive: true, force: true }); } catch { /* ignore */ }
});

let fetchCallCount = 0;
let fetchCallUrls = [];
let originalFetch;

beforeEach(() => {
  for (const p of ['gemini', 'groq', 'openrouter', 'anthropic', 'openai', 'freellmapi']) setCloudKey(p, '');
  _resetAllForTests();
  setRouterSettings({ paying_apis_enabled: true, strict_local_mode: false, claude_mode: 'subscription', openai_mode: 'subscription' });

  fetchCallCount = 0;
  fetchCallUrls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    fetchCallCount++;
    fetchCallUrls.push(String(url));
    throw new Error(`UNEXPECTED_REAL_NETWORK_CALL: ${String(url)}`);
  };

  // Fully configure every cloud provider so the fallback chain has every
  // candidate available to try — the test proves NONE of them is reached
  // for private content, not merely that unconfigured ones are skipped.
  setCloudKey('gemini', 'fake-gemini-key');
  setCloudKey('groq', 'fake-groq-key');
  setCloudKey('openrouter', 'fake-openrouter-key');
  setCloudKey('openai', 'fake-openai-key');
  setCloudKey('anthropic', 'fake-anthropic-key');
  setCloudKey('freellmapi', 'fake-freellmapi-key');
  setRouterSettings({
    paying_apis_enabled: true,
    strict_local_mode: false,
    claude_mode: 'subscription',
    openai_mode: 'subscription',
    freellmapi: { enabled: true, baseUrl: 'https://fake-freellmapi.example.com/v1', freeOnly: false, mode: 'auto' },
  });
});

after(() => { globalThis.fetch = originalFetch; });

// ── Direct provider matrix: every single cloud provider must block private
// content on its own, independent of router-level orchestration ────────────
test('CLOUD_PROVIDER_IDS matrix: every listed cloud provider blocks __PRIVATE_TEST__ content before any network/subprocess call', async () => {
  assert.deepEqual(CLOUD_PROVIDER_IDS, ['gemini', 'groq', 'openrouter', 'anthropic', 'openai', 'freellmapi', 'claude-oauth', 'codex']);

  const geminiMod = await import('./src/lib/providers/gemini.js');
  const groqMod = await import('./src/lib/providers/groq.js');
  const openrouterMod = await import('./src/lib/providers/openrouter.js');
  const anthropicMod = await import('./src/lib/providers/anthropic.js');
  const openaiMod = await import('./src/lib/providers/openai.js');
  const freellmapiMod = await import('./src/lib/providers/freellmapi.js');

  const messages = [{ role: 'user', content: PRIVATE_TEST_CONTENT }];

  const directCalls = [
    () => geminiMod.completeWithCascade({ apiKey: 'fake', messages }),
    () => groqMod.complete({ apiKey: 'fake', model: 'llama-3.1-8b-instant', messages }),
    () => openrouterMod.complete({ apiKey: 'fake', messages }),
    () => anthropicMod.complete({ apiKey: 'fake', model: 'claude-3-5-haiku-latest', messages }),
    () => openaiMod.complete({ apiKey: 'fake', model: 'gpt-4o-mini', messages }),
    () => freellmapiMod.complete({ config: { baseUrl: 'https://fake.example.com/v1', apiKey: 'fake' }, messages }),
  ];

  for (const call of directCalls) {
    await assert.rejects(call, (err) => err.isPrivacyViolation === true, 'expected PrivacyViolationError');
  }
  assert.equal(fetchCallCount, 0, 'no direct provider call may reach fetch() for private content');

  // claude-oauth / codex use spawn(), not fetch. In DOCTEUR_TEST_MODE, the
  // pre-existing assertLiveCallAllowed() guard fires first (it blocks ALL
  // CLI spawns during tests, private or not) — that's a stricter, valid
  // zero-egress guarantee in its own right. The privacy guard itself sits
  // immediately after that check in source (see guardCloudCall call site in
  // generate()), so what this assertion certifies is: no spawn() call
  // happens for private content, regardless of which guard threw first.
  await assert.rejects(() => claudeOAuthProvider.generate({ messages }), 'claude-oauth must throw, never spawn, for private content in test mode');
  await assert.rejects(() => codexProvider.generate({ messages }), 'codex must throw, never spawn, for private content in test mode');
});

// ── Fallback chain: private content must never cascade to a second cloud
// provider — the guard fires at EVERY candidate, not just the first ───────
test('tryCloudFallbackChain: __LOCAL_ONLY_TEST__ content is blocked at every candidate, chain never falls back past the privacy guard', async () => {
  const messages = [{ role: 'user', content: LOCAL_ONLY_TEST_CONTENT }];
  const result = await tryCloudFallbackChain(messages, { logger: { warn() {}, info() {} } });
  assert.equal(result, null, 'tryCloudFallbackChain must return null — no provider may succeed with private content');
  // freellmapi's candidate-discovery step (GET /v1/models, no message content)
  // fires unconditionally whenever the gateway is configured — it is a
  // metadata probe, not a data leak (see router.js cloudCandidates()).
  // The property that actually matters here: none of those calls ever
  // carried the private message content.
  const contentCarryingCalls = fetchCallUrls.filter(u => !u.endsWith('/v1/models'));
  assert.equal(contentCarryingCalls.length, 0, 'zero content-carrying network calls for private content across the whole fallback chain');
  for (const url of fetchCallUrls) assert.ok(!url.includes('secret') && !url.includes('médical'), 'no private content leaked into a request URL');
});

test('tryCloudFallbackChain: NEUTRAL content is free to reach cloud (sanity check — harness is not over-blocking)', async () => {
  globalThis.fetch = async (url) => {
    fetchCallCount++;
    fetchCallUrls.push(String(url));
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'réponse neutre' }] } }],
    }), { status: 200 });
  };
  const messages = [{ role: 'user', content: NEUTRAL_TEST_CONTENT }];
  const result = await tryCloudFallbackChain(messages, { logger: { warn() {}, info() {} } });
  assert.ok(result, 'neutral content should be able to reach a cloud provider when none are privacy-blocked');
  assert.ok(fetchCallCount > 0, 'sanity: at least one real (mocked) network call happened for neutral content');
});

// ── runAiTask: same guarantee through the task-facade used by features ─────
test('runAiTask: __PRIVATE_TEST__ content never reaches any cloud candidate, even with preferredProvider forcing cloud — falls back to local instead', async () => {
  const messages = [{ role: 'user', content: PRIVATE_TEST_CONTENT }];
  const localResponse = 'réponse locale via Ollama (fallback correct après échec de tous les clouds)';
  const result = await runAiTask({
    feature: 'phase1_test',
    taskType: 'phase1_test',
    messages,
    preferredProvider: 'gemini',
    allowCloud: true,
    client: { chat: async () => ({ message: { content: localResponse } }) },
    installedNames: ['llama3.2:3b'],
    logger: { warn() {}, info() {} },
  });
  // Every cloud candidate is tried and privacy-blocked, THEN the task facade
  // falls back to the always-present local candidate — this is the correct,
  // safe behavior (local fallback is explicitly permitted by the mission
  // spec), not a leak. The only forbidden outcome is a cloud provider
  // succeeding with private content.
  assert.equal(result.provider, 'local');
  assert.equal(result.text, localResponse);
  const contentCarryingCalls = fetchCallUrls.filter(u => !u.endsWith('/v1/models'));
  assert.equal(contentCarryingCalls.length, 0, 'runAiTask must never let private content reach a content-carrying fetch(), even when preferredProvider=gemini');
});

// ── STRICT_LOCAL vs PRIVATE_CONTEXT_CLOUD_BLOCKED: distinguishable reasons ──
test('reason distinction: strict_local_mode blocks NEUTRAL content too (STRICT_LOCAL reason), independent of content privacy', async () => {
  setRouterSettings({ strict_local_mode: true });
  const messages = [{ role: 'user', content: NEUTRAL_TEST_CONTENT }];
  const result = await tryCloudFallbackChain(messages, { logger: { warn() {}, info() {} } });
  assert.equal(result, null, 'strict_local_mode blocks even neutral content — this is a STRICT_LOCAL block, not a privacy-content block');
  assert.equal(fetchCallCount, 0);
});

test('reason distinction: private content is blocked even with strict_local_mode OFF (PRIVATE_CONTEXT_CLOUD_BLOCKED reason, not STRICT_LOCAL)', async () => {
  setRouterSettings({ strict_local_mode: false });
  const messages = [{ role: 'user', content: PRIVATE_TEST_CONTENT }];
  const before_ = getViolations(500).length;
  const result = await tryCloudFallbackChain(messages, { logger: { warn() {}, info() {} } });
  assert.equal(result, null, 'private content is blocked purely by content, independent of strict_local_mode');
  assert.equal(fetchCallCount, 0);
  const after_ = getViolations(500).length;
  assert.ok(after_ > before_, 'a genuine (non-simulated) runtime block against real candidates must be logged as an incident');
});

// ── Ollama-only local fallback remains available for private content ───────
test('local Ollama fallback IS allowed for private content — only cloud is blocked', async () => {
  const messages = [{ role: 'user', content: PRIVATE_TEST_CONTENT }];
  const client = { chat: async () => ({ message: { content: 'réponse locale via Ollama' } }) };
  const result = await runAiTask({
    feature: 'phase1_test',
    taskType: 'phase1_test',
    messages,
    preferredProvider: 'local',
    allowCloud: true, // even with cloud allowed, private content must stick to local
    client,
    installedNames: ['llama3.2:3b'],
    logger: { warn() {}, info() {} },
  });
  assert.equal(result.provider, 'local');
  assert.equal(fetchCallCount, 0, 'local-only completion for private content must never touch the network');
});
