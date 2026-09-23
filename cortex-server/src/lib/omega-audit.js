/**
 * OMEGA V1 Phase 2 — audit log helper. One choke point every OMEGA
 * module calls through to write an omega_audit row (mission §20).
 *
 * Closed event-type enum, mirroring the mission's own list exactly:
 *   PAIRING_STARTED, PAIRING_CODE_FAILED, PAIRING_APPROVED,
 *   PAIRING_DENIED, PAIRING_EXPIRED, PAIRING_CONSUMED,
 *   SESSION_CREATED, SESSION_EXPIRED, SESSION_REVOKED,
 *   DEVICE_REVOKED, IDENTITY_MISMATCH, REPLAY_REJECTED
 *
 * Phase 3 additions (VIEW ONLY screen streaming — mission's own event
 * list §15 "VIEW_STARTED" plus the operational events this phase's own
 * checkpoint list requires being provable via audit): VIEW_STARTED,
 * VIEW_STOPPED, VIEW_FRAME_REJECTED, VIEW_PERMISSION_DENIED.
 *
 * Phase 4 additions (OMEGA_INTERACTIVE mouse/keyboard input injection):
 * INTERACTIVE_STARTED, INTERACTIVE_STOPPED, INTERACTIVE_PERMISSION_DENIED,
 * INTERACTIVE_INPUT_REJECTED, INTERACTIVE_RATE_LIMITED.
 *
 * Phase 4.1 additions (transport/indicator hardening): TLS_REMOTE_DENIED.
 * Phase 5 additions (semantic ADMIN actions): ADMIN_REQUESTED,
 * ADMIN_APPROVED, ADMIN_DENIED, ADMIN_EXECUTED, ADMIN_FAILED,
 * ADMIN_EXPIRED.
 *
 * Never stores: pairing codes, session tokens, private key material,
 * raw keyboard input, screen frames. `detail` is a small, bounded,
 * already-redaction-safe object (device display names may appear here
 * as inert untrusted text — mission §29 — never interpreted). The
 * shared Pino redaction in logger.js is the actual secret-scrubbing
 * choke point for anything ALSO passed to `logger` — this module's own
 * DB writes additionally never receive secret fields in the first
 * place, by construction of every call site in omega-pairing.js/
 * omega-session.js.
 */
import crypto from 'node:crypto';
import * as db from './sqlite.js';

export const OMEGA_AUDIT_EVENT_TYPES = Object.freeze([
  'PAIRING_STARTED', 'PAIRING_CODE_FAILED', 'PAIRING_APPROVED',
  'PAIRING_DENIED', 'PAIRING_EXPIRED', 'PAIRING_CONSUMED',
  'SESSION_CREATED', 'SESSION_EXPIRED', 'SESSION_REVOKED',
  'DEVICE_REVOKED', 'IDENTITY_MISMATCH', 'REPLAY_REJECTED',
  // Phase 3 — VIEW ONLY screen streaming
  'VIEW_STARTED', 'VIEW_STOPPED', 'VIEW_FRAME_REJECTED', 'VIEW_PERMISSION_DENIED',
  // Phase 4 — OMEGA_INTERACTIVE mouse/keyboard input injection
  'INTERACTIVE_STARTED', 'INTERACTIVE_STOPPED', 'INTERACTIVE_PERMISSION_DENIED',
  'INTERACTIVE_INPUT_REJECTED', 'INTERACTIVE_RATE_LIMITED',
  // Phase 4.1 — reject non-loopback OMEGA over cleartext HTTP
  'TLS_REMOTE_DENIED',
  // Phase 5 — semantic, allowlisted ADMIN actions
  'ADMIN_REQUESTED', 'ADMIN_APPROVED', 'ADMIN_DENIED', 'ADMIN_EXECUTED',
  'ADMIN_FAILED', 'ADMIN_EXPIRED',
]);

const EVENT_TYPE_SET = new Set(OMEGA_AUDIT_EVENT_TYPES);

// Bound the detail object's serialized size so a pathological caller
// can never grow an audit row unboundedly (mission §30 discipline
// applied to audit writes too, not just query paths).
const MAX_DETAIL_JSON_LENGTH = 4000;

function boundDetail(detail) {
  if (!detail || typeof detail !== 'object') return {};
  try {
    const json = JSON.stringify(detail);
    if (json.length <= MAX_DETAIL_JSON_LENGTH) return detail;
    return { truncated: true, preview: json.slice(0, MAX_DETAIL_JSON_LENGTH) };
  } catch {
    return {};
  }
}

export function recordOmegaAudit(eventType, { deviceId = null, sessionId = null, pairingId = null, result = '', detail = {} } = {}) {
  if (!EVENT_TYPE_SET.has(eventType)) {
    // Fail loudly in dev/test rather than silently mis-logging an audit
    // event under an unlisted type — this is a closed enum by design.
    throw new Error(`omega_audit_event_type_invalid:${eventType}`);
  }
  db.insertOmegaAudit({
    id: crypto.randomUUID(),
    event_type: eventType,
    device_id: deviceId,
    session_id: sessionId,
    pairing_id: pairingId,
    result: String(result ?? '').slice(0, 200),
    detail: boundDetail(detail),
  });
}

export function listOmegaAuditLog({ limit = 200 } = {}) {
  return db.listOmegaAudit({ limit });
}
