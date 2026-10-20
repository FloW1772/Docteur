import './test-setup.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from './src/lib/root-policy/engine.js';
import { buildDefaultPolicy } from './src/lib/root-policy/default-policy.js';
import { createKiwixProcessPolicyGate } from './src/lib/kiwix-process-policy.js';
import { createKiwixLifecycle, createKiwixLifecyclePort, KIWIX_BINARY_NAME } from './src/lib/kiwix.js';

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiwix-v2b-')));
const binDir = path.join(scratch, 'Kiwix Tools');
const zimDir = path.join(scratch, 'ZIM');
fs.mkdirSync(binDir); fs.mkdirSync(zimDir);
fs.writeFileSync(path.join(binDir, KIWIX_BINARY_NAME), 'test executable');
fs.writeFileSync(path.join(zimDir, 'offline.zim'), 'test archive');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const V1 = buildDefaultPolicy({ version: 1, issuedAt: '2026-10-02T00:00:00.000Z' });
const V2 = buildDefaultPolicy({ version: 2, issuedAt: '2026-10-19T00:00:00.000Z' });
const view = (policy, state = 'VALID') => ({ status: { state, version: state === 'VALID' ? policy?.version ?? 0 : 0 }, policy: state === 'VALID' ? policy : null });
const gateFor = (policy, state = 'VALID') => {
  const engine = createEngine({ getPolicy: () => ({ valid: state === 'VALID', policy, version: policy?.version ?? 0 }) });
  return createKiwixProcessPolicyGate({ getPolicyViewFn: () => view(policy, state), decideFn: engine.decide });
};

let nextPid = 51_000;
class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = nextPid++; this.exitCode = null; this.signalCode = null; }
  kill() { queueMicrotask(() => { this.exitCode = 0; this.emit('exit', 0); }); return true; }
}

function rig({ policyGate = gateFor(V2), settings = {}, health = async () => false, listListeners = async () => ({ ok: true, listeners: [] }) } = {}) {
  const calls = []; const decisions = [];
  const recordingGate = { evaluate(req) { const d = policyGate.evaluate(req); decisions.push({ req, d }); return d; } };
  const lc = createKiwixLifecycle({
    policyGate: recordingGate,
    spawnFn: (command, args, options) => { const child = new FakeChild(); calls.push({ command, args, options, child }); return child; },
    getSettings: () => ({ kiwixServePath: binDir, archivesFolder: zimDir, port: 18_941, ...settings }),
    portFree: async () => true, health, listListeners,
    limits: { healthAttempts: 0, healthIntervalMs: 1, verifyWindowMs: 20, stopGraceMs: 20, forceWaitMs: 20, portReleaseMs: 20 },
  });
  return { lc, calls, decisions };
}

test('V2 USER start checks and executes the same immutable canonical launch plan', async () => {
  const r = rig();
  const result = await r.lc.start({ actor: 'USER', userInitiated: true, reason: 'USER_START_ROUTE', healthCheckAttempts: 0 });
  assert.equal(result.ok, true);
  assert.equal(r.calls.length, 1);
  const policy = r.decisions.find(x => x.req.action === 'PROCESS_START');
  assert.deepEqual([policy.req.actor, policy.req.userInitiated, policy.d.decision, policy.d.code], ['USER', true, 'ALLOW', 'ALLOW_INTERNAL_TYPED_EXECUTOR']);
  assert.equal(r.calls[0].command, policy.req.plan.executable);
  assert.equal(r.calls[0].args, policy.req.plan.args, 'spawn receives the exact argv object checked by policy');
  assert.equal(r.calls[0].options, policy.req.plan.spawnOptions, 'spawn receives the exact options object checked by policy');
  assert.equal(Object.isFrozen(policy.req.plan), true);
  assert.equal(Object.isFrozen(policy.req.plan.args), true);
  assert.deepEqual({ executor: policy.req.plan.executorId, address: policy.req.plan.address, blockExternal: policy.req.plan.blockExternal, shell: policy.req.plan.spawnOptions.shell, env: policy.req.plan.environment.contract }, {
    executor: 'kiwix-serve', address: '127.0.0.1', blockExternal: true, shell: false, env: 'MINIMAL_ALLOWLIST',
  });
  await r.lc.stop({ actor: 'USER', userInitiated: true });
});

test('V2 typed-plan mutations deny before spawn', async (t) => {
  const mutations = {
    'wrong executable': p => ({ ...p, executable: 'C:\\Windows\\System32\\cmd.exe' }),
    'wrong executor': p => ({ ...p, executorId: 'shell' }),
    'shell true': p => ({ ...p, viaShell: true, spawnOptions: { ...p.spawnOptions, shell: true } }),
    'wrong cwd': p => ({ ...p, cwd: 'C:\\Windows' }),
    'wide binding': p => ({ ...p, args: p.args.map(a => a === '--address=127.0.0.1' ? '--address=0.0.0.0' : a), address: '0.0.0.0' }),
    'missing blockexternal': p => ({ ...p, args: p.args.filter(a => a !== '--blockexternal'), blockExternal: false }),
    'extra argument': p => ({ ...p, args: [...p.args, '--library'] }),
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const v2 = gateFor(V2); let calls = 0;
    const transformingGate = { evaluate(req) { calls++; return v2.evaluate(req.action === 'PROCESS_START' ? { ...req, plan: mutate(req.plan) } : req); } };
    const r = rig({ policyGate: transformingGate });
    const result = await r.lc.start({ actor: 'USER', userInitiated: true, healthCheckAttempts: 0 });
    assert.deepEqual([result.ok, result.error, r.calls.length, calls], [false, 'policy_denied', 0, 1]);
    assert.match(result.decisionCode, /^DENY_/);
  });
});

test('invalid/reserved port and malformed archive contract deny before policy or spawn', async () => {
  for (const settings of [{ port: 3001 }, { port: 65_536 }, { archivesFolder: path.join(scratch, 'missing') }]) {
    const r = rig({ settings });
    const result = await r.lc.start({ actor: 'USER', userInitiated: true });
    assert.equal(result.ok, false);
    assert.equal(r.calls.length, 0);
    assert.equal(r.decisions.length, 0);
  }
});

test('V2 actor/module boundary: only trusted user gesture or MODULE can use the exact Kiwix executor', () => {
  const form = { executorId: 'kiwix-serve', executable: 'C:\\Program Files\\Kiwix\\kiwix-serve.exe', args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'D:\\zim\\a.zim'], cwd: 'C:\\Program Files\\Kiwix', argsTyped: true, freeFormCommand: false, viaShell: false };
  const engine = createEngine({ getPolicy: () => ({ valid: true, policy: V2, version: 2 }) });
  const decide = (overrides = {}) => engine.decide({ action: 'PROCESS_START', module: 'kiwix', trustDomain: 'PROCESS', actor: { kind: 'USER' }, userInitiated: true, context: form, ...overrides });
  assert.equal(decide().decision, 'ALLOW');
  assert.equal(decide({ userInitiated: false }).code, 'DENY_NOT_USER_INITIATED');
  assert.match(decide({ module: 'browser' }).code, /^DENY_/);
  for (const kind of ['AI_LOCAL', 'AI_CLOUD', 'AGENT', 'PLUGIN', 'MCP', 'REMOTE', 'CONNECTOR', 'DOCUMENT']) assert.equal(decide({ actor: { kind } }).code, 'DENY_ACTOR_NOT_PERMITTED', kind);
});

test('policy-version matrix is exact: V1 migration only; V2 mandatory; invalid/future deny', async () => {
  for (const [name, policyGate, expected] of [
    ['V1', gateFor(V1), true],
    ['V2', gateFor(V2), true],
    ['invalid', gateFor(null, 'INVALID'), false],
    ['unknown V3', gateFor(buildDefaultPolicy({ version: 3, issuedAt: '2026-10-19T00:00:00.000Z' })), false],
  ]) {
    const r = rig({ policyGate });
    const result = await r.lc.start({ actor: 'USER', userInitiated: true, healthCheckAttempts: 0 });
    assert.equal(result.ok, expected, name);
    assert.equal(r.calls.length, expected ? 1 : 0, name);
    if (expected) await r.lc.stop({ actor: 'USER', userInitiated: true });
  }
  const missing = structuredClone(V2); delete missing.modules.kiwix;
  const malformed = structuredClone(V2); malformed.capabilities['PROCESS.START_TYPED'].constraints.executors.kiwix['kiwix-serve'].argsTemplates = ['url'];
  for (const [name, policy] of [['missing module', missing], ['malformed executor semantics', malformed]]) {
    const r = rig({ policyGate: gateFor(policy) });
    const result = await r.lc.start({ actor: 'USER', userInitiated: true });
    assert.deepEqual([result.ok, r.calls.length], [false, 0], name);
  }
});

test('USER stop maps to PROCESS_STOP/ALLOW_STOP_ALWAYS and only terminates the owned child', async () => {
  const r = rig();
  await r.lc.start({ actor: 'USER', userInitiated: true, healthCheckAttempts: 0 });
  const owned = r.calls[0].child;
  const stopped = await r.lc.stop({ actor: 'USER', userInitiated: true, reason: 'USER_STOP_ROUTE' });
  assert.deepEqual([stopped.ok, stopped.state, owned.exitCode, r.lc.status().running], [true, 'STOPPED', 0, false], JSON.stringify({ stopped, decisions: r.decisions.map(x => ({ action: x.req.action, actor: x.req.actor, decision: x.d })) }));
  const d = r.decisions.find(x => x.req.action === 'PROCESS_STOP');
  assert.deepEqual([d.req.actor, d.req.userInitiated, d.d.decision, d.d.code], ['USER', true, 'ALLOW', 'ALLOW_STOP_ALWAYS']);
});

test('internal unsafe-binding cleanup maps MODULE stop-always and remains available', async () => {
  let childPid = null; let healthCalls = 0;
  const r = rig({
    health: async () => (++healthCalls === 2),
    listListeners: async () => ({ ok: true, listeners: [{ address: '0.0.0.0', port: 18_941, pid: childPid }] }),
  });
  const oldSpawn = r.lc.start.bind(r.lc);
  // The listener PID is learned synchronously when spawn returns.
  const start = oldSpawn({ actor: 'MODULE', userInitiated: false, healthCheckAttempts: 1, healthCheckIntervalMs: 1 });
  await new Promise(resolve => setImmediate(resolve)); childPid = r.calls[0]?.child.pid;
  const result = await start;
  assert.equal(result.ok, false);
  assert.equal(r.lc.status().running, false);
  const stop = r.decisions.find(x => x.req.action === 'PROCESS_STOP');
  assert.ok(stop, JSON.stringify({ result, status: r.lc.status(), decisions: r.decisions.map(x => x.req.action) }));
  assert.deepEqual([stop.req.actor, stop.d.decision, stop.d.code], ['MODULE', 'ALLOW', 'ALLOW_STOP_ALWAYS']);
});

test('restart requires typed start too: denial is evaluated before stop and causes no outage', async () => {
  let denyReplacement = false; const base = gateFor(V2); const seen = [];
  const policyGate = { evaluate(req) {
    seen.push(req.action);
    if (denyReplacement && req.action === 'PROCESS_START') return { decision: 'DENY', code: 'DENY_ARBITRARY_EXECUTION', policyVersion: 2 };
    return base.evaluate(req);
  } };
  const r = rig({ policyGate });
  await r.lc.start({ actor: 'MODULE', userInitiated: true, healthCheckAttempts: 0 });
  const before = r.lc.status(); denyReplacement = true;
  const port = createKiwixLifecyclePort({ lifecycle: r.lc, redeemRestartAuthorization: () => true });
  const result = await port.restartOwnedKiwix(Object.freeze({}));
  assert.deepEqual([result.ok, result.error, r.calls.length], [false, 'policy_denied', 1]);
  assert.deepEqual([r.lc.status().running, r.lc.status().pid, r.lc.status().generation], [true, before.pid, before.generation]);
  assert.equal(seen.filter(x => x === 'PROCESS_STOP').length, 0, 'healthy old instance was not stopped');
  denyReplacement = false; await r.lc.stop({ actor: 'MODULE' });
});

test('static production surface has one spawn site and no raw product spawn override', () => {
  const source = fs.readFileSync(new URL('./src/lib/kiwix.js', import.meta.url), 'utf8');
  assert.equal((source.match(/spawnFn\(plan\.executable, plan\.args, plan\.spawnOptions\)/g) ?? []).length, 1);
  assert.doesNotMatch(source, /export function startKiwixServe[\s\S]{0,180}spawnFn/);
  assert.match(source, /startKiwixServe\(\{ logger \} = \{\}\)[\s\S]{0,180}actor: 'USER'[\s\S]{0,80}userInitiated: true/);
  const users = [];
  // URL-to-path kept explicit on Windows: only the closed HTTP route imports
  // the trusted public start wrapper.
  const root = fileURLToPath(new URL('./src/', import.meta.url));
  const scan = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) scan(file); else if (/\.js$/.test(entry.name) && !file.endsWith(`${path.sep}lib${path.sep}kiwix.js`) && /startKiwixServe/.test(fs.readFileSync(file, 'utf8'))) users.push(path.relative(root, file).replace(/\\/g, '/')); } };
  scan(root);
  assert.deepEqual(users, ['routes/kiwix.js']);
});
