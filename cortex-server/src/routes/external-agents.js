import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { streamSSE } from 'hono/streaming';

const localAddress = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
export function createExternalAgentsRoute({ service, isLocal = c => localAddress(getConnInfo(c).remote.address) }) {
  const route = new Hono();
  route.use('/external-agents/*', async (c, next) => {
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
  route.onError((error, c) => c.json({ error: /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'external_agent_error' }, 400));
  route.get('/external-agents/settings', c => c.json(service.settings()));
  route.get('/external-agents/clients', async c => c.json(await service.detect()));
  route.post('/external-agents/test/:provider', async c => c.json(await service.probe(c.req.param('provider'))));
  route.post('/external-agents/roots', async c => c.json(service.requestRoot((await c.req.json()).cwd)));
  route.post('/external-agents/roots/:id/approval', async c => c.json(service.approveRoot(c.req.param('id'), (await c.req.json()).accepted === true)));
  route.get('/external-agents/jobs', c => c.json(service.list()));
  route.post('/external-agents/jobs', async c => {
    const text = await c.req.text();
    if (text.length > 40000) return c.json({ error: 'request_too_large' }, 413);
    return c.json(service.preview(JSON.parse(text)), 201);
  });
  route.get('/external-agents/jobs/:id', c => c.json(service.get(c.req.param('id'))));
  route.post('/external-agents/jobs/:id/approval', async c => c.json(await service.approve(c.req.param('id'), (await c.req.json()).accepted === true)));
  route.post('/external-agents/jobs/:id/cancel', c => c.json(service.cancel(c.req.param('id'))));
  route.post('/external-agents/jobs/:id/review', async c => c.json(service.review(c.req.param('id'), (await c.req.json()).accepted === true)));
  route.post('/external-agents/jobs/:id/undo', c => c.json(service.undo(c.req.param('id'))));
  route.post('/external-agents/history/delete', c => c.json(service.deleteHistory()));
  route.get('/external-agents/jobs/:id/events', c => {
    const id = c.req.param('id'); service.get(id);
    return streamSSE(c, async stream => {
      let dirty = true, stopped = false;
      const listener = job => { if (job.id === id) dirty = true; };
      service.on('job', listener);
      stream.onAbort(() => { stopped = true; service.off('job', listener); });
      try {
        while (!stopped) {
          if (dirty) { dirty = false; await stream.writeSSE({ event: 'job', data: JSON.stringify(service.get(id)) }); }
          await stream.sleep(250);
        }
      } finally { service.off('job', listener); }
    });
  });
  return route;
}
