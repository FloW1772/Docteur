// C1a — cloud AI is allowed only when the router setting cloud_enabled is exactly the boolean `true`.
// Run: node --test test-c1-cloud-opt-in.mjs
//
// Covers the cloud checks in privacy-guard.js (guardCloudCall), whisper-groq.js (transcribeWithGroq) and
// router.js (runAiTask / buildTaskCandidates, routedCompletion). An absent, partial, null, string, numeric or
// otherwise non-boolean value, or an unreadable settings store, must never open the cloud; Strict Local always wins;
// an explicit `true` keeps working.
//
// Isolation: temporary databases only (never the real one), Root Policy loaded read-only from ./policy with an
// in-memory audit (no dataDir), a stubbed global fetch for the cloud provider (a request is recorded, never sent),
// a synthetic API key, a fake local model client. No server is started.
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initSqlite, getDatabase, getRouterSettings, setRouterSettings, setCloudKey } from './src/lib/sqlite.js';
import { guardCloudCall } from './src/lib/privacy-guard.js';
import { transcribeWithGroq } from './src/lib/whisper-groq.js';
import { runAiTask, routedCompletion } from './src/lib/router.js';
import { initRootPolicy } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';
import { _resetAllForTests } from './src/lib/provider-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = path.join(HERE, 'policy');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-c1-'));
const MISSING_AUDIO = path.join(scratch, 'absent.wav');
const MESSAGES = [{ role: 'user', content: 'C1 synthetic question' }];
const GROQ_KEY = 'gsk_c1_synthetic_not_a_real_key';

// Every value that is not the boolean true. `undefined` (absent key) is covered separately for the routers; a stored
// settings row cannot keep an absent key (getRouterSettings merges the defaults), see the child-process tests.
const NOT_TRUE = [null, 'true', 'false', 'TRUE', 1, 0, '', 'yes', {}, []];
const label = (v) => JSON.stringify(v);

// Cloud-enabled router settings without subscription CLIs or paid providers: the only cloud candidate is Groq.
const ALLOW = Object.freeze({
  router_enabled: true, strict_local_mode: false, cloud_enabled: true, cloud_preference: 'local',
  claude_mode: 'api', openai_mode: 'api', paying_apis_enabled: false, fallback_model: 'llama3.2:3b',
});

// Stubbed cloud transport: records the URL, answers like Groq, never touches the network.
let cloudRequests = [];
const realFetch = globalThis.fetch;
const cloudFetchStub = async (url) => {
  cloudRequests.push(String(url));
  return new Response(JSON.stringify({ model: 'stub', choices: [{ message: { content: 'cloud reply' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
const localClient = () => ({ chat: async () => ({ message: { content: 'local reply' } }) });
const logger = { info() {}, warn() {}, error() {}, debug() {} };

const isDenied = (code) => (e) => e?.rootPolicyDenied === true && e.decisionCode === code;
const guard = () => guardCloudCall({ messages: MESSAGES, provider: 'groq', functionCalled: 'complete' });

async function outcome(fn) {
  try { return (await fn()).provider; } catch (e) { return `ERROR:${e?.code ?? e?.message}`; }
}
const aiTask = (settings) => outcome(() => runAiTask({
  feature: 'c1', taskType: 'c1_task', messages: MESSAGES, preferredProvider: 'groq',
  client: localClient(), settings, logger,
}));
// deep_capture on more than 6 000 words escalates to the cloud level when cloud is enabled.
const routed = (settings) => outcome(() => routedCompletion(localClient(), {
  action: 'deep_capture', input: 'c1', context: { word_count: 7_000 }, messages: MESSAGES,
  installedNames: ['llama3.2:3b'], settings, logger,
}));

function child({ testMode, db, strictOff = false }) {
  const url = (p) => JSON.stringify(pathToFileURL(path.join(HERE, p)).href);
  const code = `
    import { initSqlite, getRouterSettings, setRouterSettings, getDatabase } from ${url('src/lib/sqlite.js')};
    import { guardCloudCall } from ${url('src/lib/privacy-guard.js')};
    import { initRootPolicy } from ${url('src/lib/root-policy/index.js')};
    import { TRUST_ANCHORS } from ${url('src/lib/root-policy/trust-anchors.js')};
    initSqlite(${JSON.stringify(db)});
    initRootPolicy({ policyDir: ${JSON.stringify(POLICY)}, trustAnchors: TRUST_ANCHORS });
    if (${strictOff}) setRouterSettings({ strict_local_mode: false });
    const s = getRouterSettings();
    let denied = null;
    try { guardCloudCall({ messages: [{ role: 'user', content: 'x' }], provider: 'groq', functionCalled: 'complete' }); }
    catch (e) { denied = e.decisionCode ?? String(e.message); }
    getDatabase().close();
    console.log(JSON.stringify({ testMode: process.env.DOCTEUR_TEST_MODE ?? null, cloud: s.cloud_enabled, strict: s.strict_local_mode, denied }));`;
  const env = { ...process.env };
  if (testMode) env.DOCTEUR_TEST_MODE = '1'; else delete env.DOCTEUR_TEST_MODE;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: HERE, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

before(() => {
  initSqlite(path.join(scratch, 'c1.db'));
  initRootPolicy({ policyDir: POLICY, trustAnchors: TRUST_ANCHORS });
  setCloudKey('groq', GROQ_KEY);
  globalThis.fetch = cloudFetchStub;
});
after(() => {
  globalThis.fetch = realFetch;
  try { getDatabase()?.close(); } catch { /* already closed by the last test */ }
  fs.rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  cloudRequests = [];
  _resetAllForTests();
  setRouterSettings({ ...ALLOW }); // the store allows: router tests isolate the router's own check
});

test('production defaults (no DOCTEUR_TEST_MODE): cloud off, Strict Local on, the guard refuses; still refused with Strict Local off', () => {
  assert.deepEqual(child({ testMode: false, db: path.join(scratch, 'prod.db') }),
    { testMode: null, cloud: false, strict: true, denied: 'DENY_STRICT_LOCAL' });
  assert.deepEqual(child({ testMode: false, db: path.join(scratch, 'prod2.db'), strictOff: true }),
    { testMode: null, cloud: false, strict: false, denied: 'DENY_CLOUD_NOT_ENABLED' });
});

test('DOCTEUR_TEST_MODE compatibility: the simulated cloud baseline is an explicit boolean true and stays allowed', () => {
  assert.deepEqual(child({ testMode: true, db: path.join(scratch, 'testmode.db') }),
    { testMode: '1', cloud: true, strict: false, denied: null });
});

test('explicit cloud_enabled === true keeps working: guard, Groq STT policy, runAiTask and routedCompletion reach the stubbed cloud', async () => {
  assert.doesNotThrow(guard);
  // The policy lets the STT call through; it then stops at the missing synthetic file, before any request.
  await assert.rejects(transcribeWithGroq(MISSING_AUDIO, GROQ_KEY), (e) => e?.code === 'ENOENT');
  assert.equal(await aiTask({ ...ALLOW }), 'groq');
  assert.equal(await routed({ ...ALLOW }), 'groq');
  assert.equal(cloudRequests.length, 2);
  assert.ok(cloudRequests.every((u) => u.startsWith('https://api.groq.com/')));
});

test('Strict Local wins over cloud_enabled === true everywhere', async () => {
  setRouterSettings({ strict_local_mode: true, cloud_enabled: true });
  assert.throws(guard, isDenied('DENY_STRICT_LOCAL'));
  await assert.rejects(transcribeWithGroq(MISSING_AUDIO, GROQ_KEY), isDenied('DENY_STRICT_LOCAL'));
  assert.equal(await aiTask({ ...ALLOW, strict_local_mode: true }), 'local');
  assert.equal(await routed({ ...ALLOW, strict_local_mode: true }), 'local');
  assert.equal(cloudRequests.length, 0);
});

test('stored null / string / numeric / object values never enable cloud: guard and Groq STT refuse', async () => {
  for (const v of NOT_TRUE) {
    setRouterSettings({ strict_local_mode: false, cloud_enabled: v });
    assert.throws(guard, isDenied('DENY_CLOUD_NOT_ENABLED'), `guard with cloud_enabled=${label(v)}`);
    await assert.rejects(transcribeWithGroq(MISSING_AUDIO, GROQ_KEY), isDenied('DENY_CLOUD_NOT_ENABLED'), `STT with cloud_enabled=${label(v)}`);
  }
  assert.equal(cloudRequests.length, 0);
});

test('null / string / numeric / object values passed to the routers never enable cloud', async () => {
  for (const v of NOT_TRUE) {
    assert.equal(await aiTask({ ...ALLOW, cloud_enabled: v }), 'local', `runAiTask with cloud_enabled=${label(v)}`);
    assert.equal(await routed({ ...ALLOW, cloud_enabled: v }), 'local', `routedCompletion with cloud_enabled=${label(v)}`);
  }
  assert.equal(cloudRequests.length, 0);
});

test('absent and partial settings never enable cloud in the routers', async () => {
  const { cloud_enabled: _omitted, ...withoutCloudKey } = ALLOW;
  for (const s of [null, {}, { strict_local_mode: false }, withoutCloudKey]) {
    const a = await aiTask(s);
    const r = await routed(s);
    assert.notEqual(a, 'groq', `runAiTask with settings=${label(s)} → ${a}`);
    assert.notEqual(r, 'groq', `routedCompletion with settings=${label(s)} → ${r}`);
  }
  assert.equal(await routed(undefined), 'local', 'routedCompletion without any settings object');
  assert.equal(cloudRequests.length, 0);
});

// Must stay last: it closes the test database.
test('unreadable settings store: guard and Groq STT fail closed (never treated as cloud enabled)', async () => {
  setRouterSettings({ strict_local_mode: false, cloud_enabled: true });
  getDatabase().close();
  assert.throws(() => getRouterSettings(), 'the store is really unreadable');
  assert.throws(guard, isDenied('DENY_CLOUD_NOT_ENABLED'));
  await assert.rejects(transcribeWithGroq(MISSING_AUDIO, GROQ_KEY), isDenied('DENY_CLOUD_NOT_ENABLED'));
  assert.equal(cloudRequests.length, 0);
});
