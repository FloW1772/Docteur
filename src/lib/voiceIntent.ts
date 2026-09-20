// VOICE-5 — Intent Layer core types. A voice transcript in COMMAND mode is
// never executed directly; it is first parsed into one of these strict,
// compiler-checked intent shapes, then gated by voicePolicy.ts, then
// dispatched to a known application function (voiceIntentExecutor.ts).
// There is no path from raw text to a shell command, an HTTP call, or an
// arbitrary tool name anywhere in this layer.

/** How an intent was produced. Confidence as a float is deliberately
 * avoided (mission: "confidence uniquement si réellement justifiée") —
 * a regex match IS certain, and VOICE-5 has no calibrated model that
 * would make a numeric confidence meaningful. MODEL_ASSISTED exists as a
 * documented extension point; VOICE-5 ships it as NOT_IMPLEMENTED so the
 * type is future-proof (see mission item 16) without pretending Ollama
 * classification exists yet (item 18: cloud intent OFF, item 17: no new
 * local structured-JSON endpoint added this phase). */
export type MatchType = 'DETERMINISTIC' | 'MODEL_ASSISTED' | 'UNKNOWN';

/** LEVEL_0: read/navigation. LEVEL_1: local, reversible, low-risk action.
 * LEVEL_2: sensitive — requires explicit confirmation. LEVEL_3:
 * destructive/security-sensitive — denied by default, no VOICE-5 handler
 * may claim this level (see voicePolicy.ts's authorizeVoiceIntent, which
 * refuses LEVEL_3 unconditionally regardless of registry contents). */
export type RiskLevel = 'LEVEL_0' | 'LEVEL_1' | 'LEVEL_2' | 'LEVEL_3';

export type VoiceIntentType =
  | 'OPEN_FEATURE'
  | 'OPEN_SETTINGS'
  | 'GO_HOME'
  | 'SEARCH_QUERY'
  | 'STOP_LISTENING'
  | 'STOP_SPEAKING'
  | 'CANCEL_CURRENT_VOICE_ACTION'
  | 'SWITCH_FOCUS'
  | 'SWITCH_DASHBOARD'
  | 'CAMERA_ON'
  | 'CAMERA_OFF'
  | 'EXPLAIN_FEATURE'
  | 'UNKNOWN'
  | 'NEEDS_CLARIFICATION';

export interface VoiceIntentParameters {
  OPEN_FEATURE: { featureId: string };
  OPEN_SETTINGS: { tab?: string };
  GO_HOME: Record<string, never>;
  SEARCH_QUERY: { query: string };
  STOP_LISTENING: Record<string, never>;
  STOP_SPEAKING: Record<string, never>;
  CANCEL_CURRENT_VOICE_ACTION: Record<string, never>;
  SWITCH_FOCUS: Record<string, never>;
  SWITCH_DASHBOARD: Record<string, never>;
  CAMERA_ON: Record<string, never>;
  CAMERA_OFF: Record<string, never>;
  EXPLAIN_FEATURE: { featureId: string; level: 'simple' };
  UNKNOWN: { rawText: string };
  NEEDS_CLARIFICATION: { rawText: string; candidates: string[] };
}

export interface VoiceIntent<T extends VoiceIntentType = VoiceIntentType> {
  type: T;
  parameters: VoiceIntentParameters[T];
  matchType: MatchType;
  /** The exact transcript this intent was parsed from — kept for the UI's
   * "Heard / Intent / Action" feedback panel and minimal history, never
   * for re-interpretation downstream. */
  source: string;
}

export function makeIntent<T extends VoiceIntentType>(
  type: T,
  parameters: VoiceIntentParameters[T],
  matchType: MatchType,
  source: string,
): VoiceIntent<T> {
  return { type, parameters, matchType, source };
}
