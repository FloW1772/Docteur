/**
 * RASSILON V1 Phase 2 — scratch workspace: a strictly dedicated,
 * quota-bounded directory RASSILON jobs may write into (mission §25/§26/
 * §27). Phase 2's SAFE_CPU_TASK executor never actually writes files —
 * everything is in-process/in-memory — but the workspace and its path-
 * containment discipline are built now since the job-acceptance pipeline
 * and quota checks reference it, and a future executor (Phase 3+) must
 * not be able to introduce path-escape by construction.
 *
 * Path safety (mission §26): every path this module hands back is built
 * from a FIXED base directory plus a generated (never job-supplied)
 * segment, then canonicalized and containment-checked. Callers never
 * string-concatenate a job-supplied value into a path themselves.
 */
import fs from 'node:fs';
import path from 'node:path';

export class RassilonScratchError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'RassilonScratchError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new RassilonScratchError(code, detail);
}

let scratchRoot = null;

/** Must be called once at startup (mirrors initSqlite's explicit-init shape). Idempotent. */
export function initRassilonScratch(rootPath) {
  scratchRoot = path.resolve(rootPath);
  fs.mkdirSync(scratchRoot, { recursive: true });
  return scratchRoot;
}

export function getRassilonScratchRoot() {
  if (!scratchRoot) fail('scratch_not_initialized');
  return scratchRoot;
}

// Job ids are already validated upstream (rassilon-job-schema.js:
// /^[A-Za-z0-9_-]{8,128}$/) — this is a defensive second check so this
// module never trusts a caller skipped that validation, since a
// directory name built from an unvalidated jobId is exactly the kind of
// mistake path-traversal bugs come from.
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolves the scratch directory for one job, creating it if needed.
 * Refuses '..', absolute paths, UNC/drive paths, or any segment that
 * doesn't match SAFE_SEGMENT_PATTERN (mission §26) — jobId is the ONLY
 * caller-supplied input here, and it is validated, never path-joined
 * raw.
 */
export function getJobScratchDir(jobId) {
  const root = getRassilonScratchRoot();
  if (typeof jobId !== 'string' || !SAFE_SEGMENT_PATTERN.test(jobId)) fail('unsafe_job_id', { jobId });

  const candidate = path.resolve(root, jobId);
  const relative = path.relative(root, candidate);
  // path.relative returning something starting with '..' or being
  // absolute means the resolved path escaped the root — the containment
  // check mission §26 requires, applied generically rather than trusting
  // the regex alone.
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('scratch_path_escape', { jobId });

  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

/** Recursively sums file sizes under a directory; missing dir = 0. */
function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else if (entry.isFile()) {
      try { total += fs.statSync(full).size; } catch { /* file removed mid-scan */ }
    }
  }
  return total;
}

/** Total bytes currently used across the whole scratch root. */
export function getScratchUsageBytes() {
  const root = getRassilonScratchRoot();
  return dirSizeBytes(root);
}

/** Deterministic cleanup for one job's scratch dir (mission §27 — "après job : cleanup déterministe"). */
export function cleanupJobScratchDir(jobId) {
  const root = getRassilonScratchRoot();
  if (typeof jobId !== 'string' || !SAFE_SEGMENT_PATTERN.test(jobId)) return;
  const candidate = path.resolve(root, jobId);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return;
  fs.rmSync(candidate, { recursive: true, force: true });
}

/**
 * Boot-time sweep (mission §27 — "Crash : cleanup au prochain boot selon
 * policy"): removes every per-job subdirectory under the scratch root.
 * Called once at RASSILON worker startup, after crash-recovery has
 * already read whatever job metadata it needed from SQLite — this never
 * reads job content, it only deletes directories.
 */
export function sweepScratchOnBoot() {
  const root = getRassilonScratchRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_SEGMENT_PATTERN.test(entry.name)) continue;
    fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Test-only reset so each test file gets a clean scratchRoot binding. */
export function resetRassilonScratchForTests() {
  scratchRoot = null;
}
