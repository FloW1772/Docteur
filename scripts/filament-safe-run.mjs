// [ARCADE-SAFETY V2 2026-10-23] Supervised launcher for Filament lab scripts (Windows-first, no dependency).
//
//   node scripts/filament-safe-run.mjs <approved script>       e.g. scripts/test-filament-lab-guards.mjs
//   node scripts/filament-safe-run.mjs --clear-stale-lock      (only removes a lock whose owner process is gone)
//
// Development rule (Arcade): every test command is short, verifiable, non-recursive and supervised — a direct `node`
// call with explicit arguments, no shell function, no complex pipeline, nothing detached, no launch loop, no retry.
//
// Why: a level-design session ended in a Windows crash (BSOD 0xEF). This launcher provides what in-process checks
// cannot:
//   * ONLY scripts listed in APPROVED_SCRIPTS, and only if their whole local import graph passes a static check:
//     node: builtins from a short allowlist, relative files inside the repository, no package, no URL, no dynamic
//     import, no CommonJS loader, no process/thread/network API names, and physics.ts reachable only through
//     scripts/filament-lab-lib.mjs. This is a static filter, not an isolation boundary (no Windows Job Object: Node
//     has no API for it and no native dependency is added), so the first validation must not need any descendant.
//   * exactly ONE child: process.execPath, shell: false, not detached, no retry, V8 heap capped with
//     --max-old-space-size (a heap cap, NOT a cap on total process memory)
//   * supervision capability: a random per-run nonce goes to the child (FILAMENT_LAB_SESSION); the lock file holds
//     only its SHA-256 and this launcher's PID. The lab accepts the session only when both match and the lock owner is
//     its parent. Nothing is stored in the repository.
//   * memory watchdog, FAIL-CLOSED: a preflight measurement of this launcher's own PID must succeed before any spawn;
//     the child is measured as soon as it has a PID, then every MEMORY_POLL_MS (one tasklist call in flight at a
//     time). Any unreadable, ambiguous or failed measurement of a live child stops it
//     (FILAMENT_MEMORY_MONITOR_UNAVAILABLE, exit 8). Above RSS_LIMIT_BYTES the child is stopped (exit 4).
//   * [V3] start handshake: the child is always scripts/filament-lab-bootstrap.mjs (pinned by BOOTSTRAP_SHA256), with
//     an IPC channel. The bootstrap imports nothing of the approved script until this launcher has (a) received its
//     READY message for this exact PID and (b) obtained a valid tasklist measurement of that PID; only then is ONE
//     start signal sent over this child's own channel { type, v, pid, sessionHash, measuredAt, startupRssKB }. The
//     bootstrap then closes the channel and imports the approved script. The wait counts in HARD_LIMIT_MS. A child
//     that ends without having been started exits 13 (never 0); a refused send exits 14; any unexpected message
//     exits 15. Memory evidence is reported separately: launcher preflight / child at startup (before any assertion)
//     / child during the run (only if a measurement actually happened then).
//   * independent wall-clock limit for the child (HARD_LIMIT_MS) and an absolute limit for the launcher itself
//     (LAUNCHER_MAX_MS) after which it releases its lock and exits, whatever the child does
//   * termination only through the ChildProcess handle this launcher owns (child.kill → TerminateProcess on that
//     handle): no name-based kill (never `taskkill /IM …`), no other process, no escalation
//   * one supervised run per machine: exclusive lock file under .tmp/filament-lab/ (flag 'wx'); a second launcher is
//     refused, never queued; a stale lock is removed only by --clear-stale-lock when its owner is gone
//   * child output capped (OUTPUT_CAP_BYTES per stream); the outcome is always a distinct exit code:
//       child's own code (0 only after a measured start) · 3 time limit · 4 memory limit · 5 lock busy ·
//       6 termination unconfirmed · 7 refused · 8 memory monitor unavailable · 9 launcher deadline ·
//       10 interrupted (Ctrl+C) · 11 completed without any memory measurement · 12 spawn failed ·
//       13 child ended without being started · 14 start signal could not be sent · 15 protocol violation
//     (the bootstrap itself exits 20 invalid/stale start · 21 start wait expired · 22 launcher gone before start ·
//      23 bad invocation — all before the approved script is imported)
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARD_LIMIT_MS = 10_000;
export const LAUNCHER_MAX_MS = 15_000;
export const RSS_LIMIT_BYTES = 350 * 1024 * 1024;
export const HEAP_LIMIT_MB = 128;
export const MEMORY_POLL_MS = 700;
export const TASKLIST_TIMEOUT_MS = 1500;
export const KILL_CONFIRM_MS = 2000;
export const OUTPUT_CAP_BYTES = 64 * 1024;
// [ARCADE-SAFE-REPLAY 2026-10-23] + one fixed replay of one known solution (1 candidate, ≤ 600 steps, no argument)
// [ARCADE-SAFE-WATCHDOG 2026-10-23] + one passive idle target (one timer, no import) to check the time limit
// [ARCADE-SAFE-REPLAY CH1-B 2026-10-23] + one fixed replay of the known CH1-B solution (1 candidate, ≤ 600 steps)
// [FILAMENT-2 2026-10-23] + constructive design of 4 chapter-1 levels (fixed plan, no grid search, ≈ 180 candidates)
//   and the replay of the whole chapter's reference solutions (one candidate per level)
// [FILAMENT-4 CH2-A 2026-10-23] + single calibration of CH2-A only (2 trajectories max, ≤ 600 steps each, 1 200 total);
//   the global chapter-2 design script stays NOT approved
// [FILAMENT-4 CH2 SEQUENTIAL 2026-10-23] + one dedicated per-level calibration at a time (same bounds), added just
//   before its single run; the shared module scripts/filament-calibrate-ch2-common.mjs is never approved by itself
// [FILAMENT-4 CH2-C v2 2026-10-23] scripts/filament-calibrate-ch2-c-v2.mjs (one candidate correction of CH2-C) was
//   approved for its single run (exit 33, inconclusive), then removed again; scripts/filament-calibrate-ch2-c.mjs too
// [FILAMENT-4 CH2-C v3 2026-10-23] + ONE candidate correction of CH2-C (crystal ramp descending right; same bounds)
// [FILAMENT-4 CH2-D/E 2026-10-23] + the dedicated CH2-D, then CH2-E calibration, each added just before its single run
// [FILAMENT-4 CH2-F v3 2026-10-23] + ONE redesign test of CH2-F (≤ 3 trajectories, ≤ 600 steps each, ≤ 1 800 total)
// [FILAMENT-5 CH3 2026-10-23] + one dedicated chapter-3 calibration at a time, added just before its single run
//   (the shared module scripts/filament-calibrate-ch3-common.mjs is never approved by itself);
//   scripts/filament-calibrate-ch3-e.mjs was approved for its single run (2026-10-24, exit 33, inconclusive), then removed;
//   scripts/filament-calibrate-ch3-e-v2.mjs (fan-column redesign V2) added just before its single run
// [FILAMENT-6 CH4 2026-10-24] chapter 4, strictly sequential: one dedicated script added just before its single run
export const APPROVED_SCRIPTS = Object.freeze(['scripts/test-filament-lab-guards.mjs', 'scripts/filament-single-replay.mjs', 'scripts/test-filament-watchdog-idle.mjs', 'scripts/filament-replay-ch1-b.mjs', 'scripts/filament-design-ch1-extension.mjs', 'scripts/filament-verify-chapter1.mjs', 'scripts/filament-calibrate-ch2-a.mjs', 'scripts/filament-calibrate-ch2-b.mjs', 'scripts/filament-calibrate-ch2-c-v3.mjs', 'scripts/filament-calibrate-ch2-d.mjs', 'scripts/filament-calibrate-ch2-e.mjs', 'scripts/filament-calibrate-ch2-f-v3.mjs', 'scripts/filament-calibrate-ch3-a.mjs', 'scripts/filament-calibrate-ch3-b.mjs', 'scripts/filament-calibrate-ch3-c-v3.mjs', 'scripts/filament-calibrate-ch3-d-v2.mjs', 'scripts/filament-calibrate-ch3-e-v2.mjs', 'scripts/filament-calibrate-ch4-a.mjs', 'scripts/filament-calibrate-ch4-b.mjs', 'scripts/filament-calibrate-ch4-c.mjs', 'scripts/filament-calibrate-ch4-d.mjs', 'scripts/filament-calibrate-ch4-e.mjs']);
export const EXIT = Object.freeze({
  TIME_LIMIT: 3, MEMORY_LIMIT: 4, LOCK_BUSY: 5, TERMINATION_UNCONFIRMED: 6, REFUSED: 7, MEMORY_MONITOR_UNAVAILABLE: 8,
  LAUNCHER_DEADLINE: 9, INTERRUPTED: 10, NOT_MEASURED: 11, SPAWN_FAILED: 12, NOT_STARTED: 13, START_SIGNAL_FAILED: 14,
  PROTOCOL_VIOLATION: 15,
});
/** [V3] The only file ever spawned; pinned by hash (update this constant only after reviewing a bootstrap change). */
export const BOOTSTRAP = 'scripts/filament-lab-bootstrap.mjs';
export const BOOTSTRAP_SHA256 = '633be06b38df96877104bc7d8a1383d4a7cce783f456954f65d5527ddd8fbc6b';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_DIR = path.join(ROOT, '.tmp', 'filament-lab');
const LOCK_FILE = path.join(LOCK_DIR, 'run.lock');
const BOOTSTRAP_FILE = path.join(ROOT, BOOTSTRAP);
const ALLOWED_BUILTINS = new Set(['node:test', 'node:assert', 'node:assert/strict', 'node:fs', 'node:path', 'node:url', 'node:crypto']);
const PHYSICS = 'src/arcade/filament/physics.ts';
const PHYSICS_IMPORTERS = new Set(['scripts/filament-lab-lib.mjs']);
const FORBIDDEN_TEXT = /child_process|worker_threads|node:cluster|['"]cluster['"]|\bexecSync\b|\bspawnSync\b|\bshell\s*:|process\.binding|process\.dlopen|createRequire|\brequire\s*\(|\bimport\s*\(|node:(?:net|http|https|http2|dgram|inspector|vm|tls|dns)\b/;
const SPECIFIER = /\b(?:from|import)\s*['"]([^'"\n]+)['"]/g;
const MAX_GRAPH_FILES = 16;
const MAX_FILE_BYTES = 512 * 1024;
/** Absolute path (no PATH lookup) of the Windows process lister used by the memory watchdog. */
const TASKLIST = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tasklist.exe');
/** The child runs this same Node binary, so this launcher and its child share one image name. */
const NODE_IMAGE = path.basename(process.execPath);

const log = (event, details = {}) => process.stderr.write(`${JSON.stringify({ launcher: 'filament-safe-run', event, ...details })}\n`);
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

// ── lock ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}

/** Exclusive lock (flag 'wx'): fails if any lock file exists, alive or stale. */
function acquireLock(sessionHash) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), sessionHash }), { flag: 'wx' });
    return true;
  } catch {
    const lock = readLock();
    const alive = pidAlive(lock?.pid);
    log('LOCK_BUSY', { owner: lock?.pid ?? null, ownerAlive: alive, hint: alive ? 'wait for the other run to finish' : 'stale lock: run with --clear-stale-lock' });
    return false;
  }
}

function releaseLock() {
  const lock = readLock();
  if (lock?.pid === process.pid) { try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ } }
}

function clearStaleLock() {
  const lock = readLock();
  if (!lock) { log('NO_LOCK'); return 0; }
  if (pidAlive(lock.pid)) { log('LOCK_OWNER_ALIVE', { owner: lock.pid }); return EXIT.LOCK_BUSY; }
  fs.unlinkSync(LOCK_FILE);
  log('STALE_LOCK_CLEARED', { owner: lock.pid });
  return 0;
}

// ── script approval: allowlist + static import-graph check ───────────────────────────────────────────────────────
/** Returns { ok, file, graph } or { ok: false, reason }. Reads files only; executes nothing. */
export function checkScript(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return { ok: false, reason: 'missing script argument' };
  const file = path.resolve(ROOT, raw);
  const relative = rel(file);
  if (!APPROVED_SCRIPTS.includes(relative)) return { ok: false, reason: `not an approved script: ${relative.slice(0, 120)}` };
  const seen = new Set();
  const queue = [file];
  while (queue.length > 0) {
    const current = queue.shift();
    const name = rel(current);
    if (seen.has(name)) continue;
    seen.add(name);
    if (seen.size > MAX_GRAPH_FILES) return { ok: false, reason: `import graph larger than ${MAX_GRAPH_FILES} files` };
    if (name.startsWith('..') || path.isAbsolute(name)) return { ok: false, reason: `outside the repository: ${name.slice(0, 120)}` };
    let text;
    try {
      const stat = fs.statSync(current);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { ok: false, reason: `not a small regular file: ${name}` };
      text = fs.readFileSync(current, 'utf8');
    } catch {
      return { ok: false, reason: `not readable: ${name}` };
    }
    if (FORBIDDEN_TEXT.test(text)) return { ok: false, reason: `forbidden API name in ${name}` };
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match[1];
      if (spec.startsWith('node:')) {
        if (!ALLOWED_BUILTINS.has(spec)) return { ok: false, reason: `builtin not allowed: ${spec} in ${name}` };
        continue;
      }
      if (!spec.startsWith('./') && !spec.startsWith('../')) return { ok: false, reason: `only relative or node: imports are allowed (${spec.slice(0, 80)} in ${name})` };
      const target = path.resolve(path.dirname(current), spec);
      const targetName = rel(target);
      if (targetName.startsWith('..') || path.isAbsolute(targetName)) return { ok: false, reason: `import leaves the repository: ${spec} in ${name}` };
      if (!/\.(mjs|js|ts)$/.test(targetName)) return { ok: false, reason: `unsupported import: ${targetName}` };
      if (targetName === PHYSICS && !PHYSICS_IMPORTERS.has(name)) return { ok: false, reason: `${name} may not import the physics engine directly` };
      queue.push(target);
    }
  }
  return { ok: true, file, graph: [...seen] };
}

// ── memory measurement (tasklist, fail-closed parsing) ──────────────────────────────────────────────────────────
/** Strict CSV row parser for one tasklist line: every field quoted, "" as an escaped quote. */
function parseCsvRow(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') return null;
    let value = '';
    i += 1;
    for (;;) {
      if (i >= line.length) return null;
      if (line[i] === '"') {
        if (line[i + 1] === '"') { value += '"'; i += 2; continue; }
        i += 1;
        break;
      }
      value += line[i];
      i += 1;
    }
    fields.push(value);
    if (i === line.length) break;
    if (line[i] !== ',') return null;
    i += 1;
  }
  return fields;
}

/**
 * Interprets `tasklist /FI "PID eq <pid>" /FO CSV /NH` output (decoded byte-for-byte as latin1, so a code-page
 * NBSP thousands separator stays one non-digit character). Expected row: "node.exe","<pid>","<session>","<n>","<mem>".
 * Memory = integer kilobytes, either plain digits or groups of exactly 3 digits separated by 1–3 non-digit,
 * non-ASCII-letter characters (space, NBSP in any code page, comma, dot, apostrophe), then a unit K / KB / Ko.
 * Anything else is a failure, never a guess. Returns { kind: 'ok', bytes } | { kind: 'no-row' } | { kind: 'fail', reason }.
 */
export function parseTasklistMemory(output, pid, image = NODE_IMAGE) {
  const lines = String(output).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { kind: 'fail', reason: 'EMPTY_OUTPUT' };
  const rows = lines.filter(l => l.startsWith('"'));
  if (rows.length === 0) return { kind: 'no-row' };
  if (rows.length > 1) return { kind: 'fail', reason: 'MULTIPLE_ROWS' };
  const fields = parseCsvRow(rows[0]);
  if (!fields || fields.length !== 5) return { kind: 'fail', reason: 'UNEXPECTED_COLUMNS' };
  if (typeof image !== 'string' || fields[0].toLowerCase() !== image.toLowerCase()) return { kind: 'fail', reason: 'IMAGE_MISMATCH' };
  if (fields[1] !== String(pid)) return { kind: 'fail', reason: 'PID_MISMATCH' };
  const m = /^(\d+|\d{1,3}(?:[^\dA-Za-z]{1,3}\d{3})+)\s*([A-Za-z]+)$/.exec(fields[4].trim());
  if (!m) return { kind: 'fail', reason: 'UNREADABLE_MEMORY_FIELD' };
  if (!['K', 'KB', 'KO'].includes(m[2].toUpperCase())) return { kind: 'fail', reason: 'UNKNOWN_UNIT' };
  const kb = Number(m[1].replace(/\D/g, ''));
  if (!Number.isSafeInteger(kb) || kb < 1024 || kb > 64 * 1024 * 1024) return { kind: 'fail', reason: 'IMPLAUSIBLE_VALUE' };
  return { kind: 'ok', bytes: kb * 1024 };
}

/** One measurement of exactly `pid` (no shell, bounded by TASKLIST_TIMEOUT_MS). */
function measure(pid) {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) { resolve({ kind: 'fail', reason: 'NO_PID' }); return; }
    execFile(TASKLIST, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: TASKLIST_TIMEOUT_MS, windowsHide: true, encoding: 'latin1', maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) { resolve({ kind: 'fail', reason: `TASKLIST_ERROR_${String(error.code ?? error.signal ?? 'UNKNOWN').slice(0, 24)}` }); return; }
      resolve(parseTasklistMemory(stdout, pid));
    });
  });
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────
let activeChild = null;
let childExited = false;

/** [V3] The bootstrap must be byte-identical to the reviewed version (BOOTSTRAP_SHA256). */
function checkBootstrap() {
  try {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(BOOTSTRAP_FILE)).digest('hex');
    return hash === BOOTSTRAP_SHA256 ? { ok: true } : { ok: false, reason: 'the bootstrap differs from the reviewed version (BOOTSTRAP_SHA256)' };
  } catch {
    return { ok: false, reason: 'bootstrap not readable' };
  }
}

async function main(argv) {
  if (argv[0] === '--clear-stale-lock') return argv.length === 1 ? clearStaleLock() : EXIT.REFUSED;
  if (process.env.FILAMENT_LAB_SESSION) { log('REFUSED', { reason: 'nested launcher' }); return EXIT.REFUSED; }
  if (argv.length !== 1) { log('REFUSED', { reason: 'exactly one argument: the approved script (no extra arguments)' }); return EXIT.REFUSED; }
  const script = checkScript(argv[0]);
  if (!script.ok) { log('REFUSED', { reason: script.reason }); return EXIT.REFUSED; }
  const boot = checkBootstrap();
  if (!boot.ok) { log('REFUSED', { reason: boot.reason }); return EXIT.REFUSED; }
  log('APPROVED', { script: rel(script.file), graph: script.graph, bootstrap: BOOTSTRAP });
  const nonce = crypto.randomBytes(32).toString('hex');
  const sessionHash = crypto.createHash('sha256').update(nonce).digest('hex');
  if (!acquireLock(sessionHash)) return EXIT.LOCK_BUSY;
  try {
    // preflight: the measurement path must work on a known node.exe (this launcher) before anything is spawned
    const self = await measure(process.pid);
    if (self.kind !== 'ok') {
      log('FILAMENT_MEMORY_MONITOR_UNAVAILABLE', { stage: 'preflight', reason: self.kind === 'fail' ? self.reason : 'NO_ROW_FOR_LAUNCHER' });
      return EXIT.MEMORY_MONITOR_UNAVAILABLE;
    }
    log('MONITOR_READY', { evidence: 'LAUNCHER_PREFLIGHT_MEMORY_MEASURED', launcherRssMB: Math.round(self.bytes / 1048576) });
    return await supervise(script.file, nonce, sessionHash, Math.round(self.bytes / 1024));
  } finally {
    releaseLock();
  }
}

function supervise(file, nonce, sessionHash, launcherRssKB) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const env = { ...process.env, FILAMENT_LAB_SESSION: nonce };
    delete env.FILAMENT_LAB_SUPERVISED; // v1 flag: no longer meaningful anywhere
    // the only spawned file is the pinned bootstrap; the approved script is its argument, imported after the start signal
    const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_LIMIT_MB}`, '--experimental-strip-types', '--no-warnings', BOOTSTRAP_FILE, rel(file)], {
      cwd: ROOT, shell: false, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env,
    });
    activeChild = child;
    let exited = false, verdict = null, monitorFailure = null, polling = false, finished = false, poll = null, confirm = null;
    let ready = false, startSent = false, lastStartupSampleAt = 0;
    const mem = { startupSamples: 0, startupPeak: 0, startupFirst: 0, runtimeSamples: 0, runtimePeak: 0 };
    const mb = (bytes) => Math.round(bytes / 1048576);
    /** Separate evidence: launcher preflight / child before any assertion / child while the approved script ran. */
    const evidence = () => ({
      // never "MEASURED" alone: says WHEN the child was measured (startup only ≠ the run's peak)
      memoryStatus: monitorFailure ? 'MONITOR_FAILED'
        : mem.runtimeSamples > 0 ? (mem.startupSamples > 0 ? 'STARTUP_AND_RUNTIME_MEASURED' : 'RUNTIME_ONLY_MEASURED')
          : mem.startupSamples > 0 ? 'STARTUP_ONLY_MEASURED' : 'NOT_MEASURED',
      launcherPreflight: { status: 'LAUNCHER_PREFLIGHT_MEMORY_MEASURED', rssMB: Math.round(launcherRssKB / 1024) },
      childStartup: mem.startupSamples
        ? { status: 'CHILD_STARTUP_MEMORY_MEASURED', samples: mem.startupSamples, peakMB: mb(mem.startupPeak) }
        : { status: 'CHILD_STARTUP_MEMORY_NOT_MEASURED', samples: 0, peakMB: null },
      childRuntime: mem.runtimeSamples
        ? { status: 'CHILD_RUNTIME_MEMORY_MEASURED', samples: mem.runtimeSamples, peakMB: mb(mem.runtimePeak) }
        : { status: 'CHILD_RUNTIME_MEMORY_NOT_OBSERVED', samples: 0, peakMB: null },
      ...(monitorFailure ? { monitor: { status: 'MEMORY_MONITOR_FAILED', reason: monitorFailure } } : {}),
      started: startSent,
    });

    const forward = (stream, target) => {
      let sent = 0, truncated = false;
      stream.on('data', (chunk) => {
        if (sent >= OUTPUT_CAP_BYTES) { if (!truncated) { truncated = true; log('OUTPUT_TRUNCATED', { capBytes: OUTPUT_CAP_BYTES }); } return; }
        const part = chunk.subarray(0, OUTPUT_CAP_BYTES - sent);
        sent += part.length;
        target.write(part);
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);

    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(hard);
      if (poll) clearInterval(poll);
      if (confirm) clearTimeout(confirm);
      // termination not confirmed: detach our pipes and channel so this launcher itself never hangs on them
      if (!exited) { child.stdout?.destroy(); child.stderr?.destroy(); if (child.connected) child.disconnect(); child.unref(); }
      log('FINISHED', { pid: child.pid ?? null, exitCode: code, verdict: verdict ?? 'EXITED', elapsedMs: elapsed(), ...evidence() });
      resolve(code);
    };
    const stop = (reason) => {
      if (exited || verdict || finished) return;
      verdict = reason;
      log('STOPPING', { pid: child.pid, reason, elapsedMs: elapsed(), ...evidence() });
      child.kill(); // TerminateProcess on the handle this launcher owns
      // kept referenced on purpose: even if the child's pipes are already closed, this bounded wait still fires
      confirm = setTimeout(() => {
        if (!exited) { log('TERMINATION_UNCONFIRMED', { pid: child.pid, action: 'check this PID manually; nothing else was touched, nothing will be retried' }); finish(EXIT.TERMINATION_UNCONFIRMED); }
      }, KILL_CONFIRM_MS);
    };
    const hard = setTimeout(() => stop('TIME_LIMIT'), HARD_LIMIT_MS); // the start wait counts in this limit

    /** One start signal, over this child's own channel, only after READY + a valid measurement of this PID. */
    const trySendStart = () => {
      if (startSent || !ready || mem.startupSamples === 0 || verdict || exited || finished) return;
      startSent = true;
      const signal = { type: 'FILAMENT_START', v: 1, pid: child.pid, sessionHash, measuredAt: lastStartupSampleAt, startupRssKB: Math.round(mem.startupFirst / 1024) };
      log('START_SENT', { pid: child.pid, afterMs: elapsed(), evidence: 'CHILD_STARTUP_MEMORY_MEASURED', startupRssMB: mb(mem.startupFirst) });
      try {
        child.send(signal, (error) => { if (error) { log('START_SIGNAL_FAILED', { pid: child.pid, message: String(error?.message ?? error).slice(0, 120) }); stop('START_SIGNAL_FAILED'); } });
      } catch (error) {
        log('START_SIGNAL_FAILED', { pid: child.pid, message: String(error?.message ?? error).slice(0, 120) });
        stop('START_SIGNAL_FAILED');
      }
    };

    const sample = async () => {
      if (polling || exited || verdict || finished) return;
      polling = true;
      const phase = startSent ? 'runtime' : 'startup'; // classified by when the measurement began
      const r = await measure(child.pid);
      polling = false;
      if (exited || verdict || finished) return;
      if (r.kind === 'ok') {
        if (phase === 'startup') {
          mem.startupSamples += 1;
          if (!mem.startupFirst) mem.startupFirst = r.bytes;
          mem.startupPeak = Math.max(mem.startupPeak, r.bytes);
          lastStartupSampleAt = Date.now();
        } else {
          mem.runtimeSamples += 1;
          mem.runtimePeak = Math.max(mem.runtimePeak, r.bytes);
        }
        if (r.bytes > RSS_LIMIT_BYTES) { stop('MEMORY_LIMIT'); return; }
        trySendStart();
      } else if (r.kind === 'no-row' && !pidAlive(child.pid)) {
        // the child has just ended; its 'exit' event is pending — not a monitor failure
      } else {
        monitorFailure = r.kind === 'fail' ? r.reason : 'NO_ROW_FOR_LIVE_CHILD';
        log('FILAMENT_MEMORY_MONITOR_UNAVAILABLE', { stage: phase === 'startup' ? 'child-startup' : 'child-runtime', pid: child.pid, reason: monitorFailure });
        stop('MEMORY_MONITOR_UNAVAILABLE');
      }
    };

    child.on('message', (message) => {
      const valid = !ready && !startSent && message !== null && typeof message === 'object' && !Array.isArray(message)
        && Object.keys(message).sort().join(',') === 'pid,type,v' && message.type === 'FILAMENT_BOOTSTRAP_READY' && message.v === 1 && message.pid === child.pid;
      if (!valid) { log('PROTOCOL_VIOLATION', { pid: child.pid, afterMs: elapsed() }); stop('PROTOCOL_VIOLATION'); return; }
      ready = true;
      log('CHILD_READY', { pid: child.pid, afterMs: elapsed() });
      trySendStart();
    });
    child.on('disconnect', () => log('CHANNEL_CLOSED', { pid: child.pid ?? null, started: startSent, afterMs: elapsed() }));
    child.once('spawn', () => {
      log('STARTED', { pid: child.pid, script: rel(file), bootstrap: BOOTSTRAP, hardLimitMs: HARD_LIMIT_MS, rssLimitMB: RSS_LIMIT_BYTES / 1048576, heapMB: HEAP_LIMIT_MB, pollMs: MEMORY_POLL_MS });
      void sample(); // first measurement as soon as the child has a PID
      poll = setInterval(() => { void sample(); }, MEMORY_POLL_MS);
    });
    child.on('error', (error) => {
      log('SPAWN_ERROR', { message: String(error?.message ?? error).slice(0, 200) });
      exited = true; childExited = true;
      finish(EXIT.SPAWN_FAILED);
    });
    child.on('exit', (code, signal) => {
      exited = true; childExited = true;
      const byVerdict = { TIME_LIMIT: EXIT.TIME_LIMIT, MEMORY_LIMIT: EXIT.MEMORY_LIMIT, MEMORY_MONITOR_UNAVAILABLE: EXIT.MEMORY_MONITOR_UNAVAILABLE, START_SIGNAL_FAILED: EXIT.START_SIGNAL_FAILED, PROTOCOL_VIOLATION: EXIT.PROTOCOL_VIOLATION };
      if (verdict) finish(byVerdict[verdict] ?? 1);
      else if (!startSent) { log('NOT_STARTED', { childExitCode: code, signal: signal ?? null }); finish(EXIT.NOT_STARTED); }
      else if (code === 0 && mem.startupSamples === 0) finish(EXIT.NOT_MEASURED); // unreachable: the start needs a measurement
      else finish(code ?? (signal ? 1 : 0));
    });
  });
}

// Absolute limit for this launcher, whatever happens to the child or its pipes (unref: never keeps the process alive).
setTimeout(() => {
  log('LAUNCHER_DEADLINE', { afterMs: LAUNCHER_MAX_MS, childPid: activeChild?.pid ?? null });
  if (activeChild && !childExited) activeChild.kill();
  releaseLock();
  process.exit(EXIT.LAUNCHER_DEADLINE);
}, LAUNCHER_MAX_MS).unref();
// Ctrl+C: stop only our own child, release the lock, exit with a distinct code.
process.once('SIGINT', () => {
  log('INTERRUPTED');
  if (activeChild && !childExited) activeChild.kill();
  releaseLock();
  process.exit(EXIT.INTERRUPTED);
});
process.once('exit', () => releaseLock());

const code = await main(process.argv.slice(2));
process.exitCode = code;
