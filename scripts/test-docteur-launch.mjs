// [STARTUP-2] Launch sequence scenarios on a synthetic world + virtual clock (no real port, process, console or browser).
// "code 0" is the only outcome on which Docteur-Launcher.bat opens Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {
  runLaunch, describeFailure, serviceConsole, findOllamaExe, isCmdSafePath, pingBackend,
  BACKEND_READY_TIMEOUT_MS, FRONTEND_READY_TIMEOUT_MS, BACKEND_BUSY_GRACE_MS, PROCESS_APPEAR_MS,
  FRONTEND_REQUEST_TIMEOUT_MS, BACKEND_REQUEST_TIMEOUT_MS,
} from './docteur-launch.mjs';
import { DOCTEUR_MARKER, loopbackTarget, probeFrontend } from './wait-for-frontend.mjs';
import { createWorld, worldDeps, startBackend, startFrontend, startOllama, REPO } from './launcher-test-world.mjs';

const normal = { ollama: startOllama, backend: startBackend(5_000), frontend: startFrontend(3_000) };
async function launch(w, opts = {}) {
  const deps = worldDeps(w, { ...opts, onStart: { ...normal, ...opts.onStart } });
  const result = await runLaunch(deps);
  assert.equal(w.lockHeld, false, 'lock always released');
  return result;
}
const foreignNode = (w, port, address = '127.0.0.1') => { const pid = w.add({ name: 'node.exe', cmdLine: 'node C:\\work\\api\\server.js' }); w.listen(port, pid, address); return pid; };

// ── Phase B: startup ──────────────────────────────────────────────────────────────────────────────────────────────
test('cold start: ports checked first, then Ollama, backend, frontend; ready only when both answer AND are identified', async () => {
  const w = createWorld();
  const r = await launch(w);
  assert.equal(r.code, 0);
  assert.deepEqual(w.starts, ['ollama', 'backend', 'frontend']);
  assert.deepEqual(r.trace, ['PREFLIGHT', 'PORT_CHECK', 'OLLAMA', 'BACKEND_STARTING', 'BACKEND_READY', 'FRONTEND_STARTING', 'FRONTEND_READY', 'BROWSER_OPENING']);
  assert.ok(w.said.some(l => /Moteur Docteur prêt et vérifié/.test(l)) && w.said.some(l => /Interface prête et vérifiée/.test(l)));
  assert.match(w.said.at(-1), /Docteur est prêt/);
  assert.equal(w.terminations.length, 0);
});

test('slow cold boot (91 s, as observed once): waits, shows elapsed time / maximum, no fake percentage', async () => {
  const w = createWorld();
  const r = await launch(w, { onStart: { backend: startBackend(91_000) } });
  assert.equal(r.code, 0);
  const progress = w.said.filter(l => /Le moteur s'initialise… \d+ s écoulées \(maximum 120 s\)/.test(l));
  assert.ok(progress.length >= 8, `progress lines: ${progress.length}`);
  assert.ok(!w.said.some(l => /%/.test(l)), 'no invented percentage');
});

test('backend never answers: bounded failure at 120 s, frontend never started, Chrome not opened', async () => {
  const w = createWorld();
  const r = await launch(w, { onStart: { backend: startBackend(10 * BACKEND_READY_TIMEOUT_MS) } });
  assert.deepEqual([r.code, r.error], [1, 'BACKEND_TIMEOUT']);
  assert.ok(w.t >= BACKEND_READY_TIMEOUT_MS && w.t < BACKEND_READY_TIMEOUT_MS + 10_000, `bounded: ${w.t}`);
  assert.deepEqual(w.starts, ['ollama', 'backend']);
  assert.match(describeFailure(r), /ERREUR BACKEND_TIMEOUT[\s\S]*Chrome n'a pas été ouvert/);
});

test('backend crashes while booting (node --watch waits on): reported at once, not after 120 s', async () => {
  const w = createWorld();
  const r = await launch(w, { onStart: { backend: ww => { startBackend(60_000)(ww); ww.at(12_000, () => ww.remove(ww.lastBackend.server)); } } });
  assert.deepEqual([r.code, r.error], [1, 'BACKEND_CRASHED']);
  assert.ok(w.t < 30_000, `fast: ${w.t}`);
  assert.match(describeFailure(r), /fenêtre « Cortex Server » \(elle reste ouverte\)/);
});

test('backend process exits entirely / never appears', async () => {
  const exits = createWorld();
  const r1 = await launch(exits, { onStart: { backend: ww => { startBackend(60_000)(ww); ww.at(9_000, () => { for (const pid of Object.values(ww.lastBackend)) if (pid) ww.remove(pid); }); } } });
  assert.equal(r1.error, 'BACKEND_EXITED');
  const never = createWorld();
  const r2 = await launch(never, { onStart: { backend: () => ({ ok: true }) } });
  assert.equal(r2.error, 'BACKEND_PROCESS_NOT_FOUND');
  assert.ok(never.t >= PROCESS_APPEAR_MS && never.t < PROCESS_APPEAR_MS + 10_000);
  const spawnFail = createWorld();
  assert.equal((await launch(spawnFail, { onStart: { backend: () => ({ ok: false, reason: 'SPAWN_FAILED' }) } })).error, 'BACKEND_START_FAILED');
});

test('a foreign program grabs 3001 while the backend boots (even if it answers /api/ping like Docteur)', async () => {
  const w = createWorld();
  w.foreignBackendAnswers = true;
  const r = await launch(w, { onStart: { backend: ww => { startBackend(60_000)(ww); ww.at(6_000, () => foreignNode(ww, 3001)); } } });
  assert.deepEqual([r.code, r.error], [1, 'BACKEND_PORT_TAKEN']);
  assert.ok(!w.starts.includes('frontend'));
});

test('frontend: timeout, crash, foreign answer — each bounded, Chrome never opened', async () => {
  const slow = createWorld();
  const r1 = await launch(slow, { onStart: { frontend: startFrontend(10 * FRONTEND_READY_TIMEOUT_MS) } });
  assert.equal(r1.error, 'FRONTEND_NOT_READY');
  const crash = createWorld();
  const r2 = await launch(crash, { onStart: { frontend: ww => { startFrontend(30_000)(ww); ww.at(5_000, () => ww.remove(ww.lastFrontend.vite)); } } });
  assert.equal(r2.error, 'FRONTEND_EXITED');
  const foreign = createWorld();
  const r3 = await launch(foreign, { onStart: { frontend: ww => { startFrontend(60_000)(ww); ww.at(2_000, () => { ww.frontendForeignAnswer = true; foreignNode(ww, 5173, '::'); }); } } });
  assert.equal(r3.error, 'FRONTEND_PORT_TAKEN');
  for (const r of [r1, r2, r3]) assert.equal(r.code, 1);
});

test('probe failure is never read as "free": nothing started', async () => {
  const w = createWorld();
  w.snapshotFails = 1;
  const r = await launch(w);
  assert.deepEqual([r.code, r.error, r.detail], [1, 'PROCESS_PROBE_FAILED', 'SNAPSHOT_TIMEOUT']);
  assert.deepEqual(w.starts, []);
});

// ── Phase A: port 3001 ownership ─────────────────────────────────────────────────────────────────────────────────
for (const [label, setup, error] of [
  ['foreign HTTP server (node)', w => foreignNode(w, 3001), 'BACKEND_PORT_FOREIGN'],
  ['foreign non-node program', w => { const p = w.add({ name: 'grafana.exe' }); w.listen(3001, p, '0.0.0.0'); return p; }, 'BACKEND_PORT_FOREIGN'],
  ['Docteur-looking server.js not anchored to this repository', w => { const p = w.add({ name: 'node.exe', cmdLine: 'node src/server.js' }); w.listen(3001, p); return p; }, 'BACKEND_PORT_UNKNOWN_OWNER'],
  ['process whose command line cannot be read', w => { const p = w.add({ name: 'node.exe', cmdLine: null }); w.listen(3001, p); return p; }, 'BACKEND_PORT_UNKNOWN_OWNER'],
  ['two different owners', w => { foreignNode(w, 3001); return foreignNode(w, 3001, '::1'); }, 'BACKEND_PORT_INCONSISTENT'],
  ['owner vanished from the process list', w => { w.listeners.push({ port: 3001, pid: 77777, address: '127.0.0.1' }); return null; }, 'BACKEND_PORT_INCONSISTENT'],
]) {
  test(`3001 held by ${label}: refused, nothing started, nothing terminated, no Chrome`, async () => {
    const w = createWorld();
    const pid = setup(w);
    const r = await launch(w);
    assert.deepEqual([r.code, r.error], [1, error]);
    assert.deepEqual(w.starts, [], 'no Ollama, no backend, no frontend');
    assert.equal(w.terminations.length, 0);
    assert.equal(w.confirms.length, 0, 'the user is not even asked');
    if (pid) assert.ok(w.procs.has(pid), 'the other program survives');
    assert.match(describeFailure(r), /Docteur n'a fermé aucun processus/);
  });
}

test('healthy confirmed Docteur backend is reused: no second backend, nothing terminated', async () => {
  const w = createWorld();
  const chain = w.backendChain();
  const r = await launch(w);
  assert.equal(r.code, 0);
  assert.deepEqual(w.starts, ['ollama', 'frontend']);
  assert.ok(w.procs.has(chain.server) && w.terminations.length === 0);
  assert.ok(w.said.some(l => /Moteur Docteur déjà actif et vérifié \(PID \d+, mode développement : rechargement automatique\) : réutilisé/.test(l)));
  assert.ok(w.said.some(l => /vous avez demandé le mode quotidien stable\. Pour changer de mode, fermer la fenêtre « Cortex Server »/.test(l)), 'mode mismatch explained, nothing stopped');
});

test('confirmed backend busy for 20 s then answers: reused, never treated as abandoned', async () => {
  const w = createWorld();
  w.backendChain();
  w.backendHealthy = false;
  w.at(20_000, () => { w.backendHealthy = true; });
  const r = await launch(w);
  assert.equal(r.code, 0);
  assert.equal(w.confirms.length, 0);
  assert.ok(!w.starts.includes('backend'));
});

test('confirmed but hung backend: user says no (or no answer) → nothing stopped, launch refused', async () => {
  const w = createWorld();
  const chain = w.backendChain();
  w.backendHealthy = false;
  const r = await launch(w, { confirmAnswer: false });
  assert.deepEqual([r.code, r.error], [1, 'BACKEND_UNRESPONSIVE']);
  assert.ok(w.t >= BACKEND_BUSY_GRACE_MS, 'waited the busy grace first');
  assert.equal(w.confirms.length, 1);
  assert.match(w.confirms[0], new RegExp(`PID ${chain.watcher} \\(surveillance node --watch\\), PID ${chain.server} \\(moteur\\)`));
  assert.equal(w.terminations.length, 0);
  assert.ok(w.procs.has(chain.server));
});

test('confirmed hung backend, user agrees: exactly its watcher + server stopped, port release verified, new backend started', async () => {
  const w = createWorld();
  const chain = w.backendChain();
  const browser = w.add({ name: 'chrome.exe', ppid: chain.server });
  w.backendHealthy = false;
  const r = await launch(w, { confirmAnswer: ww => { ww.backendHealthy = true; return true; } });
  assert.equal(r.code, 0);
  assert.equal(w.terminations.length, 1);
  assert.deepEqual(w.terminations[0].targets.map(t => t.pid), [chain.watcher, chain.server]);
  assert.deepEqual(w.terminations[0].expected, { port: 3001, pid: chain.server, created: w.terminations[0].targets[1].created });
  assert.ok(w.procs.has(browser), 'a browser opened by the backend is not touched');
  assert.ok(w.procs.has(chain.console), 'the old console (diagnostics) is not closed');
  assert.ok(r.trace.includes('STOPPING'));
  assert.deepEqual(w.starts, ['ollama', 'backend', 'frontend']);
});

test('replacement refused at the pinned re-check (identity changed / PID reused): nothing started', async () => {
  const w = createWorld();
  w.backendChain();
  w.backendHealthy = false;
  const r = await launch(w, { confirmAnswer: true, terminateResult: () => ({ ok: false, reason: 'IDENTITY_CHANGED_LISTENER_NOT_THE_SAME_PROCESS' }) });
  assert.deepEqual([r.code, r.error], [1, 'BACKEND_REPLACE_REFUSED']);
  assert.match(r.detail, /rien n'a été arrêté/);
  assert.deepEqual(w.starts, []);
});

test('port still held after an authorised stop: bounded wait, refused, no new backend', async () => {
  const w = createWorld();
  const chain = w.backendChain();
  w.backendHealthy = false;
  const r = await launch(w, { confirmAnswer: true, terminateResult: ww => { ww.remove(chain.watcher); return { ok: false, reason: 'unused' }; } });
  assert.equal(r.error, 'BACKEND_REPLACE_REFUSED');
  const v = createWorld();
  const c2 = v.backendChain();
  v.backendHealthy = false;
  const zombie = v.add({ name: 'node.exe', cmdLine: 'node other.js' });
  const r2 = await launch(v, { confirmAnswer: true, terminateResult: vv => { vv.at(0, () => vv.listen(3001, zombie)); return { ok: true, killed: [c2.watcher, c2.server] }; } });
  assert.deepEqual([r2.code, r2.error], [1, 'BACKEND_PORT_NOT_RELEASED']);
  assert.ok(!v.starts.includes('backend'));
  assert.ok(v.procs.has(zombie));
});

test('listener replaced during the busy wait: re-planned from scratch, the new owner is judged on its own', async () => {
  const w = createWorld();
  const chain = w.backendChain();
  w.backendHealthy = false;
  let foreign;
  w.at(6_000, () => { w.remove(chain.server); foreign = foreignNode(w, 3001); });
  const r = await launch(w, { confirmAnswer: true });
  assert.deepEqual([r.code, r.error], [1, 'BACKEND_PORT_FOREIGN']);
  assert.equal(w.confirms.length, 0); assert.equal(w.terminations.length, 0);
  assert.ok(w.procs.has(foreign));
});

// ── 5173 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('5173 foreign or unknown at preflight: refused BEFORE the backend is started, nothing killed', async () => {
  for (const [setup, error] of [
    [w => foreignNode(w, 5173, '::'), 'FRONTEND_PORT_FOREIGN'],
    [w => { const p = w.add({ name: 'node.exe', cmdLine: `node "${REPO}\\node_modules\\vite\\bin\\vite.js" preview` }); w.listen(5173, p, '::'); return p; }, 'FRONTEND_PORT_UNKNOWN_OWNER'],
  ]) {
    const w = createWorld();
    const pid = setup(w);
    const r = await launch(w);
    assert.deepEqual([r.code, r.error], [1, error]);
    assert.deepEqual(w.starts, []);
    assert.ok(w.procs.has(pid));
  }
});

test('healthy Docteur frontend is reused, a hung one is reported (never killed)', async () => {
  const ok = createWorld(); ok.frontendChain();
  assert.equal((await launch(ok)).code, 0);
  assert.ok(!ok.starts.includes('frontend'));
  const hung = createWorld(); const f = hung.frontendChain(); hung.frontendHealthy = false;
  const r = await launch(hung);
  assert.deepEqual([r.code, r.error], [1, 'FRONTEND_UNRESPONSIVE']);
  assert.deepEqual(hung.starts, [], 'checked before the backend is started');
  assert.ok(hung.procs.has(f.vite));
});

// ── Phase C: lifecycle ────────────────────────────────────────────────────────────────────────────────────────────
test('Docteur already open (both healthy): second launch reuses both, starts nothing, opens Chrome', async () => {
  const w = createWorld();
  w.backendChain(); w.frontendChain(); startOllama(w);
  const r = await launch(w);
  assert.equal(r.code, 0);
  assert.deepEqual(w.starts, []);
});

test('another launch in progress: refused immediately, nothing probed or started', async () => {
  const w = createWorld();
  const r = await launch(w, { lockActive: true });
  assert.deepEqual([r.code, r.error], [1, 'LAUNCH_ALREADY_IN_PROGRESS']);
  assert.deepEqual(w.starts, []);
  assert.match(describeFailure(r), /Attendre la fin de l'autre fenêtre « DOCTEUR - LANCEUR »/);
});

test('backend still booting from a previous launch (no listener yet): awaited, not duplicated', async () => {
  const w = createWorld();
  const chain = w.backendChain({ listen: false });
  w.at(40_000, () => w.listen(3001, chain.server));
  const r = await launch(w);
  assert.equal(r.code, 0);
  assert.ok(!w.starts.includes('backend'));
  assert.ok(w.said.some(l => /déjà en train de démarrer/.test(l)));
});

test('frontend still booting from a previous launch: awaited, not duplicated', async () => {
  const w = createWorld();
  const f = w.frontendChain({ listen: false });
  w.at(8_000, () => w.listen(5173, f.vite));
  assert.equal((await launch(w)).code, 0);
  assert.ok(!w.starts.includes('frontend'));
});

test('leftover consoles and a crashed watcher are reported, never closed; a fresh backend is started', async () => {
  const w = createWorld();
  const old = w.backendChain({ listen: false });
  w.remove(old.server); // crashed earlier: watcher waits for file changes, console stays open
  const r = await launch(w);
  assert.equal(r.code, 0);
  assert.ok(w.procs.has(old.console) && w.procs.has(old.watcher));
  assert.ok(w.said.some(l => /ancienne fenêtre « Cortex Server » sans service actif/.test(l)));
  assert.ok(w.said.some(l => /ancien moteur Docteur arrêté reste en attente/.test(l)));
  assert.equal(w.terminations.length, 0);
  assert.ok(w.starts.includes('backend'));
});

test('an old idle watcher does not make a slow-spawning new backend look crashed', async () => {
  const w = createWorld();
  const old = w.backendChain({ listen: false });
  w.remove(old.server);
  const r = await launch(w, { onStart: { backend: startBackend(30_000, {}, 9_000) } }); // npm needs 9 s to spawn node
  assert.equal(r.code, 0, r.error);
  assert.ok(w.procs.has(old.watcher), 'old watcher untouched');
});

test('5173 is judged before a hung backend is offered for replacement (no stop for nothing)', async () => {
  const w = createWorld();
  w.backendChain();
  w.backendHealthy = false;
  foreignNode(w, 5173, '::');
  const r = await launch(w, { confirmAnswer: true });
  assert.deepEqual([r.code, r.error], [1, 'FRONTEND_PORT_FOREIGN']);
  assert.equal(w.confirms.length, 0); assert.equal(w.terminations.length, 0);
});

test('Ollama is optional: used as-is when present, started local-only when absent, never blocking', async () => {
  const listening = createWorld(); startOllama(listening);
  await launch(listening);
  assert.ok(!listening.starts.includes('ollama'));
  const booting = createWorld(); booting.add({ name: 'ollama app.exe' });
  await launch(booting);
  assert.ok(!booting.starts.includes('ollama'));
  for (const [reason, pattern] of [['OLLAMA_NOT_FOUND', /Ollama introuvable/], ['SPAWN_FAILED', /Ollama n'a pas pu être lancé/]]) {
    const w = createWorld();
    const r = await launch(w, { onStart: { ollama: () => ({ ok: false, reason }) } });
    assert.equal(r.code, 0, 'Docteur still starts');
    assert.ok(w.said.some(l => pattern.test(l)));
  }
});

test('preflight refusals: non-Windows, unsafe repository path, unknown own identity', async () => {
  assert.equal((await launch(createWorld(), { platform: 'linux' })).error, 'NOT_WINDOWS');
  assert.equal((await launch(createWorld({ repo: 'C:\\dev\\Doc&teur' }))).error, 'LAUNCH_PATH_UNSUPPORTED');
  assert.equal((await launch(createWorld(), { selfPid: 424242 })).error, 'LAUNCH_LOCK_ERROR');
});

// ── consoles, environment, network ───────────────────────────────────────────────────────────────────────────────
test('service consoles: constant commands, child-scoped quiet/local environment, unsafe paths refused', () => {
  const env = { PATH: 'C:\\x', OLLAMA_HOST: '0.0.0.0:11434' };
  const b = serviceConsole('backend', { repoRoot: REPO, env });
  assert.deepEqual([b.title, b.command, b.env.npm_config_update_notifier], ['Cortex Server', `cd /d "${REPO}\\cortex-server" && npm start`, 'false'], 'daily use: no file watcher');
  assert.equal(serviceConsole('backend', { repoRoot: REPO, env, mode: 'dev' }).command, `cd /d "${REPO}\\cortex-server" && npm run dev`, 'development keeps node --watch');
  const f = serviceConsole('frontend', { repoRoot: REPO, env });
  assert.deepEqual([f.title, f.command, f.env.npm_config_update_notifier], ['Docteur Frontend', `cd /d "${REPO}" && npm run dev`, 'false']);
  const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe';
  const o = serviceConsole('ollama', { repoRoot: REPO, env, ollamaExe: exe });
  assert.deepEqual([o.command, o.env.OLLAMA_NO_CLOUD, o.env.OLLAMA_HOST], [`"${exe}" serve`, '1', '127.0.0.1:11434']);
  assert.equal(b.env.OLLAMA_NO_CLOUD, undefined, 'Ollama settings stay scoped to the Ollama console');
  assert.equal(env.OLLAMA_HOST, '0.0.0.0:11434', 'the caller environment is not mutated');
  for (const bad of ['C:\\a&b\\ollama.exe', 'C:\\a"b\\ollama.exe', 'C:\\%TEMP%\\ollama.exe', 'relative\\ollama.exe', '\\\\server\\share\\ollama.exe']) {
    assert.equal(serviceConsole('ollama', { repoRoot: REPO, env, ollamaExe: bad }), null, bad);
  }
  assert.equal(serviceConsole('backend', { repoRoot: 'C:\\x|y', env }), null);
  assert.equal(isCmdSafePath('C:\\dev\\Docteur'), true);
  assert.equal(findOllamaExe({ PATH: 'C:\\a;C:\\b', LOCALAPPDATA: 'C:\\L' }, p => p === 'C:\\L\\Programs\\Ollama\\ollama.exe'), 'C:\\L\\Programs\\Ollama\\ollama.exe');
  assert.equal(findOllamaExe({ PATH: '' }, () => false), null);
});

test('a frontend answering in 3 s (measured under load) is ready with the launcher timeout, never with the old 2 s one', async () => {
  const page = `<!doctype html><html><head>${DOCTEUR_MARKER}</head></html>`;
  const server = http.createServer((q, r) => setTimeout(() => r.end(page), 3_000));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const target = loopbackTarget(`http://127.0.0.1:${server.address().port}/`);
    assert.equal((await probeFrontend(target, { requestTimeoutMs: 2_000 })).state, 'down');
    assert.equal((await probeFrontend(target, { requestTimeoutMs: FRONTEND_REQUEST_TIMEOUT_MS })).state, 'ready');
    const src = fs.readFileSync(new URL('./docteur-launch.mjs', import.meta.url), 'utf8');
    assert.match(src, /probeFrontend\(frontendTarget, \{ requestTimeoutMs: FRONTEND_REQUEST_TIMEOUT_MS \}\)/);
  } finally { await new Promise(r => server.close(r)); }
});

test('backend ping: only HTTP 200 + {"ok":true} on 127.0.0.1 counts', async () => {
  for (const [status, body, expected] of [[200, '{"ok":true}', 'ready'], [200, '{"ok":false}', 'down'], [200, '<html>Docteur</html>', 'down'], [503, '{"ok":true}', 'down']]) {
    const server = http.createServer((q, r) => { r.statusCode = status; r.end(q.url === '/api/ping' ? body : ''); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try { assert.equal((await pingBackend({ port: server.address().port })).state, expected, `${status} ${body}`); } finally { await new Promise(r => server.close(r)); }
  }
  assert.equal(BACKEND_REQUEST_TIMEOUT_MS, 5_000);
});

test('budgets: backend 120 s mirrors wait-for-cortex and the boot screen; all waits bounded', () => {
  assert.equal(BACKEND_READY_TIMEOUT_MS, 120_000);
  assert.match(fs.readFileSync(new URL('./wait-for-cortex.mjs', import.meta.url), 'utf8'), /Date\.now\(\) - started < 120000/);
  assert.equal(FRONTEND_READY_TIMEOUT_MS, 60_000);
});

test('no new network destination: the launcher only talks to loopback', () => {
  for (const file of ['docteur-launch.mjs', 'launcher-identity.mjs', 'launcher-lock.mjs']) {
    const src = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const hosts = [...src.matchAll(/host:\s*'([^']+)'/g)].map(m => m[1]);
    assert.ok(hosts.every(h => h === '127.0.0.1'), `${file}: ${hosts}`);
    assert.ok(!/https?:\/\/(?!localhost|127\.0\.0\.1)[a-z]/i.test(src.replace(/\/\/.*$/gm, '')), `${file}: no external URL in code`);
    assert.ok(!/\bfetch\(|https\.|net\.connect|dns\./.test(src), `${file}: no other network API`);
  }
});

// ── [STARTUP-3] daily mode (npm start, no watcher) ───────────────────────────────────────────────────────────────
const startDaily = (bootMs = 5_000) => startBackend(bootMs, { mode: 'daily' });

test('daily mode: backend started without watcher, identified, ready; crash without watcher reported as an exit', async () => {
  const w = createWorld();
  const r = await launch(w, { onStart: { backend: startDaily() } });
  assert.equal(r.code, 0);
  assert.ok(w.said.some(l => /Démarrage du moteur Docteur \(fenêtre « Cortex Server », mode quotidien stable\)/.test(l)));
  assert.equal(w.lastBackend.watcher, null);
  const crash = createWorld();
  const r2 = await launch(crash, { onStart: { backend: ww => { startDaily(60_000)(ww); ww.at(8_000, () => ww.remove(ww.lastBackend.server)); } } });
  assert.deepEqual([r2.code, r2.error], [1, 'BACKEND_EXITED']);
  assert.ok(crash.t < 30_000);
});

test('daily mode: a running daily backend is reused as such; a hung one is replaced by stopping only its server', async () => {
  const w = createWorld(); w.backendChain({ mode: 'daily' });
  assert.equal((await launch(w)).code, 0);
  assert.ok(w.said.some(l => /\(PID \d+, mode quotidien stable\) : réutilisé/.test(l)));
  assert.ok(!w.said.some(l => /Pour changer de mode/.test(l)));
  const hung = createWorld(); const c = hung.backendChain({ mode: 'daily' }); hung.backendHealthy = false;
  const r = await launch(hung, { confirmAnswer: ww => { ww.backendHealthy = true; return true; }, onStart: { backend: startDaily() } });
  assert.equal(r.code, 0);
  assert.deepEqual(hung.terminations[0].targets.map(t => [t.pid, t.role]), [[c.server, 'server']], 'no watcher, never the console or npm');
});

test('development mode requested while a daily backend runs: reused, mode difference explained, nothing stopped', async () => {
  const w = createWorld(); const c = w.backendChain({ mode: 'daily' });
  const r = await launch(w, { mode: 'dev' });
  assert.equal(r.code, 0);
  assert.ok(w.procs.has(c.server) && w.terminations.length === 0);
  assert.ok(w.said.some(l => /vous avez demandé le mode développement/.test(l)));
});

// ── [STARTUP-3] browser: bring back an open Docteur window instead of stacking a new one ───────────────────────────
const docteurWindow = { hwnd: '3868522', pid: 17272, kind: 'app', minimized: false };

test('Docteur window already open: brought back, no new window (exit 10 path), nothing closed', async () => {
  const w = createWorld(); w.backendChain(); w.frontendChain(); startOllama(w);
  const r = await launch(w, { browserWindow: docteurWindow });
  assert.deepEqual([r.code, r.browser], [0, 'existing']);
  assert.deepEqual(w.activations, [docteurWindow]);
  assert.ok(w.said.some(l => /remise au premier plan \(aucune nouvelle fenêtre\)/.test(l)));
  assert.deepEqual(w.starts, []);
  const flashed = createWorld(); flashed.backendChain(); flashed.frontendChain();
  const r2 = await launch(flashed, { browserWindow: docteurWindow, activation: 'flashed' });
  assert.equal(r2.browser, 'existing');
  assert.ok(flashed.said.some(l => /clignote dans la barre des tâches/.test(l)));
});

test('no Docteur window, detection failure, or window gone/changed before activation: a new window is opened as before', async () => {
  for (const [opts, activations] of [[{ browserWindow: null }, 0], [{ browserWindow: 'fail' }, 0], [{ browserWindow: docteurWindow, activation: 'gone' }, 1], [{ browserWindow: docteurWindow, activation: 'changed' }, 1], [{ browserWindow: docteurWindow, activation: 'failed' }, 1]]) {
    const w = createWorld(); w.backendChain(); w.frontendChain();
    const r = await launch(w, opts);
    assert.deepEqual([r.code, r.browser], [0, 'open'], JSON.stringify(opts));
    assert.equal(w.activations.length, activations);
    assert.match(w.said.at(-1), /Docteur est prêt\. Ouverture du navigateur/);
  }
});

test('browser lookup happens only once both services are verified ready: never on a failed launch', async () => {
  const w = createWorld(); foreignNode(w, 3001);
  const r = await launch(w, { browserWindow: docteurWindow });
  assert.equal(r.code, 1);
  assert.equal(w.windowLookups, 0); assert.equal(w.activations.length, 0);
});

// ── the .bat contract ────────────────────────────────────────────────────────────────────────────────────────────
test('Docteur-Launcher.bat: option 1 = one gated launch; no taskkill anywhere; failures keep the diagnostic on screen', () => {
  const bat = fs.readFileSync(new URL('../Docteur-Launcher.bat', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const pc = bat.slice(bat.indexOf(':MODE_PC'), bat.indexOf(':MODE_RESEAU'));
  assert.match(pc, /node scripts\/docteur-launch\.mjs %LAUNCH_ARGS%\nif errorlevel 10 goto BROWSER_ALREADY_OPEN\nif errorlevel 1 goto STARTUP_STOPPED\n\necho Ouverture de Chrome\.\.\./);
  assert.ok(pc.indexOf('node scripts/docteur-launch.mjs') < pc.indexOf('start chrome --app=http://localhost:5173'));
  // [STARTUP-3] [1] daily (no args) / [5] development (--dev); exit 10 = existing window shown, nothing opened or closed
  const menu = bat.slice(bat.indexOf(':MENU'), bat.indexOf(':MODE_PC'));
  assert.match(menu, /set "LAUNCH_ARGS="\n[^\n]*\nif "%CHOICE%"=="1" goto MODE_PC\nif "%CHOICE%"=="5" \(\n\s+set "LAUNCH_ARGS=--dev"/);
  const already = bat.slice(bat.indexOf(':BROWSER_ALREADY_OPEN'), bat.indexOf(':MODE_RESEAU'));
  assert.ok(already.includes('exit /b 0') && !/^\s*(start|taskkill|cls)/m.test(already), 'existing-window path opens and closes nothing');
  assert.ok(!/goto MENU/.test(pc), 'no path back to the menu (its cls would erase the error)');
  assert.ok(!/start "Cortex Server"|start "Docteur Frontend"|ollama serve|timeout \/t \d+[^\n]*\n[^\n]*\n?echo Ouverture de Chrome/.test(pc), 'services are started only by the gated launcher');
  assert.ok(!/taskkill|Stop-Process|wmic/i.test(bat), 'the launcher never terminates processes itself');
  assert.ok(!/:FREE_PORTS|:FREE_FRONTEND_PORT/.test(bat));
  const stopped = bat.slice(bat.indexOf(':STARTUP_STOPPED'), bat.indexOf(':QUITTER'));
  assert.ok(stopped.includes('pause') && stopped.includes('exit /b 1') && !/^(cls|start |goto MENU)/m.test(stopped), 'stop path: no cls, no Chrome');
  for (const label of ['MODE_RESEAU', 'MODE_MOBILE']) assert.match(bat, new RegExp(`:${label}\\nREM [^\\n]*\\ngoto LAN_REFUSED\\n`), `${label} still refused`);
  assert.match(bat, /LAN_API_DISABLED_PENDING_AUTHENTICATION/);
});
