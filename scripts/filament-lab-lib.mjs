// [ARCADE-GE] Filament — level laboratory (design + verification helpers, Node only, never shipped).
// Everything here drives the REAL simulation (src/arcade/filament/physics.ts): a level counts as solvable only
// because a replayed action list reaches WON, never because of a geometric guess.
//
// [ARCADE-SAFETY V2 2026-10-23] Hardened after a Windows crash (BSOD 0xEF) during level design.
//   * Candidates are COUNTED arithmetically (BigInt, no simulation) before anything runs; a grid above the ceiling or
//     above what is left in the session is refused (FILAMENT_SEARCH_BUDGET_EXCEEDED), never "tried anyway".
//   * Two budgets apply to every operation (run = bounded replay, scan, scanSummary, tolerance, trace):
//       - a per-operation budget (LAB_BUDGET; a caller may only lower it);
//       - ONE per-process session ledger (SESSION_BUDGET) that every operation debits. Starting a new operation never
//         resets it; once a session limit is hit or a search is cancelled the session is closed for good
//         (FILAMENT_LAB_SESSION_EXHAUSTED). The ledger lives in a closure registered once on globalThis under a
//         non-writable, non-configurable symbol, so a second instance of this module shares it and no option object
//         can replace it.
//   * Every physics step is metered: per-candidate cap (the candidate is UNRESOLVED, never a loss), totals, and a
//     monotonic clock checked every TIME_CHECK_EVERY steps inside the step loop; an AbortSignal cancels.
//   * Supervision: simulations run only in a process started by scripts/filament-safe-run.mjs. The launcher creates a
//     random per-run nonce, passes it to its single child in FILAMENT_LAB_SESSION and writes only its SHA-256, with its
//     own PID, into .tmp/filament-lab/run.lock. This module accepts the session only if the nonce hashes to the lock's
//     value AND the lock owner is this process's parent (process.ppid). No option, argument or static token can grant
//     it. This prevents accidental unsupervised runs; it is NOT a sandbox against code written to defeat it.
//   * Options are strict: only { budget, signal } (plus each function's own documented fields); anything else, such as
//     the former `env` option, is refused (FILAMENT_SEARCH_INVALID).
//   * The engine's own replay() (40 s of ticks by default) is not used here; the supervised launcher only accepts
//     scripts whose import graph reaches physics.ts through this module.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim, stepSim, TICK_RATE } from '../src/arcade/filament/physics.ts';

export const MS_PER_TICK = 1000 / TICK_RATE;

/** Per-operation ceilings (conservative starting values, not values proven safe on any machine). */
export const LAB_BUDGET = Object.freeze({
  maxCandidates: 2000,
  maxTotalSteps: 200_000,
  maxStepsPerCandidate: 960,
  softTimeMs: 3000,
  maxPlanLength: 3,
  sampleSize: 20,
  maxToleranceLimit: 24,
});
/** Whole supervised process: shared by every operation; below the launcher's 10 s external limit. */
export const SESSION_BUDGET = Object.freeze({ maxCandidates: 2000, maxTotalSteps: 200_000, maxTimeMs: 8000 });
/** Elapsed time is read every N physics steps. */
export const TIME_CHECK_EVERY = 64;
/** Per-step cost is proportional to the level contents: they are bounded too. */
export const LEVEL_LIMITS = Object.freeze({ threads: 8, segments: 48, pegs: 24, rifts: 24, currents: 8, wells: 4, stars: 5, actions: 8 });
export const SESSION_ENV = 'FILAMENT_LAB_SESSION';

export const LAB_ERROR = Object.freeze({
  BUDGET: 'FILAMENT_SEARCH_BUDGET_EXCEEDED',
  STEPS: 'FILAMENT_STEP_BUDGET_EXCEEDED',
  TIMEOUT: 'FILAMENT_SEARCH_TIMEOUT',
  CANCELLED: 'FILAMENT_SEARCH_CANCELLED',
  BUSY: 'FILAMENT_SEARCH_BUSY',
  INVALID: 'FILAMENT_SEARCH_INVALID',
  UNSUPERVISED: 'FILAMENT_LAB_UNSUPERVISED',
  EXHAUSTED: 'FILAMENT_LAB_SESSION_EXHAUSTED',
});

export class FilamentLabError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'FilamentLabError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = {}) => { throw new FilamentLabError(code, message, details); };
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;

/** Effective budget: every requested value can only lower the given ceilings. */
function tighten(ceilings, requested) {
  const want = requested && typeof requested === 'object' ? requested : {};
  const out = {};
  for (const [key, ceiling] of Object.entries(ceilings)) {
    const value = want[key];
    out[key] = Number.isSafeInteger(value) && value > 0 ? Math.min(ceiling, value) : ceiling;
  }
  return Object.freeze(out);
}
export function tightenBudget(requested = {}) { return tighten(LAB_BUDGET, requested); }

// ── supervision ───────────────────────────────────────────────────────────────────────────────────────────────────
const LOCK_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp', 'filament-lab', 'run.lock');
const NONCE = /^[0-9a-f]{64}$/;

/** Pure check of the launcher evidence; returns null when valid, otherwise a short reason code. */
export function checkSupervisionEvidence({ nonce, lock, ppid }) {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return 'NO_SESSION_NONCE';
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return 'NO_LAUNCHER_LOCK';
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.pid !== ppid) return 'PARENT_IS_NOT_LAUNCHER';
  const hash = crypto.createHash('sha256').update(nonce).digest('hex');
  if (typeof lock.sessionHash !== 'string' || lock.sessionHash !== hash) return 'SESSION_MISMATCH';
  return null;
}

function readLauncherLock() {
  try {
    const text = fs.readFileSync(LOCK_FILE, 'utf8');
    return text.length <= 4096 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ── session ledger (whole process) ───────────────────────────────────────────────────────────────────────────────
/**
 * One ledger per supervised process. Counters live in this closure only; the returned object is frozen. A session
 * limit (steps, candidates, time) or a cancellation closes the ledger permanently: every later operation is refused.
 * Exported for the guard tests (a ledger alone runs nothing); simulations always use the process ledger below.
 */
export function createSessionLedger({ budget = {}, now = () => performance.now() } = {}) {
  const limits = tighten(SESSION_BUDGET, budget);
  const start = now();
  let steps = 0, candidates = 0, cancellations = 0, terminal = null;
  const close = (code, message, details) => { terminal = code; fail(code, message, { scope: 'session', ...details }); };
  const checkTime = () => {
    const elapsed = now() - start;
    if (elapsed > limits.maxTimeMs) close(LAB_ERROR.TIMEOUT, `session exceeded ${limits.maxTimeMs} ms`, { elapsedMs: Math.round(elapsed), steps, candidates });
  };
  const assertOpen = () => {
    if (terminal) fail(LAB_ERROR.EXHAUSTED, `the lab session is closed (${terminal})`, { scope: 'session', cause: terminal, steps, candidates });
    checkTime();
  };
  return Object.freeze({
    assertOpen,
    checkTime,
    debitStep() {
      if (terminal) assertOpen();
      steps += 1;
      if (steps > limits.maxTotalSteps) close(LAB_ERROR.STEPS, `more than ${limits.maxTotalSteps} physics steps in this session`, { steps, candidates });
    },
    debitCandidate() {
      assertOpen();
      candidates += 1;
      if (candidates > limits.maxCandidates) close(LAB_ERROR.BUDGET, `more than ${limits.maxCandidates} candidates in this session`, { steps, candidates });
    },
    cancel() { cancellations += 1; if (!terminal) terminal = LAB_ERROR.CANCELLED; },
    remainingCandidates() { return Math.max(0, limits.maxCandidates - candidates); },
    status() { return Object.freeze({ steps, candidates, cancellations, elapsedMs: Math.round(now() - start), terminal, limits }); },
  });
}

const SESSION_KEY = Symbol.for('docteur.filament-lab.session.v2');

/** The process ledger, created on first use after the launcher evidence is verified; never replaced afterwards. */
function processSession() {
  const existing = globalThis[SESSION_KEY];
  if (existing) return existing;
  const reason = checkSupervisionEvidence({ nonce: process.env[SESSION_ENV], lock: readLauncherLock(), ppid: process.ppid });
  if (reason) fail(LAB_ERROR.UNSUPERVISED, 'run Filament simulations only through: node scripts/filament-safe-run.mjs <approved script>', { reason });
  const ledger = createSessionLedger();
  Object.defineProperty(globalThis, SESSION_KEY, { value: ledger, writable: false, configurable: false, enumerable: false });
  return ledger;
}

/** Read-only snapshot of the process ledger, or null if no operation has opened it yet. */
export function labSessionStatus() {
  const ledger = globalThis[SESSION_KEY];
  return ledger ? ledger.status() : null;
}

// ── validation ───────────────────────────────────────────────────────────────────────────────────────────────────
const OPTION_KEYS = new Set(['budget', 'signal']);

/** Strict options: a plain object with { budget?, signal? } only. Unknown keys (e.g. `env`) are refused. */
function checkOptions(opts) {
  if (opts === undefined) return {};
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) fail(LAB_ERROR.INVALID, 'options must be a plain object');
  for (const key of Object.keys(opts)) if (!OPTION_KEYS.has(key)) fail(LAB_ERROR.INVALID, `unknown option "${String(key).slice(0, 40)}"`);
  if (opts.budget !== undefined && (opts.budget === null || typeof opts.budget !== 'object')) fail(LAB_ERROR.INVALID, 'budget must be an object');
  if (opts.signal != null && typeof opts.signal.aborted !== 'boolean') fail(LAB_ERROR.INVALID, 'signal must be an AbortSignal');
  return opts;
}

export function validateLevel(level) {
  if (!level || typeof level !== 'object') fail(LAB_ERROR.INVALID, 'level must be an object');
  for (const [key, max] of Object.entries(LEVEL_LIMITS)) {
    if (key === 'actions') continue;
    const list = level[key] ?? [];
    if (!Array.isArray(list) || list.length > max) fail(LAB_ERROR.INVALID, `level.${key}: at most ${max} entries`, { key, max });
  }
}

function validateActions(actions, budget) {
  if (!Array.isArray(actions) || actions.length > LEVEL_LIMITS.actions) fail(LAB_ERROR.INVALID, `at most ${LEVEL_LIMITS.actions} timed actions`);
  for (const a of actions) {
    if (!a || !isNonNegInt(a.tick) || a.tick >= budget.maxStepsPerCandidate) fail(LAB_ERROR.INVALID, `action ticks must be integers in [0, ${budget.maxStepsPerCandidate - 1}]`);
  }
}

/** Validates a scan grid; returns the exact candidate count (BigInt) computed WITHOUT simulating. */
export function validateGrid(planLength, { step, maxTick, gap }, budget = LAB_BUDGET) {
  if (!isNonNegInt(planLength) || planLength > budget.maxPlanLength) fail(LAB_ERROR.INVALID, `plan length must be 0..${budget.maxPlanLength}`);
  if (!Number.isSafeInteger(step) || step < 1) fail(LAB_ERROR.INVALID, 'step must be an integer ≥ 1');
  if (!Number.isSafeInteger(gap) || gap < 1) fail(LAB_ERROR.INVALID, 'gap must be an integer ≥ 1');
  if (!isNonNegInt(maxTick) || maxTick >= budget.maxStepsPerCandidate) fail(LAB_ERROR.INVALID, `maxTick must be an integer in [0, ${budget.maxStepsPerCandidate - 1}]`);
  return countCandidates(planLength, { step, maxTick, gap });
}

/**
 * Exact number of tick sequences scan() would enumerate: t1 = 0, step, 2·step… ≤ maxTick, then each next tick starts
 * at previous + gap and advances by step. Pure arithmetic, O(planLength × maxTick) BigInt additions:
 *   f_k(x) = 1;  f_i(from) = f_{i+1}(from + gap) + f_i(from + step)  (0 once from > maxTick)
 * Callers validate the inputs first (validateGrid): integers, step ≥ 1, gap ≥ 1, 0 ≤ maxTick < 960.
 */
export function countCandidates(planLength, { step, maxTick, gap }) {
  let next = null; // f_{i+1} over 0..maxTick (null = level k: always 1)
  const at = (f, x) => (f === null ? 1n : x <= maxTick ? f[x] : 0n);
  for (let i = planLength - 1; i >= 0; i--) {
    const cur = new Array(maxTick + 1);
    for (let from = maxTick; from >= 0; from--) cur[from] = at(next, from + gap) + (from + step <= maxTick ? cur[from + step] : 0n);
    next = cur;
  }
  return at(next, 0);
}

/** Refuses before any simulation if the grid is above the per-operation ceiling or above what is left in the session. */
export function precheckScan(planLength, grid, budget = LAB_BUDGET, sessionRemaining = SESSION_BUDGET.maxCandidates) {
  const candidates = validateGrid(planLength, grid, budget);
  if (candidates > BigInt(budget.maxCandidates)) {
    fail(LAB_ERROR.BUDGET, `${candidates} candidates > ${budget.maxCandidates}: use a coarser grid, a shorter window or a local search around a known solution`, { scope: 'search', candidates: candidates.toString(), limit: budget.maxCandidates });
  }
  if (candidates > BigInt(sessionRemaining)) {
    fail(LAB_ERROR.BUDGET, `${candidates} candidates > ${sessionRemaining} left in this session`, { scope: 'session', candidates: candidates.toString(), remaining: sessionRemaining });
  }
  return { candidates: Number(candidates), worstCaseSteps: (candidates * BigInt(budget.maxStepsPerCandidate)).toString() };
}

/**
 * Per-operation meter. Every step and candidate is checked against the operation's budget first, then debited from
 * the session ledger; the FIRST exceeded limit throws. Time (operation and session) is read every TIME_CHECK_EVERY
 * steps and at every candidate.
 */
export function createMeter({ budget = LAB_BUDGET, signal = null, now = () => performance.now(), session }) {
  if (!session) fail(LAB_ERROR.INVALID, 'a meter needs a session ledger');
  session.assertOpen();
  const start = now();
  let steps = 0, candidates = 0;
  const checkClock = () => {
    if (signal?.aborted) { session.cancel(); fail(LAB_ERROR.CANCELLED, 'search cancelled', { scope: 'search', steps, candidates }); }
    const elapsed = now() - start;
    if (elapsed > budget.softTimeMs) fail(LAB_ERROR.TIMEOUT, `operation exceeded ${budget.softTimeMs} ms`, { scope: 'search', steps, candidates, elapsedMs: Math.round(elapsed) });
    session.checkTime();
  };
  return {
    budget,
    step() {
      steps += 1;
      if (steps > budget.maxTotalSteps) fail(LAB_ERROR.STEPS, `more than ${budget.maxTotalSteps} physics steps in this operation`, { scope: 'search', steps, candidates });
      session.debitStep();
      if (steps % TIME_CHECK_EVERY === 0) checkClock();
    },
    candidate() {
      candidates += 1;
      if (candidates > budget.maxCandidates) fail(LAB_ERROR.BUDGET, `more than ${budget.maxCandidates} candidates in this operation`, { scope: 'search', candidates });
      session.debitCandidate();
      checkClock();
    },
    get steps() { return steps; },
    get candidates() { return candidates; },
    elapsedMs: () => Math.round(now() - start),
  };
}

let activeSearch = false;
/** One operation at a time in this process (a second concurrent / nested one is refused, not queued). */
function exclusive(fn) {
  if (activeSearch) fail(LAB_ERROR.BUSY, 'another Filament lab operation is already running in this process');
  activeSearch = true;
  try { return fn(); } finally { activeSearch = false; }
}

/**
 * Bounded replay: at most budget.maxStepsPerCandidate ticks, every step metered. A run that has not finished by then
 * is UNRESOLVED (reported as such, never counted as a loss or a win). A budget error propagates immediately.
 */
function simulate(level, actions, meter, onStep = null) {
  meter.candidate();
  const state = createSim(level);
  const sorted = [...actions].sort((a, b) => a.tick - b.tick);
  const cap = meter.budget.maxStepsPerCandidate;
  let next = 0;
  while (state.outcome === 'PLAYING' && state.tick < cap) {
    const now = [];
    while (next < sorted.length && sorted[next].tick <= state.tick) now.push(sorted[next++].action);
    onStep?.(state);
    meter.step();
    stepSim(level, state, now);
  }
  const outcome = state.outcome === 'PLAYING' ? 'UNRESOLVED' : state.outcome;
  return { outcome, loss: state.loss, stars: state.starsTaken.filter(Boolean).length, tick: state.tick, state };
}

/** Options first (pure), then the supervised session, then the level, then a meter on that session. */
function begin(level, opts) {
  const o = checkOptions(opts);
  const session = processSession();
  session.assertOpen();
  validateLevel(level);
  const budget = tightenBudget(o.budget);
  return { budget, session, meter: createMeter({ budget, signal: o.signal ?? null, session }) };
}

/** Bounded replay of one solution. Returns { outcome: WON | LOST | UNRESOLVED, loss, stars, tick, state }. */
export function run(level, actions, opts) {
  return exclusive(() => {
    const { budget, meter } = begin(level, opts);
    validateActions(actions, budget);
    return simulate(level, actions, meter);
  });
}

function enumerate(plan, grid, visit) {
  const ticks = [];
  const rec = (i, from) => {
    if (i === plan.length) { visit(ticks.map((tick, k) => ({ tick, action: plan[k] })), [...ticks]); return; }
    for (let t = from; t <= grid.maxTick; t += grid.step) { ticks.push(t); rec(i + 1, t + grid.gap); ticks.pop(); }
  };
  rec(0, 0);
}

function gridOptions(options) {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) fail(LAB_ERROR.INVALID, 'options must be a plain object');
  const { step = 6, maxTick = 720, gap = 6, ...opts } = options ?? {};
  return { grid: { step, maxTick, gap }, opts };
}

/**
 * Same plan, every combination of increasing ticks on a grid (plan = list of actions, in order).
 * Contract kept: returns an array of { ticks, outcome, stars, loss } — at most LAB_BUDGET.maxCandidates rows, because a
 * larger grid is refused before simulating. outcome may be UNRESOLVED (step cap reached).
 */
export function scan(level, plan, options) {
  return exclusive(() => {
    const { grid, opts } = gridOptions(options);
    const { budget, session, meter } = begin(level, opts);
    if (!Array.isArray(plan)) fail(LAB_ERROR.INVALID, 'plan must be an array');
    precheckScan(plan.length, grid, budget, session.remainingCandidates());
    const out = [];
    enumerate(plan, grid, (actions, ticks) => {
      const r = simulate(level, actions, meter);
      out.push({ ticks, outcome: r.outcome, stars: r.stars, loss: r.loss });
    });
    return out;
  });
}

/** Streaming variant: counters + the best `sampleSize` wins (most stars first). Memory does not grow with the grid. */
export function scanSummary(level, plan, options) {
  return exclusive(() => {
    const { grid, opts } = gridOptions(options);
    const { budget, session, meter } = begin(level, opts);
    if (!Array.isArray(plan)) fail(LAB_ERROR.INVALID, 'plan must be an array');
    const pre = precheckScan(plan.length, grid, budget, session.remainingCandidates());
    const summary = { candidates: 0, wins: 0, threeStars: 0, unresolved: 0, losses: {}, sample: [], precheck: pre };
    enumerate(plan, grid, (actions, ticks) => {
      const r = simulate(level, actions, meter);
      summary.candidates += 1;
      if (r.outcome === 'WON') {
        summary.wins += 1;
        if (r.stars === 3) summary.threeStars += 1;
        summary.sample.push({ ticks, stars: r.stars });
        summary.sample.sort((a, b) => b.stars - a.stars);
        if (summary.sample.length > budget.sampleSize) summary.sample.length = budget.sampleSize;
      } else if (r.outcome === 'UNRESOLVED') {
        summary.unresolved += 1;
      } else {
        const key = r.loss ?? r.outcome;
        summary.losses[key] = (summary.losses[key] ?? 0) + 1;
      }
    });
    summary.steps = meter.steps;
    summary.elapsedMs = meter.elapsedMs();
    return summary;
  });
}

/**
 * Timing tolerance of a recorded solution: for each action, how far (in ticks) it can move earlier / later, the
 * others fixed, while the run still WINS (win window) and while it still collects as many stars (star window).
 * Bounded: limit ≤ budget.maxToleranceLimit; every probe shares ONE meter and the session ledger.
 */
export function tolerance(level, solution, options) {
  return exclusive(() => {
    if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) fail(LAB_ERROR.INVALID, 'options must be a plain object');
    const { limit = LAB_BUDGET.maxToleranceLimit, ...opts } = options ?? {};
    const { budget, session, meter } = begin(level, opts);
    validateActions(solution, budget);
    const maxReach = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : 1, budget.maxToleranceLimit);
    const probes = 1 + solution.length * 4 * maxReach;
    if (probes > budget.maxCandidates) fail(LAB_ERROR.BUDGET, `${probes} tolerance probes > ${budget.maxCandidates}`, { scope: 'search' });
    if (probes > session.remainingCandidates()) fail(LAB_ERROR.BUDGET, `${probes} tolerance probes > ${session.remainingCandidates()} left in this session`, { scope: 'session' });
    const base = simulate(level, solution, meter);
    return solution.map((_, k) => {
      const probe = (delta, needStars) => {
        const moved = solution.map((a, j) => (j === k ? { ...a, tick: Math.min(budget.maxStepsPerCandidate - 1, Math.max(0, a.tick + delta)) } : a));
        const r = simulate(level, moved, meter);
        return r.outcome === 'WON' && (!needStars || r.stars >= base.stars);
      };
      const reach = (sign, needStars) => { let d = 0; while (d < maxReach && probe(sign * (d + 1), needStars)) d++; return d; };
      return { action: k, winEarly: reach(-1, false), winLate: reach(1, false), starEarly: reach(-1, true), starLate: reach(1, true), capped: maxReach };
    });
  });
}

/** Orb positions every `every` ticks along a bounded replay (star placement on a proven trajectory). */
export function trace(level, actions, every = 6, opts) {
  return exclusive(() => {
    checkOptions(opts); // before copying the level (the copy evaluates its properties)
    processSession().assertOpen();
    const bare = { ...level, stars: [] };
    const { budget, meter } = begin(bare, opts);
    validateActions(actions, budget);
    const stride = Number.isSafeInteger(every) && every >= 1 ? every : 6;
    const points = [];
    const r = simulate(bare, actions, meter, (state) => {
      if (state.tick % stride === 0) points.push({ tick: state.tick, x: Math.round(state.p.x), y: Math.round(state.p.y) });
    });
    points.push({ tick: r.tick, x: Math.round(r.state.p.x), y: Math.round(r.state.p.y), outcome: r.outcome, loss: r.loss });
    return points;
  });
}

/** Share of grid timings that win (difficulty indicator). Works on scan() rows. */
export function summarize(results) {
  const n = results.length, wins = results.filter(r => r.outcome === 'WON');
  const three = wins.filter(r => r.stars === 3);
  const unresolved = results.filter(r => r.outcome === 'UNRESOLVED').length;
  return { combos: n, winRate: n ? wins.length / n : 0, threeStarRate: n ? three.length / n : 0, wins: wins.length, threeStars: three.length, unresolved };
}

/** CLI helper for lab scripts: prints a one-line typed failure and returns the process exit code (2). */
export function reportLabFailure(error) {
  if (error instanceof FilamentLabError) {
    console.error(JSON.stringify({ error: error.code, message: error.message, details: error.details }));
    return 2;
  }
  console.error(JSON.stringify({ error: 'FILAMENT_LAB_UNEXPECTED', message: String(error?.message ?? error).slice(0, 300) }));
  return 1;
}
