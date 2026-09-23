/**
 * OMEGA V1 Phase 2 — device listing + revocation orchestration.
 *
 * revokeDevice() (mission §17/§18) invalidates, immediately and
 * irreversibly for that device identity:
 *   - the device record itself (revoked_at set — future sessions and
 *     future pairing-approval reuse of this fingerprint are blocked)
 *   - all outstanding session tokens for that device (ended/revoked)
 *   - the device's stored private-key-adjacent material has no
 *     Docteur-side private key to revoke (the device's OWN private key
 *     never left the device by design — see omega-identity.js's header
 *     comment); what Docteur revokes is its trust IN that public key.
 *
 * A revoked device must complete a full new pairing flow — there is no
 * "re-authorize" shortcut. Since omega-pairing.js's approvePairing()
 * only reuses an existing device row when it is NOT revoked
 * (`if (existing && !existing.revoked_at)`), a revoked device's
 * fingerprint reappearing in a new pairing attempt always creates a
 * BRAND NEW device row rather than resurrecting the revoked one — this
 * is the structural enforcement of "must re-pair fully", not just a
 * status flag a client could ignore.
 */
import * as db from './sqlite.js';
import { recordOmegaAudit } from './omega-audit.js';
import { revokeSessionsForDevice } from './omega-session.js';
import { deleteDeviceKey } from './omega-identity.js';
import { stopPersistentIndicatorsForDevice } from './omega-indicator.js';
import { notifyOmegaAdminDeviceRevoked } from './omega-admin-registry.js';

export class OmegaDeviceError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'OmegaDeviceError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OmegaDeviceError(code, detail);
}

function parseDeviceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    fingerprint: row.fingerprint,
    permissionLevel: row.permission_level,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    revokedAt: row.revoked_at,
    // publicKeyPem intentionally omitted from the default list shape —
    // large PEM blobs aren't useful for a device listing UI; exposed
    // via getDevice() below for anything that specifically needs it
    // (never the private key, which never enters this module at all).
  };
}

export function listDevices() {
  return db.getAllOmegaDevices().map(parseDeviceRow);
}

export function getDevice(deviceId) {
  const row = db.getOmegaDeviceById(deviceId);
  if (!row) return null;
  return { ...parseDeviceRow(row), publicKeyPem: row.public_key_pem };
}

export function revokeDevice(deviceId) {
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) fail('device_id_required');

  const row = db.getOmegaDeviceById(deviceId);
  if (!row) fail('device_not_found');

  const wasAlreadyRevoked = !!row.revoked_at;
  const changed = db.revokeOmegaDevice(deviceId);

  // Always invalidate sessions on a revoke call, even if the device
  // row was already marked revoked previously (idempotent safety net —
  // mission §18 "immédiatement ou à la prochaine requête").
  const revokedSessionCount = revokeSessionsForDevice(deviceId);
  const stoppedIndicatorCount = stopPersistentIndicatorsForDevice(deviceId);
  notifyOmegaAdminDeviceRevoked(deviceId);

  // Belt-and-suspenders: this module never held a Docteur-side private
  // key for a REMOTE device (only Docteur's own self-identity, if any,
  // would have one) — deleteDeviceKey() is a harmless no-op via
  // secret-store's absent-key semantics when there's nothing stored
  // under this deviceId's namespace, which is the common case for a
  // remote paired device.
  deleteDeviceKey(deviceId);

  recordOmegaAudit('DEVICE_REVOKED', {
    deviceId,
    result: wasAlreadyRevoked ? 'already_revoked_sessions_recleared' : 'revoked',
    detail: { revokedSessionCount, stoppedIndicatorCount },
  });

  return { deviceId, revoked: true, alreadyRevoked: wasAlreadyRevoked, revokedSessionCount, stoppedIndicatorCount, changed };
}
