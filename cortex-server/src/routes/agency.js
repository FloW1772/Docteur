// Agency V1 — HTTP routes. Thin layer over createAgencyService: every rule
// (states, tools, approvals, STOP) is enforced by the service, not here.
import { Hono } from 'hono';
import { AgencyError } from '../lib/agency.js';

export function createAgencyRoute({ service, logger = null }) {
  const route = new Hono();

  const handle = (fn) => async (c) => {
    try {
      return c.json(await fn(c));
    } catch (err) {
      if (err instanceof AgencyError) return c.json({ error: err.code, detail: err.detail ?? null }, err.status);
      logger?.error?.({ err: err?.message }, 'agency route error');
      return c.json({ error: 'agency_internal_error' }, 500);
    }
  };
  const body = async (c) => { try { return await c.req.json(); } catch { return {}; } };

  route.get('/agency/catalog', handle(() => ({ agents: service.agents, tools: service.tools })));
  route.get('/agency/runs', handle(() => ({ runs: service.listRuns(50) })));
  route.post('/agency/runs', handle(async (c) => {
    const b = await body(c);
    return service.createRun({
      objective: b.objective,
      strictLocal: b.strictLocal !== false,
      maxConcurrency: b.maxConcurrency ?? undefined,
      saveResult: b.saveResult === true,
      autoStart: b.autoStart === true,
    });
  }));
  route.get('/agency/runs/:id', handle((c) => service.getRun(c.req.param('id'))));
  route.post('/agency/runs/:id/start', handle((c) => service.startRun(c.req.param('id'))));
  route.post('/agency/runs/:id/resume', handle((c) => service.resumeRun(c.req.param('id'))));
  route.post('/agency/runs/:id/cancel', handle((c) => service.cancelRun(c.req.param('id'))));
  // STOP: always available, final.
  route.post('/agency/runs/:id/stop', handle((c) => service.stopRun(c.req.param('id'))));
  route.post('/agency/stop-all', handle(() => service.stopAll()));
  route.post('/agency/tasks/:id/retry', handle((c) => service.retryTask(c.req.param('id'))));
  route.post('/agency/tasks/:id/cancel', handle((c) => service.cancelTask(c.req.param('id'))));
  // Human decision bound to the exact digest the user was shown.
  route.post('/agency/approvals/:id', handle(async (c) => {
    const b = await body(c);
    return service.decideApproval(c.req.param('id'), { accepted: b.accepted === true, digest: b.digest });
  }));

  return route;
}
