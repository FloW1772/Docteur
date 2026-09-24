/**
 * RASSILON V1 Phase 2 — Windows user-idle-duration probe. Reports ONLY a
 * millisecond duration since last input (mission §12: "Seulement : idle
 * duration"); never captures keystroke content, mouse coordinates, or
 * any input data. Uses GetLastInputInfo (user32.dll) via a fixed,
 * Docteur-authored C# snippet compiled in-process by PowerShell's
 * Add-Type, run through the same safe-exec contract as every other
 * Windows probe in this codebase (execFile, shell:false, hard timeout,
 * bounded output — maitre-windows-exec.js's runReadOnlyPowerShell).
 *
 * GetLastInputInfo is session-scoped: it reports input only for the
 * interactive session this process runs in, which is exactly the
 * "is the machine's owner using it right now" signal RASSILON needs
 * (mission §12/§13).
 *
 * Cost note: Add-Type's C# compilation adds real overhead on top of the
 * baseline PowerShell cold-start (roughly 300-600ms per call, compilation-
 * dominated). This is NOT meant to be polled every few seconds — callers
 * should poll on the order of tens of seconds (rassilon-worker.js uses
 * this as a periodic safety-guard check, not a per-request check).
 */
import { isWindows, runReadOnlyPowerShell } from './maitre-windows-exec.js';

const PROBE_TIMEOUT_MS = 5_000;

// Fixed script — no user/job-supplied text is ever concatenated into
// this. Returns a bare millisecond integer (idle time since last input),
// never any input content.
const IDLE_PROBE_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Docteur {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }
  public static class IdleTime {
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")]
    public static extern uint GetTickCount();
    public static uint GetIdleMilliseconds() {
      LASTINPUTINFO lii = new LASTINPUTINFO();
      lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
      if (!GetLastInputInfo(ref lii)) { return 0; }
      return GetTickCount() - lii.dwTime;
    }
  }
}
'@ -Language CSharp

Write-Output ([Docteur.IdleTime]::GetIdleMilliseconds())
`.trim();

/**
 * @typedef {Object} IdleStatus
 * @property {number|null} idleMs - milliseconds since last input, or null if unavailable
 * @property {string} source
 */

/** @returns {Promise<IdleStatus>} */
export async function detectIdleStatus() {
  if (!isWindows()) {
    return { idleMs: null, source: 'unsupported_platform' };
  }

  const result = await runReadOnlyPowerShell(IDLE_PROBE_SCRIPT, { timeoutMs: PROBE_TIMEOUT_MS });
  if (!result.ok || !result.stdout.trim()) {
    return { idleMs: null, source: 'detection_failed' };
  }

  const idleMs = Number(result.stdout.trim());
  if (!Number.isFinite(idleMs) || idleMs < 0) {
    return { idleMs: null, source: 'detection_failed' };
  }
  return { idleMs, source: 'win32_getlastinputinfo' };
}
