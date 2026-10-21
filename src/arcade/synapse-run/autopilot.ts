// [GAME-4] Synapse Run — deterministic "careful player" used by tests and measurements only (10-minute simulation,
// browser frame-rate runs). Never part of the shipped game: main.ts references it only behind the test-hook flag.
// It jumps BLOCKs and slides under HIGH_GATEs in its own lane and makes occasional lane changes when both lanes are
// clear for 14 m; decisions come from the state alone plus its own seeded LCG.
import type { Command, Lane, Obstacle, SimState } from './simulation.ts';

export function createAutopilot(rngSeed: number): (state: SimState) => Command[] {
  let x = rngSeed >>> 0;
  return state => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    if (state.status === 'READY') return ['START'];
    if (state.status !== 'RUNNING') return [];
    const ahead = (lane: Lane): Obstacle | undefined => {
      let best: Obstacle | undefined;
      for (const o of state.obstacles) if (o.lane === lane && o.z - state.distance > -1 && (!best || o.z < best.z)) best = o;
      return best;
    };
    const next = ahead(state.laneProgress ? state.laneTo : state.lane);
    if (next && state.laneProgress === 0 && state.mode === 'RUN') {
      const d = next.z - state.distance;
      if (next.type === 'BLOCK' && d <= state.speed / 3 && d > state.speed * 0.18) return ['JUMP'];
      if (next.type === 'HIGH_GATE' && d <= state.speed / 3 && d > 0.7) return ['SLIDE'];
    }
    if (state.laneProgress === 0 && state.mode === 'RUN' && x % 97 === 0) {
      const target = state.lane + (x & 256 ? 1 : -1);
      const clear = (lane: Lane) => { const o = ahead(lane); return !o || o.z - state.distance > state.speed * 1.2; };
      if (target >= 0 && target <= 2 && clear(state.lane) && clear(target as Lane)) return [target < state.lane ? 'LEFT' : 'RIGHT'];
    }
    return [];
  };
}
