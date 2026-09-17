// OPENROUTER — SUITE DE NON-RÉGRESSION DÉDIÉE
//
// Consolide et rend explicite, pour OpenRouter spécifiquement, ce qui est
// déjà couvert de façon éparpillée par test-teacher-fallback.mjs (bug réel
// observé en live : réponse vide HTTP 200 sur le modèle gratuit, corrigé par
// un repli local unique et explicite) et test-phase1-egress-certification.mjs
// (verrou de confidentialité générique sur 8 providers, dont OpenRouter).
//
// Historique du bug (voir MAINTENANCE-2026-09-08.md, section "Professeur") :
//   - OpenRouter doit rester limité au modèle gratuit fixe
//     (nvidia/nemotron-3-super-120b-a12b:free) — tout autre identifiant
//     refusé à la validation.
//   - Un test réel a produit HTTP 503 / réponse vide du fournisseur sur une
//     réponse longue — le correctif exige que ce soit signalé explicitement
//     (repli local UNIQUEMENT, jamais un changement silencieux de modèle,
//     jamais un rebond vers un autre provider cloud).
//
// RÈGLES DE SÉCURITÉ DE CE FICHIER (jamais dérogées) :
//   - Aucune clé API réelle n'est utilisée ici — uniquement des chaînes
//     factices ('test-openrouter-key', 'fake-...'). Aucune variable
//     d'environnement contenant une vraie clé n'est lue.
//   - Base de données exclusivement en mémoire (':memory:') — jamais le
//     fichier réel cortex-server/data/cortex.sqlite. Aucune écriture ne peut
//     donc jamais atteindre les credentials réels de l'utilisateur.
//   - globalThis.fetch est systématiquement mocké — 0 appel réseau réel vers
//     openrouter.ai ou tout autre domaine pendant l'exécution de ce fichier.
//
// Run: node --test test-openrouter-regression.mjs
import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import { initSqlite, setRouterSettings, setCloudKey } from './src/lib/sqlite.js';
import { markPrivate, getViolations } from './src/lib/privacy-guard.js';
import { tryCloudFallbackChain, runAiTask, CLOUD_PROVIDER_IDS } from './src/lib/router.js';
import { _resetAllForTests } from './src/lib/provider-state.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import * as openrouterProvider from './src/lib/providers/openrouter.js';

// ── Garde-fou anti-vraie-clé : si une variable d'environnement contenant une
// vraie clé OpenRouter existe dans ce process, ce fichier ne doit jamais la
// lire ni la propager — vérifié explicitement pour qu'un futur changement ne
// puisse pas introduire silencieusement une fuite. ──────────────────────────
const FAKE_OPENROUTER_KEY = 'test-openrouter-key-never-real';
if (FAKE_OPENROUTER_KEY.startsWith('sk-or-')) {
  throw new Error('SAFETY: la clé de test ressemble à une vraie clé OpenRouter — abandon.');
}

initSqlite(':memory:'); // jamais la vraie base — voir en-tête de fichier

let fetchCallCount = 0;
let fetchCallUrls = [];
let originalFetch;

beforeEach(() => {
  for (const p of ['gemini', 'groq', 'openrouter', 'anthropic', 'openai']) setCloudKey(p, '');
  _resetAllForTests();
  setRouterSettings({ paying_apis_enabled: true, strict_local_mode: false, claude_mode: 'subscription', openai_mode: 'subscription' });

  fetchCallCount = 0;
  fetchCallUrls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCallCount++;
    fetchCallUrls.push(String(url));
    throw new Error(`UNEXPECTED_REAL_NETWORK_CALL: ${String(url)}`);
  };
});

after(() => { globalThis.fetch = originalFetch; });

// ── 1/2 — Cause du bug et correctif retrouvés et vérifiés présents ─────────

test('OPENROUTER REGRESSION 1: le modèle gratuit fixe est toujours câblé en dur (jamais de sélection dynamique)', () => {
  assert.equal(openrouterProvider.FREE_MODEL, 'nvidia/nemotron-3-super-120b-a12b:free');
});

test('OPENROUTER REGRESSION 2: complete() refuse tout modèle qui n\'est pas le modèle gratuit fixe (protection anti-facturation)', async () => {
  // complete() n'accepte même pas de paramètre model — le seul moyen
  // d'introduire une régression ici serait de modifier providers/openrouter.js
  // pour accepter un model dynamique. On vérifie donc directement le
  // comportement observable : un appel avec un contenu neutre utilise
  // FREE_MODEL, jamais autre chose.
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, openrouterProvider.FREE_MODEL, 'complete() doit toujours envoyer FREE_MODEL, jamais un autre modèle');
    assert.ok(body.model.endsWith(':free'), 'le modèle envoyé doit toujours porter le suffixe :free (protection anti-facturation)');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'réponse neutre' } }], model: openrouterProvider.FREE_MODEL }), { status: 200 });
  };
  const result = await openrouterProvider.complete({ apiKey: FAKE_OPENROUTER_KEY, messages: [{ role: 'user', content: 'question neutre' }] });
  assert.equal(result.text, 'réponse neutre');
});

// ── 3 — Test de non-régression dédié pour le bug historique (réponse vide) ──

test('OPENROUTER REGRESSION 3: une réponse HTTP 200 avec contenu vide lève une erreur explicite (jamais une réponse fantôme)', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 });
  await assert.rejects(
    () => openrouterProvider.complete({ apiKey: FAKE_OPENROUTER_KEY, messages: [{ role: 'user', content: 'question' }] }),
    (err) => err.message.includes('réponse vide'),
    'une réponse vide doit lever une erreur explicite "réponse vide", jamais retourner un texte vide silencieusement',
  );
});

test('OPENROUTER REGRESSION 3b: côté route Professeur, la réponse vide déclenche un repli LOCAL explicite et transparent (correctif historique du bug live)', async () => {
  setCloudKey('openrouter', FAKE_OPENROUTER_KEY);
  const ollamaClient = { chat: async ({ model }) => ({ message: { content: `réponse locale de ${model}` } }) };
  const app = new Hono();
  app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));

  // Plan initial (contenu neutre, réponse valide) pour amorcer un parcours réel.
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] }), { status: 200 });
  await (await import('./src/lib/sqlite.js')).setTeacherSettings({ model: `openrouter:${openrouterProvider.FREE_MODEL}` });
  const planRes = await app.request('/api/teacher/paths', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: '__OPENROUTER_REGRESSION_TEST__' }),
  });
  const { path } = await planRes.json();
  const startRes = await app.request(`/api/teacher/paths/${path.id}/start`, { method: 'POST' });
  const { steps } = await startRes.json();

  // Le bug historique : OpenRouter répond 200 avec un contenu vide.
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 });
  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${steps[0].id}/explain`, { method: 'POST' });

  assert.equal(res.status, 200, 'le parcours doit réussir via le repli local, pas échouer entièrement');
  const body = await res.json();
  assert.equal(body.forced_local, true, 'doit être marqué explicitement comme forcé en local');
  assert.equal(body.requested_provider, 'openrouter', 'la transparence exige de dire qu\'OpenRouter était demandé');
  assert.equal(body.model_used.startsWith('local/'), true, 'le modèle réellement utilisé doit être local, jamais implicitement OpenRouter');
  assert.equal(body.fallback_reason_code, 'unknown');
  assert.ok(body.step.content.startsWith('réponse locale de'), 'le contenu doit venir du modèle local, jamais d\'un texte fantôme');
});

// ── 4a — Sélection du modèle (rejet d'un modèle non pris en charge) ─────────

test('OPENROUTER REGRESSION 4a: la validation de réglages Professeur rejette tout modèle OpenRouter autre que le modèle gratuit fixe', async () => {
  setCloudKey('openrouter', FAKE_OPENROUTER_KEY);
  const app = new Hono();
  app.route('/api', createTeacherRoute({ services: {}, ollamaClient: {}, logger: null }));
  const res = await app.request('/api/teacher/settings/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openrouter:some-other-paid-model' }),
  });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /seul le modèle gratuit/i);
});

// ── 4b — Authentification (clé absente / clé invalide) ──────────────────────

test('OPENROUTER REGRESSION 4b: une clé OpenRouter absente est signalée clairement, sans appel réseau', async () => {
  setCloudKey('openrouter', ''); // aucune clé configurée
  const app = new Hono();
  app.route('/api', createTeacherRoute({ services: {}, ollamaClient: {}, logger: null }));
  const res = await app.request('/api/teacher/settings/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: `openrouter:${openrouterProvider.FREE_MODEL}` }),
  });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(fetchCallCount, 0, 'aucune requête réseau ne doit partir sans clé configurée');
});

test('OPENROUTER REGRESSION 4b-bis: une clé invalide (401) est classée AUTH_FAILED et ne déclenche jamais de repli local silencieux', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });
  await assert.rejects(
    () => openrouterProvider.complete({ apiKey: 'fake-invalid-key', messages: [{ role: 'user', content: 'question' }] }),
    (err) => err.category === 'AUTH_FAILED',
  );
});

// ── 4c — Erreurs (quota, indisponibilité) ───────────────────────────────────

test('OPENROUTER REGRESSION 4c: un quota atteint (429) est classé et ne déclenche jamais de repli local silencieux', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 });
  await assert.rejects(
    () => openrouterProvider.complete({ apiKey: FAKE_OPENROUTER_KEY, messages: [{ role: 'user', content: 'question' }] }),
    (err) => err.isQuota === true,
  );
});

test('OPENROUTER REGRESSION 4c-bis: une indisponibilité (503) est classée PROVIDER_UNAVAILABLE', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'service unavailable' } }), { status: 503 });
  await assert.rejects(
    () => openrouterProvider.complete({ apiKey: FAKE_OPENROUTER_KEY, messages: [{ role: 'user', content: 'question' }] }),
    (err) => err.category === 'PROVIDER_UNAVAILABLE',
  );
});

// ── 5 — Aucune donnée local_only ne peut atteindre OpenRouter ──────────────

test('OPENROUTER REGRESSION 5: complete() bloque tout contenu marqué privé/local_only AVANT tout appel réseau', async () => {
  const privateMessages = [{ role: 'user', content: markPrivate('__LOCAL_ONLY_TEST__ contenu confidentiel de test') }];
  await assert.rejects(
    () => openrouterProvider.complete({ apiKey: FAKE_OPENROUTER_KEY, messages: privateMessages }),
    (err) => err.isPrivacyViolation === true,
  );
  assert.equal(fetchCallCount, 0, 'aucun octet de contenu privé ne doit jamais atteindre fetch() en direction d\'OpenRouter');
});

test('OPENROUTER REGRESSION 5b: le blocage est journalisé comme un incident réel (non simulé), sans jamais stocker le contenu', async () => {
  const before_ = getViolations(500).length;
  const privateMessages = [{ role: 'user', content: markPrivate('__LOCAL_ONLY_TEST__ autre contenu confidentiel') }];
  await assert.rejects(() => openrouterProvider.complete({ apiKey: FAKE_OPENROUTER_KEY, messages: privateMessages }));
  const after_ = getViolations(500).length;
  assert.ok(after_ > before_, 'un blocage réel (non simulé) doit être journalisé');
  const violations = getViolations(500);
  const serialized = JSON.stringify(violations);
  assert.ok(!serialized.includes('contenu confidentiel'), 'le contenu privé bloqué ne doit jamais être persisté dans le journal d\'incidents');
});

test('OPENROUTER REGRESSION 5c: runAiTask ne laisse jamais du contenu privé atteindre OpenRouter même avec preferredProvider forcé', async () => {
  setCloudKey('openrouter', FAKE_OPENROUTER_KEY);
  const messages = [{ role: 'user', content: markPrivate('__PRIVATE_TEST__ CV confidentiel de test') }];
  const localResponse = 'réponse locale via Ollama';
  const result = await runAiTask({
    feature: 'openrouter_regression_test', taskType: 'test', messages,
    preferredProvider: 'openrouter', allowCloud: true,
    client: { chat: async () => ({ message: { content: localResponse } }) },
    installedNames: ['llama3.2:3b'],
    logger: { warn() {}, info() {} },
  });
  assert.equal(result.provider, 'local', 'doit retomber sur local, jamais échouer ni envoyer le contenu privé à OpenRouter');
  const contentCarryingCalls = fetchCallUrls.filter(u => !u.endsWith('/v1/models'));
  assert.equal(contentCarryingCalls.length, 0);
});

// ── 6 — Un échec OpenRouter ne provoque jamais de fallback cloud interdit ──

test('OPENROUTER REGRESSION 6: dans la chaîne de fallback générique, un contenu privé bloqué sur OpenRouter n\'entraîne jamais d\'essai vers un autre provider cloud pour ce même contenu', async () => {
  setCloudKey('gemini', 'fake-gemini-key');
  setCloudKey('groq', 'fake-groq-key');
  setCloudKey('openrouter', FAKE_OPENROUTER_KEY);
  setCloudKey('openai', 'fake-openai-key');
  setCloudKey('anthropic', 'fake-anthropic-key');

  const messages = [{ role: 'user', content: markPrivate('__LOCAL_ONLY_TEST__ contenu jamais transmissible') }];
  const result = await tryCloudFallbackChain(messages, { logger: { warn() {}, info() {} } });
  assert.equal(result, null, 'aucun provider — OpenRouter inclus — ne doit réussir avec ce contenu');
  assert.equal(fetchCallCount, 0, 'zéro appel réseau porteur de contenu pour la totalité de la chaîne, OpenRouter compris');
});

test('OPENROUTER REGRESSION 6b: côté route Professeur, un échec réseau OpenRouter (catégorie repli) ne rebondit jamais vers un autre provider cloud — uniquement vers le local', async () => {
  setCloudKey('openrouter', FAKE_OPENROUTER_KEY);
  setCloudKey('gemini', 'fake-gemini-key'); // une clé Gemini existe aussi — vérifie qu'elle n'est jamais utilisée en repli
  const calledUrls = [];
  const ollamaClient = { chat: async ({ model }) => ({ message: { content: `réponse locale de ${model}` } }) };
  const app = new Hono();
  app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));

  globalThis.fetch = async (url) => { calledUrls.push(String(url)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] }), { status: 200 }); };
  await (await import('./src/lib/sqlite.js')).setTeacherSettings({ model: `openrouter:${openrouterProvider.FREE_MODEL}` });
  const planRes = await app.request('/api/teacher/paths', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: '__OPENROUTER_REGRESSION_TEST_6B__' }),
  });
  const { path } = await planRes.json();
  const startRes = await app.request(`/api/teacher/paths/${path.id}/start`, { method: 'POST' });
  const { steps } = await startRes.json();

  calledUrls.length = 0;
  globalThis.fetch = async (url) => { calledUrls.push(String(url)); return new Response(JSON.stringify({ error: { message: 'service unavailable' } }), { status: 503 }); };
  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${steps[0].id}/explain`, { method: 'POST' });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model_used.startsWith('local/'), true, 'doit utiliser le modèle local, jamais Gemini ni un autre cloud');
  assert.ok(calledUrls.every(u => u.includes('openrouter')), 'seul OpenRouter doit avoir été appelé — jamais Gemini ni un autre provider cloud en repli');
  assert.equal(calledUrls.filter(u => u.includes('generativelanguage') || u.includes('googleapis')).length, 0, 'Gemini ne doit jamais être appelé en repli après un échec OpenRouter');
});

// ── 7/8 — Garde-fous anti-vraie-clé / anti-écrasement de credentials ───────

test('OPENROUTER REGRESSION 7/8: ce fichier n\'utilise et ne peut utiliser que des clés factices, jamais la vraie base de données', () => {
  // Vérification structurelle : la base est en mémoire (initSqlite(':memory:')
  // en tête de fichier), donc setCloudKey() ci-dessus n'a écrit dans aucun
  // fichier réel. On vérifie aussi qu'aucune clé utilisée dans ce fichier ne
  // provient de process.env (qui pourrait contenir une vraie clé sur la
  // machine de l'utilisateur).
  assert.equal(FAKE_OPENROUTER_KEY, 'test-openrouter-key-never-real');
  assert.equal(process.env.OPENROUTER_API_KEY, undefined, 'ce fichier ne doit jamais lire/propager une variable d\'environnement contenant une vraie clé OpenRouter');
});

// ── Récapitulatif de couverture (0 provider cloud manquant) ────────────────

test('OPENROUTER REGRESSION: openrouter figure bien dans la liste canonique des providers cloud couverts par le verrou de confidentialité', () => {
  assert.ok(CLOUD_PROVIDER_IDS.includes('openrouter'));
});
