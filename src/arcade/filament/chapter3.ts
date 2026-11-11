// [FILAMENT-5] Filament — chapter 3 « Vergers Stellaires » (global levels 15 to 19): level SPECIFICATIONS awaiting the
// supervised validation, one level at a time (same method as chapter 2). Like chapter1.ts / chapter2.ts this module
// imports nothing, so the game and a future supervised calibration script read the very same objects.
//
// STATUS: PENDING_VALIDATION — none of these levels is playable. No goal and no stars on purpose: they are placed later
// ON the trajectory actually traced by the engine (`design.place` = the line the trajectory must cross). Nothing below
// has been simulated; `design.actions` and `design.estimate` are hand HYPOTHESES.
//
// Engine features used (src/arcade/filament/physics.ts, unchanged): WellDef { x, y, radius, strength } — acceleration
// towards the centre of magnitude strength · (1 − d / radius), zero beyond the radius (l. 181-184); PegDef (round solid,
// restitution 0.45); deflector / wall segments; rifts; constant and fan currents (TOGGLE). Not available in the engine:
// springs, moving obstacles, a player action on a well — none is used or faked here.
// Design rules learnt in chapter 2 (reports CH2-C / CH2-F): an orb at rest outside every field makes the path predictable;
// contacts (pegs, walls, crystals) do not bounce predictably (restitution applied from the last projection pass only),
// so no level may depend on a bounce; a down-right crystal ramp is used only as a slide (precedent CH1-J, CH2-C).
// Static rules (checked by scripts/test-filament-game-unit.mjs, prepared): every orb starts at its thread length, outside
// every current box and outside every well radius (no drift before the first action).
// [2026-10-24] Chapter complete: the five levels are validated and live in CHAPTER3_LEVELS; CHAPTER3_SPECS is empty.

type Point = { x: number; y: number };
type SegmentKind = 'wall' | 'deflector';
type Action = { type: 'CUT'; thread: number } | { type: 'TOGGLE'; current: number };
type Timed = { tick: number; action: Action };

const pend = (ax: number, ay: number, L: number, deg: number): Point => ({ x: ax + L * Math.sin(deg * Math.PI / 180), y: ay + L * Math.cos(deg * Math.PI / 180) });
const seg = (x1: number, y1: number, x2: number, y2: number, kind: SegmentKind = 'wall') => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, kind });
const rift = (x1: number, y1: number, x2: number, y2: number) => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const cut = (tick: number, thread: number): Timed => ({ tick, action: { type: 'CUT', thread } });
const toggle = (tick: number, current: number): Timed => ({ tick, action: { type: 'TOGGLE', current } });

export type Chapter3Status = 'PENDING_VALIDATION';
export type Difficulty = 'facile' | 'facile à modérée' | 'modérée' | 'modérée à avancée' | 'finale';

/** Shape of a chapter-3 specification (what levels.ts reads as a PendingLevel). */
export interface Chapter3Spec {
  id: string; code: string; number: number; title: string; status: Chapter3Status; difficulty: Difficulty;
  mechanics: string[]; intent: string; scene: string;
  physics: {
    orb: Point;
    threads: { anchor: Point; length: number }[];
    currents?: { x: number; y: number; w: number; h: number; ax: number; ay: number; fan?: { initiallyOn: boolean; device: Point } }[];
    segments?: { a: Point; b: Point; kind: SegmentKind }[];
    pegs?: { x: number; y: number; r: number }[];
    rifts?: { a: Point; b: Point }[];
    wells?: { x: number; y: number; radius: number; strength: number }[];
  };
  design: { actions: Timed[]; place: { gx?: number; gy?: number }; estimate: string; risks: string };
}

/** [FILAMENT-5 CH3] Validated, playable chapter-3 levels (global numbers given here; chapter added by levels.ts). Each one
 * kept its spec geometry and action list; goal and stars come from ONE supervised calibration
 * (scripts/filament-calibrate-ch3-<letter>.mjs, report FILAMENT_CH3_SEQUENTIAL_PHYSICS_VALIDATION.md). Browser NOT tested. */
export const CHAPTER3_LEVELS = [
  {
    // spec kept as is (orb at rest, one well, cut(20, 0), place rule y = 430); run once, exit 0, WON 3 stars
    id: 'ch3-a', code: 'CH3-A', number: 15, title: 'La première orbite',
    hint: 'Coupez le fil quand vous voulez : en tombant, la bille passe près d’un petit astre qui l’attire et courbe sa chute vers le halo.',
    scene: 'Une bille pend sous un fil, en haut à gauche. À droite, un petit astre doré entouré d’anneaux attire la bille ; trois étoiles suivent sa chute courbée jusqu’au halo, en bas.',
    physics: {
      orb: { x: 200, y: 150 },
      threads: [{ anchor: { x: 200, y: 50 }, length: 100 }],
      wells: [{ x: 370, y: 300, radius: 220, strength: 2600 }],
      goal: { x: 262, y: 430, r: 34 },
      stars: [{ x: 202, y: 219 }, { x: 214, y: 291 }, { x: 234, y: 359 }],
    },
    reference: { actions: [cut(20, 0)], winTick: 107, starAt: [54, 78, 93] },
  },
  {
    // spec kept as is (pendulum, two fruits avoided, crystal ramp slide, rift, cut(82, 0), place rule x = 560); run once,
    // exit 0, WON 3 stars; fruits never touched (closest 60.7 / 51), first ramp contact on its face (27.9 from its end)
    id: 'ch3-b', code: 'CH3-B', number: 16, title: 'Les fruits suspendus',
    hint: 'Coupez le fil quand la bille passe au plus bas : elle file entre les deux fruits suspendus, se pose sur la rampe de cristal et glisse jusqu’au halo, au-delà de la faille.',
    scene: 'Une bille se balance en haut à gauche. Deux fruits stellaires pendent dans le verger ; plus bas, une rampe de cristal descend vers la droite au-dessus d’une faille ; trois étoiles mènent au halo, à droite.',
    physics: {
      orb: pend(180, 60, 150, -60),
      threads: [{ anchor: { x: 180, y: 60 }, length: 150 }],
      segments: [seg(350, 380, 490, 420, 'deflector')],
      pegs: [{ x: 300, y: 190, r: 12 }, { x: 260, y: 300, r: 12 }],
      rifts: [rift(200, 485, 520, 485)],
      goal: { x: 561, y: 425, r: 34 },
      stars: [{ x: 297, y: 264 }, { x: 363, y: 337 }, { x: 452, y: 386 }],
    },
    reference: { actions: [cut(82, 0)], winTick: 186, starAt: [114, 138, 161] },
  },
  {
    // [CH3-C v3] GRAVITY REDESIGN (FILAMENT_CH3_C_GRAVITY_REDESIGN.md). The spec — orb at rest (140, 140), stars
    // { 230, 290, R 150, S 2400 } and { 540, 330, R 170, S 1800 }, rift (100, 485)→(460, 485), cut(20, 0), place x = 640 —
    // sent the orb into the rift. Validated design: the CH3-B pendulum, star A above the flight (it holds the orb up and
    // throws it forward), star B calling it into the halo below it, rift moved under the flight;
    // scripts/filament-calibrate-ch3-c-v3.mjs, run once, exit 0, WON 3 stars (both stars acted: 66 / 33 ticks).
    id: 'ch3-c', code: 'CH3-C', number: 17, title: 'L’appel des astres',
    hint: 'Coupez le fil quand la bille passe au plus bas : le premier astre la porte au-dessus de la faille et la lance en avant, le second l’appelle jusqu’au halo, juste sous lui.',
    scene: 'Une bille se balance en haut à gauche. Un astre violet flotte au-dessus de son chemin, un astre doré plus loin à droite veille sur le halo ; une faille rouge court au sol entre les deux.',
    physics: {
      orb: pend(180, 60, 150, -60),
      threads: [{ anchor: { x: 180, y: 60 }, length: 150 }],
      wells: [
        { x: 360, y: 190, radius: 160, strength: 2600 },
        { x: 600, y: 360, radius: 200, strength: 2800 },
      ],
      rifts: [rift(300, 485, 520, 485)],
      goal: { x: 605, y: 393, r: 34 },
      stars: [{ x: 304, y: 254 }, { x: 397, y: 290 }, { x: 496, y: 334 }],
    },
    reference: { actions: [cut(82, 0)], winTick: 177, starAt: [113, 135, 157] },
  },
  {
    // [CH3-D v2] AIR-COLUMN REDESIGN (FILAMENT_CH3_D_AIR_COLUMN_REDESIGN.md). The spec — pendulum pend(160, 60, 140, −60),
    // column { 320, 200, 160 × 280, ax 150, ay −1700 }, star { 640, 140, R 160, S 1600 }, rift (220, 485)→(700, 485),
    // cut(78, 0) — crossed the narrow column still falling, into the rift. Validated design: level 13's start and column,
    // made cyclic (blowing ticks 40–159, 280–399 …), star kept at (640, 140) but stronger so it holds the arc up, rift
    // under the drop; scripts/filament-calibrate-ch3-d-v2.mjs, run once, exit 0, WON 3 stars (column 81 / star 50 ticks).
    id: 'ch3-d', code: 'CH3-D', number: 18, title: 'Le jardin renversé',
    hint: 'La colonne d’air ne souffle que par intermittence : son anneau montre le rythme. Coupez pour que la bille y tombe pendant qu’elle souffle : relancée vers le haut, elle est portée par l’astre doré jusqu’au halo, en hauteur. Sinon, elle s’abîme dans la faille.',
    scene: 'Une bille pend au-dessus d’une colonne d’air qui souffle par intermittence vers le ciel ; une faille rouge court au sol ; en haut à droite, un astre doré veille sur le halo, que trois étoiles annoncent.',
    physics: {
      orb: { x: 200, y: 160 },
      threads: [{ anchor: { x: 200, y: 60 }, length: 100 }],
      currents: [{ x: 140, y: 200, w: 190, h: 270, ax: 500, ay: -1700, timing: { period: 240, on: 120, phase: 200 } }],
      wells: [{ x: 640, y: 140, radius: 200, strength: 2400 }],
      rifts: [rift(120, 485, 700, 485)],
      goal: { x: 643, y: 262, r: 34 },
      stars: [{ x: 259, y: 237 }, { x: 372, y: 168 }, { x: 511, y: 192 }],
    },
    reference: { actions: [cut(30, 0)], winTick: 241, starAt: [106, 157, 206] },
  },
  {
    // [CH3-E v2] FAN-COLUMN REDESIGN V2 (FILAMENT_CH3_E_FAN_REDESIGN_V2.md), chapter-3 finale. The spec — column
    // { 520, 260, 140 × 220 }, star { 680, 160, R 140, S 1800 }, place x = 660 — and the first correction (star moved to
    // (730, 290), place x = 740) only slowed the fall: the orb left the column still descending, the star never acted.
    // Validated design: the CH1-J relay kept, column's left edge 520 → 440 (force and fan kept) so the orb enters earlier
    // and rises out of it into the star; scripts/filament-calibrate-ch3-e-v2.mjs, run once, exit 0, WON 3 stars
    // (fan 58 / star 27 ticks); fan never switched on → LOST in the rift (tick 196).
    id: 'ch3-e', code: 'CH3-E', number: 19, title: 'Le cœur du verger',
    hint: 'Allumez le ventilateur, puis coupez le premier fil : la bille s’élance sur le second. Coupez-le au plus bas : le souffle la relève au-dessus de la faille et le cœur du verger l’attire jusqu’au halo. Ventilateur éteint, elle tombe dans la faille.',
    scene: 'Une bille pend sous deux fils, en haut à gauche. À droite, une large colonne de ventilateur se dresse au-dessus d’une faille rouge ; juste après, le cœur du verger brille comme un soleil miniature autour du halo, que trois étoiles annoncent.',
    physics: {
      orb: { x: 150, y: 160 },
      threads: [{ anchor: { x: 150, y: 60 }, length: 100 }, { anchor: { x: 330, y: 60 }, length: 206 }],
      currents: [{ x: 440, y: 260, w: 220, h: 220, ax: 120, ay: -2000, fan: { initiallyOn: false, device: { x: 590, y: 478 } } }],
      wells: [{ x: 730, y: 290, radius: 140, strength: 1800 }],
      rifts: [rift(420, 485, 700, 485)],
      goal: { x: 745, y: 265, r: 34 },
      stars: [{ x: 454, y: 306 }, { x: 539, y: 327 }, { x: 636, y: 303 }],
    },
    reference: { actions: [toggle(10, 0), cut(20, 0), cut(117, 1)], winTick: 216, starAt: [144, 167, 193] },
  },
];

/** All five chapter-3 levels are validated (CH3-E last, 2026-10-24): no specification is left pending. */
export const CHAPTER3_SPECS: readonly Chapter3Spec[] = [];
