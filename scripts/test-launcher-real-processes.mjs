// [STARTUP-2] Real Windows processes, synthetic services: a throw-away fake repository in %TEMP%, ephemeral ports only.
// Ports 3001 / 5173, the real backend, the user's consoles and browser are never touched. Every process this file
// starts is its own child (or a descendant of its own child) and is cleaned up by PID at the end.
//   node --test scripts/test-launcher-real-processes.mjs          (Windows only; opens one console window briefly)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { takeSnapshot, classifyPort, backendTerminationTargets, terminatePinned, STATES, consoleAnchor } from './launcher-identity.mjs';
import { startConsole, serviceConsole } from './docteur-launch.mjs';

const windows = process.platform === 'win32';
const SERVER_JS = `
const http = require('http');
http.createServer((q, r) => { if (q.url === '/api/ping') { r.setHeader('content-type', 'application/json'); r.end('{"ok":true}'); } else { r.statusCode = 404; r.end(); } })
  .listen(Number(process.env.FAKE_PORT), '127.0.0.1', () => console.log('listening'));
`;
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const spawned = [];
const own = child => { spawned.push(child.pid); return child; };
const killTree = pid => { try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } };

let fake;
test.before(() => {
  if (!windows) return;
  fake = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-launch-real-'));
  fs.mkdirSync(path.join(fake, 'cortex-server', 'src'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'cortex-server', 'package.json'), JSON.stringify({ name: 'fake-cortex', private: true, scripts: { start: 'node src/server.js', dev: 'node --watch-path=src --watch-preserve-output src/server.js' } }));
  fs.writeFileSync(path.join(fake, 'cortex-server', 'src', 'server.js'), SERVER_JS);
});
test.after(async () => {
  for (const pid of spawned) killTree(pid);
  // consoles opened through `start` (production path) are not our direct children: close the ones anchored to THIS
  // test's own temporary fake repository, even when a test failed before registering them
  if (fake) {
    const snap = await takeSnapshot({ ports: [1] });
    for (const p of snap.ok ? snap.processes : []) if (/^cmd\.exe$/i.test(p.name ?? '') && consoleAnchor(p.cmdLine, fake)) killTree(p.pid);
  }
  await sleep(500);
  if (fake) fs.rmSync(fake, { recursive: true, force: true });
});

/** The launcher's backend console chain (cmd /k → npm → cmd /c → node --watch → node src/server.js), hidden window. */
function startFakeBackend(port) {
  const comspec = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return own(spawn(comspec, ['/d', '/s', '/k', `"cd /d "${path.join(fake, 'cortex-server')}" && npm run dev"`],
    { windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, FAKE_PORT: String(port), npm_config_update_notifier: 'false' } }));
}
async function waitFor(port, predicate, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const snap = await takeSnapshot({ ports: [port] });
    assert.equal(snap.ok, true, snap.reason);
    const c = classifyPort(snap, port, 'backend', fake);
    if (predicate(c)) return { snap, c };
    if (Date.now() - t0 > timeoutMs) assert.fail(`timeout waiting on port ${port}: last ${JSON.stringify(c)}`);
    await sleep(700);
  }
}
const alive = async (pid, port) => (await takeSnapshot({ ports: [port] })).processes.some(p => p.pid === pid);

test('confirmed Docteur chain: wrong creation time refused under pin; exact identity stopped (watcher + server only), port released', { skip: !windows }, async () => {
  const port = await freePort();
  const consoleProc = startFakeBackend(port);
  const { snap, c } = await waitFor(port, x => x.state !== STATES.FREE);
  assert.deepEqual([c.state, c.reason], [STATES.BACKEND, 'launcher-console']);
  const targets = backendTerminationTargets(snap, c, fake);
  assert.deepEqual(targets.map(t => t.role), ['watcher', 'server']);
  const expected = { port, pid: c.pid, created: c.created };

  // PID-reuse simulation: same PIDs, different creation time → refused, nothing stopped
  const shifted = targets.map(t => ({ ...t, created: String(BigInt(t.created) + 10n) }));
  const refused = await terminatePinned(shifted, { ...expected, created: shifted[1].created }, { repoRoot: fake, ports: [port] });
  assert.equal(refused.ok, false); assert.match(refused.reason, /^IDENTITY_CHANGED_/);
  assert.equal((await waitFor(port, () => true)).c.pid, c.pid, 'still running');

  const done = await terminatePinned(targets, expected, { repoRoot: fake, ports: [port] });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.killed.sort(), targets.map(t => t.pid).sort());
  await waitFor(port, x => x.state === STATES.FREE, 10_000);
  assert.ok(await alive(consoleProc.pid, port), 'the console (cmd /k) is not closed');
  consoleProc.stdin.end();
});

test('foreign listeners are classified, never targeted, and survive (×10)', { skip: !windows }, async () => {
  const ports = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const [lookalike, tcpOnly, psListener, unanchored] = ports;
  // 1. foreign node HTTP server answering /api/ping exactly like Docteur
  const a = own(spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end('{"ok":true}')).listen(${lookalike},'127.0.0.1')`], { stdio: 'ignore', windowsHide: true }));
  // 2. TCP listener that never speaks HTTP
  const b = own(spawn(process.execPath, ['-e', `require('net').createServer(()=>{}).listen(${tcpOnly},'127.0.0.1')`], { stdio: 'ignore', windowsHide: true }));
  // 3. not a node process at all
  const c = own(spawn(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-Command', `$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, ${psListener}); $l.Start(); Start-Sleep 120`], { stdio: 'ignore', windowsHide: true }));
  // 4. Docteur's own entry point started outside the launcher console (cannot be proven)
  const d = own(spawn(process.execPath, ['src/server.js'], { cwd: path.join(fake, 'cortex-server'), stdio: 'ignore', windowsHide: true, env: { ...process.env, FAKE_PORT: String(unanchored) } }));
  const expect = { [lookalike]: [STATES.FOREIGN, 'OTHER_NODE_PROGRAM', a.pid], [tcpOnly]: [STATES.FOREIGN, 'OTHER_NODE_PROGRAM', b.pid], [psListener]: [STATES.FOREIGN, 'NOT_A_NODE_PROCESS', c.pid], [unanchored]: [STATES.UNKNOWN, 'NOT_ANCHORED_TO_THIS_REPOSITORY', d.pid] };
  for (let round = 0; round < 10; round++) {
    const snap = await takeSnapshot({ ports });
    assert.equal(snap.ok, true);
    for (const port of ports) {
      const cl = classifyPort(snap, port, 'backend', fake);
      if (round === 0 && cl.state === STATES.FREE) { round = -1; break; } // listeners still starting
      if (cl.state === STATES.FREE) continue;
      assert.deepEqual([cl.state, cl.reason, cl.pid], expect[port], `round ${round} port ${port}`);
      assert.equal(backendTerminationTargets(snap, cl, fake), null, 'never a termination target');
    }
    if (round === -1) { await sleep(800); continue; }
  }
  const after = await takeSnapshot({ ports });
  for (const child of [a, b, c, d]) assert.ok(after.processes.some(p => p.pid === child.pid), `pid ${child.pid} survived`);
  assert.equal(after.listeners.filter(l => ports.includes(l.port)).length >= 4, true);
});

test('listener replaced between observation and termination: refused, the new owner survives; dead PID: refused', { skip: !windows }, async () => {
  const port = await freePort();
  const first = startFakeBackend(port);
  const { snap, c } = await waitFor(port, x => x.state === STATES.BACKEND);
  const targets = backendTerminationTargets(snap, c, fake);
  killTree(first.pid); // the original owner goes away…
  await waitFor(port, x => x.state === STATES.FREE, 10_000);
  const second = startFakeBackend(port); // …and an identical-looking instance takes the port
  const now = await waitFor(port, x => x.state === STATES.BACKEND);
  assert.notEqual(now.c.created, c.created);
  const r = await terminatePinned(targets, { port, pid: c.pid, created: c.created }, { repoRoot: fake, ports: [port] });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /TARGET_NOT_PINNABLE|IDENTITY_CHANGED_/);
  assert.equal((await waitFor(port, () => true)).c.pid, now.c.pid, 'new owner untouched');
  killTree(second.pid);
});

test('production console path (start "Cortex Server" cmd /s /k …): real window, anchored command line, confirmed identity', { skip: !windows }, async () => {
  const port = await freePort();
  const spec = serviceConsole('backend', { repoRoot: fake, env: { ...process.env, FAKE_PORT: String(port) } });
  const t0 = await takeSnapshot({ ports: [port] });
  const started = await startConsole(spec);
  assert.deepEqual(started, { ok: true });
  const { snap, c } = await waitFor(port, x => x.state !== STATES.FREE);
  assert.deepEqual([c.state, c.reason], [STATES.BACKEND, 'launcher-console']);
  const consoles = snap.processes.filter(p => /^cmd\.exe$/i.test(p.name ?? '') && consoleAnchor(p.cmdLine, fake) === 'backend' && !t0.processes.some(q => q.pid === p.pid));
  assert.equal(consoles.length, 1, 'exactly the console this test opened');
  assert.equal(spec.env.npm_config_update_notifier, 'false');
  const done = await terminatePinned(backendTerminationTargets(snap, c, fake), { port, pid: c.pid, created: c.created }, { repoRoot: fake, ports: [port] });
  assert.equal(done.ok, true);
  spawned.push(consoles[0].pid); // the visible console window this test opened is closed in test.after
});
