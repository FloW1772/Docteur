// [FILAMENT-2 2026-10-23] Filament — verification of the chapter the game ships (src/arcade/filament/chapter1.ts, the
// very objects the game reads). No argument, no search. Run only through the supervised launcher:
//   node scripts/filament-safe-run.mjs scripts/filament-verify-chapter1.mjs
// Per level, in order:
//   1. pure geometry check: every thread at least as long as its anchor → orb distance (no jump on the first frame)
//   2. ONE replay of the reference solution: WON, 3 stars, exactly the recorded win tick and star ticks
//   3. ONE replay with no action at all: must NOT win (every cut is needed)
// 8 levels × 2 candidates, ≤ 600 steps each (≤ 9 600 steps). Exit codes: 0 all pass · 30 a check failed ·
// 2 typed lab refusal · 1 unexpected error.
import { run, labSessionStatus, reportLabFailure } from './filament-lab-lib.mjs';
import { CHAPTER1_LEVELS } from '../src/arcade/filament/chapter1.ts';

const BUDGET = Object.freeze({ maxStepsPerCandidate: 600 });
const out = (fields) => process.stdout.write(`${JSON.stringify(fields)}\n`);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function geometryProblem(physics) {
  for (const [i, t] of physics.threads.entries()) {
    const d = Math.hypot(physics.orb.x - t.anchor.x, physics.orb.y - t.anchor.y);
    if (d > t.length + 0.5) return `THREAD_${i}_TOO_SHORT_BY_${Math.round(d - t.length)}`;
  }
  return null;
}

function main() {
  let allOk = true;
  for (const level of CHAPTER1_LEVELS) {
    const geometry = geometryProblem(level.physics);
    const r = run(level.physics, level.reference.actions, { budget: BUDGET });
    const idle = run(level.physics, [], { budget: BUDGET });
    const checks = {
      geometry: geometry === null,
      won: r.outcome === 'WON' && r.loss === null,
      threeStars: r.stars === 3,
      winTick: r.tick === level.reference.winTick,
      starTicks: same(r.state.starAt, level.reference.starAt),
      idleDoesNotWin: idle.outcome !== 'WON',
    };
    const ok = Object.values(checks).every(Boolean);
    allOk = allOk && ok;
    out({ code: level.code, ok, outcome: r.outcome, stars: r.stars, winTick: r.tick, starAt: [...r.state.starAt], idle: idle.outcome, ...(geometry ? { geometry } : {}), checks });
  }
  const s = labSessionStatus();
  out({ session: s && { steps: s.steps, candidates: s.candidates, elapsedMs: s.elapsedMs, terminal: s.terminal } });
  return allOk ? 0 : 30;
}

try {
  process.exitCode = main();
} catch (error) {
  out({ session: labSessionStatus() });
  process.exitCode = reportLabFailure(error);
}
