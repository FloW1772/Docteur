// Companion V1 — COMP-6A server half of the CompanionUiPort (a library: no route, not imported by server.js).
//
// COMP-6 will expose these methods over the local API; COMP-6A only tests them in-process. Each method maps to the
// COMP-5 framework (READ_ONLY actions for reads, proposals / gesture channel / execute for mutations) and shapes a DTO
// for the UI. The UI never becomes a security authority: every decision stays in COMP-5 and the gesture channel.
// DTO rules: no nonce, no full UI session id, no system prompt, no credential; a memory summary is a short excerpt of
// the NB-5 statement, withheld when it looks like a secret; model status comes ONLY from the existing model audit
// (no probe, no runtime start, no invented availability).

import { CompanionError, freezeDeep, parseStrictJson } from './companion-contracts.js';
import { detectSecretMemory } from './companion-secrets.js';
import { CONFIRMATION_KIND } from './companion-human-approval.js';
import { MODEL_FORBIDDEN_FIELDS } from './companion-action-registry.js';

export const UI_SUMMARY_CHARS = 140;
export const MODEL_UI_STATUS = Object.freeze(['LOCAL_AVAILABLE', 'LOCAL_UNAVAILABLE', 'NOT_RUN', 'RUNNING', 'TIMEOUT', 'CANCELLED', 'ERROR']);
const MAX_EXECUTIONS = 16;
/** [COMP-REMED-1] PROVISIONAL bounds: a model envelope (text + one proposal) and the open proposals shown in the panel. */
const MODEL_ENVELOPE_BYTES = 16 * 1024;
const MAX_LISTED_PROPOSALS = 20;
const EXEC_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Last model-audit outcome → UI status. No entry ⇒ NOT_RUN. Never a probe. */
export function deriveModelStatus(entries = []) {
  const last = [...entries].reverse().find(e => ['MODEL_REQUESTED', 'MODEL_SELECTED', 'MODEL_COMPLETED', 'MODEL_CANCELLED', 'MODEL_TIMEOUT', 'MODEL_FAILED'].includes(e.action));
  if (!last) return freezeDeep({ status: 'NOT_RUN', code: null, at: null, source: 'COMPANION_MODEL_AUDIT' });
  const code = typeof last.details?.code === 'string' ? last.details.code : null;
  const status = { MODEL_REQUESTED: 'RUNNING', MODEL_SELECTED: 'RUNNING', MODEL_COMPLETED: 'LOCAL_AVAILABLE', MODEL_CANCELLED: 'CANCELLED', MODEL_TIMEOUT: 'TIMEOUT' }[last.action]
    ?? (code === 'LOCAL_MODEL_UNAVAILABLE' ? 'LOCAL_UNAVAILABLE' : 'ERROR');
  return freezeDeep({ status, code, at: last.at, source: 'COMPANION_MODEL_AUDIT' });
}
/** A short excerpt for the person's own UI, withheld when it looks like a secret. */
export function summarize(text) {
  if (typeof text !== 'string' || !text) return { summary: null, withheld: null };
  if (detectSecretMemory(text).refused) return { summary: null, withheld: 'SECRET_SHAPE' };
  return { summary: text.length > UI_SUMMARY_CHARS ? `${text.slice(0, UI_SUMMARY_CHARS)}…` : text, withheld: null };
}
const asUiError = (e) => {
  if (e instanceof CompanionError) return new CompanionError(e.code, e.message, { reason: e.details?.reason ?? null, decision: e.details?.decision ?? null });
  return new CompanionError('ACTION_FAILED', 'unexpected error', { reason: 'INTERNAL' });
};
const wrap = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { throw asUiError(e); } };

/**
 * @param {object} deps
 *   actions    createCompanionActions(...) — UI_GESTURE channel
 *   companion  CompanionMemory (read: preferences / view)
 *   store      CompanionStore (read: schemaVersion / listModelAudit)
 */
export function createCompanionUiService({ actions, companion, store, activation = 'DISABLED_PENDING_HUMAN_ACTIVATION', now = Date.now } = {}) {
  if (actions?.approvalChannel !== 'UI_GESTURE') throw new CompanionError('COMP_INTERNAL', 'the UI service only runs on the UI_GESTURE approval channel');
  const executions = new Map();

  function proposalDto(p) {
    const preview = p.preview ? JSON.parse(JSON.stringify(p.preview)) : null;
    if (preview?.memory) Object.assign(preview.memory, (({ summary, withheld }) => ({ excerpt: summary, excerptWithheld: withheld }))(summarize(preview.memory.excerpt)));
    return freezeDeep({
      proposalId: p.proposalId, actionId: p.actionId, actionVersion: p.actionVersion, riskClass: p.riskClass, parameters: p.parameters, target: p.target,
      digest: p.digest, digestShort: p.digest.slice(0, 12), proposedBy: p.proposedBy, status: p.status, resultCode: p.resultCode,
      createdAt: p.createdAt, expiresAt: p.expiresAt, expired: p.expired, previewStale: p.previewStale, preview, idempotency: p.idempotency,
      confirmationKind: p.riskClass === 'READ_ONLY' ? 'NONE' : (CONFIRMATION_KIND[preview?.confirmation?.level] ?? 'UNKNOWN'),
      requiresApproval: p.requiresApproval,
    });
  }
  async function readOnly(actionId, parameters) {
    const r = await actions.user.runReadOnly({ actionId, parameters });
    if (r.status !== 'EXECUTED') throw new CompanionError(r.resultCode, `${actionId} did not complete`, { reason: r.status });
    return r.resultMetadata;
  }

  return Object.freeze({
    openUiSession: wrap(async () => actions.gesture.openUiSession()),
    closeUiSession: wrap(async (uiSessionId) => actions.gesture.closeUiSession(uiSessionId)),
    getStatus: wrap(async () => {
      const preferences = companion.preferences();
      return freezeDeep({ activation, schemaVersion: store.schemaVersion(), preferences, model: deriveModelStatus(store.listModelAudit()) });
    }),
    listMemories: wrap(async () => {
      const list = await readOnly('COMPANION.MEMORY.LIST', { limit: 100 });
      const at = new Date(now()).toISOString();
      return freezeDeep(list.memories.map(m => {
        const v = companion.view(m.memoryId);
        const prov = v.companion?.provenance ?? null;
        return {
          memoryId: m.memoryId, category: m.category, state: v.state, conflict: v.state === 'DISPUTED', privacyScope: v.privacyScope, companionEnabled: m.companionEnabled,
          sensitivity: v.sensitivity, ...(({ summary, withheld }) => ({ summary, summaryWithheld: withheld }))(summarize(v.statement)),
          provenance: prov ? { origin: prov.origin, sourceType: prov.sourceType, proposalId: prov.proposalId ?? null, evidenceCount: (prov.evidenceRefs ?? []).length } : null,
          freshness: v.freshness, reviewRequired: Boolean(v.freshness?.reviewAfter && v.freshness.reviewAfter <= at),
        };
      }));
    }),
    explainMemory: wrap(async (memoryId) => readOnly('COMPANION.MEMORY.EXPLAIN', { memoryId })),
    explainContext: wrap(async (requestId) => readOnly('COMPANION.CONTEXT.EXPLAIN', { requestId })),
    propose: wrap(async (actionId, parameters) => proposalDto(actions.user.propose({ actionId, parameters }))),
    /**
     * COMP-8B: Submit a model response that may contain an action proposal. Parses and validates the proposal, creating it with proposedBy='MODEL'.
     * [COMP-REMED-1] MODEL ONLY: rawOutput is required and is the only accepted field — the former fallback to
     * actions.user.propose() let anything posted here become a USER proposal (wrong origin, and an escape from the
     * model-only privacy-loosening refusal). Envelope { text?, actionProposal } only: any other envelope field is
     * refused (an approval / execution claim → MODEL_SELF_APPROVAL). Returns the FULL proposal view (preview, expiry,
     * confirmation kind) — the former id-only DTO left the review without a preview, so it could never be approved.
     */
    proposeFromModel: wrap(async (input) => {
      const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
      const refuse = (code, reason, message) => { throw new CompanionError(code, message, { reason, decision: `DENY_${code}` }); };
      if (!isPlain(input)) refuse('INVALID_ACTION_PAYLOAD', 'NOT_AN_OBJECT', 'model output expected');
      for (const k of Object.keys(input)) if (k !== 'rawOutput') refuse('INVALID_ACTION_PAYLOAD', 'UNKNOWN_FIELD', 'the model endpoint accepts only rawOutput');
      let raw = input.rawOutput;
      if (raw === undefined || raw === null) refuse('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_REQUIRED', 'rawOutput is required');
      if (typeof raw === 'string') {
        if (Buffer.byteLength(raw) > MODEL_ENVELOPE_BYTES) refuse('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_TOO_LARGE', 'model output too large');
        // [COMP-REMED-2] CR-1: strict parse — a duplicate key (any depth, decoded) refuses the whole envelope
        try { raw = parseStrictJson(raw); } catch (e) {
          const reason = e?.details?.reason ?? 'NOT_JSON';
          const message = { DUPLICATE_KEY: 'model output has a duplicate key', TOO_DEEP: 'model output is nested too deeply' }[reason] ?? 'model output is not JSON';
          refuse('INVALID_ACTION_PAYLOAD', `MODEL_OUTPUT_${reason}`, message);
        }
      }
      if (!isPlain(raw)) refuse('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_NOT_AN_OBJECT', 'model output must be an object');
      let proposalInput = raw;
      if (Object.prototype.hasOwnProperty.call(raw, 'actionProposal')) {
        const extra = Object.keys(raw).filter(k => k !== 'text' && k !== 'actionProposal');
        if (extra.some(k => MODEL_FORBIDDEN_FIELDS.includes(k.toLowerCase().replace(/[_-]/g, '')))) refuse('ACTION_NOT_ALLOWED', 'MODEL_SELF_APPROVAL', 'a model can propose an action, never approve, confirm or execute it');
        if (extra.length) refuse('INVALID_ACTION_PAYLOAD', 'ENVELOPE_UNKNOWN_FIELD', 'unknown model output field');
        if (raw.text !== undefined && typeof raw.text !== 'string') refuse('INVALID_ACTION_PAYLOAD', 'ENVELOPE_TEXT_NOT_STRING', 'text must be a string');
        proposalInput = raw.actionProposal;
      }
      const created = actions.model.proposeFromModelOutput(proposalInput);
      return proposalDto(actions.user.getProposal(created.proposalId));
    }),
    /** [COMP-REMED-1] Open proposals (PENDING / APPROVED, not expired), newest first, bounded — so the product panel can show model proposals. */
    listProposals: wrap(async () => {
      const open = [...actions.user.listProposals({ status: 'PENDING' }), ...actions.user.listProposals({ status: 'APPROVED' })]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, MAX_LISTED_PROPOSALS);
      return freezeDeep(open.map(r => proposalDto(actions.user.getProposal(r.proposalId))).filter(p => !p.expired));
    }),
    getProposal: wrap(async (proposalId) => proposalDto(actions.user.getProposal(proposalId))),
    issueChallenge: wrap(async (uiSessionId, proposalId) => {
      const c = actions.gesture.issueChallenge({ uiSessionId, proposalId });
      return freezeDeep({ ...c, actionDigestShort: c.actionDigest.slice(0, 12) });
    }),
    submitIntent: wrap(async (intent) => {
      const a = actions.gesture.submitIntent(intent);
      return freezeDeep({ approvalId: a.approvalId, proposalId: a.proposalId, approvedBy: a.approvedBy, approvedAt: a.approvedAt, expiresAt: a.expiresAt, singleUse: a.singleUse });
    }),
    // [COMP-REMED-1] proposalId is forwarded: a READ_ONLY proposal (e.g. model-proposed) runs through COMP-5's READ_ONLY
    // path, which checks the exact digest; a LOCAL_MUTATION still needs its approvalId (unchanged authority).
    execute: wrap(async ({ actionId, parameters, approvalId = null, proposalId = null, executionId }) => {
      if (typeof executionId !== 'string' || !EXEC_ID_RE.test(executionId)) throw new CompanionError('INVALID_ACTION_PAYLOAD', 'executionId required', { reason: 'EXECUTION_ID' });
      while (executions.size >= MAX_EXECUTIONS) executions.delete(executions.keys().next().value);
      const ctl = new AbortController(); executions.set(executionId, ctl);
      try { return await actions.user.execute({ actionId, parameters, approvalId, proposalId, signal: ctl.signal }); } finally { executions.delete(executionId); }
    }),
    /** Requests cancellation; the result of execute() says honestly whether it was honoured. */
    abortExecution: wrap(async (executionId) => { const c = executions.get(executionId); if (c) c.abort(); return Boolean(c); }),
    reject: wrap(async (proposalId) => proposalDto(actions.user.reject(proposalId))),
    cancel: wrap(async (proposalId) => proposalDto(actions.user.cancel(proposalId))),
  });
}
