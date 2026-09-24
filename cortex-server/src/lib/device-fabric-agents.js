/**
 * DEVICE FABRIC Phase 2 — read-only agent adapters.
 *
 * The only bridge between Device Fabric and the frozen OMEGA V1 / RASSILON V1
 * agents. Everything here is a READ of an existing store helper, followed by
 * an immediate projection onto a whitelist. Nothing here creates, pairs,
 * revokes, enables, stops, dispatches or signs anything, and no session,
 * nonce, token, key or certificate is read into a projection
 * (reports/DEVICE_FABRIC_ARCHITECTURE_2026-09.md §7, §12, §15).
 *
 * Deliberately NOT used (test-device-fabric-static-audit.mjs enforces it):
 * the local-identity helper of rassilon-pairing.js (it generates an identity
 * when none exists), any *-identity / secret-store module, and any
 * session getter. Session state is only ever seen through RASSILON's own
 * identifier-free projection getRassilonDeviceSessionView().
 *
 * Direction matters (architecture F1/F2):
 *   OMEGA_CLIENT         — the remote device acts ON THIS PC (OMEGA V1 is
 *                          host-side only; this PC has no OMEGA client).
 *   RASSILON_WORKER      — THIS PC can send compute TO the device.
 *   RASSILON_CONTROLLER  — the device can send compute TO THIS PC.
 *   RASSILON_BOTH        — both RASSILON directions.
 *   RASSILON_LOCAL       — this PC's own RASSILON worker identity.
 */
import {
  getAllOmegaDevices, getOmegaDeviceById, getRassilonDevice, getRassilonDeviceSessionView,
  getRassilonLocalDevice, getRassilonSettings, listRassilonDevices, listRassilonIdentities,
} from './sqlite.js';
import { deriveDevicePresence, ONLINE_AFTER_MS, STALE_AFTER_MS } from './rassilon-scheduler.js';
import { getRassilonStatus } from './rassilon-worker.js';

export const TRUST = Object.freeze({ TRUSTED: 'TRUSTED', REVOKED: 'REVOKED', UNKNOWN: 'UNKNOWN' });
export const AVAILABILITY = Object.freeze({ AVAILABLE: 'AVAILABLE', UNAVAILABLE: 'UNAVAILABLE', UNKNOWN: 'UNKNOWN', ERROR: 'ERROR' });
export const TRI = Object.freeze({ YES: 'YES', NO: 'NO', UNKNOWN: 'UNKNOWN' });

// Mirror of OMEGA's OMEGA_PERMISSION_LEVELS (asserted equal by the tests,
// without importing omega-pairing.js and its key-handling graph here).
export const OMEGA_CAPABILITY_LEVELS = Object.freeze({ OMEGA_VIEW: 1, OMEGA_INTERACTIVE: 2, OMEGA_ADMIN: 3 });
// Mirror of RASSILON's EXECUTOR_PERMISSION (asserted equal by the tests).
export const RASSILON_CAPABILITY_PERMISSIONS = Object.freeze({
  SAFE_CPU_TASK: 'RASSILON_COMPUTE_SAFE',
  EMBEDDING_BATCH: 'RASSILON_EMBEDDING',
});

export const DIRECTIONS = Object.freeze({
  REMOTE_ACTS_ON_THIS_PC: 'REMOTE_ACTS_ON_THIS_PC',
  THIS_PC_SENDS_COMPUTE: 'THIS_PC_SENDS_COMPUTE',
  DEVICE_SENDS_COMPUTE: 'DEVICE_SENDS_COMPUTE',
  LOCAL_WORKER: 'LOCAL_WORKER',
});

const FINGERPRINT = /^[0-9a-f]{64}$/;

function safeFingerprint(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return FINGERPRINT.test(normalized) ? normalized : null;
}

// ── OMEGA ──────────────────────────────────────────────────────────────────

function projectOmegaRow(row) {
  if (!row) return null;
  return {
    agentType: 'OMEGA',
    agentDeviceId: row.id,
    displayName: row.display_name,
    fingerprint: safeFingerprint(row.fingerprint),
    role: 'OMEGA_CLIENT',
    trust: row.revoked_at ? TRUST.REVOKED : TRUST.TRUSTED,
    revokedAt: row.revoked_at ?? null,
    // OMEGA writes last_seen only when a session is authenticated
    // (architecture F4) — shown as such, never as live presence.
    lastSessionAt: row.last_seen ?? null,
    permissionLevel: Number.isInteger(row.permission_level) ? row.permission_level : null,
  };
}

export function getOmegaDevicesForFabric() {
  return getAllOmegaDevices().map(projectOmegaRow);
}

export function getOmegaDeviceForFabric(agentDeviceId) {
  return projectOmegaRow(getOmegaDeviceById(agentDeviceId));
}

function omegaSections(identity) {
  const revoked = identity.trust === TRUST.REVOKED;
  // OMEGA V1 host capabilities are implemented for Windows only.
  const supported = process.platform === 'win32' ? TRI.YES : TRI.NO;
  const capabilities = Object.entries(OMEGA_CAPABILITY_LEVELS).map(([name, level]) => ({
    name,
    supported,
    authorized: revoked || identity.permissionLevel === null ? TRI.NO : identity.permissionLevel >= level ? TRI.YES : TRI.NO,
    // No OMEGA projection reports live sessions per device (F4): never YES.
    available: revoked ? TRI.NO : TRI.UNKNOWN,
  }));
  return {
    availability: revoked ? AVAILABILITY.UNAVAILABLE : AVAILABILITY.UNKNOWN,
    directions: [{ direction: DIRECTIONS.REMOTE_ACTS_ON_THIS_PC, capabilities }],
  };
}

// ── RASSILON ───────────────────────────────────────────────────────────────

const RASSILON_ROLES = Object.freeze({
  CONTROLLER: 'RASSILON_CONTROLLER',
  WORKER: 'RASSILON_WORKER',
  BOTH: 'RASSILON_BOTH',
});

function projectRassilonDevice(device) {
  if (!device) return null;
  return {
    agentType: 'RASSILON',
    agentDeviceId: device.deviceId,
    displayName: device.displayName,
    fingerprint: safeFingerprint(device.fingerprint),
    role: RASSILON_ROLES[device.role] ?? 'RASSILON_UNKNOWN_ROLE',
    trust: device.revokedAt ? TRUST.REVOKED : TRUST.TRUSTED,
    revokedAt: device.revokedAt ?? null,
    lastSeenAt: device.lastSeenAt ?? null,
    // Kept internally for state derivation; stripped from API output.
    _presenceInput: { revokedAt: device.revokedAt, status: device.status, lastSeenAt: device.lastSeenAt },
    _permissionSet: Array.isArray(device.permissionSet) ? device.permissionSet.filter(p => typeof p === 'string') : [],
    _advertisedExecutors: Array.isArray(device.capabilities?.safeExecutorTypes)
      ? device.capabilities.safeExecutorTypes.filter(t => typeof t === 'string') : null,
  };
}

function projectLocalRassilon() {
  const local = getRassilonLocalDevice();
  if (!local) return null;
  // listRassilonIdentities() also returns revoked rows, so a revoked local
  // identity is shown as REVOKED instead of silently disappearing.
  const identity = listRassilonIdentities().find(row => row.device_id === local.deviceId);
  if (!identity) return null;
  return {
    agentType: 'RASSILON',
    agentDeviceId: local.deviceId,
    displayName: local.displayName,
    fingerprint: safeFingerprint(identity.fingerprint),
    role: 'RASSILON_LOCAL',
    trust: identity.revoked_at ? TRUST.REVOKED : TRUST.TRUSTED,
    revokedAt: identity.revoked_at ?? null,
    lastSeenAt: null,
  };
}

export function getRassilonDevicesForFabric() {
  const local = projectLocalRassilon();
  const remote = listRassilonDevices({ includeRevoked: true })
    .filter(device => device.deviceId !== local?.agentDeviceId)
    .map(projectRassilonDevice);
  return local ? [local, ...remote] : remote;
}

export function getRassilonDeviceForFabric(agentDeviceId) {
  const local = projectLocalRassilon();
  if (local && local.agentDeviceId === agentDeviceId) return local;
  return projectRassilonDevice(getRassilonDevice(agentDeviceId, { includeRevoked: true }));
}

// A session counts as EXPIRING in its last 3 minutes (RASSILON V1 sessions
// last 15 minutes and are never renewed).
export const SESSION_EXPIRING_MS = 3 * 60_000;
// Freshness window of a verified presence (RASSILON's own ONLINE window).
export const PRESENCE_FRESH_MS = ONLINE_AFTER_MS;
export const PRESENCE_STALE_MS = STALE_AFTER_MS;

// RASSILON's session projection merges inbound ?? outbound (one row per
// device, architecture F9), so a session reported for the other direction
// means "unknown for this direction", never "none". Only the state and the
// expiry are surfaced; the projection carries no session identifier.
function sessionDetail(agentDeviceId, expected, now) {
  const view = getRassilonDeviceSessionView(agentDeviceId);
  if (!view) return { state: 'NONE', expiresAt: null, expiresInMs: null };
  if (view.direction !== expected) return { state: 'UNKNOWN', expiresAt: null, expiresInMs: null };
  if (view.revokedAt) return { state: 'REVOKED', expiresAt: view.expiresAt, expiresInMs: null };
  const expiresInMs = Date.parse(view.expiresAt) - now;
  if (!(expiresInMs > 0)) return { state: 'EXPIRED', expiresAt: view.expiresAt, expiresInMs: 0 };
  return { state: expiresInMs <= SESSION_EXPIRING_MS ? 'EXPIRING' : 'VALID', expiresAt: view.expiresAt, expiresInMs };
}

// Presence as RASSILON last verified it through an authenticated exchange.
// Anything older than the freshness window is not a current fact.
function presenceDetail(identity, now) {
  const seen = Date.parse(identity.lastSeenAt);
  const ageMs = Number.isFinite(seen) ? Math.max(0, now - seen) : null;
  if (identity.trust === TRUST.REVOKED) return { state: 'REVOKED', lastVerifiedAt: identity.lastSeenAt, ageMs, freshnessWindowMs: PRESENCE_FRESH_MS };
  const derived = deriveDevicePresence(identity._presenceInput, now);
  const state = derived === 'ONLINE' ? 'VERIFIED' : derived === 'STALE' ? 'STALE' : 'NOT_VERIFIED';
  return { state, lastVerifiedAt: identity.lastSeenAt, ageMs, freshnessWindowMs: PRESENCE_FRESH_MS };
}

function localWorkerAvailability() {
  const status = getRassilonStatus();
  if (status.state === 'ERROR') return { availability: AVAILABILITY.ERROR, acceptedJobTypes: status.settings.acceptedJobTypes };
  const running = status.enabled && ['IDLE', 'WORKING'].includes(status.state);
  return { availability: running ? AVAILABILITY.AVAILABLE : AVAILABILITY.UNAVAILABLE, acceptedJobTypes: status.settings.acceptedJobTypes };
}

function combineCapability({ agentAvailability, supported, authorized }) {
  if (agentAvailability !== AVAILABILITY.AVAILABLE && agentAvailability !== AVAILABILITY.UNKNOWN) return TRI.NO;
  if (supported === TRI.NO || authorized === TRI.NO) return TRI.NO;
  if (agentAvailability === AVAILABILITY.AVAILABLE && supported === TRI.YES && authorized === TRI.YES) return TRI.YES;
  return TRI.UNKNOWN;
}

function remoteDirection(identity, direction, now) {
  const expectedSession = direction === DIRECTIONS.THIS_PC_SENDS_COMPUTE ? 'OUTBOUND' : 'INBOUND';
  const session = sessionDetail(identity.agentDeviceId, expectedSession, now);
  const presence = presenceDetail(identity, now);
  const sessionActive = session.state === 'VALID' || session.state === 'EXPIRING';
  let availability;
  if (identity.trust === TRUST.REVOKED || ['NONE', 'EXPIRED', 'REVOKED'].includes(session.state)) availability = AVAILABILITY.UNAVAILABLE;
  // Presence is only refreshed by authenticated exchanges (F6): anything but
  // a fresh VERIFIED is "not confirmed", i.e. UNKNOWN, never OFFLINE-by-guess.
  else availability = sessionActive && presence.state === 'VERIFIED' ? AVAILABILITY.AVAILABLE : AVAILABILITY.UNKNOWN;

  let localWorker = null;
  if (direction === DIRECTIONS.DEVICE_SENDS_COMPUTE) {
    localWorker = localWorkerAvailability();
    if (localWorker.availability === AVAILABILITY.ERROR) availability = AVAILABILITY.ERROR;
    else if (localWorker.availability !== AVAILABILITY.AVAILABLE && availability !== AVAILABILITY.UNAVAILABLE) availability = AVAILABILITY.UNAVAILABLE;
  }

  const revoked = identity.trust === TRUST.REVOKED;
  const capabilities = Object.entries(RASSILON_CAPABILITY_PERMISSIONS).map(([name, permission]) => {
    let supported;
    let authorized;
    if (direction === DIRECTIONS.THIS_PC_SENDS_COMPUTE) {
      // Advertised by the remote worker itself: a claim, not a fact.
      supported = identity._advertisedExecutors === null ? TRI.UNKNOWN : identity._advertisedExecutors.includes(name) ? TRI.YES : TRI.NO;
      authorized = !revoked && identity._permissionSet.includes(permission) ? TRI.YES : TRI.NO;
    } else {
      // This PC's own closed RASSILON V1 registry runs the job.
      supported = TRI.YES;
      authorized = !revoked && identity._permissionSet.includes(permission) && localWorker.acceptedJobTypes.includes(name) ? TRI.YES : TRI.NO;
    }
    return { name, supported, authorized, available: combineCapability({ agentAvailability: availability, supported, authorized }) };
  });
  return { direction, availability, capabilities, presence, session };
}

function localDirection(identity) {
  const revoked = identity.trust === TRUST.REVOKED;
  const worker = localWorkerAvailability();
  const availability = revoked ? AVAILABILITY.UNAVAILABLE : worker.availability;
  const capabilities = Object.keys(RASSILON_CAPABILITY_PERMISSIONS).map(name => {
    const authorized = !revoked && worker.acceptedJobTypes.includes(name) ? TRI.YES : TRI.NO;
    return { name, supported: TRI.YES, authorized, available: combineCapability({ agentAvailability: availability, supported: TRI.YES, authorized }) };
  });
  return { direction: DIRECTIONS.LOCAL_WORKER, availability, capabilities };
}

const AVAILABILITY_RANK = [AVAILABILITY.ERROR, AVAILABILITY.AVAILABLE, AVAILABILITY.UNKNOWN, AVAILABILITY.UNAVAILABLE];

function rassilonSections(identity, now) {
  let directions;
  if (identity.role === 'RASSILON_LOCAL') directions = [localDirection(identity)];
  else if (identity.role === 'RASSILON_WORKER') directions = [remoteDirection(identity, DIRECTIONS.THIS_PC_SENDS_COMPUTE, now)];
  else if (identity.role === 'RASSILON_CONTROLLER') directions = [remoteDirection(identity, DIRECTIONS.DEVICE_SENDS_COMPUTE, now)];
  else if (identity.role === 'RASSILON_BOTH') {
    directions = [remoteDirection(identity, DIRECTIONS.THIS_PC_SENDS_COMPUTE, now), remoteDirection(identity, DIRECTIONS.DEVICE_SENDS_COMPUTE, now)];
  } else {
    return { availability: identity.trust === TRUST.REVOKED ? AVAILABILITY.UNAVAILABLE : AVAILABILITY.UNKNOWN, directions: [] };
  }
  // Agent-level availability = the best direction (ERROR always surfaces).
  const availability = AVAILABILITY_RANK.find(state => directions.some(d => d.availability === state));
  return { availability, directions };
}

// ── Common public shape ────────────────────────────────────────────────────

export function getAgentIdentity(agentType, agentDeviceId) {
  if (agentType === 'OMEGA') return getOmegaDeviceForFabric(agentDeviceId);
  if (agentType === 'RASSILON') return getRassilonDeviceForFabric(agentDeviceId);
  return null;
}

export function listAgentIdentities(agentType) {
  if (agentType === 'OMEGA') return getOmegaDevicesForFabric();
  if (agentType === 'RASSILON') return getRassilonDevicesForFabric();
  return [];
}

/** Public identity shape: no internal fields, no key, no session. */
export function publicIdentity(identity) {
  if (!identity) return null;
  const { _presenceInput: _p, _permissionSet: _s, _advertisedExecutors: _a, ...rest } = identity;
  return rest;
}

/** Availability + capability sections for an existing identity. */
export function describeAgentState(identity, now = Date.now()) {
  return identity.agentType === 'OMEGA' ? omegaSections(identity) : rassilonSections(identity, now);
}
