// Professeur V2 (PROF-3) — THÉORIE | PRATIQUE lesson view for dual-track parcours (schema_version 2).
// Two independent tracks per module, each with its own state, evaluation and remediation. The "next module" control
// only reflects the server gate (POST /advance answers 409 TRACKS_NOT_PASSED until BOTH tracks are passed).
// V1 parcours never reach this component (TeacherModal keeps its historical LessonView for them).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, RefreshCw, BookOpen, Hammer, Lock } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type {
  DualTrackLearningPath, DualTrackLearningStep, TeacherTracks, TeacherVerdict, TeacherPracticeEvidence,
  TeacherPracticeMode, TeacherTrackState, TeacherAttemptView,
} from '../../lib/cortex/client';
import { MarkdownContent } from '../../lib/renderMd';
import { WorkoutView, CheckinFields, SportProgramDashboard } from './TeacherSportCoach';
import { defaultCheckinForm, buildCheckin, checkinSummary, sessionEquipment, type CheckinForm } from '../../lib/teacher/sport';
import type { SportSession, SportPathProfile, SportProgramWithState, SportLoopResult } from '../../lib/cortex/client';
import {
  dualTrackLayout, TRACK_STATE_LABELS, TRACK_STATE_COLORS, EVIDENCE_LABELS, PRACTICE_KIND_LABELS,
  allowedPracticeModes, canSubmitTrack, bothTracksPassed, shouldRequestPracticeSpec, verdictTone, advanceLabel,
  attemptStatus, ATTEMPT_STATUS_LABELS, submissionSummary, trackHistory, canViewModule,
} from '../../lib/teacher/dual-track';

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '8px 10px', fontSize: 13, width: '100%',
  fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
};
const btnStyle: React.CSSProperties = {
  background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)',
  borderRadius: 6, color: '#a78bfa', padding: '7px 14px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const btnGhostStyle: React.CSSProperties = {
  background: 'none', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6, color: '#94a3b8', padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 8, padding: 12,
};

type TrackName = 'theory' | 'practice';
type Refresh = (p: DualTrackLearningPath, s: DualTrackLearningStep[]) => void;

function StateBadge({ state, testId }: { state: TeacherTrackState; testId?: string }) {
  return (
    <span data-testid={testId} data-state={state} style={{
      fontSize: 10, fontFamily: 'monospace', letterSpacing: '0.05em', padding: '2px 8px', borderRadius: 999,
      color: TRACK_STATE_COLORS[state], border: `1px solid ${TRACK_STATE_COLORS[state]}55`, background: `${TRACK_STATE_COLORS[state]}14`,
    }}>
      {TRACK_STATE_LABELS[state]}
    </span>
  );
}

function VerdictView({ verdict, evidence }: { verdict: TeacherVerdict | null; evidence?: TeacherPracticeEvidence | null }) {
  const tone = verdictTone(verdict);
  if (!verdict || !tone) return null;
  const color = tone === 'passed' ? '#3dffaa' : tone === 'failed' ? '#ffb547' : '#ff4d58';
  const title = tone === 'passed' ? 'Validé' : tone === 'failed' ? 'Pas encore validé' : 'Évaluation inexploitable';
  return (
    <div data-testid="verdict" data-tone={tone} style={{ ...cardStyle, borderColor: `${color}44`, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong style={{ color, fontSize: 12 }}>{title}</strong>
        {tone !== 'invalid' && <span data-testid="verdict-score" style={{ fontSize: 11, color: '#94a3b8' }}>Score {verdict.score}/100</span>}
      </div>
      {verdict.criteria.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {verdict.criteria.map((c, i) => (
            <li key={i} data-testid="verdict-criterion" data-met={c.met ? 'true' : 'false'} style={{ fontSize: 12, color: '#cbd5e1' }}>
              <span style={{ color: c.met ? '#3dffaa' : '#ff4d58', marginRight: 6 }}>{c.met ? '✓' : '✗'}</span>
              {c.name}{c.comment ? <span style={{ color: '#64748b' }}> — {c.comment}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {verdict.feedback && <div style={{ fontSize: 12, color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>{verdict.feedback}</div>}
      {tone === 'failed' && verdict.remediation && (
        <div data-testid="remediation" data-source={verdict.remediation.source} style={{ borderLeft: '2px solid #ffb547', paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#e2e8f0' }}>
          <span><strong style={{ color: '#ffb547' }}>À retravailler :</strong> <span data-testid="remediation-focus">{verdict.remediation.focus}</span></span>
          <span><strong style={{ color: '#94a3b8' }}>Pourquoi :</strong> {verdict.remediation.why}</span>
          <span data-testid="remediation-retry"><strong style={{ color: '#a78bfa' }}>Nouvelle tentative :</strong> {verdict.remediation.retry}</span>
        </div>
      )}
      {verdict.inconsistent && (
        <div style={{ fontSize: 11, color: '#ffb547' }}>Le verdict du modèle était incohérent : il est compté comme non validé.</div>
      )}
      {tone === 'invalid' && (
        <div style={{ fontSize: 11, color: '#94a3b8' }}>Rien n'a été validé ni perdu — tu peux renvoyer ta réponse.</div>
      )}
      {evidence && (
        <div data-testid="evidence-label" data-evidence={evidence} style={{ fontSize: 11, color: evidence === 'SELF_REPORTED' ? '#ffb547' : '#94a3b8' }}>
          Provenance : {EVIDENCE_LABELS[evidence]}
        </div>
      )}
    </div>
  );
}

function formatDateTime(iso: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── Historique (PROF-4) ─────────────────────────────────────────────────────────────────────────────────────────────
const STATUS_COLORS = { passed: '#3dffaa', failed: '#ffb547', invalid: '#ff4d58', corrupted: '#64748b' } as const;

function HistoryList({ track, attempts, error }: { track: TrackName; attempts: TeacherAttemptView[] | null; error: string | null }) {
  const items = trackHistory(attempts, track);
  if (error) return <div data-testid={`history-${track}-error`} style={{ fontSize: 11, color: '#64748b' }}>Historique indisponible : {error}</div>;
  if (!attempts || items.length === 0) return null;
  return (
    <details data-testid={`history-${track}`} style={{ fontSize: 12, color: '#cbd5e1' }}>
      <summary style={{ cursor: 'pointer', color: '#94a3b8', fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.05em' }}>
        HISTORIQUE ({items.length} tentative{items.length > 1 ? 's' : ''})
      </summary>
      <ol style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(a => {
          const status = attemptStatus(a);
          return (
            <li key={a.id ?? `${track}-${a.index}`} data-testid="history-item" data-status={status} data-index={a.index}
              style={{ borderLeft: `2px solid ${STATUS_COLORS[status]}`, paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>
                #{a.index} · {a.created_at ? formatDateTime(a.created_at) : '—'} · <span style={{ color: STATUS_COLORS[status] }}>{ATTEMPT_STATUS_LABELS[status]}</span>
                {a.verdict && !a.verdict.invalid ? ` · ${a.verdict.score}/100` : ''}
                {a.evidence ? ` · ${EVIDENCE_LABELS[a.evidence]}` : ''}
              </span>
              {submissionSummary(a.payload) && <span data-testid="history-submission" style={{ color: '#cbd5e1' }}>« {submissionSummary(a.payload)} »</span>}
              {a.payload.checkin && <span data-testid="history-checkin" style={{ color: '#94a3b8' }}>{checkinSummary(a.payload.checkin)}</span>}
              {a.verdict?.feedback && <span style={{ color: '#94a3b8' }}>{a.verdict.feedback}</span>}
              {a.verdict?.remediation && <span style={{ color: '#ffb547' }}>À retravailler : {a.verdict.remediation.focus}</span>}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

// ── Théorie ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function TheoryPanel({ path, step, tracks, loadingExplain, onRefresh, readOnly, history, historyError }: {
  path: DualTrackLearningPath; step: DualTrackLearningStep; tracks: TeacherTracks; loadingExplain: boolean; onRefresh: Refresh;
  readOnly: boolean; history: TeacherAttemptView[] | null; historyError: string | null;
}) {
  const theory = tracks.theory;
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setAnswer(''); setError(null); }, [step.id]);

  async function submit() {
    if (!answer.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await cortexClient.submitTheoryAnswer(path.id, step.id, answer.trim());
      onRefresh(res.path, res.steps);
      if (res.evaluated) setAnswer('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section data-testid="track-theory" data-state={theory.state} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#e2e8f0', fontWeight: 600, letterSpacing: '0.06em' }}>
          <BookOpen size={14} color="#a78bfa" /> THÉORIE
        </span>
        <StateBadge state={theory.state} testId="theory-state" />
      </div>

      {theory.state === 'LOCKED' ? (
        <div style={{ ...cardStyle, fontSize: 12, color: '#64748b', display: 'flex', gap: 6, alignItems: 'center' }}><Lock size={12} /> Module pas encore débloqué.</div>
      ) : (
        <div data-testid="theory-content" style={{ ...cardStyle, fontSize: 13, color: '#e2e8f0', lineHeight: 1.6 }}>
          {loadingExplain
            ? <span style={{ color: '#64748b' }}>Génération de la leçon…</span>
            : step.content ? <MarkdownContent text={step.content} /> : <span style={{ color: '#64748b' }}>—</span>}
        </div>
      )}

      <VerdictView verdict={theory.lastVerdict} />

      {theory.state === 'PASSED' && (
        <div data-testid="theory-passed" style={{ fontSize: 12, color: '#3dffaa' }}>
          Théorie validée{theory.passedAt ? ` le ${formatDateTime(theory.passedAt)}` : ''} — acquise même si la pratique demande encore du travail.
        </div>
      )}

      {!readOnly && canSubmitTrack(theory.state) && step.content && !loadingExplain && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>{theory.state === 'REMEDIATION' ? 'NOUVELLE RÉPONSE (REMÉDIATION)' : 'TA RÉPONSE À LA QUESTION DE COMPRÉHENSION'}</span>
          <textarea
            data-testid="theory-answer"
            style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }}
            value={answer}
            maxLength={8000}
            onChange={e => setAnswer(e.target.value)}
            placeholder="Explique avec tes mots…"
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#64748b' }}>{theory.attempts > 0 ? `${theory.attempts} tentative(s)` : ''}</span>
            <button type="button" data-testid="theory-submit" style={btnStyle} onClick={() => void submit()} disabled={submitting || !answer.trim()}>
              {submitting ? <RefreshCw size={13} className="spin" /> : <Check size={13} />} Faire évaluer
            </button>
          </div>
        </div>
      )}
      {error && <div data-testid="theory-error" style={{ fontSize: 12, color: '#ff4d58' }}>{error}</div>}
      <HistoryList track="theory" attempts={history} error={historyError} />
    </section>
  );
}

// ── Pratique ────────────────────────────────────────────────────────────────────────────────────────────────────────
function PracticePanel({ path, step, tracks, specStatus, onRetrySpec, onRefresh, readOnly, history, historyError }: {
  path: DualTrackLearningPath; step: DualTrackLearningStep; tracks: TeacherTracks;
  specStatus: { loading: boolean; notice: string | null }; onRetrySpec: () => void; onRefresh: Refresh;
  readOnly: boolean; history: TeacherAttemptView[] | null; historyError: string | null;
}) {
  const practice = tracks.practice;
  const spec = practice.spec;
  const modes = allowedPracticeModes(spec);
  const checklist = spec?.checklist ?? [];
  const [mode, setMode] = useState<TeacherPracticeMode>(modes[0]);
  const [confirmations, setConfirmations] = useState<boolean[]>(() => checklist.map(() => false));
  const [note, setNote] = useState('');
  const [deliverable, setDeliverable] = useState('');
  const isWorkout = spec?.kind === 'workout';
  const [checkin, setCheckin] = useState<CheckinForm>(defaultCheckinForm);
  const [loopResult, setLoopResult] = useState<SportLoopResult['decision'] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const specKey = `${step.id}:${spec?.kind}:${checklist.join('|')}`;
  useEffect(() => {
    setMode(allowedPracticeModes(spec)[0]);
    setConfirmations(checklist.map(() => false));
    setNote(''); setDeliverable(''); setError(null); setCheckin(defaultCheckinForm());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      if (isWorkout) {
        // PROF-6: the session declaration carries its check-in; the server adapts the next sessions
        const res = await cortexClient.submitWorkout(path.id, step.id, { confirmations, ...(note.trim() ? { note: note.trim() } : {}), checkin: buildCheckin(checkin) });
        setLoopResult(res.sport?.decision ?? null);
        onRefresh(res.path, res.steps);
        return;
      }
      const res = mode === 'self_report'
        ? await cortexClient.submitPractice(path.id, step.id, { mode: 'self_report', confirmations, ...(note.trim() ? { note: note.trim() } : {}) })
        : await cortexClient.submitPractice(path.id, step.id, { mode: 'deliverable', submission: deliverable.trim() });
      onRefresh(res.path, res.steps);
      if (res.evaluated && mode === 'deliverable') setDeliverable('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = !readOnly && canSubmitTrack(practice.state) && !specStatus.loading;
  const ready = mode === 'self_report' ? confirmations.length > 0 : deliverable.trim().length > 0;

  return (
    <section data-testid="track-practice" data-state={practice.state} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#e2e8f0', fontWeight: 600, letterSpacing: '0.06em' }}>
          <Hammer size={14} color="#a78bfa" /> PRATIQUE
        </span>
        <StateBadge state={practice.state} testId="practice-state" />
      </div>

      {practice.state === 'LOCKED' ? (
        <div style={{ ...cardStyle, fontSize: 12, color: '#64748b', display: 'flex', gap: 6, alignItems: 'center' }}><Lock size={12} /> Module pas encore débloqué.</div>
      ) : (
        <div data-testid="practice-spec" data-kind={spec?.kind} data-generated={spec?.generated === false ? 'false' : 'true'} style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>{(PRACTICE_KIND_LABELS[spec?.kind ?? ''] ?? 'Mise en pratique').toUpperCase()}</span>
          {specStatus.loading
            ? <span data-testid="practice-spec-loading" style={{ fontSize: 12, color: '#64748b' }}>Préparation de l'exercice pratique…</span>
            : spec?.kind === 'workout' && (spec as { workout?: SportSession }).workout
              ? <WorkoutView workout={(spec as { workout?: SportSession }).workout as SportSession} />
              : <div style={{ fontSize: 13, color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>{spec?.instructions}</div>}
          {!specStatus.loading && (spec?.rubric?.length ?? 0) > 0 && (
            <div style={{ fontSize: 11, color: '#94a3b8' }}>Critères : {spec.rubric!.join(' · ')}</div>
          )}
          {specStatus.notice && (
            <div data-testid="spec-notice" style={{ fontSize: 11, color: '#ffb547', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {specStatus.notice}
              {!readOnly && shouldRequestPracticeSpec(tracks) && (
                <button type="button" data-testid="spec-retry" style={{ ...btnGhostStyle, padding: '2px 8px', fontSize: 11 }} onClick={onRetrySpec}>Réessayer</button>
              )}
            </div>
          )}
        </div>
      )}

      <VerdictView verdict={practice.lastVerdict} evidence={practice.lastVerdict ? practice.evidence : null} />

      {practice.state === 'PASSED' && (
        <div data-testid="practice-passed" style={{ fontSize: 12, color: '#3dffaa' }}>
          Pratique validée{practice.passedAt ? ` le ${formatDateTime(practice.passedAt)}` : ''}
          {practice.evidence ? ` — ${EVIDENCE_LABELS[practice.evidence]}` : ''}.
        </div>
      )}

      {canSubmit && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {modes.length > 1 && (
            <div role="radiogroup" aria-label="Façon de valider la pratique" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {modes.map(m => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} data-testid={`practice-mode-${m}`}
                  style={{ ...btnGhostStyle, ...(mode === m ? { color: '#a78bfa', borderColor: 'rgba(167,139,250,0.5)' } : {}) }}
                  onClick={() => setMode(m)}>
                  {m === 'self_report' ? 'Je l’ai fait (auto-déclaration)' : 'Je rends un livrable'}
                </button>
              ))}
            </div>
          )}

          {mode === 'self_report' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div data-testid="self-report-warning" style={{ fontSize: 11, color: '#ffb547' }}>
                Docteur ne peut pas observer cette réalisation : elle sera enregistrée comme « auto-déclarée », jamais comme vérifiée.
              </div>
              {checklist.map((item, i) => (
                <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: '#e2e8f0', cursor: 'pointer' }}>
                  <input type="checkbox" data-testid={`practice-check-${i}`} checked={confirmations[i] ?? false}
                    onChange={e => setConfirmations(c => c.map((v, j) => (j === i ? e.target.checked : v)))} style={{ marginTop: 2 }} />
                  {item}
                </label>
              ))}
              {isWorkout && <CheckinFields form={checkin} onChange={setCheckin} equipment={sessionEquipment((spec as { workout?: SportSession }).workout)} />}
              <input data-testid="practice-note" style={{ ...inputStyle, fontSize: 12 }} value={note} maxLength={2000}
                onChange={e => setNote(e.target.value)} placeholder="Note facultative (ce que tu as fait, difficultés…)" />
            </div>
          ) : (
            <textarea data-testid="practice-deliverable" style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={deliverable} maxLength={20000}
              onChange={e => setDeliverable(e.target.value)} placeholder="Colle ou décris ton livrable…" />
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#64748b' }}>{practice.attempts > 0 ? `${practice.attempts} tentative(s)` : ''}</span>
            <button type="button" data-testid="practice-submit" style={btnStyle} onClick={() => void submit()} disabled={submitting || !ready}>
              {submitting ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
              {mode === 'self_report' ? 'Enregistrer ma déclaration' : 'Faire évaluer le livrable'}
            </button>
          </div>
        </div>
      )}
      <div aria-live="polite">
        {loopResult && loopResult.kind !== 'none' && (
          <div data-testid="sport-loop-result" data-kind={loopResult.kind} data-rule={loopResult.rule}
            style={{ fontSize: 12, color: loopResult.kind === 'pause' ? '#ffb547' : '#cbd5e1', borderLeft: `2px solid ${loopResult.kind === 'pause' ? '#ffb547' : '#a78bfa'}`, paddingLeft: 8 }}>
            {loopResult.reason}
          </div>
        )}
      </div>
      {error && <div data-testid="practice-error" style={{ fontSize: 12, color: '#ff4d58' }}>{error}</div>}
      <HistoryList track="practice" attempts={history} error={historyError} />
    </section>
  );
}

// ── Vue module ──────────────────────────────────────────────────────────────────────────────────────────────────────
// `currentStep` is the server's pointer (current_step_index) — the only module that can be worked on. Any unlocked
// module can be OPENED for reading (PROF-4 navigation): viewing never calls a mutating endpoint, so it can never change
// a validation. `reviewOnly` (completed parcours) shows everything read-only.
export default function DualTrackLessonView({ path, steps, onRefresh, onFinished, reviewOnly = false }: {
  path: DualTrackLearningPath;
  steps: DualTrackLearningStep[];
  onRefresh: Refresh;
  onFinished: (p: DualTrackLearningPath, s: DualTrackLearningStep[]) => void;
  reviewOnly?: boolean;
}) {
  const currentStep = steps.find(s => s.step_index === path.current_step_index) ?? steps[0];
  const [viewStepId, setViewStepId] = useState<string | null>(null);
  const shownStep = (viewStepId ? steps.find(s => s.id === viewStepId) : null) ?? currentStep;
  const tracks = (shownStep?.tracks ?? null) as TeacherTracks | null;
  const currentTracks = (currentStep?.tracks ?? null) as TeacherTracks | null;
  const readOnly = reviewOnly || !!(shownStep && currentStep && shownStep.id !== currentStep.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tab, setTab] = useState<TrackName>('theory');
  const [loadingExplain, setLoadingExplain] = useState(false);
  const [specStatus, setSpecStatus] = useState<{ loading: boolean; notice: string | null }>({ loading: false, notice: null });
  const [error, setError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<{ stepId: string; attempts: TeacherAttemptView[] | null; error: string | null } | null>(null);
  const specRequested = useRef(new Set<string>());
  const latest = useRef({ path, steps });
  latest.current = { path, steps };
  const currentStepId = useRef<string | undefined>(currentStep?.id);
  currentStepId.current = currentStep?.id;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout = dualTrackLayout(width);

  const replaceStep = useCallback((step: DualTrackLearningStep) => {
    const { path: p, steps: s } = latest.current;
    onRefresh(p, s.map(x => (x.id === step.id ? { ...x, ...step } : x)));
  }, [onRefresh]);

  const loadExplanation = useCallback(async (stepId: string) => {
    setLoadingExplain(true);
    setError(null);
    setFallbackNotice(null);
    try {
      const res = await cortexClient.explainStep(path.id, stepId);
      if (res.requested_provider && res.requested_provider !== 'local' && res.model_used?.startsWith('local/')) {
        setFallbackNotice(`Provider demandé : ${res.requested_provider} · utilisé : Ollama (local)${res.fallback_reason ? ` — ${res.fallback_reason}` : ''}`);
      }
      replaceStep(res.step as DualTrackLearningStep);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingExplain(false);
    }
  }, [path.id, replaceStep]);

  const requestSpec = useCallback(async (stepId: string) => {
    setSpecStatus({ loading: true, notice: null });
    try {
      const res = await cortexClient.generatePracticeSpec(path.id, stepId);
      if (currentStepId.current !== stepId) return;
      onRefresh(res.path, res.steps);
      setSpecStatus({ loading: false, notice: res.generated ? null : 'Exercice générique : la génération personnalisée n’a pas abouti. Tu peux pratiquer avec celui-ci ou réessayer.' });
    } catch (err) {
      if (currentStepId.current !== stepId) return;
      setSpecStatus({ loading: false, notice: `Exercice générique (génération indisponible : ${(err as Error).message}).` });
    }
  }, [path.id, onRefresh]);

  // Current module only: lesson first (theory), then the module's practical exercise — sequential, so the exercise
  // can build on the lesson. Never for a read-only review.
  useEffect(() => {
    setSpecStatus({ loading: false, notice: null });
    setError(null);
    setViewStepId(null);
    if (reviewOnly || !currentStep || !currentTracks) return;
    let cancelled = false;
    void (async () => {
      if (currentTracks.theory.state !== 'LOCKED' && !currentStep.content) await loadExplanation(currentStep.id);
      if (cancelled || !shouldRequestPracticeSpec(currentTracks) || specRequested.current.has(currentStep.id)) return;
      specRequested.current.add(currentStep.id);
      await requestSpec(currentStep.id);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id]);

  // PROF-4 history of the shown module, re-read after every new attempt (attempt counters change).
  const attemptsKey = `${shownStep?.id}:${tracks?.theory.attempts ?? 0}:${tracks?.practice.attempts ?? 0}`;
  useEffect(() => {
    const stepId = shownStep?.id;
    if (!stepId) return;
    let cancelled = false;
    cortexClient.getTrackHistory(path.id, stepId)
      .then(res => { if (!cancelled) setHistory({ stepId, attempts: res.attempts ?? [], error: null }); })
      .catch(err => { if (!cancelled) setHistory({ stepId, attempts: null, error: (err as Error).message }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptsKey, path.id]);
  const shownHistory = history && history.stepId === shownStep?.id ? history : null;

  if (!shownStep || !tracks || !currentStep) return <div style={{ color: '#64748b', fontSize: 12 }}>Aucun module.</div>;

  const sportPaused = path.mode === 'sport' && !!(path.profile as (SportPathProfile & { program: SportProgramWithState }) | null)?.program?.pause;
  const passed = bothTracksPassed(currentTracks) && !sportPaused;
  const isLast = currentStep.step_index === steps.length - 1;

  async function handleAdvance() {
    setAdvancing(true);
    setError(null);
    try {
      const res = await cortexClient.advanceDualTrackStep(path.id, currentStep.id);
      if (res.finished) onFinished(res.path, res.steps);
      else { setTab('theory'); onRefresh(res.path, res.steps); }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdvancing(false);
    }
  }

  async function handleBack() {
    setError(null);
    try {
      const res = await cortexClient.backStep(path.id, currentStep.id);
      onRefresh(res.path as DualTrackLearningPath, res.steps as DualTrackLearningStep[]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const historyProps = { history: shownHistory?.attempts ?? null, historyError: shownHistory?.error ?? null };
  const theoryPanel = (
    <TheoryPanel path={path} step={shownStep} tracks={tracks} loadingExplain={loadingExplain && !readOnly} onRefresh={onRefresh}
      readOnly={readOnly} {...historyProps} />
  );
  const practicePanel = (
    <PracticePanel path={path} step={shownStep} tracks={tracks} specStatus={readOnly ? { loading: false, notice: null } : specStatus}
      onRetrySpec={() => void requestSpec(currentStep.id)} onRefresh={onRefresh} readOnly={readOnly} {...historyProps} />
  );

  return (
    <div ref={containerRef} data-testid="teacher-v2-lesson" data-layout={layout} data-read-only={readOnly ? 'true' : 'false'} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div data-testid="module-title" style={{ fontSize: 13, color: '#e2e8f0' }}>
          Module {shownStep.step_index + 1} / {steps.length} — <strong>{shownStep.title}</strong>
        </div>
        {!reviewOnly && (
          <button type="button" style={btnGhostStyle} onClick={() => void handleBack()} disabled={readOnly || currentStep.step_index === 0}>
            <ArrowLeft size={12} /> Module précédent
          </button>
        )}
      </div>

      {path.mode === 'sport' && <SportProgramDashboard path={path} steps={steps} onRefresh={onRefresh} readOnly={reviewOnly} />}

      <div data-testid="module-stepper" role="list" aria-label="Modules du parcours" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {steps.map(s => {
          const t = s.tracks as TeacherTracks | null;
          const shown = s.id === shownStep.id;
          const viewable = canViewModule(t);
          return (
            <button key={s.id} type="button" role="listitem" data-testid="module-pill" data-step-index={s.step_index}
              data-theory={t?.theory.state} data-practice={t?.practice.state} data-current={s.id === currentStep.id ? 'true' : 'false'}
              aria-current={shown ? 'step' : undefined} disabled={!viewable}
              onClick={() => setViewStepId(s.id === currentStep.id ? null : s.id)}
              title={`${s.title} — théorie : ${t ? TRACK_STATE_LABELS[t.theory.state] : '?'} · pratique : ${t ? TRACK_STATE_LABELS[t.practice.state] : '?'}${viewable ? '' : ' (verrouillé)'}`}
              style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 6px', borderRadius: 4, background: 'none', cursor: viewable ? 'pointer' : 'not-allowed',
                border: `1px solid ${shown ? '#a78bfa' : 'rgba(255,255,255,0.08)'}`, color: '#94a3b8', opacity: viewable ? 1 : 0.5 }}>
              {s.step_index + 1}
              <span style={{ color: t ? TRACK_STATE_COLORS[t.theory.state] : '#64748b', marginLeft: 4 }}>T</span>
              <span style={{ color: t ? TRACK_STATE_COLORS[t.practice.state] : '#64748b', marginLeft: 2 }}>P</span>
            </button>
          );
        })}
      </div>

      {readOnly && !reviewOnly && (
        <div data-testid="review-banner" style={{ fontSize: 12, color: '#94a3b8', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          Consultation du module {shownStep.step_index + 1} (lecture seule — ses validations ne changent pas).
          <button type="button" data-testid="back-to-current" style={{ ...btnGhostStyle, padding: '3px 8px' }} onClick={() => setViewStepId(null)}>
            Revenir au module en cours
          </button>
        </div>
      )}
      {reviewOnly && (
        <div data-testid="review-banner" style={{ fontSize: 12, color: '#94a3b8' }}>Parcours terminé — consultation des modules en lecture seule.</div>
      )}

      {layout === 'columns' ? (
        <div data-testid="dual-track-columns" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14, alignItems: 'start' }}>
          <div style={{ ...cardStyle, background: 'rgba(255,255,255,0.015)' }}>{theoryPanel}</div>
          <div style={{ ...cardStyle, background: 'rgba(255,255,255,0.015)' }}>{practicePanel}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div role="tablist" aria-label="Voies du module" style={{ display: 'flex', gap: 6 }}>
            {(['theory', 'practice'] as const).map(name => (
              <button key={name} type="button" role="tab" aria-selected={tab === name} data-testid={`tab-${name}`}
                style={{ ...btnGhostStyle, flex: 1, justifyContent: 'center', ...(tab === name ? { color: '#a78bfa', borderColor: 'rgba(167,139,250,0.5)' } : {}) }}
                onClick={() => setTab(name)}>
                {name === 'theory' ? 'Théorie' : 'Pratique'}
                <StateBadge state={tracks[name].state} />
              </button>
            ))}
          </div>
          <div style={{ ...cardStyle, background: 'rgba(255,255,255,0.015)' }}>{tab === 'theory' ? theoryPanel : practicePanel}</div>
        </div>
      )}

      {fallbackNotice && !readOnly && <div style={{ fontSize: 11, color: '#f59e0b' }}>{fallbackNotice}</div>}

      {!readOnly && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span data-testid="gate-hint" style={{ fontSize: 11, color: passed ? '#3dffaa' : '#64748b' }}>
            {sportPaused ? 'Programme en pause : la séance suivante attend ta reprise.' : passed ? 'Théorie et pratique validées.' : 'Le module suivant se débloque quand la théorie ET la pratique sont validées.'}
          </span>
          <button type="button" data-testid="advance-button" style={{ ...btnStyle, opacity: passed ? 1 : 0.5 }} onClick={() => void handleAdvance()} disabled={!passed || advancing}>
            {advancing ? <RefreshCw size={13} className="spin" /> : <ArrowRight size={13} />} {advanceLabel({ passed, isLast })}
          </button>
        </div>
      )}
      {error && <div data-testid="lesson-error" style={{ fontSize: 12, color: '#ff4d58' }}>{error}</div>}
    </div>
  );
}
