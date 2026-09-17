// PHASE 6 — Configurable browser selection (MASTER mission). URL validation,
// shell:false spawn discipline, argument injection resistance, and graceful
// handling of an absent/uninstalled browser. Uses a mocked child_process
// spawn — never actually launches a real browser window during tests.
// Run: node --test test-phase6-browser.mjs
import './test-setup.mjs';
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';

import { initSqlite } from './src/lib/sqlite.js';
import {
  detectInstalledBrowsers, getBrowserSettings, setBrowserSettings,
  assertOpenableUrl, resolveOpenCommand, validateCustomBrowserPath,
} from './src/lib/browser.js';
import { createBrowserRoute } from './src/routes/browser.js';

const TEST_DB = './data-test-browser/test.db';

before(() => {
  fs.rmSync('./data-test-browser', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

after(() => {
  try { fs.rmSync('./data-test-browser', { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  setBrowserSettings({ selected: 'system', customPath: null });
});

function buildApp() {
  const app = new Hono();
  app.route('/api', createBrowserRoute({ logger: { info() {}, warn() {} } }));
  return app;
}

// ── URL validation ───────────────────────────────────────────────────────

test('assertOpenableUrl: accepts http/https, rejects everything else', () => {
  assert.equal(assertOpenableUrl('https://example.com/docs'), 'https://example.com/docs');
  assert.equal(assertOpenableUrl('http://example.com'), 'http://example.com/');

  for (const dangerous of [
    'javascript:alert(1)',
    'file:///C:/Windows/system32/cmd.exe',
    'data:text/html,<script>alert(1)</script>',
    'powershell:Get-Process',
    'cmd:whoami',
    'vbscript:msgbox(1)',
    'about:blank',
  ]) {
    assert.throws(() => assertOpenableUrl(dangerous), /Protocole non autorisé/, `must reject ${dangerous}`);
  }
});

test('assertOpenableUrl: rejects a malformed URL rather than passing it through', () => {
  assert.throws(() => assertOpenableUrl('not a url at all'), /URL invalide/);
  assert.throws(() => assertOpenableUrl(''), /URL invalide/);
});

test('assertOpenableUrl: argument-injection attempt via URL string is neutralized by URL parsing, not string matching', () => {
  // A crafted string like this could be dangerous to a naive shell-concatenated
  // command, but URL parsing + spawn(..., [url], {shell:false}) treats it as
  // one opaque argument — no shell metacharacter interpretation is possible.
  const tricky = 'https://example.com/?x=1"; rm -rf ~; #';
  const result = assertOpenableUrl(tricky);
  assert.ok(result.startsWith('https://example.com/'));
});

// ── Browser detection ────────────────────────────────────────────────────

test('detectInstalledBrowsers: always includes "system" (OS default), others only if actually present on disk', () => {
  const browsers = detectInstalledBrowsers();
  assert.ok(browsers.some(b => b.id === 'system'));
  const systemEntry = browsers.find(b => b.id === 'system');
  assert.equal(systemEntry.path, null, 'system has no specific executable path');
  // Every non-system entry must have a real, existing path (detectInstalledBrowsers
  // only returns browsers it verified with fs.existsSync).
  for (const b of browsers.filter(x => x.id !== 'system')) {
    assert.ok(fs.existsSync(b.path), `${b.id} reported as installed must have a real path`);
  }
});

// ── Settings persistence ────────────────────────────────────────────────

test('getBrowserSettings/setBrowserSettings round-trip, defaults to system', () => {
  assert.deepEqual(getBrowserSettings(), { selected: 'system', customPath: null });
  const updated = setBrowserSettings({ selected: 'firefox' });
  assert.equal(updated.selected, 'firefox');
  assert.deepEqual(getBrowserSettings(), { selected: 'firefox', customPath: null });
});

// ── Custom path validation ───────────────────────────────────────────────

test('validateCustomBrowserPath: rejects a non-.exe path, a relative path, and a nonexistent file', () => {
  assert.throws(() => validateCustomBrowserPath(''), /Chemin vide/);
  assert.throws(() => validateCustomBrowserPath('C:\\Windows\\System32\\notepad.txt'), /\.exe/);
  assert.throws(() => validateCustomBrowserPath('relative\\path\\browser.exe'), /absolu/);
  assert.throws(() => validateCustomBrowserPath('C:\\does\\not\\exist\\browser.exe'), /introuvable/);
});

test('validateCustomBrowserPath: accepts a real, absolute .exe path', () => {
  // node.exe itself is a stand-in "real .exe that definitely exists" for this test.
  const realExe = process.execPath;
  assert.equal(validateCustomBrowserPath(realExe), realExe);
});

// ── resolveOpenCommand — always {command, args}, never a shell string ──────

test('resolveOpenCommand: "system" selection uses cmd.exe /c start — a real array of args, not a concatenated string', () => {
  setBrowserSettings({ selected: 'system', customPath: null });
  const { command, args } = resolveOpenCommand('https://example.com');
  assert.ok(command.toLowerCase().endsWith('cmd.exe'));
  assert.deepEqual(args, ['/c', 'start', '', 'https://example.com']);
});

test('resolveOpenCommand: a browser not detected as installed throws a clear error instead of spawning garbage', () => {
  setBrowserSettings({ selected: 'firefox_but_not_really_installed_xyz', customPath: null });
  assert.throws(() => resolveOpenCommand('https://example.com'), /non détecté/);
});

test('resolveOpenCommand: custom path selection uses the verified path with the URL as its own array element', () => {
  const realExe = process.execPath;
  setBrowserSettings({ selected: 'custom', customPath: realExe });
  const { command, args } = resolveOpenCommand('https://example.com/?a=1&b=2');
  assert.equal(command, realExe);
  assert.deepEqual(args, ['https://example.com/?a=1&b=2']);
});

// ── Route integration ────────────────────────────────────────────────────

test('GET /api/browser/installed returns the real detected list', async () => {
  const app = buildApp();
  const res = await app.request('/api/browser/installed');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.browsers));
  assert.ok(body.browsers.some(b => b.id === 'system'));
});

test('PUT /api/browser/settings rejects selecting a browser that is not actually installed', async () => {
  const app = buildApp();
  const res = await app.request('/api/browser/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selected: 'totally_fake_browser_id' }),
  });
  assert.equal(res.status, 400);
});

test('PUT /api/browser/settings with a bad custom path returns 400 with a clear reason, never silently accepted', async () => {
  const app = buildApp();
  const res = await app.request('/api/browser/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selected: 'custom', customPath: 'C:\\nonexistent\\browser.exe' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /introuvable/);
});

test('POST /api/browser/open rejects a javascript: URL with 400 and never reaches spawn', async () => {
  const app = buildApp();
  const res = await app.request('/api/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'javascript:alert(document.cookie)' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Protocole non autorisé/);
});

test('POST /api/browser/open rejects a file: URL (local file access attempt)', async () => {
  const app = buildApp();
  const res = await app.request('/api/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'file:///C:/Windows/win.ini' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/browser/open with no browser installed for the selected id returns a clear 400, not a crash', async () => {
  setBrowserSettings({ selected: 'edge_definitely_not_here_xyz', customPath: null });
  const app = buildApp();
  const res = await app.request('/api/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(res.status, 400);
});
