/**
 * Semantic API routes for Observateur passive monitoring. Same
 * loopback-only guard shape as cyber-audit.js/metagpt.js/sherlock.js —
 * this control plane must never be reachable except from the local
 * machine. Every handler calls ONLY monitor-orchestrator.js — never
 * monitor-collector.js/monitor-service.js internals directly.
 */
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import {
  getStatus, startMonitoring, pauseMonitoring, resumeMonitoring,
  getSettings, putSettings, getLiveConnections, getProcesses,
  getAnomalies, listReports, getReport,
} from '../lib/monitor-orchestrator.js';
import { startMonitorService } from '../lib/monitor-service.js';

const localAddress = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);

const defaultGateway = {
  getStatus, startMonitoring, pauseMonitoring, resumeMonitoring,
  getSettings, putSettings, getLiveConnections, getProcesses,
  getAnomalies, listReports, getReport,
};

export function createMonitorRoute({ logger, isLocal = c => { try { return localAddress(getConnInfo(c).remote.address); } catch { return false; } }, gateway = defaultGateway, ollamaClient = null, ollamaModel = null } = {}) {
  const route = new Hono();
  const {
    getStatus, startMonitoring, pauseMonitoring, resumeMonitoring,
    getSettings, putSettings, getLiveConnections, getProcesses,
    getAnomalies, listReports, getReport,
  } = gateway;

  route.use('/monitor/*', async (c, next) => {
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
    const requiresJsonBody = c.req.method === 'PUT';
    if (requiresJsonBody && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415);
    await next();
  });
  route.use('/monitor/*', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }));

  route.get('/monitor/status', (c) => c.json({ ok: true, status: getStatus() }));

  route.post('/monitor/start', (c) => {
    const settings = startMonitoring();
    startMonitorService({ ollamaClient, ollamaModel, logger });
    logger?.info?.('OBSERVATEUR_MONITOR_STARTED');
    return c.json({ ok: true, settings });
  });

  route.post('/monitor/pause', (c) => {
    const settings = pauseMonitoring();
    logger?.info?.('OBSERVATEUR_MONITOR_PAUSED');
    return c.json({ ok: true, settings });
  });

  route.post('/monitor/resume', (c) => {
    const settings = resumeMonitoring();
    logger?.info?.('OBSERVATEUR_MONITOR_RESUMED');
    return c.json({ ok: true, settings });
  });

  route.get('/monitor/settings', (c) => c.json({ ok: true, settings: getSettings() }));

  route.put('/monitor/settings', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'json_invalid' }, 400); }
    const settings = putSettings(body);
    return c.json({ ok: true, settings });
  });

  route.get('/monitor/connections/live', (c) => {
    const sinceMinutes = Number(c.req.query('sinceMinutes')) || 30;
    return c.json({ ok: true, connections: getLiveConnections({ sinceMinutes }) });
  });

  route.get('/monitor/processes', (c) => {
    const sinceMinutes = Number(c.req.query('sinceMinutes')) || 60;
    return c.json({ ok: true, processes: getProcesses({ sinceMinutes }) });
  });

  route.get('/monitor/anomalies', (c) => c.json({ ok: true, anomalies: getAnomalies() }));

  route.get('/monitor/reports', (c) => c.json({ ok: true, reports: listReports() }));

  route.get('/monitor/reports/:id', (c) => {
    const format = c.req.query('format') === 'json' ? 'json' : 'html';
    const report = getReport(c.req.param('id'), format);
    if (report === null) return c.json({ error: 'report_not_found' }, 404);
    if (report.format === 'json') return c.json(JSON.parse(report.content));
    return c.html(report.content);
  });

  return route;
}
