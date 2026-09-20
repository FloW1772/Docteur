// VOICE-5 — Central Intent Registry. One place declares every voice
// intent's risk level, whether it needs confirmation, and its parameter
// shape — never regex scattered across components (mission item 8).
// Handlers are wired in voiceIntentExecutor.ts, not here, so this file
// stays a pure declaration with no App.tsx/React dependency.
import type { FeatureKey } from '../content/capabilities';
import { getRegisteredFeatures } from '../content/featureRegistry';
import type { RiskLevel, VoiceIntentType } from './voiceIntent';

export interface VoiceIntentDefinition {
  id: VoiceIntentType;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  description: string;
}

// LEVEL_0 = read/navigation, LEVEL_1 = local reversible low-risk action.
// VOICE-5 ships ONLY these two levels as executable (mission item 9) —
// no LEVEL_2 handler exists yet (nothing sensitive was found to be
// safely voice-triggerable per the VOICE-5 audit), and LEVEL_3 is refused
// unconditionally by voicePolicy.ts regardless of what this table says.
export const VOICE_INTENTS: Record<VoiceIntentType, VoiceIntentDefinition> = {
  OPEN_FEATURE:               { id: 'OPEN_FEATURE', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'Ouvrir une fonctionnalité existante (Studio, panneau).' },
  OPEN_SETTINGS:              { id: 'OPEN_SETTINGS', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'Ouvrir les paramètres, éventuellement un onglet précis.' },
  GO_HOME:                    { id: 'GO_HOME', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'Fermer les panneaux ouverts et revenir au tableau de bord.' },
  SEARCH_QUERY:               { id: 'SEARCH_QUERY', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'Lancer une recherche via la Console existante.' },
  STOP_LISTENING:             { id: 'STOP_LISTENING', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'Arrêter l’écoute du microphone.' },
  STOP_SPEAKING:              { id: 'STOP_SPEAKING', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'Arrêter la synthèse vocale en cours.' },
  CANCEL_CURRENT_VOICE_ACTION:{ id: 'CANCEL_CURRENT_VOICE_ACTION', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'Annuler la confirmation vocale en attente.' },
  SWITCH_FOCUS:               { id: 'SWITCH_FOCUS', riskLevel: 'LEVEL_1', requiresConfirmation: false, description: 'Passer le Command Center en mode Focus.' },
  SWITCH_DASHBOARD:           { id: 'SWITCH_DASHBOARD', riskLevel: 'LEVEL_1', requiresConfirmation: false, description: 'Passer le Command Center en mode Dashboard.' },
  CAMERA_ON:                  { id: 'CAMERA_ON', riskLevel: 'LEVEL_1', requiresConfirmation: false, description: 'Activer la caméra de reconnaissance de gestes (migré depuis le regex historique, mission item 30).' },
  CAMERA_OFF:                 { id: 'CAMERA_OFF', riskLevel: 'LEVEL_1', requiresConfirmation: false, description: 'Désactiver la caméra de reconnaissance de gestes.' },
  EXPLAIN_FEATURE:            { id: 'EXPLAIN_FEATURE', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'NOT IMPLEMENTED — aucun Local Explainer n’existe encore.' },
  UNKNOWN:                    { id: 'UNKNOWN', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'Commande non reconnue.' },
  NEEDS_CLARIFICATION:        { id: 'NEEDS_CLARIFICATION', riskLevel: 'LEVEL_0', requiresConfirmation: false, description: 'Plusieurs destinations possibles — préciser laquelle.' },
};

// The allowlist for OPEN_FEATURE/OPEN_SETTINGS: reuses capabilities.ts's
// FeatureKey + HELP_DIRECTORY (mission item 6's own recommendation) so a
// voice intent can never reference a feature that doesn't have a real,
// audited opener in App.tsx. No parallel "second list that could rot."
export const OPENABLE_FEATURE_IDS: ReadonlySet<FeatureKey> = new Set(
  getRegisteredFeatures().map(definition => definition.id as FeatureKey),
);

export function isOpenableFeatureId(value: string): value is FeatureKey {
  return OPENABLE_FEATURE_IDS.has(value as FeatureKey);
}

const SETTINGS_TABS = ['models', 'memory', 'images', 'privacy', 'audio', 'files', 'vocal', 'external', 'connections'] as const;
export type OpenableSettingsTab = typeof SETTINGS_TABS[number];

export function isOpenableSettingsTab(value: string): value is OpenableSettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(value);
}

export const MAX_SEARCH_QUERY_LENGTH = 500;
