// [GAME-6] Synapse Run — presentation events derived from consecutive simulation states. Read-only: the result
// drives sound, visual cues and screen-reader announcements and never flows back into the simulation, so the
// deterministic run (checksum, course, collisions) is unaffected.
import type { SimState } from './simulation.ts';

export type FeedbackEvent = 'START' | 'LANE' | 'JUMP' | 'SLIDE' | 'SHARD' | 'CRASH';

/** The few fields the comparison needs (copied each tick; no references into the live state). */
export interface FeedbackView {
  status: SimState['status'];
  laneTo: number;
  laneProgress: number;
  mode: SimState['mode'];
  shardsCollected: number;
}

export function feedbackView(state: SimState): FeedbackView {
  return { status: state.status, laneTo: state.laneTo, laneProgress: state.laneProgress, mode: state.mode, shardsCollected: state.shardsCollected };
}

/** Events between two consecutive ticks of the same run, in a fixed order. */
export function feedbackEvents(prev: FeedbackView, next: FeedbackView): FeedbackEvent[] {
  const events: FeedbackEvent[] = [];
  if (prev.status === 'READY' && next.status === 'RUNNING') events.push('START');
  // a lane change starts with laneProgress 1 (also when a buffered change follows the previous one)
  if (next.laneProgress === 1 && (prev.laneProgress === 0 || prev.laneTo !== next.laneTo)) events.push('LANE');
  if (next.mode === 'JUMP' && prev.mode !== 'JUMP') events.push('JUMP');
  if (next.mode === 'SLIDE' && prev.mode !== 'SLIDE') events.push('SLIDE');
  if (next.shardsCollected > prev.shardsCollected) events.push('SHARD');
  if (next.status === 'GAME_OVER' && prev.status !== 'GAME_OVER') events.push('CRASH');
  return events;
}
