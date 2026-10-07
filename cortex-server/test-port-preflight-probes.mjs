// Fail-closed probe tests for port-preflight.js. Regression guard for the
// sandbox-account failure where Get-NetTCPConnection returned Access Denied,
// the old script swallowed it (SilentlyContinue) and the port was reported
// "free" while it was actually held.
//
// Unit part: probes injected (PowerShell / netstat runners), no real process.
// Integration part (Windows only): a real listener on a scratch port, the REAL
// pre-existing PowerShell runner with Get-NetTCPConnection shadowed by a
// PermissionDenied error (the exact sandbox symptom), and the REAL netstat.exe.
// Run with: node --test test-port-preflight-probes.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { isWindows, runReadOnlyPowerShell } from './src/lib/maitre-windows-exec.js';
import {
  checkPortOwnership, parseNetstatListeners, runNetstatListing, isValidPort,
} from './src/lib/port-preflight.js';

const SCRATCH_PORT = 31742; // distinct from test-port-preflight.mjs's 31741

const NETSTAT_FR = `
Connexions actives

  Proto  Adresse locale         Adresse distante       \u00c9tat
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1936
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:31742        0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:50000        127.0.0.1:31742        ESTABLISHED     777
  TCP    [::]:135               [::]:0                 LISTENING       1936
  TCP    [::1]:31743            [::]:0                 LISTENING       5151
  UDP    0.0.0.0:5353           *:*                                    2020
`;

const psJson = (obj) => async () => ({ ok: true, stdout: `${JSON.stringify(obj)}\r\n`, stderr: '' });
const PS_ACCESS_DENIED = psJson({ probeFailed: true, category: 'PermissionDenied' });
const PS_MISSING = async () => ({ ok: false, reason: 'exec_failed', detail: 'spawn powershell.exe ENOENT' });
const netstatOk = (stdout) => async () => ({ ok: true, stdout });
const NETSTAT_FAILED = async () => ({ ok: false, reason: 'exec_failed', detail: 'Access is denied.' });

// Routes the owner script vs. the PID identity script to different fakes.
function psRouter({ owner, identity }) {
  const calls = [];
  const fn = async (script, opts) => {
    calls.push(script);
    if (script.includes('Get-NetTCPConnection')) return owner(script, opts);
    return identity ? identity(script, opts) : { ok: false, reason: 'exec_failed', detail: 'no identity fake' };
  };
  fn.calls = calls;
  return fn;
}

const W = { windows: true };

// ── Primary probe conclusive (existing behavior preserved) ──────────────
test('free port: primary probe sees no listener → free', async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, { ...W, runPowerShell: psJson({ listening: false }), runNetstat: NETSTAT_FAILED });
  assert.deepEqual(r, { state: 'free' });
});

test('Docteur-owned port: node src/server.js → owned_by_cortex (unchanged)', async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, {
    ...W, runPowerShell: psJson({ listening: true, pid: 1234, name: 'node.exe', cmdLine: '"C:\\Program Files\\nodejs\\node.exe" src/server.js' }),
  });
  assert.equal(r.state, 'owned_by_cortex');
  assert.equal(r.pid, 1234);
});

test('unrelated occupied port → owned_by_unknown with pid (unchanged)', async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, {
    ...W, runPowerShell: psJson({ listening: true, pid: 999, name: 'python.exe', cmdLine: 'python -m http.server' }),
  });
  assert.equal(r.state, 'owned_by_unknown');
  assert.equal(r.pid, 999);
  assert.equal(r.name, 'python.exe');
});

test('listener whose process can\'t be read → owned_by_unknown (unchanged)', async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, { ...W, runPowerShell: psJson({ listening: true, pid: 77, unknown: true }) });
  assert.equal(r.state, 'owned_by_unknown');
  assert.equal(r.pid, 77);
});

// ── PowerShell Access Denied → secondary probe ──────────────────────────
test('PowerShell Access Denied + netstat shows listener → owned_by_unknown, never free', async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, {
    ...W,
    runPowerShell: psRouter({ owner: PS_ACCESS_DENIED, identity: psJson({ found: true, pid: 4242, name: 'python.exe', cmdLine: 'python -m http.server 31742' }) }),
    runNetstat: netstatOk(NETSTAT_FR),
  });
  assert.equal(r.state, 'owned_by_unknown');
  assert.equal(r.pid, 4242);
  assert.equal(r.name, 'python.exe');
});

test('PowerShell Access Denied + netstat shows listener owned by cortex → owned_by_cortex', async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, {
    ...W,
    runPowerShell: psRouter({ owner: PS_ACCESS_DENIED, identity: psJson({ found: true, pid: 4242, name: 'node.exe', cmdLine: 'node src/server.js' }) }),
    runNetstat: netstatOk(NETSTAT_FR),
  });
  assert.equal(r.state, 'owned_by_cortex');
  assert.equal(r.pid, 4242);
});

test('PowerShell Access Denied everywhere + netstat shows listener → owned_by_unknown with netstat pid', async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, {
    ...W, runPowerShell: psRouter({ owner: PS_ACCESS_DENIED, identity: PS_MISSING }), runNetstat: netstatOk(NETSTAT_FR),
  });
  assert.deepEqual(r, { state: 'owned_by_unknown', pid: 4242, name: null, cmdLine: null });
});

test('PowerShell Access Denied + netstat proves port not listening → free', async () => {
  const r = await checkPortOwnership('127.0.0.1', 31799, { ...W, runPowerShell: PS_ACCESS_DENIED, runNetstat: netstatOk(NETSTAT_FR) });
  assert.deepEqual(r, { state: 'free' });
});

test('PowerShell unavailable (ENOENT / throws / timeout) → secondary probe decides', async () => {
  for (const runPowerShell of [PS_MISSING, async () => { throw new Error('boom'); }, async () => ({ ok: false, reason: 'timeout' })]) {
    const occupied = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, { ...W, runPowerShell, runNetstat: netstatOk(NETSTAT_FR) });
    assert.equal(occupied.state, 'owned_by_unknown');
    assert.equal(occupied.pid, 4242);
    const free = await checkPortOwnership('127.0.0.1', 31799, { ...W, runPowerShell, runNetstat: netstatOk(NETSTAT_FR) });
    assert.equal(free.state, 'free');
  }
});

test('PowerShell exits OK but output is empty/garbled/unexpected → never free on its own', async () => {
  for (const stdout of ['', 'Accès refusé', '{"something":1}', 'null']) {
    const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, {
      ...W, runPowerShell: async () => ({ ok: true, stdout }), runNetstat: NETSTAT_FAILED,
    });
    assert.equal(r.state, 'undetermined', `stdout=${JSON.stringify(stdout)}`);
  }
});

test('empty listener table from PowerShell is a probe failure, not free', async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, {
    ...W, runPowerShell: psJson({ probeFailed: true, category: 'EmptyListenerTable' }), runNetstat: NETSTAT_FAILED,
  });
  assert.equal(r.state, 'undetermined');
});

// ── All probes fail → fail-closed ───────────────────────────────────────
test('all probes fail → undetermined with reasons, never free', async () => {
  const cases = [
    [PS_ACCESS_DENIED, NETSTAT_FAILED],
    [PS_MISSING, NETSTAT_FAILED],
    [PS_MISSING, async () => { throw new Error('spawn netstat ENOENT'); }],
    [PS_ACCESS_DENIED, netstatOk('')],
    [PS_ACCESS_DENIED, netstatOk('Connexions actives\r\n\r\n  Proto  Adresse locale\r\n')],
    [PS_ACCESS_DENIED, async () => ({ ok: false, reason: 'timeout' })],
  ];
  for (const [runPowerShell, runNetstat] of cases) {
    const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, { ...W, runPowerShell, runNetstat });
    assert.equal(r.state, 'undetermined');
    assert.equal(r.reason, 'all_probes_failed');
    assert.equal(r.probes.length, 2);
  }
});

test('non-IP host can\'t be matched in netstat → undetermined, not free', async () => {
  const r = await checkPortOwnership('localhost', SCRATCH_PORT, { ...W, runPowerShell: PS_ACCESS_DENIED, runNetstat: netstatOk(NETSTAT_FR) });
  assert.equal(r.state, 'undetermined');
  assert.ok(r.probes.includes('netstat_host_not_ip'));
});

test('non-Windows stays undetermined (unchanged)', async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, { windows: false, runPowerShell: () => assert.fail('must not run'), runNetstat: () => assert.fail('must not run') });
  assert.equal(r.state, 'undetermined');
});

// ── Exact-address semantics (kiwix wide-bind check relies on them) ──────
test('netstat match is exact on address: 127.0.0.1 listener does not count for 0.0.0.0, IPv6 parsed', async () => {
  const wide = await checkPortOwnership('0.0.0.0', SCRATCH_PORT, { ...W, runPowerShell: PS_ACCESS_DENIED, runNetstat: netstatOk(NETSTAT_FR) });
  assert.equal(wide.state, 'free');
  const v6 = await checkPortOwnership('::1', 31743, { ...W, runPowerShell: psRouter({ owner: PS_ACCESS_DENIED }), runNetstat: netstatOk(NETSTAT_FR) });
  assert.equal(v6.state, 'owned_by_unknown');
  assert.equal(v6.pid, 5151);
});

test('parseNetstatListeners: localized header ignored, ESTABLISHED/UDP rows excluded, remote :0 counts as listening', () => {
  const { tcpRows, listeners } = parseNetstatListeners(NETSTAT_FR);
  assert.equal(tcpRows, 6);
  assert.equal(listeners.length, 5);
  assert.ok(!listeners.some((l) => l.pid === 777));
  // Locale-independent: a non-English state word still counts via remote ":0".
  const de = parseNetstatListeners('  TCP    127.0.0.1:31742        0.0.0.0:0              ABHÖREN         88\n');
  assert.deepEqual(de.listeners, [{ address: '127.0.0.1', port: 31742, pid: 88 }]);
});

// ── Input validation / no interpolation ─────────────────────────────────
test('invalid port is rejected before any probe runs (never free)', async () => {
  for (const port of [0, -1, 65536, 1.5, NaN, '31742; whoami', '31742 -or 1', null, undefined]) {
    const r = await checkPortOwnership('127.0.0.1', port, {
      ...W, runPowerShell: () => assert.fail('must not run'), runNetstat: () => assert.fail('must not run'),
    });
    assert.equal(r.state, 'undetermined');
    assert.equal(r.reason, 'invalid_port');
  }
  assert.equal(isValidPort(31742), true);
});

test('host is embedded only as a PowerShell single-quoted literal', async () => {
  const run = psRouter({ owner: psJson({ listening: false }) });
  await checkPortOwnership("127.0.0.1'; Remove-Item C:\\x; '", SCRATCH_PORT, { ...W, runPowerShell: run, runNetstat: NETSTAT_FAILED });
  assert.equal(run.calls.length, 1);
  assert.ok(run.calls[0].includes("'127.0.0.1''; Remove-Item C:\\x; '''"), 'quote must be doubled inside a single literal');
  assert.match(run.calls[0], /\$_\.LocalPort -eq 31742 \}/);
});

test('static safety: netstat runs via execFile with constant argv and no shell', () => {
  const source = readFileSync(new URL('./src/lib/port-preflight.js', import.meta.url), 'utf8');
  assert.match(source, /const NETSTAT_ARGS = Object\.freeze\(\['-a', '-n', '-o'\]\);/);
  assert.match(source, /execFile\(\s*NETSTAT_EXE,\s*NETSTAT_ARGS,/);
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /\bexec\(|execSync|spawn\(|shell:\s*true/);
  assert.doesNotMatch(source, /SilentlyContinue/, 'probe errors must never be silenced into "no listener"');
});

// ── Integration (real PowerShell + real netstat), Windows only ──────────
function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
function stillHeld(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => { probe.close(); resolve(false); });
    probe.listen(port, '127.0.0.1');
  });
}
// The exact sandbox symptom: Get-NetTCPConnection raises a non-terminating
// PermissionDenied ("Accès refusé"), everything else runs for real.
const DENY_NETTCP = "function Get-NetTCPConnection { Write-Error -Message 'Accès refusé' -Category PermissionDenied -ErrorId 'Windows System Error 5,Get-NetTCPConnection' }\n";
const DENY_CIM = "function Get-CimInstance { Write-Error -Message 'Accès refusé' -Category PermissionDenied -ErrorId 'HRESULT 0x80041003,Get-CimInstance' }\n";
const deniedPowerShell = (prefix) => (script, opts) => runReadOnlyPowerShell(prefix + script, opts);

test('REAL: Get-NetTCPConnection Access Denied while port is held → owned_by_unknown with this PID; listener untouched', { skip: !isWindows() }, async () => {
  const srv = await listen(SCRATCH_PORT);
  try {
    const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, { runPowerShell: deniedPowerShell(DENY_NETTCP) });
    assert.equal(r.state, 'owned_by_unknown');
    assert.equal(r.pid, process.pid);
    assert.match(String(r.cmdLine), /test-port-preflight-probes\.mjs/);
    assert.equal(await stillHeld(SCRATCH_PORT), true, 'occupant must never be stopped');
  } finally {
    srv.close();
  }
});

test('REAL: Get-NetTCPConnection AND Get-CimInstance denied → owned_by_unknown with netstat PID', { skip: !isWindows() }, async () => {
  const srv = await listen(SCRATCH_PORT);
  try {
    const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, { runPowerShell: deniedPowerShell(DENY_NETTCP + DENY_CIM) });
    assert.deepEqual(r, { state: 'owned_by_unknown', pid: process.pid, name: null, cmdLine: null });
    assert.equal(await stillHeld(SCRATCH_PORT), true);
  } finally {
    srv.close();
  }
});

test('REAL: Get-NetTCPConnection Access Denied on a really free port → free (via netstat)', { skip: !isWindows() }, async () => {
  const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, { runPowerShell: deniedPowerShell(DENY_NETTCP) });
  assert.deepEqual(r, { state: 'free' });
});

test('REAL: denied PowerShell + netstat unavailable → undetermined', { skip: !isWindows() }, async () => {
  const srv = await listen(SCRATCH_PORT);
  try {
    const r = await checkPortOwnership('127.0.0.1', SCRATCH_PORT, { runPowerShell: deniedPowerShell(DENY_NETTCP), runNetstat: NETSTAT_FAILED });
    assert.equal(r.state, 'undetermined');
  } finally {
    srv.close();
  }
});

test('REAL: runNetstatListing returns a parseable table that includes a held port', { skip: !isWindows() }, async () => {
  const srv = await listen(SCRATCH_PORT);
  try {
    const res = await runNetstatListing();
    assert.equal(res.ok, true);
    const { listeners } = parseNetstatListeners(res.stdout);
    assert.ok(listeners.some((l) => l.address === '127.0.0.1' && l.port === SCRATCH_PORT && l.pid === process.pid));
  } finally {
    srv.close();
  }
});
