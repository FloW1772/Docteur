/**
 * Device Fabric V2 Phase 3/4 — closed OMEGA V2 VIEW + INTERACTIVE
 * orchestration.
 *
 * This module names one exact Fabric link, asks the already-certified OMEGA
 * controller for VIEW/INTERACTIVE permission, and retains only opaque public
 * ids in process memory. Frames AND input events never pass through Fabric:
 * pointer/keyboard/wheel events are sent by the browser straight to OMEGA
 * V2's own certified `/api/omega/outbound/sessions/:id/input/*` and
 * `/interactive/*` routes with the sessionId this module returns (mission
 * §13, §14: the certified OMEGA V2 mapping — bounds, letterbox, button
 * allowlist, wheel bounds, coalescing, queue limits, keyboard allowlist —
 * stays the single source of truth and is never reimplemented here).
 * Fabric's own job is START/STOP orchestration only: exact-target
 * resolution, TOCTOU revalidation, and reflecting OMEGA's own STOP/
 * revocation/expiry/network-drop outcomes. There is deliberately no action
 * name, raw payload, target override, fallback target, raw input primitive
 * or ADMIN primitive in this module.
 */
import { insertFabricAudit } from './sqlite.js';
import { getOmegaV2LinkView, resolveFabricOmegaV2Target, OMEGA_V2_AGENT_TYPE } from './device-fabric-omega-v2.js';
import {
  connectOmegaDevice, getOmegaOutboundSession, startOmegaOutboundInteractive,
  startOmegaOutboundView, stopOmegaOutboundInteractive, stopOmegaOutboundSession, stopOmegaOutboundView,
} from './omega-outbound-client.js';

const FINGERPRINT = /^[0-9a-f]{64}$/;
const STARTS_PER_MINUTE = 10;
const STOPS_PER_MINUTE = 30;

export class DeviceFabricOmegaV2ViewError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = 'DeviceFabricOmegaV2ViewError';
    this.code = code;
    this.status = status;
  }
}

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
    PERMISSION_DENIED: 'OMEGA_V2_PERMISSION_DENIED',
    SESSION_EXPIRED: 'OMEGA_V2_SESSION_EXPIRED',
    SESSION_NOT_FOUND: 'OMEGA_V2_SESSION_EXPIRED',
    REMOTE_STOPPED: 'OMEGA_V2_REMOTE_STOPPED',
    VIEW_NOT_STARTED: 'OMEGA_V2_REMOTE_STOPPED',
    VIEW_NOT_ACTIVE: 'OMEGA_V2_VIEW_NOT_ACTIVE',
    STREAM_EXPIRED: 'OMEGA_V2_REMOTE_STOPPED',
    WRONG_STREAM: 'OMEGA_V2_VIEW_NOT_ACTIVE',
    INTERACTIVE_ALREADY_STARTED: 'OMEGA_V2_INTERACTIVE_ALREADY_STARTED',
    INTERACTIVE_NOT_STARTED: 'OMEGA_V2_REMOTE_STOPPED',
    NETWORK_UNAVAILABLE: 'OMEGA_V2_NETWORK_UNAVAILABLE',
    RATE_LIMITED: 'OMEGA_V2_RATE_LIMITED',
  };
  return mapping[code] ?? 'OMEGA_V2_UNAVAILABLE';
}

function fail(code, status = 409) {
  throw new DeviceFabricOmegaV2ViewError(code, status);
}

function sameBinding(left, right) {
  return left.fabricDeviceId === right.fabricDeviceId
    && left.linkId === right.linkId
    && left.linkVersion === right.linkVersion
    && left.omegaV2HostId === right.omegaV2HostId
    && left.fingerprint === right.fingerprint;
}

function validateStartInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('OMEGA_V2_VIEW_REQUEST_INVALID', 400);
  const keys = Object.keys(input);
  if (keys.some(key => !['screenIndex', 'linkId', 'linkVersion', 'omegaV2HostId', 'fingerprint'].includes(key))) {
    fail('OMEGA_V2_VIEW_REQUEST_INVALID', 400);
  }
  if (!Number.isInteger(input.screenIndex) || input.screenIndex < 0 || input.screenIndex > 63
    || typeof input.linkId !== 'string' || input.linkId.length < 1 || input.linkId.length > 128
    || !Number.isInteger(input.linkVersion) || input.linkVersion < 1
    || typeof input.omegaV2HostId !== 'string' || !/^ov2h-[0-9a-f-]{36}$/.test(input.omegaV2HostId)
    || typeof input.fingerprint !== 'string' || !FINGERPRINT.test(input.fingerprint.toLowerCase())) {
    fail('OMEGA_V2_VIEW_REQUEST_INVALID', 400);
  }
  return { ...input, fingerprint: input.fingerprint.toLowerCase() };
}

/** Testable factory for the three closed VIEW operations. */
export function createFabricOmegaV2ViewService(overrides = {}) {
  const deps = {
    resolveTarget: resolveFabricOmegaV2Target,
    // Requests the trust's own permission ceiling (never more), so the same
    // session can later be explicitly elevated to INTERACTIVE by OMEGA V2's
    // own certified startOmegaOutboundInteractive — which requires the
    // SAME session, not a second one (omega-outbound-client.js
    // requireInteractiveSession checks session.permission, fixed at connect
    // time and never re-negotiated). Connecting always at 'VIEW' would make
    // INTERACTIVE permanently unreachable on that session; Fabric never
    // invents a permission, it only asks for the one OMEGA's own trust
    // record already grants — OMEGA still independently re-verifies and
    // caps it (mission §10, §11: no silent upgrade, no Fabric-side inference
    // of authorization).
    connectPermission: fabricDeviceId => getOmegaV2LinkView(fabricDeviceId)?.trust?.maxPermission ?? 'VIEW',
    connectView: (hostId, permission, options) => connectOmegaDevice(hostId, permission, options),
    startView: startOmegaOutboundView,
    getSession: getOmegaOutboundSession,
    stopView: stopOmegaOutboundView,
    stopSession: stopOmegaOutboundSession,
    startInteractive: startOmegaOutboundInteractive,
    stopInteractive: stopOmegaOutboundInteractive,
    audit: fields => insertFabricAudit(fields),
    now: () => Date.now(),
    ...overrides,
  };
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

  function safeView(binding, session, overridesView = {}) {
    return {
      fabricDeviceId: binding.fabricDeviceId,
      omegaV2HostId: binding.omegaV2HostId,
      linkId: binding.linkId,
      linkVersion: binding.linkVersion,
      sessionId: binding.sessionId ?? null,
      sessionStatus: session?.status ?? 'DISCONNECTED',
      sessionReason: session?.reason ?? null,
      viewStatus: binding.viewStatus ?? 'STOPPED',
      streamId: binding.streamId ?? null,
      screenIndex: binding.screenIndex ?? null,
      interactiveStatus: binding.interactiveStatus ?? 'STOPPED',
      linkChanged: false,
      ...overridesView,
    };
  }

  /** Held-input release, STOP and revocation/expiry always run through this: never a Fabric-local release loop (mission §19: "Fabric ne fait pas le release lui-même"). */
  function clearInteractive(binding) {
    binding.interactiveStatus = 'STOPPED';
  }

  async function startViewForFabricDevice(fabricDeviceId, rawInput, omegaOptions = {}) {
    const input = validateStartInput(rawInput);
    limit(fabricDeviceId, 'start', STARTS_PER_MINUTE);
    const expected = { fabricDeviceId, linkId: input.linkId, linkVersion: input.linkVersion,
      omegaV2HostId: input.omegaV2HostId, fingerprint: input.fingerprint };
    audit('FABRIC_OMEGA_V2_VIEW_REQUESTED', expected, 'explicit_user_action');
    let connectedSession = null;
    let createdNewSession = false;
    try {
      const resolved = deps.resolveTarget(fabricDeviceId);
      if (!sameBinding(resolved, expected)) fail('OMEGA_V2_LINK_CHANGED');

      // Second fresh read immediately before the only connect call. A link
      // replacement, unlink/relink or trust fingerprint/revocation change is
      // rejected; the newly named target is never used as a substitute.
      const revalidated = deps.resolveTarget(fabricDeviceId);
      if (!sameBinding(revalidated, resolved)) fail('OMEGA_V2_LINK_CHANGED');

      const previous = activeByFabricDevice.get(fabricDeviceId);
      const previousSession = previous ? deps.getSession(previous.sessionId) : null;
      if (previous && previous.viewStatus !== 'STOPPED' && previousSession?.status === 'CONNECTED') {
        fail('OMEGA_V2_VIEW_ALREADY_STARTED');
      }

      let session;
      if (previous && sameBinding(previous, revalidated) && previousSession?.status === 'CONNECTED') session = previousSession;
      else {
        // Request the trust's own ceiling, never more: OMEGA V2 still caps
        // and re-verifies this independently on every subsequent call, so
        // Fabric asking for it here is not an authorization decision, only
        // what makes a later explicit INTERACTIVE activation reachable at
        // all on THIS session (mission §10 — Fabric never infers
        // authorization itself; OMEGA's own verdict is what is trusted).
        const permission = deps.connectPermission(fabricDeviceId);
        session = await deps.connectView(revalidated.omegaV2HostId, permission, omegaOptions);
        createdNewSession = true;
      }
      connectedSession = session;
      // 'VIEW' always qualifies to view; a higher-ceiling session (INTERACTIVE
      // or ADMIN) still supports VIEW, since OMEGA V2's own permission order
      // is VIEW < INTERACTIVE < ADMIN. Anything else, or a mismatched device,
      // is rejected exactly as before.
      if (!session || session.remoteOmegaDeviceId !== revalidated.omegaV2HostId
        || !['VIEW', 'INTERACTIVE', 'ADMIN'].includes(session.permission)) {
        fail('OMEGA_V2_WRONG_DEVICE');
      }
      const view = await deps.startView(session.sessionId, input.screenIndex, omegaOptions);
      const binding = { ...revalidated, sessionId: session.sessionId, viewStatus: view.status ?? 'VIEW_STARTING',
        streamId: view.streamId ?? null, screenIndex: input.screenIndex };
      activeByFabricDevice.set(fabricDeviceId, binding);
      audit('FABRIC_OMEGA_V2_VIEW_STARTED', binding, 'VIEW');
      return safeView(binding, session);
    } catch (error) {
      const code = error instanceof DeviceFabricOmegaV2ViewError ? error.code : mappedCode(error);
      if (createdNewSession && connectedSession?.sessionId) {
        await deps.stopSession(connectedSession.sessionId, omegaOptions).catch(() => {});
      }
      audit('FABRIC_OMEGA_V2_VIEW_FAILED', expected, code);
      if (error instanceof DeviceFabricOmegaV2ViewError) throw error;
      throw new DeviceFabricOmegaV2ViewError(code, code === 'OMEGA_V2_RATE_LIMITED' ? 429 : 409);
    }
  }

  function getViewStateForFabricDevice(fabricDeviceId) {
    const binding = activeByFabricDevice.get(fabricDeviceId);
    if (!binding) {
      let resolved;
      try { resolved = deps.resolveTarget(fabricDeviceId); }
      catch (error) { throw new DeviceFabricOmegaV2ViewError(mappedCode(error), error?.status ?? 409); }
      return { fabricDeviceId, omegaV2HostId: resolved.omegaV2HostId, linkId: resolved.linkId,
        linkVersion: resolved.linkVersion, sessionId: null, sessionStatus: 'DISCONNECTED', sessionReason: null,
        viewStatus: 'STOPPED', streamId: null, screenIndex: null, linkChanged: false };
    }
    const session = deps.getSession(binding.sessionId);
    let linkChanged = false;
    let linkReason = null;
    try { linkChanged = !sameBinding(binding, deps.resolveTarget(fabricDeviceId)); }
    catch (error) { linkChanged = true; linkReason = mappedCode(error); }
    // OMEGA V2 itself kills INTERACTIVE whenever VIEW is not CONNECTED
    // (mission §20: "Si VIEW est stoppé, INTERACTIVE doit être stoppé aussi
    // par le comportement OMEGA certifié"). This mirrors that fact, it does
    // not decide it: OMEGA already tore the session down; Fabric only stops
    // presenting a control state that no longer exists.
    if (!session || session.status !== 'CONNECTED') {
      binding.viewStatus = 'STOPPED';
      binding.streamId = null;
      clearInteractive(binding);
    }
    return safeView(binding, session, { linkChanged, linkReason });
  }

  async function stopViewForFabricDevice(fabricDeviceId, omegaOptions = {}) {
    limit(fabricDeviceId, 'stop-view', STOPS_PER_MINUTE);
    const binding = activeByFabricDevice.get(fabricDeviceId);
    if (!binding) fail('OMEGA_V2_VIEW_NOT_STARTED', 404);
    let reason = 'user_stop_view';
    try {
      // stopOmegaOutboundView already stops INTERACTIVE first when active
      // (omega-outbound-client.js): Fabric calls one certified primitive,
      // never a separate interactive-release step of its own.
      if (binding.viewStatus !== 'STOPPED') await deps.stopView(binding.sessionId, omegaOptions);
    } catch (error) {
      const code = mappedCode(error);
      if (!['OMEGA_V2_REMOTE_STOPPED', 'OMEGA_V2_SESSION_EXPIRED'].includes(code)) throw new DeviceFabricOmegaV2ViewError(code);
      reason = code;
    }
    binding.viewStatus = 'STOPPED';
    binding.streamId = null;
    clearInteractive(binding);
    audit('FABRIC_OMEGA_V2_VIEW_STOPPED', binding, reason);
    return safeView(binding, deps.getSession(binding.sessionId));
  }

  async function stopSessionForFabricDevice(fabricDeviceId, omegaOptions = {}) {
    limit(fabricDeviceId, 'stop-session', STOPS_PER_MINUTE);
    const binding = activeByFabricDevice.get(fabricDeviceId);
    if (!binding) fail('OMEGA_V2_SESSION_EXPIRED', 404);
    await deps.stopSession(binding.sessionId, omegaOptions).catch(() => {});
    binding.viewStatus = 'STOPPED';
    binding.streamId = null;
    clearInteractive(binding);
    audit('FABRIC_OMEGA_V2_VIEW_STOPPED', binding, 'user_stop_session');
    activeByFabricDevice.delete(fabricDeviceId);
    return safeView(binding, deps.getSession(binding.sessionId), { sessionStatus: 'DISCONNECTED' });
  }

  // ── Phase 4: closed OMEGA V2 INTERACTIVE orchestration ──────────────────
  // Same exact-target + TOCTOU discipline as VIEW. INTERACTIVE requires an
  // already-active VIEW binding on the SAME sessionId (mission §8): Fabric
  // never starts a session for INTERACTIVE, it only asks OMEGA to elevate an
  // existing, already-validated VIEW session — exactly what
  // startOmegaOutboundInteractive itself already requires and re-checks.

  async function startInteractiveForFabricDevice(fabricDeviceId, rawInput, omegaOptions = {}) {
    if (rawInput !== undefined && rawInput !== null) {
      if (typeof rawInput !== 'object' || Array.isArray(rawInput) || Object.keys(rawInput).length > 0) {
        fail('OMEGA_V2_INTERACTIVE_REQUEST_INVALID', 400);
      }
    }
    limit(fabricDeviceId, 'interactive-start', STARTS_PER_MINUTE);
    const binding = activeByFabricDevice.get(fabricDeviceId);
    if (!binding) fail('OMEGA_V2_VIEW_NOT_ACTIVE', 409);
    audit('FABRIC_OMEGA_V2_INTERACTIVE_REQUESTED', binding, 'explicit_user_action');
    try {
      // Re-read and compare against the binding this VIEW session was
      // created under: an unlink/relink/fingerprint or revocation change
      // since START VIEW must block activation rather than silently control
      // whatever the link now names (mission §7, §24).
      const revalidated = deps.resolveTarget(fabricDeviceId);
      if (!sameBinding(revalidated, binding)) fail('OMEGA_V2_LINK_CHANGED');

      const session = deps.getSession(binding.sessionId);
      if (!session || session.status !== 'CONNECTED') fail('OMEGA_V2_REMOTE_STOPPED');
      if (session.remoteOmegaDeviceId !== revalidated.omegaV2HostId) fail('OMEGA_V2_WRONG_DEVICE');
      if (binding.viewStatus === 'STOPPED') fail('OMEGA_V2_VIEW_NOT_ACTIVE');

      const result = await deps.startInteractive(binding.sessionId, omegaOptions);
      binding.interactiveStatus = result.status ?? 'INTERACTIVE';
      audit('FABRIC_OMEGA_V2_INTERACTIVE_STARTED', binding, 'INTERACTIVE');
      return safeView(binding, session);
    } catch (error) {
      let code = error instanceof DeviceFabricOmegaV2ViewError ? error.code : mappedCode(error);
      // OMEGA's own permission ceiling denial is reported with the specific
      // INTERACTIVE-authorization code the mission's safe-error list names,
      // never the generic connect-time permission code (mission §36, §10:
      // Fabric never infers authorization from the link — only OMEGA's own
      // verdict on THIS session decides).
      if (code === 'OMEGA_V2_PERMISSION_DENIED') code = 'OMEGA_V2_INTERACTIVE_NOT_AUTHORIZED';
      audit('FABRIC_OMEGA_V2_INTERACTIVE_DENIED', binding, code);
      if (error instanceof DeviceFabricOmegaV2ViewError) throw new DeviceFabricOmegaV2ViewError(code, error.status);
      throw new DeviceFabricOmegaV2ViewError(code, code === 'OMEGA_V2_RATE_LIMITED' ? 429 : 409);
    }
  }

  /** Read-only: never connects, never creates a session, never activates control (mission §35). */
  function getInteractiveStateForFabricDevice(fabricDeviceId) {
    const binding = activeByFabricDevice.get(fabricDeviceId);
    if (!binding) {
      let resolved;
      try { resolved = deps.resolveTarget(fabricDeviceId); }
      catch (error) { throw new DeviceFabricOmegaV2ViewError(mappedCode(error), error?.status ?? 409); }
      return { fabricDeviceId, omegaV2HostId: resolved.omegaV2HostId, linkId: resolved.linkId,
        linkVersion: resolved.linkVersion, sessionId: null, sessionStatus: 'DISCONNECTED', sessionReason: null,
        viewStatus: 'STOPPED', streamId: null, screenIndex: null, interactiveStatus: 'STOPPED', linkChanged: false };
    }
    const session = deps.getSession(binding.sessionId);
    let linkChanged = false;
    let linkReason = null;
    try { linkChanged = !sameBinding(binding, deps.resolveTarget(fabricDeviceId)); }
    catch (error) { linkChanged = true; linkReason = mappedCode(error); }
    // OMEGA V2's own INTERACTIVE heartbeat (startOmegaOutboundInteractive's
    // internal 2 s poll) already detects a remote STOP or lease expiry and
    // fails the session closed on OMEGA's side; this read only reflects
    // whatever OMEGA already decided, with 0 side effect of its own.
    if (!session || session.status !== 'CONNECTED') {
      binding.viewStatus = 'STOPPED';
      binding.streamId = null;
      clearInteractive(binding);
    }
    return safeView(binding, session, { linkChanged, linkReason });
  }

  async function stopInteractiveForFabricDevice(fabricDeviceId, omegaOptions = {}) {
    limit(fabricDeviceId, 'interactive-stop', STOPS_PER_MINUTE);
    const binding = activeByFabricDevice.get(fabricDeviceId);
    if (!binding) fail('OMEGA_V2_REMOTE_STOPPED', 404);
    let reason = 'user_stop_interactive';
    try {
      // stopOmegaOutboundInteractive releases held keys/buttons on the host
      // itself; Fabric never performs a release loop of its own (mission §19).
      if (binding.interactiveStatus && binding.interactiveStatus !== 'STOPPED') await deps.stopInteractive(binding.sessionId, omegaOptions);
    } catch (error) {
      const code = mappedCode(error);
      if (!['OMEGA_V2_REMOTE_STOPPED', 'OMEGA_V2_SESSION_EXPIRED', 'OMEGA_V2_VIEW_NOT_ACTIVE'].includes(code)) {
        throw new DeviceFabricOmegaV2ViewError(code);
      }
      reason = code;
    }
    clearInteractive(binding);
    audit('FABRIC_OMEGA_V2_INTERACTIVE_STOPPED', binding, reason);
    return safeView(binding, deps.getSession(binding.sessionId));
  }

  return {
    startViewForFabricDevice, getViewStateForFabricDevice, stopViewForFabricDevice, stopSessionForFabricDevice,
    startInteractiveForFabricDevice, getInteractiveStateForFabricDevice, stopInteractiveForFabricDevice,
  };
}

const service = createFabricOmegaV2ViewService();
export const startViewForFabricDevice = service.startViewForFabricDevice;
export const getViewStateForFabricDevice = service.getViewStateForFabricDevice;
export const stopViewForFabricDevice = service.stopViewForFabricDevice;
export const stopSessionForFabricDevice = service.stopSessionForFabricDevice;
export const startInteractiveForFabricDevice = service.startInteractiveForFabricDevice;
export const getInteractiveStateForFabricDevice = service.getInteractiveStateForFabricDevice;
export const stopInteractiveForFabricDevice = service.stopInteractiveForFabricDevice;
