/**
 * OMEGA V1 Phase 2 — session tokens + binding + anti-replay.
 *
 * A session token is NOT the pairing code reused (mission §14) — it is
 * a fresh, unguessable, short-lived credential (sessionId, itself a
 * crypto.randomUUID, opaque to the client) tied to exactly one
 * (deviceId, permissionLevel) pair established at creation time and
 * never mutated afterward (mission §15 — "un token VIEW ne peut pas
 * devenir INTERACTIVE").
 *
 * Anti-replay (mission §16): each session carries a server-generated
 * nonce at creation. Every subsequent use of the session must present
 * the PREVIOUS nonce (proving it saw the last server response) and
 * receives a freshly rotated nonce in return (classic synchronizer-
 * token / one-time-nonce chaining) — replaying an old request with a
 * stale nonce is rejected, and replaying the exact same request twice
 * fails on the second attempt because the nonce has already advanced.
 * This is deliberately simple (no sequence counters, no external clock
 * dependency) and composes with the session's own short TTL as a second
 * layer of "session freshness" per the mission's own suggested
 * mitigation shape (§16: "protection native du transport complétée par
 * session freshness").
 */
import crypto from 'node:crypto';
import * as db from './sqlite.js';
import { recordOmegaAudit } from './omega-audit.js';
import { notifyOmegaAdminSessionEnded } from './omega-admin-registry.js';
import { stopPersistentIndicator } from './omega-indicator.js';

export class OmegaSessionError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'OmegaSessionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OmegaSessionError(code, detail);
}

// Short-lived by design (mission §14) — fixed server-side, not
// configurable from the frontend in V1.
const SESSION_TTL_MS = 15 * 60_000; // 15 minutes

function parseSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceId: row.device_id,
    permissionLevel: row.permission_level,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    revokedAt: row.revoked_at,
    // nonce/last_used_nonce deliberately excluded from any external
    // shape — anti-replay material, not for display.
  };
}

function isSessionRowLive(row, nowIso = new Date().toISOString()) {
  if (!row) return false;
  if (row.ended_at) return false;
  if (row.revoked_at) return false;
  if (row.expires_at < nowIso) return false;
  return true;
}

/**
 * Creates a new session for a device that has JUST proven possession
 * of its private key via omega-pairing.js's verifyDeviceChallenge()
 * (mission §12 — mutual auth happens before a session is ever minted,
 * this function does not itself re-verify a signature; callers are
 * responsible for calling verifyDeviceChallenge() first — see
 * omega.js route for the actual call order). Permission level is
 * ALWAYS read from the device's server-recorded ceiling — never from
 * a client-supplied field (mission §11/§15, mirrors MAÎTRE's
 * ACTION_LEVELS discipline).
 */
export function createSession({ deviceId }) {
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) fail('device_id_required');

  const device = db.getOmegaDeviceById(deviceId);
  if (!device) fail('device_not_found');
  if (device.revoked_at) {
    recordOmegaAudit('SESSION_CREATED', { deviceId, result: 'denied_device_revoked' });
    fail('device_revoked');
  }

  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();

  db.insertOmegaSession({
    id, device_id: deviceId, permission_level: device.permission_level,
    nonce, expires_at: expiresAt,
  });

  recordOmegaAudit('SESSION_CREATED', { deviceId, sessionId: id, result: 'created', detail: { permissionLevel: device.permission_level } });

  // The initial nonce is returned exactly once here — it is the first
  // "previous nonce" the caller must present on its next call.
  return { sessionId: id, deviceId, permissionLevel: device.permission_level, expiresAt, nonce };
}

/**
 * Validates a session for use: not ended, not revoked, not expired,
 * device not revoked (checked live, not cached — mission §18), AND the
 * presented previousNonce matches what the server has on record. On
 * success, rotates the nonce and returns the new one. On any failure,
 * returns { valid: false, reason } and — for a nonce mismatch
 * specifically — logs REPLAY_REJECTED (mission §16/§20).
 */
export function validateAndAdvanceSession({ sessionId, deviceId, presentedNonce }) {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return { valid: false, reason: 'session_id_required' };

  const row = db.getOmegaSessionById(sessionId);
  if (!row) return { valid: false, reason: 'session_not_found' };

  // Device binding (mission §15/T6): a token issued to Device A must
  // never validate when presented alongside a different deviceId.
  if (typeof deviceId === 'string' && deviceId.length > 0 && row.device_id !== deviceId) {
    recordOmegaAudit('REPLAY_REJECTED', { sessionId, deviceId, result: 'wrong_device' });
    return { valid: false, reason: 'wrong_device' };
  }

  const nowIso = new Date().toISOString();
  if (row.ended_at) return { valid: false, reason: 'session_ended' };
  if (row.revoked_at) return { valid: false, reason: 'session_revoked' };
  if (row.expires_at < nowIso) {
    recordOmegaAudit('SESSION_EXPIRED', { sessionId, deviceId: row.device_id, result: 'expired' });
    return { valid: false, reason: 'session_expired' };
  }

  const device = db.getOmegaDeviceById(row.device_id);
  if (!device || device.revoked_at) {
    recordOmegaAudit('SESSION_REVOKED', { sessionId, deviceId: row.device_id, result: 'device_revoked_live_check' });
    return { valid: false, reason: 'device_revoked' };
  }

  const expectedNonce = row.last_used_nonce ?? row.nonce;
  if (typeof presentedNonce !== 'string' || presentedNonce !== expectedNonce) {
    recordOmegaAudit('REPLAY_REJECTED', { sessionId, deviceId: row.device_id, result: 'nonce_mismatch' });
    return { valid: false, reason: 'nonce_invalid_or_replayed' };
  }

  const newNonce = crypto.randomBytes(24).toString('base64url');
  db.updateOmegaSessionLastNonce(sessionId, newNonce);

  return { valid: true, session: parseSessionRow(row), nextNonce: newNonce, permissionLevel: row.permission_level };
}

export function endSession(sessionId) {
  const row = db.getOmegaSessionById(sessionId);
  if (!row) fail('session_not_found');
  const ok = db.endOmegaSession(sessionId);
  if (ok) {
    // A session end is the global STOP primitive. Keep every capability
    // projection and visible indicator in sync, regardless of which route
    // initiated the stop.
    db.stopOmegaViewSession(sessionId);
    db.stopOmegaInteractiveSession(sessionId);
    stopPersistentIndicator(sessionId);
    recordOmegaAudit('SESSION_EXPIRED', { sessionId, deviceId: row.device_id, result: 'ended_by_client' });
    notifyOmegaAdminSessionEnded(sessionId, 'session_ended');
  }
  return ok;
}

/**
 * Revokes ALL active sessions for a device — called by revokeDevice()
 * in omega-devices.js so revocation invalidates active sessions
 * immediately, not just at natural expiry (mission §17/§18).
 */
export function revokeSessionsForDevice(deviceId) {
  const count = db.revokeOmegaSessionsForDevice(deviceId);
  if (count > 0) {
    recordOmegaAudit('SESSION_REVOKED', { deviceId, result: 'revoked_on_device_revocation', detail: { count } });
  }
  return count;
}

export function getSession(sessionId) {
  const row = db.getOmegaSessionById(sessionId);
  if (!row) return null;
  return { ...parseSessionRow(row), live: isSessionRowLive(row) };
}

export { SESSION_TTL_MS };
