/**
 * RASSILON V1 Phase 2 — live CPU/RAM telemetry and admission/execution
 * resource checks. Node built-ins only (os.*, process.*) — no new
 * dependency, no WMI (mission §7 — "Préférer Node OS APIs").
 *
 * Distinguishes explicitly (mission §8):
 *   - SOFT resource guard: sampled usage checked periodically, job
 *     paused/cancelled if it stays over budget — what this module
 *     implements.
 *   - HARD OS limit: a kernel-enforced ceiling (cgroups-equivalent) that
 *     Windows has no clean, dependency-free equivalent of for an
 *     arbitrary Node process. NOT implemented — never claimed as
 *     implemented. CPU quota enforcement is reported as PARTIAL in the
 *     Phase 2 report for exactly this reason (mission §9).
 *
 * System-wide CPU%: standard os.cpus() two-snapshot delta — sum each
 * core's busy ticks (user+nice+sys+irq) and total ticks (busy+idle)
 * across both snapshots, %busy = busyDelta/totalDelta*100. A single
 * os.cpus() snapshot is meaningless (cumulative since boot); this always
 * takes two snapshots across a short window.
 *
 * Process-own CPU%: process.cpuUsage() delta (microseconds of user+system
 * time consumed by THIS Node process) divided by wall-clock elapsed time
 * and by logical core count, expressed as % of one core's worth of
 * capacity relative to the elapsed window.
 */
import os from 'node:os';

const SAMPLE_WINDOW_MS = 200;

function sampleCpuTicks() {
  return os.cpus().map(cpu => ({
    busy: cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq,
    total: cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle,
  }));
}

function diffCpuPercent(before, after) {
  let busyDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < before.length; i++) {
    busyDelta += after[i].busy - before[i].busy;
    totalDelta += after[i].total - before[i].total;
  }
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (busyDelta / totalDelta) * 100));
}

/**
 * Samples system-wide CPU utilization over a short window (default
 * 200ms). Returns a percentage 0-100. Windows caveat (documented, not
 * silently assumed accurate): os.cpus() tick granularity/consistency
 * across logical (hyperthreaded) cores can be coarser on Windows than on
 * Linux — treated as an indicative signal for the pause/admission
 * threshold, not a precise measurement.
 */
export async function sampleSystemCpuPercent({ windowMs = SAMPLE_WINDOW_MS } = {}) {
  const before = sampleCpuTicks();
  await new Promise(resolve => setTimeout(resolve, windowMs));
  const after = sampleCpuTicks();
  return diffCpuPercent(before, after);
}

/**
 * Percent of one logical core's worth of capacity consumed by THIS
 * process over the given window (process.cpuUsage() delta / windowMs,
 * normalized to a single core — NOT divided by core count, since a
 * single-threaded Node computation can only ever occupy one core
 * regardless of how many the machine has, and the job's own
 * maxCpuPercent budget is meant to bound that one core's worth of
 * consumption).
 */
export async function sampleProcessCpuPercent({ windowMs = SAMPLE_WINDOW_MS } = {}) {
  const before = process.cpuUsage();
  await new Promise(resolve => setTimeout(resolve, windowMs));
  const after = process.cpuUsage(before);
  const busyUs = after.user + after.system;
  const windowUs = windowMs * 1000;
  if (windowUs <= 0) return 0;
  return Math.max(0, Math.min(100, (busyUs / windowUs) * 100));
}

/**
 * Telemetry-failure fail-safe (mission §42 Phase 3): os.totalmem()/
 * os.freemem() are Node built-ins that don't realistically throw, but
 * this function still never lets an unexpected error escape as a crash —
 * on failure it returns `available: false` rather than fabricating a
 * plausible-looking RAM reading. Callers that gate a decision on RAM
 * pressure treat `available: false` conservatively (see
 * rassilon-worker.js's runSafetyGuardSweep: telemetry failure does NOT
 * silently let a big job proceed as if no data meant "all clear" —
 * admission checks that need a real reading fail closed instead).
 */
export function getSystemRamStatus() {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    return { available: true, totalBytes: total, freeBytes: free, usedPercent: total > 0 ? ((total - free) / total) * 100 : 0 };
  } catch {
    return { available: false, totalBytes: 0, freeBytes: 0, usedPercent: 0 };
  }
}

export function getProcessRamMb() {
  return process.memoryUsage().rss / (1024 * 1024);
}

/**
 * Admission check (mission §8/§10 — before a job starts): does the job's
 * declared resourceBudget fit within policy AND is there currently
 * enough free system RAM to accept it. Never inspects live CPU here —
 * CPU admission is budget-vs-policy only (mission §32's acceptance
 * pipeline checks quota fit, not a live sample, since a live CPU sample
 * at admission time is noisy and not predictive of what the job itself
 * will consume).
 */
export function checkAdmission({ resourceBudget, settings, systemRam = getSystemRamStatus() }) {
  const reasons = [];
  if (resourceBudget.cpuPercent > settings.maxCpuPercent) reasons.push('cpu_budget_exceeds_policy');
  if (resourceBudget.ramMb > settings.maxRamMb) reasons.push('ram_budget_exceeds_policy');
  if (resourceBudget.maxDurationSec > settings.maxJobDurationSec) reasons.push('duration_budget_exceeds_policy');

  // Telemetry-failure fail-safe (mission §42): if RAM telemetry is
  // unavailable, admission is refused rather than assuming "plenty of
  // free RAM" — a job is never admitted on the strength of missing data.
  if (systemRam.available === false) {
    reasons.push('ram_telemetry_unavailable');
  } else {
    // Reserve at least the job's declared RAM budget plus a fixed safety
    // margin (64MB) out of currently-free system RAM — a soft guard, not
    // a guarantee against a concurrent spike from elsewhere on the machine.
    const SAFETY_MARGIN_MB = 64;
    const freeMb = systemRam.freeBytes / (1024 * 1024);
    if (freeMb < resourceBudget.ramMb + SAFETY_MARGIN_MB) reasons.push('insufficient_free_ram');
  }

  return { admitted: reasons.length === 0, reasons };
}

/**
 * Mid-execution guard (mission §8/§10): called periodically while a job
 * runs. Returns { withinBudget, reason } — 'ram_over_budget' if this
 * process's own RSS has grown past the job's declared ramMb (a soft
 * signal, since RSS is whole-process, not job-scoped, per this module's
 * header note on that limitation), or null.
 */
export function checkRuntimeBudget({ resourceBudget, processRamMb = getProcessRamMb() }) {
  if (processRamMb > resourceBudget.ramMb) {
    return { withinBudget: false, reason: 'ram_over_budget' };
  }
  return { withinBudget: true, reason: null };
}
