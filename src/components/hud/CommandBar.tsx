// HUD Command Center V2 — bottom command bar. Never duplicates the search/
// voice logic: submitting text opens the existing SearchConsole via its
// `initialQuery` prop (same channel already used by voice dictation —
// App.tsx's voiceConsoleQuery), and the mic button/state come directly
// from the real `useVoiceActivation` hook instance App.tsx already owns
// (VoiceIndicator's own state, not a second copy of it).
import { useState, type FormEvent } from 'react';
import { Mic, MicOff, Send, X } from 'lucide-react';
import type { VoiceState } from '../../hooks/useVoiceActivation';
import type { CortexVisualState } from '../../hooks/useCortexState';
import { CORTEX_STATE_LABEL } from '../../hooks/useCortexState';

const VOICE_LABEL: Record<VoiceState, string> = {
  idle: '',
  'wake-listening': 'En écoute',
  recording: 'Enregistrement…',
  transcribing: 'Transcription…',
  pending: 'Commande en attente',
};

interface Props {
  onSubmit: (query: string) => void;
  cortexState: CortexVisualState;
  voiceEnabled: boolean;
  voiceState: VoiceState;
  onVoiceClick: () => void;
  /** Present only when a real cancellable job/action is running (never a fake stop button). */
  onCancel?: () => void;
}

export default function CommandBar({ onSubmit, cortexState, voiceEnabled, voiceState, onVoiceClick, onCancel }: Props) {
  const [value, setValue] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  }

  const listening = voiceState === 'wake-listening' || voiceState === 'recording';
  const cortexLabel = CORTEX_STATE_LABEL[cortexState];

  return (
    <form
      className={`hud2-command-bar glass${listening ? ' hud2-command-bar--listening' : ''}`}
      onSubmit={handleSubmit}
      role="search"
      aria-label="Commande principale"
    >
      {voiceEnabled && (
        <button
          type="button"
          className={`hud2-command-bar-mic${listening ? ' hud2-command-bar-mic--active' : ''}`}
          onClick={onVoiceClick}
          aria-label={voiceState === 'idle' ? 'Activer le micro' : (VOICE_LABEL[voiceState] || 'Micro actif')}
          title={voiceState === 'idle' ? 'Activer le micro (Alt+M)' : VOICE_LABEL[voiceState]}
        >
          {voiceState === 'idle' ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
      )}

      <input
        type="text"
        className="hud2-command-bar-input"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Demander à Docteur…"
        aria-label="Commande ou question"
      />

      {cortexLabel && (
        <span className="hud2-command-bar-status" aria-live="polite">{cortexLabel}</span>
      )}

      {onCancel ? (
        <button type="button" className="hud2-command-bar-cancel" onClick={onCancel} aria-label="Annuler l'action en cours">
          <X size={14} /> Annuler
        </button>
      ) : (
        <button type="submit" className="hud2-command-bar-send" disabled={!value.trim()} aria-label="Envoyer">
          <Send size={14} />
        </button>
      )}
    </form>
  );
}
