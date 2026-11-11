// [FILAMENT-1] Filament — one attempt at one level, on top of the unchanged engine (physics.ts). No DOM, no clock:
// the caller decides WHEN a tick runs (loop.ts); this module decides WHAT a tick does.
//
// Player actions are requests, validated here before they ever reach the engine:
//   * only a CUT of an existing, still attached thread, and only while the attempt is playing;
//   * a thread already requested for the next tick is not queued twice (rapid clicks / key repeat);
//   * requests are applied at the start of the next tick, exactly like the engine's replay (tick ≤ state.tick).
// Every attempt is bounded: besides the engine's own endings (goal, out of bounds, stuck, 12 s free flight), an attempt
// still playing after ATTEMPT_TICK_LIMIT ticks ends as TIME_UP. Nothing here searches, scans or replays solutions.
// [FILAMENT-4] Fans: a TOGGLE request (engine action { type: 'TOGGLE', current }) is accepted only for an existing
// current that HAS a fan, while playing, once per tick; it is applied at the start of the next tick, after the cuts.
// Levels without fans (chapter 1) send exactly the same action lists to the engine as before.
import { createSim, stepSim, TICK_RATE, type Action, type LossReason, type SimState } from './physics.ts';
import type { FilamentLevel } from './levels.ts';

/** 60 s of simulated time per attempt (CH1-A wins at tick 87, CH1-B at 221 with the reference timing). */
export const ATTEMPT_TICK_LIMIT = 60 * TICK_RATE;

export type AttemptPhase = 'playing' | 'won' | 'lost';
export type AttemptLoss = LossReason | 'TIME_UP';

/** What changed during one tick (reused object: read it before the next step). */
export interface TickReport {
  cutThreads: number;
  /** [FILAMENT-4] fans switched during this tick */
  toggledFans: number;
  starsTaken: number;
  ended: boolean;
}

export interface Attempt {
  readonly level: FilamentLevel;
  readonly state: SimState;
  readonly phase: AttemptPhase;
  readonly loss: AttemptLoss | null;
  readonly starCount: number;
  /** true when the request was queued for the next tick */
  requestCut(thread: number): boolean;
  /** index of the first attached thread not yet requested, or -1 */
  nextCuttableThread(): number;
  /** [FILAMENT-4] true when the fan toggle was queued for the next tick */
  requestToggle(current: number): boolean;
  /** [FILAMENT-4] index of the first current with a fan, or -1 */
  firstFan(): number;
  /** advances exactly one tick while playing; returns null once the attempt is over */
  step(): TickReport | null;
}

export function createAttempt(level: FilamentLevel): Attempt {
  const physics = level.physics;
  const state = createSim(physics);
  const threadCount = physics.threads.length;
  const pending = new Array<boolean>(threadCount).fill(false);
  const currents = physics.currents ?? [];
  const pendingToggle = new Array<boolean>(currents.length).fill(false);
  const actions: Action[] = [];
  const report: TickReport = { cutThreads: 0, toggledFans: 0, starsTaken: 0, ended: false };
  let phase: AttemptPhase = 'playing';
  let loss: AttemptLoss | null = null;

  const countStars = () => state.starsTaken.reduce((n, taken) => n + (taken ? 1 : 0), 0);

  return {
    level,
    state,
    get phase() { return phase; },
    get loss() { return loss; },
    get starCount() { return countStars(); },
    requestCut(thread) {
      if (phase !== 'playing' || !Number.isInteger(thread) || thread < 0 || thread >= threadCount) return false;
      if (!state.attached[thread] || pending[thread]) return false;
      pending[thread] = true;
      return true;
    },
    nextCuttableThread() {
      for (let i = 0; i < threadCount; i++) if (state.attached[i] && !pending[i]) return i;
      return -1;
    },
    requestToggle(current) {
      if (phase !== 'playing' || !Number.isInteger(current) || current < 0 || current >= currents.length) return false;
      if (!currents[current].fan || pendingToggle[current]) return false;
      pendingToggle[current] = true;
      return true;
    },
    firstFan() {
      return currents.findIndex(c => c.fan !== undefined);
    },
    step() {
      if (phase !== 'playing') return null;
      actions.length = 0;
      for (let i = 0; i < threadCount; i++) {
        if (pending[i]) { actions.push({ type: 'CUT', thread: i }); pending[i] = false; }
      }
      let toggled = 0;
      for (let i = 0; i < pendingToggle.length; i++) {
        if (pendingToggle[i]) { actions.push({ type: 'TOGGLE', current: i }); pendingToggle[i] = false; toggled += 1; }
      }
      const attachedBefore = state.attached.reduce((n, a) => n + (a ? 1 : 0), 0);
      const starsBefore = countStars();
      stepSim(physics, state, actions);
      report.cutThreads = attachedBefore - state.attached.reduce((n, a) => n + (a ? 1 : 0), 0);
      report.toggledFans = toggled;
      report.starsTaken = countStars() - starsBefore;
      if (state.outcome === 'WON') phase = 'won';
      else if (state.outcome === 'LOST') { phase = 'lost'; loss = state.loss ?? 'INVALID'; }
      else if (state.tick >= ATTEMPT_TICK_LIMIT) { phase = 'lost'; loss = 'TIME_UP'; }
      report.ended = phase !== 'playing';
      return report;
    },
  };
}
