// [MASTER WS1] Regression: the logger must never mutate the object it is given, and must not crash on a frozen one.
// Root cause of the Recorder fresh-boot bug (RECORDER_UNAVAILABLE): recorderService.recoverAfterRestart() returns
// Object.freeze(summary); server.js does logger.info(summary, 'recorder ready'); the logger's deepRedact scrubber
// used to assign back into the object (value[k] = ...), which throws on a frozen input and disabled the Recorder.
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, redactSecrets } from './src/lib/logger.js';

const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-logger-')), 'cortex.log');
const readLog = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const settle = () => new Promise(r => setTimeout(r, 120));

test('logger does not throw on a frozen flat object (the Recorder recover shape)', async () => {
  const logger = createLogger({ level: 'info', logFile: tmpLog() });
  const frozen = Object.freeze({ flagged: 0, recovered: 0, missing: 0, emptyRemoved: 0, orphanFiles: 2, deleting: 0 });
  assert.doesNotThrow(() => logger.info(frozen, 'recorder ready'));
});

test('logger does not throw on a nested frozen object', async () => {
  const logger = createLogger({ level: 'info', logFile: tmpLog() });
  assert.doesNotThrow(() => logger.info({ recovered: Object.freeze({ flagged: 0 }), list: Object.freeze([Object.freeze({ a: 1 })]) }, 'nested'));
});

test('logger never mutates the caller object (frozen or not)', async () => {
  const logger = createLogger({ level: 'info', logFile: tmpLog() });
  const plain = { apiKey: 'sk-ant-REDACTME0123456789abcdef', nested: { token: 'Bearer REDACTME0123456789' }, msg: 'free text sk-proj-REDACTME0123456789' };
  const snapshot = JSON.stringify(plain);
  logger.info(plain, 'secret');
  assert.equal(JSON.stringify(plain), snapshot, 'the logged object must be unchanged after logging');
});

test('redaction still fires after the copy fix (path-based + free-text regex)', async () => {
  const lf = tmpLog();
  const logger = createLogger({ level: 'info', logFile: lf });
  logger.info({ apiKey: 'sk-ant-REDACTME0123456789abcdef', note: 'token sk-proj-REDACTME0123456789 inside' }, 'r');
  await settle();
  const out = readLog(lf);
  assert.ok(!out.includes('sk-ant-REDACTME'), 'path-based key must be redacted');
  assert.ok(!out.includes('sk-proj-REDACTME'), 'free-text secret must be redacted');
  assert.ok(out.includes('[REDACTED]'), 'a redaction placeholder must be present');
});

test('redactSecrets is unchanged for a plain string', () => {
  assert.equal(redactSecrets('hello sk-proj-REDACTME0123456789 world').includes('sk-proj-REDACTME'), false);
  assert.equal(redactSecrets(42), 42);
});
