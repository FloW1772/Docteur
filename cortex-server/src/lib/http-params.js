// Safe integer query-param parsing (Batch A, audit finding F16).
//
// Number(x) on a non-numeric query string (e.g. ?limit=abc) yields NaN, which
// then propagates unguarded into Math.min/Math.max and finally into a
// prepared SQLite statement expecting an integer bind parameter — better-
// sqlite3 throws "datatype mismatch" on a NaN, turning a malformed/bookmarked
// URL into an unhandled 500 instead of a graceful fallback to the default.
// Reproduced and confirmed during the Phase 9 audit (2026-09) across 5 route
// files (routes/memory.js, notebook.js, privacy.js, skills.js, teacher.js).
export function parseIntParam(rawValue, fallback) {
  const n = Number(rawValue);
  return Number.isFinite(n) ? n : fallback;
}
