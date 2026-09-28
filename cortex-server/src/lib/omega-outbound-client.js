import crypto from 'node:crypto';
import {
  ensureOmegaV2Identity, signWithOmegaV2Identity,
} from './omega-outbound-identity.js';
import {
  getOutboundTrust, listOutboundTrust, upsertOutboundTrust, revokeOutboundTrust,
  insertSession, getSession, listSessions, endSession, recordAudit,
} from './omega-outbound-store.js';
import {
  identityFingerprint, normalizeFingerprint, permissionAllowed, validPermission, randomNonce,
  requestFields, responseFields, viewFrameFields, verifyMessage, timestampFresh,
} from './omega-outbound-protocol.js';
import { assertOmegaPrivateDestination, tlsBinaryRequest, tlsJsonRequest } from './omega-outbound-network.js';
import { inspectPng, OMEGA_V2_VIEW_LIMITS } from './omega-outbound-view.js';
import {
  OMEGA_V2_ADMIN_STATUSES, OMEGA_V2_ADMIN_TERMINAL_STATUSES, OMEGA_V2_ADMIN_OUTCOME_CODES,
  validateAdminResult, validAdminAction, isHighImpactAdminAction,
} from './omega-outbound-admin.js';

const active = new Map();
const connectAttempts = new Map();
const MAX_CONNECTS_PER_MINUTE = 10;

function removeActive(sessionId) {
  const state = active.get(sessionId);
  if (state?.monitor) clearInterval(state.monitor);
  if (state?.interactiveMonitor) clearInterval(state.interactiveMonitor);
  for (const op of state?.admin?.operations.values() ?? []) if (op.monitor) clearInterval(op.monitor);
  active.delete(sessionId);
}

function startSignedStatusMonitor(sessionId, state, options) {
  state.monitor = setInterval(() => {
    refreshOmegaOutboundSession(sessionId, options).catch(() => {
      // refreshOmegaOutboundSession/signedSessionRequest already performs the
      // fail-closed transition and cleanup. Never reconnect or retry here.
    });
  }, 5_000);
  state.monitor.unref?.();
}

function safeSession(row, state) {
  if (!row) return null;
  return { sessionId: row.id, localOmegaDeviceId: row.local_device_id,
    remoteOmegaDeviceId: row.remote_device_id, permission: row.permission,
    createdAt: row.created_at, expiresAt: row.expires_at,
    status: state?.status ?? row.status, reason: row.reason ?? null };
}

function rateLimit(remoteDeviceId) {
  const now = Date.now();
  const values = (connectAttempts.get(remoteDeviceId) ?? []).filter(value => now - value < 60_000);
  if (values.length >= MAX_CONNECTS_PER_MINUTE) throw Object.assign(new Error('RATE_LIMITED'), { code: 'RATE_LIMITED' });
  values.push(now);
  connectAttempts.set(remoteDeviceId, values);
}

function validateHostRegistration(input) {
  if (!/^ov2h-[0-9a-f-]{36}$/.test(input.remoteDeviceId ?? '')) throw new Error('remote_device_id_invalid');
  if (!validPermission(input.maxPermission)) throw new Error('permission_invalid');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('port_invalid');
  const cert = new crypto.X509Certificate(input.certificatePem);
  if (normalizeFingerprint(cert.fingerprint256) !== normalizeFingerprint(input.certificateFingerprint)) throw new Error('certificate_fingerprint_mismatch');
  if (identityFingerprint(input.publicKeyPem) !== normalizeFingerprint(input.identityFingerprint)) throw new Error('identity_fingerprint_mismatch');
}

export function registerOmegaOutboundHost(input) {
  validateHostRegistration(input);
  return upsertOutboundTrust({ ...input, identityFingerprint: normalizeFingerprint(input.identityFingerprint),
    certificateFingerprint: normalizeFingerprint(input.certificateFingerprint), createdAt: new Date().toISOString() });
}

export function listOmegaOutboundHosts() {
  return listOutboundTrust().map(row => ({ remoteDeviceId: row.remote_device_id, host: row.host, port: row.port,
    certificateFingerprint: row.certificate_fingerprint, identityFingerprint: row.identity_fingerprint,
    maxPermission: row.max_permission, createdAt: row.created_at, revokedAt: row.revoked_at }));
}

export function revokeOmegaOutboundHost(remoteDeviceId) {
  const changed = revokeOutboundTrust(remoteDeviceId);
  for (const [id, state] of active) if (state.remoteDeviceId === remoteDeviceId) {
    state.status = 'ERROR';
    for (const request of state.pending) request.destroy();
    state.pending.clear();
    removeActive(id);
  }
  return changed;
}

function clientError(error, fallback = 'NETWORK_UNAVAILABLE') {
  const code = error?.code || error?.message || fallback;
  if (/CERT|TLS|fingerprint|hostname|altname/i.test(code)) return 'TLS_IDENTITY_MISMATCH';
  if (['RATE_LIMITED', 'PERMISSION_DENIED', 'DEVICE_REVOKED', 'DEVICE_UNTRUSTED', 'SESSION_EXPIRED', 'REMOTE_STOPPED'].includes(code)) return code;
  return fallback;
}

async function requestPeer(peer, requestPath, body, state, options, auditTls = false, transport = {}) {
  return tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
    expectedFingerprint: peer.certificate_fingerprint, requestPath, body,
    timeoutMs: transport.timeoutMs ?? options.timeoutMs ?? 10_000, maxResponseBytes: transport.maxResponseBytes,
    onRequest: request => { state?.pending.add(request); request.once('close', () => state?.pending.delete(request)); },
    onTls: auditTls ? () => recordAudit('OUTBOUND_TLS_ESTABLISHED', { remoteDeviceId: peer.remote_device_id, result: 'established' }) : undefined,
  });
}

export async function connectOmegaDevice(remoteDeviceId, permission, options = {}) {
  rateLimit(remoteDeviceId);
  if (!validPermission(permission)) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  const peer = getOutboundTrust(remoteDeviceId);
  if (!peer || peer.revoked_at) throw Object.assign(new Error('DEVICE_UNTRUSTED'), { code: 'DEVICE_UNTRUSTED' });
  if (!permissionAllowed(permission, peer.max_permission)) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  await assertOmegaPrivateDestination(peer.host, options);
  const identity = ensureOmegaV2Identity('CONTROLLER');
  const state = { status: 'CONNECTING', remoteDeviceId, pending: new Set() };
  recordAudit('OUTBOUND_CONNECT_REQUESTED', { localDeviceId: identity.deviceId, remoteDeviceId, result: 'requested' });
  const clientNonce = randomNonce();
  try {
    const challengeResult = await requestPeer(peer, '/api/omega-v2/challenge', {
      expectedRemoteDeviceId: remoteDeviceId, localDeviceId: identity.deviceId, clientNonce,
    }, state, options, true);
    if (challengeResult.status !== 200) throw Object.assign(new Error(challengeResult.body?.error ?? 'DEVICE_UNTRUSTED'), { code: challengeResult.body?.error });
    state.status = 'AUTHENTICATING';
    const challenge = challengeResult.body;
    const challengeFields = { hostDeviceId: challenge.hostDeviceId, clientDeviceId: identity.deviceId,
      challengeId: challenge.challengeId, serverNonce: challenge.serverNonce, clientNonce,
      issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
      certificateFingerprint: normalizeFingerprint(challenge.certificateFingerprint) };
    if (challenge.hostDeviceId !== remoteDeviceId
      || normalizeFingerprint(challenge.certificateFingerprint) !== normalizeFingerprint(peer.certificate_fingerprint)
      || !verifyMessage(peer.public_key_pem, challenge.signature, 'OMEGA-V2/HOST/CHALLENGE', challengeFields)) {
      throw Object.assign(new Error('TLS_IDENTITY_MISMATCH'), { code: 'TLS_IDENTITY_MISMATCH' });
    }
    const authFields = { ...challengeFields, requestedPermission: permission };
    const authSignature = signWithOmegaV2Identity('CONTROLLER', identity.deviceId, 'OMEGA-V2/CONTROLLER/AUTH', authFields);
    const sessionResult = await requestPeer(peer, '/api/omega-v2/sessions', {
      ...authFields, controllerPublicKeyFingerprint: identity.fingerprint, signature: authSignature,
    }, state, options);
    if (sessionResult.status !== 201) throw Object.assign(new Error(sessionResult.body?.error ?? 'AUTH_FAILURE'), { code: sessionResult.body?.error });
    const payload = sessionResult.body.payload;
    const signedFields = { sessionId: payload.sessionId, localDeviceId: identity.deviceId,
      remoteDeviceId, permission: payload.permission, createdAt: payload.createdAt, expiresAt: payload.expiresAt };
    if (payload.remoteDeviceId !== remoteDeviceId || payload.localDeviceId !== identity.deviceId
      || payload.permission !== permission
      || !verifyMessage(peer.public_key_pem, sessionResult.body.signature, 'OMEGA-V2/HOST/SESSION', signedFields)) {
      throw Object.assign(new Error('wrong_device_response'), { code: 'TLS_IDENTITY_MISMATCH' });
    }
    insertSession({ ...signedFields, direction: 'OUTBOUND', status: 'CONNECTED' });
    state.status = 'CONNECTED';
    active.set(payload.sessionId, state);
    startSignedStatusMonitor(payload.sessionId, state, options);
    recordAudit('OUTBOUND_AUTHENTICATED', { localDeviceId: identity.deviceId, remoteDeviceId, sessionId: payload.sessionId, result: 'authenticated' });
    recordAudit('OUTBOUND_SESSION_CREATED', { localDeviceId: identity.deviceId, remoteDeviceId, sessionId: payload.sessionId, result: 'created', detail: { permission } });
    return safeSession(getSession(payload.sessionId), state);
  } catch (error) {
    for (const request of state.pending) request.destroy();
    const code = clientError(error);
    recordAudit(code === 'TLS_IDENTITY_MISMATCH' ? 'OUTBOUND_TLS_FAILURE' : 'OUTBOUND_AUTH_FAILURE', {
      localDeviceId: identity.deviceId, remoteDeviceId, result: code,
    });
    throw Object.assign(new Error(code), { code });
  }
}

async function signedSessionRequest(sessionId, action, options = {}, payload = {}, transport = {}) {
  const row = getSession(sessionId);
  const state = active.get(sessionId);
  if (!row || row.direction !== 'OUTBOUND') throw Object.assign(new Error('SESSION_NOT_FOUND'), { code: 'SESSION_NOT_FOUND' });
  if (!state || row.ended_at) throw Object.assign(new Error('SESSION_EXPIRED'), { code: 'SESSION_EXPIRED' });
  if (Date.parse(row.expires_at) <= Date.now()) {
    endSession(sessionId, 'session_expired'); removeActive(sessionId);
    recordAudit('OUTBOUND_SESSION_EXPIRED', { sessionId, localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id, result: 'expired' });
    throw Object.assign(new Error('SESSION_EXPIRED'), { code: 'SESSION_EXPIRED' });
  }
  const peer = getOutboundTrust(row.remote_device_id);
  if (!peer || peer.revoked_at) throw Object.assign(new Error('DEVICE_REVOKED'), { code: 'DEVICE_REVOKED' });
  const bodyBytes = Buffer.from(JSON.stringify(payload));
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = randomNonce();
  const requestPath = `/api/omega-v2/sessions/${sessionId}/${action}`;
  const fields = requestFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId, requestId, timestamp, nonce, method: 'POST', path: requestPath, bodyBytes });
  const signature = signWithOmegaV2Identity('CONTROLLER', row.local_device_id, 'OMEGA-V2/CONTROLLER/REQUEST', fields);
  let result;
  try {
    result = await requestPeer(peer, requestPath, { payload, auth: { ...fields, signature } }, state, options, false, transport);
  } catch (error) {
    for (const request of state.pending) request.destroy();
    endSession(sessionId, 'network_drop');
    removeActive(sessionId);
    throw Object.assign(new Error('NETWORK_UNAVAILABLE'), { code: 'NETWORK_UNAVAILABLE', cause: error });
  }
  const responsePayload = result.body?.payload ?? {};
  const responseAuth = result.body?.auth;
  const expectedResponse = responseFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId, requestId, timestamp: responseAuth?.timestamp, statusCode: result.status,
    bodyBytes: Buffer.from(JSON.stringify(responsePayload)) });
  if (!responseAuth || !timestampFresh(responseAuth.timestamp)
    || !verifyMessage(peer.public_key_pem, responseAuth.signature, 'OMEGA-V2/HOST/RESPONSE', expectedResponse)) {
    throw Object.assign(new Error('INVALID_RESPONSE'), { code: 'INVALID_RESPONSE' });
  }
  if (result.status >= 400) {
    const reason = responsePayload.error ?? 'REMOTE_STOPPED';
    if ((action.startsWith('view/') || action.startsWith('interactive/') || action.startsWith('input/'))
      && ['VIEW_ALREADY_STARTED', 'SCREEN_INDEX_INVALID', 'FRAME_INVALID', 'FRAME_TOO_LARGE', 'RATE_LIMITED',
        'VIEW_NOT_STARTED', 'VIEW_NOT_ACTIVE', 'WRONG_STREAM', 'WRONG_SCREEN', 'PERMISSION_DENIED',
        'INTERACTIVE_ALREADY_STARTED', 'INTERACTIVE_NOT_STARTED', 'INTERACTIVE_STOPPED', 'INPUT_INVALID',
        'INPUT_CATEGORY_INVALID', 'POINTER_OUT_OF_BOUNDS', 'BUTTON_INVALID', 'WHEEL_DELTA_INVALID',
        'KEY_INVALID', 'OPERATION_ID_INVALID', 'OPERATION_REPLAYED', 'DUPLICATE_DOWN', 'QUEUE_FULL'].includes(reason)) {
      throw Object.assign(new Error(reason), { code: reason });
    }
    if (action.startsWith('admin/') && ADMIN_NON_TERMINAL_ERRORS.has(reason)) throw Object.assign(new Error(reason), { code: reason });
    endSession(sessionId, reason); removeActive(sessionId);
    throw Object.assign(new Error(reason), { code: reason });
  }
  return responsePayload;
}

function requireViewSession(sessionId) {
  const row = getSession(sessionId);
  const state = active.get(sessionId);
  if (!row || row.direction !== 'OUTBOUND' || !state) throw Object.assign(new Error('SESSION_EXPIRED'), { code: 'SESSION_EXPIRED' });
  if (!permissionAllowed('VIEW', row.permission)) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  return { row, state };
}

export async function startOmegaOutboundView(sessionId, screenIndex, options = {}) {
  if (!Number.isInteger(screenIndex) || screenIndex < 0) throw Object.assign(new Error('SCREEN_INDEX_INVALID'), { code: 'SCREEN_INDEX_INVALID' });
  requireViewSession(sessionId);
  const payload = await signedSessionRequest(sessionId, 'view/start', options, { screenIndex });
  active.get(sessionId).view = { streamId: payload.streamId, status: payload.status, screenIndex: payload.screenIndex,
    inFlight: false, lastSequence: 0, recentFrameIds: new Set() };
  return payload;
}

export async function getOmegaOutboundViewStatus(sessionId, options = {}) {
  const { state } = requireViewSession(sessionId);
  if (!state.view?.streamId) return { status: 'STOPPED', reason: 'VIEW_NOT_STARTED' };
  const payload = await signedSessionRequest(sessionId, 'view/status', options, { streamId: state.view.streamId });
  if (payload.status === 'STOPPED') state.view = null;
  else if (state.view) state.view = { ...state.view, ...payload };
  return payload;
}

export function validateOmegaOutboundFrame({ row, stateView, peerPublicKeyPem, requestId, result }) {
  const headers = result.headers;
  const frameId = headers['x-omega-frame-id'];
  const streamId = headers['x-omega-stream-id'];
  const frameTimestamp = headers['x-omega-frame-timestamp'];
  const remoteDeviceId = headers['x-omega-remote-device-id'];
  const responseSessionId = headers['x-omega-session-id'];
  const frameFields = viewFrameFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId: row.id, requestId, streamId, frameId, sequence: Number(headers['x-omega-frame-sequence']),
    timestamp: frameTimestamp, mimeType: headers['content-type'], width: Number(headers['x-omega-frame-width']),
    height: Number(headers['x-omega-frame-height']), screenIndex: Number(headers['x-omega-screen-index']), bodyBytes: result.body });
  const responseAuthFields = responseFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId: row.id, requestId, timestamp: headers['x-omega-response-timestamp'], statusCode: result.status, bodyBytes: result.body });
  const responseValid = timestampFresh(headers['x-omega-response-timestamp'])
    && verifyMessage(peerPublicKeyPem, headers['x-omega-response-signature'], 'OMEGA-V2/HOST/RESPONSE', responseAuthFields);
  const frameValid = verifyMessage(peerPublicKeyPem, headers['x-omega-frame-signature'], 'OMEGA-V2/HOST/VIEW_FRAME', frameFields);
  let png;
  try { png = inspectPng(result.body); } catch { png = null; }
  const validShape = headers['content-type'] === OMEGA_V2_VIEW_LIMITS.mimeType
    && result.body.length <= OMEGA_V2_VIEW_LIMITS.maxFrameBytes
    && png?.width === frameFields.width && png?.height === frameFields.height
    && frameFields.width <= OMEGA_V2_VIEW_LIMITS.maxDimension && frameFields.height <= OMEGA_V2_VIEW_LIMITS.maxDimension;
  const freshFrame = timestampFresh(frameTimestamp);
  const newSequence = Number.isInteger(frameFields.sequence) && frameFields.sequence > stateView.lastSequence;
  const newFrameId = /^[0-9a-f-]{36}$/.test(frameId ?? '') && !stateView.recentFrameIds.has(frameId);
  if (!responseValid || !frameValid || !validShape || !freshFrame || !newSequence || !newFrameId
    || streamId !== stateView.streamId || remoteDeviceId !== row.remote_device_id || responseSessionId !== row.id) {
    throw Object.assign(new Error('INVALID_FRAME'), { code: 'INVALID_FRAME', detail: {
      responseValid, frameValid, validShape, freshFrame, newSequence, newFrameId,
      streamMatch: streamId === stateView.streamId, deviceMatch: remoteDeviceId === row.remote_device_id,
      sessionMatch: responseSessionId === row.id,
    } });
  }
  return { frameId, streamId, frameTimestamp, frameFields };
}

export async function fetchOmegaOutboundViewFrame(sessionId, options = {}) {
  const { row, state } = requireViewSession(sessionId);
  if (!state.view?.streamId) throw Object.assign(new Error('VIEW_NOT_STARTED'), { code: 'VIEW_NOT_STARTED' });
  if (state.view.inFlight) throw Object.assign(new Error('RATE_LIMITED'), { code: 'RATE_LIMITED' });
  const stateView = state.view;
  stateView.inFlight = true;
  const peer = getOutboundTrust(row.remote_device_id);
  const payload = { streamId: stateView.streamId };
  const bodyBytes = Buffer.from(JSON.stringify(payload));
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = randomNonce();
  const requestPath = `/api/omega-v2/sessions/${sessionId}/view/frame`;
  const fields = requestFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId, requestId, timestamp, nonce, method: 'POST', path: requestPath, bodyBytes });
  const signature = signWithOmegaV2Identity('CONTROLLER', row.local_device_id, 'OMEGA-V2/CONTROLLER/REQUEST', fields);
  let result;
  try {
    result = await tlsBinaryRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
      expectedFingerprint: peer.certificate_fingerprint, requestPath,
      body: { payload, auth: { ...fields, signature } }, maxResponseBytes: 8 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 10_000,
      onRequest: request => { state.pending.add(request); request.once('close', () => state.pending.delete(request)); } });
  } catch (error) {
    endSession(sessionId, 'network_drop'); removeActive(sessionId);
    throw Object.assign(new Error('NETWORK_UNAVAILABLE'), { code: 'NETWORK_UNAVAILABLE', cause: error });
  } finally {
    stateView.inFlight = false;
  }
  if (result.status >= 400) {
    let envelope;
    try { envelope = JSON.parse(result.body.toString('utf8')); } catch { /* rejected below */ }
    const error = envelope?.payload?.error ?? 'INVALID_RESPONSE';
    const errorFields = responseFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
      sessionId, requestId, timestamp: envelope?.auth?.timestamp, statusCode: result.status,
      bodyBytes: Buffer.from(JSON.stringify(envelope?.payload ?? {})) });
    if (!envelope?.auth || !timestampFresh(envelope.auth.timestamp)
      || !verifyMessage(peer.public_key_pem, envelope.auth.signature, 'OMEGA-V2/HOST/RESPONSE', errorFields)) {
      throw Object.assign(new Error('INVALID_RESPONSE'), { code: 'INVALID_RESPONSE' });
    }
    const viewOnlyError = envelope?.payload?.type === 'VIEW_STATUS'
      && ['REMOTE_STOPPED', 'VIEW_NOT_STARTED', 'WRONG_STREAM', 'STREAM_EXPIRED', 'RATE_LIMITED',
        'FRAME_INVALID', 'FRAME_TOO_LARGE'].includes(error);
    if (viewOnlyError) {
      if (error !== 'RATE_LIMITED') state.view = null;
    } else {
      endSession(sessionId, error); removeActive(sessionId);
    }
    throw Object.assign(new Error(error), { code: error });
  }
  const { frameId, streamId, frameTimestamp, frameFields } = validateOmegaOutboundFrame({ row,
    stateView, peerPublicKeyPem: peer.public_key_pem, requestId, result });
  if (active.get(sessionId) !== state || state.view !== stateView) {
    result.body.fill(0);
    throw Object.assign(new Error('REMOTE_STOPPED'), { code: 'REMOTE_STOPPED' });
  }
  stateView.recentFrameIds.add(frameId);
  while (stateView.recentFrameIds.size > 1_200) stateView.recentFrameIds.delete(stateView.recentFrameIds.values().next().value);
  state.view = { ...stateView, status: 'VIEWING', lastFrameAt: frameTimestamp,
    sequence: frameFields.sequence, lastSequence: frameFields.sequence };
  return { buffer: result.body, mimeType: result.headers['content-type'], width: frameFields.width,
    height: frameFields.height, streamId, frameId, sequence: frameFields.sequence, timestamp: frameTimestamp,
    screenIndex: frameFields.screenIndex };
}

export async function stopOmegaOutboundView(sessionId, options = {}) {
  const { state } = requireViewSession(sessionId);
  if (!state.view?.streamId) throw Object.assign(new Error('VIEW_NOT_STARTED'), { code: 'VIEW_NOT_STARTED' });
  if (state.interactive) await stopOmegaOutboundInteractive(sessionId, options).catch(() => { state.interactive = null; });
  const payload = { streamId: state.view.streamId };
  try { await signedSessionRequest(sessionId, 'view/stop', options, payload); } finally { state.view = null; }
  return { status: 'STOPPED' };
}

function requireInteractiveSession(sessionId) {
  const { row, state } = requireViewSession(sessionId);
  if (!permissionAllowed('INTERACTIVE', row.permission)) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  if (!state.view?.streamId || state.view.status !== 'VIEWING') throw Object.assign(new Error('VIEW_NOT_ACTIVE'), { code: 'VIEW_NOT_ACTIVE' });
  return { row, state };
}

function startInteractiveHeartbeat(sessionId, state, options) {
  if (state.interactiveMonitor) clearInterval(state.interactiveMonitor);
  state.interactiveMonitor = setInterval(() => {
    if (state.interactiveHeartbeatPending) return;
    state.interactiveHeartbeatPending = true;
    getOmegaOutboundInteractiveStatus(sessionId, options).catch(() => {}).finally(() => { state.interactiveHeartbeatPending = false; });
  }, 2_000);
  state.interactiveMonitor.unref?.();
}

export async function startOmegaOutboundInteractive(sessionId, options = {}) {
  const { row, state } = requireInteractiveSession(sessionId);
  if (state.interactive) throw Object.assign(new Error('INTERACTIVE_ALREADY_STARTED'), { code: 'INTERACTIVE_ALREADY_STARTED' });
  const payload = await signedSessionRequest(sessionId, 'interactive/start', options,
    { streamId: state.view.streamId, screenIndex: state.view.screenIndex });
  state.interactive = { interactiveId: payload.interactiveId, status: payload.status,
    streamId: payload.streamId, screenIndex: payload.screenIndex };
  startInteractiveHeartbeat(sessionId, state, options);
  recordAudit('OUTBOUND_INTERACTIVE_STARTED', { sessionId, localDeviceId: row.local_device_id,
    remoteDeviceId: row.remote_device_id, result: 'started' });
  return payload;
}

export async function getOmegaOutboundInteractiveStatus(sessionId, options = {}) {
  const { state } = requireInteractiveSession(sessionId);
  if (!state.interactive) return { status: 'STOPPED', reason: 'INTERACTIVE_NOT_STARTED' };
  const payload = await signedSessionRequest(sessionId, 'interactive/status', options,
    { streamId: state.interactive.streamId });
  if (payload.status === 'STOPPED') {
    state.interactive = null;
    if (state.interactiveMonitor) clearInterval(state.interactiveMonitor);
    state.interactiveMonitor = null;
  } else state.interactive = { ...state.interactive, ...payload };
  return payload;
}

export async function sendOmegaOutboundInput(sessionId, category, input, options = {}) {
  const { state } = requireInteractiveSession(sessionId);
  if (!state.interactive || state.interactive.status !== 'INTERACTIVE') throw Object.assign(new Error('INTERACTIVE_NOT_STARTED'), { code: 'INTERACTIVE_NOT_STARTED' });
  const payload = { ...input, operationId: crypto.randomUUID(), streamId: state.interactive.streamId,
    screenIndex: state.interactive.screenIndex };
  return signedSessionRequest(sessionId, `input/${category}`, options, payload);
}

export async function stopOmegaOutboundInteractive(sessionId, options = {}) {
  const { state } = requireViewSession(sessionId);
  if (!state.interactive) return { status: 'STOPPED', stopped: false };
  const payload = { streamId: state.interactive.streamId };
  try { return await signedSessionRequest(sessionId, 'interactive/stop', options, payload); }
  finally {
    state.interactive = null;
    if (state.interactiveMonitor) clearInterval(state.interactiveMonitor);
    state.interactiveMonitor = null;
  }
}

export async function refreshOmegaOutboundSession(sessionId, options = {}) {
  const payload = await signedSessionRequest(sessionId, 'status', options);
  if (payload.status !== 'CONNECTED') {
    endSession(sessionId, payload.reason ?? 'REMOTE_STOPPED'); removeActive(sessionId);
  }
  return safeSession(getSession(sessionId), active.get(sessionId));
}

export async function stopOmegaOutboundSession(sessionId, options = {}) {
  const row = getSession(sessionId);
  if (!row) return false;
  const state = active.get(sessionId);
  if (state) state.status = 'STOPPING';
  for (const op of state?.admin?.operations.values() ?? []) {
    if (!OMEGA_V2_ADMIN_TERMINAL_STATUSES.includes(op.status)) {
      op.status = 'CANCELLED'; op.error = 'CONTROLLER_STOP'; auditAdminTerminal(row, op);
    }
  }
  try { if (state) await signedSessionRequest(sessionId, 'stop', options); } catch { /* local STOP remains authoritative */ }
  for (const request of state?.pending ?? []) request.destroy();
  endSession(sessionId, 'client_stop'); removeActive(sessionId);
  recordAudit('OUTBOUND_SESSION_STOPPED', { sessionId, localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id, result: 'client_stop' });
  return true;
}

export async function stopAllOmegaOutboundSessions(options = {}) {
  const ids = [...active.keys()];
  await Promise.allSettled(ids.map(id => stopOmegaOutboundSession(id, options)));
  return ids.length;
}

export function getOmegaOutboundSession(sessionId) { return safeSession(getSession(sessionId), active.get(sessionId)); }
export function listOmegaOutboundSessions() { return listSessions('OUTBOUND').map(row => safeSession(row, active.get(row.id))); }
export function getOmegaOutboundIdentity() { return ensureOmegaV2Identity('CONTROLLER'); }

// ---------------------------------------------------------------------------
// OMEGA V2 ADMIN (controller side). Typed functions over the closed enum only:
// no generic executor, no raw payload, no approval capability. The host alone
// decides, after local approval on the host for high-impact actions.
// ---------------------------------------------------------------------------
const ADMIN_NON_TERMINAL_ERRORS = new Set(['PERMISSION_DENIED', 'RATE_LIMITED', 'ADMIN_ACTION_INVALID',
  'ADMIN_PAYLOAD_INVALID', 'OPERATION_ID_INVALID', 'OPERATION_DUPLICATE', 'OPERATION_NOT_FOUND',
  'ADMIN_HIGH_IMPACT_PENDING', 'REMOTE_CONSENT_UNAVAILABLE', 'ADMIN_REJECTED']);
export const OMEGA_V2_ADMIN_CLIENT_LIMITS = Object.freeze({
  readPerMinute: 30, highImpactPerMinute: 4, statusPerMinute: 120, maxOperations: 64,
  monitorIntervalMs: 2_000, requestTimeoutMs: 15_000, maxResponseBytes: 160 * 1024, pendingGraceMs: 15_000,
});
const ADMIN_TERMINAL_AUDIT = Object.freeze({ EXECUTED: 'OUTBOUND_ADMIN_EXECUTED', FAILED: 'OUTBOUND_ADMIN_FAILED',
  DENIED: 'OUTBOUND_ADMIN_DENIED', EXPIRED: 'OUTBOUND_ADMIN_DENIED', CANCELLED: 'OUTBOUND_ADMIN_CANCELLED' });
const ADMIN_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function adminError(code) { return Object.assign(new Error(code), { code }); }
function adminTerminal(status) { return OMEGA_V2_ADMIN_TERMINAL_STATUSES.includes(status); }

function auditAdminTerminal(row, op) {
  if (!row || op.audited || !ADMIN_TERMINAL_AUDIT[op.status]) return;
  op.audited = true;
  recordAudit(ADMIN_TERMINAL_AUDIT[op.status], { sessionId: row.id, localDeviceId: row.local_device_id,
    remoteDeviceId: row.remote_device_id, result: op.error ?? op.status.toLowerCase(),
    detail: { operationId: op.operationId, actionType: op.actionType, status: op.status } });
}

function requireAdminSession(sessionId) {
  const row = getSession(sessionId);
  const state = active.get(sessionId);
  if (!row || row.direction !== 'OUTBOUND' || !state || row.ended_at || state.status === 'STOPPING') throw adminError('SESSION_EXPIRED');
  if (Date.parse(row.expires_at) <= Date.now()) {
    endSession(sessionId, 'session_expired'); removeActive(sessionId);
    throw adminError('SESSION_EXPIRED');
  }
  // Exact permission: VIEW and INTERACTIVE sessions never reach the network for ADMIN.
  if (row.permission !== 'ADMIN') {
    recordAudit('OUTBOUND_ADMIN_DENIED', { sessionId, localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
      result: 'PERMISSION_DENIED', detail: { permission: row.permission } });
    throw adminError('PERMISSION_DENIED');
  }
  state.admin ??= { operations: new Map(), rate: { read: [], high: [], status: [] } };
  return { row, state };
}

function adminRate(list, maximum) {
  const now = Date.now();
  while (list.length && now - list[0] >= 60_000) list.shift();
  if (list.length >= maximum) throw adminError('RATE_LIMITED');
  list.push(now);
}

/** Result binding: the host-signed payload must name this exact session, both devices, operation and action. */
export function verifyOmegaOutboundAdminPayload({ row, operationId, actionType, payload }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !['ADMIN_RESULT', 'ADMIN_STATUS'].includes(payload.type)
    || payload.sessionId !== row.id || payload.controllerDeviceId !== row.local_device_id
    || payload.hostDeviceId !== row.remote_device_id || payload.operationId !== operationId
    || payload.actionType !== actionType || !OMEGA_V2_ADMIN_STATUSES.includes(payload.status)
    || (payload.type === 'ADMIN_RESULT') !== adminTerminal(payload.status)) {
    throw adminError('ADMIN_RESULT_MISMATCH');
  }
  if (payload.error !== undefined && !OMEGA_V2_ADMIN_OUTCOME_CODES.includes(payload.error)) throw adminError('ADMIN_RESULT_INVALID');
  if (payload.status === 'EXECUTED' ? !validateAdminResult(actionType, payload.result) : payload.result !== undefined) {
    throw adminError('ADMIN_RESULT_INVALID');
  }
  return { status: payload.status, error: payload.error ?? null,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : null,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
    ...(payload.status === 'EXECUTED' ? { result: payload.result } : {}) };
}

function publicAdminOperation(op) {
  return { operationId: op.operationId, actionType: op.actionType, status: op.status, createdAt: op.createdAt,
    expiresAt: op.expiresAt, error: op.error, ...(op.result ? { result: op.result } : {}) };
}

function createAdminOperation(row, state, actionType, kind) {
  for (const [id, op] of state.admin.operations) if (adminTerminal(op.status)) state.admin.operations.delete(id);
  if (state.admin.operations.size >= OMEGA_V2_ADMIN_CLIENT_LIMITS.maxOperations) throw adminError('RATE_LIMITED');
  const op = { operationId: crypto.randomUUID(), actionType, kind, status: 'REQUESTING', createdAt: null,
    expiresAt: null, error: null, result: null, monitor: null, polling: false, audited: false };
  state.admin.operations.set(op.operationId, op);
  recordAudit('OUTBOUND_ADMIN_REQUESTED', { sessionId: row.id, localDeviceId: row.local_device_id,
    remoteDeviceId: row.remote_device_id, result: kind === 'HIGH_IMPACT' ? 'high_impact' : 'read_only',
    detail: { operationId: op.operationId, actionType } });
  return op;
}

async function adminOperationRequest(sessionId, op, message, options) {
  const { row } = requireAdminSession(sessionId);
  const payload = message === 'request' ? { operationId: op.operationId, actionType: op.actionType } : { operationId: op.operationId };
  const response = await signedSessionRequest(sessionId, `admin/${message}`, options, payload, {
    timeoutMs: OMEGA_V2_ADMIN_CLIENT_LIMITS.requestTimeoutMs, maxResponseBytes: OMEGA_V2_ADMIN_CLIENT_LIMITS.maxResponseBytes });
  const verified = verifyOmegaOutboundAdminPayload({ row, operationId: op.operationId, actionType: op.actionType, payload: response });
  Object.assign(op, verified);
  if (adminTerminal(op.status)) {
    if (op.monitor) clearInterval(op.monitor);
    op.monitor = null;
    auditAdminTerminal(row, op);
  }
  return publicAdminOperation(op);
}

function monitorAdminOperation(sessionId, op, options) {
  const row = getSession(sessionId);
  op.monitor = setInterval(() => {
    if (op.polling || adminTerminal(op.status)) return;
    // Bounded wait: never an indefinitely pending ADMIN operation.
    if (Date.parse(op.expiresAt ?? '') + OMEGA_V2_ADMIN_CLIENT_LIMITS.pendingGraceMs < Date.now()) {
      op.status = op.status === 'EXECUTING' ? 'FAILED' : 'EXPIRED';
      op.error = op.status === 'FAILED' ? 'EXECUTION_TIMEOUT' : 'APPROVAL_TIMEOUT';
      clearInterval(op.monitor); op.monitor = null; auditAdminTerminal(row, op);
      return;
    }
    op.polling = true;
    adminOperationRequest(sessionId, op, 'status', options).catch(error => {
      if (!active.has(sessionId) && !adminTerminal(op.status)) {
        const sessionCode = ['REMOTE_STOPPED', 'SESSION_EXPIRED', 'DEVICE_REVOKED'].includes(error?.code) ? error.code : null;
        op.status = sessionCode && op.status === 'PENDING_APPROVAL' ? 'CANCELLED' : 'FAILED';
        op.error = sessionCode ?? 'NETWORK_TIMEOUT';
        auditAdminTerminal(row, op);
      }
      if (op.monitor) clearInterval(op.monitor);
      op.monitor = null;
    }).finally(() => { op.polling = false; });
  }, OMEGA_V2_ADMIN_CLIENT_LIMITS.monitorIntervalMs);
  op.monitor.unref?.();
}

async function runAdminRead(sessionId, actionType, options) {
  if (!validAdminAction(actionType) || isHighImpactAdminAction(actionType)) throw adminError('ADMIN_ACTION_INVALID');
  const { row, state } = requireAdminSession(sessionId);
  adminRate(state.admin.rate.read, OMEGA_V2_ADMIN_CLIENT_LIMITS.readPerMinute);
  const op = createAdminOperation(row, state, actionType, 'READ');
  try { return await adminOperationRequest(sessionId, op, 'request', options); }
  finally { active.get(sessionId)?.admin?.operations.delete(op.operationId); }
}

async function requestAdminHighImpact(sessionId, actionType, options) {
  if (!isHighImpactAdminAction(actionType)) throw adminError('ADMIN_ACTION_INVALID');
  const { row, state } = requireAdminSession(sessionId);
  if ([...state.admin.operations.values()].some(op => op.kind === 'HIGH_IMPACT' && !adminTerminal(op.status))) {
    throw adminError('ADMIN_HIGH_IMPACT_PENDING');
  }
  adminRate(state.admin.rate.high, OMEGA_V2_ADMIN_CLIENT_LIMITS.highImpactPerMinute);
  const op = createAdminOperation(row, state, actionType, 'HIGH_IMPACT');
  try { await adminOperationRequest(sessionId, op, 'request', options); }
  catch (error) { active.get(sessionId)?.admin?.operations.delete(op.operationId); throw error; }
  if (!adminTerminal(op.status)) monitorAdminOperation(sessionId, op, options);
  return publicAdminOperation(op);
}

export const getOmegaOutboundAdminSystemInfo = (sessionId, options = {}) => runAdminRead(sessionId, 'GET_SYSTEM_INFO', options);
export const listOmegaOutboundAdminProcesses = (sessionId, options = {}) => runAdminRead(sessionId, 'PROCESS_LIST', options);
export const getOmegaOutboundAdminServiceStatus = (sessionId, options = {}) => runAdminRead(sessionId, 'SERVICE_STATUS', options);
export const getOmegaOutboundAdminNetworkStatus = (sessionId, options = {}) => runAdminRead(sessionId, 'NETWORK_STATUS', options);
export const getOmegaOutboundAdminDiskStatus = (sessionId, options = {}) => runAdminRead(sessionId, 'DISK_STATUS', options);
export const requestOmegaOutboundAdminLock = (sessionId, options = {}) => requestAdminHighImpact(sessionId, 'LOCK', options);
export const requestOmegaOutboundAdminLogoff = (sessionId, options = {}) => requestAdminHighImpact(sessionId, 'LOGOFF', options);
export const requestOmegaOutboundAdminRestart = (sessionId, options = {}) => requestAdminHighImpact(sessionId, 'RESTART', options);
export const requestOmegaOutboundAdminShutdown = (sessionId, options = {}) => requestAdminHighImpact(sessionId, 'SHUTDOWN', options);

function requireAdminOperation(sessionId, operationId) {
  const { state } = requireAdminSession(sessionId);
  const op = typeof operationId === 'string' && ADMIN_OPERATION_ID.test(operationId) ? state.admin.operations.get(operationId) : null;
  if (!op) throw adminError('OPERATION_NOT_FOUND');
  return { state, op };
}

export async function getOmegaOutboundAdminOperation(sessionId, operationId, options = {}) {
  const { state, op } = requireAdminOperation(sessionId, operationId);
  if (adminTerminal(op.status)) return publicAdminOperation(op);
  adminRate(state.admin.rate.status, OMEGA_V2_ADMIN_CLIENT_LIMITS.statusPerMinute);
  return adminOperationRequest(sessionId, op, 'status', options);
}

export async function cancelOmegaOutboundAdminOperation(sessionId, operationId, options = {}) {
  const { state, op } = requireAdminOperation(sessionId, operationId);
  if (adminTerminal(op.status)) return publicAdminOperation(op);
  adminRate(state.admin.rate.status, OMEGA_V2_ADMIN_CLIENT_LIMITS.statusPerMinute);
  return adminOperationRequest(sessionId, op, 'cancel', options);
}
