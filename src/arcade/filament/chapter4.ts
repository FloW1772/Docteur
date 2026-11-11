// [FILAMENT-6] Filament — chapter 4 « Lisière du Crépuscule » (global levels 20 to 24, the last chapter): level
// SPECIFICATIONS awaiting the supervised validation, one level at a time (same method as chapters 2 and 3). Like
// chapter1.ts … chapter3.ts this module imports nothing, so the game and a future supervised calibration script read the
// very same objects.
//
// STATUS: PENDING_VALIDATION — none of these levels is playable. No goal and no stars on purpose: they are placed later
// ON the trajectory actually traced by the engine (`design.place` = the line the trajectory must cross). Nothing below
// has been simulated; `design.actions`, `design.estimate` and every coordinate are hand HYPOTHESES.
//
// Engine features used (src/arcade/filament/physics.ts, unchanged): taut / slack threads (cut only), wall and deflector
// segments, pegs, rifts, constant currents, timed currents (`timing`, automatic cycle), fan currents (`fan`, TOGGLE: on
// ↔ off, either initial state) and wells (pull toward the centre, linear falloff). Not available in the engine and not
// used or faked: springs, moving obstacles or platforms, gravity switches, a player action on a well or on a timed
// current, special collisions. A current with both `timing` and `fan` behaves as a fan only (currentActive).
// Design rules learnt in chapters 1–3 (reports CH2-C, CH2-F, CH3-C, CH3-D, CH3-E):
//   * build on free-flight segments already MEASURED by a supervised run (never on positions recorded after a contact);
//     a mirrored level (x → 800 − x) keeps a measured path exact, gravity being vertical;
//   * no solution may depend on a bounce (restitution is applied from the last projection pass only);
//   * a well only lifts an orb passing UNDER it or flying toward it; passing over it bends the path down;
//   * a lifting column must be entered early and slowly enough: a fast orb crosses it still falling (CH3-D, CH3-E);
//   * an orb at rest outside every field (or a validated pendulum) keeps the start predictable.
// Static rules (checked by scripts/test-filament-game-unit.mjs, prepared, not run): every orb starts at its thread
// length, outside every current box and outside every well radius (no drift before the first action).
// [2026-10-24] Chapter complete: the five levels were validated one at a time (one supervised run each, report
// FILAMENT_CHAPTER_4_SEQUENTIAL_VALIDATION.md) and live in CHAPTER4_LEVELS; CHAPTER4_SPECS is empty.

type Point = { x: number; y: number };
type SegmentKind = 'wall' | 'deflector';
type Action = { type: 'CUT'; thread: number } | { type: 'TOGGLE'; current: number };
type Timed = { tick: number; action: Action };

const pend = (ax: number, ay: number, L: number, deg: number): Point => ({ x: ax + L * Math.sin(deg * Math.PI / 180), y: ay + L * Math.cos(deg * Math.PI / 180) });
const seg = (x1: number, y1: number, x2: number, y2: number, kind: SegmentKind = 'wall') => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, kind });
const rift = (x1: number, y1: number, x2: number, y2: number) => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const cut = (tick: number, thread: number): Timed => ({ tick, action: { type: 'CUT', thread } });
const toggle = (tick: number, current: number): Timed => ({ tick, action: { type: 'TOGGLE', current } });

export type Chapter4Status = 'PENDING_VALIDATION';
export type Chapter4Difficulty = 'accessible' | 'modérée' | 'avancée' | 'grande finale';

/** Shape of a chapter-4 specification (what levels.ts reads as a PendingLevel). */
export interface Chapter4Spec {
  id: string; code: string; number: number; title: string; status: Chapter4Status; difficulty: Chapter4Difficulty;
  mechanics: string[]; intent: string; scene: string;
  /** scenery specific to this level (drawn by the shared « crépuscule » theme; never collides) */
  decor: string;
  physics: {
    orb: Point;
    threads: { anchor: Point; length: number }[];
    currents?: { x: number; y: number; w: number; h: number; ax: number; ay: number; timing?: { period: number; on: number; phase: number }; fan?: { initiallyOn: boolean; device: Point } }[];
    segments?: { a: Point; b: Point; kind: SegmentKind }[];
    pegs?: { x: number; y: number; r: number }[];
    rifts?: { a: Point; b: Point }[];
    wells?: { x: number; y: number; radius: number; strength: number }[];
  };
  design: { actions: Timed[]; place: { gx?: number; gy?: number }; estimate: string; risks: string };
}

/** The V hang of CH4-B: both threads taut and symmetric, the orb at rest at their meeting point. */
const V_LENGTH = Math.hypot(80, 110);

/** [FILAMENT-6 CH4] Validated, playable chapter-4 levels (global numbers given here; chapter added by levels.ts). Each one
 * kept its spec geometry and action list; goal and stars come from ONE supervised calibration
 * (scripts/filament-calibrate-ch4-<letter>.mjs, report FILAMENT_CHAPTER_4_SEQUENTIAL_VALIDATION.md). Browser NOT tested. */
export const CHAPTER4_LEVELS = [
  {
    // spec kept as is (CH3-B pendulum mirrored, constant ray, pillar, rift, cut(82, 0), place rule x = 160);
    // scripts/filament-calibrate-ch4-a.mjs, run once, exit 0, WON 3 stars (ray 50 ticks, pillar never closer than 45.9)
    id: 'ch4-a', code: 'CH4-A', number: 20, title: 'Le dernier rayon',
    hint: 'Coupez le fil quand la bille passe au plus bas : elle file vers la gauche, le dernier rayon du soleil la soulève au-dessus du pilier, puis elle redescend vers le halo.',
    scene: 'Une bille se balance en haut à droite, devant le soleil couchant. Un rayon doré monte du sol au milieu de la scène, devant un pilier de pierre ; une faille rouge court sous le chemin ; trois étoiles mènent au halo, à gauche, derrière le pilier.',
    physics: {
      orb: pend(620, 60, 150, 60),
      threads: [{ anchor: { x: 620, y: 60 }, length: 150 }],
      currents: [{ x: 370, y: 200, w: 150, h: 230, ax: 0, ay: -1700 }],
      segments: [seg(330, 340, 330, 500, 'wall')],
      rifts: [rift(340, 485, 600, 485)],
      goal: { x: 160, y: 414, r: 34 },
      stars: [{ x: 488, y: 272 }, { x: 381, y: 296 }, { x: 258, y: 319 }],
    },
    reference: { actions: [cut(82, 0)], winTick: 230, starAt: [118, 152, 195] },
  },
  {
    // spec kept as is (V hang, cyclic glide wind blowing ticks 80–219, two stones, rift, cut(20, 0) then cut(95, 1),
    // place rule x = 720); scripts/filament-calibrate-ch4-b.mjs, run once, exit 0, WON 3 stars (orb at rest before the
    // first cut, bottom (280, 196) at tick 95, wind 87 ticks while blowing, stones 39.6 / 30.2 beyond contact)
    id: 'ch4-b', code: 'CH4-B', number: 21, title: 'Les ombres mouvantes',
    hint: 'Coupez d’abord le fil de gauche : la bille se balance sur l’autre. Libérez-la au plus bas pendant que le vent du soir souffle (son anneau montre le rythme) : il la porte en vol plané entre les deux pierres jusqu’au halo. Hors du souffle, elle tombe dans la faille.',
    scene: 'Une bille pend entre deux fils en V, en haut à gauche. Un vent du soir souffle par intermittence vers la droite ; deux pierres sombres flottent au-dessus et au-dessous de son chemin ; une faille rouge court au sol ; trois étoiles mènent au halo, à droite.',
    physics: {
      orb: { x: 200, y: 170 },
      threads: [{ anchor: { x: 120, y: 60 }, length: V_LENGTH }, { anchor: { x: 280, y: 60 }, length: V_LENGTH }],
      currents: [{ x: 300, y: 150, w: 340, h: 180, ax: 700, ay: -900, timing: { period: 240, on: 140, phase: 160 } }],
      pegs: [{ x: 470, y: 170, r: 14 }, { x: 560, y: 320, r: 14 }],
      rifts: [rift(300, 485, 640, 485)],
      goal: { x: 725, y: 285, r: 34 },
      stars: [{ x: 397, y: 229 }, { x: 496, y: 247 }, { x: 605, y: 263 }],
    },
    reference: { actions: [cut(20, 0), cut(95, 1)], winTick: 203, starAt: [134, 160, 183] },
  },
  {
    // spec kept as is (CH3-C's pendulum and star A above the flight, constant column, rift, cut(82, 0), place rule
    // x = 700); scripts/filament-calibrate-ch4-c.mjs, run once, exit 0, WON 3 stars (star 66 ticks, closest 80.8;
    // column 43 ticks, entered at (441, 306), left rising at (618, 317))
    id: 'ch4-c', code: 'CH4-C', number: 22, title: 'Entre deux horizons',
    hint: 'Coupez le fil quand la bille passe au plus bas : l’astre du soir, au-dessus de son chemin, la porte et la lance en avant ; la colonne chaude de l’autre horizon la relève jusqu’au halo, au-dessus de la faille.',
    scene: 'Une bille se balance en haut à gauche. Un astre violet veille au-dessus de son chemin, côté nuit ; à droite, côté soleil, une colonne d’air doré monte du sol au-dessus d’une faille ; trois étoiles mènent au halo, à droite, en hauteur.',
    physics: {
      orb: pend(180, 60, 150, -60),
      threads: [{ anchor: { x: 180, y: 60 }, length: 150 }],
      wells: [{ x: 360, y: 190, radius: 160, strength: 2600 }],
      currents: [{ x: 440, y: 250, w: 180, h: 220, ax: 0, ay: -1900 }],
      rifts: [rift(300, 485, 620, 485)],
      goal: { x: 702, y: 304, r: 34 },
      stars: [{ x: 325, y: 263 }, { x: 436, y: 304 }, { x: 567, y: 326 }],
    },
    reference: { actions: [cut(82, 0)], winTick: 205, starAt: [118, 143, 174] },
  },
  {
    // spec kept as is (CH3-E relay mirrored, headwind on at start switched off, lift fan switched on, wall, rift,
    // toggle(10, 0), toggle(14, 1), cut(20, 0), cut(117, 1), place rule x = 55); scripts/filament-calibrate-ch4-d.mjs, run
    // once, exit 0, WON 3 stars (4 actions applied, fans [off, on]; lift 48 ticks, left rising at (152, 352); wall 55.8)
    id: 'ch4-d', code: 'CH4-D', number: 23, title: 'Les fils du crépuscule',
    hint: 'Éteignez le vent contraire, allumez le ventilateur qui soulève, puis coupez le premier fil : la bille s’élance sur le second. Coupez-le au plus bas : relevée par le souffle, elle franchit le mur jusqu’au halo. Un seul oubli, et elle s’abîme dans la faille.',
    scene: 'Une bille pend sous deux fils, en haut à droite. Au milieu, un ventilateur déjà allumé souffle vers la droite, contre son chemin ; à gauche, une large colonne de ventilateur éteinte se dresse au-dessus d’une faille, devant un mur ; trois étoiles mènent au halo, derrière le mur, à gauche.',
    physics: {
      orb: { x: 650, y: 160 },
      threads: [{ anchor: { x: 650, y: 60 }, length: 100 }, { anchor: { x: 470, y: 60 }, length: 206 }],
      currents: [
        { x: 360, y: 230, w: 80, h: 170, ax: 1600, ay: 0, fan: { initiallyOn: true, device: { x: 430, y: 478 } } },
        { x: 150, y: 260, w: 180, h: 220, ax: -120, ay: -2000, fan: { initiallyOn: false, device: { x: 240, y: 478 } } },
      ],
      segments: [seg(110, 400, 110, 500, 'wall')],
      rifts: [rift(110, 485, 400, 485)],
      goal: { x: 53, y: 343, r: 34 },
      stars: [{ x: 346, y: 307 }, { x: 267, y: 351 }, { x: 164, y: 355 }],
    },
    reference: { actions: [toggle(10, 0), toggle(14, 1), cut(20, 0), cut(117, 1)], winTick: 221, starAt: [144, 166, 193] },
  },
  {
    // the grand finale, spec kept as is (CH2-E / CH3-D start, fan, CH3-D star, cyclic last gust, final wall, rift,
    // toggle(10, 0), cut(30, 0), place rule x = 745); scripts/filament-calibrate-ch4-e.mjs, run once, exit 0, WON 3 stars
    // (fan 81 / star 73 / gust 32 ticks while blowing; wall passed at 29.8 from it, only 7.8 beyond the contact distance);
    // control: fan never switched on → LOST in the rift (tick 129). The gust's necessity is NOT tested (influence only).
    id: 'ch4-e', code: 'CH4-E', number: 24, title: 'Au-delà de la lisière',
    hint: 'Allumez le ventilateur, puis coupez le fil : relancée vers le haut, la bille est portée par le dernier astre ; si la dernière rafale souffle quand elle arrive (son anneau montre le rythme), elle franchit le mur et rejoint le halo, au-delà de la lisière.',
    scene: 'Une bille pend au-dessus d’une colonne de ventilateur éteinte, à gauche. Une faille rouge court sur tout le sol ; en haut à droite, le dernier astre brille au crépuscule ; plus loin, une rafale souffle par intermittence devant un mur ; trois étoiles mènent au halo final, derrière le mur.',
    physics: {
      orb: { x: 200, y: 160 },
      threads: [{ anchor: { x: 200, y: 60 }, length: 100 }],
      currents: [
        { x: 140, y: 200, w: 190, h: 270, ax: 500, ay: -1700, fan: { initiallyOn: false, device: { x: 235, y: 478 } } },
        { x: 580, y: 140, w: 180, h: 190, ax: 0, ay: -1500, timing: { period: 300, on: 120, phase: 90 } },
      ],
      wells: [{ x: 640, y: 140, radius: 200, strength: 2400 }],
      segments: [seg(700, 280, 700, 500, 'wall')],
      rifts: [rift(120, 485, 700, 485)],
      goal: { x: 748, y: 236, r: 34 },
      stars: [{ x: 281, y: 224 }, { x: 422, y: 160 }, { x: 580, y: 231 }],
    },
    reference: { actions: [toggle(10, 0), cut(30, 0)], winTick: 264, starAt: [121, 174, 226] },
  },
];

/** All five chapter-4 levels are validated (CH4-E last, 2026-10-24): no specification is left pending. */
export const CHAPTER4_SPECS: readonly Chapter4Spec[] = [];
