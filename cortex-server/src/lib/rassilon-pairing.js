import crypto from 'node:crypto';
import {
  createRassilonSession, getRassilonIdentity, getRassilonLocalDevice, getRassilonPairing,
  insertRassilonPairing, setRassilonLocalDevice, updateRassilonPairing, upsertRassilonDevice,
  upsertRassilonIdentity,
} from './sqlite.js';
import {
  computeFingerprint, generateDeviceIdentity, getDeviceKeyStatus, signWithDeviceKey, verifyWithPublicKey,
} from './rassilon-identity.js';
import { RASSILON_PERMISSIONS, SESSION_TTL_MS } from './rassilon-lan-auth.js';
import { recordAuditEvent } from './rassilon-audit.js';

export const PAIRING_TTL_MS = 2 * 60_000;

export class RassilonPairingError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'RassilonPairingError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new RassilonPairingError(code, status); }
function hashCode(pairingId, code) { return crypto.createHash('sha256').update(`${pairingId}:${code}`).digest('hex'); }
function stable(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function bytes(kind, material) { return Buffer.from(stable({ kind, ...material }), 'utf8'); }
function validPermissions(values) {
  if (!Array.isArray(values) || values.some(value => !RASSILON_PERMISSIONS.includes(value))) fail('permissions_invalid');
  return [...new Set(values)];
}
function assertUsable(pairing, now = Date.now()) {
  if (!pairing) fail('pairing_unknown', 404);
  if (pairing.usedAt || pairing.state === 'USED') fail('pairing_already_used', 409);
  if (pairing.cancelledAt || pairing.state === 'CANCELLED') fail('pairing_cancelled', 409);
  if (Date.parse(pairing.expiresAt) <= now) {
    updateRassilonPairing(pairing.pairingId, { state: 'EXPIRED' });
    fail('pairing_expired', 410);
  }
}

export function ensureLocalRassilonDevice({ deviceId = null, displayName = 'Docteur RASSILON' } = {}) {
  let local = getRassilonLocalDevice();
  if (!local) {
    local = setRassilonLocalDevice({ deviceId: deviceId ?? `rassilon-${crypto.randomUUID()}`, displayName });
  }
  let identity = getRassilonIdentity(local.deviceId);
  if (!identity || getDeviceKeyStatus(local.deviceId) !== 'valid') {
    const generated = generateDeviceIdentity(local.deviceId);
    upsertRassilonIdentity({ deviceId: local.deviceId, publicKeyPem: generated.publicKeyPem, fingerprint: generated.fingerprint });
    identity = getRassilonIdentity(local.deviceId);
  }
  return { ...local, publicKeyPem: identity.public_key_pem, fingerprint: identity.fingerprint };
}

export function startRassilonPairing({ ttlMs = PAIRING_TTL_MS, now = Date.now() } = {}) {
  const worker = ensureLocalRassilonDevice();
  const pairingId = crypto.randomUUID();
  const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
  const workerNonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(now + Math.min(Math.max(ttlMs, 10_000), PAIRING_TTL_MS)).toISOString();
  insertRassilonPairing({ pairingId, codeHash: hashCode(pairingId, code), workerNonce, expiresAt });
  recordAuditEvent({ eventType: 'PAIRING_STARTED', resultSummary: { pairingId, expiresAt } });
  return {
    pairingId, code, expiresAt, workerNonce,
    worker: { deviceId: worker.deviceId, displayName: worker.displayName, publicKeyPem: worker.publicKeyPem, fingerprint: worker.fingerprint },
  };
}

export function canonicalPairingRequest(input) {
  return bytes('RASSILON_PAIR_REQUEST_V1', {
    pairingId: input.pairingId, workerNonce: input.workerNonce,
    expectedWorkerFingerprint: input.expectedWorkerFingerprint,
    controllerDeviceId: input.controllerDeviceId, controllerPublicKeyPem: input.controllerPublicKeyPem,
    controllerFingerprint: input.controllerFingerprint, controllerNonce: input.controllerNonce,
    requestedPermissions: input.requestedPermissions,
  });
}

export function requestRassilonPairing(input, { now = Date.now() } = {}) {
  const pairing = getRassilonPairing(input?.pairingId);
  try {
    assertUsable(pairing, now);
    if (pairing.state !== 'STARTED') fail('pairing_wrong_state', 409);
    const suppliedCodeHash = Buffer.from(hashCode(pairing.pairingId, String(input.code ?? '')), 'hex');
    const storedCodeHash = Buffer.from(pairing.codeHash, 'hex');
    if (suppliedCodeHash.length !== storedCodeHash.length || !crypto.timingSafeEqual(suppliedCodeHash, storedCodeHash)) fail('pairing_code_invalid', 401);
    const worker = ensureLocalRassilonDevice();
    if (input.workerNonce !== pairing.workerNonce) fail('worker_challenge_mismatch', 401);
    if (input.expectedWorkerFingerprint !== worker.fingerprint) fail('worker_fingerprint_mismatch', 401);
    if (typeof input.controllerDeviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.controllerDeviceId)) fail('controller_device_id_invalid');
    if (typeof input.controllerNonce !== 'string' || input.controllerNonce.length < 16) fail('controller_nonce_invalid');
    let fingerprint;
    try { fingerprint = computeFingerprint(input.controllerPublicKeyPem); }
    catch { fail('controller_public_key_invalid'); }
    if (fingerprint !== input.controllerFingerprint) fail('controller_fingerprint_mismatch', 401);
    const requestedPermissions = validPermissions(input.requestedPermissions);
    if (!verifyWithPublicKey(input.controllerPublicKeyPem, canonicalPairingRequest({ ...input, requestedPermissions }), input.signature)) {
      fail('controller_proof_invalid', 401);
    }
    updateRassilonPairing(pairing.pairingId, {
      state: 'REQUESTED', controller_nonce: input.controllerNonce,
      controller_device_id: input.controllerDeviceId, controller_public_key_pem: input.controllerPublicKeyPem,
      controller_fingerprint: fingerprint, controller_display_name: String(input.controllerDisplayName ?? 'RASSILON controller').slice(0, 80),
      requested_permissions: JSON.stringify(requestedPermissions),
    });
    const response = {
      pairingId: pairing.pairingId, workerDeviceId: worker.deviceId, workerPublicKeyPem: worker.publicKeyPem,
      workerFingerprint: worker.fingerprint, workerNonce: pairing.workerNonce, controllerNonce: input.controllerNonce,
      state: 'AWAITING_LOCAL_CONFIRMATION', expiresAt: pairing.expiresAt,
    };
    return { ...response, workerSignature: signWithDeviceKey(worker.deviceId, bytes('RASSILON_PAIR_RESPONSE_V1', response)).toString('base64') };
  } catch (error) {
    recordAuditEvent({ eventType: 'PAIRING_FAILED', issuerDeviceId: input?.controllerDeviceId ?? null, resultSummary: { reason: error.code ?? 'invalid_request' } });
    throw error;
  }
}

export function confirmRassilonPairing(pairingId, { approvedPermissions, endpointHost = null, endpointPort = null, tlsCertificatePem = null, tlsCertificateFingerprint = null } = {}, { now = Date.now() } = {}) {
  const pairing = getRassilonPairing(pairingId);
  assertUsable(pairing, now);
  if (pairing.state !== 'REQUESTED') fail('pairing_not_awaiting_confirmation', 409);
  const approved = validPermissions(approvedPermissions);
  if (approved.some(permission => !pairing.requestedPermissions.includes(permission))) fail('permission_not_requested');
  upsertRassilonDevice({
    deviceId: pairing.controllerDeviceId, displayName: pairing.controllerDisplayName,
    publicKeyPem: pairing.controllerPublicKeyPem, fingerprint: pairing.controllerFingerprint,
    role: 'CONTROLLER', permissionSet: approved, endpointHost, endpointPort,
    tlsCertificatePem, tlsCertificateFingerprint, status: 'OFFLINE', capabilities: {},
  });
  // The worker's existing signed-job verifier reads public issuer keys from
  // rassilon_identity. This is public material only; trust/revocation remains
  // governed by rassilon_devices and the authenticated LAN route.
  upsertRassilonIdentity({ deviceId: pairing.controllerDeviceId, publicKeyPem: pairing.controllerPublicKeyPem, fingerprint: pairing.controllerFingerprint });
  updateRassilonPairing(pairingId, {
    state: 'CONFIRMED', approved_permissions: JSON.stringify(approved), confirmed_at: new Date(now).toISOString(),
  });
  return { pairingId, state: 'CONFIRMED', controllerDeviceId: pairing.controllerDeviceId, approvedPermissions: approved };
}

export function rejectRassilonPairing(pairingId, { now = Date.now() } = {}) {
  const pairing = getRassilonPairing(pairingId);
  assertUsable(pairing, now);
  updateRassilonPairing(pairingId, { state: 'CANCELLED', cancelled_at: new Date(now).toISOString() });
  recordAuditEvent({ eventType: 'PAIRING_FAILED', issuerDeviceId: pairing.controllerDeviceId, resultSummary: { reason: 'user_rejected' } });
  return { pairingId, state: 'CANCELLED' };
}

export function canonicalPairingComplete(input) {
  return bytes('RASSILON_PAIR_COMPLETE_V1', { pairingId: input.pairingId, controllerNonce: input.controllerNonce });
}

export function completeRassilonPairing(input, { now = Date.now() } = {}) {
  const pairing = getRassilonPairing(input?.pairingId);
  try {
    assertUsable(pairing, now);
    if (pairing.state !== 'CONFIRMED') fail('local_confirmation_required', 403);
    if (input.controllerNonce !== pairing.controllerNonce) fail('controller_challenge_mismatch', 401);
    if (!verifyWithPublicKey(pairing.controllerPublicKeyPem, canonicalPairingComplete(input), input.signature)) fail('controller_proof_invalid', 401);
    const worker = ensureLocalRassilonDevice();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    createRassilonSession({ sessionId, deviceId: pairing.controllerDeviceId, expiresAt });
    updateRassilonPairing(pairing.pairingId, { state: 'USED', used_at: new Date(now).toISOString() });
    const response = {
      pairingId: pairing.pairingId, sessionId, expiresAt, workerDeviceId: worker.deviceId,
      controllerDeviceId: pairing.controllerDeviceId, approvedPermissions: pairing.approvedPermissions,
    };
    const workerSignature = signWithDeviceKey(worker.deviceId, bytes('RASSILON_PAIR_COMPLETE_RESPONSE_V1', response)).toString('base64');
    recordAuditEvent({ eventType: 'PAIRING_SUCCEEDED', issuerDeviceId: pairing.controllerDeviceId, resultSummary: { pairingId: pairing.pairingId } });
    recordAuditEvent({ eventType: 'SESSION_CREATED', issuerDeviceId: pairing.controllerDeviceId, resultSummary: { sessionId, expiresAt } });
    return { ...response, workerSignature };
  } catch (error) {
    recordAuditEvent({ eventType: 'PAIRING_FAILED', issuerDeviceId: pairing?.controllerDeviceId ?? null, resultSummary: { reason: error.code ?? 'invalid_request' } });
    throw error;
  }
}

export function verifyWorkerPairingProof(publicKeyPem, kind, material, signature) {
  return verifyWithPublicKey(publicKeyPem, bytes(kind, material), signature);
}
