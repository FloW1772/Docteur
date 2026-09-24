/**
 * RASSILON V1 Phase 2 — local-only control-plane + job-submission API
 * (mission §40). Same loopback-only + Origin-check guard shape as
 * maitre.js/monitor.js/cyber-audit.js — this control plane must never be
 * reachable except from the local machine (mission §42: LAN listener 0,
 * Internet listener 0). Every handler calls ONLY rassilon-worker.js —
 * never rassilon-executors.js/rassilon-job-schema.js internals directly,
 * mirroring MAÎTRE's routes-stay-thin discipline.
 *
 * No /shell, /exec, /run, /script, and no field named command/cmd/shell/
 * script anywhere in this surface (mission §40 architecture report) —
 * structurally absent, not merely unused.
 *
 * Job submission requires a full signature even on loopback (mission
 * §41 — "Ne pas bypass signature 'parce que loopback'"): the identity/
 * signature check happens inside rassilon-worker.js's submitJob, this
 * route layer adds no exception for local callers.
 */
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import {
  getRassilonStatus, enableRassilon, disableRassilon, pauseRassilon, resumeRassilon,
  killAllRassilonWork, submitJobAndEnqueue, getJob, listJobs, cancelJobById,
  changeRassilonSettings, RassilonWorkerError,
  cancelJobsByIssuer,
} from '../lib/rassilon-worker.js';
import {
  getRassilonSettings, getRassilonDevice, getRassilonDeviceSessionView, getRassilonPairing,
  listRassilonDevices, revokeRassilonDevice,
} from '../lib/sqlite.js';
import { RassilonSettingsError } from '../lib/rassilon-settings.js';
import {
  startRassilonPairing, confirmRassilonPairing, rejectRassilonPairing, RassilonPairingError,
} from '../lib/rassilon-pairing.js';
import {
  getRassilonLanRuntimeStatus, startRassilonLanServer, stopRassilonLanServer, RassilonLanServerError,
} from '../lib/rassilon-lan-server.js';
import {
  completeOutboundRassilonPairing, dispatchRassilonRemoteJob, requestOutboundRassilonPairing,
  RassilonControllerError,
} from '../lib/rassilon-controller.js';
import { getAuditLog, recordAuditEvent } from '../lib/rassilon-audit.js';
import { deriveDevicePresence } from '../lib/rassilon-scheduler.js';

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

function handleRassilonError(c, err) {
  if (err instanceof RassilonWorkerError || err instanceof RassilonSettingsError || err instanceof RassilonPairingError || err instanceof RassilonLanServerError || err instanceof RassilonControllerError) {
    const status = err.status ?? (err.code === 'job_not_found' ? 404 : 400);
    return c.json({ ok: false, error: err.code }, status);
  }
  throw err;
}

function deviceView(device) {
  return {
    deviceId: device.deviceId,
    displayName: device.displayName,
    fingerprint: device.fingerprint,
    role: device.role,
    permissions: device.permissionSet,
    status: device.status,
    presence: deriveDevicePresence(device),
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    session: getRassilonDeviceSessionView(device.deviceId),
  };
}

function pairingView(pairing) {
  if (!pairing) return null;
  return {
    pairingId: pairing.pairingId,
    state: pairing.state,
    controllerDeviceId: pairing.controllerDeviceId,
    controllerDisplayName: pairing.controllerDisplayName,
    controllerFingerprint: pairing.controllerFingerprint,
    requestedPermissions: pairing.requestedPermissions,
    approvedPermissions: pairing.approvedPermissions,
    createdAt: pairing.createdAt,
    expiresAt: pairing.expiresAt,
    confirmedAt: pairing.confirmedAt,
    usedAt: pairing.usedAt,
    cancelledAt: pairing.cancelledAt,
  };
}

export function createRassilonRoute({
  logger,
  isLocal = c => { try { return localAddress(getConnInfo(c).remote.address); } catch { return false; } },
} = {}) {
  const route = new Hono();

  route.use('/rassilon/*', async (c, next) => {
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
  // Bounded body (mission §40 — "body bounded"). 64KB comfortably covers
  // the largest Phase 2 job payload (JSON_TRANSFORM_BENCH's 10k-item
  // array) plus settings/job envelopes, with headroom, while still
  // rejecting anything resembling an oversized-payload attack (mission
  // §24/§57).
  route.use('/rassilon/*', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  // ── Status / settings ────────────────────────────────────────────────

  route.get('/rassilon/status', (c) => {
    return c.json({ ok: true, ...getRassilonStatus() });
  });

  route.get('/rassilon/settings', (c) => {
    return c.json({ ok: true, settings: getRassilonSettings() });
  });

  route.put('/rassilon/settings', async (c) => {
    try {
      const body = await c.req.json();
      const settings = changeRassilonSettings(body);
      return c.json({ ok: true, settings });
    } catch (err) {
      return handleRassilonError(c, err);
    }
  });

  // ── Lifecycle (mission §31-§34) ──────────────────────────────────────

  route.post('/rassilon/enable', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const status = enableRassilon(body);
      return c.json({ ok: true, ...status });
    } catch (err) {
      return handleRassilonError(c, err);
    }
  });

  route.post('/rassilon/disable', async (c) => {
    const status = disableRassilon();
    await stopRassilonLanServer();
    return c.json({ ok: true, ...status });
  });

  route.post('/rassilon/pause', (c) => {
    try {
      return c.json({ ok: true, ...pauseRassilon() });
    } catch (err) {
      return handleRassilonError(c, err);
    }
  });

  route.post('/rassilon/resume', (c) => {
    try {
      return c.json({ ok: true, ...resumeRassilon() });
    } catch (err) {
      return handleRassilonError(c, err);
    }
  });

  route.post('/rassilon/stop', async (c) => {
    const status = killAllRassilonWork();
    await stopRassilonLanServer();
    return c.json({ ok: true, ...status });
  });

  // Phase 4 LAN controls remain loopback-only. There is deliberately no
  // equivalent on /rassilon-lan: a remote controller cannot enable LAN,
  // change quotas, approve pairing, or override the local STOP authority.
  route.get('/rassilon/lan/status', c => c.json({ ok: true, lan: getRassilonLanRuntimeStatus() }));

  route.post('/rassilon/lan/enable', async c => {
    try {
      if (!getRassilonStatus().enabled) throw new RassilonWorkerError('rassilon_disabled');
      if (getRassilonSettings().acceptedJobTypes.length === 0) throw new RassilonWorkerError('lan_requires_explicit_accepted_job_types');
      const body = await c.req.json();
      const { bindAddress, port, networkProfile, allowUnknownNetworkProfile } = body ?? {};
      return c.json({ ok: true, lan: await startRassilonLanServer({ bindAddress, port, networkProfile, allowUnknownNetworkProfile }) });
    } catch (err) { return handleRassilonError(c, err); }
  });

  route.post('/rassilon/lan/disable', async c => {
    return c.json({ ok: true, lan: await stopRassilonLanServer() });
  });

  route.post('/rassilon/pairing/start', c => {
    try {
      if (getRassilonLanRuntimeStatus().state !== 'LISTENING') throw new RassilonLanServerError('lan_not_listening');
      return c.json({ ok: true, pairing: startRassilonPairing() }, 201);
    }
    catch (err) { return handleRassilonError(c, err); }
  });

  route.get('/rassilon/pairing/:id', c => {
    const pairing = getRassilonPairing(c.req.param('id'));
    return pairing
      ? c.json({ ok: true, pairing: pairingView(pairing) })
      : c.json({ ok: false, error: 'pairing_unknown' }, 404);
  });

  route.post('/rassilon/pairing/:id/confirm', async c => {
    try { return c.json({ ok: true, pairing: confirmRassilonPairing(c.req.param('id'), await c.req.json()) }); }
    catch (err) { return handleRassilonError(c, err); }
  });

  route.post('/rassilon/pairing/:id/reject', c => {
    try { return c.json({ ok: true, pairing: rejectRassilonPairing(c.req.param('id')) }); }
    catch (err) { return handleRassilonError(c, err); }
  });

  route.post('/rassilon/controller/pairing/request', async c => {
    try { return c.json({ ok: true, pairing: await requestOutboundRassilonPairing(await c.req.json()) }, 202); }
    catch (err) { return handleRassilonError(c, err); }
  });

  route.post('/rassilon/controller/pairing/:id/complete', async c => {
    try { return c.json({ ok: true, session: await completeOutboundRassilonPairing({ pairingId: c.req.param('id') }) }); }
    catch (err) { return handleRassilonError(c, err); }
  });

  route.get('/rassilon/devices', c => c.json({
    ok: true,
    devices: listRassilonDevices().map(deviceView),
  }));
  route.get('/rassilon/devices/:id/status', c => {
    const device = getRassilonDevice(c.req.param('id'), { includeRevoked: true });
    return device ? c.json({ ok: true, device: deviceView(device) }) : c.json({ ok: false, error: 'device_not_found' }, 404);
  });
  route.post('/rassilon/devices/:id/revoke', c => {
    const deviceId = c.req.param('id');
    const revoked = revokeRassilonDevice(deviceId);
    const cancelledJobs = revoked ? cancelJobsByIssuer(deviceId) : 0;
    if (revoked) recordAuditEvent({ eventType: 'DEVICE_REVOKED', issuerDeviceId: deviceId, resultSummary: { cancelledJobs } });
    return revoked ? c.json({ ok: true, revoked: true, cancelledJobs }) : c.json({ ok: false, error: 'device_not_found_or_already_revoked' }, 404);
  });

  route.post('/rassilon/jobs/dispatch', async c => {
    try { return c.json({ ok: true, ...(await dispatchRassilonRemoteJob(await c.req.json())) }, 202); }
    catch (err) { return handleRassilonError(c, err); }
  });

  route.get('/rassilon/audit', c => {
    const limit = clampLimit(c.req.query('limit'));
    const offset = clampOffset(c.req.query('offset'));
    const events = getAuditLog({ limit, offset }).map(event => {
      const job = event.job_id ? getJob(event.job_id) : null;
      const failure = /(?:FAILED|REJECTED|ERROR|INTERRUPTED)$/.test(event.event_type);
      const success = /(?:COMPLETED|SUCCEEDED|ENABLED|RESUMED|CREATED)$/.test(event.event_type);
      return {
        id: event.id,
        eventType: event.event_type,
        deviceId: event.issuer_device_id,
        jobId: event.job_id,
        jobType: job?.jobType ?? null,
        timestamp: event.created_at,
        status: failure ? 'ERROR' : success ? 'OK' : 'INFO',
      };
    });
    return c.json({ ok: true, events });
  });

  // ── Jobs ──────────────────────────────────────────────────────────────

  route.get('/rassilon/jobs', (c) => {
    const limit = clampLimit(c.req.query('limit'));
    const offset = clampOffset(c.req.query('offset'));
    const status = c.req.query('status') || null;
    return c.json({ ok: true, jobs: listJobs({ limit, offset, status }) });
  });

  route.get('/rassilon/jobs/:id', (c) => {
    const job = getJob(c.req.param('id'));
    if (!job) return c.json({ ok: false, error: 'job_not_found' }, 404);
    return c.json({ ok: true, job });
  });

  route.post('/rassilon/jobs/:id/cancel', (c) => {
    try {
      const job = cancelJobById(c.req.param('id'));
      return c.json({ ok: true, job });
    } catch (err) {
      return handleRassilonError(c, err);
    }
  });

  // Job submission — signature required even from loopback (mission §41).
  // The request body IS the signed job envelope (mission §8 schema);
  // rassilon-worker.js's submitJobAndEnqueue runs the full acceptance
  // pipeline (schema, forbidden-key, signature, replay/expiry, policy,
  // resource admission, queue bound) before this handler ever sees a
  // success/failure outcome — the route never re-implements any of that
  // logic itself.
  route.post('/rassilon/jobs', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }
    const outcome = submitJobAndEnqueue(body);
    if (!outcome.accepted) {
      return c.json({ ok: false, error: outcome.reason }, 400);
    }
    return c.json({ ok: true, job: outcome.job }, 202);
  });

  return route;
}
