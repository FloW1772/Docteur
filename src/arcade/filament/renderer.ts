// [FILAMENT-1] Filament — Canvas 2D renderer, « Jardins de l’Aube ». Reads the simulation state, never writes it.
// [FILAMENT-2] Art pass: a sky that moves from deep night (level 1) towards dawn (last level), soft nebulae, a crescent
// moon that fades with the dawn, layered hills with a luminous garden, mist and vignette; interactive elements drawn
// brighter and warmer than the scenery (orb > goal > stars > threads > obstacles > background), a flower-shaped goal,
// crystal deflectors, stone walls, a glowing rift and a short, bounded victory bloom.
//
// Budget and resource rules (unchanged):
//   * ONE 2D context on the visible canvas and ONE on an offscreen background layer, both created once;
//   * the static background is painted into the layer only on resize, on a dawn (level) change or a reduced-motion
//     change, then copied with a single drawImage per frame;
//   * gradients, star / petal shapes and particle buffers are built once and reused (translate / scale / rotate);
//   * the orb trail is a fixed ring buffer (TRAIL_POINTS) and the victory bloom a fixed set of BLOOM_SPARKS;
//   * backing store capped: devicePixelRatio ≤ MAX_DPR and ≤ MAX_BACKING_PIXELS in total;
//   * no shadowBlur, no filters, no WebGL. Under reduced motion: no twinkle, pulse, rotation, trail, cut or bloom
//     animation — the scene stays complete and every obstacle keeps the same look.
// World units are the engine's (800 × 500, y down), letterboxed into the canvas.
// [FILAMENT-4] Second theme « Courants d’Altitude » (setTheme('altitude')): blue sky with a golden sun, distant sky
// mountains, floating islands, a crystal arch, a sea of clouds; gameplay elements get a thin dark outline on this
// lighter sky. Wind is drawn for any level that has currents: the zone, direction chevrons that stay visible under
// reduced motion, moving streaks (≤ MAX_STREAKS per zone, animated only without reduced motion), a ring showing the
// cycle of a timed current, and fan devices (round buttons, blades turning while on). The chapter-1 theme ('aube')
// draws exactly as before: same background, same palette values, no outline pass, and chapter-1 levels have no currents.
// [FILAMENT-5] Third theme « Vergers Stellaires » (setTheme('verger')): a cosmic orchard — indigo / violet sky with a
// rose horizon, pink / electric-blue / gold / green nebulae, constellations, two distant planets, floating orchard
// islands with silver-leaf trees, glowing fruits, phosphorescent flowers and violet / gold crystals (background layer,
// painted rarely). Animated only without reduced motion and bounded: the shared twinkling stars, ≤ ORCHARD_FRUITS fruit
// pulses and ≤ DUST_MOTES drifting motes per frame, no allocation. Wells (engine WellDef, until now never drawn) are drawn
// for any level that has them: influence ring, inward (or outward) chevrons that stay visible under reduced motion, a
// glowing core and, with motion, a slowly turning dashed ring. Pegs are drawn as star-fruits in this theme only.
// Chapters 1 and 2 have no wells and no pegs: their drawing is unchanged.
// [FILAMENT-6] Fourth theme « Lisière du Crépuscule » (setTheme('crepuscule')), the end of the journey between day and
// night, in six planes (background layer, painted rarely): a sunset sky (orange, dusty rose, violet, night blue, indigo)
// that darkens level after level (`dawn` = progress through the chapter), a low sun on the horizon with soft rays,
// distant mountains and suspended islands in silhouette, dusk mist, constellations that appear as the night comes,
// trees, golden-edged plants and opalescent crystals lit by the last glow; turquoise for interactive parts (anchors,
// halo, winds, fans), warm luminous threads, and a thin dark outline pass for readability over the bright horizon.
// Animated only without reduced motion and bounded: the shared twinkling stars and ≤ DUSK_FIREFLIES fireflies per frame,
// no allocation. Under reduced motion the scene is complete and static. Pegs get a golden rim in this theme only.
import { currentActive, ORB_RADIUS, STAR_RADIUS, WALL_THICKNESS, WORLD, type CurrentDef, type LevelPhysics, type SimState, type Vec } from './physics.ts';

export const MAX_DPR = 2;
export const MAX_BACKING_PIXELS = 2560 * 1600;
export const TRAIL_POINTS = 24;
export const CUT_EFFECT_MS = 450;
export const BLOOM_MS = 1100;
const BLOOM_SPARKS = 18;
const DECOR_STARS = 110;
const TWINKLE_STARS = 14;
const GLINT_STARS = 6;

type Rgb = readonly [number, number, number];
const NIGHT = { top: [5, 8, 23], mid: [15, 21, 56], low: [36, 32, 77], horizon: [59, 42, 90] } as const;
const DAWN = { top: [10, 18, 52], mid: [36, 44, 104], low: [112, 76, 138], horizon: [232, 156, 138] } as const;
// [FILAMENT-4] « Courants d’Altitude »: soft celestial blues, never saturated; golden morning → clear day
const ALT_MORNING = { top: [27, 74, 120], mid: [62, 132, 170], low: [150, 200, 214], horizon: [232, 222, 200] } as const;
const ALT_DAY = { top: [30, 86, 140], mid: [76, 152, 192], low: [160, 214, 226], horizon: [214, 238, 240] } as const;
// [FILAMENT-5] « Vergers Stellaires »: deep indigo night (first level) towards a richer violet / rose glow (last level)
const ORCHARD_EARLY = { top: [9, 7, 30], mid: [27, 16, 72], low: [58, 28, 98], horizon: [96, 44, 112] } as const;
const ORCHARD_LATE = { top: [14, 10, 44], mid: [40, 20, 92], low: [84, 34, 118], horizon: [150, 70, 128] } as const;
const ORCHARD_FRUITS = 9;
const DUST_MOTES = 10;
// [FILAMENT-6] « Lisière du Crépuscule »: warm sunset (first level of the chapter) towards the first night (last level)
const DUSK_EARLY = { top: [44, 32, 92], mid: [118, 62, 122], low: [214, 112, 112], horizon: [255, 180, 112] } as const;
const DUSK_LATE = { top: [8, 10, 34], mid: [28, 26, 78], low: [88, 46, 104], horizon: [190, 96, 98] } as const;
const DUSK_FIREFLIES = 8;
/** [FILAMENT-6] the low sun, on the horizon behind the far mountains (it sinks a little at each level) */
const DUSK_SUN = { x: 610, y: 392, sink: 46 } as const;
/** Wells: fixed colours (only chapter 3 has wells) */
const WELL = { ring: '#ffd86b', core: '#fff1c4', halo: 'rgba(255, 216, 107, 0.22)', field: 'rgba(255, 216, 107, 1)', repel: '#9fd2ff' } as const;

const COLOR = {
  hillFar: '#1b2350', hillMid: '#141a3e', hillNear: '#0a0e26', garden: '#070a1c',
  bud: '#ffd9a8', budCool: '#bfe9ff',
  thread: 'rgba(247, 240, 255, 0.95)', threadGlow: 'rgba(214, 196, 255, 0.22)', threadHot: '#ffffff',
  anchorFill: '#201a4a', anchorRing: '#d2c4ff', anchorGlow: 'rgba(210, 196, 255, 0.25)',
  star: '#ffe7a3', starCore: '#fff7da', starHalo: 'rgba(255, 226, 150, 0.20)',
  goalRing: '#8cf2e2', goalPetal: 'rgba(140, 242, 226, 0.55)', goalCore: '#e9fffb',
  wallShade: 'rgba(8, 6, 24, 0.55)', wall: '#a596d8', wallLight: '#f0eaff',
  deflectorShade: 'rgba(6, 22, 34, 0.55)', deflector: '#7fd6ea', deflectorLight: '#e6fbff',
  peg: '#cbbdf4', riftGlow: 'rgba(255, 92, 128, 0.22)', rift: '#ff7a98', riftCore: '#ffd2dc',
  trail: 'rgba(255, 214, 140, 1)', bloom: 'rgba(255, 236, 190, 1)',
} as const;

export type RenderTheme = 'aube' | 'altitude' | 'verger' | 'crepuscule';
const MAX_STREAKS = 12;
const CHEVRON_STEP = 48;

/** Gameplay colours; `outline` = an extra dark pass under threads, stars, goal and orb (null = none). */
type Palette = { -readonly [K in keyof typeof COLOR]: string } & { outline: string | null; wind: string; windZone: string; fanOn: string; fanOff: string; fanRing: string };
const AUBE: Palette = {
  ...COLOR, outline: null,
  wind: 'rgba(170, 230, 255, 1)', windZone: 'rgba(140, 220, 255, 1)', fanOn: '#ffe7a3', fanOff: '#8a86b0', fanRing: '#d2c4ff',
};
const ALTITUDE: Palette = {
  ...COLOR, outline: 'rgba(14, 32, 66, 0.55)',
  thread: '#ffffff', threadGlow: 'rgba(255, 255, 255, 0.32)', threadHot: '#fff7d6',
  anchorFill: '#1f3c66', anchorRing: '#ffffff', anchorGlow: 'rgba(255, 255, 255, 0.28)',
  star: '#ffd86b', starCore: '#fff6d2', starHalo: 'rgba(255, 216, 107, 0.22)',
  goalRing: '#19b3a1', goalPetal: 'rgba(25, 179, 161, 0.5)', goalCore: '#f0fffc',
  wallShade: 'rgba(14, 28, 60, 0.45)', wall: '#5f6f9e', wallLight: '#dfe6ff',
  deflectorShade: 'rgba(8, 40, 60, 0.45)', deflector: '#2aa7c9', deflectorLight: '#e9fbff',
  wind: 'rgba(255, 255, 255, 1)', windZone: 'rgba(255, 255, 255, 1)', fanOn: '#ffd86b', fanOff: '#8e9bb8', fanRing: '#1f3c66',
};
// [FILAMENT-5] dark sky again: no outline pass; gold anchors, green halo, violet crystals, rose fruits (pegs)
const VERGER: Palette = {
  ...COLOR, outline: null,
  thread: 'rgba(250, 244, 255, 0.95)', threadGlow: 'rgba(226, 196, 255, 0.24)', threadHot: '#ffffff',
  anchorFill: '#2a1650', anchorRing: '#f2d27a', anchorGlow: 'rgba(242, 210, 122, 0.24)',
  star: '#ffd86b', starCore: '#fff6d2', starHalo: 'rgba(255, 216, 107, 0.22)',
  goalRing: '#7ef0c8', goalPetal: 'rgba(126, 240, 200, 0.5)', goalCore: '#effff8',
  wallShade: 'rgba(14, 6, 30, 0.6)', wall: '#8a7bb8', wallLight: '#efe8ff',
  deflectorShade: 'rgba(20, 8, 40, 0.6)', deflector: '#b58cff', deflectorLight: '#f3e8ff',
  peg: '#ff9ec7',
  wind: 'rgba(170, 220, 255, 1)', windZone: 'rgba(170, 220, 255, 1)', fanOn: '#ffd86b', fanOff: '#8a86b0', fanRing: '#f2d27a',
};
// [FILAMENT-6] dusk: a thin dark outline (the horizon is bright in the first levels), warm luminous threads, turquoise
// interactive parts, opalescent crystals, stone walls with golden edges, dark stones (pegs, golden rim drawn separately)
const CREPUSCULE: Palette = {
  ...COLOR, outline: 'rgba(24, 12, 44, 0.5)',
  thread: '#fff6ea', threadGlow: 'rgba(255, 214, 160, 0.32)', threadHot: '#ffffff',
  anchorFill: '#1d1640', anchorRing: '#7ff0e0', anchorGlow: 'rgba(127, 240, 224, 0.25)',
  star: '#ffd36b', starCore: '#fff4d0', starHalo: 'rgba(255, 211, 107, 0.22)',
  goalRing: '#5ff2d8', goalPetal: 'rgba(95, 242, 216, 0.5)', goalCore: '#effffb',
  wallShade: 'rgba(16, 8, 30, 0.6)', wall: '#6e5a8e', wallLight: '#ffd9a0',
  deflectorShade: 'rgba(20, 10, 40, 0.6)', deflector: '#d9c4ff', deflectorLight: '#bffcf2',
  peg: '#4a3a70',
  wind: 'rgba(150, 245, 230, 1)', windZone: 'rgba(150, 245, 230, 1)', fanOn: '#ffd36b', fanOff: '#7d7aa8', fanRing: '#7ff0e0',
};
const PALETTES: Record<RenderTheme, Palette> = { aube: AUBE, altitude: ALTITUDE, verger: VERGER, crepuscule: CREPUSCULE };

export interface CutEffect { thread: number; x: number; y: number; atMs: number }

export interface RenderView {
  readonly physics: LevelPhysics;
  readonly state: SimState;
  /** share of the next tick already elapsed (0 when the attempt is not running) */
  readonly alpha: number;
  readonly nowMs: number;
  readonly cuts: readonly CutEffect[];
  /** thread under the mouse, or -1 */
  readonly highlightThread: number;
  /** false on menus: no trail is recorded */
  readonly running: boolean;
  /** time of the win (victory bloom), or null */
  readonly wonAtMs: number | null;
  /** [FILAMENT-4] fan device under the mouse, or -1 */
  readonly highlightFan?: number;
}

export interface FilamentRenderer {
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void;
  setReducedMotion(reduced: boolean): void;
  /** 0 = deep night … 1 = dawn; repaints the background layer when it changes */
  setDawn(dawn: number): void;
  /** [FILAMENT-4] chapter scenery and gameplay palette; repaints the background layer when it changes */
  setTheme(theme: RenderTheme): void;
  /** CSS pixel position inside the canvas → world units */
  toWorld(cssX: number, cssY: number, out: Vec): Vec;
  render(view: RenderView): void;
  resetTrail(): void;
  destroy(): void;
}

interface DecorStar { x: number; y: number; r: number; a: number; phase: number }
interface GardenTuft { x: number; h: number; lean: number; bud: boolean; cool: boolean }

/** Small deterministic generator for the decoration only (never used by the simulation). */
function generator(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function decorStars(): DecorStar[] {
  const next = generator(0x2f6b3d1);
  return Array.from({ length: DECOR_STARS }, () => {
    const bright = next();
    return { x: next() * WORLD.width, y: next() * WORLD.height * 0.68, r: 0.45 + bright * bright * 1.6, a: 0.25 + bright * 0.6, phase: next() * Math.PI * 2 };
  }).sort((p, q) => q.r - p.r); // brightest first: they twinkle and carry the glints
}

function gardenTufts(): GardenTuft[] {
  const next = generator(0x51a7e);
  return Array.from({ length: 34 }, (_, i) => ({ x: (i + next() * 0.8) * (WORLD.width / 34), h: 8 + next() * 22, lean: (next() - 0.5) * 8, bud: next() < 0.45, cool: next() < 0.3 }));
}

/** [FILAMENT-5] Floating orchard islands (background only, no collision): position, scale, tree offset. */
const ORCHARD_ISLANDS = [
  { x: 118, y: 418, s: 1, tree: -14 },
  { x: 418, y: 470, s: 1.2, tree: 18 },
  { x: 708, y: 400, s: 0.92, tree: -8 },
] as const;

interface OrchardFruit { x: number; y: number; warm: boolean }

/** Three glowing fruits per orchard tree, fixed once (painted in the layer; pulsed per frame without reduced motion). */
function orchardFruits(): OrchardFruit[] {
  const out: OrchardFruit[] = [];
  for (const isl of ORCHARD_ISLANDS) {
    const cx = isl.x + isl.tree * isl.s, cy = isl.y - 58 * isl.s;
    out.push({ x: cx - 14 * isl.s, y: cy + 8 * isl.s, warm: true }, { x: cx + 12 * isl.s, y: cy + 2 * isl.s, warm: false }, { x: cx + 2 * isl.s, y: cy - 14 * isl.s, warm: true });
  }
  return out.slice(0, ORCHARD_FRUITS);
}

function starPath(radius: number): Path2D {
  const path = new Path2D();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.45;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    if (i === 0) path.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
    else path.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  path.closePath();
  return path;
}

/** One petal of the goal flower, pointing up, base at the origin (unit length). */
function petalPath(): Path2D {
  const path = new Path2D();
  path.moveTo(0, 0);
  path.quadraticCurveTo(0.32, -0.45, 0, -1);
  path.quadraticCurveTo(-0.32, -0.45, 0, 0);
  path.closePath();
  return path;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('FILAMENT_CANVAS_2D_UNAVAILABLE');
  return ctx;
}

const mix = (a: Rgb, b: Rgb, t: number) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)}, ${Math.round(a[1] + (b[1] - a[1]) * t)}, ${Math.round(a[2] + (b[2] - a[2]) * t)})`;

export function createFilamentRenderer(canvas: HTMLCanvasElement): FilamentRenderer {
  const ctx = context2d(canvas);
  const layer = document.createElement('canvas');
  const layerCtx = context2d(layer);
  const stars = decorStars();
  const tufts = gardenTufts();
  const fruits = orchardFruits();
  const star = starPath(STAR_RADIUS);
  const petal = petalPath();
  const trail = new Float32Array(TRAIL_POINTS * 2);
  const sparks = new Float32Array(BLOOM_SPARKS * 3); // angle, speed, size — fixed at creation
  {
    const next = generator(0xb100);
    for (let i = 0; i < BLOOM_SPARKS; i++) {
      sparks[i * 3] = (i / BLOOM_SPARKS) * Math.PI * 2 + next() * 0.3;
      sparks[i * 3 + 1] = 40 + next() * 55;
      sparks[i * 3 + 2] = 1.2 + next() * 1.8;
    }
  }
  let trailCount = 0, trailHead = 0;
  let reducedMotion = false;
  let dawn = 0;
  let theme: RenderTheme = 'aube';
  let pal: Palette = AUBE;
  let pixelRatio = 1, scale = 1, offsetX = 0, offsetY = 0;

  const orbGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, ORB_RADIUS * 2.6);
  orbGlow.addColorStop(0, 'rgba(255, 248, 226, 1)');
  orbGlow.addColorStop(0.28, 'rgba(255, 224, 156, 0.95)');
  orbGlow.addColorStop(0.46, 'rgba(255, 196, 112, 0.42)');
  orbGlow.addColorStop(1, 'rgba(255, 190, 110, 0)');
  const orbCore = ctx.createRadialGradient(-ORB_RADIUS * 0.22, -ORB_RADIUS * 0.26, 0, 0, 0, ORB_RADIUS * 0.7);
  orbCore.addColorStop(0, '#ffffff');
  orbCore.addColorStop(0.55, '#fff3d0');
  orbCore.addColorStop(1, '#ffd58e');
  const goalGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  goalGlow.addColorStop(0, 'rgba(140, 242, 226, 0.34)');
  goalGlow.addColorStop(0.65, 'rgba(140, 242, 226, 0.12)');
  goalGlow.addColorStop(1, 'rgba(140, 242, 226, 0)');
  const starGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, STAR_RADIUS * 1.9);
  starGlow.addColorStop(0, 'rgba(255, 232, 170, 0.36)');
  starGlow.addColorStop(1, 'rgba(255, 232, 170, 0)');

  const worldTransform = (target: CanvasRenderingContext2D) => {
    target.setTransform(pixelRatio * scale, 0, 0, pixelRatio * scale, pixelRatio * offsetX, pixelRatio * offsetY);
  };

  // ── background layer (painted rarely) ────────────────────────────────────────────────────────────────────────
  function paintSky(w: number, h: number): CanvasGradient {
    const sky = layerCtx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, mix(NIGHT.top, DAWN.top, dawn));
    sky.addColorStop(0.5, mix(NIGHT.mid, DAWN.mid, dawn));
    sky.addColorStop(0.82, mix(NIGHT.low, DAWN.low, dawn));
    sky.addColorStop(1, mix(NIGHT.horizon, DAWN.horizon, dawn));
    layerCtx.fillStyle = sky;
    layerCtx.fillRect(0, 0, w, h);
    return sky;
  }

  function paintNebulae() {
    const blobs = [
      { x: 170, y: 120, r: 200, c: '150, 110, 230', a: 0.12 },
      { x: 610, y: 190, r: 240, c: '90, 190, 210', a: 0.08 },
      { x: 400, y: 360, r: 320, c: '235, 150, 170', a: 0.06 + dawn * 0.1 },
    ];
    for (const b of blobs) {
      const g = layerCtx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, `rgba(${b.c}, ${b.a})`);
      g.addColorStop(1, `rgba(${b.c}, 0)`);
      layerCtx.fillStyle = g;
      layerCtx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    }
  }

  function paintStarsAndMoon(sky: CanvasGradient) {
    const fade = 1 - dawn * 0.65; // the dawn washes the faint stars out
    for (let i = reducedMotion ? 0 : TWINKLE_STARS; i < stars.length; i++) {
      const s = stars[i];
      layerCtx.globalAlpha = s.a * fade;
      layerCtx.fillStyle = i % 7 === 0 ? '#ffe9c8' : '#e2e8ff';
      layerCtx.beginPath(); layerCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2); layerCtx.fill();
    }
    // a few glints: thin four-point crosses on the brightest stars
    layerCtx.strokeStyle = '#eef2ff';
    layerCtx.lineWidth = 0.6;
    for (let i = 0; i < GLINT_STARS; i++) {
      const s = stars[i];
      layerCtx.globalAlpha = 0.45 * fade;
      layerCtx.beginPath();
      layerCtx.moveTo(s.x - s.r * 4, s.y); layerCtx.lineTo(s.x + s.r * 4, s.y);
      layerCtx.moveTo(s.x, s.y - s.r * 4); layerCtx.lineTo(s.x, s.y + s.r * 4);
      layerCtx.stroke();
    }
    // a faint constellation
    layerCtx.globalAlpha = 0.14 * fade;
    layerCtx.strokeStyle = '#c9d4ff';
    layerCtx.lineWidth = 0.8;
    layerCtx.beginPath();
    layerCtx.moveTo(92, 58); layerCtx.lineTo(138, 84); layerCtx.lineTo(178, 70); layerCtx.lineTo(214, 104); layerCtx.lineTo(186, 132);
    layerCtx.stroke();
    // crescent moon (top right), fading as the dawn comes: a lit disc, then the sky painted over its offset copy
    const moon = { x: 690, y: 78, r: 20 };
    layerCtx.globalAlpha = 0.9 * (1 - dawn * 0.75);
    const halo = layerCtx.createRadialGradient(moon.x, moon.y, moon.r * 0.6, moon.x, moon.y, moon.r * 3.2);
    halo.addColorStop(0, 'rgba(255, 244, 214, 0.22)');
    halo.addColorStop(1, 'rgba(255, 244, 214, 0)');
    layerCtx.fillStyle = halo;
    layerCtx.beginPath(); layerCtx.arc(moon.x, moon.y, moon.r * 3.2, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.fillStyle = '#fff1d2';
    layerCtx.beginPath(); layerCtx.arc(moon.x, moon.y, moon.r, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.globalAlpha = 1;
    layerCtx.save();
    layerCtx.setTransform(1, 0, 0, 1, 0, 0); // the sky gradient lives in device pixels
    layerCtx.fillStyle = sky;
    const cx = pixelRatio * (offsetX + (moon.x + moon.r * 0.55) * scale), cy = pixelRatio * (offsetY + (moon.y - moon.r * 0.28) * scale);
    layerCtx.beginPath(); layerCtx.arc(cx, cy, pixelRatio * scale * moon.r * 0.92, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.restore();
  }

  function hill(points: readonly number[], fill: string | CanvasGradient) {
    layerCtx.fillStyle = fill;
    layerCtx.beginPath();
    layerCtx.moveTo(-80, points[0]);
    for (let i = 1; i < points.length; i++) {
      const x0 = -80 + ((i - 1) * 960) / (points.length - 1), x1 = -80 + (i * 960) / (points.length - 1);
      layerCtx.quadraticCurveTo((x0 + x1) / 2, (points[i - 1] + points[i]) / 2 - 10, x1, points[i]);
    }
    layerCtx.lineTo(880, 620); layerCtx.lineTo(-80, 620); layerCtx.closePath();
    layerCtx.fill();
  }

  function paintLandscape() {
    // dawn glow on the horizon
    const glow = layerCtx.createRadialGradient(400, 470, 10, 400, 470, 420);
    glow.addColorStop(0, `rgba(255, 186, 150, ${0.10 + dawn * 0.28})`);
    glow.addColorStop(1, 'rgba(255, 186, 150, 0)');
    layerCtx.fillStyle = glow;
    layerCtx.fillRect(-80, 160, 960, 400);
    hill([430, 400, 418, 392, 410, 384, 404], COLOR.hillFar);
    // mist between the far and the middle hills
    const mist = layerCtx.createLinearGradient(0, 400, 0, 470);
    mist.addColorStop(0, 'rgba(190, 170, 230, 0)');
    mist.addColorStop(0.5, `rgba(190, 170, 230, ${0.10 + dawn * 0.06})`);
    mist.addColorStop(1, 'rgba(190, 170, 230, 0)');
    layerCtx.fillStyle = mist;
    layerCtx.fillRect(-80, 400, 960, 70);
    hill([462, 444, 456, 438, 452, 446, 440], COLOR.hillMid);
    hill([494, 482, 490, 476, 488, 480, 486], COLOR.hillNear);
    // the garden: two round trees and a row of grass tufts with luminous buds, kept below the play area's floor line
    layerCtx.fillStyle = COLOR.garden;
    // both trees stay clear of every chapter-1 goal (closest: CH1-J at x 691 ± 34, CH1-H at x 187 ± 34)
    for (const t of [{ x: 58, y: 472, r: 24 }, { x: 774, y: 468, r: 28 }]) {
      layerCtx.fillRect(t.x - 2.5, t.y, 5, 40);
      layerCtx.beginPath(); layerCtx.arc(t.x, t.y - t.r * 0.5, t.r, 0, Math.PI * 2); layerCtx.fill();
      layerCtx.beginPath(); layerCtx.arc(t.x - t.r * 0.7, t.y - t.r * 0.1, t.r * 0.6, 0, Math.PI * 2); layerCtx.fill();
      layerCtx.beginPath(); layerCtx.arc(t.x + t.r * 0.7, t.y - t.r * 0.15, t.r * 0.62, 0, Math.PI * 2); layerCtx.fill();
    }
    layerCtx.strokeStyle = COLOR.garden;
    layerCtx.lineWidth = 2;
    layerCtx.lineCap = 'round';
    for (const tuft of tufts) {
      layerCtx.beginPath();
      layerCtx.moveTo(tuft.x, 502);
      layerCtx.quadraticCurveTo(tuft.x + tuft.lean * 0.3, 502 - tuft.h * 0.6, tuft.x + tuft.lean, 502 - tuft.h);
      layerCtx.stroke();
      if (!tuft.bud) continue;
      layerCtx.globalAlpha = 0.75;
      layerCtx.fillStyle = tuft.cool ? COLOR.budCool : COLOR.bud;
      layerCtx.beginPath(); layerCtx.arc(tuft.x + tuft.lean, 502 - tuft.h, 1.8, 0, Math.PI * 2); layerCtx.fill();
      layerCtx.globalAlpha = 1;
      layerCtx.fillStyle = COLOR.garden;
    }
  }

  function paintVignette(w: number, h: number) {
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    const v = layerCtx.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.35, w / 2, h * 0.45, Math.max(w, h) * 0.8);
    v.addColorStop(0, 'rgba(3, 4, 14, 0)');
    v.addColorStop(1, 'rgba(3, 4, 14, 0.5)');
    layerCtx.fillStyle = v;
    layerCtx.fillRect(0, 0, w, h);
  }

  // ── [FILAMENT-4] « Courants d’Altitude » background (painted rarely, like the chapter-1 one) ────────────────
  /** A floating island, drawn at the origin then placed by translate / scale (background only, no collision). */
  function island(x: number, y: number, s: number) {
    layerCtx.save();
    layerCtx.translate(x, y);
    layerCtx.scale(s, s);
    layerCtx.globalAlpha = 0.85;
    layerCtx.fillStyle = '#4d5f8e';
    layerCtx.beginPath();
    layerCtx.moveTo(-60, 0); layerCtx.lineTo(60, 0); layerCtx.lineTo(22, 48); layerCtx.lineTo(6, 70); layerCtx.lineTo(-14, 52); layerCtx.lineTo(-38, 30);
    layerCtx.closePath(); layerCtx.fill();
    layerCtx.strokeStyle = '#3f4f78';
    layerCtx.lineWidth = 1.2;
    layerCtx.beginPath();
    layerCtx.moveTo(-20, 30); layerCtx.lineTo(-24, 62);
    layerCtx.moveTo(10, 50); layerCtx.lineTo(12, 84);
    layerCtx.moveTo(30, 24); layerCtx.lineTo(36, 48);
    layerCtx.stroke();
    layerCtx.fillStyle = '#6fa69a';
    layerCtx.beginPath(); layerCtx.ellipse(0, 0, 64, 12, 0, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.fillStyle = '#5c9488';
    layerCtx.beginPath(); layerCtx.arc(-6, -12, 10, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.beginPath(); layerCtx.arc(6, -14, 8, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.fillStyle = 'rgba(176, 238, 252, 0.9)';
    layerCtx.beginPath();
    layerCtx.moveTo(-32, -4); layerCtx.lineTo(-27, -28); layerCtx.lineTo(-22, -4);
    layerCtx.moveTo(18, -4); layerCtx.lineTo(23, -19); layerCtx.lineTo(28, -4);
    layerCtx.fill();
    layerCtx.restore();
  }

  function cloudRow(y: number, color: string, seed: number) {
    const next = generator(seed);
    layerCtx.fillStyle = color;
    layerCtx.beginPath();
    for (let x = -60; x <= 860; x += 44) {
      const r = 30 + next() * 20;
      const cx = x + next() * 10, cy = y + next() * 8;
      layerCtx.moveTo(cx + r, cy);
      layerCtx.arc(cx, cy, r, 0, Math.PI * 2);
    }
    layerCtx.fill();
  }

  function paintAltitude(w: number, h: number) {
    // sky: morning (first level of the chapter) towards full day (last level); `dawn` carries that progress
    const sky = layerCtx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, mix(ALT_MORNING.top, ALT_DAY.top, dawn));
    sky.addColorStop(0.5, mix(ALT_MORNING.mid, ALT_DAY.mid, dawn));
    sky.addColorStop(0.82, mix(ALT_MORNING.low, ALT_DAY.low, dawn));
    sky.addColorStop(1, mix(ALT_MORNING.horizon, ALT_DAY.horizon, dawn));
    layerCtx.fillStyle = sky;
    layerCtx.fillRect(0, 0, w, h);
    worldTransform(layerCtx);
    // golden sun, high on the right
    const sun = layerCtx.createRadialGradient(640, 92, 10, 640, 92, 280);
    sun.addColorStop(0, `rgba(255, 226, 160, ${0.42 - dawn * 0.14})`);
    sun.addColorStop(1, 'rgba(255, 226, 160, 0)');
    layerCtx.fillStyle = sun;
    layerCtx.fillRect(360, -190, 560, 560);
    layerCtx.fillStyle = 'rgba(255, 244, 214, 0.9)';
    layerCtx.beginPath(); layerCtx.arc(640, 92, 24, 0, Math.PI * 2); layerCtx.fill();
    // high thin clouds
    layerCtx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    for (const c of [{ x: 150, y: 70, rx: 120, ry: 9 }, { x: 330, y: 112, rx: 90, ry: 7 }, { x: 520, y: 58, rx: 140, ry: 8 }, { x: 740, y: 150, rx: 100, ry: 7 }]) {
      layerCtx.beginPath(); layerCtx.ellipse(c.x, c.y, c.rx, c.ry, 0, 0, Math.PI * 2); layerCtx.fill();
    }
    // distant sky mountains
    hill([402, 350, 380, 336, 366, 344, 374], 'rgba(150, 170, 214, 0.55)');
    hill([432, 402, 416, 394, 410, 398, 412], 'rgba(118, 146, 198, 0.5)');
    // crystal arch
    layerCtx.lineCap = 'round';
    layerCtx.strokeStyle = 'rgba(210, 245, 255, 0.22)';
    layerCtx.lineWidth = 7;
    layerCtx.beginPath(); layerCtx.moveTo(300, 470); layerCtx.quadraticCurveTo(430, 230, 560, 470); layerCtx.stroke();
    layerCtx.strokeStyle = 'rgba(240, 252, 255, 0.5)';
    layerCtx.lineWidth = 1.6;
    layerCtx.stroke();
    // floating islands (scenery only: they never collide)
    island(105, 250, 0.75);
    island(560, 140, 0.5);
    island(738, 300, 0.65);
    // long wind ribbons
    layerCtx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
    layerCtx.lineWidth = 2.5;
    layerCtx.beginPath();
    layerCtx.moveTo(-40, 200); layerCtx.bezierCurveTo(180, 150, 380, 240, 840, 170);
    layerCtx.moveTo(-40, 330); layerCtx.bezierCurveTo(220, 290, 500, 370, 840, 310);
    layerCtx.moveTo(-40, 110); layerCtx.bezierCurveTo(260, 80, 460, 140, 840, 96);
    layerCtx.stroke();
    // the sea of clouds, three rows, the nearest one brightest
    cloudRow(458, 'rgba(222, 238, 246, 0.72)', 0xc10d1);
    cloudRow(482, 'rgba(236, 246, 250, 0.88)', 0xc10d2);
    cloudRow(508, 'rgba(246, 251, 252, 1)', 0xc10d3);
    // light vignette
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    const v = layerCtx.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.4, w / 2, h * 0.45, Math.max(w, h) * 0.85);
    v.addColorStop(0, 'rgba(10, 30, 60, 0)');
    v.addColorStop(1, 'rgba(10, 30, 60, 0.28)');
    layerCtx.fillStyle = v;
    layerCtx.fillRect(0, 0, w, h);
  }

  // ── [FILAMENT-5] « Vergers Stellaires » background (painted rarely, like the other two) ─────────────────────────
  function glowDisc(x: number, y: number, r: number, rgb: string, a: number) {
    const g = layerCtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb}, ${a})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    layerCtx.fillStyle = g;
    layerCtx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /** A floating orchard island: violet rock, mossy top, crystals, flowers, one silver-leaf tree with its fruits. */
  function orchardIsland(x: number, y: number, s: number, tree: number) {
    layerCtx.save();
    layerCtx.translate(x, y);
    layerCtx.scale(s, s);
    layerCtx.fillStyle = '#2b1a52';
    layerCtx.beginPath();
    layerCtx.moveTo(-66, 0); layerCtx.lineTo(66, 0); layerCtx.lineTo(30, 40); layerCtx.lineTo(8, 64); layerCtx.lineTo(-12, 46); layerCtx.lineTo(-40, 28);
    layerCtx.closePath(); layerCtx.fill();
    layerCtx.strokeStyle = 'rgba(160, 120, 230, 0.35)';
    layerCtx.lineWidth = 1.2;
    layerCtx.beginPath(); layerCtx.moveTo(-18, 26); layerCtx.lineTo(-22, 58); layerCtx.moveTo(14, 44); layerCtx.lineTo(16, 78); layerCtx.stroke();
    layerCtx.fillStyle = '#1f4a4a';
    layerCtx.beginPath(); layerCtx.ellipse(0, 0, 70, 12, 0, 0, Math.PI * 2); layerCtx.fill();
    // violet and gold crystals
    layerCtx.fillStyle = 'rgba(190, 150, 255, 0.85)';
    layerCtx.beginPath(); layerCtx.moveTo(-50, -3); layerCtx.lineTo(-45, -24); layerCtx.lineTo(-40, -3); layerCtx.fill();
    layerCtx.fillStyle = 'rgba(255, 214, 120, 0.8)';
    layerCtx.beginPath(); layerCtx.moveTo(44, -3); layerCtx.lineTo(48, -17); layerCtx.lineTo(52, -3); layerCtx.fill();
    // phosphorescent flowers
    for (const f of [{ x: -28, c: 'rgba(140, 255, 200, 0.9)' }, { x: 26, c: 'rgba(150, 200, 255, 0.9)' }, { x: 56, c: 'rgba(255, 160, 220, 0.9)' }]) {
      layerCtx.strokeStyle = 'rgba(120, 200, 170, 0.6)';
      layerCtx.lineWidth = 1;
      layerCtx.beginPath(); layerCtx.moveTo(f.x, -2); layerCtx.lineTo(f.x, -10); layerCtx.stroke();
      layerCtx.fillStyle = f.c;
      layerCtx.beginPath(); layerCtx.arc(f.x, -11, 2.4, 0, Math.PI * 2); layerCtx.fill();
    }
    // silver-leaf tree
    layerCtx.strokeStyle = '#4a3a6e';
    layerCtx.lineWidth = 4;
    layerCtx.lineCap = 'round';
    layerCtx.beginPath(); layerCtx.moveTo(tree, -2); layerCtx.quadraticCurveTo(tree - 4, -26, tree + 2, -46); layerCtx.stroke();
    layerCtx.fillStyle = 'rgba(206, 214, 236, 0.55)';
    for (const leaf of [{ dx: -16, dy: -56, r: 17 }, { dx: 14, dy: -60, r: 16 }, { dx: 0, dy: -74, r: 15 }, { dx: -2, dy: -52, r: 14 }]) {
      layerCtx.beginPath(); layerCtx.arc(tree + leaf.dx, leaf.dy, leaf.r, 0, Math.PI * 2); layerCtx.fill();
    }
    layerCtx.fillStyle = 'rgba(240, 244, 255, 0.35)';
    layerCtx.beginPath(); layerCtx.arc(tree - 6, -70, 7, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.restore();
  }

  function paintVerger(w: number, h: number) {
    const sky = layerCtx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, mix(ORCHARD_EARLY.top, ORCHARD_LATE.top, dawn));
    sky.addColorStop(0.5, mix(ORCHARD_EARLY.mid, ORCHARD_LATE.mid, dawn));
    sky.addColorStop(0.82, mix(ORCHARD_EARLY.low, ORCHARD_LATE.low, dawn));
    sky.addColorStop(1, mix(ORCHARD_EARLY.horizon, ORCHARD_LATE.horizon, dawn));
    layerCtx.fillStyle = sky;
    layerCtx.fillRect(0, 0, w, h);
    worldTransform(layerCtx);
    // nebulae: rose, electric blue, gold, luminescent green
    glowDisc(190, 150, 230, '230, 120, 200', 0.14);
    glowDisc(600, 190, 260, '110, 150, 255', 0.11);
    glowDisc(420, 330, 300, '255, 200, 120', 0.05 + dawn * 0.05);
    glowDisc(730, 330, 200, '120, 230, 180', 0.06);
    // a faint diagonal band of star dust
    layerCtx.save();
    layerCtx.translate(400, 210);
    layerCtx.rotate(-0.32);
    const band = layerCtx.createLinearGradient(0, -60, 0, 60);
    band.addColorStop(0, 'rgba(220, 200, 255, 0)');
    band.addColorStop(0.5, 'rgba(220, 200, 255, 0.07)');
    band.addColorStop(1, 'rgba(220, 200, 255, 0)');
    layerCtx.fillStyle = band;
    layerCtx.fillRect(-520, -60, 1040, 120);
    layerCtx.restore();
    // stars (the brightest ones twinkle per frame unless reduced motion) and glints
    for (let i = reducedMotion ? 0 : TWINKLE_STARS; i < stars.length; i++) {
      const s = stars[i];
      layerCtx.globalAlpha = s.a;
      layerCtx.fillStyle = i % 5 === 0 ? '#ffe3a8' : i % 7 === 0 ? '#ffc8ec' : '#e6e2ff';
      layerCtx.beginPath(); layerCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2); layerCtx.fill();
    }
    layerCtx.strokeStyle = '#f4ecff';
    layerCtx.lineWidth = 0.6;
    for (let i = 0; i < GLINT_STARS; i++) {
      const s = stars[i];
      layerCtx.globalAlpha = 0.5;
      layerCtx.beginPath();
      layerCtx.moveTo(s.x - s.r * 4, s.y); layerCtx.lineTo(s.x + s.r * 4, s.y);
      layerCtx.moveTo(s.x, s.y - s.r * 4); layerCtx.lineTo(s.x, s.y + s.r * 4);
      layerCtx.stroke();
    }
    // two constellations: lines, then gold nodes
    const figures = [
      [{ x: 248, y: 62 }, { x: 290, y: 44 }, { x: 334, y: 58 }, { x: 320, y: 98 }, { x: 272, y: 94 }, { x: 248, y: 62 }],
      [{ x: 512, y: 42 }, { x: 552, y: 68 }, { x: 598, y: 60 }, { x: 632, y: 90 }],
    ];
    layerCtx.globalAlpha = 0.3;
    layerCtx.strokeStyle = '#d8c8ff';
    layerCtx.lineWidth = 0.8;
    for (const fig of figures) {
      layerCtx.beginPath();
      fig.forEach((p, i) => (i === 0 ? layerCtx.moveTo(p.x, p.y) : layerCtx.lineTo(p.x, p.y)));
      layerCtx.stroke();
    }
    layerCtx.globalAlpha = 0.85;
    layerCtx.fillStyle = '#ffe6a6';
    for (const fig of figures) for (const p of fig) { layerCtx.beginPath(); layerCtx.arc(p.x, p.y, 1.6, 0, Math.PI * 2); layerCtx.fill(); }
    layerCtx.globalAlpha = 1;
    // distant planets: a ringed one top right, a small green one top left
    glowDisc(690, 92, 60, '255, 190, 230', 0.18);
    const planet = layerCtx.createLinearGradient(670, 72, 710, 112);
    planet.addColorStop(0, '#f2b6dd');
    planet.addColorStop(1, '#6a3c9a');
    layerCtx.fillStyle = planet;
    layerCtx.beginPath(); layerCtx.arc(690, 92, 21, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.strokeStyle = 'rgba(255, 228, 170, 0.6)';
    layerCtx.lineWidth = 2;
    layerCtx.beginPath(); layerCtx.ellipse(690, 92, 36, 8, -0.35, 0, Math.PI * 2); layerCtx.stroke();
    layerCtx.fillStyle = '#7fd8b0';
    layerCtx.globalAlpha = 0.8;
    layerCtx.beginPath(); layerCtx.arc(112, 74, 8, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.globalAlpha = 1;
    // floating orchards, then their fruits
    for (const isl of ORCHARD_ISLANDS) orchardIsland(isl.x, isl.y, isl.s, isl.tree);
    for (const f of fruits) {
      layerCtx.fillStyle = f.warm ? 'rgba(255, 150, 200, 0.95)' : 'rgba(140, 255, 200, 0.95)';
      layerCtx.beginPath(); layerCtx.arc(f.x, f.y, 3.6, 0, Math.PI * 2); layerCtx.fill();
    }
    // vignette
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    const v = layerCtx.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.35, w / 2, h * 0.45, Math.max(w, h) * 0.8);
    v.addColorStop(0, 'rgba(6, 2, 18, 0)');
    v.addColorStop(1, 'rgba(6, 2, 18, 0.5)');
    layerCtx.fillStyle = v;
    layerCtx.fillRect(0, 0, w, h);
  }

  // ── [FILAMENT-6] « Lisière du Crépuscule » background (painted rarely, like the other three) ───────────────────
  /** A suspended island in silhouette (background only, no collision), lit on its sun side. */
  function duskIsland(x: number, y: number, s: number) {
    layerCtx.save();
    layerCtx.translate(x, y);
    layerCtx.scale(s, s);
    layerCtx.fillStyle = 'rgba(40, 22, 66, 0.82)';
    layerCtx.beginPath();
    layerCtx.moveTo(-58, 0); layerCtx.lineTo(58, 0); layerCtx.lineTo(24, 36); layerCtx.lineTo(4, 58); layerCtx.lineTo(-16, 40); layerCtx.lineTo(-40, 22);
    layerCtx.closePath(); layerCtx.fill();
    layerCtx.beginPath(); layerCtx.ellipse(0, 0, 62, 9, 0, 0, Math.PI * 2); layerCtx.fill();
    // a small tree and the golden edge facing the sun
    layerCtx.beginPath(); layerCtx.arc(-8, -18, 13, 0, Math.PI * 2); layerCtx.arc(8, -22, 11, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.strokeStyle = 'rgba(255, 196, 120, 0.55)';
    layerCtx.lineWidth = 1.4;
    layerCtx.beginPath(); layerCtx.arc(8, -22, 11, -1.2, 0.6); layerCtx.moveTo(10, -1); layerCtx.lineTo(56, -1); layerCtx.stroke();
    layerCtx.restore();
  }

  /** A foreground tree in silhouette with a golden rim on its sun side (background only, kept below y 430). */
  function duskTree(x: number, y: number, r: number) {
    layerCtx.fillStyle = '#120a24';
    layerCtx.fillRect(x - 2.5, y, 5, 60);
    for (const leaf of [{ dx: 0, dy: -0.5, k: 1 }, { dx: -0.7, dy: -0.1, k: 0.62 }, { dx: 0.7, dy: -0.15, k: 0.6 }]) {
      layerCtx.beginPath(); layerCtx.arc(x + leaf.dx * r, y + leaf.dy * r, r * leaf.k, 0, Math.PI * 2); layerCtx.fill();
    }
    layerCtx.strokeStyle = 'rgba(255, 200, 120, 0.6)';
    layerCtx.lineWidth = 1.6;
    layerCtx.beginPath(); layerCtx.arc(x, y - 0.5 * r, r, -1.4, 0.2); layerCtx.stroke();
  }

  /** Opalescent crystals: a small cluster of upright shards (rose, lilac, turquoise faces). */
  function duskCrystals(x: number, y: number, s: number) {
    const shards = [{ dx: -9, h: 20, w: 5, c: 'rgba(255, 190, 220, 0.8)' }, { dx: 0, h: 30, w: 6, c: 'rgba(214, 196, 255, 0.85)' }, { dx: 9, h: 17, w: 5, c: 'rgba(160, 250, 236, 0.8)' }];
    for (const sh of shards) {
      layerCtx.fillStyle = sh.c;
      layerCtx.beginPath();
      layerCtx.moveTo(x + (sh.dx - sh.w) * s, y); layerCtx.lineTo(x + sh.dx * s, y - sh.h * s); layerCtx.lineTo(x + (sh.dx + sh.w) * s, y);
      layerCtx.closePath(); layerCtx.fill();
    }
    layerCtx.strokeStyle = 'rgba(255, 248, 236, 0.7)';
    layerCtx.lineWidth = 0.8;
    layerCtx.beginPath(); layerCtx.moveTo(x, y); layerCtx.lineTo(x, y - 30 * s); layerCtx.stroke();
  }

  function paintCrepuscule(w: number, h: number) {
    // 1. sky and horizon: sunset (first level of the chapter) towards the first night (last level)
    const sky = layerCtx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, mix(DUSK_EARLY.top, DUSK_LATE.top, dawn));
    sky.addColorStop(0.45, mix(DUSK_EARLY.mid, DUSK_LATE.mid, dawn));
    sky.addColorStop(0.78, mix(DUSK_EARLY.low, DUSK_LATE.low, dawn));
    sky.addColorStop(1, mix(DUSK_EARLY.horizon, DUSK_LATE.horizon, dawn));
    layerCtx.fillStyle = sky;
    layerCtx.fillRect(0, 0, w, h);
    worldTransform(layerCtx);
    // the last light: a very low sun, its glow and a few soft static rays (fainter as the night comes)
    const sunY = DUSK_SUN.y + dawn * DUSK_SUN.sink;
    glowDisc(DUSK_SUN.x, sunY, 340, '255, 168, 112', 0.32 - dawn * 0.16);
    glowDisc(DUSK_SUN.x, sunY, 130, '255, 214, 150', 0.4 - dawn * 0.2);
    layerCtx.save();
    layerCtx.translate(DUSK_SUN.x, sunY);
    layerCtx.globalAlpha = 0.07 * (1 - dawn * 0.6);
    layerCtx.fillStyle = 'rgba(255, 222, 170, 1)';
    for (let k = 0; k < 7; k++) {
      layerCtx.rotate(k === 0 ? -Math.PI * 0.92 : Math.PI * 0.14);
      layerCtx.beginPath(); layerCtx.moveTo(0, 0); layerCtx.lineTo(560, -16); layerCtx.lineTo(560, 16); layerCtx.closePath(); layerCtx.fill();
    }
    layerCtx.restore();
    layerCtx.globalAlpha = 0.95 - dawn * 0.3;
    layerCtx.fillStyle = '#ffd9a0';
    layerCtx.beginPath(); layerCtx.arc(DUSK_SUN.x, sunY, 26, 0, Math.PI * 2); layerCtx.fill();
    layerCtx.globalAlpha = 1;
    // 4. the first stars, in the upper sky only; more of them at each level (the brightest twinkle per frame)
    const night = 0.25 + dawn * 0.75;
    for (let i = reducedMotion ? 0 : TWINKLE_STARS; i < stars.length; i++) {
      const s = stars[i];
      if (s.y > 300) continue;
      layerCtx.globalAlpha = s.a * night * (1 - s.y / 380);
      layerCtx.fillStyle = i % 6 === 0 ? '#ffe2b8' : '#eae6ff';
      layerCtx.beginPath(); layerCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2); layerCtx.fill();
    }
    // nascent constellations: fragments, clearer at each level
    const figures = [
      [{ x: 96, y: 52 }, { x: 138, y: 74 }, { x: 182, y: 62 }, { x: 214, y: 96 }],
      [{ x: 352, y: 40 }, { x: 396, y: 58 }, { x: 440, y: 46 }, { x: 470, y: 78 }, { x: 430, y: 104 }],
      [{ x: 700, y: 46 }, { x: 742, y: 72 }, { x: 770, y: 54 }],
    ];
    layerCtx.globalAlpha = 0.1 + dawn * 0.24;
    layerCtx.strokeStyle = '#e2d6ff';
    layerCtx.lineWidth = 0.8;
    for (const fig of figures) {
      layerCtx.beginPath();
      fig.forEach((p, i) => (i === 0 ? layerCtx.moveTo(p.x, p.y) : layerCtx.lineTo(p.x, p.y)));
      layerCtx.stroke();
    }
    layerCtx.globalAlpha = 0.35 + dawn * 0.5;
    layerCtx.fillStyle = '#ffe6b0';
    for (const fig of figures) for (const p of fig) { layerCtx.beginPath(); layerCtx.arc(p.x, p.y, 1.5, 0, Math.PI * 2); layerCtx.fill(); }
    layerCtx.globalAlpha = 1;
    // 2. distant mountains (they hide the lower half of the sun) and suspended islands in silhouette
    hill([392, 360, 384, 350, 376, 356, 370], `rgba(${Math.round(110 - dawn * 50)}, ${Math.round(58 - dawn * 22)}, ${Math.round(112 - dawn * 30)}, 0.9)`);
    duskIsland(130, 236, 0.62);
    duskIsland(468, 150, 0.42);
    duskIsland(742, 300, 0.5);
    // 3. dusk mist: soft rose and violet bands
    layerCtx.fillStyle = `rgba(255, 170, 190, ${0.1 - dawn * 0.05})`;
    for (const m of [{ x: 200, y: 404, rx: 260, ry: 12 }, { x: 600, y: 418, rx: 300, ry: 10 }]) {
      layerCtx.beginPath(); layerCtx.ellipse(m.x, m.y, m.rx, m.ry, 0, 0, Math.PI * 2); layerCtx.fill();
    }
    hill([430, 414, 426, 408, 420, 412, 418], 'rgba(46, 24, 68, 0.94)');
    layerCtx.fillStyle = `rgba(190, 150, 230, ${0.08 + dawn * 0.04})`;
    layerCtx.beginPath(); layerCtx.ellipse(400, 446, 460, 9, 0, 0, Math.PI * 2); layerCtx.fill();
    hill([476, 462, 472, 458, 470, 462, 468], '#160c2a');
    // 5. trees, golden-edged plants and opalescent crystals lit by the last glow (all below the play area's floor line)
    duskTree(46, 452, 22);
    duskTree(778, 446, 26);
    duskCrystals(300, 482, 0.9);
    duskCrystals(540, 488, 0.75);
    layerCtx.lineWidth = 1.6;
    layerCtx.lineCap = 'round';
    for (const tuft of tufts) {
      layerCtx.strokeStyle = '#120a24';
      layerCtx.beginPath();
      layerCtx.moveTo(tuft.x, 502);
      layerCtx.quadraticCurveTo(tuft.x + tuft.lean * 0.3, 502 - tuft.h * 0.6, tuft.x + tuft.lean, 502 - tuft.h);
      layerCtx.stroke();
      if (!tuft.bud) continue;
      layerCtx.strokeStyle = tuft.cool ? 'rgba(150, 245, 230, 0.7)' : 'rgba(255, 200, 120, 0.75)';
      layerCtx.beginPath();
      layerCtx.moveTo(tuft.x + tuft.lean * 0.3, 502 - tuft.h * 0.6);
      layerCtx.quadraticCurveTo(tuft.x + tuft.lean * 0.7, 502 - tuft.h * 0.85, tuft.x + tuft.lean, 502 - tuft.h);
      layerCtx.stroke();
    }
    // vignette
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    const v = layerCtx.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.38, w / 2, h * 0.45, Math.max(w, h) * 0.82);
    v.addColorStop(0, 'rgba(10, 4, 22, 0)');
    v.addColorStop(1, 'rgba(10, 4, 22, 0.42)');
    layerCtx.fillStyle = v;
    layerCtx.fillRect(0, 0, w, h);
  }

  function paintBackground() {
    const w = layer.width, h = layer.height;
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.globalAlpha = 1;
    if (theme === 'altitude') { paintAltitude(w, h); return; }
    if (theme === 'verger') { paintVerger(w, h); return; }
    if (theme === 'crepuscule') { paintCrepuscule(w, h); return; }
    const sky = paintSky(w, h);
    worldTransform(layerCtx);
    paintNebulae();
    paintStarsAndMoon(sky);
    worldTransform(layerCtx);
    paintLandscape();
    paintVignette(w, h);
  }

  // ── interactive layer (every frame) ──────────────────────────────────────────────────────────────────────────
  function drawGoal(goal: LevelPhysics['goal'], nowMs: number, won: boolean) {
    const t = reducedMotion ? 0 : nowMs / 1000;
    const pulse = reducedMotion ? 0.8 : 0.68 + 0.16 * Math.sin(t * 1.4);
    ctx.save();
    ctx.translate(goal.x, goal.y);
    ctx.save();
    ctx.globalAlpha = won ? 1 : pulse;
    ctx.scale(goal.r * 2.3, goal.r * 2.3);
    ctx.fillStyle = goalGlow;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // six petals, slowly turning
    ctx.save();
    ctx.rotate(t * 0.25);
    ctx.fillStyle = pal.goalPetal;
    for (let i = 0; i < 6; i++) {
      ctx.save();
      ctx.rotate((i * Math.PI) / 3);
      ctx.translate(0, -goal.r * 0.18);
      ctx.scale(goal.r * 0.62, goal.r * 0.78);
      ctx.fill(petal);
      ctx.restore();
    }
    ctx.restore();
    if (pal.outline) {
      ctx.strokeStyle = pal.outline;
      ctx.lineWidth = 4.6;
      ctx.beginPath(); ctx.arc(0, 0, goal.r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = pal.goalRing;
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(0, 0, goal.r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, goal.r * 1.18, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.goalCore;
    ctx.beginPath(); ctx.arc(0, 0, goal.r * 0.16, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function strokeSegment(a: Vec, b: Vec) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }

  function drawObstacles(physics: LevelPhysics, nowMs: number) {
    ctx.lineCap = 'round';
    for (const s of physics.segments ?? []) {
      const crystal = s.kind === 'deflector';
      ctx.strokeStyle = crystal ? pal.deflectorShade : pal.wallShade;
      ctx.lineWidth = WALL_THICKNESS + 6;
      strokeSegment(s.a, s.b);
      ctx.strokeStyle = crystal ? pal.deflector : pal.wall;
      ctx.lineWidth = WALL_THICKNESS;
      strokeSegment(s.a, s.b);
      ctx.strokeStyle = crystal ? pal.deflectorLight : pal.wallLight;
      ctx.lineWidth = 1.6;
      strokeSegment(s.a, s.b);
    }
    for (const peg of physics.pegs ?? []) {
      ctx.fillStyle = pal.peg;
      ctx.beginPath(); ctx.arc(peg.x, peg.y, peg.r, 0, Math.PI * 2); ctx.fill();
      if (theme === 'crepuscule') {
        // [FILAMENT-6] a dark stone with a golden rim (same solid disc: the engine's peg radius)
        ctx.strokeStyle = '#ffcf8a';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(peg.x, peg.y, peg.r, 0, Math.PI * 2); ctx.stroke();
        continue;
      }
      if (theme !== 'verger') continue;
      // [FILAMENT-5] star-fruit: a highlight and a small leaf (same solid disc: the engine's peg radius)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.beginPath(); ctx.arc(peg.x - peg.r * 0.35, peg.y - peg.r * 0.35, peg.r * 0.28, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#7fe0b4';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(peg.x, peg.y - peg.r); ctx.quadraticCurveTo(peg.x + peg.r * 0.6, peg.y - peg.r * 1.7, peg.x + peg.r * 1.1, peg.y - peg.r * 1.2); ctx.stroke();
    }
    const rifts = physics.rifts ?? [];
    if (rifts.length === 0) return;
    const flicker = reducedMotion ? 1 : 0.8 + 0.2 * Math.sin(nowMs / 260);
    for (const r of rifts) {
      ctx.globalAlpha = flicker;
      ctx.strokeStyle = pal.riftGlow;
      ctx.lineWidth = 16;
      strokeSegment(r.a, r.b);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.rift;
      ctx.lineWidth = 4;
      ctx.setLineDash([9, 6]);
      strokeSegment(r.a, r.b);
      ctx.setLineDash([]);
      ctx.strokeStyle = pal.riftCore;
      ctx.lineWidth = 1.2;
      strokeSegment(r.a, r.b);
    }
  }

  function drawStars(physics: LevelPhysics, state: SimState, nowMs: number) {
    const spin = reducedMotion ? 0 : Math.sin(nowMs / 1400) * 0.18;
    for (let i = 0; i < physics.stars.length; i++) {
      const s = physics.stars[i];
      if (!state.starsTaken[i]) {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.fillStyle = starGlow;
        ctx.beginPath(); ctx.arc(0, 0, STAR_RADIUS * 1.9, 0, Math.PI * 2); ctx.fill();
        ctx.rotate(spin + i * 0.4);
        if (pal.outline) {
          ctx.strokeStyle = pal.outline;
          ctx.lineWidth = 2.4;
          ctx.lineJoin = 'round';
          ctx.stroke(star);
        }
        ctx.fillStyle = pal.star;
        ctx.fill(star);
        ctx.scale(0.42, 0.42);
        ctx.fillStyle = pal.starCore;
        ctx.fill(star);
        ctx.restore();
        continue;
      }
      const age = state.tick - state.starAt[i];
      if (reducedMotion || state.starAt[i] < 0 || age > 36) continue;
      // collected: one soft expanding ring, measured in ticks so it freezes with the game
      const k = age / 36;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = pal.star;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s.x, s.y, STAR_RADIUS * (1 + k * 1.6), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawThreads(view: RenderView, orb: Vec) {
    const { physics, state } = view;
    ctx.lineCap = 'round';
    for (let i = 0; i < physics.threads.length; i++) {
      if (!state.attached[i]) continue;
      const { anchor, length } = physics.threads[i];
      const d = Math.hypot(orb.x - anchor.x, orb.y - anchor.y);
      const hot = i === view.highlightThread;
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      if (d < length - 0.5) {
        // slack thread: a gentle sag, presentation only (the engine models a straight inextensible thread)
        const sag = Math.min(0.5 * Math.sqrt(length * length - d * d), 60);
        ctx.quadraticCurveTo((anchor.x + orb.x) / 2, (anchor.y + orb.y) / 2 + sag, orb.x, orb.y);
      } else {
        ctx.lineTo(orb.x, orb.y);
      }
      if (pal.outline) {
        ctx.strokeStyle = pal.outline;
        ctx.lineWidth = hot ? 6 : 4.4;
        ctx.stroke();
      }
      ctx.strokeStyle = pal.threadGlow;
      ctx.lineWidth = hot ? 9 : 6;
      ctx.stroke();
      ctx.strokeStyle = hot ? pal.threadHot : pal.thread;
      ctx.lineWidth = hot ? 3 : 1.9;
      ctx.stroke();
    }
    for (const t of physics.threads) {
      ctx.fillStyle = pal.anchorGlow;
      ctx.beginPath(); ctx.arc(t.anchor.x, t.anchor.y, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = pal.anchorFill;
      ctx.strokeStyle = pal.anchorRing;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(t.anchor.x, t.anchor.y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  function drawCutEffects(view: RenderView) {
    if (reducedMotion) return;
    for (const c of view.cuts) {
      const k = (view.nowMs - c.atMs) / CUT_EFFECT_MS;
      if (k < 0 || k >= 1) continue;
      const anchor = view.physics.threads[c.thread]?.anchor;
      if (!anchor) continue;
      // the upper half springs back to its anchor and fades; a small spark where it was cut
      const reach = 0.5 * (1 - k);
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = pal.thread;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(anchor.x + (c.x - anchor.x) * reach, anchor.y + (c.y - anchor.y) * reach);
      ctx.stroke();
      const mx = (anchor.x + c.x) / 2, my = (anchor.y + c.y) / 2;
      ctx.fillStyle = pal.bloom;
      ctx.beginPath(); ctx.arc(mx, my, 3 + 6 * k, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function recordTrail(orb: Vec) {
    trail[trailHead * 2] = orb.x;
    trail[trailHead * 2 + 1] = orb.y;
    trailHead = (trailHead + 1) % TRAIL_POINTS;
    trailCount = Math.min(trailCount + 1, TRAIL_POINTS);
  }

  function drawTrail() {
    ctx.fillStyle = pal.trail;
    for (let n = 0; n < trailCount; n++) {
      const slot = (trailHead - 1 - n + TRAIL_POINTS) % TRAIL_POINTS;
      ctx.globalAlpha = 0.3 * (1 - n / TRAIL_POINTS);
      ctx.beginPath();
      ctx.arc(trail[slot * 2], trail[slot * 2 + 1], ORB_RADIUS * 0.45 * (1 - n / (TRAIL_POINTS * 1.4)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawOrb(orb: Vec, nowMs: number) {
    const breathe = reducedMotion ? 1 : 1 + 0.05 * Math.sin(nowMs / 520);
    ctx.save();
    ctx.translate(orb.x, orb.y);
    ctx.save();
    ctx.scale(breathe, breathe);
    ctx.fillStyle = orbGlow;
    ctx.beginPath(); ctx.arc(0, 0, ORB_RADIUS * 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (pal.outline) {
      ctx.strokeStyle = pal.outline;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0, 0, ORB_RADIUS * 0.74, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = orbCore;
    ctx.beginPath(); ctx.arc(0, 0, ORB_RADIUS * 0.7, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(-ORB_RADIUS * 0.24, -ORB_RADIUS * 0.28, ORB_RADIUS * 0.16, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawBloom(goal: LevelPhysics['goal'], wonAtMs: number | null, nowMs: number) {
    if (reducedMotion || wonAtMs === null) return;
    const k = (nowMs - wonAtMs) / BLOOM_MS;
    if (k < 0 || k >= 1) return;
    const ease = 1 - (1 - k) * (1 - k);
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = pal.goalRing;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(goal.x, goal.y, goal.r * (1 + ease * 1.8), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = pal.bloom;
    for (let i = 0; i < BLOOM_SPARKS; i++) {
      const a = sparks[i * 3], dist = sparks[i * 3 + 1] * ease;
      ctx.beginPath(); ctx.arc(goal.x + Math.cos(a) * dist, goal.y + Math.sin(a) * dist, sparks[i * 3 + 2] * (1 - k * 0.6), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ── [FILAMENT-4] wind: zones, direction chevrons, streaks, cycle ring, fan devices ──────────────────────────
  /** Moving streaks along the wind, clipped to the zone; ≤ MAX_STREAKS, one stroke call, no allocation. */
  function drawStreaks(c: CurrentDef, dx: number, dy: number, strength: number, nowMs: number, seed: number) {
    const n = Math.min(MAX_STREAKS, Math.max(4, Math.round((c.w * c.h) / 9000)));
    const speed = Math.min(260, 60 + strength * 0.12); // world units per second, for the eye only
    const span = Math.abs(dx) * c.w + Math.abs(dy) * c.h + 60;
    const perpSpan = Math.abs(dy) * c.w + Math.abs(dx) * c.h;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(c.x, c.y, c.w, c.h); ctx.clip();
    ctx.strokeStyle = pal.wind;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.38;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const along = (((nowMs / 1000) * speed + ((k * 0.618 + seed * 0.37) % 1) * span) % span) - span / 2;
      const across = ((k + 0.5) / n - 0.5) * perpSpan;
      const x = cx + dx * along - dy * across, y = cy + dy * along + dx * across;
      ctx.moveTo(x - dx * 26, y - dy * 26);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Timed current: a ring at the zone's corner, filled with the share of the phase still to come. */
  function drawCycle(c: CurrentDef, state: SimState) {
    const timing = c.timing;
    if (!timing || timing.period <= 0 || timing.on <= 0 || timing.on >= timing.period) return;
    const t = (((state.tick + timing.phase) % timing.period) + timing.period) % timing.period;
    const on = t < timing.on;
    const share = on ? 1 - t / timing.on : (t - timing.on) / (timing.period - timing.on);
    const x = c.x + 14, y = c.y + 14;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = on ? pal.fanOn : pal.fanOff;
    ctx.beginPath(); ctx.arc(x, y, 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * share); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawCurrents(view: RenderView) {
    const currents = view.physics.currents ?? [];
    for (let i = 0; i < currents.length; i++) {
      const c = currents[i];
      const active = currentActive(c, i, view.state);
      const strength = Math.hypot(c.ax, c.ay);
      const dx = strength > 0 ? c.ax / strength : 0, dy = strength > 0 ? c.ay / strength : 0;
      ctx.globalAlpha = active ? 0.1 : 0.04;
      ctx.fillStyle = pal.windZone;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.globalAlpha = active ? 0.4 : 0.18;
      ctx.strokeStyle = pal.windZone;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.setLineDash([]);
      if (strength > 0) {
        // direction chevrons: static, so the wind stays readable under reduced motion (bounded by the zone size)
        ctx.globalAlpha = active ? 0.55 : 0.16;
        ctx.strokeStyle = pal.wind;
        ctx.lineWidth = 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let gx = c.x + CHEVRON_STEP / 2; gx < c.x + c.w; gx += CHEVRON_STEP) {
          for (let gy = c.y + CHEVRON_STEP / 2; gy < c.y + c.h; gy += CHEVRON_STEP) {
            const bx = gx - dx * 4, by = gy - dy * 4, px = -dy * 6, py = dx * 6;
            ctx.moveTo(bx + px, by + py);
            ctx.lineTo(gx + dx * 5, gy + dy * 5);
            ctx.lineTo(bx - px, by - py);
          }
        }
        ctx.stroke();
        if (active && !reducedMotion) drawStreaks(c, dx, dy, strength, view.nowMs, i);
      }
      drawCycle(c, view.state);
      ctx.globalAlpha = 1;
    }
  }

  function drawFans(view: RenderView) {
    const currents = view.physics.currents ?? [];
    for (let i = 0; i < currents.length; i++) {
      const c = currents[i];
      if (!c.fan) continue;
      const d = c.fan.device;
      const on = view.state.fanOn[i] === true;
      // dotted link to the zone it drives
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = pal.wind;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 4]);
      strokeSegment(d, { x: Math.min(Math.max(d.x, c.x), c.x + c.w), y: c.y + c.h });
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (view.highlightFan === i) {
        ctx.strokeStyle = pal.threadHot;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(d.x, d.y, 22, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = on ? pal.fanOn : pal.fanOff;
      ctx.strokeStyle = pal.fanRing;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(d.x, d.y, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const angle = on && !reducedMotion ? (view.nowMs / 1000) * 9 : 0.3;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(angle);
      ctx.fillStyle = pal.fanRing;
      for (let b = 0; b < 3; b++) {
        ctx.beginPath(); ctx.ellipse(0, -7.5, 3.4, 7, 0, 0, Math.PI * 2); ctx.fill();
        ctx.rotate((Math.PI * 2) / 3); // three blades, 120° apart
      }
      ctx.restore();
    }
  }

  // ── [FILAMENT-5] wells: influence ring, direction chevrons (static), glowing core, turning dashed ring (motion) ──
  function drawWells(view: RenderView) {
    for (const w of view.physics.wells ?? []) {
      const attract = w.strength >= 0;
      const tint = attract ? WELL.ring : WELL.repel;
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = attract ? WELL.field : WELL.repel;
      ctx.beginPath(); ctx.arc(w.x, w.y, w.radius, 0, Math.PI * 2); ctx.fill();
      // the influence edge (the force is zero beyond it) and two inner rings where it grows
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = tint;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = reducedMotion ? 0 : (attract ? 1 : -1) * ((view.nowMs / 60) % 12);
      ctx.beginPath(); ctx.arc(w.x, w.y, w.radius, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.globalAlpha = 0.22;
      ctx.beginPath(); ctx.arc(w.x, w.y, w.radius * 0.66, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(w.x, w.y, w.radius * 0.33, 0, Math.PI * 2); ctx.stroke();
      // eight chevrons at 0.8 radius, pointing to the centre (or away from it): readable without animation
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4 + Math.PI / 8;
        const ux = Math.cos(a), uy = Math.sin(a);
        const dir = attract ? -1 : 1; // along the radius: −1 = inwards
        const cx = w.x + ux * w.radius * 0.8, cy = w.y + uy * w.radius * 0.8;
        const tipX = cx + ux * 5 * dir, tipY = cy + uy * 5 * dir;
        const backX = cx - ux * 4 * dir, backY = cy - uy * 4 * dir;
        ctx.moveTo(backX - uy * 5, backY + ux * 5);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(backX + uy * 5, backY - ux * 5);
      }
      ctx.stroke();
      // the star body
      ctx.globalAlpha = 1;
      ctx.fillStyle = WELL.halo;
      ctx.beginPath(); ctx.arc(w.x, w.y, 20, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = tint;
      ctx.beginPath(); ctx.arc(w.x, w.y, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = WELL.core;
      ctx.beginPath(); ctx.arc(w.x - 2.5, w.y - 2.5, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** [FILAMENT-5] fruit pulses and drifting star dust (bounded, no allocation); never under reduced motion. */
  function drawOrchardLife(nowMs: number) {
    const t = nowMs / 1000;
    for (let i = 0; i < fruits.length; i++) {
      const f = fruits[i];
      ctx.globalAlpha = 0.18 + 0.16 * Math.sin(t * 1.1 + i * 1.7);
      ctx.fillStyle = f.warm ? '#ff9ec7' : '#8cffc8';
      ctx.beginPath(); ctx.arc(f.x, f.y, 7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#ffe9b8';
    for (let k = 0; k < DUST_MOTES; k++) {
      const x = (k * 83 + t * (8 + (k % 3) * 5)) % WORLD.width;
      const y = 110 + ((k * 47) % 300) + Math.sin(t * 0.6 + k) * 10;
      ctx.globalAlpha = 0.3 + 0.2 * Math.sin(t * 1.3 + k * 2.1);
      ctx.beginPath(); ctx.arc(x, y, 1.3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Brightness of the per-frame twinkling stars: 0 = none (reduced motion, or the daylight sky of chapter 2). */
  function twinkleFade(): number {
    if (reducedMotion) return 0;
    if (theme === 'aube') return 1 - dawn * 0.65;
    if (theme === 'verger') return 1;
    if (theme === 'crepuscule') return 0.25 + dawn * 0.75; // [FILAMENT-6] they appear as the night comes
    return 0;
  }
  /** [FILAMENT-6] the dusk keeps its stars in the upper sky (above the bright horizon) */
  function twinkleMaxY(): number { return theme === 'crepuscule' ? 300 : WORLD.height; }

  /** [FILAMENT-6] a few fireflies drifting low over the dusk garden (bounded, no allocation); never under reduced motion. */
  function drawDuskLife(nowMs: number) {
    const t = nowMs / 1000;
    for (let k = 0; k < DUSK_FIREFLIES; k++) {
      const x = (k * 107 + t * (6 + (k % 3) * 4)) % WORLD.width;
      const y = 300 + ((k * 53) % 150) + Math.sin(t * 0.7 + k * 1.3) * 12;
      ctx.globalAlpha = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.6 + k * 2.3));
      ctx.fillStyle = k % 3 === 0 ? '#a8fff0' : '#ffd890';
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  const orbAt: Vec = { x: 0, y: 0 };

  return {
    resize(cssWidth, cssHeight, devicePixelRatio) {
      const cssW = Math.max(1, Math.floor(cssWidth));
      const cssH = Math.max(1, Math.floor(cssHeight));
      let ratio = Math.min(Math.max(Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1, 1), MAX_DPR);
      if (cssW * cssH * ratio * ratio > MAX_BACKING_PIXELS) ratio = Math.max(Math.sqrt(MAX_BACKING_PIXELS / (cssW * cssH)), 0.25);
      pixelRatio = ratio;
      scale = Math.min(cssW / WORLD.width, cssH / WORLD.height);
      offsetX = (cssW - WORLD.width * scale) / 2;
      offsetY = (cssH - WORLD.height * scale) / 2;
      canvas.width = layer.width = Math.max(1, Math.round(cssW * pixelRatio));
      canvas.height = layer.height = Math.max(1, Math.round(cssH * pixelRatio));
      paintBackground();
    },
    setReducedMotion(reduced) {
      if (reduced === reducedMotion) return;
      reducedMotion = reduced;
      if (reduced) trailCount = 0;
      if (layer.width > 1) paintBackground();
    },
    setDawn(value) {
      const next = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1);
      if (next === dawn) return;
      dawn = next;
      if (layer.width > 1) paintBackground();
    },
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      pal = PALETTES[next];
      if (layer.width > 1) paintBackground();
    },
    toWorld(cssX, cssY, out) {
      out.x = (cssX - offsetX) / scale;
      out.y = (cssY - offsetY) / scale;
      return out;
    },
    render(view) {
      const { physics, state } = view;
      const a = view.alpha;
      orbAt.x = state.prev.x + (state.p.x - state.prev.x) * a;
      orbAt.y = state.prev.y + (state.p.y - state.prev.y) * a;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(layer, 0, 0);
      worldTransform(ctx);
      // twinkling night stars belong to the night skies (chapter 1; [FILAMENT-5] and the orchard of chapter 3)
      // [FILAMENT-6] and the dusk of chapter 4, upper sky only, brighter as its night comes
      const fade = twinkleFade();
      if (fade > 0) {
        for (let i = 0; i < TWINKLE_STARS; i++) {
          const s = stars[i];
          if (s.y > twinkleMaxY()) continue;
          ctx.globalAlpha = s.a * fade * (0.55 + 0.45 * Math.sin(view.nowMs / 900 + s.phase));
          ctx.fillStyle = '#eef2ff';
          ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      if (!reducedMotion && theme === 'verger') drawOrchardLife(view.nowMs);
      if (!reducedMotion && theme === 'crepuscule') drawDuskLife(view.nowMs);
      // [FILAMENT-5] wells under the winds (no-op without wells: chapters 1 and 2 have none)
      drawWells(view);
      // [FILAMENT-4] winds under everything else, fan devices on top of the obstacles (no-op without currents)
      drawCurrents(view);
      drawObstacles(physics, view.nowMs);
      drawFans(view);
      drawGoal(physics.goal, view.nowMs, state.outcome === 'WON');
      drawStars(physics, state, view.nowMs);
      drawThreads(view, orbAt);
      drawCutEffects(view);
      const free = !state.attached.some(Boolean);
      if (!reducedMotion && view.running && free && state.outcome === 'PLAYING') recordTrail(orbAt);
      if (!reducedMotion && free) drawTrail();
      drawOrb(orbAt, view.nowMs);
      drawBloom(physics.goal, view.wonAtMs, view.nowMs);
    },
    resetTrail() { trailCount = 0; trailHead = 0; },
    destroy() {
      trailCount = 0;
      canvas.width = canvas.height = 0;
      layer.width = layer.height = 0;
    },
  };
}
