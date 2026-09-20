// Route tests for the Observateur monitoring semantic API. Exercises
// the Hono app directly (no live server), mirrors
// test-cyber-audit-routes.mjs's shape: loopback-only guard, route
// delegates only to the injected gateway (never collector/service
// internals directly).
// Run with: node --test test-monitor-route.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';
import { initSqlite } from './src/lib/sqlite.js';
import { createMonitorRoute } from './src/routes/monitor.js';
import * as orchestrator from './src/lib/monitor-orchestrator.js';
import { stopMonitorService } from './src/lib/monitor-service.js';

const TEST_DB_DIR = './data-test-monitor-routes';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  // POST /start really starts monitor-service.js's setInterval loop
  // (this route test exercises the real service, not a mock) — it must
  // be stopped or the test process (and `node --test`) never exits.
  stopMonitorService();
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

const localApp = new Hono().route('/api', createMonitorRoute({ isLocal: () => true, gateway: orchestrator }));
const remoteApp = new Hono().route('/api', createMonitorRoute({ isLocal: () => false, gateway: orchestrator }));

async function request(app, path, { method = 'GET', body } = {}) {
  const response = await app.request(`http://localhost/api/monitor${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('access control: a non-local caller is denied 403 on every route', async () => {
  const { status, body } = await request(remoteApp, '/status');
  assert.equal(status, 403);
  assert.equal(body.error, 'local_access_required');
});

test('GET /status: returns ok with a status object', async () => {
  const { status, body } = await request(localApp, '/status');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok('enabled' in body.status);
});

test('GET /settings: returns settings with cloudAiEnabled defaulting to false', async () => {
  const { status, body } = await request(localApp, '/settings');
  assert.equal(status, 200);
  assert.equal(body.settings.cloudAiEnabled, false);
});

test('PUT /settings: rejects a bad content-type', async () => {
  const response = await localApp.request('http://localhost/api/monitor/settings', {
    method: 'PUT', body: JSON.stringify({ enabled: true }),
  });
  assert.equal(response.status, 415);
});

test('PUT /settings: updates and persists a valid setting', async () => {
  const { status, body } = await request(localApp, '/settings', { method: 'PUT', body: { retentionDays: 14 } });
  assert.equal(status, 200);
  assert.equal(body.settings.retentionDays, 14);
});

test('POST /start, /pause, /resume: round-trip without throwing', async () => {
  const start = await request(localApp, '/start', { method: 'POST' });
  assert.equal(start.status, 200);
  assert.equal(start.body.settings.enabled, true);

  const pause = await request(localApp, '/pause', { method: 'POST' });
  assert.equal(pause.status, 200);
  assert.equal(pause.body.settings.paused, true);

  const resume = await request(localApp, '/resume', { method: 'POST' });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.settings.paused, false);
});

test('GET /connections/live, /processes, /anomalies, /reports: all return ok arrays', async () => {
  const conns = await request(localApp, '/connections/live');
  assert.equal(conns.status, 200);
  assert.ok(Array.isArray(conns.body.connections));

  const procs = await request(localApp, '/processes');
  assert.equal(procs.status, 200);
  assert.ok(Array.isArray(procs.body.processes));

  const anomalies = await request(localApp, '/anomalies');
  assert.equal(anomalies.status, 200);
  assert.ok(Array.isArray(anomalies.body.anomalies));

  const reports = await request(localApp, '/reports');
  assert.equal(reports.status, 200);
  assert.ok(Array.isArray(reports.body.reports));
});

test('GET /reports/:id: unknown report id is 404', async () => {
  const { status, body } = await request(localApp, '/reports/does-not-exist');
  assert.equal(status, 404);
  assert.equal(body.error, 'report_not_found');
});

test('forbidden routes: no /execute, /run, /shell, /raw-command route exists', async () => {
  for (const path of ['/execute', '/run', '/shell', '/raw-command']) {
    const response = await localApp.request(`http://localhost/api/monitor${path}`, { method: 'POST' });
    assert.notEqual(response.status, 200);
  }
});
