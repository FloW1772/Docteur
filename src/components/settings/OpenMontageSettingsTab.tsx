import { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, Play, Square, Film, Lock } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import { startJobPolling } from '../../lib/video-job-polling';
import type { OpenMontageCapabilities, OpenMontageJob, OpenMontageResolution } from '../../lib/cortex/client';

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
};
const btnStyle: React.CSSProperties = {
  background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)',
  borderRadius: 6, color: '#a78bfa', padding: '6px 12px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6,
};
const btnDangerStyle: React.CSSProperties = {
  background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)',
  borderRadius: 6, color: '#f87171', padding: '6px 12px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6,
};
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', fontSize: 12, width: '100%',
  fontFamily: 'monospace', outline: 'none',
};
const labelStyle: React.CSSProperties = { fontFamily: 'monospace', fontSize: 10, color: '#5a4a7a', letterSpacing: '0.08em' };

const STATUS_LABELS: Record<string, string> = {
  NOT_INSTALLED: 'Non installé',
  PARTIAL: 'Installation partielle',
  READY_LOCAL: 'Prêt (local)',
  BUSY: 'Occupé',
  ERROR: 'Erreur',
};

const RESOLUTIONS: { value: OpenMontageResolution; label: string }[] = [
  { value: '1920x1080', label: '1920×1080 (16:9)' },
  { value: '1080x1920', label: '1080×1920 (9:16)' },
  { value: '1080x1080', label: '1080×1080 (1:1)' },
];

export function OpenMontageSettingsTab() {
  const [capabilities, setCapabilities] = useState<OpenMontageCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('DOCTEUR');
  const [subtitle, setSubtitle] = useState('Local Video Pipeline');
  const [resolution, setResolution] = useState<OpenMontageResolution>('1920x1080');
  const [fps, setFps] = useState<24 | 25 | 30>(30);
  const [durationSeconds, setDurationSeconds] = useState(6);

  const [job, setJob] = useState<OpenMontageJob | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const stopPollingRef = useRef<(() => void) | null>(null);

  const reload = useCallback(async () => {
    try {
      const caps = await cortexClient.getOpenMontageCapabilities();
      setCapabilities(caps);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => () => { stopPollingRef.current?.(); }, []);

  const startRender = useCallback(async () => {
    setRenderError(null);
    try {
      const { jobId } = await cortexClient.startOpenMontageRender({ title, subtitle, resolution, fps, durationSeconds });
      stopPollingRef.current?.();
      stopPollingRef.current = startJobPolling(
        () => cortexClient.getOpenMontageJob(jobId),
        detail => detail.status,
        detail => setJob(detail),
        () => { void reload(); },
      );
    } catch (e) {
      setRenderError((e as Error).message);
    }
  }, [title, subtitle, resolution, fps, durationSeconds, reload]);

  const cancel = useCallback(async () => {
    if (!job) return;
    try { await cortexClient.cancelOpenMontageJob(job.jobId); } catch { /* best-effort */ }
  }, [job]);

  const reset = useCallback(() => {
    stopPollingRef.current?.();
    stopPollingRef.current = null;
    setJob(null);
    setRenderError(null);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={16} className="animate-spin" style={{ color: '#3d3060' }} />
      </div>
    );
  }

  const status = capabilities?.status ?? 'ERROR';
  const isRunning = job?.status === 'running';
  const elapsedSeconds = job ? Math.round(job.elapsedMs / 1000) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Film size={14} style={{ color: '#a78bfa' }} />
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0' }}>OpenMontage — Local Video Studio</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Lock size={11} style={{ color: '#3dffaa' }} />
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#3dffaa', letterSpacing: '0.08em' }}>LOCAL</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={labelStyle}>État :</span>
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: status === 'READY_LOCAL' ? '#3dffaa' : status === 'ERROR' ? '#f87171' : '#facc15' }}>
            {STATUS_LABELS[status] ?? status}
          </span>
          <button type="button" style={{ ...btnStyle, padding: '4px 8px', marginLeft: 'auto' }} onClick={() => void reload()}>
            <RefreshCw size={11} /> Vérifier
          </button>
        </div>
        {error && <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#f87171' }}>{error}</div>}
        {capabilities && status !== 'READY_LOCAL' && (
          <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#5a4a7a' }}>
            Python: {capabilities.python.available ? 'OK' : 'manquant'} · FFmpeg: {capabilities.ffmpeg.available ? 'OK' : 'manquant'} · Remotion: {capabilities.remotion.available ? 'OK' : 'manquant'}
          </div>
        )}
      </div>

      {!job && (
        <div style={cardStyle}>
          <div>
            <div style={labelStyle}>Titre</div>
            <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} maxLength={120} disabled={isRunning} />
          </div>
          <div>
            <div style={labelStyle}>Sous-titre</div>
            <input style={inputStyle} value={subtitle} onChange={e => setSubtitle(e.target.value)} maxLength={120} disabled={isRunning} />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Format</div>
              <select style={inputStyle} value={resolution} onChange={e => setResolution(e.target.value as OpenMontageResolution)} disabled={isRunning}>
                {RESOLUTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div style={{ width: 90 }}>
              <div style={labelStyle}>FPS</div>
              <select style={inputStyle} value={fps} onChange={e => setFps(Number(e.target.value) as 24 | 25 | 30)} disabled={isRunning}>
                <option value={24}>24</option>
                <option value={25}>25</option>
                <option value={30}>30</option>
              </select>
            </div>
            <div style={{ width: 110 }}>
              <div style={labelStyle}>Durée (s)</div>
              <input
                type="number" min={3} max={10} style={inputStyle}
                value={durationSeconds}
                onChange={e => setDurationSeconds(Math.min(10, Math.max(3, Number(e.target.value) || 3)))}
                disabled={isRunning}
              />
            </div>
          </div>
          {renderError && <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#f87171' }}>{renderError}</div>}
          <button
            type="button"
            style={{ ...btnStyle, justifyContent: 'center', opacity: status === 'READY_LOCAL' ? 1 : 0.5 }}
            onClick={() => void startRender()}
            disabled={status !== 'READY_LOCAL'}
          >
            <Play size={12} /> Générer localement
          </button>
        </div>
      )}

      {job && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#e2e8f0' }}>
              {job.status === 'running' ? 'Rendu en cours…' : job.status === 'done' ? 'Rendu terminé' : job.status === 'cancelled' ? 'Rendu annulé' : 'Rendu échoué'}
            </span>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#5a4a7a' }}>{elapsedSeconds}s écoulées</span>
          </div>
          {job.status === 'running' && (
            <button type="button" style={btnDangerStyle} onClick={() => void cancel()}>
              <Square size={11} /> Annuler
            </button>
          )}
          {job.status === 'failed' && job.error && (
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#f87171' }}>{job.error}</div>
          )}
          {job.status === 'done' && job.hasArtifact && (
            <>
              <video controls style={{ width: '100%', borderRadius: 6, background: '#000' }} src={cortexClient.getOpenMontageArtifactUrl(job.jobId)} />
              <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#5a4a7a' }}>output.mp4 — {job.width}×{job.height} @ {job.fps}fps</div>
            </>
          )}
          {(job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') && (
            <button type="button" style={btnStyle} onClick={reset}>Nouveau rendu</button>
          )}
        </div>
      )}
    </div>
  );
}
