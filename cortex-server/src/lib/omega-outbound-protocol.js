import crypto from 'node:crypto';

export const OMEGA_V2_PROTOCOL = 'OMEGA-V2';
export const OMEGA_V2_SESSION_TTL_MS = 15 * 60_000;
export const OMEGA_V2_CLOCK_SKEW_MS = 60_000;
export const OMEGA_V2_PERMISSIONS = Object.freeze(['VIEW', 'INTERACTIVE', 'ADMIN']);
export const OMEGA_V2_VIEW_MESSAGES = Object.freeze(['VIEW_START', 'VIEW_FRAME', 'VIEW_STATUS', 'VIEW_STOP']);
export const OMEGA_V2_INTERACTIVE_MESSAGES = Object.freeze([
  'INTERACTIVE_START', 'INTERACTIVE_STATUS', 'INTERACTIVE_STOP',
  'INPUT_POINTER_MOVE', 'INPUT_POINTER_BUTTON', 'INPUT_POINTER_WHEEL', 'INPUT_KEY_DOWN', 'INPUT_KEY_UP',
]);
export const OMEGA_V2_ADMIN_MESSAGES = Object.freeze(['ADMIN_REQUEST', 'ADMIN_RESULT', 'ADMIN_STATUS', 'ADMIN_CANCEL']);
const PERMISSION_RANK = Object.freeze({ VIEW: 1, INTERACTIVE: 2, ADMIN: 3 });

export function validPermission(value) { return OMEGA_V2_PERMISSIONS.includes(value); }
export function permissionAllowed(requested, ceiling) {
  return validPermission(requested) && validPermission(ceiling) && PERMISSION_RANK[requested] <= PERMISSION_RANK[ceiling];
}
export function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function randomNonce() { return crypto.randomBytes(24).toString('base64url'); }
export function identityFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  return sha256(key.export({ type: 'spki', format: 'der' }));
}
export function normalizeFingerprint(value) { return String(value ?? '').replaceAll(':', '').toLowerCase(); }

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error('omega_v2_canonical_scalar_required');
}

export function canonicalMessage(domain, fields) {
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  return Buffer.from([`domain=${domain}`, `version=${OMEGA_V2_PROTOCOL}`,
    ...entries.map(([key, value]) => `${key}=${scalar(value)}`)].join('\n'), 'utf8');
}

export function signMessage(privateKey, domain, fields) {
  return crypto.sign(null, canonicalMessage(domain, fields), privateKey).toString('base64');
}

export function verifyMessage(publicKeyPem, signature, domain, fields) {
  try {
    return crypto.verify(null, canonicalMessage(domain, fields), crypto.createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
  } catch { return false; }
}

export function requestFields({ localDeviceId, remoteDeviceId, sessionId, requestId, timestamp, nonce, method, path, bodyBytes }) {
  return { localDeviceId, remoteDeviceId, sessionId, requestId, timestamp, nonce,
    method: String(method).toUpperCase(), path, bodyHash: sha256(bodyBytes) };
}

export function responseFields({ localDeviceId, remoteDeviceId, sessionId, requestId, timestamp, statusCode, bodyBytes }) {
  return { localDeviceId, remoteDeviceId, sessionId, requestId, timestamp,
    statusCode, bodyHash: sha256(bodyBytes) };
}

export function viewFrameFields({ localDeviceId, remoteDeviceId, sessionId, requestId, streamId,
  frameId, sequence, timestamp, mimeType, width, height, screenIndex, bodyBytes }) {
  return { localDeviceId, remoteDeviceId, sessionId, requestId, streamId, frameId, sequence,
    timestamp, mimeType, width, height, screenIndex, bodyHash: sha256(bodyBytes) };
}

export function viewMessageFields({ type, localDeviceId, remoteDeviceId, sessionId, streamId,
  requestId, frameId = '', timestamp, bodyBytes }) {
  if (!OMEGA_V2_VIEW_MESSAGES.includes(type)) throw new Error('omega_v2_view_message_invalid');
  return { type, localDeviceId, remoteDeviceId, sessionId, streamId, requestId, frameId,
    timestamp, bodyHash: sha256(bodyBytes) };
}

export function timestampFresh(timestamp, now = Date.now()) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && Math.abs(now - parsed) <= OMEGA_V2_CLOCK_SKEW_MS;
}
