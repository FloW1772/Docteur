/**
 * Semantic API routes for MAÎTRE (MA-11). Same loopback-only guard shape
 * as monitor.js/cyber-audit.js/metagpt.js/sherlock.js — this control
 * plane must never be reachable except from the local machine. Every
 * handler calls ONLY maitre-orchestrator.js — never maitre-executor.js/
 * maitre-approval.js/maitre-store.js/etc. internals directly (mission
 * §2/§10 — this route reproduces no executor/policy/approval logic of
 * its own).
 *
 * Mandatory PROPOSE → POLICY → APPROVAL → EXECUTE flow (mission §7):
 * there is no POST /execute-arbitrary-action endpoint. The only path to
 * executeApprovedAction() is POST /actions/:id/execute, and that
 * function itself (unmodified from MA-8/9/10) re-validates policy,
 * approval, TOCTOU state, and level from the CURRENT persisted rows —
 * this route layer never trusts a client-supplied level/approved/
 * verified flag for anything (mission §11).
 */
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import {
  getMaitreOverview, listIncidents, getIncidentDetail, listSecurityEvents, getEvidence,
  listMaitreProcesses, inspectMaitreProcess, getMaitrePersistenceSnapshot,
  getMaitreDefenderStatus, getMaitreDefenderDetections, getIsolationStatusSummary,
  proposeMaitreAction, getMaitreActionProposal, listMaitreActionsForIncidentDetail,
  requestMaitreApproval, approveMaitreAction, rejectMaitreAction, executeMaitreAction,
  getMaitreActionRunDetail, listMaitreActionRunsForIncidentDetail,
  analyzeMaitreIncident,
} from '../lib/maitre-orchestrator.js';
import { MaitreActionError } from '../lib/maitre-actions.js';
import { MaitreExecutionError } from '../lib/maitre-executor.js';

const localAddress = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);

const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 50;

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return LIST_LIMIT_DEFAULT;
  return Math.min(Math.floor(n), LIST_LIMIT_MAX);
}

function clampOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// Errors thrown by maitre-actions.js/maitre-approval.js/maitre-executor.js
// (MaitreActionError, MaitreExecutionError) carry a stable `.code` — this
// maps that to an HTTP status without leaking a stack trace or raw
// message to the client. Anything not in this map defaults to 400 (the
// overwhelming majority are input/state validation failures, never
// server bugs) except the explicit "not found" codes below.
function statusForErrorCode(code) {
  if (code === 'incident_not_found' || code === 'action_not_found' || code === 'approval_not_found') return 404;
  if (code === 'isolation_already_active' || code === 'action_already_running' || code === 'action_already_executed') return 409;
  return 400;
}

function handleMaitreError(c, err) {
  if (err instanceof MaitreActionError || err instanceof MaitreExecutionError) {
    return c.json({ ok: false, error: err.code }, statusForErrorCode(err.code));
  }
  throw err;
}

export function createMaitreRoute({
  logger,
  isLocal = c => { try { return localAddress(getConnInfo(c).remote.address); } catch { return false; } },
  ollamaClient = null,
  ollamaModel = null,
  // Forwarded to every maitre-orchestrator.js call that ultimately calls
  // PowerShell/child_process (processes/persistence/defender/isolation
  // preflight/execute) — undefined in production so each module's own
  // real default (runReadOnlyPowerShell/isWindows) is used. Route and
  // browser tests inject a mock here so no real OS command is ever run
  // from a test (mission §42/§44).
  exec,
  checkPlatform,
} = {}) {
  const route = new Hono();
  const execOpts = (exec !== undefined || checkPlatform !== undefined) ? { exec, checkPlatform } : undefined;

  route.use('/maitre/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: 'local_access_required' }, 403);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname)) return c.json({ error: 'host_denied' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        if (!['http:', 'https:'].includes(parsedOrigin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)) {
          return c.json({ error: 'origin_denied' }, 403);
        }
      } catch { return c.json({ error: 'origin_denied' }, 403); }
    }
    const requiresJsonBody = ['POST', 'PUT'].includes(c.req.method);
    if (requiresJsonBody && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415);
    await next();
  });
  route.use('/maitre/*', bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  // ── Overview ──────────────────────────────────────────────────────────

  route.get('/maitre/overview', async (c) => {
    const overview = await getMaitreOverview(execOpts);
    return c.json({ ok: true, overview });
  });

  // ── Incidents ─────────────────────────────────────────────────────────

  route.get('/maitre/incidents', (c) => {
    const limit = clampLimit(c.req.query('limit'));
    const offset = clampOffset(c.req.query('offset'));
    const status = c.req.query('status') || null;
    const incidents = listIncidents({ limit, offset, status });
    return c.json({ ok: true, incidents });
  });

  route.get('/maitre/incidents/:id', (c) => {
    const detail = getIncidentDetail(c.req.param('id'));
    if (!detail) return c.json({ ok: false, error: 'incident_not_found' }, 404);
    const actions = listMaitreActionsForIncidentDetail(detail.incident.id, { limit: LIST_LIMIT_MAX });
    const actionRuns = listMaitreActionRunsForIncidentDetail(detail.incident.id, { limit: LIST_LIMIT_MAX });
    return c.json({ ok: true, ...detail, actions, actionRuns });
  });

  route.post('/maitre/incidents/:id/analyze', async (c) => {
    try {
      const result = await analyzeMaitreIncident(c.req.param('id'), { ollamaClient, ollamaModel });
      if (!result) return c.json({ ok: false, error: 'incident_not_found' }, 404);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return handleMaitreError(c, err);
    }
  });

  // ── Events ────────────────────────────────────────────────────────────

  route.get('/maitre/events', (c) => {
    const limit = clampLimit(c.req.query('limit'));
    const offset = clampOffset(c.req.query('offset'));
    const incidentId = c.req.query('incidentId') || null;
    const events = listSecurityEvents({ limit, offset, incidentId });
    return c.json({ ok: true, events });
  });

  // ── Evidence ──────────────────────────────────────────────────────────

  route.get('/maitre/evidence/:id', (c) => {
    const evidence = getEvidence(c.req.param('id'));
    if (!evidence) return c.json({ ok: false, error: 'evidence_not_found' }, 404);
    return c.json({ ok: true, evidence });
  });

  // ── Processes ─────────────────────────────────────────────────────────

  route.get('/maitre/processes', async (c) => {
    const result = await listMaitreProcesses(execOpts);
    return c.json({ ok: true, ...result });
  });

  route.get('/maitre/processes/:pid', async (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isInteger(pid) || pid < 0) return c.json({ ok: false, error: 'pid_invalid' }, 400);
    const result = await inspectMaitreProcess(pid, execOpts);
    return c.json({ ok: true, ...result });
  });

  // ── Persistence ───────────────────────────────────────────────────────

  route.get('/maitre/persistence', async (c) => {
    const snapshot = await getMaitrePersistenceSnapshot(execOpts);
    return c.json({ ok: true, ...snapshot });
  });

  // ── Defender ──────────────────────────────────────────────────────────

  route.get('/maitre/defender/status', async (c) => {
    const status = await getMaitreDefenderStatus(execOpts);
    return c.json({ ok: true, status });
  });

  route.get('/maitre/defender/detections', async (c) => {
    const detections = await getMaitreDefenderDetections(execOpts);
    return c.json({ ok: true, ...detections });
  });

  // ── Isolation status ──────────────────────────────────────────────────

  route.get('/maitre/isolation/status', (c) => {
    const status = getIsolationStatusSummary();
    return c.json({ ok: true, ...status });
  });

  // ── Actions: PROPOSE → POLICY → APPROVAL → EXECUTE ──────────────────────

  route.post('/maitre/actions/propose', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'json_invalid' }, 400); }
    try {
      // Level is NEVER read from body here — proposeMaitreAction ->
      // createActionProposal -> validateActionInput assigns it
      // server-side from the closed ACTION_LEVELS table regardless of
      // any level field the client might include (mission §8/§47).
      const proposal = proposeMaitreAction(body);
      return c.json({ ok: true, proposal });
    } catch (err) {
      return handleMaitreError(c, err);
    }
  });

  route.get('/maitre/actions/:id', (c) => {
    const action = getMaitreActionProposal(c.req.param('id'));
    if (!action) return c.json({ ok: false, error: 'action_not_found' }, 404);
    return c.json({ ok: true, action });
  });

  route.post('/maitre/actions/:id/request-approval', (c) => {
    try {
      const approval = requestMaitreApproval(c.req.param('id'));
      return c.json({ ok: true, approval });
    } catch (err) {
      return handleMaitreError(c, err);
    }
  });

  route.post('/maitre/actions/:approvalId/approve', async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch { /* empty body is fine — strengthenedConfirmation defaults false */ }
    try {
      // strengthenedConfirmation must be an explicit boolean the user
      // actively supplied (mission §9: modal-open/hover/navigation must
      // never count) — the frontend UI is responsible for only sending
      // true after an explicit, distinct confirmation step; this route
      // and approveProposal() itself do not infer it from anything else.
      const strengthenedConfirmation = body?.strengthenedConfirmation === true;
      const approval = approveMaitreAction(c.req.param('approvalId'), { strengthenedConfirmation });
      return c.json({ ok: true, approval });
    } catch (err) {
      return handleMaitreError(c, err);
    }
  });

  route.post('/maitre/actions/:approvalId/reject', async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch { /* reason is optional */ }
    try {
      const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 2000) : '';
      const approval = rejectMaitreAction(c.req.param('approvalId'), { reason });
      return c.json({ ok: true, approval });
    } catch (err) {
      return handleMaitreError(c, err);
    }
  });

  route.post('/maitre/actions/:id/execute', async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch { /* approvalId may be omitted for a READY/ALLOW-decision action */ }
    try {
      // This route ONLY calls executeApprovedAction() — no reimplemented
      // policy/approval/TOCTOU/level logic here (mission §10). Every
      // safety property (approval validity, one-time consumption,
      // level re-check, target re-verification) is enforced inside that
      // already-certified function, exactly as it is for a MAÎTRE-9/10
      // action invoked any other way.
      const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : null;
      const run = await executeMaitreAction(c.req.param('id'), { approvalId, ...execOpts });
      return c.json({ ok: true, run });
    } catch (err) {
      return handleMaitreError(c, err);
    }
  });

  route.get('/maitre/actions/runs/:runId', (c) => {
    const run = getMaitreActionRunDetail(c.req.param('runId'));
    if (!run) return c.json({ ok: false, error: 'run_not_found' }, 404);
    return c.json({ ok: true, run });
  });

  if (logger) logger.info?.('MAITRE_ROUTE_REGISTERED');

  return route;
}
