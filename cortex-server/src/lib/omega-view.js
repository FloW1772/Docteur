/**
 * OMEGA V1 Phase 3 — VIEW ONLY screen-viewing session orchestration.
 *
 * Builds on Phase 2's session layer (omega-session.js) — this module
 * never mints its own authentication credential. A VIEW stream can only
 * be started against an already-valid omega_sessions row, and every
 * frame request re-validates that session via
 * validateAndAdvanceSession() (nonce-chained anti-replay, live
 * device-revocation check, expiry check) — there is no separate,
 * weaker auth path for the streaming route (mission's own "transport
 * authentifié/chiffré" requirement, "no separate weaker auth path for
 * the fun streaming route").
 *
 * VIEW-only enforcement (mission rule 2 — "Une session VIEW ne peut
 * injecter aucun input"): startViewSession()/getFrame() both check
 * `session.permissionLevel >= OMEGA_PERMISSION_LEVELS.OMEGA_VIEW`, read
 * from the SESSION RECORD returned by validateAndAdvanceSession() —
 * never from any client-supplied field. There is structurally no mouse/
 * keyboard/admin code path anywhere in this file or anything it calls;
 * omega-capture.js has no input-injection function to call even if a
 * caller wanted to.
 *
 * Multi-monitor (mission rule 10): startViewSession() REQUIRES an
 * explicit screenIndex argument — there is no default, no "capture
 * every screen", no silent fallback to screen 0 if omitted.
 *
 * Streaming bounds (mission rule 9): FPS is bounded by refusing a frame
 * request that arrives sooner than MIN_FRAME_INTERVAL_MS after the
 * previous one for the SAME session (server-side enforced, not
 * trusting the client to self-throttle) — this is the "backpressure"
 * mechanism: a fast poller gets 429-equivalent throttling rather than
 * triggering unbounded concurrent PowerShell captures. Frame size and
 * resolution bounds are enforced inside omega-capture.js itself.
 */
import { validateAndAdvanceSession, endSession } from './omega-session.js';
import { OMEGA_PERMISSION_LEVELS } from './omega-pairing.js';
import * as realCapture from './omega-capture.js';
import { MIN_FRAME_INTERVAL_MS, OmegaCaptureError } from './omega-capture.js';
import { recordOmegaAudit } from './omega-audit.js';
import * as db from './sqlite.js';

// Injectable capture provider (mirrors the isLocal-injection pattern
// used by omega.js/monitor.js) — defaults to the REAL PowerShell-backed
// implementation. Tests running on a non-Windows CI box, or tests that
// want to exercise many scenarios (oversized frame, malformed frame,
// slow link, crash) without spawning real PowerShell processes for
// every case, inject a fake { captureFrame, listScreens,
// showSessionIndicator } here instead. Production code (the route
// layer) never overrides this — it always gets the real capture module.
let captureProvider = {
  captureFrame: realCapture.captureFrame,
  listScreens: realCapture.listScreens,
  showSessionIndicator: realCapture.showSessionIndicator,
};

export function _setCaptureProviderForTests(overrides) {
  captureProvider = { ...captureProvider, ...overrides };
}

export function _resetCaptureProviderForTests() {
  captureProvider = {
    captureFrame: realCapture.captureFrame,
    listScreens: realCapture.listScreens,
    showSessionIndicator: realCapture.showSessionIndicator,
  };
}

export class OmegaViewError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'OmegaViewError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OmegaViewError(code, detail);
}

// In-process throttle tracking: sessionId -> last frame serve timestamp
// (ms). Deliberately in-process, same rationale as Phase 2's rate
// limiters (mission §25 framing — single-user local/LAN control plane,
// not an Internet-facing service). Reset on Cortex restart, which is
// harmless here (worst case: one extra frame allowed sooner than ideal
// right after a restart).
const lastFrameServedAt = new Map();

export function _resetViewThrottleForTests() {
  lastFrameServedAt.clear();
}

/**
 * Re-validates the session (nonce-chained anti-replay + live
 * revocation/expiry checks, exactly Phase 2's mechanism) AND enforces
 * VIEW-or-higher permission, read from the validated session record
 * only. Throws OmegaViewError on any failure; never returns a session
 * object for a VIEW-insufficient or invalid session.
 */
function requireValidViewSession({ sessionId, deviceId, presentedNonce }) {
  const result = validateAndAdvanceSession({ sessionId, deviceId, presentedNonce });
  if (!result.valid) fail('session_invalid', { reason: result.reason });

  if (result.permissionLevel < OMEGA_PERMISSION_LEVELS.OMEGA_VIEW) {
    recordOmegaAudit('VIEW_PERMISSION_DENIED', { sessionId, deviceId: result.session.deviceId, result: 'insufficient_permission' });
    fail('permission_insufficient');
  }
  return result;
}

/**
 * Enumerates monitors only after the same device-bound, nonce-chained
 * authentication used by every other VIEW operation. Screen selection occurs
 * before a VIEW stream starts, but it must not disclose monitor topology to an
 * unauthenticated LAN caller.
 */
export async function listScreensForSession({ sessionId, deviceId, presentedNonce }) {
  const validated = requireValidViewSession({ sessionId, deviceId, presentedNonce });
  const screens = await captureProvider.listScreens();
  return { screens, nextNonce: validated.nextNonce };
}

/**
 * Starts a VIEW stream: validates the session + permission, records the
 * EXPLICITLY-chosen screenIndex (mission rule 10 — no default), shows
 * the mandatory visible indicator on the controlled machine (mission
 * rule 12), and writes an omega_view_sessions row. Does NOT itself
 * capture a frame — the caller fetches frames via getFrame().
 */
export async function startViewSession({ sessionId, deviceId, presentedNonce, screenIndex }) {
  if (!Number.isInteger(screenIndex) || screenIndex < 0) fail('screen_index_required');

  const validated = requireValidViewSession({ sessionId, deviceId, presentedNonce });

  const screens = await captureProvider.listScreens();
  if (screenIndex >= screens.length) fail('screen_index_out_of_range', { screenIndex, available: screens.length });

  const existing = db.getOmegaViewSession(sessionId);
  if (!existing) {
    db.insertOmegaViewSession({ session_id: sessionId, device_id: validated.session.deviceId, screen_index: screenIndex });
  }

  recordOmegaAudit('VIEW_STARTED', {
    sessionId, deviceId: validated.session.deviceId, result: 'started',
    detail: { screenIndex, screenCount: screens.length },
  });

  // Visible indicator (mission rule 12) — awaited so a genuine failure
  // to show it is observable, but its own failure does not itself
  // block/abort the VIEW session (a missing balloon-tip API on a
  // locked-down machine shouldn't be a hard-fail for VIEW capability;
  // the requirement is "best-effort genuinely visible", not "session
  // cannot start without it" — documented tradeoff in the Phase 3 report).
  const indicator = await captureProvider.showSessionIndicator(
    'start', sessionId, validated.session.deviceId, validated.session.expiresAt,
    () => stopViewSession({ sessionId, deviceId: validated.session.deviceId }),
  ).catch(err => ({ ok: false, reason: 'indicator_threw', detail: err?.message }));

  return { nextNonce: validated.nextNonce, screenIndex, screens, indicatorShown: !!indicator?.ok };
}

/**
 * Fetches exactly one bounded, authenticated frame. Re-validates the
 * session on EVERY call (mission's "no separate weaker auth path")
 * and enforces the FPS ceiling server-side (mission rule 9 —
 * backpressure/bounds). Returns { buffer, width, height, capturedAt,
 * nextNonce } or throws OmegaViewError with a specific code:
 *   - session_invalid       (expired/revoked/replayed/wrong device)
 *   - permission_insufficient
 *   - view_session_not_started (startViewSession was never called)
 *   - rate_limited           (polled faster than MAX_FPS allows)
 *   - capture_failed / capture_frame_too_large / capture_frame_malformed
 *     / capture_resolution_invalid (bubbled up from omega-capture.js)
 */
export async function getFrame({ sessionId, deviceId, presentedNonce }) {
  const validated = requireValidViewSession({ sessionId, deviceId, presentedNonce });

  const viewSession = db.getOmegaViewSession(sessionId);
  if (!viewSession || viewSession.stopped_at) fail('view_session_not_started');

  const now = Date.now();
  const last = lastFrameServedAt.get(sessionId) ?? 0;
  if (now - last < MIN_FRAME_INTERVAL_MS) {
    fail('rate_limited', { retryAfterMs: MIN_FRAME_INTERVAL_MS - (now - last) });
  }

  try {
    const frame = await captureProvider.captureFrame(viewSession.screen_index);
    lastFrameServedAt.set(sessionId, Date.now());
    db.recordOmegaViewFrame(sessionId, { width: frame.width, height: frame.height });
    return { ...frame, nextNonce: validated.nextNonce, screenIndex: viewSession.screen_index };
  } catch (err) {
    if (err instanceof OmegaCaptureError) {
      recordOmegaAudit('VIEW_FRAME_REJECTED', {
        sessionId, deviceId: validated.session.deviceId, result: err.code,
      });
      fail(err.code, err.detail);
    }
    throw err;
  }
}

/**
 * STOP SESSION (mission rule 11): cuts the stream (marks the view
 * session stopped so getFrame() refuses further frames even if the
 * underlying omega_sessions row were somehow still valid), and — the
 * mission's stronger requirement — also ends the underlying OMEGA
 * session itself so NO silent resumption is possible: a stopped VIEW
 * session cannot be revived by simply calling startViewSession() again
 * with the same sessionId, because the session credential itself is
 * gone (endSession() marks omega_sessions.ended_at, and
 * validateAndAdvanceSession() fails closed on an ended session).
 */
export async function stopViewSession({ sessionId, deviceId }) {
  const viewSession = db.getOmegaViewSession(sessionId);
  const wasRunning = !!viewSession && !viewSession.stopped_at;

  if (viewSession) db.stopOmegaViewSession(sessionId);

  // Ending the underlying session is what actually prevents silent
  // resumption (mission rule 11's strongest clause) — omega-session.js
  // has no import back into this file, so no circular-import concern.
  let sessionEnded = false;
  try { sessionEnded = endSession(sessionId); } catch { /* already ended/not found — fine, idempotent STOP */ }

  recordOmegaAudit('VIEW_STOPPED', {
    sessionId, deviceId: deviceId ?? viewSession?.device_id ?? null,
    result: wasRunning ? 'stopped' : 'was_not_running',
  });

  await captureProvider.showSessionIndicator('stop', sessionId, deviceId ?? viewSession?.device_id ?? null).catch(() => {});

  return { sessionId, viewStopped: wasRunning, sessionEnded };
}

/** Remote STOP must prove possession of the live session nonce. */
export async function stopViewSessionAuthenticated({ sessionId, deviceId, presentedNonce }) {
  requireValidViewSession({ sessionId, deviceId, presentedNonce });
  return stopViewSession({ sessionId, deviceId });
}

export function getViewSessionState(sessionId) {
  const row = db.getOmegaViewSession(sessionId);
  if (!row) return null;
  return {
    sessionId: row.session_id,
    deviceId: row.device_id,
    screenIndex: row.screen_index,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    lastFrameAt: row.last_frame_at,
    lastFrameWidth: row.last_frame_width,
    lastFrameHeight: row.last_frame_height,
    frameCount: row.frame_count,
    active: !row.stopped_at,
  };
}

export function getAuthenticatedViewSessionState({ sessionId, deviceId, presentedNonce }) {
  const validated = requireValidViewSession({ sessionId, deviceId, presentedNonce });
  const state = getViewSessionState(sessionId);
  if (!state || state.deviceId !== validated.session.deviceId) fail('view_session_not_started');
  return { state, nextNonce: validated.nextNonce };
}

export { MIN_FRAME_INTERVAL_MS };
