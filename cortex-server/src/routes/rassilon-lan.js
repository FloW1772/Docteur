import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import {
  authenticateLanRequest, assertDevicePermission, createRateLimiter, isLoopbackAddress, isPrivateIpv4,
  RassilonLanAuthError,
} from '../lib/rassilon-lan-auth.js';
import { completeRassilonPairing, requestRassilonPairing, RassilonPairingError, ensureLocalRassilonDevice } from '../lib/rassilon-pairing.js';
import { getRassilonCapabilities } from '../lib/rassilon-capabilities.js';
import { getJob, submitJobAndEnqueue, cancelJobById, getRassilonStatus } from '../lib/rassilon-worker.js';
import { createSignedRemoteResult, RassilonResultError } from '../lib/rassilon-remote-result.js';
import { recordAuditEvent } from '../lib/rassilon-audit.js';
import { getRassilonSettings } from '../lib/sqlite.js';

const MAX_LAN_BODY_BYTES = 256 * 1024;

function errorResponse(c, error) {
  if (error instanceof RassilonLanAuthError || error instanceof RassilonPairingError) {
    return c.json({ ok: false, error: error.code }, error.status);
  }
  if (error instanceof RassilonResultError) return c.json({ ok: false, error: error.code }, 422);
  throw error;
}

export function createRassilonLanRoute({
  providers = {},
  allowLoopbackForTests = false,
  remoteAddress = c => { try { return getConnInfo(c).remote.address; } catch { return ''; } },
} = {}) {
  const app = new Hono();
  const limiter = createRateLimiter();

  app.use('/rassilon-lan/*', async (c, next) => {
    const address = remoteAddress(c);
    if (!isPrivateIpv4(address) && !(allowLoopbackForTests && isLoopbackAddress(address))) {
      return c.json({ ok: false, error: 'private_lan_source_required' }, 403);
    }
    c.set('rassilonRemoteAddress', address);
    await next();
  });
  app.use('/rassilon-lan/*', bodyLimit({ maxSize: MAX_LAN_BODY_BYTES, onError: c => c.json({ ok: false, error: 'request_too_large' }, 413) }));

  const pairLimit = async (c, next) => {
    const key = `pair:${c.get('rassilonRemoteAddress')}`;
    if (!limiter.check(key, { limit: 8, windowMs: 60_000 })) return c.json({ ok: false, error: 'rate_limited' }, 429);
    await next();
  };
  app.use('/rassilon-lan/pair/*', pairLimit);

  app.post('/rassilon-lan/pair/request', async c => {
    try { return c.json({ ok: true, pairing: requestRassilonPairing(await c.req.json()) }, 202); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post('/rassilon-lan/pair/complete', async c => {
    try { return c.json({ ok: true, session: completeRassilonPairing(await c.req.json()) }); }
    catch (error) { return errorResponse(c, error); }
  });

  app.use('/rassilon-lan/status', authenticated);
  app.use('/rassilon-lan/heartbeat', authenticated);
  // Hono's '/jobs/*' also matches '/jobs' itself: registering both would run
  // authentication twice and the second pass rejects its own nonce as a replay.
  app.use('/rassilon-lan/jobs/*', authenticated);

  async function authenticated(c, next) {
    const raw = Buffer.from(await c.req.raw.clone().arrayBuffer());
    const source = c.get('rassilonRemoteAddress');
    if (!limiter.check(`auth:${source}`, { limit: 60, windowMs: 60_000 })) return c.json({ ok: false, error: 'rate_limited' }, 429);
    try {
      const auth = authenticateLanRequest({
        headers: c.req.raw.headers, method: c.req.method, path: new URL(c.req.url).pathname, bodyBytes: raw,
      });
      const category = c.req.method === 'POST' && new URL(c.req.url).pathname.endsWith('/jobs') ? 'jobs' : 'poll';
      const limits = category === 'jobs' ? { limit: 20, windowMs: 60_000 } : { limit: 120, windowMs: 60_000 };
      if (!limiter.check(`${category}:${auth.device.deviceId}`, limits)) return c.json({ ok: false, error: 'rate_limited' }, 429);
      c.set('rassilonAuth', auth);
      await next();
    } catch (error) {
      recordAuditEvent({ eventType: 'SESSION_REJECTED', resultSummary: { reason: error.code ?? 'auth_failed' } });
      return errorResponse(c, error);
    }
  }

  app.get('/rassilon-lan/status', async c => {
    const local = ensureLocalRassilonDevice();
    return c.json({ ok: true, capabilities: await getRassilonCapabilities({ deviceId: local.deviceId, providers }) });
  });
  app.post('/rassilon-lan/heartbeat', async c => {
    const local = ensureLocalRassilonDevice();
    const status = getRassilonStatus();
    return c.json({ ok: true, heartbeat: { deviceId: local.deviceId, state: status.state, available: status.enabled && ['IDLE', 'WORKING'].includes(status.state), timestamp: new Date().toISOString() } });
  });

  app.post('/rassilon-lan/jobs', async c => {
    const auth = c.get('rassilonAuth');
    let job;
    try { job = await c.req.json(); } catch { return c.json({ ok: false, error: 'invalid_json' }, 400); }
    const local = ensureLocalRassilonDevice();
    recordAuditEvent({ eventType: 'REMOTE_JOB_RECEIVED', jobId: job?.jobId ?? null, issuerDeviceId: auth.device.deviceId });
    try {
      if (!['CONTROLLER', 'BOTH'].includes(auth.device.role)) throw new RassilonLanAuthError('controller_role_required', 403);
      if (job?.issuerId !== auth.device.deviceId) throw new RassilonLanAuthError('job_issuer_mismatch', 403);
      if (job?.targetDeviceId !== local.deviceId) throw new RassilonLanAuthError('job_target_mismatch', 403);
      assertDevicePermission(auth.device, job?.jobType);
      if (!getRassilonSettings().acceptedJobTypes.includes(job?.jobType)) throw new RassilonLanAuthError('job_type_not_enabled_for_lan', 403);
      const outcome = submitJobAndEnqueue(job);
      if (!outcome.accepted) {
        recordAuditEvent({ eventType: 'REMOTE_JOB_REJECTED', jobId: job?.jobId ?? null, issuerDeviceId: auth.device.deviceId, resultSummary: { reason: outcome.reason } });
        return c.json({ ok: false, error: outcome.reason }, 400);
      }
      recordAuditEvent({ eventType: 'REMOTE_JOB_ACCEPTED', jobId: job.jobId, issuerDeviceId: auth.device.deviceId });
      return c.json({ ok: true, job: outcome.job }, 202);
    } catch (error) {
      recordAuditEvent({ eventType: 'REMOTE_JOB_REJECTED', jobId: job?.jobId ?? null, issuerDeviceId: auth.device.deviceId, resultSummary: { reason: error.code ?? 'rejected' } });
      return errorResponse(c, error);
    }
  });

  app.get('/rassilon-lan/jobs/:id', c => {
    const auth = c.get('rassilonAuth');
    const job = getJob(c.req.param('id'));
    if (!job || job.issuerDeviceId !== auth.device.deviceId) return c.json({ ok: false, error: 'job_not_found' }, 404);
    const local = ensureLocalRassilonDevice();
    const result = createSignedRemoteResult({ job, workerDeviceId: local.deviceId });
    return c.json({ ok: true, result });
  });

  app.post('/rassilon-lan/jobs/:id/cancel', c => {
    const auth = c.get('rassilonAuth');
    const job = getJob(c.req.param('id'));
    if (!job || job.issuerDeviceId !== auth.device.deviceId) return c.json({ ok: false, error: 'job_not_found' }, 404);
    try {
      recordAuditEvent({ eventType: 'REMOTE_STOP', jobId: job.jobId, issuerDeviceId: auth.device.deviceId });
      const cancelled = cancelJobById(job.jobId);
      recordAuditEvent({ eventType: 'REMOTE_JOB_CANCELLED', jobId: job.jobId, issuerDeviceId: auth.device.deviceId });
      return c.json({ ok: true, job: cancelled });
    } catch (error) { return c.json({ ok: false, error: error.code ?? 'cancel_failed' }, 409); }
  });

  app.notFound(c => c.json({ ok: false, error: 'route_not_found' }, 404));
  return app;
}
