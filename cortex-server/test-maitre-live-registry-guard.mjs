// [MAITRE-REG-1] Regression guard for the September 2026 leak: test-maitre-executor-level2.mjs wrote
// DocteurMaitre* values into the REAL HKCU\...\CurrentVersion\Run key and only removed them when the
// action under test succeeded, so failed/aborted runs left autorun entries behind.
//  1. runReadOnlyPowerShell refuses, under DOCTEUR_TEST_MODE, any registry-mutating script aimed at a live
//     autorun key, BEFORE spawning (LIVE_AUTORUN_REGISTRY_FORBIDDEN_IN_TEST);
//  2. the guard is inert outside the test harness (production unchanged);
//  3. no test file writes a live autorun key directly (static scan of every cortex-server/scripts test).
// The only real call made here removes a canary value name that never exists, so even a broken guard
// could not change the registry.
// Run with: node --test test-maitre-live-registry-guard.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runReadOnlyPowerShell, isLiveAutorunMutationInTest, LIVE_AUTORUN_REGISTRY_FORBIDDEN_IN_TEST } from './src/lib/maitre-windows-exec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ENV = { DOCTEUR_TEST_MODE: '1' };
const REMOVE_SCRIPT = "Remove-ItemProperty -LiteralPath $env:DOCTEUR_PS_DATA_REGISTRY_PATH -Name $env:DOCTEUR_PS_DATA_REGISTRY_VALUE_NAME -ErrorAction Stop";
const LIVE_LOCATIONS = [
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',
  'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'hkcu:/software/microsoft/windows/currentversion/run',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\',
];

test('test mode: every registry-mutating form aimed at a live autorun key is classified as forbidden', () => {
  for (const location of LIVE_LOCATIONS) {
    assert.equal(isLiveAutorunMutationInTest(REMOVE_SCRIPT, { REGISTRY_PATH: location, REGISTRY_VALUE_NAME: 'x' }, TEST_ENV), true, location);
  }
  for (const script of [
    "New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name x -Value y",
    "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name x -Value y",
    "reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x /d y /f",
    "reg.exe delete HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce /v x /f",
    "[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run', $true).DeleteValue('x')",
    "[Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce').SetValue('x', 'y')",
  ]) assert.equal(isLiveAutorunMutationInTest(script, {}, TEST_ENV), true, script);
});

test('test mode: reads of live autorun keys and writes to non-autorun keys stay allowed', () => {
  const read = "$item = Get-ItemProperty -LiteralPath $env:DOCTEUR_PS_DATA_REGISTRY_PATH -ErrorAction Stop";
  assert.equal(isLiveAutorunMutationInTest(read, { REGISTRY_PATH: LIVE_LOCATIONS[0] }, TEST_ENV), false, 'read-only listing');
  for (const location of [
    'HKCU:\\Software\\DocteurTestMaitreRegistrySandbox-1234\\HKCU-Run',
    'HKCU:\\Software\\DocteurTestMaitreRegistrySandbox-1234\\HKLM-RunOnce',
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Runner',
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer',
  ]) assert.equal(isLiveAutorunMutationInTest(REMOVE_SCRIPT, { REGISTRY_PATH: location, REGISTRY_VALUE_NAME: 'x' }, TEST_ENV), false, location);
});

test('production: the guard is inert without DOCTEUR_TEST_MODE (legitimate MAÎTRE remediation unchanged)', () => {
  for (const env of [{}, { DOCTEUR_TEST_MODE: '0' }, { DOCTEUR_TEST_MODE: 'true' }]) {
    assert.equal(isLiveAutorunMutationInTest(REMOVE_SCRIPT, { REGISTRY_PATH: LIVE_LOCATIONS[0], REGISTRY_VALUE_NAME: 'x' }, env), false, JSON.stringify(env));
  }
  assert.equal(process.env.DOCTEUR_TEST_MODE, '1', 'this suite itself runs under the harness flag');
});

test('runReadOnlyPowerShell throws LIVE_AUTORUN_REGISTRY_FORBIDDEN_IN_TEST before spawning anything', async () => {
  if (process.platform !== 'win32') return;
  const canary = `DocteurMaitreGuardCanaryNeverCreated${process.pid}`;
  for (const location of LIVE_LOCATIONS.slice(0, 5)) {
    const started = Date.now();
    await assert.rejects(runReadOnlyPowerShell(REMOVE_SCRIPT, { data: { REGISTRY_PATH: location, REGISTRY_VALUE_NAME: canary } }),
      err => err.code === LIVE_AUTORUN_REGISTRY_FORBIDDEN_IN_TEST && err.message.startsWith(LIVE_AUTORUN_REGISTRY_FORBIDDEN_IN_TEST), location);
    assert.ok(Date.now() - started < 200, 'refused synchronously, no PowerShell start-up');
  }
  // the refusal happens in-process: the live key never had the canary and still does not
  const { stdout } = await promisify(execFile)('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(stdout.includes(canary), false);
});

test('static: no test file writes a live autorun registry key directly', () => {
  // source text: path separators may appear escaped (\\) inside JS strings
  const liveKey = /Software(?:\\\\|\\|\/)+(?:WOW6432Node(?:\\\\|\\|\/)+)?Microsoft(?:\\\\|\\|\/)+Windows(?:\\\\|\\|\/)+CurrentVersion(?:\\\\|\\|\/)+Run(?:Once)?(?!\w)/i;
  const mutation = /\b(?:New|Set|Remove|Rename|Clear)-ItemProperty\b|\breg(?:\.exe)?['"]?\s*[,(]?\s*\[?\s*['"]?(?:add|delete|import)\b|\.(?:SetValue|DeleteValue|CreateSubKey|DeleteSubKey(?:Tree)?)\s*\(/i;
  const self = path.basename(fileURLToPath(import.meta.url));
  const offenders = [];
  for (const dir of [HERE, path.join(HERE, '..', 'scripts')]) {
    for (const file of fs.readdirSync(dir).filter(f => /^test-.*\.m?js$/.test(f) && f !== self)) {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // comments describe, they do not run
        const windowText = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
        if (mutation.test(line) && liveKey.test(windowText)) offenders.push(`${file}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `direct live autorun writes in tests: ${offenders.join(', ')}`);
});
