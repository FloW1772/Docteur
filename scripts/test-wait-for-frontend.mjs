// [STARTUP-1] Frontend readiness gate + launcher contract. Real loopback HTTP servers on ephemeral ports; the
// production port 5173 and the real backend are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DOCTEUR_MARKER, loopbackTarget, probeFrontend, waitForFrontend, describe } from './wait-for-frontend.mjs';

const DOCTEUR_PAGE = `<!doctype html><html><head>${DOCTEUR_MARKER}</head><body><div id="root"></div></body></html>`;
const serve = (handler, host = '127.0.0.1') => new Promise(resolve => {
  const server = http.createServer(handler);
  server.listen(0, host, () => resolve({ server, port: server.address().port }));
});
const close = server => new Promise(resolve => server.close(resolve));
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
// async: the CLI must reach servers living in this same test process
const cli = (args, timeout = 20000) => new Promise(resolve => {
  const child = spawn(process.execPath, ['scripts/wait-for-frontend.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const timer = setTimeout(() => child.kill(), timeout);
  child.on('exit', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});

test('loopback only: localhost / 127.0.0.1 / [::1] over http; everything else is refused before any request', async () => {
  assert.deepEqual(loopbackTarget('http://localhost:5173/').addresses, ['::1', '127.0.0.1']);
  assert.deepEqual(loopbackTarget('http://127.0.0.1:5173/').addresses, ['127.0.0.1']);
  assert.deepEqual(loopbackTarget('http://[::1]:5173/x?y=1'), { addresses: ['::1'], port: 5173, path: '/x?y=1' });
  for (const url of ['https://localhost:5173/', 'http://192.168.1.20:5173/', 'http://0.0.0.0:5173/', 'http://example.com/', 'http://localhost.example.com:5173/', 'http://user:pw@localhost:5173/', 'file:///C:/x', 'not a url']) {
    assert.equal(loopbackTarget(url), null, url);
    let probes = 0;
    const r = await waitForFrontend({ url, probe: async () => { probes++; return { state: 'ready' }; } });
    assert.equal(r.code, 3, url); assert.equal(probes, 0, `${url}: no request`);
  }
  const out = await cli(['--url', 'http://192.168.1.20:5173/']);
  assert.equal(out.status, 3); assert.match(out.stderr, /FRONTEND_PROBE_NOT_LOOPBACK/);
});

test('ready only on a real HTTP 200 carrying the Docteur page; localhost falls back from ::1 to 127.0.0.1', async () => {
  const { server, port } = await serve((req, res) => { res.setHeader('content-type', 'text/html'); res.end(DOCTEUR_PAGE); });
  try {
    const r = await probeFrontend(loopbackTarget(`http://localhost:${port}/`));
    assert.equal(r.state, 'ready'); assert.equal(r.address, '127.0.0.1');
    const ok = await cli(['--url', `http://localhost:${port}/`, '--timeout-ms', '5000']);
    assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /\[startup\] Frontend prêt après \d+ ms/);
  } finally { await close(server); }
});

test('connection refused is retried, then succeeds when the frontend starts listening late', async () => {
  const port = await freePort();
  let server;
  const late = setTimeout(async () => { ({ server } = await new Promise(resolve => { const s = http.createServer((q, r) => r.end(DOCTEUR_PAGE)); s.listen(port, '127.0.0.1', () => resolve({ server: s })); })); }, 1200);
  try {
    const r = await waitForFrontend({ url: `http://127.0.0.1:${port}/`, timeoutMs: 10000, intervalMs: 200 });
    assert.equal(r.code, 0); assert.ok(r.attempts > 2, `retried (${r.attempts} attempts)`); assert.ok(r.elapsedMs >= 1000);
  } finally { clearTimeout(late); if (server) await close(server); }
});

test('nothing listening: deterministic timeout, exit 1, French diagnostic naming the Docteur Frontend window', async () => {
  const port = await freePort();
  const started = Date.now();
  const out = await cli(['--url', `http://127.0.0.1:${port}/`, '--timeout-ms', '2000', '--interval-ms', '500']);
  const took = Date.now() - started;
  assert.equal(out.status, 1);
  assert.match(out.stderr, /FRONTEND_NOT_READY : le frontend Docteur ne répond pas .* après 2 s \(dernier état : connexion refusée\)/);
  assert.match(out.stderr, /Chrome n'a pas été ouvert\. Consulter la fenêtre "Docteur Frontend"/);
  assert.ok(took >= 1400 && took < 8000, `bounded (${took} ms)`);
  // pure loop: exact attempt count and bound with an injected clock
  let t = 0;
  const r = await waitForFrontend({ url: 'http://localhost:5173/', timeoutMs: 60000, intervalMs: 500, now: () => t, sleep: async ms => { t += ms; }, probe: async () => ({ state: 'down', detail: 'ECONNREFUSED' }) });
  assert.equal(r.code, 1); assert.equal(r.outcome, 'timeout'); assert.equal(r.attempts, 121, 'probes at t = 0, 0.5 s … 60 s'); assert.ok(r.elapsedMs <= 60000);
});

test('another service on the port (wrong app, HTTP error, Docteur page with error status): never ready, exit 2 after a short grace', async () => {
  for (const handler of [
    (q, r) => r.end('<html><title>Some other app</title></html>'),
    (q, r) => { r.statusCode = 500; r.end('boom'); },
    (q, r) => { r.statusCode = 404; r.end(DOCTEUR_PAGE); },
  ]) {
    const { server, port } = await serve(handler);
    try {
      const r = await waitForFrontend({ url: `http://localhost:${port}/`, timeoutMs: 20000, intervalMs: 200, foreignGraceMs: 1000 });
      assert.equal(r.code, 2); assert.equal(r.outcome, 'foreign'); assert.ok(r.elapsedMs < 5000, 'fails fast, not at the timeout');
      assert.match(describe(r, 'http://localhost:5173/', 20000), /FRONTEND_PORT_BUSY : un autre service répond \(HTTP \d+\) .*ce n'est pas Docteur/);
      const id = await cli(['--identify', '--url', `http://localhost:${port}/`]);
      assert.equal(id.status, 2); assert.match(id.stderr, /FRONTEND_PORT_BUSY .*Rien n'a été arrêté/);
    } finally { await close(server); }
  }
});

test('a listener that never answers HTTP counts as down (per-request timeout), and --identify reports unknown ownership', async () => {
  const sockets = [];
  const silent = net.createServer(s => sockets.push(s));
  await new Promise(r => silent.listen(0, '127.0.0.1', r));
  const port = silent.address().port;
  try {
    const r = await probeFrontend(loopbackTarget(`http://127.0.0.1:${port}/`), { requestTimeoutMs: 300 });
    assert.deepEqual(r, { state: 'down', detail: 'TIMEOUT' });
    const id = await cli(['--identify', '--url', `http://127.0.0.1:${port}/`]);
    assert.equal(id.status, 1); assert.match(id.stderr, /FRONTEND_PORT_UNKNOWN/);
  } finally { sockets.forEach(s => s.destroy()); await new Promise(r => silent.close(r)); }
});

test('frontend process dies after starting: readiness is not latched from an earlier probe', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end(${JSON.stringify(DOCTEUR_PAGE)})).listen(${port},'127.0.0.1',()=>console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(r => child.stdout.once('data', r));
  assert.equal((await probeFrontend(loopbackTarget(`http://127.0.0.1:${port}/`))).state, 'ready');
  child.kill(); await new Promise(r => child.once('exit', r));
  const r = await waitForFrontend({ url: `http://127.0.0.1:${port}/`, timeoutMs: 1500, intervalMs: 250 });
  assert.equal(r.code, 1); assert.equal(r.last.detail, 'ECONNREFUSED');
});

test('launcher: option 1 opens Chrome only after the HTTP gate, stops on failure; LAN options stay refused', () => {
  const bat = fs.readFileSync('Docteur-Launcher.bat', 'utf8').replace(/\r\n/g, '\n');
  const pc = bat.slice(bat.indexOf(':MODE_PC'), bat.indexOf(':MODE_RESEAU'));
  const frontend = pc.indexOf('start "Docteur Frontend" cmd /k "cd /d C:\\dev\\Docteur && npm run dev"');
  const gate = pc.indexOf('node scripts/wait-for-frontend.mjs\nif errorlevel 1 goto STARTUP_STOPPED');
  const chrome = pc.indexOf('start chrome --app=http://localhost:5173');
  assert.ok(frontend > 0 && gate > frontend && chrome > gate, 'frontend start < HTTP gate < Chrome');
  assert.ok(!/timeout \/t \d+[^\n]*\n[^\n]*\n?echo Ouverture de Chrome/.test(pc), 'no blind delay before Chrome');
  assert.ok(!pc.includes('dev:local'), 'mode PC never uses the LAN dev server');
  assert.ok(pc.indexOf('node scripts/wait-for-cortex.mjs') < frontend, 'backend readiness still precedes the frontend');
  assert.match(pc, /call :FREE_PORTS\nif errorlevel 1 goto STARTUP_STOPPED/);
  const stopped = bat.slice(bat.indexOf(':STARTUP_STOPPED'), bat.indexOf(':QUITTER'));
  assert.ok(stopped.includes('pause') && stopped.includes('exit /b 1') && !/start |taskkill/.test(stopped), 'stop path: no Chrome, nothing killed');
  for (const label of ['MODE_RESEAU', 'MODE_MOBILE']) assert.match(bat, new RegExp(`:${label}\\nREM [^\\n]*\\ngoto LAN_REFUSED\\n`), label);
  const free = bat.slice(bat.indexOf(':FREE_FRONTEND_PORT'));
  assert.ok(free.indexOf('node scripts/wait-for-frontend.mjs --identify') < free.indexOf('taskkill /PID %~1'), '5173 is killed only after identification');
  assert.match(free, /if errorlevel 1 \(\n\s+set "PORT_BUSY=1"/);
});
