import crypto from 'node:crypto';
import {
  consumeRassilonRequestNonce, getRassilonDevice, getRassilonSession, touchRassilonSession,
} from './sqlite.js';
import { signWithDeviceKey, verifyWithPublicKey } from './rassilon-identity.js';

export const RASSILON_PERMISSIONS = Object.freeze(['RASSILON_COMPUTE_SAFE', 'RASSILON_EMBEDDING']);
export const EXECUTOR_PERMISSION = Object.freeze({
  SAFE_CPU_TASK: 'RASSILON_COMPUTE_SAFE',
  EMBEDDING_BATCH: 'RASSILON_EMBEDDING',
});
export const REQUEST_CLOCK_SKEW_MS = 60_000;
export const SESSION_TTL_MS = 15 * 60_000;

export class RassilonLanAuthError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.name = 'RassilonLanAuthError';
    this.code = code;
    this.status = status;
  }
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Base64(data) {
  return crypto.createHash('sha256').update(data).digest('base64');
}

export function canonicalRequestBytes({ deviceId, sessionId, timestamp, nonce, method, path, bodyHash }) {
  return Buffer.from(stableStringify({ deviceId, sessionId, timestamp, nonce, method: method.toUpperCase(), path, bodyHash }), 'utf8');
}

export function createSignedRequestHeaders({ deviceId, sessionId, method, path, body = '', timestamp = new Date().toISOString(), nonce = crypto.randomBytes(18).toString('base64url') }) {
  const bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const bodyHash = sha256Base64(bodyBytes);
  const signature = signWithDeviceKey(deviceId, canonicalRequestBytes({ deviceId, sessionId, timestamp, nonce, method, path, bodyHash })).toString('base64');
  return {
    'x-rassilon-device-id': deviceId,
    'x-rassilon-session-id': sessionId,
    'x-rassilon-timestamp': timestamp,
    'x-rassilon-nonce': nonce,
    'x-rassilon-body-sha256': bodyHash,
    'x-rassilon-signature': signature,
  };
}

export function authenticateLanRequest({ headers, method, path, bodyBytes, now = Date.now() }) {
  const read = name => headers?.get ? headers.get(name) : headers?.[name] ?? headers?.[name.toLowerCase()];
  const deviceId = read('x-rassilon-device-id');
  const sessionId = read('x-rassilon-session-id');
  const timestamp = read('x-rassilon-timestamp');
  const nonce = read('x-rassilon-nonce');
  const declaredBodyHash = read('x-rassilon-body-sha256');
  const signature = read('x-rassilon-signature');
  if (![deviceId, sessionId, timestamp, nonce, declaredBodyHash, signature].every(v => typeof v === 'string' && v.length > 0)) {
    throw new RassilonLanAuthError('auth_headers_missing');
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new RassilonLanAuthError('nonce_invalid');
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > REQUEST_CLOCK_SKEW_MS) {
    throw new RassilonLanAuthError(timestampMs > now ? 'timestamp_future' : 'timestamp_stale');
  }
  const session = getRassilonSession(sessionId);
  if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now) throw new RassilonLanAuthError('session_invalid');
  if (session.deviceId !== deviceId) throw new RassilonLanAuthError('session_device_mismatch');
  const device = getRassilonDevice(deviceId);
  if (!device) throw new RassilonLanAuthError('device_unknown_or_revoked');
  const bodyHash = sha256Base64(bodyBytes ?? Buffer.alloc(0));
  const expectedHashBytes = Buffer.from(bodyHash);
  const declaredHashBytes = Buffer.from(declaredBodyHash);
  if (expectedHashBytes.length !== declaredHashBytes.length || !crypto.timingSafeEqual(expectedHashBytes, declaredHashBytes)) {
    throw new RassilonLanAuthError('body_hash_mismatch');
  }
  const valid = verifyWithPublicKey(device.publicKeyPem,
    canonicalRequestBytes({ deviceId, sessionId, timestamp, nonce, method, path, bodyHash }), signature);
  if (!valid) throw new RassilonLanAuthError('request_signature_invalid');
  const nonceExpiresAt = new Date(now + REQUEST_CLOCK_SKEW_MS).toISOString();
  if (!consumeRassilonRequestNonce({ sessionId, nonce, expiresAt: nonceExpiresAt })) throw new RassilonLanAuthError('request_replay');
  touchRassilonSession(sessionId, new Date(now).toISOString());
  return { device, session };
}

export function requiredPermissionForJob(jobType) {
  return typeof jobType === 'string' && Object.hasOwn(EXECUTOR_PERMISSION, jobType) ? EXECUTOR_PERMISSION[jobType] : null;
}

export function assertDevicePermission(device, jobType) {
  const required = requiredPermissionForJob(jobType);
  if (!required || !device?.permissionSet?.includes(required)) throw new RassilonLanAuthError('permission_denied', 403);
  return required;
}

export function isPrivateIpv4(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

export function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createRateLimiter() {
  const buckets = new Map();
  return {
    check(key, { limit, windowMs }, now = Date.now()) {
      const current = buckets.get(key);
      if (!current || current.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      current.count += 1;
      return current.count <= limit;
    },
    clear() { buckets.clear(); },
  };
}

export function certificateFingerprint(certificatePem) {
  return new crypto.X509Certificate(certificatePem).fingerprint256;
}
