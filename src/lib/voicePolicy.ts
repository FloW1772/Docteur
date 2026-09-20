// VOICE-5 — Voice Policy: the single gate every voice intent must pass
// through before any handler runs. No UI component may call a voice
// intent handler directly (mission item 10) — everything goes through
// authorizeVoiceIntent() here.
import { VOICE_INTENTS } from './voiceIntentRegistry';
import type { VoiceIntent, VoiceIntentType } from './voiceIntent';
import { getFeatureDefinition } from '../content/featureRegistry';

export type VoicePolicyDecision = 'ALLOW' | 'CONFIRM' | 'DENY';

export interface VoicePolicyResult {
  decision: VoicePolicyDecision;
  reason: string;
}

// LEVEL_3 is refused unconditionally here, independent of whatever the
// registry table says for any given intent id — this is the actual
// enforcement point (mission item 9: "LEVEL_3: DENY BY DEFAULT"), not a
// convention the registry could accidentally violate. VOICE-5 defines no
// LEVEL_3 intent at all, so this branch cannot currently be hit by a
// legitimate intent — it exists as a structural guarantee for any future
// intent addition, tested explicitly (see test file).
function denyLevel3(): VoicePolicyResult {
  return { decision: 'DENY', reason: 'LEVEL_3 actions are denied by default in VOICE-5 — no security-sensitive or destructive action can be triggered by voice yet.' };
}

/**
 * Authorizes a parsed VoiceIntent. Returns ALLOW/CONFIRM/DENY with a
 * structured reason — never a bare boolean, so a denial is always
 * explainable (mission: "avec raison structurée").
 */
export function authorizeVoiceIntent(intent: VoiceIntent): VoicePolicyResult {
  const definition = VOICE_INTENTS[intent.type];
  if (!definition) return { decision: 'DENY', reason: `Unknown intent type: ${intent.type}` };

  if (intent.type === 'UNKNOWN') return { decision: 'DENY', reason: 'Commande non reconnue.' };
  if (intent.type === 'NEEDS_CLARIFICATION') return { decision: 'CONFIRM', reason: 'Plusieurs destinations possibles — clarification requise.' };

  if (intent.type === 'EXPLAIN_FEATURE') {
    const featureId = String((intent.parameters as { featureId?: string }).featureId ?? '');
    const feature = featureId ? getFeatureDefinition(featureId) : null;

    if (!feature) {
      return { decision: 'DENY', reason: `La fonctionnalité « ${featureId || 'inconnue'} » n’est pas référencée dans le Feature Registry.` };
    }

    if (feature.status === 'DRAFT' || feature.status === 'UNVERIFIED' || !feature.available || !feature.verified) {
      return { decision: 'DENY', reason: `La fonctionnalité « ${feature.name} » n’est pas encore certifiée comme explicable.` };
    }

    return { decision: 'ALLOW', reason: `EXPLAIN_FEATURE est autorisé pour ${feature.name} — le Local Explainer lit la définition centrale de la fonctionnalité.` };
  }

  if (definition.riskLevel === 'LEVEL_3') return denyLevel3();

  if (definition.riskLevel === 'LEVEL_2' || definition.requiresConfirmation) {
    return { decision: 'CONFIRM', reason: `${intent.type} is LEVEL_2 and requires explicit confirmation.` };
  }

  // LEVEL_0 / LEVEL_1 — allowed outright, matching the mission's "VOICE-5
  // peut implémenter réellement LEVEL_0 et LEVEL_1" scope.
  return { decision: 'ALLOW', reason: `${intent.type} is ${definition.riskLevel}.` };
}

// ── Confirmation model (mission items 21-25) ────────────────────────────

export interface PendingVoiceConfirmation {
  id: string;
  intent: VoiceIntent;
  createdAt: number;
  expiresAt: number;
  /** Binds the confirmation to the EXACT intent+parameters it was created
   * for (mission item 22) — a stringified, order-independent hash of
   * type+parameters, so "oui" spoken later can never confirm a
   * DIFFERENT intent/target that happens to be pending at the same time
   * (there is only ever one pending confirmation at a time in VOICE-5,
   * but the hash still guards against a stale reference being reused). */
  contextHash: string;
}

export const CONFIRMATION_TTL_MS = 20_000; // 20s — short, documented (mission item 23)

// Small, explicit, case-insensitive confirm/cancel vocabularies (mission
// item 24) — a bare "oui" is intentionally NOT accepted; every voice
// intent requiring confirmation in VOICE-5 is LEVEL_2, and the mission
// explicitly asks to avoid a stray "oui" confirming a sensitive action.
const CONFIRM_WORDS = ['confirme', 'confirmer', 'je confirme'];
const CANCEL_WORDS = ['annule', 'annuler', 'non'];

function normalizeWord(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/[.!?]+$/g, '');
}

export function isConfirmWord(text: string): boolean {
  return CONFIRM_WORDS.includes(normalizeWord(text));
}

export function isCancelWord(text: string): boolean {
  return CANCEL_WORDS.includes(normalizeWord(text));
}

export function computeContextHash(type: VoiceIntentType, parameters: unknown): string {
  return `${type}:${JSON.stringify(parameters, Object.keys(parameters as Record<string, unknown>).sort())}`;
}

export function createPendingConfirmation(intent: VoiceIntent, id: string, now: number = Date.now()): PendingVoiceConfirmation {
  return {
    id,
    intent,
    createdAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
    contextHash: computeContextHash(intent.type, intent.parameters),
  };
}

export type ConfirmationOutcome =
  | { status: 'CONFIRMED'; intent: VoiceIntent }
  | { status: 'CANCELLED' }
  | { status: 'EXPIRED' }
  | { status: 'MISMATCHED_TARGET' }
  | { status: 'NOT_A_CONFIRMATION_WORD' };

/**
 * Resolves a spoken reply against a pending confirmation. `now` is
 * injectable for deterministic tests. A reply that doesn't match the
 * confirm/cancel vocabulary at all is NOT_A_CONFIRMATION_WORD — the
 * caller decides what to do with it (e.g. treat as a new command).
 */
export function resolvePendingConfirmation(
  pending: PendingVoiceConfirmation | null,
  reply: string,
  now: number = Date.now(),
): ConfirmationOutcome {
  if (!pending) return { status: 'NOT_A_CONFIRMATION_WORD' };
  if (isCancelWord(reply)) return { status: 'CANCELLED' };
  if (!isConfirmWord(reply)) return { status: 'NOT_A_CONFIRMATION_WORD' };
  if (now >= pending.expiresAt) return { status: 'EXPIRED' };
  const currentHash = computeContextHash(pending.intent.type, pending.intent.parameters);
  if (currentHash !== pending.contextHash) return { status: 'MISMATCHED_TARGET' };
  return { status: 'CONFIRMED', intent: pending.intent };
}
