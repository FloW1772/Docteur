import { Camera, MonitorOff, X } from 'lucide-react';
import type { ScreenShareState } from '../../hooks/useScreenShare';

interface Props {
  state:        ScreenShareState;
  error:        string | null;
  videoRef:     React.MutableRefObject<HTMLVideoElement | null>;
  onCapture:    () => void;
  onStop:       () => void;
}

export default function ScreenShareOverlay({ state, error, videoRef, onCapture, onStop }: Props) {
  if (state === 'idle') return null;

  return (
    <div
      className="screen-share-overlay-wrap"
      style={{
        position:       'fixed',
        bottom:         72,
        left:           16,
        zIndex:         200,
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'flex-start',
        gap:            6,
        pointerEvents:  'none',
      }}
    >
      {state === 'error' && error && (
        <div
          style={{
            pointerEvents:  'auto',
            background:     'rgba(255,77,88,0.12)',
            border:         '1px solid rgba(255,77,88,0.3)',
            borderRadius:   8,
            padding:        '6px 10px',
            fontFamily:     'monospace',
            fontSize:       11,
            color:          '#ff6b75',
            maxWidth:       260,
          }}
        >
          ⚠ {error}
        </div>
      )}

      {state === 'active' && (
        <div
          style={{
            pointerEvents:  'auto',
            position:       'relative',
            width:          200,
            borderRadius:   10,
            border:         '1px solid rgba(94,231,255,0.35)',
            background:     '#0a0814',
            overflow:       'hidden',
            boxShadow:      '0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px rgba(94,231,255,0.15)',
          }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            style={{ width: '100%', display: 'block', aspectRatio: '16/10', objectFit: 'cover' }}
          />

          <div style={{ position: 'absolute', top: 6, left: 6, width: 8, height: 8, borderRadius: '50%', background: '#5ee7ff', boxShadow: '0 0 6px #5ee7ff', animation: 'pulse 1.2s ease-in-out infinite' }} />

          <button
            type="button"
            title="Désactiver le partage d'écran (Alt+S)"
            onClick={onStop}
            style={{
              position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: '50%',
              background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#9f8fbf',
            }}
          >
            <X size={10} />
          </button>

          <div style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={onCapture}
              className="flex items-center justify-center gap-1.5 font-mono"
              style={{
                flex: 1, fontSize: 10, padding: '5px 8px', borderRadius: 6,
                border: '1px solid rgba(94,231,255,0.3)', background: 'rgba(94,231,255,0.1)',
                color: '#5ee7ff', cursor: 'pointer',
              }}
            >
              <Camera size={11} /> Capturer
            </button>
            <button
              type="button"
              onClick={onStop}
              title="Arrêter le partage"
              style={{ color: '#5a4a7a', display: 'flex', alignItems: 'center' }}
            >
              <MonitorOff size={13} />
            </button>
          </div>
        </div>
      )}

      <div style={{
        pointerEvents: 'none',
        fontFamily:    'monospace',
        fontSize:      9,
        color:         state === 'error' ? '#ff4d58' : '#5ee7ff',
        letterSpacing: '0.1em',
        opacity:       0.7,
      }}>
        {state === 'active' ? '● PARTAGE D\'ÉCRAN ACTIF' : '✕ ERREUR'}
      </div>
    </div>
  );
}
