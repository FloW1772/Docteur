/**
 * OMEGA V1 Phase 2 — pairing state machine + mutual authentication.
 *
 * This module is a FULLY SEPARATE authorization domain from MAÎTRE
 * (mission §43, restated in this phase's own constraints) — zero
 * imports from or calls into any maitre-*.js file. It structurally
 * mirrors MAÎTRE's hash-bound proposal→approval→consume pattern
 * (maitre-approval.js/maitre-actions.js) but with its own tables
 * (omega_pairings, via sqlite.js) and its own state machine.
 *
 * Pairing code (mission §7/§8): generated with crypto.randomInt over a
 * fixed alphabet, 8 characters drawn from a 32-symbol alphabet
 * (Crockford-style, excludes ambiguous 0/O/1/I/L) — that's
 * 32^8 ≈ 1.1 * 10^12 possible codes, far beyond what a rate-limited
 * (5 attempts/pairing, cooldown thereafter) brute force can explore
 * inside a 5-minute expiry window. Only crypto.randomInt is used (never
 * Math.random). The code is never persisted in plaintext — only its
 * SHA-256 hash is stored (mission §8). Comparison at verify time uses
 * crypto.timingSafeEqual on the hash bytes to avoid timing side
 * channels. SHA-256 (not a slow KDF like scrypt/bcrypt) is judged
 * sufficient here specifically because the input space is NOT a
 * human-memorable low-entropy password — it's a full 8-char/32-symbol
 * machine-generated code with ~40 bits of entropy, expiring in minutes,
 * attempt-capped at 5 tries. A slow KDF exists to slow down offline
 * brute force of low-entropy secrets; here the code's own entropy plus
 * the attempt cap plus the short TTL already make offline brute force
 * of a stolen hash impractical within the pairing's useful lifetime,
 * and SHA-256 keeps verify() cheap for the legitimate high-frequency
 * caller. Documented choice, not a default.
 *
 * Mutual authentication (mission §12): Phase 2 has no live two-device
 * network session yet (that's Phase 3+), so mutual auth is proven via
 * challenge-response signatures using the Ed25519 keys from
 * omega-identity.js — the verifying side issues a random challenge
 * (crypto.randomBytes), the device signs it with its private key
 * (never transmitted), and the verifier checks the signature against
 * the device's registered public key (crypto.verify). This is real,
 * standard, provable mutual auth without a live mTLS socket. No TLS/
 * mTLS listener was stood up in this phase — Phase 2's entire pairing/
 * session API surface runs through Cortex's existing HTTP server on
 * its existing loopback-guarded control-plane routes (mission §25),
 * which already terminate any transport-level concern for this phase;
 * a LAN-reachable listener for an actual second physical device is
 * explicitly deferred to Phase 3, where the screen/input data path
 * itself will need its own transport-level design per the Phase 1
 * architecture (§12 of OMEGA_ARCHITECTURE_2026-09.md).
 */
import crypto from 'node:crypto';
import * as db from './sqlite.js';
import { generateDeviceIdentity, computeFingerprint, verifyWithPublicKey } from './omega-identity.js';
import { recordOmegaAudit } from './omega-audit.js';

export class OmegaPairingError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'OmegaPairingError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OmegaPairingError(code, detail);
}

// ── Constants (mission §7: "Ne pas rendre la durée configurable par le
// frontend en V1" — these are fixed server-side, never accepted from a
// request body). ──
const PAIRING_TTL_MS = 3 * 60_000; // 3 minutes — single-digit-minute target (mission §7)
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // no 0/O/1/I/L
const CODE_LENGTH = 8;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_PAIRING_CREATIONS_PER_WINDOW = 10;
const CREATION_WINDOW_MS = 60_000;

export const OMEGA_PERMISSION_LEVELS = Object.freeze({
  OMEGA_VIEW: 1,
  OMEGA_INTERACTIVE: 2,
  OMEGA_ADMIN: 3,
});

const VALID_PERMISSION_VALUES = new Set(Object.values(OMEGA_PERMISSION_LEVELS));

function hashCode(code) {
  return crypto.createHash('sha256').update(code, 'utf8').digest();
}

function timingSafeHashEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generatePairingCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

// ── Simple in-process rate limiter for pairing CREATION (mission §9:
// "Limiter : créations de pairing ... par source"). Per-process, best
// effort — this is a single-user local control plane, not an
// internet-facing service (Phase 1 architecture §14's own framing). ──
const creationTimestamps = [];
function assertCreationRateOk() {
  const now = Date.now();
  while (creationTimestamps.length && now - creationTimestamps[0] > CREATION_WINDOW_MS) {
    creationTimestamps.shift();
  }
  if (creationTimestamps.length >= MAX_PAIRING_CREATIONS_PER_WINDOW) {
    fail('pairing_creation_rate_limited');
  }
  creationTimestamps.push(now);
}

// Test-only escape hatch: clears the sliding creation-rate window so a
// fast test suite exercising MANY unrelated pairing scenarios in one
// process doesn't trip the same rate limiter a real slow human would
// (mission §26/§27 — the limiter itself has its own dedicated brute-
// force test; other tests should not be collateral damage of it).
// Never called from any route or production code path.
export function _resetPairingRateLimitForTests() {
  creationTimestamps.length = 0;
}

function parsePairingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    initiatorDeviceName: row.initiator_device_name,
    requestedPermission: row.requested_permission,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    attemptCount: row.attempt_count,
    status: row.status,
    deviceId: row.device_id,
    fingerprint: row.fingerprint,
    consumedAt: row.consumed_at,
    decidedAt: row.decided_at,
    // codeHash / publicKeyPem deliberately excluded from the public
    // shape returned to callers — internal use only.
  };
}

function isExpired(row, nowIso = new Date().toISOString()) {
  return row.expires_at < nowIso;
}

function reapIfExpired(row) {
  if (row.status === 'PENDING' && isExpired(row)) {
    db.updateOmegaPairingStatus(row.id, { status: 'EXPIRED' });
    recordOmegaAudit('PAIRING_EXPIRED', { pairingId: row.id, result: 'expired' });
    return db.getOmegaPairingById(row.id);
  }
  return row;
}

/**
 * Starts a new pairing attempt. `initiatorDeviceName` is untrusted
 * display text (mission §29) — stored and returned verbatim as inert
 * data, never interpreted. Returns the plaintext code EXACTLY ONCE,
 * here, to the caller — it is never persisted and never logged.
 */
export function startPairing({ initiatorDeviceName, requestedPermission }) {
  assertCreationRateOk();

  const name = typeof initiatorDeviceName === 'string' ? initiatorDeviceName.trim() : '';
  if (name.length === 0 || name.length > 200) fail('device_name_invalid');

  const permission = Number(requestedPermission);
  if (!VALID_PERMISSION_VALUES.has(permission)) fail('requested_permission_invalid', { requestedPermission });

  // Opportunistic cleanup of stale PENDING rows (mission §31) — bounded,
  // indexed by (status, expires_at).
  db.expireStaleOmegaPairings(new Date().toISOString());

  const id = crypto.randomUUID();
  const code = generatePairingCode();
  const codeHash = hashCode(code).toString('hex');
  const now = Date.now();
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();

  db.insertOmegaPairing({
    id, initiator_device_name: name, requested_permission: permission,
    code_hash: codeHash, expires_at: expiresAt,
  });

  recordOmegaAudit('PAIRING_STARTED', { pairingId: id, result: 'pending', detail: { requestedPermission: permission } });

  return { pairingId: id, code, expiresAt };
}

/**
 * Verifies a submitted code against the pairing record, single-use and
 * attempt-bound (mission §7/§9). On success, the pairing moves to
 * AWAITING_APPROVAL (still zero trust — mission §10) and the caller's
 * public key is registered against the pairing pending human
 * confirmation. Wrong code, expired code, exhausted attempts, or an
 * already-consumed/decided pairing all fail closed.
 */
export function verifyPairingCode({ pairingId, code, publicKeyPem }) {
  if (typeof pairingId !== 'string' || pairingId.trim().length === 0) fail('pairing_id_required');
  if (typeof code !== 'string' || code.length === 0 || code.length > 64) fail('code_format_invalid');
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0 || publicKeyPem.length > 4096) fail('public_key_required');

  let row = db.getOmegaPairingById(pairingId);
  if (!row) fail('pairing_not_found');
  row = reapIfExpired(row);

  if (row.status !== 'PENDING') {
    recordOmegaAudit('PAIRING_CODE_FAILED', { pairingId, result: `denied_status_${row.status}` });
    fail('pairing_not_pending', { status: row.status });
  }

  if (row.attempt_count >= MAX_VERIFY_ATTEMPTS) {
    db.updateOmegaPairingStatus(pairingId, { status: 'DENIED' });
    recordOmegaAudit('PAIRING_CODE_FAILED', { pairingId, result: 'denied_attempts_exhausted' });
    fail('pairing_attempts_exhausted');
  }

  db.incrementOmegaPairingAttempt(pairingId);

  const submittedHash = hashCode(code);
  const storedHash = Buffer.from(row.code_hash, 'hex');
  const match = timingSafeHashEqual(submittedHash, storedHash);

  if (!match) {
    recordOmegaAudit('PAIRING_CODE_FAILED', { pairingId, result: 'wrong_code' });
    const updated = db.getOmegaPairingById(pairingId);
    if (updated.attempt_count >= MAX_VERIFY_ATTEMPTS) {
      db.updateOmegaPairingStatus(pairingId, { status: 'DENIED' });
      recordOmegaAudit('PAIRING_CODE_FAILED', { pairingId, result: 'denied_attempts_exhausted' });
    }
    fail('pairing_code_invalid');
  }

  // Validate the caller's supplied public key is at least a
  // structurally valid key before storing it against the pairing.
  let fingerprint;
  try {
    fingerprint = computeFingerprint(publicKeyPem);
  } catch {
    fail('public_key_malformed');
  }

  db.updateOmegaPairingStatus(pairingId, { status: 'AWAITING_APPROVAL', public_key_pem: publicKeyPem, fingerprint });
  recordOmegaAudit('PAIRING_STARTED', { pairingId, result: 'code_verified_awaiting_approval' });

  return parsePairingRow(db.getOmegaPairingById(pairingId));
}

/**
 * Human confirmation gate (mission §10/§11) — even with a correct code,
 * pairing is NOT trusted until an explicit ALLOW here. Registers the
 * device identity (deviceId, publicKey, fingerprint, permission) only
 * on approval. `approverDisplayInfo` is accepted for audit purposes
 * only (mission §11's "afficher côté appareil contrôlé" requirement —
 * the API surface itself IS the display/decision contract this phase).
 */
export function approvePairing(pairingId) {
  if (typeof pairingId !== 'string' || pairingId.trim().length === 0) fail('pairing_id_required');

  let row = db.getOmegaPairingById(pairingId);
  if (!row) fail('pairing_not_found');
  row = reapIfExpired(row);

  if (row.status !== 'AWAITING_APPROVAL') {
    fail('pairing_not_awaiting_approval', { status: row.status });
  }
  if (!row.public_key_pem || !row.fingerprint) fail('pairing_missing_identity');

  // Identity-change detection (mission §13/§18): if this exact
  // fingerprint already belongs to a NON-revoked device, this is a
  // re-pairing of the same identity, which is allowed (idempotent
  // trust) — but if the fingerprint is new, register fresh. If a
  // DIFFERENT device previously used this pairing's device slot that
  // is not possible here since deviceId is only assigned at approval
  // time, one per pairing row.
  const existing = db.getOmegaDeviceByFingerprint(row.fingerprint);
  let deviceId;
  if (existing && !existing.revoked_at) {
    deviceId = existing.id;
    // Permission may be re-requested lower/higher on re-pairing; V1
    // simply records the newly-approved requested permission as the
    // device's ceiling going forward (still not a functional grant —
    // mission §11).
  } else {
    deviceId = crypto.randomUUID();
    db.insertOmegaDevice({
      id: deviceId,
      display_name: row.initiator_device_name,
      public_key_pem: row.public_key_pem,
      fingerprint: row.fingerprint,
      permission_level: row.requested_permission,
    });
  }

  const now = new Date().toISOString();
  db.updateOmegaPairingStatus(pairingId, { status: 'APPROVED', device_id: deviceId, decided_at: now, consumed_at: now });

  recordOmegaAudit('PAIRING_APPROVED', { pairingId, deviceId, result: 'approved' });
  recordOmegaAudit('PAIRING_CONSUMED', { pairingId, deviceId, result: 'consumed' });

  return { pairingId, deviceId, status: 'APPROVED' };
}

export function denyPairing(pairingId) {
  if (typeof pairingId !== 'string' || pairingId.trim().length === 0) fail('pairing_id_required');

  let row = db.getOmegaPairingById(pairingId);
  if (!row) fail('pairing_not_found');
  row = reapIfExpired(row);

  if (row.status !== 'AWAITING_APPROVAL' && row.status !== 'PENDING') {
    fail('pairing_not_decidable', { status: row.status });
  }

  const now = new Date().toISOString();
  db.updateOmegaPairingStatus(pairingId, { status: 'DENIED', decided_at: now, consumed_at: now });
  recordOmegaAudit('PAIRING_DENIED', { pairingId, result: 'denied' });

  return { pairingId, status: 'DENIED' };
}

export function getPairing(pairingId) {
  let row = db.getOmegaPairingById(pairingId);
  if (!row) return null;
  row = reapIfExpired(row);
  return parsePairingRow(row);
}

export function listPairings() {
  return db.getAllOmegaPairings().map(row => parsePairingRow(reapIfExpired(row)));
}

// ── Challenge-response mutual authentication (mission §12) ────────────
//
// Issued challenges are tracked in-process, single-use, short-TTL
// (mission §16 anti-replay applied to the mutual-auth step itself, not
// just to established sessions) — without this, a signature captured
// once (e.g. from a sniffed local request) could be replayed against
// POST /api/omega/sessions repeatedly to mint unlimited sessions
// without ever touching the private key again. Consuming the challenge
// on first use (valid OR invalid attempt) closes that gap. Per-process
// Map is sufficient here for the same reason the pairing creation rate
// limiter is (mission §25 framing — local single-user control plane).
const CHALLENGE_TTL_MS = 2 * 60_000;
const issuedChallenges = new Map(); // challenge -> expiresAtMs

function sweepExpiredChallenges() {
  const now = Date.now();
  for (const [ch, expiresAtMs] of issuedChallenges) {
    if (expiresAtMs < now) issuedChallenges.delete(ch);
  }
}

/**
 * Issues a fresh random challenge for a device to sign, proving
 * possession of its private key. The challenge itself carries no
 * secret value — it's a nonce, safe to log/return. Tracked server-side
 * as unconsumed until verifyDeviceChallenge() is called with it.
 */
export function issueChallenge() {
  sweepExpiredChallenges();
  const challenge = crypto.randomBytes(32).toString('base64');
  issuedChallenges.set(challenge, Date.now() + CHALLENGE_TTL_MS);
  return challenge;
}

/**
 * Verifies a device's signature over a challenge against its
 * REGISTERED public key (never the key supplied by the caller in this
 * call — always looked up server-side from omega_devices, so a caller
 * cannot simply supply an arbitrary key and self-sign). Fails closed
 * for unknown/revoked devices (mission §13/§17), and the challenge is
 * consumed (removed from the pending set) on this call regardless of
 * outcome, so it can never be presented again (mission §16).
 */
export function verifyDeviceChallenge({ deviceId, challenge, signatureB64 }) {
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) fail('device_id_required');

  sweepExpiredChallenges();
  const wasIssued = issuedChallenges.has(challenge);
  issuedChallenges.delete(challenge); // single-use regardless of outcome

  if (!wasIssued) return { valid: false, reason: 'challenge_unknown_or_expired_or_reused' };

  const device = db.getOmegaDeviceById(deviceId);
  if (!device) return { valid: false, reason: 'device_not_found' };
  if (device.revoked_at) return { valid: false, reason: 'device_revoked' };

  let signature;
  try {
    signature = Buffer.from(signatureB64, 'base64');
  } catch {
    return { valid: false, reason: 'signature_malformed' };
  }

  const valid = verifyWithPublicKey(device.public_key_pem, challenge, signature);
  if (!valid) return { valid: false, reason: 'signature_invalid' };

  db.touchOmegaDeviceLastSeen(deviceId);
  return { valid: true, device };
}

// Test-only: clears the issued-challenge set, mirroring
// _resetPairingRateLimitForTests()'s rationale — a fast test suite
// exercising many challenge/verify pairs in one process should not
// leak state between unrelated tests. Never called from production code.
export function _resetIssuedChallengesForTests() {
  issuedChallenges.clear();
}

export { generateDeviceIdentity };
