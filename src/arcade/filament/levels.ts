// [FILAMENT-1] Filament — approved levels of the playable preview. [FILAMENT-2] The data now lives in chapter1.ts
// (8 levels, imports nothing) so that the game and the supervised verification read the very same objects; this file
// adds the types, the play order numbers and the freeze. ONLY levels whose reference solution was replayed under the
// supervised lab are listed (provenance in chapter1.ts). The game never plays a reference solution by itself.
// [FILAMENT-4] Chapters. Chapter 2 « Courants d’Altitude » (chapter2.ts) is listed as PENDING_VALIDATION: its levels
// are shown in the level grid as « en préparation », can be previewed (scenery and winds, no goal, no stars, never
// simulated), and are NOT in FILAMENT_LEVELS — so they are neither playable, nor counted, nor saved — until a separate
// supervised validation gives each one a goal, stars and a verified reference solution.
// [FILAMENT-4 CH2-A] CH2-A « Premier souffle » (level 9) is the first validated chapter-2 level: it is in FILAMENT_LEVELS,
// after the 8 chapter-1 levels (their numbers and order unchanged); CH2-B … CH2-F stay pending.
// [FILAMENT-5] Chapter 3 « Vergers Stellaires » (chapter3.ts, levels 15–19): five PENDING_VALIDATION specifications, shown
// as « en préparation » with a scenery preview, never in FILAMENT_LEVELS (not playable, not counted, not saved).
// Chapter 4 (5 levels, 24 in all) is planned, not created.
// [FILAMENT-6] Chapter 4 « Lisière du Crépuscule » (chapter4.ts, levels 20–24), the last one: five PENDING_VALIDATION
// specifications, shown as « en préparation » with a scenery preview, never in FILAMENT_LEVELS (not playable, not
// counted, not saved). The 19 playable levels, their ids, numbers and order are unchanged.
import type { Action, CurrentDef, LevelPhysics } from './physics.ts';
import { CHAPTER1_LEVELS } from './chapter1.ts';
import { CHAPTER2_LEVELS, CHAPTER2_SPECS } from './chapter2.ts';
import { CHAPTER3_LEVELS, CHAPTER3_SPECS } from './chapter3.ts';
import { CHAPTER4_LEVELS, CHAPTER4_SPECS } from './chapter4.ts';

export type ChapterId = 'ch1' | 'ch2' | 'ch3' | 'ch4';
export type ChapterTheme = 'aube' | 'altitude' | 'verger' | 'crepuscule';

export interface FilamentChapter {
  readonly id: ChapterId;
  readonly number: number;
  readonly title: string;
  readonly theme: ChapterTheme;
}

export interface ReferenceSolution {
  readonly actions: readonly { readonly tick: number; readonly action: Action }[];
  readonly winTick: number;
  readonly starAt: readonly number[];
}

export interface FilamentLevel {
  readonly id: string;
  readonly code: string;
  readonly chapter: ChapterId;
  /** 1-based position in the whole game (chapter 1: 1–8) */
  readonly number: number;
  readonly title: string;
  readonly hint: string;
  /** text alternative of the scene (canvas aria-label) */
  readonly scene: string;
  readonly physics: LevelPhysics;
  readonly reference: ReferenceSolution;
}

/** A level that exists as a specification only (no goal, no stars, nothing verified). */
export interface PendingLevel {
  readonly id: string;
  readonly code: string;
  readonly chapter: ChapterId;
  readonly number: number;
  readonly title: string;
  readonly status: 'PENDING_VALIDATION';
  readonly mechanics: readonly string[];
  readonly intent: string;
  readonly scene: string;
  readonly physics: Omit<LevelPhysics, 'goal' | 'stars'> & { readonly currents?: readonly CurrentDef[] };
  /** hypotheses for the supervised validation; never used by the game */
  readonly design: { readonly actions: readonly { readonly tick: number; readonly action: Action }[]; readonly place: { readonly gx?: number; readonly gy?: number }; readonly estimate: string };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

export const FILAMENT_CHAPTERS: readonly FilamentChapter[] = deepFreeze([
  { id: 'ch1', number: 1, title: 'Jardins de l’Aube', theme: 'aube' },
  { id: 'ch2', number: 2, title: 'Courants d’Altitude', theme: 'altitude' },
  { id: 'ch3', number: 3, title: 'Vergers Stellaires', theme: 'verger' },
  { id: 'ch4', number: 4, title: 'Lisière du Crépuscule', theme: 'crepuscule' },
] satisfies FilamentChapter[]);

/** [FILAMENT-6] planned size of the whole game, chapters 1 to 4 (not a count of playable levels) */
export const PLANNED_LEVELS = 24;

/** kept for the chapter-1 texts */
export const CHAPTER_TITLE = 'Jardins de l’Aube';

/** Playable, verified levels only (chapter 1, then the validated chapter-2 levels). Progress, navigation and saves use
 * this list; a level's index in it is its number − 1. */
export const FILAMENT_LEVELS: readonly FilamentLevel[] = deepFreeze([
  ...CHAPTER1_LEVELS.map((level, index): FilamentLevel => ({ ...level, chapter: 'ch1', number: index + 1 })),
  ...CHAPTER2_LEVELS.map((level): FilamentLevel => ({ ...level, chapter: 'ch2' })),
  // [FILAMENT-5 CH3] validated chapter-3 levels (after the 14 earlier ones, numbers unchanged)
  ...CHAPTER3_LEVELS.map((level): FilamentLevel => ({ ...level, chapter: 'ch3' })),
  // [FILAMENT-6 CH4] validated chapter-4 levels (after the 19 earlier ones, numbers unchanged), one at a time
  ...CHAPTER4_LEVELS.map((level): FilamentLevel => ({ ...level, chapter: 'ch4' })),
]);

/** [FILAMENT-4] Chapter 2 specifications awaiting supervised validation (not playable). */
export const PENDING_LEVELS: readonly PendingLevel[] = deepFreeze([
  ...CHAPTER2_SPECS.map((spec): PendingLevel => ({ ...spec, chapter: 'ch2' })),
  ...CHAPTER3_SPECS.map((spec): PendingLevel => ({ ...spec, chapter: 'ch3' })),
  ...CHAPTER4_SPECS.map((spec): PendingLevel => ({ ...spec, chapter: 'ch4' })),
]);

export function getLevel(index: number): FilamentLevel | null {
  return Number.isInteger(index) && index >= 0 && index < FILAMENT_LEVELS.length ? FILAMENT_LEVELS[index] : null;
}

export function getChapter(id: ChapterId): FilamentChapter {
  return FILAMENT_CHAPTERS.find(chapter => chapter.id === id) ?? FILAMENT_CHAPTERS[0];
}

/** [FILAMENT-4 CH2-A] indices in FILAMENT_LEVELS of one chapter's playable levels, in play order */
export function chapterLevelIndices(id: ChapterId): number[] {
  return FILAMENT_LEVELS.flatMap((level, index) => (level.chapter === id ? [index] : []));
}

/** [FILAMENT-4 CH2-A] one chapter's pending levels, in number order */
export function chapterPending(id: ChapterId): PendingLevel[] {
  return PENDING_LEVELS.filter(pending => pending.chapter === id);
}

/** Far outside the world: a preview has no goal (the renderer draws it out of sight). */
const NO_GOAL = Object.freeze({ x: -5000, y: -5000, r: 1 });

/**
 * Scenery preview of a pending level: its threads, walls, rifts and winds, with NO goal and NO stars. Shown behind the
 * title screen only; it is never stepped (no simulation) and never reaches the progress or the save.
 */
export function previewLevel(pending: PendingLevel): FilamentLevel {
  return {
    id: pending.id, code: pending.code, chapter: pending.chapter, number: pending.number, title: pending.title,
    hint: pending.intent, scene: pending.scene,
    physics: { ...pending.physics, currents: pending.physics.currents ? [...pending.physics.currents] : undefined, goal: NO_GOAL, stars: [] },
    reference: { actions: [], winTick: 0, starAt: [] },
  };
}
