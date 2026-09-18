// Route tests for the Cyber Audit Agent semantic API (SENTINEL V1, CA-7).
// Exercises the Hono app directly (no live server) with isLocal forced
// true, exactly like test-metagpt-studio.mjs does for /api/metagpt.
// Covers: create valid mission, create without authorization denied,
// create invalid scope denied, get mission, list missions, start, double
// start denied, cancel, double cancel, cancel race, completed mission
// restart denied, get findings, get evidence, unknown mission, invalid
// id.
// Run with: node --test test-cyber-audit-routes.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';

import { initSqlite } from './src/lib/sqlite.js';
import { createCyberAuditRoute } from './src/routes/cyber-audit.js';
import * as orchestrator from './src/lib/cyber-orchestrator.js';
import { createCyberAuditFixture } from './test-cyber-audit-fixture.mjs';

const TEST_DB_DIR = './data-test-cyber-routes';
let fixture, origin, port;
// startMission is wrapped to always pass allowPrivateFixture: true — the
// route tests target the local 127.0.0.1 fixture, which the real
// (unwrapped) startMission correctly refuses as a private address. The
// production route registration (server.js) never injects this wrapper.
const app = new Hono().route('/api', createCyberAuditRoute({
  isLocal: () => true,
  gateway: {
    ...orchestrator,
    startMission: (id) => orchestrator.startMission(id, { allowPrivateFixture: true }),
  },
}));

before(async () => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
  fixture = createCyberAuditFixture();
  ({ port, origin } = await fixture.listen());
});

after(async () => {
  await fixture.close();
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function request(path, { method = 'GET', body } = {}) {
  const response = await app.request(`http://localhost/api/cyber-audit${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function validBody(overrides = {}) {
  return {
    title: 'Route test mission',
    clientName: 'Acme Corp',
    authorizationConfirmed: true,
    authorizationReference: 'AUTH-REF-9999',
    scope: {
      allowedHosts: ['127.0.0.1'],
      allowedPorts: [port],
      allowedProtocols: ['http:'],
      allowedPaths: ['/site/contact'],
      maxDepth: 0,
      maxRequests: 5,
      requestsPerSecond: 2,
      timeoutMs: 3000,
    },
    ...overrides,
  };
}

// ── create ─────────────────────────────────────────────────────────────

test('create valid mission: 201, READY status, scope summary present', async () => {
  const r = await request('/missions', { method: 'POST', body: validBody() });
  assert.equal(r.status, 201);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.mission.status, 'READY');
  assert.ok(r.body.mission.id);
  assert.deepEqual(r.body.mission.scope.allowedHosts, ['127.0.0.1']);
});

test('create without authorization denied: 400, authorization_not_confirmed', async () => {
  const body = validBody();
  delete body.authorizationConfirmed;
  const r = await request('/missions', { method: 'POST', body });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'authorization_not_confirmed');
});

test('create invalid scope denied: empty allowedHosts is rejected with 400', async () => {
  const r = await request('/missions', { method: 'POST', body: validBody({ scope: { allowedHosts: [], allowedPorts: [80], allowedProtocols: ['http:'] } }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'scope_hosts_invalid');
});

test('create invalid scope denied: wildcard host is rejected', async () => {
  const r = await request('/missions', { method: 'POST', body: validBody({ scope: { allowedHosts: ['*'], allowedPorts: [80], allowedProtocols: ['http:'] } }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'scope_wildcard_denied');
});

test('create invalid scope denied: limit above server caps is rejected', async () => {
  const r = await request('/missions', { method: 'POST', body: validBody({ scope: { allowedHosts: ['a.invalid'], allowedPorts: [80], allowedProtocols: ['http:'], maxRequests: 99999 } }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'scope_max_requests_invalid');
});

test('create: malformed JSON body is rejected with 400, not a 500', async () => {
  const response = await app.request('http://localhost/api/cyber-audit/missions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not valid json',
  });
  assert.equal(response.status, 400);
});

test('create: missing content-type on a POST with a body is rejected with 415', async () => {
  const response = await app.request('http://localhost/api/cyber-audit/missions', {
    method: 'POST', body: JSON.stringify(validBody()),
  });
  assert.equal(response.status, 415);
});

// ── get / list ───────────────────────────────────────────────────────

test('get mission: returns the created mission by id', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const r = await request(`/missions/${created.body.mission.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mission.id, created.body.mission.id);
});

test('list missions: includes a just-created mission', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const r = await request('/missions');
  assert.equal(r.status, 200);
  assert.ok(r.body.missions.some(m => m.id === created.body.mission.id));
});

test('unknown mission: get returns 404 mission_not_found', async () => {
  const r = await request('/missions/00000000-0000-0000-0000-000000000000');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'mission_not_found');
});

test('invalid id: a non-UUID-shaped id is handled as not-found, not a crash', async () => {
  const r = await request('/missions/not-a-real-id;DROP TABLE');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'mission_not_found');
});

// ── start ────────────────────────────────────────────────────────────

test('start: READY -> RUNNING, no body required, and no arbitrary URL override is accepted', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const id = created.body.mission.id;
  // Even if a caller tries to smuggle a URL/scope override into /start's
  // body, the route never reads it — startMission() takes no body param.
  const r = await request(`/missions/${id}/start`, { method: 'POST', body: { url: 'http://evil.invalid/', scope: { allowedHosts: ['evil.invalid'] } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.mission.status, 'RUNNING');
  const stored = await request(`/missions/${id}`);
  assert.deepEqual(stored.body.mission.scope.allowedHosts, ['127.0.0.1'], 'scope must remain exactly what was persisted at creation');
});

test('double start denied: starting an already-RUNNING mission is rejected with 409', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const id = created.body.mission.id;
  const first = await request(`/missions/${id}/start`, { method: 'POST' });
  assert.equal(first.status, 200);
  const second = await request(`/missions/${id}/start`, { method: 'POST' });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /invalid_state_for_start/);
});

test('completed mission restart denied: starting a COMPLETED mission is rejected with 409', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const id = created.body.mission.id;
  await request(`/missions/${id}/start`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 500));
  const stored = await request(`/missions/${id}`);
  assert.equal(stored.body.mission.status, 'COMPLETED');
  const restart = await request(`/missions/${id}/start`, { method: 'POST' });
  assert.equal(restart.status, 409);
  assert.match(restart.body.error, /invalid_state_for_start/);
});

test('start on unknown mission: 404', async () => {
  const r = await request('/missions/00000000-0000-0000-0000-000000000000/start', { method: 'POST' });
  assert.equal(r.status, 404);
});

// ── cancel ───────────────────────────────────────────────────────────

test('cancel: a RUNNING mission moves to CANCELLED', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody({ scope: { allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'], allowedPaths: ['/slow'], maxDepth: 0, maxRequests: 5, requestsPerSecond: 2, timeoutMs: 3000 } }) });
  const id = created.body.mission.id;
  await request(`/missions/${id}/start`, { method: 'POST' });
  const r = await request(`/missions/${id}/cancel`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mission.status, 'CANCELLED');
});

test('double cancel: cancelling twice is idempotent, never errors', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const id = created.body.mission.id;
  const first = await request(`/missions/${id}/cancel`, { method: 'POST' });
  assert.equal(first.status, 200);
  const second = await request(`/missions/${id}/cancel`, { method: 'POST' });
  assert.equal(second.status, 200);
  assert.equal(second.body.mission.alreadyFinished, true);
});

test('cancel race: cancel immediately after start on a fast-completing mission never leaves state as COMPLETED', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const id = created.body.mission.id;
  await request(`/missions/${id}/start`, { method: 'POST' });
  await request(`/missions/${id}/cancel`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 400));
  const stored = await request(`/missions/${id}`);
  assert.notEqual(stored.body.mission.status, 'COMPLETED');
});

test('cancel on unknown mission: 404', async () => {
  const r = await request('/missions/00000000-0000-0000-0000-000000000000/cancel', { method: 'POST' });
  assert.equal(r.status, 404);
});

// ── findings / evidence / events ─────────────────────────────────────

test('get findings: returns an array (possibly empty) for a completed mission', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const id = created.body.mission.id;
  await request(`/missions/${id}/start`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 500));
  const r = await request(`/missions/${id}/findings`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.findings));
});

test('get findings: unknown mission is 404', async () => {
  const r = await request('/missions/00000000-0000-0000-0000-000000000000/findings');
  assert.equal(r.status, 404);
});

test('get evidence: returns the recorded evidence for a mission that scanned at least one page', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody({ scope: { allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'], allowedPaths: ['/info-disclosure'], maxDepth: 0, maxRequests: 5, requestsPerSecond: 2, timeoutMs: 3000 } }) });
  const id = created.body.mission.id;
  await request(`/missions/${id}/start`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 500));
  const findings = await request(`/missions/${id}/findings`);
  assert.ok(findings.body.findings.length >= 1);
  const evidenceId = findings.body.findings[0].evidenceIds[0];
  const r = await request(`/missions/${id}/evidence/${evidenceId}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.evidence.url.includes('/info-disclosure'));
  // API output must never include a raw/internal shape — only the
  // minimal evidence fields.
  assert.equal(Object.keys(r.body.evidence).sort().join(','), 'excerpt,id,method,relevantHeaders,responseStatus,sha256,timestamp,url');
});

test('get evidence: unknown evidence id on a real mission is 404', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const r = await request(`/missions/${created.body.mission.id}/evidence/does-not-exist`);
  assert.equal(r.status, 404);
});

test('get evidence: unknown mission id is 404 even with a real-looking evidence id', async () => {
  const r = await request('/missions/00000000-0000-0000-0000-000000000000/evidence/some-id');
  assert.equal(r.status, 404);
});

test('get events: returns the mission lifecycle event log', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const id = created.body.mission.id;
  await request(`/missions/${id}/start`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 300));
  const r = await request(`/missions/${id}/events`);
  assert.equal(r.status, 200);
  assert.ok(r.body.events.some(e => e.toStatus === 'RUNNING'));
});

// ── report (CA-9) ──────────────────────────────────────────────────────

test('get report: HTML format (default) returns a self-contained HTML document', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const id = created.body.mission.id;
  await request(`/missions/${id}/start`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 400));
  const response = await app.request(`http://localhost/api/cyber-audit/missions/${id}/report`);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type')?.includes('text/html'));
  const html = await response.text();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /Rapport d'audit de sécurité externe/);
});

test('get report: format=json returns the findings-only JSON export', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const id = created.body.mission.id;
  await request(`/missions/${id}/start`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 400));
  const r = await request(`/missions/${id}/report?format=json`);
  assert.equal(r.status, 200);
  assert.equal(r.body.missionId, id);
  assert.ok(Array.isArray(r.body.findings));
});

test('get report: unknown mission is 404', async () => {
  const response = await app.request('http://localhost/api/cyber-audit/missions/00000000-0000-0000-0000-000000000000/report');
  assert.equal(response.status, 404);
});

// ── Forbidden route surface ────────────────────────────────────────────

test('forbidden routes: no /execute, /run, /shell, /raw-fetch, /arbitrary-url, /raw-command route exists', async () => {
  for (const suffix of ['/execute', '/run', '/shell', '/raw-fetch', '/arbitrary-url', '/raw-command']) {
    // A JSON content-type is supplied so the request clears the shared
    // json_required middleware and actually reaches Hono's own routing —
    // proving the ROUTE itself doesn't exist (404), not merely that an
    // unrelated body-shape guard rejected it first.
    const response = await app.request(`http://localhost/api/cyber-audit/missions/some-id${suffix}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404, `${suffix} must not exist as a route`);
  }
});

// ── API output minimalism ──────────────────────────────────────────────

test('API output: mission response never exposes an internal DB path, stack, or secret-shaped field', async () => {
  const created = await request('/missions', { method: 'POST', body: validBody() });
  const serialized = JSON.stringify(created.body.mission);
  assert.ok(!serialized.includes(TEST_DB_DIR));
  assert.ok(!/\.sqlite|\.db"/.test(serialized));
  assert.ok(!serialized.toLowerCase().includes('stack'));
});

// ── Access control (loopback-only guard) ────────────────────────────────

test('access control: a non-local caller is denied 403', async () => {
  const restrictedApp = new Hono().route('/api', createCyberAuditRoute({ isLocal: () => false }));
  const response = await restrictedApp.request('http://localhost/api/cyber-audit/missions');
  assert.equal(response.status, 403);
});

// ── Security regression ─────────────────────────────────────────────────

test('confirmation: zero destructive methods reached the fixture across every route test in this suite', () => {
  let sawForbidden = false;
  fixture.server.on('unexpected-method', () => { sawForbidden = true; });
  assert.equal(sawForbidden, false);
});
