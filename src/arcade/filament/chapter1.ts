// [FILAMENT-2] Filament — chapter 1 « Jardins de l’Aube »: the data of the 8 approved levels, in play order.
// This module imports NOTHING on purpose: the game (levels.ts) and the supervised verification
// (scripts/filament-verify-chapter1.mjs, run under scripts/filament-safe-run.mjs) read exactly the same objects.
//
// Provenance of every level (reports/arcade-grand-evolution-2026-10/):
//   CH1-A  draft a, replayed: FILAMENT_SINGLE_REPLAY_EXECUTION.md
//   CH1-B  draft b, replayed: FILAMENT_CH1_B_SINGLE_REPLAY_EXECUTION.md
//   CH1-C  draft c (design session 2026-10-22, solution 12 / 138), replayed: FILAMENT_CONTENT_AND_VISUAL_EVOLUTION.md
//   CH1-D  draft d (design session, solution 126, stars of its second star layout), replayed: same report
//   CH1-G/H/I/J  new: chosen solution, goal and stars placed ON the traced trajectory (no search), replayed and their
//          timing tolerance measured under the supervised lab: same report
// Drafts e and f are NOT used: their starting geometry is inconsistent (e: two threads that cannot both be satisfied;
// f: a thread 146 units too short at start, the orb would jump on the first frame).
// `reference` is for verification and a future hint only: the game never plays it by itself.

type Point = { x: number; y: number };
type SegmentKind = 'wall' | 'deflector';
type Cut = { tick: number; action: { type: 'CUT'; thread: number } };

const pend = (ax: number, ay: number, L: number, deg: number): Point => ({ x: ax + L * Math.sin(deg * Math.PI / 180), y: ay + L * Math.cos(deg * Math.PI / 180) });
const seg = (x1: number, y1: number, x2: number, y2: number, kind: SegmentKind = 'wall') => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, kind });
const rift = (x1: number, y1: number, x2: number, y2: number) => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const cut = (tick: number, thread: number): Cut => ({ tick, action: { type: 'CUT', thread } });

export const CHAPTER1_LEVELS = [
  {
    id: 'ch1-a', code: 'CH1-A', title: 'Premier fil',
    hint: 'La bille pend sous un fil. Coupez-le : elle tombe droit vers le halo et cueille les étoiles en chemin.',
    scene: 'Une bille lumineuse pend sous un fil, au centre du ciel. Juste en dessous, trois étoiles sont alignées au-dessus d’un halo turquoise.',
    physics: {
      orb: { x: 400, y: 180 },
      threads: [{ anchor: { x: 400, y: 70 }, length: 110 }],
      goal: { x: 400, y: 430, r: 34 },
      stars: [{ x: 400, y: 239 }, { x: 400, y: 291 }, { x: 400, y: 349 }],
    },
    reference: { actions: [cut(4, 0)], winTick: 87, starAt: [33, 54, 70] },
  },
  {
    id: 'ch1-g', code: 'CH1-G', title: 'Le rebond',
    hint: 'La bille attend, immobile, au-dessus d’un tremplin de cristal. Coupez quand vous voulez : le tremplin la renvoie vers le halo.',
    scene: 'Une bille pend sous un fil à gauche, au-dessus d’un tremplin de cristal incliné. Trois étoiles suivent la courbe du rebond jusqu’au halo, en bas au centre.',
    physics: {
      orb: { x: 200, y: 170 },
      threads: [{ anchor: { x: 200, y: 60 }, length: 110 }],
      goal: { x: 421, y: 420, r: 34 },
      segments: [seg(140, 330, 300, 390, 'deflector')],
      stars: [{ x: 200, y: 277 }, { x: 268, y: 298 }, { x: 346, y: 327 }],
    },
    reference: { actions: [cut(20, 0)], winTick: 178, starAt: [69, 107, 142] },
  },
  {
    id: 'ch1-d', code: 'CH1-D', title: 'Premier élan',
    hint: 'La bille se balance depuis la droite. Laissez-la passer au plus bas et remonter un peu vers la gauche, puis coupez : elle vole jusqu’à l’entonnoir.',
    scene: 'Une bille se balance au bout d’un long fil, en haut à droite. Trois étoiles jalonnent sa course vers la gauche, jusqu’à un entonnoir de deux murs qui abrite le halo.',
    physics: {
      orb: pend(520, 70, 180, 65),
      threads: [{ anchor: { x: 520, y: 70 }, length: 180 }],
      goal: { x: 210, y: 330, r: 34 },
      segments: [seg(135, 265, 182, 345), seg(285, 265, 238, 345)],
      stars: [{ x: 610, y: 226 }, { x: 488, y: 247 }, { x: 349, y: 198 }],
    },
    reference: { actions: [cut(126, 0)], winTick: 209, starAt: [53, 92, 141] },
  },
  {
    id: 'ch1-b', code: 'CH1-B', title: 'Le balancier',
    hint: 'La bille se balance. Coupez le fil quand elle passe au plus bas : son élan la porte vers l’entonnoir et le halo.',
    scene: 'Une bille lumineuse se balance au bout d’un fil, en haut à gauche. Trois étoiles dessinent une courbe vers la droite, jusqu’à un entonnoir de deux murs au fond duquel brille le halo.',
    physics: {
      orb: pend(300, 60, 170, -70),
      threads: [{ anchor: { x: 300, y: 60 }, length: 170 }],
      goal: { x: 590, y: 410, r: 34 },
      segments: [seg(515, 345, 562, 425), seg(665, 345, 618, 425)],
      stars: [{ x: 411, y: 255 }, { x: 469, y: 291 }, { x: 523, y: 340 }],
    },
    reference: { actions: [cut(92, 0)], winTick: 221, starAt: [113, 130, 146] },
  },
  {
    id: 'ch1-c', code: 'CH1-C', title: 'Deux fils',
    hint: 'Deux fils retiennent la bille. Coupez d’abord celui de gauche : elle se balance sur l’autre. Coupez le second quand elle remonte vers la droite.',
    scene: 'Une bille est retenue par deux fils en V, au centre. Trois étoiles s’alignent vers la droite, à mi-hauteur, jusqu’au halo.',
    physics: {
      orb: { x: 330, y: 200 },
      threads: [{ anchor: { x: 230, y: 70 }, length: 165 }, { anchor: { x: 470, y: 60 }, length: 200 }],
      goal: { x: 690, y: 360, r: 34 },
      stars: [{ x: 419, y: 253 }, { x: 521, y: 253 }, { x: 627, y: 256 }],
    },
    reference: { actions: [cut(12, 0), cut(138, 1)], winTick: 206, starAt: [71, 111, 162] },
  },
  {
    id: 'ch1-h', code: 'CH1-H', title: 'Le grand arc',
    hint: 'Un muret coupe le jardin. Coupez juste après le point bas du balancier : la bille doit passer par-dessus le muret pour rejoindre le halo.',
    scene: 'Une bille se balance au bout d’un long fil, en haut à droite. Un muret se dresse au milieu du sol ; trois étoiles passent au-dessus de lui jusqu’au halo, en bas à gauche.',
    physics: {
      orb: pend(520, 50, 190, 70),
      threads: [{ anchor: { x: 520, y: 50 }, length: 190 }],
      goal: { x: 187, y: 433, r: 34 },
      segments: [seg(300, 370, 300, 500)],
      stars: [{ x: 385, y: 261 }, { x: 320, y: 299 }, { x: 255, y: 354 }],
    },
    reference: { actions: [cut(100, 0)], winTick: 178, starAt: [123, 141, 159] },
  },
  {
    id: 'ch1-i', code: 'CH1-I', title: 'La faille',
    hint: 'Une faille rouge brille au ras du sol : la toucher, c’est perdre. Coupez au point bas du balancier pour que la bille la survole jusqu’au halo.',
    scene: 'Une bille se balance en haut à gauche. Une longue faille rouge court au ras du sol ; trois étoiles et le halo flottent au-dessus d’elle, vers la droite.',
    physics: {
      orb: pend(250, 70, 140, -80),
      threads: [{ anchor: { x: 250, y: 70 }, length: 140 }],
      goal: { x: 533, y: 413, r: 34 },
      rifts: [rift(260, 480, 560, 480)],
      stars: [{ x: 357, y: 243 }, { x: 416, y: 284 }, { x: 471, y: 336 }],
    },
    reference: { actions: [cut(84, 0)], winTick: 157, starAt: [106, 123, 139] },
  },
  {
    id: 'ch1-j', code: 'CH1-J', title: 'Le pont des étoiles',
    hint: 'Coupez le premier fil quand vous voulez : la bille s’élance sur le second. Coupez-le au plus bas, ou juste après : le tremplin la porte jusqu’au halo.',
    scene: 'Une bille pend sous un fil court, en haut à gauche, reliée à un second fil plus long. Trois étoiles mènent à un tremplin de cristal, puis au halo à droite.',
    physics: {
      orb: { x: 150, y: 160 },
      threads: [{ anchor: { x: 150, y: 60 }, length: 100 }, { anchor: { x: 330, y: 60 }, length: 206 }],
      goal: { x: 691, y: 397, r: 34 },
      segments: [seg(500, 360, 640, 400, 'deflector')],
      stars: [{ x: 257, y: 253 }, { x: 397, y: 279 }, { x: 539, y: 339 }],
    },
    reference: { actions: [cut(20, 0), cut(117, 1)], winTick: 210, starAt: [86, 128, 167] },
  },
];
