// Professeur V2 (PROF-2) — compatibility layer between V1 (single track) and V2 (theory + practice) parcours.
//
// V1 rows (schema_version 1 — every parcours created before PROF-2, and every parcours still created without asking for
// V2) are NEVER rewritten. They are only *presented* with a derived, read-only view: their historical validation maps to
// the theory track, and practice is NOT_APPLICABLE — no practice is invented retroactively for them.

import { publicPracticeSpec } from './teacher-progress.js';

export const SCHEMA_V1 = 1;
export const SCHEMA_V2 = 2;

export const schemaVersionOf = (path) => (Number.isInteger(path?.schema_version) ? path.schema_version : SCHEMA_V1);
export const isDualTrackPath = (path) => schemaVersionOf(path) >= SCHEMA_V2;

const LEGACY_THEORY_STATE = { done: 'PASSED', active: 'ACTIVE', pending: 'LOCKED' };

/** Read-only presentation of a step; the stored fields are returned unchanged, a `track_view` is added. */
export function presentStep(path, step) {
  if (!step) return step;
  if (isDualTrackPath(path)) {
    // PROF-3: a server-side expected answer (deterministic VERIFIED check) never leaves the server.
    const tracks = step.tracks?.practice
      ? { ...step.tracks, practice: { ...step.tracks.practice, spec: publicPracticeSpec(step.tracks.practice.spec) } }
      : (step.tracks ?? null);
    return { ...step, tracks, legacy: false, track_view: tracks };
  }
  return {
    ...step,
    legacy: true,
    track_view: {
      theory: { state: LEGACY_THEORY_STATE[step.status] ?? 'LOCKED', source: 'legacy_comprehension_check' },
      practice: { state: 'NOT_APPLICABLE' },
    },
  };
}

export function presentPath(path) {
  if (!path) return path;
  return { ...path, schema_version: schemaVersionOf(path), mode: path.mode ?? 'standard', legacy: !isDualTrackPath(path) };
}
