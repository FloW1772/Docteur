/**
 * OMEGA ADMIN V1 semantic API.
 *
 * This route group rides the existing OMEGA TLS/session transport. It exposes
 * only named read-only queries and named high-impact action requests. There
 * is deliberately no shell, exec, PowerShell, command or arbitrary-process
 * route. Local approval endpoints are loopback + Origin protected and cannot
 * be reached by the remote controller.
 */
import { Hono } from 'hono';
import crypto from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { getOmegaTransportInfo, OMEGA_TLS_REQUIRED, isOmegaTransportAllowed } from '../lib/omega-transport.js';
import {
  OMEGA_ADMIN_ACTIONS, OMEGA_ADMIN_READ_ACTIONS, OMEGA_ADMIN_HIGH_IMPACT_ACTIONS,
  getAdminStatus, executeAdminReadAction, requestAdminAction, getAdminActionStatus,
  approveAdminActionLocally, denyAdminActionLocally, OmegaAdminError,
} from '../lib/omega-admin.js';
import { recordOmegaAudit } from '../lib/omega-audit.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const ACTION_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function isValidSessionId(value) { return typeof value === 'string' && SESSION_ID_PATTERN.test(value); }
function isValidDeviceId(value) { return typeof value === 'string' && DEVICE_ID_PATTERN.test(value); }
function isValidActionId(value) { return typeof value === 'string' && ACTION_ID_PATTERN.test(value); }
function isValidRequestId(value) { return typeof value === 'string' && REQUEST_ID_PATTERN.test(value); }

function isLoopbackRequest(c, isLocal) {
  if (!isLocal(c)) return false;
  const hostname = new URL(c.req.url).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false;
  const origin = c.req.header('origin');
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch { return false; }
}

function queryAuth(c) {
  const sessionId = c.req.query('sessionId');
  const deviceId = c.req.query('deviceId');
  const nonce = c.req.query('nonce');
  if (!isValidSessionId(sessionId) || !isValidDeviceId(deviceId) || typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) {
    throw new OmegaAdminError('SESSION_INVALID');
  }
  return { sessionId, deviceId, presentedNonce: nonce };
}

function bodyAuth(body) {
  if (!isValidSessionId(body?.sessionId) || !isValidDeviceId(body?.deviceId) || typeof body?.nonce !== 'string' || body.nonce.length === 0 || body.nonce.length > 128) {
    throw new OmegaAdminError('SESSION_INVALID');
  }
  return { sessionId: body.sessionId, deviceId: body.deviceId, presentedNonce: body.nonce };
}

function handleAdminError(c, error, logger) {
  if (error instanceof OmegaAdminError) {
    const status = {
      SESSION_INVALID: 401,
      DEVICE_REVOKED: 401,
      ACTION_NOT_ALLOWED: 403,
      RATE_LIMITED: 429,
      APPROVAL_EXPIRED: 409,
      ACCESS_DENIED: 403,
      NOT_SUPPORTED: 501,
      EXECUTION_FAILED: 502,
    }[error.code] ?? 400;
    return c.json({ error: error.code }, status);
  }
  logger?.warn?.({ error_message: error?.message }, 'OMEGA_ADMIN_ROUTE_UNEXPECTED_ERROR');
  return c.json({ error: 'internal_error' }, 500);
}

export function createOmegaAdminRoute({
  logger,
  transportPolicy = isOmegaTransportAllowed,
  isLocal = c => { try { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(getConnInfo(c).remote.address); } catch { return false; } },
} = {}) {
  const route = new Hono();

  route.use('/omega/admin/*', async (c, next) => {
    if (!transportPolicy(c)) {
      const transport = getOmegaTransportInfo(c);
      recordOmegaAudit('TLS_REMOTE_DENIED', {
        result: OMEGA_TLS_REQUIRED,
        detail: { loopback: transport.loopback, encrypted: transport.encrypted, surface: 'admin' },
      });
      return c.json({ error: OMEGA_TLS_REQUIRED }, 403);
    }
    await next();
  });
  route.use('/omega/admin/*', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  route.get('/omega/admin/status', (c) => {
    try { return c.json({ ok: true, ...getAdminStatus(queryAuth(c)) }); }
    catch (error) { return handleAdminError(c, error, logger); }
  });

  const readRoutes = [
    ['/system', 'GET_SYSTEM_INFO'],
    ['/processes', 'GET_PROCESS_LIST'],
    ['/services', 'GET_SERVICE_STATUS'],
    ['/network', 'GET_NETWORK_STATUS'],
    ['/disks', 'GET_DISK_STATUS'],
  ];
  for (const [suffix, action] of readRoutes) {
    route.get(`/omega/admin${suffix}`, async (c) => {
      try {
        const auth = queryAuth(c);
        const requestId = c.req.query('requestId');
        return c.json({ ok: true, ...await executeAdminReadAction({ ...auth, action, requestId: requestId || crypto.randomUUID() }) });
      } catch (error) { return handleAdminError(c, error, logger); }
    });
  }

  route.post('/omega/admin/actions', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }
    if (!isValidRequestId(body?.requestId)) return c.json({ error: 'ACTION_NOT_ALLOWED' }, 403);
    try {
      const result = await requestAdminAction({ ...bodyAuth(body), requestId: body.requestId, action: body.action, arguments: body.arguments });
      return c.json({ ok: true, ...result }, 202);
    } catch (error) { return handleAdminError(c, error, logger); }
  });

  route.get('/omega/admin/actions/:actionId', (c) => {
    if (!isValidActionId(c.req.param('actionId'))) return c.json({ error: 'ACTION_NOT_ALLOWED' }, 403);
    try { return c.json({ ok: true, ...getAdminActionStatus({ ...queryAuth(c), actionId: c.req.param('actionId') }) }); }
    catch (error) { return handleAdminError(c, error, logger); }
  });

  // These routes are deliberately local-only. The remote session/device is
  // not accepted as an approval credential; the local user is the approver.
  route.post('/omega/admin/actions/:actionId/approve-local', (c) => {
    if (!isLoopbackRequest(c, isLocal)) return c.json({ error: 'local_access_required' }, 403);
    try { return c.json({ ok: true, ...approveAdminActionLocally(c.req.param('actionId')) }); }
    catch (error) { return handleAdminError(c, error, logger); }
  });

  route.post('/omega/admin/actions/:actionId/deny-local', (c) => {
    if (!isLoopbackRequest(c, isLocal)) return c.json({ error: 'local_access_required' }, 403);
    try { return c.json({ ok: true, ...denyAdminActionLocally(c.req.param('actionId')) }); }
    catch (error) { return handleAdminError(c, error, logger); }
  });

  // Keep the closed lists referenced in the module so route/schema reviews
  // have one obvious source of truth and no UI/client field can expand them.
  void OMEGA_ADMIN_ACTIONS;
  void OMEGA_ADMIN_READ_ACTIONS;
  void OMEGA_ADMIN_HIGH_IMPACT_ACTIONS;
  return route;
}
