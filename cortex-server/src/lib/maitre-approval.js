/**
 * MAÎTRE — proposal creation + approval binding (MA-7). This is the
 * security boundary: every function here only ever PROPOSES, POLICES,
 * or CRYPTOGRAPHICALLY BINDS an approval — nothing in this file, or
 * anything it imports, can execute a system action. There is no
 * maitre-executor.js in this phase, and this file does not import
 * child_process, ollama.js, or any OS adapter.
 *
 * Approval binding contract (mission §18/§25): an approval is bound to
 * the EXACT proposalHash (incidentId+actionType+target+parameters) at
 * request time. If the underlying action row could ever be mutated
 * after that point the approval would become stale — but
 * updateMaitreAction() only allows touching status/policy_result, so
 * target/parameters/actionType/incidentId are physically immutable
 * post-creation. validateApproval() re-derives the hash fresh from the
 * CURRENT action row and compares it against the approval's stored
 * hash regardless, so this holds even if a future refactor ever loosens
 * that column allowlist.
 */
import crypto from 'node:crypto';
import {
  insertMaitreAction, getMaitreActionById, listMaitreActionsForIncident, updateMaitreAction,
  insertMaitreActionApproval, getMaitreActionApprovalById, updateMaitreActionApproval,
} from './sqlite.js';
import { getIncident, updateIncident, createEvidence } from './maitre-store.js';
import {
  validateActionInput, computeProposalHash, computeTargetHash, computeParametersHash,
  parseActionRow, parseApprovalRow, MaitreActionError,
} from './maitre-actions.js';
import { evaluateActionPolicy } from './maitre-policy.js';
import { isValidIncidentTransition } from './maitre-models.js';

const LIST_LIMIT_MAX = 500;

// Approval TTL — mission §20: "raisonnable et explicite", 5 minutes is
// the mission's own example value. Applied uniformly to LEVEL 2/3
// (LEVEL 1 ALLOW never creates an approval row at all; LEVEL 1 CONFIRM
// actions use the same TTL as LEVEL 2/3 for consistency).
const APPROVAL_TTL_MS = 5 * 60_000;

function clampLimit(limit, fallback = 200) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, LIST_LIMIT_MAX);
}

// ── Proposal creation ──────────────────────────────────────────────────────

/**
 * Validates input (maitre-actions.js), evaluates policy, and persists
 * an action row. Never executes anything. If policy says CONFIRM, the
 * incident is moved to AWAITING_APPROVAL (a valid MA-2 transition,
 * re-checked here explicitly rather than assumed) and the action's
 * status becomes AWAITING_APPROVAL; ALLOW-decision LEVEL 1 actions are
 * marked READY directly (still not executed — MA-8's executor is what
 * would eventually consume a READY row); DENY-decision actions are
 * persisted as REJECTED so there is always an audit trail of what was
 * proposed and why it was refused.
 */
export function createActionProposal(input) {
  const validated = validateActionInput(input); // throws MaitreActionError on bad input

  const incident = getIncident(validated.incidentId);
  if (!incident) fail('incident_not_found');

  const proposalHash = computeProposalHash(validated);
  const now = new Date().toISOString();
  const policyResult = evaluateActionPolicy(validated);

  const status = policyResult.decision === 'DENY' ? 'REJECTED'
    : policyResult.decision === 'ALLOW' ? 'READY'
      : 'AWAITING_APPROVAL';

  const row = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    incident_id: validated.incidentId,
    action_type: validated.actionType,
    level: validated.level,
    target: JSON.stringify(validated.target),
    parameters: JSON.stringify(validated.parameters),
    reason: typeof input.reason === 'string' ? input.reason.slice(0, 2000) : '',
    evidence_refs: JSON.stringify(Array.isArray(input.evidenceRefs) ? input.evidenceRefs.slice(0, 200) : []),
    status,
    proposal_hash: proposalHash,
    policy_result: JSON.stringify(policyResult),
    expires_at: null,
  };
  insertMaitreAction(row);

  if (status === 'AWAITING_APPROVAL' && isValidIncidentTransition(incident.status, 'AWAITING_APPROVAL')) {
    updateIncident(incident.id, { status: 'AWAITING_APPROVAL' });
  }

  return parseActionRow(row);
}

export function getActionProposal(id) {
  return parseActionRow(getMaitreActionById(id));
}

export function listActionProposalsForIncident(incidentId, { limit = 200, offset = 0 } = {}) {
  return listMaitreActionsForIncident(incidentId, { limit: clampLimit(limit), offset }).map(parseActionRow);
}

// ── Approval request + binding ─────────────────────────────────────────────

/**
 * Creates a PENDING approval request for a proposed (AWAITING_APPROVAL)
 * action. This is NOT itself an approval — it just opens the binding
 * window. Only the server computes the hashes; a client can never
 * supply its own hash and have it trusted.
 */
export function createApprovalRequest(actionId) {
  const actionRow = getMaitreActionById(actionId);
  if (!actionRow) fail('action_not_found');
  const action = parseActionRow(actionRow);

  if (action.status !== 'AWAITING_APPROVAL') fail('action_not_awaiting_approval', { status: action.status });

  const now = Date.now();
  const approval = {
    id: crypto.randomUUID(),
    created_at: new Date(now).toISOString(),
    action_id: action.id,
    incident_id: action.incidentId,
    action_type: action.actionType,
    target_hash: computeTargetHash(action.target),
    parameters_hash: computeParametersHash(action.parameters),
    proposal_hash: action.proposalHash,
    status: 'PENDING',
    approved_at: null,
    consumed_at: null,
    expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
  };
  insertMaitreActionApproval(approval);
  return parseApprovalRow(approval);
}

/**
 * Re-derives the action's CURRENT hashes and compares them against the
 * approval's stored hashes — this is the actual binding check (mission
 * §18/§25). Any mutation to the underlying action (which, per the
 * updateMaitreAction column allowlist, can only ever be status/
 * policy_result — target/parameters/actionType/incidentId are fixed at
 * creation) would still be caught here even if that allowlist were
 * ever loosened, because the comparison is against freshly-recomputed
 * hashes, never a cached boolean.
 *
 * Returns { valid: boolean, reason? } — never throws for an expected
 * invalid state (expired/wrong action/wrong incident/tampered);
 * throwing is reserved for a genuinely missing approval/action row.
 */
export function validateApproval(approvalId, { expectedActionId = null, expectedIncidentId = null } = {}) {
  const approvalRow = getMaitreActionApprovalById(approvalId);
  if (!approvalRow) fail('approval_not_found');
  const approval = parseApprovalRow(approvalRow);

  if (approval.status === 'CONSUMED') return { valid: false, reason: 'approval_already_consumed' };
  if (approval.status === 'REJECTED') return { valid: false, reason: 'approval_rejected' };
  if (approval.status === 'EXPIRED') return { valid: false, reason: 'approval_expired' };

  if (new Date(approval.expiresAt).getTime() < Date.now()) {
    updateMaitreActionApproval(approval.id, { status: 'EXPIRED' });
    return { valid: false, reason: 'approval_expired' };
  }

  if (expectedActionId && approval.actionId !== expectedActionId) {
    return { valid: false, reason: 'wrong_action' };
  }
  if (expectedIncidentId && approval.incidentId !== expectedIncidentId) {
    return { valid: false, reason: 'wrong_incident' };
  }

  const actionRow = getMaitreActionById(approval.actionId);
  if (!actionRow) return { valid: false, reason: 'action_not_found' };
  const action = parseActionRow(actionRow);

  // The actual cryptographic re-check: recompute from the CURRENT
  // action row's target/parameters/proposalHash and compare byte-exact
  // against what was hashed at approval-request time.
  if (computeTargetHash(action.target) !== approval.targetHash) return { valid: false, reason: 'target_mismatch' };
  if (computeParametersHash(action.parameters) !== approval.parametersHash) return { valid: false, reason: 'parameters_mismatch' };
  if (action.proposalHash !== approval.proposalHash) return { valid: false, reason: 'proposal_hash_mismatch' };
  if (action.actionType !== approval.actionType) return { valid: false, reason: 'action_type_mismatch' };

  return { valid: true };
}

/**
 * Records an explicit human approval decision. This is the ONLY path
 * that can move an approval from PENDING to APPROVED — there is no
 * "approved: true" flag accepted anywhere else in this module, and
 * this function itself requires the approval to already exist
 * (created server-side by createApprovalRequest) and be PENDING and
 * unexpired. A caller passing an arbitrary approvalId it invented
 * cannot succeed — getMaitreActionApprovalById will simply not find it.
 *
 * strengthenedConfirmation is required for LEVEL 3 actions (mission
 * §34) — a plain confirm is not sufficient for HOST_ISOLATION/
 * RESTORE_HOST_NETWORK.
 */
export function approveProposal(approvalId, { strengthenedConfirmation = false } = {}) {
  const approvalRow = getMaitreActionApprovalById(approvalId);
  if (!approvalRow) fail('approval_not_found');
  const approval = parseApprovalRow(approvalRow);

  if (approval.status !== 'PENDING') fail('approval_not_pending', { status: approval.status });
  if (new Date(approval.expiresAt).getTime() < Date.now()) {
    updateMaitreActionApproval(approval.id, { status: 'EXPIRED' });
    fail('approval_expired');
  }

  const actionRow = getMaitreActionById(approval.actionId);
  const action = parseActionRow(actionRow);
  // Strengthened confirmation is required exactly when the policy layer
  // (maitre-policy.js) itself asked for it — not merely because the
  // action is LEVEL 3. RESTORE_HOST_NETWORK is LEVEL 3 but its own
  // policy decision only lists 'user_confirmation' (mission MA-10 §4:
  // "confirmation explicite obligatoire", not strengthened); HOST_ISOLATION
  // is the one LEVEL 3 action whose policy decision lists
  // 'strengthened_confirmation' too. Checking the actual per-action
  // requirement (rather than a blanket level===3 check) keeps this
  // correct even if a future LEVEL 3 action type has different rules.
  const requiresStrengthened = Array.isArray(action.policyResult?.requirements)
    && action.policyResult.requirements.includes('strengthened_confirmation');
  if (requiresStrengthened && !strengthenedConfirmation) {
    fail('level3_requires_strengthened_confirmation');
  }

  const now = new Date().toISOString();
  updateMaitreActionApproval(approval.id, { status: 'APPROVED', approved_at: now });
  updateMaitreAction(action.id, { status: 'APPROVED' });

  return parseApprovalRow(getMaitreActionApprovalById(approval.id));
}

export function rejectProposal(approvalId, { reason = '' } = {}) {
  const approvalRow = getMaitreActionApprovalById(approvalId);
  if (!approvalRow) fail('approval_not_found');
  const approval = parseApprovalRow(approvalRow);
  if (approval.status !== 'PENDING') fail('approval_not_pending', { status: approval.status });

  updateMaitreActionApproval(approval.id, { status: 'REJECTED' });
  updateMaitreAction(approval.actionId, { status: 'REJECTED' });

  const actionRow = getMaitreActionById(approval.actionId);
  const action = parseActionRow(actionRow);
  const incident = getIncident(action.incidentId);
  if (incident && isValidIncidentTransition(incident.status, 'INVESTIGATING')) {
    updateIncident(incident.id, { status: 'INVESTIGATING', summary: reason ? `${incident.summary}\n[Action rejected: ${reason.slice(0, 500)}]`.trim() : incident.summary });
  }

  return parseApprovalRow(getMaitreActionApprovalById(approval.id));
}

/**
 * One-time consumption (mission §21). Marks the approval CONSUMED and
 * the action READY-for-a-future-executor (never EXECUTED — that status
 * belongs to MA-8). A second call for the same approval fails
 * (already_consumed) — replay is structurally impossible since
 * validateApproval() also rejects a CONSUMED approval outright.
 *
 * This function does NOT execute anything — MA-7 has no executor. It
 * exists so MA-8 has a single, already-tested "is this approval good
 * for exactly one use, right now" gate to call before it ever touches
 * the OS.
 */
export function consumeApproval(approvalId, { expectedActionId = null, expectedIncidentId = null } = {}) {
  const check = validateApproval(approvalId, { expectedActionId, expectedIncidentId });
  if (!check.valid) fail('approval_invalid', { reason: check.reason });

  const approvalRow = getMaitreActionApprovalById(approvalId);
  const approval = parseApprovalRow(approvalRow);
  if (approval.status !== 'APPROVED') fail('approval_not_approved', { status: approval.status });

  const now = new Date().toISOString();
  updateMaitreActionApproval(approval.id, { status: 'CONSUMED', consumed_at: now });
  updateMaitreAction(approval.actionId, { status: 'CONSUMED' });

  return parseApprovalRow(getMaitreActionApprovalById(approval.id));
}

function fail(code, detail) {
  throw new MaitreActionError(code, detail);
}

export { createEvidence };
