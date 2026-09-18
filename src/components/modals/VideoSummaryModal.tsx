import { useCallback, useEffect, useRef, useState } from 'react';
import { isTerminalVideoStatus, startJobPolling, startVideoJobPolling } from '../../lib/video-job-polling';
import {
  Clapperboard, X, ChevronLeft, Minimize2, AlertTriangle, CheckCircle,
  RotateCcw, Ban, HardDrive, Clock, History, RefreshCw, Play, Square, Film, Lock,
} from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type {
  VideoEstimate, VideoJob, VideoJobDetail,
  OpenMontageCapabilities, OpenMontageJob,
} from '../../lib/cortex/client';
import OpenMontageFormat, { OPENMONTAGE_FORMAT } from '../studio/OpenMontageFormat';
import OpenMontageOutput from '../studio/OpenMontageOutput';
import { useStudioDialog } from '../../hooks/useStudioDialog';
import { studioRequestError } from '../../lib/studio-errors';

interface Props {
  onClose:          () => void;
  onMinimize?:      () => void;
  strictLocalMode:  boolean;
  // Called when a job finishes — caller reloads its neuron list.
  onDone?:          () => void;
  /** Which tab to land on — 'render' for the "Nouveau rendu vidéo" quick
   * action, defaults to the transcription form otherwise. */
  initialView?:     'form' | 'render';
}

// Phase UX-6: 'render' is a new tab exposing the real MP4-producing system
// (previously only reachable via Settings, under a mismatched Dashboard
// badge — see reports/STUDIOS_UX_V2_2026-09.md, GAP 5). The transcription
// views (form/progress/history) and their polling below are UNCHANGED from
// before this pass — this Studio now honestly presents both as two distinct
// capabilities instead of conflating them under one ambiguous entry point.
type View = 'form' | 'progress' | 'history' | 'render';

const OM_STATUS_LABELS: Record<string, string> = {
  NOT_INSTALLED: 'Non installé',
  PARTIAL: 'Installation partielle',
  READY_LOCAL: 'Prêt (local)',
  BUSY: 'Occupé',
  ERROR: 'Erreur',
};

const RESUME_TYPES = [
  { value: 'auto',      label: 'Automatique (recherche du style le plus proche)' },
  { value: 'educatif',  label: 'Éducatif' },
  { value: 'interview', label: 'Interview' },
  { value: 'podcast',   label: 'Podcast' },
  { value: 'rediff',    label: 'Rediff / stream' },
];

const WHISPER_PROVIDERS = [
  { value: 'auto',  label: 'Auto (Groq si disponible, sinon local)' },
  { value: 'groq',  label: 'Groq (cloud, rapide, quota limité)' },
  { value: 'local', label: 'Whisper local (lent, illimité, privé)' },
];

const SYNTHESIS_PROVIDERS = [
  { value: 'local',  label: 'Local (gratuit, privé)' },
  { value: 'groq',   label: 'Groq (cloud)' },
  { value: 'gemini', label: 'Gemini (cloud)' },
];

const STEP_LABELS: Record<string, string> = {
  pending:      'En attente',
  estimating:   'Estimation…',
  downloading:  'Téléchargement audio…',
  chunking:     'Découpage audio…',
  transcribing: 'Transcription…',
  summarizing:  'Résumé des segments…',
  synthesizing: 'Synthèse finale…',
  done:         'Terminé',
  error:        'Erreur',
  cancelled:    'Annulé',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} Mo`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} Go`;
}

export default function VideoSummaryModal({ onClose, onMinimize, strictLocalMode, onDone, initialView = 'form' }: Props) {
  const dialogRef = useStudioDialog(onClose);
  const [view, setView]           = useState<View>(initialView);
  const [url, setUrl]             = useState('');
  const [estimate, setEstimate]   = useState<VideoEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateErr, setEstimateErr] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);

  const [resumeType, setResumeType]         = useState('auto');
  const [whisperProvider, setWhisperProvider] = useState('auto');
  const [synthesisProvider, setSynthesisProvider] = useState('local');
  const [isPrivate, setIsPrivate]           = useState(false);
  const [launching, setLaunching]           = useState(false);
  const [launchErr, setLaunchErr]           = useState<string | null>(null);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [detail, setDetail]           = useState<VideoJobDetail | null>(null);
  const [history, setHistory]         = useState<VideoJob[]>([]);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const [pollGeneration, setPollGeneration] = useState(0);

  // ── Render view state (Phase UX-6) — entirely separate from the
  // transcription state/polling above; the two systems share nothing
  // server-side (see reports/STUDIOS_UX_V2_2026-09.md, GAP 5). ──
  const [omCapabilities, setOmCapabilities] = useState<OpenMontageCapabilities | null>(null);
  const [omLoading, setOmLoading] = useState(true);
  const [omError, setOmError] = useState<string | null>(null);
  const [omTitle, setOmTitle] = useState('DOCTEUR');
  const [omSubtitle, setOmSubtitle] = useState('Local Video Pipeline');
  const [omDurationSeconds, setOmDurationSeconds] = useState(6);
  const [omJob, setOmJob] = useState<OpenMontageJob | null>(null);
  const [omRenderError, setOmRenderError] = useState<string | null>(null);
  const [omSubmitting, setOmSubmitting] = useState(false);
  const omSubmittingRef = useRef(false);
  const omStopPollingRef = useRef<(() => void) | null>(null);

  const reloadOmCapabilities = useCallback(async () => {
    try {
      const caps = await cortexClient.getOpenMontageCapabilities();
      setOmCapabilities(caps);
      setOmError(null);
    } catch (e) {
      setOmError(studioRequestError(e));
    } finally {
      setOmLoading(false);
    }
  }, []);

  useEffect(() => { if (view === 'render' && !omCapabilities) void reloadOmCapabilities(); }, [view, omCapabilities, reloadOmCapabilities]);
  useEffect(() => () => { omStopPollingRef.current?.(); }, []);

  const startOmRender = useCallback(async () => {
    if (omSubmittingRef.current) return;
    omSubmittingRef.current = true; setOmSubmitting(true);
    setOmRenderError(null);
    try {
      const { jobId } = await cortexClient.startOpenMontageRender({ title: omTitle, subtitle: omSubtitle, ...OPENMONTAGE_FORMAT, durationSeconds: omDurationSeconds });
      omStopPollingRef.current?.();
      omStopPollingRef.current = startJobPolling(
        () => cortexClient.getOpenMontageJob(jobId),
        d => d.status,
        d => setOmJob(d),
        () => { void reloadOmCapabilities(); },
      );
    } catch (e) {
      setOmRenderError(studioRequestError(e));
    } finally {
      omSubmittingRef.current = false; setOmSubmitting(false);
    }
  }, [omTitle, omSubtitle, omDurationSeconds, reloadOmCapabilities]);

  const cancelOmRender = useCallback(async () => {
    if (!omJob) return;
    try { await cortexClient.cancelOpenMontageJob(omJob.jobId); } catch { setOmRenderError('Annulation non confirmée. Réessayez.'); }
  }, [omJob]);

  const resetOmRender = useCallback(() => {
    omStopPollingRef.current?.();
    omStopPollingRef.current = null;
    setOmJob(null);
    setOmRenderError(null);
  }, []);

  const cloudForcedLocal = strictLocalMode || isPrivate;


  // Resume watching an already-running job, if any, when the modal opens.
  useEffect(() => {
    let disposed = false;
    cortexClient.listVideoSummaryJobs().then(jobs => {
      if (disposed) return;
      setHistory(jobs);
      const active = jobs.find(j => !isTerminalVideoStatus(j.status));
      if (active) {
        setActiveJobId(active.id);
        setView('progress');
      }
    }).catch(() => { /* history is best-effort */ });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (view !== 'progress' || !activeJobId) return;
    return startVideoJobPolling(
      () => cortexClient.getVideoSummaryJob(activeJobId),
      setDetail,
      () => onDoneRef.current?.(),
    );
  }, [view, activeJobId, pollGeneration]);

  async function handleEstimate() {
    if (!url.trim()) return;
    setEstimating(true);
    setEstimateErr(null);
    setEstimate(null);
    setNeedsConfirm(false);
    try {
      const est = await cortexClient.estimateVideoSummary(url.trim());
      setEstimate(est);
      setNeedsConfirm(est.requires_confirmation);
      if (!est.groq_available && whisperProvider === 'groq') setWhisperProvider('auto');
    } catch (e) {
      setEstimateErr(e instanceof Error ? e.message : 'Estimation impossible');
    } finally {
      setEstimating(false);
    }
  }

  async function handleLaunch() {
    if (!estimate?.ok) return;
    if (needsConfirm) { setNeedsConfirm(false); return; } // require explicit second click via confirm button below
    setLaunching(true);
    setLaunchErr(null);
    try {
      const { jobId } = await cortexClient.createVideoSummaryJob({
        url: url.trim(),
        resumeType,
        whisperProvider,
        synthesisProvider: cloudForcedLocal ? 'local' : synthesisProvider,
        private: isPrivate,
        duration_s: estimate.duration_s,
      });
      setActiveJobId(jobId);
      setDetail(null);
      setView('progress');
    } catch (e) {
      setLaunchErr(e instanceof Error ? e.message : 'Lancement impossible');
    } finally {
      setLaunching(false);
    }
  }

  async function handleCancel() {
    if (!activeJobId) return;
    try { await cortexClient.cancelVideoSummaryJob(activeJobId); } catch { /* best effort */ }
  }

  async function handleResume(jobId: string) {
    try {
      await cortexClient.resumeVideoSummaryJob(jobId);
      setPollGeneration(n => n + 1);
      setActiveJobId(jobId);
      setDetail(null);
      setView('progress');
    } catch (e) {
      setLaunchErr(e instanceof Error ? e.message : 'Reprise impossible');
    }
  }

  async function loadHistory() {
    try { setHistory(await cortexClient.listVideoSummaryJobs()); } catch { /* ignore */ }
    setView('history');
  }

  const modalStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
  };
  const panelStyle: React.CSSProperties = {
    width: 'min(760px, calc(100vw - 24px))', maxHeight: '90vh', display: 'flex', flexDirection: 'column',
    background: '#0d0f14', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
  };
  const inputStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6, color: '#e2e8f0', padding: '7px 10px', fontSize: 13, width: '100%',
    fontFamily: 'inherit', outline: 'none',
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
  const sectionStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 };

  function renderHeader(title: string, showBack = false, backFn?: () => void) {
    return (
      <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
        {showBack && (
          <button type="button" aria-label="Retour" onClick={backFn} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c084fc', display: 'flex', padding: 2 }}>
            <ChevronLeft size={14} />
          </button>
        )}
        <Clapperboard size={14} style={{ color: '#c084fc', flexShrink: 0 }} />
        <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#e2e8f0', fontWeight: 600, flex: 1 }}>{title}</span>
        {view === 'progress' && onMinimize && (
          <button
            type="button" onClick={onMinimize} title="Réduire (continuer à utiliser Docteur)"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, cursor: 'pointer', color: '#c0b0e0', padding: '3px 8px', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <Minimize2 size={10} /> Réduire
          </button>
        )}
        {(view === 'form' || view === 'render') && (
          <button type="button" onClick={loadHistory} title="Historique" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', display: 'flex' }}>
            <History size={14} />
          </button>
        )}
        <button type="button" aria-label="Fermer Studio Vidéo" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', display: 'flex' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  // Two honestly-distinct capabilities (transcription→text vs. real MP4
  // render — see module header comment) presented as tabs instead of one
  // ambiguous entry point (Phase UX-6).
  function renderModeTabs() {
    return (
      <div style={{ display: 'flex', gap: 4, padding: '10px 20px 0' }}>
        <button
          type="button" onClick={() => setView('form')}
          style={{ flex: 1, padding: '7px 0', fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.04em', cursor: 'pointer', borderRadius: '6px 6px 0 0', border: 'none', borderBottom: view === 'form' ? '2px solid #c084fc' : '2px solid transparent', background: 'none', color: view === 'form' ? '#c084fc' : '#64748b' }}
        >
          TRANSCRIPTION
        </button>
        <button
          type="button" onClick={() => setView('render')}
          style={{ flex: 1, padding: '7px 0', fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.04em', cursor: 'pointer', borderRadius: '6px 6px 0 0', border: 'none', borderBottom: view === 'render' ? '2px solid #a78bfa' : '2px solid transparent', background: 'none', color: view === 'render' ? '#a78bfa' : '#64748b' }}
        >
          RENDU (MP4)
        </button>
      </div>
    );
  }

  // ── Form view ──────────────────────────────────────────────────────────────
  function renderForm() {
    return (
      <>
        {renderHeader('STUDIO VIDÉO')}
        {renderModeTabs()}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          <div style={sectionStyle}>
            <label style={labelStyle}>LIEN DE LA VIDÉO</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={inputStyle} value={url} placeholder="https://..."
                onChange={e => { setUrl(e.target.value); setEstimate(null); setNeedsConfirm(false); }}
                onKeyDown={e => { if (e.key === 'Enter') void handleEstimate(); }}
              />
              <button
                type="button" onClick={() => void handleEstimate()} disabled={!url.trim() || estimating}
                style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid rgba(192,132,252,0.3)', background: 'rgba(192,132,252,0.1)', color: '#c084fc', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {estimating ? 'Analyse…' : 'Estimer'}
              </button>
            </div>
            {estimateErr && <span style={{ fontSize: 11, color: '#ff4d58', marginTop: 4 }}>{estimateErr}</span>}
          </div>

          {estimate?.ok && (
            <div style={{ padding: '12px 14px', marginBottom: 14, borderRadius: 8, background: 'rgba(192,132,252,0.06)', border: '1px solid rgba(192,132,252,0.15)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12, color: '#c0b0e0' }}>
                <div>Durée : <b style={{ color: '#e2e8f0' }}>{estimate.duration_label}</b></div>
                <div>Segments estimés : <b style={{ color: '#e2e8f0' }}>{estimate.chunk_count_estimate}</b></div>
                <div>Transcription locale : <b style={{ color: '#e2e8f0' }}>~{estimate.transcription_minutes_local} min</b></div>
                <div>Transcription Groq : <b style={{ color: '#e2e8f0' }}>{estimate.groq_available ? `~${estimate.transcription_minutes_groq} min` : 'indisponible'}</b></div>
                <div>Résumé des segments : <b style={{ color: '#e2e8f0' }}>~{estimate.summarization_minutes_estimate} min</b></div>
                <div>Total estimé (local) : <b style={{ color: '#e2e8f0' }}>~{(estimate.total_minutes_estimate_local / 60).toFixed(1)} h</b></div>
              </div>
              {estimate.confirmation_message && (
                <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <AlertTriangle size={14} style={{ color: '#fbbf24', flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 12, color: '#fde68a' }}>{estimate.confirmation_message}</span>
                </div>
              )}
            </div>
          )}

          <div style={sectionStyle}>
            <label style={labelStyle}>TYPE DE RÉSUMÉ</label>
            <select value={resumeType} onChange={e => setResumeType(e.target.value)} style={inputStyle}>
              {RESUME_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <span style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
              Sert à choisir les exemples de style ("exemple-resume") les plus proches lors de la synthèse.
            </span>
          </div>

          <div style={sectionStyle}>
            <label style={labelStyle}>TRANSCRIPTION</label>
            <select value={whisperProvider} onChange={e => setWhisperProvider(e.target.value)} style={inputStyle}>
              {WHISPER_PROVIDERS.map(t => (
                <option key={t.value} value={t.value} disabled={t.value === 'groq' && estimate ? !estimate.groq_available : false}>{t.label}</option>
              ))}
            </select>
          </div>

          <div style={sectionStyle}>
            <label style={labelStyle}>SYNTHÈSE FINALE</label>
            <select
              value={cloudForcedLocal ? 'local' : synthesisProvider}
              onChange={e => setSynthesisProvider(e.target.value)}
              disabled={cloudForcedLocal}
              style={{ ...inputStyle, opacity: cloudForcedLocal ? 0.6 : 1 }}
            >
              {SYNTHESIS_PROVIDERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {cloudForcedLocal && (
              <span style={{ fontSize: 11, color: '#fbbf24', marginTop: 2 }}>
                {strictLocalMode ? 'Mode strictement local activé — cloud indisponible.' : 'Neurone marqué privé — synthèse forcée en local.'}
              </span>
            )}
            {!cloudForcedLocal && synthesisProvider !== 'local' && (
              <span style={{ fontSize: 11, color: '#fbbf24', marginTop: 2, display: 'flex', gap: 4, alignItems: 'flex-start' }}>
                <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                Le contenu de la vidéo (résumés intermédiaires) quittera la machine pour la synthèse finale.
              </span>
            )}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#94a3b8', cursor: 'pointer', marginBottom: 4 }}>
            <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} />
            Neurone privé (jamais envoyé au cloud, synthèse forcée en local)
          </label>

          {launchErr && <div style={{ fontSize: 12, color: '#ff4d58', marginTop: 8 }}>{launchErr}</div>}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'none', color: '#94a3b8', fontSize: 12, cursor: 'pointer' }}>
            Annuler
          </button>
          {needsConfirm ? (
            <button
              type="button" onClick={() => void handleLaunch()} disabled={launching}
              style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.12)', color: '#fbbf24', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
            >
              Confirmer et lancer quand même
            </button>
          ) : (
            <button
              type="button" onClick={() => void handleLaunch()} disabled={!estimate?.ok || launching}
              style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid rgba(192,132,252,0.4)', background: 'rgba(192,132,252,0.15)', color: '#c084fc', fontSize: 12, cursor: 'pointer', fontWeight: 600, opacity: (!estimate?.ok || launching) ? 0.5 : 1 }}
            >
              {launching ? 'Lancement…' : 'Lancer le résumé'}
            </button>
          )}
        </div>
      </>
    );
  }

  // ── Progress view ──────────────────────────────────────────────────────────
  function renderProgress() {
    const job = detail?.job;
    const segments = detail?.segments ?? [];
    const total = segments.length;
    const transcribedDone = segments.filter(s => s.transcript_status === 'done').length;
    const summarizedDone  = segments.filter(s => s.summary_status === 'done').length;
    const failed = segments.filter(s => s.transcript_status === 'error' || s.summary_status === 'error').length;
    const finished = job && isTerminalVideoStatus(job.status);

    return (
      <>
        {renderHeader('RÉSUMÉ EN COURS', true, () => setView('form'))}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {!job && <div style={{ fontSize: 12, color: '#64748b' }}>Chargement…</div>}
          {job && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div className="animate-pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: finished ? (job.status === 'error' ? '#ff4d58' : '#3dffaa') : '#c084fc', flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600 }}>{STEP_LABELS[job.status] ?? job.status}</span>
              </div>

              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{job.current_step}</div>

              {total > 0 && (
                <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#c0b0e0', marginBottom: 14 }}>
                  Transcription {transcribedDone}/{total} segments · Résumés {summarizedDone}/{total} · Synthèse {
                    job.status === 'synthesizing' ? 'en cours…' : job.status === 'done' ? 'terminée' : 'en attente'
                  }
                </div>
              )}

              {failed > 0 && (
                <div style={{ fontSize: 11, color: '#fbbf24', marginBottom: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <AlertTriangle size={12} /> {failed} segment(s) en échec — le reste continue, ils seront mentionnés dans le récapitulatif final.
                </div>
              )}

              {job.disk_bytes > 0 && (
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <HardDrive size={12} /> Disque utilisé : {formatBytes(job.disk_bytes)}
                </div>
              )}

              {job.status === 'error' && (
                <div style={{ fontSize: 12, color: '#ff4d58', marginBottom: 10 }}>{job.error_message}</div>
              )}

              {job.status === 'done' && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#3dffaa', marginBottom: 10 }}>
                  <CheckCircle size={14} /> Synthèse créée{job.neuron_id ? ' — disponible dans tes neurones.' : '.'}
                </div>
              )}

              {job.status === 'cancelled' && (
                <div style={{ fontSize: 12, color: '#fbbf24', marginBottom: 10 }}>
                  Annulé — le travail déjà effectué a été conservé. Tu peux reprendre depuis l'historique.
                </div>
              )}
            </>
          )}
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {!finished && (
            <button
              type="button" onClick={() => void handleCancel()}
              style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid rgba(255,77,88,0.3)', background: 'rgba(255,77,88,0.08)', color: '#ff8a90', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <Ban size={12} /> Annuler (garder le travail effectué)
            </button>
          )}
          <button type="button" onClick={onClose} style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'none', color: '#94a3b8', fontSize: 12, cursor: 'pointer' }}>
            Fermer
          </button>
        </div>
      </>
    );
  }

  // ── History view ────────────────────────────────────────────────────────────
  function renderHistory() {
    return (
      <>
        {renderHeader('HISTORIQUE', true, () => setView('form'))}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          {history.length === 0 && <div style={{ fontSize: 12, color: '#64748b' }}>Aucun résumé de vidéo lancé.</div>}
          {history.map(j => (
            <div key={j.id} style={{ padding: '10px 12px', marginBottom: 8, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 12, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{j.title || j.url}</div>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: j.status === 'done' ? '#3dffaa' : j.status === 'error' ? '#ff4d58' : '#c084fc' }}>{STEP_LABELS[j.status] ?? j.status}</span>
              </div>
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 4, display: 'flex', gap: 10 }}>
                <span><Clock size={10} style={{ verticalAlign: -1 }} /> {new Date(j.created_at).toLocaleString('fr-FR')}</span>
                {j.disk_bytes > 0 && <span>{formatBytes(j.disk_bytes)}</span>}
              </div>
              {!['done'].includes(j.status) && (
                <button
                  type="button"
                  onClick={() => void handleResume(j.id)}
                  style={{ marginTop: 8, padding: '4px 10px', borderRadius: 5, border: '1px solid rgba(192,132,252,0.3)', background: 'rgba(192,132,252,0.1)', color: '#c084fc', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <RotateCcw size={10} /> Reprendre
                </button>
              )}
            </div>
          ))}
        </div>
      </>
    );
  }

  // ── Render view (Phase UX-6) — the real MP4-producing system, previously
  // only reachable via Settings under an unrelated Dashboard status badge.
  // Ported from OpenMontageSettingsTab.tsx with the same backend contract
  // (one fixed Remotion template, 3-10s, 1920x1080 at 30fps) — no
  // new capability, only a proper entry point. ──
  function renderRender() {
    const cardStyle: React.CSSProperties = { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 };
    const omBtnStyle: React.CSSProperties = { background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 6, color: '#a78bfa', padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6 };
    const omBtnDangerStyle: React.CSSProperties = { background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 6, color: '#f87171', padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6 };
    const omLabelStyle: React.CSSProperties = { fontFamily: 'monospace', fontSize: 10, color: '#5a4a7a', letterSpacing: '0.08em' };
    const status = omCapabilities?.status ?? 'ERROR';
    const isRunning = omJob?.status === 'running';
    const elapsedSeconds = omJob ? Math.round(omJob.elapsedMs / 1000) : 0;

    return (
      <>
        {renderHeader('STUDIO VIDÉO')}
        {renderModeTabs()}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Film size={14} style={{ color: '#a78bfa' }} />
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0' }}>OpenMontage — rendu vidéo local</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Lock size={11} style={{ color: '#3dffaa' }} />
                <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#3dffaa', letterSpacing: '0.08em' }}>LOCAL</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={omLabelStyle}>État :</span>
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: status === 'READY_LOCAL' ? '#3dffaa' : status === 'ERROR' ? '#f87171' : '#facc15' }}>
                {OM_STATUS_LABELS[status] ?? status}
              </span>
              <button type="button" style={{ ...omBtnStyle, padding: '4px 8px', marginLeft: 'auto' }} onClick={() => void reloadOmCapabilities()}>
                <RefreshCw size={11} /> Vérifier
              </button>
            </div>
            {omError && <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#f87171' }}>{omError}</div>}
            {omCapabilities && status !== 'READY_LOCAL' && (
              <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#5a4a7a' }}>
                Python: {omCapabilities.python.available ? 'OK' : 'manquant'} · FFmpeg: {omCapabilities.ffmpeg.available ? 'OK' : 'manquant'} · Remotion: {omCapabilities.remotion.available ? 'OK' : 'manquant'}
                {omCapabilities.registry.available && ` · ${omCapabilities.registry.toolCount} outil(s) enregistré(s)`}
              </div>
            )}
          </div>

          {omLoading && <div style={{ fontSize: 12, color: '#64748b' }}>Chargement…</div>}

          {!omLoading && !omJob && (
            <div style={cardStyle}>
              <div>
                <div style={omLabelStyle}>Titre</div>
                <input aria-label="Titre du rendu" style={inputStyle} value={omTitle} onChange={e => setOmTitle(e.target.value)} maxLength={120} disabled={isRunning || omSubmitting} />
              </div>
              <div>
                <div style={omLabelStyle}>Sous-titre</div>
                <input aria-label="Sous-titre du rendu" style={inputStyle} value={omSubtitle} onChange={e => setOmSubtitle(e.target.value)} maxLength={120} disabled={isRunning || omSubmitting} />
              </div>
              <OpenMontageFormat />
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ width: 110 }}>
                  <div style={omLabelStyle}>Durée (s)</div>
                  <input
                    aria-label="Durée (s)" type="number" min={3} max={10} style={inputStyle}
                    value={omDurationSeconds}
                    onChange={e => setOmDurationSeconds(Math.min(10, Math.max(3, Number(e.target.value) || 3)))}
                    disabled={isRunning}
                  />
                </div>
              </div>
              {omRenderError && <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#f87171' }}>{omRenderError}</div>}
              <button
                type="button"
                style={{ ...omBtnStyle, justifyContent: 'center', opacity: status === 'READY_LOCAL' ? 1 : 0.5 }}
                onClick={() => void startOmRender()}
                disabled={status !== 'READY_LOCAL' || omSubmitting}
              >
                <Play size={12} /> Générer localement
              </button>
            </div>
          )}

          {omJob && (
            <div style={cardStyle}>
              <p>Job : {omJob.jobId}</p>
              {omRenderError && <p role="alert">{omRenderError}</p>}
              {omJob.status === 'running' && <p>Aperçu disponible après rendu.</p>}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#e2e8f0' }}>
                  {omJob.status === 'running' ? 'Rendu en cours…' : omJob.status === 'done' ? 'Rendu terminé' : omJob.status === 'cancelled' ? 'Rendu annulé' : 'Rendu échoué'}
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#5a4a7a' }}>{elapsedSeconds}s écoulées</span>
              </div>
              {omJob.status === 'running' && (
                <button type="button" style={omBtnDangerStyle} onClick={() => void cancelOmRender()}>
                  <Square size={11} /> Annuler
                </button>
              )}
              {omJob.status === 'failed' && omJob.error && (
                <div role="alert" style={{ fontFamily: 'monospace', fontSize: 11, color: '#f87171' }}>{studioRequestError(omJob.error)}</div>
              )}
              {omJob.status === 'done' && omJob.hasArtifact && (
                <OpenMontageOutput key={omJob.jobId} job={omJob} />
              )}
              {(omJob.status === 'done' || omJob.status === 'failed' || omJob.status === 'cancelled') && (
                <button type="button" style={omBtnStyle} onClick={resetOmRender}>Nouveau rendu</button>
              )}
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <div style={modalStyle} onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Studio Vidéo" tabIndex={-1} className="studio-video-panel" style={panelStyle} onClick={e => e.stopPropagation()}>
        {view === 'form' && renderForm()}
        {view === 'progress' && renderProgress()}
        {view === 'history' && renderHistory()}
        {view === 'render' && renderRender()}
      </div>
    </div>
  );
}
