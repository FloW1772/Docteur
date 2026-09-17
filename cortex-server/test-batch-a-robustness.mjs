// BATCH A — robustesse (findings d'audit F16, F17, F1). Corrections
// appliquées après autorisation explicite de l'utilisateur (2026-09-16).
//
// F16 : ?limit=abc (non numérique) provoquait un crash HTTP 500
//       ("datatype mismatch" SQLite) sur 5 routes au lieu d'un repli
//       gracieux sur la valeur par défaut.
// F17 : les erreurs OAuth des connecteurs renvoyaient le message brut du
//       fournisseur au client au lieu d'un message générique sanitisé.
// F1  : les appels fetch() des connecteurs OAuth n'avaient aucun timeout.
//
// Aucune clé réelle, aucune base réelle — mêmes garanties que les autres
// suites de cette mission (initSqlite(':memory:'), fetch mocké).
// Run: node --test test-batch-a-robustness.mjs
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Hono } from 'hono';

import { parseIntParam } from './src/lib/http-params.js';
import { initSqlite, createNotebook, setCloudKey } from './src/lib/sqlite.js';
import { createNotebookRoute } from './src/routes/notebook.js';
import { createMemoryRoute } from './src/routes/memory.js';
import { createSkillsRoute } from './src/routes/skills.js';
import { createPrivacyRoute } from './src/routes/privacy.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import { createConnectorsRoute } from './src/routes/connectors.js';

const TEST_DB = './data-test-batch-a/test.db';

before(() => {
  fs.rmSync('./data-test-batch-a', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

after(() => {
  try { fs.rmSync('./data-test-batch-a', { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── F16: parseIntParam unit coverage ────────────────────────────────────────

test('parseIntParam: valid numeric strings pass through unchanged', () => {
  assert.equal(parseIntParam('42', 100), 42);
  assert.equal(parseIntParam('0', 100), 0);
  assert.equal(parseIntParam('-5', 100), -5);
});

test('parseIntParam: missing/undefined falls back to the default', () => {
  assert.equal(parseIntParam(undefined, 100), 100);
});

test('parseIntParam: non-numeric string falls back to the default (the actual F16 bug) instead of propagating NaN', () => {
  assert.equal(parseIntParam('abc', 100), 100);
  assert.equal(parseIntParam('12abc', 100), 100); // Number() rejects partially-numeric strings too
  assert.equal(parseIntParam('NaN', 100), 100);
  assert.equal(parseIntParam(null, 100), 0, 'Number(null) is 0 (finite), not NaN — passes through, not a bug case');
  assert.equal(Number.isFinite(parseIntParam('abc', 100)), true, 'result must never be NaN/Infinity');
});

// ── F16: end-to-end — malformed limit no longer crashes any of the 5 routes ─

test('F16: GET /api/notebooks/:id/sources?limit=abc returns 200 with the default limit, never a 500 crash', async () => {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'Batch A test notebook' });
  const app = new Hono();
  app.route('/api', createNotebookRoute({ ollamaClient: {}, env: { EMBEDDING_MODEL: 'x', ANSWER_MODEL: 'y', LANCEDB_PATH: './data-test-batch-a/test.lance' }, logger: { info() {}, warn() {} } }));

  const res = await app.request(`/api/notebooks/${notebookId}/sources?limit=abc&offset=xyz`);
  assert.equal(res.status, 200, 'a malformed limit/offset must never crash the endpoint');
  const body = await res.json();
  assert.deepEqual(body.sources, []);
});

test('F16: GET /api/memory/items does not crash — no limit param used by this route, sanity check only', async () => {
  const app = new Hono();
  app.route('/api', createMemoryRoute({ logger: { info() {}, warn() {} } }));
  const res = await app.request('/api/memory/items');
  assert.equal(res.status, 200);
});

test('F16: GET /api/skills/:id/runs?limit=abc returns gracefully instead of a 500 crash', async () => {
  const app = new Hono();
  app.route('/api', createSkillsRoute({ services: {}, logger: { info() {}, warn() {} } }));
  // Create a real skill so we exercise the parseIntParam line itself
  // (an unknown id would 404 before ever reaching it).
  const createRes = await app.request('/api/skills', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Batch A test skill', instruction: 'test' }),
  });
  assert.equal(createRes.status, 201, 'test setup: skill creation must succeed to exercise the runs endpoint');
  const { skill } = await createRes.json();
  const res = await app.request(`/api/skills/${skill.id}/runs?limit=abc`);
  assert.equal(res.status, 200, 'a malformed limit must never crash /skills/:id/runs');
});

test('F16: GET /api/privacy/violations?limit=abc returns gracefully instead of a 500 crash', async () => {
  const app = new Hono();
  app.route('/api', createPrivacyRoute({ logger: { info() {}, warn() {}, error() {} } }));
  const res = await app.request('/api/privacy/violations?limit=abc');
  assert.equal(res.status, 200, 'a malformed limit must never crash /privacy/violations');
  const body = await res.json();
  assert.ok(Array.isArray(body.violations));
});

test('F16: GET /api/teacher/review/due?limit=abc returns gracefully instead of a 500 crash', async () => {
  const app = new Hono();
  app.route('/api', createTeacherRoute({ services: {}, ollamaClient: {}, logger: null }));
  const res = await app.request('/api/teacher/review/due?limit=abc');
  assert.equal(res.status, 200, 'a malformed limit must never crash /teacher/review/due');
  const body = await res.json();
  assert.ok(Array.isArray(body.items));
});

// ── F17: connector OAuth errors are sanitized before reaching the client ───

test('F17: a failed OAuth callback never leaks the raw provider error message to the HTTP response', async () => {
  const app = new Hono();
  app.route('/api', createConnectorsRoute({ services: {}, logger: { info() {}, warn() {} } }));

  const sensitiveMessage = 'internal debug: upstream=https://internal.example/secret?token=xyz789 request_id=abc123';

  // Configure client credentials and obtain a valid state via the real
  // auth-url endpoint so the callback's state check passes and we reach the
  // actual OAuth token-exchange code path (mocked fetch below).
  await app.request('/api/connectors/youtube/client-credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'fake-client-id', client_secret: 'fake-client-secret' }),
  });
  const authUrlRes = await app.request('/api/connectors/youtube/auth-url?redirect_uri=http://localhost:5173/oauth/youtube');
  const { state } = await authUrlRes.json();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: sensitiveMessage }), { status: 400 });
  try {
    const res = await app.request('/api/connectors/youtube/callback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'fake-code', state, redirect_uri: 'http://localhost:5173/oauth/youtube' }),
    });
    const body = await res.json();
    assert.equal(res.status, 502);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('internal.example'), false, 'raw provider error must never leak to the client');
    assert.equal(serialized.includes('token=xyz789'), false);
    assert.equal(serialized.includes('request_id'), false);
    assert.match(body.error, /Échec de la communication avec youtube/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── F1: connector fetch() calls now carry a timeout ─────────────────────────

// Matches only real invocations ("await fetch("), never a mention of the
// word in a comment (e.g. this file's own "every outbound fetch()" prose).
const FETCH_CALL_SPLIT_RE = /(?=\bawait fetch\()/;

test('F1: youtube-connector.js — every fetch() call site sets an AbortSignal.timeout', () => {
  const source = fs.readFileSync('./src/lib/connectors/youtube-connector.js', 'utf8');
  const fetchBlocks = source.split(FETCH_CALL_SPLIT_RE).slice(1);
  assert.ok(fetchBlocks.length >= 3, `expected at least 3 fetch() call sites, found ${fetchBlocks.length}`);
  for (const block of fetchBlocks) {
    const closingIdx = findMatchingParenEnd(block.slice('await '.length));
    const callText = block.slice(0, closingIdx + 'await '.length);
    assert.match(callText, /signal:\s*AbortSignal\.(?:timeout\(|any\(\[AbortSignal\.timeout\()/, `fetch() call missing a timeout signal: ${callText.slice(0, 80)}...`);
  }
});

test('F1: onedrive-connector.js — every fetch() call site sets an AbortSignal.timeout', async () => {
  const source = fs.readFileSync('./src/lib/connectors/onedrive-connector.js', 'utf8');
  const fetchBlocks = source.split(FETCH_CALL_SPLIT_RE).slice(1);
  assert.equal(fetchBlocks.length, 3, 'three direct API calls; file download is delegated to the shared helper');
  for (const block of fetchBlocks) {
    const closingIdx = findMatchingParenEnd(block.slice('await '.length));
    const callText = block.slice(0, closingIdx + 'await '.length);
    assert.match(callText, /signal:\s*AbortSignal\.(?:timeout\(|any\(\[AbortSignal\.timeout\()/, `fetch() call missing a timeout signal: ${callText.slice(0, 80)}...`);
  }
  // Exercise the fourth network path through the helper, and verify the
  // actual timeout passed to fetch rather than counting source mentions.
  const { downloadFileContent } = await import('./src/lib/connectors/onedrive-connector.js');
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const signal = new AbortController().signal;
  let calls = 0;
  AbortSignal.timeout = (ms) => { assert.equal(ms, 60_000); return signal; };
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.signal, signal);
    return new Response('bounded');
  };
  try {
    assert.equal(Buffer.from(await downloadFileContent('https://mock.invalid/file')).toString(), 'bounded');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

// Finds the index just past the closing parenthesis that matches the
// opening "fetch(" at the start of `text`, accounting for nested parens.
function findMatchingParenEnd(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

// ── Garde-fou : la suite OpenRouter reste intacte après Batch A ────────────

test('Batch A did not touch OpenRouter provider/fallback source files', () => {
  // Sanity re-check from this suite's own vantage point — the real proof is
  // running test-openrouter-regression.mjs + test-teacher-fallback.mjs
  // unmodified, which the Batch A checkpoint report does separately.
  const openrouterSource = fs.readFileSync('./src/lib/providers/openrouter.js', 'utf8');
  assert.match(openrouterSource, /FREE_MODEL = 'nvidia\/nemotron-3-super-120b-a12b:free'/);
  assert.match(openrouterSource, /réponse vide/);
});
