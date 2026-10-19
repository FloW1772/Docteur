// Runtime Supervisor V1 — unit + REAL-PROCESS harness + route + static guards.
// Real processes are ONLY the test fixture (fixtures/runtime-fixture-service.mjs) on 127.0.0.1 random ports, launched by the
// supervisor under a TEST registry; the product registry is exercised read-only. No real Docteur component, no Ollama, no
// external network. Real cortex.sqlite (+wal) and the real Companion store are hashed before/after.
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
import {
  createRuntimeSupervisor, createRuntimeAuditLog, validateServiceDefinition, canTransition, TRANSITIONS, RUNTIME_STATES, RuntimeSupervisorError,
} from './src/lib/runtime-supervisor.js';
import { probeLoopback, loopbackTarget } from './src/lib/runtime-supervisor-probe.js';
import { createProductRuntimeServices } from './src/lib/runtime-supervisor-services.js';
import { createRuntimeSupervisorRoute } from './src/routes/runtime-supervisor.js';
import { killProcessTree } from './src/lib/process-tree.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'runtime-fixture-service.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-sup-'));
const REAL = ['cortex.sqlite', 'cortex.sqlite-wal', path.join('companion-v1', 'companion.sqlite')].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const SYNTHETIC_SECRET = `sk-runtime${'Z'.repeat(24)}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const realFetch = globalThis.fetch;
let fetchCalls = 0; let realBefore;
const supervisors = []; const externals = [];
const ALLOW = () => ({ decision: 'ALLOW', code: 'ALLOW_TEST' });
const FAST = { backoffBaseMs: 300, backoffMaxMs: 1_000, healthPollMs: 50, killWaitMs: 4_000, portReleaseTimeoutMs: 2_000 };

before(() => {
  realBefore = REAL.map(fileHash);
  globalThis.fetch = async () => { fetchCalls++; throw new Error('no fetch in the supervisor'); };
  process.env.RUNTIME_SUPERVISOR_TEST_SECRET = SYNTHETIC_SECRET; // must never reach a child, a log or a DTO
});
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.RUNTIME_SUPERVISOR_TEST_SECRET;
  for (const s of supervisors) await s.shutdown().catch(() => {});
  for (const e of externals) await killProcessTree(e).catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let nDef = 0;
async function fixtureDef(mode, { port = null, identity = true, stopTimeout = 1_500, startTimeout = 4_000, graceful = true, extraArgs = [] } = {}) {
  const p = port ?? await freePort();
  const control = path.join(TMP, `ctl-${++nDef}.txt`);
  return {
    control, port: p,
    def: {
      serviceId: `fixture-${nDef}`, displayName: `Fixture ${nDef}`, ownershipClass: 'DOCTEUR_OWNED', kind: 'SPAWN', optional: true,
      launch: { executable: process.execPath, args: [FIXTURE, '--port', String(p), '--mode', mode, '--control', control, ...extraArgs], cwd: HERE },
      healthCheck: { host: '127.0.0.1', port: p, path: '/health', identity, timeoutMs: 800 },
      gracefulStop: graceful ? { kind: 'HTTP_POST', path: '/shutdown' } : { kind: 'NONE' },
      gracefulStopTimeoutMs: stopTimeout, startTimeoutMs: startTimeout,
    },
  };
}
function rig(defs, { policy = ALLOW, limits = FAST, spawnImpl = spawn, killTree = killProcessTree } = {}) {
  const spawned = []; const kills = [];
  const spawnSpy = spawnImpl ? (exe, args, opts) => { const c = spawnImpl(exe, args, opts); spawned.push({ exe, args, opts, child: c }); return c; } : null;
  const killSpy = killTree ? async (child) => { kills.push({ child, exitedAtCall: child.exitCode !== null || child.signalCode !== null, known: spawned.some(s => s.child === child) }); return killTree(child); } : null;
  const auditFile = path.join(TMP, `audit-${crypto.randomUUID()}.jsonl`);
  // policy 'REAL' ⇒ omit the override so the supervisor uses the real Root Policy decide() on the sealed policy
  const sup = createRuntimeSupervisor({ services: defs, spawnImpl: spawnSpy, killTree: killSpy, ...(policy === 'REAL' ? {} : { policyDecide: policy }), audit: createRuntimeAuditLog({ file: auditFile }), limits });
  supervisors.push(sup);
  return { sup, spawned, kills, auditFile };
}
const restartAndWait = async (sup, id, opts = {}) => { await sup.restart(id, opts); await sup.whenIdle(id); return sup.get(id); };
const code = (c, reason) => (e) => { assert.ok(e instanceof RuntimeSupervisorError, String(e)); assert.equal(e.code, c); if (reason) assert.equal(e.details?.reason, reason); return true; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const startExternal = (port, mode = 'healthy') => { const c = spawn(process.execPath, [FIXTURE, '--port', String(port), '--mode', mode], { shell: false, windowsHide: true, stdio: 'ignore' }); externals.push(c); return c; };
const waitListening = async (port) => { for (let i = 0; i < 60; i++) { if ((await probeLoopback({ host: '127.0.0.1', port, path: '/health' })).code !== 'REFUSED') return true; await sleep(50); } return false; };

// ── registry / state machine ─────────────────────────────────────────────────────────────────────────────────────────
test('1. closed registry: invalid, shell-like, relative, non-owned SPAWN, auto-restart, bad env/ids are refused; definitions are frozen', async () => {
  const { def } = await fixtureDef('healthy');
  const bad = {
    shellExe: { ...def, launch: { ...def.launch, executable: 'C:\\Windows\\System32\\cmd.exe' } },
    powershell: { ...def, launch: { ...def.launch, executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' } },
    relativeExe: { ...def, launch: { ...def.launch, executable: 'node' } },
    argsString: { ...def, launch: { ...def.launch, args: `${FIXTURE} --port 1` } },
    argNul: { ...def, launch: { ...def.launch, args: ['a\0b'] } },
    relativeCwd: { ...def, launch: { ...def.launch, cwd: '.' } },
    externalSpawn: { ...def, ownershipClass: 'EXTERNAL_OBSERVED' },
    autoRestart: { ...def, restartPolicy: 'ALWAYS' },
    lanHealth: { ...def, healthCheck: { ...def.healthCheck, host: '192.168.1.10' } },
    badEnv: { ...def, launch: { ...def.launch, env: { 'bad key': 'x' } } },
    badId: { ...def, serviceId: 'Fixture; rm -rf' },
    observedNoFn: { serviceId: 'obs', displayName: 'x', ownershipClass: 'EXTERNAL_OBSERVED', kind: 'OBSERVED' },
  };
  for (const [label, d] of Object.entries(bad)) assert.throws(() => validateServiceDefinition(d), code('RS_DEFINITION_INVALID'), label);
  assert.throws(() => createRuntimeSupervisor({ services: [def, def], policyDecide: ALLOW }), code('RS_DEFINITION_INVALID', 'DUPLICATE'));
  assert.throws(() => createRuntimeSupervisor({ services: [{ ...def, dependencies: ['missing-dep'] }], policyDecide: ALLOW }), code('RS_DEFINITION_INVALID', 'DEPENDENCY'));
  const frozen = validateServiceDefinition(def);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.launch) && Object.isFrozen(frozen.launch.args));
  assert.throws(() => { 'use strict'; frozen.launch.args.push('--evil'); });
});

test('2. state machine: exactly the declared transitions are legal; every state is reachable and left', () => {
  for (const from of RUNTIME_STATES) for (const to of RUNTIME_STATES) assert.equal(canTransition(from, to), TRANSITIONS[from].includes(to), `${from}→${to}`);
  const targets = new Set(Object.values(TRANSITIONS).flat());
  for (const s of RUNTIME_STATES) { assert.ok(TRANSITIONS[s].length > 0, `${s} has an exit`); if (s !== 'STOPPED') assert.ok(targets.has(s), `${s} reachable`); }
  for (const [from, to] of [['STOPPED', 'HEALTHY'], ['CRASHED', 'HEALTHY'], ['BLOCKED', 'STARTING'], ['HEALTHY', 'STARTING'], ['BACKOFF', 'STARTING']]) assert.equal(canTransition(from, to), false, `${from}→${to}`);
});

// ── real-process harness ────────────────────────────────────────────────────────────────────────────────────────────
test('3. stopped → manual start → HEALTHY: health from the check, instance identity verified, pid + uptime', async () => {
  const f = await fixtureDef('healthy');
  const { sup, spawned } = rig([f.def]);
  const stopped = await sup.get(f.def.serviceId);
  assert.deepEqual([stopped.state, stopped.pid, stopped.processRunning, stopped.restart.allowed, stopped.restart.code], ['STOPPED', null, false, true, 'OK']);
  const v = await restartAndWait(sup, f.def.serviceId);
  assert.deepEqual([v.state, v.health.status, v.health.code, v.processRunning, v.restartCount], ['HEALTHY', 'HEALTHY', 'OK', true, 1]);
  assert.ok(Number.isInteger(v.pid) && alive(v.pid) && v.uptimeMs >= 0);
  assert.equal(spawned[0].opts.shell, false); assert.equal(spawned[0].opts.windowsHide, true);
  assert.deepEqual(spawned[0].args, f.def.launch.args, 'registered argv passed as-is');
  const events = sup.events(f.def.serviceId).map(e => `${e.from}>${e.to}`);
  assert.deepEqual(events, ['STOPPED>RESTARTING', 'RESTARTING>STARTING', 'STARTING>HEALTHY']);
});

test('4. real crash → CRASHED with exit code; immediate restart → BACKOFF; after backoff → HEALTHY again', async () => {
  const f = await fixtureDef('crash-after', { extraArgs: ['--after', '600'] });
  const { sup } = rig([f.def]);
  const up = await restartAndWait(sup, f.def.serviceId);
  assert.equal(up.state, 'HEALTHY');
  for (let i = 0; i < 60 && (await sup.get(f.def.serviceId)).state !== 'CRASHED'; i++) await sleep(50);
  const crashed = await sup.get(f.def.serviceId);
  assert.deepEqual([crashed.state, crashed.lastExitCode, crashed.crashCount, crashed.processRunning, crashed.lastError], ['CRASHED', 3, 1, false, 'PROCESS_EXITED']);
  assert.deepEqual([crashed.restart.allowed, crashed.restart.code], [false, 'RESTART_BACKOFF'], 'the backoff window is visible before any click');
  assert.ok(Date.parse(crashed.retryAt) > Date.now());
  await assert.rejects(sup.restart(f.def.serviceId), code('RS_BACKOFF', 'RESTART_BACKOFF'));
  const backoff = await sup.get(f.def.serviceId);
  assert.deepEqual([backoff.state, backoff.restart.allowed, backoff.restart.code], ['BACKOFF', false, 'RESTART_BACKOFF']);
  assert.ok(Date.parse(backoff.retryAt) > Date.now() - 50);
  fs.writeFileSync(f.control, 'healthy'); // the "fixed" service for the next launch
  await sleep(Date.parse(backoff.retryAt) - Date.now() + 20);
  const back = await restartAndWait(sup, f.def.serviceId);
  assert.deepEqual([back.state, back.restartCount], ['HEALTHY', 2]);
});

test('5. slow startup inside the timeout → HEALTHY; beyond it → DEGRADED (process kept, never "healthy" from a PID)', async () => {
  const slowOk = await fixtureDef('slow', { startTimeout: 3_000, extraArgs: ['--delay', '800'] });
  const slowKo = await fixtureDef('slow', { startTimeout: 600, extraArgs: ['--delay', '2500'] });
  const { sup } = rig([slowOk.def, slowKo.def]);
  assert.equal((await restartAndWait(sup, slowOk.def.serviceId)).state, 'HEALTHY');
  const ko = await restartAndWait(sup, slowKo.def.serviceId);
  // live health is re-probed on read (still not listening); the cause stays recorded as lastError
  assert.deepEqual([ko.state, ko.lastError, ko.processRunning, ko.portListening], ['DEGRADED', 'START_TIMEOUT', true, false]);
  assert.ok(['START_TIMEOUT', 'PORT_NOT_LISTENING'].includes(ko.health.code));
});

test('6. health-check failure → DEGRADED; port hijack (wrong instance token) → DEGRADED / IDENTITY_MISMATCH', async () => {
  const unhealthy = await fixtureDef('unhealthy', { startTimeout: 700 });
  const hijack = await fixtureDef('wrong-identity', { startTimeout: 700 });
  const { sup } = rig([unhealthy.def, hijack.def]);
  const u = await restartAndWait(sup, unhealthy.def.serviceId);
  assert.deepEqual([u.state, u.health.code], ['DEGRADED', 'HEALTH_HTTP_ERROR']);
  const h = await restartAndWait(sup, hijack.def.serviceId);
  assert.deepEqual([h.state, h.health.code], ['DEGRADED', 'IDENTITY_MISMATCH']);
});

test('7. occupied port → BLOCKED / PORT_IN_USE; the occupant (not ours) is never touched', async () => {
  const port = await freePort();
  const occupant = startExternal(port);
  assert.ok(await waitListening(port));
  const f = await fixtureDef('healthy', { port });
  const { sup, spawned, kills } = rig([f.def]);
  const v = await restartAndWait(sup, f.def.serviceId);
  assert.deepEqual([v.state, v.lastError, spawned.length, kills.length], ['BLOCKED', 'PORT_IN_USE', 0, 0]);
  assert.ok(alive(occupant.pid), 'the external occupant is still alive');
});

test('8. graceful stop: HTTP stop honoured, exit 0, no forced termination; shutdown → STOPPED', async () => {
  const f = await fixtureDef('healthy');
  const { sup, kills } = rig([f.def]);
  const v = await restartAndWait(sup, f.def.serviceId);
  await sup.shutdown();
  const s = await sup.get(f.def.serviceId);
  assert.deepEqual([s.state, s.lastExitCode, kills.length, alive(v.pid)], ['STOPPED', 0, 0, false]);
  assert.equal(sup.events(f.def.serviceId).some(e => e.event === 'FORCED_TERMINATION'), false);
});

test('9. hung stop → forced termination of the OWNED fixture only; a same-executable, same-script external process is untouched', async () => {
  const extPort = await freePort();
  const external = startExternal(extPort); // same node.exe, same fixture script, not launched by the supervisor
  assert.ok(await waitListening(extPort));
  const f = await fixtureDef('hang-stop', { stopTimeout: 400 });
  const { sup, kills } = rig([f.def]);
  const v = await restartAndWait(sup, f.def.serviceId);
  const restarted = await restartAndWait(sup, f.def.serviceId, { confirmInterrupt: true });
  assert.equal(restarted.state, 'HEALTHY');
  assert.notEqual(restarted.pid, v.pid);
  assert.equal(kills.length, 1);
  assert.ok(kills.every(k => k.known && !k.exitedAtCall), 'killTree only ever received a live handle the supervisor spawned');
  assert.equal(alive(v.pid), false, 'the hung owned instance is gone');
  assert.ok(alive(external.pid), 'the external same-name process is untouched');
  assert.ok(sup.events(f.def.serviceId).some(e => e.event === 'FORCED_TERMINATION'));
});

test('10. crash loop → BLOCKED; manual reset required; reset restarts the service', async () => {
  const f = await fixtureDef('crash-on-start', { startTimeout: 1_500 });
  const { sup } = rig([f.def], { limits: { ...FAST, backoffBaseMs: 100, backoffMaxMs: 100 } });
  for (let i = 0; i < 3; i++) {
    const v = await restartAndWait(sup, f.def.serviceId);
    if (v.state === 'BLOCKED') break;
    assert.equal(v.state, 'CRASHED');
    await sleep(150);
  }
  const blocked = await sup.get(f.def.serviceId);
  assert.deepEqual([blocked.state, blocked.crashCount, blocked.lastExitCode], ['BLOCKED', 3, 7]);
  assert.equal(sup.events(f.def.serviceId).some(e => e.to === 'BLOCKED' && e.reason === 'CRASH_LOOP'), true);
  await assert.rejects(sup.restart(f.def.serviceId), code('RS_BLOCKED', 'RESET_REQUIRED'));
  fs.writeFileSync(f.control, 'healthy');
  const reset = await restartAndWait(sup, f.def.serviceId, { resetBlocked: true });
  assert.deepEqual([reset.state, reset.crashCount], ['HEALTHY', 0]);
});

test('11. double / concurrent restart: exactly one operation; restart during STOPPING refused; confirmation required on a healthy service', async () => {
  const f = await fixtureDef('slow', { extraArgs: ['--delay', '600'] });
  const { sup, spawned } = rig([f.def]);
  const results = await Promise.allSettled([sup.restart(f.def.serviceId), sup.restart(f.def.serviceId), sup.restart(f.def.serviceId)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of results.filter(x => x.status === 'rejected')) code('RS_OPERATION_IN_PROGRESS')(r.reason);
  await sup.whenIdle(f.def.serviceId);
  assert.equal(spawned.length, 1);
  await assert.rejects(sup.restart(f.def.serviceId), code('RS_CONFIRMATION_REQUIRED'));
  const hang = await fixtureDef('hang-stop', { stopTimeout: 800 });
  const r2 = rig([hang.def]);
  await restartAndWait(r2.sup, hang.def.serviceId);
  const stopping = r2.sup.shutdown();
  await sleep(100);
  assert.equal((await r2.sup.get(hang.def.serviceId)).state, 'STOPPING');
  await assert.rejects(r2.sup.restart(hang.def.serviceId, { confirmInterrupt: true }), code('RS_OPERATION_IN_PROGRESS'));
  await stopping;
});

test('12. unknown / forged serviceIds are refused before anything happens', async () => {
  const f = await fixtureDef('healthy');
  const { sup, spawned } = rig([f.def]);
  for (const id of ['nope', '../fixture-1', 'fixture-1; rm -rf /', '__proto__', 'constructor', 'toString', '', 'FIXTURE-1', 'a'.repeat(60), null, 42, { id: f.def.serviceId }]) {
    await assert.rejects(sup.restart(id), code('RS_UNKNOWN_SERVICE'), String(id));
    await assert.rejects(sup.get(id), code('RS_UNKNOWN_SERVICE'));
  }
  assert.equal(spawned.length, 0);
});

test('13. PID-reuse safety: an exited instance is never killed; kills only ever target live handles we spawned', async () => {
  const f = await fixtureDef('crash-after', { extraArgs: ['--after', '300'] });
  const { sup, kills } = rig([f.def], { limits: { ...FAST, backoffBaseMs: 50, backoffMaxMs: 50 } });
  const v = await restartAndWait(sup, f.def.serviceId);
  for (let i = 0; i < 40 && (await sup.get(f.def.serviceId)).state !== 'CRASHED'; i++) await sleep(50);
  // A new process is started by "someone else" — it may even receive the old PID; the supervisor must never signal it.
  const other = startExternal(await freePort());
  await sleep(100);
  await sup.shutdown();
  fs.writeFileSync(f.control, 'healthy');
  await restartAndWait(sup, f.def.serviceId);
  await sup.shutdown();
  assert.ok(kills.every(k => k.known && !k.exitedAtCall));
  assert.equal(kills.some(k => k.child.pid === v.pid), false, 'the exited instance was never killed');
  assert.ok(alive(other.pid), 'the unrelated process is untouched');
});

test('14. Root Policy: real sealed policy ⇒ REQUIRE_APPROVAL ⇒ restart refused, nothing launched; DENY ⇒ refused', async () => {
  const f = await fixtureDef('healthy');
  const real = rig([f.def], { policy: 'REAL' }); // the real Root Policy decide() on the sealed V1 policy
  await assert.rejects(real.sup.restart(f.def.serviceId), code('RS_POLICY_APPROVAL_REQUIRED', 'ROOT_POLICY_APPROVAL_REQUIRED'));
  const view = await real.sup.get(f.def.serviceId);
  assert.deepEqual([view.state, view.restart.allowed, view.restart.code, real.spawned.length], ['STOPPED', false, 'ROOT_POLICY_APPROVAL_REQUIRED', 0]);
  const denied = rig([f.def], { policy: () => ({ decision: 'DENY', code: 'DENY_X' }) });
  await assert.rejects(denied.sup.restart(f.def.serviceId), code('RS_POLICY_DENIED'));
  const throwing = rig([f.def], { policy: () => { throw new Error('policy engine down'); } });
  await assert.rejects(throwing.sup.restart(f.def.serviceId), code('RS_POLICY_DENIED'));
  assert.equal(denied.spawned.length + throwing.spawned.length, 0);
});

test('15. no launcher injected (product) ⇒ nothing can be launched even for an owned definition', async () => {
  const f = await fixtureDef('healthy');
  const { sup } = rig([f.def], { spawnImpl: null, killTree: null });
  await assert.rejects(sup.restart(f.def.serviceId), code('RS_RESTART_NOT_ALLOWED', 'LAUNCHER_UNAVAILABLE'));
  assert.deepEqual((await sup.get(f.def.serviceId)).restart, { allowed: false, code: 'LAUNCHER_UNAVAILABLE' });
});

test('16. secrets: the child gets a minimal environment; audit file, ring and DTOs never carry env, args, paths or the secret', async () => {
  const f = await fixtureDef('healthy');
  const { sup, auditFile } = rig([f.def]);
  await restartAndWait(sup, f.def.serviceId);
  const r = await probeLoopback({ host: '127.0.0.1', port: f.port, path: '/envkeys' });
  const keys = JSON.parse(r.body);
  assert.equal(keys.includes('RUNTIME_SUPERVISOR_TEST_SECRET'), false, 'parent secret not inherited');
  assert.ok(keys.includes('DOCTEUR_RS_INSTANCE'));
  await sup.shutdown();
  const everything = fs.readFileSync(auditFile, 'utf8') + JSON.stringify(sup.events(f.def.serviceId)) + JSON.stringify(await sup.list());
  for (const s of [SYNTHETIC_SECRET, FIXTURE, process.execPath, '--port', 'DOCTEUR_RS_INSTANCE', TMP]) assert.equal(everything.includes(s), false, `leaked ${s.slice(0, 12)}`);
});

// ── product registry (read-only) ───────────────────────────────────────────────────────────────────────────────────
function productRig({ probe, ollamaUrl = 'http://localhost:11434', kiwix, comfy } = {}) {
  const calls = [];
  const spyProbe = async (req) => { calls.push(req); return probe ? probe(req) : { code: 'REFUSED' }; };
  const services = createProductRuntimeServices({ ollamaUrl, kiwix: kiwix ?? { status: () => ({ running: false }), health: async () => false }, comfy: comfy ?? { installState: () => ({ kind: 'none', status: 'not_installed' }) } });
  const sup = createRuntimeSupervisor({ services, probe: spyProbe }); // product shape: real Root Policy, NO launcher, NO killer
  supervisors.push(sup);
  return { sup, calls };
}

test('17. product registry: classifications, read-only observation, nothing restartable; Ollama EXTERNAL_OBSERVED never restartable', async () => {
  const { sup, calls } = productRig({ probe: (r) => (r.port === 11434 ? { code: 'OK', headers: {} } : { code: 'REFUSED' }) });
  const list = await sup.list();
  const by = Object.fromEntries(list.map(s => [s.serviceId, s]));
  assert.deepEqual(Object.keys(by).sort(), ['comfyui', 'docteur-backend', 'docteur-frontend', 'kiwix-serve', 'ollama']);
  assert.deepEqual(Object.fromEntries(list.map(s => [s.serviceId, s.ownershipClass])), {
    'docteur-backend': 'DOCTEUR_OWNED', 'docteur-frontend': 'DOCTEUR_MANAGED_OPTIONAL', ollama: 'EXTERNAL_OBSERVED', 'kiwix-serve': 'DOCTEUR_MANAGED_OPTIONAL', comfyui: 'DOCTEUR_MANAGED_OPTIONAL',
  });
  assert.deepEqual([by['docteur-backend'].state, by['docteur-backend'].pid], ['HEALTHY', process.pid]);
  assert.deepEqual([by.ollama.state, by.ollama.health.code, by.ollama.pid], ['HEALTHY', 'API_OK', null]);
  assert.deepEqual([by['docteur-frontend'].state, by['kiwix-serve'].state, by.comfyui.state, by.comfyui.health.code], ['STOPPED', 'STOPPED', 'STOPPED', 'NOT_INSTALLED']);
  for (const s of list) assert.equal(s.restart.allowed, false, s.serviceId);
  assert.equal(by.ollama.restart.code, 'NOT_DOCTEUR_OWNED');
  assert.equal(by['docteur-backend'].restart.code, 'SELF_RESTART_UNSUPPORTED');
  for (const id of ['kiwix-serve', 'comfyui', 'docteur-frontend']) assert.equal(by[id].restart.code, 'MANAGED_BY_OWN_MODULE', id);
  for (const id of ['ollama', 'docteur-backend', 'kiwix-serve', 'comfyui', 'docteur-frontend']) await assert.rejects(sup.restart(id, { confirmInterrupt: true }), code('RS_RESTART_NOT_ALLOWED'));
  assert.ok(calls.every(c => ['127.0.0.1', '::1'].includes(c.host)), 'loopback probes only');
  assert.ok(calls.every(c => c.method === undefined || c.method === 'GET'));
});

test('18. product observers: non-loopback Ollama endpoint is never probed; Kiwix running/degraded from its own module; secrets in lastError withheld', async () => {
  const lan = productRig({ ollamaUrl: 'http://192.168.1.50:11434' });
  const o = await lan.sup.get('ollama');
  assert.deepEqual([o.state, o.health.status, o.health.code], ['BLOCKED', 'NOT_PROBED', 'NON_LOOPBACK_ENDPOINT']);
  assert.equal(lan.calls.some(c => c.port === 11434), false);
  for (const url of ['https://localhost:11434', 'http://user:pw@127.0.0.1:11434', 'http://example.com', 'file:///x', 'not a url']) assert.equal(loopbackTarget(url), null, url);
  const k = productRig({ kiwix: { status: () => ({ running: true, port: 8090, pid: 4242, lastError: `token=${SYNTHETIC_SECRET}` }), health: async () => false } });
  const kv = await k.sup.get('kiwix-serve');
  assert.deepEqual([kv.state, kv.pid, kv.lastError], ['DEGRADED', 4242, 'KIWIX_REPORTED_ERROR']);
  assert.equal(JSON.stringify(kv).includes(SYNTHETIC_SECRET), false);
});

test('19. the probe refuses anything that is not loopback / GET|POST / a plain path', async () => {
  for (const req of [{ host: '8.8.8.8', port: 53 }, { host: 'example.com', port: 80 }, { host: '192.168.1.1', port: 80 }, { host: '127.0.0.1', port: 0 }, { host: '127.0.0.1', port: 80, path: 'http://evil/' }, { host: '127.0.0.1', port: 80, method: 'DELETE' }, { host: '127.0.0.1', port: 80, path: '/a?b=c' }]) {
    assert.match((await probeLoopback(req)).code, /^(NOT_LOOPBACK|INVALID)$/, JSON.stringify(req));
  }
});

// ── route ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('20. route: typed endpoints, strict restart body (no command/executable/args/cwd/shell/pid), status mapping, 202 on accept', async () => {
  const f = await fixtureDef('healthy');
  const { sup, spawned } = rig([f.def]);
  const app = new Hono().route('/api', createRuntimeSupervisorRoute({ supervisor: sup }));
  const post = (id, body) => app.request(`/api/runtime/services/${id}/restart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const list = await (await app.request('/api/runtime/services')).json();
  assert.equal(list.value.services[0].serviceId, f.def.serviceId);
  for (const body of [{ command: 'calc.exe' }, { executable: 'C:\\Windows\\System32\\cmd.exe' }, { args: ['/c', 'whoami'] }, { cwd: 'C:\\' }, { shell: true }, { pid: 4 }, { serviceId: 'other' }, { confirmInterrupt: 'yes' }]) {
    const r = await post(f.def.serviceId, JSON.stringify(body));
    const j = await r.json();
    assert.deepEqual([r.status, j.error.code], [400, 'RS_REQUEST_INVALID'], JSON.stringify(body));
  }
  for (const body of ['{bad', '[]', '"x"', 'x'.repeat(2_000)]) assert.equal((await post(f.def.serviceId, body)).status, 400);
  for (const id of ['nope', '..%2F..%2Fetc', 'fixture-1%3Bcalc']) assert.equal((await post(id, '{}')).status, 404);
  assert.equal(spawned.length, 0, 'no refused request launched anything');
  const ok = await post(f.def.serviceId, '');
  assert.deepEqual([ok.status, (await ok.json()).value.state], [202, 'RESTARTING']);
  await sup.whenIdle(f.def.serviceId);
  const conflict = await post(f.def.serviceId, '{}');
  assert.deepEqual([conflict.status, (await conflict.json()).error.code], [409, 'RS_CONFIRMATION_REQUIRED']);
  const detail = await (await app.request(`/api/runtime/services/${f.def.serviceId}`)).json();
  assert.equal(detail.value.service.state, 'HEALTHY');
  assert.ok(detail.value.events.length >= 3);
  const productApp = new Hono().route('/api', createRuntimeSupervisorRoute({ supervisor: productRig().sup }));
  const forbidden = await productApp.request('/api/runtime/services/ollama/restart', { method: 'POST', body: '{"confirmInterrupt":true}' });
  assert.deepEqual([forbidden.status, (await forbidden.json()).error.reason], [403, 'NOT_DOCTEUR_OWNED']);
  const none = new Hono().route('/api', createRuntimeSupervisorRoute({ supervisor: null }));
  assert.equal((await none.request('/api/runtime/services')).status, 503);
});

// ── static guards ──────────────────────────────────────────────────────────────────────────────────────────────────
test('21. static: one launch site (shell:false, registered argv), no process/network primitive in the supervisor, closed request fields, product injects no launcher', () => {
  const read = (p) => fs.readFileSync(path.join(HERE, 'src', p), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const sup = strip(read('lib/runtime-supervisor.js'));
  assert.doesNotMatch(sup, /child_process|\bexec\w*\(|\bfork\(|\bfetch\s*\(|node:(http|https|net|dns|tls)|\beval\s*\(|new Function|process\.kill\(/);
  assert.equal((sup.match(/spawnImpl\(/g) ?? []).length, 1, 'exactly one launch site');
  assert.match(sup, /spawnImpl\(def\.launch\.executable, \[\.\.\.def\.launch\.args\], \{\s*cwd: def\.launch\.cwd, env: childEnv\(def, token\), shell: false,/);
  assert.equal((sup.match(/killTree\(/g) ?? []).length, 1, 'exactly one kill site');
  assert.match(sup, /await killTree\(instance\.child\)/, 'kills receive our own handle only');
  const services = strip(read('lib/runtime-supervisor-services.js'));
  assert.doesNotMatch(services, /kind: 'SPAWN'|child_process|spawn|stopKiwixServe|startKiwixServe|stopComfyUi|startComfyUi|\bfetch\s*\(/, 'product registry is observe-only');
  const route = strip(read('routes/runtime-supervisor.js'));
  assert.match(route, /const RESTART_FIELDS = Object\.freeze\(\['confirmInterrupt', 'resetBlocked'\]\);/);
  assert.doesNotMatch(route, /child_process|spawn|exec|req\.query|c\.req\.query|executable|\bcwd\b|\bshell\b/);
  assert.deepEqual([...route.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)].map(m => `${m[1]} ${m[2]}`), ['get /runtime/services', 'get /runtime/services/:serviceId', 'post /runtime/services/:serviceId/restart']);
  const server = read('server.js');
  const call = server.slice(server.indexOf('createRuntimeSupervisor({'), server.indexOf('app.route(\'/api\', createRuntimeSupervisorRoute'));
  assert.doesNotMatch(call, /spawnImpl|killTree|policyDecide|probe:/, 'the product injects no launcher, killer, policy override or probe');
  assert.equal(server.split('createRuntimeSupervisor(').length - 1, 1);
  const probe = strip(read('lib/runtime-supervisor-probe.js'));
  assert.equal((probe.match(/http\.request\(/g) ?? []).length, 1);
});

test('22. isolation: 0 fetch, real DB and real Companion store untouched', () => {
  assert.equal(fetchCalls, 0);
  assert.deepEqual(REAL.map(fileHash), realBefore);
});
