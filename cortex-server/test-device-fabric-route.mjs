// DEVICE FABRIC Phase 2 — HTTP route tests: loopback/Host/Origin guard,
// body limits, strict input validation, safe errors, no routing surface.
// Run with: node --test test-device-fabric-route.mjs
import './test-setup.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { initSqlite, insertOmegaDevice, getRassilonSettings, upsertRassilonDevice } from './src/lib/sqlite.js';
import { createDeviceFabricRoute } from './src/routes/device-fabric.js';

const TEST_ROOT = './data-test-device-fabric-route';
const BASE = 'http://localhost/device-fabric';
let local;
let remote;
const omegaKey = crypto.generateKeyPairSync('ed25519').publicKey;
const omegaFingerprint = crypto.createHash('sha256').update(omegaKey.export({ type: 'spki', format: 'der' })).digest('hex');
const workerKey = crypto.generateKeyPairSync('ed25519').publicKey;
const workerFingerprint = crypto.createHash('sha256').update(workerKey.export({ type: 'spki', format: 'der' })).digest('hex');

before(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  initSqlite(`${TEST_ROOT}/test.db`);
  getRassilonSettings();
  insertOmegaDevice({ id: 'omega-route-1', display_name: '<img src=x onerror=alert(1)>', public_key_pem: omegaKey.export({ type: 'spki', format: 'pem' }), fingerprint: omegaFingerprint, permission_level: 1 });
  upsertRassilonDevice({ deviceId: 'rassilon-route-1', displayName: 'Worker', publicKeyPem: workerKey.export({ type: 'spki', format: 'pem' }), fingerprint: workerFingerprint, role: 'WORKER', permissionSet: ['RASSILON_EMBEDDING'], capabilities: {}, status: 'OFFLINE', endpointHost: '192.168.1.9', endpointPort: 3443, tlsCertificatePem: '-----BEGIN CERTIFICATE-----fake', tlsCertificateFingerprint: 'AA:BB' });
  local = createDeviceFabricRoute({ isLocal: () => true });
  remote = createDeviceFabricRoute({ isLocal: () => false });
});

const json = (method, body, headers = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function create(name) {
  const response = await local.request(`${BASE}/devices`, json('POST', { displayName: name }));
  assert.equal(response.status, 201);
  return (await response.json()).device;
}

test('happy path through the API: create, get, list, rename, link, unlink, delete, agents, audit', async () => {
  const device = await create('PC Bureau');
  assert.equal((await (await local.request(`${BASE}/devices/${device.fabricDeviceId}`)).json()).device.displayName, 'PC Bureau');
  assert.equal((await (await local.request(`${BASE}/devices`)).json()).devices.length >= 1, true);
  const renamed = await local.request(`${BASE}/devices/${device.fabricDeviceId}`, json('PATCH', { displayName: 'PC Salon' }));
  assert.equal((await renamed.json()).device.displayName, 'PC Salon');

  const agents = (await (await local.request(`${BASE}/agents`)).json()).agents;
  assert.deepEqual(agents.OMEGA.map(a => a.agentDeviceId), ['omega-route-1']);
  assert.deepEqual(agents.RASSILON.map(a => a.agentDeviceId), ['rassilon-route-1']);
  assert.doesNotMatch(JSON.stringify(agents), /BEGIN CERTIFICATE|PUBLIC KEY|192\.168|AA:BB|sessionId/);

  const link = await local.request(`${BASE}/devices/${device.fabricDeviceId}/link`, json('POST', { agentType: 'OMEGA', agentDeviceId: 'omega-route-1', confirmFingerprint: omegaFingerprint }));
  assert.equal(link.status, 200);
  assert.equal((await link.json()).device.agents.OMEGA.agentDeviceId, 'omega-route-1');
  const linkedAgents = (await (await local.request(`${BASE}/agents`)).json()).agents;
  assert.equal(linkedAgents.OMEGA[0].linkedFabricDeviceId, device.fabricDeviceId);

  const blockedDelete = await local.request(`${BASE}/devices/${device.fabricDeviceId}`, { method: 'DELETE' });
  assert.equal(blockedDelete.status, 409);
  assert.equal((await blockedDelete.json()).error, 'removal_requires_link_confirmation');
  const unlink = await local.request(`${BASE}/devices/${device.fabricDeviceId}/link/OMEGA`, { method: 'DELETE' });
  assert.equal((await unlink.json()).device.agents.OMEGA, null);
  const removed = await local.request(`${BASE}/devices/${device.fabricDeviceId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);

  const auditBody = await (await local.request(`${BASE}/audit?limit=50`)).json();
  assert.deepEqual([...new Set(auditBody.events.map(e => e.eventType))].sort(), ['FABRIC_AGENT_LINKED', 'FABRIC_AGENT_UNLINKED', 'FABRIC_DEVICE_CREATED', 'FABRIC_DEVICE_REMOVED', 'FABRIC_DEVICE_RENAMED']);
});

test('remote caller → 403 on every endpoint and method', async () => {
  const id = `fdev-${crypto.randomUUID()}`;
  for (const [method, path] of [['GET', '/devices'], ['GET', `/devices/${id}`], ['POST', '/devices'], ['PATCH', `/devices/${id}`], ['DELETE', `/devices/${id}`], ['GET', '/agents'], ['POST', `/devices/${id}/link`], ['DELETE', `/devices/${id}/link/OMEGA`], ['GET', '/audit']]) {
    const response = await remote.request(`${BASE}${path}`, method === 'GET' || method === 'DELETE' ? { method } : json(method, {}));
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.json()).error, 'local_access_required');
  }
});

test('bad Origin, foreign Host (DNS rebinding) and non-http origin → 403', async () => {
  for (const origin of ['http://evil.example', 'https://192.168.1.5', 'null', 'file://', 'chrome-extension://abc']) {
    const response = await local.request(`${BASE}/devices`, { headers: { origin } });
    assert.equal(response.status, 403, origin);
  }
  assert.equal((await local.request('http://evil.example/device-fabric/devices')).status, 403);
  assert.equal((await local.request(`${BASE}/devices`, { headers: { origin: 'http://localhost:5173' } })).status, 200);
});

test('oversized body → 413, non-JSON → 415, malformed JSON → 400', async () => {
  const big = await local.request(`${BASE}/devices`, json('POST', { displayName: 'x'.repeat(9 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal((await local.request(`${BASE}/devices`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'displayName=a' })).status, 415);
  const malformed = await local.request(`${BASE}/devices`, json('POST', '{not json'));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'json_invalid');
  const array = await local.request(`${BASE}/devices`, json('POST', '[]'));
  assert.equal((await array.json()).error, 'json_object_required');
});

test('malformed ids → 400; unknown device → 404; unknown fields rejected', async () => {
  for (const id of ['abc', 'fdev-1', `fdev-${crypto.randomUUID()}x`, 'fdev-../../etc', encodeURIComponent('<script>')]) {
    const response = await local.request(`${BASE}/devices/${id}`);
    assert.equal(response.status, 400, id);
    assert.equal((await response.json()).error, 'fabric_device_id_invalid');
  }
  assert.equal((await local.request(`${BASE}/devices/fdev-${crypto.randomUUID()}`)).status, 404);
  const device = await create('Fields');
  for (const [path, method, body] of [
    ['/devices', 'POST', { displayName: 'A', trusted: true }],
    [`/devices/${device.fabricDeviceId}`, 'PATCH', { displayName: 'B', permission: 'ADMIN' }],
    [`/devices/${device.fabricDeviceId}/link`, 'POST', { agentType: 'OMEGA', agentDeviceId: 'omega-route-1', confirmFingerprint: omegaFingerprint, sessionId: 'x' }],
    [`/devices/${device.fabricDeviceId}/link`, 'POST', { agentType: 'OMEGA', agentDeviceId: 'omega-route-1', confirmFingerprint: omegaFingerprint, ip: '192.168.1.9' }],
    [`/devices/${device.fabricDeviceId}/link`, 'POST', { agentType: 'OMEGA', agentDeviceId: 'omega-route-1', confirmFingerprint: omegaFingerprint, __proto__: { x: 1 }, constructor: 'x' }],
  ]) {
    const response = await local.request(`${BASE}${path}`, json(method, body));
    assert.equal(response.status, 400, `${method} ${path}`);
    assert.equal((await response.json()).error, 'unknown_field');
  }
  const badType = await local.request(`${BASE}/devices/${device.fabricDeviceId}/link/SHELL`, { method: 'DELETE' });
  assert.equal((await badType.json()).error, 'agent_type_invalid');
  const xssName = await local.request(`${BASE}/devices`, json('POST', { displayName: '<script>alert(1)</script>' }));
  assert.equal((await xssName.json()).error, 'display_name_charset_invalid');
});

test('same-key conflict is a safe 409 error without stack trace or internal detail', async () => {
  const shared = crypto.generateKeyPairSync('ed25519').publicKey;
  const fingerprint = crypto.createHash('sha256').update(shared.export({ type: 'spki', format: 'der' })).digest('hex');
  insertOmegaDevice({ id: 'omega-shared', display_name: 'Shared', public_key_pem: shared.export({ type: 'spki', format: 'pem' }), fingerprint, permission_level: 1 });
  upsertRassilonDevice({ deviceId: 'rassilon-shared', displayName: 'Shared', publicKeyPem: shared.export({ type: 'spki', format: 'pem' }), fingerprint, role: 'WORKER', permissionSet: [], capabilities: {}, status: 'OFFLINE' });
  const device = await create('Shared key');
  const response = await local.request(`${BASE}/devices/${device.fabricDeviceId}/link`, json('POST', { agentType: 'RASSILON', agentDeviceId: 'rassilon-shared', confirmFingerprint: fingerprint }));
  assert.equal(response.status, 409);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { ok: false, error: 'cross_agent_key_reuse' });
  assert.doesNotMatch(text, /at |\.js:|stack|Error:/);
});

test('unexpected internal errors are a generic 500 with no stack or message', async () => {
  const device = await create('Boom');
  const { getDatabase } = await import('./src/lib/sqlite.js');
  getDatabase().exec('ALTER TABLE fabric_agent_links RENAME TO fabric_agent_links_hidden');
  try {
    const response = await local.request(`${BASE}/devices/${device.fabricDeviceId}`);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { ok: false, error: 'internal_error' });
    assert.doesNotMatch(text, /no such table|sqlite|at |\.js/i);
  } finally {
    getDatabase().exec('ALTER TABLE fabric_agent_links_hidden RENAME TO fabric_agent_links');
  }
});

test('no generic surface: execute/run/action/command/shell/tool/rpc/dispatch and agent actions → 404', async () => {
  const device = await create('No routing');
  const id = device.fabricDeviceId;
  // Phase 3 adds exactly one semantic endpoint (POST /route, tested in
  // test-device-fabric-routing.mjs); everything generic stays absent.
  assert.equal((await local.request(`${BASE}/route`)).status, 404, 'GET /route never routes');
  const candidates = [
    '/execute', '/run', '/action', '/command', '/shell', '/tool', '/rpc', '/dispatch', '/jobs', '/stop', '/stop-all', '/cancel',
    `/operations/${id}/cancel`, `/devices/${id}/rassilon/jobs`, `/devices/${id}/rassilon/dispatch`,
    `/devices/${id}/route`, `/devices/${id}/execute`, `/devices/${id}/run`, `/devices/${id}/action`, `/devices/${id}/command`,
    `/devices/${id}/dispatch`, `/devices/${id}/omega/view`, `/devices/${id}/omega/interactive`, `/devices/${id}/omega/admin`,
    `/devices/${id}/rassilon/jobs`, `/devices/${id}/revoke`, `/devices/${id}/pair`, `/devices/${id}/enable`, `/devices/${id}/stop`,
  ];
  for (const path of candidates) {
    for (const method of ['GET', 'POST']) {
      const response = await local.request(`${BASE}${path}`, method === 'POST' ? json('POST', { actionType: 'OMEGA_VIEW' }) : { method });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  }
});

// ── Phase 3 routing endpoints ──────────────────────────────────────────────

test('Phase 3 endpoints: remote caller and bad Origin → 403', async () => {
  const id = `fdev-${crypto.randomUUID()}`;
  for (const [method, path] of [['POST', '/route'], ['GET', '/operations'], ['GET', `/operations/fop-${crypto.randomUUID()}`], ['POST', `/devices/${id}/rassilon/probe`]]) {
    const init = method === 'POST' ? json('POST', {}) : { method };
    assert.equal((await remote.request(`${BASE}${path}`, init)).status, 403, `${method} ${path}`);
    const withOrigin = { ...init, headers: { ...(init.headers ?? {}), origin: 'http://evil.example' } };
    assert.equal((await local.request(`${BASE}${path}`, withOrigin)).status, 403, `origin ${method} ${path}`);
  }
});

test('POST /route: bounded body (64 KiB), strict request, safe errors, no stack trace', async () => {
  const device = await create('Route API');
  const route = body => local.request(`${BASE}/route`, json('POST', body));
  assert.equal((await route({ fabricDeviceId: device.fabricDeviceId, actionType: 'RASSILON_EMBEDDING', semanticPayload: { texts: ['x'.repeat(70 * 1024)], model: 'nomic-embed-text' } })).status, 413);
  const cases = [
    [{ fabricDeviceId: device.fabricDeviceId, actionType: 'OMEGA_VIEW', semanticPayload: {} }, 409, 'not_routable'],
    [{ fabricDeviceId: device.fabricDeviceId, actionType: 'OMEGA_ADMIN', semanticPayload: {} }, 409, 'not_routable'],
    [{ fabricDeviceId: device.fabricDeviceId, actionType: 'EXEC', semanticPayload: {} }, 400, 'action_not_supported'],
    [{ fabricDeviceId: device.fabricDeviceId, actionType: 'RASSILON_SAFE_CPU', semanticPayload: { kind: 'HASH_BUFFER', data: { hex: 'ab' } }, command: 'x' }, 400, 'unknown_field'],
    [{ fabricDeviceId: device.fabricDeviceId, actionType: 'RASSILON_SAFE_CPU', semanticPayload: { kind: 'HASH_BUFFER', data: { hex: 'ab', shell: 'x' } } }, 400, 'forbidden_payload_field'],
    [{ fabricDeviceId: 'fdev-bad', actionType: 'RASSILON_SAFE_CPU', semanticPayload: { kind: 'HASH_BUFFER', data: { hex: 'ab' } } }, 400, 'fabric_device_id_invalid'],
    [{ fabricDeviceId: `fdev-${crypto.randomUUID()}`, actionType: 'RASSILON_SAFE_CPU', semanticPayload: { kind: 'HASH_BUFFER', data: { hex: 'ab' } } }, 404, 'fabric_device_not_found'],
  ];
  for (const [body, status, error] of cases) {
    const response = await route(body);
    const text = await response.text();
    assert.equal(response.status, status, `${body.actionType}: ${text}`);
    assert.equal(JSON.parse(text).error, error);
    assert.doesNotMatch(text, /at |\.js:|stack|Error:/);
  }
  const notLinked = await route({ fabricDeviceId: device.fabricDeviceId, actionType: 'RASSILON_SAFE_CPU', semanticPayload: { kind: 'HASH_BUFFER', data: { hex: 'ab' } } });
  assert.equal(notLinked.status, 409);
  const notLinkedBody = await notLinked.json();
  assert.equal(notLinkedBody.error, 'rassilon_not_linked');
  assert.equal(notLinkedBody.operation.status, 'NOT_AVAILABLE');
  assert.match(notLinkedBody.operation.correlationId, /^fcor-/);
});

test('operations read API: bounded list, validated id, 404, no side effect', async () => {
  const list = await (await local.request(`${BASE}/operations?limit=5000&offset=-3`)).json();
  assert.ok(list.operations.length <= 100);
  assert.equal((await local.request(`${BASE}/operations/not-an-id`)).status, 400);
  assert.equal((await local.request(`${BASE}/operations/fop-${crypto.randomUUID()}`)).status, 404);
  assert.equal((await local.request(`${BASE}/operations`, json('POST', {}))).status, 404, 'no write on /operations');
});
