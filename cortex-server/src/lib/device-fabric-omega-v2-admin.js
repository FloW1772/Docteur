/**
 * Device Fabric V2 Phase 5 — closed OMEGA V2 ADMIN orchestration + Fabric
 * controller STOP.
 *
 * Fabric's job here is exactly what it is for VIEW/INTERACTIVE: exact-target
 * resolution, TOCTOU revalidation, and delegating to OMEGA V2's own already
 * certified typed ADMIN functions (`omega-outbound-client.js`,
 * `omega-outbound-admin.js`). Fabric never deduces ADMIN from the link, never
 * approves a high-impact action itself, never stores an approval token, and
 * never exposes a generic executor. The closed semantic allowlist — five
 * read-only actions and four high-impact actions, each already a fixed
 * enum-to-V1-typed-executor mapping inside OMEGA V2 — is reused unchanged.
 * There is deliberately no `runFabricOmegaV2AdminOperation(id, action)`
 * generic entry point: every action gets its own typed wrapper function
 * (mission §13).
 */
import { insertFabricAudit } from './sqlite.js';
import { getOmegaV2LinkView, resolveFabricOmegaV2Target, OMEGA_V2_AGENT_TYPE } from './device-fabric-omega-v2.js';
import {
  connectOmegaDevice, getOmegaOutboundSession, stopOmegaOutboundSession,
  getOmegaOutboundAdminSystemInfo, listOmegaOutboundAdminProcesses, getOmegaOutboundAdminServiceStatus,
  getOmegaOutboundAdminNetworkStatus, getOmegaOutboundAdminDiskStatus,
  requestOmegaOutboundAdminLock, requestOmegaOutboundAdminLogoff, requestOmegaOutboundAdminRestart, requestOmegaOutboundAdminShutdown,
  getOmegaOutboundAdminOperation, cancelOmegaOutboundAdminOperation,
} from './omega-outbound-client.js';

const READS_PER_MINUTE = 30;
const HIGH_IMPACT_PER_MINUTE = 4;
const STATUS_PER_MINUTE = 120;
const STOPS_PER_MINUTE = 30;

export class DeviceFabricOmegaV2AdminError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = 'DeviceFabricOmegaV2AdminError';
    this.code = code;
    this.status = status;
  }
}

// Safe-error mapping over OMEGA V2's own closed vocabulary (mission §36-style
// list, ADMIN edition). Never a raw message, never a stack, never a command
// echo — OMEGA's own outcome codes are already safe and are passed through.
function mappedCode(error) {
  const code = error?.code ?? error?.message;
  const mapping = {
    omega_v2_not_linked: 'OMEGA_V2_NOT_LINKED',
    omega_v2_host_missing: 'OMEGA_V2_LINK_STALE',
    omega_v2_link_stale: 'OMEGA_V2_LINK_STALE',
    omega_v2_host_revoked: 'OMEGA_V2_REVOKED',
    DEVICE_UNTRUSTED: 'OMEGA_V2_REVOKED',
    DEVICE_REVOKED: 'OMEGA_V2_REVOKED',
    TLS_IDENTITY_MISMATCH: 'OMEGA_V2_TLS_FAILURE',
    PERMISSION_DENIED: 'OMEGA_V2_ADMIN_NOT_AUTHORIZED',
    SESSION_EXPIRED: 'OMEGA_V2_SESSION_EXPIRED',
    SESSION_NOT_FOUND: 'OMEGA_V2_SESSION_EXPIRED',
    REMOTE_STOPPED: 'OMEGA_V2_REMOTE_STOPPED',
    NETWORK_UNAVAILABLE: 'OMEGA_V2_NETWORK_UNAVAILABLE',
    RATE_LIMITED: 'OMEGA_V2_RATE_LIMITED',
    ADMIN_ACTION_INVALID: 'OMEGA_V2_ADMIN_ACTION_INVALID',
    ADMIN_PAYLOAD_INVALID: 'OMEGA_V2_ADMIN_ACTION_INVALID',
    OPERATION_ID_INVALID: 'OMEGA_V2_ADMIN_OPERATION_NOT_FOUND',
    OPERATION_NOT_FOUND: 'OMEGA_V2_ADMIN_OPERATION_NOT_FOUND',
    OPERATION_DUPLICATE: 'OMEGA_V2_ADMIN_OPERATION_NOT_FOUND',
    ADMIN_HIGH_IMPACT_PENDING: 'OMEGA_V2_ADMIN_HIGH_IMPACT_PENDING',
    REMOTE_CONSENT_UNAVAILABLE: 'OMEGA_V2_ADMIN_APPROVAL_UNAVAILABLE',
    ADMIN_RESULT_MISMATCH: 'OMEGA_V2_UNAVAILABLE',
    ADMIN_RESULT_INVALID: 'OMEGA_V2_UNAVAILABLE',
  };
  return mapping[code] ?? 'OMEGA_V2_UNAVAILABLE';
}

function fail(code, status = 409) {
  throw new DeviceFabricOmegaV2AdminError(code, status);
}

function sameBinding(left, right) {
  return left.fabricDeviceId === right.fabricDeviceId
    && left.linkId === right.linkId
    && left.linkVersion === right.linkVersion
    && left.omegaV2HostId === right.omegaV2HostId
    && left.fingerprint === right.fingerprint;
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validateOperationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('OMEGA_V2_ADMIN_REQUEST_INVALID', 400);
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'operationId') fail('OMEGA_V2_ADMIN_REQUEST_INVALID', 400);
  if (typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)) fail('OMEGA_V2_ADMIN_REQUEST_INVALID', 400);
  return input.operationId;
}

/** Testable factory for the closed ADMIN + STOP operations. */
export function createFabricOmegaV2AdminService(overrides = {}) {
  const deps = {
    resolveTarget: resolveFabricOmegaV2Target,
    // Same principle as VIEW/INTERACTIVE: Fabric asks for the trust's own
    // ceiling, never invents ADMIN itself. OMEGA re-verifies session
    // permission === 'ADMIN' independently on every single call (mission
    // §6: "Fabric ne déduit jamais ADMIN du simple lien").
    connectPermission: fabricDeviceId => getOmegaV2LinkView(fabricDeviceId)?.trust?.maxPermission ?? 'VIEW',
    connectAdmin: (hostId, permission, options) => connectOmegaDevice(hostId, permission, options),
    getSession: getOmegaOutboundSession,
    stopSession: stopOmegaOutboundSession,
    reads: {
      GET_SYSTEM_INFO: getOmegaOutboundAdminSystemInfo,
      PROCESS_LIST: listOmegaOutboundAdminProcesses,
      SERVICE_STATUS: getOmegaOutboundAdminServiceStatus,
      NETWORK_STATUS: getOmegaOutboundAdminNetworkStatus,
      DISK_STATUS: getOmegaOutboundAdminDiskStatus,
    },
    highImpact: {
      LOCK: requestOmegaOutboundAdminLock,
      LOGOFF: requestOmegaOutboundAdminLogoff,
      RESTART: requestOmegaOutboundAdminRestart,
      SHUTDOWN: requestOmegaOutboundAdminShutdown,
    },
    getOperation: getOmegaOutboundAdminOperation,
    cancelOperation: cancelOmegaOutboundAdminOperation,
    audit: fields => insertFabricAudit(fields),
    now: () => Date.now(),
    ...overrides,
  };
  // Fabric-owned ADMIN-capable sessions only. STOP ALL iterates exactly this
  // map's keys — never the global stopAllOmegaOutboundSessions(), which
  // would reach sessions Fabric never created (mission §27, §30, §31).
  const activeByFabricDevice = new Map();
  const attempts = new Map();

  function audit(eventType, binding, reason = null) {
    deps.audit({
      eventType, fabricDeviceId: binding?.fabricDeviceId ?? null,
      agentType: OMEGA_V2_AGENT_TYPE, agentDeviceId: binding?.omegaV2HostId ?? null,
      reason,
    });
  }

  function limit(fabricDeviceId, operation, maximum) {
    const key = `${fabricDeviceId}:${operation}`;
    const now = deps.now();
    const recent = (attempts.get(key) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= maximum) fail('OMEGA_V2_RATE_LIMITED', 429);
    recent.push(now);
    attempts.set(key, recent);
  }

  /** Exact-target resolve + TOCTOU-style revalidation against the binding an ADMIN session was created under, or a fresh double-read when none exists yet. */
  function revalidate(fabricDeviceId, against) {
    const resolved = deps.resolveTarget(fabricDeviceId);
    if (!sameBinding(resolved, against)) fail('OMEGA_V2_LINK_CHANGED');
    return resolved;
  }

  /**
   * Ensures a CONNECTED session with exactly ADMIN permission exists for
   * this Fabric device, connecting one only if none is already bound. Never
   * upgrades an existing VIEW/INTERACTIVE session silently (mission §15):
   * a session Fabric already owns for VIEW/INTERACTIVE was requested with
   * whatever ceiling the trust allowed at that time, and if it is not
   * exactly ADMIN, ADMIN calls against it are rejected by OMEGA itself
   * (`requireAdminSession` checks `row.permission !== 'ADMIN'`) — Fabric
   * does not pre-empt that by silently opening a second session either;
   * a fresh explicit user action is what triggers a new ADMIN connect here.
   */
  async function ensureAdminSession(fabricDeviceId, expected, omegaOptions) {
    const previous = activeByFabricDevice.get(fabricDeviceId);
    const previousSession = previous ? deps.getSession(previous.sessionId) : null;
    if (previous && sameBinding(previous, expected) && previousSession?.status === 'CONNECTED'
      && previousSession.permission === 'ADMIN') {
      return { session: previousSession, binding: previous, createdNew: false };
    }
    const permission = deps.connectPermission(fabricDeviceId);
    const session = await deps.connectAdmin(expected.omegaV2HostId, permission, omegaOptions);
    if (!session || session.remoteOmegaDeviceId !== expected.omegaV2HostId) fail('OMEGA_V2_WRONG_DEVICE');
    if (session.permission !== 'ADMIN') {
      // OMEGA itself capped this below ADMIN (trust ceiling too low): Fabric
      // never silently retries at a different level or infers a grant.
      await deps.stopSession(session.sessionId, omegaOptions).catch(() => {});
      fail('OMEGA_V2_ADMIN_NOT_AUTHORIZED');
    }
    const binding = { ...expected, sessionId: session.sessionId };
    activeByFabricDevice.set(fabricDeviceId, binding);
    return { session, binding, createdNew: true };
  }

  async function runRead(fabricDeviceId, actionType, omegaOptions) {
    limit(fabricDeviceId, 'admin-read', READS_PER_MINUTE);
    let expected = { fabricDeviceId };
    let createdNew = false;
    let sessionId = null;
    try {
      expected = deps.resolveTarget(fabricDeviceId);
      audit('FABRIC_OMEGA_V2_ADMIN_REQUESTED', expected, actionType);
      const revalidated = revalidate(fabricDeviceId, expected);
      const ensured = await ensureAdminSession(fabricDeviceId, revalidated, omegaOptions);
      createdNew = ensured.createdNew;
      sessionId = ensured.session.sessionId;
      const result = await deps.reads[actionType](sessionId, omegaOptions);
      audit(result.status === 'EXECUTED' ? 'FABRIC_OMEGA_V2_ADMIN_COMPLETED' : 'FABRIC_OMEGA_V2_ADMIN_FAILED', revalidated, result.status);
      return { fabricDeviceId, omegaV2HostId: revalidated.omegaV2HostId, sessionId, ...result };
    } catch (error) {
      const code = error instanceof DeviceFabricOmegaV2AdminError ? error.code : mappedCode(error);
      if (createdNew && sessionId) await deps.stopSession(sessionId, omegaOptions).catch(() => {});
      audit('FABRIC_OMEGA_V2_ADMIN_FAILED', expected, code);
      if (error instanceof DeviceFabricOmegaV2AdminError) throw error;
      throw new DeviceFabricOmegaV2AdminError(code, code === 'OMEGA_V2_RATE_LIMITED' ? 429 : 409);
    }
  }

  async function runHighImpact(fabricDeviceId, actionType, omegaOptions) {
    limit(fabricDeviceId, 'admin-high-impact', HIGH_IMPACT_PER_MINUTE);
    let expected = { fabricDeviceId };
    let createdNew = false;
    let sessionId = null;
    try {
      expected = deps.resolveTarget(fabricDeviceId);
      audit('FABRIC_OMEGA_V2_ADMIN_REQUESTED', expected, actionType);
      const revalidated = revalidate(fabricDeviceId, expected);
      const ensured = await ensureAdminSession(fabricDeviceId, revalidated, omegaOptions);
      createdNew = ensured.createdNew;
      sessionId = ensured.session.sessionId;
      const operation = await deps.highImpact[actionType](sessionId, omegaOptions);
      const eventType = operation.status === 'PENDING_APPROVAL' ? 'FABRIC_OMEGA_V2_ADMIN_WAITING_APPROVAL'
        : operation.status === 'EXECUTED' ? 'FABRIC_OMEGA_V2_ADMIN_COMPLETED'
        : operation.status === 'DENIED' ? 'FABRIC_OMEGA_V2_ADMIN_DENIED' : 'FABRIC_OMEGA_V2_ADMIN_FAILED';
      audit(eventType, revalidated, operation.status);
      return { fabricDeviceId, omegaV2HostId: revalidated.omegaV2HostId, sessionId, ...operation };
    } catch (error) {
      const code = error instanceof DeviceFabricOmegaV2AdminError ? error.code : mappedCode(error);
      if (createdNew && sessionId) await deps.stopSession(sessionId, omegaOptions).catch(() => {});
      audit('FABRIC_OMEGA_V2_ADMIN_FAILED', expected, code);
      if (error instanceof DeviceFabricOmegaV2AdminError) throw error;
      throw new DeviceFabricOmegaV2AdminError(code, code === 'OMEGA_V2_RATE_LIMITED' ? 429 : 409);
    }
  }

  function requireBoundSession(fabricDeviceId) {
    const binding = activeByFabricDevice.get(fabricDeviceId);
    if (!binding) fail('OMEGA_V2_ADMIN_SESSION_NOT_ACTIVE', 404);
    return binding;
  }

  async function operationStatus(fabricDeviceId, rawInput, omegaOptions) {
    limit(fabricDeviceId, 'admin-status', STATUS_PER_MINUTE);
    const binding = requireBoundSession(fabricDeviceId);
    const operationId = validateOperationInput(rawInput);
    try {
      const operation = await deps.getOperation(binding.sessionId, operationId, omegaOptions);
      return { fabricDeviceId, omegaV2HostId: binding.omegaV2HostId, sessionId: binding.sessionId, ...operation };
    } catch (error) {
      const code = error instanceof DeviceFabricOmegaV2AdminError ? error.code : mappedCode(error);
      throw new DeviceFabricOmegaV2AdminError(code, code === 'OMEGA_V2_RATE_LIMITED' ? 429 : 409);
    }
  }

  async function cancelOperationForFabricDevice(fabricDeviceId, rawInput, omegaOptions) {
    limit(fabricDeviceId, 'admin-status', STATUS_PER_MINUTE);
    const binding = requireBoundSession(fabricDeviceId);
    const operationId = validateOperationInput(rawInput);
    try {
      const operation = await deps.cancelOperation(binding.sessionId, operationId, omegaOptions);
      audit('FABRIC_OMEGA_V2_ADMIN_CANCELLED', binding, operation.status);
      return { fabricDeviceId, omegaV2HostId: binding.omegaV2HostId, sessionId: binding.sessionId, ...operation };
    } catch (error) {
      const code = error instanceof DeviceFabricOmegaV2AdminError ? error.code : mappedCode(error);
      throw new DeviceFabricOmegaV2AdminError(code, code === 'OMEGA_V2_RATE_LIMITED' ? 429 : 409);
    }
  }

  // ── Typed read wrappers (mission §13): one function per action, no enum arg. ──
  const getSystemInfoForFabricDevice = (fabricDeviceId, omegaOptions = {}) => runRead(fabricDeviceId, 'GET_SYSTEM_INFO', omegaOptions);
  const listProcessesForFabricDevice = (fabricDeviceId, omegaOptions = {}) => runRead(fabricDeviceId, 'PROCESS_LIST', omegaOptions);
  const getServiceStatusForFabricDevice = (fabricDeviceId, omegaOptions = {}) => runRead(fabricDeviceId, 'SERVICE_STATUS', omegaOptions);
  const getNetworkStatusForFabricDevice = (fabricDeviceId, omegaOptions = {}) => runRead(fabricDeviceId, 'NETWORK_STATUS', omegaOptions);
  const getDiskStatusForFabricDevice = (fabricDeviceId, omegaOptions = {}) => runRead(fabricDeviceId, 'DISK_STATUS', omegaOptions);

  // ── Typed high-impact wrappers: explicit user action only; the confirmation
  // token names the exact action, mirroring OMEGA V2's own local route guard
  // (mission §9, §19: Fabric's own confirmation never substitutes for the
  // remote device's local approval — it only gates Fabric's own request). ──
  function requireConfirm(rawInput, expected) {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)
      || Object.keys(rawInput).length !== 1 || rawInput.confirm !== expected) {
      fail('OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED', 400);
    }
  }
  // async so an invalid/missing confirmation is always a rejected promise,
  // never a synchronous throw a caller might not be awaiting yet.
  const lockFabricDevice = async (fabricDeviceId, rawInput, omegaOptions = {}) => { requireConfirm(rawInput, 'LOCK'); return runHighImpact(fabricDeviceId, 'LOCK', omegaOptions); };
  const logoffFabricDevice = async (fabricDeviceId, rawInput, omegaOptions = {}) => { requireConfirm(rawInput, 'LOGOFF'); return runHighImpact(fabricDeviceId, 'LOGOFF', omegaOptions); };
  const restartFabricDevice = async (fabricDeviceId, rawInput, omegaOptions = {}) => { requireConfirm(rawInput, 'RESTART'); return runHighImpact(fabricDeviceId, 'RESTART', omegaOptions); };
  const shutdownFabricDevice = async (fabricDeviceId, rawInput, omegaOptions = {}) => { requireConfirm(rawInput, 'SHUTDOWN'); return runHighImpact(fabricDeviceId, 'SHUTDOWN', omegaOptions); };

  // ── Controller STOP (mission §26-31): a capacity reduction, never an
  // ADMIN operation itself — no approval, no allowlist check, no permission
  // requirement beyond the Fabric binding already existing. ──
  async function stopDeviceForFabricDevice(fabricDeviceId, omegaOptions = {}) {
    limit(fabricDeviceId, 'admin-stop', STOPS_PER_MINUTE);
    const binding = activeByFabricDevice.get(fabricDeviceId);
    if (!binding) return { fabricDeviceId, sessionId: null, stopped: false };
    await deps.stopSession(binding.sessionId, omegaOptions).catch(() => {});
    activeByFabricDevice.delete(fabricDeviceId);
    audit('FABRIC_OMEGA_V2_ADMIN_STOP_COMPLETED', binding, 'user_stop_device');
    return { fabricDeviceId, sessionId: binding.sessionId, stopped: true };
  }

  /**
   * Stops only sessions this process bound for ADMIN. Never calls the
   * global stopAllOmegaOutboundSessions() (which would reach VIEW/
   * INTERACTIVE-only sessions and any session opened outside Fabric).
   * A failure on one device's stop never aborts the others (mission §30);
   * results are returned per device.
   */
  async function stopAllForFabricDevices(omegaOptions = {}) {
    const bindings = [...activeByFabricDevice.entries()];
    const results = await Promise.allSettled(bindings.map(async ([fabricDeviceId, binding]) => {
      await deps.stopSession(binding.sessionId, omegaOptions).catch(() => {});
      activeByFabricDevice.delete(fabricDeviceId);
      audit('FABRIC_OMEGA_V2_ADMIN_STOP_COMPLETED', binding, 'user_stop_all');
      return { fabricDeviceId, sessionId: binding.sessionId, stopped: true };
    }));
    return results.map((result, index) => result.status === 'fulfilled'
      ? result.value
      : { fabricDeviceId: bindings[index][0], sessionId: bindings[index][1].sessionId, stopped: false });
  }

  /** Read-only: never connects, never creates a session (mission §36). */
  function getAdminStateForFabricDevice(fabricDeviceId) {
    const binding = activeByFabricDevice.get(fabricDeviceId);
    if (!binding) {
      let resolved;
      try { resolved = deps.resolveTarget(fabricDeviceId); }
      catch (error) { throw new DeviceFabricOmegaV2AdminError(mappedCode(error), error?.status ?? 409); }
      return { fabricDeviceId, omegaV2HostId: resolved.omegaV2HostId, sessionId: null, sessionStatus: 'DISCONNECTED', linkChanged: false };
    }
    const session = deps.getSession(binding.sessionId);
    let linkChanged = false;
    try { linkChanged = !sameBinding(binding, deps.resolveTarget(fabricDeviceId)); }
    catch { linkChanged = true; }
    if (!session || session.status !== 'CONNECTED' || session.permission !== 'ADMIN') {
      activeByFabricDevice.delete(fabricDeviceId);
      return { fabricDeviceId, omegaV2HostId: binding.omegaV2HostId, sessionId: null, sessionStatus: 'DISCONNECTED', linkChanged };
    }
    return { fabricDeviceId, omegaV2HostId: binding.omegaV2HostId, sessionId: binding.sessionId, sessionStatus: session.status, linkChanged };
  }

  return {
    getSystemInfoForFabricDevice, listProcessesForFabricDevice, getServiceStatusForFabricDevice,
    getNetworkStatusForFabricDevice, getDiskStatusForFabricDevice,
    lockFabricDevice, logoffFabricDevice, restartFabricDevice, shutdownFabricDevice,
    operationStatusForFabricDevice: operationStatus, cancelOperationForFabricDevice,
    stopDeviceForFabricDevice, stopAllForFabricDevices, getAdminStateForFabricDevice,
  };
}

const service = createFabricOmegaV2AdminService();
export const getSystemInfoForFabricDevice = service.getSystemInfoForFabricDevice;
export const listProcessesForFabricDevice = service.listProcessesForFabricDevice;
export const getServiceStatusForFabricDevice = service.getServiceStatusForFabricDevice;
export const getNetworkStatusForFabricDevice = service.getNetworkStatusForFabricDevice;
export const getDiskStatusForFabricDevice = service.getDiskStatusForFabricDevice;
export const lockFabricDevice = service.lockFabricDevice;
export const logoffFabricDevice = service.logoffFabricDevice;
export const restartFabricDevice = service.restartFabricDevice;
export const shutdownFabricDevice = service.shutdownFabricDevice;
export const operationStatusForFabricDevice = service.operationStatus;
export const cancelOperationForFabricDevice = service.cancelOperationForFabricDevice;
export const stopDeviceForFabricDevice = service.stopDeviceForFabricDevice;
export const stopAllForFabricDevices = service.stopAllForFabricDevices;
export const getAdminStateForFabricDevice = service.getAdminStateForFabricDevice;
