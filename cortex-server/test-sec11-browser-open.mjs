// SEC-REMED-2 / SEC-11 — "open in browser" must hand the URL, as DATA, to a real browser executable and to nothing else.
//
// SEC-CERT-RETRY finding: SEC-REMED-1 dispatched `explorer.exe <url>`. explorer.exe splits its command line on commas and
// honours its own switches, so the valid http URL `https://127.0.0.1:9/?a,/root,C:\…\probe.cmd` launched probe.cmd.
// The "system" choice now resolves the default browser's own .exe from the registry and spawns `browser.exe [url]`.
//
// Default run: no process is started except reg.exe (read-only) and a node stand-in — every launch goes through a spawn
// recorder, the registry is faked where determinism matters, temp DB only.
// Real Windows proof (opt-in, it opens browser tabs on https://127.0.0.1:9/… — a closed port):
//   DOCTEUR_SEC11_REAL_LAUNCH=1 node --test test-sec11-browser-open.mjs
// It first proves the harness detects the attack (the OLD explorer.exe dispatch runs a harmless marker .cmd), then sends
// the same payloads through the REAL route + REAL registry + REAL spawn and requires every marker to stay NOT_EXECUTED.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import { initSqlite } from './src/lib/sqlite.js';
import {
  assertOpenableUrl, openUrlInSelectedBrowser, parseBrowserOpenCommand, resolveDefaultBrowserExecutable, resolveOpenCommand,
  setBrowserSettings, validateCustomBrowserPath, SAFE_BROWSER_OPEN_UNAVAILABLE,
} from './src/lib/browser.js';
import { createBrowserRoute } from './src/routes/browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sec11-browser-'));
const SYS = process.env.SystemRoot || 'C:\\Windows';
const REAL = process.platform === 'win32' && process.env.DOCTEUR_SEC11_REAL_LAUNCH === '1';

const fake = (...parts) => path.join(TMP, ...parts);
const BRAVE = fake('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
const CHROME = fake('Google', 'Chrome', 'Application', 'chrome.exe');
const EDGE = fake('Microsoft', 'Edge', 'Application', 'msedge.exe');
const FIREFOX = fake('Mozilla Firefox', 'firefox.exe');
const CHROME_ELSEWHERE = fake('Downloads', 'chrome.exe');
const OPERA = fake('Opera', 'launcher.exe');
const ZEN = fake('Zen Browser', 'zen.exe');
const ECHO = fake('echo-argv.cjs');

/** Fake registry: { latest, choice } ProgIds per scheme, ProgId → command, scheme fallback command. Records every key read. */
function registry({ latest = 'BraveHTML', choice = null, commands = { BraveHTML: `"${BRAVE}" --single-argument %1` }, schemeCommand = null } = {}) {
  const keys = [];
  const read = (key, name) => {
    keys.push([key, name]);
    if (/\\UserChoiceLatest\\ProgId$/.test(key)) return latest;
    if (/\\UserChoice$/.test(key)) return choice;
    const m = /^HKCR\\(.+)\\shell\\open\\command$/.exec(key);
    if (m && (m[1] === 'http' || m[1] === 'https')) return schemeCommand;
    return m ? (commands[m[1]] ?? null) : null;
  };
  return { read, keys };
}
const recorder = () => {
  const calls = [];
  return { calls, spawnImpl: (command, args, options) => { calls.push({ command, args: [...args], options: { ...options } }); return { unref() {} }; } };
};
const DISPATCHERS = /^(cmd|explorer|rundll32|powershell|pwsh|mshta|wscript|cscript|conhost)\.exe$/i;

before(() => {
  initSqlite(fake('settings.db'));
  for (const exe of [BRAVE, CHROME, EDGE, FIREFOX, CHROME_ELSEWHERE, OPERA, ZEN]) { fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, ''); }
  fs.writeFileSync(ECHO, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  setBrowserSettings({ selected: 'system', customPath: null });
});
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ } });

// ═══ 1. Default browser resolution: executable only, known browsers only, everything else fails closed ═══════════════
test('registry: the registered commands of the four known browsers resolve to their own .exe (static args dropped, %1 = the URL slot)', () => {
  assert.equal(parseBrowserOpenCommand(`"${BRAVE}" --single-argument %1`), BRAVE);
  assert.equal(parseBrowserOpenCommand(`"${CHROME}" --single-argument %1`), CHROME);
  assert.equal(parseBrowserOpenCommand(`"${EDGE}" --single-argument %1`), EDGE);
  assert.equal(parseBrowserOpenCommand(`"${EDGE}" "%1"`), EDGE, 'HKCR\\https\\shell\\open\\command form');
  assert.equal(parseBrowserOpenCommand(`"${FIREFOX}" -osint -url "%1"`), FIREFOX);
});

test('registry: dispatchers, unknown programs, non-local / non-absolute / unexpanded paths and unexpected arguments → SAFE_BROWSER_OPEN_UNAVAILABLE', () => {
  const REFUSED = [
    `${SYS}\\explorer.exe %1`, `"${SYS}\\explorer.exe" "%1"`, `"${SYS}\\System32\\cmd.exe" /c start "" %1`,
    `"${SYS}\\System32\\rundll32.exe" url.dll,FileProtocolHandler %1`, `rundll32.exe url.dll,FileProtocolHandler %1`,
    `"${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" Start-Process "%1"`, `"${SYS}\\System32\\mshta.exe" "%1"`,
    `"${OPERA}" %1`, `"${CHROME_ELSEWHERE}" %1`, '"\\\\server\\share\\Google\\Chrome\\Application\\chrome.exe" %1',
    '"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1', 'chrome.exe %1', '"Application\\chrome.exe" %1',
    `"${path.join(TMP, 'x', '..', 'Google', 'Chrome', 'Application', 'chrome.exe').replace(path.join(TMP, 'Google'), `${TMP}\\x\\..\\Google`)}" %1`,
    `"${CHROME}" --new-window %1`, `"${CHROME}" --single-argument`, `"${CHROME}" %1 %1`, `"${CHROME}" %2`, `"${CHROME}" --load-extension=x %1`,
    `"${CHROME}"%1`, `"${fake('Google', 'Chrome', 'Application', 'missing', 'chrome.exe')}" %1`, '', '"', '   ', null,
  ];
  for (const c of REFUSED) {
    assert.throws(() => parseBrowserOpenCommand(c), (e) => e.code === SAFE_BROWSER_OPEN_UNAVAILABLE, JSON.stringify(c));
  }
});

test('registry: lookup order (UserChoiceLatest → UserChoice → HKCR\\<scheme>), ProgId shape checked, URL never part of any key, non-Windows fails closed', () => {
  const latest = registry({ latest: 'BraveHTML', choice: 'ChromeHTML', commands: { BraveHTML: `"${BRAVE}" --single-argument %1`, ChromeHTML: `"${CHROME}" --single-argument %1` } });
  assert.equal(resolveDefaultBrowserExecutable('https', { readRegistry: latest.read, platform: 'win32' }), BRAVE, 'UserChoiceLatest wins (Windows 11 24H2+)');
  const legacy = registry({ latest: null, choice: 'FirefoxURL-308046B0AF4A39CB', commands: { 'FirefoxURL-308046B0AF4A39CB': `"${FIREFOX}" -osint -url "%1"` } });
  assert.equal(resolveDefaultBrowserExecutable('http', { readRegistry: legacy.read, platform: 'win32' }), FIREFOX);
  const scheme = registry({ latest: null, choice: null, schemeCommand: `"${EDGE}" "%1"` });
  assert.equal(resolveDefaultBrowserExecutable('https', { readRegistry: scheme.read, platform: 'win32' }), EDGE);
  for (const r of [latest, legacy, scheme]) {
    for (const [key] of r.keys) assert.match(key, /^(HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https?\\UserChoice(Latest\\ProgId)?|HKCR\\[A-Za-z0-9._-]+\\shell\\open\\command)$/, key);
  }
  const unavailable = (e) => e.code === SAFE_BROWSER_OPEN_UNAVAILABLE;
  for (const progId of ['..\\..\\cmd', 'Brave HTML', 'x"y', 'a\\b', '']) {
    assert.throws(() => resolveDefaultBrowserExecutable('https', { readRegistry: registry({ latest: progId }).read, platform: 'win32' }), unavailable, progId);
  }
  assert.throws(() => resolveDefaultBrowserExecutable('https', { readRegistry: registry({ latest: 'AppXq0fevzme2pys62n3e0fbqa7peapykr8v' }).read, platform: 'win32' }), unavailable, 'UWP / DelegateExecute handler: no command → fail closed');
  assert.throws(() => resolveDefaultBrowserExecutable('https', { readRegistry: registry({ latest: null }).read, platform: 'win32' }), unavailable, 'nothing registered');
  assert.throws(() => resolveDefaultBrowserExecutable('https', { readRegistry: latest.read, platform: 'linux' }), unavailable);
  assert.throws(() => resolveDefaultBrowserExecutable('file', { readRegistry: latest.read, platform: 'win32' }), unavailable);
});

test('fail closed: an unresolvable default browser starts 0 processes and says SAFE_BROWSER_OPEN_UNAVAILABLE', () => {
  const { calls, spawnImpl } = recorder();
  setBrowserSettings({ selected: 'system', customPath: null });
  for (const reg of [registry({ latest: 'Evil', commands: { Evil: `"${SYS}\\explorer.exe" %1` } }), registry({ latest: null })]) {
    assert.throws(() => openUrlInSelectedBrowser('https://127.0.0.1:9/', { spawnImpl, readRegistry: reg.read, platform: 'win32' }), (e) => e.code === SAFE_BROWSER_OPEN_UNAVAILABLE);
  }
  assert.equal(calls.length, 0);
});

// ═══ 2. Attack matrix: every URL is the ONE argv element of the browser .exe ═════════════════════════════════════════
const MATRIX = [
  'https://127.0.0.1:9/', 'http://127.0.0.1:9/', 'https://127.0.0.1:9/?a=1&b=2', 'https://127.0.0.1:9/?a|b', 'https://127.0.0.1:9/?a^b',
  'https://127.0.0.1:9/?a,b', String.raw`https://127.0.0.1:9/?a\b`,
  String.raw`https://127.0.0.1:9/?a,/root,C:\TEMP\marker.cmd`, String.raw`https://127.0.0.1:9/?a,/select,C:\TEMP\marker.cmd`,
  'https://127.0.0.1:9/,/root,C:/TEMP/marker.cmd', String.raw`https://127.0.0.1:9/#a,/root,C:\TEMP\marker.cmd`,
  String.raw`https://127.0.0.1:9/?a,/e,/n,/root,C:\Windows`, 'https://127.0.0.1:9/?x="quoted"', "https://127.0.0.1:9/?x='single'",
  'https://127.0.0.1:9/a b?c d#e f', 'https://127.0.0.1:9/café?q=é', 'https://bücher.test/', 'https://127.0.0.1:9/?p=100%25&x=%PATH%&y=%1',
  'https://127.0.0.1:9/?x=%0D%0A%26ver', 'https://127.0.0.1:9/?x=%252F%255C%250D%250A', 'https://127.0.0.1:9/?-new-window', 'https://127.0.0.1:9/?--single-argument',
  'https://127.0.0.1:9/?x=`tick`;(p)<t>', 'https://127.0.0.1:9/?x=^&ver',
];

test('attack matrix: one spawn of the browser .exe, args === [href], shell:false, no verbatim args, the argument can never be a switch, a path or a second argv', () => {
  const reg = registry();
  const { calls, spawnImpl } = recorder();
  setBrowserSettings({ selected: 'system', customPath: null });
  for (const u of MATRIX) {
    const href = assertOpenableUrl(u);
    const before = calls.length;
    const r = openUrlInSelectedBrowser(u, { spawnImpl, readRegistry: reg.read, platform: 'win32' });
    assert.equal(calls.length, before + 1, u);
    const c = calls.at(-1);
    assert.equal(c.command, BRAVE, u);
    assert.doesNotMatch(path.win32.basename(c.command), DISPATCHERS, u);
    assert.deepEqual(c.args, [href], u);
    assert.equal(r.url, href, u);
    assert.match(c.args[0], /^https?:\/\/[^\s"]+$/, `${u}: starts with the scheme (never -, /, \\ or a drive letter), no quote / whitespace`);
    assert.equal(c.options.shell, false, u);
    assert.equal(c.options.windowsVerbatimArguments, false, u);
    assert.equal(c.options.cwd, undefined, `${u}: working directory not chosen by the URL`);
  }
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/TEMP/marker.cmd', 'vbscript:msgbox(1)', 'cmd:whoami', 'powershell:Get-Item',
    'shell:startup', 'ftp://127.0.0.1/x', 'gopher://127.0.0.1/x', 'search-ms:query=x', 'ms-msdt:/id x', 'mailto:a@b.c', 'about:blank']) {
    assert.throws(() => openUrlInSelectedBrowser(u, { spawnImpl, readRegistry: reg.read, platform: 'win32' }), /Protocole non autorisé|URL invalide/, u);
  }
  assert.equal(calls.length, MATRIX.length, 'unsafe schemes → 0 process');
});

test('attack matrix: Windows delivers each argv to the program byte-identical, as ONE argument (complement to the real-browser proof below)', () => {
  const reg = registry();
  for (const u of MATRIX) {
    const { args } = resolveOpenCommand(assertOpenableUrl(u), { readRegistry: reg.read, platform: 'win32' });
    const out = spawnSync(process.execPath, [ECHO, ...args], { shell: false, encoding: 'utf8', timeout: 10_000 });
    assert.equal(out.status, 0, u);
    assert.deepEqual(JSON.parse(out.stdout), args, u);
  }
});

// ═══ 3. UNC / local path forms (static + recorder; nothing is ever launched, no network share is contacted) ══════════
test('UNC / file forms: refused outright, or they stay a web URL argument of the browser — never a filesystem / UNC argument', () => {
  const reg = registry();
  const { calls, spawnImpl } = recorder();
  const REFUSED = ['\\\\server\\share\\file.cmd', '//server/share/file.cmd', 'file://server/share/file.cmd', 'file:///C:/TEMP/marker.cmd',
    '\\\\server@SSL\\DavWWWRoot\\x.cmd', '\\\\localhost\\c$\\TEMP\\x.cmd', '\\\\?\\UNC\\server\\share\\x.cmd', 'C:\\TEMP\\marker.cmd', 'C:/TEMP/marker.cmd',
    'search-ms:query=x&crumb=location:\\\\server\\share', '\\\\127.0.0.1@80\\DavWWWRoot\\x.lnk'];
  for (const u of REFUSED) assert.throws(() => openUrlInSelectedBrowser(u, { spawnImpl, readRegistry: reg.read, platform: 'win32' }), /Protocole non autorisé|URL invalide/, u);
  assert.equal(calls.length, 0);
  const WEB = ['https:\\\\server\\share\\file.cmd', 'https://127.0.0.1:9/\\\\server\\share\\file.cmd', 'https://127.0.0.1:9/?u=\\\\server\\share\\file.cmd',
    'https://127.0.0.1:9/?u=file://server/share/x', 'https://127.0.0.1:9/?a,/root,\\\\server\\share\\x.cmd', 'https://127.0.0.1:9/?a,/root,\\\\server@SSL\\DavWWWRoot\\x.lnk'];
  for (const u of WEB) {
    openUrlInSelectedBrowser(u, { spawnImpl, readRegistry: reg.read, platform: 'win32' });
    const c = calls.at(-1);
    assert.equal(c.command, BRAVE, u);
    assert.equal(c.args.length, 1, u);
    assert.match(c.args[0], /^https:\/\//, `${u}: a web URL for the browser`);
    assert.doesNotMatch(c.args[0], /^(\\\\|[A-Za-z]:|file:)/i, u);
  }
  assert.equal(new URL(assertOpenableUrl('https:\\\\server\\share\\file.cmd')).protocol, 'https:', 'backslash authority = an https host, not UNC');
});

// ═══ 4. Custom browser: never a launcher / interpreter, even if one was stored before this fix ═══════════════════════
test('custom browser: explorer.exe, cmd.exe, rundll32.exe, powershell.exe, mshta.exe, wscript.exe are refused when chosen AND at open time', () => {
  const { calls, spawnImpl } = recorder();
  const LAUNCHERS = [`${SYS}\\explorer.exe`, `${SYS}\\System32\\cmd.exe`, `${SYS}\\System32\\rundll32.exe`,
    `${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, `${SYS}\\System32\\mshta.exe`, `${SYS}\\System32\\wscript.exe`].filter(p => fs.existsSync(p));
  assert.ok(LAUNCHERS.length >= 4, 'real system launchers present');
  for (const exe of LAUNCHERS) {
    assert.throws(() => validateCustomBrowserPath(exe), /pas un navigateur/, exe);
    setBrowserSettings({ selected: 'custom', customPath: exe }); // a value stored before the fix
    assert.throws(() => openUrlInSelectedBrowser(String.raw`https://127.0.0.1:9/?a,/root,C:\TEMP\marker.cmd`, { spawnImpl }), /pas un navigateur/, exe);
  }
  assert.equal(calls.length, 0, 'no launcher ever started');
  assert.equal(validateCustomBrowserPath(ZEN), ZEN, 'a real custom browser .exe stays allowed');
  setBrowserSettings({ selected: 'custom', customPath: ZEN });
  openUrlInSelectedBrowser('https://127.0.0.1:9/?a,b', { spawnImpl });
  assert.deepEqual([calls[0].command, calls[0].args], [ZEN, ['https://127.0.0.1:9/?a,b']]);
  setBrowserSettings({ selected: 'system', customPath: null });
});

// ═══ 5. Route + static ════════════════════════════════════════════════════════════════════════════════════════════
test('route: POST /api/browser/open with the SEC-11 payload → the real default browser .exe [href] (or SAFE_BROWSER_OPEN_UNAVAILABLE and 0 process)', async () => {
  const { calls, spawnImpl } = recorder();
  const app = new Hono().route('/api', createBrowserRoute({ spawnImpl }));
  setBrowserSettings({ selected: 'system', customPath: null });
  const payload = String.raw`https://127.0.0.1:9/?a,/root,C:\TEMP\marker.cmd`;
  const r = await app.request('/api/browser/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: payload }) });
  const body = await r.json();
  let expected = null;
  try { expected = resolveDefaultBrowserExecutable(payload.startsWith('https') ? 'https' : 'http'); } catch (e) { assert.equal(e.code, SAFE_BROWSER_OPEN_UNAVAILABLE); }
  if (expected) {
    assert.equal(r.status, 200);
    assert.deepEqual(calls.map(c => [c.command, c.args, c.options.shell]), [[expected, [assertOpenableUrl(payload)], false]]);
    assert.doesNotMatch(path.win32.basename(expected), DISPATCHERS);
  } else {
    assert.equal(r.status, 400);
    assert.equal(body.code, SAFE_BROWSER_OPEN_UNAVAILABLE);
    assert.equal(calls.length, 0);
  }
});

test('static: browser module has no dispatcher; server.js mounts the route without the test seam; no other module hands a URL to explorer / cmd / rundll32', () => {
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const browser = strip(fs.readFileSync(path.join(HERE, 'src', 'lib', 'browser.js'), 'utf8'));
  assert.doesNotMatch(browser, /explorer\.exe|cmd\.exe|rundll32|FileProtocolHandler|powershell\.exe|Start-Process|shell:\s*true|\bexecSync\(|\bexec\(/i);
  assert.match(browser, /spawnImpl\(command, \[safeUrl\], \{ shell: false, windowsVerbatimArguments: false/);
  const server = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  assert.deepEqual(server.match(/createBrowserRoute\([^)]*\)/g), ['createBrowserRoute({ logger })']);
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'root-policy' && e.name !== '__pycache__') walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      if (/explorer\.exe|rundll32|FileProtocolHandler|['"]start['"]\s*,\s*['"]{2}/i.test(strip(fs.readFileSync(p, 'utf8')))) offenders.push(path.relative(HERE, p));
    }
  };
  walk(path.join(HERE, 'src'));
  assert.deepEqual(offenders, [], 'Root Policy data (deny lists, V2 candidate templates) is the only remaining mention');
});

// ═══ 6. REAL Windows proof (opt-in) ═══════════════════════════════════════════════════════════════════════════════
test('REAL Windows: the OLD explorer.exe dispatch runs the marker (control); the NEW real route + registry + spawn never does', { skip: REAL ? false : 'opt-in: DOCTEUR_SEC11_REAL_LAUNCH=1 (opens browser tabs on https://127.0.0.1:9/)' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec11-real-'));
  assert.doesNotMatch(dir, /\s/, 'marker paths must be valid URL data (no whitespace)');
  const marker = (k) => path.join(dir, `marker-${k}.txt`);
  const probe = (k) => { const p = path.join(dir, `probe-${k}.cmd`); fs.writeFileSync(p, `@echo off\r\necho EXECUTED_${k} > "${marker(k)}"\r\nexit\r\n`); return p; };
  const waitFor = async (k, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fs.existsSync(marker(k))) return true; await new Promise(r => setTimeout(r, 200)); } return fs.existsSync(marker(k)); };
  try {
    // control — the SEC-REMED-1 dispatch, with the same spawn options: explorer.exe runs the marker
    const ctrl = assertOpenableUrl(`https://127.0.0.1:9/?a,/root,${probe('control')}`);
    spawn(path.join(SYS, 'explorer.exe'), [ctrl], { shell: false, detached: true, stdio: 'ignore' }).unref();
    assert.equal(await waitFor('control', 10_000), true, 'control: the harness detects the SEC-11 attack (marker EXECUTED via explorer.exe)');

    // fixed — real route, real registry, real spawn (recorded, then really started)
    const expected = resolveDefaultBrowserExecutable('https');
    const launched = [];
    const spawnImpl = (command, args, options) => { launched.push({ command, args: [...args], options: { ...options } }); return spawn(command, args, options); };
    const app = new Hono().route('/api', createBrowserRoute({ spawnImpl }));
    setBrowserSettings({ selected: 'system', customPath: null });
    const CASES = {
      root: `https://127.0.0.1:9/?a,/root,${probe('root')}`, select: `https://127.0.0.1:9/?a,/select,${probe('select')}`,
      plain: `https://127.0.0.1:9/?a,${probe('plain')}`, fragment: `https://127.0.0.1:9/#a,/root,${probe('fragment')}`,
      meta: `https://127.0.0.1:9/?a=1&b=2|c^d,e\\f&x=/root,${probe('meta')}`,
    };
    for (const [k, url] of Object.entries(CASES)) {
      const r = await app.request('/api/browser/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      assert.equal(r.status, 200, k);
    }
    await new Promise(r => setTimeout(r, 8_000));
    for (const k of Object.keys(CASES)) assert.equal(fs.existsSync(marker(k)), false, `${k}: marker NOT_EXECUTED`);
    assert.equal(launched.length, Object.keys(CASES).length);
    for (const [i, url] of Object.values(CASES).entries()) {
      assert.deepEqual([launched[i].command, launched[i].args, launched[i].options.shell], [expected, [assertOpenableUrl(url)], false]);
    }
    console.log(`# SEC-11 real proof: control EXECUTED via explorer.exe; ${launched.length} payloads → ${path.win32.basename(expected)} [url], 0 marker executed`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
