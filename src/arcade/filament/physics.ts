// [ARCADE-GE] Filament — authoritative puzzle physics. Pure and deterministic: no DOM, no clock, no Math.random.
// Same level + same action list (tick, action) ⇒ exactly the same trajectory, at any display frame rate.
//
// Method: position-based dynamics on ONE rigid body (the orb), fixed step 1/120 s.
//   1. integrate: v += (gravity + active field forces)·dt, |v| clamped, p += v·dt
//   2. project constraints a few times: each attached thread is an inextensible, slackable distance constraint
//      (|p − anchor| ≤ length; a thread pulls, it never pushes); solid contacts push the orb out of walls / pegs
//   3. v = (p − p_prev) / dt, then each solid contact reflects the normal velocity with its restitution
// Why this and not a chain of rope particles: the puzzles need predictable pendulums and clean cuts, not cloth. One
// distance constraint per thread is exact for a taut thread, cannot oscillate numerically, and is cheap. The thread is
// DRAWN with a sag when slack, but that curve is presentation only.
//
// Safety: |v| ≤ MAX_SPEED keeps the per-step travel (MAX_SPEED·dt ≈ 10.8) below the orb radius, so the orb cannot
// tunnel through a wall; non-finite values end the attempt (LOST/INVALID) instead of propagating.

export const TICK_RATE = 120;
export const DT = 1 / TICK_RATE;
export const GRAVITY = 900; // world units / s² (world = 800 × 500 units, y down)
export const MAX_SPEED = 1300;
export const ORB_RADIUS = 18;
export const STAR_RADIUS = 15;
export const WALL_THICKNESS = 8;
export const CONSTRAINT_ITERATIONS = 8;
export const WORLD = { width: 800, height: 500 } as const;
/** Free flight (no thread holding the orb) longer than this is a failure: the level never waits forever. */
export const FREE_FLIGHT_LIMIT_TICKS = 12 * TICK_RATE;
/** Free orb slower than this for STUCK_TICKS is a failure (resting on a ledge out of reach). */
export const STUCK_SPEED = 6;
export const STUCK_TICKS = Math.round(1.5 * TICK_RATE);

export interface Vec { x: number; y: number }
export interface ThreadDef { anchor: Vec; length: number }
export interface SegmentDef { a: Vec; b: Vec; kind: 'wall' | 'deflector' }
export interface PegDef { x: number; y: number; r: number }
export interface RiftDef { a: Vec; b: Vec }
/** Air current: constant acceleration inside an axis-aligned box. timing = automatic cycle; fan = player toggle. */
export interface CurrentDef {
  x: number; y: number; w: number; h: number; ax: number; ay: number;
  timing?: { period: number; on: number; phase: number };
  fan?: { initiallyOn: boolean; device: Vec };
}
/** Stellar well: acceleration toward the centre, linear falloff to 0 at `radius`. */
export interface WellDef { x: number; y: number; radius: number; strength: number }

export interface LevelPhysics {
  orb: Vec;
  orbVelocity?: Vec;
  threads: ThreadDef[];
  goal: { x: number; y: number; r: number };
  stars: Vec[];
  segments?: SegmentDef[];
  pegs?: PegDef[];
  rifts?: RiftDef[];
  currents?: CurrentDef[];
  wells?: WellDef[];
}

export type Action = { type: 'CUT'; thread: number } | { type: 'TOGGLE'; current: number };
export type Outcome = 'PLAYING' | 'WON' | 'LOST';
export type LossReason = 'OUT_OF_BOUNDS' | 'RIFT' | 'STUCK' | 'FREE_FLIGHT_TIMEOUT' | 'INVALID';

export interface SimState {
  tick: number;
  p: Vec; v: Vec;
  /** previous tick's position (render interpolation only) */
  prev: Vec;
  attached: boolean[];
  /** tick at which each thread was cut, −1 if intact (presentation: cut animation) */
  cutAt: number[];
  fanOn: boolean[];
  starsTaken: boolean[];
  /** tick at which each star was taken, −1 otherwise (presentation) */
  starAt: number[];
  outcome: Outcome;
  loss: LossReason | null;
  freeTicks: number;
  slowTicks: number;
  /** last contacts (presentation: a soft spark on hard bounces only) */
  lastImpact: { tick: number; x: number; y: number; speed: number } | null;
  actionsApplied: number;
}

export function createSim(level: LevelPhysics): SimState {
  const threads = level.threads.length, stars = level.stars.length;
  return {
    tick: 0,
    p: { ...level.orb }, v: { ...(level.orbVelocity ?? { x: 0, y: 0 }) }, prev: { ...level.orb },
    attached: new Array(threads).fill(true), cutAt: new Array(threads).fill(-1),
    fanOn: (level.currents ?? []).map(c => c.fan?.initiallyOn ?? true),
    starsTaken: new Array(stars).fill(false), starAt: new Array(stars).fill(-1),
    outcome: 'PLAYING', loss: null, freeTicks: 0, slowTicks: 0, lastImpact: null, actionsApplied: 0,
  };
}

/** Whether a current pushes at `tick` (timed currents cycle; fans follow the player's toggle). */
export function currentActive(c: CurrentDef, index: number, state: SimState): boolean {
  if (c.fan) return state.fanOn[index];
  if (c.timing) {
    const t = (state.tick + c.timing.phase) % c.timing.period;
    return t < c.timing.on;
  }
  return true;
}

/** Applies one player action; returns false if it does nothing (already cut, unknown index, finished level). */
export function applyAction(level: LevelPhysics, state: SimState, action: Action): boolean {
  if (state.outcome !== 'PLAYING') return false;
  if (action.type === 'CUT') {
    if (!Number.isInteger(action.thread) || action.thread < 0 || action.thread >= level.threads.length || !state.attached[action.thread]) return false;
    state.attached[action.thread] = false;
    state.cutAt[action.thread] = state.tick;
  } else {
    const c = level.currents?.[action.current];
    if (!c?.fan) return false;
    state.fanOn[action.current] = !state.fanOn[action.current];
  }
  state.actionsApplied += 1;
  return true;
}

function closestOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
  return { x: a.x + abx * t, y: a.y + aby * t };
}

interface Contact { nx: number; ny: number; restitution: number }

const RESTITUTION = { wall: 0.3, deflector: 0.78, peg: 0.45 } as const;
const FRICTION = 0.04;

function projectThreads(level: LevelPhysics, state: SimState): void {
  for (let i = 0; i < level.threads.length; i++) {
    if (!state.attached[i]) continue;
    const { anchor, length } = level.threads[i];
    const dx = state.p.x - anchor.x, dy = state.p.y - anchor.y;
    const d = Math.hypot(dx, dy);
    if (d > length && d > 1e-9) {
      const k = length / d;
      state.p.x = anchor.x + dx * k;
      state.p.y = anchor.y + dy * k;
    }
  }
}

function pushOut(state: SimState, cx: number, cy: number, minDist: number, restitution: number, contacts: Contact[]): void {
  const dx = state.p.x - cx, dy = state.p.y - cy;
  const d = Math.hypot(dx, dy);
  if (d >= minDist) return;
  // exactly at the centre: push straight up (deterministic choice, never NaN)
  const nx = d > 1e-9 ? dx / d : 0, ny = d > 1e-9 ? dy / d : -1;
  state.p.x = cx + nx * minDist;
  state.p.y = cy + ny * minDist;
  contacts.push({ nx, ny, restitution });
}

function solveContacts(level: LevelPhysics, state: SimState, contacts: Contact[]): void {
  for (const s of level.segments ?? []) {
    const c = closestOnSegment(state.p, s.a, s.b);
    pushOut(state, c.x, c.y, ORB_RADIUS + WALL_THICKNESS / 2, RESTITUTION[s.kind], contacts);
  }
  for (const peg of level.pegs ?? []) pushOut(state, peg.x, peg.y, ORB_RADIUS + peg.r, RESTITUTION.peg, contacts);
}

function finite(v: Vec): boolean { return Number.isFinite(v.x) && Number.isFinite(v.y); }

/** Advances exactly one tick. Actions are applied first, in order. Returns the state (mutated). */
export function stepSim(level: LevelPhysics, state: SimState, actions: readonly Action[] = []): SimState {
  if (state.outcome !== 'PLAYING') return state;
  for (const a of actions) applyAction(level, state, a);
  state.prev.x = state.p.x; state.prev.y = state.p.y;

  let ax = 0, ay = GRAVITY;
  const currents = level.currents ?? [];
  for (let i = 0; i < currents.length; i++) {
    const c = currents[i];
    if (!currentActive(c, i, state)) continue;
    if (state.p.x >= c.x && state.p.x <= c.x + c.w && state.p.y >= c.y && state.p.y <= c.y + c.h) { ax += c.ax; ay += c.ay; }
  }
  for (const w of level.wells ?? []) {
    const dx = w.x - state.p.x, dy = w.y - state.p.y, d = Math.hypot(dx, dy);
    if (d < w.radius && d > 2) { const k = w.strength * (1 - d / w.radius) / d; ax += dx * k; ay += dy * k; }
  }
  state.v.x += ax * DT; state.v.y += ay * DT;
  const speed = Math.hypot(state.v.x, state.v.y);
  if (speed > MAX_SPEED) { state.v.x *= MAX_SPEED / speed; state.v.y *= MAX_SPEED / speed; }
  state.p.x += state.v.x * DT; state.p.y += state.v.y * DT;

  let contacts: Contact[] = [];
  for (let i = 0; i < CONSTRAINT_ITERATIONS; i++) {
    projectThreads(level, state);
    contacts = [];
    solveContacts(level, state, contacts);
  }
  state.v.x = (state.p.x - state.prev.x) / DT;
  state.v.y = (state.p.y - state.prev.y) / DT;
  for (const c of contacts) {
    const vn = state.v.x * c.nx + state.v.y * c.ny;
    if (vn < 0) {
      const impact = -vn;
      state.v.x -= (1 + c.restitution) * vn * c.nx;
      state.v.y -= (1 + c.restitution) * vn * c.ny;
      const tx = state.v.x - (state.v.x * c.nx + state.v.y * c.ny) * c.nx, ty = state.v.y - (state.v.x * c.nx + state.v.y * c.ny) * c.ny;
      state.v.x -= tx * FRICTION; state.v.y -= ty * FRICTION;
      if (impact > 160) state.lastImpact = { tick: state.tick, x: state.p.x - c.nx * ORB_RADIUS, y: state.p.y - c.ny * ORB_RADIUS, speed: impact };
    }
  }
  state.tick += 1;

  if (!finite(state.p) || !finite(state.v)) { state.outcome = 'LOST'; state.loss = 'INVALID'; return state; }
  for (let i = 0; i < level.stars.length; i++) {
    if (state.starsTaken[i]) continue;
    const s = level.stars[i];
    if (Math.hypot(state.p.x - s.x, state.p.y - s.y) < ORB_RADIUS + STAR_RADIUS) { state.starsTaken[i] = true; state.starAt[i] = state.tick; }
  }
  for (const r of level.rifts ?? []) {
    const c = closestOnSegment(state.p, r.a, r.b);
    if (Math.hypot(state.p.x - c.x, state.p.y - c.y) < ORB_RADIUS + 3) { state.outcome = 'LOST'; state.loss = 'RIFT'; return state; }
  }
  if (Math.hypot(state.p.x - level.goal.x, state.p.y - level.goal.y) < level.goal.r) { state.outcome = 'WON'; return state; }
  if (state.p.y > WORLD.height + 60 || state.p.x < -80 || state.p.x > WORLD.width + 80 || state.p.y < -400) { state.outcome = 'LOST'; state.loss = 'OUT_OF_BOUNDS'; return state; }
  const held = state.attached.some(Boolean);
  if (!held) {
    state.freeTicks += 1;
    state.slowTicks = Math.hypot(state.v.x, state.v.y) < STUCK_SPEED ? state.slowTicks + 1 : 0;
    if (state.slowTicks >= STUCK_TICKS) { state.outcome = 'LOST'; state.loss = 'STUCK'; return state; }
    if (state.freeTicks >= FREE_FLIGHT_LIMIT_TICKS) { state.outcome = 'LOST'; state.loss = 'FREE_FLIGHT_TIMEOUT'; return state; }
  }
  return state;
}

export interface TimedAction { tick: number; action: Action }

/** Deterministic replay: actions sorted by tick, applied at the start of that tick; runs until an outcome or maxTicks. */
export function replay(level: LevelPhysics, actions: readonly TimedAction[], maxTicks = 40 * TICK_RATE): SimState {
  const state = createSim(level);
  const sorted = [...actions].sort((a, b) => a.tick - b.tick);
  let next = 0;
  while (state.outcome === 'PLAYING' && state.tick < maxTicks) {
    const now: Action[] = [];
    while (next < sorted.length && sorted[next].tick <= state.tick) now.push(sorted[next++].action);
    stepSim(level, state, now);
  }
  return state;
}

/** Stable FNV-1a checksum of the logical state (determinism evidence). */
export function checksum(state: SimState): string {
  const text = JSON.stringify(state);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
