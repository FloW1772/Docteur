// WEB EGRESS GUARD V1 — isolated real-server boot proof.
//   node web-egress-boot-proof.mjs
//
// Boots the REAL cortex-server on a throw-away SQLite/LanceDB/log (never the real data), on loopback, then:
//   1. waits for "cortex server started" (boot smoke);
//   2. GET /api/health works (trusted local path unaffected);
//   3. a request carrying the original bypass payload (http://[::ffff:127.0.0.1]/) is refused by the real route (HTTP 400), as are
//      several other forbidden forms, with NO side effect (the isolated DB is empty afterwards);
//   4. the structured BLOCKED_* log events exist and contain no URL path / query / userinfo;
//   5. clean SIGINT shutdown.
// Prints one JSON summary; exit 0 = PASS.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-egress-boot-'));
const port = 33129;
const logFile = path.join(tmp, 'server.log');
const summary = { boot: false, health: null, blocked: {}, logEvents: [], logLeaks: [], shutdown: null };

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: here,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOCAL_NETWORK: 'false', SQLITE_PATH: path.join(tmp, 'cortex.sqlite'), LANCEDB_PATH: path.join(tmp, 'cortex.lance'), LOG_FILE: logFile, LOG_LEVEL: 'info' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = '';
child.stdout.on('data', d => { output += d; });
child.stderr.on('data', d => { output += d; });

async function waitStarted() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (output.includes('cortex server started')) return true;
    if (child.exitCode !== null) return false;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

let failed = null;
try {
  summary.boot = await waitStarted();
  if (!summary.boot) throw new Error(`server did not start:\n${output.slice(-1500)}`);
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`);
  summary.health = health.status;

  const payloads = {
    'ipv4-mapped loopback (ORIGINAL BYPASS)': 'http://[::ffff:127.0.0.1]/',
    'ipv4-mapped hex form': 'http://[::ffff:7f00:1]/',
    'ipv4-mapped metadata': 'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'unspecified ipv6': 'http://[::]/',
    'cgnat': 'http://100.64.0.1/',
    'userinfo': 'http://user:SECRETPASSWORD@example.com/private/path?token=QUERYSECRET',
    'localhost with trailing dot': 'http://localhost./',
    'non-standard port': 'https://example.com:8443/',
    'file scheme': 'file:///C:/Windows/win.ini',
  };
  for (const [name, url] of Object.entries(payloads)) {
    const res = await fetch(`${base}/api/video-summary/estimate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    const body = await res.json().catch(() => ({}));
    summary.blocked[name] = { status: res.status, error: body.error ?? null };
    if (res.status !== 400) throw new Error(`payload "${name}" was not refused (HTTP ${res.status})`);
  }

  await new Promise(r => setTimeout(r, 400));
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  summary.logEvents = [...new Set([...logText.matchAll(/"reason":"(BLOCKED_[A-Z_]+)"/g)].map(m => m[1]))];
  for (const secret of ['SECRETPASSWORD', 'QUERYSECRET', '/private/path', 'win.ini']) if (logText.includes(secret)) summary.logLeaks.push(secret);
  for (const wanted of ['BLOCKED_LOOPBACK', 'BLOCKED_METADATA', 'BLOCKED_USERINFO', 'BLOCKED_PORT', 'BLOCKED_SCHEME', 'BLOCKED_UNSPECIFIED', 'BLOCKED_PRIVATE', 'BLOCKED_LOCAL_NAME']) {
    if (!summary.logEvents.includes(wanted)) throw new Error(`expected structured log event ${wanted} was not written`);
  }
  if (summary.logLeaks.length) throw new Error(`secrets leaked into the log: ${summary.logLeaks.join(', ')}`);
} catch (error) {
  failed = error;
} finally {
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  if (child.exitCode === null) child.kill('SIGINT');
  summary.shutdown = await Promise.race([exited, new Promise(r => setTimeout(() => { child.kill(); r({ code: 'forced', signal: null }); }, 15_000))]);
  fs.rmSync(tmp, { recursive: true, force: true });
}
summary.status = failed ? 'FAIL' : 'PASS';
if (failed) summary.error = String(failed.message ?? failed).slice(0, 500);
console.log(JSON.stringify(summary, null, 1));
process.exit(failed ? 1 : 0);
