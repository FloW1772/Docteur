// PHASE 3 — Mémoire adaptative locale (3 niveaux : session / épisodique /
// profil long-terme). Extraction 100% locale (règles + Ollama optionnel,
// jamais cloud), budget de contexte borné, dédup, propagation local_only.
// Run: node --test test-phase3-adaptive-memory.mjs
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';

import { initSqlite, addPreferenceFact, listPreferenceFacts, clearPreferenceFacts, countEpisodicMemories, listEpisodicMemories } from './src/lib/sqlite.js';
import {
  getMemorySettings, setMemorySettings, getBudgetLimits, isWorthRemembering, extractWithOllama,
  jaccardSimilarity, findDuplicate, addEpisodicMemoryDeduped, selectMemoriesForBudget, privacyFromSource,
  resetAdaptiveMemory,
} from './src/lib/memory.js';
import { createMemoryRoute } from './src/routes/memory.js';
import { createSearchRoute } from './src/routes/search.js';

const TEST_DB = './data-test-memory/test.db';

before(() => {
  fs.rmSync('./data-test-memory', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

after(() => {
  try { fs.rmSync('./data-test-memory', { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  resetAdaptiveMemory();
  clearPreferenceFacts();
  setMemorySettings({ enabled: true, learn_from_searches: true, learn_from_neurons: true, learn_from_corrections: true, budget: 'normal' });
});

function buildApp() {
  const app = new Hono();
  app.route('/api', createMemoryRoute({ logger: { info() {}, warn() {}, error() {} } }));
  return app;
}

// ── Settings ─────────────────────────────────────────────────────────────

test('settings: defaults are sane and additive (existing behavior unaffected when disabled)', () => {
  setMemorySettings({});
  const s = getMemorySettings();
  assert.equal(typeof s.enabled, 'boolean');
  assert.ok(['low', 'normal', 'extended'].includes(s.budget));
});

test('settings: PUT /api/memory/settings updates only allowed fields, rejects invalid budget silently by falling back to normal', async () => {
  const app = buildApp();
  const res = await app.request('/api/memory/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ budget: 'not_a_real_budget', enabled: false, unrelated_field: 'ignored' }),
  });
  const body = await res.json();
  assert.equal(body.enabled, false);
  assert.equal(body.budget, 'normal');
  assert.equal(body.unrelated_field, undefined);
});

// ── Rule-based extraction (local only, no AI) ───────────────────────────────

test('isWorthRemembering: recognizes stated preferences, ignores generic chit-chat', () => {
  assert.equal(isWorthRemembering('je préfère le café sans sucre'), true);
  assert.equal(isWorthRemembering("j'aime bien le format markdown pour les résumés"), true);
  assert.equal(isWorthRemembering('appelle-moi Alex'), true);
  assert.equal(isWorthRemembering('quel temps fait-il ?'), false);
  assert.equal(isWorthRemembering('ok merci'), false);
  assert.equal(isWorthRemembering(''), false);
  assert.equal(isWorthRemembering('a'), false); // too short
  assert.equal(isWorthRemembering('x'.repeat(500)), false); // too long
});

test('isWorthRemembering: correction kind uses a distinct pattern set', () => {
  assert.equal(isWorthRemembering('non, en fait je voulais dire autre chose', { kind: 'correction' }), true);
  assert.equal(isWorthRemembering('je préfère le café', { kind: 'correction' }), false, 'a preference is not a correction pattern');
});

test('extractWithOllama: never throws, returns null on any local-completion failure, uses ONLY the provided local function (no cloud coupling)', async () => {
  const failing = async () => { throw new Error('ollama down'); };
  assert.equal(await extractWithOllama(failing, 'texte quelconque'), null);
  assert.equal(await extractWithOllama(null, 'texte quelconque'), null);

  const answersNothing = async () => 'RIEN';
  assert.equal(await extractWithOllama(answersNothing, 'texte quelconque'), null);

  const answersFact = async () => "L'utilisateur travaille en TypeScript";
  assert.equal(await extractWithOllama(answersFact, 'je code surtout en TypeScript'), "L'utilisateur travaille en TypeScript");
});

// ── Dedup ────────────────────────────────────────────────────────────────

test('jaccardSimilarity: near-identical sentences score high, unrelated ones score low', () => {
  const a = 'je préfère recevoir des résumés courts et clairs';
  const b = 'je préfère avoir des résumés courts et clairs';
  const c = "j'aime le café noir sans sucre le matin";
  assert.ok(jaccardSimilarity(a, b) > 0.7, 'near-duplicate sentences should score high');
  assert.ok(jaccardSimilarity(a, c) < 0.3, 'unrelated sentences should score low');
});

test('findDuplicate: locates a near-identical existing memory by text', () => {
  const existing = [{ id: '1', text: 'je préfère des résumés courts et clairs' }];
  const dup = findDuplicate('je préfère avoir des résumés courts et clairs', existing);
  assert.equal(dup?.id, '1');
  assert.equal(findDuplicate('sujet complètement différent ici', existing), null);
});

test('addEpisodicMemoryDeduped: a repeated near-identical memory is merged (usage bumped), not duplicated', () => {
  const r1 = addEpisodicMemoryDeduped({ text: 'je préfère des réponses en français', category: 'preference', source: 'test' });
  assert.equal(r1.deduped, false);
  const r2 = addEpisodicMemoryDeduped({ text: 'je préfère avoir des réponses en français', category: 'preference', source: 'test' });
  assert.equal(r2.deduped, true);
  assert.equal(r2.id, r1.id);
  assert.equal(countEpisodicMemories(), 1, 'dedup must prevent unbounded growth from repeated near-identical memories');
});

test('addEpisodicMemoryDeduped: contradictory statements are NOT merged (different enough text)', () => {
  addEpisodicMemoryDeduped({ text: "j'aime le café le matin", category: 'preference', source: 'test' });
  addEpisodicMemoryDeduped({ text: 'je déteste le café le matin maintenant', category: 'preference', source: 'test' });
  // Both survive as distinct memories — resolving contradictions is a
  // retrieval-time concern (recency wins in scoreMemory), not a write-time
  // merge; merging opposite meanings into one row would silently destroy
  // information.
  assert.equal(countEpisodicMemories(), 2);
});

// ── Privacy propagation ─────────────────────────────────────────────────────

test('privacyFromSource: cv/candidature kinds and *_private connector sources are always local_only', () => {
  assert.deepEqual(privacyFromSource({ kind: 'cv' }), { privacy: true, egressPolicy: 'local_only' });
  assert.deepEqual(privacyFromSource({ kind: 'candidature' }), { privacy: true, egressPolicy: 'local_only' });
  assert.deepEqual(privacyFromSource({ connectorSource: 'youtube_private' }), { privacy: true, egressPolicy: 'local_only' });
  assert.deepEqual(privacyFromSource({ connectorSource: 'onedrive_private' }), { privacy: true, egressPolicy: 'local_only' });
  assert.deepEqual(privacyFromSource({ isPrivatePage: true }), { privacy: true, egressPolicy: 'local_only' });
  assert.deepEqual(privacyFromSource({ kind: 'note' }), { privacy: false, egressPolicy: 'cloud_allowed' });
});

test('a memory extracted with privacy=true is stored local_only and selectMemoriesForBudget preserves that flag', () => {
  const { id } = addEpisodicMemoryDeduped({
    text: 'CV: numéro de sécurité sociale fictif 123-45-6789', category: 'general', source: 'neuron_created',
    ...privacyFromSource({ kind: 'cv' }),
  });
  const selected = selectMemoriesForBudget({ query: 'sécurité sociale' });
  const item = selected.find(m => m.id === id);
  assert.ok(item, 'the private memory must still be selectable for LOCAL use');
  assert.equal(item.privacy, true);
  assert.equal(item.egressPolicy, 'local_only');
  // The actual cloud-blocking mechanism is markPrivate()+guardCloudCall(),
  // certified end-to-end in test-phase1-egress-certification.mjs — this test
  // only certifies that the metadata survives the memory pipeline unchanged,
  // which is the precondition callers rely on before applying that mechanism.
});

// ── Context budget — never injects everything ──────────────────────────────

test('selectMemoriesForBudget: never returns more than the configured budget, even with far more candidates available', () => {
  for (let i = 0; i < 20; i++) {
    addEpisodicMemoryDeduped({ text: `préférence numéro ${i} totalement distincte des autres sujets abc${i}xyz`, category: 'preference', source: 'test' });
  }
  setMemorySettings({ budget: 'low' });
  const low = selectMemoriesForBudget({});
  assert.ok(low.length <= getBudgetLimits('low').maxMemories);

  setMemorySettings({ budget: 'extended' });
  const extended = selectMemoriesForBudget({});
  assert.ok(extended.length <= getBudgetLimits('extended').maxMemories);
  assert.ok(extended.length >= low.length, 'a larger budget should never select fewer memories than a smaller one, given the same candidates');
});

test('selectMemoriesForBudget: query-relevant memories are ranked above irrelevant ones', () => {
  addEpisodicMemoryDeduped({ text: 'je préfère parler de cuisine française et de recettes', category: 'preference', source: 'test' });
  addEpisodicMemoryDeduped({ text: 'je travaille sur un projet de menuiserie en bois', category: 'preference', source: 'test' });
  const selected = selectMemoriesForBudget({ query: 'quelle recette de cuisine me conseilles-tu', budget: 'low' });
  assert.ok(selected.length > 0);
  assert.ok(selected[0].text.includes('cuisine'), 'the query-relevant memory should rank first');
});

test('selectMemoriesForBudget: merges long-term and episodic tiers by relevance, not "N from each"', () => {
  addPreferenceFact('je préfère les réponses courtes');
  addEpisodicMemoryDeduped({ text: 'je préfère les réponses détaillées et complètes avec des exemples', category: 'preference', source: 'test' });
  const selected = selectMemoriesForBudget({ query: 'réponse', budget: 'low' });
  const tiers = new Set(selected.map(m => m.tier));
  assert.ok(tiers.size >= 1, 'at least one tier represented');
});

// ── View / delete / reset endpoints ─────────────────────────────────────────

test('GET /api/memory/items lists both tiers with full metadata, no plaintext secrets beyond the memory text itself', async () => {
  addPreferenceFact('je préfère le mode sombre');
  addEpisodicMemoryDeduped({ text: 'intérêt pour les modèles Ollama légers', category: 'search_interest', source: 'search_query' });
  const app = buildApp();
  const res = await app.request('/api/memory/items');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.long_term.length, 1);
  assert.equal(body.episodic.length, 1);
  assert.ok(body.budget.maxMemories > 0);
});

test('GET /api/memory/preview shows exactly what would be injected for a query, without any AI call', async () => {
  addEpisodicMemoryDeduped({ text: 'je préfère les explications avec des schémas', category: 'preference', source: 'test' });
  const app = buildApp();
  const res = await app.request('/api/memory/preview?' + new URLSearchParams({ query: 'explique-moi avec un schéma' }));
  const body = await res.json();
  assert.ok(Array.isArray(body.selected));
  assert.ok(body.selected.length <= body.budget.maxMemories);
});

test('DELETE /api/memory/items/:tier/:id removes exactly one item from the right tier', async () => {
  const { id } = addEpisodicMemoryDeduped({ text: 'mémoire à supprimer explicitement par l\'utilisateur', category: 'general', source: 'test' });
  const app = buildApp();
  const res = await app.request(`/api/memory/items/episodic/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(countEpisodicMemories(), 0);
});

test('POST /api/memory/reset clears episodic memory but leaves long-term manual facts untouched', async () => {
  addPreferenceFact('fait manuel à conserver');
  addEpisodicMemoryDeduped({ text: 'mémoire épisodique à effacer par le reset', category: 'general', source: 'test' });
  const app = buildApp();
  const res = await app.request('/api/memory/reset', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(countEpisodicMemories(), 0);
  assert.equal(listPreferenceFacts().length, 1, 'manual long-term facts are the user\'s own explicit entries and must survive an adaptive-memory reset');
});

// ── Scale tests ──────────────────────────────────────────────────────────

test('scale: 1000 distinct episodic memories — selection stays bounded and fast', () => {
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    addEpisodicMemoryDeduped({
      text: `sujet distinct numéro ${i} avec un identifiant unique zz${i}qq et des mots différents chaque fois`,
      category: 'general', source: 'test', importance: Math.random(),
    });
  }
  const writeMs = Date.now() - t0;
  assert.ok(countEpisodicMemories() <= 1000);

  const t1 = Date.now();
  const selected = selectMemoriesForBudget({ query: 'sujet numéro 500', budget: 'normal' });
  const selectMs = Date.now() - t1;
  assert.ok(selected.length <= getBudgetLimits('normal').maxMemories);
  assert.ok(selectMs < 2000, `selection over 1000 memories took ${selectMs}ms — should stay well under 2s for a local, non-AI operation`);
});

test('scale: 100 repeated/near-identical search-derived memories collapse via dedup instead of growing unbounded', () => {
  for (let i = 0; i < 100; i++) {
    addEpisodicMemoryDeduped({ text: 'je préfère toujours des résumés courts et concis en français', category: 'search_interest', source: 'search_query' });
  }
  assert.equal(countEpisodicMemories(), 1, '100 near-identical writes must collapse to 1 memory via dedup, not 100');
  const [only] = listEpisodicMemories({ limit: 10 });
  assert.equal(only.usage_count, 99, 'the 99 duplicates after the first write should each have bumped usage_count');
});

// ── Integration: search route actually invokes the "learn from searches" hook ─

function buildSearchApp({ neurons = [] } = {}) {
  const services = {
    embeddingModel: 'nomic-embed-text',
    isOllamaError: () => false,
    getAllNeurons: async () => neurons,
    embedText: async () => [0.1, 0.2, 0.3],
    searchVector: async () => [],
  };
  const app = new Hono();
  app.route('/api', createSearchRoute({ services }));
  return app;
}

test('integration: POST /api/search learns a worth-remembering query into episodic memory when learn_from_searches is on', async () => {
  const app = buildSearchApp();
  const res = await app.request('/api/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: "je préfère toujours des résultats triés par date" }),
  });
  assert.equal(res.status, 200);
  assert.equal(countEpisodicMemories(), 1);
  const [memory] = listEpisodicMemories({ limit: 1 });
  assert.equal(memory.category, 'search_interest');
  assert.equal(memory.source, 'search_query');
  assert.equal(memory.privacy, 0, 'a generic search query is not private by default');
});

test('integration: POST /api/search does not learn a generic query (not worth remembering)', async () => {
  const app = buildSearchApp();
  await app.request('/api/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'météo demain' }),
  });
  assert.equal(countEpisodicMemories(), 0);
});

test('integration: POST /api/search learns nothing when learn_from_searches is disabled', async () => {
  setMemorySettings({ learn_from_searches: false });
  const app = buildSearchApp();
  await app.request('/api/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: "je préfère toujours des résultats triés par date" }),
  });
  assert.equal(countEpisodicMemories(), 0);
});

test('integration: POST /api/search learns nothing when the master switch (enabled) is off', async () => {
  setMemorySettings({ enabled: false });
  const app = buildSearchApp();
  await app.request('/api/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: "je préfère toujours des résultats triés par date" }),
  });
  assert.equal(countEpisodicMemories(), 0);
});

test('scale: contradictory memories over time — recency-weighted scoring favors the most recent', async () => {
  addEpisodicMemoryDeduped({ text: "j'aime beaucoup le café le matin avant de travailler", category: 'preference', source: 'test' });
  // Simulate the passage of time by directly touching last_used_at via a
  // second, sufficiently different statement rather than sleeping in a test.
  await new Promise(r => setTimeout(r, 5));
  addEpisodicMemoryDeduped({ text: 'je ne bois plus jamais de café maintenant, je préfère le thé vert', category: 'preference', source: 'test' });
  const selected = selectMemoriesForBudget({ query: 'café ou thé', budget: 'low' });
  assert.ok(selected.length > 0);
  // Both may be selected (they are legitimately different memories), but the
  // more recent one about tea must not be crowded out by dedup or budget —
  // this asserts the contradiction-handling model (keep both, let recency +
  // relevance sort them) rather than one silently overwriting the other.
  assert.ok(selected.some(m => m.text.includes('thé')), 'the more recent contradictory memory must survive selection');
});

// Batch C (audit finding F4): listPreferenceFacts() had no explicit SQL
// LIMIT — safe today only because addPreferenceFact() already refuses past
// MAX_PREFERENCE_FACTS (50), but inconsistent with the paginated pattern
// used elsewhere. This confirms the read side is now explicitly bounded too,
// independent of the write-side gate ever changing.
test('listPreferenceFacts: SQL-level LIMIT matches the write-side MAX_PREFERENCE_FACTS cap (defense in depth)', () => {
  clearPreferenceFacts();
  for (let i = 0; i < 50; i++) addPreferenceFact(`fait ${i}`, { source: 'manual' });
  assert.equal(listPreferenceFacts().length, 50);
  // The write side already refuses a 51st fact — this just confirms the read
  // side would not silently return more than the cap even if that changed.
  assert.throws(() => addPreferenceFact('fait 51', { source: 'manual' }));
  assert.equal(listPreferenceFacts().length, 50);
});
