// Asserts cloudAiEnabled defaults false in a fresh config, and that no
// code path in monitor-report.js sends data externally when it's off —
// V1 implements no cloud send path at all (config field only, for
// future use). This test guards against that ever silently changing.
// Run with: node --test test-monitor-cloud-default-off.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite } from './src/lib/sqlite.js';
import { getMonitorSettings } from './src/lib/monitor-config.js';

const TEST_DB_DIR = './data-test-monitor-cloud-default-off';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('getMonitorSettings: cloudAiEnabled is false on a fresh install', () => {
  const settings = getMonitorSettings();
  assert.equal(settings.cloudAiEnabled, false);
});

test('monitor-report.js: source contains no fetch/https call to a non-local, non-Ollama endpoint', () => {
  const source = fs.readFileSync('./src/lib/monitor-report.js', 'utf8');
  // V1 implements no cloud-send path at all — the only network client
  // this file imports is the local Ollama client.
  assert.equal(/https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(source), false,
    'monitor-report.js must not reference any external URL — no cloud send path exists in V1');
  const importLines = source.split('\n').filter(l => l.trim().startsWith('import'));
  for (const line of importLines) {
    assert.doesNotMatch(line, /cloud|openai|anthropic|gemini/i, 'no cloud AI client is imported by the report generator');
  }
});

test('monitor-config.js: source never auto-sends on cloudAiEnabled toggle — it is stored only', () => {
  const source = fs.readFileSync('./src/lib/monitor-config.js', 'utf8');
  assert.doesNotMatch(source, /fetch\(|https?:\/\/(?!localhost|127\.0\.0\.1)/i);
});
