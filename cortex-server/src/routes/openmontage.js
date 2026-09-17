import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  getStatus, getCapabilities, createWorkspace, startRender, cancelJob, getJobStatus, reapJob,
  WORKSPACES_ROOT,
} from '../lib/openmontage-adapter.js';
import { hasActiveJobs } from './jobs.js';

// Same loopback-only guard shape as external-agents.js — this feature must
// never be reachable except from the local machine, and never talks to any
// cloud provider regardless of caller.
const localAddress = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);

// First supported project type only ("Vidéo locale simple"): a fixed
// resolution/FPS allowlist and a bounded duration. No arbitrary filesystem
// path, no composition id, no CLI args, no remote URL is ever accepted from
// the client — those are all resolved server-side by the adapter itself.
const RESOLUTIONS = {
  '1920x1080': { width: 1920, height: 1080 },
  '1080x1920': { width: 1080, height: 1920 },
  '1080x1080': { width: 1080, height: 1080 },
};
const FPS_VALUES = new Set([24, 25, 30]);
const MIN_DURATION_SECONDS = 3;
const MAX_DURATION_SECONDS = 10;
const MAX_TEXT_LENGTH = 120;

// Strips control characters and caps length; the value only ever reaches
// Remotion as a JSON-encoded React prop (never a shell argument, never a
// filesystem path), but user-facing text still shouldn't carry control
// bytes or absurd length into the render.
function sanitizeText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, MAX_TEXT_LENGTH);
}

const jobs = new Map(); // jobId -> { status, startedAt, finishedAt, outputPath, error, cancelled }

export function createOpenMontageRoute({ isLocal = c => localAddress(getConnInfo(c).remote.address) } = {}) {
  const route = new Hono();

  route.use('/openmontage/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: 'local_access_required' }, 403);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname)) return c.json({ error: 'host_denied' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      try { if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) return c.json({ error: 'origin_denied' }, 403); }
      catch { return c.json({ error: 'origin_denied' }, 403); }
    }
    if (!['GET', 'HEAD'].includes(c.req.method) && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415);
    await next();
  });

  // GET /api/openmontage/status
  route.get('/openmontage/status', async (c) => {
    try {
      const status = await getStatus();
      return c.json({ status });
    } catch (err) {
      return c.json({ status: 'ERROR', error: err.message }, 500);
    }
  });

  // GET /api/openmontage/capabilities
  route.get('/openmontage/capabilities', async (c) => {
    try {
      const capabilities = await getCapabilities();
      return c.json(capabilities);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // POST /api/openmontage/render — the only project type: "Vidéo locale simple"
  route.post('/openmontage/render', async (c) => {
    const body = await c.req.json().catch(() => ({}));

    const resolutionKey = String(body.resolution ?? '');
    const resolution = RESOLUTIONS[resolutionKey];
    if (!resolution) return c.json({ error: 'resolution_invalid' }, 400);

    const fps = Number(body.fps);
    if (!FPS_VALUES.has(fps)) return c.json({ error: 'fps_invalid' }, 400);

    const durationSeconds = Number(body.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) {
      return c.json({ error: 'duration_invalid' }, 400);
    }

    const title = sanitizeText(body.title, 'DOCTEUR');
    const subtitle = sanitizeText(body.subtitle, 'Local Video Pipeline');

    // Same single-heavy-job convention as video-summary.js.
    if (hasActiveJobs()) return c.json({ error: 'Un traitement est déjà en cours. Attends sa fin avant d\'en lancer un nouveau.' }, 409);
    for (const job of jobs.values()) if (job.status === 'running') return c.json({ error: 'Un rendu OpenMontage est déjà en cours.' }, 409);

    const status = await getStatus();
    if (status !== 'READY_LOCAL') return c.json({ error: 'DEPENDENCY_MISSING', status }, 503);

    const jobId = crypto.randomUUID();
    const { dir } = createWorkspace(jobId);
    const record = { status: 'running', startedAt: Date.now(), finishedAt: null, outputPath: null, error: null, cancelled: false, width: resolution.width, height: resolution.height, fps, durationSeconds };
    jobs.set(jobId, record);

    const { done, outputPath } = startRender({
      jobId,
      workspaceDir: dir,
      outputRelativePath: 'output.mp4',
      title,
      subtitle,
      durationInFrames: Math.round(durationSeconds * fps),
      timeout: 300000,
    });
    record.outputPath = outputPath;

    done.then(result => {
      record.finishedAt = Date.now();
      record.cancelled = result.cancelled;
      record.status = result.cancelled ? 'cancelled' : (result.ok ? 'done' : 'failed');
      record.error = result.ok ? null : (result.error || 'render_failed');
      reapJob(jobId);
    }).catch(err => {
      record.finishedAt = Date.now();
      record.status = 'failed';
      record.error = err.message;
      reapJob(jobId);
    });

    return c.json({ jobId }, 201);
  });

  // GET /api/openmontage/job/:id
  route.get('/openmontage/job/:id', (c) => {
    const id = c.req.param('id');
    const record = jobs.get(id);
    if (!record) return c.json({ error: 'Job introuvable' }, 404);
    const runtimeStatus = getJobStatus(id);
    return c.json({
      jobId: id,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      elapsedMs: (record.finishedAt ?? Date.now()) - record.startedAt,
      error: record.error,
      cancelled: record.cancelled,
      width: record.width,
      height: record.height,
      fps: record.fps,
      durationSeconds: record.durationSeconds,
      hasArtifact: record.status === 'done' && !!record.outputPath && fs.existsSync(record.outputPath),
      pid: runtimeStatus.pid ?? null,
    });
  });

  // POST /api/openmontage/job/:id/cancel
  route.post('/openmontage/job/:id/cancel', (c) => {
    const id = c.req.param('id');
    const record = jobs.get(id);
    if (!record) return c.json({ error: 'Job introuvable' }, 404);
    if (record.status !== 'running') return c.json({ ok: true, alreadyFinished: true });
    const result = cancelJob(id);
    return c.json({ ok: result.ok !== false });
  });

  // GET /api/openmontage/job/:id/artifact — streams the rendered MP4 back.
  // The path served is never client-supplied: it is the exact outputPath
  // this same route computed via the adapter's own workspace resolution.
  route.get('/openmontage/job/:id/artifact', (c) => {
    const id = c.req.param('id');
    const record = jobs.get(id);
    if (!record) return c.json({ error: 'Job introuvable' }, 404);
    if (record.status !== 'done' || !record.outputPath || !fs.existsSync(record.outputPath)) {
      return c.json({ error: 'Artefact indisponible' }, 404);
    }
    // Defense in depth: outputPath must still resolve under WORKSPACES_ROOT
    // even though it was never influenced by client input.
    if (!record.outputPath.startsWith(WORKSPACES_ROOT)) return c.json({ error: 'path_denied' }, 403);
    const stream = fs.createReadStream(record.outputPath);
    return new Response(stream, { headers: { 'Content-Type': 'video/mp4' } });
  });

  return route;
}
