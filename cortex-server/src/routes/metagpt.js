import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  createMission, getMission, listMissions, getMissionArtifacts,
  runPlanning, runCodegen, runPrepareApply, approveMission, runApply, cancelMission,
} from '../lib/metagpt-orchestrator.js';
import { ALLOWED_MISSION_MODES } from '../lib/metagpt-node-policy.js';
import { hasActiveJobs } from './jobs.js';

// Same loopback-only guard shape as openmontage.js/external-agents.js —
// MetaGPT Studio must never be reachable except from the local machine.
const localAddress = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);

const MAX_TITLE_LENGTH = 200;
const MAX_REQUIREMENT_LENGTH = 4000;

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

export function createMetaGptRoute({ logger, isLocal = c => localAddress(getConnInfo(c).remote.address) } = {}) {
  const route = new Hono();

  route.use('/metagpt/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: 'local_access_required' }, 403);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname)) return c.json({ error: 'host_denied' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      try { if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) return c.json({ error: 'origin_denied' }, 403); }
      catch { return c.json({ error: 'origin_denied' }, 403); }
    }
    // Only routes that actually read a JSON body enforce the content-type
    // check — /plan, /apply, /cancel take no payload (mirrors
    // openmontage.js's job/:id/cancel, which also has no body).
    const NO_BODY_SUFFIXES = ['/plan', '/apply', '/cancel', '/prepare-apply'];
    const requiresJsonBody = c.req.method === 'POST' && !NO_BODY_SUFFIXES.some(suffix => c.req.path.endsWith(suffix));
    if (requiresJsonBody && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415);
    await next();
  });

  // POST /api/metagpt/missions — MG-6C: create a mission from structured data only.
  route.post('/metagpt/missions', async (c) => {
    const body = await c.req.json().catch(() => ({}));

    const title = sanitizeText(body.title, MAX_TITLE_LENGTH);
    if (!title) return c.json({ error: 'title_invalid' }, 400);

    const requirement = sanitizeText(body.requirement, MAX_REQUIREMENT_LENGTH);
    if (!requirement) return c.json({ error: 'requirement_invalid' }, 400);

    const mode = String(body.mode ?? '');
    if (!ALLOWED_MISSION_MODES.has(mode)) {
      return c.json({ error: 'mode_denied', code: 'MODE_DENIED', allowed: [...ALLOWED_MISSION_MODES] }, 400);
    }

    const targetScope = sanitizeText(body.target_scope, 200);

    if (hasActiveJobs()) return c.json({ error: 'Un traitement est déjà en cours. Attends sa fin avant d\'en lancer un nouveau.' }, 409);

    try {
      const mission = createMission({ title, requirement, target_scope: targetScope, mode }, { logger });
      logger?.info?.({ mission_id: mission.id, mode }, 'METAGPT_MISSION_CREATED');
      return c.json({ ok: true, ...mission }, 201);
    } catch (err) {
      logger?.warn?.({ error_message: err.message, code: err.code }, 'METAGPT_MISSION_CREATE_DENIED');
      return c.json({ error: err.message, code: err.code }, 400);
    }
  });

  // GET /api/metagpt/missions — list all missions (most recent first).
  route.get('/metagpt/missions', (c) => {
    return c.json({ ok: true, missions: listMissions() });
  });

  // GET /api/metagpt/missions/:id — poll a single mission's full state.
  route.get('/metagpt/missions/:id', (c) => {
    const mission = getMission(c.req.param('id'));
    if (!mission) return c.json({ error: 'mission_not_found' }, 404);
    return c.json({ ok: true, mission });
  });

  // POST /api/metagpt/missions/:id/plan — MG-6F: run the certified planning pipeline.
  route.post('/metagpt/missions/:id/plan', async (c) => {
    const id = c.req.param('id');
    try {
      const result = await runPlanning(id, { logger });
      return c.json(result, result.ok ? 200 : 422);
    } catch (err) {
      logger?.error?.({ mission_id: id, error_message: err.message, code: err.code }, 'METAGPT_PLAN_ERROR');
      return c.json({ error: err.message, code: err.code }, err.code?.startsWith('invalid_') ? 409 : 500);
    }
  });

  // POST /api/metagpt/missions/:id/generate — MG-6G: text-only code generation.
  route.post('/metagpt/missions/:id/generate', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const files = Array.isArray(body.files) ? body.files.filter(f => typeof f === 'string') : [];
    try {
      const result = await runCodegen(id, { files, logger });
      return c.json(result, result.ok ? 200 : 422);
    } catch (err) {
      logger?.error?.({ mission_id: id, error_message: err.message, code: err.code }, 'METAGPT_CODEGEN_ERROR');
      return c.json({ error: err.message, code: err.code }, err.code?.startsWith('invalid_') || err.code === 'files_invalid' || err.code === 'mode_does_not_allow_codegen' ? 409 : 500);
    }
  });

  // POST /api/metagpt/missions/:id/prepare-apply — MG-6H: diff-only preparation.
  route.post('/metagpt/missions/:id/prepare-apply', async (c) => {
    const id = c.req.param('id');
    try {
      const result = await runPrepareApply(id, { logger });
      return c.json(result, result.ok ? 200 : 422);
    } catch (err) {
      logger?.error?.({ mission_id: id, error_message: err.message, code: err.code }, 'METAGPT_PREPARE_APPLY_ERROR');
      return c.json({ error: err.message, code: err.code }, err.code?.startsWith('invalid_') ? 409 : 500);
    }
  });

  // GET /api/metagpt/missions/:id/diff — read-only diff/approval package retrieval for the UI.
  route.get('/metagpt/missions/:id/diff', (c) => {
    const mission = getMission(c.req.param('id'));
    if (!mission) return c.json({ error: 'mission_not_found' }, 404);
    const prepareApply = mission.metadata?.prepare_apply;
    if (!prepareApply) return c.json({ error: 'diff_not_ready' }, 404);
    return c.json({ ok: true, diff_sha256: mission.diff_sha256, ...prepareApply });
  });

  // GET /api/metagpt/missions/:id/artifacts — PRD/Design/Tasks/generated files summary.
  route.get('/metagpt/missions/:id/artifacts', (c) => {
    const artifacts = getMissionArtifacts(c.req.param('id'));
    if (!artifacts) return c.json({ error: 'mission_not_found' }, 404);
    return c.json({ ok: true, ...artifacts });
  });

  // POST /api/metagpt/missions/:id/approve — MG-6I: approval bound to the
  // exact (diff_sha256, file list) pair the UI showed, never a bare flag.
  route.post('/metagpt/missions/:id/approve', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const diffSha256 = typeof body.diff_sha256 === 'string' ? body.diff_sha256 : '';
    const files = Array.isArray(body.files) ? body.files.filter(f => typeof f === 'string') : [];
    try {
      const result = approveMission(id, { diff_sha256: diffSha256, files, logger });
      logger?.info?.({ mission_id: id, diff_sha256: diffSha256 }, 'METAGPT_MISSION_APPROVED');
      return c.json(result, 200);
    } catch (err) {
      logger?.warn?.({ mission_id: id, error_message: err.message, code: err.code }, 'METAGPT_APPROVAL_DENIED');
      return c.json({ error: err.message, code: err.code }, 409);
    }
  });

  // POST /api/metagpt/missions/:id/apply — MG-6J: apply the exact approved diff only.
  route.post('/metagpt/missions/:id/apply', async (c) => {
    const id = c.req.param('id');
    try {
      const result = await runApply(id, { logger });
      return c.json(result, result.ok ? 200 : 422);
    } catch (err) {
      logger?.error?.({ mission_id: id, error_message: err.message, code: err.code }, 'METAGPT_APPLY_ERROR');
      return c.json({ error: err.message, code: err.code }, err.code?.startsWith('invalid_') ? 409 : 500);
    }
  });

  // POST /api/metagpt/missions/:id/cancel — MG-6M.
  route.post('/metagpt/missions/:id/cancel', (c) => {
    const id = c.req.param('id');
    try {
      const result = cancelMission(id, { logger });
      return c.json(result, 200);
    } catch (err) {
      return c.json({ error: err.message, code: err.code }, 404);
    }
  });

  return route;
}
