// [FILAMENT-1] Filament — pure input geometry and key mapping (no DOM). The page turns pointer positions into world
// coordinates with the renderer's viewport, then asks here which thread a tap or a swipe touches.
//   * tap / click: the nearest attached thread within the pick radius (larger for touch);
//   * swipe: every attached thread whose straight anchor → orb segment the stroke crosses;
//   * keys: Space / Enter / X cut the next attached thread, 1–8 cut that thread, P / Échap pause, R restart,
//     N next level (win screen only, decided by the caller), [FILAMENT-4] F switch the level's fan.
//   * [FILAMENT-4] fans: a tap / click on a fan's device (a round button drawn on the ground) switches it.
// A thread is hit-tested as a straight line even when it is drawn slack (the sag is presentation only).
import type { Vec } from './physics.ts';

export const PICK_RADIUS_MOUSE = 22;
export const PICK_RADIUS_TOUCH = 38;
/** [FILAMENT-4] fan devices are buttons: a larger target than a thread */
export const FAN_RADIUS_MOUSE = 26;
export const FAN_RADIUS_TOUCH = 42;

export interface FanDevice { readonly index: number; readonly x: number; readonly y: number }

/** [FILAMENT-4] Nearest fan device within `radius` of `point`, or -1. */
export function pickFan(point: Vec, fans: readonly FanDevice[], radius: number): number {
  let best = -1, bestDistance = radius;
  for (const fan of fans) {
    const d = Math.hypot(point.x - fan.x, point.y - fan.y);
    if (d <= bestDistance) { best = fan.index; bestDistance = d; }
  }
  return best;
}

export interface ThreadLine { readonly index: number; readonly a: Vec; readonly b: Vec }

export function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

function cross(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Proper or touching intersection of segments p1p2 and q1q2. */
export function segmentsIntersect(p1: Vec, p2: Vec, q1: Vec, q2: Vec): boolean {
  const d1 = cross(q1.x, q1.y, q2.x, q2.y, p1.x, p1.y);
  const d2 = cross(q1.x, q1.y, q2.x, q2.y, p2.x, p2.y);
  const d3 = cross(p1.x, p1.y, p2.x, p2.y, q1.x, q1.y);
  const d4 = cross(p1.x, p1.y, p2.x, p2.y, q2.x, q2.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0) || d1 === 0 || d2 === 0)
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0) || d3 === 0 || d4 === 0)
    && Math.min(p1.x, p2.x) <= Math.max(q1.x, q2.x) && Math.min(q1.x, q2.x) <= Math.max(p1.x, p2.x)
    && Math.min(p1.y, p2.y) <= Math.max(q1.y, q2.y) && Math.min(q1.y, q2.y) <= Math.max(p1.y, p2.y);
}

/** Nearest thread within `radius` of `point`, or -1. */
export function pickThread(point: Vec, lines: readonly ThreadLine[], radius: number): number {
  let best = -1, bestDistance = radius;
  for (const line of lines) {
    const d = distanceToSegment(point, line.a, line.b);
    if (d <= bestDistance) { best = line.index; bestDistance = d; }
  }
  return best;
}

/** Threads crossed by the stroke from → to (at most lines.length entries, written into `out`). */
export function threadsCrossed(from: Vec, to: Vec, lines: readonly ThreadLine[], out: number[]): number[] {
  out.length = 0;
  for (const line of lines) if (segmentsIntersect(from, to, line.a, line.b)) out.push(line.index);
  return out;
}

export type KeyCommand =
  | { kind: 'CUT_NEXT' }
  | { kind: 'CUT'; thread: number }
  | { kind: 'PAUSE' }
  | { kind: 'RESTART' }
  | { kind: 'NEXT' }
  /** slot = the level's n-th fan, in definition order (F: first, G: second) [FILAMENT-6 level 23 has two] */
  | { kind: 'FAN'; slot: number };

const CUT_NEXT: KeyCommand = { kind: 'CUT_NEXT' };
const FAN: KeyCommand = { kind: 'FAN', slot: 0 };
const FAN_SECOND: KeyCommand = { kind: 'FAN', slot: 1 };
const PAUSE: KeyCommand = { kind: 'PAUSE' };
const RESTART: KeyCommand = { kind: 'RESTART' };
const NEXT: KeyCommand = { kind: 'NEXT' };
const CUT_DIGIT: readonly KeyCommand[] = Object.freeze(Array.from({ length: 8 }, (_, thread) => Object.freeze({ kind: 'CUT', thread } as const)));

export function keyCommand(key: string): KeyCommand | null {
  switch (key) {
    case ' ': case 'Enter': case 'x': case 'X': return CUT_NEXT;
    case 'Escape': case 'p': case 'P': return PAUSE;
    case 'r': case 'R': return RESTART;
    case 'n': case 'N': return NEXT;
    case 'f': case 'F': return FAN;
    case 'g': case 'G': return FAN_SECOND;
    default: {
      const digit = /^[1-8]$/.test(key) ? Number(key) - 1 : -1;
      return digit >= 0 ? CUT_DIGIT[digit] : null;
    }
  }
}
