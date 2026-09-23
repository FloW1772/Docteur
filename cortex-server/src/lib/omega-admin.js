/**
 * OMEGA ADMIN V1 semantic action manager.
 *
 * This module deliberately has no generic process runner. Remote callers can
 * select only the closed action enum below. Read-only actions use one fixed
 * repository PowerShell file with one enum argument. High-impact actions are
 * never executed on request: a visible local prompt must write a one-time
 * ALLOW decision first. Pending authority is process-local and session-bound.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isWindows, runFixedPowerShellScript } from './omega-windows-exec.js';
import { OMEGA_PERMISSION_LEVELS } from './omega-pairing.js';
import { validateAndAdvanceSession, getSession, endSession } from './omega-session.js';
import { recordOmegaAudit } from './omega-audit.js';
import { startPersistentIndicator, stopPersistentIndicator, getPersistentIndicatorState } from './omega-indicator.js';
import { registerOmegaAdminLifecycle } from './omega-admin-registry.js';

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const MODULE_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ADMIN_SCRIPT_PATH = path.join(MODULE_DIR, 'omega-admin.ps1');
const PROMPT_SCRIPT_PATH = path.join(MODULE_DIR, 'omega-admin-prompt.ps1');
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export const OMEGA_ADMIN_ACTIONS = Object.freeze([
  'GET_SYSTEM_INFO', 'GET_PROCESS_LIST', 'GET_SERVICE_STATUS',
  'GET_NETWORK_STATUS', 'GET_DISK_STATUS',
  'LOCK_WORKSTATION', 'REQUEST_LOGOFF', 'REQUEST_RESTART', 'REQUEST_SHUTDOWN',
]);

export const OMEGA_ADMIN_READ_ACTIONS = Object.freeze([
  'GET_SYSTEM_INFO', 'GET_PROCESS_LIST', 'GET_SERVICE_STATUS',
  'GET_NETWORK_STATUS', 'GET_DISK_STATUS',
]);

export const OMEGA_ADMIN_HIGH_IMPACT_ACTIONS = Object.freeze([
  'LOCK_WORKSTATION', 'REQUEST_LOGOFF', 'REQUEST_RESTART', 'REQUEST_SHUTDOWN',
]);

const ACTION_SET = new Set(OMEGA_ADMIN_ACTIONS);
const READ_SET = new Set(OMEGA_ADMIN_READ_ACTIONS);
const HIGH_SET = new Set(OMEGA_ADMIN_HIGH_IMPACT_ACTIONS);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const ACTION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const ADMIN_REQUEST_TTL_MS = 30_000;
const ADMIN_PROMPT_LEASE_TIMEOUT_MS = 5_000;
const ADMIN_PROMPT_TIMEOUT_SECONDS = 30;
const ADMIN_READ_WINDOW_MS = 60_000;
const ADMIN_READ_MAX_PER_WINDOW = 30;
const ADMIN_HIGH_MIN_INTERVAL_MS = 30_000;
const MAX_ADMIN_RESULT_BYTES = 512 * 1024;
const MAX_ACTION_HISTORY = 500;

export class OmegaAdminError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'OmegaAdminError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OmegaAdminError(code, detail);
}

let actionExecutor = executeRealAdminAction;
let indicatorProvider = {
  start: startPersistentIndicator,
  stop: stopPersistentIndicator,
  get: getPersistentIndicatorState,
};
let promptProcessFactory = ({ args }) => spawn(POWERSHELL_EXE, args, {
  shell: false,
  windowsHide: true,
  stdio: 'ignore',
});

const pendingActions = new Map();
const actionsByRequest = new Map();
const readTimestamps = new Map();
const highActionTimestamps = new Map();

function audit(eventType, record, result, detail = {}) {
  recordOmegaAudit(eventType, {
    deviceId: record.deviceId,
    sessionId: record.sessionId,
    result,
    detail: { requestId: record.requestId, action: record.action, approvalState: record.approvalState, ...detail },
  });
}

function validateAction(action) {
  if (!ACTION_SET.has(action)) fail('ACTION_NOT_ALLOWED', { action: typeof action === 'string' ? action.slice(0, 80) : null });
  return action;
}

function normalizeArguments(value) {
  if (value === undefined || value === null) return '{}';
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) {
    fail('ACTION_NOT_ALLOWED', { reason: 'arguments_not_supported' });
  }
  return '{}';
}

function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) fail('ACTION_NOT_ALLOWED', { reason: 'request_id_invalid' });
  return requestId;
}

function validateActionId(actionId) {
  if (typeof actionId !== 'string' || !ACTION_ID_PATTERN.test(actionId)) fail('ACTION_NOT_ALLOWED', { reason: 'action_id_invalid' });
}

function requireAdminSession({ sessionId, deviceId, presentedNonce }) {
  const result = validateAndAdvanceSession({ sessionId, deviceId, presentedNonce });
  if (!result.valid) {
    const code = result.reason === 'device_revoked' ? 'DEVICE_REVOKED' : 'SESSION_INVALID';
    fail(code, { reason: result.reason });
  }
  if (result.permissionLevel < OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN) {
    recordOmegaAudit('ADMIN_DENIED', {
      sessionId,
      deviceId: result.session.deviceId,
      result: 'permission_insufficient',
      detail: { permissionLevel: result.permissionLevel },
    });
    fail('ACTION_NOT_ALLOWED', { reason: 'permission_insufficient' });
  }
  return result;
}

function ensureArgumentsForAction(action, args) {
  validateAction(action);
  return normalizeArguments(args);
}

function ensureAdminIndicator(session) {
  if (indicatorProvider.get(session.id, 'admin')) return { ok: true, persistent: true, alreadyActive: true };
  return indicatorProvider.start({
    sessionId: session.id,
    deviceId: session.deviceId,
    mode: 'admin',
    expiresAt: session.expiresAt,
    onLocalStop: () => {
      try { endSessionFromAdminIndicator(session.id); } catch { /* session cleanup remains fail-closed */ }
    },
  });
}

function requireAdminIndicator(session) {
  const indicator = ensureAdminIndicator(session);
  if (isWindows() && !indicator?.ok) fail('EXECUTION_FAILED', { reason: 'admin_indicator_unavailable' });
  return indicator;
}

function endSessionFromAdminIndicator(sessionId) {
  cancelPendingAdminActionsForSession(sessionId, 'local_stop');
  try { endSession(sessionId); } catch { /* already ended */ }
}

function pruneRateMaps(now = Date.now()) {
  for (const [sessionId, timestamps] of readTimestamps) {
    const live = timestamps.filter(timestamp => now - timestamp < ADMIN_READ_WINDOW_MS);
    if (live.length) readTimestamps.set(sessionId, live);
    else readTimestamps.delete(sessionId);
  }
  for (const [sessionId, timestamp] of highActionTimestamps) {
    if (now - timestamp >= ADMIN_HIGH_MIN_INTERVAL_MS) highActionTimestamps.delete(sessionId);
  }
}

function checkReadRate(sessionId) {
  const now = Date.now();
  pruneRateMaps(now);
  const timestamps = readTimestamps.get(sessionId) ?? [];
  if (timestamps.length >= ADMIN_READ_MAX_PER_WINDOW) fail('RATE_LIMITED');
  timestamps.push(now);
  readTimestamps.set(sessionId, timestamps);
}

function checkHighRate(sessionId) {
  pruneRateMaps();
  for (const record of pendingActions.values()) {
    if (record.sessionId === sessionId && record.status === 'pending') {
      fail('RATE_LIMITED', { reason: 'one_high_impact_pending_per_session' });
    }
  }
  const last = highActionTimestamps.get(sessionId) ?? 0;
  if (Date.now() - last < ADMIN_HIGH_MIN_INTERVAL_MS) fail('RATE_LIMITED');
  highActionTimestamps.set(sessionId, Date.now());
}

function removePromptFiles(record) {
  try { record.watcher?.close(); } catch {}
  try { fs.rmSync(record.dir, { recursive: true, force: true }); } catch {}
}

function killPrompt(record) {
  try { record.child?.kill?.(); } catch {}
}

function cleanupPendingRecord(record, { kill = true } = {}) {
  if (record.timeout) clearTimeout(record.timeout);
  clearInterval(record.heartbeat);
  if (kill) killPrompt(record);
  removePromptFiles(record);
  pendingActions.delete(record.actionId);
}

function pruneActionHistory() {
  if (actionsByRequest.size <= MAX_ACTION_HISTORY) return;
  for (const [key, record] of actionsByRequest) {
    if (record.status === 'pending' || record.status === 'executing') continue;
    actionsByRequest.delete(key);
    if (actionsByRequest.size <= MAX_ACTION_HISTORY) break;
  }
}

function getSafeRecord(record) {
  if (!record) return null;
  return {
    actionId: record.actionId,
    requestId: record.requestId,
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    action: record.action,
    status: record.status,
    approvalState: record.approvalState,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    result: record.result ?? null,
  };
}

function markDenied(record, result = 'denied') {
  if (!record || !['pending'].includes(record.status)) return getSafeRecord(record);
  record.approvalConsumed = true;
  const invalidated = result === 'expired' || result === 'session_stopped' || result === 'device_revoked';
  record.status = invalidated ? 'expired' : 'denied';
  record.approvalState = invalidated ? 'invalidated' : 'denied';
  record.result = result;
  audit(invalidated ? 'ADMIN_EXPIRED' : 'ADMIN_DENIED', record, result);
  cleanupPendingRecord(record);
  return getSafeRecord(record);
}

function sessionStillAuthorizes(record) {
  const session = getSession(record.sessionId);
  return !!session && session.live && Date.now() < new Date(record.expiresAt).getTime()
    && session.deviceId === record.deviceId && session.permissionLevel >= OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN;
}

function approvalBindingValid(record) {
  const expected = crypto.createHash('sha256').update(JSON.stringify({
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    action: record.action,
    normalizedArguments: record.normalizedArguments,
    expiresAt: record.expiresAt,
    approvalNonce: record.approvalNonce,
  })).digest('hex');
  const actual = Buffer.from(record.approvalBinding, 'utf8');
  const candidate = Buffer.from(expected, 'utf8');
  return actual.length === candidate.length && crypto.timingSafeEqual(actual, candidate);
}

async function consumeLocalDecision(record, decision) {
  if (!record || record.status !== 'pending') return;
  if (decision !== 'ALLOW') {
    markDenied(record, 'denied');
    return;
  }
  if (record.approvalConsumed || !approvalBindingValid(record) || !sessionStillAuthorizes(record)) {
    markDenied(record, 'session_stopped');
    return;
  }

  record.approvalConsumed = true;
  record.approvalState = 'approved';
  audit('ADMIN_APPROVED', record, 'approved');
  record.status = 'executing';
  cleanupPendingRecord(record);

  try {
    const outcome = await actionExecutor(record.action);
    if (outcome?.ok) {
      record.status = 'executed';
      record.result = sanitizeExecutorResult(outcome, record.action);
      audit('ADMIN_EXECUTED', record, 'success');
    } else {
      record.status = 'failed';
      record.result = { error: outcome?.error === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : 'EXECUTION_FAILED' };
      audit('ADMIN_FAILED', record, record.result.error);
    }
  } catch (error) {
    record.status = 'failed';
    record.result = { error: error?.code === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : 'EXECUTION_FAILED' };
    audit('ADMIN_FAILED', record, record.result.error);
  }
}

function readApprovalFile(record) {
  if (!record || record.status !== 'pending') return;
  let decision;
  try { decision = fs.readFileSync(record.approvalFile, 'utf8').trim(); } catch { return; }
  if (decision === 'ALLOW' || decision === 'DENY') void consumeLocalDecision(record, decision);
}

function expireRecord(record, reason = 'expired') {
  if (!record || record.status !== 'pending') return;
  markDenied(record, reason);
}

function startLocalPrompt(record) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-omega-admin-'));
  record.dir = dir;
  record.approvalFile = path.join(dir, 'approval.txt');
  record.leaseFile = path.join(dir, 'lease.txt');
  fs.writeFileSync(record.leaseFile, String(Date.now()), 'utf8');
  let child;
  try {
    child = promptProcessFactory({ args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', PROMPT_SCRIPT_PATH,
      '-Action', record.action,
      '-DeviceId', record.deviceId,
      '-ApprovalFile', record.approvalFile,
      '-LeaseFile', record.leaseFile,
      '-LeaseTimeoutMs', String(ADMIN_PROMPT_LEASE_TIMEOUT_MS),
      '-TimeoutSeconds', String(ADMIN_PROMPT_TIMEOUT_SECONDS),
    ] });
  } catch (error) {
    removePromptFiles(record);
    fail('EXECUTION_FAILED', { reason: 'approval_prompt_spawn_failed', detail: error?.message });
  }
  record.child = child;
  record.heartbeat = setInterval(() => {
    try { fs.writeFileSync(record.leaseFile, String(Date.now()), 'utf8'); } catch {}
  }, 1_000);
  record.heartbeat.unref?.();
  try {
    record.watcher = fs.watch(dir, { persistent: false }, () => readApprovalFile(record));
  } catch (error) {
    cleanupPendingRecord(record);
    fail('EXECUTION_FAILED', { reason: 'approval_watch_failed', detail: error?.message });
  }
  child?.once?.('error', () => expireRecord(record));
  child?.once?.('exit', () => {
    if (record.status === 'pending') readApprovalFile(record);
    if (record.status === 'pending') expireRecord(record);
  });
  const delay = Math.max(0, new Date(record.expiresAt).getTime() - Date.now());
  record.timeout = setTimeout(() => expireRecord(record), delay);
  record.timeout.unref?.();
}

function createRecord({ session, requestId, action, normalizedArguments }) {
  const expiresAt = new Date(Math.min(Date.now() + ADMIN_REQUEST_TTL_MS, new Date(session.expiresAt).getTime())).toISOString();
  const record = {
    actionId: crypto.randomUUID(),
    requestId,
    sessionId: session.id,
    deviceId: session.deviceId,
    action,
    normalizedArguments,
    approvalNonce: crypto.randomBytes(24).toString('base64url'),
    approvalBinding: '',
    createdAt: new Date().toISOString(),
    expiresAt,
    status: 'pending',
    approvalState: 'pending',
    result: null,
  };
  record.approvalBinding = crypto.createHash('sha256').update(JSON.stringify({
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    action: record.action,
    normalizedArguments: record.normalizedArguments,
    expiresAt: record.expiresAt,
    approvalNonce: record.approvalNonce,
  })).digest('hex');
  return record;
}

export async function requestAdminAction({ sessionId, deviceId, presentedNonce, requestId, action, arguments: actionArguments } = {}) {
  const validated = requireAdminSession({ sessionId, deviceId, presentedNonce });
  const normalizedArguments = ensureArgumentsForAction(action, actionArguments);
  validateRequestId(requestId);
  if (!HIGH_SET.has(action)) fail('ACTION_NOT_ALLOWED', { reason: 'read_only_actions_use_read_routes' });

  const requestKey = `${validated.session.id}:${requestId}`;
  const existing = actionsByRequest.get(requestKey);
  if (existing) {
    if (existing.action !== action || existing.normalizedArguments !== normalizedArguments) fail('ACTION_NOT_ALLOWED', { reason: 'request_id_binding_mismatch' });
    return { ...getSafeRecord(existing), nextNonce: validated.nextNonce, idempotent: true };
  }

  checkHighRate(validated.session.id);
  requireAdminIndicator(validated.session);
  const record = createRecord({ session: validated.session, requestId, action, normalizedArguments });
  pendingActions.set(record.actionId, record);
  actionsByRequest.set(requestKey, record);
  pruneActionHistory();
  audit('ADMIN_REQUESTED', record, 'pending');
  try {
    startLocalPrompt(record);
  } catch (error) {
    record.status = 'failed';
    record.approvalState = 'denied';
    record.result = { error: error.code === 'EXECUTION_FAILED' ? 'EXECUTION_FAILED' : 'APPROVAL_REQUIRED' };
    audit('ADMIN_FAILED', record, record.result.error);
    cleanupPendingRecord(record);
  }
  return { ...getSafeRecord(record), nextNonce: validated.nextNonce };
}

export async function executeAdminReadAction({ sessionId, deviceId, presentedNonce, action, requestId = crypto.randomUUID(), arguments: actionArguments } = {}) {
  const validated = requireAdminSession({ sessionId, deviceId, presentedNonce });
  const normalizedArguments = ensureArgumentsForAction(action, actionArguments);
  validateRequestId(requestId);
  if (!READ_SET.has(action)) fail('ACTION_NOT_ALLOWED', { reason: 'high_impact_actions_require_local_approval' });
  checkReadRate(validated.session.id);
  requireAdminIndicator(validated.session);

  const record = createRecord({ session: validated.session, requestId, action, normalizedArguments });
  record.approvalState = 'not_required';
  record.status = 'executing';
  audit('ADMIN_REQUESTED', record, 'read_only');
  try {
    const outcome = await actionExecutor(action);
    if (!outcome?.ok) {
      record.status = 'failed';
      record.result = { error: outcome?.error === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : 'EXECUTION_FAILED' };
      audit('ADMIN_FAILED', record, record.result.error);
      fail(record.result.error);
    }
    record.status = 'executed';
    record.result = sanitizeExecutorResult(outcome, action);
    audit('ADMIN_EXECUTED', record, 'success');
    return { ...getSafeRecord(record), nextNonce: validated.nextNonce };
  } catch (error) {
    if (error instanceof OmegaAdminError) throw error;
    record.status = 'failed';
    record.result = { error: 'EXECUTION_FAILED' };
    audit('ADMIN_FAILED', record, 'EXECUTION_FAILED');
    fail('EXECUTION_FAILED');
  }
}

export function getAdminActionStatus({ sessionId, deviceId, presentedNonce, actionId } = {}) {
  const validated = requireAdminSession({ sessionId, deviceId, presentedNonce });
  validateActionId(actionId);
  const record = actionsByRequest.size ? [...actionsByRequest.values()].find(item => item.actionId === actionId) : null;
  if (!record || record.sessionId !== validated.session.id || record.deviceId !== validated.session.deviceId) fail('ACTION_NOT_ALLOWED');
  return { ...getSafeRecord(record), nextNonce: validated.nextNonce };
}

export function approveAdminActionLocally(actionId) {
  validateActionId(actionId);
  const record = [...actionsByRequest.values()].find(item => item.actionId === actionId);
  if (!record || record.status !== 'pending') fail('APPROVAL_EXPIRED');
  void consumeLocalDecision(record, 'ALLOW');
  return getSafeRecord(record);
}

export function denyAdminActionLocally(actionId) {
  validateActionId(actionId);
  const record = [...actionsByRequest.values()].find(item => item.actionId === actionId);
  if (!record || record.status !== 'pending') fail('APPROVAL_EXPIRED');
  return markDenied(record, 'denied');
}

export function getAdminStatus({ sessionId, deviceId, presentedNonce } = {}) {
  const validated = requireAdminSession({ sessionId, deviceId, presentedNonce });
  requireAdminIndicator(validated.session);
  return {
    nextNonce: validated.nextNonce,
    permissionLevel: validated.permissionLevel,
    actions: OMEGA_ADMIN_ACTIONS,
    readOnlyActions: OMEGA_ADMIN_READ_ACTIONS,
    highImpactActions: OMEGA_ADMIN_HIGH_IMPACT_ACTIONS,
    limits: {
      readOnlyPerMinute: ADMIN_READ_MAX_PER_WINDOW,
      highImpactMinIntervalMs: ADMIN_HIGH_MIN_INTERVAL_MS,
      highImpactPendingPerSession: 1,
    },
  };
}

export function cancelPendingAdminActionsForSession(sessionId, reason = 'session_ended') {
  for (const record of pendingActions.values()) {
    if (record.sessionId === sessionId) markDenied(record, reason);
  }
  indicatorProvider.stop(sessionId, 'admin');
}

export function cancelPendingAdminActionsForDevice(deviceId) {
  for (const record of pendingActions.values()) {
    if (record.deviceId === deviceId) markDenied(record, 'device_revoked');
  }
}

function sanitizeExecutorResult(outcome, action) {
  const copy = { ...outcome };
  delete copy.ok;
  delete copy.error;
  if (action === 'GET_PROCESS_LIST' && Array.isArray(copy.processes)) copy.processes = copy.processes.slice(0, 200);
  if (action === 'GET_SERVICE_STATUS' && Array.isArray(copy.services)) copy.services = copy.services.slice(0, 200);
  if (action === 'GET_NETWORK_STATUS' && Array.isArray(copy.interfaces)) copy.interfaces = copy.interfaces.slice(0, 64);
  if (action === 'GET_DISK_STATUS' && Array.isArray(copy.disks)) copy.disks = copy.disks.slice(0, 32);
  try {
    if (JSON.stringify(copy).length > MAX_ADMIN_RESULT_BYTES) return { error: 'EXECUTION_FAILED' };
  } catch { return { error: 'EXECUTION_FAILED' }; }
  return copy;
}

function parseExecutorOutput(stdout, action) {
  if (typeof stdout !== 'string' || stdout.length === 0 || stdout.length > MAX_ADMIN_RESULT_BYTES) return { ok: false, error: 'EXECUTION_FAILED' };
  let parsed;
  try { parsed = JSON.parse(stdout.trim()); } catch { return { ok: false, error: 'EXECUTION_FAILED' }; }
  if (!parsed || parsed.action !== action || typeof parsed.ok !== 'boolean') return { ok: false, error: 'EXECUTION_FAILED' };
  if (!parsed.ok) return { ok: false, error: parsed.error === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : 'EXECUTION_FAILED' };
  return parsed;
}

async function runFixedSemanticAction(action) {
  if (!isWindows()) return { ok: false, error: 'NOT_SUPPORTED' };
  const result = await runFixedPowerShellScript(ADMIN_SCRIPT_PATH, [action], { timeoutMs: 8_000 });
  if (!result.ok) {
    const detail = String(result.detail ?? '').toLowerCase();
    return { ok: false, error: detail.includes('access denied') ? 'ACCESS_DENIED' : result.reason === 'timeout' ? 'EXECUTION_FAILED' : 'EXECUTION_FAILED' };
  }
  return parseExecutorOutput(result.stdout, action);
}

export function getSystemInfo() { return runFixedSemanticAction('GET_SYSTEM_INFO'); }
export function getProcessList() { return runFixedSemanticAction('GET_PROCESS_LIST'); }
export function getServiceStatus() { return runFixedSemanticAction('GET_SERVICE_STATUS'); }
export function getNetworkStatus() { return runFixedSemanticAction('GET_NETWORK_STATUS'); }
export function getDiskStatus() { return runFixedSemanticAction('GET_DISK_STATUS'); }
export function lockWorkstation() { return runFixedSemanticAction('LOCK_WORKSTATION'); }
export function requestLogoff() { return runFixedSemanticAction('REQUEST_LOGOFF'); }
export function requestRestart() { return runFixedSemanticAction('REQUEST_RESTART'); }
export function requestShutdown() { return runFixedSemanticAction('REQUEST_SHUTDOWN'); }

const SEMANTIC_EXECUTORS = Object.freeze({
  GET_SYSTEM_INFO: getSystemInfo,
  GET_PROCESS_LIST: getProcessList,
  GET_SERVICE_STATUS: getServiceStatus,
  GET_NETWORK_STATUS: getNetworkStatus,
  GET_DISK_STATUS: getDiskStatus,
  LOCK_WORKSTATION: lockWorkstation,
  REQUEST_LOGOFF: requestLogoff,
  REQUEST_RESTART: requestRestart,
  REQUEST_SHUTDOWN: requestShutdown,
});

export async function executeRealAdminAction(action) {
  validateAction(action);
  return SEMANTIC_EXECUTORS[action]();
}

export function _setAdminExecutorForTests(executor) { actionExecutor = executor; }
export function _resetAdminExecutorForTests() { actionExecutor = executeRealAdminAction; }
export function _setAdminIndicatorProviderForTests(provider) { indicatorProvider = { ...indicatorProvider, ...provider }; }
export function _resetAdminIndicatorProviderForTests() {
  indicatorProvider = { start: startPersistentIndicator, stop: stopPersistentIndicator, get: getPersistentIndicatorState };
}
export function _setAdminPromptProcessFactoryForTests(factory) { promptProcessFactory = factory; }
export function _resetAdminPromptProcessFactoryForTests() {
  promptProcessFactory = ({ args }) => spawn(POWERSHELL_EXE, args, { shell: false, windowsHide: true, stdio: 'ignore' });
}
export function _resetAdminStateForTests() {
  for (const record of [...pendingActions.values()]) cleanupPendingRecord(record);
  pendingActions.clear();
  actionsByRequest.clear();
  readTimestamps.clear();
  highActionTimestamps.clear();
}
export function _expireAdminActionForTests(actionId) {
  const record = [...actionsByRequest.values()].find(item => item.actionId === actionId);
  if (record) expireRecord(record, 'expired');
}

registerOmegaAdminLifecycle({
  onSessionEnded: (sessionId, reason) => cancelPendingAdminActionsForSession(sessionId, reason),
  onDeviceRevoked: (deviceId) => cancelPendingAdminActionsForDevice(deviceId),
});

export { ADMIN_SCRIPT_PATH, PROMPT_SCRIPT_PATH, ADMIN_REQUEST_TTL_MS, ADMIN_HIGH_MIN_INTERVAL_MS };
