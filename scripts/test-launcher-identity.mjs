// [STARTUP-2] Pure identity / classification / termination-guard tests on synthetic snapshots (no process is touched).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  STATES, splitCommandLine, recognizeBackend, recognizeFrontend, consoleAnchor, classifyPort, findDocteurProcesses,
  backendTerminationTargets, sameTargetsStillConfirmed, terminatePinned, takeSnapshot, normalizeSnapshot,
} from './launcher-identity.mjs';
import { createWorld, REPO } from './launcher-test-world.mjs';

test('command lines: Docteur backend / frontend entry points are recognised, nothing else', () => {
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" --x "a b" c'), ['C:\\Program Files\\nodejs\\node.exe', '--x', 'a b', 'c']);
  assert.deepEqual(recognizeBackend('node  --watch-path=src --watch-preserve-output src/server.js', REPO), { role: 'watcher', absolute: false });
  assert.deepEqual(recognizeBackend('"C:\\Program Files\\nodejs\\node.exe" --watch-preserve-output src/server.js', REPO), { role: 'server', absolute: false });
  assert.deepEqual(recognizeBackend(`node "${REPO}\\cortex-server\\src\\server.js"`, REPO), { role: 'server', absolute: true });
  assert.deepEqual(recognizeBackend(`node ${REPO.replace(/\\/g, '/')}/cortex-server/src/server.js`, REPO), { role: 'server', absolute: true });
  for (const cmd of [
    'node src/server.js --check', // one-shot check, not a server
    'node other/src/server.js', 'node server.js', 'node C:\\other\\cortex-server\\src\\server.js',
    'python src/server.js', 'deno run src/server.js', 'node', '', null,
    'node "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev',
  ]) assert.equal(recognizeBackend(cmd, REPO), null, String(cmd));
  assert.deepEqual(recognizeFrontend(`"node"  "${REPO}\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js" `, REPO), { role: 'dev', absolute: true });
  assert.deepEqual(recognizeFrontend(`node "${REPO}\\node_modules\\vite\\bin\\vite.js" preview`, REPO), { role: 'other', absolute: true });
  assert.equal(recognizeFrontend('node "C:\\other\\node_modules\\vite\\bin\\vite.js"', REPO), null);
});

test('launcher console anchor: exact repository, exact command, quoted or not', () => {
  assert.equal(consoleAnchor(`"C:\\WINDOWS\\System32\\cmd.exe" /s /k "cd /d "${REPO}\\cortex-server" && npm run dev"`, REPO), 'backend');
  assert.equal(consoleAnchor(`cmd  /k "cd /d ${REPO}\\cortex-server && npm run dev"`, REPO), 'backend');
  assert.equal(consoleAnchor(`cmd /k "cd /d ${REPO.toLowerCase()}\\CORTEX-SERVER && npm run dev"`, REPO), 'backend');
  assert.equal(consoleAnchor(`"C:\\WINDOWS\\System32\\cmd.exe" /s /k "cd /d "${REPO}" && npm run dev"`, REPO), 'frontend');
  // [STARTUP-3] daily mode: `npm start` anchors the backend console only
  assert.equal(consoleAnchor(`"C:\\WINDOWS\\System32\\cmd.exe" /s /k "cd /d "${REPO}\\cortex-server" && npm start"`, REPO), 'backend');
  for (const cmd of [`cmd /k "cd /d ${REPO} && npm start"`, `cmd /k "cd /d ${REPO}\\cortex-server && npm run start"`, `cmd /k "cd /d ${REPO}\\cortex-server && npm start && evil"`, `cmd /k "cd /d ${REPO}\\cortex-server && npm starts"`]) {
    assert.equal(consoleAnchor(cmd, REPO), null, cmd);
  }
  for (const cmd of [
    `cmd /k "cd /d ${REPO}2\\cortex-server && npm run dev"`, // sibling directory sharing the prefix
    `cmd /k "cd /d ${REPO}\\cortex-server2 && npm run dev"`,
    `cmd /k "cd /d ${REPO}\\cortex-server && npm run dev && evil"`,
    `cmd /k "cd /d ${REPO}\\cortex-server && npm run dev:local"`,
    `cmd /k "cd /d C:\\other\\cortex-server && npm run dev"`,
    `powershell -c "cd /d ${REPO}\\cortex-server && npm run dev"`,
    `cmd /k "title Cortex Server"`, null,
  ]) assert.equal(consoleAnchor(cmd, REPO), null, String(cmd));
});

test('3001 classification: FREE, confirmed Docteur backend, foreign, unknown, inconsistent', () => {
  const free = createWorld();
  assert.equal(classifyPort(free.snapshot(), 3001, 'backend', REPO).state, STATES.FREE);

  const ok = createWorld();
  const chain = ok.backendChain();
  const c = classifyPort(ok.snapshot(), 3001, 'backend', REPO);
  assert.equal(c.state, STATES.BACKEND); assert.equal(c.pid, chain.server); assert.equal(c.reason, 'launcher-console');

  const nonNode = createWorld(); nonNode.listen(3001, nonNode.add({ name: 'grafana-server.exe' }));
  assert.deepEqual([classifyPort(nonNode.snapshot(), 3001, 'backend', REPO).state, classifyPort(nonNode.snapshot(), 3001, 'backend', REPO).reason], [STATES.FOREIGN, 'NOT_A_NODE_PROCESS']);

  const otherNode = createWorld(); otherNode.listen(3001, otherNode.add({ name: 'node.exe', cmdLine: 'node C:\\work\\api\\index.js' }));
  assert.equal(classifyPort(otherNode.snapshot(), 3001, 'backend', REPO).reason, 'OTHER_NODE_PROGRAM');

  // Docteur-looking entry point started from a plain terminal (no launcher console in its ancestry): not provable
  const manual = createWorld();
  const term = manual.add({ name: 'pwsh.exe' });
  manual.listen(3001, manual.add({ name: 'node.exe', ppid: term, cmdLine: 'node src/server.js' }));
  assert.deepEqual(pick(classifyPort(manual.snapshot(), 3001, 'backend', REPO)), [STATES.UNKNOWN, 'NOT_ANCHORED_TO_THIS_REPOSITORY']);

  // the same entry point under another checkout's launcher console
  const other = createWorld({ repo: 'C:\\dev\\DocteurFork' }); other.backendChain();
  assert.deepEqual(pick(classifyPort(other.snapshot(), 3001, 'backend', REPO)), [STATES.UNKNOWN, 'NOT_ANCHORED_TO_THIS_REPOSITORY']);

  const hidden = createWorld(); hidden.listen(3001, hidden.add({ name: 'node.exe', cmdLine: null })); // another user's / elevated process
  assert.deepEqual(pick(classifyPort(hidden.snapshot(), 3001, 'backend', REPO)), [STATES.UNKNOWN, 'COMMAND_LINE_UNREADABLE']);

  const system = createWorld(); system.listeners.push({ port: 3001, pid: 4, address: '0.0.0.0' });
  assert.deepEqual(pick(classifyPort(system.snapshot(), 3001, 'backend', REPO)), [STATES.FOREIGN, 'SYSTEM_OWNER']);

  const two = createWorld(); const a = two.backendChain(); two.listen(3001, two.add({ name: 'node.exe', cmdLine: 'node x.js' }), '::1');
  assert.deepEqual(pick(classifyPort(two.snapshot(), 3001, 'backend', REPO)), [STATES.INCONSISTENT, 'MULTIPLE_OWNERS']);
  assert.ok(a.server);

  const vanished = createWorld(); vanished.listeners.push({ port: 3001, pid: 999999, address: '127.0.0.1' });
  assert.deepEqual(pick(classifyPort(vanished.snapshot(), 3001, 'backend', REPO)), [STATES.INCONSISTENT, 'OWNER_NOT_IN_PROCESS_LIST']);

  const lan = createWorld(); const l = lan.backendChain({ listen: false }); lan.listen(3001, l.server, '0.0.0.0');
  assert.deepEqual(pick(classifyPort(lan.snapshot(), 3001, 'backend', REPO)), [STATES.UNKNOWN, 'NON_LOOPBACK_LISTENER']);

  const swapped = createWorld(); const f = swapped.frontendChain({ listen: false }); swapped.listen(3001, f.vite, '::');
  assert.deepEqual(pick(classifyPort(swapped.snapshot(), 3001, 'backend', REPO)), [STATES.UNKNOWN, 'DOCTEUR_FRONTEND_ON_WRONG_PORT']);
});

test('daily-mode chain (npm start → node src/server.js, no watcher) is a confirmed backend; anything foreign is not', () => {
  const w = createWorld(); const c = w.backendChain({ mode: 'daily' });
  assert.deepEqual(pick(classifyPort(w.snapshot(), 3001, 'backend', REPO)), [STATES.BACKEND, 'launcher-console']);
  assert.deepEqual(backendTerminationTargets(w.snapshot(), classifyPort(w.snapshot(), 3001, 'backend', REPO), REPO).map(t => [t.pid, t.role]), [[c.server, 'server']]);
  const fake = createWorld(); const term = fake.add({ name: 'cmd.exe', cmdLine: `cmd /k "cd /d C:\\other\\cortex-server && npm start"` });
  fake.listen(3001, fake.add({ name: 'node.exe', ppid: term, cmdLine: 'node src/server.js' }));
  assert.deepEqual(pick(classifyPort(fake.snapshot(), 3001, 'backend', REPO)), [STATES.UNKNOWN, 'NOT_ANCHORED_TO_THIS_REPOSITORY']);
});

test('PID reuse in the ancestry breaks the anchor: a parent younger than its child is not its parent', () => {
  const w = createWorld();
  const chain = w.backendChain();
  // the npm process died and its PID now names a process created after the server
  const npm = w.procs.get(chain.npm);
  npm.created = String(BigInt(w.procs.get(chain.server).created) + 1n);
  assert.deepEqual(pick(classifyPort(w.snapshot(), 3001, 'backend', REPO)), [STATES.UNKNOWN, 'NOT_ANCHORED_TO_THIS_REPOSITORY']);
  // unknown creation time is never trusted either
  const v = createWorld(); const c2 = v.backendChain(); v.procs.get(c2.shell).created = null;
  assert.equal(classifyPort(v.snapshot(), 3001, 'backend', REPO).state, STATES.UNKNOWN);
});

test('5173 classification: confirmed Vite dev server of this repository only', () => {
  const ok = createWorld(); const f = ok.frontendChain();
  assert.deepEqual(pick(classifyPort(ok.snapshot(), 5173, 'frontend', REPO)), [STATES.FRONTEND, 'absolute-path']);
  assert.equal(classifyPort(ok.snapshot(), 5173, 'frontend', REPO).pid, f.vite);
  const preview = createWorld(); preview.listen(5173, preview.add({ name: 'node.exe', cmdLine: `node "${REPO}\\node_modules\\vite\\bin\\vite.js" preview --port 5173` }), '::');
  assert.deepEqual(pick(classifyPort(preview.snapshot(), 5173, 'frontend', REPO)), [STATES.UNKNOWN, 'NOT_THE_DEV_SERVER']);
  const otherVite = createWorld(); otherVite.listen(5173, otherVite.add({ name: 'node.exe', cmdLine: 'node "C:\\proj\\node_modules\\vite\\bin\\vite.js"' }), '::');
  assert.equal(classifyPort(otherVite.snapshot(), 5173, 'frontend', REPO).state, STATES.FOREIGN);
  const lanVite = createWorld(); const g = lanVite.frontendChain({ listen: false }); lanVite.listen(5173, g.vite, '0.0.0.0');
  assert.deepEqual(pick(classifyPort(lanVite.snapshot(), 5173, 'frontend', REPO)), [STATES.UNKNOWN, 'NON_LOOPBACK_LISTENER']);
});

test('booting services, idle watchers and leftover consoles are reported (never acted on)', () => {
  const w = createWorld();
  w.backendChain({ listen: false }); // booting: server process alive, not yet listening
  let p = findDocteurProcesses(w.snapshot(), REPO);
  assert.equal(p.backendServers.length, 1); assert.equal(p.idleWatchers.length, 0); assert.equal(p.idleConsoles.length, 0);

  const crashed = createWorld(); const c = crashed.backendChain({ listen: false }); crashed.remove(c.server);
  p = findDocteurProcesses(crashed.snapshot(), REPO);
  assert.equal(p.backendServers.length, 0); assert.equal(p.idleWatchers.length, 1);
  assert.deepEqual(p.idleConsoles, [{ pid: c.console, kind: 'backend' }]);

  const dead = createWorld(); const d = dead.frontendChain(); dead.remove(d.vite);
  assert.deepEqual(findDocteurProcesses(dead.snapshot(), REPO).idleConsoles, [{ pid: d.console, kind: 'frontend' }]);
});

test('termination targets: only the verified watcher + server, never descendants (browser, kiwix-serve…)', () => {
  const w = createWorld();
  const chain = w.backendChain();
  const chrome = w.add({ name: 'chrome.exe', ppid: chain.server }); // opened by lib/browser.js for the user
  const kiwix = w.add({ name: 'kiwix-serve.exe', ppid: chain.server });
  const c = classifyPort(w.snapshot(), 3001, 'backend', REPO);
  const targets = backendTerminationTargets(w.snapshot(), c, REPO);
  assert.deepEqual(targets.map(t => [t.pid, t.role]), [[chain.watcher, 'watcher'], [chain.server, 'server']]);
  assert.ok(!targets.some(t => t.pid === chrome || t.pid === kiwix || t.pid === chain.console || t.pid === chain.npm));

  const noWatch = createWorld(); const n = noWatch.backendChain({ watcher: false });
  assert.deepEqual(backendTerminationTargets(noWatch.snapshot(), classifyPort(noWatch.snapshot(), 3001, 'backend', REPO), REPO).map(t => t.pid), [n.server]);
  for (const state of [STATES.FREE, STATES.FOREIGN, STATES.UNKNOWN, STATES.INCONSISTENT]) assert.equal(backendTerminationTargets(w.snapshot(), { state }, REPO), null);
  assert.equal(backendTerminationTargets(w.snapshot(), { ...c, created: '1' }, REPO), null, 'stale classification');
});

test('re-verification: same listener + same targets only', () => {
  const w = createWorld(); const chain = w.backendChain();
  const c = classifyPort(w.snapshot(), 3001, 'backend', REPO);
  const targets = backendTerminationTargets(w.snapshot(), c, REPO);
  const expected = { port: 3001, pid: c.pid, created: c.created };
  assert.deepEqual(sameTargetsStillConfirmed(w.snapshot(), targets, expected, REPO), { ok: true });

  const reused = createWorld(); reused.clock += 1_000_000n; reused.backendChain(); // same PIDs and shape, different creation times = another process
  assert.equal(sameTargetsStillConfirmed(reused.snapshot(), targets, expected, REPO).ok, false);

  const gone = createWorld(); gone.procs = new Map(w.procs); gone.listeners = [];
  assert.deepEqual(sameTargetsStillConfirmed(gone.snapshot(), targets, expected, REPO), { ok: false, reason: 'LISTENER_FREE' });

  const foreign = createWorld(); foreign.procs = new Map(w.procs); foreign.listen(3001, foreign.add({ name: 'node.exe', cmdLine: 'node evil.js' }));
  assert.equal(sameTargetsStillConfirmed(foreign.snapshot(), targets, expected, REPO).reason, 'LISTENER_FOREIGN_PROCESS');

  const rewatched = createWorld(); rewatched.procs = new Map([...w.procs].map(([k, v]) => [k, { ...v }])); rewatched.listeners = w.listeners.map(l => ({ ...l }));
  rewatched.procs.get(chain.watcher).created = String(BigInt(rewatched.procs.get(chain.watcher).created) - 5n); // a different watcher instance
  assert.deepEqual(sameTargetsStillConfirmed(rewatched.snapshot(), targets, expected, REPO), { ok: false, reason: 'TARGETS_CHANGED' });
});

function fakeSession(pinnedSnapshot, { pinFail = false } = {}) {
  const sent = [];
  const queue = pinFail ? [JSON.stringify({ phase: 'pin', ok: false, reason: 'TARGET_NOT_PINNABLE' })] : [JSON.stringify({ ...pinnedSnapshot, phase: 'pinned' })];
  return {
    sent,
    open: ({ pids }) => ({
      next: async () => queue.shift() ?? null,
      send: text => { sent.push(text); queue.push(JSON.stringify(text === 'GO' ? { phase: 'done', killed: pids, failed: [], exited: pids } : { phase: 'done', killed: [], reason: 'ABORTED' })); },
      close: () => {},
    }),
  };
}

test('terminatePinned: GO only when the pinned re-observation matches; any doubt aborts with nothing killed', async () => {
  const w = createWorld(); w.backendChain();
  const c = classifyPort(w.snapshot(), 3001, 'backend', REPO);
  const targets = backendTerminationTargets(w.snapshot(), c, REPO);
  const expected = { port: 3001, pid: c.pid, created: c.created };
  const opts = s => ({ openSession: s.open, platform: 'win32', repoRoot: REPO });

  const same = fakeSession(w.snapshot());
  assert.deepEqual(await terminatePinned(targets, expected, opts(same)), { ok: true, killed: targets.map(t => t.pid), exited: targets.map(t => t.pid) });
  assert.deepEqual(same.sent, ['GO']);

  const other = createWorld(); other.clock += 1_000_000n; other.backendChain(); // PID now names a different process (different creation times)
  const changed = fakeSession(other.snapshot());
  const r = await terminatePinned(targets, expected, opts(changed));
  assert.equal(r.ok, false); assert.match(r.reason, /^IDENTITY_CHANGED_/); assert.deepEqual(changed.sent, ['ABORT']);

  const pinFail = fakeSession(null, { pinFail: true });
  assert.deepEqual(await terminatePinned(targets, expected, opts(pinFail)), { ok: false, reason: 'TARGET_NOT_PINNABLE' });
  assert.deepEqual(pinFail.sent, ['ABORT']);

  const unusable = fakeSession({ ok: false, reason: 'PROCESSES_UNREADABLE' });
  assert.equal((await terminatePinned(targets, expected, opts(unusable))).reason, 'IDENTITY_CHANGED_PINNED_SNAPSHOT_UNUSABLE');
  assert.deepEqual(unusable.sent, ['ABORT']);

  let opened = 0;
  const never = { openSession: () => { opened++; return null; }, platform: 'win32', repoRoot: REPO };
  for (const bad of [[], [...targets, { pid: 9999, created: '1' }, { pid: 9998, created: '2' }], [{ pid: 4, created: '1' }], [{ pid: 10, created: 'x' }], null]) {
    assert.equal((await terminatePinned(bad, expected, never)).reason, 'BAD_TARGETS');
  }
  assert.equal((await terminatePinned(targets, { ...expected, port: 80 }, never)).reason, 'BAD_PORTS');
  assert.equal((await terminatePinned(targets, expected, { ...never, platform: 'linux' })).reason, 'NOT_WINDOWS');
  assert.equal(opened, 0, 'invalid requests never reach PowerShell');
});

test('snapshot failures are never "free"', async () => {
  const run = result => async () => result;
  assert.deepEqual(await takeSnapshot({ platform: 'linux' }), { ok: false, reason: 'NOT_WINDOWS' });
  assert.deepEqual(await takeSnapshot({ platform: 'win32', run: run({ ok: false, reason: 'TIMEOUT' }) }), { ok: false, reason: 'SNAPSHOT_TIMEOUT' });
  assert.deepEqual(await takeSnapshot({ platform: 'win32', run: run({ ok: true, stdout: 'garbage' }) }), { ok: false, reason: 'SNAPSHOT_UNPARSEABLE' });
  assert.deepEqual(await takeSnapshot({ platform: 'win32', run: run({ ok: true, stdout: '{"ok":false,"reason":"LISTENERS_UNREADABLE"}' }) }), { ok: false, reason: 'LISTENERS_UNREADABLE' });
  assert.deepEqual(await takeSnapshot({ platform: 'win32', run: run({ ok: true, stdout: '{"ok":true,"listeners":[],"processes":[]}' }) }), { ok: false, reason: 'SNAPSHOT_UNPARSEABLE' });
  assert.deepEqual(await takeSnapshot({ platform: 'win32', ports: [3001, 'x'] }), { ok: false, reason: 'BAD_PORTS' });
  // PowerShell collapses single-element arrays into objects
  const one = normalizeSnapshot({ ok: true, listeners: { address: '127.0.0.1', port: 3001, pid: 7 }, processes: { pid: 7, ppid: 1, name: 'node.exe', created: '5', cmdLine: 'node x' } });
  assert.equal(one.listeners.length, 1); assert.equal(one.processes.length, 1);
});

test('PowerShell scripts: read-only snapshot, termination only through pinned handles (no taskkill, no tree kill, no image-name kill)', () => {
  const src = fs.readFileSync(new URL('./launcher-identity.mjs', import.meta.url), 'utf8');
  const snapshotPart = src.slice(src.indexOf('const snapshotBody'), src.indexOf('function runPowerShell'));
  assert.ok(!/Stop-Process|taskkill|\.Kill\(|Remove-|Set-|New-/.test(snapshotPart), 'snapshot script is read-only');
  assert.ok(!/taskkill|Stop-Process|\/T\b|-Name/.test(src.slice(src.indexOf('const terminateScript'))), 'no tree / name based termination');
  assert.match(src, /foreach \(\$p in \$pinned\) \{ try \{ if \(-not \$p\.HasExited\) \{ \$p\.Kill\(\) \}/);
  assert.match(src, /if \(\$answer -ne 'GO'\)/);
  assert.ok(src.indexOf("$null = $p.Handle") < src.indexOf('$snap.phase = \'pinned\''), 'pinned before re-observation');
});

const pick = c => [c.state, c.reason];
