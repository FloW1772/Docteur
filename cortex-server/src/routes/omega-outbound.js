import crypto from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  ensureOmegaV2Identity, signWithOmegaV2Identity,
} from '../lib/omega-outbound-identity.js';
import {
  getInboundTrust, upsertInboundTrust, revokeInboundTrust, insertSession, getSession,
  endSession, expireSession, consumeReplayToken, pruneReplayTokens, recordAudit, listAudit,
  initializeOmegaOutboundStore,
} from '../lib/omega-outbound-store.js';
import {
  identityFingerprint, normalizeFingerprint, permissionAllowed, validPermission, randomNonce,
  requestFields, responseFields, viewFrameFields, verifyMessage, timestampFresh, sha256,
  OMEGA_V2_SESSION_TTL_MS,
} from '../lib/omega-outbound-protocol.js';
import {
  connectOmegaDevice, getOmegaOutboundIdentity, getOmegaOutboundSession,
  listOmegaOutboundSessions, listOmegaOutboundHosts, refreshOmegaOutboundSession,
  registerOmegaOutboundHost, revokeOmegaOutboundHost, stopAllOmegaOutboundSessions,
  stopOmegaOutboundSession, startOmegaOutboundView, getOmegaOutboundViewStatus,
  fetchOmegaOutboundViewFrame, stopOmegaOutboundView, startOmegaOutboundInteractive,
  getOmegaOutboundInteractiveStatus, sendOmegaOutboundInput, stopOmegaOutboundInteractive,
  getOmegaOutboundAdminSystemInfo, listOmegaOutboundAdminProcesses, getOmegaOutboundAdminServiceStatus,
  getOmegaOutboundAdminNetworkStatus, getOmegaOutboundAdminDiskStatus, requestOmegaOutboundAdminLock,
  requestOmegaOutboundAdminLogoff, requestOmegaOutboundAdminRestart, requestOmegaOutboundAdminShutdown,
  getOmegaOutboundAdminOperation, cancelOmegaOutboundAdminOperation,
} from '../lib/omega-outbound-client.js';
import { createOmegaOutboundViewManager } from '../lib/omega-outbound-view.js';
import { createOmegaOutboundInteractiveManager, OMEGA_V2_INPUT_LIMITS } from '../lib/omega-outbound-interactive.js';
import { createOmegaOutboundAdminManager } from '../lib/omega-outbound-admin.js';

const ID = /^(?:ov2c|ov2h)-[0-9a-f-]{36}$/;
const SESSION_ID = /^[0-9a-f-]{36}$/;
const localAddress = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
const challenges = new Map();
const challengeAttempts = new Map();
const statusAttempts = new Map();
const localInputAttempts = new Map();
const adminAttempts = new Map();
const localAdminAttempts = new Map();
const ADMIN_ROUTE_MAX_PER_MINUTE = 180;
const ADMIN_TERMINAL_ERRORS = new Set(['DEVICE_REVOKED', 'SESSION_EXPIRED', 'REMOTE_STOPPED']);
// Local semantic ADMIN routes: fixed path -> typed client function. No generic executor.
const LOCAL_ADMIN_READ_ROUTES = Object.freeze({
  'system-info': getOmegaOutboundAdminSystemInfo, processes: listOmegaOutboundAdminProcesses,
  services: getOmegaOutboundAdminServiceStatus, network: getOmegaOutboundAdminNetworkStatus,
  disks: getOmegaOutboundAdminDiskStatus,
});
const LOCAL_ADMIN_HIGH_IMPACT_ROUTES = Object.freeze({
  lock: ['LOCK', requestOmegaOutboundAdminLock], logoff: ['LOGOFF', requestOmegaOutboundAdminLogoff],
  restart: ['RESTART', requestOmegaOutboundAdminRestart], shutdown: ['SHUTDOWN', requestOmegaOutboundAdminShutdown],
});

function limited(map, key, maximum, windowMs) {
  const now = Date.now();
  const values = (map.get(key) ?? []).filter(value => now - value < windowMs);
  if (values.length >= maximum) return true;
  values.push(now); map.set(key, values); return false;
}

function safeError(error) {
  const value = error?.code || error?.message || 'internal_error';
  const allowed = new Set(['DEVICE_UNTRUSTED', 'DEVICE_REVOKED', 'PERMISSION_DENIED', 'SESSION_EXPIRED',
    'REMOTE_STOPPED', 'RATE_LIMITED', 'TLS_IDENTITY_MISMATCH', 'NETWORK_UNAVAILABLE',
    'SCREEN_INDEX_INVALID', 'VIEW_ALREADY_STARTED', 'VIEW_NOT_STARTED', 'WRONG_STREAM',
    'FRAME_INVALID', 'FRAME_TOO_LARGE', 'INVALID_FRAME', 'REMOTE_CONSENT_UNAVAILABLE',
    'VIEW_NOT_ACTIVE', 'WRONG_SCREEN', 'INTERACTIVE_ALREADY_STARTED', 'INTERACTIVE_NOT_STARTED',
    'INTERACTIVE_STOPPED', 'INPUT_INVALID', 'INPUT_CATEGORY_INVALID', 'POINTER_OUT_OF_BOUNDS',
    'BUTTON_INVALID', 'WHEEL_DELTA_INVALID', 'KEY_INVALID', 'OPERATION_ID_INVALID',
    'OPERATION_REPLAYED', 'DUPLICATE_DOWN', 'QUEUE_FULL',
    'ADMIN_ACTION_INVALID', 'ADMIN_PAYLOAD_INVALID', 'OPERATION_DUPLICATE', 'OPERATION_NOT_FOUND',
    'ADMIN_HIGH_IMPACT_PENDING', 'ADMIN_RESULT_MISMATCH', 'ADMIN_RESULT_INVALID', 'CONFIRMATION_REQUIRED',
    'INVALID_RESPONSE', 'SESSION_NOT_FOUND',
    'outbound_trust_already_exists', 'inbound_trust_already_exists']);
  return allowed.has(value) ? value : 'request_rejected';
}

function publicIdentity(identity) {
  return { deviceId: identity.deviceId, role: identity.role, publicKeyPem: identity.publicKeyPem, fingerprint: identity.fingerprint };
}

function registerInboundController(input) {
  if (!ID.test(input.controllerDeviceId ?? '') || !String(input.controllerDeviceId).startsWith('ov2c-')) throw new Error('controller_device_id_invalid');
  if (!validPermission(input.maxPermission)) throw new Error('permission_invalid');
  const actual = identityFingerprint(input.publicKeyPem);
  if (actual !== normalizeFingerprint(input.identityFingerprint)) throw new Error('identity_fingerprint_mismatch');
  return upsertInboundTrust({ controllerDeviceId: input.controllerDeviceId, publicKeyPem: input.publicKeyPem,
    identityFingerprint: actual, maxPermission: input.maxPermission, createdAt: new Date().toISOString() });
}

function signedHostResponse(identity, session, requestId, statusCode, payload) {
  const timestamp = new Date().toISOString();
  const fields = responseFields({ localDeviceId: session.remote_device_id, remoteDeviceId: session.local_device_id,
    sessionId: session.id, requestId, timestamp, statusCode,
    bodyBytes: Buffer.from(JSON.stringify(payload), 'utf8') });
  const signature = signWithOmegaV2Identity('HOST', identity.deviceId, 'OMEGA-V2/HOST/RESPONSE', fields);
  return { payload, auth: { timestamp, signature } };
}

function verifySessionEnvelope(c, sessionId, action) {
  return c.req.json().catch(() => null).then(body => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'INVALID_REQUEST', status: 400 };
    const session = getSession(sessionId);
    if (!session || session.direction !== 'INBOUND') return { error: 'SESSION_EXPIRED', status: 404 };
    const auth = body?.auth;
    const payload = body?.payload;
    if (!auth || !payload || typeof payload !== 'object' || Array.isArray(payload)) return { session, error: 'AUTH_FAILURE', status: 401 };
    const expectedPath = `/api/omega-v2/sessions/${sessionId}/${action}`;
    const fields = requestFields({ localDeviceId: auth.localDeviceId, remoteDeviceId: auth.remoteDeviceId,
      sessionId: auth.sessionId, requestId: auth.requestId, timestamp: auth.timestamp, nonce: auth.nonce,
      method: 'POST', path: expectedPath, bodyBytes: Buffer.from(JSON.stringify(payload), 'utf8') });
    if (auth.sessionId !== session.id || auth.localDeviceId !== session.remote_device_id
      || auth.remoteDeviceId !== session.local_device_id || auth.method !== 'POST' || auth.path !== expectedPath
      || auth.bodyHash !== fields.bodyHash || !timestampFresh(auth.timestamp)
      || !/^[A-Za-z0-9_-]{32}$/.test(auth.nonce ?? '') || !/^[0-9a-f-]{36}$/.test(auth.requestId ?? '')) {
      return { session, requestId: auth.requestId, error: 'AUTH_FAILURE', status: 401 };
    }
    const trust = getInboundTrust(session.remote_device_id);
    if (!trust) return { session, requestId: auth.requestId, error: 'DEVICE_UNTRUSTED', status: 403 };
    if (!verifyMessage(trust.public_key_pem, auth.signature, 'OMEGA-V2/CONTROLLER/REQUEST', fields)) {
      return { session, requestId: auth.requestId, error: 'AUTH_FAILURE', status: 401 };
    }
    if (!consumeReplayToken({ sessionId, requestId: auth.requestId, nonceHash: sha256(auth.nonce), createdAt: auth.timestamp })) {
      return { session, requestId: auth.requestId, error: 'REPLAY_REJECTED', status: 409 };
    }
    if (trust.revoked_at) {
      endSession(sessionId, 'controller_revoked');
      return { session: getSession(sessionId), requestId: auth.requestId, error: 'DEVICE_REVOKED', status: 403 };
    }
    if (session.status === 'EXPIRED') return { session, requestId: auth.requestId, error: 'SESSION_EXPIRED', status: 410 };
    if (session.ended_at) return { session, requestId: auth.requestId, error: 'REMOTE_STOPPED', status: 409 };
    if (Date.parse(session.expires_at) <= Date.now()) {
      expireSession(sessionId);
      return { session: getSession(sessionId), requestId: auth.requestId, error: 'SESSION_EXPIRED', status: 410 };
    }
    return { session, requestId: auth.requestId, payload };
  });
}

export function createOmegaOutboundRoute({
  certificateFingerprint = null,
  isLocal = c => { try { return localAddress(getConnInfo(c).remote.address); } catch { return false; } },
  isTls = c => c?.env?.incoming?.socket?.encrypted === true || c?.env?.server?.incoming?.socket?.encrypted === true,
  clientOptions = {},
  viewProvider,
  outboundViewManager,
  interactiveProvider,
  outboundInteractiveManager,
  outboundAdminManager,
  adminExecutor,
  adminApprovalProvider,
  adminIndicatorProvider,
  adminLimits,
} = {}) {
  initializeOmegaOutboundStore();
  const route = new Hono();
  const viewManager = outboundViewManager ?? createOmegaOutboundViewManager(viewProvider);
  const interactiveManager = outboundInteractiveManager ?? createOmegaOutboundInteractiveManager({
    viewManager, provider: interactiveProvider,
  });
  viewManager.onStop?.((sessionId, reason) => interactiveManager.onViewStopped(sessionId, reason));
  const adminManager = outboundAdminManager ?? createOmegaOutboundAdminManager({
    ...(adminExecutor ? { executor: adminExecutor } : {}),
    ...(adminApprovalProvider ? { approvalProvider: adminApprovalProvider } : {}),
    ...(adminIndicatorProvider ? { indicatorProvider: adminIndicatorProvider } : {}),
    limits: adminLimits,
    // The host ADMIN indicator STOP ends the whole session, like the INTERACTIVE one.
    onRemoteLocalStop: sessionId => {
      void interactiveManager.stop(sessionId, 'remote_local_stop', { stopView: true, terminateSession: true })
        .catch(() => {}).then(() => viewManager.stop(sessionId, 'remote_local_stop')).catch(() => {});
    },
  });
  // A revoked, expired or ended session must release held input immediately,
  // not only when the 6 s network lease runs out.
  const stopInteractiveOnTerminal = (sessionId, error) => (['DEVICE_REVOKED', 'SESSION_EXPIRED', 'REMOTE_STOPPED'].includes(error)
    ? interactiveManager.stop(sessionId, error, { stopView: true }).catch(() => {}) : Promise.resolve());

  route.use('/omega/outbound/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: 'local_access_required' }, 403);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname)) return c.json({ error: 'host_denied' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return c.json({ error: 'origin_denied' }, 403);
      } catch { return c.json({ error: 'origin_denied' }, 403); }
    }
    const pathname = new URL(c.req.url).pathname;
    const bodyless = pathname.endsWith('/stop-all') || pathname.endsWith('/stop') || pathname.endsWith('/revoke');
    if (c.req.method === 'POST' && !bodyless && !c.req.header('content-type')?.startsWith('application/json')) {
      return c.json({ error: 'content_type_required' }, 415);
    }
    return next();
  });
  route.use('/omega/outbound/*', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  route.use('/omega-v2/*', async (c, next) => {
    if (!isTls(c)) {
      recordAudit('OUTBOUND_TLS_FAILURE', { result: 'TLS_REQUIRED' });
      return c.json({ error: 'TLS_REQUIRED' }, 426);
    }
    if (!certificateFingerprint) return c.json({ error: 'TLS_IDENTITY_UNAVAILABLE' }, 503);
    if (c.req.method === 'POST' && !c.req.header('content-type')?.startsWith('application/json')) {
      return c.json({ error: 'content_type_required' }, 415);
    }
    return next();
  });
  route.use('/omega-v2/*', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  route.get('/omega/outbound/identity', c => c.json({ controller: publicIdentity(getOmegaOutboundIdentity()),
    host: publicIdentity(ensureOmegaV2Identity('HOST')) }));
  route.get('/omega/outbound/trust/hosts', c => c.json({ hosts: listOmegaOutboundHosts() }));
  route.post('/omega/outbound/trust/hosts', async c => {
    try { return c.json({ host: registerOmegaOutboundHost(await c.req.json()) }, 201); }
    catch (error) { return c.json({ error: safeError(error) }, 400); }
  });
  route.post('/omega/outbound/trust/hosts/:id/revoke', c => c.json({ revoked: revokeOmegaOutboundHost(c.req.param('id')) }));
  route.post('/omega/outbound/trust/controllers', async c => {
    try { const row = registerInboundController(await c.req.json()); return c.json({ controllerDeviceId: row.controller_device_id, maxPermission: row.max_permission }, 201); }
    catch (error) { return c.json({ error: safeError(error) }, 400); }
  });
  route.post('/omega/outbound/trust/controllers/:id/revoke', async c => {
    const controllerDeviceId = c.req.param('id');
    await adminManager.stopForController(controllerDeviceId, 'DEVICE_REVOKED');
    await interactiveManager.stopForController(controllerDeviceId, 'controller_revoked');
    await viewManager.stopForController(controllerDeviceId, 'controller_revoked');
    return c.json({ revoked: revokeInboundTrust(controllerDeviceId) });
  });
  route.post('/omega/outbound/connect', async c => {
    try {
      const body = await c.req.json();
      return c.json({ session: await connectOmegaDevice(body.remoteDeviceId, body.permission, clientOptions) }, 201);
    } catch (error) { return c.json({ error: safeError(error) }, 409); }
  });
  route.get('/omega/outbound/sessions', c => c.json({ sessions: listOmegaOutboundSessions() }));
  route.get('/omega/outbound/sessions/:id', async c => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return c.json({ error: 'session_id_invalid' }, 400);
    try { return c.json({ session: await refreshOmegaOutboundSession(id, clientOptions) }); }
    catch (error) {
      const session = getOmegaOutboundSession(id);
      return c.json({ error: safeError(error), session }, error?.code === 'SESSION_NOT_FOUND' ? 404 : 409);
    }
  });
  route.post('/omega/outbound/sessions/:id/view/start', async c => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return c.json({ error: 'session_id_invalid' }, 400);
    try {
      const body = await c.req.json();
      return c.json({ view: await startOmegaOutboundView(id, body?.screenIndex, clientOptions) }, 201);
    } catch (error) { return c.json({ error: safeError(error) }, error?.code === 'SESSION_EXPIRED' ? 409 : 400); }
  });
  route.get('/omega/outbound/sessions/:id/view/status', async c => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return c.json({ error: 'session_id_invalid' }, 400);
    try { return c.json({ view: await getOmegaOutboundViewStatus(id, clientOptions) }); }
    catch (error) { return c.json({ error: safeError(error) }, 409); }
  });
  route.post('/omega/outbound/sessions/:id/view/frame', async c => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return c.json({ error: 'session_id_invalid' }, 400);
    try {
      const frame = await fetchOmegaOutboundViewFrame(id, clientOptions);
      return new Response(frame.buffer, { status: 200, headers: {
        'Content-Type': frame.mimeType, 'Content-Length': String(frame.buffer.length), 'Cache-Control': 'no-store',
        'X-Omega-Stream-Id': frame.streamId, 'X-Omega-Frame-Id': frame.frameId,
        'X-Omega-Frame-Sequence': String(frame.sequence), 'X-Omega-Frame-Width': String(frame.width),
        'X-Omega-Frame-Height': String(frame.height), 'X-Omega-Frame-Timestamp': frame.timestamp,
        'X-Omega-Screen-Index': String(frame.screenIndex),
      } });
    } catch (error) { return c.json({ error: safeError(error) }, error?.code === 'NETWORK_UNAVAILABLE' ? 503 : 409); }
  });
  route.post('/omega/outbound/sessions/:id/view/stop', async c => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return c.json({ error: 'session_id_invalid' }, 400);
    try { return c.json({ view: await stopOmegaOutboundView(id, clientOptions) }); }
    catch (error) { return c.json({ error: safeError(error) }, 409); }
  });
  route.post('/omega/outbound/sessions/:id/interactive/start', async c => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return c.json({ error: 'session_id_invalid' }, 400);
    try { return c.json({ interactive: await startOmegaOutboundInteractive(id, clientOptions) }, 201); }
    catch (error) { return c.json({ error: safeError(error) }, error?.code === 'PERMISSION_DENIED' ? 403 : 409); }
  });
  route.get('/omega/outbound/sessions/:id/interactive/status', async c => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return c.json({ error: 'session_id_invalid' }, 400);
    try { return c.json({ interactive: await getOmegaOutboundInteractiveStatus(id, clientOptions) }); }
    catch (error) { return c.json({ error: safeError(error) }, 409); }
  });
  route.post('/omega/outbound/sessions/:id/interactive/stop', async c => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return c.json({ error: 'session_id_invalid' }, 400);
    try { return c.json({ interactive: await stopOmegaOutboundInteractive(id, clientOptions) }); }
    catch (error) { return c.json({ error: safeError(error) }, 409); }
  });
  for (const category of ['pointer', 'button', 'wheel', 'key']) route.post(`/omega/outbound/sessions/:id/input/${category}`, async c => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return c.json({ error: 'session_id_invalid' }, 400);
    if (limited(localInputAttempts, `${id}:${category}`, OMEGA_V2_INPUT_LIMITS[`${category}PerSecond`], 1_000)) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > 8 * 1024) return c.json({ error: 'request_too_large' }, 413);
    try { return c.json({ input: await sendOmegaOutboundInput(id, category, await c.req.json(), clientOptions) }); }
    catch (error) { return c.json({ error: safeError(error) }, error?.code === 'RATE_LIMITED' ? 429 : 409); }
  });
  // ADMIN (controller side): loopback semantic routes only, one per typed function.
  const localAdminStatus = error => (error?.code === 'PERMISSION_DENIED' ? 403 : error?.code === 'RATE_LIMITED' ? 429
    : error?.code === 'OPERATION_NOT_FOUND' ? 404 : error?.code === 'NETWORK_UNAVAILABLE' ? 503 : 409);
  const localAdminGuard = async (c, expectedBody) => {
    const id = c.req.param('id');
    if (!SESSION_ID.test(id)) return { response: c.json({ error: 'session_id_invalid' }, 400) };
    if (limited(localAdminAttempts, id, ADMIN_ROUTE_MAX_PER_MINUTE, 60_000)) return { response: c.json({ error: 'RATE_LIMITED' }, 429) };
    if (expectedBody) {
      const body = await c.req.json().catch(() => null);
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
      const expectedKeys = Object.keys(expectedBody);
      if (!keys || keys.length !== expectedKeys.length || expectedKeys.some(key => body[key] !== expectedBody[key])) {
        return { response: c.json({ error: expectedKeys.length ? 'CONFIRMATION_REQUIRED' : 'ADMIN_PAYLOAD_INVALID' }, 400) };
      }
    }
    return { id };
  };
  for (const [name, read] of Object.entries(LOCAL_ADMIN_READ_ROUTES)) route.post(`/omega/outbound/sessions/:id/admin/${name}`, async c => {
    const guard = await localAdminGuard(c, {});
    if (guard.response) return guard.response;
    try { return c.json({ admin: await read(guard.id, clientOptions) }); }
    catch (error) { return c.json({ error: safeError(error) }, localAdminStatus(error)); }
  });
  for (const [name, [actionType, requestHighImpact]] of Object.entries(LOCAL_ADMIN_HIGH_IMPACT_ROUTES)) {
    // A high-impact request requires an explicit typed confirmation naming the exact action.
    route.post(`/omega/outbound/sessions/:id/admin/${name}/request`, async c => {
      const guard = await localAdminGuard(c, { confirm: actionType });
      if (guard.response) return guard.response;
      try { return c.json({ admin: await requestHighImpact(guard.id, clientOptions) }, 202); }
      catch (error) { return c.json({ error: safeError(error) }, localAdminStatus(error)); }
    });
  }
  route.get('/omega/outbound/sessions/:id/admin/operations/:operationId', async c => {
    const guard = await localAdminGuard(c, null);
    if (guard.response) return guard.response;
    try { return c.json({ admin: await getOmegaOutboundAdminOperation(guard.id, c.req.param('operationId'), clientOptions) }); }
    catch (error) { return c.json({ error: safeError(error) }, localAdminStatus(error)); }
  });
  route.post('/omega/outbound/sessions/:id/admin/operations/:operationId/cancel', async c => {
    const guard = await localAdminGuard(c, {});
    if (guard.response) return guard.response;
    try { return c.json({ admin: await cancelOmegaOutboundAdminOperation(guard.id, c.req.param('operationId'), clientOptions) }); }
    catch (error) { return c.json({ error: safeError(error) }, localAdminStatus(error)); }
  });
  route.post('/omega/outbound/sessions/:id/stop', async c => c.json({ stopped: await stopOmegaOutboundSession(c.req.param('id'), clientOptions) }));
  route.post('/omega/outbound/stop-all', async c => c.json({ stopped: await stopAllOmegaOutboundSessions(clientOptions) }));
  route.get('/omega/outbound/audit', c => c.json({ events: listAudit(100) }));

  route.post('/omega-v2/challenge', async c => {
    const body = await c.req.json();
    if (!ID.test(body.localDeviceId ?? '') || !ID.test(body.expectedRemoteDeviceId ?? '') || typeof body.clientNonce !== 'string') return c.json({ error: 'invalid_request' }, 400);
    if (limited(challengeAttempts, body.localDeviceId, 10, 60_000)) return c.json({ error: 'RATE_LIMITED' }, 429);
    const host = ensureOmegaV2Identity('HOST');
    if (body.expectedRemoteDeviceId !== host.deviceId) return c.json({ error: 'wrong_device' }, 409);
    const trust = getInboundTrust(body.localDeviceId);
    if (!trust || trust.revoked_at) return c.json({ error: trust?.revoked_at ? 'DEVICE_REVOKED' : 'DEVICE_UNTRUSTED' }, 403);
    const now = Date.now();
    const challenge = { hostDeviceId: host.deviceId, clientDeviceId: body.localDeviceId,
      challengeId: crypto.randomUUID(), serverNonce: randomNonce(), clientNonce: body.clientNonce,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      certificateFingerprint: normalizeFingerprint(certificateFingerprint) };
    challenges.set(challenge.challengeId, { ...challenge, used: false });
    challenge.signature = signWithOmegaV2Identity('HOST', host.deviceId, 'OMEGA-V2/HOST/CHALLENGE', challenge);
    return c.json(challenge);
  });

  route.post('/omega-v2/sessions', async c => {
    const body = await c.req.json();
    const challenge = challenges.get(body.challengeId);
    if (!challenge || challenge.used || Date.parse(challenge.expiresAt) <= Date.now()) return c.json({ error: 'AUTH_FAILURE' }, 401);
    challenge.used = true;
    const host = ensureOmegaV2Identity('HOST');
    const trust = getInboundTrust(body.clientDeviceId);
    const fields = { hostDeviceId: body.hostDeviceId, clientDeviceId: body.clientDeviceId,
      challengeId: body.challengeId, serverNonce: body.serverNonce, clientNonce: body.clientNonce,
      issuedAt: body.issuedAt, expiresAt: body.expiresAt,
      certificateFingerprint: normalizeFingerprint(body.certificateFingerprint), requestedPermission: body.requestedPermission };
    if (!trust || trust.revoked_at || body.hostDeviceId !== host.deviceId
      || Object.keys(challenge).some(key => key !== 'used' && key in fields && fields[key] !== challenge[key])
      || body.controllerPublicKeyFingerprint !== trust.identity_fingerprint
      || !permissionAllowed(body.requestedPermission, trust.max_permission)
      || !verifyMessage(trust.public_key_pem, body.signature, 'OMEGA-V2/CONTROLLER/AUTH', fields)) {
      recordAudit('OUTBOUND_SESSION_DENIED', { localDeviceId: host.deviceId, remoteDeviceId: body.clientDeviceId, result: 'AUTH_FAILURE' });
      return c.json({ error: 'AUTH_FAILURE' }, 401);
    }
    const issuedAt = Date.now();
    const createdAt = new Date(issuedAt).toISOString();
    const payload = { sessionId: crypto.randomUUID(), localDeviceId: body.clientDeviceId,
      remoteDeviceId: host.deviceId, permission: body.requestedPermission, createdAt,
      expiresAt: new Date(issuedAt + OMEGA_V2_SESSION_TTL_MS).toISOString() };
    insertSession({ sessionId: payload.sessionId, direction: 'INBOUND', localDeviceId: host.deviceId,
      remoteDeviceId: body.clientDeviceId, permission: payload.permission, createdAt, expiresAt: payload.expiresAt, status: 'CONNECTED' });
    const signature = signWithOmegaV2Identity('HOST', host.deviceId, 'OMEGA-V2/HOST/SESSION', payload);
    return c.json({ payload, signature }, 201);
  });

  route.post('/omega-v2/sessions/:id/view/start', async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const verified = await verifySessionEnvelope(c, sessionId, 'view/start');
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      await viewManager.stop(sessionId, verified.error).catch(() => {});
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status, { type: 'VIEW_STATUS', error: verified.error }), verified.status);
    }
    if (!permissionAllowed('VIEW', verified.session.permission)) {
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 403, { type: 'VIEW_STATUS', error: 'PERMISSION_DENIED' }), 403);
    }
    try {
      const result = await viewManager.start(verified.session, verified.payload.screenIndex);
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 200, { type: 'VIEW_START', ...result }), 200);
    } catch (error) {
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 409, { type: 'VIEW_STATUS', error: error.code ?? 'VIEW_START_FAILED' }), 409);
    }
  });

  route.post('/omega-v2/sessions/:id/view/status', async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const verified = await verifySessionEnvelope(c, sessionId, 'view/status');
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      await viewManager.stop(sessionId, verified.error).catch(() => {});
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status, { type: 'VIEW_STATUS', error: verified.error }), verified.status);
    }
    if (typeof verified.payload.streamId !== 'string') {
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 409,
        { type: 'VIEW_STATUS', error: 'WRONG_STREAM' }), 409);
    }
    const result = viewManager.status(sessionId, verified.payload.streamId);
    return c.json(signedHostResponse(host, verified.session, verified.requestId, 200, { type: 'VIEW_STATUS', ...result }), 200);
  });

  route.post('/omega-v2/sessions/:id/view/stop', async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const verified = await verifySessionEnvelope(c, sessionId, 'view/stop');
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      await viewManager.stop(sessionId, verified.error).catch(() => {});
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status, { type: 'VIEW_STATUS', error: verified.error }), verified.status);
    }
    if (typeof verified.payload.streamId !== 'string') {
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 409,
        { type: 'VIEW_STATUS', error: 'WRONG_STREAM' }), 409);
    }
    const result = await viewManager.stop(sessionId, 'controller_view_stop', verified.payload.streamId);
    return c.json(signedHostResponse(host, verified.session, verified.requestId, 200, { type: 'VIEW_STOP', ...result }), 200);
  });

  route.post('/omega-v2/sessions/:id/view/frame', async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const verified = await verifySessionEnvelope(c, sessionId, 'view/frame');
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      await viewManager.stop(sessionId, verified.error).catch(() => {});
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status, { type: 'VIEW_STATUS', error: verified.error }), verified.status);
    }
    try {
      if (typeof verified.payload.streamId !== 'string') throw Object.assign(new Error('WRONG_STREAM'), { code: 'WRONG_STREAM' });
      const frame = await viewManager.frame(sessionId, verified.payload.streamId);
      const responseTimestamp = new Date().toISOString();
      const responseAuth = responseFields({ localDeviceId: verified.session.remote_device_id,
        remoteDeviceId: verified.session.local_device_id, sessionId, requestId: verified.requestId,
        timestamp: responseTimestamp, statusCode: 200, bodyBytes: frame.buffer });
      const frameFields = viewFrameFields({ localDeviceId: verified.session.remote_device_id,
        remoteDeviceId: verified.session.local_device_id, sessionId, requestId: verified.requestId,
        streamId: frame.streamId, frameId: frame.frameId, sequence: frame.sequence, timestamp: frame.timestamp,
        mimeType: frame.mimeType, width: frame.width, height: frame.height, screenIndex: frame.screenIndex,
        bodyBytes: frame.buffer });
      return new Response(frame.buffer, { status: 200, headers: {
        'Content-Type': frame.mimeType, 'Content-Length': String(frame.buffer.length), 'Cache-Control': 'no-store',
        'X-Omega-Stream-Id': frame.streamId, 'X-Omega-Frame-Id': frame.frameId,
        'X-Omega-Frame-Sequence': String(frame.sequence), 'X-Omega-Frame-Width': String(frame.width),
        'X-Omega-Frame-Height': String(frame.height), 'X-Omega-Frame-Timestamp': frame.timestamp,
        'X-Omega-Screen-Index': String(frame.screenIndex), 'X-Omega-Response-Timestamp': responseTimestamp,
        'X-Omega-Session-Id': sessionId, 'X-Omega-Remote-Device-Id': verified.session.local_device_id,
        'X-Omega-Response-Signature': signWithOmegaV2Identity('HOST', host.deviceId, 'OMEGA-V2/HOST/RESPONSE', responseAuth),
        'X-Omega-Frame-Signature': signWithOmegaV2Identity('HOST', host.deviceId, 'OMEGA-V2/HOST/VIEW_FRAME', frameFields),
      } });
    } catch (error) {
      const status = error.code === 'FRAME_TOO_LARGE' || error.code === 'FRAME_INVALID' ? 422 : 409;
      return c.json(signedHostResponse(host, verified.session, verified.requestId, status, { type: 'VIEW_STATUS', error: error.code ?? 'VIEW_FRAME_FAILED' }), status);
    }
  });

  route.post('/omega-v2/sessions/:id/interactive/start', async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const verified = await verifySessionEnvelope(c, sessionId, 'interactive/start');
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      await stopInteractiveOnTerminal(sessionId, verified.error);
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status,
        { type: 'INTERACTIVE_STATUS', error: verified.error }), verified.status);
    }
    if (!permissionAllowed('INTERACTIVE', verified.session.permission)) {
      recordAudit('OUTBOUND_INTERACTIVE_DENIED', { sessionId, localDeviceId: host.deviceId,
        remoteDeviceId: verified.session.remote_device_id, result: 'PERMISSION_DENIED' });
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 403,
        { type: 'INTERACTIVE_STATUS', error: 'PERMISSION_DENIED' }), 403);
    }
    try {
      const result = await interactiveManager.start(verified.session, verified.payload);
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 200,
        { type: 'INTERACTIVE_START', ...result }), 200);
    } catch (error) {
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 409,
        { type: 'INTERACTIVE_STATUS', error: error.code ?? 'INPUT_INVALID' }), 409);
    }
  });

  route.post('/omega-v2/sessions/:id/interactive/status', async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const verified = await verifySessionEnvelope(c, sessionId, 'interactive/status');
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      await stopInteractiveOnTerminal(sessionId, verified.error);
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status,
        { type: 'INTERACTIVE_STATUS', error: verified.error }), verified.status);
    }
    try {
      const result = interactiveManager.status(sessionId, verified.payload.streamId);
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 200,
        { type: 'INTERACTIVE_STATUS', ...result }), 200);
    } catch (error) {
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 409,
        { type: 'INTERACTIVE_STATUS', error: error.code ?? 'INPUT_INVALID' }), 409);
    }
  });

  route.post('/omega-v2/sessions/:id/interactive/stop', async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const verified = await verifySessionEnvelope(c, sessionId, 'interactive/stop');
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      await stopInteractiveOnTerminal(sessionId, verified.error);
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status,
        { type: 'INTERACTIVE_STATUS', error: verified.error }), verified.status);
    }
    try {
      const result = await interactiveManager.stop(sessionId, 'controller_interactive_stop');
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 200,
        { type: 'INTERACTIVE_STOP', ...result }), 200);
    } catch (error) {
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 409,
        { type: 'INTERACTIVE_STATUS', error: error.code ?? 'INPUT_INVALID' }), 409);
    }
  });

  for (const category of ['pointer', 'button', 'wheel', 'key']) route.post(`/omega-v2/sessions/:id/input/${category}`, async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const verified = await verifySessionEnvelope(c, sessionId, `input/${category}`);
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      await stopInteractiveOnTerminal(sessionId, verified.error);
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status,
        { type: 'INPUT_STATUS', error: verified.error }), verified.status);
    }
    if (!permissionAllowed('INTERACTIVE', verified.session.permission)) {
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 403,
        { type: 'INPUT_STATUS', error: 'PERMISSION_DENIED' }), 403);
    }
    try {
      const result = await interactiveManager.input(sessionId, category, verified.payload);
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 200,
        { type: 'INPUT_STATUS', category, accepted: true, ...result }), 200);
    } catch (error) {
      const status = error.code === 'RATE_LIMITED' ? 429 : 409;
      return c.json(signedHostResponse(host, verified.session, verified.requestId, status,
        { type: 'INPUT_STATUS', error: error.code ?? 'INPUT_INVALID' }), status);
    }
  });

  // ADMIN (host side): ADMIN_REQUEST / ADMIN_STATUS / ADMIN_CANCEL over the signed V2 envelope.
  for (const action of ['request', 'status', 'cancel']) route.post(`/omega-v2/sessions/:id/admin/${action}`, async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    if (limited(adminAttempts, sessionId, ADMIN_ROUTE_MAX_PER_MINUTE, 60_000)) return c.json({ error: 'RATE_LIMITED' }, 429);
    const verified = await verifySessionEnvelope(c, sessionId, `admin/${action}`);
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      const auditFields = { sessionId, localDeviceId: host.deviceId, remoteDeviceId: verified.session.remote_device_id,
        result: verified.error, detail: { message: `ADMIN_${action.toUpperCase()}` } };
      recordAudit(verified.error === 'REPLAY_REJECTED' ? 'OUTBOUND_ADMIN_REPLAY_REJECTED' : 'OUTBOUND_ADMIN_DENIED', auditFields);
      if (ADMIN_TERMINAL_ERRORS.has(verified.error)) {
        await adminManager.stop(sessionId, verified.error).catch(() => {});
        await stopInteractiveOnTerminal(sessionId, verified.error);
      }
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status,
        { type: 'ADMIN_STATUS', error: verified.error }), verified.status);
    }
    try {
      const result = await adminManager[action](verified.session, verified.payload);
      return c.json(signedHostResponse(host, verified.session, verified.requestId, 200, result), 200);
    } catch (error) {
      const code = error?.code ?? 'ADMIN_REJECTED';
      const status = code === 'PERMISSION_DENIED' ? 403 : code === 'RATE_LIMITED' ? 429 : code === 'OPERATION_NOT_FOUND' ? 404 : 409;
      return c.json(signedHostResponse(host, verified.session, verified.requestId, status, { type: 'ADMIN_STATUS', error: code }), status);
    }
  });

  for (const action of ['status', 'stop']) route.post(`/omega-v2/sessions/:id/${action}`, async c => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    if (action === 'status' && limited(statusAttempts, sessionId, 60, 60_000)) return c.json({ error: 'RATE_LIMITED' }, 429);
    pruneReplayTokens(new Date(Date.now() - OMEGA_V2_SESSION_TTL_MS).toISOString());
    const verified = await verifySessionEnvelope(c, sessionId, action);
    if (!verified.session || !verified.requestId) return c.json({ error: verified.error }, verified.status);
    const host = ensureOmegaV2Identity('HOST');
    if (verified.error) {
      if (ADMIN_TERMINAL_ERRORS.has(verified.error)) await adminManager.stop(sessionId, verified.error).catch(() => {});
      await viewManager.stop(sessionId, verified.error).catch(() => {});
      return c.json(signedHostResponse(host, verified.session, verified.requestId, verified.status, { error: verified.error }), verified.status);
    }
    if (action === 'stop') {
      await adminManager.stop(sessionId, 'CONTROLLER_STOP').catch(() => {});
      await interactiveManager.stop(sessionId, 'controller_stop').catch(() => {});
      await viewManager.stop(sessionId, 'controller_stop').catch(() => {});
      endSession(sessionId, 'controller_stop');
      const current = getSession(sessionId);
      return c.json(signedHostResponse(host, current, verified.requestId, 200, { status: 'TERMINATED', reason: 'controller_stop' }));
    }
    return c.json(signedHostResponse(host, verified.session, verified.requestId, 200, {
      status: 'CONNECTED', permission: verified.session.permission, expiresAt: verified.session.expires_at,
    }));
  });

  return route;
}
