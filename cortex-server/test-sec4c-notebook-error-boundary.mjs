// SEC-REMED-4C — focused regression for the frozen Notebook /ask error boundary.
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-sec4c-'));
const dbPath = path.join(tempRoot, 'notebook.db');
const lancePath = path.join(tempRoot, 'notebook.lance');
let notebookId;

before(() => {
  initSqlite(dbPath);
  notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: 'SEC-4C isolated Notebook' });
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
    env: { EMBEDDING_MODEL: 'fake-embed', ANSWER_MODEL: 'fake-answer', LANCEDB_PATH: lancePath },
    logger,
  }));
  return { app, logs };
}

async function ask(app) {
  const response = await app.request(`/api/notebooks/${notebookId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Trigger the isolated fake runtime.' }),
  });
  return { response, body: await response.json() };
}

function freshHostileError({ category = ErrorCategory.PROVIDER_UNAVAILABLE } = {}) {
  const canary = `DOCTEUR_NOTEBOOK_CERT_CANARY_${crypto.randomBytes(18).toString('hex')}`;
  const credentials = [
    `sk-proj-${crypto.randomBytes(24).toString('hex')}`,
    `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`,
    `sk-or-v1-${crypto.randomBytes(24).toString('hex')}`,
    `gsk_${crypto.randomBytes(24).toString('hex')}`,
    `bearer-${crypto.randomBytes(24).toString('hex')}`,
    `authorization-${crypto.randomBytes(24).toString('hex')}`,
    `query-${crypto.randomBytes(24).toString('hex')}`,
  ];
  const topLevel = [
    canary,
    `OpenAI key: ${credentials[0]}`,
    `Anthropic key: ${credentials[1]}`,
    `OpenRouter key: ${credentials[2]}`,
    `Groq key: ${credentials[3]}`,
    `Bearer ${credentials[4]}`,
    `Authorization: Bearer ${credentials[5]}`,
    `api_key=${credentials[6]}`,
    String.raw`C:\Users\alice\Private\notebook-secrets.txt`,
    'Error: provider exploded\n    at fakeProvider (C:\\private\\provider.js:41:9)',
    'Traceback (most recent call last):\n  File "C:\\private\\runtime.py", line 7',
    'SQLITE_ERROR: no such column: secret; SELECT secret FROM credentials',
    'provider body: {"error":{"message":"credential rejected"}}',
    'stderr: fatal runtime diagnostic',
  ];
  const nestedCause = `NESTED_CAUSE_${crypto.randomBytes(12).toString('hex')}`;
  const deepCause = `DEEP_NESTED_CAUSE_${crypto.randomBytes(12).toString('hex')}`;
  const responseData = `RESPONSE_DATA_${crypto.randomBytes(12).toString('hex')}`;
  const stderrField = `STDERR_DATA_${crypto.randomBytes(12).toString('hex')}`;
  const error = new Error(topLevel.join('\n'), {
    cause: new Error(nestedCause, { cause: new Error(deepCause) }),
  });
  error.response = { data: `${responseData}\nAuthorization: Bearer ${credentials[5]}` };
  error.stderr = `${stderrField}\n${String.raw`C:\Users\alice\Private\stderr.txt`}`;
  error.status = 502;
  if (category) error.category = category;
  return {
    error,
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
      'provider body:',
      'stderr:',
      nestedCause,
      deepCause,
      responseData,
      stderrField,
    ],
  };
}

function assertNoSensitiveText(text, sensitive, boundary) {
  for (const value of sensitive) assert.equal(text.includes(value), false, `${boundary} leaked ${value.slice(0, 32)}`);
}

test('Notebook /ask: provider/runtime text never reaches HTTP, logger, or persistence', async () => {
  const { error, sensitive } = freshHostileError();
  const { app, logs } = makeApp(error);
  const { response, body } = await ask(app);

  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: SAFE_RUNTIME_UNAVAILABLE_MESSAGE, code: 'MODEL_RUNTIME_UNAVAILABLE' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'NOTEBOOK_ASK_FAILED');
  assert.deepEqual(Object.keys(logs[0].fields).sort(), [
    'category', 'errorClass', 'errorCode', 'httpStatus', 'notebookId', 'operation', 'provider', 'sysCode',
  ]);
  assert.equal(logs[0].fields.errorCode, 'MODEL_RUNTIME_UNAVAILABLE');
  assert.equal(logs[0].fields.operation, 'notebook.ask');
  assert.equal(logs[0].fields.provider, 'ollama');

  assertNoSensitiveText(boundaryText(body), sensitive, 'HTTP');
  assertNoSensitiveText(boundaryText(logs), sensitive, 'logger');
  assertNoSensitiveText(persistedText(), sensitive, 'persistence');
});

test('Notebook /ask: an unknown exception gets a stable Notebook failure', async () => {
  const { error, sensitive } = freshHostileError({ category: null });
  const { app, logs } = makeApp(error);
  const { response, body } = await ask(app);

  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: 'La réponse du Notebook n’a pas pu être générée.', code: 'NOTEBOOK_ASK_FAILED' });
  assert.equal(logs[0].fields.errorCode, 'NOTEBOOK_ASK_FAILED');
  assertNoSensitiveText(boundaryText(body), sensitive, 'unknown HTTP');
  assertNoSensitiveText(boundaryText(logs), sensitive, 'unknown logger');
});

test('Notebook /ask: model unavailable keeps a safe useful semantic', async () => {
  const { error, sensitive } = freshHostileError({ category: ErrorCategory.MODEL_UNAVAILABLE });
  const { app, logs } = makeApp(error);
  const { response, body } = await ask(app);

  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: 'Le modèle local configuré n’est pas disponible.', code: 'MODEL_UNAVAILABLE' });
  assert.equal(logs[0].fields.errorCode, 'MODEL_UNAVAILABLE');
  assertNoSensitiveText(boundaryText(body), sensitive, 'model-unavailable HTTP');
  assertNoSensitiveText(boundaryText(logs), sensitive, 'model-unavailable logger');
});

test('Notebook /ask: trusted Docteur PublicError message is preserved', async () => {
  const trusted = new PublicError('NOTEBOOK_CANCELLED', 'Opération Notebook annulée.', { status: 409 });
  const { app, logs } = makeApp(trusted);
  const { response, body } = await ask(app);

  assert.equal(response.status, 409);
  assert.deepEqual(body, { error: 'Opération Notebook annulée.', code: 'NOTEBOOK_CANCELLED' });
  assert.equal(logs[0].fields.errorCode, 'NOTEBOOK_CANCELLED');
});
