// Unit tests for maitre-windows-exec.js — the shared execFile/timeout/
// output-bound/platform-check helper. Includes one gated real-Windows
// smoke test (only runs when process.platform === 'win32', matching
// the mission's "authorized manual read-only smoke test" allowance —
// it never depends on admin privileges or any specific locale).
// Run with: node --test test-maitre-windows-exec.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWindows, runReadOnlyPowerShell, buildPowerShellChildEnv, POWERSHELL_DATA_ENV,
} from './src/lib/maitre-windows-exec.js';

test('isWindows: matches process.platform === "win32"', () => {
  assert.equal(isWindows(), process.platform === 'win32');
});

test('PowerShell data transport: closed slots build a child-only environment without mutating the parent', () => {
  const parent = { PATH: 'fixture', docteur_ps_data_file_path: 'stale-parent-value' };
  const child = buildPowerShellChildEnv({ FILE_PATH: "C:\\O’Brien.exe" }, parent);
  assert.deepEqual(parent, { PATH: 'fixture', docteur_ps_data_file_path: 'stale-parent-value' });
  assert.equal(child.PATH, 'fixture');
  assert.equal(child.docteur_ps_data_file_path, undefined, 'case-insensitive reserved parent value must be scrubbed');
  assert.equal(child[POWERSHELL_DATA_ENV.FILE_PATH], "C:\\O’Brien.exe");
});

test('PowerShell data transport: arbitrary environment names, non-strings and NUL are refused', () => {
  assert.throws(() => buildPowerShellChildEnv({ PATH: 'attacker-controlled' }), /unsupported data slot/);
  assert.throws(() => buildPowerShellChildEnv({ FILE_PATH: 123 }), /must be a string/);
  assert.throws(() => buildPowerShellChildEnv({ FILE_PATH: 'a\0b' }), /contains NUL/);
});

test('runReadOnlyPowerShell: throws synchronously if called when isWindows() would be false — caller must gate first', async () => {
  if (isWindows()) return; // this assertion only makes sense on a non-Windows CI runner
  await assert.rejects(() => runReadOnlyPowerShell('Get-Date'));
});

// ── Real Windows smoke test (gated, read-only only) ──────────────────────
// Per mission MA-3 §14: "un test manuel READ-ONLY sur la machine de
// développement" is authorized. This never modifies system state —
// Get-Date is a pure read with zero side effects.
test('runReadOnlyPowerShell: real Windows smoke test — trivial read-only command succeeds', { skip: !isWindows() }, async () => {
  const result = await runReadOnlyPowerShell('Get-Date | Out-String');
  assert.equal(result.ok, true);
  assert.ok(result.stdout.length > 0);
});

test('runReadOnlyPowerShell: real Windows smoke test — a failing command degrades to a controlled error, never throws', { skip: !isWindows() }, async () => {
  const result = await runReadOnlyPowerShell('$ErrorActionPreference="Stop"; Get-NonExistentCmdlet123');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exec_failed');
});

test('runReadOnlyPowerShell: real Windows smoke test — output is UTF-8, no replacement characters for accented text', { skip: !isWindows() }, async () => {
  const result = await runReadOnlyPowerShell("Write-Output 'caf\u00e9 \u00e9t\u00e9 na\u00efve'");
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.stdout, /\ufffd/, 'must never contain the Unicode replacement character');
  assert.match(result.stdout, /caf\u00e9/);
});
