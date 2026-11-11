// [FILAMENT-4] Filament — chapter 2 « Courants d’Altitude » (global levels 9 to 14): level SPECIFICATIONS awaiting the
// supervised validation. Like chapter1.ts this module imports nothing, so the game and a future supervised design /
// verification script (scripts/filament-design-ch2.mjs, prepared, NOT approved, NOT run) read the same objects.
//
// [FILAMENT-4 CH2-A] CH2-A « Premier souffle » is VALIDATED and playable (CHAPTER2_LEVELS below): its spec geometry,
// wind and action list were kept as they were; goal and stars come from ONE supervised calibration
// (scripts/filament-calibrate-ch2-a.mjs, run once 2026-10-23, exit 0: trajectory 1 traced, trajectory 2 replayed WON
// 3 stars at win tick 111, stars at 59 / 80 / 96 — report FILAMENT_CH2_A_SINGLE_CALIBRATION.md). Timing margin NOT
// measured. Browser NOT tested.
// [CH2 SEQUENTIAL 2026-10-23] Later levels validated the same way, one supervised run each (dedicated scripts
// scripts/filament-calibrate-ch2-<letter>.mjs, report FILAMENT_CHAPTER_2_SEQUENTIAL_FINALIZATION.md), moved below.
//
// [CH2-F v3] All six chapter-2 levels are now in CHAPTER2_LEVELS; CHAPTER2_SPECS is empty. The method that was used:
// STATUS of CHAPTER2_SPECS: PENDING_VALIDATION — none of these levels is playable yet. They have no goal and no stars on purpose:
//   * the goal is placed later ON the trajectory actually traced by the engine (constructive method of FILAMENT-2:
//     `design.place` = the line the trajectory must cross, descending through y = gy, or through x = gx);
//   * the three stars are then placed on that same traced trajectory;
//   * the finished level is replayed once and its timing tolerance measured, under scripts/filament-safe-run.mjs.
// Nothing below has been simulated. `design.actions` are HYPOTHESES derived by hand from pendulum periods and constant
// wind accelerations; the validation may change them, or the geometry, before a level opens.
//
// Engine features used (src/arcade/filament/physics.ts, unchanged): CurrentDef = axis-aligned box, constant
// acceleration (ax, ay) while the orb's centre is inside; optional `timing` (automatic cycle, in ticks) or `fan`
// (player toggle, action { type: 'TOGGLE', current }); walls / deflectors (segments) and rifts as in chapter 1.
// Save: level ids are stable ('ch2-a' … 'ch2-f'); filament-progress-v1 can hold them once they are playable (see the
// FILAMENT-4 report: no format change, no migration).

type Point = { x: number; y: number };
type SegmentKind = 'wall' | 'deflector';
type Action = { type: 'CUT'; thread: number } | { type: 'TOGGLE'; current: number };
type Timed = { tick: number; action: Action };

const pend = (ax: number, ay: number, L: number, deg: number): Point => ({ x: ax + L * Math.sin(deg * Math.PI / 180), y: ay + L * Math.cos(deg * Math.PI / 180) });
const seg = (x1: number, y1: number, x2: number, y2: number, kind: SegmentKind = 'wall') => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, kind });
const rift = (x1: number, y1: number, x2: number, y2: number) => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const cut = (tick: number, thread: number): Timed => ({ tick, action: { type: 'CUT', thread } });
const toggle = (tick: number, current: number): Timed => ({ tick, action: { type: 'TOGGLE', current } });

export type PendingStatus = 'PENDING_VALIDATION';

/** [FILAMENT-4 CH2-A] Validated, playable chapter-2 levels (global numbers given here; chapter added by levels.ts). */
export const CHAPTER2_LEVELS = [
  {
    // spec kept as is: orb, thread, wind box and action list of the former CH2-A spec (design hypothesis cut(20, 0),
    // place rule y = 440); goal = the trajectory's first point at or below y = 440, stars on that same trajectory
    id: 'ch2-a', code: 'CH2-A', number: 9, title: 'Premier souffle',
    hint: 'Les chevrons montrent le vent : il souffle vers la droite. Coupez le fil quand vous voulez : la bille tombe dans le courant, qui la pousse vers le halo en cueillant les étoiles.',
    scene: 'Une bille pend sous un fil, en haut à gauche, au-dessus d’un large courant d’air qui souffle vers la droite. Trois étoiles dessinent la courbe de sa chute poussée par le vent, jusqu’au halo, en bas vers le centre.',
    physics: {
      orb: { x: 180, y: 160 },
      threads: [{ anchor: { x: 180, y: 60 }, length: 100 }],
      currents: [{ x: 100, y: 180, w: 600, h: 290, ax: 1000, ay: 0 }],
      goal: { x: 353, y: 445, r: 34 },
      stars: [{ x: 201, y: 237 }, { x: 240, y: 298 }, { x: 291, y: 368 }],
    },
    reference: { actions: [cut(20, 0)], winTick: 111, starAt: [59, 80, 96] },
  },
  {
    // [CH2 SEQUENTIAL] spec kept as is (pendulum, carrying wind, rift, cut(82, 0), place rule x = 600); goal = first
    // point crossing x = 600, stars on that trajectory — scripts/filament-calibrate-ch2-b.mjs, run once, exit 0
    id: 'ch2-b', code: 'CH2-B', number: 10, title: 'La traversée',
    hint: 'Coupez le fil quand la bille passe au plus bas du balancier : le courant d’air la soulève et la porte au-dessus de la faille rouge jusqu’au halo.',
    scene: 'Une bille se balance à gauche. Un long courant porteur traverse le ciel vers la droite, au-dessus d’une faille rouge ; trois étoiles suivent sa course jusqu’au halo, à droite.',
    physics: {
      orb: pend(160, 60, 150, -60),
      threads: [{ anchor: { x: 160, y: 60 }, length: 150 }],
      currents: [{ x: 200, y: 150, w: 560, h: 180, ax: 400, ay: -600 }],
      rifts: [rift(220, 480, 560, 480)],
      goal: { x: 600, y: 428, r: 34 },
      stars: [{ x: 293, y: 254 }, { x: 391, y: 298 }, { x: 499, y: 353 }],
    },
    reference: { actions: [cut(82, 0)], winTick: 187, starAt: [116, 142, 166] },
  },
  {
    // [CH2-C v3] spec kept as is (pendulum, air river, rift, cut(66, 0), place rule x = 700) EXCEPT the crystal: the
    // spec's seg(560, 330, 680, 290) was never reached (v1), the moved seg(520, 460, 640, 420) rising to the right made
    // the orb slide back into the rift (v2); validated: same centre (580, 440), inclination inverted to a ramp
    // descending to the right — scripts/filament-calibrate-ch2-c-v3.mjs, run once, exit 0 (FILAMENT_CH2_C_RAMP_CORRECTION_V3.md)
    id: 'ch2-c', code: 'CH2-C', number: 11, title: 'Les jardins suspendus',
    hint: 'Coupez le fil quand la bille arrive au plus bas : la rivière d’air la porte vers la droite, puis la rampe de cristal la fait glisser jusqu’au halo, au-delà de la faille.',
    scene: 'Une bille se balance en haut à gauche. Une rivière d’air file vers la droite sous elle ; plus bas, une rampe de cristal descend vers la droite juste après la faille rouge ; trois étoiles suivent la course jusqu’au halo, à droite.',
    physics: {
      orb: pend(130, 60, 120, -50),
      threads: [{ anchor: { x: 130, y: 60 }, length: 120 }],
      currents: [{ x: 60, y: 200, w: 680, h: 100, ax: 900, ay: -700 }],
      segments: [seg(517, 434, 643, 446, 'deflector')],
      rifts: [rift(150, 475, 520, 475)],
      goal: { x: 702, y: 433, r: 34 },
      stars: [{ x: 269, y: 262 }, { x: 403, y: 326 }, { x: 543, y: 414 }],
    },
    reference: { actions: [cut(66, 0)], winTick: 196, starAt: [113, 142, 168] },
  },
  {
    // [CH2-D] spec kept as is (two winds, the lower one cyclic, cut(20, 0), place rule y = 460); goal = first point at
    // or below y = 460, stars on that trajectory — scripts/filament-calibrate-ch2-d.mjs, run once, exit 0
    // (FILAMENT_CH2_D_E_F_FINALIZATION.md)
    id: 'ch2-d', code: 'CH2-D', number: 12, title: 'Vents contraires',
    hint: 'Le vent du haut pousse vers la droite ; celui du bas souffle vers la gauche par intermittence, son anneau montre le rythme. Coupez pour que la bille le traverse pendant qu’il souffle : il la ramène vers le halo.',
    scene: 'Une bille pend en haut à gauche. Un courant souffle vers la droite ; dessous, un second courant souffle vers la gauche par intermittence, son rythme indiqué par un anneau ; trois étoiles mènent au halo, en bas, un peu à droite.',
    physics: {
      orb: { x: 160, y: 160 },
      threads: [{ anchor: { x: 160, y: 50 }, length: 110 }],
      currents: [
        { x: 100, y: 190, w: 600, h: 90, ax: 900, ay: -450 },
        { x: 100, y: 300, w: 660, h: 130, ax: -1100, ay: -300, timing: { period: 240, on: 120, phase: 0 } },
      ],
      goal: { x: 249, y: 464, r: 34 },
      stars: [{ x: 172, y: 234 }, { x: 211, y: 294 }, { x: 243, y: 370 }],
    },
    reference: { actions: [cut(20, 0)], winTick: 125, starAt: [57, 83, 104] },
  },
  {
    // [CH2-E] spec kept as is (fan column, rift, toggle(10, 0) then cut(30, 0), place rule y = 420); goal = first point
    // at or below y = 420, stars on that trajectory — scripts/filament-calibrate-ch2-e.mjs, run once, exit 0
    // (FILAMENT_CH2_D_E_F_FINALIZATION.md). Only the order « fan on, then cut » was verified.
    id: 'ch2-e', code: 'CH2-E', number: 13, title: 'Le souffle des cristaux',
    hint: 'Sans le ventilateur, la bille tombe dans la faille. Allumez d’abord le ventilateur (touchez-le, cliquez dessus ou appuyez sur F), puis coupez le fil : son souffle la soulève et la lance vers le halo.',
    scene: 'Une bille pend au-dessus d’une faille. Juste dessous, un ventilateur de cristal éteint attend au sol ; trois étoiles dessinent un grand arc jusqu’au halo, plus loin à droite.',
    physics: {
      orb: { x: 200, y: 160 },
      threads: [{ anchor: { x: 200, y: 60 }, length: 100 }],
      currents: [{ x: 140, y: 200, w: 190, h: 270, ax: 500, ay: -1700, fan: { initiallyOn: false, device: { x: 235, y: 478 } } }],
      rifts: [rift(120, 485, 360, 485)],
      goal: { x: 673, y: 422, r: 34 },
      stars: [{ x: 286, y: 221 }, { x: 433, y: 161 }, { x: 580, y: 267 }],
    },
    reference: { actions: [toggle(10, 0), cut(30, 0)], winTick: 269, starAt: [124, 178, 234] },
  },
  {
    // [CH2-F v3] REDESIGN (FILAMENT_CH2_F_REDESIGN_V3.md): the spec's pendulum pend(180, 60, 140, −55) and its two
    // currents (cloud { 220, 170, 380 × 120, ax 700, ay −500 }, fan { 600, 250, 90 × 220, ax 150, ay −1600, device
    // (645, 478) }) never let the fan act; one coherent design replaced orb, thread and both currents; wall, rift,
    // actions toggle(10, 1) + cut(76, 0) and place rule x = 720 kept. scripts/filament-calibrate-ch2-f-v3.mjs, run
    // once, exit 0: with the fan WON 3 stars; same level and cut without the fan: LOST (OUT_OF_BOUNDS, tick 360).
    id: 'ch2-f', code: 'CH2-F', number: 14, title: 'Le passage des nuages',
    hint: 'Le courant des nuages porte la bille vers la droite. Allumez le ventilateur avant qu’elle ne l’atteigne : son souffle la soulève par-dessus le muret jusqu’au halo. Sans lui, elle s’écrase contre le muret.',
    scene: 'Une bille pend en haut à gauche, juste au-dessus d’un courant de nuages qui file vers la droite ; au bout, une large colonne de ventilateur éteinte précède un muret ; le halo flotte haut, au-delà du muret.',
    physics: {
      orb: { x: 150, y: 168 },
      threads: [{ anchor: { x: 150, y: 68 }, length: 100 }],
      currents: [
        { x: 110, y: 170, w: 340, h: 140, ax: 250, ay: -900 },
        { x: 450, y: 200, w: 200, h: 270, ax: 100, ay: -2000, fan: { initiallyOn: false, device: { x: 550, y: 478 } } },
      ],
      segments: [seg(690, 300, 690, 500)],
      rifts: [rift(240, 485, 600, 485)],
      goal: { x: 722, y: 131, r: 34 },
      stars: [{ x: 278, y: 231 }, { x: 427, y: 259 }, { x: 583, y: 223 }],
    },
    reference: { actions: [toggle(10, 1), cut(76, 0)], winTick: 340, starAt: [189, 252, 301] },
  },
];

/** Shape of a pending specification (what levels.ts reads as a PendingLevel). */
export interface Chapter2Spec {
  id: string; code: string; number: number; title: string; status: PendingStatus;
  mechanics: string[]; intent: string; scene: string;
  physics: {
    orb: Point;
    threads: { anchor: Point; length: number }[];
    currents?: { x: number; y: number; w: number; h: number; ax: number; ay: number; timing?: { period: number; on: number; phase: number }; fan?: { initiallyOn: boolean; device: Point } }[];
    segments?: { a: Point; b: Point; kind: SegmentKind }[];
    rifts?: { a: Point; b: Point }[];
  };
  design: { actions: Timed[]; place: { gx?: number; gy?: number }; estimate: string };
}

/** [CH2-F v3] every chapter-2 level is validated: no specification is pending any more */
export const CHAPTER2_SPECS: readonly Chapter2Spec[] = [];
