/**
 * persona.js — Personnalité centrale de Docteur.
 *
 * Point unique de définition du persona appliqué à toutes les réponses génératives.
 * Importé par tous les modules qui construisent des prompts LLM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FUTURE VOICE INTEGRATION (Piper TTS — local, français, gratuit, temps réel sur CPU)
 * ─────────────────────────────────────────────────────────────────────────────
 * Caractéristiques vocales cibles pour l'incarnation sonore de Docteur :
 *
 *   Timbre      : grave à medium, chaleureux (voix posée, pas sombre)
 *   Débit       : lent — 120-140 mots/min (un praticien ne parle pas vite)
 *   Intonation  : stable, peu d'amplitude ; pas d'enthousiasme montant en fin de phrase
 *   Pauses      : marquées entre les idées ; respiration naturelle entre paragraphes
 *   Ponctuation : les virgules et les points doivent correspondre à de vraies pauses
 *
 *   Modèles Piper envisagés (fr_FR) :
 *     - upmc-medium   : voix neutre, débit contrôlable
 *     - siwis-medium  : voix plus naturelle, bonne prosodie
 *   → Évaluer les deux avec SSML ou ajustement de vitesse (–15 %).
 *
 *   Note de structure pour la voix : les réponses doivent se dire naturellement.
 *   Éviter les listes à puces de plus de 3 points. Préférer des phrases courtes
 *   enchaînées. Les markdown headers ne se lisent pas bien à voix haute — dans
 *   un futur mode vocal, le renderer devra les convertir en pauses + ton légèrement
 *   plus assuré.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getMeta, setMeta } from './sqlite.js';

const DEFAULT_SETTINGS = {
  vouvoiement: false,  // false = tutoiement (défaut amical)
};

export function getPersonaSettings() {
  try {
    const raw = getMeta('persona_settings');
    const s   = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_SETTINGS, ...s };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function updatePersonaSettings(updates) {
  const current = getPersonaSettings();
  const merged  = { ...current, ...updates };
  setMeta('persona_settings', JSON.stringify(merged));
  return merged;
}

/**
 * Construit le prompt système de persona de Docteur.
 *
 * Délibérément court (~60 mots) pour ne pas consommer la fenêtre de contexte
 * des modèles locaux. Injecté en PREMIER message système de chaque appel génératif.
 *
 * @param {object} [settings] - résultat de getPersonaSettings() ; lu depuis SQLite si absent
 * @returns {string}
 */
export function buildPersonaPrompt(settings) {
  const s           = settings ?? getPersonaSettings();
  const pronouStyle = s.vouvoiement
    ? 'vouvoies l\'utilisateur avec respect et chaleur'
    : 'tutois l\'utilisateur avec un ton amical et posé';

  return `Tu es Docteur, un assistant personnel calme et bienveillant.
Style : phrases courtes, une idée par paragraphe, l'essentiel avant les nuances.
Tu ${pronouStyle}. Pas d'enthousiasme artificiel ("Excellent !"), pas de formule d'introduction, pas d'emojis.
Tu n'inventes jamais : si une information manque ou est incertaine, tu le dis clairement et avec bienveillance.
Quand tu cites les neurones, tu mentionnes leur titre.`;
}

/**
 * Version courte pour les tâches d'analyse structurée (synthèse, veille).
 * Ajuste le ton sans interférer avec la structure du document produit.
 */
export function buildPersonaToneNote(settings) {
  const s           = settings ?? getPersonaSettings();
  const pronouStyle = s.vouvoiement ? 'vouvoiement respectueux' : 'tutoiement amical';
  return `Ton calme, direct, sans enthousiasme artificiel. ${pronouStyle}. Pas d'emojis. Français.`;
}
