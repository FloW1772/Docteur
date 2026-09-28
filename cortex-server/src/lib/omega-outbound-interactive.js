import crypto from 'node:crypto';
import * as capture from './omega-capture.js';
import { permissionAllowed } from './omega-outbound-protocol.js';
import { endSession, expireSession, recordAudit } from './omega-outbound-store.js';
import { validateSemanticInput, executeSemanticInput, releaseSemanticInput } from './omega-outbound-input.js';

export const OMEGA_V2_INPUT_LIMITS = Object.freeze({
  pointerPerSecond: 30, buttonPerSecond: 10, wheelPerSecond: 8, keyPerSecond: 20,
  maxQueue: 32, maxOperationIds: 1024, leaseMs: 6_000,
});

export class OmegaOutboundInteractiveError extends Error {
  constructor(code, detail) { super(code); this.name = 'OmegaOutboundInteractiveError'; this.code = code; this.detail = detail; }
}
function fail(code, detail) { throw new OmegaOutboundInteractiveError(code, detail); }
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createOmegaOutboundInteractiveManager({ viewManager, provider = {
  listScreens: capture.listScreens,
  showSessionIndicator: capture.showSessionIndicator,
  executeSemanticInput,
  releaseSemanticInput,
} } = {}) {
  if (!viewManager) throw new Error('omega_view_manager_required');
  const streams = new Map();

  function audit(type, stream, result, detail) {
    recordAudit(type, { sessionId: stream?.sessionId, localDeviceId: stream?.hostDeviceId,
      remoteDeviceId: stream?.controllerDeviceId, result, detail });
  }

  function clearLease(stream) { if (stream.leaseTimer) clearTimeout(stream.leaseTimer); stream.leaseTimer = null; }
  function refreshLease(stream) {
    clearLease(stream);
    stream.leaseUntil = Date.now() + OMEGA_V2_INPUT_LIMITS.leaseMs;
    stream.leaseTimer = setTimeout(() => void stop(stream.sessionId, 'network_timeout', { stopView: true, terminateSession: true }),
      OMEGA_V2_INPUT_LIMITS.leaseMs);
    stream.leaseTimer.unref?.();
  }

  function checkView(sessionId, streamId, screenIndex) {
    const view = viewManager.status(sessionId, streamId);
    if (view.status !== 'VIEWING') fail('VIEW_NOT_ACTIVE');
    if (view.streamId !== streamId) fail('WRONG_STREAM');
    if (view.screenIndex !== screenIndex) fail('WRONG_SCREEN');
    return view;
  }

  function checkRate(stream, category) {
    const now = Date.now();
    const limit = OMEGA_V2_INPUT_LIMITS[`${category}PerSecond`];
    const bucket = stream.rate[category].filter(value => now - value < 1_000);
    stream.rate[category] = bucket;
    if (bucket.length >= limit) {
      audit('OUTBOUND_INPUT_RATE_LIMITED', stream, category);
      fail('RATE_LIMITED');
    }
    bucket.push(now);
  }

  async function runPrepared(stream, prepared) {
    if (!stream.accepting) fail('INTERACTIVE_STOPPED');
    const held = prepared.category === 'key' ? stream.heldKeys : prepared.category === 'button' ? stream.heldButtons : null;
    const identity = prepared.key ?? prepared.button;
    if (held && prepared.state === 'DOWN' && held.has(identity)) fail('DUPLICATE_DOWN');
    if (held && prepared.state === 'UP' && !held.has(identity)) return { requested: 0, sent: 0, idempotent: true };
    const result = await provider.executeSemanticInput(prepared);
    if (result.sent > 0 && held) {
      if (prepared.state === 'DOWN') {
        if (held instanceof Map) held.set(identity, prepared); else held.add(identity);
      } else held.delete(identity);
    }
    stream.eventCounts[prepared.category] += 1;
    return result;
  }

  async function drain(stream) {
    if (stream.draining) return stream.drainPromise;
    stream.draining = true;
    stream.drainPromise = (async () => {
      while (stream.accepting && (stream.queue.length || stream.pendingMove)) {
        const item = stream.queue.shift() ?? { prepared: stream.pendingMove, resolve: null, reject: null };
        if (!stream.queue.length && item.prepared === stream.pendingMove) stream.pendingMove = null;
        // Evaluate before the optional call: coalesced moves have no resolver
        // and `resolve?.(await ...)` would skip executing them entirely.
        try { const result = await runPrepared(stream, item.prepared); item.resolve?.(result); }
        catch (error) { item.reject?.(error); }
      }
    })().finally(() => { stream.draining = false; stream.drainPromise = null; });
    return stream.drainPromise;
  }

  function enqueue(stream, prepared) {
    if (!stream.accepting) fail('INTERACTIVE_STOPPED');
    if (prepared.category === 'pointer' && (stream.draining || stream.queue.length || stream.pendingMove)) {
      stream.pendingMove = prepared;
      void drain(stream);
      return Promise.resolve({ requested: 1, sent: 0, coalesced: true });
    }
    if (stream.queue.length + (stream.pendingMove ? 1 : 0) >= OMEGA_V2_INPUT_LIMITS.maxQueue) fail('QUEUE_FULL');
    // Only moves are coalesced: a pending move must execute before any later
    // button/wheel/key event so DOWN/UP ordering and drag paths are preserved.
    if (stream.pendingMove) {
      stream.queue.push({ prepared: stream.pendingMove, resolve: null, reject: null });
      stream.pendingMove = null;
    }
    return new Promise((resolve, reject) => {
      stream.queue.push({ prepared, resolve, reject });
      void drain(stream);
    });
  }

  async function start(session, { streamId, screenIndex }) {
    audit('OUTBOUND_INTERACTIVE_REQUESTED', { sessionId: session.id, hostDeviceId: session.local_device_id,
      controllerDeviceId: session.remote_device_id }, 'requested');
    if (!permissionAllowed('INTERACTIVE', session.permission)) {
      audit('OUTBOUND_INTERACTIVE_DENIED', { sessionId: session.id, hostDeviceId: session.local_device_id,
        controllerDeviceId: session.remote_device_id }, 'permission_denied');
      fail('PERMISSION_DENIED');
    }
    if (streams.has(session.id)) fail('INTERACTIVE_ALREADY_STARTED');
    if (typeof streamId !== 'string' || !Number.isInteger(screenIndex)) fail('INPUT_INVALID');
    checkView(session.id, streamId, screenIndex);
    const screens = await provider.listScreens();
    if (!screens[screenIndex]) fail('WRONG_SCREEN');
    const state = { sessionId: session.id, controllerDeviceId: session.remote_device_id,
      hostDeviceId: session.local_device_id, interactiveId: crypto.randomUUID(), streamId, screenIndex,
      status: 'INTERACTIVE_STARTING', accepting: false, queue: [], pendingMove: null, draining: false,
      drainPromise: null, heldKeys: new Set(), heldButtons: new Map(), operationIds: new Set(),
      rate: { pointer: [], button: [], wheel: [], key: [] },
      eventCounts: { pointer: 0, button: 0, wheel: 0, key: 0 }, screens,
      startedAt: new Date().toISOString(), leaseTimer: null, expiryTimer: null, leaseUntil: 0 };
    const indicator = await provider.showSessionIndicator('interactive_start', session.id, session.remote_device_id,
      session.expires_at, () => stop(session.id, 'remote_local_stop', { stopView: true, terminateSession: true }))
      .catch(() => ({ ok: false }));
    if (!indicator?.ok) fail('REMOTE_CONSENT_UNAVAILABLE');
    state.status = 'INTERACTIVE'; state.accepting = true; streams.set(session.id, state); refreshLease(state);
    // Session expiry releases held input even when no further request arrives.
    state.expiryTimer = setTimeout(() => void stop(session.id, 'session_expired', { stopView: true })
      .then(() => expireSession(session.id)), Math.max(0, Date.parse(session.expires_at) - Date.now()));
    state.expiryTimer.unref?.();
    audit('OUTBOUND_INTERACTIVE_STARTED', state, 'started', { streamId, screenIndex });
    return status(session.id, streamId);
  }

  function status(sessionId, expectedStreamId) {
    const stream = streams.get(sessionId);
    if (!stream) return { status: 'STOPPED', reason: 'INTERACTIVE_NOT_STARTED' };
    if (stream.streamId !== expectedStreamId) fail('WRONG_STREAM');
    checkView(sessionId, expectedStreamId, stream.screenIndex);
    refreshLease(stream);
    return { status: stream.status, interactiveId: stream.interactiveId, streamId: stream.streamId,
      screenIndex: stream.screenIndex, startedAt: stream.startedAt, leaseUntil: new Date(stream.leaseUntil).toISOString(),
      queueDepth: stream.queue.length + (stream.pendingMove ? 1 : 0), heldKeyCount: stream.heldKeys.size,
      heldButtonCount: stream.heldButtons.size, eventCounts: { ...stream.eventCounts }, limits: OMEGA_V2_INPUT_LIMITS };
  }

  async function input(sessionId, category, payload) {
    if (!['pointer', 'button', 'wheel', 'key'].includes(category)) fail('INPUT_CATEGORY_INVALID');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INPUT_INVALID');
    const stream = streams.get(sessionId);
    if (!stream || !stream.accepting) fail('INTERACTIVE_NOT_STARTED');
    if (payload.streamId !== stream.streamId) fail('WRONG_STREAM');
    if (payload.screenIndex !== stream.screenIndex) fail('WRONG_SCREEN');
    if (!OPERATION_ID.test(payload.operationId ?? '')) fail('OPERATION_ID_INVALID');
    if (stream.operationIds.has(payload.operationId)) fail('OPERATION_REPLAYED');
    stream.operationIds.add(payload.operationId);
    while (stream.operationIds.size > OMEGA_V2_INPUT_LIMITS.maxOperationIds) stream.operationIds.delete(stream.operationIds.values().next().value);
    checkView(sessionId, stream.streamId, stream.screenIndex);
    checkRate(stream, category);
    refreshLease(stream);
    const screens = await provider.listScreens();
    if (!screens[stream.screenIndex]) fail('WRONG_SCREEN');
    let prepared;
    try { prepared = validateSemanticInput(category, payload, { screens, screenIndex: stream.screenIndex }); }
    catch (error) { audit('OUTBOUND_INPUT_INVALID', stream, error.code ?? 'INPUT_INVALID', { category }); throw error; }
    return { operationId: payload.operationId, ...(await enqueue(stream, prepared)) };
  }

  async function stop(sessionId, reason = 'controller_stop', { stopView = false, terminateSession = false } = {}) {
    const stream = streams.get(sessionId);
    if (!stream) return { status: 'STOPPED', stopped: false, reason };
    streams.delete(sessionId); stream.status = 'INTERACTIVE_STOPPING'; stream.accepting = false; clearLease(stream);
    if (stream.expiryTimer) clearTimeout(stream.expiryTimer);
    stream.pendingMove = null;
    for (const item of stream.queue.splice(0)) item.reject?.(new OmegaOutboundInteractiveError('INTERACTIVE_STOPPED'));
    await stream.drainPromise?.catch(() => {});
    const screens = await provider.listScreens().catch(() => stream.screens);
    for (const key of [...stream.heldKeys]) await provider.releaseSemanticInput('key', key, screens, stream.screenIndex).catch(() => {});
    for (const [button, prepared] of [...stream.heldButtons]) await provider.releaseSemanticInput('button', button, screens, stream.screenIndex, prepared).catch(() => {});
    stream.heldKeys.clear(); stream.heldButtons.clear();
    await provider.showSessionIndicator('interactive_stop', sessionId, stream.controllerDeviceId).catch(() => {});
    if (stopView) await viewManager.stop(sessionId, reason, stream.streamId).catch(() => {});
    if (terminateSession) endSession(sessionId, reason);
    stream.status = 'STOPPED';
    audit(reason === 'remote_local_stop' ? 'OUTBOUND_REMOTE_STOP' : 'OUTBOUND_INTERACTIVE_STOPPED', stream, reason,
      { counts: stream.eventCounts });
    return { status: 'STOPPED', stopped: true, reason, released: true };
  }

  async function stopForController(controllerDeviceId, reason) {
    const targets = [...streams.values()].filter(stream => stream.controllerDeviceId === controllerDeviceId);
    await Promise.allSettled(targets.map(stream => stop(stream.sessionId, reason, { stopView: true, terminateSession: true })));
    return targets.length;
  }

  function onViewStopped(sessionId, reason) {
    if (streams.has(sessionId)) void stop(sessionId, `view_${reason}`, { stopView: false, terminateSession: false });
  }

  return { start, status, input, stop, stopForController, onViewStopped, _streams: streams };
}
