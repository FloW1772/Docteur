/**
 * OMEGA V1 Phase 4 — OMEGA_INTERACTIVE mouse/keyboard data-path routes.
 *
 * Same network/auth-model shape as Phase 3's routes/omega-view.js
 * (rides the existing HTTP server, no new listener/port; every route
 * requires a valid, non-expired, non-revoked, correctly-nonce-chained
 * OMEGA session bound to the caller's deviceId — validateAndAdvanceSession(),
 * reused verbatim) — registered as its own separate route group so a
 * VIEW-level session is structurally unable to reach ANY code path here
 * regardless of how routes are organized: every handler additionally
 * requires permissionLevel >= OMEGA_INTERACTIVE, read from the session
 * record only (omega-interactive.js's requireValidInteractiveSession()).
 *
 * Mission rule 1 ("VIEW reste strictement lecture seule"): this route
 * group is entirely separate from routes/omega-view.js — omega-view.js
 * was not modified to add input capability, and grepping it (done as
 * part of this phase's own test suite) confirms it still has zero
 * mouse/keyboard-shaped tokens.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  startInteractiveSession, submitInputBatch,
  stopInteractiveSessionAuthenticated, getAuthenticatedInteractiveSessionState,
  OmegaInteractiveError, MAX_EVENTS_PER_BATCH,
} from '../lib/omega-interactive.js';
import { getOmegaTransportInfo, OMEGA_TLS_REQUIRED, isOmegaTransportAllowed } from '../lib/omega-transport.js';
import { recordOmegaAudit } from '../lib/omega-audit.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

function isValidSessionId(v) { return typeof v === 'string' && SESSION_ID_PATTERN.test(v); }
function isValidDeviceId(v) { return typeof v === 'string' && DEVICE_ID_PATTERN.test(v); }

const INTERACTIVE_ERROR_STATUS = {
  session_invalid: 401,
  permission_insufficient: 403,
  interactive_session_not_started: 409,
  rate_limited: 429,
  screen_index_required: 400,
  screen_index_out_of_range: 400,
  screen_index_invalid: 400,
  batch_empty: 400,
  batch_too_large: 413,
  event_malformed: 400,
  event_type_invalid: 400,
  coords_invalid: 400,
  coords_out_of_bounds: 400,
  screen_bounds_unavailable: 400,
  vk_not_allowed: 400,
  wheel_delta_invalid: 400,
  screens_unavailable: 502,
  input_not_supported: 501,
};

function handleInteractiveError(c, err) {
  if (err instanceof OmegaInteractiveError) {
    const status = INTERACTIVE_ERROR_STATUS[err.code] ?? 400;
    return c.json({ error: err.code }, status);
  }
  return c.json({ error: 'internal_error' }, 500);
}

export function createOmegaInteractiveRoute({ logger, transportPolicy = isOmegaTransportAllowed } = {}) {
  const route = new Hono();

  // INTERACTIVE is LAN-reachable by design, so cleartext remote HTTP must
  // never reach session/input handlers. Loopback remains allowed for local
  // Cortex use.
  route.use('/omega/interactive/*', async (c, next) => {
    if (!transportPolicy(c)) {
      const transport = getOmegaTransportInfo(c);
      recordOmegaAudit('TLS_REMOTE_DENIED', {
        result: OMEGA_TLS_REQUIRED,
        detail: { loopback: transport.loopback, encrypted: transport.encrypted },
      });
      return c.json({ error: OMEGA_TLS_REQUIRED }, 403);
    }
    await next();
  });

  // Bounded body — a batch of at most MAX_EVENTS_PER_BATCH small
  // integer-tuple event objects comfortably fits well under this limit;
  // this bounds the mission's "oversized batch" attack at the HTTP
  // layer too, not just via the array-length check inside
  // omega-interactive.js/omega-input.js.
  route.use('/omega/interactive/*', bodyLimit({ maxSize: 8 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  // ── POST /api/omega/interactive/:sessionId/start — begins an
  // INTERACTIVE control session on an explicitly-chosen screenIndex.
  // Body: { deviceId, nonce, screenIndex }. ──
  route.post('/omega/interactive/:sessionId/start', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidSessionId(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);

    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }

    if (!isValidDeviceId(body?.deviceId)) return c.json({ error: 'device_id_invalid' }, 400);
    if (typeof body?.nonce !== 'string' || body.nonce.length === 0 || body.nonce.length > 128) {
      return c.json({ error: 'nonce_invalid' }, 400);
    }
    const screenIndex = Number(body?.screenIndex);
    if (!Number.isInteger(screenIndex) || screenIndex < 0) {
      return c.json({ error: 'screen_index_invalid' }, 400);
    }

    try {
      const result = await startInteractiveSession({ sessionId, deviceId: body.deviceId, presentedNonce: body.nonce, screenIndex });
      return c.json({ ok: true, ...result }, 201);
    } catch (err) {
      logger?.warn?.({ sessionId, code: err?.code }, 'OMEGA_INTERACTIVE_START_FAILED');
      return handleInteractiveError(c, err);
    }
  });

  // ── POST /api/omega/interactive/:sessionId/input — submits a bounded
  // batch (<= MAX_EVENTS_PER_BATCH) of mouse/keyboard events. Body:
  // { deviceId, nonce, screenIndex, events: [...] }. Every event is
  // validated against the vk-code/coordinate allowlists before ANY are
  // sent; the response reports the honest sent/requested count (UIPI
  // may silently reduce sent < requested — never assumed successful). ──
  route.post('/omega/interactive/:sessionId/input', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidSessionId(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);

    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }

    if (!isValidDeviceId(body?.deviceId)) return c.json({ error: 'device_id_invalid' }, 400);
    if (typeof body?.nonce !== 'string' || body.nonce.length === 0 || body.nonce.length > 128) {
      return c.json({ error: 'nonce_invalid' }, 400);
    }
    const screenIndex = Number(body?.screenIndex);
    if (!Number.isInteger(screenIndex) || screenIndex < 0) {
      return c.json({ error: 'screen_index_invalid' }, 400);
    }
    if (!Array.isArray(body?.events)) return c.json({ error: 'events_invalid' }, 400);
    if (body.events.length > MAX_EVENTS_PER_BATCH) return c.json({ error: 'batch_too_large' }, 413);

    try {
      const result = await submitInputBatch({
        sessionId, deviceId: body.deviceId, presentedNonce: body.nonce,
        screenIndex, events: body.events,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger?.warn?.({ sessionId, code: err?.code }, 'OMEGA_INTERACTIVE_INPUT_FAILED');
      return handleInteractiveError(c, err);
    }
  });

  // ── GET /api/omega/interactive/:sessionId/status — non-secret state
  // read (event count, last event time, active flag). ──
  route.get('/omega/interactive/:sessionId/status', (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidSessionId(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const deviceId = c.req.query('deviceId');
    const nonce = c.req.query('nonce');
    if (!isValidDeviceId(deviceId)) return c.json({ error: 'device_id_invalid' }, 400);
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) return c.json({ error: 'nonce_invalid' }, 400);
    try {
      return c.json({ ok: true, ...getAuthenticatedInteractiveSessionState({ sessionId, deviceId, presentedNonce: nonce }) });
    } catch (err) { return handleInteractiveError(c, err); }
  });

  // ── POST /api/omega/interactive/:sessionId/stop — STOP SESSION
  // (mission rule 11). Body: { deviceId } (optional). Cuts INTERACTIVE
  // capability AND ends the underlying session so no silent resumption
  // is possible — idempotent, always 200. ──
  route.post('/omega/interactive/:sessionId/stop', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidSessionId(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);

    let body = {};
    try { body = await c.req.json(); } catch { /* body-less stop is allowed */ }
    if (!isValidDeviceId(body?.deviceId)) return c.json({ error: 'device_id_invalid' }, 400);
    if (typeof body?.nonce !== 'string' || body.nonce.length === 0 || body.nonce.length > 128) return c.json({ error: 'nonce_invalid' }, 400);
    try {
      const result = await stopInteractiveSessionAuthenticated({ sessionId, deviceId: body.deviceId, presentedNonce: body.nonce });
      logger?.info?.({ sessionId }, 'OMEGA_INTERACTIVE_STOPPED');
      return c.json({ ok: true, ...result });
    } catch (err) { return handleInteractiveError(c, err); }
  });

  return route;
}
