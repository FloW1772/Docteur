// Companion V1 — COMP-6A UI contracts + pure view model. No React, no network, no wiring.
// The UI is never a security authority: every decision is re-made by the COMP-5 framework and the human approval
// channel on the server. This file decides wording and what the UI enables; anything unknown is shown as unknown and
// enables nothing (fail-closed). The ONLY place an approval intent is built is buildApprovalIntent(), and only from a
// trusted pointer / keyboard event.

export type PrivacyScope = 'PRIVATE_LOCAL' | 'LOCAL_SHARED_CONTEXT' | 'CLOUD_ALLOWED' | 'NEVER_CLOUD';
export type ConfirmationKind = 'NONE' | 'SIMPLE_CONFIRM' | 'TYPED_CONFIRM' | 'REINFORCED_CONFIRM';
export type ProposalUiState = 'PENDING' | 'APPROVED' | 'EXECUTING' | 'EXECUTED' | 'FAILED' | 'INCOMPLETE' | 'CANCELLED' | 'EXPIRED' | 'REJECTED' | 'SUPERSEDED' | 'UNKNOWN';
export type ModelUiStatus = 'LOCAL_AVAILABLE' | 'LOCAL_UNAVAILABLE' | 'NOT_RUN' | 'RUNNING' | 'TIMEOUT' | 'CANCELLED' | 'ERROR';
export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'muted' | 'model';
export type LocalMutationActionId = 'COMPANION.PREFERENCES.UPDATE' | 'COMPANION.MEMORY.SET_ENABLED' | 'COMPANION.MEMORY.SET_PRIVACY' | 'COMPANION.MEMORY.FORGET';

export interface CompanionPreferences { memoryEnabled: boolean; sessionMemoryEnabled: boolean; proposalEnabled: boolean; cloudContextEnabled: boolean }
export interface CompanionStatusDto {
  activation: string; schemaVersion: number; preferences: CompanionPreferences;
  model: { status: string; code: string | null; at: string | null; source: string };
  /** Boot reason, sent by the route when no Companion store is open (e.g. COMPANION_HUMAN_ACTIVATION_REQUIRED). */
  disabledReason?: string | null;
}
export interface Freshness { confirmedAt?: string | null; lastPresentedAt?: string | null; validFrom?: string | null; validTo?: string | null; expiresAt?: string | null; reviewAfter?: string | null }
export interface MemoryRowDto {
  memoryId: string; category: string | null; state: string; conflict: boolean; privacyScope: string; companionEnabled: boolean; sensitivity: string | null;
  summary: string | null; summaryWithheld: string | null; reviewRequired: boolean; freshness: Freshness | null;
  provenance: { origin: string; sourceType: string; proposalId: string | null; evidenceCount: number } | null;
}
export interface MemoryExplainDto {
  memoryId: string; state: string; conflict: string; durableOwner: string; nb5Status: string | null; sensitivity: string | null; privacyScope: string | null;
  companionEnabled: boolean | null; category: string | null; freshness: Freshness | null;
  provenance: { origin: string; sourceType: string; proposalId: string | null; sessionId: string | null; evidenceRefs: { kind: string; ref: string }[]; sourceReference: { kind: string; ref: string } | null; derivedBy: unknown } | null;
}
export interface ContextExplainDto {
  requestId: string; found: boolean; usedAt?: string; stateAsOf?: string; contextUsed: { itemId: string; kind: string }[]; memories: MemoryExplainDto[];
  typeCounts?: Record<string, number>; privacyCounts?: Record<string, number>; truncationCount?: number;
}
export interface PreviewDto {
  action?: string; actionId?: string; target?: Record<string, unknown>; summary?: string; changes?: { field: string; from: unknown; to: unknown }[]; unchanged?: string[];
  effects?: string[]; reversible?: string; privacyImpact?: { level?: string; neverCloudRelease?: boolean }; confirmation?: { level?: string; phrase?: string };
  pointOfNoReturn?: string; parameters?: Record<string, unknown>; memory?: { memoryId?: string; state?: string; category?: string | null; privacyScope?: string; companionEnabled?: boolean | null; excerpt?: string | null; excerptWithheld?: string | null };
  readOnly?: boolean; sideEffectsBeforeApproval?: string; [key: string]: unknown;
}
export interface ProposalDto {
  proposalId: string; actionId: string; actionVersion: number; riskClass: string; parameters: Record<string, unknown>; target: Record<string, unknown>;
  digest: string; digestShort: string; proposedBy: string; status: string; resultCode: string | null; createdAt: string; expiresAt: string; expired: boolean;
  previewStale: boolean; preview: PreviewDto | null; idempotency: string; confirmationKind: string;
}
export interface ChallengeDto {
  nonce: string; uiSessionId: string; proposalId: string; actionId: string; actionDigest: string; actionDigestShort: string; previewSha256: string;
  confirmationKind: string; typedPhrase: string | null; requiredAcknowledgements: string[]; issuedAt: string; expiresAt: string;
}
export interface ApprovalDto { approvalId: string; proposalId: string; approvedBy: string; approvedAt: string; expiresAt: string; singleUse: boolean }
export interface ActionResultDto {
  actionId: string; proposalId: string | null; approvalId: string | null; status: string; resultCode: string; startedAt: string; completedAt: string; durationMs: number;
  resultMetadata: Record<string, unknown> | null; sideEffects: { kind: string; transactional?: boolean; [k: string]: unknown }[]; effectApplied: string;
  cancellation: { requested: boolean; honored?: boolean; stage?: string | null }; automaticRetries: number;
}
/** What the UI sends after a trusted gesture. Exactly these fields: the server refuses any other one. */
export interface HumanApprovalIntent {
  proposalId: string; actionDigest: string; confirmationKind: 'SIMPLE_CONFIRM' | 'TYPED_CONFIRM' | 'REINFORCED_CONFIRM'; uiSessionId: string; nonce: string; createdAt: string;
  gesture: { kind: 'POINTER' | 'KEYBOARD'; trusted: true }; typedPhrase?: string; acknowledgements?: string[];
}
export class CompanionUiError extends Error {
  code: string; reason: string | null;
  constructor(code: string, message: string, reason: string | null = null) { super(message); this.name = 'CompanionUiError'; this.code = code; this.reason = reason; }
}
/** The UI's only door to the Companion. COMP-6 implements it over the local API; COMP-6A tests use fixtures / in-process adapters. */
export interface CompanionUiPort {
  openUiSession(): Promise<{ uiSessionId: string }>;
  closeUiSession?(uiSessionId: string): Promise<boolean>;
  getStatus(): Promise<CompanionStatusDto>;
  listMemories(): Promise<MemoryRowDto[]>;
  explainMemory(memoryId: string): Promise<MemoryExplainDto>;
  explainContext(requestId: string): Promise<ContextExplainDto>;
  propose(actionId: LocalMutationActionId, parameters: Record<string, unknown>): Promise<ProposalDto>;
  proposeFromModel(rawOutput: unknown): Promise<ProposalDto>;
  getProposal(proposalId: string): Promise<ProposalDto>;
  /** [COMP-REMED-1] Open proposals known to the backend (e.g. from the model), so the panel can show them. */
  listProposals?(): Promise<ProposalDto[]>;
  issueChallenge(uiSessionId: string, proposalId: string): Promise<ChallengeDto>;
  submitIntent(intent: HumanApprovalIntent): Promise<ApprovalDto>;
  /** A LOCAL_MUTATION needs its approvalId; a READ_ONLY proposal runs with its proposalId (no approval, digest-checked). */
  execute(req: { actionId: string; parameters: Record<string, unknown>; approvalId?: string | null; proposalId?: string | null; executionId: string }): Promise<ActionResultDto>;
  abortExecution(executionId: string): Promise<boolean>;
  reject(proposalId: string): Promise<ProposalDto>;
  cancel(proposalId: string): Promise<ProposalDto>;
  /** [COMP-9 CHAT] One bounded local answer (POST /companion/answers). Aborting `signal` closes the request, which
   *  aborts the server-side context assembly and the local model call. Optional: fixtures without it show no chat. */
  answer?(text: string, options?: { signal?: AbortSignal }): Promise<AnswerDto>;
}

// ── [COMP-9 CHAT] answer contract (cortex-server/src/lib/companion-conversation.js) ──
export interface AnswerKgProvenanceDto { itemId: string; sourceRef: string | null; evidenceRefs: { kind: string; ref: string }[]; authority: string }
export interface AnswerDto {
  requestId: string; text: string; truncated: boolean; local: boolean; model: string | null; durationMs: number | null; contextItems: number | null;
  /** The model also returned an action proposal: it was NOT registered (the answer path creates no action). */
  actionProposalIgnored: boolean;
  diagnostics: { kgContextUsed: boolean; kg: { gate: string; state: string; status: string; authority: string; retrieved: number; used: number; dropped: number; chars: number; excluded: string[] } };
  kgProvenance: AnswerKgProvenanceDto[];
}

// ── privacy ──
export const PRIVACY_SCOPES: readonly PrivacyScope[] = Object.freeze(['PRIVATE_LOCAL', 'LOCAL_SHARED_CONTEXT', 'CLOUD_ALLOWED', 'NEVER_CLOUD']);
const PRIVACY: Record<PrivacyScope, { label: string; tone: Tone; description: string }> = {
  PRIVATE_LOCAL: { label: 'PRIVATE_LOCAL', tone: 'info', description: 'Privé, sur cet ordinateur uniquement.' },
  LOCAL_SHARED_CONTEXT: { label: 'LOCAL_SHARED_CONTEXT', tone: 'info', description: 'Local, partageable avec les autres modules de Docteur.' },
  CLOUD_ALLOWED: { label: 'CLOUD_ALLOWED', tone: 'warn', description: 'Peut être envoyé à un service cloud si le cloud est activé et autorisé.' },
  NEVER_CLOUD: { label: 'NEVER_CLOUD — jamais envoyé au cloud', tone: 'danger', description: 'Verrouillé : ne quitte jamais cet ordinateur, quels que soient les réglages cloud.' },
};
export function privacyBadge(scope: unknown): { scope: string; label: string; tone: Tone; description: string; known: boolean } {
  if (typeof scope === 'string' && Object.prototype.hasOwnProperty.call(PRIVACY, scope)) return { scope, known: true, ...PRIVACY[scope as PrivacyScope] };
  return { scope: 'UNKNOWN', known: false, label: 'PORTÉE INCONNUE', tone: 'danger', description: 'Portée de confidentialité inconnue : traitée comme non partageable.' };
}
/** Privacy change direction, for the UI only (the server decides). */
export function privacyChange(from: unknown, to: unknown): 'NONE' | 'TIGHTENS' | 'RELAXES_LOCAL' | 'LOOSENS_CLOUD' | 'UNKNOWN' {
  const rank: Record<string, number> = { NEVER_CLOUD: 0, PRIVATE_LOCAL: 1, LOCAL_SHARED_CONTEXT: 2, CLOUD_ALLOWED: 3 };
  if (typeof from !== 'string' || typeof to !== 'string' || !(from in rank) || !(to in rank)) return 'UNKNOWN';
  if (from === to) return 'NONE';
  if (from === 'NEVER_CLOUD' || to === 'CLOUD_ALLOWED') return 'LOOSENS_CLOUD';
  return rank[to] > rank[from] ? 'RELAXES_LOCAL' : 'TIGHTENS';
}

// ── memory ──
const MEMORY_STATE: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'ok' }, DISPUTED: { label: 'En conflit', tone: 'warn' }, SUPERSEDED: { label: 'Remplacée', tone: 'muted' },
  INVALIDATED: { label: 'Invalidée', tone: 'muted' }, ARCHIVED: { label: 'Archivée', tone: 'muted' }, MISSING: { label: 'Absente de Docteur Memory', tone: 'danger' },
};
export function memoryStateLabel(state: unknown): { label: string; tone: Tone; known: boolean } {
  return typeof state === 'string' && MEMORY_STATE[state] ? { ...MEMORY_STATE[state], known: true } : { label: 'État inconnu', tone: 'danger', known: false };
}
const ORIGIN: Record<string, string> = { USER_EXPLICIT: 'Dit par vous', USER_CONFIRMED: 'Proposé puis confirmé par vous', DERIVED: 'Déduit (non confirmé)', IMPORTED: 'Importé (à revoir)' };
export const originLabel = (o: unknown): string => (typeof o === 'string' && ORIGIN[o]) || 'Origine inconnue';
export const userConfirmed = (o: unknown): boolean => o === 'USER_EXPLICIT' || o === 'USER_CONFIRMED';
const CATEGORY: Record<string, string> = { USER_PREFERENCE: 'Préférence', USER_FACT: 'Fait personnel' };
export const categoryLabel = (c: unknown): string => (typeof c === 'string' && CATEGORY[c]) || 'Catégorie inconnue';

/**
 * What the not-active notice says, from the typed status only. Certification and human activation are distinct: the
 * Companion is certified (companion-boot.js COMPANION_CERTIFIED) and stays off until a person activates it; a store
 * that failed to open is NOT "waiting for activation"; an unknown state claims nothing.
 */
export function activationNotice(status: Pick<CompanionStatusDto, 'activation' | 'disabledReason'> | null | undefined): { kind: 'ACTIVE' | 'AWAITING_ACTIVATION' | 'UNAVAILABLE' | 'UNKNOWN'; text: string | null } {
  if (status?.activation === 'ACTIVE') return { kind: 'ACTIVE', text: null };
  const reason = typeof status?.disabledReason === 'string' && status.disabledReason ? status.disabledReason : null;
  const quiet = 'Il ne lit, ne mémorise et n’agit pas de lui-même tant qu’il reste désactivé.';
  if (status?.activation === 'DISABLED_PENDING_HUMAN_ACTIVATION' && (reason === null || reason === 'COMPANION_HUMAN_ACTIVATION_REQUIRED')) {
    return { kind: 'AWAITING_ACTIVATION', text: `Le Companion est certifié mais pas encore activé : il ne démarre qu’après une activation explicite de votre part. ${quiet}` };
  }
  if (reason !== null) return { kind: 'UNAVAILABLE', text: `Le Companion est désactivé : il n’a pas pu être ouvert (${reason.slice(0, 60)}). ${quiet}` };
  return { kind: 'UNKNOWN', text: `Le Companion n’est pas activé (${String(status?.activation ?? 'état inconnu').slice(0, 60)}). ${quiet}` };
}

/** Global memory OFF: what is off, what stays available. */
export function memoryOffContract(p: CompanionPreferences | null | undefined) {
  const off = !p || p.memoryEnabled !== true;
  return {
    off,
    durableRetrieval: off ? 'OFF' : 'ON', sessionMemory: off || p?.sessionMemoryEnabled !== true ? 'OFF' : 'ON',
    proposals: off || p?.proposalEnabled !== true ? 'OFF' : 'ON', contextMemory: off ? 'OFF' : 'ON',
    forgetAvailable: true, cloudContext: !off && p?.cloudContextEnabled === true ? 'ON' : 'OFF',
  } as const;
}

// ── model ──
const MODEL: Record<ModelUiStatus, { label: string; tone: Tone }> = {
  LOCAL_AVAILABLE: { label: 'Modèle local : dernier appel réussi', tone: 'ok' }, LOCAL_UNAVAILABLE: { label: 'Modèle local indisponible', tone: 'warn' },
  NOT_RUN: { label: 'Modèle local : jamais exécuté', tone: 'muted' }, RUNNING: { label: 'Modèle local : en cours', tone: 'info' },
  TIMEOUT: { label: 'Modèle local : délai dépassé', tone: 'warn' }, CANCELLED: { label: 'Modèle local : annulé', tone: 'muted' }, ERROR: { label: 'Modèle local : erreur', tone: 'danger' },
};
export function modelStatusLabel(status: unknown): { status: string; label: string; tone: Tone; known: boolean } {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(MODEL, status) ? { status, known: true, ...MODEL[status as ModelUiStatus] } : { status: 'UNKNOWN', known: false, label: 'État du modèle inconnu (non affirmé)', tone: 'danger' };
}

// ── proposals, confirmation, lifecycle ──
export function confirmationKindOf(p: Pick<ProposalDto, 'riskClass' | 'confirmationKind'>): ConfirmationKind | 'UNKNOWN' {
  if (p.riskClass === 'READ_ONLY') return 'NONE';
  return p.riskClass === 'LOCAL_MUTATION' && ['SIMPLE_CONFIRM', 'TYPED_CONFIRM', 'REINFORCED_CONFIRM'].includes(p.confirmationKind) ? p.confirmationKind as ConfirmationKind : 'UNKNOWN';
}
export const CONFIRMATION_TEXT: Record<string, string> = {
  NONE: 'Lecture seule : aucune confirmation.', SIMPLE_CONFIRM: 'Confirmation simple.', TYPED_CONFIRM: 'Confirmation saisie : recopiez la phrase exacte.',
  REINFORCED_CONFIRM: 'Confirmation renforcée : cochez chaque point et recopiez la phrase exacte.', UNKNOWN: 'Confirmation inconnue : action impossible.',
};
export const ACK_TEXT: Record<string, string> = {
  CURRENT_SCOPE_LEAVES_NEVER_CLOUD: 'Je comprends que ce souvenir quitte la protection NEVER_CLOUD.',
  FUTURE_CLOUD_USE_POSSIBLE: 'Je comprends qu’un envoi cloud pourra devenir possible plus tard si le cloud est autorisé.',
};
export function proposedByLabel(by: unknown): { label: string; model: boolean } {
  if (by === 'MODEL') return { label: 'PROPOSED_BY_MODEL — proposé par le modèle, votre geste est requis', model: true };
  if (by === 'USER') return { label: 'Proposé par vous', model: false };
  return { label: 'Origine de la proposition inconnue', model: false };
}
const PROPOSAL_STATES = ['PENDING', 'APPROVED', 'EXECUTED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'SUPERSEDED'];
/** Lifecycle shown to the person. Unknown server status ⇒ UNKNOWN (nothing enabled). */
export function proposalUiState({ proposal, approval, executing = false, result = null, now }: { proposal: ProposalDto | null; approval?: ApprovalDto | null; executing?: boolean; result?: ActionResultDto | null; now: number }): ProposalUiState {
  if (result) {
    if (result.resultCode === 'FORGET_INCOMPLETE' || result.effectApplied === 'PARTIAL') return 'INCOMPLETE';
    if (result.status === 'EXECUTED') return 'EXECUTED';
    if (result.status === 'CANCELLED') return 'CANCELLED';
    if (result.status === 'FAILED') return 'FAILED';
    return 'UNKNOWN';
  }
  if (executing) return 'EXECUTING';
  if (!proposal || !PROPOSAL_STATES.includes(proposal.status)) return 'UNKNOWN';
  if (proposal.status === 'FAILED' && proposal.resultCode === 'FORGET_INCOMPLETE') return 'INCOMPLETE';
  if (proposal.status === 'PENDING' && (proposal.expired || Date.parse(proposal.expiresAt) <= now)) return 'EXPIRED';
  if (proposal.status === 'APPROVED' || approval) {
    if (approval && Date.parse(approval.expiresAt) <= now) return 'EXPIRED';
    return proposal.status === 'PENDING' || proposal.status === 'APPROVED' ? 'APPROVED' : proposal.status as ProposalUiState;
  }
  return proposal.status as ProposalUiState;
}
export const STATE_TEXT: Record<ProposalUiState, { label: string; tone: Tone }> = {
  PENDING: { label: 'En attente de votre confirmation', tone: 'info' }, APPROVED: { label: 'Approuvée — prête à exécuter', tone: 'info' },
  EXECUTING: { label: 'Exécution…', tone: 'info' }, EXECUTED: { label: 'Exécutée', tone: 'ok' }, FAILED: { label: 'Échec', tone: 'danger' },
  INCOMPLETE: { label: 'Incomplet — l’action n’a pas entièrement réussi', tone: 'warn' }, CANCELLED: { label: 'Annulée', tone: 'muted' },
  EXPIRED: { label: 'Expirée — une nouvelle confirmation est nécessaire', tone: 'warn' }, REJECTED: { label: 'Refusée', tone: 'muted' },
  SUPERSEDED: { label: 'Remplacée par une proposition plus récente', tone: 'muted' }, UNKNOWN: { label: 'État inconnu — aucune action possible', tone: 'danger' },
};
/** What the UI may offer. The server re-checks everything; hiding a button is never an authorisation. */
export function availableControls(state: ProposalUiState, opts: { confirmationReady?: boolean; challengeReady?: boolean; cancellableWhileExecuting?: boolean } = {}) {
  return {
    canConfirm: state === 'PENDING' && opts.challengeReady === true && opts.confirmationReady === true,
    canReject: state === 'PENDING',
    canExecute: state === 'APPROVED',
    canCancel: state === 'PENDING' || state === 'APPROVED' || (state === 'EXECUTING' && opts.cancellableWhileExecuting === true),
    canReconfirm: state === 'EXPIRED',
  };
}
/** Exact match only: no trimming, no case folding (the server does the same). */
export function confirmationReady(kind: ConfirmationKind | 'UNKNOWN', challenge: Pick<ChallengeDto, 'typedPhrase' | 'requiredAcknowledgements'> | null, typed: string, acks: readonly string[]): boolean {
  if (!challenge || kind === 'UNKNOWN' || kind === 'NONE') return false;
  if (kind === 'SIMPLE_CONFIRM') return true;
  if (typed !== challenge.typedPhrase) return false;
  if (kind === 'REINFORCED_CONFIRM') return challenge.requiredAcknowledgements.length > 0 && challenge.requiredAcknowledgements.every(a => acks.includes(a));
  return true;
}
/**
 * Builds the HumanApprovalIntent ONLY from a trusted pointer / keyboard event (event.isTrusted: a script-dispatched
 * click is not trusted). Returns null otherwise. Carries exactly the challenge binding + the person's input.
 */
export function buildApprovalIntent(challenge: ChallengeDto, event: { isTrusted?: boolean; type?: string; detail?: number } | null | undefined, input: { typed?: string; acknowledgements?: readonly string[] }, now: number): HumanApprovalIntent | null {
  if (!event || event.isTrusted !== true) return null;
  const kind = event.type === 'keydown' || event.type === 'keyup' || (event.type === 'click' && event.detail === 0) ? 'KEYBOARD' : event.type === 'click' || event.type === 'pointerup' ? 'POINTER' : null;
  if (!kind) return null;
  if (!['SIMPLE_CONFIRM', 'TYPED_CONFIRM', 'REINFORCED_CONFIRM'].includes(challenge.confirmationKind)) return null;
  const intent: HumanApprovalIntent = {
    proposalId: challenge.proposalId, actionDigest: challenge.actionDigest, confirmationKind: challenge.confirmationKind as HumanApprovalIntent['confirmationKind'],
    uiSessionId: challenge.uiSessionId, nonce: challenge.nonce, createdAt: new Date(now).toISOString(), gesture: { kind, trusted: true },
  };
  if (challenge.confirmationKind !== 'SIMPLE_CONFIRM') intent.typedPhrase = input.typed ?? '';
  if (challenge.confirmationKind === 'REINFORCED_CONFIRM') intent.acknowledgements = [...(input.acknowledgements ?? [])];
  return intent;
}
export function secondsLeft(iso: string | null | undefined, now: number): number {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : 0;
}

// ── preview rendering: nothing significant hidden ──
const PREVIEW_KNOWN = ['action', 'actionId', 'target', 'summary', 'changes', 'unchanged', 'effects', 'reversible', 'privacyImpact', 'confirmation', 'pointOfNoReturn', 'parameters', 'memory', 'readOnly', 'sideEffectsBeforeApproval'];
const EFFECT_TEXT: Record<string, string> = {
  NB5_RECORD_PURGED: 'Docteur Memory : le souvenir est supprimé', NB5_VECTOR_PURGED: 'Index vectoriel : supprimé', COMPANION_METADATA_DELETED: 'Métadonnées Companion : supprimées',
  COMPANION_MEMORY_PROPOSALS_DELETED: 'Propositions de mémoire liées : supprimées', SESSION_REFERENCES_PURGED: 'Références de session : purgées', DERIVED_CACHES_PURGED: 'Caches dérivés : purgés',
  OPEN_ACTION_PROPOSALS_ON_THIS_MEMORY_SUPERSEDED: 'Autres propositions sur ce souvenir : annulées', AUDIT_KEEPS_IDS_ONLY: 'Le journal garde seulement les identifiants',
  SESSION_CONTEXT_PURGED: 'Le contexte de session en cours est effacé', COMPANION_PREFERENCES_UPDATED: 'Préférences Companion modifiées',
  MEMORY_USABLE_IN_LOCAL_CONTEXT: 'Le souvenir pourra servir au contexte local', MEMORY_EXCLUDED_FROM_CONTEXT: 'Le souvenir ne sera plus utilisé dans le contexte',
  MEMORY_PRIVACY_SCOPE_CHANGED: 'Portée de confidentialité modifiée', CLOUD_ELIGIBLE_ONLY_IF_CLOUD_GATE_ALLOWS: 'Éligible au cloud seulement si le cloud est activé et autorisé',
};
export const effectText = (e: unknown): string => (typeof e === 'string' ? EFFECT_TEXT[e] ?? e : 'Effet inconnu');
const fmt = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
export function previewRows(p: ProposalDto): { key: string; label: string; value: string }[] {
  const pv = p.preview ?? {};
  const rows: { key: string; label: string; value: string }[] = [
    { key: 'action', label: 'Action', value: `${fmt(pv.action)} (${p.actionId} v${p.actionVersion})` },
    { key: 'target', label: 'Cible', value: fmt(pv.target ?? p.target) },
    { key: 'riskClass', label: 'Classe de risque', value: p.riskClass },
    { key: 'summary', label: 'Résumé', value: fmt(pv.summary) },
    { key: 'changes', label: 'Modifications', value: Array.isArray(pv.changes) && pv.changes.length ? pv.changes.map(c => `${c.field} : ${fmt(c.from)} → ${fmt(c.to)}`).join(' ; ') : 'Aucune modification' },
    { key: 'effects', label: 'Effets attendus', value: Array.isArray(pv.effects) && pv.effects.length ? pv.effects.map(effectText).join(' ; ') : 'Aucun' },
    { key: 'reversible', label: 'Réversibilité', value: pv.reversible === 'NO' ? 'Irréversible' : pv.reversible === 'YES' ? 'Réversible' : fmt(pv.reversible) },
    { key: 'privacyImpact', label: 'Impact confidentialité', value: fmt(pv.privacyImpact?.level) },
    { key: 'pointOfNoReturn', label: 'Point de non-retour', value: fmt(pv.pointOfNoReturn) },
    { key: 'confirmation', label: 'Confirmation nécessaire', value: CONFIRMATION_TEXT[confirmationKindOf(p)] },
    { key: 'expiresAt', label: 'Expiration de la proposition', value: p.expiresAt },
    { key: 'digest', label: 'Empreinte (digest)', value: p.digestShort },
    { key: 'parameters', label: 'Paramètres', value: fmt(pv.parameters ?? p.parameters) },
  ];
  for (const k of Object.keys(pv)) if (!PREVIEW_KNOWN.includes(k)) rows.push({ key: `extra:${k}`, label: `Autre champ : ${k}`, value: fmt(pv[k]) });
  return rows;
}

// ── errors ──
const ERROR_TEXT: Record<string, string> = {
  APPROVAL_REQUIRED: 'Une confirmation de votre part est nécessaire.', APPROVAL_EXPIRED: 'La confirmation a expiré : confirmez à nouveau.',
  APPROVAL_ALREADY_USED: 'Cette confirmation a déjà servi : une nouvelle confirmation est nécessaire.', APPROVAL_DIGEST_MISMATCH: 'L’action ne correspond plus à ce que vous avez vu : rien n’a été fait.',
  APPROVAL_NOT_FOUND: 'Confirmation introuvable.', PREVIEW_STALE: 'L’état a changé depuis l’aperçu : proposez à nouveau.', PROPOSAL_EXPIRED: 'La proposition a expiré.',
  PROPOSAL_NOT_FOUND: 'Proposition introuvable.', CONFIRMATION_REQUIRED: 'La confirmation demandée n’est pas complète ou exacte.',
  APPROVAL_INTENT_EXPIRED: 'La fenêtre de confirmation a expiré : confirmez à nouveau.', APPROVAL_INTENT_REPLAYED: 'Cette confirmation a déjà été utilisée.',
  APPROVAL_INTENT_MISMATCH: 'Cette confirmation ne correspond pas à cette action.', APPROVAL_INTENT_INVALID: 'Confirmation invalide.', UI_SESSION_UNKNOWN: 'Session d’interface expirée : rouvrez le panneau.',
  FORGET_INCOMPLETE: 'Oubli incomplet : certaines données n’ont pas pu être supprimées. Ce n’est pas un succès.', ACTION_FAILED: 'L’action a échoué ; rien n’a été réessayé automatiquement.',
  ACTION_CANCELLED: 'Action annulée.', ACTION_NOT_ALLOWED: 'Action refusée.', UNKNOWN_ACTION: 'Action inconnue : refusée.', INVALID_ACTION_PAYLOAD: 'Paramètres invalides : refusé.',
  CAPABILITY_REQUIRED: 'Action externe désactivée.', LOCAL_MODEL_UNAVAILABLE: 'Aucun modèle local disponible.', MODEL_TIMEOUT: 'Le modèle local n’a pas répondu à temps.',
  MODEL_CANCELLED: 'La requête au modèle a été annulée.',
  // [COMP-9 CHAT] answer path (COMP-4 / COMP-7 codes)
  COMPANION_DISABLED: 'Le Companion n’est pas activé : la conversation est indisponible.',
  COMP_CONVERSATION_INVALID: 'Question refusée : texte vide ou trop long.',
  COMP_CONVERSATION_FAILED: 'La réponse a échoué ; réessayez.',
  MODEL_PROVIDER_ERROR: 'Le modèle local a renvoyé une erreur.',
  MODEL_INVALID_RESPONSE: 'Le modèle local a renvoyé une réponse inutilisable.',
  MODEL_CLOUD_FORBIDDEN: 'Refusé : le Companion n’utilise jamais le cloud.',
  ROOT_POLICY_DENIED: 'Refusé par la politique racine de Docteur.',
};
export function errorText(code: unknown): { code: string; text: string; known: boolean } {
  return typeof code === 'string' && ERROR_TEXT[code] ? { code, text: ERROR_TEXT[code], known: true } : { code: typeof code === 'string' ? code.slice(0, 40) : 'UNKNOWN', text: 'Refusé (raison inconnue).', known: false };
}
export function resultView(r: ActionResultDto): { state: ProposalUiState; tone: Tone; title: string; detail: string; success: boolean } {
  const state = proposalUiState({ proposal: null, result: r, now: 0 });
  const s = STATE_TEXT[state];
  const remaining = Array.isArray((r.resultMetadata as { remainingStores?: unknown })?.remainingStores) ? (r.resultMetadata as { remainingStores: string[] }).remainingStores : [];
  const detail = state === 'INCOMPLETE' ? `${errorText('FORGET_INCOMPLETE').text}${remaining.length ? ` Restant : ${remaining.join(', ')}.` : ''}`
    : state === 'FAILED' ? errorText(r.resultCode).text
      : state === 'CANCELLED' ? `Annulée${r.cancellation?.stage ? ` (${r.cancellation.stage})` : ''} : effet ${r.effectApplied}.`
        : state === 'EXECUTED' ? `Effet ${r.effectApplied}${r.cancellation?.requested && !r.cancellation.honored ? ' — annulation demandée trop tard : l’action était déjà appliquée.' : '.'}`
          : 'Résultat inconnu : considéré comme non réussi.';
  return { state, tone: s.tone, title: s.label, detail, success: state === 'EXECUTED' };
}

// ── display hygiene (defence in depth: the server already withholds secrets) ──
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/, /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY/, /\botpauth:\/\//i, /\b(?:password|mot de passe|mdp|api[_ -]?key|token)\b\s*[:=]\s*\S{4,}/i, /\b[A-Za-z0-9+/_]{40,}={0,2}(?![A-Za-z0-9])/]; // long unbroken token; NB-5 ids (mem-<uuid>) are hyphenated and stay visible
export function displayText(v: unknown, max = 400): string {
  if (v === null || v === undefined) return '—';
  const s = String(v);
  if (SECRET_SHAPES.some(re => re.test(s))) return '[masqué]';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
