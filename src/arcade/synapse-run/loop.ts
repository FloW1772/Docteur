// [GAME-4] Synapse Run — fixed-step accumulator. Rendering follows requestAnimationFrame; the simulation only ever
// advances in whole 1/60 s ticks, never by the render-frame delta.
//
// Catch-up policy (bounded):
//   * a frame delta above MAX_FRAME_DELTA_MS (tab hidden, debugger, long GC) counts as MAX_FRAME_DELTA_MS
//   * at most MAX_STEPS_PER_FRAME ticks run per rendered frame; a backlog beyond that is dropped, so a stalled
//     browser slows the game down instead of spiralling into ever longer frames
//   * reset() (pause → resume, restart) forgets the previous timestamp: no time accumulates while paused
//   * a frame within VSYNC_TOLERANCE_MS of a whole step counts as that step (vsync timestamps such as 16.6 ms would
//     otherwise alternate 0 and 2 steps); the accumulator may then dip at most that much below zero, so simulated
//     time stays locked to real time
import { TICK_RATE } from './simulation.ts';

export const STEP_MS = 1000 / TICK_RATE;
export const MAX_STEPS_PER_FRAME = 5;
export const MAX_FRAME_DELTA_MS = 100;
export const VSYNC_TOLERANCE_MS = 0.5;

export interface FixedStepper {
  /** Called once per rendered frame with its timestamp (ms); returns how many ticks ran. */
  frame(nowMs: number): number;
  reset(): void;
  /** ticks dropped by the catch-up bound since creation */
  readonly dropped: number;
}

export function createFixedStepper(step: () => void): FixedStepper {
  let accumulator = 0;
  let last: number | null = null;
  let dropped = 0;
  return {
    frame(nowMs) {
      if (last === null || !Number.isFinite(nowMs) || nowMs < last) {
        last = Number.isFinite(nowMs) ? nowMs : null;
        return 0;
      }
      accumulator += Math.min(nowMs - last, MAX_FRAME_DELTA_MS);
      last = nowMs;
      let steps = 0;
      while (accumulator >= STEP_MS - VSYNC_TOLERANCE_MS && steps < MAX_STEPS_PER_FRAME) {
        step();
        accumulator -= STEP_MS;
        steps += 1;
      }
      if (accumulator >= STEP_MS) {
        dropped += Math.floor(accumulator / STEP_MS);
        accumulator %= STEP_MS;
      }
      return steps;
    },
    reset() {
      accumulator = 0;
      last = null;
    },
    get dropped() { return dropped; },
  };
}
