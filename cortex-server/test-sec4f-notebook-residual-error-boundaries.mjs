// SEC-REMED-4F — consolidated static boundary regression for the five Notebook residual sinks.
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const hostile = 'DOCTEUR_SEC4F_CANARY_OpenAI sk-test Authorization Bearer api_key= C:\\private\\secret.js SQLITE_ERROR SELECT secrets provider-body stderr';

test('SEC-4F export boundary: hostile error text cannot reach HTTP or logs', () => {
  const source = read('src/routes/notebook.js');
  assert.match(source, /toSafePublicError\(error,\s*\{[\s\S]*NOTEBOOK_EXPORT_FAILED/);
  assert.match(source, /safeErrorLogFields\(error,\s*\{[\s\S]*notebook\.export/);
  assert.doesNotMatch(source, /return c\.json\(\{ error: error\.message/);
  assert.doesNotMatch(source, new RegExp(hostile));
});

test('SEC-4F parser boundary: diagnostics are mapped to stable messages', () => {
  const source = read('src/routes/notebook-documents.js');
  assert.match(source, /IMPORT_ERROR_MESSAGES/);
  assert.match(source, /IMPORT_ERROR_MESSAGES\[code\]/);
  assert.doesNotMatch(source, /c\.json\(\{ error: err\.message/);
});

test('SEC-4F document job boundary: failed jobs return stable messages', () => {
  const source = read('src/lib/notebook-documents.js');
  assert.match(source, /safeImportFailureMessage\(code\)/);
  assert.doesNotMatch(source, /return \{[^\n]*message:\s*err\??\.message/);
});

test('SEC-4F AI-history setup and pipeline boundaries: both carriers are sanitized', () => {
  const source = read('src/lib/notebook-ai-history.js');
  assert.match(source, /safeImportMessage\(code\)/g);
  assert.doesNotMatch(source, /message:\s*e\??\.message/);
});

test('SEC-4F vector-purge control remains unchanged and logger-guarded', () => {
  const source = read('src/lib/notebook-documents.js');
  assert.match(source, /NOTEBOOK_DOC_VECTOR_PURGE_FAILED/);
  assert.match(source, /log\('warn', \{ code: 'INDEX_FAILED', error: err\.message \}/);
});