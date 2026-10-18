// SEC-REMED-4E — focused regression for the frozen Notebook document-ask error boundary.
// Uses only temporary stores, a fake local runtime, synthetic values and an in-memory logger.
import './test-setup.mjs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

import { createNotebook, getDatabase, initSqlite } from './src/lib/sqlite.js';
import { ErrorCategory } from './src/lib/provider-errors.js';
import { PublicError, SAFE_RUNTIME_UNAVAILABLE_MESSAGE } from './src/lib/safe-error-contract.js';
import { resetNotebookDocumentServiceForTests } from './src/lib/notebook-documents-runtime.js';
import { createNotebookDocumentsRoute } from './src/routes/notebook-documents.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-sec4e-'));
const dbPath = path.join(tempRoot, 'docask.db');
const lancePath = path.join(tempRoot, 'docask.lance');
const notebookId = crypto.randomUUID();
const DIM = 32;

function fakeEmbed(input) {
  const vector = new Array(DIM).fill(0);
  for (const token of String(input).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 0;
    for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % DIM] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

function makeApp(thrown) {
  resetNotebookDocumentServiceForTests();
  const logs = [];
  const fakeRuntime = {
    async embed({ input }) { return { embeddings: [fakeEmbed(input)] }; },
    async chat() {
      if (thrown !== undefined) throw thrown;
      return { message: { content: 'Réponse locale [1].' } };
    },
  };
  const app = new Hono();
  app.route('/api', createNotebookDocumentsRoute({
    ollamaClient: fakeRuntime,
    env: { EMBEDDING_MODEL: 'fake-embed', ANSWER_MODEL: 'fake-docask', LANCEDB_PATH: lancePath },
    logger: {
      info(fields, event) { logs.push({ level: 'info', fields, event }); },
      warn(fields, event) { logs.push({ level: 'warn', fields, event }); },
    },
  }));
  return { app, logs };
}

before(async () => {
  initSqlite(dbPath);
  createNotebook({ id: notebookId, title: 'SEC-4E isolated Notebook' });
  const { app } = makeApp();
  const response = await app.request(`/api/notebooks/${notebookId}/documents/import?wait=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'alpha beta facts',
      text: 'alpha beta gamma facts for the isolated document question',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'READY');
});

after(() => {
  resetNotebookDocumentServiceForTests();
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

async function docAsk(app) {
  const response = await app.request(`/api/notebooks/${notebookId}/doc-ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'alpha beta gamma facts' }),
  });
  return { response, body: await response.json() };
}

function freshHostileError({ category = ErrorCategory.PROVIDER_UNAVAILABLE } = {}) {
  const nonce = crypto.randomBytes(18).toString('hex');
  const canary = `DOCTEUR_NOTEBOOK_DOCASK_CANARY_${nonce}`;
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
  const lines = [
    canary,
    `OpenAI key: ${credentials[0]}`,
    `Anthropic key: ${credentials[1]}`,
    `OpenRouter key: ${credentials[2]}`,
    `Groq key: ${credentials[3]}`,
    `Bearer ${credentials[4]}`,
    `Authorization: Bearer ${credentials[5]}`,
    `api_key=${credentials[6]}`,
    String.raw`C:\Users\alice\Private\notebook-docask.txt`,
    'Error: provider exploded\n    at fakeProvider (C:\\private\\provider.js:41:9)',
    'Traceback (most recent call last):\n  File "C:\\private\\runtime.py", line 7',
    'SQLITE_ERROR: no such column: secret; SELECT secret FROM credentials',
    'provider response body: {"error":{"message":"credential rejected"}}',
    'stderr: fatal runtime diagnostic',
  ];
  const error = new Error(lines.join('\n'), { cause: new Error(nestedCause) });
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

function exposureCount(text, values) {
  return values.filter(value => text.includes(value)).length;
}

test('SEC-4E control: the legacy raw-message relay exposes the hostile fixture', () => {
  const { error, canary, credentials } = freshHostileError();
  const legacyHttp = boundaryText({ error: error.message });
  const legacyLog = boundaryText({ code: 'INDEX_FAILED', error: error.message });
  assert.equal(legacyHttp.includes(canary), true);
  assert.equal(legacyLog.includes(canary), true);
  assert.equal(credentials.filter(value => legacyHttp.includes(value)).length, 7);
  assert.equal(credentials.filter(value => legacyLog.includes(value)).length, 7);
});

test('Notebook doc-ask: provider/runtime text never reaches HTTP, logger, or persistence', async () => {
  const { error, canary, credentials, sensitive } = freshHostileError();
  const { app, logs } = makeApp(error);
  const { response, body } = await docAsk(app);
  const httpText = boundaryText(body);
  const loggerText = boundaryText(logs);
  const persistenceText = persistedText();

  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: SAFE_RUNTIME_UNAVAILABLE_MESSAGE, code: 'MODEL_RUNTIME_UNAVAILABLE' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'NOTEBOOK_DOC_ASK_FAILED');
  assert.deepEqual(Object.keys(logs[0].fields).sort(), [
    'category', 'errorCode', 'httpStatus', 'model', 'notebookId', 'operation', 'provider',
  ]);
  assert.equal(logs[0].fields.errorCode, 'MODEL_RUNTIME_UNAVAILABLE');
  assert.equal(logs[0].fields.operation, 'notebook.doc_ask');
  assert.equal(logs[0].fields.provider, 'ollama');
  assert.equal(logs[0].fields.model, 'fake-docask');

  assertNoSensitiveText(httpText, sensitive, 'HTTP');
  assertNoSensitiveText(loggerText, sensitive, 'logger');
  assertNoSensitiveText(persistenceText, sensitive, 'persistence');

  console.log('SEC-4E post-fix hostile probe', JSON.stringify({
    httpStatus: response.status,
    code: body.code,
    canaryExposure: {
      http: Number(httpText.includes(canary)),
      logger: Number(loggerText.includes(canary)),
      persistence: Number(persistenceText.includes(canary)),
    },
    credentialExposure: {
      http: exposureCount(httpText, credentials),
      logger: exposureCount(loggerText, credentials),
      persistence: exposureCount(persistenceText, credentials),
    },
    hostileMarkerExposure: {
      http: exposureCount(httpText, sensitive),
      logger: exposureCount(loggerText, sensitive),
      persistence: exposureCount(persistenceText, sensitive),
    },
    loggerFields: Object.keys(logs[0].fields).sort(),
  }));
});

test('Notebook doc-ask: an unknown exception gets a stable document-ask failure', async () => {
  const { error, sensitive } = freshHostileError({ category: null });
  const { app, logs } = makeApp(error);
  const { response, body } = await docAsk(app);

  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: 'La réponse documentaire du Notebook n’a pas pu être générée.', code: 'NOTEBOOK_DOC_ASK_FAILED' });
  assert.equal(logs[0].fields.errorCode, 'NOTEBOOK_DOC_ASK_FAILED');
  assertNoSensitiveText(boundaryText(body), sensitive, 'unknown HTTP');
  assertNoSensitiveText(boundaryText(logs), sensitive, 'unknown logger');
});

test('Notebook doc-ask: model unavailable keeps a safe useful semantic', async () => {
  const { error, sensitive } = freshHostileError({ category: ErrorCategory.MODEL_UNAVAILABLE });
  const { app, logs } = makeApp(error);
  const { response, body } = await docAsk(app);

  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: 'Le modèle local configuré n’est pas disponible.', code: 'MODEL_UNAVAILABLE' });
  assert.equal(logs[0].fields.errorCode, 'MODEL_UNAVAILABLE');
  assertNoSensitiveText(boundaryText(body), sensitive, 'model-unavailable HTTP');
  assertNoSensitiveText(boundaryText(logs), sensitive, 'model-unavailable logger');
});

test('Notebook doc-ask: trusted Docteur PublicError message is preserved', async () => {
  const trusted = new PublicError('NOTEBOOK_DOC_ASK_CANCELLED', 'Question documentaire annulée.', { status: 409 });
  const { app, logs } = makeApp(trusted);
  const { response, body } = await docAsk(app);

  assert.equal(response.status, 409);
  assert.deepEqual(body, { error: 'Question documentaire annulée.', code: 'NOTEBOOK_DOC_ASK_CANCELLED' });
  assert.equal(logs[0].fields.errorCode, 'NOTEBOOK_DOC_ASK_CANCELLED');
});
