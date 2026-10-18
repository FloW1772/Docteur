/**
 * MAÎTRE — shared Windows command-execution helper. Originally written
 * for MA-3's read-only adapters (maitre-defender-adapter.js,
 * maitre-eventlog-adapter.js); MA-9 also reuses it for the LEVEL 2
 * executor's mutating commands (Stop-Process, New-NetFirewallRule,
 * registry/task/service changes) — the function name is a historical
 * artifact of its first caller, not an enforced read-only boundary.
 * What actually makes every caller safe is unchanged either way: this
 * file only ever runs a FIXED, Docteur-authored PowerShell script text
 * passed in by the caller — it never accepts a user-, LLM-, OS-, or
 * Event-Log-derived string as the SCRIPT itself. Callers pass
 * textual data through a closed set of child-only environment slots;
 * no external text is interpolated into PowerShell source. This holds
 * identically whether the script reads a status or changes one.
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

// Closed schema: callers select a semantic slot, never an environment
// variable name. The reserved variables exist only in the spawned child.
export const POWERSHELL_DATA_ENV = Object.freeze({
  FILE_PATH: 'DOCTEUR_PS_DATA_FILE_PATH',
  SCAN_PATH: 'DOCTEUR_PS_DATA_SCAN_PATH',
  EVENT_LOG_CHANNEL: 'DOCTEUR_PS_DATA_EVENT_LOG_CHANNEL',
  REGISTRY_PATH: 'DOCTEUR_PS_DATA_REGISTRY_PATH',
  REGISTRY_VALUE_NAME: 'DOCTEUR_PS_DATA_REGISTRY_VALUE_NAME',
  TASK_PATH: 'DOCTEUR_PS_DATA_TASK_PATH',
  TASK_NAME: 'DOCTEUR_PS_DATA_TASK_NAME',
  SERVICE_NAME: 'DOCTEUR_PS_DATA_SERVICE_NAME',
  FIREWALL_RULE_NAME: 'DOCTEUR_PS_DATA_FIREWALL_RULE_NAME',
  FIREWALL_RULE_NAMES_JSON: 'DOCTEUR_PS_DATA_FIREWALL_RULE_NAMES_JSON',
  REMOTE_ADDRESS: 'DOCTEUR_PS_DATA_REMOTE_ADDRESS',
  LISTENER_HOST: 'DOCTEUR_PS_DATA_LISTENER_HOST',
});

const RESERVED_ENV_NAMES = new Set(Object.values(POWERSHELL_DATA_ENV).map(name => name.toUpperCase()));

function normalizePowerShellData(data) {
  if (data == null) return [];
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('runReadOnlyPowerShell: data must be an object');
  }

  return Object.entries(data).map(([slot, value]) => {
    const envName = POWERSHELL_DATA_ENV[slot];
    if (!envName) throw new TypeError(`runReadOnlyPowerShell: unsupported data slot ${slot}`);
    if (typeof value !== 'string') throw new TypeError(`runReadOnlyPowerShell: data slot ${slot} must be a string`);
    if (value.includes('\0')) throw new TypeError(`runReadOnlyPowerShell: data slot ${slot} contains NUL`);
    return { envName, value };
  });
}

export function buildPowerShellChildEnv(data = {}, parentEnv = process.env) {
  const entries = normalizePowerShellData(data);
  const childEnv = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (!RESERVED_ENV_NAMES.has(name.toUpperCase())) childEnv[name] = value;
  }
  for (const { envName, value } of entries) childEnv[envName] = value;
  return childEnv;
}

function redactDataValues(text, entries) {
  let redacted = String(text ?? '');
  const values = [...new Set(entries.map(entry => entry.value).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const value of values) redacted = redacted.split(value).join('[REDACTED]');
  return redacted;
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

export async function runReadOnlyPowerShell(script, { timeoutMs = DEFAULT_TIMEOUT_MS, data = {} } = {}) {
  if (!isWindows()) {
    throw new Error('runReadOnlyPowerShell: Windows-only, caller must check isWindows() first');
  }

  const dataEntries = normalizePowerShellData(data);
  const childEnv = buildPowerShellChildEnv(data);

  try {
    const { stdout, stderr } = await execFileAsync(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FORCE_UTF8_PREFIX + script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, shell: false, encoding: 'utf8', env: childEnv },
    );
    return {
      ok: true,
      stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
      stderr: redactDataValues(stderr, dataEntries).slice(0, 4_000),
    };
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      return { ok: false, reason: 'timeout', detail: `exceeded ${timeoutMs}ms` };
    }
    // execFile's error carries stdout/stderr even on non-zero exit —
    // adapters need stderr text to extract a FullyQualifiedErrorId.
    return {
      ok: false,
      reason: 'exec_failed',
      detail: redactDataValues(err.stderr || err.message, dataEntries).slice(0, 4_000),
      stdout: redactDataValues(err.stdout, dataEntries).slice(0, MAX_OUTPUT_BYTES),
    };
  }
}
