import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';

// In-memory job registry — dies with server restart, which is acceptable
// Client re-registers on each batch start; stale jobs auto-purge after 10 min
const jobs = new Map();
const DONE_TTL_MS = 10 * 60 * 1000;

function purge() {
  const cutoff = Date.now() - DONE_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.updatedAt < cutoff) jobs.delete(id);
  }
}

// Used by the vision route to warn before starting a heavy GPU load (vision
// model) on top of a batch/transcription job already running — same registry
// BatchProgressModal already writes to client-side, no new tracking added.
export function hasActiveJobs() {
  purge();
  for (const job of jobs.values()) {
    if (job.status === 'running') return true;
  }
  return false;
}

// Direct registry access for server-side callers (e.g. the video pipeline)
// that need to drive BatchProgressModal without an HTTP round-trip to itself.
export function registerJob(id, operation, total) {
  const job = {
    id,
    operation:    String(operation ?? 'Traitement'),
    current:      0,
    total:        Number(total ?? 0),
    currentLabel: '',
    okCount:      0,
    fallbackCount: 0,
    errorCount:   0,
    startedAt:    Date.now(),
    updatedAt:    Date.now(),
    status:       'running',
    summary:      null,
  };
  jobs.set(id, job);
  return id;
}

export function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job) return;
  if (updates.current       !== undefined) job.current       = Number(updates.current);
  if (updates.currentLabel  !== undefined) job.currentLabel  = String(updates.currentLabel);
  if (updates.okCount       !== undefined) job.okCount       = Number(updates.okCount);
  if (updates.fallbackCount !== undefined) job.fallbackCount = Number(updates.fallbackCount);
  if (updates.errorCount    !== undefined) job.errorCount    = Number(updates.errorCount);
  if (updates.status        !== undefined) job.status        = String(updates.status);
  if (updates.summary       !== undefined) job.summary       = updates.summary;
  job.updatedAt = Date.now();
}

export function finishJob(id, status, summary) {
  const job = jobs.get(id);
  if (!job) return;
  job.status    = String(status ?? 'done');
  job.summary   = summary ?? null;
  job.updatedAt = Date.now();
}

export function createJobsRoute() {
  const route = new Hono();

  // GET /api/jobs — list all active + recent jobs (auto-purges stale done jobs)
  route.get('/jobs', (c) => {
    purge();
    return c.json({ ok: true, jobs: [...jobs.values()] });
  });

  // POST /api/jobs — register a new job, returns { ok, id }
  route.post('/jobs', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body.id ?? randomUUID();
    const job = {
      id,
      operation:    String(body.operation ?? 'Traitement'),
      current:      0,
      total:        Number(body.total ?? 0),
      currentLabel: '',
      okCount:      0,
      fallbackCount: 0,
      errorCount:   0,
      startedAt:    Date.now(),
      updatedAt:    Date.now(),
      status:       'running',
      summary:      null,
    };
    jobs.set(id, job);
    return c.json({ ok: true, id });
  });

  // PUT /api/jobs/:id — update progress fields
  // 404 here is expected/routine, not a bug: jobs are intentionally
  // in-memory only (see comment at top of file) and are wiped by any server
  // restart. The client (cortexClient.updateJob) already treats this as
  // non-fatal and ignores it — `code: 'JOB_NOT_FOUND'` lets a caller that
  // does care (e.g. to stop a local progress mirror) distinguish this from
  // an unrelated server error, without needing to parse the message text.
  route.put('/jobs/:id', async (c) => {
    const id  = c.req.param('id');
    const job = jobs.get(id);
    if (!job) return c.json({ error: 'not found', code: 'JOB_NOT_FOUND' }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (body.current      !== undefined) job.current      = Number(body.current);
    if (body.currentLabel !== undefined) job.currentLabel = String(body.currentLabel);
    if (body.okCount      !== undefined) job.okCount      = Number(body.okCount);
    if (body.fallbackCount !== undefined) job.fallbackCount = Number(body.fallbackCount);
    if (body.errorCount   !== undefined) job.errorCount   = Number(body.errorCount);
    if (body.status       !== undefined) job.status       = String(body.status);
    if (body.summary      !== undefined) job.summary      = body.summary;
    job.updatedAt = Date.now();
    return c.json({ ok: true });
  });

  // DELETE /api/jobs/:id — mark completed (idempotent)
  route.delete('/jobs/:id', async (c) => {
    const id  = c.req.param('id');
    const job = jobs.get(id);
    if (!job) return c.json({ ok: true });
    const body   = await c.req.json().catch(() => ({}));
    job.status   = String(body.status ?? 'done');
    job.summary  = body.summary ?? null;
    job.updatedAt = Date.now();
    return c.json({ ok: true });
  });

  return route;
}
