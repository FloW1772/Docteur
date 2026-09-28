import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as capture from './omega-capture.js';
import { isWindows, runFixedPowerShellScript } from './omega-windows-exec.js';
import {
  getSystemInfo, getProcessList, getServiceStatus, getNetworkStatus, getDiskStatus,
  lockWorkstation, requestLogoff, requestRestart, requestShutdown,
} from './omega-admin.js';
import { getSession, getInboundTrust, endSession, expireSession, recordAudit } from './omega-outbound-store.js';

// OMEGA V2 ADMIN (host side). A closed semantic allowlist only: every action
// maps to one certified OMEGA V1 typed executor, which runs the fixed V1
// omega-admin.ps1 with one ValidateSet enum argument. There is no command,
// script, argument list, path, query or free-form payload anywhere.
export const OMEGA_V2_ADMIN_READ_ACTIONS = Object.freeze([
  'GET_SYSTEM_INFO', 'PROCESS_LIST', 'SERVICE_STATUS', 'NETWORK_STATUS', 'DISK_STATUS',
]);
export const OMEGA_V2_ADMIN_HIGH_IMPACT_ACTIONS = Object.freeze(['LOCK', 'LOGOFF', 'RESTART', 'SHUTDOWN']);
export const OMEGA_V2_ADMIN_ACTIONS = Object.freeze([...OMEGA_V2_ADMIN_READ_ACTIONS, ...OMEGA_V2_ADMIN_HIGH_IMPACT_ACTIONS]);
export const OMEGA_V2_ADMIN_STATUSES = Object.freeze([
  'PENDING_APPROVAL', 'EXECUTING', 'EXECUTED', 'DENIED', 'CANCELLED', 'EXPIRED', 'FAILED',
]);
export const OMEGA_V2_ADMIN_TERMINAL_STATUSES = Object.freeze(['EXECUTED', 'DENIED', 'CANCELLED', 'EXPIRED', 'FAILED']);
// Closed set of operation outcome codes carried in ADMIN_RESULT/ADMIN_STATUS.
export const OMEGA_V2_ADMIN_OUTCOME_CODES = Object.freeze([
  'LOCAL_DENY', 'APPROVAL_UNAVAILABLE', 'APPROVAL_TIMEOUT', 'CONTROLLER_CANCEL', 'CONTROLLER_STOP',
  'REMOTE_STOPPED', 'SESSION_EXPIRED', 'DEVICE_REVOKED', 'NETWORK_TIMEOUT', 'PERMISSION_DENIED',
  'ACCESS_DENIED', 'NOT_SUPPORTED', 'EXECUTION_TIMEOUT', 'ADMIN_EXECUTION_FAILED', 'ADMIN_RESULT_INVALID',
]);

export const OMEGA_V2_ADMIN_LIMITS = Object.freeze({
  readPerMinute: 30,
  statusPerMinute: 120,
  invalidPerMinute: 20,
  highImpactMinIntervalMs: 30_000,
  approvalTimeoutMs: 30_000,
  approvalLeaseMs: 8_000,
  approvalMaxAttempts: 3,
  executionTimeoutMs: 10_000,
  maxOperationsPerSession: 256,
  maxResultBytes: 96 * 1024,
});

const ACTION_METHODS = Object.freeze({
  GET_SYSTEM_INFO: 'getSystemInfo', PROCESS_LIST: 'listProcesses', SERVICE_STATUS: 'getServiceStatus',
  NETWORK_STATUS: 'getNetworkStatus', DISK_STATUS: 'getDiskStatus',
  LOCK: 'requestLock', LOGOFF: 'requestLogoff', RESTART: 'requestRestart', SHUTDOWN: 'requestShutdown',
});
// V2 enum -> certified V1 enum. Used to check the V1 executor echo and as the
// ValidateSet value of the fixed V1 approval prompt.
export const OMEGA_V2_ADMIN_V1_ACTIONS = Object.freeze({
  GET_SYSTEM_INFO: 'GET_SYSTEM_INFO', PROCESS_LIST: 'GET_PROCESS_LIST', SERVICE_STATUS: 'GET_SERVICE_STATUS',
  NETWORK_STATUS: 'GET_NETWORK_STATUS', DISK_STATUS: 'GET_DISK_STATUS',
  LOCK: 'LOCK_WORKSTATION', LOGOFF: 'REQUEST_LOGOFF', RESTART: 'REQUEST_RESTART', SHUTDOWN: 'REQUEST_SHUTDOWN',
});

// Typed executor: no argument ever reaches a V1 function.
export const OMEGA_V2_ADMIN_REAL_EXECUTOR = Object.freeze({
  getSystemInfo: () => getSystemInfo(),
  listProcesses: () => getProcessList(),
  getServiceStatus: () => getServiceStatus(),
  getNetworkStatus: () => getNetworkStatus(),
  getDiskStatus: () => getDiskStatus(),
  requestLock: () => lockWorkstation(),
  requestLogoff: () => requestLogoff(),
  requestRestart: () => requestRestart(),
  requestShutdown: () => requestShutdown(),
});

const READ_SET = new Set(OMEGA_V2_ADMIN_READ_ACTIONS);
const HIGH_SET = new Set(OMEGA_V2_ADMIN_HIGH_IMPACT_ACTIONS);
const ACTION_SET = new Set(OMEGA_V2_ADMIN_ACTIONS);
const TERMINAL_SET = new Set(OMEGA_V2_ADMIN_TERMINAL_STATUSES);
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PROMPT_SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'omega-admin-prompt.ps1');

export class OmegaOutboundAdminError extends Error {
  constructor(code) { super(code); this.name = 'OmegaOutboundAdminError'; this.code = code; }
}
function fail(code) { throw new OmegaOutboundAdminError(code); }

// ---------------------------------------------------------------------------
// Safe result schemas, shared by the host projection and the controller check.
// Field kinds: uint, uint?, dec?, bool, [text, max], [texts, maxItems, max].
// ---------------------------------------------------------------------------
const TABLE_SCHEMAS = Object.freeze({
  PROCESS_LIST: { list: 'processes', max: 200, source: 'processes',
    sort: (a, b) => a.pid - b.pid,
    row: { pid: 'uint', name: ['text', 128], memoryBytes: 'uint?', cpuSeconds: 'dec?' } },
  SERVICE_STATUS: { list: 'services', max: 200, source: 'services',
    sort: (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    row: { name: ['text', 128], displayName: ['text', 256], state: ['text', 32], startMode: ['text', 32] } },
  NETWORK_STATUS: { list: 'interfaces', max: 32, source: 'interfaces',
    sort: (a, b) => (a.description < b.description ? -1 : a.description > b.description ? 1 : 0),
    row: { description: ['text', 128], dhcpEnabled: 'bool', addresses: ['texts', 16, 64],
      gateways: ['texts', 8, 64], dnsServers: ['texts', 8, 64] } },
  DISK_STATUS: { list: 'disks', max: 32, source: 'disks',
    sort: (a, b) => (a.drive < b.drive ? -1 : a.drive > b.drive ? 1 : 0),
    row: { drive: ['text', 8], filesystem: ['text', 16], totalBytes: 'uint', freeBytes: 'uint' } },
});
const SYSTEM_SCHEMA = Object.freeze({ computerName: ['text', 64], osCaption: ['text', 128], osVersion: ['text', 64],
  architecture: ['text', 32], lastBootUpTime: ['text', 64] });
const HIGH_IMPACT_SCHEMA = Object.freeze({ accepted: 'bool' });

function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
}

function coerceField(kind, value) {
  if (kind === 'uint') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (kind === 'uint?') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (kind === 'dec?') return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : null;
  if (kind === 'bool') return value === true;
  if (kind[0] === 'text') return cleanText(value, kind[1]);
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return items.filter(item => typeof item === 'string').slice(0, kind[1]).map(item => cleanText(item, kind[2]));
}

function fieldValid(kind, value) {
  if (kind === 'uint') return Number.isSafeInteger(value) && value >= 0;
  if (kind === 'uint?') return value === null || (Number.isSafeInteger(value) && value >= 0);
  if (kind === 'dec?') return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (kind === 'bool') return typeof value === 'boolean';
  const textValid = (item, max) => typeof item === 'string' && item.length <= max && !CONTROL_CHARS.test(item);
  if (kind[0] === 'text') return textValid(value, kind[1]);
  return Array.isArray(value) && value.length <= kind[1] && value.every(item => textValid(item, kind[2]));
}

function projectRow(schema, source) {
  if (!plainObject(source)) return null;
  const row = {};
  for (const [key, kind] of Object.entries(schema)) {
    const value = coerceField(kind, source[key]);
    if (value === undefined) return null;
    row[key] = value;
  }
  return row;
}

function rowValid(schema, row) {
  return exactKeys(row, Object.keys(schema)) && Object.entries(schema).every(([key, kind]) => fieldValid(kind, row[key]));
}

function byteLength(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

/**
 * Projects a raw V1 executor result onto the V2 safe schema: allowlisted
 * fields only, bounded strings/lists, deterministic sort and truncation by
 * row count then by serialized size. Unknown fields (command lines,
 * environment, MAC address, anything else) are dropped by construction.
 */
export function projectAdminResult(actionType, raw, maxResultBytes = OMEGA_V2_ADMIN_LIMITS.maxResultBytes) {
  if (!plainObject(raw)) fail('ADMIN_RESULT_INVALID');
  if (HIGH_SET.has(actionType)) return { accepted: raw.accepted === true };
  if (actionType === 'GET_SYSTEM_INFO') {
    const system = projectRow(SYSTEM_SCHEMA, raw.system);
    if (!system) fail('ADMIN_RESULT_INVALID');
    return { system };
  }
  const table = TABLE_SCHEMAS[actionType];
  if (!table) fail('ADMIN_ACTION_INVALID');
  const source = raw[table.source];
  const items = Array.isArray(source) ? source : plainObject(source) ? [source] : null;
  if (!items) fail('ADMIN_RESULT_INVALID');
  const rows = items.map(item => projectRow(table.row, item)).filter(Boolean).sort(table.sort);
  // V1 already caps at its own source limit; reaching the cap means the list may be partial.
  let truncated = rows.length >= table.max || rows.length < items.length;
  const kept = rows.slice(0, table.max);
  const build = () => ({ [table.list]: kept, count: kept.length, truncated });
  let result = build();
  while (byteLength(result) > maxResultBytes && kept.length) {
    kept.pop();
    truncated = true;
    result = build();
  }
  return result;
}

/** Strict check of an already projected result (controller side, defense in depth). */
export function validateAdminResult(actionType, result) {
  if (HIGH_SET.has(actionType)) return rowValid(HIGH_IMPACT_SCHEMA, result);
  if (actionType === 'GET_SYSTEM_INFO') return exactKeys(result, ['system']) && rowValid(SYSTEM_SCHEMA, result.system);
  const table = TABLE_SCHEMAS[actionType];
  if (!table || !exactKeys(result, [table.list, 'count', 'truncated'])) return false;
  const rows = result[table.list];
  return Array.isArray(rows) && rows.length <= table.max && result.count === rows.length
    && typeof result.truncated === 'boolean' && rows.every(row => rowValid(table.row, row))
    && byteLength(result) <= OMEGA_V2_ADMIN_LIMITS.maxResultBytes;
}

export function validAdminAction(value) { return typeof value === 'string' && ACTION_SET.has(value); }
export function isHighImpactAdminAction(value) { return typeof value === 'string' && HIGH_SET.has(value); }

function approvalBindingHash({ operationId, sessionId, controllerDeviceId, hostDeviceId, actionType, expiresAt, approvalNonce }) {
  return crypto.createHash('sha256').update(JSON.stringify([
    'OMEGA-V2/HOST/ADMIN_APPROVAL', operationId, sessionId, controllerDeviceId, hostDeviceId, actionType, expiresAt, approvalNonce,
  ])).digest();
}

// ---------------------------------------------------------------------------
// Real approval channel: the certified V1 WinForms prompt (fixed script,
// ValidateSet action, validated device id), launched through the V1 fixed
// PowerShell runner. Cancellation removes the lease file so the prompt
// closes itself with DENY; any decision after cancel is ignored.
// ---------------------------------------------------------------------------
export function createOmegaV2AdminPromptApprovalProvider({ runScript = runFixedPowerShellScript,
  scriptPath = PROMPT_SCRIPT_PATH, windows = isWindows } = {}) {
  return {
    request(request) {
      if (!windows()) return { ok: false, reason: 'not_windows' };
      const binding = { operationId: request.operationId, sessionId: request.sessionId,
        controllerDeviceId: request.controllerDeviceId, actionType: request.actionType, approvalNonce: request.approvalNonce };
      let dir;
      try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-omega-v2-admin-')); }
      catch { return { ok: false, reason: 'approval_dir_unavailable' }; }
      const approvalFile = path.join(dir, 'approval.txt');
      const leaseFile = path.join(dir, 'lease.txt');
      let active = true;
      const writeLease = () => { try { fs.writeFileSync(leaseFile, String(Date.now()), 'utf8'); } catch { /* prompt fails closed */ } };
      writeLease();
      const heartbeat = setInterval(() => { if (active) writeLease(); }, 1_000);
      heartbeat.unref?.();
      const cleanup = () => { clearInterval(heartbeat); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } };
      const seconds = Math.max(1, Math.min(30, Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 1_000)));
      const v1Action = OMEGA_V2_ADMIN_V1_ACTIONS[request.actionType];
      const settle = decision => {
        const wasActive = active;
        active = false;
        cleanup();
        if (wasActive) request.onDecision(decision, binding);
      };
      Promise.resolve()
        .then(() => runScript(scriptPath, ['-Action', v1Action, '-DeviceId', request.controllerDeviceId,
          '-ApprovalFile', approvalFile, '-LeaseFile', leaseFile, '-LeaseTimeoutMs', '5000',
          '-TimeoutSeconds', String(seconds)], { timeoutMs: (seconds + 10) * 1_000 }))
        .then(() => {
          let decision = 'UNAVAILABLE';
          try {
            const value = fs.readFileSync(approvalFile, 'utf8').trim();
            if (value === 'ALLOW' || value === 'DENY') decision = value;
          } catch { /* no decision written */ }
          settle(decision);
        }, () => settle('UNAVAILABLE'));
      return { ok: true, cancel: () => {
        if (!active) return;
        active = false;
        clearInterval(heartbeat);
        try { fs.rmSync(leaseFile, { force: true }); } catch { /* prompt closes on lease loss */ }
      } };
    },
  };
}

function mergeLimits(overrides) {
  const limits = { ...OMEGA_V2_ADMIN_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (Object.hasOwn(OMEGA_V2_ADMIN_LIMITS, key) && Number.isFinite(value) && value >= 0) limits[key] = value;
  }
  return Object.freeze(limits);
}

function takeRate(list, maximum, windowMs, now = Date.now()) {
  while (list.length && now - list[0] >= windowMs) list.shift();
  if (list.length >= maximum) return false;
  list.push(now);
  return true;
}

export function createOmegaOutboundAdminManager({
  executor = OMEGA_V2_ADMIN_REAL_EXECUTOR,
  approvalProvider = createOmegaV2AdminPromptApprovalProvider(),
  indicatorProvider = { showSessionIndicator: capture.showSessionIndicator },
  limits: limitOverrides,
  onRemoteLocalStop,
} = {}) {
  const limits = mergeLimits(limitOverrides);
  const sessions = new Map();

  function audit(type, op, result, detail = {}) {
    recordAudit(type, { sessionId: op.sessionId, localDeviceId: op.hostDeviceId, remoteDeviceId: op.controllerDeviceId,
      result, detail: { operationId: op.operationId ?? null, actionType: op.actionType ?? null, ...detail } });
  }

  function publicOperation(op) {
    const value = { type: TERMINAL_SET.has(op.status) ? 'ADMIN_RESULT' : 'ADMIN_STATUS', sessionId: op.sessionId,
      controllerDeviceId: op.controllerDeviceId, hostDeviceId: op.hostDeviceId, operationId: op.operationId,
      actionType: op.actionType, status: op.status, createdAt: op.createdAt, expiresAt: op.expiresAt };
    if (op.status === 'EXECUTED') value.result = op.result;
    if (op.error) value.error = op.error;
    return value;
  }

  /** Authoritative liveness from the host DB and trust store; never from the payload. */
  function sessionBlocker(sessionId, controllerDeviceId) {
    const row = getSession(sessionId);
    if (!row || row.direction !== 'INBOUND' || row.remote_device_id !== controllerDeviceId) return 'REMOTE_STOPPED';
    if (row.status === 'EXPIRED') return 'SESSION_EXPIRED';
    if (row.ended_at) return 'REMOTE_STOPPED';
    if (Date.parse(row.expires_at) <= Date.now()) { expireSession(sessionId); return 'SESSION_EXPIRED'; }
    if (row.permission !== 'ADMIN') return 'PERMISSION_DENIED';
    const trust = getInboundTrust(controllerDeviceId);
    if (!trust || trust.revoked_at) return 'DEVICE_REVOKED';
    return null;
  }

  function sessionState(session) {
    let state = sessions.get(session.id);
    if (state) return state;
    state = { sessionId: session.id, controllerDeviceId: session.remote_device_id, hostDeviceId: session.local_device_id,
      operations: new Map(), readTimes: [], statusTimes: [], invalidTimes: [], lastHighImpactAt: 0,
      indicatorPromise: null, stopped: false, expiryTimer: null };
    state.expiryTimer = setTimeout(() => { void stop(session.id, 'SESSION_EXPIRED').then(() => expireSession(session.id)); },
      Math.max(0, Date.parse(session.expires_at) - Date.now()));
    state.expiryTimer.unref?.();
    sessions.set(session.id, state);
    return state;
  }

  function reject(state, code, detail = {}) {
    takeRate(state.invalidTimes, Number.MAX_SAFE_INTEGER, 60_000);
    audit('OUTBOUND_ADMIN_DENIED', { sessionId: state.sessionId, hostDeviceId: state.hostDeviceId,
      controllerDeviceId: state.controllerDeviceId }, code, detail);
    fail(code);
  }

  function requireAdmin(session) {
    if (session?.permission !== 'ADMIN') {
      recordAudit('OUTBOUND_ADMIN_DENIED', { sessionId: session?.id, localDeviceId: session?.local_device_id,
        remoteDeviceId: session?.remote_device_id, result: 'PERMISSION_DENIED', detail: { permission: session?.permission ?? null } });
      fail('PERMISSION_DENIED');
    }
    const state = sessionState(session);
    if (state.stopped) fail('REMOTE_STOPPED');
    const recentInvalid = state.invalidTimes.filter(value => Date.now() - value < 60_000).length;
    if (recentInvalid >= limits.invalidPerMinute) fail('RATE_LIMITED');
    return state;
  }

  function findOperation(state, payload) {
    if (!exactKeys(payload, ['operationId'])) reject(state, 'ADMIN_PAYLOAD_INVALID');
    if (typeof payload.operationId !== 'string' || !OPERATION_ID.test(payload.operationId)) reject(state, 'OPERATION_ID_INVALID');
    const op = state.operations.get(payload.operationId);
    // Operations are only visible to the exact session and controller that created them.
    if (!op || op.sessionId !== state.sessionId || op.controllerDeviceId !== state.controllerDeviceId) reject(state, 'OPERATION_NOT_FOUND');
    return op;
  }

  async function ensureIndicator(state, session) {
    if (!state.indicatorPromise) {
      state.indicatorPromise = Promise.resolve()
        .then(() => indicatorProvider.showSessionIndicator('admin_start', session.id, session.remote_device_id,
          session.expires_at, () => {
            void stop(session.id, 'REMOTE_STOPPED', { terminateSession: true });
            onRemoteLocalStop?.(session.id);
          }))
        .catch(() => ({ ok: false }));
    }
    const indicator = await state.indicatorPromise;
    if (!indicator?.ok) { state.indicatorPromise = null; fail('REMOTE_CONSENT_UNAVAILABLE'); }
  }

  function clearOperationTimers(op) {
    if (op.approvalTimer) clearTimeout(op.approvalTimer);
    if (op.leaseTimer) clearTimeout(op.leaseTimer);
    op.approvalTimer = null; op.leaseTimer = null;
  }

  function finish(op, status, code, auditType) {
    clearOperationTimers(op);
    const handle = op.approvalHandle;
    op.approvalHandle = null;
    try { handle?.cancel?.(); } catch { /* the prompt fails closed on lease loss */ }
    op.status = status;
    op.error = code ?? null;
    audit(auditType, op, code ?? status.toLowerCase(), { status });
  }

  function refreshLease(op) {
    if (op.leaseTimer) clearTimeout(op.leaseTimer);
    op.leaseUntil = Date.now() + limits.approvalLeaseMs;
    op.leaseTimer = setTimeout(() => {
      if (op.status === 'PENDING_APPROVAL') finish(op, 'CANCELLED', 'NETWORK_TIMEOUT', 'OUTBOUND_ADMIN_CANCELLED');
    }, limits.approvalLeaseMs);
    op.leaseTimer.unref?.();
  }

  async function runExecutor(op) {
    const method = executor?.[ACTION_METHODS[op.actionType]];
    if (typeof method !== 'function') return { ok: false, error: 'NOT_SUPPORTED' };
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => method.call(executor)),
        new Promise(resolve => {
          timer = setTimeout(() => resolve({ ok: false, error: 'EXECUTION_TIMEOUT' }), limits.executionTimeoutMs);
        }),
      ]);
    } catch { return { ok: false, error: 'ADMIN_EXECUTION_FAILED' }; }
    finally { clearTimeout(timer); }
  }

  async function execute(op) {
    const outcome = await runExecutor(op);
    if (op.status !== 'EXECUTING') return; // a read was cancelled while in flight: result dropped
    if (!outcome?.ok) {
      const code = ['ACCESS_DENIED', 'NOT_SUPPORTED', 'EXECUTION_TIMEOUT'].includes(outcome?.error) ? outcome.error : 'ADMIN_EXECUTION_FAILED';
      finish(op, 'FAILED', code, 'OUTBOUND_ADMIN_FAILED');
      return;
    }
    if (outcome.action !== undefined && outcome.action !== OMEGA_V2_ADMIN_V1_ACTIONS[op.actionType]) {
      finish(op, 'FAILED', 'ADMIN_RESULT_INVALID', 'OUTBOUND_ADMIN_FAILED');
      return;
    }
    try { op.result = projectAdminResult(op.actionType, outcome, limits.maxResultBytes); }
    catch { finish(op, 'FAILED', 'ADMIN_RESULT_INVALID', 'OUTBOUND_ADMIN_FAILED'); return; }
    finish(op, 'EXECUTED', null, 'OUTBOUND_ADMIN_EXECUTED');
  }

  async function request(session, payload) {
    const state = requireAdmin(session);
    if (!exactKeys(payload, ['actionType', 'operationId'])) reject(state, 'ADMIN_PAYLOAD_INVALID');
    if (typeof payload.operationId !== 'string' || !OPERATION_ID.test(payload.operationId)) reject(state, 'OPERATION_ID_INVALID');
    if (!validAdminAction(payload.actionType)) reject(state, 'ADMIN_ACTION_INVALID');
    if (state.operations.has(payload.operationId)) {
      audit('OUTBOUND_ADMIN_REPLAY_REJECTED', { sessionId: state.sessionId, hostDeviceId: state.hostDeviceId,
        controllerDeviceId: state.controllerDeviceId, operationId: payload.operationId, actionType: payload.actionType }, 'OPERATION_DUPLICATE');
      fail('OPERATION_DUPLICATE');
    }
    if (state.operations.size >= limits.maxOperationsPerSession) fail('RATE_LIMITED');
    const blocker = sessionBlocker(session.id, session.remote_device_id);
    if (blocker) fail(blocker);
    const highImpact = HIGH_SET.has(payload.actionType);
    if (!highImpact && !takeRate(state.readTimes, limits.readPerMinute, 60_000)) fail('RATE_LIMITED');
    if (highImpact) {
      if ([...state.operations.values()].some(op => op.kind === 'HIGH_IMPACT' && ['PENDING_APPROVAL', 'EXECUTING'].includes(op.status))) {
        fail('ADMIN_HIGH_IMPACT_PENDING');
      }
      if (state.lastHighImpactAt && Date.now() - state.lastHighImpactAt < limits.highImpactMinIntervalMs) fail('RATE_LIMITED');
    }
    await ensureIndicator(state, session);
    if (state.stopped) fail('REMOTE_STOPPED');

    const now = Date.now();
    const op = { operationId: payload.operationId, sessionId: session.id, controllerDeviceId: session.remote_device_id,
      hostDeviceId: session.local_device_id, actionType: payload.actionType, kind: highImpact ? 'HIGH_IMPACT' : 'READ',
      status: 'EXECUTING', createdAt: new Date(now).toISOString(), expiresAt: null, result: null, error: null,
      approvalNonce: null, approvalHash: null, approvalHandle: null, approvalAttempts: 0,
      approvalTimer: null, leaseTimer: null, leaseUntil: 0 };
    state.operations.set(op.operationId, op);
    audit('OUTBOUND_ADMIN_REQUESTED', op, highImpact ? 'high_impact' : 'read_only');

    if (!highImpact) {
      await execute(op);
      return publicOperation(op);
    }

    state.lastHighImpactAt = now;
    op.status = 'PENDING_APPROVAL';
    op.expiresAt = new Date(Math.min(now + limits.approvalTimeoutMs, Date.parse(session.expires_at))).toISOString();
    op.approvalNonce = crypto.randomBytes(24).toString('base64url');
    op.approvalHash = approvalBindingHash(op);
    audit('OUTBOUND_ADMIN_APPROVAL_REQUIRED', op, 'approval_required', { expiresAt: op.expiresAt });
    op.approvalTimer = setTimeout(() => {
      if (op.status === 'PENDING_APPROVAL') finish(op, 'EXPIRED', 'APPROVAL_TIMEOUT', 'OUTBOUND_ADMIN_DENIED');
    }, Math.max(0, Date.parse(op.expiresAt) - now));
    op.approvalTimer.unref?.();
    refreshLease(op);
    let handle;
    try {
      handle = approvalProvider?.request?.({ operationId: op.operationId, sessionId: op.sessionId,
        controllerDeviceId: op.controllerDeviceId, hostDeviceId: op.hostDeviceId, actionType: op.actionType,
        expiresAt: op.expiresAt, approvalNonce: op.approvalNonce,
        onDecision: (decision, binding) => { void decide(op.operationId, decision, binding); } });
    } catch { handle = null; }
    // Safe default: no approval channel means DENY, never a weaker path.
    if (!handle?.ok) {
      if (op.status === 'PENDING_APPROVAL') finish(op, 'DENIED', 'APPROVAL_UNAVAILABLE', 'OUTBOUND_ADMIN_DENIED');
    } else if (op.status === 'PENDING_APPROVAL') op.approvalHandle = handle;
    else try { handle.cancel?.(); } catch { /* already decided */ }
    return publicOperation(op);
  }

  function status(session, payload) {
    const state = requireAdmin(session);
    if (!takeRate(state.statusTimes, limits.statusPerMinute, 60_000)) fail('RATE_LIMITED');
    const op = findOperation(state, payload);
    if (op.status === 'PENDING_APPROVAL') refreshLease(op);
    return publicOperation(op);
  }

  function cancel(session, payload) {
    const state = requireAdmin(session);
    if (!takeRate(state.statusTimes, limits.statusPerMinute, 60_000)) fail('RATE_LIMITED');
    const op = findOperation(state, payload);
    if (op.status === 'PENDING_APPROVAL' || (op.kind === 'READ' && op.status === 'EXECUTING')) {
      finish(op, 'CANCELLED', 'CONTROLLER_CANCEL', 'OUTBOUND_ADMIN_CANCELLED');
    }
    return publicOperation(op);
  }

  /**
   * Local approval decision (host UI only; no network route reaches this).
   * The binding must name the exact operation, session, controller, action and
   * one-time approval nonce. Commit happens synchronously after the final
   * liveness check, so STOP/revocation/expiry either wins before commit or the
   * action is already committed (see report: atomicity).
   */
  async function decide(operationId, decision, binding = {}) {
    let op = null;
    for (const state of sessions.values()) if (state.operations.has(operationId)) op = state.operations.get(operationId);
    if (!op || op.kind !== 'HIGH_IMPACT' || op.status !== 'PENDING_APPROVAL') return { accepted: false, code: 'APPROVAL_EXPIRED' };
    const candidate = approvalBindingHash({ operationId, sessionId: binding.sessionId, controllerDeviceId: binding.controllerDeviceId,
      hostDeviceId: op.hostDeviceId, actionType: binding.actionType, expiresAt: op.expiresAt, approvalNonce: binding.approvalNonce });
    if (!crypto.timingSafeEqual(candidate, op.approvalHash)) {
      op.approvalAttempts += 1;
      audit('OUTBOUND_ADMIN_DENIED', op, 'APPROVAL_BINDING_MISMATCH', { status: op.status, attempt: op.approvalAttempts });
      if (op.approvalAttempts >= limits.approvalMaxAttempts) finish(op, 'DENIED', 'LOCAL_DENY', 'OUTBOUND_ADMIN_DENIED');
      return { accepted: false, code: 'APPROVAL_BINDING_MISMATCH' };
    }
    if (decision === 'UNAVAILABLE') { finish(op, 'DENIED', 'APPROVAL_UNAVAILABLE', 'OUTBOUND_ADMIN_DENIED'); return { accepted: true, status: op.status }; }
    if (decision !== 'ALLOW') { finish(op, 'DENIED', 'LOCAL_DENY', 'OUTBOUND_ADMIN_DENIED'); return { accepted: true, status: op.status }; }
    const state = sessions.get(op.sessionId);
    const blocker = !state || state.stopped ? 'REMOTE_STOPPED'
      : Date.parse(op.expiresAt) <= Date.now() ? 'APPROVAL_TIMEOUT'
        : op.leaseUntil < Date.now() ? 'NETWORK_TIMEOUT'
          : sessionBlocker(op.sessionId, op.controllerDeviceId);
    if (blocker) {
      if (blocker === 'APPROVAL_TIMEOUT') finish(op, 'EXPIRED', blocker, 'OUTBOUND_ADMIN_DENIED');
      else finish(op, 'CANCELLED', blocker, 'OUTBOUND_ADMIN_CANCELLED');
      return { accepted: false, code: blocker };
    }
    // Commit point: from here the action is no longer cancellable.
    clearOperationTimers(op);
    op.approvalHandle = null;
    op.status = 'EXECUTING';
    audit('OUTBOUND_ADMIN_APPROVED', op, 'approved');
    await execute(op);
    return { accepted: true, status: op.status };
  }

  async function stop(sessionId, reason = 'REMOTE_STOPPED', { terminateSession = false } = {}) {
    const state = sessions.get(sessionId);
    if (terminateSession) endSession(sessionId, 'remote_local_stop');
    if (!state) return { stopped: false, cancelled: 0 };
    const code = OMEGA_V2_ADMIN_OUTCOME_CODES.includes(reason) ? reason : 'REMOTE_STOPPED';
    state.stopped = true;
    sessions.delete(sessionId);
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    let cancelled = 0;
    for (const op of state.operations.values()) {
      // Committed high-impact actions (EXECUTING) cannot be recalled; everything else fails closed.
      if (op.status === 'PENDING_APPROVAL' || (op.kind === 'READ' && op.status === 'EXECUTING')) {
        finish(op, 'CANCELLED', code, 'OUTBOUND_ADMIN_CANCELLED');
        cancelled += 1;
      }
    }
    if (state.indicatorPromise) {
      await Promise.resolve()
        .then(() => indicatorProvider.showSessionIndicator('admin_stop', sessionId, state.controllerDeviceId))
        .catch(() => {});
    }
    return { stopped: true, cancelled };
  }

  async function stopForController(controllerDeviceId, reason = 'DEVICE_REVOKED') {
    const targets = [...sessions.values()].filter(state => state.controllerDeviceId === controllerDeviceId);
    await Promise.allSettled(targets.map(state => stop(state.sessionId, reason)));
    return targets.length;
  }

  return { request, status, cancel, decide, stop, stopForController, limits, _sessions: sessions };
}
