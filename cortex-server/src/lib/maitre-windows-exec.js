/**
 * MAÎTRE — shared Windows command-execution helper. Originally written
 * for MA-3's read-only adapters (maitre-defender-adapter.js,
 * maitre-eventlog-adapter.js); MA-9 also reuses it for the LEVEL 2
 * executor's mutating commands (Stop-Process, New-NetFirewallRule,
 * registry/task/service changes) — the function name is a historical
 * artifact of its first caller, not an enforced read-only boundary.
 * What actually makes every caller safe is unchanged either way: this
 * file only ever runs a FIXED, Docteur-authored PowerShell script text
 * passed in by the caller — it never accepts a user-, LLM-, or
 * Event-Log-derived string as the SCRIPT itself. Callers pass small,
 * typed, validated parameters that get embedded via safe literal
 * construction (see toPsSingleQuotedLiteral below), never via naive
 * string concatenation of untrusted text — this holds identically
 * whether the script reads a status or changes one.
 *
 * shell:false always (execFile, not exec/spawn-with-shell). Every call
 * has a hard timeout and a bounded stdout/stderr buffer. Non-Windows
 * platforms short-circuit to NOT_SUPPORTED before ever touching
 * child_process.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export const DEFAULT_TIMEOUT_MS = 8_000;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB — bounds a large Event Log JSON payload

export function isWindows() {
  return process.platform === 'win32';
}

/**
 * Escapes a value for safe interpolation inside a PowerShell
 * single-quoted string literal: the only special character in a
 * single-quoted PS string is the single quote itself, doubled to
 * escape (PowerShell's own convention, not shell escaping). Never use
 * this to build a script from LLM/user/Event-Log text as a COMMAND —
 * it only makes a DATA VALUE safe to embed as a literal, the script
 * structure itself must always be the fixed, Docteur-authored text.
 */
export function toPsSingleQuotedLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Runs a fixed PowerShell script (never user/LLM/Event-Log-derived) with
 * a hard timeout and bounded output. Returns { ok: true, stdout } or
 * { ok: false, reason, detail } — never throws for an expected
 * operational failure (timeout, access denied, not found); only throws
 * for a genuine programming error (e.g. calling this on a non-Windows
 * platform, which callers should check via isWindows() first).
 */
// The Windows console's default codepage (often CP850/CP1252 on
// non-English installs, confirmed via manual probe on this dev box) is
// NOT UTF-8 — without forcing it, accented/non-ASCII characters in
// Event Log messages or Defender fields get corrupted into U+FFFD
// replacement characters before Node ever sees them. Every script is
// prefixed with this line so stdout is always emitted as UTF-8,
// matching execFileAsync's utf8 decode below.
const FORCE_UTF8_PREFIX = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ";

export async function runReadOnlyPowerShell(script, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isWindows()) {
    throw new Error('runReadOnlyPowerShell: Windows-only, caller must check isWindows() first');
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FORCE_UTF8_PREFIX + script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, shell: false, encoding: 'utf8' },
    );
    return { ok: true, stdout: stdout.slice(0, MAX_OUTPUT_BYTES), stderr: (stderr || '').slice(0, 4_000) };
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      return { ok: false, reason: 'timeout', detail: `exceeded ${timeoutMs}ms` };
    }
    // execFile's error carries stdout/stderr even on non-zero exit —
    // adapters need stderr text to extract a FullyQualifiedErrorId.
    return {
      ok: false,
      reason: 'exec_failed',
      detail: (err.stderr || err.message || '').slice(0, 4_000),
      stdout: (err.stdout || '').slice(0, MAX_OUTPUT_BYTES),
    };
  }
}
