/**
 * OMEGA V1 Phase 4 — OMEGA_INTERACTIVE mouse/keyboard control-session
 * orchestration.
 *
 * Builds on Phase 2's session layer (omega-session.js) AND Phase 3's
 * screen enumeration (omega-capture.js's listScreens(), reused verbatim,
 * unmodified) — this module never mints its own authentication
 * credential and never re-derives screen bounds independently. An
 * INTERACTIVE control session can only be started against an
 * already-valid omega_sessions row, and every input batch re-validates
 * that session via validateAndAdvanceSession() (nonce-chained
 * anti-replay, live device-revocation check, expiry check) — the exact
 * same mechanism Phase 3's VIEW path uses, no separate/weaker auth path.
 *
 * INTERACTIVE-or-higher enforcement (mission rule 2/3 — "seule une
 * session INTERACTIVE valide peut injecter input", "permission lue
 * côté serveur depuis la session, jamais depuis le client"):
 * startInteractiveSession()/sendInputBatch() both check
 * `session.permissionLevel >= OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE`,
 * read from the SESSION RECORD returned by validateAndAdvanceSession() —
 * never from any client-supplied field. A VIEW-level session
 * (permissionLevel === 1) fails this check exactly like an
 * under-permissioned session failed VIEW's own gate in Phase 3 — the
 * same mechanism, one level higher.
 *
 * Bounds/rate limits (mission's own list, mirrors Phase 3's streaming
 * bounds discipline but for the input path): MAX_EVENTS_PER_BATCH and
 * MAX_REQUESTS_PER_SECOND are enforced in omega-input.js (event/coord
 * validation) and HERE (per-session request-rate throttle, same
 * in-process Map pattern as omega-view.js's lastFrameServedAt).
 */
import { validateAndAdvanceSession, endSession } from './omega-session.js';
import { OMEGA_PERMISSION_LEVELS } from './omega-pairing.js';
import * as realInput from './omega-input.js';
import { validateInputEvent, sendInputBatch as realSendInputBatch, MAX_EVENTS_PER_BATCH, MIN_REQUEST_INTERVAL_MS, OmegaInputError } from './omega-input.js';
import { listScreens as realListScreens, showSessionIndicator as realShowSessionIndicator } from './omega-capture.js';
import { recordOmegaAudit } from './omega-audit.js';
import * as db from './sqlite.js';

// Injectable provider (mirrors omega-view.js's _setCaptureProviderForTests
// pattern exactly) — defaults to the REAL SendInput-backed implementation.
// Production code (the route layer) never overrides this.
let inputProvider = {
  sendInputBatch: realSendInputBatch,
  listScreens: realListScreens,
  showSessionIndicator: realShowSessionIndicator,
};

export function _setInputProviderForTests(overrides) {
  inputProvider = { ...inputProvider, ...overrides };
}

export function _resetInputProviderForTests() {
  inputProvider = {
    sendInputBatch: realSendInputBatch,
    listScreens: realListScreens,
    showSessionIndicator: realShowSessionIndicator,
  };
}

export class OmegaInteractiveError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'OmegaInteractiveError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OmegaInteractiveError(code, detail);
}

// In-process per-session request-rate throttle (mission's "rate limits"
// requirement) — same rationale/pattern as omega-view.js's
// lastFrameServedAt: single-user local/LAN control plane, in-process is
// sufficient, resets harmlessly on Cortex restart.
const lastRequestAt = new Map();
const THROTTLE_RETENTION_MS = 60_000;

function pruneInteractiveThrottle(now = Date.now()) {
  for (const [sessionId, lastAt] of lastRequestAt) {
    if (now - lastAt > THROTTLE_RETENTION_MS) lastRequestAt.delete(sessionId);
  }
}

export function _resetInteractiveThrottleForTests() {
  lastRequestAt.clear();
}

/**
 * Re-validates the session (nonce-chained anti-replay + live
 * revocation/expiry checks) AND enforces INTERACTIVE-or-higher
 * permission, read from the validated session record only. Throws
 * OmegaInteractiveError on any failure. This is the mission's core
 * enforcement point: "VIEW tente mouse/keyboard -> refus".
 */
function requireValidInteractiveSession({ sessionId, deviceId, presentedNonce }) {
  const result = validateAndAdvanceSession({ sessionId, deviceId, presentedNonce });
  if (!result.valid) fail('session_invalid', { reason: result.reason });

  if (result.permissionLevel < OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE) {
    recordOmegaAudit('INTERACTIVE_PERMISSION_DENIED', {
      sessionId, deviceId: result.session.deviceId, result: 'insufficient_permission',
      detail: { permissionLevel: result.permissionLevel },
    });
    fail('permission_insufficient');
  }
  return result;
}

/**
 * Starts an INTERACTIVE control session: validates the session +
 * INTERACTIVE permission, records the row, shows the mandatory visible
 * indicator "OMEGA — INTERACTIVE CONTROL ACTIVE" (mission rule 14) on
 * the controlled machine. Requires an explicit screenIndex (mirrors
 * Phase 3's "no default, no silent fallback" discipline) so mouse
 * coordinates have a known reference frame from the first input event.
 */
export async function startInteractiveSession({ sessionId, deviceId, presentedNonce, screenIndex }) {
  if (!Number.isInteger(screenIndex) || screenIndex < 0) fail('screen_index_required');

  const validated = requireValidInteractiveSession({ sessionId, deviceId, presentedNonce });

  const screens = await inputProvider.listScreens();
  if (screenIndex >= screens.length) fail('screen_index_out_of_range', { screenIndex, available: screens.length });

  const existing = db.getOmegaInteractiveSession(sessionId);
  if (!existing) {
    db.insertOmegaInteractiveSession({ session_id: sessionId, device_id: validated.session.deviceId });
  }

  recordOmegaAudit('INTERACTIVE_STARTED', {
    sessionId, deviceId: validated.session.deviceId, result: 'started',
    detail: { screenIndex, screenCount: screens.length },
  });

  // Mandatory visible indicator (mission rule 14) — best-effort, same
  // documented tradeoff as Phase 3: its own failure does not block
  // session start, but a genuine failure is observable via the returned
  // indicatorShown flag and logs, never silently swallowed.
  const indicator = await inputProvider.showSessionIndicator(
    'interactive_start', sessionId, validated.session.deviceId, validated.session.expiresAt,
    () => stopInteractiveSession({ sessionId, deviceId: validated.session.deviceId }),
  )
    .catch(err => ({ ok: false, reason: 'indicator_threw', detail: err?.message }));

  return { nextNonce: validated.nextNonce, screenIndex, screens, indicatorShown: !!indicator?.ok };
}

/**
 * Injects a bounded batch of already-schema-shaped input events.
 * Re-validates the session on EVERY call (no separate weaker auth path),
 * enforces the per-session request-rate throttle, validates EVERY event
 * in the batch against the vk-code/coordinate allowlists (omega-input.js)
 * BEFORE sending ANY of them (fail-closed on the whole batch if one
 * event is malformed — never partially execute a batch that contains a
 * disallowed event), then sends via SendInput and returns the honest
 * "N of M sent" result (UIPI may cause sent < requested even for a
 * fully valid, fully authorized batch — this is surfaced, not hidden).
 */
export async function submitInputBatch({ sessionId, deviceId, presentedNonce, events, screenIndex }) {
  const validated = requireValidInteractiveSession({ sessionId, deviceId, presentedNonce });

  const interactiveSession = db.getOmegaInteractiveSession(sessionId);
  if (!interactiveSession || interactiveSession.stopped_at) fail('interactive_session_not_started');

  const now = Date.now();
  pruneInteractiveThrottle(now);
  const last = lastRequestAt.get(sessionId) ?? 0;
  if (now - last < MIN_REQUEST_INTERVAL_MS) {
    recordOmegaAudit('INTERACTIVE_RATE_LIMITED', { sessionId, deviceId: validated.session.deviceId, result: 'rate_limited' });
    fail('rate_limited', { retryAfterMs: MIN_REQUEST_INTERVAL_MS - (now - last) });
  }

  if (!Array.isArray(events) || events.length === 0) fail('batch_empty');
  if (events.length > MAX_EVENTS_PER_BATCH) {
    recordOmegaAudit('INTERACTIVE_INPUT_REJECTED', {
      sessionId, deviceId: validated.session.deviceId, result: 'batch_too_large',
      detail: { size: events.length, max: MAX_EVENTS_PER_BATCH },
    });
    fail('batch_too_large', { size: events.length, max: MAX_EVENTS_PER_BATCH });
  }

  const screens = await inputProvider.listScreens();
  if (!Number.isInteger(screenIndex) || screenIndex < 0 || screenIndex >= screens.length) {
    fail('screen_index_invalid', { screenIndex });
  }

  // Validate EVERY event before sending ANY (fail-closed on the whole
  // batch — mission rule 9's "input injection bornée et allowlistée"
  // applies to the batch as a unit, not best-effort per-event).
  let tuples;
  try {
    tuples = events.map(evt => validateInputEvent(evt, { screens, screenIndex }));
  } catch (err) {
    recordOmegaAudit('INTERACTIVE_INPUT_REJECTED', {
      sessionId, deviceId: validated.session.deviceId, result: err.code ?? 'event_invalid',
    });
    // Keep the route-facing error contract at the orchestration boundary.
    // The input validator deliberately owns the detailed allowlist/bounds
    // checks, but callers of this module must receive an
    // OmegaInteractiveError so the HTTP layer can map these failures to
    // their intended 4xx status instead of leaking them as 500s.
    if (err instanceof OmegaInputError) {
      throw new OmegaInteractiveError(err.code, err.detail);
    }
    throw err;
  }

  lastRequestAt.set(sessionId, Date.now());

  const outcome = await inputProvider.sendInputBatch(tuples);
  db.recordOmegaInteractiveEvents(sessionId, events.length);

  return { ...outcome, nextNonce: validated.nextNonce };
}

/**
 * STOP SESSION (mission rule 11): cuts INTERACTIVE capability
 * immediately (marks the row stopped so submitInputBatch() refuses
 * further events even if the underlying omega_sessions row were somehow
 * still valid), and — same stronger guarantee as Phase 3's VIEW STOP —
 * ends the underlying OMEGA session itself so no silent resumption is
 * possible. Idempotent.
 */
export async function stopInteractiveSession({ sessionId, deviceId }) {
  const interactiveSession = db.getOmegaInteractiveSession(sessionId);
  const wasRunning = !!interactiveSession && !interactiveSession.stopped_at;

  if (interactiveSession) db.stopOmegaInteractiveSession(sessionId);
  lastRequestAt.delete(sessionId);

  let sessionEnded = false;
  try { sessionEnded = endSession(sessionId); } catch { /* already ended/not found — fine, idempotent STOP */ }

  recordOmegaAudit('INTERACTIVE_STOPPED', {
    sessionId, deviceId: deviceId ?? interactiveSession?.device_id ?? null,
    result: wasRunning ? 'stopped' : 'was_not_running',
  });

  await inputProvider.showSessionIndicator(
    'interactive_stop', sessionId, deviceId ?? interactiveSession?.device_id ?? null,
  ).catch(() => {});

  return { sessionId, interactiveStopped: wasRunning, sessionEnded };
}

/** Remote STOP must prove possession of the live session nonce. */
export async function stopInteractiveSessionAuthenticated({ sessionId, deviceId, presentedNonce }) {
  requireValidInteractiveSession({ sessionId, deviceId, presentedNonce });
  return stopInteractiveSession({ sessionId, deviceId });
}

export function getInteractiveSessionState(sessionId) {
  const row = db.getOmegaInteractiveSession(sessionId);
  if (!row) return null;
  return {
    sessionId: row.session_id,
    deviceId: row.device_id,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    lastEventAt: row.last_event_at,
    eventCount: row.event_count,
    active: !row.stopped_at,
  };
}

export function getAuthenticatedInteractiveSessionState({ sessionId, deviceId, presentedNonce }) {
  const validated = requireValidInteractiveSession({ sessionId, deviceId, presentedNonce });
  const state = getInteractiveSessionState(sessionId);
  if (!state || state.deviceId !== validated.session.deviceId) fail('interactive_session_not_started');
  return { state, nextNonce: validated.nextNonce };
}

export { MAX_EVENTS_PER_BATCH, MIN_REQUEST_INTERVAL_MS };
