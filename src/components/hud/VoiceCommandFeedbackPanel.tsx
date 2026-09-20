// VOICE-5 — "Heard / Intent / Action" feedback panel (mission item 38).
// Also the ONLY UI for confirming/cancelling a pending LEVEL_2 voice
// action — and per mission item 50 ("la voix ne doit jamais devenir le
// seul moyen de confirmer ou annuler"), both buttons here are real
// mouse/keyboard-operable controls, not voice-only affordances.
import type { VoiceCommandFeedback } from '../../hooks/useVoiceCommandPipeline';
import type { PendingVoiceConfirmation } from '../../lib/voicePolicy';
import { useEffect, useRef } from 'react';
import { HELP_DIRECTORY } from '../../content/capabilities';
import { containsSensitiveContent } from '../../lib/voiceResponsePolicy';

const INTENT_LABEL: Record<string, string> = {
  OPEN_FEATURE: 'Ouvrir une fonctionnalité',
  OPEN_SETTINGS: 'Ouvrir les paramètres',
  GO_HOME: 'Retour à l’accueil',
  SEARCH_QUERY: 'Recherche',
  STOP_LISTENING: 'Arrêter l’écoute',
  STOP_SPEAKING: 'Arrêter la lecture',
  CANCEL_CURRENT_VOICE_ACTION: 'Annuler',
  SWITCH_FOCUS: 'Mode Focus',
  SWITCH_DASHBOARD: 'Mode Tableau de bord',
  CAMERA_ON: 'Activer la caméra',
  CAMERA_OFF: 'Désactiver la caméra',
  EXPLAIN_FEATURE: 'Expliquer une fonctionnalité',
  UNKNOWN: 'Commande non reconnue',
  NEEDS_CLARIFICATION: 'Précision nécessaire',
};

interface Props {
  feedback: VoiceCommandFeedback;
  pendingConfirmation: PendingVoiceConfirmation | null;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry?: () => void;
  onSwitchToDictation?: () => void;
}

export default function VoiceCommandFeedbackPanel({ feedback, pendingConfirmation, onConfirm, onCancel, onRetry, onSwitchToDictation }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmationId = pendingConfirmation?.id;
  useEffect(() => {
    if (!confirmationId) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    cancelRef.current?.focus();
    return () => {
      if (document.activeElement !== document.body && !panel?.contains(document.activeElement)) return;
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else document.querySelector<HTMLElement>('.hud2-command-bar-mic')?.focus();
    };
  }, [confirmationId]);
  const candidates = 'candidates' in feedback.intent.parameters ? feedback.intent.parameters.candidates : [];
  const features = HELP_DIRECTORY.flatMap(category => category.items);
  const targetId = 'featureId' in feedback.intent.parameters ? feedback.intent.parameters.featureId : undefined;
  const safeTarget = features.find(item => item.feature === targetId)?.name;
  return (
    <div ref={panelRef} className="hud2-voice-feedback glass" role="region" aria-label="Résultat de la commande vocale" onKeyDown={event => {
      if (event.key === 'Escape' && pendingConfirmation) { event.preventDefault(); event.stopPropagation(); onCancel(); }
    }}>
      <p className="hud2-voice-feedback-row">
        <span className="hud2-voice-feedback-label">Heard :</span> « {containsSensitiveContent(feedback.heard) ? 'Contenu sensible masqué' : feedback.heard} »
      </p>
      <p className="hud2-voice-feedback-row">
        <span className="hud2-voice-feedback-label">Intent :</span> {INTENT_LABEL[feedback.intent.type] ?? feedback.intent.type}
      </p>
      {feedback.needsConfirmation && pendingConfirmation ? (
        <div className="hud2-voice-feedback-row hud2-voice-feedback-confirm">
          <p role="status" aria-live="polite">Confirmation requise</p>
          <dl className="voice-metadata"><dt>Action</dt><dd>{INTENT_LABEL[pendingConfirmation.intent.type]}</dd><dt>Cible</dt><dd>{safeTarget ?? 'À préciser'}</dd><dt>Expiration</dt><dd><time dateTime={new Date(pendingConfirmation.expiresAt).toISOString()}>{new Date(pendingConfirmation.expiresAt).toLocaleTimeString()}</time> — expire après 20 secondes</dd></dl>
          {candidates.length > 0 && <><p>Précisez l’une des destinations proposées dans une nouvelle commande :</p><ul>{candidates.map(candidate => {
            const feature = features.find(item => item.feature === candidate);
            return feature ? <li key={candidate}>{feature.name}</li> : null;
          })}</ul></>}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" className="hud2-command-bar-mic-mode-btn hud2-command-bar-mic-mode-btn--active" onClick={onConfirm}>
              Confirmer
            </button>
            <button ref={cancelRef} type="button" className="hud2-command-bar-mic-mode-btn" onClick={onCancel}>
              Annuler
            </button>
          </div>
        </div>
      ) : (
        feedback.action && (
          <p className="hud2-voice-feedback-row" role="status" aria-live="polite">
            <span className="hud2-voice-feedback-label">Action :</span> {feedback.intent.type === 'UNKNOWN' ? 'Commande non reconnue.' : feedback.intent.type === 'EXPLAIN_FEATURE' ? 'Cette commande n’est pas disponible.' : feedback.action.message}
          </p>
        )
      )}
      {feedback.intent.type === 'UNKNOWN' && <div className="voice-actions">
        {onRetry && <button type="button" onClick={onRetry}>Réessayer</button>}
        {onSwitchToDictation && <button type="button" onClick={onSwitchToDictation}>Passer en dictée</button>}
      </div>}
    </div>
  );
}
