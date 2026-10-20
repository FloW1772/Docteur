// [KWX-1] Kiwix lifecycle hardening — real production lifecycle code, REAL child processes (a test-only stand-in for
// kiwix-serve.exe, fixtures/kiwix-fixture-serve.mjs, on 127.0.0.1 random ports) and the REAL OS listener table
// (netstat -ano). kiwix-tools is NOT installed: real kiwix-serve certification is NOT_RUN by design.
// No real Kiwix, no download, no external network; the real cortex.sqlite (+wal) and Companion store are hashed.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import * as db from './src/lib/sqlite.js';
import {
  createKiwixLifecycle, createKiwixLifecyclePort, validateKiwixBinary, validateKiwixPort, verifyLoopbackBinding,
  KIWIX_STATES, KIWIX_TRANSITIONS, KIWIX_BINARY_NAME,
} from './src/lib/kiwix.js';
import { createKiwixRoute } from './src/routes/kiwix.js';
import { killProcessTree } from './src/lib/process-tree.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'kiwix-fixture-serve.mjs');
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kwx1-')));
const REAL = ['cortex.sqlite', 'cortex.sqlite-wal', path.join('companion-v1', 'companion.sqlite')].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const SECRET = `sk-kwx1${'Q'.repeat(24)}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const realFetch = globalThis.fetch;
let externalFetches = 0; let realBefore;
const children = []; const logs = [];
const logger = { info: (o, m) => logs.push({ o, m }), warn: (o, m) => logs.push({ o, m }), error: (o, m) => logs.push({ o, m }) };

// a fake kiwix-tools folder (the "binary" is only validated; the injected spawn runs the fixture) + real .zim files
const BIN_DIR = path.join(TMP, 'Kiwix Tools'); fs.mkdirSync(BIN_DIR);
const BINARY = path.join(BIN_DIR, KIWIX_BINARY_NAME); fs.writeFileSync(BINARY, 'stand-in, never executed');
const ZIM_DIR = path.join(TMP, 'ZIM été'); fs.mkdirSync(ZIM_DIR);
fs.writeFileSync(path.join(ZIM_DIR, 'wikipedia_fr.zim'), 'archive'); fs.writeFileSync(path.join(ZIM_DIR, 'pokepedia.ZIM'), 'archive');

before(() => {
  realBefore = REAL.map(fileHash);
  process.env.KWX1_TEST_SECRET = SECRET; // must never reach the child environment nor a log
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== '127.0.0.1') { externalFetches++; throw new Error('external network refused'); }
    return realFetch(input, init);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.KWX1_TEST_SECRET;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) await killProcessTree(c).catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

const FAST = { healthAttempts: 30, healthIntervalMs: 100, verifyWindowMs: 2_000, stopGraceMs: 1_500, forceWaitMs: 2_000, portReleaseMs: 1_500 };
/** Real lifecycle with the fixture standing in for kiwix-serve.exe. modes: one per launch (last one repeats). */
async function rig({ modes = ['healthy'], extra = [], port = null, terminate, forceKill, limits = {}, settings = {} } = {}) {
  const p = port ?? await freePort();
  const calls = [];
  const spawnFn = (binary, args, opts) => {
    const mode = modes[Math.min(calls.length, modes.length - 1)];
    const child = spawn(process.execPath, [FIXTURE, `--fixture-mode=${mode}`, ...extra, ...args], opts);
    calls.push({ binary, args: [...args], opts, child });
    children.push(child);
    return child;
  };
  const lc = createKiwixLifecycle({
    spawnFn, getSettings: () => ({ kiwixServePath: BIN_DIR, archivesFolder: ZIM_DIR, port: p, ...settings }), logger, limits: { ...FAST, ...limits },
    ...(terminate ? { terminate } : {}), ...(forceKill ? { forceKill } : {}),
  });
  return { lc, port: p, calls };
}
const startExternal = (port, mode = 'healthy') => {
  const c = spawn(process.execPath, [FIXTURE, `--fixture-mode=${mode}`, `--port=${port}`, '--address=127.0.0.1'], { shell: false, windowsHide: true, stdio: 'ignore' });
  children.push(c); return c;
};
const waitListening = async (port) => { for (let i = 0; i < 80; i++) { if (await new Promise(r => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); })) return true; await sleep(50); } return false; };
const transitions = (from = 0) => logs.slice(from).filter(l => l.o?.event === 'transition').map(l => `${l.o.from}>${l.o.to}`);

// ── state machine / validation ─────────────────────────────────────────────────────────────────────────────────────
test('1. state machine: closed transition table over the six required states', () => {
  assert.deepEqual([...KIWIX_STATES].sort(), ['CRASHED', 'DEGRADED', 'HEALTHY', 'STARTING', 'STOPPED', 'STOPPING']);
  for (const s of KIWIX_STATES) assert.ok(KIWIX_TRANSITIONS[s]?.length > 0, s);
  assert.equal(KIWIX_TRANSITIONS.STOPPED.includes('HEALTHY'), false, 'PID alone never makes HEALTHY: STOPPED → STARTING only');
  assert.equal(KIWIX_TRANSITIONS.STOPPING.includes('STARTING'), false);
  for (const to of KIWIX_TRANSITIONS.STARTING) assert.ok(['HEALTHY', 'DEGRADED', 'CRASHED', 'STOPPING'].includes(to));
});

test('2. binary path validation: exact kiwix-serve.exe regular file only; shells, look-alikes, dirs, UNC, relative, missing refused', () => {
  assert.equal(validateKiwixBinary(BINARY).ok, true);
  const dirNamedExe = path.join(TMP, 'trap', KIWIX_BINARY_NAME); fs.mkdirSync(dirNamedExe, { recursive: true });
  const lookAlike = path.join(TMP, 'kiwix-serve.exe.bat'); fs.writeFileSync(lookAlike, '@echo off');
  for (const [candidate, code] of [
    ['C:\\Windows\\System32\\cmd.exe', 'binary_invalid'], ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'binary_invalid'],
    [lookAlike, 'binary_invalid'], [dirNamedExe, 'binary_invalid'], ['kiwix-serve.exe', 'binary_invalid'], ['\\\\server\\share\\kiwix-serve.exe', 'binary_invalid'],
    [path.join(TMP, 'missing', KIWIX_BINARY_NAME), 'binary_not_found'], ['', 'binary_not_found'], [null, 'binary_not_found'], [`${BINARY}\0x`, 'binary_not_found'],
  ]) assert.equal(validateKiwixBinary(candidate).code, code, String(candidate));
  try {
    const link = path.join(TMP, 'link', KIWIX_BINARY_NAME); fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync('C:\\Windows\\System32\\cmd.exe', link);
    assert.equal(validateKiwixBinary(link).code, 'binary_invalid', 'a link named kiwix-serve.exe is refused');
  } catch (e) { if (e.code !== 'EPERM') throw e; } // symlink creation needs a privilege on Windows: skipped then
});

test('3. port validation: integers 1024–65535, never a Docteur service port', () => {
  for (const bad of [0, 80, 1023, 3001, 5173, 11434, 8188, 65_536, 99_999, '8090x', null, 8090.5]) assert.equal(validateKiwixPort(bad), null, String(bad));
  assert.equal(validateKiwixPort(8090), 8090);
  assert.equal(validateKiwixPort('18199'), 18199);
});

test('4. arbitrary executable / args / port through settings are impossible: refused before any spawn', async () => {
  const zimDirWithTrap = path.join(TMP, 'zim-trap'); fs.mkdirSync(path.join(zimDirWithTrap, 'folder.zim'), { recursive: true });
  for (const [settings, code] of [
    [{ kiwixServePath: 'C:\\Windows\\System32\\cmd.exe' }, 'binary_invalid'],
    [{ port: 3001 }, 'invalid_port'], [{ port: 22 }, 'invalid_port'],
    [{ archivesFolder: path.join(TMP, 'empty') }, 'no_archives'],
  ]) {
    if (settings.archivesFolder) fs.mkdirSync(settings.archivesFolder, { recursive: true });
    const r = await rig({ settings });
    const res = await r.lc.start();
    assert.deepEqual([res.ok, res.error, r.calls.length], [false, code, 0], JSON.stringify(settings));
  }
});

test('5. verifyLoopbackBinding is fail-closed on every table shape', async () => {
  const t = (listeners, ok = true) => async () => (ok ? { ok: true, listeners } : { ok: false, reason: 'probe_failed' });
  const cases = [
    [t([{ address: '127.0.0.1', port: 1, pid: 10 }]), 10, 'LOOPBACK_ONLY'],
    [t([{ address: '::1', port: 1, pid: 10 }, { address: '127.0.0.1', port: 1, pid: 10 }]), 10, 'LOOPBACK_ONLY'],
    [t([{ address: '0.0.0.0', port: 1, pid: 10 }]), 10, 'NOT_LOOPBACK'],
    [t([{ address: '::', port: 1, pid: 10 }]), 10, 'NOT_LOOPBACK'],
    [t([{ address: '127.0.0.1', port: 1, pid: 10 }, { address: '192.168.1.20', port: 1, pid: 10 }]), 10, 'NOT_LOOPBACK'],
    [t([{ address: '127.0.0.1', port: 1, pid: 11 }]), 10, 'FOREIGN_LISTENER'],
    [t([{ address: '127.0.0.1', port: 1, pid: 0 }]), 10, 'UNDETERMINED'],
    [t([], false), 10, 'UNDETERMINED'],
    [async () => { throw new Error('netstat exploded'); }, 10, 'UNDETERMINED'],
    [t([]), 10, 'NOT_LISTENING'],
  ];
  for (const [listListeners, expectedPid, status] of cases) {
    const v = await verifyLoopbackBinding(1, { expectedPid, listListeners });
    assert.equal(v.status, status); assert.equal(v.loopbackOnly, status === 'LOOPBACK_ONLY');
  }
});

// ── real-process lifecycle ─────────────────────────────────────────────────────────────────────────────────────────
test('6. start healthy: STARTING → HEALTHY only after alive + health + REAL loopback listener owned by OUR pid; typed argv, shell:false, minimal env', async () => {
  const r = await rig();
  const mark = logs.length;
  const res = await r.lc.start();
  assert.deepEqual([res.ok, res.state, res.healthy, res.bindingVerified, res.binding], [true, 'HEALTHY', true, true, 'LOOPBACK_ONLY']);
  assert.deepEqual(transitions(mark), ['STOPPED>STARTING', 'STARTING>HEALTHY']);
  const call = r.calls[0];
  assert.equal(call.binary, fs.realpathSync.native(BINARY));
  assert.deepEqual(call.args.slice(0, 3), [`--port=${r.port}`, '--address=127.0.0.1', '--blockexternal']);
  assert.ok(call.args.slice(3).every(a => path.isAbsolute(a) && a.toLowerCase().endsWith('.zim')));
  assert.deepEqual([call.opts.shell, call.opts.windowsHide, call.opts.cwd, call.opts.stdio.join()], [false, true, path.dirname(call.binary), 'ignore,ignore,ignore']);
  assert.equal(Object.hasOwn(call.opts.env, 'KWX1_TEST_SECRET'), false, 'parent secret not inherited');
  assert.ok(Object.keys(call.opts.env).length <= 11);
  assert.equal(r.lc.status().pid, call.child.pid);
  assert.equal((await r.lc.stop()).ok, true);
});

test('7. slow startup inside the budget → HEALTHY; startup crash → CRASHED / start_crashed with the exit code', async () => {
  const slow = await rig({ modes: ['slow'], extra: ['--fixture-delay=900'] });
  assert.equal((await slow.lc.start()).state, 'HEALTHY');
  await slow.lc.stop();
  const crash = await rig({ modes: ['crash-on-start'] });
  const res = await crash.lc.start();
  assert.deepEqual([res.ok, res.error, crash.lc.status().state, crash.lc.status().lastExitCode, crash.lc.status().running], [false, 'start_crashed', 'CRASHED', 7, false]);
});

test('8. runtime crash → CRASHED exactly once; health failure → never HEALTHY (STARTING then DEGRADED / start_timeout)', async () => {
  const r = await rig({ modes: ['crash-after'], extra: ['--fixture-after=500'] });
  assert.equal((await r.lc.start()).state, 'HEALTHY');
  const mark = logs.length;
  for (let i = 0; i < 40 && r.lc.status().state !== 'CRASHED'; i++) await sleep(50);
  assert.deepEqual([r.lc.status().state, r.lc.status().lastExitCode, r.lc.status().lastError, r.lc.status().running], ['CRASHED', 3, 'process_exited', false]);
  assert.deepEqual(transitions(mark), ['HEALTHY>CRASHED']);
  const sick = await rig({ modes: ['unhealthy'], limits: { healthAttempts: 3, verifyWindowMs: 1_200 } });
  const res = await sick.lc.start();
  assert.deepEqual([res.ok, res.state, res.healthy], [true, 'STARTING', false], 'running but not verified: never reported healthy');
  for (let i = 0; i < 40 && sick.lc.status().state === 'STARTING'; i++) await sleep(100);
  assert.deepEqual([sick.lc.status().state, sick.lc.status().lastError], ['DEGRADED', 'start_timeout']);
  await sick.lc.stop();
});

test('9. wide binding (0.0.0.0) detected from the REAL listener table → OUR instance stopped, fail closed', async () => {
  const r = await rig({ modes: ['wide'] });
  const res = await r.lc.start();
  assert.deepEqual([res.ok, res.error, r.lc.status().state, r.lc.status().running], [false, 'binding_not_loopback', 'CRASHED', false]);
  assert.equal(alive(r.calls[0].child.pid), false, 'the unsafe instance is gone');
  assert.ok(logs.some(l => l.o?.event === 'unsafe_listener_stopping_own_instance'));
});

test('10. port hijack (listener owned by another PID) → identity_mismatch, only OUR instance stopped', async () => {
  const p = await freePort();
  const r = await rig({ port: p });
  const forged = createKiwixLifecycle({
    spawnFn: (b, a, o) => { const c = spawn(process.execPath, [FIXTURE, '--fixture-mode=healthy', ...a], o); children.push(c); r.calls.push({ child: c }); return c; },
    getSettings: () => ({ kiwixServePath: BIN_DIR, archivesFolder: ZIM_DIR, port: p }), logger, limits: FAST,
    listListeners: async (port) => ({ ok: true, listeners: [{ address: '127.0.0.1', port, pid: process.pid }] }), // someone else owns the socket
  });
  const res = await forged.start();
  assert.deepEqual([res.ok, res.error, forged.status().state], [false, 'identity_mismatch', 'CRASHED']);
  assert.equal(alive(process.pid), true, 'the foreign owner (this test process) is untouched');
});

test('11. occupied port → port_in_use, nothing spawned, the unknown occupant untouched', async () => {
  const p = await freePort();
  const occupant = startExternal(p);
  assert.ok(await waitListening(p));
  const r = await rig({ port: p });
  const res = await r.lc.start();
  assert.deepEqual([res.ok, res.error, r.calls.length], [false, 'port_in_use', 0]);
  assert.ok(alive(occupant.pid), 'occupant alive');
});

test('12. double start (concurrent) → one spawn; start during stop refused; stop during start cancels it', async () => {
  const r = await rig({ modes: ['slow'], extra: ['--fixture-delay=700'] });
  const [a, b] = await Promise.all([r.lc.start(), r.lc.start()]);
  assert.equal(r.calls.length, 1, 'exactly one process');
  assert.deepEqual([a.state, b.state], ['HEALTHY', 'HEALTHY']);
  const stopping = r.lc.stop();
  const during = await r.lc.start();
  assert.deepEqual([during.ok, during.error], [false, 'operation_in_progress']);
  await stopping;
  const s = await rig({ modes: ['slow'], extra: ['--fixture-delay=3000'] });
  const starting = s.lc.start();
  await sleep(250);
  assert.equal(s.lc.status().state, 'STARTING');
  const stopped = await s.lc.stop();
  const started = await starting;
  assert.deepEqual([stopped.ok, s.lc.status().state, started.ok, started.error], [true, 'STOPPED', false, 'start_cancelled']);
  assert.equal(alive(s.calls[0].child.pid), false);
});

test('13. double stop → one stop operation; stop waits for the REAL exit (state STOPPING until then)', async () => {
  let terminations = 0;
  const r = await rig({ terminate: (child) => { terminations++; setTimeout(() => child.kill(), 500); } });
  await r.lc.start();
  const pid = r.lc.status().pid;
  const first = r.lc.stop(); const second = r.lc.stop();
  assert.equal(first, second, 'the second stop joins the first');
  await sleep(200);
  assert.deepEqual([r.lc.status().state, alive(pid)], ['STOPPING', true], 'not reported stopped while the process lives');
  const res = await first;
  assert.deepEqual([res.ok, res.forced, r.lc.status().state, alive(pid), terminations], [true, false, 'STOPPED', false, 1]);
});

test('14. stop timeout: a process that does not exit is NEVER reported stopped (stop_timeout, DEGRADED, still owned)', async () => {
  const r = await rig({ terminate: () => {}, forceKill: async () => {} });
  await r.lc.start();
  const pid = r.lc.status().pid;
  const res = await r.lc.stop();
  assert.deepEqual([res.ok, res.error, res.processExited, r.lc.status().state, r.lc.status().running, alive(pid)], [false, 'stop_timeout', false, 'DEGRADED', true, true]);
  r.calls[0].child.kill(); // test cleanup of the deliberately "unkillable" instance
});

test('15. forced stop: tree-kill of OUR live handle only; a same-executable, same-script external process is untouched', async () => {
  const extPort = await freePort();
  const external = startExternal(extPort);
  assert.ok(await waitListening(extPort));
  const forced = [];
  const r = await rig({ terminate: () => {}, forceKill: async (child) => { forced.push(child); return killProcessTree(child); } });
  await r.lc.start();
  const pid = r.lc.status().pid;
  const res = await r.lc.stop();
  assert.deepEqual([res.ok, res.forced, forced.length, forced[0] === r.calls[0].child, alive(pid)], [true, true, 1, true, false]);
  assert.ok(alive(external.pid), 'external same-name process untouched');
});

test('16. PID reuse / stale PID: an exited instance is never signalled; unrelated processes untouched', async () => {
  const signalled = [];
  const r = await rig({ modes: ['crash-after'], extra: ['--fixture-after=300'], terminate: (c) => signalled.push(c), forceKill: async (c) => signalled.push(c) });
  await r.lc.start();
  for (let i = 0; i < 40 && r.lc.status().state !== 'CRASHED'; i++) await sleep(50);
  const other = startExternal(await freePort()); // may even receive the old PID: must never be touched
  const res = await r.lc.stop();
  assert.deepEqual([res.ok, res.wasRunning, signalled.length, r.lc.status().state], [true, false, 0, 'STOPPED']);
  assert.ok(alive(other.pid));
});

test('17. late / duplicate events from an old instance never overwrite the newer one; duplicate exit+error count once', async () => {
  const r = await rig({ modes: ['crash-after', 'healthy'], extra: ['--fixture-after=300'] });
  await r.lc.start();
  for (let i = 0; i < 40 && r.lc.status().state !== 'CRASHED'; i++) await sleep(50);
  const restarted = await r.lc.start();
  assert.equal(restarted.state, 'HEALTHY');
  const newPid = r.lc.status().pid;
  const old = r.calls[0].child;
  const mark = logs.length;
  old.emit('exit', 9); old.emit('error', new Error('late'));
  assert.deepEqual([r.lc.status().state, r.lc.status().pid], ['HEALTHY', newPid], 'the old instance cannot touch the new one');
  assert.ok(logs.slice(mark).every(l => l.o?.event !== 'transition'));
  assert.ok(logs.slice(mark).some(l => l.o?.event === 'duplicate_exit_event'));
  await r.lc.stop();
  // a single instance emitting exit then error transitions once
  const fake = new EventEmitter(); fake.pid = 424242; fake.kill = () => {};
  const lc = createKiwixLifecycle({ spawnFn: () => fake, getSettings: () => ({ kiwixServePath: BIN_DIR, archivesFolder: ZIM_DIR, port: 18_377 }), logger, limits: { ...FAST, healthAttempts: 1, healthIntervalMs: 10 }, listListeners: async () => ({ ok: false }) });
  await lc.start();
  const m2 = logs.length;
  fake.emit('exit', 1); fake.emit('error', new Error('x')); fake.emit('exit', 2);
  assert.deepEqual(transitions(m2), ['STARTING>CRASHED']);
  assert.equal(lc.status().lastExitCode, 1);
});

// ── route / delegation port ────────────────────────────────────────────────────────────────────────────────────────
test('18. routes: start / stop take NO parameters — executable, args, cwd, pid, port, shell are refused (400)', async () => {
  db.initSqlite(':memory:');
  const app = new Hono().route('/api', createKiwixRoute({ services: { indexNeuron: async () => {} }, logger }));
  const post = (p, body) => app.request(`http://localhost/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  for (const body of [{ executable: 'C:\\Windows\\System32\\cmd.exe' }, { args: ['/c', 'calc'] }, { cwd: 'C:\\' }, { pid: 4 }, { port: 3001 }, { shell: true }, { command: 'x' }]) {
    for (const p of ['/kiwix/start', '/kiwix/stop']) {
      const res = await post(p, JSON.stringify(body));
      assert.deepEqual([res.status, (await res.json()).code], [400, 'KIWIX_REQUEST_INVALID'], `${p} ${JSON.stringify(body)}`);
    }
  }
  for (const raw of ['[]', '"x"', '{bad', 'x'.repeat(200)]) assert.equal((await post('/kiwix/start', raw)).status, 400);
  const stop = await post('/kiwix/stop', '');
  assert.deepEqual([stop.status, (await stop.json()).wasRunning], [200, false]);
  const start = await post('/kiwix/start', '{}');
  const sj = await start.json();
  assert.deepEqual([start.status, sj.error], [409, 'binary_not_found'], 'empty settings: refused before any spawn');
});

test('19. delegation port: without a redeemed authorization nothing restarts — process fields, policy-looking objects and the unwired default are all refused, nothing touched', async () => {
  const r = await rig();
  await r.lc.start();
  const before = r.lc.status();
  const port = createKiwixLifecyclePort({ lifecycle: r.lc }); // default redeemer: never authorized (not wired to a restart authority)
  for (const bad of [undefined, null, {}, { executable: 'cmd.exe' }, { args: ['x'] }, { cwd: 'C:\\' }, { pid: before.pid }, { command: 'x' }, { reason: 'SUPERVISOR' },
    { certifiedBoundary: true }, { decision: 'ALLOW', code: 'ALLOW_CERTIFIED_BOUNDARY' }, { approval: { token: 'x' } }, [], 'x', true]) {
    const res = await port.restartOwnedKiwix(bad);
    assert.deepEqual([res.ok, res.error], [false, 'restart_not_authorized'], JSON.stringify(bad) ?? String(bad));
  }
  assert.deepEqual([r.lc.status().pid, r.lc.status().state, r.calls.length], [before.pid, 'HEALTHY', 1], 'nothing stopped or started');
  const st = port.getLifecycleStatus();
  assert.match(st.definitionDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(st).includes(TMP), false, 'no path leaves the module');
  await r.lc.stop();
});

test('20. delegation port: the redeemer is asked with the LIVE digest + generation; a redeemed authorization stops OUR instance (real exit) then starts a new one → HEALTHY', async () => {
  const r = await rig();
  await r.lc.start();
  const seen = []; const GOOD = Object.freeze({});
  const port = createKiwixLifecyclePort({ lifecycle: r.lc, redeemRestartAuthorization: (authorization, binding) => { seen.push(binding); return authorization === GOOD; } });
  const { definitionDigest, generation, pid } = port.getLifecycleStatus();
  assert.equal((await port.restartOwnedKiwix(Object.freeze({}))).error, 'restart_not_authorized', 'a look-alike object is not the authorization');
  assert.deepEqual([r.lc.status().pid, r.calls.length], [pid, 1], 'refused before any stop');
  const mark = logs.length;
  const res = await port.restartOwnedKiwix(GOOD);
  assert.deepEqual([res.ok, res.state], [true, 'HEALTHY']);
  assert.deepEqual(seen.at(-1), { serviceId: 'kiwix-serve', definitionDigest, generation });
  assert.deepEqual(transitions(mark), ['HEALTHY>STOPPING', 'STOPPING>STOPPED', 'STOPPED>STARTING', 'STARTING>HEALTHY']);
  assert.notEqual(r.lc.status().pid, pid);
  assert.equal(r.lc.status().generation, generation + 1);
  assert.equal(alive(pid), false);
  await r.lc.stop();
});

// ── static guards / isolation ──────────────────────────────────────────────────────────────────────────────────────
test('21. static: one spawn site with shell:false + typed argv; no stop by name/port/PID; delegation port wired only by the composition root; logs sanitized', () => {
  const src = fs.readFileSync(path.join(HERE, 'src', 'lib', 'kiwix.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((src.match(/spawnFn\(plan\.executable, plan\.args, plan\.spawnOptions\)/g) ?? []).length, 1, 'one launch site');
  assert.match(src, /spawnFn\(plan\.executable, plan\.args, plan\.spawnOptions\)/);
  assert.match(src, /spawnOptions:\s*\{ cwd: def\.cwd, env: \{ \.\.\.def\.env \}, shell: false, windowsHide: true, stdio: \['ignore', 'ignore', 'ignore'\] \}/);
  assert.doesNotMatch(src, /shell:\s*true|process\.kill\(|taskkill|tasklist|\/IM\b|cmd\.exe|powershell|exec\(/i);
  assert.doesNotMatch(src, /forceKill\((?!inst\.child\))/, 'force kill only ever receives our own handle');
  const users = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name) && /createKiwixLifecyclePort/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(HERE, p).replace(/\\/g, '/')); } };
  walk(path.join(HERE, 'src'));
  assert.deepEqual(users.sort(), ['src/lib/kiwix.js', 'src/server.js'], 'the delegation contract is built only by the composition root (RS-KIWIX-RESTART)');
  const logged = JSON.stringify(logs);
  for (const s of [TMP, BIN_DIR, ZIM_DIR, 'wikipedia_fr', '--blockexternal', '--address', SECRET]) assert.equal(logged.includes(s), false, `log leaked ${s.slice(0, 16)}`);
});

test('22. isolation: 0 external network, real DB / Companion store untouched, no fixture left running', async () => {
  await sleep(200);
  assert.equal(externalFetches, 0);
  assert.deepEqual(REAL.map(fileHash), realBefore);
  const leftovers = children.filter(c => c.exitCode === null && c.signalCode === null && ![...c.spawnargs].includes('--fixture-mode=healthy'));
  assert.equal(leftovers.length, 0, 'only the deliberately external fixtures may still run (killed in after())');
});
