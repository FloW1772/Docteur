/**
 * OMEGA V1 Phase 3 — OMEGA-owned safe PowerShell execution helper.
 *
 * This deliberately mirrors maitre-windows-exec.js's exact safe-process-
 * execution discipline (absolute executable path, fixed args array,
 * shell:false, windowsHide, bounded stdout/stderr, hard timeout) rather
 * than importing that file directly. Per the mission's own instruction
 * ("your call, document which you did and why"): a fresh, OMEGA-owned
 * equivalent was built instead of reusing maitre-windows-exec.js's
 * runReadOnlyPowerShell() because:
 *   1. Module-boundary hygiene — OMEGA is a fully separate authorization
 *      domain from MAÎTRE (mission §43, carried over from Phase 1/2's own
 *      "zero imports from or calls into any maitre-*.js file" rule,
 *      applied here to non-approval code too for consistency and to keep
 *      a future MAÎTRE-side change from silently affecting OMEGA).
 *   2. OMEGA's capture invocation needs a materially different shape:
 *      it runs a FIXED SCRIPT FILE (-File, not -Command with inlined
 *      script text) with ONLY numeric/enum positional arguments (screen
 *      index, output path), never interpolated text of any kind — an
 *      even narrower invocation surface than maitre-windows-exec.js's
 *      toPsSingleQuotedLiteral()-escaped string literals, so it did not
 *      need that helper's string-literal-escaping machinery at all.
 *
 * shell:false always. Every call has a hard timeout and a bounded
 * stdout/stderr buffer. Non-Windows platforms short-circuit before ever
 * touching child_process. No dependency added — child_process is a Node
 * built-in.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export const DEFAULT_TIMEOUT_MS = 6_000;
export const MAX_OUTPUT_BYTES = 12 * 1024 * 1024; // 12 MB — bounds a single PNG frame read via stdout-adjacent path (frames are read from disk, this only bounds stdout/stderr text)

export function isWindows() {
  return process.platform === 'win32';
}

/**
 * Runs a FIXED, repo-shipped .ps1 script file (never inline user/LLM-
 * derived script text) with a bounded list of purely numeric/string
 * ENUM positional arguments — no string is ever concatenated into a
 * script body. Returns { ok: true, stdout, stderr } or
 * { ok: false, reason, detail } — never throws for an expected
 * operational failure (timeout, access denied, not found); only throws
 * for a genuine programming error (e.g. calling this on a non-Windows
 * platform — callers must check isWindows() first).
 */
export async function runFixedPowerShellScript(scriptPath, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isWindows()) {
    throw new Error('runFixedPowerShellScript: Windows-only, caller must check isWindows() first');
  }
  if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath)) {
    throw new Error('runFixedPowerShellScript: scriptPath must be an absolute path');
  }
  // Every arg must be a plain string/number with no shell/PowerShell
  // metacharacters — this is a defense-in-depth belt (execFile with
  // shell:false already prevents shell injection structurally; this
  // additionally stops a caller from smuggling PowerShell-meaningful
  // characters into what should always be a numeric/enum argument).
  const safeArgs = args.map((a) => {
    const s = String(a);
    if (!/^[A-Za-z0-9_.:\\/-]{1,260}$/.test(s)) {
      throw new Error(`runFixedPowerShellScript: unsafe argument rejected: ${JSON.stringify(a)}`);
    }
    return s;
  });

  try {
    const { stdout, stderr } = await execFileAsync(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, ...safeArgs],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, shell: false, encoding: 'utf8' },
    );
    return { ok: true, stdout: stdout.slice(0, MAX_OUTPUT_BYTES), stderr: (stderr || '').slice(0, 4_000) };
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      return { ok: false, reason: 'timeout', detail: `exceeded ${timeoutMs}ms` };
    }
    return {
      ok: false,
      reason: 'exec_failed',
      detail: (err.stderr || err.message || '').slice(0, 4_000),
      stdout: (err.stdout || '').slice(0, MAX_OUTPUT_BYTES),
    };
  }
}
