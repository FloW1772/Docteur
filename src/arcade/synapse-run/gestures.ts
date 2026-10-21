// [GAME-5] Synapse Run — swipe recognition (Pointer Events). Produces the SAME simulation commands as the keyboard;
// there is no separate touch gameplay. Rules:
//   * only the first (primary) pointer of a gesture is tracked; any other pointer is ignored
//   * a gesture yields at most ONE command, as soon as it travels SWIPE_MIN_DISTANCE_PX (or at release)
//   * dominant axis: |dx| ≥ |dy| → horizontal (an exact diagonal resolves to horizontal), else vertical
//   * movement under SWIPE_MIN_DISTANCE_PX, or a gesture longer than SWIPE_MAX_DURATION_MS, yields nothing
import type { Command } from './simulation.ts';

export const SWIPE_MIN_DISTANCE_PX = 30;
export const SWIPE_MAX_DURATION_MS = 700;

export type SwipeCommand = Extract<Command, 'LEFT' | 'RIGHT' | 'JUMP' | 'SLIDE'>;

export interface PointerSample { pointerId: number; x: number; y: number; t: number }

export interface SwipeDetector {
  down(sample: PointerSample): void;
  move(sample: PointerSample): SwipeCommand | null;
  up(sample: PointerSample): SwipeCommand | null;
  cancel(pointerId: number): void;
  readonly tracking: boolean;
}

/** The command for a displacement, or null below the distance threshold. */
export function swipeCommand(dx: number, dy: number, minDistance = SWIPE_MIN_DISTANCE_PX): SwipeCommand | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < minDistance) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'LEFT' : 'RIGHT';
  return dy < 0 ? 'JUMP' : 'SLIDE'; // screen y grows downwards: swipe up = jump
}

export function createSwipeDetector(): SwipeDetector {
  let active: { pointerId: number; x: number; y: number; t: number; fired: boolean } | null = null;
  const resolve = (sample: PointerSample): SwipeCommand | null => {
    if (!active || active.fired || sample.pointerId !== active.pointerId) return null;
    if (sample.t - active.t > SWIPE_MAX_DURATION_MS) return null;
    const command = swipeCommand(sample.x - active.x, sample.y - active.y);
    if (command) active.fired = true;
    return command;
  };
  return {
    down(sample) { if (!active) active = { ...sample, fired: false }; },
    move: resolve,
    up(sample) {
      if (!active || sample.pointerId !== active.pointerId) return null;
      const command = resolve(sample);
      active = null;
      return command;
    },
    cancel(pointerId) { if (active && active.pointerId === pointerId) active = null; },
    get tracking() { return active !== null; },
  };
}
