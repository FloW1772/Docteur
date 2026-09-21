/**
 * Local hardware profile — detects CPU/RAM/GPU/disk for the fit engine.
 * Node-first (os.*), Windows-only best-effort GPU/VRAM/disk probing via a
 * fixed, read-only PowerShell script reusing MAÎTRE's existing safe-exec
 * helper (maitre-windows-exec.js) — shell:false, hard timeout, bounded
 * output, no LLM/user-supplied script text, per mission §20.
 *
 * Never sends this data anywhere (mission §17): no cloud, no catalog
 * provider, no GitHub, no Hugging Face, no FreeLLMAPI. Pure local read.
 *
 * No machine fingerprinting (mission §24): no serial numbers, no MAC
 * addresses, no persistent machine ID — only coarse capacity figures.
 */

import os from 'node:os';
import { isWindows, runReadOnlyPowerShell } from './maitre-windows-exec.js';

const GPU_PROBE_TIMEOUT_MS = 5_000;
const DISK_PROBE_TIMEOUT_MS = 5_000;

// Short in-process cache so repeated fit evaluations (e.g. rendering many
// catalog cards) don't re-invoke PowerShell per call — mission §45.
let cachedProfile = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/**
 * @typedef {Object} GpuInfo
 * @property {string} name
 * @property {string|null} vendor
 * @property {number|null} vramBytes
 * @property {string} source - e.g. "wmi", "unknown"
 */

/**
 * @typedef {Object} LocalHardwareProfile
 * @property {string} platform
 * @property {string} arch
 * @property {string|null} cpuModel
 * @property {number} logicalCores
 * @property {number} totalRamBytes
 * @property {number} freeRamBytes
 * @property {GpuInfo[]} gpus
 * @property {number|null} freeDiskBytes
 * @property {string|null} osVersion
 * @property {string} detectedAt - ISO timestamp
 */

function detectCpuRamBasics() {
  const cpus = os.cpus() || [];
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus.length > 0 ? cpus[0].model : null,
    logicalCores: cpus.length,
    totalRamBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    osVersion: `${os.release()}`,
  };
}

/**
 * Fixed, Docteur-authored read-only WMI query — never built from user/LLM
 * input, only literal text (mission §20). Emits one JSON line per GPU.
 */
const GPU_PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$gpus = Get-CimInstance -ClassName Win32_VideoController | Select-Object Name, AdapterCompatibility, AdapterRAM
$gpus | ForEach-Object {
  [PSCustomObject]@{
    name = $_.Name
    vendor = $_.AdapterCompatibility
    vramBytes = $_.AdapterRAM
  }
} | ConvertTo-Json -Compress
`.trim();

async function detectGpus() {
  if (!isWindows()) {
    return { gpus: [], source: 'unsupported_platform' };
  }
  const result = await runReadOnlyPowerShell(GPU_PROBE_SCRIPT, { timeoutMs: GPU_PROBE_TIMEOUT_MS });
  if (!result.ok || !result.stdout.trim()) {
    return { gpus: [], source: 'detection_failed' };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const gpus = rows
      .filter(row => row && typeof row === 'object' && row.name)
      .map(row => ({
        name: String(row.name),
        vendor: row.vendor ? String(row.vendor) : null,
        // AdapterRAM on modern GPUs (>4GB) can overflow WMI's 32-bit field
        // and report bogus small/negative values — treat non-positive or
        // suspiciously small results as unknown rather than lying to the
        // fit engine.
        vramBytes: typeof row.vramBytes === 'number' && row.vramBytes > 268_435_456 ? row.vramBytes : null,
        source: 'wmi',
      }));
    return { gpus, source: gpus.length > 0 ? 'wmi' : 'detection_failed' };
  } catch {
    return { gpus: [], source: 'detection_failed' };
  }
}

const DISK_PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$drive = Get-PSDrive -Name (Get-Location).Drive.Name
[PSCustomObject]@{ freeBytes = $drive.Free } | ConvertTo-Json -Compress
`.trim();

async function detectFreeDisk() {
  if (!isWindows()) {
    return null;
  }
  const result = await runReadOnlyPowerShell(DISK_PROBE_SCRIPT, { timeoutMs: DISK_PROBE_TIMEOUT_MS });
  if (!result.ok || !result.stdout.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return typeof parsed.freeBytes === 'number' && parsed.freeBytes >= 0 ? parsed.freeBytes : null;
  } catch {
    return null;
  }
}

/**
 * Detects the local hardware profile. Never throws — GPU/disk detection
 * failures degrade to UNKNOWN (empty gpus[] / null freeDiskBytes), never
 * crash the caller (mission §21).
 *
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<LocalHardwareProfile>}
 */
export async function detectLocalHardwareProfile(options = {}) {
  const { forceRefresh = false } = options;
  const now = Date.now();
  if (!forceRefresh && cachedProfile && now - cachedAt < CACHE_TTL_MS) {
    return cachedProfile;
  }

  const basics = detectCpuRamBasics();

  let gpuResult = { gpus: [], source: 'detection_failed' };
  let freeDiskBytes = null;
  try {
    [gpuResult, freeDiskBytes] = await Promise.all([detectGpus(), detectFreeDisk()]);
  } catch {
    // Defensive: detectGpus/detectFreeDisk already catch internally, but
    // never let an unexpected error here escape as a crash (mission §21).
  }

  const profile = Object.freeze({
    ...basics,
    gpus: Object.freeze(gpuResult.gpus),
    freeDiskBytes,
    detectedAt: new Date().toISOString(),
  });

  cachedProfile = profile;
  cachedAt = now;
  return profile;
}

/** Clears the short-lived cache — primarily for tests. */
export function clearHardwareProfileCache() {
  cachedProfile = null;
  cachedAt = 0;
}

/** Best-known total VRAM across all detected GPUs, or null if none known. */
export function getTotalVramBytes(profile) {
  const known = (profile.gpus || []).filter(g => typeof g.vramBytes === 'number');
  if (known.length === 0) return null;
  return known.reduce((sum, g) => sum + g.vramBytes, 0);
}
