// [GAME-4] Synapse Run — authoritative runner simulation. Pure and deterministic: no DOM, no Three.js, no clock,
// no Math.random. Same seed + same command sequence + same number of ticks ⇒ exactly the same state.
//
// World: metres. z = distance along the track (the player is always at z = distance), x = lateral, y = height.
// Lanes 0 / 1 / 2 = LEFT / CENTER / RIGHT, centres at x = (lane − 1) · LANE_WIDTH.
//
// Rules (each is unit-tested):
//   * fixed step 1/60 s; speed constant SPEED (distance is derived from runTicks, never accumulated)
//   * commands are applied at the start of a tick, in order
//   * lane change: exactly LANE_CHANGE_TICKS ticks of linear motion, the command tick being the first (x moves 1/8
//     per tick, the lane is settled on the 8th); a lane command during a change is buffered (one slot, last command
//     wins) and starts on the settling tick; lanes are clamped to 0..2 (an outward command is ignored)
//   * jump: only when grounded and not airborne; fixed JUMP_VELOCITY, GRAVITY, semi-implicit Euler, lands at y = 0
//   * slide: exactly SLIDE_TICKS ticks at reduced height (the command tick is the first); SLIDE while airborne or
//     already sliding is ignored (holding the key cannot extend it); JUMP while sliding cancels the slide and jumps
//   * collision: axis-aligned boxes in x / y / z computed from this state only (never from meshes)
//   * shards are collected once (collected flag); obstacles end the run (GAME_OVER freezes the simulation)
//
// Course fairness invariants (tested over many seeds):
//   1. the first obstacle row is at z ≥ START_SAFE_Z
//   2. consecutive rows are MIN_ROW_GAP..MAX_ROW_GAP metres apart (whole metres)
//   3. a row holds 1 or 2 obstacles, never 3: at least one lane is always completely free
//   4. every obstacle is also passable in its own lane: BLOCK by a jump, HIGH_GATE by a slide
//   5. shards lie strictly inside a gap (≥ SHARD_MARGIN from both rows), one lane per gap
//   6. rows are generated only up to distance + HORIZON; entities more than PRUNE_BEHIND behind are removed

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const SPEED = 12; // m/s → 0.2 m per tick
export const LANE_COUNT = 3;
export const LANE_WIDTH = 2.2;
export const LANE_CHANGE_TICKS = 8;
export const JUMP_VELOCITY = 9.2;
export const GRAVITY = 28;
export const SLIDE_TICKS = 36;
export const HORIZON = 110;
export const PRUNE_BEHIND = 6;
export const START_SAFE_Z = 36;
export const MIN_ROW_GAP = 16;
export const MAX_ROW_GAP = 26;
export const SHARD_MARGIN = 4;
export const SHARD_SPACING = 2.5;
export const SHARD_POINTS = 10;

/** Collision boxes (half extents in x / z, vertical span in y). */
export const PLAYER_HALF_WIDTH = 0.4;
export const PLAYER_HALF_DEPTH = 0.4;
export const PLAYER_HEIGHT = 1.6;
export const PLAYER_SLIDE_HEIGHT = 0.7;
export const OBSTACLE_HALF_WIDTH = 0.9;
export const BLOCK = { halfDepth: 0.5, bottom: 0, top: 1.0 } as const;
export const HIGH_GATE = { halfDepth: 0.3, bottom: 1.05, top: 2.6 } as const;
export const SHARD = { halfWidth: 0.35, halfDepth: 0.35, bottom: 0.45, top: 1.15 } as const;

export type Lane = 0 | 1 | 2;
export type ObstacleType = 'BLOCK' | 'HIGH_GATE';
export type GameStatus = 'READY' | 'RUNNING' | 'GAME_OVER' | 'STOPPED';
export type PlayerMode = 'RUN' | 'JUMP' | 'SLIDE';
export type Command = 'START' | 'LEFT' | 'RIGHT' | 'JUMP' | 'SLIDE';

export interface Obstacle { id: number; type: ObstacleType; lane: Lane; z: number }
export interface Shard { id: number; lane: Lane; z: number; collected: boolean }

export interface SimState {
  seed: number;
  /** mulberry32 state (int32); advanced only by course generation */
  rng: number;
  tick: number;
  runTicks: number;
  status: GameStatus;
  distance: number;
  speed: number;
  lane: Lane;
  laneFrom: Lane;
  laneTo: Lane;
  /** ticks into the current lane change; 0 = settled in `lane` */
  laneProgress: number;
  /** buffered lane command: −1 left, +1 right, 0 none */
  laneBuffer: -1 | 0 | 1;
  y: number;
  vy: number;
  mode: PlayerMode;
  slideTicks: number;
  obstacles: Obstacle[];
  shards: Shard[];
  nextId: number;
  lastRowZ: number;
  nextRowZ: number;
  shardsCollected: number;
  crash: { obstacleId: number; type: ObstacleType } | null;
}

/** Seeds are explicit uint32 values. */
export function normalizeSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
}

/** mulberry32: tiny, fast, fully deterministic 32-bit PRNG. Returns [0, 1). */
function random(state: SimState): number {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randomInt(state: SimState, min: number, max: number): number {
  return min + Math.floor(random(state) * (max - min + 1));
}

export function laneX(lane: number): number {
  return (lane - 1) * LANE_WIDTH;
}

/** Lateral player position (linear during a lane change). */
export function playerX(state: SimState): number {
  if (state.laneProgress === 0) return laneX(state.lane);
  const t = state.laneProgress / LANE_CHANGE_TICKS;
  return laneX(state.laneFrom) + (laneX(state.laneTo) - laneX(state.laneFrom)) * t;
}

export function playerHeight(state: SimState): number {
  return state.mode === 'SLIDE' ? PLAYER_SLIDE_HEIGHT : PLAYER_HEIGHT;
}

function generateRow(state: SimState): void {
  const rowZ = state.nextRowZ;
  // shards inside the gap before this row (invariant 5)
  if (random(state) < 0.7) {
    const lane = randomInt(state, 0, 2) as Lane;
    const from = Math.max(state.lastRowZ + SHARD_MARGIN, 10);
    const to = rowZ - SHARD_MARGIN;
    for (let z = from, n = 0; z <= to && n < 5; z += SHARD_SPACING, n++) state.shards.push({ id: state.nextId++, lane, z, collected: false });
  }
  // 1 or 2 obstacles, never 3 (invariant 3)
  const count = random(state) < 0.55 ? 1 : 2;
  const lanes: Lane[] = [0, 1, 2];
  for (let i = lanes.length - 1; i > 0; i--) {
    const j = randomInt(state, 0, i);
    [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
  }
  for (let i = 0; i < count; i++) {
    state.obstacles.push({ id: state.nextId++, type: random(state) < 0.5 ? 'BLOCK' : 'HIGH_GATE', lane: lanes[i], z: rowZ });
  }
  state.lastRowZ = rowZ;
  state.nextRowZ = rowZ + randomInt(state, MIN_ROW_GAP, MAX_ROW_GAP);
}

/** Generates rows up to `untilZ` (no pruning). updateCourse uses it with distance + HORIZON. */
export function generateCourse(state: SimState, untilZ: number): void {
  while (state.nextRowZ <= untilZ) generateRow(state);
}

function updateCourse(state: SimState): void {
  generateCourse(state, state.distance + HORIZON);
  const limit = state.distance - PRUNE_BEHIND;
  if (state.obstacles.length > 0 && state.obstacles[0].z < limit) state.obstacles = state.obstacles.filter(o => o.z >= limit);
  if (state.shards.length > 0 && state.shards[0].z < limit) state.shards = state.shards.filter(s => s.z >= limit);
}

/** A new run in READY state, its opening course already generated from `seed`. */
export function createSim(seed: number): SimState {
  const s = normalizeSeed(seed);
  const state: SimState = {
    seed: s, rng: s | 0, tick: 0, runTicks: 0, status: 'READY', distance: 0, speed: SPEED,
    lane: 1, laneFrom: 1, laneTo: 1, laneProgress: 0, laneBuffer: 0,
    y: 0, vy: 0, mode: 'RUN', slideTicks: 0,
    obstacles: [], shards: [], nextId: 1, lastRowZ: 0, nextRowZ: START_SAFE_Z,
    shardsCollected: 0, crash: null,
  };
  updateCourse(state);
  return state;
}

export function score(state: SimState): number {
  return Math.floor(state.distance) + SHARD_POINTS * state.shardsCollected;
}

function startLaneChange(state: SimState, direction: -1 | 1): void {
  const target = state.lane + direction;
  if (target < 0 || target >= LANE_COUNT) return; // lane bounds
  state.laneFrom = state.lane;
  state.laneTo = target as Lane;
  state.laneProgress = 1;
}

function applyCommand(state: SimState, command: Command): void {
  if (state.status === 'READY') {
    if (command === 'START') state.status = 'RUNNING';
    return;
  }
  if (state.status !== 'RUNNING') return;
  switch (command) {
    case 'LEFT':
    case 'RIGHT': {
      const direction = command === 'LEFT' ? -1 : 1;
      if (state.laneProgress > 0) state.laneBuffer = direction;
      else startLaneChange(state, direction);
      return;
    }
    case 'JUMP':
      if (state.mode === 'JUMP') return; // airborne: no double jump
      state.mode = 'JUMP';
      state.slideTicks = 0;
      state.vy = JUMP_VELOCITY;
      return;
    case 'SLIDE':
      if (state.mode !== 'RUN') return; // airborne or already sliding: ignored
      state.mode = 'SLIDE';
      state.slideTicks = SLIDE_TICKS;
      return;
    case 'START':
      return;
  }
}

function overlaps(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax && bMin < aMax;
}

function collide(state: SimState): void {
  const x = playerX(state), z = state.distance, yMin = state.y, yMax = state.y + playerHeight(state);
  for (const shard of state.shards) {
    if (shard.collected) continue;
    if (Math.abs(x - laneX(shard.lane)) < PLAYER_HALF_WIDTH + SHARD.halfWidth && Math.abs(z - shard.z) < PLAYER_HALF_DEPTH + SHARD.halfDepth && overlaps(yMin, yMax, SHARD.bottom, SHARD.top)) {
      shard.collected = true;
      state.shardsCollected += 1;
    }
  }
  for (const obstacle of state.obstacles) {
    const box = obstacle.type === 'BLOCK' ? BLOCK : HIGH_GATE;
    if (Math.abs(x - laneX(obstacle.lane)) < PLAYER_HALF_WIDTH + OBSTACLE_HALF_WIDTH && Math.abs(z - obstacle.z) < PLAYER_HALF_DEPTH + box.halfDepth && overlaps(yMin, yMax, box.bottom, box.top)) {
      state.status = 'GAME_OVER';
      state.crash = { obstacleId: obstacle.id, type: obstacle.type };
      return;
    }
  }
}

/**
 * Advances exactly one tick (mutates `state`). READY: only START is accepted and nothing moves.
 * GAME_OVER / STOPPED: nothing changes at all.
 */
export function stepSim(state: SimState, commands: readonly Command[] = []): SimState {
  if (state.status === 'GAME_OVER' || state.status === 'STOPPED') return state;
  const wasChanging = state.laneProgress > 0;
  const wasSliding = state.mode === 'SLIDE';
  for (const command of commands) applyCommand(state, command);
  if (state.status !== 'RUNNING') return state;

  // a change started by this tick's command already moved 1/8 (laneProgress = 1); only older changes advance
  if (wasChanging) {
    state.laneProgress += 1;
    if (state.laneProgress >= LANE_CHANGE_TICKS) {
      state.lane = state.laneTo;
      state.laneFrom = state.lane;
      state.laneProgress = 0;
      const buffered = state.laneBuffer;
      state.laneBuffer = 0;
      if (buffered !== 0) startLaneChange(state, buffered);
    }
  }
  if (state.mode === 'JUMP') {
    state.vy -= GRAVITY * DT;
    state.y += state.vy * DT;
    if (state.y <= 0) { state.y = 0; state.vy = 0; state.mode = 'RUN'; }
  } else if (state.mode === 'SLIDE' && wasSliding) {
    state.slideTicks -= 1;
    if (state.slideTicks <= 0) { state.slideTicks = 0; state.mode = 'RUN'; }
  }

  state.runTicks += 1;
  state.tick += 1;
  state.distance = (state.runTicks * SPEED) / TICK_RATE;
  updateCourse(state);
  collide(state);
  return state;
}

/** Stable FNV-1a checksum of the whole logical state (tests and determinism evidence). */
export function checksum(state: SimState): string {
  const text = JSON.stringify(state);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
