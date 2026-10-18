// SEC-REMED-1 / SEC-3 — the Docteur API has no LAN authentication, so it must never listen beyond loopback.
//
// Root cause (SEC-CERT-1): LOCAL_NETWORK=true bound the API on 0.0.0.0 while the central guard (built against web pages)
// admits any client without an Origin header → every LAN device reached the whole private API (memories, notebooks,
// backups, Companion, and /api/browser/open — the SEC-1 chain). Decision B (fail closed): the server refuses to start
// with LAN_API_DISABLED_PENDING_AUTHENTICATION (future LAN-AUTH-1); the LAN launchers refuse before starting anything.
//
// The real-boot checks start src/server.js only with a configuration that must be refused, with temporary DB / log /
// vector paths as a precaution, and verify that it exits before listening and that the real user DB is byte-identical.
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiBindHost, isLoopbackHost, LAN_API_DISABLED } from './src/lib/lan-exposure-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const refused = (e) => e?.code === LAN_API_DISABLED && e.message.startsWith(LAN_API_DISABLED);

test('policy: default and loopback hosts allowed; LOCAL_NETWORK=true and every non-loopback HOST refused with LAN_API_DISABLED_PENDING_AUTHENTICATION', () => {
  assert.equal(resolveApiBindHost({}), '127.0.0.1', 'default stays loopback');
  assert.equal(resolveApiBindHost({ host: '' }), '127.0.0.1');
  for (const h of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST', '127.0.0.2', '::ffff:127.0.0.1']) assert.equal(resolveApiBindHost({ host: h }), h, h);
  assert.throws(() => resolveApiBindHost({ localNetwork: true }), refused, 'LOCAL_NETWORK=true');
  assert.throws(() => resolveApiBindHost({ localNetwork: true, host: '127.0.0.1' }), refused, 'LOCAL_NETWORK wins over a loopback HOST');
  for (const h of ['0.0.0.0', '::', '[::]', '192.168.1.20', '10.0.0.5', '172.16.0.1', '169.254.1.1', 'fe80::1', 'my-pc.local', 'example.com', '127.0.0.1.nip.io', '127.0.0.256', '0']) {
    assert.throws(() => resolveApiBindHost({ host: h }), refused, h);
  }
  assert.equal(isLoopbackHost('127.1.2.3'), true); assert.equal(isLoopbackHost('128.0.0.1'), false);
});

test('static: server.js resolves the bind host BEFORE the logger, the stores and the listener; the listener uses only that host; no 0.0.0.0 bind remains', () => {
  const src = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  const at = (re) => { const m = re.exec(src); assert.ok(m, String(re)); return m.index; };
  const check = at(/const API_BIND_HOST = resolveApiBindHost\(\{ localNetwork: LOCAL_NETWORK, host: process\.env\.HOST \}\);/);
  for (const later of [/const logger = createLogger\(/, /\ninitSqlite\(env\.SQLITE_PATH\)/, /const httpServer = serve\(\{/, /\napp\.use\('\*', cors\(/]) assert.ok(check < at(later), `check precedes ${later}`);
  assert.match(src, /HOST: API_BIND_HOST,/);
  assert.match(src, /hostname: env\.HOST,/);
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, ''), /['"]0\.0\.0\.0['"]/, 'no wildcard bind left in code');
});

const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

test('real boot: src/server.js with LOCAL_NETWORK=true, HOST=0.0.0.0 or HOST=:: exits with the refusal before listening; real user DB untouched', async () => {
  const before = REAL_DB.map(fileHash);
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sec3-boot-'));
  const PORT = 39_871;
  try {
    for (const extra of [{ LOCAL_NETWORK: 'true' }, { HOST: '0.0.0.0' }, { HOST: '::' }, { HOST: '192.168.1.20' }]) {
      const env = { ...process.env, ...extra, PORT: String(PORT), SQLITE_PATH: path.join(TMP, 'x.sqlite'), LANCEDB_PATH: path.join(TMP, 'x.lance'), LOG_FILE: path.join(TMP, 'x.log') };
      delete env.DOCTEUR_TEST_MODE;
      if (!extra.LOCAL_NETWORK) delete env.LOCAL_NETWORK;
      const r = spawnSync(process.execPath, [path.join(HERE, 'src', 'server.js')], { cwd: HERE, env, encoding: 'utf8', timeout: 90_000 });
      assert.notEqual(r.status, 0, `${JSON.stringify(extra)} must not keep running`);
      assert.match(`${r.stderr}${r.stdout}`, /LAN_API_DISABLED_PENDING_AUTHENTICATION/, JSON.stringify(extra));
      assert.doesNotMatch(`${r.stderr}${r.stdout}`, /cortex server started/, 'never reached the listener');
      assert.equal(await portFree(PORT), true, 'nothing listens');
      assert.equal(fs.existsSync(path.join(TMP, 'x.sqlite')), false, 'no store was opened');
    }
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  assert.deepEqual(REAL_DB.map(fileHash), before, 'real user DB byte-identical');
});

test('launchers: start-local.bat, start-mobile.bat and Docteur-Launcher options 2/3 refuse BEFORE any start command', () => {
  const root = path.join(HERE, '..');
  for (const f of ['start-local.bat', 'start-mobile.bat']) {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/);
    const refuse = lines.findIndex(l => /^exit \/b 1\s*$/.test(l));
    const firstLaunch = lines.findIndex(l => /^\s*(start |call npm|npm |node )/i.test(l));
    assert.ok(refuse > 0 && lines.slice(0, refuse).some(l => /LAN_API_DISABLED_PENDING_AUTHENTICATION/.test(l)), `${f}: refusal message`);
    assert.ok(refuse < firstLaunch, `${f}: refuses before launching anything`);
  }
  const launcher = fs.readFileSync(path.join(root, 'Docteur-Launcher.bat'), 'utf8');
  for (const label of ['MODE_RESEAU', 'MODE_MOBILE']) assert.match(launcher, new RegExp(`:${label}\\r?\\nREM [^\\n]*\\r?\\ngoto LAN_REFUSED\\r?\\n`), label);
  assert.match(launcher, /:LAN_REFUSED[\s\S]*LAN_API_DISABLED_PENDING_AUTHENTICATION[\s\S]*goto MENU/);
});
