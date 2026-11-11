// [ARCADE-SAFETY V2 2026-10-23] Guard tests for scripts/filament-lab-lib.mjs. NO physics step is ever executed here:
// every test either computes arithmetic (candidate counts, budgets), drives meters and ledgers with a fake clock, or
// checks that a refusal happens BEFORE any level is read (a level whose `orb` / `goal` getters throw proves that
// createSim was never reached). The last test asserts that the process session ledger recorded 0 steps and 0
// candidates for the whole file.
// It must run under the supervised launcher (the lab refuses unsupervised processes):
//   node scripts/filament-safe-run.mjs scripts/test-filament-lab-guards.mjs
// Status when written: NOT RUN (pending a separately authorised minimal validation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  LAB_BUDGET, SESSION_BUDGET, LAB_ERROR, FilamentLabError, countCandidates, precheckScan, tightenBudget, createMeter,
  createSessionLedger, checkSupervisionEvidence, labSessionStatus, scan, scanSummary, tolerance, run, trace, validateGrid,
} from './filament-lab-lib.mjs';

const code = (c, scope = null) => (e) => {
  assert.ok(e instanceof FilamentLabError, String(e));
  assert.equal(e.code, c);
  if (scope) assert.equal(e.details?.scope, scope);
  return true;
};
/** A level that explodes if anything tries to simulate it. */
const untouchable = () => ({
  threads: [], stars: [], segments: [], pegs: [], rifts: [], currents: [], wells: [],
  get orb() { throw new Error('SIMULATION_REACHED'); }, get goal() { throw new Error('SIMULATION_REACHED'); },
});
const PLAN3 = [{ type: 'CUT', thread: 0 }, { type: 'CUT', thread: 1 }, { type: 'CUT', thread: 2 }];

/** Reference count by plain tuple enumeration (arithmetic only, tiny grids). */
function bruteCount(k, { step, maxTick, gap }) {
  let n = 0;
  const rec = (i, from) => { if (i === k) { n++; return; } for (let t = from; t <= maxTick; t += step) rec(i + 1, t + gap); };
  rec(0, 0);
  return BigInt(n);
}

test('countCandidates equals the enumeration scan() would perform (small grids)', () => {
  for (const k of [0, 1, 2, 3]) for (const step of [1, 3, 6]) for (const gap of [1, 6, 7]) for (const maxTick of [0, 5, 30, 61]) {
    assert.equal(countCandidates(k, { step, maxTick, gap }), bruteCount(k, { step, maxTick, gap }), JSON.stringify({ k, step, gap, maxTick }));
  }
});

test('the search that ran for > 600 s before the crash is refused before any simulation', () => {
  // plan of 3 actions, step 6, maxTick 900, gap 6: C(151, 3) = 562 475 candidates
  assert.equal(countCandidates(3, { step: 6, maxTick: 900, gap: 6 }), 562_475n);
  assert.throws(() => precheckScan(3, { step: 6, maxTick: 900, gap: 6 }), code(LAB_ERROR.BUDGET, 'search'));
  assert.throws(() => scan(untouchable(), PLAN3, { step: 6, maxTick: 900, gap: 6 }), code(LAB_ERROR.BUDGET, 'search'));
  assert.throws(() => scanSummary(untouchable(), PLAN3, { step: 15, maxTick: 600, gap: 6 }), code(LAB_ERROR.BUDGET, 'search'));
});

test('grid validation: integers only, bounded plan, actions inside the per-candidate step cap', () => {
  for (const grid of [{ step: 0, maxTick: 10, gap: 1 }, { step: 1.5, maxTick: 10, gap: 1 }, { step: 1, maxTick: -1, gap: 1 }, { step: 1, maxTick: 10, gap: 0 },
    { step: Number.NaN, maxTick: 10, gap: 1 }, { step: 1, maxTick: Infinity, gap: 1 }, { step: 1, maxTick: LAB_BUDGET.maxStepsPerCandidate, gap: 1 }, { step: 1, maxTick: 10 }]) {
    assert.throws(() => validateGrid(1, grid), code(LAB_ERROR.INVALID), JSON.stringify(grid));
  }
  assert.throws(() => validateGrid(LAB_BUDGET.maxPlanLength + 1, { step: 100, maxTick: 100, gap: 100 }), code(LAB_ERROR.INVALID));
  assert.equal(precheckScan(1, { step: 1, maxTick: 900, gap: 1 }).candidates, 901);
  assert.throws(() => precheckScan(1, { step: 1, maxTick: 900, gap: 1 }, LAB_BUDGET, 100), code(LAB_ERROR.BUDGET, 'session'));
});

test('budgets can only be tightened, never raised (including absurd or hostile values)', () => {
  const b = tightenBudget({ maxCandidates: 1e12, maxTotalSteps: Infinity, softTimeMs: -5, maxStepsPerCandidate: 100, sampleSize: '999' });
  assert.equal(b.maxCandidates, LAB_BUDGET.maxCandidates);
  assert.equal(b.maxTotalSteps, LAB_BUDGET.maxTotalSteps);
  assert.equal(b.softTimeMs, LAB_BUDGET.softTimeMs);
  assert.equal(b.maxStepsPerCandidate, 100);
  assert.equal(b.sampleSize, LAB_BUDGET.sampleSize);
  assert.ok(Object.isFrozen(LAB_BUDGET) && Object.isFrozen(b) && Object.isFrozen(SESSION_BUDGET));
  const s = createSessionLedger({ budget: { maxCandidates: 1e9, maxTotalSteps: 10, maxTimeMs: Infinity }, now: () => 0 }).status().limits;
  assert.deepEqual([s.maxCandidates, s.maxTotalSteps, s.maxTimeMs], [SESSION_BUDGET.maxCandidates, 10, SESSION_BUDGET.maxTimeMs]);
});

test('operation meter: step budget, timeout, cancellation, candidate ceiling — first limit wins', () => {
  let t = 0;
  const ledger = () => createSessionLedger({ now: () => t });
  const steps = createMeter({ budget: tightenBudget({ maxTotalSteps: 10 }), now: () => t, session: ledger() });
  for (let i = 0; i < 10; i++) steps.step();
  assert.throws(() => steps.step(), code(LAB_ERROR.STEPS, 'search'));

  const slow = createMeter({ budget: tightenBudget({ softTimeMs: 50 }), now: () => t, session: ledger() });
  t = 51;
  assert.throws(() => { for (let i = 0; i < 1000; i++) slow.step(); }, code(LAB_ERROR.TIMEOUT, 'search'));

  t = 0;
  const controller = new AbortController();
  const cancelLedger = ledger();
  const cancel = createMeter({ signal: controller.signal, now: () => t, session: cancelLedger });
  controller.abort();
  assert.throws(() => cancel.candidate(), code(LAB_ERROR.CANCELLED, 'search'));
  assert.throws(() => createMeter({ now: () => t, session: cancelLedger }), code(LAB_ERROR.EXHAUSTED, 'session'), 'a cancelled session stays closed');

  const many = createMeter({ budget: tightenBudget({ maxCandidates: 2 }), now: () => t, session: ledger() });
  many.candidate(); many.candidate();
  assert.throws(() => many.candidate(), code(LAB_ERROR.BUDGET, 'search'));
});

test('session ledger: shared by successive operations, never reset, closed for good once exceeded', () => {
  let t = 0;
  const shared = createSessionLedger({ budget: { maxTotalSteps: 10, maxCandidates: 3 }, now: () => t });
  const first = createMeter({ now: () => t, session: shared });
  for (let i = 0; i < 6; i++) first.step();
  const second = createMeter({ now: () => t, session: shared }); // a new operation: local counters at 0, session at 6
  for (let i = 0; i < 4; i++) second.step();
  assert.throws(() => second.step(), code(LAB_ERROR.STEPS, 'session'));
  assert.equal(shared.status().terminal, LAB_ERROR.STEPS);
  assert.throws(() => createMeter({ now: () => t, session: shared }), code(LAB_ERROR.EXHAUSTED, 'session'), 'retry after a budget error is refused');
  assert.throws(() => shared.debitStep(), code(LAB_ERROR.EXHAUSTED, 'session'));

  const candidates = createSessionLedger({ budget: { maxCandidates: 3 }, now: () => t });
  const a = createMeter({ now: () => t, session: candidates });
  a.candidate(); a.candidate();
  const b = createMeter({ now: () => t, session: candidates });
  b.candidate();
  assert.throws(() => b.candidate(), code(LAB_ERROR.BUDGET, 'session'));

  t = 0;
  const timed = createSessionLedger({ budget: { maxTimeMs: 100 }, now: () => t });
  const c = createMeter({ now: () => t, session: timed });
  t = 60; c.candidate(); // 60 ms: inside both budgets (operation softTimeMs 3000, session 100)
  t = 101;
  assert.throws(() => createMeter({ now: () => t, session: timed }), code(LAB_ERROR.TIMEOUT, 'session'), 'short successive operations cannot exceed the session time');
  assert.throws(() => createMeter({ now: () => t, session: timed }), code(LAB_ERROR.EXHAUSTED, 'session'));
  assert.ok(Object.isFrozen(timed));
});

test('supervision evidence: nonce + lock hash + lock owner = parent process, nothing else', () => {
  const nonce = 'a'.repeat(64);
  const sessionHash = crypto.createHash('sha256').update(nonce).digest('hex');
  assert.equal(checkSupervisionEvidence({ nonce: undefined, lock: { pid: 7, sessionHash }, ppid: 7 }), 'NO_SESSION_NONCE');
  assert.equal(checkSupervisionEvidence({ nonce: '1', lock: { pid: 7, sessionHash }, ppid: 7 }), 'NO_SESSION_NONCE');
  assert.equal(checkSupervisionEvidence({ nonce, lock: null, ppid: 7 }), 'NO_LAUNCHER_LOCK');
  assert.equal(checkSupervisionEvidence({ nonce, lock: { pid: 8, sessionHash }, ppid: 7 }), 'PARENT_IS_NOT_LAUNCHER');
  assert.equal(checkSupervisionEvidence({ nonce, lock: { pid: 7, sessionHash: 'f'.repeat(64) }, ppid: 7 }), 'SESSION_MISMATCH');
  assert.equal(checkSupervisionEvidence({ nonce, lock: { pid: 7, sessionHash }, ppid: 7 }), null);
});

test('the former `env` option and any unknown option are refused before anything else', () => {
  const env = { env: { FILAMENT_LAB_SUPERVISED: '1', FILAMENT_LAB_SESSION: 'a'.repeat(64) } };
  assert.throws(() => run(untouchable(), [], env), code(LAB_ERROR.INVALID));
  assert.throws(() => scan(untouchable(), [], { step: 1, maxTick: 1, gap: 1, ...env }), code(LAB_ERROR.INVALID));
  assert.throws(() => scanSummary(untouchable(), [], { step: 1, maxTick: 1, gap: 1, ...env }), code(LAB_ERROR.INVALID));
  assert.throws(() => tolerance(untouchable(), [], { limit: 1, ...env }), code(LAB_ERROR.INVALID));
  assert.throws(() => trace(untouchable(), [], 6, env), code(LAB_ERROR.INVALID));
  assert.throws(() => trace(untouchable(), [], 6, 960), code(LAB_ERROR.INVALID), 'numeric options (old maxTicks argument) are refused');
  assert.throws(() => run(untouchable(), [], { budget: { maxCandidates: 1 }, session: {} }), code(LAB_ERROR.INVALID), 'no ledger can be supplied');
});

test('oversized levels and out-of-range actions are refused before simulating', () => {
  const big = untouchable();
  Object.defineProperty(big, 'segments', { value: new Array(49).fill({}) });
  assert.throws(() => run(big, []), code(LAB_ERROR.INVALID));
  assert.throws(() => run(untouchable(), [{ tick: LAB_BUDGET.maxStepsPerCandidate, action: {} }]), code(LAB_ERROR.INVALID));
  assert.throws(() => run(untouchable(), [{ tick: 1.5, action: {} }]), code(LAB_ERROR.INVALID));
  assert.throws(() => tolerance(untouchable(), [{ tick: 10, action: {} }], { limit: 1e9, budget: { maxCandidates: 10 } }), code(LAB_ERROR.BUDGET, 'search'));
});

test('the whole file executed zero physics steps and zero candidates in the supervised session', () => {
  const status = labSessionStatus();
  assert.ok(status, 'the supervised session was opened by the refusals above');
  assert.equal(status.steps, 0);
  assert.equal(status.candidates, 0);
  assert.equal(status.terminal, null);
});
