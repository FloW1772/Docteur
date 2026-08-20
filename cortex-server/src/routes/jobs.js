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
  route.put('/jobs/:id', async (c) => {
    const id  = c.req.param('id');
    const job = jobs.get(id);
    if (!job) return c.json({ error: 'not found' }, 404);
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
