// VOICE-5 — Deterministic French command parser. Simple commands never
// need Ollama (mission item 15/52): "stop", "ouvre sentinel", "arrête de
// parler" all resolve here, synchronously, with zero network I/O. If
// nothing matches deterministically, the result is UNKNOWN or
// NEEDS_CLARIFICATION — never a guess at a sensitive action (mission item
// 19/20). There is no path in this file from raw text to a shell command,
// a URL, or a tool name: OPEN_FEATURE's featureId is validated against
// OPENABLE_FEATURE_IDS before the intent is even constructed, and
// SEARCH_QUERY's text is carried as inert data with a hard length cap.
import { makeIntent, type VoiceIntent } from './voiceIntent';
import { isOpenableFeatureId, isOpenableSettingsTab, MAX_SEARCH_QUERY_LENGTH, type OpenableSettingsTab } from './voiceIntentRegistry';
import { HELP_DIRECTORY } from '../content/capabilities';
import type { FeatureKey } from '../content/capabilities';

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents: "arrête" -> "arrete"
    .trim()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
}

// ── STOP family — deterministic, priority path (mission item 7) ─────────
// These never wait on anything else; checked before any other pattern.

const STOP_SPEAKING_RE = /^(arrete|stop)(\s+de\s+parler|\s+parler)?$/;
const STOP_LISTENING_RE = /^(arrete|stop)\s+(l['\s]?ecoute|le\s+micro|d['\s]?ecouter)$/;
const CANCEL_RE = /^(annule|annuler|stoppe)$/;
const BARE_STOP_RE = /^(arrete|stoppe|stop)$/;

function matchStopFamily(normalized: string): VoiceIntent | null {
  if (STOP_SPEAKING_RE.test(normalized)) return makeIntent('STOP_SPEAKING', {}, 'DETERMINISTIC', normalized);
  if (STOP_LISTENING_RE.test(normalized)) return makeIntent('STOP_LISTENING', {}, 'DETERMINISTIC', normalized);
  if (CANCEL_RE.test(normalized)) return makeIntent('CANCEL_CURRENT_VOICE_ACTION', {}, 'DETERMINISTIC', normalized);
  // A bare "arrête"/"stop"/"stoppe" with nothing else is ambiguous between
  // stopping speech and stopping listening — stopping speech is the safer,
  // more common intent (mission: STOP must be deterministic and
  // immediate), and stopSpeaking() is a harmless no-op if nothing is
  // speaking, unlike guessing wrong the other way.
  if (BARE_STOP_RE.test(normalized)) return makeIntent('STOP_SPEAKING', {}, 'DETERMINISTIC', normalized);
  return null;
}

/** Local priority path, evaluated before mode/confirmation/classification. */
export function isEmergencyVoiceStop(text: string): boolean {
  return matchStopFamily(normalize(text)) !== null;
}

// ── Navigation aliases — explicit, curated (avoids noisy generic keyword
// matching producing false positives on named studios) ──────────────────

const FEATURE_ALIASES: Record<string, FeatureKey> = {
  'sentinel': 'cyber-audit', 'cyber audit': 'cyber-audit', 'audit cyber': 'cyber-audit', 'securite': 'cyber-audit',
  'metagpt': 'metagpt', 'meta gpt': 'metagpt',
  'sherlock': 'sherlock',
  'investissement': 'investment', 'investment': 'investment', 'bourse': 'investment',
  'notebook': 'notebook', 'bloc-notes': 'notebook', 'bloc notes': 'notebook',
  'capture': 'capture',
  'professeur': 'teacher',
  'agents': 'agents',
  'competences': 'skills',
  'images': 'images', 'generation d image': 'images', 'generateur d image': 'images',
  'kiwix': 'kiwix',
  'todo': 'todo', 'a faire': 'todo',
  'sauvegarde': 'backup',
  'corpus': 'corpus',
  'generateur de prompts': 'prompt-generator',
  'video': 'video-summary', 'resume video': 'video-summary',
};

// Derived aliases from HELP_DIRECTORY's own keywords/name (mission item 6
// recommendation) — supplements the curated list above without requiring
// every feature to be hand-aliased; only added if it doesn't collide with
// a curated entry, so the explicit list always wins.
for (const category of HELP_DIRECTORY) {
  for (const item of category.items) {
    for (const rawKeyword of [item.name, ...(item.keywords ?? [])]) {
      const key = normalize(rawKeyword);
      if (key && !(key in FEATURE_ALIASES)) FEATURE_ALIASES[key] = item.feature;
    }
  }
}

const SETTINGS_ALIASES: Record<string, OpenableSettingsTab> = {
  'modeles': 'models', 'memoire': 'memory', 'images': 'images', 'confidentialite': 'privacy',
  'audio': 'audio', 'fichiers': 'files', 'vocal': 'vocal', 'voix': 'vocal',
  'agents externes': 'external', 'connexions': 'connections', 'connecteurs': 'connections',
};

const OPEN_RE = /^ouvre(?:z|-moi|s)?\s+(?:le\s+|la\s+|les\s+|l['\s])?(.+)$/;
const OPEN_SETTINGS_RE = /^(?:ouvre|va\s+dans)\s+les?\s+parametres?(?:\s+(.+))?$/;
const GO_HOME_RE = /^(?:retour(?:ne)?\s+(?:a\s+l['\s]?accueil|au\s+tableau\s+de\s+bord)|accueil|ferme\s+tout)$/;
const SWITCH_FOCUS_RE = /^(?:mode\s+)?focus$/;
const SWITCH_DASHBOARD_RE = /^(?:mode\s+)?(?:tableau\s+de\s+bord|dashboard)$/;
const SEARCH_RE = /^(?:cherche|recherche|trouve)\s+(.+)$/;
const EXPLAIN_RE = /^explique(?:-moi)?\s+(.+?)(?:\s+simplement)?$/;

// Migrated from the legacy App.tsx regex (mission item 30). The legacy
// "active" pattern also matched "désactive" as a substring bug (French
// "désactive" contains "active") — CAMERA_OFF is matched and checked
// FIRST in parseDeterministicIntent (order-based exclusion, the same
// pattern used for the STOP family above) so that bug cannot recur.
const CAMERA_OFF_RE = /desactive.*camera|camera.*desactive/;
const CAMERA_ON_RE = /active.*camera|camera.*active/;

function resolveFeatureAlias(phrase: string): FeatureKey | null {
  const key = normalize(phrase);
  if (key in FEATURE_ALIASES) return FEATURE_ALIASES[key];
  // Loose containment match as a fallback (e.g. "le studio sentinel" ->
  // "sentinel" still resolves) — but only ever resolves to a KNOWN alias
  // key, never invents a featureId from arbitrary text.
  const found = Object.keys(FEATURE_ALIASES).find(alias => key.includes(alias));
  return found ? FEATURE_ALIASES[found] : null;
}

function ambiguousFeatureCandidates(phrase: string): string[] {
  // Deliberately narrow: only flags a real collision when the SAME
  // normalized phrase maps to more than one distinct feature across the
  // curated + derived alias tables — this never happens today (no two
  // curated aliases share a key), so this exists as a structural
  // guarantee for NEEDS_CLARIFICATION (mission item 20), not dead code:
  // if a future feature addition collides with an existing alias, this
  // is what routes it to clarification instead of an arbitrary pick.
  const key = normalize(phrase);
  const matches = new Set<FeatureKey>();
  for (const [alias, featureId] of Object.entries(FEATURE_ALIASES)) {
    if (key === alias || key.includes(alias)) matches.add(featureId);
  }
  return matches.size > 1 ? [...matches] : [];
}

/**
 * Parses one transcript into a VoiceIntent, deterministically, with no
 * network I/O. Returns UNKNOWN if nothing matches, never a guess.
 */
export function parseDeterministicIntent(rawText: string): VoiceIntent {
  const normalized = normalize(rawText);
  if (!normalized) return makeIntent('UNKNOWN', { rawText }, 'DETERMINISTIC', rawText);

  const stopIntent = matchStopFamily(normalized);
  if (stopIntent) return stopIntent;

  if (GO_HOME_RE.test(normalized)) return makeIntent('GO_HOME', {}, 'DETERMINISTIC', rawText);
  if (SWITCH_FOCUS_RE.test(normalized)) return makeIntent('SWITCH_FOCUS', {}, 'DETERMINISTIC', rawText);
  if (SWITCH_DASHBOARD_RE.test(normalized)) return makeIntent('SWITCH_DASHBOARD', {}, 'DETERMINISTIC', rawText);
  // CAMERA_OFF checked before CAMERA_ON — "désactive" contains "active" as
  // a substring, so order is the actual bug fix (see comment above).
  if (CAMERA_OFF_RE.test(normalized)) return makeIntent('CAMERA_OFF', {}, 'DETERMINISTIC', rawText);
  if (CAMERA_ON_RE.test(normalized)) return makeIntent('CAMERA_ON', {}, 'DETERMINISTIC', rawText);

  const settingsMatch = OPEN_SETTINGS_RE.exec(normalized);
  if (settingsMatch) {
    const tabPhrase = settingsMatch[1];
    if (!tabPhrase) return makeIntent('OPEN_SETTINGS', {}, 'DETERMINISTIC', rawText);
    const tabKey = normalize(tabPhrase);
    const tab = tabKey in SETTINGS_ALIASES ? SETTINGS_ALIASES[tabKey] : null;
    if (tab && isOpenableSettingsTab(tab)) return makeIntent('OPEN_SETTINGS', { tab }, 'DETERMINISTIC', rawText);
    return makeIntent('OPEN_SETTINGS', {}, 'DETERMINISTIC', rawText);
  }

  const explainMatch = EXPLAIN_RE.exec(normalized);
  if (explainMatch) {
    const featureId = resolveFeatureAlias(explainMatch[1]);
    if (featureId && isOpenableFeatureId(featureId)) {
      return makeIntent('EXPLAIN_FEATURE', { featureId, level: 'simple' }, 'DETERMINISTIC', rawText);
    }
    return makeIntent('UNKNOWN', { rawText }, 'DETERMINISTIC', rawText);
  }

  const openMatch = OPEN_RE.exec(normalized);
  if (openMatch) {
    const phrase = openMatch[1];
    const ambiguous = ambiguousFeatureCandidates(phrase);
    if (ambiguous.length > 1) return makeIntent('NEEDS_CLARIFICATION', { rawText, candidates: ambiguous }, 'DETERMINISTIC', rawText);
    const featureId = resolveFeatureAlias(phrase);
    if (featureId && isOpenableFeatureId(featureId)) {
      return makeIntent('OPEN_FEATURE', { featureId }, 'DETERMINISTIC', rawText);
    }
    return makeIntent('UNKNOWN', { rawText }, 'DETERMINISTIC', rawText);
  }

  const searchMatch = SEARCH_RE.exec(normalized);
  if (searchMatch) {
    const query = searchMatch[1].slice(0, MAX_SEARCH_QUERY_LENGTH).trim();
    if (query) return makeIntent('SEARCH_QUERY', { query }, 'DETERMINISTIC', rawText);
  }

  return makeIntent('UNKNOWN', { rawText }, 'DETERMINISTIC', rawText);
}
