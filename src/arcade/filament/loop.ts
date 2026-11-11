// [FILAMENT-1] Filament — fixed-step accumulator (same policy as Synapse Run's loop.ts, for the 120 Hz engine; that
// file is bound to Synapse Run's own 60 Hz tick rate, so it is not shared). Rendering follows requestAnimationFrame;
// the physics only ever advances in whole 1/120 s ticks.
//
// Catch-up policy (bounded, explicit):
//   * a frame delta above MAX_FRAME_DELTA_MS (tab hidden, debugger, long GC) counts as MAX_FRAME_DELTA_MS;
//   * at most MAX_STEPS_PER_FRAME ticks run per rendered frame (60 fps needs 2, 30 fps needs 4); a backlog beyond that
//     is dropped, so a slow machine sees the game in slow motion instead of ever longer frames;
//   * reset() (pause → resume, restart, new level) forgets the previous timestamp: no time accumulates while paused.
import { TICK_RATE } from './physics.ts';

export const STEP_MS = 1000 / TICK_RATE;
export const MAX_STEPS_PER_FRAME = 4;
export const MAX_FRAME_DELTA_MS = 100;
export const VSYNC_TOLERANCE_MS = 0.25;

export interface FixedStepper {
  /** Called once per rendered frame with its timestamp (ms); returns how many ticks ran. */
  frame(nowMs: number): number;
  reset(): void;
  /** share of the next tick already elapsed, in [0, 1) (render interpolation) */
  readonly alpha: number;
  /** ticks dropped by the catch-up bound since creation */
  readonly dropped: number;
}

/** `step` returns false when nothing is left to simulate (attempt over): the frame stops stepping at once. */
export function createFixedStepper(step: () => boolean): FixedStepper {
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
        accumulator -= STEP_MS;
        steps += 1;
        if (!step()) { accumulator = 0; break; }
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
    get alpha() { return Math.min(Math.max(accumulator / STEP_MS, 0), 0.999); },
    get dropped() { return dropped; },
  };
}
