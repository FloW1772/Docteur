/**
 * OMEGA V1 Phase 2 — device identity + pairing + session API. Same
 * loopback-only control-plane guard shape as monitor.js/cyber-audit.js/
 * maitre.js — this control surface must never be reachable except from
 * the local machine (mission §25 — no network listener for the
 * control plane this phase). Every handler calls ONLY the omega-*.js
 * library modules — never maitre-*.js (mission §43, hard requirement:
 * zero imports from or calls into any maitre-*.js file anywhere in
 * this route or its dependencies).
 *
 * Phase 2 scope (mission's own objective list): identity, key storage,
 * pairing, mutual auth, revocation, session tokens, anti-replay, audit.
 * NOT in this phase, structurally absent from this file: screen
 * capture, mouse/keyboard injection, admin actions, shell, Windows
 * service, persistence, Internet relay. No route here ever calls
 * assertCloudAllowed() because no route here ever reaches a cloud
 * provider — LAN-direct/local-only for this entire surface (mission
 * §24), confirmed by inspection: every handler below only touches
 * omega-*.js modules and sqlite.js, no fetch()/http(s) client anywhere
 * in this file or its imports.
 */
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import {
  startPairing, verifyPairingCode, approvePairing, denyPairing, getPairing, listPairings,
  issueChallenge, verifyDeviceChallenge, OMEGA_PERMISSION_LEVELS,
  OmegaPairingError,
} from '../lib/omega-pairing.js';
import { listDevices, getDevice, revokeDevice, OmegaDeviceError } from '../lib/omega-devices.js';
import {
  createSession, validateAndAdvanceSession, endSession, getSession, OmegaSessionError,
} from '../lib/omega-session.js';
import { getDeviceKeyStatus } from '../lib/omega-identity.js';
import { listOmegaAuditLog } from '../lib/omega-audit.js';

const localAddress = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const PAIRING_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

function isValidDeviceId(v) { return typeof v === 'string' && DEVICE_ID_PATTERN.test(v); }
function isValidPairingId(v) { return typeof v === 'string' && PAIRING_ID_PATTERN.test(v); }
function isValidSessionId(v) { return typeof v === 'string' && SESSION_ID_PATTERN.test(v); }

export function createOmegaRoute({
  logger,
  isLocal = c => { try { return localAddress(getConnInfo(c).remote.address); } catch { return false; } },
} = {}) {
  const route = new Hono();

  // ── Loopback + Origin guard, identical shape to monitor.js's
  // established precedent (mission's own explicit instruction to reuse
  // this exact template). ──
  route.use('/omega/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: 'local_access_required' }, 403);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname)) return c.json({ error: 'host_denied' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        if (!['http:', 'https:'].includes(parsedOrigin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)) {
          return c.json({ error: 'origin_denied' }, 403);
        }
      } catch { return c.json({ error: 'origin_denied' }, 403); }
    }
    // Only routes that actually read a JSON body need the content-type
    // enforced — challenge/revoke/DELETE-session are body-less POST/
    // DELETE calls (mirrors monitor.js's own PUT-only enforcement,
    // widened here since OMEGA mixes body-having and body-less POSTs
    // rather than monitor.js's PUT-only body shape).
    const pathname = new URL(c.req.url).pathname;
    const isBodyLessRevoke = /^\/api\/omega\/devices\/[^/]+\/revoke$/.test(pathname);
    const isBodyLessDelete = c.req.method === 'DELETE';
    const requiresJsonBody = ['POST', 'PUT'].includes(c.req.method)
      && pathname !== '/api/omega/challenge'
      && !isBodyLessRevoke
      && !isBodyLessDelete;
    if (requiresJsonBody && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415);
    await next();
  });
  route.use('/omega/*', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  function handleKnownError(c, err, fallbackStatus = 400) {
    if (err instanceof OmegaPairingError || err instanceof OmegaDeviceError || err instanceof OmegaSessionError) {
      const rateLimited = err.code === 'pairing_creation_rate_limited' || err.code === 'pairing_attempts_exhausted';
      return c.json({ error: err.code }, rateLimited ? 429 : fallbackStatus);
    }
    logger?.warn?.({ error_message: err?.message }, 'OMEGA_ROUTE_UNEXPECTED_ERROR');
    return c.json({ error: 'internal_error' }, 500);
  }

  // ── GET /api/omega/status — no secrets, safe summary only. ──
  route.get('/omega/status', (c) => {
    const devices = listDevices();
    const pairings = listPairings();
    return c.json({
      ok: true,
      permissionLevels: OMEGA_PERMISSION_LEVELS,
      deviceCount: devices.length,
      activeDeviceCount: devices.filter(d => !d.revokedAt).length,
      pendingPairingCount: pairings.filter(p => p.status === 'PENDING' || p.status === 'AWAITING_APPROVAL').length,
      recentAudit: listOmegaAuditLog({ limit: 20 }),
    });
  });

  // ── GET /api/omega/devices — list, public shape only. ──
  route.get('/omega/devices', (c) => {
    return c.json({ ok: true, devices: listDevices() });
  });

  route.get('/omega/devices/:id', (c) => {
    const id = c.req.param('id');
    if (!isValidDeviceId(id)) return c.json({ error: 'device_id_invalid' }, 400);
    const device = getDevice(id);
    if (!device) return c.json({ error: 'device_not_found' }, 404);
    const { publicKeyPem, ...safe } = device;
    return c.json({ ok: true, device: safe, keyStatus: getDeviceKeyStatus(id) });
  });

  // ── POST /api/omega/pairing/start ──
  route.post('/omega/pairing/start', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }

    if (typeof body?.initiatorDeviceName !== 'string' || body.initiatorDeviceName.trim().length === 0) {
      return c.json({ error: 'device_name_invalid' }, 400);
    }
    if (body.initiatorDeviceName.length > 200) return c.json({ error: 'device_name_invalid' }, 400);

    const requestedPermission = Number(body?.requestedPermission);
    if (!Object.values(OMEGA_PERMISSION_LEVELS).includes(requestedPermission)) {
      return c.json({ error: 'requested_permission_invalid' }, 400);
    }

    try {
      const result = startPairing({ initiatorDeviceName: body.initiatorDeviceName, requestedPermission });
      return c.json({ ok: true, ...result }, 201);
    } catch (err) { return handleKnownError(c, err); }
  });

  // ── POST /api/omega/pairing/verify ──
  route.post('/omega/pairing/verify', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }

    if (!isValidPairingId(body?.pairingId)) return c.json({ error: 'pairing_id_invalid' }, 400);
    if (typeof body?.code !== 'string' || body.code.length === 0 || body.code.length > 64) return c.json({ error: 'code_format_invalid' }, 400);
    if (typeof body?.publicKeyPem !== 'string' || body.publicKeyPem.length === 0 || body.publicKeyPem.length > 4096) {
      return c.json({ error: 'public_key_required' }, 400);
    }

    try {
      const pairing = verifyPairingCode({ pairingId: body.pairingId, code: body.code, publicKeyPem: body.publicKeyPem });
      return c.json({ ok: true, pairing });
    } catch (err) { return handleKnownError(c, err); }
  });

  // ── POST /api/omega/pairing/approve — human confirmation gate
  // (mission §10/§11). ──
  route.post('/omega/pairing/approve', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }
    if (!isValidPairingId(body?.pairingId)) return c.json({ error: 'pairing_id_invalid' }, 400);

    try {
      const result = approvePairing(body.pairingId);
      return c.json({ ok: true, ...result });
    } catch (err) { return handleKnownError(c, err); }
  });

  route.post('/omega/pairing/deny', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }
    if (!isValidPairingId(body?.pairingId)) return c.json({ error: 'pairing_id_invalid' }, 400);

    try {
      const result = denyPairing(body.pairingId);
      return c.json({ ok: true, ...result });
    } catch (err) { return handleKnownError(c, err); }
  });

  route.get('/omega/pairing/:id', (c) => {
    const id = c.req.param('id');
    if (!isValidPairingId(id)) return c.json({ error: 'pairing_id_invalid' }, 400);
    const pairing = getPairing(id);
    if (!pairing) return c.json({ error: 'pairing_not_found' }, 404);
    return c.json({ ok: true, pairing });
  });

  // ── Challenge-response mutual auth (mission §12) — separate from
  // pairing/session creation so a caller can prove key possession
  // independent of minting a new session (e.g. a future re-auth flow). ──
  route.post('/omega/challenge', (c) => {
    return c.json({ ok: true, challenge: issueChallenge() });
  });

  // ── POST /api/omega/sessions — requires proof of key possession via
  // challenge-response (mutual auth, mission §12) before a session is
  // minted. Permission level is ALWAYS read server-side from the
  // device's record — never accepted from the request body. ──
  route.post('/omega/sessions', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }

    if (!isValidDeviceId(body?.deviceId)) return c.json({ error: 'device_id_invalid' }, 400);
    if (typeof body?.challenge !== 'string' || body.challenge.length === 0 || body.challenge.length > 256) {
      return c.json({ error: 'challenge_invalid' }, 400);
    }
    if (typeof body?.signature !== 'string' || body.signature.length === 0 || body.signature.length > 512) {
      return c.json({ error: 'signature_invalid' }, 400);
    }

    const authResult = verifyDeviceChallenge({ deviceId: body.deviceId, challenge: body.challenge, signatureB64: body.signature });
    if (!authResult.valid) {
      return c.json({ error: authResult.reason === 'device_not_found' ? 'device_not_found' : 'mutual_auth_failed' }, authResult.reason === 'device_not_found' ? 404 : 401);
    }

    try {
      const session = createSession({ deviceId: body.deviceId });
      return c.json({ ok: true, ...session }, 201);
    } catch (err) { return handleKnownError(c, err); }
  });

  route.get('/omega/sessions/:id', (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'session_id_invalid' }, 400);
    const session = getSession(id);
    if (!session) return c.json({ error: 'session_not_found' }, 404);
    return c.json({ ok: true, session });
  });

  // ── POST /api/omega/sessions/:id/validate — anti-replay nonce-chain
  // check (mission §16). Not in the mission's minimal route list
  // verbatim, but required to exercise/prove replay protection through
  // the API surface rather than only at the library layer; kept under
  // the /sessions/:id path family rather than a new top-level route. ──
  route.post('/omega/sessions/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'session_id_invalid' }, 400);
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }
    if (typeof body?.nonce !== 'string' || body.nonce.length === 0 || body.nonce.length > 128) {
      return c.json({ error: 'nonce_invalid' }, 400);
    }
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : undefined;

    const result = validateAndAdvanceSession({ sessionId: id, deviceId, presentedNonce: body.nonce });
    if (!result.valid) return c.json({ error: result.reason }, 401);
    return c.json({ ok: true, nextNonce: result.nextNonce, permissionLevel: result.permissionLevel });
  });

  // ── DELETE /api/omega/sessions/:id ──
  route.delete('/omega/sessions/:id', (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'session_id_invalid' }, 400);
    try {
      const ok = endSession(id);
      return c.json({ ok: true, ended: ok });
    } catch (err) { return handleKnownError(c, err, 404); }
  });

  // ── POST /api/omega/devices/:id/revoke ──
  route.post('/omega/devices/:id/revoke', (c) => {
    const id = c.req.param('id');
    if (!isValidDeviceId(id)) return c.json({ error: 'device_id_invalid' }, 400);
    try {
      const result = revokeDevice(id);
      logger?.info?.({ deviceId: id }, 'OMEGA_DEVICE_REVOKED');
      return c.json({ ok: true, ...result });
    } catch (err) { return handleKnownError(c, err, 404); }
  });

  return route;
}
