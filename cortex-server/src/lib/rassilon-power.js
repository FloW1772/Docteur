/**
 * RASSILON V1 Phase 2 — Windows AC/battery status probe. Fixed, read-only
 * WMI query via MAÎTRE's existing safe-exec helper (maitre-windows-exec.js)
 * — same pattern as local-hardware-profile.js's GPU/disk probes:
 * execFile, shell:false, hard timeout, bounded output, no
 * user/LLM-derived script text (mission §11/§7).
 *
 * A desktop machine with no battery reports batteryStatus: NOT_PRESENT
 * and never blocks the worker on that basis (mission §11) — Win32_Battery
 * simply returns no rows, which this module treats as "no battery" rather
 * than an error.
 */
import { isWindows, runReadOnlyPowerShell } from './maitre-windows-exec.js';

const PROBE_TIMEOUT_MS = 5_000;

// BatteryStatus WMI enum: 1 = discharging (on battery), 2 = AC/plugged in
// (charging or fully charged with AC connected), 3-9 = various charging/
// critical/unknown states. We only need the discharging-vs-not distinction
// for pause-on-battery policy, so this maps the full enum down to a
// coarse onBattery boolean rather than exposing WMI's raw numeric code as
// if it were meaningful to a caller who hasn't memorized the enum.
const DISCHARGING_STATUS_CODES = new Set([1]);

const BATTERY_PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$battery = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining, BatteryStatus
if ($null -eq $battery) {
  [PSCustomObject]@{ present = $false } | ConvertTo-Json -Compress
} else {
  [PSCustomObject]@{
    present = $true
    percent = $battery.EstimatedChargeRemaining
    statusCode = $battery.BatteryStatus
  } | ConvertTo-Json -Compress
}
`.trim();

/**
 * @typedef {Object} PowerStatus
 * @property {'AC_ONLY'|'ON_BATTERY'|'NOT_PRESENT'|'UNKNOWN'} status
 * @property {number|null} batteryPercent
 * @property {string} source
 */

/** @returns {Promise<PowerStatus>} */
export async function detectPowerStatus() {
  if (!isWindows()) {
    return { status: 'UNKNOWN', batteryPercent: null, source: 'unsupported_platform' };
  }

  const result = await runReadOnlyPowerShell(BATTERY_PROBE_SCRIPT, { timeoutMs: PROBE_TIMEOUT_MS });
  if (!result.ok || !result.stdout.trim()) {
    return { status: 'UNKNOWN', batteryPercent: null, source: 'detection_failed' };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (!parsed.present) {
      return { status: 'NOT_PRESENT', batteryPercent: null, source: 'wmi' };
    }
    const percent = typeof parsed.percent === 'number' && parsed.percent >= 0 && parsed.percent <= 100 ? parsed.percent : null;
    const onBattery = DISCHARGING_STATUS_CODES.has(parsed.statusCode);
    return { status: onBattery ? 'ON_BATTERY' : 'AC_ONLY', batteryPercent: percent, source: 'wmi' };
  } catch {
    return { status: 'UNKNOWN', batteryPercent: null, source: 'detection_failed' };
  }
}
