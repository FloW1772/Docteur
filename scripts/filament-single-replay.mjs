// [ARCADE-SAFE-REPLAY 2026-10-23] Filament — ONE deterministic replay of ONE known solution, nothing else.
// It must run under the supervised launcher (the lab refuses unsupervised processes):
//   node scripts/filament-safe-run.mjs scripts/filament-single-replay.mjs
// Status when written: NOT RUN (pending a separately authorised single execution).
//
// What it does, in this order, and nothing more:
//   1. pure checks of the fixture (one thread, one CUT, no wall / peg / rift / current / well, tick in range);
//   2. SHA-256 of the engine file must equal the fixture's (the recorded result is only meaningful on that engine);
//   3. exactly ONE call to run() of scripts/filament-lab-lib.mjs: 1 candidate, ≤ 600 physics steps, 2 s soft limit,
//      every step metered by the lab and debited from the process session ledger;
//   4. compares the result with the recorded outcome and the analytic prediction, checks the ledger
//      (candidates = 1, steps = final tick ≤ 600), prints ONE JSON line and sets the exit code.
// Never: scan / scanSummary / tolerance / trace, loops over candidates, retries, arguments, writes, network, processes.
// Exit codes (distinct from the launcher's 3–15 and the bootstrap's 20–23): 0 pass · 1 unexpected error ·
// 2 typed lab refusal (budget, supervision…) · 30 result mismatch · 31 engine differs · 32 invalid fixture.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, labSessionStatus, reportLabFailure } from './filament-lab-lib.mjs';
import { FIXTURE } from './filament-single-replay-fixture.mjs';

export const MAX_STEPS = 600;
/** Only lowers the lab ceilings (LAB_BUDGET): 1 candidate, 600 steps in total and per candidate. */
export const REPLAY_BUDGET = Object.freeze({ maxCandidates: 1, maxTotalSteps: MAX_STEPS, maxStepsPerCandidate: MAX_STEPS, softTimeMs: 2000 });
const CODE = Object.freeze({ PASS: 0, MISMATCH: 30, ENGINE_CHANGED: 31, BAD_FIXTURE: 32 });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const out = (fields) => process.stdout.write(`${JSON.stringify({ replay: FIXTURE?.id ?? null, ...fields })}\n`);

/** Pure: the fixture must describe the lightest possible level (returns a reason or null). */
function fixtureProblem(f) {
  const l = f?.level;
  if (!l || !Array.isArray(l.threads) || l.threads.length !== 1 || !Array.isArray(l.stars) || l.stars.length !== 3) return 'LEVEL_SHAPE';
  for (const key of ['segments', 'pegs', 'rifts', 'currents', 'wells']) if (l[key] !== undefined) return `UNEXPECTED_${key.toUpperCase()}`;
  if (!Array.isArray(f.actions) || f.actions.length !== 1) return 'NOT_ONE_ACTION';
  const [a] = f.actions;
  if (a?.action?.type !== 'CUT' || a.action.thread !== 0 || !Number.isSafeInteger(a.tick) || a.tick < 0 || a.tick >= MAX_STEPS) return 'ACTION_SHAPE';
  if (!Number.isSafeInteger(f.analytic?.tick) || f.analytic.tick > MAX_STEPS) return 'EXPECTED_TICK_OUT_OF_BUDGET';
  return null;
}

function engineHash() {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, FIXTURE.engineFile))).digest('hex'); } catch { return null; }
}

function main() {
  const problem = fixtureProblem(FIXTURE);
  if (problem) { out({ verdict: 'INVALID_FIXTURE', reason: problem, steps: 0 }); return CODE.BAD_FIXTURE; }
  const hash = engineHash();
  if (hash !== FIXTURE.engineSha256) { out({ verdict: 'ENGINE_CHANGED', expected: FIXTURE.engineSha256.slice(0, 16), actual: hash?.slice(0, 16) ?? null, steps: 0 }); return CODE.ENGINE_CHANGED; }

  let r;
  try {
    r = run(FIXTURE.level, FIXTURE.actions, { budget: REPLAY_BUDGET }); // the one and only simulation
  } catch (error) {
    out({ verdict: 'LAB_ERROR', session: labSessionStatus() });
    return reportLabFailure(error);
  }

  const session = labSessionStatus();
  const starAt = [...r.state.starAt];
  const checks = {
    recordedOutcome: r.outcome === FIXTURE.recorded.outcome,
    recordedStars: r.stars === FIXTURE.recorded.stars,
    analyticLoss: r.loss === FIXTURE.analytic.loss,
    analyticTick: r.tick === FIXTURE.analytic.tick,
    analyticStarTicks: starAt.length === FIXTURE.analytic.starAt.length && starAt.every((t, i) => t === FIXTURE.analytic.starAt[i]),
    oneCandidate: session?.candidates === 1,
    stepsWithinBudget: session?.steps === r.tick && r.tick <= MAX_STEPS,
    sessionOpen: session?.terminal === null,
  };
  const pass = Object.values(checks).every(Boolean);
  out({
    verdict: pass ? 'PASS' : 'MISMATCH',
    outcome: r.outcome, loss: r.loss, stars: r.stars, tick: r.tick, starAt,
    final: { x: Number(r.state.p.x.toFixed(3)), y: Number(r.state.p.y.toFixed(3)) },
    checks,
    session: session && { steps: session.steps, candidates: session.candidates, elapsedMs: session.elapsedMs, terminal: session.terminal },
  });
  return pass ? CODE.PASS : CODE.MISMATCH;
}

process.exitCode = main();
