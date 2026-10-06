// Professeur V2 (PROF-2) — dual-track progression model. PURE: no I/O, no model call, no clock unless passed in.
//
// A V2 module (= one learning_path_steps row) carries `tracks` = { version, theory, practice }. Each track has its own
// state machine and its own validation; the next module unlocks only when BOTH are passed:
//
//   LOCKED ──activate──▶ ACTIVE ──passing verdict──▶ PASSED (final: passedAt kept, never re-evaluated)
//                          │  ▲
//               failing verdict │ retry (same endpoint)
//                          ▼  │
//                      REMEDIATION
//
// A verdict on one track NEVER touches the other one (independent remediation). Practice keeps the provenance of its
// validation (`evidence`): VERIFIED only from a deterministic server-side check, MODEL_ASSESSED from a structured model
// verdict, SELF_REPORTED when the learner declares having done it — and it is never upgraded afterwards.

export const TRACKS_SCHEMA_VERSION = 1;
export const TRACK_NAMES = Object.freeze(['theory', 'practice']);
export const TRACK_STATES = Object.freeze({ LOCKED: 'LOCKED', ACTIVE: 'ACTIVE', PASSED: 'PASSED', REMEDIATION: 'REMEDIATION' });
export const EVIDENCE = Object.freeze({ VERIFIED: 'VERIFIED', MODEL_ASSESSED: 'MODEL_ASSESSED', SELF_REPORTED: 'SELF_REPORTED' });
export const THEORY_EVALUATION_KINDS = Object.freeze(['short', 'explain', 'problem', 'mcq']);
export const PRACTICE_KINDS = Object.freeze(['exercise', 'deliverable', 'checklist', 'result']);

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Default practice spec derived from the plan entry (PROF-3 will generate richer specs; nothing is pretended here). */
export function defaultPracticeSpec(planStep = {}) {
  const title = String(planStep.title ?? '').trim();
  return {
    kind: 'checklist',
    instructions: `Mets en pratique : ${title}`.trim(),
    checklist: [`J'ai réalisé un exercice concret sur « ${title} »`, 'J\'ai vérifié le résultat obtenu'],
    rubric: [],
    generated: false,
  };
}

/** Fresh tracks for a V2 module. The first module starts ACTIVE on both tracks, the others LOCKED. */
export function createTracks({ active = false, planStep = {}, practiceSpec } = {}) {
  const state = active ? TRACK_STATES.ACTIVE : TRACK_STATES.LOCKED;
  return {
    version: TRACKS_SCHEMA_VERSION,
    theory: { state, evaluation: { kind: 'short' }, lastVerdict: null, passedAt: null, attempts: 0 },
    practice: { state, spec: practiceSpec ?? defaultPracticeSpec(planStep), evidence: null, lastVerdict: null, passedAt: null, attempts: 0 },
  };
}

export const isTrackPassed = (track) => track?.state === TRACK_STATES.PASSED && typeof track?.passedAt === 'string';

/** THE gate: a V2 module may be left (next one unlocked) only when theory AND practice are passed. */
export function canAdvance(step) {
  const tracks = step?.tracks;
  if (!tracks || typeof tracks !== 'object') return false; // no tracks = not a V2 module: never through this gate
  return isTrackPassed(tracks.theory) && isTrackPassed(tracks.practice);
}

/** Can a new attempt be evaluated on this track right now? (LOCKED: not yet; PASSED: already acquired) */
export function canAttempt(tracks, trackName) {
  if (!TRACK_NAMES.includes(trackName)) return { ok: false, code: 'UNKNOWN_TRACK' };
  const track = tracks?.[trackName];
  if (!track) return { ok: false, code: 'NO_TRACK' };
  if (track.state === TRACK_STATES.LOCKED) return { ok: false, code: 'TRACK_LOCKED' };
  if (track.state === TRACK_STATES.PASSED) return { ok: false, code: 'TRACK_ALREADY_PASSED' };
  return { ok: true };
}

/**
 * Applies ONE validated verdict to ONE track and returns new tracks (input never mutated).
 * `verdict.passed === true` (strictly) is the only way to PASSED; anything else is a failure → REMEDIATION.
 * The other track is copied untouched — including its state and passedAt.
 */
export function applyVerdict(tracks, trackName, verdict, { now = new Date().toISOString(), evidence = null } = {}) {
  const allowed = canAttempt(tracks, trackName);
  if (!allowed.ok) throw Object.assign(new Error(allowed.code), { code: allowed.code });
  const next = clone(tracks);
  const track = next[trackName];
  track.attempts = (track.attempts ?? 0) + 1;
  track.lastVerdict = verdict;
  if (verdict?.passed === true) {
    track.state = TRACK_STATES.PASSED;
    track.passedAt = now;
  } else {
    track.state = TRACK_STATES.REMEDIATION;
  }
  if (trackName === 'practice') {
    if (!Object.values(EVIDENCE).includes(evidence)) throw Object.assign(new Error('PRACTICE_EVIDENCE_REQUIRED'), { code: 'PRACTICE_EVIDENCE_REQUIRED' });
    track.evidence = evidence; // provenance of the LAST evaluation; kept as-is once PASSED (never upgraded later)
  }
  return next;
}

/** Unlocks a module's tracks (LOCKED → ACTIVE). Already active / remediation / passed tracks are left as they are. */
export function activateTracks(tracks) {
  const next = clone(tracks);
  for (const name of TRACK_NAMES) if (next[name]?.state === TRACK_STATES.LOCKED) next[name].state = TRACK_STATES.ACTIVE;
  return next;
}

// ── PROF-3 — practice specs ────────────────────────────────────────────────────────────────────────────────────────
// Kinds a MODEL may generate. 'result' (deterministic VERIFIED check against `expected`) is deliberately not among
// them: an expected answer written by the model is not ground truth, so it must never be able to label anything
// VERIFIED. The engine still supports 'result' specs authored server-side.
export const GENERATED_PRACTICE_KINDS = Object.freeze(['exercise', 'deliverable', 'checklist']);
export const PRACTICE_MODES = Object.freeze(['self_report', 'deliverable']);

/**
 * Which submission modes a practice spec accepts:
 *   result      → deliverable only (Docteur can check it — self-declaring it would bypass the check)
 *   deliverable → deliverable only (there is something to hand in)
 *   exercise / checklist → self_report (needs a checklist) and deliverable
 *   workout (Sport Coach session) → self_report only (Docteur cannot observe a physical session)
 */
export function allowedPracticeModes(spec) {
  const kind = spec?.kind;
  if (kind === 'workout') return ['self_report']; // PROF-5 Sport: a real workout can only be declared, never 'verified'
  if (kind === 'result' || kind === 'deliverable') return ['deliverable'];
  const hasChecklist = Array.isArray(spec?.checklist) && spec.checklist.length > 0;
  return hasChecklist ? ['self_report', 'deliverable'] : ['deliverable'];
}

/** The spec as the learner may see it: a server-side `expected` answer is never sent to the client. */
export function publicPracticeSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const { expected, ...visible } = spec; // eslint-disable-line no-unused-vars
  return visible;
}

/**
 * May a generated spec replace the current one? Only the generic default (generated === false) — never a spec
 * authored server-side or already generated — and only before any practice attempt (history stays coherent).
 */
export function canReplacePracticeSpec(tracks) {
  const practice = tracks?.practice;
  if (!practice) return { ok: false, code: 'NO_TRACK' };
  if (practice.state === TRACK_STATES.LOCKED) return { ok: false, code: 'TRACK_LOCKED' };
  if (practice.state === TRACK_STATES.PASSED) return { ok: false, code: 'TRACK_ALREADY_PASSED' };
  if ((practice.attempts ?? 0) > 0) return { ok: false, code: 'SPEC_FROZEN' };
  if (practice.spec?.generated !== false) return { ok: false, code: 'SPEC_NOT_DEFAULT' };
  return { ok: true };
}

/** Legacy `status` column kept coherent for V2 rows (so an older build still navigates them): done ⇔ both passed. */
export function deriveStepStatus(step, { isCurrent }) {
  if (canAdvance(step)) return 'done';
  return isCurrent ? 'active' : 'pending';
}
