// Companion V1 — COMP-5 typed local action framework + approvals.
//
//   MODEL OUTPUT → VALIDATION → ACTION PROPOSAL → PREVIEW → USER APPROVAL → EXECUTION        (never MODEL → EXECUTION)
//
// Two facets, no shared permission:
//   user   propose / getProposal / approve / reject / cancel / execute / runReadOnly / expireStale
//   model  proposeFromModelOutput — creates a proposal (validated by the registry) and nothing else: the object has no
//          approve and no execute, and an output that claims an approval / confirmation / execution is refused.
// LOCAL_MUTATION lifecycle: proposal (canonical digest + preview hash, PENDING, ≤ 10 min) → user approval (approvedBy
// USER, the digest the user saw, the confirmation phrase the preview demands; single-use, ≤ 300 s) → execution:
//   1. digest recomputed from the executed actionId + payload  ≠ approval / proposal → APPROVAL_DIGEST_MISMATCH
//   2. preview recomputed from the current state               ≠ approved preview  → PREVIEW_STALE (a new approval)
//   3. atomic consumption: UPDATE … WHERE consumed_at IS NULL AND not expired, in an IMMEDIATE transaction — of two
//      concurrent executions (same process or two processes) exactly one gets the row; the other APPROVAL_ALREADY_USED
//   4. SYNC_TRANSACTION actions: mutation + EXECUTED status + ACTION_EXECUTED audit in ONE transaction; cancellation is
//      checked before the mutation and again just before COMMIT (abort ⇒ ROLLBACK, effect NONE); after COMMIT a late
//      abort is reported honestly (cancellation requested, not honoured, effect FULL).
//      POINT_OF_NO_RETURN actions (forget): cancellable until the NB-5 delete starts, never after; the result is the
//      verified one (COMPLETE, or FAILED / FORGET_INCOMPLETE with the remaining stores — never a false success).
//   5. any error ⇒ FAILED, rolled back; 0 automatic retry (the approval is consumed: a new attempt needs a new approval).
// Every step is audited in companion_action_audit (append-only, hash-chained): ids, digest, class, status, codes,
// timestamps — never a parameter value outside ids / enums, a preview, a statement, a prompt or a secret.

import { CompanionError, newId, nowIso, sha256Hex, boundedJson, freezeDeep, limit } from './companion-contracts.js';
import { detectSecretInValue } from './companion-secrets.js';
import {
  ACTION_ERROR, ACTION_LIMITS, ACTION_CLASS, deny, lookupAction, validateParameters, canonicalJson, computeActionDigest, previewSha256, parseModelActionOutput, describeRegistry,
} from './companion-action-registry.js';
import { createHumanApprovalChannel } from './companion-human-approval.js';

export const ACTION_STATUS = Object.freeze(Object.fromEntries(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].map(s => [s, s])));
export const ACTION_AUDIT_EVENTS = Object.freeze(['ACTION_PROPOSED', 'ACTION_APPROVED', 'ACTION_REJECTED', 'ACTION_EXPIRED', 'ACTION_EXECUTION_STARTED',
  'ACTION_EXECUTED', 'ACTION_FAILED', 'ACTION_CANCELLED', 'APPROVAL_CONSUMED', 'ACTION_DENIED', 'ACTION_SUPERSEDED']);
const COMPANION_PORT = Object.freeze(['preferences', 'view', 'setPreferences', 'setCompanionEnabled', 'setPrivacyScope', 'forget']);
const OPEN = ['PENDING', 'APPROVED'];
/** COMP-6A: UI_GESTURE (default, product) = only the human approval channel approves; DIRECT_TEST_ONLY = the COMP-5 direct approve, refused unless DOCTEUR_TEST_MODE=1. */
export const APPROVAL_CHANNELS = Object.freeze(['UI_GESTURE', 'DIRECT_TEST_ONLY']);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class Cancelled extends Error { constructor(stage) { super('cancelled'); this.stage = stage; } }

/**
 * @param {object} deps
 *   store          CompanionStore (schema v3)
 *   companion      CompanionMemory (or a double exposing COMPANION_PORT on the SAME store)
 *   now            () => ms (default: the store clock)
 *   approvalTtlMs  ≤ 300 000 (default 120 000)
 *   approvalChannel 'UI_GESTURE' (default) | 'DIRECT_TEST_ONLY' (tests only: DOCTEUR_TEST_MODE=1)
 */
export function createCompanionActions({ store, companion, now = null, approvalTtlMs = ACTION_LIMITS.approvalTtlMs.value, approvalChannel = 'UI_GESTURE' } = {}) {
  if (!APPROVAL_CHANNELS.includes(approvalChannel)) throw new CompanionError('COMP_INTERNAL', 'unknown approval channel');
  if (approvalChannel === 'DIRECT_TEST_ONLY' && process.env.DOCTEUR_TEST_MODE !== '1') throw new CompanionError('COMP_INTERNAL', 'the direct approval channel exists for tests only');
  if (!store?.db || typeof store.schemaVersion !== 'function' || store.schemaVersion() < 3) throw new CompanionError('COMP_INTERNAL', 'a Companion store with the action schema (v3) is required');
  for (const fn of COMPANION_PORT) if (typeof companion?.[fn] !== 'function') throw new CompanionError('COMP_INTERNAL', `the Companion port must expose ${fn}`);
  if (!Number.isSafeInteger(approvalTtlMs) || approvalTtlMs < ACTION_LIMITS.approvalTtlMs.min || approvalTtlMs > ACTION_LIMITS.approvalTtlMs.max) throw new CompanionError('COMP_INTERNAL', 'approvalTtlMs is 5 s..300 s');
  const db = store.db;
  const owner = store.ownerId;
  const clock = now ?? (() => Date.parse(store.at()));
  const iso = () => nowIso(clock());
  const ports = Object.freeze({ companion, store: Object.freeze({ listMetadata: () => store.listMetadata(), listAudit: () => store.listAudit() }) });
  /** Writes always take the write lock first (IMMEDIATE), so a read-then-write never races another process. */
  const tx = (fn) => (db.inTransaction ? fn() : db.transaction(fn).immediate());

  // ── action audit (append-only, hash-chained) ──
  function audit(event, { def = null, riskClass = def?.riskClass ?? null, actionId = def?.actionId ?? null, proposalId = null, approvalId = null, digest = null, resultCode = null, details = {} } = {}) {
    if (!ACTION_AUDIT_EVENTS.includes(event)) throw new CompanionError('COMP_INTERNAL', 'invalid action audit event');
    if (detectSecretInValue(details).refused) throw new CompanionError('COMP_INTERNAL', 'action audit details must never carry a secret');
    const detailsJson = boundedJson(details, limit('auditDetailsBytes'), 'action audit details');
    return tx(() => {
      const prev = db.prepare('SELECT entry_hash FROM companion_action_audit WHERE owner_id = ? ORDER BY seq DESC LIMIT 1').get(owner)?.entry_hash ?? null;
      const id = newId(); const at = iso();
      const row = [id, owner, event, actionId, proposalId, approvalId, digest, riskClass, resultCode, at, detailsJson];
      db.prepare(`INSERT INTO companion_action_audit (audit_id, owner_id, event, action_id, proposal_id, approval_id, action_digest, risk_class, result_code, at, details_json, prev_hash, entry_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...row, prev, sha256Hex(JSON.stringify([...row, prev])));
      return id;
    });
  }
  function listAudit({ proposalId = null } = {}) {
    return db.prepare('SELECT * FROM companion_action_audit WHERE owner_id = ? ORDER BY seq').all(owner).filter(r => proposalId === null || r.proposal_id === proposalId).map(r => freezeDeep({
      id: r.audit_id, event: r.event, actionId: r.action_id, proposalId: r.proposal_id, approvalId: r.approval_id, digest: r.action_digest, riskClass: r.risk_class,
      resultCode: r.result_code, at: r.at, details: JSON.parse(r.details_json), prevHash: r.prev_hash, entryHash: r.entry_hash,
    }));
  }
  function verifyAudit() {
    let prev = null; let n = 0;
    for (const r of db.prepare('SELECT * FROM companion_action_audit WHERE owner_id = ? ORDER BY seq').all(owner)) {
      const row = [r.audit_id, r.owner_id, r.event, r.action_id, r.proposal_id, r.approval_id, r.action_digest, r.risk_class, r.result_code, r.at, r.details_json];
      if (r.prev_hash !== prev || r.entry_hash !== sha256Hex(JSON.stringify([...row, prev]))) return { ok: false, brokenAt: r.audit_id, entries: n };
      prev = r.entry_hash; n++;
    }
    return { ok: true, entries: n, head: prev };
  }
  /** Audited refusal (best effort: a refusal is never turned into a success because the audit failed). */
  function refuse(error, ctx = {}) {
    if (error instanceof CompanionError && error.details?.decision) {
      try { audit('ACTION_DENIED', { ...ctx, resultCode: error.code, details: { reason: String(error.details.reason ?? error.code).slice(0, 64), ...(error.details.field ? { field: /^[A-Za-z0-9_]{1,40}$/.test(String(error.details.field)) ? String(error.details.field) : 'NON_IDENTIFIER_FIELD' } : {}) } }); } catch { /* the refusal stands */ }
    }
    throw error;
  }
  const guard = (fn, ctx = () => ({})) => { try { return fn(); } catch (e) { return refuse(e, ctx()); } };

  // ── persistence ──
  const proposalRow = (r) => r && freezeDeep({
    proposalId: r.proposal_id, actionId: r.action_id, actionVersion: r.action_version, riskClass: r.risk_class, target: JSON.parse(r.target_json),
    parameters: JSON.parse(r.parameters_json), canonicalParameters: r.parameters_json, digest: r.action_digest, previewSha256: r.preview_sha256,
    proposedBy: r.proposed_by, status: r.status, resultCode: r.result_code, createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at, supersededBy: r.superseded_by,
  });
  const getRow = (proposalId) => proposalRow(db.prepare('SELECT * FROM companion_action_proposals WHERE owner_id = ? AND proposal_id = ?').get(owner, String(proposalId)));
  const approvalRow = (r) => r && freezeDeep({ approvalId: r.approval_id, proposalId: r.proposal_id, actionDigest: r.action_digest, approvedBy: r.approved_by, approvedAt: r.approved_at,
    expiresAt: r.expires_at, singleUse: r.single_use === 1, consumedAt: r.consumed_at });
  const getApproval = (approvalId) => approvalRow(db.prepare('SELECT * FROM companion_action_approvals WHERE owner_id = ? AND approval_id = ?').get(owner, String(approvalId)));
  /** Status moves forward only (the DB trigger enforces it too); returns false when another writer moved it first. */
  function setStatus(proposalId, from, to, { resultCode = null, supersededBy = null } = {}) {
    const r = db.prepare(`UPDATE companion_action_proposals SET status = ?, decided_at = ?, result_code = ?, superseded_by = ?
      WHERE owner_id = ? AND proposal_id = ? AND status IN (${from.map(() => '?').join(', ')})`).run(to, iso(), resultCode, supersededBy, owner, proposalId, ...from);
    return r.changes === 1;
  }
  const expired = (isoTime) => clock() >= Date.parse(isoTime);

  function build(def, parameters) {
    const params = validateParameters(def, parameters);
    const target = def.target(params, { ownerId: owner });
    const digest = computeActionDigest({ ownerId: owner, actionId: def.actionId, actionVersion: def.version, riskClass: def.riskClass, target, parameters: params });
    return { params, target, digest };
  }
  function previewOf(def, params) {
    let p;
    try { p = def.preview(ports, params); } catch (e) {
      if (e instanceof CompanionError && e.details?.decision) throw e;
      deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'the action target cannot be previewed', { reason: String(e?.code ?? 'PREVIEW_FAILED').slice(0, 60) });
    }
    return { preview: p, sha: previewSha256(p) };
  }

  // ── proposals ──
  function propose({ actionId, parameters } = {}, proposedBy) {
    let def = null;
    return guard(() => {
      def = lookupAction(actionId);
      const { params, target, digest } = build(def, parameters);
      const { preview, sha } = previewOf(def, params);
      if (proposedBy === 'MODEL') {
        if (!def.modelProposable) deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'a model cannot propose this action', { reason: 'MODEL_NOT_ALLOWED' });
        if (preview.privacyImpact?.level === 'LOOSENS_CLOUD') deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'a model never proposes to loosen privacy toward the cloud: the user starts it', { reason: 'MODEL_PRIVACY_LOOSENING' });
      }
      const at = iso(); const expiresAt = nowIso(clock() + ACTION_LIMITS.proposalTtlMs.value); const id = newId();
      const targetJson = canonicalJson(target, 512, 'action target');
      tx(() => {
        const open = db.prepare(`SELECT COUNT(*) AS n FROM companion_action_proposals WHERE owner_id = ? AND status IN ('PENDING','APPROVED') AND expires_at > ?`).get(owner, at).n;
        if (open >= ACTION_LIMITS.openProposals.value) deny(ACTION_ERROR.ACTION_NOT_ALLOWED, `at most ${ACTION_LIMITS.openProposals.value} open action proposals`, { reason: 'TOO_MANY_OPEN_PROPOSALS' });
        db.prepare(`INSERT INTO companion_action_proposals (proposal_id, owner_id, action_id, action_version, risk_class, target_json, parameters_json, action_digest, preview_sha256, proposed_by, status, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`).run(id, owner, def.actionId, def.version, def.riskClass, targetJson, canonicalJson(params), digest, sha, proposedBy, at, expiresAt);
        // one open proposal per action and target: a changed payload replaces the previous one (and voids its approval)
        for (const old of db.prepare(`SELECT proposal_id, action_digest FROM companion_action_proposals WHERE owner_id = ? AND action_id = ? AND target_json = ? AND proposal_id <> ? AND status IN ('PENDING','APPROVED')`).all(owner, def.actionId, targetJson, id)) {
          setStatus(old.proposal_id, OPEN, 'SUPERSEDED', { supersededBy: id });
          audit('ACTION_SUPERSEDED', { def, proposalId: old.proposal_id, digest: old.action_digest, details: { by: id } });
        }
        audit('ACTION_PROPOSED', { def, proposalId: id, digest, details: { proposedBy, requiresApproval: def.requiresApproval, confirmationLevel: preview.confirmation?.level ?? 'NONE', privacyImpact: preview.privacyImpact?.level ?? 'NONE' } });
      });
      return view(getRow(id), preview);
    }, () => ({ def, actionId: def?.actionId ?? null }));
  }
  function view(row, preview = undefined) {
    const def = lookupAction(row.actionId);
    let current = preview; let previewStale = false;
    if (current === undefined) {
      try { current = previewOf(def, row.parameters).preview; previewStale = previewSha256(current) !== row.previewSha256; } catch { current = null; previewStale = true; }
    }
    return freezeDeep({ ...row, preview: current, previewStale, requiresApproval: def.requiresApproval, idempotency: def.idempotency,
      confirmation: current?.confirmation ?? (def.requiresApproval ? null : { level: 'NONE' }), expired: OPEN.includes(row.status) && expired(row.expiresAt) });
  }
  function getProposal(proposalId) {
    const row = getRow(proposalId);
    if (!row) deny(ACTION_ERROR.PROPOSAL_NOT_FOUND, 'action proposal not found', { reason: 'PROPOSAL_NOT_FOUND' });
    return view(row);
  }
  const listProposals = ({ status = null } = {}) => db.prepare('SELECT * FROM companion_action_proposals WHERE owner_id = ? ORDER BY created_at, rowid').all(owner)
    .filter(r => status === null || r.status === status).map(proposalRow);

  function expireProposal(row, def) {
    tx(() => { if (setStatus(row.proposalId, OPEN, 'EXPIRED', { resultCode: 'EXPIRED' })) audit('ACTION_EXPIRED', { def, proposalId: row.proposalId, digest: row.digest, details: { from: row.status } }); });
  }
  /** Marks every open proposal whose proposal or approval time has passed. Returns the count. */
  function expireStale() {
    let n = 0;
    for (const row of listProposals().filter(r => OPEN.includes(r.status))) {
      const ap = row.status === 'APPROVED' ? approvalRow(db.prepare('SELECT * FROM companion_action_approvals WHERE owner_id = ? AND proposal_id = ?').get(owner, row.proposalId)) : null;
      if (expired(row.expiresAt) || (ap && !ap.consumedAt && expired(ap.expiresAt))) { expireProposal(row, lookupAction(row.actionId)); n++; }
    }
    return n;
  }

  // ── user approval ──
  /** Internal: reached only through the human approval channel (product) or the test-only direct channel. */
  function approve(proposalId, { approvedBy, digest, confirmationPhrase = null, expectedPreviewSha256 = null } = {}, channel = { channel: 'DIRECT_TEST_ONLY' }) {
    let row = null; let def = null;
    return guard(() => {
      if (approvedBy !== 'USER') deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'only the user approves an action', { reason: 'APPROVER_NOT_USER' });
      row = getRow(proposalId) ?? deny(ACTION_ERROR.PROPOSAL_NOT_FOUND, 'action proposal not found', { reason: 'PROPOSAL_NOT_FOUND' });
      def = lookupAction(row.actionId);
      if (def.riskClass !== ACTION_CLASS.LOCAL_MUTATION) deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'a READ_ONLY action needs no approval', { reason: 'APPROVAL_NOT_APPLICABLE' });
      if (row.status !== 'PENDING') deny(ACTION_ERROR.ACTION_NOT_ALLOWED, `this proposal is ${row.status}`, { reason: `PROPOSAL_${row.status}` });
      if (expired(row.expiresAt)) { expireProposal(row, def); deny(ACTION_ERROR.PROPOSAL_EXPIRED, 'this proposal expired: propose again', { reason: 'PROPOSAL_EXPIRED' }); }
      if (digest !== row.digest) deny(ACTION_ERROR.APPROVAL_DIGEST_MISMATCH, 'the approved digest is not the proposal digest', { reason: 'APPROVED_DIGEST_DIFFERS' });
      const { preview, sha } = previewOf(def, row.parameters);
      if (sha !== row.previewSha256 || (expectedPreviewSha256 !== null && expectedPreviewSha256 !== row.previewSha256)) deny(ACTION_ERROR.PREVIEW_STALE, 'the state changed since the preview: propose again', { reason: 'PREVIEW_STALE' });
      if (['EXPLICIT', 'REINFORCED'].includes(preview.confirmation.level) && confirmationPhrase !== preview.confirmation.phrase) {
        deny(ACTION_ERROR.CONFIRMATION_REQUIRED, `this action needs the ${preview.confirmation.level.toLowerCase()} confirmation phrase`, { reason: `${preview.confirmation.level}_CONFIRMATION_REQUIRED` });
      }
      // ≤ approvalTtlMs and never beyond the proposal itself (execution and expireStale then agree)
      const approvalId = newId(); const at = iso(); const expiresAt = nowIso(Math.min(clock() + approvalTtlMs, Date.parse(row.expiresAt)));
      tx(() => {
        db.prepare(`INSERT INTO companion_action_approvals (approval_id, owner_id, proposal_id, action_digest, approved_by, approved_at, expires_at, single_use) VALUES (?, ?, ?, ?, 'USER', ?, ?, 1)`)
          .run(approvalId, owner, row.proposalId, row.digest, at, expiresAt);
        if (!setStatus(row.proposalId, ['PENDING'], 'APPROVED')) deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'this proposal was decided meanwhile', { reason: 'PROPOSAL_DECIDED' });
        audit('ACTION_APPROVED', { def, proposalId: row.proposalId, approvalId, digest: row.digest, details: { approvedBy: 'USER', confirmationLevel: preview.confirmation.level, ttlMs: approvalTtlMs, ...channel } });
      });
      return getApproval(approvalId);
    }, () => ({ def, actionId: def?.actionId ?? null, proposalId: row?.proposalId ?? null }));
  }
  function decide(proposalId, to, event) {
    let row = null; let def = null;
    guard(() => {
      row = getRow(proposalId) ?? deny(ACTION_ERROR.PROPOSAL_NOT_FOUND, 'action proposal not found', { reason: 'PROPOSAL_NOT_FOUND' });
      def = lookupAction(row.actionId);
      tx(() => {
        if (!setStatus(row.proposalId, OPEN, to, { resultCode: to })) deny(ACTION_ERROR.ACTION_NOT_ALLOWED, `this proposal is ${getRow(proposalId).status}`, { reason: 'PROPOSAL_DECIDED' });
        audit(event, { def, proposalId: row.proposalId, digest: row.digest, details: { from: row.status, stage: 'BEFORE_START' } });
      });
    }, () => ({ def, proposalId: row?.proposalId ?? null }));
    return getProposal(proposalId);
  }

  // ── execution ──
  function result(def, { proposalId = null, approvalId = null, status, resultCode, startedAt, out = null, effectApplied, cancellation = { requested: false }, auditId }) {
    const completed = clock();
    return freezeDeep({
      actionId: def.actionId, actionVersion: def.version, riskClass: def.riskClass, proposalId, approvalId, status, resultCode,
      startedAt: nowIso(startedAt), completedAt: nowIso(completed), durationMs: completed - startedAt,
      resultMetadata: out?.result ?? null, sideEffects: out?.sideEffects ?? [], effectApplied, cancellation, idempotency: def.idempotency, automaticRetries: 0, auditId,
    });
  }
  const checkpointFor = (signal) => (stage) => { if (signal?.aborted) throw new Cancelled(stage); };
  const isSignal = (s) => s === null || (typeof s === 'object' && typeof s.aborted === 'boolean' && typeof s.addEventListener === 'function');

  /** READ_ONLY: no approval. Optional proposalId (a model-proposed read) must match the digest. Bounded by a timeout. */
  async function runReadOnly({ actionId, parameters, proposalId = null, signal = null } = {}) {
    let def = null; let built = null; let row = null;
    guard(() => {
      def = lookupAction(actionId);
      if (def.riskClass !== ACTION_CLASS.READ_ONLY) deny(ACTION_ERROR.APPROVAL_REQUIRED, 'this action changes local state: propose it, then approve it', { reason: 'NOT_READ_ONLY' });
      if (!isSignal(signal)) deny(ACTION_ERROR.INVALID_ACTION_PAYLOAD, 'signal must be an AbortSignal', { reason: 'INVALID_SIGNAL' });
      built = build(def, parameters);
      if (proposalId !== null) {
        row = getRow(proposalId) ?? deny(ACTION_ERROR.PROPOSAL_NOT_FOUND, 'action proposal not found', { reason: 'PROPOSAL_NOT_FOUND' });
        if (row.digest !== built.digest) deny(ACTION_ERROR.APPROVAL_DIGEST_MISMATCH, 'the payload is not the proposed one', { reason: 'PROPOSAL_DIGEST_DIFFERS' });
        if (row.status !== 'PENDING') deny(ACTION_ERROR.ACTION_NOT_ALLOWED, `this proposal is ${row.status}`, { reason: `PROPOSAL_${row.status}` });
        if (expired(row.expiresAt)) { expireProposal(row, def); deny(ACTION_ERROR.PROPOSAL_EXPIRED, 'this proposal expired', { reason: 'PROPOSAL_EXPIRED' }); }
      }
    }, () => ({ def, actionId: def?.actionId ?? null, proposalId: row?.proposalId ?? null, digest: built?.digest ?? null }));
    const started = clock(); const ids = { def, proposalId, digest: built.digest };
    const finish = (status, resultCode, out, extra) => {
      let auditId;
      tx(() => {
        if (row) setStatus(row.proposalId, ['PENDING'], status, { resultCode });
        auditId = audit(status === 'EXECUTED' ? 'ACTION_EXECUTED' : status === 'CANCELLED' ? 'ACTION_CANCELLED' : 'ACTION_FAILED', { ...ids, resultCode, details: { durationMs: clock() - started, ...extra } });
      });
      return result(def, { proposalId, status, resultCode, startedAt: started, out, effectApplied: 'NONE', cancellation: { requested: status === 'CANCELLED', honored: status === 'CANCELLED', stage: extra.stage ?? null }, auditId });
    };
    if (signal?.aborted) return finish('CANCELLED', ACTION_ERROR.ACTION_CANCELLED, null, { stage: 'BEFORE_START' });
    audit('ACTION_EXECUTION_STARTED', ids);
    const internal = new AbortController();
    const relay = () => internal.abort();
    signal?.addEventListener('abort', relay, { once: true });
    let timer = null;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { internal.abort(); reject(new CompanionError(ACTION_ERROR.ACTION_TIMEOUT, 'read-only action timed out')); }, ACTION_LIMITS.readOnlyTimeoutMs.value); });
    try {
      const out = await Promise.race([def.execute(ports, built.params, { checkpoint: checkpointFor(internal.signal) }), timeout]);
      if (internal.signal.aborted) return finish('CANCELLED', ACTION_ERROR.ACTION_CANCELLED, null, { stage: 'BEFORE_RESULT' });
      return finish('EXECUTED', 'OK', out, {});
    } catch (e) {
      if (e instanceof Cancelled) return finish('CANCELLED', ACTION_ERROR.ACTION_CANCELLED, null, { stage: e.stage });
      if (e?.code === ACTION_ERROR.ACTION_TIMEOUT) return finish('FAILED', ACTION_ERROR.ACTION_TIMEOUT, null, { stage: 'TIMEOUT' });
      return finish('FAILED', ACTION_ERROR.ACTION_FAILED, null, { error: String(e?.code ?? 'ERROR').slice(0, 60) });
    } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', relay); }
  }

  /**
   * Executes an action. READ_ONLY without approvalId → runReadOnly. LOCAL_MUTATION: approvalId + the exact approved
   * actionId / parameters. Refusals throw (DENY_*, audited); once the approval is consumed a structured result is
   * always returned (EXECUTED / FAILED / CANCELLED) and nothing is retried.
   */
  async function execute({ actionId, parameters, approvalId = null, proposalId = null, signal = null } = {}) {
    const peek = (() => { try { return lookupAction(actionId); } catch { return null; } })();
    if (peek?.riskClass === ACTION_CLASS.READ_ONLY && approvalId === null) return runReadOnly({ actionId, parameters, proposalId, signal });
    let def = null; let built = null; let ap = null; let row = null; let preview = null;
    guard(() => {
      def = lookupAction(actionId);
      if (!isSignal(signal)) deny(ACTION_ERROR.INVALID_ACTION_PAYLOAD, 'signal must be an AbortSignal', { reason: 'INVALID_SIGNAL' });
      built = build(def, parameters);
      if (def.riskClass !== ACTION_CLASS.LOCAL_MUTATION) deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'not an executable class', { reason: 'CLASS_NOT_EXECUTABLE' });
      if (approvalId === null || approvalId === undefined) deny(ACTION_ERROR.APPROVAL_REQUIRED, 'a local mutation needs a user approval', { reason: 'NO_APPROVAL' });
      if (typeof approvalId !== 'string' || !ID_RE.test(approvalId)) deny(ACTION_ERROR.APPROVAL_NOT_FOUND, 'unknown approval', { reason: 'APPROVAL_NOT_FOUND' });
      ap = getApproval(approvalId) ?? deny(ACTION_ERROR.APPROVAL_NOT_FOUND, 'unknown approval', { reason: 'APPROVAL_NOT_FOUND' });
      row = getRow(ap.proposalId);
      if (built.digest !== ap.actionDigest || built.digest !== row.digest) deny(ACTION_ERROR.APPROVAL_DIGEST_MISMATCH, 'the executed action is not the approved one', { reason: 'EXECUTED_DIGEST_DIFFERS' });
      if (ap.consumedAt) deny(ACTION_ERROR.APPROVAL_ALREADY_USED, 'this approval was already used', { reason: 'APPROVAL_CONSUMED' });
      if (expired(ap.expiresAt)) { expireProposal(row, def); deny(ACTION_ERROR.APPROVAL_EXPIRED, 'this approval expired: approve again', { reason: 'APPROVAL_EXPIRED' }); }
      if (row.status !== 'APPROVED') deny(ACTION_ERROR.ACTION_NOT_ALLOWED, `this proposal is ${row.status}`, { reason: `PROPOSAL_${row.status}` });
    }, () => ({ def, actionId: def?.actionId ?? null, proposalId: ap?.proposalId ?? null, approvalId: ap?.approvalId ?? null, digest: built?.digest ?? null }));
    const ids = { def, proposalId: row.proposalId, approvalId: ap.approvalId, digest: row.digest };
    const started = clock();
    const out = (status, resultCode, o, effectApplied, cancellation, auditId) => result(def, { proposalId: row.proposalId, approvalId: ap.approvalId, status, resultCode, startedAt: started, out: o, effectApplied, cancellation, auditId });

    if (signal?.aborted) {
      let auditId;
      tx(() => { setStatus(row.proposalId, ['APPROVED'], 'CANCELLED', { resultCode: ACTION_ERROR.ACTION_CANCELLED }); auditId = audit('ACTION_CANCELLED', { ...ids, resultCode: ACTION_ERROR.ACTION_CANCELLED, details: { stage: 'BEFORE_START', effectApplied: 'NONE', approvalConsumed: false } }); });
      return out('CANCELLED', ACTION_ERROR.ACTION_CANCELLED, null, 'NONE', { requested: true, honored: true, stage: 'BEFORE_START' }, auditId);
    }
    guard(() => {
      ({ preview } = previewOf(def, row.parameters));
      if (previewSha256(preview) !== row.previewSha256) deny(ACTION_ERROR.PREVIEW_STALE, 'the state changed since the approved preview: approve a new proposal', { reason: 'PREVIEW_STALE' });
    }, () => ids);

    // atomic, single-use consumption
    guard(() => tx(() => {
      const r = db.prepare('UPDATE companion_action_approvals SET consumed_at = ? WHERE owner_id = ? AND approval_id = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday(?)').run(iso(), owner, ap.approvalId, iso());
      if (r.changes !== 1) {
        if (getApproval(ap.approvalId).consumedAt) deny(ACTION_ERROR.APPROVAL_ALREADY_USED, 'this approval was already used', { reason: 'APPROVAL_CONSUMED_CONCURRENTLY' });
        deny(ACTION_ERROR.APPROVAL_EXPIRED, 'this approval expired', { reason: 'APPROVAL_EXPIRED' });
      }
      if (getRow(row.proposalId).status !== 'APPROVED') deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'this proposal was decided meanwhile', { reason: 'PROPOSAL_DECIDED' });
      audit('APPROVAL_CONSUMED', { ...ids, details: { singleUse: true } });
      audit('ACTION_EXECUTION_STARTED', { ...ids, details: { mode: def.mode, pointOfNoReturn: def.mode === 'POINT_OF_NO_RETURN' ? 'BEFORE_EXTERNAL_STORE_WRITE' : 'TRANSACTION_COMMIT' } });
    }), () => ids);

    const checkpoint = checkpointFor(signal);
    const failed = (e, stage) => {
      let auditId;
      const code = e instanceof Cancelled ? ACTION_ERROR.ACTION_CANCELLED : ACTION_ERROR.ACTION_FAILED;
      const status = e instanceof Cancelled ? 'CANCELLED' : 'FAILED';
      tx(() => {
        setStatus(row.proposalId, ['APPROVED'], status, { resultCode: code });
        auditId = audit(status === 'CANCELLED' ? 'ACTION_CANCELLED' : 'ACTION_FAILED', { ...ids, resultCode: code, details: { stage: e instanceof Cancelled ? e.stage : stage, effectApplied: 'NONE', rolledBack: true, approvalConsumed: true, error: e instanceof Cancelled ? null : String(e?.code ?? 'ERROR').slice(0, 60) } });
      });
      return out(status, code, null, 'NONE', e instanceof Cancelled ? { requested: true, honored: true, stage: e.stage } : { requested: Boolean(signal?.aborted), honored: false, stage: null }, auditId);
    };

    if (def.mode === 'SYNC_TRANSACTION') {
      let o; let auditId;
      try {
        tx(() => {
          checkpoint('BEFORE_MUTATION');
          o = def.execute(ports, row.parameters, { preview });
          checkpoint('BEFORE_COMMIT');
          if (!setStatus(row.proposalId, ['APPROVED'], 'EXECUTED', { resultCode: 'OK' })) throw new CompanionError('COMP_INTERNAL', 'proposal state changed during execution');
          auditId = audit('ACTION_EXECUTED', { ...ids, resultCode: 'OK', details: { effectApplied: 'FULL', sideEffects: o.sideEffects.map(s => s.kind) } });
        });
      } catch (e) { return failed(e, 'MUTATION'); }
      const late = Boolean(signal?.aborted);
      return out('EXECUTED', 'OK', o, 'FULL', { requested: late, honored: false, stage: late ? 'AFTER_COMMIT' : null }, auditId);
    }

    // POINT_OF_NO_RETURN (multi-store; each store keeps its own transaction)
    try { checkpoint('BEFORE_POINT_OF_NO_RETURN'); } catch (e) { return failed(e, 'BEFORE_POINT_OF_NO_RETURN'); }
    let o;
    try { o = await def.execute(ports, row.parameters, { preview }); } catch (e) {
      let auditId;
      tx(() => { setStatus(row.proposalId, ['APPROVED'], 'FAILED', { resultCode: ACTION_ERROR.ACTION_FAILED }); auditId = audit('ACTION_FAILED', { ...ids, resultCode: ACTION_ERROR.ACTION_FAILED, details: { stage: 'AFTER_POINT_OF_NO_RETURN', effectApplied: 'UNKNOWN', error: String(e?.code ?? 'ERROR').slice(0, 60) } }); });
      return out('FAILED', ACTION_ERROR.ACTION_FAILED, null, 'UNKNOWN', { requested: Boolean(signal?.aborted), honored: false, stage: signal?.aborted ? 'AFTER_POINT_OF_NO_RETURN' : null }, auditId);
    }
    const status = o.complete ? 'EXECUTED' : 'FAILED';
    let auditId;
    tx(() => {
      setStatus(row.proposalId, ['APPROVED'], status, { resultCode: o.resultCode });
      if (def.supersedesTargetProposals) {
        for (const other of db.prepare(`SELECT proposal_id, action_id, action_digest FROM companion_action_proposals WHERE owner_id = ? AND target_json = ? AND proposal_id <> ? AND status IN ('PENDING','APPROVED')`).all(owner, canonicalJson(row.target, 512, 'action target'), row.proposalId)) {
          setStatus(other.proposal_id, OPEN, 'SUPERSEDED', { supersededBy: row.proposalId });
          audit('ACTION_SUPERSEDED', { actionId: other.action_id, riskClass: 'LOCAL_MUTATION', proposalId: other.proposal_id, digest: other.action_digest, details: { by: row.proposalId, reason: 'TARGET_FORGOTTEN' } });
        }
      }
      auditId = audit(status === 'EXECUTED' ? 'ACTION_EXECUTED' : 'ACTION_FAILED', { ...ids, resultCode: o.resultCode, details: { effectApplied: o.complete ? 'FULL' : 'PARTIAL', remainingStores: o.result.remainingStores ?? [] } });
    });
    const late = Boolean(signal?.aborted);
    return out(status, o.resultCode, o, o.complete ? 'FULL' : 'PARTIAL', { requested: late, honored: false, stage: late ? 'AFTER_POINT_OF_NO_RETURN' : null }, auditId);
  }

  // ── facets ──
  /** Product mode: a plain call can never approve — not even with approvedBy USER or a humanConfirmed flag. */
  function directApprove(proposalId, opts = {}) {
    if (approvalChannel !== 'DIRECT_TEST_ONLY') {
      return guard(() => deny(ACTION_ERROR.APPROVAL_REQUIRED, 'an approval comes only from a confirmed gesture in the Companion UI', { reason: 'HUMAN_GESTURE_REQUIRED' }),
        () => ({ proposalId: typeof proposalId === 'string' && ID_RE.test(proposalId) ? proposalId : null }));
    }
    return approve(proposalId, { approvedBy: opts?.approvedBy, digest: opts?.digest, confirmationPhrase: opts?.confirmationPhrase ?? null }, { channel: 'DIRECT_TEST_ONLY' });
  }
  const gesture = createHumanApprovalChannel({
    clock, refuse,
    getPending: (proposalId) => {
      const row = (typeof proposalId === 'string' && ID_RE.test(proposalId) ? getRow(proposalId) : null) ?? deny(ACTION_ERROR.PROPOSAL_NOT_FOUND, 'action proposal not found', { reason: 'PROPOSAL_NOT_FOUND' });
      return view(row);
    },
    approve: (proposalId, opts, channel) => approve(proposalId, { approvedBy: 'USER', ...opts }, channel),
  });
  const user = Object.freeze({
    propose: (input) => propose(input, 'USER'), getProposal, listProposals, approve: directApprove,
    reject: (proposalId) => decide(proposalId, 'REJECTED', 'ACTION_REJECTED'), cancel: (proposalId) => decide(proposalId, 'CANCELLED', 'ACTION_CANCELLED'),
    execute, runReadOnly, expireStale,
  });
  const model = Object.freeze({
    /** Validates a model output ({ actionId, parameters } only) and creates a PENDING proposal. Returns ids, never a preview. */
    proposeFromModelOutput(raw) {
      let parsed;
      try { parsed = parseModelActionOutput(raw); } catch (e) { return refuse(e, { details: { proposedBy: 'MODEL' } }); }
      const p = propose(parsed, 'MODEL');
      return freezeDeep({ proposalId: p.proposalId, actionId: p.actionId, riskClass: p.riskClass, status: p.status, requiresApproval: p.requiresApproval, digest: p.digest, proposedBy: p.proposedBy });
    },
  });
  return Object.freeze({ registry: describeRegistry(), approvalChannel, user, model, gesture, audit: Object.freeze({ list: listAudit, verify: verifyAudit }) });
}
