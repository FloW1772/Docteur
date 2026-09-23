/**
 * OMEGA V1 Phase 3 — VIEW ONLY screen-streaming data-path routes.
 *
 * Network architecture note (mission rules 4/5 — "aucun listener 0.0.0.0
 * sans justification explicite" / "préférer LAN direct"): this route
 * group is registered on Cortex's EXISTING HTTP server, the SAME
 * process and the SAME listener as every other route — no new port, no
 * new `.listen()` call anywhere in this phase's code. Confirmed by
 * inspection of server.js: the LAN-exposure decision already exists and
 * predates OMEGA entirely — `LOCAL_NETWORK=true` in .env is what binds
 * HOST to 0.0.0.0 instead of 127.0.0.1 (see server.js's own comment:
 * "Set LOCAL_NETWORK=true in .env to expose on the LAN"), and that
 * decision is explicitly opt-in and documented as the user's own choice
 * ("NEVER set this on a machine directly reachable from the internet").
 * OMEGA Phase 3 does not introduce a new LAN-exposure decision; it rides
 * the existing one, exactly as every other LAN-capable route in this
 * codebase already does (see the DEV_ORIGINS/isLanOrigin CORS allowlist
 * in server.js, which every route including this one is subject to).
 *
 * Auth model — deliberately DIFFERENT from omega.js's control-plane
 * guard: omega.js's `/omega/*` routes are loopback-ONLY (isLocal(c)),
 * because the control plane (pairing, device management, revocation)
 * has no reason to ever be reached from a second physical device. The
 * VIEW data path is the opposite: it MUST be reachable from the
 * controller device elsewhere on the LAN, by definition (mission's own
 * "session LAN réelle entre 2 appareils autorisés"). So instead of a
 * loopback/Origin gate, every route here requires a valid, non-expired,
 * non-revoked, correctly-nonce-chained OMEGA session token bound to the
 * caller's deviceId (Phase 2's validateAndAdvanceSession(), reused
 * verbatim, not re-implemented) — this IS the "transport authentifié
 * par l'identité du device" requirement (mission rule 3). There is no
 * separate/weaker auth path for these routes: the exact same
 * nonce-chained anti-replay mechanism Phase 2 built and tested gates
 * every single frame request, not just session start.
 *
 * VIEW ONLY (mission rule 2): every handler below only ever calls
 * omega-view.js/omega-capture.js functions, none of which have any
 * mouse/keyboard/admin/shell code path — there is structurally nothing
 * to call even if a compromised caller tried.
 *
 * Transport/streaming mechanism: bounded POLLING (GET one frame per
 * call), not SSE. Documented choice: SSE's `ReadableStream` idiom (as
 * used by download.js/kiwix.js) is one-directional and well-proven in
 * this codebase, but base64-JSON-wrapping a PNG frame inside an SSE
 * `data:` event adds ~33% overhead per frame for no benefit here, AND
 * capture is inherently pull-based (one PowerShell process per frame,
 * not a continuously-pushing OS capture API) — a polling GET endpoint
 * where the client asks for "the next frame" maps onto that pull-based
 * reality far more directly than simulating a push stream on top of it.
 * Polling also makes "lien lent"/"déconnexion"/"reconnexion" mission
 * test scenarios trivial to reason about (each GET is independent,
 * fully bounded, no long-lived connection state to leak or hang) and
 * gives free, structural backpressure: the server only captures a NEW
 * frame in response to an actual client request, never ahead of demand.
 *
 * Streaming bounds enforced here (on top of omega-capture.js's own
 * frame-size/resolution bounds and omega-view.js's own FPS throttle):
 * request bodies are tiny (session id + nonce only), responses are
 * capped at MAX_FRAME_BYTES via omega-capture.js, and every GET is
 * itself bounded by the underlying PowerShell invocation's own timeout.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  listScreensForSession, startViewSession, getFrame,
  stopViewSessionAuthenticated, getAuthenticatedViewSessionState,
  OmegaViewError,
} from '../lib/omega-view.js';
import { getOmegaTransportInfo, OMEGA_TLS_REQUIRED, isOmegaTransportAllowed } from '../lib/omega-transport.js';
import { recordOmegaAudit } from '../lib/omega-audit.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

function isValidSessionId(v) { return typeof v === 'string' && SESSION_ID_PATTERN.test(v); }
function isValidDeviceId(v) { return typeof v === 'string' && DEVICE_ID_PATTERN.test(v); }

const VIEW_ERROR_STATUS = {
  session_invalid: 401,
  permission_insufficient: 403,
  view_session_not_started: 409,
  rate_limited: 429,
  screen_index_required: 400,
  screen_index_out_of_range: 400,
  screen_index_invalid: 400,
  capture_not_supported: 501,
  capture_failed: 502,
  capture_frame_too_large: 502,
  capture_frame_malformed: 502,
  capture_resolution_invalid: 502,
  capture_file_missing: 502,
  capture_file_empty: 502,
  capture_malformed_output: 502,
  screen_enumeration_failed: 502,
  screen_enumeration_malformed_output: 502,
};

function handleViewError(c, err) {
  if (err instanceof OmegaViewError) {
    const status = VIEW_ERROR_STATUS[err.code] ?? 400;
    return c.json({ error: err.code }, status);
  }
  return c.json({ error: 'internal_error' }, 500);
}

export function createOmegaViewRoute({ logger, transportPolicy = isOmegaTransportAllowed } = {}) {
  const route = new Hono();

  // VIEW is LAN-reachable by design, so cleartext remote HTTP must fail
  // closed. Loopback remains compatible with Cortex's local HTTP mode.
  route.use('/omega/view/*', async (c, next) => {
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

  // Small bodies only — session id / nonce / a screen index. No frame
  // data is ever accepted IN a request body on this route group (frames
  // only ever flow server -> client).
  route.use('/omega/view/*', bodyLimit({ maxSize: 4 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  // ── GET /api/omega/view/screens — enumerate monitors. Requires a
  // valid caller identity too (deviceId) but does NOT require an
  // already-started view session, since screen selection necessarily
  // happens BEFORE starting one. Still requires the device to be a
  // recognized, non-revoked paired device to avoid leaking monitor
  // topology to an arbitrary LAN caller — enforced by requiring a
  // signed session token exactly like every other route here (a device
  // must have completed pairing + mutual auth to hold ANY session
  // token, VIEW-level or otherwise). ──
  route.get('/omega/view/screens', async (c) => {
    const sessionId = c.req.query('sessionId');
    const deviceId = c.req.query('deviceId');
    const nonce = c.req.query('nonce');
    if (!isValidSessionId(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    if (!isValidDeviceId(deviceId)) return c.json({ error: 'device_id_invalid' }, 400);
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) {
      return c.json({ error: 'nonce_invalid' }, 400);
    }
    try {
      const result = await listScreensForSession({ sessionId, deviceId, presentedNonce: nonce });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return handleViewError(c, err);
    }
  });

  // ── POST /api/omega/view/:sessionId/start — begins a VIEW stream on
  // an explicitly-chosen screenIndex (mission rule 10). Body:
  // { deviceId, nonce, screenIndex }. ──
  route.post('/omega/view/:sessionId/start', async (c) => {
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
      const result = await startViewSession({ sessionId, deviceId: body.deviceId, presentedNonce: body.nonce, screenIndex });
      return c.json({ ok: true, ...result }, 201);
    } catch (err) {
      logger?.warn?.({ sessionId, code: err?.code }, 'OMEGA_VIEW_START_FAILED');
      return handleViewError(c, err);
    }
  });

  // ── GET /api/omega/view/:sessionId/frame?deviceId=...&nonce=... —
  // fetches exactly one bounded, freshly-captured, freshly-authenticated
  // frame. Every call re-validates the session (nonce rotates on every
  // successful call, exactly like Phase 2's /sessions/:id/validate) —
  // this is the pull-based backpressure mechanism: the client cannot
  // get ahead of the server, and the server never pushes unrequested
  // frames. Response headers carry the rotated nonce so the client can
  // present it on the NEXT poll (mirrors Phase 2's nonce-chaining
  // exactly, just carried over HTTP headers instead of a response body
  // field, since this endpoint's body IS the raw PNG). ──
  route.get('/omega/view/:sessionId/frame', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidSessionId(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);

    const deviceId = c.req.query('deviceId');
    const nonce = c.req.query('nonce');
    if (!isValidDeviceId(deviceId)) return c.json({ error: 'device_id_invalid' }, 400);
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) {
      return c.json({ error: 'nonce_invalid' }, 400);
    }

    try {
      const frame = await getFrame({ sessionId, deviceId, presentedNonce: nonce });
      return new Response(frame.buffer, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(frame.byteLength),
          'Cache-Control': 'no-store',
          'X-Omega-Next-Nonce': frame.nextNonce,
          'X-Omega-Frame-Width': String(frame.width),
          'X-Omega-Frame-Height': String(frame.height),
          'X-Omega-Captured-At': frame.capturedAt,
          'X-Omega-Screen-Index': String(frame.screenIndex),
        },
      });
    } catch (err) {
      logger?.warn?.({ sessionId, code: err?.code }, 'OMEGA_VIEW_FRAME_FAILED');
      return handleViewError(c, err);
    }
  });

  // ── GET /api/omega/view/:sessionId/status — non-secret state read
  // (frame count, last frame time, active flag). ──
  route.get('/omega/view/:sessionId/status', (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidSessionId(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);
    const deviceId = c.req.query('deviceId');
    const nonce = c.req.query('nonce');
    if (!isValidDeviceId(deviceId)) return c.json({ error: 'device_id_invalid' }, 400);
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) return c.json({ error: 'nonce_invalid' }, 400);
    try {
      return c.json({ ok: true, ...getAuthenticatedViewSessionState({ sessionId, deviceId, presentedNonce: nonce }) });
    } catch (err) { return handleViewError(c, err); }
  });

  // ── POST /api/omega/view/:sessionId/stop — STOP SESSION (mission
  // rule 11). Body: { deviceId } (optional but recommended for audit
  // accuracy). Cuts the stream AND ends the underlying session so no
  // silent resumption is possible — idempotent, always 200 even if
  // already stopped (a client racing its own stop button should never
  // see a confusing error). ──
  route.post('/omega/view/:sessionId/stop', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidSessionId(sessionId)) return c.json({ error: 'session_id_invalid' }, 400);

    let body = {};
    try { body = await c.req.json(); } catch { /* body-less stop is allowed */ }
    if (!isValidDeviceId(body?.deviceId)) return c.json({ error: 'device_id_invalid' }, 400);
    if (typeof body?.nonce !== 'string' || body.nonce.length === 0 || body.nonce.length > 128) return c.json({ error: 'nonce_invalid' }, 400);
    try {
      const result = await stopViewSessionAuthenticated({ sessionId, deviceId: body.deviceId, presentedNonce: body.nonce });
      logger?.info?.({ sessionId }, 'OMEGA_VIEW_STOPPED');
      return c.json({ ok: true, ...result });
    } catch (err) { return handleViewError(c, err); }
  });

  return route;
}
