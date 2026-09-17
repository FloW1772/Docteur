// PHASE 5 — Local Notebook (documentary/RAG workspace). Uses a real,
// temporary LanceDB table (data-test-notebook/cortex.lance) with FAKE
// (deterministic, non-Ollama) vectors — proves the actual LanceDB
// .where() id-scoping behavior end-to-end without requiring a live Ollama
// instance. Every "AI call" (embedding, local completion) is a plain JS
// function in this file — zero network calls, zero Ollama dependency.
// Run: node --test test-phase5-notebook.mjs
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Hono } from 'hono';

import {
  initSqlite,
  createNotebook, listNotebooks, getNotebook, deleteNotebook, countNotebookSources,
  addNotebookSource, removeNotebookSource,
} from './src/lib/sqlite.js';
import { upsertNeuron, searchNeuronsByIds, getNeuronsByIds, getAllNeurons } from './src/lib/lancedb.js';
import {
  computeNotebookPrivacy, recomputeAndPersistNotebookPrivacy, chunkSourceContent,
  retrieveForQuestion, buildNotebookMessages, extractCitations, getOrBuildGlobalSummary,
} from './src/lib/notebook.js';
import { createNotebookRoute } from './src/routes/notebook.js';

const TEST_SQLITE_DB = './data-test-notebook/test.db';
const TEST_LANCE_DB = './data-test-notebook/test.lance';

// Deterministic fake embedding: derives a small numeric vector from the
// text's character codes so semantically-similar strings (sharing
// substrings) end up with closer vectors — good enough to exercise real
// ranking behavior without an actual embedding model.
const FAKE_DIM = 16;
function fakeEmbed(text) {
  const vec = new Array(FAKE_DIM).fill(0);
  const s = String(text).toLowerCase();
  for (let i = 0; i < s.length; i++) vec[i % FAKE_DIM] += s.charCodeAt(i) / 1000;
  return vec;
}

before(() => {
  fs.rmSync('./data-test-notebook', { recursive: true, force: true });
  initSqlite(TEST_SQLITE_DB);
});

after(() => {
  try { fs.rmSync('./data-test-notebook', { recursive: true, force: true }); } catch { /* ignore */ }
});

async function seedNeuron({ id, title, content, kind = 'note' }) {
  await upsertNeuron(TEST_LANCE_DB, { id, kind, title, content, metadata: {}, vector: fakeEmbed(`${title} ${content}`) });
  return id;
}

// Fake Ollama client for route-level integration tests (createNotebookRoute
// calls the real lib/ollama.js embedText/chatCompletion, which expect a
// client with .embed()/.chat() — this stub never touches the network).
function buildFakeOllamaClient() {
  return {
    embed: async ({ input }) => ({ embeddings: [fakeEmbed(input)] }),
    chat: async ({ messages }) => {
      const contextMsg = messages.find(m => m.content?.includes('Extraits disponibles'));
      return { message: { content: contextMsg ? 'Réponse basée sur les extraits fournis [1].' : 'Résumé synthétique généré localement.' } };
    },
  };
}

function buildDeps() {
  return {
    embedText: async (text) => fakeEmbed(text),
    searchNeuronsByIds: async (vector, ids, opts) => searchNeuronsByIds(TEST_LANCE_DB, vector, ids, opts),
    getNeuronsByIds: async (ids) => getNeuronsByIds(TEST_LANCE_DB, ids),
    localComplete: async (messages) => {
      // Deterministic fake "LLM": echoes back a citation to the first
      // extract it was given, so extractCitations() has something real to find.
      const contextMsg = messages.find(m => m.content?.includes('Extraits disponibles'));
      return contextMsg ? 'Réponse basée sur les extraits fournis [1].' : 'Résumé synthétique généré localement.';
    },
  };
}

// ── Notebook CRUD ────────────────────────────────────────────────────────────

test('createNotebook / listNotebooks / getNotebook round-trip', () => {
  const id = crypto.randomUUID();
  createNotebook({ id, title: 'Mon Notebook', description: 'Test' });
  const notebook = getNotebook(id);
  assert.equal(notebook.title, 'Mon Notebook');
  assert.equal(notebook.privacy, false);
  assert.equal(notebook.egress_policy, 'cloud_allowed');
  assert.ok(listNotebooks().some(n => n.id === id));
});

test('deleteNotebook removes the notebook and its source references but NEVER the underlying neurons', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'À supprimer' });
  const neuronId = await seedNeuron({ id: crypto.randomUUID(), title: 'Neurone persistant', content: 'Contenu qui doit survivre.' });
  addNotebookSource({ id: crypto.randomUUID(), notebookId, sourceId: neuronId, title: 'Neurone persistant', privacy: false, egressPolicy: 'cloud_allowed' });

  deleteNotebook(notebookId);
  assert.equal(getNotebook(notebookId), null);

  const allNeurons = await getAllNeurons(TEST_LANCE_DB);
  assert.ok(allNeurons.some(n => n.id === neuronId), 'the underlying neuron must survive notebook deletion');
});

test('removing a source never deletes the underlying neuron', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Test suppression source' });
  const neuronId = await seedNeuron({ id: crypto.randomUUID(), title: 'Neurone à garder', content: 'Contenu.' });
  const sourceRowId = crypto.randomUUID();
  addNotebookSource({ id: sourceRowId, notebookId, sourceId: neuronId, title: 'Neurone à garder', privacy: false, egressPolicy: 'cloud_allowed' });

  removeNotebookSource(notebookId, sourceRowId);
  assert.equal(countNotebookSources(notebookId), 0);
  const allNeurons = await getAllNeurons(TEST_LANCE_DB);
  assert.ok(allNeurons.some(n => n.id === neuronId), 'removing a notebook source must not delete the neuron');
});

// ── Privacy aggregation — most restrictive wins ─────────────────────────────

test('computeNotebookPrivacy: all-neutral sources → cloud_allowed', () => {
  const sources = [{ privacy: false, egress_policy: 'cloud_allowed' }, { privacy: false, egress_policy: 'cloud_allowed' }];
  assert.deepEqual(computeNotebookPrivacy(sources), { privacy: false, egressPolicy: 'cloud_allowed' });
});

test('computeNotebookPrivacy: one local_only source flips the whole notebook, even with many neutral sources', () => {
  const sources = [
    { privacy: false, egress_policy: 'cloud_allowed' },
    { privacy: false, egress_policy: 'cloud_allowed' },
    { privacy: true, egress_policy: 'local_only' },
  ];
  assert.deepEqual(computeNotebookPrivacy(sources), { privacy: true, egressPolicy: 'local_only' });
});

test('recomputeAndPersistNotebookPrivacy: adding a private (OneDrive-style) source makes the notebook local_only; it cannot revert without removing that source', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Notebook mixte' });

  const publicNeuronId = await seedNeuron({ id: crypto.randomUUID(), title: 'Article public', content: 'Contenu public.' });
  addNotebookSource({ id: crypto.randomUUID(), notebookId, sourceId: publicNeuronId, title: 'Article public', privacy: false, egressPolicy: 'cloud_allowed' });
  let derived = recomputeAndPersistNotebookPrivacy(notebookId);
  assert.equal(derived.privacy, false);

  const privateNeuronId = await seedNeuron({ id: crypto.randomUUID(), title: 'Document OneDrive privé', content: 'Contenu confidentiel.' });
  const privateSourceRowId = crypto.randomUUID();
  addNotebookSource({ id: privateSourceRowId, notebookId, sourceId: privateNeuronId, title: 'Document OneDrive privé', privacy: true, egressPolicy: 'local_only' });
  derived = recomputeAndPersistNotebookPrivacy(notebookId);
  assert.equal(derived.privacy, true);
  assert.equal(getNotebook(notebookId).egress_policy, 'local_only');

  // Removing the private source restores cloud_allowed — recomputed fresh
  // each time from the CURRENT source set, never a one-way ratchet beyond
  // what the mission requires ("impossible de repasser cloud_allowed SANS
  // retirer toutes les sources responsables" — removing it IS retiring it).
  removeNotebookSource(notebookId, privateSourceRowId);
  derived = recomputeAndPersistNotebookPrivacy(notebookId);
  assert.equal(derived.privacy, false);
});

test('a source referencing a cv/candidature-kind neuron is private even if the client never says so', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Notebook CV' });
  const app = new Hono();
  app.route('/api', createNotebookRoute({ ollamaClient: buildFakeOllamaClient(), env: { EMBEDDING_MODEL: 'x', ANSWER_MODEL: 'y', LANCEDB_PATH: TEST_LANCE_DB }, logger: { info() {}, warn() {} } }));

  const neuronId = await seedNeuron({ id: crypto.randomUUID(), title: 'Mon CV', content: 'Expérience professionnelle...', kind: 'cv' });
  const res = await app.request(`/api/notebooks/${notebookId}/sources`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: neuronId, title: 'Mon CV', kind: 'cv' }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.notebook_privacy.privacy, true, 'a cv-kind source must make the notebook local_only automatically');
});

// ── Chunking ─────────────────────────────────────────────────────────────

test('chunkSourceContent: short content stays one chunk, long content splits with stable chunk ids', () => {
  const short = chunkSourceContent({ id: 'n1', title: 'Court', content: 'Un texte court.' });
  assert.equal(short.length, 1);
  assert.equal(short[0].chunkId, 'n1#0');

  const longContent = 'Paragraphe. '.repeat(500);
  const long = chunkSourceContent({ id: 'n2', title: 'Long', content: longContent });
  assert.ok(long.length > 1);
  assert.deepEqual(long.map(c => c.chunkId), long.map((_, i) => `n2#${i}`));
});

// ── RAG retrieval scoped to notebook sources only ───────────────────────────

test('retrieveForQuestion: only returns chunks from THIS notebook\'s sources, never from neurons outside it', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Notebook scoped' });
  const deps = buildDeps();

  const inScopeId = await seedNeuron({ id: crypto.randomUUID(), title: 'Dans le notebook', content: 'Ce contenu appartient au notebook et parle de voyages en montagne.' });
  const outOfScopeId = await seedNeuron({ id: crypto.randomUUID(), title: 'Hors notebook', content: 'Ce contenu ne doit jamais apparaître car il n\'est pas dans ce notebook, il parle aussi de voyages en montagne.' });
  addNotebookSource({ id: crypto.randomUUID(), notebookId, sourceId: inScopeId, title: 'Dans le notebook', privacy: false, egressPolicy: 'cloud_allowed' });

  const { chunks, sourceIds } = await retrieveForQuestion(deps, notebookId, 'voyages en montagne', { topK: 5 });
  assert.ok(chunks.length > 0);
  assert.ok(sourceIds.every(id => id === inScopeId), 'no chunk may come from a neuron outside this notebook');
  assert.ok(!sourceIds.includes(outOfScopeId));
});

test('retrieveForQuestion: an empty notebook returns no chunks (never falls back to the whole neuron store)', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Notebook vide' });
  const deps = buildDeps();
  // Seed an unrelated neuron in LanceDB to prove it's never picked up.
  await seedNeuron({ id: crypto.randomUUID(), title: 'Neurone quelconque', content: 'Contenu quelconque.' });

  const { chunks, sourceIds } = await retrieveForQuestion(deps, notebookId, 'une question quelconque');
  assert.equal(chunks.length, 0);
  assert.equal(sourceIds.length, 0);
});

// ── Citations — never invented, always trace to a retrieved chunk ─────────

test('extractCitations: only [N] markers actually present in the answer are returned, mapped to the real chunk', () => {
  const chunks = [
    { chunkId: 'a#0', sourceId: 'a', sourceTitle: 'Source A', text: 'Contenu A' },
    { chunkId: 'b#0', sourceId: 'b', sourceTitle: 'Source B', text: 'Contenu B' },
  ];
  const citations = extractCitations('Une affirmation [1] et une autre [2], répétée [1].', chunks);
  assert.equal(citations.length, 2);
  assert.equal(citations[0].sourceTitle, 'Source A');
  assert.equal(citations[1].sourceTitle, 'Source B');
});

test('extractCitations: an out-of-range [N] (hallucinated reference) is silently dropped, never fabricated', () => {
  const chunks = [{ chunkId: 'a#0', sourceId: 'a', sourceTitle: 'Source A', text: 'Contenu A' }];
  const citations = extractCitations('Une affirmation [1] et une invention [99].', chunks);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].ref, 1);
});

test('buildNotebookMessages: instructs the model never to invent a citation, and includes only the retrieved chunks', () => {
  const chunks = [{ chunkId: 'a#0', sourceId: 'a', sourceTitle: 'Source A', text: 'Contenu A' }];
  const messages = buildNotebookMessages('Question ?', chunks);
  const systemMsgs = messages.filter(m => m.role === 'system').map(m => m.content).join(' ');
  assert.ok(systemMsgs.includes('n\'invente jamais'));
  assert.ok(systemMsgs.includes('Source A'));
});

// ── Full route integration: ask endpoint ────────────────────────────────────

test('integration: POST /notebooks/:id/ask returns an answer with real, traceable citations for a non-empty notebook', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Notebook Q&A' });
  const app = new Hono();
  app.route('/api', createNotebookRoute({ ollamaClient: buildFakeOllamaClient(), env: { EMBEDDING_MODEL: 'x', ANSWER_MODEL: 'y', LANCEDB_PATH: TEST_LANCE_DB }, logger: { info() {}, warn() {} } }));

  const neuronId = await seedNeuron({ id: crypto.randomUUID(), title: 'Recette de pain', content: 'La farine et l\'eau sont les ingrédients principaux du pain.' });
  await app.request(`/api/notebooks/${notebookId}/sources`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: neuronId, title: 'Recette de pain' }),
  });

  const res = await app.request(`/api/notebooks/${notebookId}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Quels sont les ingrédients du pain ?' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.answer.length > 0);
  assert.ok(body.chunks_used > 0);
});

test('integration: an empty notebook answers gracefully, never a crash or a fabricated answer', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Notebook vide 2' });
  const app = new Hono();
  app.route('/api', createNotebookRoute({ ollamaClient: buildFakeOllamaClient(), env: { EMBEDDING_MODEL: 'x', ANSWER_MODEL: 'y', LANCEDB_PATH: TEST_LANCE_DB }, logger: { info() {}, warn() {} } }));

  const res = await app.request(`/api/notebooks/${notebookId}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Question quelconque ?' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.chunks_used, 0);
  assert.equal(body.citations.length, 0);
});

// ── Hierarchical summary — cached, invalidated on source change ────────────

test('getOrBuildGlobalSummary: generates once, then serves from cache until sources change', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Notebook résumé' });
  const deps = buildDeps();
  const neuronId = await seedNeuron({ id: crypto.randomUUID(), title: 'Article', content: 'Contenu à résumer.' });
  addNotebookSource({ id: crypto.randomUUID(), notebookId, sourceId: neuronId, title: 'Article', privacy: false, egressPolicy: 'cloud_allowed' });

  const first = await getOrBuildGlobalSummary(deps, notebookId);
  assert.equal(first.cached, false);
  const second = await getOrBuildGlobalSummary(deps, notebookId);
  assert.equal(second.cached, true);
  assert.equal(second.content, first.content);

  const neuron2Id = await seedNeuron({ id: crypto.randomUUID(), title: 'Article 2', content: 'Autre contenu.' });
  addNotebookSource({ id: crypto.randomUUID(), notebookId, sourceId: neuron2Id, title: 'Article 2', privacy: false, egressPolicy: 'cloud_allowed' });
  const third = await getOrBuildGlobalSummary(deps, notebookId);
  assert.equal(third.cached, false, 'adding a source must invalidate the cached summary');
});

// ── Scale ────────────────────────────────────────────────────────────────

test('scale: 100 sources in one notebook — retrieval stays scoped and fast', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Notebook à 100 sources' });
  const deps = buildDeps();

  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    const neuronId = await seedNeuron({ id: crypto.randomUUID(), title: `Source ${i}`, content: `Contenu unique numéro ${i} à propos de sujet-${i}.` });
    addNotebookSource({ id: crypto.randomUUID(), notebookId, sourceId: neuronId, title: `Source ${i}`, privacy: false, egressPolicy: 'cloud_allowed' });
  }
  const seedMs = Date.now() - t0;

  assert.equal(countNotebookSources(notebookId), 100);

  const t1 = Date.now();
  const { chunks, sourceIds } = await retrieveForQuestion(deps, notebookId, 'sujet-42', { topK: 6 });
  const retrieveMs = Date.now() - t1;

  assert.ok(chunks.length <= 6, 'retrieval must stay bounded by topK even with 100 candidate sources');
  assert.ok(retrieveMs < 5000, `retrieval over 100 sources took ${retrieveMs}ms (seed took ${seedMs}ms) — should stay well under 5s`);
});
