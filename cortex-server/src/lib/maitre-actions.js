/**
 * MAÎTRE — action proposal model (MA-7). Closed action-type enum, fixed
 * level assignment (server-side only, never client-chosen), per-action
 * schema validation, canonical serialization, and SHA-256 proposal
 * hashing. NO executor here — this file has zero imports of
 * child_process, no OS adapters, nothing that could run a command.
 *
 * Every action type has its OWN typed parameter schema (mission §30) —
 * there is no generic {command: "..."} shape anywhere in this file.
 */
import crypto from 'node:crypto';
import { classifyProcessCriticality } from './maitre-process-inspector.js';

export class MaitreActionError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'MaitreActionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new MaitreActionError(code, detail);
}

// ── Closed action-type enum + fixed level (mission §3/§7) ─────────────────
// Level is assigned HERE, in code, never accepted from a caller —
// buildActionProposal() below always looks up the level from this table
// and ignores/rejects any client-supplied level field.
export const ACTION_LEVELS = Object.freeze({
  SCAN_WITH_DEFENDER: 1,
  COLLECT_EVIDENCE: 1,
  TERMINATE_PROCESS: 2,
  QUARANTINE_WITH_DEFENDER: 2,
  BLOCK_REMOTE_IP: 2,
  DISABLE_PERSISTENCE_ENTRY: 2,
  HOST_ISOLATION: 3,
  RESTORE_HOST_NETWORK: 3,
});

export const ACTION_TYPES = Object.freeze(Object.keys(ACTION_LEVELS));

export const ACTION_STATUSES = Object.freeze([
  'PROPOSED', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'READY', 'CONSUMED',
]);

// Forbidden parameter/target key names — a shell-shaped or arbitrary-
// command field must never even parse as a valid proposal, regardless
// of actionType (mission §31). Checked generically across ALL action
// types' target/parameters before the per-type schema check even runs.
const FORBIDDEN_KEY_PATTERN = /^(command|cmd|shell|powershell|script|args|exec|execute|toolCall|tool_call)$/i;

function assertNoForbiddenKeys(obj, label) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) fail(`${label}_forbidden_key`, { key });
  }
}

// ── Per-action-type target/parameter schemas ───────────────────────────────
// Each validator returns a normalized {target, parameters} pair or
// throws MaitreActionError. No action type accepts a freeform object —
// every field is named and typed.

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLoopbackOrGlobalIp(ip) {
  if (ip === '::1' || ip === 'localhost') return true;
  if (ip === '0.0.0.0' || ip === '::' || ip === '0.0.0.0/0' || ip === '::/0') return true;
  const m = ip.match(IPV4_PATTERN);
  if (m) {
    const first = Number(m[1]);
    if (first === 127) return true; // 127.0.0.0/8
    if (m.slice(1).every(o => Number(o) === 0)) return true; // 0.0.0.0
  }
  return false;
}

function isValidIpLiteral(ip) {
  if (typeof ip !== 'string') return false;
  if (IPV4_PATTERN.test(ip)) {
    return ip.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
  }
  // Minimal IPv6 literal check — full parsing is out of scope; reject
  // anything containing characters outside hex/colon, which also
  // rejects domain strings and shell fragments by construction.
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':')) return true;
  return false;
}

const VALIDATORS = {
  SCAN_WITH_DEFENDER(input) {
    const path = input?.target?.path;
    if (typeof path !== 'string' || path.trim().length === 0) fail('scan_target_path_required');
    if (path.startsWith('\\\\')) fail('scan_target_unc_denied');
    return { target: { path }, parameters: {} };
  },

  COLLECT_EVIDENCE(input) {
    const evidenceType = input?.target?.evidenceType;
    const EVIDENCE_TYPES = ['PROCESS_SNAPSHOT', 'FILE_METADATA', 'FILE_HASH', 'DEFENDER_RESULT', 'EVENT_LOG_EXCERPT', 'NETWORK_REFERENCE', 'PERSISTENCE_METADATA', 'FIREWALL_STATE', 'DOCTEUR_INTEGRITY', 'OTHER'];
    if (!EVIDENCE_TYPES.includes(evidenceType)) fail('collect_evidence_type_invalid', { evidenceType });

    // MA-8 addition: evidenceType alone says WHAT KIND of evidence, not
    // WHAT TO COLLECT IT ABOUT (mission §5 — "collecter seulement ce
    // que le proposal cible explicitement"). Each type that needs a
    // concrete subject requires one here; types that are inherently
    // scopeless (DEFENDER_RESULT reads current status, FIREWALL_STATE
    // reads current state) need no further target field.
    const target = { evidenceType };
    if (evidenceType === 'PROCESS_SNAPSHOT') {
      const pid = Number(input?.target?.pid);
      if (!Number.isInteger(pid) || pid < 0) fail('collect_evidence_pid_required');
      target.pid = pid;
    } else if (evidenceType === 'FILE_METADATA' || evidenceType === 'FILE_HASH') {
      const path = input?.target?.path;
      if (typeof path !== 'string' || path.trim().length === 0) fail('collect_evidence_path_required');
      if (path.startsWith('\\\\')) fail('collect_evidence_path_unc_denied');
      target.path = path;
    } else if (evidenceType === 'PERSISTENCE_METADATA') {
      // Scopeless by design in V1 — collects the current bounded
      // persistence snapshot rather than requiring the caller to name
      // one specific item (persistence items are already individually
      // addressable via DISABLE_PERSISTENCE_ENTRY, a different action).
    }

    return { target, parameters: {} };
  },

  TERMINATE_PROCESS(input) {
    const pid = Number(input?.target?.pid);
    const processIdentity = input?.target?.processIdentity;
    if (!Number.isInteger(pid) || pid < 0) fail('terminate_pid_invalid');
    if (typeof processIdentity !== 'string' || processIdentity.trim().length === 0) fail('terminate_process_identity_required');

    // Reuse MA-4's classification — never a second, inconsistent
    // denylist (mission §11).
    const criticality = classifyProcessCriticality({ pid, name: processIdentity });
    if (criticality === 'SYSTEM_CRITICAL') fail('terminate_denied_system_critical', { pid, processIdentity });
    if (criticality === 'DOCTEUR_CRITICAL') fail('terminate_denied_docteur_critical', { pid, processIdentity });

    const executablePath = typeof input?.target?.executablePath === 'string' ? input.target.executablePath : null;
    // startTime (MA-9 addition): PID alone is not a sufficient identity
    // — PIDs are reused by Windows once a process exits (mission §5).
    // Capturing the process's own startTime at proposal time lets the
    // executor re-verify, immediately before termination, that the
    // process currently holding this PID is still the SAME process
    // instance, not a different one that happens to have been assigned
    // the same PID since.
    const startTime = typeof input?.target?.startTime === 'string' ? input.target.startTime : null;
    return { target: { pid, processIdentity, executablePath, startTime }, parameters: {} };
  },

  QUARANTINE_WITH_DEFENDER(input) {
    const path = input?.target?.path;
    if (typeof path !== 'string' || path.trim().length === 0) fail('quarantine_target_path_required');
    // Device paths (\\.\, \\?\) are checked BEFORE the generic UNC
    // check below, since both share the \\ prefix and device paths are
    // the more specific, more actionable denial reason.
    if (path.startsWith('\\\\.\\') || path.startsWith('\\\\?\\')) fail('quarantine_target_device_path_denied');
    if (path.startsWith('\\\\')) fail('quarantine_target_unc_denied');
    if (path.endsWith('\\') || path.endsWith('/')) fail('quarantine_target_directory_denied');
    return { target: { path }, parameters: {} };
  },

  BLOCK_REMOTE_IP(input) {
    const ip = input?.target?.ip;
    // Known-forbidden literal shapes (including CIDR-suffixed globals
    // like 0.0.0.0/0 or ::/0, which would otherwise fail the plain-IP
    // literal check below with a less specific reason) are checked
    // FIRST so the denial reason is always the most informative one.
    if (typeof ip === 'string' && isLoopbackOrGlobalIp(ip)) fail('block_ip_denied_loopback_or_global', { ip });
    if (!isValidIpLiteral(ip)) fail('block_ip_invalid_literal', { ip });
    if (typeof ip === 'string' && ip.includes('*')) fail('block_ip_wildcard_denied');

    const direction = ['inbound', 'outbound', 'both'].includes(input?.parameters?.direction) ? input.parameters.direction : 'outbound';
    const protocol = ['tcp', 'udp', 'any'].includes(input?.parameters?.protocol) ? input.parameters.protocol : 'any';
    return { target: { ip }, parameters: { direction, protocol } };
  },

  DISABLE_PERSISTENCE_ENTRY(input) {
    // Must target an item already identified by MA-4's persistence
    // inspector via its own id — never a freeform path/registry key
    // supplied directly by a client (mission §13).
    const persistenceItemId = input?.target?.persistenceItemId;
    const persistenceType = input?.target?.persistenceType;
    const PERSISTENCE_TYPES = ['REGISTRY_RUN', 'REGISTRY_RUNONCE', 'STARTUP_FILE', 'SCHEDULED_TASK', 'AUTO_START_SERVICE'];
    if (typeof persistenceItemId !== 'string' || persistenceItemId.trim().length === 0) fail('persistence_item_id_required');
    if (!PERSISTENCE_TYPES.includes(persistenceType)) fail('persistence_type_invalid', { persistenceType });
    return { target: { persistenceItemId, persistenceType }, parameters: {} };
  },

  HOST_ISOLATION(input) {
    const reason = input?.target?.reason;
    if (typeof reason !== 'string' || reason.trim().length === 0) fail('host_isolation_reason_required');
    if (input?.target?.previewMetadata === undefined || input?.target?.previewMetadata === null) fail('host_isolation_preview_required');
    if (input?.target?.rollbackPlanAvailable !== true) fail('host_isolation_rollback_plan_required');
    return { target: { reason, previewMetadata: input.target.previewMetadata, rollbackPlanAvailable: true }, parameters: {} };
  },

  RESTORE_HOST_NETWORK(input) {
    const relatedActionId = input?.target?.relatedActionId;
    if (typeof relatedActionId !== 'string' || relatedActionId.trim().length === 0) fail('restore_related_action_id_required');
    return { target: { relatedActionId }, parameters: {} };
  },
};

/**
 * Validates raw input into a normalized {incidentId, actionType, level,
 * target, parameters} shape. actionType must be one of the closed
 * enum; level is looked up server-side and NEVER taken from input,
 * even if input supplies one (mission §7 — "le client ne peut pas
 * choisir le level"). incidentId is required here (existence against
 * the store is checked by the caller, maitre-approval.js) so every
 * downstream hash/policy function can rely on it always being present.
 */
export function validateActionInput(input) {
  if (!input || typeof input !== 'object') fail('action_input_required');

  const incidentId = input.incidentId;
  if (typeof incidentId !== 'string' || incidentId.trim().length === 0) fail('incident_id_required');

  const actionType = input.actionType;
  if (!ACTION_TYPES.includes(actionType)) fail('action_type_invalid', { actionType });

  assertNoForbiddenKeys(input.target, 'target');
  assertNoForbiddenKeys(input.parameters, 'parameters');

  const validator = VALIDATORS[actionType];
  const { target, parameters } = validator(input);

  assertNoForbiddenKeys(target, 'target');
  assertNoForbiddenKeys(parameters, 'parameters');

  return { incidentId, actionType, level: ACTION_LEVELS[actionType], target, parameters };
}

// ── Canonical serialization + proposal hash (mission §18/§19) ─────────────

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The exact fields that make up an action's identity for hashing
 * purposes — incidentId, actionType, target, parameters. Deliberately
 * EXCLUDES reason/evidenceRefs/timestamps (non-security-relevant
 * narrative fields) so a cosmetic reason edit doesn't need to be
 * re-approved, while any field that changes WHAT will happen always
 * invalidates a prior approval.
 */
export function computeProposalHash({ incidentId, actionType, target, parameters }) {
  const material = stableStringify({ incidentId, actionType, target, parameters });
  return crypto.createHash('sha256').update(material).digest('hex');
}

export function computeTargetHash(target) {
  return crypto.createHash('sha256').update(stableStringify(target)).digest('hex');
}

export function computeParametersHash(parameters) {
  return crypto.createHash('sha256').update(stableStringify(parameters)).digest('hex');
}

export function parseActionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    incidentId: row.incident_id,
    actionType: row.action_type,
    level: row.level,
    target: safeParseJson(row.target, {}),
    parameters: safeParseJson(row.parameters, {}),
    reason: row.reason,
    evidenceRefs: safeParseJson(row.evidence_refs, []),
    status: row.status,
    proposalHash: row.proposal_hash,
    policyResult: safeParseJson(row.policy_result, {}),
    expiresAt: row.expires_at,
  };
}

function safeParseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function parseApprovalRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    actionId: row.action_id,
    incidentId: row.incident_id,
    actionType: row.action_type,
    targetHash: row.target_hash,
    parametersHash: row.parameters_hash,
    proposalHash: row.proposal_hash,
    status: row.status,
    approvedAt: row.approved_at,
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
  };
}
