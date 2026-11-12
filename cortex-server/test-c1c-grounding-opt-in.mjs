// C1c — Gemini grounding (news research and news watch) reaches the cloud only through the same guard as every other
// cloud call: cloud_enabled must be exactly the boolean `true`, Strict Local wins, private content never leaves.
// Run: node --test test-c1c-grounding-opt-in.mjs
//
// Paths covered: providers/gemini.js completeWithGrounding (the single grounding entry point), the POST /research
// route in "actualite" mode, and the news-watch agent (AGENT_TYPES.veille) in "actualite" mode.
//
// Isolation: temporary databases only (never the real one), Root Policy loaded read-only from ./policy with an
// in-memory audit (no dataDir), a stubbed global fetch that answers like Gemini grounding and records every request
// (nothing is sent), a synthetic API key. No server is started.
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { initSqlite, getDatabase, getRouterSettings, setRouterSettings, setCloudKey } from './src/lib/sqlite.js';
import { markPrivate, PrivacyViolationError } from './src/lib/privacy-guard.js';
import { completeWithGrounding } from './src/lib/providers/gemini.js';
import { createResearchRoute } from './src/routes/research.js';
import { AGENT_TYPES } from './src/lib/agent-runner.js';
import { initRootPolicy } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';
import { _resetAllForTests } from './src/lib/provider-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = path.join(HERE, 'policy');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-c1c-'));
const GEMINI_KEY = 'c1c_synthetic_not_a_real_key';
const MODEL = 'gemini-2.5-flash';
const PROMPT = 'C1c synthetic news question';

const NOT_TRUE = [false, null, 'true', 'false', 1, 0, '', 'yes', {}, []];
const label = (v) => JSON.stringify(v);
// gemini_rpm 60: the provider's own rate limiter never makes the test wait.
const ALLOW = Object.freeze({ strict_local_mode: false, cloud_enabled: true, gemini_rpm: 60 });

// Stubbed transport: answers like a grounded Gemini response and records the host, never touches the network.
let cloudRequests = [];
const realFetch = globalThis.fetch;
const groundingStub = async (url) => {
  cloudRequests.push(new URL(String(url)).host);
  return new Response(JSON.stringify({
    candidates: [{
      content: { parts: [{ text: 'grounded reply' }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.test/source', title: 'Source' } }] },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

const isDenied = (code) => (e) => e?.rootPolicyDenied === true && e.decisionCode === code;
const ground = (prompt = PROMPT) => completeWithGrounding({ apiKey: GEMINI_KEY, model: MODEL, prompt });

function researchApp() {
  const app = new Hono();
  app.route('/', createResearchRoute({ logger, fallbackChat: null, services: {} }));
  return app;
}
const research = () => researchApp().request('/research', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ subject: 'C1c synthetic subject', mode: 'actualite' }),
});
const veille = () => AGENT_TYPES.veille.execute({ params: { subject: 'C1c synthetic subject', mode: 'actualite' }, logger, services: {} });
async function veilleOutcome() {
  try { const r = await veille(); return r?.metadata?.sources ? 'grounded' : 'other'; } catch (e) { return `ERROR:${e?.code ?? e?.decisionCode ?? e?.message}`; }
}

function child({ testMode, db, strictOff = false }) {
  const url = (p) => JSON.stringify(pathToFileURL(path.join(HERE, p)).href);
  const code = `
    import { initSqlite, getRouterSettings, setRouterSettings, getDatabase } from ${url('src/lib/sqlite.js')};
    import { completeWithGrounding } from ${url('src/lib/providers/gemini.js')};
    import { initRootPolicy } from ${url('src/lib/root-policy/index.js')};
    import { TRUST_ANCHORS } from ${url('src/lib/root-policy/trust-anchors.js')};
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response('{}', { status: 500 }); };
    initSqlite(${JSON.stringify(db)});
    initRootPolicy({ policyDir: ${JSON.stringify(POLICY)}, trustAnchors: TRUST_ANCHORS });
    if (${strictOff}) setRouterSettings({ strict_local_mode: false });
    const s = getRouterSettings();
    let denied = null;
    try { await completeWithGrounding({ apiKey: 'x', model: 'gemini-2.5-flash', prompt: 'x' }); }
    catch (e) { denied = e.decisionCode ?? 'NOT_DENIED'; }
    getDatabase().close();
    console.log(JSON.stringify({ testMode: process.env.DOCTEUR_TEST_MODE ?? null, cloud: s.cloud_enabled, strict: s.strict_local_mode, denied, requests }));`;
  const env = { ...process.env };
  if (testMode) env.DOCTEUR_TEST_MODE = '1'; else delete env.DOCTEUR_TEST_MODE;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: HERE, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

before(() => {
  initSqlite(path.join(scratch, 'c1c.db'));
  initRootPolicy({ policyDir: POLICY, trustAnchors: TRUST_ANCHORS });
  setCloudKey('gemini', GEMINI_KEY);
  globalThis.fetch = groundingStub;
});
after(() => {
  globalThis.fetch = realFetch;
  try { getDatabase()?.close(); } catch { /* already closed by the last test */ }
  fs.rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  cloudRequests = [];
  _resetAllForTests();
  setRouterSettings({ ...ALLOW });
});

test('production defaults (no DOCTEUR_TEST_MODE): grounding refused by Strict Local, and still refused with Strict Local off (cloud off)', () => {
  assert.deepEqual(child({ testMode: false, db: path.join(scratch, 'prod.db') }),
    { testMode: null, cloud: false, strict: true, denied: 'DENY_STRICT_LOCAL', requests: 0 });
  assert.deepEqual(child({ testMode: false, db: path.join(scratch, 'prod2.db'), strictOff: true }),
    { testMode: null, cloud: false, strict: false, denied: 'DENY_CLOUD_NOT_ENABLED', requests: 0 });
});

test('explicit cloud_enabled === true keeps grounding working: provider, /research actualite and the news-watch agent', async () => {
  const r = await ground();
  assert.equal(r.text, 'grounded reply');
  assert.deepEqual(r.sources, [{ title: 'Source', url: 'https://example.test/source' }]);
  const res = await research();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content, 'grounded reply');
  assert.equal(await veilleOutcome(), 'grounded');
  assert.equal(cloudRequests.length, 3);
  assert.ok(cloudRequests.every((h) => h === 'generativelanguage.googleapis.com'));
});

test('Strict Local wins over cloud_enabled === true', async () => {
  setRouterSettings({ strict_local_mode: true, cloud_enabled: true });
  await assert.rejects(ground(), isDenied('DENY_STRICT_LOCAL'));
  assert.notEqual((await research()).status, 200);
  assert.match(await veilleOutcome(), /^ERROR:/);
  assert.equal(cloudRequests.length, 0);
});

test('false / null / string / numeric / object values never open grounding (provider, route, agent)', async () => {
  for (const v of NOT_TRUE) {
    setRouterSettings({ strict_local_mode: false, cloud_enabled: v });
    await assert.rejects(ground(), isDenied('DENY_CLOUD_NOT_ENABLED'), `provider with cloud_enabled=${label(v)}`);
    assert.notEqual((await research()).status, 200, `/research with cloud_enabled=${label(v)}`);
    assert.match(await veilleOutcome(), /^ERROR:/, `news watch with cloud_enabled=${label(v)}`);
  }
  assert.equal(cloudRequests.length, 0);
});

test('private content in the grounding prompt never leaves, even with cloud enabled', async () => {
  await assert.rejects(ground(`${PROMPT} ${markPrivate('__C1C_PRIVATE_MARKER__')}`), (e) => e instanceof PrivacyViolationError);
  assert.equal(cloudRequests.length, 0);
});

test('DOCTEUR_TEST_MODE compatibility: the simulated cloud baseline (explicit true) reaches the stub only', () => {
  const out = child({ testMode: true, db: path.join(scratch, 'testmode.db') });
  // Allowed by policy; the child's stub answers 500, so the provider throws a non-policy error after one request.
  assert.deepEqual(out, { testMode: '1', cloud: true, strict: false, denied: 'NOT_DENIED', requests: 1 });
});

// Must stay last: it closes the test database.
test('unreadable settings store: grounding fails closed', async () => {
  getDatabase().close();
  assert.throws(() => getRouterSettings());
  await assert.rejects(ground(), isDenied('DENY_CLOUD_NOT_ENABLED'));
  assert.equal(cloudRequests.length, 0);
});
