// Notebook NB-3 — retention policies (local only, no scheduler dependency).
//
// KEEP          default; no expiry. Semantics identical to MANUAL (see below).
// MANUAL        the user explicitly chose "never auto-delete". Behaviourally the
//               same as KEEP — only the UI framing differs (KEEP = no policy
//               chosen, MANUAL = deliberate). No fake behavioural difference.
// DELETE_AFTER  explicit duration (e.g. 1h, 24h, 7d): the document expires; it
//               is excluded from every query the moment it expires and purged
//               (rows, FTS, embeddings, vectors) by a bounded local sweep.
// SESSION_ONLY  usable during this server session; purged at the next boot (and
//               invisible to queries of any other session even before the purge).

export const RETENTION_POLICIES = Object.freeze(['KEEP', 'MANUAL', 'DELETE_AFTER', 'SESSION_ONLY']);

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
export const MIN_RETENTION_MS = 60_000;          // 1 minute
export const MAX_RETENTION_MS = 365 * 86_400_000; // 1 year

export function parseRetentionDuration(value) {
  const m = /^(\d{1,4})\s*([mhd])$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
  if (ms < MIN_RETENTION_MS || ms > MAX_RETENTION_MS) return null;
  return ms;
}
