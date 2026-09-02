import { Camera, CameraOff, X, Bug, ScanText } from 'lucide-react';
import type { GestureState, GestureName, GestureDebugInfo, CameraMode } from '../../hooks/useGestureCamera';

interface Props {
  gestureState: GestureState;
  lastGesture:  GestureName;
  error:        string | null;
  videoRef:     React.MutableRefObject<HTMLVideoElement | null>;
  onToggle:     () => void;
  debugEnabled: boolean;
  onToggleDebug: () => void;
  debugInfo:    GestureDebugInfo;
  mode:         CameraMode;
  onModeChange: (mode: CameraMode) => void;
  onCapturePhoto: () => void;
}

const GESTURE_LABELS: Record<NonNullable<GestureName>, string> = {
  rotate: '🖐️ 5 doigts — rotation',
  zoom:   '✌️ 2 doigts — zoom',
  swipe:  '☝️ 1 doigt — neurone suivant/précédent',
  scroll: '🤟 3 doigts — défilement',
  fist:   '✊ Poing — pause',
};

const STATE_LABEL: Partial<Record<GestureState, string>> = {
  loading: 'Chargement du modèle…',
  error:   'Erreur',
};

export default function GestureOverlay({
  gestureState, lastGesture, error, videoRef, onToggle, debugEnabled, onToggleDebug, debugInfo,
  mode, onModeChange, onCapturePhoto,
}: Props) {
  if (gestureState === 'idle') return null;

  const isActive  = gestureState === 'active';
  const isLoading = gestureState === 'loading';
  const isError   = gestureState === 'error';
  const isPhoto   = mode === 'photo';

  const accentColor = isError ? '#ff4d58' : isLoading ? '#ffb547' : '#3dffaa';

  return (
    <div
      className="gesture-overlay-wrap"
      style={{
        position:       'fixed',
        bottom:         72,
        right:          16,
        zIndex:         200,
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'flex-end',
        gap:            6,
        pointerEvents:  'none',
      }}
    >
      {/* Error message */}
      {isError && error && (
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
            maxWidth:       220,
          }}
        >
          ⚠ {error}
        </div>
      )}

      {/* Gesture label — deliberately larger/bolder than other overlay text so a
          recognized gesture is unmistakable at a glance */}
      {!isPhoto && isActive && lastGesture && (
        <div
          style={{
            background:   'rgba(61,255,170,0.16)',
            border:       '1px solid rgba(61,255,170,0.4)',
            borderRadius: 8,
            padding:      '6px 12px',
            fontFamily:   'monospace',
            fontSize:     13,
            fontWeight:   700,
            color:        '#3dffaa',
            letterSpacing: '0.04em',
            boxShadow:    '0 0 12px rgba(61,255,170,0.25)',
          }}
        >
          {GESTURE_LABELS[lastGesture]}
        </div>
      )}

      {/* Loading label */}
      {isLoading && (
        <div
          style={{
            background:   'rgba(255,181,71,0.1)',
            border:       '1px solid rgba(255,181,71,0.2)',
            borderRadius: 8,
            padding:      '4px 10px',
            fontFamily:   'monospace',
            fontSize:     10,
            color:        '#ffb547',
          }}
        >
          {STATE_LABEL.loading}
        </div>
      )}

      {/* Debug panel — toggleable, never shown unless explicitly enabled (gestures mode only) */}
      {!isPhoto && debugEnabled && (isActive || isLoading) && (
        <div
          style={{
            background:   'rgba(0,0,0,0.6)',
            border:       '1px solid rgba(94,231,255,0.25)',
            borderRadius: 8,
            padding:      '5px 10px',
            fontFamily:   'monospace',
            fontSize:     10,
            color:        '#5ee7ff',
            lineHeight:   1.6,
            minWidth:     150,
          }}
        >
          <div>Mains détectées : {debugInfo.handsDetected}</div>
          <div style={{ color: debugInfo.confidence !== null && debugInfo.confidence < 0.7 ? '#ffb547' : undefined }}>
            Confiance : {debugInfo.confidence !== null ? `${Math.round(debugInfo.confidence * 100)}%` : '—'}
          </div>
          <div>Doigts levés (brut) : {debugInfo.fingerCount ?? '—'}</div>
          <div>Doigts levés (stable) : {debugInfo.confirmedCount ?? '—'}</div>
          <div>Action : {lastGesture ?? '—'}</div>
          <div>
            Position : {debugInfo.position ? `${debugInfo.position.x.toFixed(2)}, ${debugInfo.position.y.toFixed(2)}` : '—'}
          </div>
          <div>
            Balayage : {debugInfo.swipeDist.toFixed(3)} / seuil {debugInfo.swipeThreshold.toFixed(3)}
          </div>
          <div>
            Vidéo : {debugInfo.videoSize ? `${debugInfo.videoSize.w}×${debugInfo.videoSize.h}` : '—'}
          </div>
          {debugInfo.metrics && (
            <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(94,231,255,0.15)' }}>
              {(['thumb', 'index', 'middle', 'ring', 'pinky'] as const).map(finger => {
                const m = debugInfo.metrics![finger];
                const ok = finger === 'thumb' ? m.value > m.threshold : m.value < m.threshold;
                const label = finger === 'thumb' ? 'Pouce' : finger === 'index' ? 'Index' : finger === 'middle' ? 'Majeur' : finger === 'ring' ? 'Annulaire' : 'Auriculaire';
                const unitLabel = m.unit === 'deg' ? '°' : '';
                return (
                  <div key={finger} style={{ color: ok ? '#3dffaa' : '#7a6c9a' }}>
                    {label} : {m.value.toFixed(m.unit === 'deg' ? 0 : 2)}{unitLabel} / seuil {m.threshold.toFixed(m.unit === 'deg' ? 0 : 2)}{unitLabel}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Mode toggle — Gestes / Photo. The two never run at once: switching
          stops MediaPipe detection immediately (photo) or loads it (gestures). */}
      {(isActive || isLoading) && (
        <div style={{ pointerEvents: 'auto', display: 'flex', gap: 3 }}>
          {(['gestures', 'photo'] as const).map(m => (
            <button
              key={m}
              type="button"
              disabled={isLoading}
              onClick={() => onModeChange(m)}
              className="font-mono"
              style={{
                fontSize: 9, padding: '3px 8px', borderRadius: 12,
                border: `1px solid ${mode === m ? 'rgba(94,231,255,0.4)' : 'rgba(255,255,255,0.08)'}`,
                background: mode === m ? 'rgba(94,231,255,0.12)' : 'transparent',
                color: mode === m ? '#5ee7ff' : '#7a6c9a',
                cursor: isLoading ? 'default' : 'pointer',
              }}
            >
              {m === 'gestures' ? '🖐 Gestes' : '📷 Photo'}
            </button>
          ))}
        </div>
      )}

      {/* Camera preview panel */}
      <div
        style={{
          pointerEvents:  'auto',
          position:       'relative',
          width:          140,
          height:         105,
          borderRadius:   10,
          border:         `1px solid ${isActive ? 'rgba(61,255,170,0.35)' : isLoading ? 'rgba(255,181,71,0.3)' : 'rgba(255,77,88,0.3)'}`,
          background:     '#0a0814',
          overflow:       'hidden',
          boxShadow:      `0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px ${accentColor}22`,
        }}
      >
        {/* Live video preview — plain declarative ref, no imperative DOM creation */}
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          style={{
            width: '100%', height: '100%', objectFit: 'cover',
            // Mirrored in gestures mode for a natural "selfie" feel — NOT in
            // photo mode, where the preview must match what actually gets
            // captured (a mirrored document photo reads backwards).
            transform: isPhoto ? 'none' : 'scaleX(-1)', display: 'block',
          }}
        />

        {/* Loading spinner overlay */}
        {isLoading && (
          <div style={{
            position:       'absolute', inset: 0,
            display:        'flex', alignItems: 'center', justifyContent: 'center',
            background:     'rgba(10,8,20,0.7)',
          }}>
            <div
              style={{
                width: 24, height: 24, borderRadius: '50%',
                border: '2px solid rgba(255,181,71,0.3)',
                borderTopColor: '#ffb547',
                animation: 'spin 0.8s linear infinite',
              }}
            />
          </div>
        )}

        {/* Active indicator dot (top-left) */}
        {isActive && (
          <div style={{
            position: 'absolute', top: 6, left: 6,
            width: 8, height: 8, borderRadius: '50%',
            background: '#ff4d58',
            boxShadow: '0 0 6px #ff4d58',
            animation: 'pulse 1.2s ease-in-out infinite',
          }} />
        )}

        {/* Camera icon + state (top-right area, non-active) */}
        {!isActive && (
          <div style={{
            position:       'absolute', inset: 0,
            display:        'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {isError
              ? <CameraOff size={24} style={{ color: '#ff4d58', opacity: 0.7 }} />
              : <Camera size={24} style={{ color: '#ffb547', opacity: 0.6 }} />
            }
          </div>
        )}

        {/* Debug toggle button — gestures mode only */}
        {!isPhoto && (
          <button
            type="button"
            title={debugEnabled ? 'Masquer le débogage' : 'Afficher le débogage'}
            onClick={onToggleDebug}
            style={{
              position:   'absolute', top: 4, right: 26,
              width:      18, height: 18,
              borderRadius: '50%',
              background: debugEnabled ? 'rgba(94,231,255,0.3)' : 'rgba(0,0,0,0.6)',
              border:     '1px solid rgba(255,255,255,0.15)',
              display:    'flex', alignItems: 'center', justifyContent: 'center',
              cursor:     'pointer', color: debugEnabled ? '#5ee7ff' : '#9f8fbf',
            }}
          >
            <Bug size={10} />
          </button>
        )}

        {/* "Prendre la photo" — photo mode only, while active */}
        {isPhoto && isActive && (
          <button
            type="button"
            title="Prendre la photo"
            onClick={onCapturePhoto}
            className="flex items-center justify-center gap-1 font-mono"
            style={{
              position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)',
              fontSize: 10, padding: '5px 12px', borderRadius: 14,
              border: '1px solid rgba(94,231,255,0.4)', background: 'rgba(10,8,20,0.75)',
              color: '#5ee7ff', cursor: 'pointer',
            }}
          >
            <ScanText size={11} /> Prendre la photo
          </button>
        )}

        {/* Close button */}
        <button
          type="button"
          title="Désactiver la caméra (Alt+C)"
          onClick={onToggle}
          style={{
            position:   'absolute', top: 4, right: 4,
            width:      18, height: 18,
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.6)',
            border:     '1px solid rgba(255,255,255,0.15)',
            display:    'flex', alignItems: 'center', justifyContent: 'center',
            cursor:     'pointer', color: '#9f8fbf',
          }}
        >
          <X size={10} />
        </button>
      </div>

      {/* Camera label */}
      <div style={{
        pointerEvents: 'none',
        fontFamily:    'monospace',
        fontSize:      9,
        color:         accentColor,
        letterSpacing: '0.1em',
        opacity:       0.7,
        textAlign:     'right',
      }}>
        {isActive ? '● CAMÉRA ACTIVE' : isLoading ? '○ CHARGEMENT…' : '✕ ERREUR'}
      </div>
    </div>
  );
}
