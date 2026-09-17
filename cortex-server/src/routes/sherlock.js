import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { getInstallState, testInstall, searchUsername, cancelSearch, getSherlockJob } from '../lib/sherlock.js';

const local = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
export function createSherlockRoute({ logger, isLocal = c => { try { return local(getConnInfo(c).remote.address); } catch { return false; } }, gateway = { searchUsername, cancelSearch, getJob: getSherlockJob } } = {}) {
  const app = new Hono();
  app.use('/sherlock/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: 'local_access_required' }, 403);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname)) return c.json({ error: 'host_denied' }, 403);
    const origin = c.req.header('origin');
    if (origin) { try { if (!['http:', 'https:'].includes(new URL(origin).protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) return c.json({ error: 'origin_denied' }, 403); } catch { return c.json({ error: 'origin_denied' }, 403); } }
    if (c.req.method === 'POST' && c.req.path.endsWith('/search') && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415);
    await next();
  });
  app.use('/sherlock/*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'request_too_large' }, 413) }));
  app.get('/sherlock/status', c => c.json(getInstallState()));
  app.post('/sherlock/test', async c => c.json(await testInstall()));
  app.post('/sherlock/install', c => c.json({ error: 'installation_requires_operator_setup' }, 409));
  app.post('/sherlock/uninstall', c => c.json({ error: 'uninstall_requires_operator_action' }, 409));
  app.post('/sherlock/search', async c => {
    let body; try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !['username', 'timeoutMs', 'siteFilter'].includes(key))) return c.json({ error: 'request_fields_denied' }, 400);
    try {
      const result = gateway.searchUsername(body);
      logger?.info?.({ jobId: result.jobId }, 'SHERLOCK_SEARCH_STARTED');
      return c.json(result, 202);
    } catch (error) {
      const code = error.code || 'search_unavailable';
      return c.json({ error: code }, code === 'search_rate_limited' ? 429 : code === 'search_concurrency_limit' ? 409 : 400);
    }
  });
  const get = c => { const job = gateway.getJob(c.req.param('id')); return job ? c.json(job) : c.json({ error: 'job_not_found' }, 404); };
  const cancel = c => { if (!gateway.getJob(c.req.param('id'))) return c.json({ error: 'job_not_found' }, 404); return c.json(gateway.cancelSearch(c.req.param('id'))); };
  app.get('/sherlock/jobs/:id', get);
  app.post('/sherlock/jobs/:id/cancel', cancel);
  // Compatibility for existing client URLs; identical checks and service.
  app.get('/sherlock/search/:id', get);
  app.post('/sherlock/search/:id/cancel', cancel);
  app.post('/sherlock/save-as-neuron', c => c.json({ error: 'osint_results_are_untrusted_data' }, 410));
  return app;
}
