import { useEffect, useState } from 'react';
import { CheckCircle, RotateCcw, AlertTriangle, Minimize2, X } from 'lucide-react';

export interface BatchProgressState {
  operation:       string;
  current:         number;
  total:           number;
  lotIndex:        number;
  lotTotal:        number;
  currentLabel:    string;
  okCount:         number;
  fallbackCount:   number;
  errorCount:      number;
  startedAt:       number;
  whisperProvider?: 'groq' | 'local'; // set while actively transcribing with Whisper
}

export interface QueuedJob {
  id:    string;
  label: string;
  count: number;
  run:   () => Promise<void>;
}

interface Props {
  state:           BatchProgressState;
  color?:          string;
  onCancel:        () => void;
  onMinimize?:     () => void;
  queue?:          QueuedJob[];
  onRemoveQueued?: (id: string) => void;
  onCancelAll?:    () => void;
}

function formatEta(elapsed: number, done: number, total: number): string {
  if (done === 0) return '…';
  const rem = ((elapsed / done) * (total - done));
  if (rem < 60_000) return `~${Math.ceil(rem / 1000)}s`;
  return `~${Math.ceil(rem / 60_000)}m`;
}

export default function BatchProgressModal({
  state, color = '#5ee7ff', onCancel, onMinimize,
  queue = [], onRemoveQueued, onCancelAll,
}: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const pct     = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
  const elapsed = now - state.startedAt;
  const eta     = formatEta(elapsed, state.current, state.total);

  return (
    <div className="modal-backdrop">
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width:     'min(460px, calc(100vw - 24px))',
          border:    `1px solid ${color}40`,
          borderRadius: 12,
          padding:   0,
          overflow:  'hidden',
          boxShadow: '0 30px 90px rgba(0,0,0,0.56)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4"
          style={{ borderBottom: `1px solid ${color}1a` }}
        >
          <div
            className="animate-pulse"
            style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }}
          />
          <div className="flex-1">
            <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
              {state.operation}
            </p>
            <p className="font-mono" style={{ fontSize: 10, color: '#7a6c9a', marginTop: 2 }}>
              Lot {state.lotIndex} / {state.lotTotal}
            </p>
          </div>
          {onMinimize && (
            <button
              type="button"
              onClick={onMinimize}
              title="Réduire dans la barre du haut (continuer à utiliser Docteur)"
              className="flex items-center gap-1 font-mono"
              style={{
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 5, cursor: 'pointer', color: '#c0b0e0',
                padding: '3px 8px', fontSize: 10, lineHeight: 1, flexShrink: 0,
              }}
            >
              <Minimize2 size={10} />
              <span>Réduire</span>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {/* Counter + ETA */}
          <div className="flex items-baseline gap-2 mb-3">
            <span className="font-grotesk font-bold" style={{ fontSize: 26, color: '#f0eaff', lineHeight: 1 }}>
              {state.current}
            </span>
            <span className="font-mono text-xs" style={{ color: '#5a4a7a' }}>
              / {state.total}
            </span>
            <span className="font-mono text-xs ml-auto" style={{ color: '#5a4a7a' }}>
              Restant : {eta}
            </span>
          </div>

          {/* Bar */}
          <div style={{ height: 5, borderRadius: 3, background: `${color}1a`, marginBottom: 10 }}>
            <div
              style={{
                height: '100%', borderRadius: 3, background: color,
                width: `${pct}%`, transition: 'width 0.3s ease',
                boxShadow: `0 0 8px ${color}50`,
              }}
            />
          </div>

          {/* Current label + Whisper provider badge */}
          <div className="flex items-center gap-2" style={{ marginBottom: 16, minHeight: 14 }}>
            {state.whisperProvider && (
              <span style={{
                flexShrink: 0,
                padding: '1px 6px', borderRadius: 3, fontSize: 9, fontFamily: 'IBM Plex Mono, monospace',
                background: state.whisperProvider === 'groq' ? 'rgba(249,115,22,0.15)' : 'rgba(52,211,153,0.12)',
                border: `1px solid ${state.whisperProvider === 'groq' ? 'rgba(249,115,22,0.4)' : 'rgba(52,211,153,0.3)'}`,
                color: state.whisperProvider === 'groq' ? '#f97316' : '#34d399',
              }}>
                {state.whisperProvider === 'groq' ? '⚡ GROQ' : '🔒 LOCAL'}
              </span>
            )}
            <p className="font-mono truncate" style={{ fontSize: 10, color: '#7a6c9a', flex: 1 }}>
              {state.currentLabel || '…'}
            </p>
          </div>

          {/* Counters */}
          <div className="flex flex-wrap gap-4 mb-5">
            <div className="flex items-center gap-1.5">
              <CheckCircle size={11} style={{ color: '#3dffaa' }} />
              <span className="font-mono" style={{ fontSize: 11, color: '#3dffaa' }}>{state.okCount}</span>
              <span className="font-mono" style={{ fontSize: 10, color: '#3d3060' }}>réussis</span>
            </div>
            {state.fallbackCount > 0 && (
              <div className="flex items-center gap-1.5">
                <RotateCcw size={11} style={{ color: '#ff8b3d' }} />
                <span className="font-mono" style={{ fontSize: 11, color: '#ff8b3d' }}>{state.fallbackCount}</span>
                <span className="font-mono" style={{ fontSize: 10, color: '#3d3060' }}>fallback</span>
              </div>
            )}
            {state.errorCount > 0 && (
              <div className="flex items-center gap-1.5">
                <AlertTriangle size={11} style={{ color: '#ff4d58' }} />
                <span className="font-mono" style={{ fontSize: 11, color: '#ff4d58' }}>{state.errorCount}</span>
                <span className="font-mono" style={{ fontSize: 10, color: '#3d3060' }}>ignorés</span>
              </div>
            )}
          </div>

          {/* Cancel */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="font-mono text-xs px-3 py-1.5 rounded"
              style={{
                background: 'rgba(255,77,88,0.08)',
                border:     '1px solid rgba(255,77,88,0.2)',
                color:      '#ff4d58',
                cursor:     'pointer',
              }}
            >
              Annuler après ce lot
            </button>
          </div>

          {/* Queue section */}
          {queue.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em' }}>
                  FILE D'ATTENTE ({queue.length})
                </span>
                {onCancelAll && (
                  <button
                    type="button"
                    onClick={onCancelAll}
                    className="font-mono"
                    style={{
                      fontSize: 9, color: '#ff4d58', background: 'rgba(255,77,88,0.08)',
                      border: '1px solid rgba(255,77,88,0.15)', borderRadius: 4,
                      padding: '2px 6px', cursor: 'pointer',
                    }}
                  >
                    Tout annuler
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-1">
                {queue.map((job, i) => (
                  <div
                    key={job.id}
                    className="flex items-center gap-2"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: 5, padding: '4px 8px',
                    }}
                  >
                    <span className="font-mono" style={{ fontSize: 9, color: '#5a4a7a', flexShrink: 0 }}>
                      {i + 2}
                    </span>
                    <span
                      className="font-mono flex-1 truncate"
                      style={{ fontSize: 10, color: '#9080b8' }}
                    >
                      {job.label}
                    </span>
                    {onRemoveQueued && (
                      <button
                        type="button"
                        onClick={() => onRemoveQueued(job.id)}
                        title="Retirer de la file"
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: '#5a4a7a', padding: 2, flexShrink: 0,
                          display: 'flex', alignItems: 'center',
                        }}
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
