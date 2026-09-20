// HUD Command Center V2 — bottom command bar. Never duplicates the search/
// voice logic: submitting text opens the existing SearchConsole via its
// `initialQuery` prop (same channel already used by voice dictation —
// App.tsx's voiceConsoleQuery), and the mic button/state come directly
// from the real `useVoiceActivation` hook instance App.tsx already owns
// (VoiceIndicator's own state, not a second copy of it).
import { useId, useState, type FormEvent } from 'react';
import { Mic, MicOff, Send, X, Volume2 } from 'lucide-react';
import type { VoiceState } from '../../hooks/useVoiceActivation';
import type { CortexVisualState } from '../../hooks/useCortexState';
import { CORTEX_STATE_LABEL } from '../../hooks/useCortexState';
import type { VoiceMicMode } from '../../hooks/useVoiceCommandPipeline';
import { VOICE_STATE_LABEL, type UnifiedVoiceState } from '../../lib/voiceLifecycle';
import VoiceCommands from '../settings/VoiceCommands';

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
  unifiedVoiceState?: UnifiedVoiceState;
  onCancelVoice?: () => void;
  onVoiceClick: () => void;
  /** Present only when a real cancellable job/action is running (never a fake stop button). */
  onCancel?: () => void;
  ttsSpeaking?: boolean;
  onStopSpeaking?: () => void;
  /** VOICE-5 — explicit, always-visible DICTATION/COMMAND toggle (mission
   * items 3/4: mode must be visible before speaking, default DICTATION,
   * no silent switch). Optional so CommandBar stays usable in contexts
   * that don't wire the Intent Layer yet. */
  voiceMode?: VoiceMicMode;
  onVoiceModeChange?: (mode: VoiceMicMode) => void;
}

export default function CommandBar({ onSubmit, cortexState, voiceEnabled, voiceState, unifiedVoiceState, onCancelVoice, onVoiceClick, onCancel, ttsSpeaking = false, onStopSpeaking, voiceMode, onVoiceModeChange }: Props) {
  const [value, setValue] = useState('');
  const modeHintId = useId();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  }

  const listening = voiceState === 'wake-listening' || voiceState === 'recording';
  const cortexLabel = unifiedVoiceState ? VOICE_STATE_LABEL[unifiedVoiceState] : CORTEX_STATE_LABEL[cortexState];

  return (
    <form
      className={`hud2-command-bar glass${listening ? ' hud2-command-bar--listening' : ''}${voiceMode === 'COMMAND' ? ' hud2-command-bar--command' : ''}`}
      onSubmit={handleSubmit}
      role="search"
      aria-label="Commande principale"
    >
      {voiceEnabled && (
        <button
          type="button"
          className={`hud2-command-bar-mic${listening ? ' hud2-command-bar-mic--active' : ''}`}
          onClick={onVoiceClick}
          aria-pressed={listening}
          aria-describedby={voiceMode ? modeHintId : undefined}
          aria-label={voiceState === 'idle' ? 'Activer le micro' : (VOICE_LABEL[voiceState] || 'Micro actif')}
          title={voiceState === 'idle' ? 'Activer le micro (Alt+M)' : VOICE_LABEL[voiceState]}
        >
          {voiceState === 'idle' ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
      )}

      {voiceEnabled && voiceMode && onVoiceModeChange && (
        <div className="hud2-command-bar-mic-mode" role="radiogroup" aria-label="Mode du microphone" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          onVoiceModeChange(voiceMode === 'COMMAND' ? 'DICTATION' : 'COMMAND');
          const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
          radios[voiceMode === 'COMMAND' ? 0 : 1]?.focus();
        }}>
          <button
            type="button"
            role="radio"
            aria-checked={voiceMode === 'DICTATION'}
            tabIndex={voiceMode === 'DICTATION' ? 0 : -1}
            className={`hud2-command-bar-mic-mode-btn${voiceMode === 'DICTATION' ? ' hud2-command-bar-mic-mode-btn--active' : ''}`}
            onClick={() => onVoiceModeChange('DICTATION')}
            title="Dictée : la transcription devient du texte"
          >
            Dictée
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={voiceMode === 'COMMAND'}
            tabIndex={voiceMode === 'COMMAND' ? 0 : -1}
            className={`hud2-command-bar-mic-mode-btn${voiceMode === 'COMMAND' ? ' hud2-command-bar-mic-mode-btn--active' : ''}`}
            onClick={() => onVoiceModeChange('COMMAND')}
            title="Commande : la transcription est interprétée comme une action"
          >
            Commande
          </button>
        </div>
      )}
      {voiceEnabled && voiceMode && <span id={modeHintId} className="voice-mode-hint">{voiceMode === 'COMMAND' ? 'Commande : vos paroles seront interprétées comme une action.' : 'Dictée : vos paroles deviennent du texte à relire.'}</span>}
      {voiceEnabled && <div className="voice-command-help" onKeyDown={event => {
        if (event.key === 'Escape') {
          const details = event.currentTarget.querySelector('details');
          if (details?.open) { event.stopPropagation(); details.open = false; details.querySelector('summary')?.focus(); }
        }
      }}><VoiceCommands compact /></div>}

      <input
        type="text"
        className="hud2-command-bar-input"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Demander à Docteur…"
        aria-label="Commande ou question"
      />

      {cortexLabel && (
        <span className="hud2-command-bar-status" role="status" aria-live="polite" aria-atomic="true">{listening && unifiedVoiceState ? `Microphone actif — ${cortexLabel}` : cortexLabel}</span>
      )}

      {unifiedVoiceState && unifiedVoiceState !== 'IDLE' && onCancelVoice && (
        <button type="button" className="hud2-command-bar-cancel" onClick={onCancelVoice} aria-label={unifiedVoiceState === 'SPEAKING' ? 'Arrêter la parole' : 'Arrêter l’interaction vocale'}><X size={14} /> {unifiedVoiceState === 'SPEAKING' ? 'Stop lecture' : 'Stop'}</button>
      )}
      {!unifiedVoiceState && ttsSpeaking && onStopSpeaking && (
        <button type="button" className="hud2-command-bar-cancel" onClick={onStopSpeaking} aria-label="Arrêter la parole" title="Arrêter la parole">
          <Volume2 size={14} /> Parle
        </button>
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
