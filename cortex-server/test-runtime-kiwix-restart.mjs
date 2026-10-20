// [RS-KIWIX-RESTART] Runtime Supervisor → Kiwix delegated restart + local challenge + Root Policy V2.
// Real fixture processes (kiwix-fixture-serve.mjs on 127.0.0.1) under the REAL Kiwix lifecycle, the REAL supervisor, route and
// restart authority. Three policy sources, never mixed: V2 rebuilt from the reviewed code (in-memory engines), the HISTORICAL signed
// V1 (public fixture, in-memory engines), and — test 15 only — the LIVE shipped signed policy through the real runtime (read, never written).
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import * as db from './src/lib/sqlite.js';
import { createKiwixLifecycle, createKiwixLifecyclePort, kiwixDefinitionDigest, KIWIX_BINARY_NAME } from './src/lib/kiwix.js';
import { createRuntimeSupervisor, createRuntimeAuditLog } from './src/lib/runtime-supervisor.js';
import { createProductRuntimeServices } from './src/lib/runtime-supervisor-services.js';
import { createRuntimeSupervisorRoute } from './src/routes/runtime-supervisor.js';
import { createRestartAuthority, RESTART_CEREMONY_LIMITS, RUNTIME_RESTART_BOUNDARY as AUTHORITY_BOUNDARY } from './src/lib/runtime-restart-authority.js';
import { buildDefaultPolicy, RUNTIME_RESTART_BOUNDARY } from './src/lib/root-policy/default-policy.js';
import { createEngine } from './src/lib/root-policy/engine.js';
import { createKiwixProcessPolicyGate } from './src/lib/kiwix-process-policy.js';
import { ACTION_IDS, canonicalize, validatePolicy } from './src/lib/root-policy/schema.js';
import * as rootPolicy from './src/lib/root-policy/index.js';
import { buildCandidateText } from './root-policy-v2-candidate.mjs';
import { killProcessTree } from './src/lib/process-tree.js';
import { SHIPPED_POLICY, loadHistoricalV1 } from './fixtures/root-policy-history.mjs';

db.initSqlite(':memory:');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'kiwix-fixture-serve.mjs');
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rskr-')));
const REAL = ['cortex.sqlite', 'cortex.sqlite-wal', path.join('companion-v1', 'companion.sqlite')].map(f => path.join(HERE, 'data', f));
const POLICY_FILES = ['root-policy.json', 'root-policy.sig.json', 'signing-log.jsonl'].map(f => path.join(HERE, 'policy', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const realFetch = globalThis.fetch;
let externalFetches = 0; let realBefore; let policyBefore;
const children = [];

const BIN_DIR = path.join(TMP, 'Kiwix Tools'); fs.mkdirSync(BIN_DIR);
const BINARY = path.join(BIN_DIR, KIWIX_BINARY_NAME); fs.writeFileSync(BINARY, 'stand-in, never executed');
const ZIM_DIR = path.join(TMP, 'ZIM'); fs.mkdirSync(ZIM_DIR);
fs.writeFileSync(path.join(ZIM_DIR, 'pokepedia.zim'), 'archive');

before(() => {
  realBefore = REAL.map(fileHash); policyBefore = POLICY_FILES.map(fileHash);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== '127.0.0.1') { externalFetches++; throw new Error('external network refused'); }
    return realFetch(input, init);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) await killProcessTree(c).catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

// ── policies: historical signed V1 (public fixture, in memory), V2 rebuilt from the reviewed code (in memory) ─────────────
const { text: V1_TEXT, policy: V1 } = loadHistoricalV1();
const V2 = JSON.parse(buildCandidateText({ issuedAt: SHIPPED_POLICY.issuedAt }));
const engineFor = (policy) => createEngine({ getPolicy: () => ({ valid: true, policy, version: policy.version }) });
const viewFor = (policy) => () => ({ status: { state: 'VALID', version: policy.version }, policy });
const e1 = engineFor(V1); const e2 = engineFor(V2);
const RESTART = (extra = {}) => ({ action: 'SERVICE_RESTART', module: 'runtime-supervisor', trustDomain: 'RUNTIME', actor: { kind: 'USER' }, userInitiated: true, context: { serviceId: 'kiwix-serve', target: 'kiwix-serve', payloadHash: 'a'.repeat(64) }, ...extra });
const code = (engine, r) => { const d = engine.decide(r); return `${d.decision}:${d.code}`; };

// ── a real Kiwix lifecycle over the fixture ───────────────────────────────────────────────────────────────────────────
const FAST = { healthAttempts: 30, healthIntervalMs: 100, verifyWindowMs: 2_000, stopGraceMs: 1_500, forceWaitMs: 2_000, portReleaseMs: 1_500 };
async function rig({ modes = ['healthy'], terminate, forceKill, policyGate } = {}) {
  const settings = { kiwixServePath: BIN_DIR, archivesFolder: ZIM_DIR, port: await freePort() };
  const calls = []; const logs = [];
  const spawnFn = (binary, args, opts) => {
    const child = spawn(process.execPath, [FIXTURE, `--fixture-mode=${modes[Math.min(calls.length, modes.length - 1)]}`, ...args], opts);
    calls.push({ child }); children.push(child); return child;
  };
  const logger = { info: (o) => logs.push(o), warn: (o) => logs.push(o), error: (o) => logs.push(o) };
  const lc = createKiwixLifecycle({ spawnFn, getSettings: () => settings, logger, limits: FAST, ...(policyGate ? { policyGate } : {}), ...(terminate ? { terminate } : {}), ...(forceKill ? { forceKill } : {}) });
  return { lc, settings, calls, logs, transitions: (from = 0) => logs.slice(from).filter(l => l.event === 'transition').map(l => `${l.from}>${l.to}`) };
}

const UI_ORIGIN = 'http://127.0.0.1:5173';
const UI = Object.freeze({ origin: UI_ORIGIN, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' });
/** Supervisor + authority + route over a rig. policy: 'V2' (in-memory reviewed V2) | 'LIVE' (the shipped signed policy through the real runtime). */
async function world({ policy = 'V2', modes, terminate, forceKill, authorityNow, loopback = true, decideSpy = null } = {}) {
  const kiwixPolicyGate = policy === 'LIVE' ? undefined : createKiwixProcessPolicyGate({ getPolicyViewFn: viewFor(V2), decideFn: e2.decide });
  const r = await rig({ modes, terminate, forceKill, policyGate: kiwixPolicyGate });
  const decisions = [];
  const decide = policy === 'LIVE' ? rootPolicy.decide : (req) => e2.decide(req);
  const authority = policy === 'LIVE'
    ? createRestartAuthority({ services: ['kiwix-serve'] })
    : createRestartAuthority({ services: ['kiwix-serve'], policyDecide: (req) => { decisions.push(req); decideSpy?.(req); return decide(req); }, policyView: viewFor(V2), ...(authorityNow ? { now: authorityNow } : {}) });
  const port = createKiwixLifecyclePort({ lifecycle: r.lc, redeemRestartAuthorization: authority.redeem });
  const audit = createRuntimeAuditLog();
  const services = createProductRuntimeServices({ ollamaUrl: 'http://127.0.0.1:9', kiwixDelegate: port, comfy: { installState: () => ({ kind: 'none', status: 'not_installed' }) } });
  const sup = createRuntimeSupervisor({ services, restartAuthority: authority, audit, probe: async () => ({ code: 'REFUSED' }) });
  const app = new Hono().route('/api', createRuntimeSupervisorRoute({ supervisor: sup, isLoopbackPeer: () => loopback }));
  const post = async (p, body, headers = UI) => {
    const res = await app.request(`http://127.0.0.1:3001/api/runtime/services/${p}`, { method: 'POST', headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const challenge = async (headers) => post('kiwix-serve/restart-challenge', undefined, headers);
  const confirm = async (challengeId, { gesture = { kind: 'POINTER', trusted: true }, headers } = {}) => post('kiwix-serve/restart-confirm', { challengeId, gesture }, headers);
  return { ...r, authority, port, sup, app, audit, post, challenge, confirm, decisions };
}
const cleanup = async (w) => { await w.sup.whenIdle('kiwix-serve').catch(() => {}); if (w.lc.status().running) await w.lc.stop(); };

// ═══════════════════════════ ROOT POLICY: historical V1 unchanged, V2 exact ═══════════════════════════════════════════
test('1. V1 generation is byte-identical to the historical signed V1; V1 has no runtime boundary and runtime-supervisor keeps approvalBoundary null', () => {
  assert.equal(canonicalize(buildDefaultPolicy({ version: 1, issuedAt: V1.issuedAt })), V1_TEXT);
  assert.equal(V1.modules['runtime-supervisor'].approvalBoundary, null);
  assert.equal(RUNTIME_RESTART_BOUNDARY in V1.approvalBoundaries, false);
  assert.equal(V1.version, 1);
  assert.deepEqual(POLICY_FILES.map(fileHash), policyBefore, 'active policy files untouched');
});

test('2. V2 candidate: valid; ONE new boundary covering exactly SERVICE_RESTART, referenced only by runtime-supervisor; the reviewed Kiwix executor rule is unchanged', () => {
  assert.deepEqual(validatePolicy(V2), { ok: true });
  assert.equal(V2.version, 2);
  assert.equal(AUTHORITY_BOUNDARY, RUNTIME_RESTART_BOUNDARY);
  assert.deepEqual(V2.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].covers, ['SERVICE_RESTART']);
  assert.deepEqual(V2.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist, ['kiwix-serve']);
  assert.deepEqual(Object.entries(V2.modules).filter(([, m]) => m.approvalBoundary === RUNTIME_RESTART_BOUNDARY).map(([n]) => n), ['runtime-supervisor']);
  assert.deepEqual(V2.modules['runtime-supervisor'], { domains: ['RUNTIME'], capabilities: ['RUNTIME.RESTART_SERVICE'], approvalBoundary: RUNTIME_RESTART_BOUNDARY });
  assert.deepEqual(V2.capabilities['PROCESS.START_TYPED'].constraints.executors.kiwix, { 'kiwix-serve': { executables: ['kiwix-serve.exe'], argsTemplates: ['kiwix-serve-loopback'], actors: ['USER', 'MODULE'] } });
  assert.deepEqual(V2.modules.kiwix, { domains: ['PROCESS'], capabilities: ['PROCESS.START_TYPED'], approvalBoundary: null });
  for (const [name, b] of Object.entries(V2.approvalBoundaries)) if (name !== RUNTIME_RESTART_BOUNDARY) assert.deepEqual(b, V1.approvalBoundaries[name], name);
});

test('3. POLICY MATRIX: historical V1 blocks; V2 (in memory AND the live shipped policy) + exact boundary request ALLOWs; anything else stays blocked', () => {
  assert.equal(code(e1, RESTART({ certifiedBoundary: true })), 'REQUIRE_APPROVAL:REQUIRE_LOCAL_APPROVAL', 'HISTORICAL V1: blocked even with the flag');
  const live = rootPolicy.decide(RESTART({ certifiedBoundary: true }));
  assert.deepEqual([live.decision, live.code, live.policyVersion], ['ALLOW', 'ALLOW_CERTIFIED_BOUNDARY', SHIPPED_POLICY.version], 'LIVE shipped V2 (real runtime): the exact boundary request');
  assert.equal(rootPolicy.getRootPolicyStatus().sha256, SHIPPED_POLICY.sha256.slice(0, 16), 'the live policy is the reviewed shipped V2');
  assert.notEqual(rootPolicy.decide(RESTART()).decision, 'ALLOW', 'LIVE: without the internal flag (only the authority sets it)');
  assert.equal(rootPolicy.decide(RESTART({ certifiedBoundary: true, context: { serviceId: 'ollama', target: 'ollama', payloadHash: 'a'.repeat(64) } })).code, 'DENY_SERVICE_NOT_ALLOWLISTED', 'LIVE: other services');
  const ok = e2.decide(RESTART({ certifiedBoundary: true }));
  assert.deepEqual([ok.decision, ok.code, ok.boundary], ['ALLOW', 'ALLOW_CERTIFIED_BOUNDARY', RUNTIME_RESTART_BOUNDARY], 'V2 exact');
  assert.equal(code(e2, RESTART()), 'REQUIRE_APPROVAL:REQUIRE_LOCAL_APPROVAL', 'V2 without the internal flag');
  for (const kind of ['AI_LOCAL', 'AI_CLOUD', 'AGENT', 'PLUGIN', 'MCP', 'REMOTE', 'CONNECTOR', 'DOCUMENT']) assert.notEqual(e2.decide(RESTART({ certifiedBoundary: true, actor: { kind } })).decision, 'ALLOW', kind);
  assert.equal(code(createEngine({ getPolicy: () => ({ valid: false }) }), RESTART({ certifiedBoundary: true })), 'DENY:DENY_POLICY_INVALID', 'V2 invalid policy');
  const missing = JSON.parse(JSON.stringify(V2)); missing.modules['runtime-supervisor'].approvalBoundary = null;
  assert.equal(code(engineFor(missing), RESTART({ certifiedBoundary: true })), 'DENY:DENY_SERVICE_ALLOWLIST_INVALID', 'V2 missing boundary fails closed');
  assert.equal(code(e2, RESTART({ certifiedBoundary: true, context: {} })), 'DENY:DENY_UNKNOWN_CAPABILITY', 'no service id');
  // the boundary authorises SERVICE_RESTART only: every other action through runtime-supervisor stays non-ALLOW, even certified
  // (STOP / revocation actions are ALLOW_STOP_ALWAYS for everyone by root rule 7 — unchanged V1 semantics, compared to V1 here)
  for (const action of ACTION_IDS.filter(a => a !== 'SERVICE_RESTART')) {
    for (const trustDomain of ['RUNTIME', 'PROCESS', 'FILES', 'OMEGA', 'RASSILON', 'DEVICE_FABRIC', 'MAITRE']) {
      const req = { action, module: 'runtime-supervisor', trustDomain, actor: { kind: 'USER' }, userInitiated: true, certifiedBoundary: true, context: { executorId: 'x', argsTyped: true, serviceId: 's' } };
      const d = e2.decide(req);
      assert.notEqual(d.code, 'ALLOW_CERTIFIED_BOUNDARY', `${action}/${trustDomain}`);
      assert.equal(code(e2, req), code(e1, req), `${action}/${trustDomain}: same as V1`);
      if (d.decision === 'ALLOW' && d.code !== 'ALLOW_STOP_ALWAYS') assert.fail(`${action}/${trustDomain} allowed (${d.code})`);
    }
  }
  // a (hypothetically signed) document whose runtime boundary also covered PROCESS_STOP still gives runtime-supervisor nothing new …
  const wider = JSON.parse(JSON.stringify(V2)); wider.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].covers.push('PROCESS_STOP');
  assert.notEqual(engineFor(wider).decide({ action: 'PROCESS_STOP', module: 'runtime-supervisor', trustDomain: 'PROCESS', actor: { kind: 'USER' }, certifiedBoundary: true }).decision, 'ALLOW');
  // … and the restart authority refuses to offer a restart at all under such a document (exact boundary required)
  assert.deepEqual(createRestartAuthority({ services: ['kiwix-serve'], policyView: viewFor(wider), policyDecide: (q) => engineFor(wider).decide(q) }).boundaryStatus(), { available: false, code: 'ROOT_POLICY_DENIED' });
  assert.deepEqual(createRestartAuthority({ services: ['kiwix-serve'], policyView: viewFor(V1) }).boundaryStatus(), { available: false, code: 'ROOT_POLICY_APPROVAL_REQUIRED' });
  assert.deepEqual(createRestartAuthority({ services: ['kiwix-serve'], policyView: () => ({ status: { state: 'INVALID' }, policy: null }) }).boundaryStatus(), { available: false, code: 'ROOT_POLICY_DENIED' });
});

// ═══════════════════════════ CHALLENGE MATRIX (authority, deterministic clock) ═══════════════════════════════════════
const DIGEST = 'a'.repeat(64);
const liveStatus = (over = {}) => ({ serviceId: 'kiwix-serve', state: 'HEALTHY', owned: true, pid: 4242, startedAt: '2026-10-19T10:00:00.000Z', generation: 7, definitionDigest: DIGEST, ...over });
function authorityRig({ policy = V2 } = {}) {
  let t = 1_000_000; const decisions = [];
  const a = createRestartAuthority({ services: ['kiwix-serve'], policyView: viewFor(policy), policyDecide: (q) => { decisions.push(q); return engineFor(policy).decide(q); }, now: () => t });
  return { a, decisions, tick: (ms) => { t += ms; } };
}
const G = Object.freeze({ kind: 'POINTER', trusted: true });
const issue = (a, over = {}) => a.issueChallenge({ serviceId: 'kiwix-serve', status: liveStatus(), origin: UI_ORIGIN, actor: 'USER', ...over });
const confirmA = (a, id, over = {}) => a.confirmChallenge({ serviceId: 'kiwix-serve', challengeId: id, gesture: G, origin: UI_ORIGIN, actor: 'USER', status: liveStatus(), ...over });

test('4. CHALLENGE: valid path ⇒ one Root Policy request with the internal flag, bound to the live digest; TTL = 90 s; 256-bit ids', () => {
  const { a, decisions } = authorityRig();
  assert.equal(RESTART_CEREMONY_LIMITS.challengeTtlMs, 90_000, 'TTL remains exactly 90 seconds');
  const c = issue(a);
  assert.equal(c.ok, true); assert.match(c.challengeId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Date.parse(c.expiresAt) - 1_000_000, RESTART_CEREMONY_LIMITS.challengeTtlMs);
  assert.equal(decisions.length, 0, 'issuing never asks the boundary');
  const r = confirmA(a, c.challengeId);
  assert.deepEqual([r.ok, r.policyCode], [true, 'ALLOW_CERTIFIED_BOUNDARY']);
  assert.deepEqual(decisions, [{ action: 'SERVICE_RESTART', module: 'runtime-supervisor', trustDomain: 'RUNTIME', actor: { kind: 'USER' }, userInitiated: true, certifiedBoundary: true, context: { serviceId: 'kiwix-serve', target: 'kiwix-serve', payloadHash: DIGEST } }]);
  const ids = new Set(Array.from({ length: 300 }, () => issue(a).challengeId)); assert.equal(ids.size, 300);
});

test('5. CHALLENGE: expired / replayed / duplicate / unknown / malformed / after backend restart / superseded ⇒ refused, Root Policy never asked', () => {
  const { a, decisions, tick } = authorityRig();
  const c1 = issue(a); tick(RESTART_CEREMONY_LIMITS.challengeTtlMs);
  assert.equal(confirmA(a, c1.challengeId).code, 'CHALLENGE_EXPIRED');
  assert.equal(confirmA(a, c1.challengeId).code, 'CHALLENGE_REPLAYED', 'an expired id is burnt');
  const c2 = issue(a); assert.equal(confirmA(a, c2.challengeId).ok, true);
  assert.equal(confirmA(a, c2.challengeId).code, 'CHALLENGE_REPLAYED', 'duplicate confirmation');
  assert.equal(confirmA(a, crypto.randomBytes(32).toString('base64url')).code, 'CHALLENGE_UNKNOWN');
  for (const bad of ['', 'x', 'a'.repeat(44), `${'a'.repeat(42)}!`, null, 42, {}]) assert.equal(confirmA(a, bad).code, 'CHALLENGE_INVALID', String(bad));
  const c3 = issue(a);
  const restarted = authorityRig().a; // a new backend process = a new, empty authority
  assert.equal(confirmA(restarted, c3.challengeId).code, 'CHALLENGE_UNKNOWN', 'never valid after a backend restart');
  const older = issue(a); const newer = issue(a);
  assert.equal(confirmA(a, older.challengeId).code, 'CHALLENGE_REPLAYED', 'a newer ceremony supersedes (burns) the older one');
  assert.equal(confirmA(a, newer.challengeId).ok, true);
  assert.equal(decisions.length, 2, 'only the two valid confirmations reached Root Policy');
});

test('6. CHALLENGE: wrong service / origin / digest / generation / pid / start time / state / gesture / actor ⇒ refused and burnt', () => {
  const cases = [
    [{ serviceId: 'ollama' }, 'CHALLENGE_WRONG_SERVICE'], [{ origin: 'http://localhost:5173' }, 'CHALLENGE_ORIGIN_MISMATCH'],
    [{ status: liveStatus({ definitionDigest: 'b'.repeat(64) }) }, 'DEFINITION_CHANGED'], [{ status: liveStatus({ generation: 8 }) }, 'INSTANCE_CHANGED'],
    [{ status: liveStatus({ pid: 4243 }) }, 'INSTANCE_CHANGED'], [{ status: liveStatus({ startedAt: '2026-10-19T10:00:01.000Z' }) }, 'INSTANCE_CHANGED'],
    [{ status: liveStatus({ state: 'DEGRADED' }) }, 'STATE_CHANGED'], [{ status: liveStatus({ owned: false }) }, 'INSTANCE_CHANGED'], [{ status: null }, 'INSTANCE_CHANGED'],
    [{ gesture: { kind: 'POINTER', trusted: false } }, 'GESTURE_INVALID'], [{ gesture: { kind: 'SCRIPT', trusted: true } }, 'GESTURE_INVALID'],
    [{ gesture: { kind: 'POINTER', trusted: true, humanConfirmed: true } }, 'GESTURE_INVALID'], [{ gesture: null }, 'GESTURE_INVALID'],
  ];
  for (const [over, expected] of cases) {
    const { a, decisions } = authorityRig();
    const c = issue(a);
    assert.equal(confirmA(a, c.challengeId, over).code, expected, JSON.stringify(over));
    assert.equal(confirmA(a, c.challengeId).code, 'CHALLENGE_REPLAYED', `burnt after ${expected}`);
    assert.equal(decisions.length, 0, `${expected}: Root Policy never asked`);
  }
  for (const actor of ['AI_LOCAL', 'AI_CLOUD', 'AGENT', 'MODULE', 'PLUGIN', 'MCP', 'REMOTE', 'DOCUMENT', 'CONNECTOR', undefined]) {
    const { a, decisions } = authorityRig();
    assert.equal(issue(a, { actor }).code, 'ACTOR_NOT_PERMITTED', `issue ${actor}`);
    const c = issue(a);
    assert.equal(confirmA(a, c.challengeId, { actor }).code, 'ACTOR_NOT_PERMITTED', `confirm ${actor}`);
    assert.equal(decisions.length, 0);
  }
  const { a } = authorityRig();
  assert.equal(issue(a, { serviceId: 'ollama' }).code, 'SERVICE_NOT_DELEGATED');
  assert.equal(issue(a, { serviceId: 'docteur-backend' }).code, 'SERVICE_NOT_DELEGATED');
  for (const state of ['STOPPED', 'STARTING', 'STOPPING', 'CRASHED']) assert.equal(issue(a, { status: liveStatus({ state }) }).code, 'NOT_RUNNING', state);
  assert.equal(issue(a, { origin: '' }).code, 'ACTOR_NOT_PERMITTED');
  assert.equal(authorityRig({ policy: V1 }).a.issueChallenge({ serviceId: 'kiwix-serve', status: liveStatus(), origin: UI_ORIGIN, actor: 'USER' }).code, 'ROOT_POLICY_APPROVAL_REQUIRED', 'no challenge under V1');
  const bounded = createRestartAuthority({ services: Array.from({ length: 20 }, (_, i) => `svc-${i}`), policyView: viewFor(V2), policyDecide: () => null });
  for (let i = 0; i < 20; i++) bounded.issueChallenge({ serviceId: `svc-${i}`, status: liveStatus({ serviceId: `svc-${i}` }), origin: UI_ORIGIN, actor: 'USER' });
  assert.ok(bounded.stats().openChallenges <= RESTART_CEREMONY_LIMITS.maxOpenChallenges, 'bounded store');
});

test('7. CHALLENGE: a missing / failing / non-ALLOW policy decision never mints an authorization', () => {
  for (const [label, policyDecide, expected] of [
    ['V1 decision', (q) => e1.decide(q), 'ROOT_POLICY_APPROVAL_REQUIRED'], ['throws', () => { throw new Error('x'); }, 'ROOT_POLICY_DENIED'],
    ['null', () => null, 'ROOT_POLICY_DENIED'], ['ALLOW without boundary', () => ({ decision: 'ALLOW', code: 'ALLOW_CAPABILITY' }), 'ROOT_POLICY_DENIED'],
    ['boundary of another module', () => ({ decision: 'ALLOW', code: 'ALLOW_CERTIFIED_BOUNDARY', boundary: 'maitre-certified' }), 'ROOT_POLICY_DENIED'],
  ]) {
    const a = createRestartAuthority({ services: ['kiwix-serve'], policyView: viewFor(V2), policyDecide });
    const c = issue(a);
    const r = confirmA(a, c.challengeId);
    assert.deepEqual([r.ok, r.code, 'authorization' in r], [false, expected, false], label);
  }
});

// ═══════════════════════════ OPAQUE AUTHORIZATION ══════════════════════════════════════════════════════════════════════
test('8. AUTHORIZATION: opaque, unforgeable from data, bound, single use, short-lived, authority-specific', () => {
  const { a, tick } = authorityRig();
  const auth = confirmA(a, issue(a).challengeId).authorization;
  const bind = { serviceId: 'kiwix-serve', definitionDigest: DIGEST, generation: 7 };
  assert.equal(JSON.stringify({ auth }), '{"auth":"[runtime-restart-authorization]"}', 'serializes to a fixed marker: nothing to replay');
  assert.deepEqual(Object.keys(auth), []); assert.ok(Object.isFrozen(auth));
  const forgeries = [JSON.parse(JSON.stringify(auth)), structuredClone(auth), { ...auth }, Object.assign({}, auth), Object.create(Object.getPrototypeOf(auth)), new auth.constructor(), {}, null, undefined, true, 'x'];
  for (const f of forgeries) assert.equal(a.redeem(f, bind), false, `forgery ${typeof f}`);
  assert.equal(authorityRig().a.redeem(auth, bind), false, 'another authority instance does not know it');
  assert.equal(a.redeem(auth, { ...bind, generation: 8 }), false, 'wrong generation');
  assert.equal(a.redeem(auth, bind), false, 'a mismatch burns it');
  const auth2 = confirmA(a, issue(a).challengeId).authorization;
  assert.equal(a.redeem(auth2, { ...bind, definitionDigest: 'c'.repeat(64) }), false, 'wrong digest');
  const auth3 = confirmA(a, issue(a).challengeId).authorization;
  assert.equal(a.redeem(auth3, { ...bind, serviceId: 'ollama' }), false, 'wrong service');
  const auth4 = confirmA(a, issue(a).challengeId).authorization;
  assert.equal(a.redeem(auth4, bind), true); assert.equal(a.redeem(auth4, bind), false, 'single use');
  const auth5 = confirmA(a, issue(a).challengeId).authorization;
  tick(RESTART_CEREMONY_LIMITS.authorizationTtlMs); assert.equal(a.redeem(auth5, bind), false, 'expired');
});

// ═══════════════════════════ DEFINITION DIGEST ═════════════════════════════════════════════════════════════════════════
test('9. DIGEST: deterministic; covers binary (path / size / mtime / content), argv, cwd, port; a changed setting / binary invalidates', async () => {
  const base = { binary: { path: 'C:\\K\\kiwix-serve.exe', size: 10, mtimeMs: 1, sha256: 'd'.repeat(64) }, args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'C:\\Z\\a.zim'], cwd: 'C:\\K', port: 8090 };
  const d0 = kiwixDefinitionDigest(base);
  assert.equal(kiwixDefinitionDigest(structuredClone(base)), d0); assert.match(d0, /^[0-9a-f]{64}$/);
  const variants = {
    path: { ...base, binary: { ...base.binary, path: 'C:\\L\\kiwix-serve.exe' } }, size: { ...base, binary: { ...base.binary, size: 11 } },
    mtime: { ...base, binary: { ...base.binary, mtimeMs: 2 } }, content: { ...base, binary: { ...base.binary, sha256: 'e'.repeat(64) } },
    args: { ...base, args: [...base.args, 'C:\\Z\\b.zim'] }, cwd: { ...base, cwd: 'C:\\L' }, port: { ...base, port: 8091 },
  };
  const all = new Set([d0, ...Object.values(variants).map(kiwixDefinitionDigest)]);
  assert.equal(all.size, 1 + Object.keys(variants).length, 'every covered property changes the digest');
  // live: a settings change, a replaced binary of another size, and a same-size rewrite with the modification time put back
  const r = await rig();
  const before = r.lc.describe().definitionDigest;
  assert.equal(r.lc.describe().definitionDigest, before, 'stable while nothing changes');
  r.settings.port += 1; const portChanged = r.lc.describe().definitionDigest; r.settings.port -= 1;
  const original = fs.readFileSync(BINARY); const st = fs.statSync(BINARY);
  fs.writeFileSync(BINARY, 'stand-in, never executed, longer'); const sizeChanged = r.lc.describe().definitionDigest;
  fs.writeFileSync(BINARY, Buffer.from(original.toString().replace(/d$/, 'D'))); fs.utimesSync(BINARY, st.atime, st.mtime);
  const sameSizeSwap = r.lc.describe().definitionDigest;
  fs.writeFileSync(BINARY, original);
  assert.equal(new Set([before, portChanged, sizeChanged, sameSizeSwap]).size, 4, 'each change invalidates');
});

// ═══════════════════════════ SUPERVISOR + ROUTE + REAL FIXTURE PROCESSES ═════════════════════════════════════════════
test('10. DELEGATED RESTART over HTTP: challenge → confirm → HEALTHY→STOPPING→STOPPED→STARTING→HEALTHY, new pid, old process gone; Kiwix stays the source of truth', async () => {
  const w = await world();
  await w.lc.start();
  const before = w.lc.status();
  const view = await w.sup.get('kiwix-serve');
  assert.deepEqual([view.kind, view.state, view.restart.allowed, view.restart.code], ['DELEGATED', 'HEALTHY', true, 'CHALLENGE_REQUIRED']);
  assert.equal(JSON.stringify(view).includes(TMP) || JSON.stringify(view).includes(before.port ? `--port=${before.port}` : '@@'), false, 'no path / argv in the view');
  const c = await w.challenge();
  assert.equal(c.status, 201);
  assert.deepEqual(Object.keys(c.json.value).sort(), ['challengeId', 'effects', 'expiresAt', 'operation', 'serviceId', 'state']);
  assert.deepEqual(c.json.value.effects, ['IN_FLIGHT_REQUESTS_INTERRUPTED', 'LOCAL_ARCHIVES_UNCHANGED']);
  const mark = w.logs.length;
  const ok = await w.confirm(c.json.value.challengeId);
  assert.equal(ok.status, 202);
  await w.sup.whenIdle('kiwix-serve');
  const after = w.lc.status();
  assert.deepEqual(w.transitions(mark), ['HEALTHY>STOPPING', 'STOPPING>STOPPED', 'STOPPED>STARTING', 'STARTING>HEALTHY']);
  assert.deepEqual([after.state, after.generation, after.binding, after.port], ['HEALTHY', before.generation + 1, 'LOOPBACK_ONLY', before.port], 'old listener released and replacement rebound the same loopback port');
  assert.notEqual(after.pid, before.pid); assert.equal(alive(before.pid), false); assert.equal(alive(after.pid), true);
  const restartLogs = w.logs.slice(mark);
  const processAllow = restartLogs.findIndex(e => e.event === 'root_policy_decision' && e.action === 'PROCESS_START' && e.decision === 'ALLOW' && e.decisionCode === 'ALLOW_INTERNAL_TYPED_EXECUTOR' && e.policyVersion === 2);
  const launched = restartLogs.findIndex(e => e.event === 'launched');
  assert.ok(w.decisions.some(r => r.action === 'SERVICE_RESTART'), 'SERVICE_RESTART candidate decision observed');
  assert.ok(processAllow >= 0 && launched > processAllow, 'typed V2 PROCESS_START ALLOW is recorded before the replacement spawn');
  const search = await realFetch(`http://127.0.0.1:${after.port}/search?content=pokepedia&pattern=fixture`);
  assert.equal(search.status, 200); assert.match(await search.text(), /\/content\/pokepedia\/A\/Fixture/);
  const content = await realFetch(`http://127.0.0.1:${after.port}/content/pokepedia/A/Fixture`);
  assert.equal(content.status, 200); assert.match(await content.text(), /Local Kiwix fixture content/);
  assert.equal(w.calls.length, 2);
  const v2 = await w.sup.get('kiwix-serve');
  assert.deepEqual([v2.state, v2.restartCount, v2.lastError, v2.pid], [after.state, 1, null, after.pid], 'the projection equals the owner\'s state');
  const events = w.sup.events('kiwix-serve', 50).map(e => e.event);
  for (const e of ['CHALLENGE_CREATED', 'CHALLENGE_CONFIRMED', 'RESTART_STARTED', 'RESTART_SUCCEEDED']) assert.ok(events.includes(e), e);
  assert.equal(events.includes('TRANSITION'), false, 'no second state machine for a delegated service');
  const auditText = JSON.stringify(w.sup.events('kiwix-serve', 50));
  assert.equal(auditText.includes(c.json.value.challengeId), false, 'the challenge id is never audited');
  for (const s of [TMP, BIN_DIR, '--blockexternal', '--address']) assert.equal(auditText.includes(s), false);
  // replay after a successful real restart
  const replay = await w.confirm(c.json.value.challengeId);
  assert.deepEqual([replay.status, replay.json.error.code], [409, 'RS_CHALLENGE_REPLAYED']);
  assert.equal(w.calls.length, 2, 'replay restarted nothing');
  assert.ok(w.sup.events('kiwix-serve', 50).some(e => e.event === 'CHALLENGE_REPLAY_REJECTED'));
  await cleanup(w);
});

test('11. GENERATION / INSTANCE: independent restart, manual stop, manual start, crash ⇒ the outstanding challenge is stale; nothing is restarted', async () => {
  const w = await world({ modes: ['healthy', 'healthy', 'healthy', 'crash-after'] });
  await w.lc.start();
  const expectStale = async (label, mutate) => {
    const c = await w.challenge();
    assert.equal(c.status, 201, `${label}: challenge`);
    await mutate();
    const launches = w.calls.length;
    const r = await w.confirm(c.json.value.challengeId);
    assert.equal(r.status, 409, `${label}: ${r.status} ${r.json.error?.code}`);
    assert.equal(r.json.error.code, 'RS_CHALLENGE_STALE', label);
    await w.sup.whenIdle('kiwix-serve');
    assert.equal(w.calls.length, launches, `${label}: the stale ceremony launched nothing`);
    assert.equal(w.decisions.length, 0, `${label}: Root Policy never asked`);
  };
  await expectStale('independent restart', async () => { await w.lc.stop(); await w.lc.start(); });
  await expectStale('manual stop', async () => { await w.lc.stop(); });
  // stopped: no challenge can be issued at all
  const stopped = await w.challenge();
  assert.deepEqual([stopped.status, stopped.json.error.code], [409, 'RS_NOT_RUNNING']);
  await w.lc.start();
  // generation bump by a manual start after a stop the challenge did not see
  const c = await w.challenge(); await w.lc.stop(); await w.lc.start();
  const r = await w.confirm(c.json.value.challengeId); assert.equal(r.json.error.code, 'RS_CHALLENGE_STALE', 'manual start');
  // crash: the 4th launch crashes after ~700 ms
  await w.lc.stop(); await w.lc.start();
  const cc = await w.challenge();
  for (let i = 0; i < 60 && w.lc.status().state !== 'CRASHED'; i++) await sleep(50);
  assert.equal(w.lc.status().state, 'CRASHED');
  const rc = await w.confirm(cc.json.value.challengeId); assert.equal(rc.json.error.code, 'RS_CHALLENGE_STALE', 'crash');
  assert.equal(w.decisions.length, 0);
  await cleanup(w);
});

test('12. FAILURES: stop failure ⇒ no replacement started (RESTART_FAILED / STOP_FAILED); start failure ⇒ deterministic CRASHED (RESTART_FAILED / PROCESS_EXITED)', async () => {
  const stuck = await world({ terminate: () => {}, forceKill: async () => {} });
  await stuck.lc.start();
  const pid = stuck.lc.status().pid;
  const c = await stuck.challenge();
  assert.equal((await stuck.confirm(c.json.value.challengeId)).status, 202);
  await stuck.sup.whenIdle('kiwix-serve');
  const v = await stuck.sup.get('kiwix-serve');
  assert.deepEqual([v.lastError, stuck.calls.length, stuck.lc.status().pid, stuck.lc.status().state], ['STOP_FAILED', 1, pid, 'DEGRADED'], 'never a second instance');
  assert.ok(stuck.sup.events('kiwix-serve', 50).some(e => e.event === 'RESTART_FAILED' && e.reason === 'STOP_FAILED'));
  await killProcessTree(stuck.calls[0].child); // our own fixture handle (test cleanup only)
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);

  const broken = await world({ modes: ['healthy', 'crash-on-start'] });
  await broken.lc.start();
  const c2 = await broken.challenge();
  assert.equal((await broken.confirm(c2.json.value.challengeId)).status, 202);
  await broken.sup.whenIdle('kiwix-serve');
  const v2 = await broken.sup.get('kiwix-serve');
  assert.deepEqual([v2.state, v2.lastError, broken.lc.status().state, v2.restart.allowed, v2.restart.code], ['CRASHED', 'PROCESS_EXITED', 'CRASHED', false, 'NOT_RUNNING']);
  assert.ok(broken.sup.events('kiwix-serve', 50).some(e => e.event === 'RESTART_FAILED' && e.reason === 'PROCESS_EXITED'));
  await cleanup(broken);
});

test('13. HTTP CONTRACT: closed bodies, unknown fields 400, unknown service 404, non-UI callers 403, the boolean restart path refuses a delegated service', async () => {
  const w = await world();
  await w.lc.start();
  // unknown fields / injected authority-looking fields, on both routes
  for (const field of ['certifiedBoundary', 'approval', 'token', 'approvalToken', 'serviceAllowlist', 'target', 'payloadHash', 'executable', 'args', 'cwd', 'pid', 'shell', 'command', 'action', 'serviceId', 'policy', 'module']) {
    const body = { [field]: field === 'certifiedBoundary' ? true : 'x' };
    const a = await w.post('kiwix-serve/restart-challenge', body);
    assert.deepEqual([a.status, a.json.error.reason], [400, 'UNKNOWN_FIELD'], `challenge ${field}`);
    const b = await w.post('kiwix-serve/restart-confirm', { challengeId: 'x', gesture: { kind: 'POINTER', trusted: true }, [field]: body[field] });
    assert.deepEqual([b.status, b.json.error.reason], [400, 'UNKNOWN_FIELD'], `confirm ${field}`);
  }
  for (const bad of ['[]', '"x"', 'not json', JSON.stringify({ challengeId: 1, gesture: { kind: 'POINTER', trusted: true } }), JSON.stringify({ challengeId: 'x', gesture: { kind: 'POINTER' } }),
    JSON.stringify({ challengeId: 'x', gesture: { kind: 'POINTER', trusted: true, x: 1 } }), JSON.stringify({ challengeId: 'x'.repeat(65), gesture: { kind: 'POINTER', trusted: true } }), 'x'.repeat(2000)]) {
    assert.equal((await w.post('kiwix-serve/restart-confirm', bad)).status, 400, bad.slice(0, 40));
  }
  const malformed = await w.confirm('not-a-challenge');
  assert.deepEqual([malformed.status, malformed.json.error.code], [400, 'RS_CHALLENGE_INVALID']);
  for (const p of ['nope-service/restart-challenge', 'nope-service/restart-confirm']) assert.equal((await w.post(p, p.endsWith('confirm') ? { challengeId: 'x', gesture: G } : undefined)).status, 404, p);
  for (const p of ['ollama/restart-challenge', 'docteur-backend/restart-challenge']) assert.equal((await w.post(p)).json.error.code, 'RS_RESTART_NOT_ALLOWED', p);
  // non-UI callers: no Origin (curl / agent), foreign origin, cross-site / missing fetch metadata, non-loopback peer, AI / agent actor context
  const reasons = async (headers) => (await w.challenge(headers)).json.error?.reason;
  assert.equal(await reasons({ 'content-type': 'application/json' }), 'UI_ORIGIN_REQUIRED');
  assert.equal(await reasons({ ...UI, origin: 'https://evil.example' }), 'UI_ORIGIN_REQUIRED');
  assert.equal(await reasons({ ...UI, origin: 'null' }), 'UI_ORIGIN_REQUIRED');
  assert.equal(await reasons({ ...UI, 'sec-fetch-site': 'cross-site' }), 'BROWSER_UI_REQUIRED');
  assert.equal(await reasons({ ...UI, 'sec-fetch-site': 'none' }), 'BROWSER_UI_REQUIRED');
  const { 'sec-fetch-site': _drop, ...noSite } = UI; assert.equal(await reasons(noSite), 'BROWSER_UI_REQUIRED');
  const remote = await world({ loopback: false }); await remote.lc.start();
  assert.equal((await remote.challenge()).json.error.reason, 'REMOTE_PEER'); await cleanup(remote);
  for (const kind of ['AI_LOCAL', 'AI_CLOUD', 'AGENT', 'MODULE', 'PLUGIN', 'MCP', 'REMOTE', 'DOCUMENT']) {
    const res = await rootPolicy.runWithActor({ kind, userInitiated: false }, () => w.challenge());
    assert.deepEqual([res.status, res.json.error.reason], [403, 'ACTOR_NOT_PERMITTED'], kind);
  }
  const old = await w.post('kiwix-serve/restart', { confirmInterrupt: true });
  assert.deepEqual([old.status, old.json.error.code], [409, 'RS_CHALLENGE_REQUIRED'], 'the V1 boolean path never restarts a delegated service');
  // stale browser confirmation: issued to one UI origin, confirmed from another
  const c = await w.challenge();
  const other = await w.confirm(c.json.value.challengeId, { headers: { ...UI, origin: 'http://localhost:5173' } });
  assert.deepEqual([other.status, other.json.error.code], [403, 'RS_CHALLENGE_MISMATCH']);
  // untrusted gesture is refused and burns the ceremony
  const c2 = await w.challenge();
  assert.equal((await w.confirm(c2.json.value.challengeId, { gesture: { kind: 'POINTER', trusted: false } })).json.error.code, 'RS_REQUEST_INVALID');
  assert.equal((await w.confirm(c2.json.value.challengeId)).json.error.code, 'RS_CHALLENGE_REPLAYED');
  assert.equal(w.calls.length, 1, 'nothing restarted by any of the above');
  await cleanup(w);
});

test('14. CONCURRENT confirmations of one challenge ⇒ exactly one restart', async () => {
  const w = await world();
  await w.lc.start();
  const c = await w.challenge();
  const [a, b] = await Promise.all([w.confirm(c.json.value.challengeId), w.confirm(c.json.value.challengeId)]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  assert.ok(['RS_OPERATION_IN_PROGRESS', 'RS_CHALLENGE_REPLAYED'].includes((a.status === 409 ? a : b).json.error.code));
  await w.sup.whenIdle('kiwix-serve');
  assert.equal(w.calls.length, 2, 'one restart = exactly one new launch');
  assert.equal(w.decisions.length, 1, 'one Root Policy request');
  await cleanup(w);
});

// ═══════════════════════════ LIVE: the real product composition under the shipped signed V2 ═══════════════════════════
// (The "view claims a boundary but the decision refuses ⇒ nothing minted" path is covered against the historical V1 in tests 6–7.)
test('15. LIVE (shipped signed V2, server.js composition: real decide, real view, product Kiwix gate): restart offered, boolean path refused, ONE real ceremony restarts exactly once, replay refused, policy untouched', async () => {
  const w = await world({ policy: 'LIVE' });
  await w.lc.start();
  const live = rootPolicy.getRootPolicyStatus();
  assert.deepEqual([live.state, live.version, live.sha256, live.keyId], ['VALID', SHIPPED_POLICY.version, SHIPPED_POLICY.sha256.slice(0, 16), SHIPPED_POLICY.keyId.slice(0, 16)], 'the live policy is the reviewed shipped V2');
  const before = w.lc.status();
  const view = await w.sup.get('kiwix-serve');
  assert.deepEqual([view.state, view.restart.allowed, view.restart.code], ['HEALTHY', true, 'CHALLENGE_REQUIRED']);
  const old = await w.post('kiwix-serve/restart', { confirmInterrupt: true });
  assert.deepEqual([old.status, old.json.error.code], [409, 'RS_CHALLENGE_REQUIRED'], 'the boolean path never restarts a delegated service');
  const notUi = await w.challenge({ 'content-type': 'application/json' });
  assert.deepEqual([notUi.status, notUi.json.error.code], [403, 'RS_ACTOR_NOT_PERMITTED'], 'no browser UI headers ⇒ no challenge');
  const c = await w.challenge();
  assert.equal(c.status, 201);
  const ok = await w.confirm(c.json.value.challengeId);
  assert.equal(ok.status, 202);
  await w.sup.whenIdle('kiwix-serve');
  const after = w.lc.status();
  assert.deepEqual([after.state, after.generation, w.calls.length], ['HEALTHY', before.generation + 1, 2], 'exactly one replacement launch');
  assert.notEqual(after.pid, before.pid);
  assert.equal(alive(before.pid), false, 'the old instance exited');
  const replay = await w.confirm(c.json.value.challengeId);
  assert.deepEqual([replay.status, replay.json.error.code], [409, 'RS_CHALLENGE_REPLAYED']);
  assert.deepEqual([w.lc.status().pid, w.calls.length], [after.pid, 2], 'replay changed nothing');
  assert.deepEqual(POLICY_FILES.map(fileHash), policyBefore, 'live policy files untouched');
  await cleanup(w);
});

// ═══════════════════════════ STATIC: who can mint, who can call, what HTTP can carry ═══════════════════════════════
const SRC = path.join(HERE, 'src');
// comments only: block comments that START a line (a '/api/*' string glob must not open a "comment"), line comments
const strip = (s) => s.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const allSources = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) out.push({ rel: path.relative(SRC, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') }); } }; walk(SRC); return out; };

test('16. STATIC: certifiedBoundary is set only by the Root Policy route gate (route-map driven) and ONCE by the restart authority, after the challenge is burnt', () => {
  const users = allSources().filter(f => /certifiedBoundary/.test(strip(f.text))).map(f => f.rel).sort();
  assert.deepEqual(users, ['lib/root-policy/engine.js', 'lib/root-policy/index.js', 'lib/runtime-restart-authority.js']);
  const idx = strip(fs.readFileSync(path.join(SRC, 'lib/root-policy/index.js'), 'utf8'));
  assert.equal((idx.match(/certifiedBoundary/g) ?? []).length, 1);
  assert.match(idx, /const d = decide\(\{ action: route\.action, module: route\.module,[^\n]*certifiedBoundary: true \}\)/, 'the gate passes it for classified frozen device routes only');
  const auth = strip(fs.readFileSync(path.join(SRC, 'lib/runtime-restart-authority.js'), 'utf8'));
  assert.equal((auth.match(/certifiedBoundary/g) ?? []).length, 1);
  const confirmFn = auth.slice(auth.indexOf('function confirmChallenge('), auth.indexOf('function redeem('));
  assert.ok(confirmFn.indexOf('burn(challengeId)') > 0 && confirmFn.indexOf('burn(challengeId)') < confirmFn.indexOf('certifiedBoundary: true'), 'burn BEFORE the policy request');
  assert.ok(confirmFn.indexOf('certifiedBoundary: true') < confirmFn.indexOf('new RuntimeRestartAuthorization()'), 'mint AFTER the policy decision');
  assert.equal((auth.match(/new RuntimeRestartAuthorization\(\)/g) ?? []).length, 1, 'one mint site');
  assert.doesNotMatch(confirmFn, /\bawait\b|\.then\(|setTimeout/, 'confirm is synchronous (no interleaving between burn and mint)');
  assert.doesNotMatch(auth, /export class|export \{[^}]*RuntimeRestartAuthorization/, 'the authorization class is not exported');
});

test('17. STATIC: HTTP can never carry the flag, an approval token, a process field or a generic action; only the composition root wires the restart port', () => {
  const route = strip(fs.readFileSync(path.join(SRC, 'routes/runtime-supervisor.js'), 'utf8'));
  // the code that handles requests, without the fixed error-code tables / French messages (RS_POLICY_APPROVAL_REQUIRED is a response code)
  const handling = route.slice(route.indexOf('export function createRuntimeSupervisorRoute')).replace(/RS_[A-Z_]+/g, 'RS_CODE');
  assert.doesNotMatch(handling, /certifiedBoundary|approval|token|executable|\bargs\b|\bcwd\b|\bpid\b|shell|spawn|exec|kill|restartOwned|redeem|policyDecide|root-policy\//i);
  assert.doesNotMatch(route, /certifiedBoundary|root-policy\//);
  assert.match(route, /const CONFIRM_FIELDS = Object\.freeze\(\['challengeId', 'gesture'\]\);/);
  assert.match(route, /await jsonBody\(c, \[\]\);/, 'the challenge request takes no field');
  assert.match(route, /s\.createRestartChallenge\(id, \{ origin, actor: 'USER' \}\)/); assert.match(route, /s\.confirmRestart\(id, \{ \.\.\.body, origin, actor: 'USER' \}\)/);
  const files = allSources();
  const using = (re) => files.filter(f => re.test(strip(f.text))).map(f => f.rel).sort();
  assert.deepEqual(using(/createKiwixLifecyclePort\(/), ['lib/kiwix.js', 'server.js']);
  assert.deepEqual(using(/restartOwnedKiwix/), ['lib/kiwix.js', 'lib/runtime-supervisor-services.js']);
  assert.deepEqual(using(/createRestartAuthority\(/), ['lib/runtime-restart-authority.js', 'server.js']);
  assert.deepEqual(using(/\.redeem\b/), ['server.js'], 'only the composition root hands redeem to the Kiwix port');
  assert.deepEqual(using(/restartAuthority\.(confirmChallenge|issueChallenge)\(/), ['lib/runtime-supervisor.js']);
  assert.deepEqual(using(/runtime-restart-authority\.js/), ['routes/runtime-supervisor.js', 'server.js'], 'importers: the composition root + the route (ceremonyActorKind only)');
  assert.match(strip(fs.readFileSync(path.join(SRC, 'routes/runtime-supervisor.js'), 'utf8')), /import \{ ceremonyActorKind \} from '\.\.\/lib\/runtime-restart-authority\.js';/);
  const server = strip(fs.readFileSync(path.join(SRC, 'server.js'), 'utf8'));
  assert.match(server, /createKiwixLifecyclePort\(\{ redeemRestartAuthorization: runtimeRestartAuthority\.redeem \}\)/);
  assert.match(server, /createRestartAuthority\(\{ services: \[KIWIX_SERVICE_ID\] \}\)/, 'product = the REAL Root Policy (no injected decide / view)');
  const kiwix = strip(fs.readFileSync(path.join(SRC, 'lib/kiwix.js'), 'utf8'));
  assert.doesNotMatch(kiwix, /root-policy\/|certifiedBoundary|rootPolicyDecide/, 'the delegate cannot authorise itself');
  const sup = strip(fs.readFileSync(path.join(SRC, 'lib/runtime-supervisor.js'), 'utf8'));
  assert.equal((sup.match(/restartOwnedInstance\(/g) ?? []).length, 1); assert.match(sup, /def\.delegate\.restartOwnedInstance\(r\.authorization\)/);
  assert.doesNotMatch(sup, /\bexecute\(|\brun\(|kill\(pid|delegate\.(spawn|kill|exec)/);
  const services = strip(fs.readFileSync(path.join(SRC, 'lib/runtime-supervisor-services.js'), 'utf8'));
  assert.doesNotMatch(services, /executable|\bargs\b|\bcwd\b|kiwixServePath|spawn/);
  const ui = strip(fs.readFileSync(path.join(HERE, '..', 'src', 'lib', 'runtime', 'http-port.ts'), 'utf8'));
  assert.doesNotMatch(ui, /certifiedBoundary|approval|token|executable|\bcwd\b|\bpid\b/i);
});

test('18. ISOLATION: 0 external network, real DB / Companion store / active policy untouched, no fixture left running', async () => {
  for (let i = 0; i < 40 && children.some(c => c.exitCode === null && c.signalCode === null); i++) await sleep(50);
  assert.equal(externalFetches, 0);
  assert.deepEqual(REAL.map(fileHash), realBefore);
  assert.deepEqual(POLICY_FILES.map(fileHash), policyBefore);
  assert.deepEqual(children.filter(c => c.exitCode === null && c.signalCode === null).map(c => c.spawnargs.slice(2, 4).join(' ')), []);
});
