import crypto from 'node:crypto';
import * as secretStore from './secret-store.js';
import { getIdentityByRole, insertIdentity } from './omega-outbound-store.js';
import { identityFingerprint, signMessage } from './omega-outbound-protocol.js';

const PREFIX = 'omega-v2-role-key:';
const ROLES = new Set(['CONTROLLER', 'HOST']);

function provider(role, id) { return `${PREFIX}${role.toLowerCase()}:${id}`; }

export function ensureOmegaV2Identity(role) {
  if (!ROLES.has(role)) throw new Error('omega_v2_identity_role_invalid');
  const existing = getIdentityByRole(role);
  if (existing) {
    if (secretStore.getSecretStatus(provider(role, existing.id)) !== 'valid') throw new Error('omega_v2_private_key_unavailable');
    return { deviceId: existing.id, role, publicKeyPem: existing.public_key_pem, fingerprint: existing.fingerprint };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const id = `${role === 'CONTROLLER' ? 'ov2c' : 'ov2h'}-${crypto.randomUUID()}`;
  secretStore.setSecret(provider(role, id), privateKeyPem);
  const fingerprint = identityFingerprint(publicKeyPem);
  insertIdentity({ id, role, publicKeyPem, fingerprint, createdAt: new Date().toISOString() });
  return { deviceId: id, role, publicKeyPem, fingerprint };
}

export function signWithOmegaV2Identity(role, deviceId, domain, fields) {
  const row = getIdentityByRole(role);
  if (!row || row.id !== deviceId || row.revoked_at) throw new Error('omega_v2_identity_unavailable');
  const pem = secretStore.getSecret(provider(role, deviceId));
  if (!pem) throw new Error('omega_v2_private_key_unavailable');
  const key = crypto.createPrivateKey(pem);
  return signMessage(key, domain, fields);
}
