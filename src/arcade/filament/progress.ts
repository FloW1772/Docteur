// [FILAMENT-3] Filament — saved progression: format, strict validation, best-result merge and the save session
// (load → record wins → coalesced writes). Pure: no DOM, no storage, no clock, no physics. The progression is persisted
// only through the Arcade host save (GAME-3: protocol ARCADE_SAVE_LOAD / _WRITE, host-owned IndexedDB
// "docteur-arcade", key "arcade:v1:filament") via public/arcade/filament/host.js. The page itself stores nothing.
//
// Format, saveVersion FILAMENT_SAVE_VERSION (1):
//   { format: 'filament-progress-v1', levels: { '<level id>': <best stars 0..3>, … } }
//   * a level appears only once it has been WON; its value is the best star count ever reached (never lowered)
//   * keys are the stable level ids of chapter1.ts ('ch1-a' …), so reordering levels never moves a result
//   * written in the fixed level order (same progression → same bytes); ≈ 150 bytes for the whole chapter
// Validation of a loaded payload (anything else is CORRUPT for this version): exactly the keys format + levels, the
// exact format string, a plain object of at most one entry per KNOWN level, integer stars within that level's star
// count, serialised size ≤ MAX_PROGRESS_BYTES. Unknown level ids are refused, not ignored: a future chapter will raise
// saveVersion, so an older game reading a newer save is refused by the host's version window instead.
// Never overwritten automatically: a corrupt or newer save (PROTECTED) is kept as it is and nothing is written; the
// player resets it with the Arcade's own two-step control. Storage unavailable (UNAVAILABLE): play continues, results
// stay in memory for this session, nothing is claimed as saved.

export const FILAMENT_SAVE_VERSION = 1;
export const PROGRESS_FORMAT = 'filament-progress-v1';
/** far above the real size (≈ 150 bytes); the host's own bound is 64 KiB */
export const MAX_PROGRESS_BYTES = 2048;

export interface KnownLevel { readonly id: string; readonly stars: number }

export interface ProgressPayload { format: typeof PROGRESS_FORMAT; levels: Record<string, number> }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Untrusted payload → a fresh Map(level id → best stars), or null if anything is off. Never throws. */
export function validateProgress(data: unknown, known: readonly KnownLevel[]): Map<string, number> | null {
  if (!isPlainObject(data) || Object.keys(data).sort().join(',') !== 'format,levels') return null;
  if (data.format !== PROGRESS_FORMAT || !isPlainObject(data.levels)) return null;
  let size: number;
  try { size = JSON.stringify(data).length; } catch { return null; }
  if (size > MAX_PROGRESS_BYTES) return null;
  const entries = Object.keys(data.levels);
  if (entries.length > known.length) return null;
  const best = new Map<string, number>();
  for (const id of entries) {
    const level = known.find(l => l.id === id);
    const stars = data.levels[id];
    if (!level || typeof stars !== 'number' || !Number.isSafeInteger(stars) || stars < 0 || stars > level.stars) return null;
    best.set(id, stars);
  }
  return best;
}

/** Canonical payload: known levels only, fixed order. */
export function serializeProgress(best: ReadonlyMap<string, number>, known: readonly KnownLevel[]): ProgressPayload {
  const levels: Record<string, number> = {};
  for (const level of known) {
    const stars = best.get(level.id);
    if (stars !== undefined) levels[level.id] = stars;
  }
  return { format: PROGRESS_FORMAT, levels };
}

// ── save session ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * LOADING      waiting for the host's load result (wins are kept in memory and merged once it arrives)
 * READY        loaded (empty or valid v1): progress changes are saved
 * UNAVAILABLE  storage unavailable / load failed: play continues, nothing is saved this session
 * PROTECTED    the stored save is corrupt or of another version: kept untouched, nothing is saved
 */
export type SaveStatus = 'LOADING' | 'READY' | 'UNAVAILABLE' | 'PROTECTED';
/** WRITING → SAVED / FAILED only on the host's answer: "saved" is never shown before it is confirmed. */
export type WriteStatus = 'IDLE' | 'WRITING' | 'SAVED' | 'FAILED';

export type LoadResult =
  | { status: 'EMPTY' }
  | { status: 'FOUND'; saveVersion: unknown; data: unknown }
  | { status: 'ERROR'; code: string };

export interface ProgressSession {
  readonly saveStatus: SaveStatus;
  readonly writeStatus: WriteStatus;
  readonly reason: string | null;
  /** best stars of a won level, or -1 when not won */
  best(id: string): number;
  /** index (in `known` order) of the first level not won yet, or the last level when all are won */
  firstOpen(): number;
  totalStars(): number;
  /** Applies the host's load result (once). Returns a payload to write if wins made while loading must be saved. */
  onLoad(result: LoadResult): ProgressPayload | null;
  /** A legitimate win. Keeps the best result; returns a payload to write when the progression changed (or when the
   * previous write failed), else null. */
  recordWin(id: string, stars: number): ProgressPayload | null;
  /** Applies a write result. Returns the follow-up payload if the progression changed meanwhile. */
  onWriteResult(ok: boolean): ProgressPayload | null;
}

export function createProgressSession(known: readonly KnownLevel[]): ProgressSession {
  let best = new Map<string, number>();
  let saveStatus: SaveStatus = 'LOADING';
  let writeStatus: WriteStatus = 'IDLE';
  let reason: string | null = null;
  let dirty = false;

  const requestWrite = (): ProgressPayload | null => {
    if (saveStatus !== 'READY') return null;
    if (writeStatus === 'WRITING') { dirty = true; return null; }
    writeStatus = 'WRITING';
    dirty = false;
    return serializeProgress(best, known);
  };

  /** max-merge of `from` into `into`; true if anything improved */
  const mergeInto = (into: Map<string, number>, from: ReadonlyMap<string, number>): boolean => {
    let changed = false;
    for (const [id, stars] of from) {
      if ((into.get(id) ?? -1) < stars) { into.set(id, stars); changed = true; }
    }
    return changed;
  };

  return {
    get saveStatus() { return saveStatus; },
    get writeStatus() { return writeStatus; },
    get reason() { return reason; },
    best: (id) => best.get(id) ?? -1,
    firstOpen() {
      const index = known.findIndex(level => !best.has(level.id));
      return index < 0 ? Math.max(known.length - 1, 0) : index;
    },
    totalStars() {
      let n = 0;
      for (const stars of best.values()) n += stars;
      return n;
    },
    onLoad(result) {
      if (saveStatus !== 'LOADING') return null;
      if (result.status === 'EMPTY') {
        saveStatus = 'READY';
        return best.size > 0 ? requestWrite() : null;
      }
      if (result.status === 'FOUND') {
        const loaded = result.saveVersion === FILAMENT_SAVE_VERSION ? validateProgress(result.data, known) : null;
        if (!loaded) { saveStatus = 'PROTECTED'; reason = 'INVALID_PROGRESS'; return null; }
        // wins made while loading are kept on top of what was stored (never lowering a stored result)
        const sessionWins = best;
        best = loaded;
        saveStatus = 'READY';
        return mergeInto(best, sessionWins) ? requestWrite() : null;
      }
      saveStatus = result.code === 'CORRUPT_SAVE' || result.code === 'UNSUPPORTED_SAVE_VERSION' ? 'PROTECTED' : 'UNAVAILABLE';
      reason = result.code;
      return null;
    },
    recordWin(id, stars) {
      const level = known.find(l => l.id === id);
      if (!level || !Number.isSafeInteger(stars) || stars < 0 || stars > level.stars) return null;
      // not better: nothing new to write, unless the last write failed (then this win retries it: one try per win,
      // never a timer or a loop)
      if ((best.get(id) ?? -1) >= stars) return writeStatus === 'FAILED' ? requestWrite() : null;
      best.set(id, stars);
      return requestWrite();
    },
    onWriteResult(ok) {
      if (writeStatus !== 'WRITING') return null;
      writeStatus = ok ? 'SAVED' : 'FAILED';
      return dirty ? requestWrite() : null;
    },
  };
}
