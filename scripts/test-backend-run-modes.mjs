// [STARTUP-3] Backend run modes with real processes: a throw-away fake repository in %TEMP%, ephemeral ports, hidden consoles
// running the genuine `npm start` / `npm run dev` chains. The real backend, its src/ files and ports 3001 / 5173 are never used.
//   daily  (`npm start`, launcher option 1): reading / stat-ing / even editing src/ never restarts the server
//   dev    (`npm run dev`, launcher option 5): a real code change restarts it (explicit development behaviour)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { takeSnapshot, classifyPort, backendTerminationTargets, STATES } from './launcher-identity.mjs';

const windows = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const killTree = pid => { try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
const SERVER_JS = "require('http').createServer((q, r) => r.end('{\"ok\":true}')).listen(Number(process.env.FAKE_PORT), '127.0.0.1');\n";
const consoles = [];
let fake;

test.before(() => {
  if (!windows) return;
  fake = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-run-modes-'));
  fs.mkdirSync(path.join(fake, 'cortex-server', 'src'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'cortex-server', 'package.json'), JSON.stringify({ name: 'fake-cortex', private: true, scripts: {
    start: 'node src/server.js', dev: 'node --watch-path=src --watch-preserve-output src/server.js' } }));
});
test.after(async () => { for (const pid of consoles) killTree(pid); await sleep(500); if (fake) fs.rmSync(fake, { recursive: true, force: true }); });

/** Writes the fake sources with a last-access time 3 h in the past (NTFS refreshes it on the next read), mtime unchanged. */
function freshSources(name) {
  const src = path.join(fake, 'cortex-server', 'src');
  fs.writeFileSync(path.join(src, 'server.js'), SERVER_JS);
  fs.writeFileSync(path.join(src, `${name}-helper.js`), 'module.exports = 1;\n');
  const old = new Date(Date.now() - 3 * 3600_000);
  for (const f of fs.readdirSync(src)) fs.utimesSync(path.join(src, f), old, fs.statSync(path.join(src, f)).mtime);
  return path.join(src, `${name}-helper.js`);
}

function startChain(script, port) {
  const comspec = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const child = spawn(comspec, ['/d', '/s', '/k', `"cd /d "${path.join(fake, 'cortex-server')}" && npm ${script}"`],
    { windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, FAKE_PORT: String(port), npm_config_update_notifier: 'false' } });
  consoles.push(child.pid);
  return child;
}
async function serverPid(port) {
  for (let i = 0; i < 40; i++) {
    const snap = await takeSnapshot({ ports: [port] });
    const c = classifyPort(snap, port, 'backend', fake);
    if (c.state === STATES.BACKEND) return { pid: c.pid, created: c.created, targets: backendTerminationTargets(snap, c, fake) };
    await sleep(500);
  }
  assert.fail('fake backend never became a confirmed Docteur backend');
}

test('daily mode (npm start): confirmed identity without watcher; reads, metadata access and edits never restart it', { skip: !windows }, async () => {
  const port = await freePort();
  const helper = freshSources('daily');
  startChain('start', port);
  const first = await serverPid(port);
  assert.deepEqual(first.targets.map(t => t.role), ['server'], 'no watcher in daily mode');
  await sleep(1500);
  fs.readFileSync(helper, 'utf8'); // read (last-access refresh)
  fs.statSync(helper); fs.readdirSync(path.dirname(helper)); // metadata only
  await sleep(3000);
  assert.deepEqual(await serverPid(port), first, 'same process after reads');
  fs.appendFileSync(helper, '// edited\n'); // even a real change: daily mode is stable by design (relaunch to apply code)
  await sleep(3000);
  assert.deepEqual(await serverPid(port), first, 'same process after an edit');
});

test('development mode (npm run dev): a real code change restarts the server (kept); read behaviour recorded', { skip: !windows }, async t => {
  const port = await freePort();
  const helper = freshSources('dev');
  startChain('run dev', port);
  await sleep(4000); // node's own first load of stale files may already cause a restart on this machine: let it settle
  const first = await serverPid(port);
  assert.deepEqual(first.targets.map(x => x.role), ['watcher', 'server']);
  fs.readFileSync(helper, 'utf8');
  await sleep(3000);
  const afterRead = await serverPid(port);
  t.diagnostic(`dev mode, plain read of a src/ file with a stale last-access time: ${afterRead.pid === first.pid ? 'no restart' : 'RESTARTED (NTFS last-access update seen by node --watch)'}`);
  fs.appendFileSync(helper, '// edited\n');
  let restarted = null;
  for (let i = 0; i < 20 && !restarted; i++) { await sleep(500); const now = await serverPid(port); if (now.pid !== afterRead.pid) restarted = now; }
  assert.ok(restarted, 'a real code change restarts the development server');
  assert.equal(restarted.targets[0].pid, first.targets[0].pid, 'same watcher, new server');
});
