/**
 * OMEGA V1 Phase 2 — device cryptographic identity.
 *
 * Crypto selection (mission §1/§5, documented before implementation):
 *   Algorithm: Ed25519 (EdDSA over Curve25519), via Node's built-in
 *   `crypto.generateKeyPairSync('ed25519', ...)`.
 *   Why: modern, small (32-byte public key, 64-byte signature), fast,
 *   constant-time by design (no timing side-channel from variable-time
 *   scalar multiplication the way naive ECDSA implementations can have),
 *   natively supported by Node/OpenSSL with zero extra configuration
 *   (no curve-parameter fuss the way plain ECDSA sometimes needs), and
 *   appropriate for signing short messages (pairing/session challenge
 *   proofs) rather than encrypting bulk data. This is a standard,
 *   audited primitive — not a custom construction.
 *   Fingerprint: SHA-256 of the SPKI-DER-encoded public key, hex.
 *   No third-party crypto dependency was added — Node's built-in
 *   `crypto` module fully satisfies every need in this phase (key
 *   generation, signing, verification, hashing, random generation,
 *   timing-safe comparison). No mTLS/TLS library was evaluated as
 *   unnecessary: see omega-pairing.js's header comment for why mutual
 *   auth is implemented as challenge-response signatures in this phase
 *   rather than a live TLS/mTLS socket.
 *
 * Private key storage: reuses secret-store.js's existing DPAPI-backed
 * setSecret()/getSecret() API verbatim (read-only reuse — no changes to
 * that module), under the namespace prefix `omega-device-key:<deviceId>`
 * (mission §4's exact conceptual example), distinct from any cloud
 * provider namespace. The private key is exported as PKCS8 PEM text and
 * handed to setSecret() as opaque plaintext — secret-store.js has no
 * idea it's a key rather than an API token, which is exactly the
 * point: one storage primitive, free-form provider string, zero new
 * DPAPI wrapper code (mission §4).
 *
 * The private key NEVER leaves this module: it is never returned to a
 * route handler as a value, never included in any response body, never
 * logged (see logger.js REDACT_PATHS), never written to SQLite in
 * plaintext (SQLite only ever sees the PUBLIC key, via omega-devices
 * rows in sqlite.js).
 */
import crypto from 'node:crypto';
import * as secretStore from './secret-store.js';

const OMEGA_KEY_PREFIX = 'omega-device-key:';

export class OmegaIdentityError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'OmegaIdentityError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OmegaIdentityError(code, detail);
}

function providerKey(deviceId) {
  return `${OMEGA_KEY_PREFIX}${deviceId}`;
}

/** SHA-256 of the SPKI-DER public key bytes, hex-encoded. */
export function computeFingerprint(publicKeyPem) {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const der = keyObject.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

/**
 * Generates a fresh Ed25519 keypair for a new device identity, persists
 * the private key via secret-store.js under the OMEGA namespace, and
 * returns ONLY public material: { publicKeyPem, fingerprint }. The
 * private key is written to secret storage inside this function and
 * never returned.
 */
export function generateDeviceIdentity(deviceId) {
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) fail('device_id_required');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fingerprint = computeFingerprint(publicKeyPem);

  secretStore.setSecret(providerKey(deviceId), privateKeyPem);

  return { publicKeyPem, fingerprint };
}

/**
 * Returns 'absent' | 'valid' | 'invalid' for a device's stored private
 * key, mirroring secret-store.js's own status semantics exactly (never
 * decrypts/returns the key itself).
 */
export function getDeviceKeyStatus(deviceId) {
  return secretStore.getSecretStatus(providerKey(deviceId));
}

/**
 * Signs `message` (a Buffer or string) with the device's stored private
 * key. Returns the signature as a Buffer, or throws OmegaIdentityError
 * if the key is absent/corrupted. Used both by the "Docteur-as-a-device"
 * self-identity (if Docteur itself proves possession of a key) and by
 * test fixtures simulating a remote device's signature. The private key
 * PEM is read into a local variable and never returned or logged.
 */
export function signWithDeviceKey(deviceId, message) {
  const privateKeyPem = secretStore.getSecret(providerKey(deviceId));
  if (!privateKeyPem) fail('device_key_unavailable', { deviceId });
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch {
    fail('device_key_corrupted', { deviceId });
  }
  const data = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
  return crypto.sign(null, data, privateKey);
}

/**
 * Verifies a signature against a device's registered PUBLIC key (never
 * touches secret storage — public keys live in SQLite via
 * omega-devices, passed in by the caller). This is the server-side half
 * of the challenge-response mutual-auth proof (mission §12).
 */
export function verifyWithPublicKey(publicKeyPem, message, signature) {
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch {
    return false;
  }
  const data = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
  const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(String(signature), 'base64');
  try {
    return crypto.verify(null, data, publicKey, sig);
  } catch {
    return false;
  }
}

/** Deletes the stored private key for a device — used on revocation. */
export function deleteDeviceKey(deviceId) {
  secretStore.deleteSecret(providerKey(deviceId));
}

export { providerKey as omegaDeviceKeyProvider };
