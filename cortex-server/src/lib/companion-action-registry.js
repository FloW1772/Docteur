// Companion V1 — COMP-5 closed action registry (no DB, no fs, no network, no process, no model).
//
// An action is a KNOWN actionId + a payload validated against its strict schema. There is no generic action: no shell,
// no command string, no argv, no eval, no arbitrary path, no URL, no dynamic module loading. The registry is a frozen
// literal; an unknown id is DENY (UNKNOWN_ACTION). The definitions only call the public Companion ports they are given
// (CompanionMemory + read-only CompanionStore listings); none of them owns a capability by itself.
//
// Classes:
//   READ_ONLY           implemented — no DB / file / preference / proposal write, no network, no process, no model
//   LOCAL_MUTATION      implemented — preview → user approval (single-use, ≤ 300 s) → bounded execution → audit
//   EXTERNAL_ACTION     DEFINED_BUT_DISABLED — every entry needs a capability the Companion does not hold
//   HIGH_IMPACT_ACTION  DEFINED_BUT_DISABLED — same, plus a human approval boundary
// Parameters are ids, enums, booleans and bounded integers only — never free text — so a proposal row, a digest input
// or an audit entry can never carry a memory statement, a prompt or a secret.

import { CompanionError, PRIVACY_SCOPE, checkPrivacyTransition, sha256Hex, boundedJson, freezeDeep, parseStrictJson } from './companion-contracts.js';

export const ACTION_FRAMEWORK_VERSION = 'companion-actions-v1';
export const ACTION_CLASS = Object.freeze({ READ_ONLY: 'READ_ONLY', LOCAL_MUTATION: 'LOCAL_MUTATION', EXTERNAL_ACTION: 'EXTERNAL_ACTION', HIGH_IMPACT_ACTION: 'HIGH_IMPACT_ACTION' });
export const ENABLED_CLASSES = Object.freeze(['READ_ONLY', 'LOCAL_MUTATION']);
export const CLASS_STATUS = freezeDeep({ READ_ONLY: 'ENABLED', LOCAL_MUTATION: 'ENABLED', EXTERNAL_ACTION: 'DEFINED_BUT_DISABLED', HIGH_IMPACT_ACTION: 'DEFINED_BUT_DISABLED' });
export const IDEMPOTENCY = Object.freeze({ IDEMPOTENT: 'IDEMPOTENT', NON_IDEMPOTENT: 'NON_IDEMPOTENT' });
export const ACTION_ERROR = Object.freeze(Object.fromEntries([
  'UNKNOWN_ACTION', 'INVALID_ACTION_PAYLOAD', 'ACTION_NOT_ALLOWED', 'APPROVAL_REQUIRED', 'APPROVAL_NOT_FOUND', 'APPROVAL_EXPIRED',
  'APPROVAL_ALREADY_USED', 'APPROVAL_DIGEST_MISMATCH', 'CONFIRMATION_REQUIRED', 'PROPOSAL_NOT_FOUND', 'PROPOSAL_EXPIRED', 'PREVIEW_STALE',
  'ACTION_CANCELLED', 'ACTION_FAILED', 'ACTION_TIMEOUT', 'CAPABILITY_REQUIRED',
].map(c => [c, c])));
/** Bounds. PROVISIONAL (no measured Companion usage yet); each has its basis. */
export const ACTION_LIMITS = freezeDeep({
  approvalTtlMs: { value: 120_000, max: 300_000, min: 5_000, status: 'PROVISIONAL', basis: 'an approval is executed right after the click; stricter than the 5-minute ceiling' },
  proposalTtlMs: { value: 10 * 60_000, status: 'PROVISIONAL', basis: 'a preview a person reviews now, not a backlog' },
  openProposals: { value: 50, status: 'PROVISIONAL', basis: 'a review list a person can actually read' },
  readOnlyTimeoutMs: { value: 5_000, status: 'PROVISIONAL', basis: 'local SQLite / NB-5 reads only' },
  listLimit: { value: 100, status: 'PROVISIONAL', basis: 'one page of memory metadata' },
  modelOutputBytes: { value: 4_096, status: 'PROVISIONAL', basis: 'an action id and a few ids / enums' },
  previewBytes: { value: 8_192, status: 'PROVISIONAL', basis: 'a readable preview (summary, fields, effects, short excerpt)' },
  excerptChars: { value: 120, status: 'PROVISIONAL', basis: 'enough for the user to recognise a memory in a preview' },
});

/** Every refusal is fail-closed: decision DENY_<code>, nothing executed. */
export const deny = (code, message, details = {}) => { throw new CompanionError(code, message, { decision: `DENY_${code}`, ...details }); };
const invalid = (reason, field = null) => deny(ACTION_ERROR.INVALID_ACTION_PAYLOAD, `invalid action payload: ${reason}${field ? ` (${field})` : ''}`, { reason, ...(field ? { field } : {}) });

// ── strict schemas ──
const MEMORY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const F = Object.freeze({
  boolean: (opts = {}) => Object.freeze({ type: 'boolean', ...opts }),
  enum: (values, opts = {}) => Object.freeze({ type: 'enum', values: Object.freeze([...values]), ...opts }),
  memoryId: (opts = {}) => Object.freeze({ type: 'id', pattern: 'MEMORY_ID', ...opts }),
  requestId: (opts = {}) => Object.freeze({ type: 'id', pattern: 'REQUEST_ID', ...opts }),
  integer: (min, max, opts = {}) => Object.freeze({ type: 'integer', min, max, ...opts }),
});
const PATTERNS = { MEMORY_ID: MEMORY_ID_RE, REQUEST_ID: REQUEST_ID_RE };
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function checkField(name, spec, v) {
  if (spec.type === 'boolean') { if (typeof v !== 'boolean') invalid('NOT_A_BOOLEAN', name); return v; }
  if (spec.type === 'enum') { if (typeof v !== 'string' || !spec.values.includes(v)) invalid('NOT_AN_ALLOWED_VALUE', name); return v; }
  if (spec.type === 'id') { if (typeof v !== 'string' || !PATTERNS[spec.pattern].test(v)) invalid('NOT_A_VALID_ID', name); return v; }
  if (spec.type === 'integer') { if (!Number.isSafeInteger(v) || v < spec.min || v > spec.max) invalid('INTEGER_OUT_OF_RANGE', name); return v; }
  return invalid('UNSUPPORTED_FIELD_TYPE', name);
}
/** Strict: plain object, no unknown field, required present, defaults materialised (so {} and the defaults digest alike). */
export function validateParameters(def, raw) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isPlain(input)) invalid('PARAMETERS_NOT_AN_OBJECT');
  const out = {};
  for (const k of Object.keys(input)) if (!Object.hasOwn(def.inputSchema, k)) invalid('UNKNOWN_FIELD', String(k).slice(0, 40));
  for (const [k, spec] of Object.entries(def.inputSchema)) {
    if (input[k] === undefined || input[k] === null) {
      if (spec.required) invalid('REQUIRED_FIELD', k);
      if (spec.default !== undefined) out[k] = spec.default;
      continue;
    }
    out[k] = checkField(k, spec, input[k]);
  }
  if (def.validate) def.validate(out, invalid);
  return freezeDeep(Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]])));
}

// ── canonical digest ──
/** Canonical JSON: sorted keys, plain JSON values only (boundedJson), bounded. */
export const canonicalJson = (value, maxBytes = 2048, what = 'action parameters') => boundedJson(value, maxBytes, what);
/**
 * The digest depends on exactly: framework version, installation (owner), actionId, actionVersion, riskClass, target,
 * canonical parameters. Same action + same payload ⇒ same digest; one parameter changed ⇒ a different digest.
 */
export function computeActionDigest({ ownerId, actionId, actionVersion, riskClass, target, parameters }) {
  return sha256Hex(JSON.stringify([ACTION_FRAMEWORK_VERSION, 'companion', String(ownerId), actionId, actionVersion, riskClass, canonicalJson(target, 512, 'action target'), canonicalJson(parameters)]));
}
export const previewSha256 = (preview) => sha256Hex(canonicalJson(preview, ACTION_LIMITS.previewBytes.value, 'action preview'));

// ── preview helpers ──
const SCOPE_RANK = Object.freeze({ NEVER_CLOUD: 0, PRIVATE_LOCAL: 1, LOCAL_SHARED_CONTEXT: 2, CLOUD_ALLOWED: 3 });
const excerpt = (s) => (typeof s === 'string' ? (s.length > ACTION_LIMITS.excerptChars.value ? `${s.slice(0, ACTION_LIMITS.excerptChars.value)}…` : s) : null);
const memoryTarget = (p) => ({ kind: 'MEMORY', id: p.memoryId });
function memoryOrDeny(ports, memoryId, { metadataRequired = true } = {}) {
  const v = ports.companion.view(memoryId);
  if (metadataRequired && !v.companion) deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'this memory has no Companion metadata', { reason: 'TARGET_NOT_FOUND' });
  return v;
}
const memoryCard = (v) => ({ memoryId: v.memoryId, state: v.state, category: v.companion?.category ?? null, privacyScope: v.privacyScope, companionEnabled: v.companion?.companionEnabled ?? null, excerpt: excerpt(v.statement) });
function explainMemory(v) {
  const prov = v.companion?.provenance ?? null;
  return {
    memoryId: v.memoryId, state: v.state, conflict: v.state === 'DISPUTED' ? 'OPEN_CONFLICT' : 'NONE', durableOwner: v.durableOwner, nb5Status: v.nb5Status,
    sensitivity: v.sensitivity, privacyScope: v.privacyScope, companionEnabled: v.companion?.companionEnabled ?? null, category: v.companion?.category ?? null,
    provenance: prov ? { origin: prov.origin, sourceType: prov.sourceType, proposalId: prov.proposalId ?? null, sessionId: prov.sessionId ?? null,
      evidenceRefs: (prov.evidenceRefs ?? []).map(r => ({ kind: r.kind, ref: r.ref })), sourceReference: prov.sourceReference ? { kind: prov.sourceReference.kind, ref: prov.sourceReference.ref } : null,
      derivedBy: prov.derivedBy ?? null } : null,
    freshness: v.freshness,
  };
}
const preview = (o) => freezeDeep({ readOnly: false, sideEffectsBeforeApproval: 'NONE', ...o });

// ── the closed registry ──
const DEFINITIONS = [
  // READ_ONLY
  {
    actionId: 'COMPANION.MEMORY.LIST', version: 1, riskClass: 'READ_ONLY', idempotency: 'IDEMPOTENT', modelProposable: true,
    description: 'Lists the Companion view of durable memories (ids, state, category, privacy, enabled) — no statement text.',
    inputSchema: { limit: F.integer(1, ACTION_LIMITS.listLimit.value, { default: 50 }), includeDisabled: F.boolean({ default: true }) },
    target: (_p, { ownerId }) => ({ kind: 'COMPANION', id: ownerId }),
    preview: (_ports, p) => freezeDeep({ readOnly: true, action: 'List memories', summary: `List up to ${p.limit} memories${p.includeDisabled ? '' : ' (enabled only)'}`, parameters: p }),
    execute: async (ports, p, ctx) => {
      const metas = ports.store.listMetadata().filter(m => p.includeDisabled || m.companionEnabled);
      const memories = [];
      for (const m of metas.slice(0, p.limit)) {
        ctx.checkpoint('READ');
        const v = ports.companion.view(m.memoryId);
        memories.push({ memoryId: v.memoryId, state: v.state, category: m.category, privacyScope: v.privacyScope, companionEnabled: m.companionEnabled, origin: m.provenance.origin, confirmedAt: m.confirmedAt, reviewAfter: m.reviewAfter });
      }
      return { result: { total: metas.length, count: memories.length, truncated: metas.length > memories.length, memories }, sideEffects: [] };
    },
  },
  {
    actionId: 'COMPANION.MEMORY.EXPLAIN', version: 1, riskClass: 'READ_ONLY', idempotency: 'IDEMPOTENT', modelProposable: true,
    description: '"Why do you know this?" — provenance, privacy, freshness and conflict state of one memory (ids only, no statement).',
    inputSchema: { memoryId: F.memoryId({ required: true }) },
    target: memoryTarget,
    preview: (_ports, p) => freezeDeep({ readOnly: true, action: 'Explain a memory', summary: `Explain memory ${p.memoryId}`, parameters: p }),
    execute: async (ports, p, ctx) => { ctx.checkpoint('READ'); return { result: explainMemory(ports.companion.view(p.memoryId)), sideEffects: [] }; },
  },
  {
    actionId: 'COMPANION.CONTEXT.EXPLAIN', version: 1, riskClass: 'READ_ONLY', idempotency: 'IDEMPOTENT', modelProposable: true,
    description: 'Which context a past request used: memory / item ids, provenance, privacy, freshness, conflicts (from the context audit; no text).',
    inputSchema: { requestId: F.requestId({ required: true }) },
    target: (p) => ({ kind: 'CONTEXT_REQUEST', id: p.requestId }),
    preview: (_ports, p) => freezeDeep({ readOnly: true, action: 'Explain a context', summary: `Explain the context used by request ${p.requestId}`, parameters: p }),
    execute: async (ports, p, ctx) => {
      const uses = ports.store.listAudit().filter(a => a.action === 'MEMORY_CONTEXT_USED' && a.objectId === p.requestId);
      if (!uses.length) return { result: { requestId: p.requestId, found: false, contextUsed: [], memories: [] }, sideEffects: [] };
      const d = uses[uses.length - 1].details;
      const memoryIds = [...new Set(d.memoryIds ?? [])];
      const memories = [];
      for (const id of memoryIds) { ctx.checkpoint('READ'); memories.push(explainMemory(ports.companion.view(id))); }
      const contextUsed = (d.itemIds ?? []).map(id => ({ itemId: id, kind: String(id).split(':')[0].toUpperCase() }));
      return { result: { requestId: p.requestId, found: true, usedAt: uses[uses.length - 1].at, stateAsOf: 'NOW', contextUsed, memories,
        typeCounts: d.typeCounts ?? {}, privacyCounts: d.privacyCounts ?? {}, truncationCount: d.truncationCount ?? 0 }, sideEffects: [] };
    },
  },

  // LOCAL_MUTATION
  {
    actionId: 'COMPANION.PREFERENCES.UPDATE', version: 1, riskClass: 'LOCAL_MUTATION', idempotency: 'IDEMPOTENT', modelProposable: true, mode: 'SYNC_TRANSACTION',
    description: 'Updates recognised Companion preferences (booleans only; an unknown key is refused).',
    inputSchema: { memoryEnabled: F.boolean(), sessionMemoryEnabled: F.boolean(), proposalEnabled: F.boolean(), cloudContextEnabled: F.boolean() },
    validate: (p, bad) => { if (!Object.keys(p).length) bad('NO_PREFERENCE_GIVEN'); },
    target: (_p, { ownerId }) => ({ kind: 'PREFERENCES', id: ownerId }),
    preview: (ports, p) => {
      const cur = ports.companion.preferences();
      const changes = Object.keys(p).filter(k => cur[k] !== p[k]).map(k => ({ field: k, from: cur[k], to: p[k] }));
      const loosens = p.cloudContextEnabled === true && cur.cloudContextEnabled !== true;
      const offs = changes.filter(c => ['memoryEnabled', 'sessionMemoryEnabled'].includes(c.field) && c.to === false);
      return preview({
        action: 'Update Companion preferences', actionId: 'COMPANION.PREFERENCES.UPDATE', target: { kind: 'PREFERENCES' },
        summary: changes.length ? changes.map(c => `${c.field}: ${c.from} → ${c.to}`).join('; ') : 'No change (already set)',
        changes, unchanged: Object.keys(p).filter(k => cur[k] === p[k]), parameters: p,
        effects: [...(changes.length ? ['COMPANION_PREFERENCES_UPDATED'] : []), ...(offs.length ? ['SESSION_CONTEXT_PURGED'] : [])],
        reversible: offs.length ? 'PARTIAL: preferences can be switched back; purged session context is gone' : 'YES',
        privacyImpact: { level: loosens ? 'LOOSENS_CLOUD' : offs.length || (p.cloudContextEnabled === false && cur.cloudContextEnabled) ? 'TIGHTENS' : changes.length ? 'RELAXES_LOCAL' : 'NONE' },
        confirmation: loosens ? { level: 'EXPLICIT', phrase: 'ALLOW CLOUD CONTEXT' } : { level: 'STANDARD' },
        pointOfNoReturn: 'TRANSACTION_COMMIT',
      });
    },
    execute: (ports, p) => {
      const out = ports.companion.setPreferences({ ...p });
      return { result: { preferences: out.preferences }, sideEffects: [{ kind: 'PREFERENCES_UPDATED', fields: Object.keys(p), transactional: true },
        ...(out.purgedSessions ? [{ kind: 'SESSION_CONTEXT_PURGED', count: out.purgedSessions, transactional: false }] : [])] };
    },
  },
  {
    actionId: 'COMPANION.MEMORY.SET_ENABLED', version: 1, riskClass: 'LOCAL_MUTATION', idempotency: 'IDEMPOTENT', modelProposable: true, mode: 'SYNC_TRANSACTION',
    description: 'Lets the Companion use (or stop using) one durable memory in its context. NB-5 keeps the memory.',
    inputSchema: { memoryId: F.memoryId({ required: true }), enabled: F.boolean({ required: true }) },
    target: memoryTarget,
    preview: (ports, p) => {
      const v = memoryOrDeny(ports, p.memoryId);
      const from = v.companion.companionEnabled;
      return preview({
        action: p.enabled ? 'Enable a memory for the Companion' : 'Disable a memory for the Companion', actionId: 'COMPANION.MEMORY.SET_ENABLED',
        target: { kind: 'MEMORY', memoryId: p.memoryId }, memory: memoryCard(v), summary: from === p.enabled ? 'No change (already set)' : `companionEnabled: ${from} → ${p.enabled}`,
        changes: from === p.enabled ? [] : [{ field: 'companionEnabled', from, to: p.enabled }], parameters: p,
        effects: from === p.enabled ? [] : [p.enabled ? 'MEMORY_USABLE_IN_LOCAL_CONTEXT' : 'MEMORY_EXCLUDED_FROM_CONTEXT'], reversible: 'YES',
        privacyImpact: { level: from === p.enabled ? 'NONE' : p.enabled ? 'RELAXES_LOCAL' : 'TIGHTENS' }, confirmation: { level: 'STANDARD' }, pointOfNoReturn: 'TRANSACTION_COMMIT',
      });
    },
    execute: (ports, p) => {
      const v = ports.companion.setCompanionEnabled(p.memoryId, p.enabled);
      return { result: { memoryId: p.memoryId, companionEnabled: v.companion.companionEnabled }, sideEffects: [{ kind: 'MEMORY_METADATA_UPDATED', field: 'companionEnabled', transactional: true }] };
    },
  },
  {
    actionId: 'COMPANION.MEMORY.SET_PRIVACY', version: 1, riskClass: 'LOCAL_MUTATION', idempotency: 'IDEMPOTENT', modelProposable: true, mode: 'SYNC_TRANSACTION',
    description: 'Changes the privacy scope of one memory under the COMP-2 rules (leaving NEVER_CLOUD needs a reinforced confirmation).',
    inputSchema: { memoryId: F.memoryId({ required: true }), scope: F.enum(Object.keys(PRIVACY_SCOPE), { required: true }) },
    target: memoryTarget,
    preview: (ports, p) => {
      const v = memoryOrDeny(ports, p.memoryId);
      if (v.state === 'MISSING') deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'this memory is not in Docteur Memory', { reason: 'TARGET_NOT_FOUND' });
      const from = v.privacyScope;
      try { checkPrivacyTransition(from, p.scope, { explicit: true, releaseNeverCloud: true, sensitivity: v.sensitivity ?? 'NORMAL' }); } catch (e) {
        deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'this privacy change is never allowed', { reason: String(e?.code ?? 'PRIVACY_RULE').slice(0, 60) });
      }
      const release = from === 'NEVER_CLOUD' && p.scope !== from;
      const level = from === p.scope ? 'NONE' : release || p.scope === 'CLOUD_ALLOWED' ? 'LOOSENS_CLOUD' : SCOPE_RANK[p.scope] > SCOPE_RANK[from] ? 'RELAXES_LOCAL' : 'TIGHTENS';
      return preview({
        action: 'Change the privacy scope of a memory', actionId: 'COMPANION.MEMORY.SET_PRIVACY', target: { kind: 'MEMORY', memoryId: p.memoryId }, memory: memoryCard(v),
        summary: from === p.scope ? 'No change (already set)' : `privacyScope: ${from} → ${p.scope}`, changes: from === p.scope ? [] : [{ field: 'privacyScope', from, to: p.scope }], parameters: p,
        effects: from === p.scope ? [] : ['MEMORY_PRIVACY_SCOPE_CHANGED', ...(p.scope === 'CLOUD_ALLOWED' ? ['CLOUD_ELIGIBLE_ONLY_IF_CLOUD_GATE_ALLOWS'] : [])],
        reversible: release ? 'PARTIAL: NEVER_CLOUD can be set again, but a later cloud use cannot be undone' : 'YES',
        privacyImpact: { level, neverCloudRelease: release },
        confirmation: release ? { level: 'REINFORCED', phrase: `RELEASE NEVER_CLOUD ${p.memoryId}` } : p.scope === 'CLOUD_ALLOWED' && from !== p.scope ? { level: 'EXPLICIT', phrase: `ALLOW CLOUD ${p.memoryId}` } : { level: 'STANDARD' },
        pointOfNoReturn: 'TRANSACTION_COMMIT',
      });
    },
    execute: (ports, p, ctx) => {
      // explicit = a user approval exists; releaseNeverCloud only when the approved (and re-verified) preview demanded the reinforced confirmation
      const v = ports.companion.setPrivacyScope(p.memoryId, p.scope, { explicit: true, releaseNeverCloud: ctx.preview.confirmation.level === 'REINFORCED' });
      return { result: { memoryId: p.memoryId, privacyScope: v.privacyScope }, sideEffects: [{ kind: 'MEMORY_METADATA_UPDATED', field: 'privacyScope', transactional: true }] };
    },
  },
  {
    actionId: 'COMPANION.MEMORY.FORGET', version: 1, riskClass: 'LOCAL_MUTATION', idempotency: 'NON_IDEMPOTENT', modelProposable: true, mode: 'POINT_OF_NO_RETURN',
    supersedesTargetProposals: true,
    description: 'Forgets one memory everywhere (NB-5 record and vector, Companion metadata, linked proposals, session references, caches), verified.',
    inputSchema: { memoryId: F.memoryId({ required: true }) },
    target: memoryTarget,
    preview: (ports, p) => {
      const v = memoryOrDeny(ports, p.memoryId, { metadataRequired: false });
      return preview({
        action: 'Forget a memory', actionId: 'COMPANION.MEMORY.FORGET', target: { kind: 'MEMORY', memoryId: p.memoryId }, memory: memoryCard(v),
        summary: `Forget memory ${p.memoryId} permanently`, changes: [{ field: 'memory', from: v.state, to: 'FORGOTTEN' }], parameters: p,
        effects: ['NB5_RECORD_PURGED', 'NB5_VECTOR_PURGED', 'COMPANION_METADATA_DELETED', 'COMPANION_MEMORY_PROPOSALS_DELETED', 'SESSION_REFERENCES_PURGED', 'DERIVED_CACHES_PURGED',
          'OPEN_ACTION_PROPOSALS_ON_THIS_MEMORY_SUPERSEDED', 'VERIFIED_AFTERWARDS: COMPLETE or FORGET_INCOMPLETE (remaining stores listed)', 'AUDIT_KEEPS_IDS_ONLY'],
        reversible: 'NO', privacyImpact: { level: 'TIGHTENS' }, confirmation: { level: 'EXPLICIT', phrase: `FORGET ${p.memoryId}` },
        pointOfNoReturn: 'NB5_DELETE: cancellable before it starts, never after',
      });
    },
    execute: async (ports, p) => {
      const r = await ports.companion.forget(p.memoryId);
      return { result: { memoryId: p.memoryId, forgetStatus: r.status, remainingStores: r.remainingStores, retryable: r.retryable }, complete: r.status === 'COMPLETE',
        resultCode: r.status === 'COMPLETE' ? 'FORGET_COMPLETE' : 'FORGET_INCOMPLETE',
        sideEffects: [{ kind: 'MEMORY_FORGOTTEN', status: r.status, remainingStores: r.remainingStores, transactional: false }] };
    },
  },
];

/**
 * Identified future actions — DEFINED, never executable here (no execute function exists). Root Policy classification only;
 * no capability is added. REC-DL-1 (local recording download) is a separate mission: noted, not implemented.
 */
const FUTURE = [
  { actionId: 'COMPANION.WEB.FETCH', riskClass: 'EXTERNAL_ACTION', status: 'DISABLED_CAPABILITY_REQUIRED', rootPolicy: 'CAPABILITY_REQUIRED', capability: 'WEB.PUBLIC_FETCH (Root Policy WEB_FETCH)', basis: 'network egress; the Companion holds no WEB capability' },
  { actionId: 'COMPANION.EMAIL.SEND', riskClass: 'EXTERNAL_ACTION', status: 'DISABLED_CAPABILITY_REQUIRED', rootPolicy: 'CAPABILITY_REQUIRED+HUMAN_APPROVAL_REQUIRED', capability: 'EMAIL.SEND (Root Policy EMAIL_SEND, impact HIGH, protected)', basis: 'leaves the machine on the user\'s behalf' },
  { actionId: 'COMPANION.SOCIAL.PUBLISH', riskClass: 'EXTERNAL_ACTION', status: 'DISABLED_CAPABILITY_REQUIRED', rootPolicy: 'CAPABILITY_REQUIRED+HUMAN_APPROVAL_REQUIRED', capability: 'SOCIAL.PUBLISH (Root Policy SOCIAL_PUBLISH, impact HIGH, protected)', basis: 'public, irreversible' },
  { actionId: 'COMPANION.CONTACT.SEND', riskClass: 'EXTERNAL_ACTION', status: 'DISABLED_CAPABILITY_REQUIRED', rootPolicy: 'CAPABILITY_REQUIRED+HUMAN_APPROVAL_REQUIRED', capability: 'none exists (support / contact form send)', basis: 'leaves the machine on the user\'s behalf' },
  { actionId: 'COMPANION.OSINT.LOOKUP', riskClass: 'EXTERNAL_ACTION', status: 'DISABLED_CAPABILITY_REQUIRED', rootPolicy: 'CAPABILITY_REQUIRED', capability: 'external OSINT module (paused before INV-4)', basis: 'background network research' },
  { actionId: 'COMPANION.FILES.SAVE_AS', riskClass: 'HIGH_IMPACT_ACTION', status: 'DISABLED_CAPABILITY_REQUIRED', rootPolicy: 'CAPABILITY_REQUIRED+HUMAN_APPROVAL_REQUIRED', capability: 'FILES.USER_SELECTED_WRITE (Root Policy FILE_WRITE)', basis: 'writes outside Docteur-owned stores; typed handles and allowed roots only' },
  { actionId: 'COMPANION.PROCESS.START', riskClass: 'HIGH_IMPACT_ACTION', status: 'DISABLED_CAPABILITY_REQUIRED', rootPolicy: 'CAPABILITY_REQUIRED+HUMAN_APPROVAL_REQUIRED', capability: 'PROCESS.START_TYPED (Root Policy PROCESS_START)', basis: 'process execution; never a generic shell' },
  { actionId: 'COMPANION.PAYMENT.PURCHASE', riskClass: 'HIGH_IMPACT_ACTION', status: 'DISABLED_CAPABILITY_REQUIRED', rootPolicy: 'CAPABILITY_REQUIRED+HUMAN_APPROVAL_REQUIRED', capability: 'none exists', basis: 'money' },
  { actionId: 'COMPANION.ACCOUNT.CREATE', riskClass: 'HIGH_IMPACT_ACTION', status: 'DISABLED_CAPABILITY_REQUIRED', rootPolicy: 'CAPABILITY_REQUIRED+HUMAN_APPROVAL_REQUIRED', capability: 'none exists', basis: 'identity on a third-party service' },
  { actionId: 'COMPANION.RECORDING.DOWNLOAD', riskClass: 'READ_ONLY', status: 'NOT_IMPLEMENTED_REC_DL_1', rootPolicy: 'EXISTING_CAPABILITY_SUFFICIENT (streaming an already-authorised local file); a copy to a chosen path = FILES.USER_SELECTED_WRITE', capability: null, basis: 'separate roadmap mission REC-DL-1' },
];

const REGISTRY = new Map(DEFINITIONS.map(d => [d.actionId, freezeDeep({
  ...d, requiresApproval: d.riskClass === 'LOCAL_MUTATION',
  cancelPolicy: d.riskClass === 'READ_ONLY' ? 'CANCELLABLE_UNTIL_RESULT' : d.mode === 'POINT_OF_NO_RETURN' ? 'CANCELLABLE_BEFORE_POINT_OF_NO_RETURN' : 'CANCELLABLE_UNTIL_TRANSACTION_COMMIT',
  auditPolicy: d.riskClass === 'READ_ONLY' ? 'EXECUTION_IDS_AND_CODES' : 'FULL_LIFECYCLE_IDS_AND_CODES',
  retryPolicy: 'NO_AUTOMATIC_RETRY',
})]));
const FUTURE_MAP = new Map(FUTURE.map(f => [f.actionId, freezeDeep({ ...f, enabled: false })]));
for (const d of REGISTRY.values()) if (!ENABLED_CLASSES.includes(d.riskClass)) throw new Error(`registry holds a disabled class: ${d.actionId}`);

export const FUTURE_ACTIONS = Object.freeze([...FUTURE_MAP.values()]);
export const ACTION_IDS = Object.freeze([...REGISTRY.keys()]);

/** The only way to an action definition: a known, enabled id. Anything else is DENY. */
export function lookupAction(actionId) {
  if (typeof actionId !== 'string') deny(ACTION_ERROR.UNKNOWN_ACTION, 'unknown action', { reason: 'NOT_A_STRING' });
  const def = REGISTRY.get(actionId);
  if (def) return def;
  const future = FUTURE_MAP.get(actionId);
  if (future) {
    if (future.riskClass === 'EXTERNAL_ACTION' || future.riskClass === 'HIGH_IMPACT_ACTION') deny(ACTION_ERROR.CAPABILITY_REQUIRED, `${actionId} is ${future.status}`, { reason: future.status, riskClass: future.riskClass, actionId });
    deny(ACTION_ERROR.ACTION_NOT_ALLOWED, `${actionId} is not implemented`, { reason: future.status, actionId });
  }
  return deny(ACTION_ERROR.UNKNOWN_ACTION, 'unknown action', { reason: 'NOT_IN_REGISTRY' });
}
export const isKnownAction = (actionId) => REGISTRY.has(actionId);

/** Read-only description of the registry (schemas included, functions excluded). */
export function describeRegistry() {
  return freezeDeep({
    frameworkVersion: ACTION_FRAMEWORK_VERSION, classes: CLASS_STATUS,
    actions: [...REGISTRY.values()].map(d => ({ actionId: d.actionId, version: d.version, class: d.riskClass, description: d.description, inputSchema: d.inputSchema,
      requiresApproval: d.requiresApproval, idempotency: d.idempotency, cancelPolicy: d.cancelPolicy, auditPolicy: d.auditPolicy, retryPolicy: d.retryPolicy, modelProposable: d.modelProposable, enabled: true })),
    futureActions: FUTURE_ACTIONS,
  });
}

// ── model output → action proposal (validation only; a model never executes, approves or confirms) ──
/** Fields that would claim an approval / execution. Their presence refuses the whole output (no silent stripping). */
export const MODEL_FORBIDDEN_FIELDS = Object.freeze(['approved', 'approval', 'approvalid', 'approvedby', 'approvedat', 'userconfirmed', 'confirmed', 'confirmation', 'confirmationphrase',
  'execute', 'executed', 'execution', 'run', 'autorun', 'signature', 'signed', 'token', 'digest', 'actiondigest', 'consume', 'force', 'bypass',
  'humanconfirmed', 'humanapproved', 'gesture', 'nonce', 'intent', 'uisessionid', 'typedphrase', 'acknowledgements']); // COMP-6A: human-approval intent fields
const MODEL_FIELDS = Object.freeze(['actionId', 'parameters']);
/**
 * Contract: the model may output exactly { actionId, parameters }. Text is parsed as JSON (bounded). Unknown field,
 * unknown action, invalid payload → refused; any approval / execution claim anywhere → ACTION_NOT_ALLOWED (MODEL_SELF_APPROVAL).
 */
export function parseModelActionOutput(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > ACTION_LIMITS.modelOutputBytes.value) invalid('MODEL_OUTPUT_TOO_LARGE');
    // [COMP-REMED-2] CR-1: strict parse — a duplicate key (any depth, decoded) is refused, never resolved last-wins
    try { obj = parseStrictJson(raw); } catch (e) { invalid(`MODEL_OUTPUT_${e?.details?.reason ?? 'NOT_JSON'}`); }
  }
  if (!isPlain(obj)) invalid('MODEL_OUTPUT_NOT_AN_OBJECT');
  const claims = [];
  const walk = (v, depth) => {
    if (depth > 6 || v === null || typeof v !== 'object') return;
    for (const k of Object.keys(v)) { if (MODEL_FORBIDDEN_FIELDS.includes(k.toLowerCase().replace(/[_-]/g, ''))) claims.push(k.slice(0, 40)); walk(v[k], depth + 1); }
  };
  walk(obj, 0);
  if (claims.length) deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'a model can propose an action, never approve, confirm or execute it', { reason: 'MODEL_SELF_APPROVAL', fields: claims.slice(0, 10) });
  for (const k of Object.keys(obj)) if (!MODEL_FIELDS.includes(k)) invalid('UNKNOWN_FIELD', k.slice(0, 40));
  const def = lookupAction(obj.actionId);
  return freezeDeep({ actionId: def.actionId, parameters: validateParameters(def, obj.parameters) });
}
