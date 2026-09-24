/**
 * RASSILON V1 Phase 2 — device cryptographic identity.
 *
 * Structurally mirrors omega-identity.js (same algorithm choice, same
 * secret-store.js reuse, same PEM/fingerprint shape) but is a fully
 * separate module: its own namespace prefix, its own SQLite table
 * (rassilon_identity, PUBLIC key material only), zero imports of or
 * calls into omega-identity.js. Per the Phase 1 architecture report
 * (reports/RASSILON_ARCHITECTURE_2026-09.md §14): "RASSILON generates
 * and stores its own device keypair... does not read, import, or
 * depend on OMEGA's identity records, keys, or pairing state."
 *
 * Algorithm: Ed25519 via Node's built-in `crypto` — no new dependency,
 * same choice already validated in this codebase by OMEGA (mission §15
 * — "Préférer Ed25519 si cohérent avec Phase 1").
 * Fingerprint: SHA-256 of the SPKI-DER-encoded public key, hex.
 *
 * Private key storage: secret-store.js's existing DPAPI-backed
 * setSecret()/getSecret() (read-only reuse, no changes to that module),
 * under the namespace prefix `rassilon-device-key:<deviceId>` — distinct
 * from OMEGA's `omega-device-key:<deviceId>` prefix, never colliding,
 * never shared.
 *
 * The private key NEVER leaves this module: never returned to a route
 * handler, never logged (see logger.js REDACT_PATHS — privateKey/
 * privateKeyPem/deviceKeyPem paths already covered), never written to
 * SQLite (rassilon_identity only ever stores the PUBLIC key, per mission
 * §39 — "ne pas dupliquer secret en DB").
 */
import crypto from 'node:crypto';
import * as secretStore from './secret-store.js';

const RASSILON_KEY_PREFIX = 'rassilon-device-key:';

export class RassilonIdentityError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'RassilonIdentityError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new RassilonIdentityError(code, detail);
}

function providerKey(deviceId) {
  return `${RASSILON_KEY_PREFIX}${deviceId}`;
}

/** SHA-256 of the SPKI-DER public key bytes, hex-encoded. */
export function computeFingerprint(publicKeyPem) {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const der = keyObject.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

/**
 * Generates a fresh Ed25519 keypair for a new RASSILON device identity,
 * persists the private key via secret-store.js under the RASSILON
 * namespace, and returns ONLY public material: { publicKeyPem,
 * fingerprint }. The private key is written to secret storage inside
 * this function and never returned.
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
 * key. Returns the signature as a Buffer, or throws
 * RassilonIdentityError if the key is absent/corrupted. Used by the
 * local Docteur-as-issuer to sign a job before submitting it to the
 * RASSILON worker (mission §16/§19 — "Docteur local trusted issuer").
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
 * rassilon_identity, passed in by the caller). This is the server-side
 * half of job signature verification (mission §16/§17 — signature
 * against a key already on file, never a key supplied inline with the
 * job itself).
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

export { providerKey as rassilonDeviceKeyProvider };
