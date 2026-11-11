// [MAITRE-STARTUP-1] Regression guard for the STARTUP_FILE leak: test-maitre-executor-level2.mjs wrote a fixture
// into the REAL current-user Startup folder and let the executor move it into the production holding directory
// %TEMP%\docteur-maitre-disabled-persistence, where every run left a file behind.
//  1. startupFileMoveViolationInTest (maitre-executor.js) refuses, under DOCTEUR_TEST_MODE, any STARTUP_FILE move
//     whose source is outside the OS temp directory or inside a real Startup folder, and any move into the
//     production holding directory; it is inert outside the test harness (production unchanged);
//  2. no test file resolves the real Startup folder through PowerShell or mutates a real Startup path / the
//     production holding directory directly (static scan of every cortex-server and scripts test).
// Run with: node --test test-maitre-live-startup-guard.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupFileMoveViolationInTest, LIVE_STARTUP_FOLDER_FORBIDDEN_IN_TEST, PRODUCTION_DISABLED_PERSISTENCE_DIR_FORBIDDEN_IN_TEST } from './src/lib/maitre-executor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = { DOCTEUR_TEST_MODE: '1', APPDATA: 'C:\\Users\\someone\\AppData\\Roaming', ProgramData: 'C:\\ProgramData' };
const SANDBOX = path.join(os.tmpdir(), 'maitre-startup-guard-sandbox');
const SANDBOX_FILE = path.join(SANDBOX, 'Startup', 'fixture.txt');
const SANDBOX_HOLDING = path.join(SANDBOX, 'disabled-persistence');
const PRODUCTION_HOLDING = path.join(os.tmpdir(), 'docteur-maitre-disabled-persistence');

test('test mode: a sandbox source moved into a sandbox holding directory is allowed', () => {
  assert.equal(startupFileMoveViolationInTest(SANDBOX_FILE, SANDBOX_HOLDING, ENV), null);
});

test('test mode: sources outside the OS temp directory or inside a real Startup folder are refused', () => {
  for (const source of [
    'C:\\Users\\someone\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk',
    'c:\\users\\SOMEONE\\appdata\\roaming\\microsoft\\windows\\start menu\\programs\\startup\\x.txt',
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk',
    'D:\\RedirectedStartup\\x.lnk',
    path.join(os.tmpdir(), '..', 'outside-temp.txt'),
  ]) assert.equal(startupFileMoveViolationInTest(source, SANDBOX_HOLDING, ENV), LIVE_STARTUP_FOLDER_FORBIDDEN_IN_TEST, source);
});

test('test mode: the production holding directory (or any destination outside temp) is refused', () => {
  for (const holding of [PRODUCTION_HOLDING, PRODUCTION_HOLDING.toUpperCase(), `${PRODUCTION_HOLDING}${path.sep}`, 'C:\\Windows\\Temp2\\held']) {
    assert.equal(startupFileMoveViolationInTest(SANDBOX_FILE, holding, ENV), PRODUCTION_DISABLED_PERSISTENCE_DIR_FORBIDDEN_IN_TEST, holding);
  }
});

test('production: the guard is inert without DOCTEUR_TEST_MODE (real Startup handling and destination unchanged)', () => {
  const realStartupFile = 'C:\\Users\\someone\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk';
  for (const env of [{ ...ENV, DOCTEUR_TEST_MODE: undefined }, { ...ENV, DOCTEUR_TEST_MODE: '0' }, { ...ENV, DOCTEUR_TEST_MODE: 'true' }]) {
    assert.equal(startupFileMoveViolationInTest(realStartupFile, PRODUCTION_HOLDING, env), null, JSON.stringify(env.DOCTEUR_TEST_MODE));
  }
  assert.equal(process.env.DOCTEUR_TEST_MODE, '1', 'this suite itself runs under the harness flag');
});

test('static: no test resolves the real Startup folder through PowerShell or mutates a real Startup path / the production holding directory', () => {
  const resolvesStartup = /GetFolderPath\(\s*['"]?(?:Common)?Startup['"]?\s*\)/i;
  const spawnsShell = /powershell|execFile|spawn/i;
  const mutation = /\b(?:writeFileSync|appendFileSync|copyFileSync|cpSync|renameSync|rmSync|unlinkSync|mkdirSync|createWriteStream|writeFile|appendFile|copyFile|rename|rm|unlink|mkdir)\s*\(|\b(?:New-Item|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item)\b/;
  const liveTarget = /Start Menu(?:\\\\|\\|\/)+Programs(?:\\\\|\\|\/)+Startup|docteur-maitre-disabled-persistence|\bREAL_STARTUP_DIRS\b|\bPRODUCTION_HOLDING(?:_DIR)?\b|process\.env\.(?:APPDATA|ProgramData)/i;
  const self = path.basename(fileURLToPath(import.meta.url));
  const offenders = [];
  for (const dir of [HERE, path.join(HERE, '..', 'scripts')]) {
    for (const file of fs.readdirSync(dir).filter(f => /^test-.*\.m?js$/.test(f) && f !== self)) {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // comments describe, they do not run
        const around = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        if (resolvesStartup.test(line) && spawnsShell.test(around)) offenders.push(`${file}:${i + 1} resolves the real Startup folder`);
        if (mutation.test(line) && liveTarget.test(line)) offenders.push(`${file}:${i + 1} mutates a real Startup path / production holding directory`);
      });
    }
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});
