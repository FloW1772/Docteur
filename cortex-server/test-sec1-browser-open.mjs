// SEC-REMED-1 / SEC-1 — "open in browser" must never hand a URL to a command interpreter.
//
// Root cause (SEC-CERT-1): the default "system" dispatch was `cmd.exe /c start "" <url>`; Node does not escape cmd.exe
// metacharacters, so a URL holding & | ^ ran a second command. The dispatch is now `explorer.exe <url>` (Root Policy
// template shell-open-url) and the URL is validated fail-closed.
//
// No real browser is ever launched: the open path uses an injected spawn, and the behavioural check delivers the exact
// argv to a stand-in program that only echoes it. The control case re-runs the OLD cmd.exe layout with the harmless
// `ver` command, to prove the check would see an injection. Temporary DB only.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import { initSqlite } from './src/lib/sqlite.js';
import { assertOpenableUrl, resolveOpenCommand, setBrowserSettings, openUrlInSelectedBrowser } from './src/lib/browser.js';
import { createBrowserRoute } from './src/routes/browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sec1-browser-'));
const ECHO = path.join(TMP, 'echo-argv.cjs');
const CMD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const VER_OUTPUT = /Microsoft Windows|\[Version \d+\./i; // what the harmless `ver` command prints
// [SEC-REMED-2] "system" = the default browser's own .exe from the registry; a fake registry points at a temp brave.exe
const BRAVE = path.join(TMP, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
const ZEN = path.join(TMP, 'Zen Browser', 'zen.exe'); // custom-browser stand-in (node.exe is now refused as an interpreter)
const readRegistry = (key) => (/\\https?\\UserChoiceLatest\\ProgId$/.test(key) ? 'BraveHTML'
  : key === 'HKCR\\BraveHTML\\shell\\open\\command' ? `"${BRAVE}" --single-argument %1` : null);

before(() => {
  initSqlite(path.join(TMP, 'settings.db'));
  fs.writeFileSync(ECHO, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  for (const exe of [BRAVE, ZEN]) { fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, ''); }
  setBrowserSettings({ selected: 'system', customPath: null });
});
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ } });

// URLs that are legitimate (special characters included) — must stay openable, never become shell syntax.
const LEGIT = [
  'http://example.test/', 'https://example.test/',
  'https://example.test/?q=a&b=c', 'https://example.test/?x=foo|bar', 'https://example.test/?x=a^b', 'https://example.test/?p=100%25',
  'https://example.test/?x=%PATH%', 'https://example.test/?x="quoted"', "https://example.test/?x='single'", 'https://example.test/?x=`tick`',
  'https://example.test/?x=a;b', 'https://example.test/(paren)', 'https://example.test/?x=<tag>', 'https://example.test/a b?c d#e f',
  'https://exemple.test/café?q=é', 'https://bücher.example/', 'https://example.test/#x&ver', 'https://example.test/?q=1&ver', 'https://example.test/?q=1|ver',
];
// URLs that must be refused before any process starts.
const REFUSED = [
  'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///C:/Windows/win.ini', 'vbscript:msgbox(1)',
  'shell:startup', 'ftp://example.test/x', 'cmd:whoami', 'powershell:Get-Item', 'ms-settings:privacy', 'about:blank',
  'not a url', '', '   ', 'https://', 'https://exa mple.test/', 'https://example.test/\r\n&ver', 'https://example.test/?x=1\n|ver', 'https://example.test/\t&ver',
  'https://example.test/\u0000', null, undefined, 42, { href: 'https://example.test/' }, `https://example.test/${'a'.repeat(9000)}`,
];

test('scheme + shape validation: http/https kept (special characters percent-encoded or kept as data); every other scheme, control character and invalid URL refused', () => {
  for (const u of LEGIT) {
    const href = assertOpenableUrl(u);
    assert.match(href, /^https?:\/\//, u);
    assert.doesNotMatch(href, /["\s\u0000-\u001f\u007f]/, `${u}: one clean argv element`);
  }
  assert.equal(assertOpenableUrl('https://example.test/?q=a&b=c'), 'https://example.test/?q=a&b=c', 'a normal query string stays a normal URL');
  assert.equal(new URL(assertOpenableUrl('https://bücher.example/')).hostname, 'xn--bcher-kva.example', 'Unicode host → punycode');
  for (const u of REFUSED) assert.throws(() => assertOpenableUrl(u), /URL invalide|Protocole non autorisé/, JSON.stringify(u));
});

test('dispatch: the "system" choice is the default browser\'s own .exe <url> — never cmd.exe / explorer.exe, never a shell, the URL is exactly one argv element', () => {
  setBrowserSettings({ selected: 'system', customPath: null });
  for (const u of LEGIT) {
    const href = assertOpenableUrl(u);
    const { command, args } = resolveOpenCommand(href, { readRegistry });
    assert.equal(command, BRAVE, u);
    assert.doesNotMatch(path.basename(command), /^(cmd|explorer|rundll32|powershell)\.exe$/i, u);
    assert.deepEqual(args, [href], u);
  }
  setBrowserSettings({ selected: 'custom', customPath: ZEN });
  for (const u of LEGIT) { const href = assertOpenableUrl(u); assert.deepEqual(resolveOpenCommand(href), { command: ZEN, args: [href] }, u); }
  setBrowserSettings({ selected: 'system', customPath: null });
});

test('open path: spawn called once with shell:false and the validated URL as its only argument; refused URLs never reach spawn', () => {
  const calls = [];
  const spawnImpl = (command, args, options) => { calls.push({ command, args, options }); return { unref() {} }; };
  for (const u of LEGIT) {
    const before = calls.length;
    const r = openUrlInSelectedBrowser(u, { spawnImpl, readRegistry });
    assert.equal(calls.length, before + 1);
    const c = calls.at(-1);
    assert.deepEqual([c.command, c.args, c.options.shell, c.options.windowsVerbatimArguments, r.url], [BRAVE, [assertOpenableUrl(u)], false, false, assertOpenableUrl(u)], u);
  }
  const n = calls.length;
  for (const u of REFUSED) assert.throws(() => openUrlInSelectedBrowser(u, { spawnImpl, readRegistry }), JSON.stringify(u));
  assert.equal(calls.length, n, 'refused URL → 0 process');
});

test('behaviour (exploit regression): the formerly exploitable payloads reach the program as ONE intact argument and run NO command; the old cmd.exe layout is the control', () => {
  // [payload, injects under the OLD cmd.exe layout] — `^&` is cmd's own escape, so that one does not inject there
  const PAYLOADS = [['https://127.0.0.1:9/?q=1&ver', true], ['https://127.0.0.1:9/?q=1|ver', true], ['https://127.0.0.1:9/#x&ver', true], ['https://127.0.0.1:9/?a=1&b=2&ver&ver', true], ['https://127.0.0.1:9/?q=1^&ver', false]];
  setBrowserSettings({ selected: 'system', customPath: null });
  for (const [p, injectedBefore] of PAYLOADS) {
    const href = assertOpenableUrl(p);
    // control: the OLD dispatch layout (start → echo, so nothing opens) really runs the injected `ver`
    const old = spawnSync(CMD, ['/c', 'echo', '', href], { shell: false, encoding: 'utf8', timeout: 10_000 });
    if (injectedBefore) assert.match(old.stdout, VER_OUTPUT, `control: the old cmd.exe layout executes the injected command for ${p}`);
    // fixed: the argv the launcher builds, delivered with shell:false to a stand-in that only echoes it
    const { args } = resolveOpenCommand(href, { readRegistry });
    const now = spawnSync(process.execPath, [ECHO, ...args], { shell: false, encoding: 'utf8', timeout: 10_000 });
    assert.equal(now.status, 0);
    assert.deepEqual(JSON.parse(now.stdout), [href], `${p}: exactly one argument, byte-identical`);
    assert.doesNotMatch(now.stdout, VER_OUTPUT, `${p}: no command executed`);
  }
});

test('route: POST /browser/open refuses unsafe schemes / control characters with 400 and starts nothing', async () => {
  const app = new Hono().route('/api', createBrowserRoute({}));
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'https://example.test/\r\n&ver', 'data:text/html,x', 'shell:startup']) {
    const r = await app.request('/api/browser/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    assert.equal(r.status, 400, url);
  }
});

test('static: no command interpreter, no URL dispatcher and no shell:true left in the browser module', () => {
  const src = fs.readFileSync(path.join(HERE, 'src', 'lib', 'browser.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /cmd\.exe|powershell\.exe|pwsh|explorer\.exe|rundll32|FileProtocolHandler|shell:\s*true|\bexecSync?\(|\bexecFile\(/i); // 'cmd:' / 'powershell:' remain only as REFUSED schemes
  // [SEC-REMED-2] the only other process is reg.exe, read-only, with a fixed argv that never contains the URL
  assert.deepEqual(src.match(/execFileSync\(\s*\w+/g), ['execFileSync(REG_EXE']);
});
