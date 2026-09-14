import { useEffect, useRef, useState } from 'react';
import { isTerminalVideoStatus, startVideoJobPolling } from '../../lib/video-job-polling';
import {
  Clapperboard, X, ChevronLeft, Minimize2, AlertTriangle, CheckCircle,
  RotateCcw, Ban, HardDrive, Clock, History,
} from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type {
  VideoEstimate, VideoJob, VideoJobDetail,
} from '../../lib/cortex/client';

interface Props {
  onClose:          () => void;
  onMinimize?:      () => void;
  strictLocalMode:  boolean;
  // Called when a job finishes — caller reloads its neuron list.
  onDone?:          () => void;
}

type View = 'form' | 'progress' | 'history';

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

export default function VideoSummaryModal({ onClose, onMinimize, strictLocalMode, onDone }: Props) {
  const [view, setView]           = useState<View>('form');
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

  const cloudForcedLocal = strictLocalMode || isPrivate;

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    width: 560, maxHeight: '84vh', display: 'flex', flexDirection: 'column',
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
          <button type="button" onClick={backFn} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c084fc', display: 'flex', padding: 2 }}>
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
        {view !== 'history' && (
          <button type="button" onClick={loadHistory} title="Historique" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', display: 'flex' }}>
            <History size={14} />
          </button>
        )}
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', display: 'flex' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  // ── Form view ──────────────────────────────────────────────────────────────
  function renderForm() {
    return (
      <>
        {renderHeader('RÉSUMÉ DE VIDÉO LONGUE')}
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

  return (
    <div style={modalStyle} onClick={onClose}>
      <div style={panelStyle} onClick={e => e.stopPropagation()}>
        {view === 'form' && renderForm()}
        {view === 'progress' && renderProgress()}
        {view === 'history' && renderHistory()}
      </div>
    </div>
  );
}
