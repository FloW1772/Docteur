import crypto from 'node:crypto';
import { getDatabase } from './sqlite.js';

const AUDIT_EVENTS = new Set([
  'OUTBOUND_CONNECT_REQUESTED', 'OUTBOUND_TLS_ESTABLISHED', 'OUTBOUND_AUTHENTICATED',
  'OUTBOUND_SESSION_CREATED', 'OUTBOUND_SESSION_DENIED', 'OUTBOUND_SESSION_STOPPED',
  'OUTBOUND_SESSION_EXPIRED', 'OUTBOUND_REMOTE_REVOKED', 'OUTBOUND_TLS_FAILURE',
  'OUTBOUND_AUTH_FAILURE', 'OUTBOUND_INTERACTIVE_REQUESTED', 'OUTBOUND_INTERACTIVE_STARTED',
  'OUTBOUND_INTERACTIVE_DENIED', 'OUTBOUND_INTERACTIVE_STOPPED', 'OUTBOUND_INPUT_RATE_LIMITED',
  'OUTBOUND_INPUT_INVALID', 'OUTBOUND_REMOTE_STOP',
  'OUTBOUND_ADMIN_REQUESTED', 'OUTBOUND_ADMIN_APPROVAL_REQUIRED', 'OUTBOUND_ADMIN_APPROVED',
  'OUTBOUND_ADMIN_DENIED', 'OUTBOUND_ADMIN_EXECUTED', 'OUTBOUND_ADMIN_FAILED', 'OUTBOUND_ADMIN_CANCELLED',
  'OUTBOUND_ADMIN_REPLAY_REJECTED',
]);

let initializedFor = null;

function db() {
  const value = getDatabase();
  if (!value) throw new Error('omega_v2_database_unavailable');
  return value;
}

export function initializeOmegaOutboundStore() {
  const database = db();
  if (initializedFor === database) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS omega_v2_identities (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL UNIQUE CHECK (role IN ('CONTROLLER', 'HOST')),
      public_key_pem TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS omega_v2_outbound_trust (
      remote_device_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      certificate_pem TEXT NOT NULL,
      certificate_fingerprint TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      identity_fingerprint TEXT NOT NULL,
      max_permission TEXT NOT NULL CHECK (max_permission IN ('VIEW', 'INTERACTIVE', 'ADMIN')),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS omega_v2_inbound_trust (
      controller_device_id TEXT PRIMARY KEY,
      public_key_pem TEXT NOT NULL,
      identity_fingerprint TEXT NOT NULL,
      max_permission TEXT NOT NULL CHECK (max_permission IN ('VIEW', 'INTERACTIVE', 'ADMIN')),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS omega_v2_sessions (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK (direction IN ('OUTBOUND', 'INBOUND')),
      local_device_id TEXT NOT NULL,
      remote_device_id TEXT NOT NULL,
      permission TEXT NOT NULL CHECK (permission IN ('VIEW', 'INTERACTIVE', 'ADMIN')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      ended_at TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_omega_v2_sessions_remote
      ON omega_v2_sessions(remote_device_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS omega_v2_replay (
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      nonce_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_id),
      UNIQUE (session_id, nonce_hash)
    );
    CREATE TABLE IF NOT EXISTS omega_v2_audit (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      local_device_id TEXT,
      remote_device_id TEXT,
      session_id TEXT,
      result TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_omega_v2_audit_created
      ON omega_v2_audit(created_at DESC);
  `);
  database.prepare(`UPDATE omega_v2_sessions SET status = 'INTERRUPTED', ended_at = ?, reason = 'process_restart'
    WHERE ended_at IS NULL AND status IN ('CONNECTED', 'AUTHENTICATING', 'CONNECTING')`).run(new Date().toISOString());
  initializedFor = database;
}

export function getIdentityByRole(role) {
  initializeOmegaOutboundStore();
  return db().prepare('SELECT * FROM omega_v2_identities WHERE role = ?').get(role) ?? null;
}

export function insertIdentity(row) {
  initializeOmegaOutboundStore();
  db().prepare(`INSERT INTO omega_v2_identities
    (id, role, public_key_pem, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(row.id, row.role, row.publicKeyPem, row.fingerprint, row.createdAt);
  return getIdentityByRole(row.role);
}

export function upsertOutboundTrust(row) {
  initializeOmegaOutboundStore();
  const existing = getOutboundTrust(row.remoteDeviceId);
  if (existing && !existing.revoked_at) throw new Error('outbound_trust_already_exists');
  db().prepare(`INSERT INTO omega_v2_outbound_trust
    (remote_device_id, host, port, certificate_pem, certificate_fingerprint, public_key_pem,
     identity_fingerprint, max_permission, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(remote_device_id) DO UPDATE SET host=excluded.host, port=excluded.port,
      certificate_pem=excluded.certificate_pem, certificate_fingerprint=excluded.certificate_fingerprint,
      public_key_pem=excluded.public_key_pem, identity_fingerprint=excluded.identity_fingerprint,
      max_permission=excluded.max_permission, created_at=excluded.created_at, revoked_at=NULL`)
    .run(row.remoteDeviceId, row.host, row.port, row.certificatePem, row.certificateFingerprint,
      row.publicKeyPem, row.identityFingerprint, row.maxPermission, row.createdAt);
  return getOutboundTrust(row.remoteDeviceId);
}

export function getOutboundTrust(remoteDeviceId) {
  initializeOmegaOutboundStore();
  return db().prepare('SELECT * FROM omega_v2_outbound_trust WHERE remote_device_id = ?').get(remoteDeviceId) ?? null;
}

export function listOutboundTrust() {
  initializeOmegaOutboundStore();
  return db().prepare('SELECT * FROM omega_v2_outbound_trust ORDER BY created_at DESC').all();
}

export function revokeOutboundTrust(remoteDeviceId) {
  initializeOmegaOutboundStore();
  const now = new Date().toISOString();
  const changed = db().prepare('UPDATE omega_v2_outbound_trust SET revoked_at = ? WHERE remote_device_id = ? AND revoked_at IS NULL').run(now, remoteDeviceId).changes;
  if (changed) db().prepare(`UPDATE omega_v2_sessions SET status='TERMINATED', ended_at=?, reason='remote_identity_revoked'
    WHERE direction='OUTBOUND' AND remote_device_id=? AND ended_at IS NULL`).run(now, remoteDeviceId);
  return changed === 1;
}

export function upsertInboundTrust(row) {
  initializeOmegaOutboundStore();
  const existing = getInboundTrust(row.controllerDeviceId);
  if (existing && !existing.revoked_at) throw new Error('inbound_trust_already_exists');
  db().prepare(`INSERT INTO omega_v2_inbound_trust
    (controller_device_id, public_key_pem, identity_fingerprint, max_permission, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(controller_device_id) DO UPDATE SET public_key_pem=excluded.public_key_pem,
      identity_fingerprint=excluded.identity_fingerprint, max_permission=excluded.max_permission,
      created_at=excluded.created_at, revoked_at=NULL`)
    .run(row.controllerDeviceId, row.publicKeyPem, row.identityFingerprint, row.maxPermission, row.createdAt);
  return getInboundTrust(row.controllerDeviceId);
}

export function getInboundTrust(controllerDeviceId) {
  initializeOmegaOutboundStore();
  return db().prepare('SELECT * FROM omega_v2_inbound_trust WHERE controller_device_id = ?').get(controllerDeviceId) ?? null;
}

export function revokeInboundTrust(controllerDeviceId) {
  initializeOmegaOutboundStore();
  const now = new Date().toISOString();
  const changed = db().prepare('UPDATE omega_v2_inbound_trust SET revoked_at = ? WHERE controller_device_id = ? AND revoked_at IS NULL').run(now, controllerDeviceId).changes;
  if (changed) db().prepare(`UPDATE omega_v2_sessions SET status='TERMINATED', ended_at=?, reason='controller_revoked'
    WHERE direction='INBOUND' AND remote_device_id=? AND ended_at IS NULL`).run(now, controllerDeviceId);
  return changed === 1;
}

export function insertSession(row) {
  initializeOmegaOutboundStore();
  db().prepare(`INSERT INTO omega_v2_sessions
    (id, direction, local_device_id, remote_device_id, permission, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.sessionId, row.direction, row.localDeviceId, row.remoteDeviceId, row.permission,
      row.createdAt, row.expiresAt, row.status);
  return getSession(row.sessionId);
}

export function getSession(sessionId) {
  initializeOmegaOutboundStore();
  return db().prepare('SELECT * FROM omega_v2_sessions WHERE id = ?').get(sessionId) ?? null;
}

export function listSessions(direction = 'OUTBOUND') {
  initializeOmegaOutboundStore();
  return db().prepare('SELECT * FROM omega_v2_sessions WHERE direction = ? ORDER BY created_at DESC LIMIT 100').all(direction);
}

export function endSession(sessionId, reason = 'stopped') {
  initializeOmegaOutboundStore();
  const now = new Date().toISOString();
  return db().prepare(`UPDATE omega_v2_sessions SET status='TERMINATED', ended_at=?, reason=?
    WHERE id=? AND ended_at IS NULL`).run(now, String(reason).slice(0, 64), sessionId).changes === 1;
}

export function expireSession(sessionId) {
  initializeOmegaOutboundStore();
  const now = new Date().toISOString();
  return db().prepare(`UPDATE omega_v2_sessions SET status='EXPIRED', ended_at=?, reason='session_expired'
    WHERE id=? AND ended_at IS NULL`).run(now, sessionId).changes === 1;
}

export function consumeReplayToken({ sessionId, requestId, nonceHash, createdAt }) {
  initializeOmegaOutboundStore();
  try {
    db().prepare('INSERT INTO omega_v2_replay (session_id, request_id, nonce_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, requestId, nonceHash, createdAt);
    return true;
  } catch (error) {
    if (String(error?.code).startsWith('SQLITE_CONSTRAINT')) return false;
    throw error;
  }
}

export function pruneReplayTokens(beforeIso) {
  initializeOmegaOutboundStore();
  db().prepare('DELETE FROM omega_v2_replay WHERE created_at < ?').run(beforeIso);
}

export function recordAudit(eventType, fields = {}) {
  initializeOmegaOutboundStore();
  if (!AUDIT_EVENTS.has(eventType)) throw new Error('omega_v2_audit_event_invalid');
  const safeDetail = fields.detail && typeof fields.detail === 'object' ? JSON.stringify(fields.detail).slice(0, 2000) : '{}';
  db().prepare(`INSERT INTO omega_v2_audit
    (id, created_at, event_type, local_device_id, remote_device_id, session_id, result, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), new Date().toISOString(), eventType, fields.localDeviceId ?? null,
      fields.remoteDeviceId ?? null, fields.sessionId ?? null, String(fields.result ?? '').slice(0, 64), safeDetail);
}

export function listAudit(limit = 100) {
  initializeOmegaOutboundStore();
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return db().prepare('SELECT * FROM omega_v2_audit ORDER BY created_at DESC LIMIT ?').all(n);
}
