// [ARCADE-SAFE-REPLAY CH1-B 2026-10-23] Filament — ONE deterministic replay of the known CH1-B solution, nothing else.
// It must run under the supervised launcher (the lab refuses unsupervised processes):
//   node scripts/filament-safe-run.mjs scripts/filament-replay-ch1-b.mjs
// Status when written: NOT RUN (pending a separately authorised single execution).
//
// Same structure as scripts/filament-single-replay.mjs (CH1-A, validated; left untouched), in this order:
//   1. pure checks of the fixture (one thread, exactly two plain walls, three stars, no peg / rift / current / well,
//      one CUT of thread 0 at a tick in range);
//   2. SHA-256 of the engine file must equal the fixture's (the recorded result is only meaningful on that engine);
//   3. exactly ONE call to run() of scripts/filament-lab-lib.mjs: 1 candidate, ≤ 600 physics steps, 2 s soft limit,
//      every step metered by the lab and debited from the process session ledger;
//   4. compares the result with the RECORDED outcome and star count only (the win tick was never recorded: it is
//      reported, not judged), checks the ledger (candidates = 1, steps = final tick ≤ 600), prints ONE JSON line.
// Never: scan / scanSummary / tolerance / trace, loops over candidates, retries, arguments, writes, network, processes.
// Exit codes (distinct from the launcher's 3–15 and the bootstrap's 20–23): 0 pass · 1 unexpected error ·
// 2 typed lab refusal (budget, supervision…) · 30 result mismatch (incl. UNRESOLVED at 600) · 31 engine differs ·
// 32 invalid fixture.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, labSessionStatus, reportLabFailure } from './filament-lab-lib.mjs';
import { FIXTURE } from './filament-replay-ch1-b-fixture.mjs';

export const MAX_STEPS = 600;
/** Only lowers the lab ceilings (LAB_BUDGET): 1 candidate, 600 steps in total and per candidate. */
export const REPLAY_BUDGET = Object.freeze({ maxCandidates: 1, maxTotalSteps: MAX_STEPS, maxStepsPerCandidate: MAX_STEPS, softTimeMs: 2000 });
const CODE = Object.freeze({ PASS: 0, MISMATCH: 30, ENGINE_CHANGED: 31, BAD_FIXTURE: 32 });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const out = (fields) => process.stdout.write(`${JSON.stringify({ replay: FIXTURE?.id ?? null, ...fields })}\n`);
const isPoint = (p) => p !== null && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y);

/** Pure: the fixture must describe exactly the CH1-B shape (returns a reason or null). */
function fixtureProblem(f) {
  const l = f?.level;
  if (!l || !isPoint(l.orb) || !Array.isArray(l.threads) || l.threads.length !== 1 || !Array.isArray(l.stars) || l.stars.length !== 3) return 'LEVEL_SHAPE';
  if (!Array.isArray(l.segments) || l.segments.length !== 2 || !l.segments.every(s => s?.kind === 'wall' && isPoint(s.a) && isPoint(s.b))) return 'SEGMENTS_SHAPE';
  for (const key of ['pegs', 'rifts', 'currents', 'wells']) if (l[key] !== undefined) return `UNEXPECTED_${key.toUpperCase()}`;
  if (!Array.isArray(f.actions) || f.actions.length !== 1) return 'NOT_ONE_ACTION';
  const [a] = f.actions;
  if (a?.action?.type !== 'CUT' || a.action.thread !== 0 || !Number.isSafeInteger(a.tick) || a.tick < 0 || a.tick >= MAX_STEPS) return 'ACTION_SHAPE';
  if (f.recorded?.outcome !== 'WON' || f.recorded?.stars !== 3) return 'RECORDED_SHAPE';
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
  const checks = {
    recordedOutcome: r.outcome === FIXTURE.recorded.outcome,
    recordedStars: r.stars === FIXTURE.recorded.stars,
    noLoss: r.loss === null,
    oneCandidate: session?.candidates === 1,
    stepsWithinBudget: session?.steps === r.tick && r.tick <= MAX_STEPS,
    sessionOpen: session?.terminal === null,
  };
  const pass = Object.values(checks).every(Boolean);
  out({
    verdict: pass ? 'PASS' : 'MISMATCH',
    outcome: r.outcome, loss: r.loss, stars: r.stars, tick: r.tick, starAt: [...r.state.starAt],
    final: { x: Number(r.state.p.x.toFixed(3)), y: Number(r.state.p.y.toFixed(3)) },
    estimateWinTickRange: FIXTURE.estimate?.winTickRange ?? null, // reported for comparison, never judged
    checks,
    session: session && { steps: session.steps, candidates: session.candidates, elapsedMs: session.elapsedMs, terminal: session.terminal },
  });
  return pass ? CODE.PASS : CODE.MISMATCH;
}

process.exitCode = main();
