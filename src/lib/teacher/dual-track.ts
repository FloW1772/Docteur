// Professeur V2 (PROF-3) — pure view-model helpers for the THÉORIE | PRATIQUE lesson UI.
// The server stays the only authority (gate on /advance, evidence, verdicts); these helpers only decide what the UI
// shows and offers, mirroring the server rules so the learner never sees an action the server would refuse.
import type { TeacherTrackState, TeacherPracticeEvidence, TeacherPracticeMode, TeacherTracks, TeacherVerdict, TeacherAttemptView } from '../cortex/client';

/** Under this panel width the two tracks are shown as tabs (their states stay distinct). */
export const DUAL_TRACK_COLUMNS_MIN_WIDTH = 900;

export type DualTrackLayout = 'columns' | 'tabs';

export function dualTrackLayout(width: number): DualTrackLayout {
  return Number.isFinite(width) && width >= DUAL_TRACK_COLUMNS_MIN_WIDTH ? 'columns' : 'tabs';
}

export const TRACK_STATE_LABELS: Record<TeacherTrackState, string> = {
  LOCKED: 'Verrouillé',
  ACTIVE: 'En cours',
  REMEDIATION: 'À retravailler',
  PASSED: 'Validé',
};

export const TRACK_STATE_COLORS: Record<TeacherTrackState, string> = {
  LOCKED: '#64748b',
  ACTIVE: '#a78bfa',
  REMEDIATION: '#ffb547',
  PASSED: '#3dffaa',
};

export const EVIDENCE_LABELS: Record<TeacherPracticeEvidence, string> = {
  VERIFIED: 'Vérifié par Docteur',
  MODEL_ASSESSED: 'Évalué par le modèle (sur ton livrable)',
  SELF_REPORTED: 'Auto-déclaré — non observé par Docteur',
};

export const PRACTICE_KIND_LABELS: Record<string, string> = {
  exercise: 'Exercice réel',
  deliverable: 'Livrable à rendre',
  checklist: 'Checklist d’actions',
  result: 'Résultat à fournir',
  workout: 'Séance d’entraînement',
};

type Spec = TeacherTracks['practice']['spec'] | null | undefined;

/** Mirror of the server's allowedPracticeModes (teacher-progress.js). */
export function allowedPracticeModes(spec: Spec): TeacherPracticeMode[] {
  const kind = spec?.kind;
  if (kind === 'workout') return ['self_report'];
  if (kind === 'result' || kind === 'deliverable') return ['deliverable'];
  return (spec?.checklist?.length ?? 0) > 0 ? ['self_report', 'deliverable'] : ['deliverable'];
}

/** A track accepts a new attempt only while ACTIVE or in REMEDIATION (mirror of canAttempt). */
export function canSubmitTrack(state: TeacherTrackState | undefined): boolean {
  return state === 'ACTIVE' || state === 'REMEDIATION';
}

/** UI hint only — the server re-checks on /advance (TRACKS_NOT_PASSED). */
export function bothTracksPassed(tracks: TeacherTracks | null | undefined): boolean {
  return tracks?.theory?.state === 'PASSED' && tracks?.practice?.state === 'PASSED';
}

/** The generic default exercise is replaced by a generated one once, before any practice attempt. */
export function shouldRequestPracticeSpec(tracks: TeacherTracks | null | undefined): boolean {
  const p = tracks?.practice;
  if (!p || !canSubmitTrack(p.state)) return false;
  return p.spec?.generated === false && (p.attempts ?? 0) === 0;
}

export type VerdictTone = 'passed' | 'failed' | 'invalid';

export function verdictTone(verdict: TeacherVerdict | null | undefined): VerdictTone | null {
  if (!verdict) return null;
  if (verdict.invalid) return 'invalid';
  return verdict.passed ? 'passed' : 'failed';
}

/** What the "next module" control should say; enabled only when both tracks are passed. */
export function advanceLabel({ passed, isLast }: { passed: boolean; isLast: boolean }): string {
  if (!passed) return 'Valide la théorie ET la pratique pour continuer';
  return isLast ? 'Terminer le parcours' : 'Module suivant';
}

// ── PROF-4 — history & navigation ───────────────────────────────────────────────────────────────────────────────────
type AttemptView = TeacherAttemptView;

export type AttemptStatus = 'passed' | 'failed' | 'invalid' | 'corrupted';

export function attemptStatus(attempt: AttemptView): AttemptStatus {
  if (attempt.corrupted || !attempt.verdict) return 'corrupted';
  if (attempt.verdict.invalid) return 'invalid';
  return attempt.passed && attempt.verdict.passed ? 'passed' : 'failed';
}

export const ATTEMPT_STATUS_LABELS: Record<AttemptStatus, string> = {
  passed: 'Validée',
  failed: 'À retravailler',
  invalid: 'Évaluation inexploitable',
  corrupted: 'Tentative illisible',
};

/** Short, learner-facing summary of what was submitted (never internal fields). */
export function submissionSummary(payload: AttemptView['payload'] | undefined, max = 160): string {
  if (!payload) return '';
  const clip = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  if (typeof payload.answer === 'string') return clip(payload.answer);
  if (payload.mode === 'deliverable' && typeof payload.submission === 'string') return clip(payload.submission);
  if (payload.mode === 'self_report' && Array.isArray(payload.confirmations)) {
    const done = payload.confirmations.filter(Boolean).length;
    return clip(`${done}/${payload.confirmations.length} point(s) déclaré(s)${payload.note ? ` — ${payload.note}` : ''}`);
  }
  return '';
}

/** History of one track, oldest first (the server already orders it). */
export function trackHistory(attempts: AttemptView[] | null | undefined, track: 'theory' | 'practice'): AttemptView[] {
  return (attempts ?? []).filter(a => a.track === track);
}

/** A module may be opened for reading once it is unlocked on at least one track; LOCKED modules stay closed. */
export function canViewModule(tracks: TeacherTracks | null | undefined): boolean {
  return !!tracks && (tracks.theory?.state !== 'LOCKED' || tracks.practice?.state !== 'LOCKED');
}
