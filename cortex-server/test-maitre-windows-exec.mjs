// Unit tests for maitre-windows-exec.js — the shared execFile/timeout/
// output-bound/platform-check helper. Includes one gated real-Windows
// smoke test (only runs when process.platform === 'win32', matching
// the mission's "authorized manual read-only smoke test" allowance —
// it never depends on admin privileges or any specific locale).
// Run with: node --test test-maitre-windows-exec.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWindows, toPsSingleQuotedLiteral, runReadOnlyPowerShell } from './src/lib/maitre-windows-exec.js';

test('isWindows: matches process.platform === "win32"', () => {
  assert.equal(isWindows(), process.platform === 'win32');
});

test('toPsSingleQuotedLiteral: escapes embedded single quotes (PowerShell doubling convention)', () => {
  assert.equal(toPsSingleQuotedLiteral("O'Brien"), "'O''Brien'");
});

test('toPsSingleQuotedLiteral: a value with no special characters passes through unchanged inside quotes', () => {
  assert.equal(toPsSingleQuotedLiteral('System'), "'System'");
});

test('toPsSingleQuotedLiteral: prompt-injection-shaped input becomes an inert quoted literal, not a command break-out', () => {
  const malicious = "'; Remove-Item C:\\ -Recurse -Force; '";
  const literal = toPsSingleQuotedLiteral(malicious);
  // Every single quote must be doubled — there is no way for this
  // value to terminate the surrounding quoted string early.
  const quoteCount = (literal.match(/'/g) || []).length;
  const originalQuoteCount = (malicious.match(/'/g) || []).length;
  assert.equal(quoteCount, originalQuoteCount * 2 + 2, 'every embedded quote must be doubled plus the two wrapping quotes');
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
