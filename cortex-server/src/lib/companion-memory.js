// Companion V1 — COMP-2 memory contracts over Docteur Memory (NB-5).
//
// NB-5 stays the durable source of truth. This module never writes a dmem_* table: a durable memory is created ONLY
// through the public NB-5 service (createMemoryService(...).createManual — the same primitive the NB-5 UI uses, which
// re-validates type / scope / length / secrets / sensitivity itself). The Companion then keeps its own metadata for
// that memory id (privacy scope, category, provenance), never the statement.
//
// Paths to durable memory:
//   USER_EXPLICIT  (sourceType USER_INPUT)  → rememberExplicit → NB-5
//   DERIVED        (model / rule)           → propose → PENDING (nothing written to NB-5) → user accepts → USER_CONFIRMED → NB-5
//   IMPORTED                                → propose with needsReview → user reviews AND accepts → USER_CONFIRMED → NB-5
//   an external source (web, document, notebook source, model) never writes a user fact directly
//   LEGACY_ADAPTIVE (preference_facts / episodic_memories) → refused, always (D4)
// Global memory OFF (preferences.memoryEnabled = false) ⇒ no proposal, no durable write, no context use, and session
// memory is off and purged too (V1 choice: GLOBAL OFF = every Companion memory OFF). Forgetting stays available.
// Cloud: only a CONTRACT here (evaluateCloudEligibility, D3: cloud_enabled === true). Nothing is ever sent.

import {
  fail, CompanionError, limit, cleanText, assertId, freezeDeep, sha256Hex, cleanProvenance, checkPrivacyTransition, defaultScopeFor, evaluateCloudEligibility,
  CATEGORY, DURABLE_CATEGORIES, NB5_TYPES_FOR, NB5_APPROVAL_SOURCE, PRIVACY_SCOPE, DEFAULT_PRIVACY_SCOPE,
} from './companion-contracts.js';
import { detectSecretMemory } from './companion-secrets.js';
import { CompanionSessionStore } from './companion-session.js';

/** The NB-5 public primitives the Companion is allowed to call (nothing else, no table access). */
export const NB5_PORT = Object.freeze(['createManual', 'getMemory', 'deleteMemory', 'listConflicts']);
const NB5_STATE = { APPROVED: 'ACTIVE', SUPERSEDED: 'SUPERSEDED', REVOKED: 'INVALIDATED', ARCHIVED: 'ARCHIVED' };
const MEMORY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const assertMemoryId = (id) => { if (typeof id !== 'string' || !MEMORY_ID_RE.test(id)) fail('COMP_INVALID_ID', 'invalid memory id'); return id; };

export class CompanionMemory {
  #store; #nb5; #session; #settings; #vectorProbe; #vectorPurge; #caches;

  /**
   * @param {object} deps
   *   store        CompanionStore
   *   nb5          the NB-5 memory service (createMemoryService(...)) — only NB5_PORT is used
   *   getSettings  () => router settings { cloud_enabled, strict_local_mode } (read only, for the cloud contract)
   *   vectorProbe  async (memoryId) => boolean   is a vector still present? (forget verification; NB-5 swallows vector errors)
   *   vectorPurge  async (memoryId) => void      retry of the vector deletion
   *   caches       [{ name, purge(id), has(id) }] derived caches to purge on forget (none exist in COMP-2)
   */
  constructor({ store, nb5, getSettings = () => ({}), vectorProbe = null, vectorPurge = null, caches = [] } = {}) {
    if (!store) fail('COMP_INTERNAL', 'store required');
    for (const fn of NB5_PORT) if (typeof nb5?.[fn] !== 'function') fail('COMP2_NB5_API_REQUIRED', `the NB-5 service must expose ${fn}`);
    this.#store = store; this.#nb5 = nb5; this.#settings = getSettings; this.#vectorProbe = vectorProbe; this.#vectorPurge = vectorPurge; this.#caches = caches;
    this.#session = new CompanionSessionStore({ now: () => Date.parse(store.at()), isEnabled: () => this.sessionEnabled() });
    Object.freeze(this);
  }

  get session() { return this.#session; }

  // ── preferences / global switch ──────────────────────────────────────────
  preferences() { return this.#store.getPreferences(); }
  sessionEnabled() { const p = this.preferences(); return p.memoryEnabled && p.sessionMemoryEnabled; }
  setPreferences(patch = {}) {
    const before = this.preferences();
    const after = this.#store.setPreferences(patch);
    const changed = Object.keys(after).filter(k => after[k] !== before[k]);
    if (changed.length) this.#store.audit('PREFERENCES_CHANGED', 'PREFERENCES', this.#store.ownerId, { details: { changed, memoryEnabled: after.memoryEnabled } });
    let purgedSessions = 0;
    if (!after.memoryEnabled || !after.sessionMemoryEnabled) purgedSessions = this.#session.purgeAll();
    return freezeDeep({ preferences: after, purgedSessions });
  }
  #requireOn({ proposals = false } = {}) {
    const p = this.preferences();
    if (!p.memoryEnabled) fail('COMP_MEMORY_DISABLED', 'Companion memory is off');
    if (proposals && !p.proposalEnabled) fail('COMP_PROPOSALS_DISABLED', 'Companion memory proposals are off');
  }

  // ── shared checks ────────────────────────────────────────────────────────
  #refuseSecret(text, objectType, objectId) {
    const s = detectSecretMemory(text);
    if (!s.refused) return;
    this.#store.audit('MEMORY_REFUSED_SECRET', objectType, objectId, { actor: 'SYSTEM', details: { kinds: s.kinds } });
    throw new CompanionError('COMP_REFUSE_MEMORY', 'REFUSE_MEMORY: a secret is never remembered', { decision: 'REFUSE_MEMORY', kinds: s.kinds });
  }
  #durableShape(category, { nb5Type, nb5Scope }) {
    if (!CATEGORY[category]) fail('COMP_UNKNOWN_CATEGORY', 'unknown memory category');
    if (!DURABLE_CATEGORIES.includes(category)) fail('COMP_NOT_DURABLE_CATEGORY', `${category} is session / proposal context only, never durable memory`);
    const type = nb5Type ?? NB5_TYPES_FOR[category][0];
    if (!NB5_TYPES_FOR[category].includes(type)) fail('COMP_INVALID_FIELD', `${category} maps to NB-5 ${NB5_TYPES_FOR[category].join(' / ')}`);
    const scope = nb5Scope ?? { kind: 'GLOBAL' };
    if (!scope || typeof scope !== 'object' || !['GLOBAL', 'PROJECT', 'NOTEBOOK'].includes(scope.kind) || Object.keys(scope).some(k => !['kind', 'projectId', 'notebookId'].includes(k))) fail('COMP_INVALID_FIELD', 'nb5Scope is { kind: GLOBAL | PROJECT | NOTEBOOK, projectId?, notebookId? }');
    return { type, scope };
  }
  #provenanceOrRefuse(provenance, objectId, opts) {
    try { return cleanProvenance(provenance, opts); } catch (e) {
      if (e.code === 'COMP_LEGACY_ADAPTIVE_UNSUPPORTED' || e.code === 'COMP_DIRECT_DURABLE_REFUSED') {
        this.#store.audit('MEMORY_REFUSED_SOURCE', 'MEMORY', objectId, { actor: 'SYSTEM', details: { code: e.code, sourceType: typeof provenance?.sourceType === 'string' ? provenance.sourceType.slice(0, 32) : null } });
      }
      throw e;
    }
  }
  /** NB-5 first (it owns the memory), then Companion metadata; if the metadata step fails, the NB-5 write is undone. */
  async #writeDurable({ category, value, type, scope, sensitivity, confirmSensitive, origin, approvalSource, metadata }) {
    const created = await this.#nb5.createManual({ type, statement: value, scope, sensitivity, confirmSensitive, approvalSource });
    const memoryId = created.memory.memoryId;
    try {
      this.#store.transaction(() => metadata(memoryId));
    } catch (e) {
      await this.#nb5.deleteMemory(memoryId).catch(() => {});
      throw e;
    }
    return { memoryId, category, origin };
  }

  // ── durable path 1: USER_EXPLICIT ────────────────────────────────────────
  /**
   * The user states a memory. provenance = { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT', sessionId?, evidenceRefs? }.
   * DERIVED → COMP_DERIVED_NEEDS_PROPOSAL; IMPORTED → COMP_IMPORTED_NEEDS_REVIEW; external source → COMP_DIRECT_DURABLE_REFUSED.
   */
  async rememberExplicit({ category, value, provenance, nb5Type, nb5Scope, sensitivity = 'NORMAL', confirmSensitive = false, privacyScope = null, privacyDecision = {}, reviewAfterDays = null } = {}) {
    this.#requireOn();
    if (provenance?.origin === 'DERIVED') fail('COMP_DERIVED_NEEDS_PROPOSAL', 'an inference becomes a proposal, never a memory directly');
    if (provenance?.origin === 'IMPORTED') fail('COMP_IMPORTED_NEEDS_REVIEW', 'an import becomes a proposal with needsReview');
    const prov = this.#provenanceOrRefuse(provenance, 'pending', {});
    const { type, scope } = this.#durableShape(category, { nb5Type, nb5Scope });
    const text = cleanText(value, limit('proposalValueChars'), 'value', { required: true });
    this.#refuseSecret(text, 'MEMORY', 'pending');
    const scopeTo = this.#initialScope(privacyScope, sensitivity, privacyDecision);
    const reviewAfter = this.#reviewAfter(reviewAfterDays);
    const out = await this.#writeDurable({
      category, value: text, type, scope, sensitivity, confirmSensitive, origin: 'USER_EXPLICIT', approvalSource: NB5_APPROVAL_SOURCE.USER_EXPLICIT,
      metadata: (memoryId) => {
        this.#store.insertMetadata({ memoryId, category, privacyScope: scopeTo, origin: 'USER_EXPLICIT', sourceType: prov.sourceType, sessionId: prov.sessionId, evidenceRefs: prov.evidenceRefs, at: this.#store.at(), reviewAfter });
        this.#store.audit('MEMORY_ADDED', 'MEMORY', memoryId, { details: { category, origin: 'USER_EXPLICIT', nb5Type: type, privacyScope: scopeTo, valueSha256: sha256Hex(text) } });
      },
    });
    return this.view(out.memoryId);
  }
  #initialScope(privacyScope, sensitivity, decision) {
    const base = defaultScopeFor(sensitivity);
    if (privacyScope === null || privacyScope === undefined) return base;
    if (!PRIVACY_SCOPE[privacyScope]) fail('COMP_INVALID_SCOPE', 'unknown privacy scope');
    return checkPrivacyTransition(base, privacyScope, { explicit: decision.explicit === true, releaseNeverCloud: decision.releaseNeverCloud === true, sensitivity });
  }
  #reviewAfter(days) {
    if (days === null || days === undefined) return null;
    if (!Number.isSafeInteger(days) || days < 1 || days > limit('reviewAfterDaysMax')) fail('COMP_INVALID_FIELD', `reviewAfterDays is 1..${limit('reviewAfterDaysMax')}`);
    return new Date(Date.parse(this.#store.at()) + days * 86_400_000).toISOString();
  }

  // ── durable path 2: proposals (DERIVED / IMPORTED) ───────────────────────
  /** A PENDING proposal writes nothing to NB-5. CLOUD_ALLOWED is never proposed (it is a user decision at acceptance). */
  propose({ kind, value, provenance, nb5Type, nb5Scope, privacyScope = DEFAULT_PRIVACY_SCOPE } = {}) {
    this.#requireOn({ proposals: true });
    if (provenance?.origin === 'USER_EXPLICIT' || provenance?.origin === 'USER_CONFIRMED') fail('COMP_INVALID_FIELD', 'a proposal is DERIVED or IMPORTED; a user statement uses rememberExplicit');
    const prov = this.#provenanceOrRefuse(provenance, 'pending', {});
    const { type, scope } = this.#durableShape(kind, { nb5Type, nb5Scope });
    const text = cleanText(value, limit('proposalValueChars'), 'value', { required: true });
    this.#refuseSecret(text, 'PROPOSAL', 'pending');
    if (!PRIVACY_SCOPE[privacyScope]) fail('COMP_INVALID_SCOPE', 'unknown privacy scope');
    if (privacyScope === 'CLOUD_ALLOWED') fail('COMP_CLOUD_SCOPE_NEEDS_DECISION', 'a proposal is never cloud-eligible: the user decides at acceptance');
    if (this.#store.findPendingByHash(kind, sha256Hex(text))) fail('COMP_DUPLICATE_PROPOSAL', 'the same proposal is already waiting for review');
    if (this.#store.countPending() >= limit('pendingProposals')) fail('COMP_REVIEW_QUEUE_FULL', `at most ${limit('pendingProposals')} pending proposals`);
    let id;
    this.#store.transaction(() => {
      id = this.#store.insertProposal({ kind, value: text, nb5Type: type, nb5Scope: scope, privacyScope, origin: prov.origin, sourceType: prov.sourceType, sessionId: prov.sessionId,
        evidenceRefs: prov.evidenceRefs, sourceReference: prov.sourceReference, derivedBy: prov.derivedBy, needsReview: prov.origin === 'IMPORTED' });
      this.#store.audit('MEMORY_PROPOSED', 'PROPOSAL', id, { actor: 'SYSTEM', details: { kind, origin: prov.origin, sourceType: prov.sourceType, needsReview: prov.origin === 'IMPORTED', valueSha256: sha256Hex(text) } });
    });
    return this.#store.getProposal(id);
  }

  listProposals({ status = 'PENDING' } = {}) { return this.#store.listProposals({ status }); }
  getProposal(proposalId) { assertId(proposalId, 'proposal id'); return this.#store.getProposal(proposalId) ?? fail('COMP_NOT_FOUND', 'proposal not found'); }

  /**
   * The user accepts (userConfirmed === true; reviewed === true as well for an IMPORTED proposal). The memory is written
   * through NB-5 (origin USER_CONFIRMED); the proposal keeps only the hash of its text.
   */
  async acceptProposal(proposalId, { userConfirmed = false, reviewed = false, editedValue = null, sensitivity = 'NORMAL', confirmSensitive = false, privacyScope = null, privacyDecision = {}, note = null } = {}) {
    this.#requireOn();
    const p = this.getProposal(proposalId);
    if (p.status !== 'PENDING') fail('COMP_PROPOSAL_DECIDED', `this proposal is ${p.status}`);
    if (userConfirmed !== true) fail('COMP_USER_CONFIRMATION_REQUIRED', 'only an explicit user confirmation turns a proposal into a memory');
    if (p.needsReview && reviewed !== true) fail('COMP_REVIEW_REQUIRED', 'an IMPORTED proposal is reviewed before it is accepted');
    const text = editedValue === null ? p.value : cleanText(editedValue, limit('proposalValueChars'), 'editedValue', { required: true });
    this.#refuseSecret(text, 'PROPOSAL', p.id);
    const decisionNote = cleanText(note, limit('decisionNoteChars'), 'note');
    // the proposed scope, tightened to NEVER_CLOUD by a HIGHLY_SENSITIVE memory; any change is an explicit user decision
    const base = defaultScopeFor(sensitivity) === 'NEVER_CLOUD' ? 'NEVER_CLOUD' : p.privacyScope;
    const scopeTo = privacyScope === null ? base
      : checkPrivacyTransition(base, privacyScope, { explicit: privacyDecision.explicit === true, releaseNeverCloud: privacyDecision.releaseNeverCloud === true, sensitivity });
    const out = await this.#writeDurable({
      category: p.kind, value: text, type: p.nb5Type, scope: p.nb5Scope, sensitivity, confirmSensitive, origin: 'USER_CONFIRMED', approvalSource: NB5_APPROVAL_SOURCE.USER_CONFIRMED,
      metadata: (memoryId) => {
        this.#store.decideProposal(p.id, 'ACCEPTED', { memoryId, note: decisionNote });
        this.#store.insertMetadata({ memoryId, category: p.kind, privacyScope: scopeTo, origin: 'USER_CONFIRMED', sourceType: p.provenance.sourceType, proposalId: p.id, sessionId: p.provenance.sessionId,
          evidenceRefs: p.provenance.evidenceRefs, sourceReference: p.provenance.sourceReference, derivedBy: p.provenance.derivedBy, at: this.#store.at() });
        this.#store.audit('MEMORY_ACCEPTED', 'PROPOSAL', p.id, { details: { memoryId, kind: p.kind, origin: p.provenance.origin, edited: editedValue !== null, privacyScope: scopeTo } });
      },
    });
    return this.view(out.memoryId);
  }

  rejectProposal(proposalId, { note = null } = {}) {
    const p = this.getProposal(proposalId);
    if (p.status !== 'PENDING') fail('COMP_PROPOSAL_DECIDED', `this proposal is ${p.status}`);
    const decisionNote = cleanText(note, limit('decisionNoteChars'), 'note');
    this.#store.transaction(() => {
      this.#store.decideProposal(p.id, 'REJECTED', { note: decisionNote });
      this.#store.audit('MEMORY_REJECTED', 'PROPOSAL', p.id, { details: { kind: p.kind, origin: p.provenance.origin } });
    });
    return this.getProposal(p.id);
  }

  /** A newer proposal replaces a pending one (the old one becomes SUPERSEDED, its text cleared). */
  supersedeProposal(proposalId, input) {
    const old = this.getProposal(proposalId);
    if (old.status !== 'PENDING') fail('COMP_PROPOSAL_DECIDED', `this proposal is ${old.status}`);
    const next = this.propose(input);
    this.#store.transaction(() => {
      this.#store.decideProposal(old.id, 'SUPERSEDED', { supersededBy: next.id });
      this.#store.audit('MEMORY_PROPOSAL_SUPERSEDED', 'PROPOSAL', old.id, { actor: 'SYSTEM', details: { by: next.id } });
    });
    return next;
  }

  /** A proposal whose basis disappeared (evidence invalidated, source forgotten). */
  invalidateProposal(proposalId, { reasonCode = 'SOURCE_INVALIDATED' } = {}) {
    const p = this.getProposal(proposalId);
    if (p.status !== 'PENDING') fail('COMP_PROPOSAL_DECIDED', `this proposal is ${p.status}`);
    if (!/^[A-Z_]{3,40}$/.test(reasonCode)) fail('COMP_INVALID_FIELD', 'reasonCode is an UPPER_CASE code');
    this.#store.transaction(() => {
      this.#store.decideProposal(p.id, 'INVALIDATED', { note: reasonCode });
      this.#store.audit('MEMORY_PROPOSAL_INVALIDATED', 'PROPOSAL', p.id, { actor: 'SYSTEM', details: { reasonCode } });
    });
    return this.getProposal(p.id);
  }

  // ── metadata, state, privacy ─────────────────────────────────────────────
  /** NB-5 is the truth: state derived from its status and OPEN conflicts; Companion metadata added when it exists. */
  view(memoryId) {
    assertMemoryId(memoryId);
    const m = this.#nb5.getMemory(memoryId);
    const meta = this.#store.getMetadata(memoryId);
    let state = 'MISSING';
    if (m) {
      state = NB5_STATE[m.status] ?? 'ACTIVE';
      if (state === 'ACTIVE' && this.#nb5.listConflicts({ status: 'OPEN', limit: 500 }).some(c => c.memoryA === memoryId || c.memoryB === memoryId)) state = 'DISPUTED';
    }
    return freezeDeep({
      memoryId, state, durableOwner: 'NB5', statement: m?.statement ?? null, nb5Status: m?.status ?? null, sensitivity: m?.sensitivity ?? null,
      freshness: m ? { confirmedAt: meta?.confirmedAt ?? m.approvedAt, lastPresentedAt: meta?.lastPresentedAt ?? null, validFrom: m.effectiveFrom, validTo: m.effectiveUntil, expiresAt: m.expiresAt, reviewAfter: meta?.reviewAfter ?? null } : null,
      companion: meta ? { category: meta.category, privacyScope: meta.privacyScope, companionEnabled: meta.companionEnabled, provenance: meta.provenance } : null,
      privacyScope: meta?.privacyScope ?? (m ? defaultScopeFor(m.sensitivity) : null),
    });
  }
  #meta(memoryId) {
    assertMemoryId(memoryId);
    return this.#store.getMetadata(memoryId) ?? fail('COMP_NOT_FOUND', 'no Companion metadata for this memory');
  }

  setPrivacyScope(memoryId, scope, { explicit = false, releaseNeverCloud = false } = {}) {
    const meta = this.#meta(memoryId);
    const sensitivity = this.#nb5.getMemory(memoryId)?.sensitivity ?? fail('COMP_NOT_FOUND', 'memory not found in NB-5');
    const to = checkPrivacyTransition(meta.privacyScope, scope, { explicit, releaseNeverCloud, sensitivity });
    if (to === meta.privacyScope) return this.view(memoryId);
    this.#store.transaction(() => {
      this.#store.updateMetadata(memoryId, { privacy_scope: to });
      this.#store.audit('PRIVACY_SCOPE_CHANGED', 'MEMORY', memoryId, { details: { from: meta.privacyScope, to, explicit } });
    });
    return this.view(memoryId);
  }
  setCompanionEnabled(memoryId, enabled) {
    const meta = this.#meta(memoryId);
    if (typeof enabled !== 'boolean') fail('COMP_INVALID_FIELD', 'enabled is a boolean');
    if (enabled === meta.companionEnabled) return this.view(memoryId);
    this.#store.transaction(() => {
      this.#store.updateMetadata(memoryId, { companion_enabled: enabled ? 1 : 0 });
      this.#store.audit(enabled ? 'MEMORY_ENABLED' : 'MEMORY_DISABLED', 'MEMORY', memoryId);
    });
    return this.view(memoryId);
  }
  /** A reminder only: nothing is ever deleted because a review date passed. */
  setReviewAfter(memoryId, days) {
    this.#meta(memoryId);
    const reviewAfter = this.#reviewAfter(days);
    this.#store.transaction(() => {
      this.#store.updateMetadata(memoryId, { review_after: reviewAfter });
      this.#store.audit('MEMORY_METADATA_CHANGED', 'MEMORY', memoryId, { details: { field: 'reviewAfter', set: reviewAfter !== null } });
    });
    return this.view(memoryId);
  }
  dueForReview() {
    const now = this.#store.at();
    return this.#store.listMetadata().filter(m => m.reviewAfter !== null && m.reviewAfter <= now).map(m => m.memoryId);
  }

  /** Records that memories were presented in a context (COMP-3 will call it). Memory OFF ⇒ refused (no memoryUsed). */
  markContextUsed(memoryIds, { requestId } = {}) {
    this.#requireOn();
    if (!Array.isArray(memoryIds) || !memoryIds.length || memoryIds.length > 20) fail('COMP_INVALID_FIELD', 'memoryIds lists 1..20 ids');
    const req = cleanText(requestId, 64, 'requestId', { required: true, multiline: false });
    const metas = memoryIds.map(id => this.#meta(id));
    if (metas.some(m => !m.companionEnabled)) fail('COMP_MEMORY_DISABLED', 'a disabled memory is never used in a context');
    this.#store.transaction(() => {
      for (const m of metas) this.#store.updateMetadata(m.memoryId, { last_presented_at: this.#store.at() });
      this.#store.audit('MEMORY_CONTEXT_USED', 'MEMORY', req, { actor: 'SYSTEM', details: { requestId: req, memoryIds: metas.map(m => m.memoryId) } });
    });
  }

  /**
   * COMP-3 context audit. Reuses the existing append-only Companion audit and updates freshness only for durable
   * memories that actually survived filtering/deduplication/budgeting. No context text is accepted or persisted.
   */
  recordContextAssembly({ requestId, memoryIds = [], itemIds = [], typeCounts = {}, privacyCounts = {}, truncationCount = 0 } = {}) {
    this.#requireOn();
    const req = cleanText(requestId, 64, 'requestId', { required: true, multiline: false });
    if (!Array.isArray(memoryIds) || memoryIds.length > 20) fail('COMP_INVALID_FIELD', 'memoryIds lists at most 20 ids');
    if (!Array.isArray(itemIds) || itemIds.length > 24) fail('COMP_INVALID_FIELD', 'itemIds lists at most 24 ids');
    const uniqueMemoryIds = [...new Set(memoryIds.map(assertMemoryId))];
    const safeItemIds = [...new Set(itemIds.map(id => cleanText(id, 128, 'itemId', { required: true, multiline: false })))];
    const counts = (value, what) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('COMP_INVALID_FIELD', `${what} must be an object`);
      const out = {};
      for (const [key, n] of Object.entries(value)) {
        if (!/^[A-Z_]{1,40}$/.test(key) || !Number.isSafeInteger(n) || n < 0 || n > 24) fail('COMP_INVALID_FIELD', `${what} contains an invalid count`);
        out[key] = n;
      }
      return out;
    };
    if (!Number.isSafeInteger(truncationCount) || truncationCount < 0 || truncationCount > 1000) fail('COMP_INVALID_FIELD', 'truncationCount is invalid');
    const metas = uniqueMemoryIds.map(id => this.#meta(id));
    if (metas.some(m => !m.companionEnabled)) fail('COMP_MEMORY_DISABLED', 'a disabled memory is never used in a context');
    this.#store.transaction(() => {
      for (const m of metas) this.#store.updateMetadata(m.memoryId, { last_presented_at: this.#store.at() });
      this.#store.audit('MEMORY_CONTEXT_USED', 'SESSION', req, { actor: 'SYSTEM', details: {
        requestId: req, memoryIds: uniqueMemoryIds, itemIds: safeItemIds,
        typeCounts: counts(typeCounts, 'typeCounts'), privacyCounts: counts(privacyCounts, 'privacyCounts'), truncationCount,
      } });
    });
  }

  /** Cloud gate CONTRACT for one memory (nothing is ever sent here). */
  cloudEligibility(memoryId, { cloudAllowed = false } = {}) {
    const v = this.view(memoryId);
    if (v.state === 'MISSING') return Object.freeze({ decision: 'DENY', reason: 'MISSING' });
    if (v.companion && !v.companion.companionEnabled) return Object.freeze({ decision: 'DENY', reason: 'DISABLED' });
    return evaluateCloudEligibility({ privacyScope: v.privacyScope, cloudAllowed, settings: this.#settings(), preferences: this.preferences() });
  }

  // ── forget (coordinated, verified) ───────────────────────────────────────
  /**
   * 1. NB-5 purge (its public deleteMemory) 2. Companion metadata 3. linked proposals 4. session references and caches
   * 5. verification of every store. COMPLETE only when nothing remains; otherwise FORGET_INCOMPLETE with the remaining
   * stores (retryable). While the NB-5 record still exists, its Companion metadata is KEPT (its privacy lock must not
   * disappear before the memory does). Forgetting works even when memory is OFF.
   */
  async forget(memoryId) {
    assertMemoryId(memoryId);
    this.#store.audit('FORGET_REQUESTED', 'MEMORY', memoryId);
    await this.#safe(() => this.#nb5.deleteMemory(memoryId)); // MEMORY_NOT_FOUND (already purged) or a failure: both are settled by the verification below
    if (this.#vectorProbe && this.#vectorPurge && await this.#safe(() => this.#vectorProbe(memoryId))) await this.#safe(() => this.#vectorPurge(memoryId));
    const recordGone = !this.#nb5.getMemory(memoryId);
    this.#store.transaction(() => {
      if (recordGone) this.#store.deleteMetadata(memoryId);
      this.#store.deleteProposalsForMemory(memoryId);
    });
    this.#session.purgeReferences(memoryId);
    for (const c of this.#caches) await this.#safe(() => c.purge(memoryId));
    const remaining = [];
    if (!recordGone || this.#nb5.getMemory(memoryId)) remaining.push('NB5_RECORD');
    if (this.#vectorProbe && await this.#safe(() => this.#vectorProbe(memoryId), true)) remaining.push('NB5_VECTOR');
    if (this.#store.getMetadata(memoryId)) remaining.push('COMPANION_METADATA');
    if (this.#store.countProposalsForMemory(memoryId)) remaining.push('COMPANION_PROPOSALS');
    if (this.#session.hasReference(memoryId)) remaining.push('SESSION_CONTEXT');
    for (const c of this.#caches) if (await this.#safe(() => c.has(memoryId), true)) remaining.push(`CACHE:${String(c.name).slice(0, 40)}`);
    const at = this.#store.at();
    const result = freezeDeep({ status: remaining.length ? 'FORGET_INCOMPLETE' : 'COMPLETE', memoryId, remainingStores: remaining, retryable: remaining.length > 0, timestamp: at });
    this.#store.audit(remaining.length ? 'FORGET_INCOMPLETE' : 'FORGET_COMPLETED', 'MEMORY', memoryId, { actor: 'SYSTEM', details: { remainingStores: remaining, retryable: remaining.length > 0 } });
    return result;
  }
  async #safe(fn, onError = false) { try { return await fn(); } catch { return onError; } }
}
