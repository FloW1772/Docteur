// VOICE-5 — Execution layer. executeVoiceIntent() switches on
// intent.type (a closed, compiled enum — never a model-chosen free
// string, mission item 34) and calls ONLY the application callbacks
// passed in via `actions`. There is no eval/Function/exec/spawn/shell
// anywhere in this file, and no fetch/window.open of user-controlled
// text (mission items 32/33) — every branch calls a typed function the
// caller (App.tsx) already owns and has already audited.
import type { VoiceIntent } from './voiceIntent';
import type { FeatureKey } from '../content/capabilities';
import type { OpenableSettingsTab } from './voiceIntentRegistry';

export interface VoiceIntentActions {
  openFeature: (featureId: FeatureKey) => void;
  openSettings: (tab?: OpenableSettingsTab) => void;
  goHome: () => void;
  runSearchQuery: (query: string) => void;
  stopListening: () => void;
  stopSpeaking: () => void;
  cancelPendingVoiceAction: () => void;
  switchToFocus: () => void;
  switchToDashboard: () => void;
  cameraOn: () => void;
  cameraOff: () => void;
}

export interface VoiceIntentExecutionResult {
  ok: boolean;
  message: string;
}

/**
 * Executes an ALREADY-AUTHORIZED intent (the caller must have already
 * gone through authorizeVoiceIntent() and received ALLOW, or resolved a
 * CONFIRM to CONFIRMED — this function does not re-check policy, by
 * design, so it can be a pure dispatch table). UNKNOWN/
 * NEEDS_CLARIFICATION/EXPLAIN_FEATURE never reach here in practice since
 * voicePolicy.ts denies/confirms them, but are handled defensively
 * anyway rather than falling through to an unhandled case.
 */
export function executeVoiceIntent(intent: VoiceIntent, actions: VoiceIntentActions): VoiceIntentExecutionResult {
  switch (intent.type) {
    case 'OPEN_FEATURE': {
      const { featureId } = intent.parameters as { featureId: FeatureKey };
      actions.openFeature(featureId);
      return { ok: true, message: `Ouverture de ${featureId}.` };
    }
    case 'OPEN_SETTINGS': {
      const { tab } = intent.parameters as { tab?: OpenableSettingsTab };
      actions.openSettings(tab);
      return { ok: true, message: 'Paramètres ouverts.' };
    }
    case 'GO_HOME':
      actions.goHome();
      return { ok: true, message: 'Retour à l’accueil.' };
    case 'SEARCH_QUERY': {
      const { query } = intent.parameters as { query: string };
      actions.runSearchQuery(query);
      return { ok: true, message: 'Recherche lancée.' };
    }
    case 'STOP_LISTENING':
      actions.stopListening();
      return { ok: true, message: 'Écoute arrêtée.' };
    case 'STOP_SPEAKING':
      actions.stopSpeaking();
      return { ok: true, message: 'Lecture arrêtée.' };
    case 'CANCEL_CURRENT_VOICE_ACTION':
      // Reaching here (rather than being intercepted earlier by
      // useVoiceCommandPipeline's own pending-confirmation check) means
      // there was nothing pending to cancel.
      actions.cancelPendingVoiceAction();
      return { ok: true, message: 'Rien à annuler.' };
    case 'SWITCH_FOCUS':
      actions.switchToFocus();
      return { ok: true, message: 'Mode Focus activé.' };
    case 'SWITCH_DASHBOARD':
      actions.switchToDashboard();
      return { ok: true, message: 'Mode Tableau de bord activé.' };
    case 'CAMERA_ON':
      actions.cameraOn();
      return { ok: true, message: 'Caméra activée.' };
    case 'CAMERA_OFF':
      actions.cameraOff();
      return { ok: true, message: 'Caméra désactivée.' };
    case 'EXPLAIN_FEATURE':
      return { ok: false, message: 'Cette fonctionnalité n’est pas encore disponible.' };
    case 'UNKNOWN':
      return { ok: false, message: 'Je n’ai pas reconnu cette commande.' };
    case 'NEEDS_CLARIFICATION':
      return { ok: false, message: 'Plusieurs destinations sont possibles — précisez laquelle.' };
    default: {
      const exhaustive: never = intent.type;
      return { ok: false, message: `Unhandled intent: ${String(exhaustive)}` };
    }
  }
}
