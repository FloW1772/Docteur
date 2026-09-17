// PHASE 5B — NotebookLM (Google) preparation, NOT active. Certifies: saving
// a key makes ZERO network calls, the notebooklm_future provider always
// reports available:false, and no code path in routes/notebook.js can ever
// reach it (Ollama fallback never silently becomes a Google fallback).
// Run: node --test test-phase5b-notebooklm.mjs
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Hono } from 'hono';

import { initSqlite, createNotebook, addNotebookSource } from './src/lib/sqlite.js';
import { getSecret, deleteSecret } from './src/lib/secret-store.js';
import { upsertNeuron } from './src/lib/lancedb.js';
import { createNotebookLmRoute } from './src/routes/notebooklm.js';
import { createNotebookRoute } from './src/routes/notebook.js';
import { NOTEBOOK_PROVIDERS, assertNotebookProviderAvailable, NotebookProviderUnavailableError } from './src/lib/notebook-provider.js';

const TEST_SQLITE_DB = './data-test-notebooklm/test.db';
const TEST_LANCE_DB = './data-test-notebooklm/test.lance';

let fetchCallCount = 0;
let originalFetch;

before(() => {
  fs.rmSync('./data-test-notebooklm', { recursive: true, force: true });
  initSqlite(TEST_SQLITE_DB);
});

after(() => {
  try { fs.rmSync('./data-test-notebooklm', { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  deleteSecret('notebooklm_key');
  fetchCallCount = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCallCount++;
    throw new Error(`UNEXPECTED_NOTEBOOKLM_NETWORK_CALL: ${url}`);
  };
});

after(() => { globalThis.fetch = originalFetch; });

function buildApp() {
  const app = new Hono();
  app.route('/api', createNotebookLmRoute({ logger: { info() {}, warn() {} } }));
  return app;
}

// ── Provider abstraction ────────────────────────────────────────────────

test('NOTEBOOK_PROVIDERS: local is available, notebooklm_future is not (reason API_NOT_SUPPORTED)', () => {
  assert.equal(NOTEBOOK_PROVIDERS.local.available, true);
  assert.equal(NOTEBOOK_PROVIDERS.notebooklm_future.available, false);
  assert.equal(NOTEBOOK_PROVIDERS.notebooklm_future.reason, 'API_NOT_SUPPORTED');
});

test('assertNotebookProviderAvailable: throws NOTEBOOKLM_API_NOT_AVAILABLE for notebooklm_future, never silently proceeds', () => {
  assert.throws(() => assertNotebookProviderAvailable('notebooklm_future'), NotebookProviderUnavailableError);
  try {
    assertNotebookProviderAvailable('notebooklm_future');
    assert.fail('must throw');
  } catch (e) {
    assert.equal(e.code, 'NOTEBOOKLM_API_NOT_AVAILABLE');
  }
});

test('assertNotebookProviderAvailable: local provider does not throw', () => {
  assert.doesNotThrow(() => assertNotebookProviderAvailable('local'));
});

// ── Key storage — zero network calls, ever ──────────────────────────────

test('saving a NotebookLM key makes ZERO network calls', async () => {
  const app = buildApp();
  const res = await app.request('/api/notebooklm/key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'fake-notebooklm-api-key' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.key_configured, true);
  assert.equal(fetchCallCount, 0, 'saving a key must never trigger a network call');
  assert.equal(getSecret('notebooklm_key'), 'fake-notebooklm-api-key', 'key IS stored server-side via DPAPI');
});

test('GET /notebooklm/status reports key_configured without ever calling the network, and includes the "not active" notice', async () => {
  const app = buildApp();
  await app.request('/api/notebooklm/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'fake-key' }) });
  fetchCallCount = 0; // reset after the save call above

  const res = await app.request('/api/notebooklm/status');
  const body = await res.json();
  assert.equal(body.key_configured, true);
  assert.match(body.notice, /Aucun appel API NotebookLM n'est effectué actuellement/);
  assert.equal(fetchCallCount, 0);
});

test('deleting a NotebookLM key makes ZERO network calls and clears the stored secret', async () => {
  const app = buildApp();
  await app.request('/api/notebooklm/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'fake-key' }) });
  fetchCallCount = 0;

  const res = await app.request('/api/notebooklm/key', { method: 'DELETE' });
  const body = await res.json();
  assert.equal(body.key_configured, false);
  assert.equal(fetchCallCount, 0);
  assert.equal(getSecret('notebooklm_key'), null);
});

// ── Notebook route independence — a configured NotebookLM key changes nothing ─

test('a configured NotebookLM key has NO effect on routes/notebook.js — Q&A stays local and makes zero calls to any external endpoint', async () => {
  const app2 = buildApp();
  await app2.request('/api/notebooklm/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'fake-key' }) });
  fetchCallCount = 0;

  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Notebook test' });
  const neuronId = crypto.randomUUID();
  await upsertNeuron(TEST_LANCE_DB, { id: neuronId, kind: 'note', title: 'Article', content: 'Contenu de test.', metadata: {}, vector: new Array(16).fill(0.01) });
  addNotebookSource({ id: crypto.randomUUID(), notebookId, sourceId: neuronId, title: 'Article', privacy: false, egressPolicy: 'cloud_allowed' });

  const fakeOllamaClient = {
    embed: async () => ({ embeddings: [new Array(16).fill(0.01)] }),
    chat: async () => ({ message: { content: 'Réponse locale [1].' } }),
  };
  const notebookApp = new Hono();
  notebookApp.route('/api', createNotebookRoute({ ollamaClient: fakeOllamaClient, env: { EMBEDDING_MODEL: 'x', ANSWER_MODEL: 'y', LANCEDB_PATH: TEST_LANCE_DB }, logger: { info() {}, warn() {} } }));

  const res = await notebookApp.request(`/api/notebooks/${notebookId}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Question ?' }),
  });
  assert.equal(res.status, 200);
  assert.equal(fetchCallCount, 0, 'notebook Q&A must never touch the network, configured NotebookLM key or not');
});

// ── routes/notebook.js never imports anything NotebookLM-related ───────────

test('static check: routes/notebook.js never imports the NotebookLM route/provider module or calls a Google API', async () => {
  const source = fs.readFileSync('./src/routes/notebook.js', 'utf8');
  // The manual "Préparer pour NotebookLM" export endpoint legitimately
  // mentions NotebookLM by name (it produces a file a user could later
  // import there themselves) — what must never exist is an actual import
  // of the notebooklm route/provider module, or a Google API endpoint.
  assert.ok(!/from ['"].*notebooklm/i.test(source), 'routes/notebook.js must never import anything from a notebooklm module');
  assert.ok(!/googleapis\.com|generativelanguage/i.test(source), 'routes/notebook.js must not reference any Google API endpoint');
});
