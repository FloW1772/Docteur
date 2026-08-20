import { useEffect, useRef, useState } from 'react';
import { Download, Link, FileVideo, X } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';

export type DownloadMode = 'link_only' | 'download' | 'download_analyze';

export interface DownloadResult {
  mode: DownloadMode;
  url:  string;
  title:    string;
  filePath: string | null;
  analysis: string | null;
}

interface Props {
  url:            string;
  downloadFolder: string;
  onDone:         (result: DownloadResult) => void;
  onClose:        () => void;
}

const MODES: { key: DownloadMode; label: string; desc: string; icon: React.ElementType }[] = [
  { key: 'link_only',        label: 'Juste le lien',          desc: 'Crée un neurone avec le lien, sans télécharger.',          icon: Link },
  { key: 'download',         label: 'Télécharger la vidéo',   desc: `Télécharge la vidéo dans le dossier configuré.`,            icon: FileVideo },
  { key: 'download_analyze', label: 'Télécharger + analyser', desc: 'Télécharge et génère un résumé à partir des sous-titres.', icon: Download },
];

export default function DownloadModal({ url, downloadFolder, onDone, onClose }: Props) {
  const [mode,     setMode]     = useState<DownloadMode>('download');
  const [busy,     setBusy]     = useState(false);
  const [percent,  setPercent]  = useState(0);
  const [statusMsg,setStatusMsg]= useState('');
  const [speed,    setSpeed]    = useState('');
  const [eta,      setEta]      = useState('');
  const [error,    setError]    = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => { ctrlRef.current?.abort(); };
  }, []);

  const hostname = (() => { try { return new URL(url).hostname.replace('www.', ''); } catch { return url.slice(0, 40); } })();

  async function handleLaunch() {
    setError(null);

    if (mode === 'link_only') {
      onDone({ mode, url, title: '', filePath: null, analysis: null });
      return;
    }

    setBusy(true);
    setPercent(0);
    setStatusMsg('Démarrage…');
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    try {
      const result = await cortexClient.downloadVideo(url, mode, downloadFolder, {
        onProgress: ({ percent: pct, speed: sp, eta: et }) => {
          setPercent(pct);
          setSpeed(sp);
          setEta(et);
          setStatusMsg(`${pct.toFixed(1)}%`);
        },
        onStatus: (msg) => { setStatusMsg(msg); },
        signal: ctrl.signal,
      });
      onDone({ mode, url, title: result.title, filePath: result.filePath, analysis: result.analysis });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message);
        setBusy(false);
      } else {
        onClose();
      }
    }
  }

  function handleCancel() {
    ctrlRef.current?.abort();
  }

  return (
    <div
      className="modal-overlay"
      style={{ zIndex: 100 }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="modal-panel" style={{ maxWidth: 480, width: '94vw' }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(61,255,170,0.10)' }}>
          <Download size={16} style={{ color: '#a78bfa', flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <p className="font-mono text-xs" style={{ color: '#a78bfa', fontSize: 10, letterSpacing: '0.12em' }}>TÉLÉCHARGEMENT</p>
            <p className="font-mono text-xs truncate" style={{ color: '#c0b0e0', fontSize: 11, marginTop: 2 }}>{hostname}</p>
          </div>
          {!busy && (
            <button type="button" title="Fermer" onClick={onClose} style={{ color: '#5a4a7a', background: 'none', border: 'none', cursor: 'pointer' }}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className="px-5 py-4">
          {/* Mode selector */}
          {!busy && (
            <div className="flex flex-col gap-2 mb-4">
              {MODES.map(m => {
                const Icon = m.icon;
                const active = mode === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setMode(m.key)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                      borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                      border: `1px solid ${active ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.08)'}`,
                      background: active ? 'rgba(167,139,250,0.10)' : 'rgba(255,255,255,0.03)',
                      transition: 'all 0.12s',
                    }}
                  >
                    <Icon size={14} style={{ color: active ? '#a78bfa' : '#5a4a7a', flexShrink: 0, marginTop: 2 }} />
                    <div>
                      <p className="font-mono" style={{ fontSize: 11, color: active ? '#f0eaff' : '#c0b0e0', fontWeight: active ? 600 : 400 }}>{m.label}</p>
                      <p className="font-mono" style={{ fontSize: 9, color: '#5a4a7a', marginTop: 2 }}>{m.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Folder display (only for download modes) */}
          {!busy && mode !== 'link_only' && (
            <p className="font-mono mb-4" style={{ fontSize: 9, color: '#5a4a7a' }}>
              Dossier : <span style={{ color: '#7a6c9a' }}>{downloadFolder}</span>
            </p>
          )}

          {/* Progress (while downloading) */}
          {busy && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="font-mono" style={{ fontSize: 11, color: '#c0b0e0' }}>{statusMsg}</p>
                {speed && <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>{speed} · ETA {eta}</p>}
              </div>
              {percent > 0 && (
                <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)' }}>
                  <div style={{ height: '100%', borderRadius: 2, width: `${percent}%`, background: 'rgba(167,139,250,0.8)', transition: 'width 0.3s' }} />
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-4 px-3 py-2 rounded" style={{ background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.2)' }}>
              <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 justify-end">
            {busy ? (
              <button
                type="button"
                onClick={handleCancel}
                className="modal-btn-cancel font-mono text-sm"
                style={{ minWidth: 80 }}
              >
                Annuler
              </button>
            ) : (
              <>
                {!error && (
                  <button type="button" onClick={onClose} className="modal-btn-cancel font-mono text-sm">Annuler</button>
                )}
                <button
                  type="button"
                  onClick={error ? () => { setError(null); handleLaunch(); } : handleLaunch}
                  className="modal-btn-confirm font-mono text-sm flex items-center gap-2"
                >
                  {error ? 'Réessayer' : mode === 'link_only' ? 'Créer le lien' : 'Lancer'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
