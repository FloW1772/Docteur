import { Hono } from 'hono';
import crypto from 'node:crypto';
import {
  insertVideoJob, updateVideoJob, getVideoJobById, getAllVideoJobs,
  getActiveVideoJob, getSegmentsByJobId, deleteVideoJob,
} from '../lib/sqlite.js';
import { estimateVideo, runVideoPipeline, requestCancel, removeJobDir } from '../lib/video-pipeline/pipeline.js';
import { hasActiveJobs } from './jobs.js';
import { assertSafeUrl } from '../lib/url-security.js';

const RESUME_TYPES = ['educatif', 'interview', 'podcast', 'rediff', 'auto'];
const WHISPER_PROVIDERS = ['auto', 'groq', 'local'];
const SYNTHESIS_PROVIDERS = ['local', 'groq', 'gemini'];

export function createVideoSummaryRoute({ services, ollamaClient, logger } = {}) {
  const route = new Hono();

  // POST /api/video-summary/estimate — durée, chunks, temps estimés, quota (pas de téléchargement)
  route.post('/video-summary/estimate', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = String(body.url ?? '').trim();
    if (!url) return c.json({ error: 'URL manquante' }, 400);
    try {
      assertSafeUrl(url);
      const estimate = await estimateVideo(url);
      if (!estimate.ok) return c.json({ error: estimate.error }, 422);
      return c.json(estimate);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // POST /api/video-summary/jobs — crée le job durable et lance le pipeline en tâche de fond
  route.post('/video-summary/jobs', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = String(body.url ?? '').trim();
    if (!url) return c.json({ error: 'URL manquante' }, 400);
    try { assertSafeUrl(url); } catch (err) { return c.json({ error: err.message }, 400); }

    const resumeType = RESUME_TYPES.includes(body.resumeType) ? body.resumeType : 'auto';
    const whisperProvider = WHISPER_PROVIDERS.includes(body.whisperProvider) ? body.whisperProvider : 'auto';
    const synthesisProvider = SYNTHESIS_PROVIDERS.includes(body.synthesisProvider) ? body.synthesisProvider : 'local';
    const isPrivate = !!body.private;

    // Un seul job lourd à la fois — même convention que BatchProgressModal / hasActiveJobs()
    const active = getActiveVideoJob();
    if (active || hasActiveJobs()) {
      return c.json({ error: 'Un traitement est déjà en cours. Attends sa fin avant d\'en lancer un nouveau.' }, 409);
    }

    const id = crypto.randomUUID();
    const duration_s = body.duration_s ?? null;
    insertVideoJob({
      id, url, title: body.title ?? null, status: 'pending',
      provider_whisper: whisperProvider, provider_synthesis: synthesisProvider,
      resume_type: resumeType, duration_s, private: isPrivate,
    });

    // Fire-and-forget — la pipeline continue après la réponse HTTP
    runVideoPipeline(id, { ollamaClient, services, logger }).catch(err => {
      logger?.error({ jobId: id, err: err.message }, 'VIDEO_PIPELINE_UNCAUGHT');
    });

    return c.json({ jobId: id }, 201);
  });

  // GET /api/video-summary/jobs — historique
  route.get('/video-summary/jobs', (c) => {
    return c.json({ jobs: getAllVideoJobs() });
  });

  // GET /api/video-summary/jobs/:id — détail + segments
  route.get('/video-summary/jobs/:id', (c) => {
    const id = c.req.param('id');
    const job = getVideoJobById(id);
    if (!job) return c.json({ error: 'Job introuvable' }, 404);
    const segments = getSegmentsByJobId(id).map(s => ({
      id: s.id, idx: s.idx, start_s: s.start_s, end_s: s.end_s,
      transcript_status: s.transcript_status, summary_status: s.summary_status,
      error_message: s.error_message, has_transcript: !!s.transcript, has_summary: !!s.summary,
    }));
    return c.json({ job, segments });
  });

  // POST /api/video-summary/jobs/:id/resume — relance en sautant les segments déjà terminés
  route.post('/video-summary/jobs/:id/resume', (c) => {
    const id = c.req.param('id');
    const job = getVideoJobById(id);
    if (!job) return c.json({ error: 'Job introuvable' }, 404);
    if (job.status === 'done') return c.json({ error: 'Job déjà terminé' }, 400);

    const active = getActiveVideoJob();
    if ((active && active.id !== id) || hasActiveJobs()) {
      return c.json({ error: 'Un autre traitement est déjà en cours.' }, 409);
    }

    updateVideoJob(id, { cancelled: false, status: 'pending', error_message: null });
    runVideoPipeline(id, { ollamaClient, services, logger }).catch(err => {
      logger?.error({ jobId: id, err: err.message }, 'VIDEO_PIPELINE_UNCAUGHT');
    });
    return c.json({ ok: true });
  });

  // POST /api/video-summary/jobs/:id/cancel — annulation coopérative, travail conservé
  route.post('/video-summary/jobs/:id/cancel', (c) => {
    const id = c.req.param('id');
    const job = getVideoJobById(id);
    if (!job) return c.json({ error: 'Job introuvable' }, 404);
    requestCancel(id);
    return c.json({ ok: true });
  });

  // DELETE /api/video-summary/jobs/:id
  route.delete('/video-summary/jobs/:id', (c) => {
    const id = c.req.param('id');
    if (!getVideoJobById(id)) return c.json({ error: 'Job introuvable' }, 404);
    deleteVideoJob(id);
    removeJobDir(id);
    return c.json({ ok: true });
  });

  return route;
}
