// C2 — the historical adaptive memory (lib/memory.js) no longer learns on its own: learn_from_searches,
// learn_from_neurons and learn_from_corrections are off until the user turns them on, and only the boolean `true`
// turns them on. Already stored memories are never deleted by this change.
// Run: node --test test-c2-memory-learning-opt-in.mjs
//
// Isolation: temporary databases only (never the real one), routes mounted on a bare Hono app (no server started),
// stubbed embedding / vector services (no Ollama, no network).
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { initSqlite, getDatabase, setMeta, getMeta, countEpisodicMemories, listEpisodicMemories } from './src/lib/sqlite.js';
import { getMemorySettings, setMemorySettings, addEpisodicMemoryDeduped, resetAdaptiveMemory } from './src/lib/memory.js';
import { createMemoryRoute } from './src/routes/memory.js';
import { createSearchRoute } from './src/routes/search.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-c2-'));
const LEARN = ['learn_from_searches', 'learn_from_neurons', 'learn_from_corrections'];
const WORTHY = 'je préfère toujours des résultats triés par date';
const NOT_TRUE = ['true', 'yes', 1, {}, [], 'false', 0, null];
const label = (v) => JSON.stringify(v);

function searchApp() {
  const services = {
    embeddingModel: 'nomic-embed-text', isOllamaError: () => false,
    getAllNeurons: async () => [], embedText: async () => [0.1, 0.2, 0.3], searchVector: async () => [],
  };
  const app = new Hono();
  app.route('/api', createSearchRoute({ services }));
  return app;
}
const search = (query = WORTHY) => searchApp().request('/api/search', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
});
function memoryApp() {
  const app = new Hono();
  app.route('/api', createMemoryRoute({ logger: { info() {}, warn() {}, error() {} } }));
  return app;
}
const putSettings = (body) => memoryApp().request('/api/memory/settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

before(() => { initSqlite(path.join(scratch, 'c2.db')); });
after(() => {
  try { getDatabase()?.close(); } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  resetAdaptiveMemory();
  setMeta('memory_settings', {}); // a fresh install: nothing saved yet
});

test('fresh install: the three learning sources are off, the rest of the defaults is unchanged', () => {
  const s = getMemorySettings();
  for (const k of LEARN) assert.equal(s[k], false, k);
  assert.equal(s.enabled, true);
  assert.equal(s.budget, 'normal');
});

test('fresh install: a worth-remembering search is not learned', async () => {
  assert.equal((await search()).status, 200);
  assert.equal(countEpisodicMemories(), 0);
});

test('explicit opt-in through the Settings route turns learning on, and turning it off again stops it', async () => {
  const res = await putSettings({ learn_from_searches: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).learn_from_searches, true);
  await search();
  assert.equal(countEpisodicMemories(), 1);
  assert.equal(listEpisodicMemories({ limit: 1 })[0].source, 'search_query');
  await putSettings({ learn_from_searches: false });
  resetAdaptiveMemory();
  await search();
  assert.equal(countEpisodicMemories(), 0);
});

test('only the boolean true opts in: stored strings, numbers, objects or null leave learning off', async () => {
  for (const v of NOT_TRUE) {
    setMeta('memory_settings', Object.fromEntries(LEARN.map((k) => [k, v])));
    const s = getMemorySettings();
    for (const k of LEARN) assert.equal(s[k], false, `${k}=${label(v)}`);
    await search();
    assert.equal(countEpisodicMemories(), 0, `search learned with learn_from_searches=${label(v)}`);
  }
});

test('the master switch still wins: enabled=false learns nothing even with a source opted in', async () => {
  setMemorySettings({ enabled: false, learn_from_searches: true });
  await search();
  assert.equal(countEpisodicMemories(), 0);
});

test('changing another setting (budget) does not opt in to learning', async () => {
  const res = await putSettings({ budget: 'extended' });
  const body = await res.json();
  assert.equal(body.budget, 'extended');
  for (const k of LEARN) assert.equal(body[k], false, k);
  for (const k of LEARN) assert.notEqual(getMeta('memory_settings', {})[k], true, `${k} stored as true`);
});

test('already stored memories are kept: the new defaults never delete anything', () => {
  addEpisodicMemoryDeduped({ text: "j'aime le format markdown pour les résumés", category: 'preference', source: 'c2_synthetic' });
  assert.equal(countEpisodicMemories(), 1);
  setMeta('memory_settings', {});
  getMemorySettings();
  setMemorySettings({ budget: 'low' });
  assert.equal(countEpisodicMemories(), 1);
  assert.equal(listEpisodicMemories({ limit: 1 })[0].source, 'c2_synthetic');
});

test('production (no DOCTEUR_TEST_MODE) and test mode share the same safe defaults', () => {
  const url = (p) => JSON.stringify(pathToFileURL(path.join(HERE, p)).href);
  const code = `
    import { initSqlite, getDatabase } from ${url('src/lib/sqlite.js')};
    import { getMemorySettings } from ${url('src/lib/memory.js')};
    initSqlite(${JSON.stringify(path.join(scratch, 'prod.db'))});
    const s = getMemorySettings();
    getDatabase().close();
    console.log(JSON.stringify({ testMode: process.env.DOCTEUR_TEST_MODE ?? null, searches: s.learn_from_searches, neurons: s.learn_from_neurons, corrections: s.learn_from_corrections }));`;
  const env = { ...process.env };
  delete env.DOCTEUR_TEST_MODE;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: HERE, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()),
    { testMode: null, searches: false, neurons: false, corrections: false });
});
