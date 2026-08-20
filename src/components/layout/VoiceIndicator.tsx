import { useRef, useEffect } from 'react';
import { Mic, MicOff, X, Check } from 'lucide-react';
import type { VoiceState } from '../../hooks/useVoiceActivation';

interface Props {
  state:           VoiceState;
  pendingText:     string | null;
  setPendingText:  (t: string) => void;
  error:           string | null;
  onMicClick:      () => void;
  onConfirm:       (text: string) => void;
  onCancel:        () => void;
}

const STATE_LABEL: Record<VoiceState, string> = {
  'idle':           '',
  'wake-listening': 'En écoute',
  'recording':      'Enregistrement…',
  'transcribing':   'Transcription…',
  'pending':        '',
};

const STATE_COLOR: Record<VoiceState, string> = {
  'idle':           '#7a6c9a',
  'wake-listening': '#3dffaa',
  'recording':      '#ff4d58',
  'transcribing':   '#ffb547',
  'pending':        '#5ee7ff',
};

export default function VoiceIndicator({
  state, pendingText, setPendingText, error, onMicClick, onConfirm, onCancel,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state === 'pending' && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [state]);

  const color = STATE_COLOR[state];
  const label = STATE_LABEL[state];
  const isPulsing = state === 'recording';

  // Pending confirmation panel
  if (state === 'pending' && pendingText !== null) {
    return (
      <div className="voice-pending-panel glass" role="dialog" aria-label="Confirmation commande vocale">
        <div className="voice-pending-header">
          <span style={{ color: '#5ee7ff', fontFamily: 'monospace', fontSize: '0.65rem', letterSpacing: '0.15em' }}>
            COMMANDE VOCALE
          </span>
          <button type="button" className="voice-pending-close" onClick={onCancel} aria-label="Annuler">
            <X size={14} />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          className="voice-pending-input"
          value={pendingText}
          onChange={(e) => setPendingText(e.target.value)}
          rows={2}
          aria-label="Texte transcrit — modifiable"
        />
        <div className="voice-pending-actions">
          <button type="button" className="voice-pending-cancel" onClick={onCancel}>
            Annuler
          </button>
          <button
            type="button"
            className="voice-pending-confirm"
            onClick={() => onConfirm(pendingText)}
            disabled={!pendingText.trim()}
          >
            <Check size={13} />
            Envoyer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-indicator-wrap">
      {error && (
        <div className="voice-error-badge" title={error}>
          ⚠ {error.slice(0, 60)}{error.length > 60 ? '…' : ''}
        </div>
      )}
      {label && (
        <span className="voice-state-label" style={{ color }}>
          {label}
        </span>
      )}
      <button
        type="button"
        className={`voice-mic-btn${isPulsing ? ' voice-mic-btn--pulsing' : ''}`}
        style={{ '--voice-color': color } as React.CSSProperties}
        onClick={onMicClick}
        aria-label={state === 'idle' ? 'Activer le micro (Alt+M)' : 'Micro actif'}
        title={state === 'idle' ? 'Activer le micro (Alt+M)' : label}
        disabled={state === 'transcribing'}
      >
        {state === 'idle' ? <MicOff size={13} /> : <Mic size={13} />}
      </button>
    </div>
  );
}
