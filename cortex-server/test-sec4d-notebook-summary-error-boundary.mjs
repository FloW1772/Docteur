// SEC-REMED-4D — focused regression for the frozen Notebook summary error boundary.
// Uses only a temporary SQLite store, a fake local runtime, synthetic values and an in-memory logger.
import './test-setup.mjs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

import {
  addNotebookSource,
  createNotebook,
  getDatabase,
  initSqlite,
} from './src/lib/sqlite.js';
import { ErrorCategory } from './src/lib/provider-errors.js';
import { PublicError, SAFE_RUNTIME_UNAVAILABLE_MESSAGE } from './src/lib/safe-error-contract.js';
import { createNotebookRoute } from './src/routes/notebook.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-sec4d-'));
const dbPath = path.join(tempRoot, 'summary.db');
const lancePath = path.join(tempRoot, 'summary.lance');
let notebookId;

before(() => {
  initSqlite(dbPath);
  notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'SEC-4D isolated Notebook' });
  addNotebookSource({
    id: crypto.randomUUID(),
    notebookId,
    sourceId: crypto.randomUUID(),
    title: 'Synthetic local source',
  });
});

after(() => {
  try { getDatabase()?.close(); } catch {}
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function boundaryText(value, seen = new Set()) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '';
  seen.add(value);
  return Object.entries(value).flatMap(([key, item]) => [key, boundaryText(item, seen)]).join('\n');
}

function persistedText() {
  const tables = getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  return tables.map(({ name }) => {
    try {
      const quoted = name.replaceAll('"', '""');
      return boundaryText(getDatabase().prepare(`SELECT * FROM "${quoted}"`).all());
    } catch {
      return '';
    }
  }).join('\n');
}

function makeApp(thrown) {
  const logs = [];
  const logger = {
    info(fields, event) { logs.push({ level: 'info', fields, event }); },
    warn(fields, event) { logs.push({ level: 'warn', fields, event }); },
  };
  const fakeRuntime = {
    async embed() { throw thrown; },
    async chat() { throw thrown; },
  };
  const app = new Hono();
  app.route('/api', createNotebookRoute({
    ollamaClient: fakeRuntime,
    env: { EMBEDDING_MODEL: 'fake-embed', ANSWER_MODEL: 'fake-summary', LANCEDB_PATH: lancePath },
    logger,
  }));
  return { app, logs };
}

async function summary(app) {
  const response = await app.request(`/api/notebooks/${notebookId}/summary`);
  return { response, body: await response.json() };
}

function freshHostileError({ category = ErrorCategory.PROVIDER_UNAVAILABLE } = {}) {
  const nonce = crypto.randomBytes(18).toString('hex');
  const canary = `DOCTEUR_NOTEBOOK_SUMMARY_CANARY_${nonce}`;
  const credentials = [
    `sk-proj-${crypto.randomBytes(24).toString('hex')}`,
    `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`,
    `sk-or-v1-${crypto.randomBytes(24).toString('hex')}`,
    `gsk_${crypto.randomBytes(24).toString('hex')}`,
    `bearer-${crypto.randomBytes(24).toString('hex')}`,
    `authorization-${crypto.randomBytes(24).toString('hex')}`,
    `query-${crypto.randomBytes(24).toString('hex')}`,
  ];
  const nestedCause = `NESTED_CAUSE_${nonce}`;
  const responseData = `RESPONSE_DATA_${nonce}`;
  const stderrData = `STDERR_DATA_${nonce}`;
  const topLevel = [
    canary,
    `OpenAI key: ${credentials[0]}`,
    `Anthropic key: ${credentials[1]}`,
    `OpenRouter key: ${credentials[2]}`,
    `Groq key: ${credentials[3]}`,
    `Bearer ${credentials[4]}`,
    `Authorization: Bearer ${credentials[5]}`,
    `api_key=${credentials[6]}`,
    String.raw`C:\Users\alice\Private\notebook-summary.txt`,
    'Error: provider exploded\n    at fakeProvider (C:\\private\\provider.js:41:9)',
    'Traceback (most recent call last):\n  File "C:\\private\\runtime.py", line 7',
    'SQLITE_ERROR: no such column: secret; SELECT secret FROM credentials',
    'provider response body: {"error":{"message":"credential rejected"}}',
    'stderr: fatal runtime diagnostic',
  ];
  const error = new Error(topLevel.join('\n'), { cause: new Error(nestedCause) });
  error.response = { data: `${responseData}\nAuthorization: Bearer ${credentials[5]}` };
  error.stderr = `${stderrData}\n${String.raw`C:\Users\alice\Private\stderr.txt`}`;
  error.status = 502;
  if (category) error.category = category;
  return {
    error,
    canary,
    credentials,
    sensitive: [
      canary,
      ...credentials,
      'Authorization: Bearer',
      'Bearer ',
      'api_key=',
      String.raw`C:\Users\alice\Private`,
      'at fakeProvider',
      'Traceback (most recent call last)',
      'SQLITE_ERROR',
      'SELECT secret',
      'provider response body:',
      'stderr:',
      nestedCause,
      responseData,
      stderrData,
    ],
  };
}

function assertNoSensitiveText(text, sensitive, boundary) {
  for (const value of sensitive) assert.equal(text.includes(value), false, `${boundary} leaked ${value.slice(0, 32)}`);
}

test('SEC-4D control: the legacy raw-message relay exposes the hostile fixture', () => {
  const { error, canary, credentials } = freshHostileError();
  const legacyHttp = boundaryText({ error: error.message });
  const legacyLog = boundaryText({ notebookId, error: error.message });
  assert.equal(legacyHttp.includes(canary), true);
  assert.equal(legacyLog.includes(canary), true);
  assert.equal(credentials.filter(value => legacyHttp.includes(value)).length, 7);
  assert.equal(credentials.filter(value => legacyLog.includes(value)).length, 7);
});

test('Notebook summary: provider/runtime text never reaches HTTP, logger, or persistence', async () => {
  const { error, sensitive } = freshHostileError();
  const { app, logs } = makeApp(error);
  const { response, body } = await summary(app);

  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: SAFE_RUNTIME_UNAVAILABLE_MESSAGE, code: 'MODEL_RUNTIME_UNAVAILABLE' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'NOTEBOOK_SUMMARY_FAILED');
  assert.deepEqual(Object.keys(logs[0].fields).sort(), [
    'category', 'errorCode', 'httpStatus', 'model', 'notebookId', 'operation', 'provider',
  ]);
  assert.equal(logs[0].fields.errorCode, 'MODEL_RUNTIME_UNAVAILABLE');
  assert.equal(logs[0].fields.operation, 'notebook.summary');
  assert.equal(logs[0].fields.provider, 'ollama');
  assert.equal(logs[0].fields.model, 'fake-summary');

  assertNoSensitiveText(boundaryText(body), sensitive, 'HTTP');
  assertNoSensitiveText(boundaryText(logs), sensitive, 'logger');
  assertNoSensitiveText(persistedText(), sensitive, 'persistence');
});

test('Notebook summary: an unknown exception gets a stable summary failure', async () => {
  const { error, sensitive } = freshHostileError({ category: null });
  const { app, logs } = makeApp(error);
  const { response, body } = await summary(app);

  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: 'Le résumé du Notebook n’a pas pu être généré.', code: 'NOTEBOOK_SUMMARY_FAILED' });
  assert.equal(logs[0].fields.errorCode, 'NOTEBOOK_SUMMARY_FAILED');
  assertNoSensitiveText(boundaryText(body), sensitive, 'unknown HTTP');
  assertNoSensitiveText(boundaryText(logs), sensitive, 'unknown logger');
});

test('Notebook summary: model unavailable keeps a safe useful semantic', async () => {
  const { error, sensitive } = freshHostileError({ category: ErrorCategory.MODEL_UNAVAILABLE });
  const { app, logs } = makeApp(error);
  const { response, body } = await summary(app);

  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: 'Le modèle local configuré n’est pas disponible.', code: 'MODEL_UNAVAILABLE' });
  assert.equal(logs[0].fields.errorCode, 'MODEL_UNAVAILABLE');
  assertNoSensitiveText(boundaryText(body), sensitive, 'model-unavailable HTTP');
  assertNoSensitiveText(boundaryText(logs), sensitive, 'model-unavailable logger');
});

test('Notebook summary: trusted Docteur PublicError message is preserved', async () => {
  const trusted = new PublicError('NOTEBOOK_SUMMARY_CANCELLED', 'Résumé Notebook annulé.', { status: 409 });
  const { app, logs } = makeApp(trusted);
  const { response, body } = await summary(app);

  assert.equal(response.status, 409);
  assert.deepEqual(body, { error: 'Résumé Notebook annulé.', code: 'NOTEBOOK_SUMMARY_CANCELLED' });
  assert.equal(logs[0].fields.errorCode, 'NOTEBOOK_SUMMARY_CANCELLED');
});
