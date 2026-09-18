/**
 * Semantic API routes for the Cyber Audit Agent (SENTINEL V1, CA-7). Same
 * loopback-only guard shape as metagpt.js/sherlock.js — this control
 * plane must never be reachable except from the local machine, even
 * though the missions it orchestrates reach out to an external,
 * authorized target.
 *
 * Every handler calls ONLY cyber-orchestrator.js — never
 * cyber-crawler.js, cyber-detect-*.js, or cyber-gateway.js directly, and
 * never accepts an arbitrary URL/command in a request body. There is
 * deliberately no /execute, /run, /shell, /raw-fetch, /arbitrary-url, or
 * /raw-command route — /start takes no body at all beyond the mission id
 * already in the path, and reuses only the scope persisted at creation.
 */
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import {
  createMission, getMission, listMissions, startMission, cancelMission,
  getMissionFindings, getMissionEvidence, getMissionEvents, getMissionReport,
} from '../lib/cyber-orchestrator.js';
import { CyberAuditPolicyError } from '../lib/cyber-policy.js';

const localAddress = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);

function statusForError(err) {
  if (err instanceof CyberAuditPolicyError || typeof err?.code === 'string') {
    if (err.code === 'mission_not_found') return 404;
    return 409;
  }
  return 500;
}

const defaultGateway = {
  createMission, getMission, listMissions, startMission, cancelMission,
  getMissionFindings, getMissionEvidence, getMissionEvents, getMissionReport,
};

// `gateway` is injectable ONLY so tests can substitute a startMission
// that passes { allowPrivateFixture: true } against the local test
// fixture (127.0.0.1) — mirrors sherlock.js's own `gateway` injection
// point. The real, registered route (server.js) always uses
// defaultGateway, so a live mission can never bypass the private-address
// check this way.
export function createCyberAuditRoute({ logger, isLocal = c => { try { return localAddress(getConnInfo(c).remote.address); } catch { return false; } }, gateway = defaultGateway } = {}) {
  const route = new Hono();
  const {
    createMission, getMission, listMissions, startMission, cancelMission,
    getMissionFindings, getMissionEvidence, getMissionEvents, getMissionReport,
  } = gateway;

  route.use('/cyber-audit/*', async (c, next) => {
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
    const NO_BODY_SUFFIXES = ['/start', '/cancel'];
    const requiresJsonBody = c.req.method === 'POST' && !NO_BODY_SUFFIXES.some(suffix => c.req.path.endsWith(suffix));
    if (requiresJsonBody && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415);
    await next();
  });
  route.use('/cyber-audit/*', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  // POST /api/cyber-audit/missions — create a mission (CREATED -> READY).
  route.post('/cyber-audit/missions', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }
    try {
      const mission = createMission(body);
      logger?.info?.({ mission_id: mission.id }, 'CYBER_AUDIT_MISSION_CREATED');
      return c.json({ ok: true, mission }, 201);
    } catch (err) {
      logger?.warn?.({ error_message: err.message, code: err.code }, 'CYBER_AUDIT_MISSION_CREATE_DENIED');
      return c.json({ error: err.code || err.message }, 400);
    }
  });

  // GET /api/cyber-audit/missions — list all missions (most recent first).
  route.get('/cyber-audit/missions', (c) => c.json({ ok: true, missions: listMissions() }));

  // GET /api/cyber-audit/missions/:id — poll one mission's summary.
  route.get('/cyber-audit/missions/:id', (c) => {
    const mission = getMission(c.req.param('id'));
    if (!mission) return c.json({ error: 'mission_not_found' }, 404);
    return c.json({ ok: true, mission });
  });

  // POST /api/cyber-audit/missions/:id/start — no body; uses the scope
  // already persisted at creation time only.
  route.post('/cyber-audit/missions/:id/start', (c) => {
    const id = c.req.param('id');
    try {
      const mission = startMission(id);
      logger?.info?.({ mission_id: id }, 'CYBER_AUDIT_MISSION_STARTED');
      return c.json({ ok: true, mission }, 200);
    } catch (err) {
      logger?.warn?.({ mission_id: id, error_message: err.message, code: err.code }, 'CYBER_AUDIT_START_DENIED');
      return c.json({ error: err.code || err.message }, statusForError(err));
    }
  });

  // POST /api/cyber-audit/missions/:id/cancel — idempotent.
  route.post('/cyber-audit/missions/:id/cancel', (c) => {
    const id = c.req.param('id');
    try {
      const mission = cancelMission(id);
      logger?.info?.({ mission_id: id }, 'CYBER_AUDIT_MISSION_CANCELLED');
      return c.json({ ok: true, mission }, 200);
    } catch (err) {
      return c.json({ error: err.code || err.message }, statusForError(err));
    }
  });

  // GET /api/cyber-audit/missions/:id/findings
  route.get('/cyber-audit/missions/:id/findings', (c) => {
    const findings = getMissionFindings(c.req.param('id'));
    if (findings === null) return c.json({ error: 'mission_not_found' }, 404);
    return c.json({ ok: true, findings });
  });

  // GET /api/cyber-audit/missions/:id/evidence/:evidenceId
  route.get('/cyber-audit/missions/:id/evidence/:evidenceId', (c) => {
    const evidence = getMissionEvidence(c.req.param('id'), c.req.param('evidenceId'));
    if (evidence === null) return c.json({ error: 'evidence_not_found' }, 404);
    return c.json({ ok: true, evidence });
  });

  // GET /api/cyber-audit/missions/:id/events
  route.get('/cyber-audit/missions/:id/events', (c) => {
    const events = getMissionEvents(c.req.param('id'));
    if (events === null) return c.json({ error: 'mission_not_found' }, 404);
    return c.json({ ok: true, events });
  });

  // GET /api/cyber-audit/missions/:id/report?format=html|json — CA-9.
  // No user-supplied template, no arbitrary URL: format is a closed
  // two-value enum, everything else comes from the mission's own
  // already-persisted, already-redacted data.
  route.get('/cyber-audit/missions/:id/report', (c) => {
    const id = c.req.param('id');
    const format = c.req.query('format') === 'json' ? 'json' : 'html';
    const report = getMissionReport(id, format);
    if (report === null) return c.json({ error: 'mission_not_found' }, 404);
    if (report.format === 'json') return c.json(JSON.parse(report.content));
    return c.html(report.content);
  });

  return route;
}
