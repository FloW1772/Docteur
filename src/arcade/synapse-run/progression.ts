// [GAME-5] Synapse Run — local progression: profile model, strict validation, run settlement, fixed missions and
// the save session (load → settle → coalesced writes). Pure: no DOM, no storage, no clock. The profile is persisted
// only through the GAME-3 host save (saveVersion SYNAPSE_RUN_SAVE_VERSION) via foundation.js; it never enters the
// authoritative simulation state.
//
// Rules:
//   * a run is settled once, and only when it legitimately reaches GAME_OVER; abandoning or restarting a run
//     before GAME_OVER settles nothing (no run, distance or shards are counted)
//   * missions are single-run goals: progress = best value reached in ONE run (never summed), completion is
//     permanent and cannot happen twice; no reward, currency or unlock
//   * a loaded payload must match the v1 shape exactly (same keys, integer bounds, known mission ids); anything else
//     is treated as corrupt: it is not used and never overwritten automatically (the user resets it in the Arcade)
//   * writes: at most one in flight; settlements during a write coalesce into one follow-up write of the latest
//     profile; a failed write is reported and not retried (the next settlement writes the full profile again)

export const SYNAPSE_RUN_SAVE_VERSION = 1;
/** Saturation bound for every counter (keeps values exact integers and the payload tiny). */
export const MAX_COUNTER = 1_000_000_000;

export type MissionId = 'run-500' | 'shards-10' | 'score-750';
export type MissionMetric = 'distance' | 'shards' | 'score';

export interface MissionDefinition {
  readonly id: MissionId;
  readonly metric: MissionMetric;
  readonly target: number;
  readonly label: string;
  readonly unit: string;
}

export const MISSIONS: readonly MissionDefinition[] = Object.freeze([
  Object.freeze({ id: 'run-500', metric: 'distance', target: 500, label: 'Parcourir 500 m en une seule course', unit: 'm' }),
  Object.freeze({ id: 'shards-10', metric: 'shards', target: 10, label: 'Ramasser 10 éclats en une seule course', unit: 'éclats' }),
  Object.freeze({ id: 'score-750', metric: 'score', target: 750, label: 'Atteindre 750 points en une seule course', unit: 'points' }),
] as const);

export interface MissionState { progress: number; completed: boolean }

export interface Profile {
  bestDistanceM: number;
  bestScore: number;
  totalRuns: number;
  totalDistanceM: number;
  totalShards: number;
  missions: Record<MissionId, MissionState>;
}

/** Summary of one finished run (taken from the simulation at GAME_OVER). */
export interface RunSummary { distanceM: number; shards: number; score: number }

export function defaultProfile(): Profile {
  const missions = {} as Record<MissionId, MissionState>;
  for (const mission of MISSIONS) missions[mission.id] = { progress: 0, completed: false };
  return { bestDistanceM: 0, bestScore: 0, totalRuns: 0, totalDistanceM: 0, totalShards: 0, missions };
}

const PROFILE_KEYS = 'bestDistanceM,bestScore,missions,totalDistanceM,totalRuns,totalShards';
const MISSION_KEYS = MISSIONS.map(m => m.id).sort().join(',');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isCounter(value: unknown, max = MAX_COUNTER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/**
 * Validates an untrusted loaded payload. Returns a fresh Profile built field by field (never the input object), or
 * null if anything is off: wrong type, extra or missing key, non-integer, out of range, unknown mission, or an
 * inconsistent combination (a best above the total, completion without reaching the target).
 */
export function validateProfile(data: unknown): Profile | null {
  if (!isPlainObject(data) || Object.keys(data).sort().join(',') !== PROFILE_KEYS) return null;
  const { bestDistanceM, bestScore, totalRuns, totalDistanceM, totalShards, missions } = data;
  if (!isCounter(bestDistanceM) || !isCounter(bestScore) || !isCounter(totalRuns) || !isCounter(totalDistanceM) || !isCounter(totalShards)) return null;
  if (bestDistanceM > totalDistanceM) return null;
  if (totalRuns === 0 && (totalDistanceM !== 0 || totalShards !== 0 || bestScore !== 0)) return null;
  if (!isPlainObject(missions) || Object.keys(missions).sort().join(',') !== MISSION_KEYS) return null;
  const profile = defaultProfile();
  Object.assign(profile, { bestDistanceM, bestScore, totalRuns, totalDistanceM, totalShards });
  for (const mission of MISSIONS) {
    const entry = missions[mission.id];
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(',') !== 'completed,progress') return null;
    if (!isCounter(entry.progress, mission.target) || typeof entry.completed !== 'boolean') return null;
    if (entry.completed !== (entry.progress === mission.target)) return null;
    profile.missions[mission.id] = { progress: entry.progress, completed: entry.completed };
  }
  return profile;
}

function metricValue(run: RunSummary, metric: MissionMetric): number {
  return metric === 'distance' ? run.distanceM : metric === 'shards' ? run.shards : run.score;
}

function cleanRun(run: RunSummary): RunSummary {
  const clamp = (value: number) => (Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_COUNTER) : 0);
  return { distanceM: clamp(run.distanceM), shards: clamp(run.shards), score: clamp(run.score) };
}

/** In-run mission progress (live display); never written by itself. */
export function missionProgress(profile: Profile, run: RunSummary): { mission: MissionDefinition; progress: number; completed: boolean; inRun: number }[] {
  const r = cleanRun(run);
  return MISSIONS.map(mission => {
    const stored = profile.missions[mission.id];
    const inRun = Math.min(metricValue(r, mission.metric), mission.target);
    return { mission, progress: Math.max(stored.progress, inRun), completed: stored.completed || inRun >= mission.target, inRun };
  });
}

/** One finished run → new profile (input untouched). Counters saturate at MAX_COUNTER. */
export function settleCompletedRun(profile: Profile, run: RunSummary): { profile: Profile; newRecords: { distance: boolean; score: boolean }; completedMissions: MissionId[] } {
  const r = cleanRun(run);
  const add = (a: number, b: number) => Math.min(a + b, MAX_COUNTER);
  const next = defaultProfile();
  next.totalRuns = add(profile.totalRuns, 1);
  next.totalDistanceM = add(profile.totalDistanceM, r.distanceM);
  next.totalShards = add(profile.totalShards, r.shards);
  next.bestDistanceM = Math.max(profile.bestDistanceM, r.distanceM);
  next.bestScore = Math.max(profile.bestScore, r.score);
  const completedMissions: MissionId[] = [];
  for (const mission of MISSIONS) {
    const before = profile.missions[mission.id];
    const progress = Math.max(before.progress, Math.min(metricValue(r, mission.metric), mission.target));
    const completed = before.completed || progress >= mission.target;
    if (completed && !before.completed) completedMissions.push(mission.id);
    next.missions[mission.id] = { progress, completed };
  }
  return { profile: next, newRecords: { distance: r.distanceM > profile.bestDistanceM, score: r.score > profile.bestScore }, completedMissions };
}

/** Canonical JSON-safe payload (fixed key order, so the same profile always serialises to the same bytes). */
export function serializeProfile(profile: Profile): Profile {
  const missions = {} as Record<MissionId, MissionState>;
  for (const mission of MISSIONS) missions[mission.id] = { progress: profile.missions[mission.id].progress, completed: profile.missions[mission.id].completed };
  return { bestDistanceM: profile.bestDistanceM, bestScore: profile.bestScore, totalRuns: profile.totalRuns, totalDistanceM: profile.totalDistanceM, totalShards: profile.totalShards, missions };
}

// ── save session ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * LOADING      waiting for the host's load result (settlements are held, at most MAX_HELD_RUNS)
 * READY        loaded (empty or valid v1): settlements are saved
 * UNAVAILABLE  storage unavailable / failed to load: play continues, nothing is saved
 * PROTECTED    the stored save is corrupt, of another version or logically invalid: kept untouched, nothing saved
 */
export type SaveStatus = 'LOADING' | 'READY' | 'UNAVAILABLE' | 'PROTECTED';
export type WriteStatus = 'IDLE' | 'WRITING' | 'SAVED' | 'FAILED';
export const MAX_HELD_RUNS = 16;

export type LoadResult =
  | { status: 'EMPTY' }
  | { status: 'FOUND'; saveVersion: unknown; data: unknown }
  | { status: 'ERROR'; code: string };

export interface SaveSession {
  readonly profile: Profile;
  readonly saveStatus: SaveStatus;
  readonly writeStatus: WriteStatus;
  readonly reason: string | null;
  /** Applies the host's load result. Returns a payload to write if held runs must now be saved. */
  onLoad(result: LoadResult): Profile | null;
  /** Settles run `runId` once (a second call with the same id is ignored). Returns a payload to write now, or null. */
  settle(runId: number, run: RunSummary): { settled: boolean; write: Profile | null; newRecords: { distance: boolean; score: boolean }; completedMissions: MissionId[] };
  /** Applies a write result. Returns the follow-up payload if settlements happened meanwhile. */
  onWriteResult(ok: boolean): Profile | null;
}

export function createSaveSession(): SaveSession {
  let profile = defaultProfile();
  let saveStatus: SaveStatus = 'LOADING';
  let writeStatus: WriteStatus = 'IDLE';
  let reason: string | null = null;
  let dirty = false;
  let lastSettledRun = -1;
  const held: RunSummary[] = [];

  const requestWrite = (): Profile | null => {
    if (saveStatus !== 'READY') return null;
    if (writeStatus === 'WRITING') { dirty = true; return null; }
    writeStatus = 'WRITING';
    dirty = false;
    return serializeProfile(profile);
  };

  return {
    get profile() { return profile; },
    get saveStatus() { return saveStatus; },
    get writeStatus() { return writeStatus; },
    get reason() { return reason; },
    onLoad(result) {
      if (saveStatus !== 'LOADING') return null;
      if (result.status === 'EMPTY') {
        saveStatus = 'READY';
      } else if (result.status === 'FOUND') {
        const loaded = result.saveVersion === SYNAPSE_RUN_SAVE_VERSION ? validateProfile(result.data) : null;
        if (loaded) { profile = loaded; saveStatus = 'READY'; } else { saveStatus = 'PROTECTED'; reason = 'INVALID_PROFILE'; }
      } else {
        saveStatus = result.code === 'CORRUPT_SAVE' || result.code === 'UNSUPPORTED_SAVE_VERSION' ? 'PROTECTED' : 'UNAVAILABLE';
        reason = result.code;
      }
      // runs finished while loading are applied on top of what was loaded (or of the in-memory profile)
      const hadHeld = held.length > 0;
      for (const run of held.splice(0)) profile = settleCompletedRun(profile, run).profile;
      return hadHeld ? requestWrite() : null;
    },
    settle(runId, run) {
      const none = { distance: false, score: false };
      if (runId <= lastSettledRun) return { settled: false, write: null, newRecords: none, completedMissions: [] };
      lastSettledRun = runId;
      if (saveStatus === 'LOADING') {
        if (held.length < MAX_HELD_RUNS) held.push(run);
        const preview = settleCompletedRun(profile, run);
        return { settled: true, write: null, newRecords: preview.newRecords, completedMissions: preview.completedMissions };
      }
      const result = settleCompletedRun(profile, run);
      profile = result.profile;
      return { settled: true, write: requestWrite(), newRecords: result.newRecords, completedMissions: result.completedMissions };
    },
    onWriteResult(ok) {
      if (writeStatus !== 'WRITING') return null;
      writeStatus = ok ? 'SAVED' : 'FAILED';
      if (dirty) return requestWrite();
      return null;
    },
  };
}
