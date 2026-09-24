/**
 * RASSILON V1 Phase 2 — closed-enum audit log (mission §38). Thin wrapper
 * around sqlite.js's insertRassilonAudit/listRassilonAudit that enforces
 * the closed event-type enum at the call boundary and bounds
 * result_summary size, mirroring OMEGA's audit-redaction discipline
 * (never job payload/output content, never credentials/secrets — see
 * logger.js REDACT_PATHS for the shared redaction choke point job
 * payloads never bypass since they never reach the logger either).
 */
import { insertRassilonAudit, listRassilonAudit } from './sqlite.js';

export const AUDIT_EVENT_TYPES = Object.freeze([
  'RASSILON_ENABLED',
  'RASSILON_DISABLED',
  'RASSILON_PAUSED',
  'RASSILON_RESUMED',
  // Phase 3 additions (mission §13/§14/§16/§18): AUTO_PAUSED/AUTO_RESUMED
  // are distinct from the manual RASSILON_PAUSED/RASSILON_RESUMED pair
  // above — they record the safety-guard sweep's own automatic
  // pause/resume, never a human action. WORKER_ERROR/WORKER_RECOVERED
  // record the ERROR state's entry/exit. SETTINGS_CHANGED is now
  // actually emitted by updateRassilonSettingsWithAudit (mission §18).
  'AUTO_PAUSED',
  'AUTO_RESUMED',
  'WORKER_ERROR',
  'WORKER_RECOVERED',
  'SETTINGS_CHANGED',
  'JOB_RECEIVED',
  'JOB_REJECTED',
  'JOB_QUEUED',
  'JOB_STARTED',
  'JOB_COMPLETED',
  'JOB_FAILED',
  'JOB_CANCELLED',
  'JOB_INTERRUPTED',
  'KILL_SWITCH_TRIGGERED',
  'PAIRING_STARTED',
  'PAIRING_SUCCEEDED',
  'PAIRING_FAILED',
  'DEVICE_REVOKED',
  'SESSION_CREATED',
  'SESSION_REJECTED',
  'REMOTE_JOB_RECEIVED',
  'REMOTE_JOB_ACCEPTED',
  'REMOTE_JOB_REJECTED',
  'REMOTE_JOB_STARTED',
  'REMOTE_JOB_COMPLETED',
  'REMOTE_JOB_FAILED',
  'REMOTE_JOB_CANCELLED',
  'REMOTE_STOP',
  'LOCAL_STOP',
  'LAN_ENABLED',
  'LAN_DISABLED',
]);

const MAX_SUMMARY_BYTES = 4 * 1024;

function boundSummary(resultSummary) {
  if (!resultSummary) return {};
  const json = JSON.stringify(resultSummary);
  if (Buffer.byteLength(json, 'utf8') <= MAX_SUMMARY_BYTES) return resultSummary;
  return { truncated: true };
}

export function recordAuditEvent({ eventType, jobId = null, issuerDeviceId = null, resultSummary = {} }) {
  if (!AUDIT_EVENT_TYPES.includes(eventType)) {
    throw new Error(`recordAuditEvent: unknown event type ${eventType}`);
  }
  insertRassilonAudit({ eventType, jobId, issuerDeviceId, resultSummary: boundSummary(resultSummary) });
}

export function getAuditLog(options) {
  return listRassilonAudit(options);
}
