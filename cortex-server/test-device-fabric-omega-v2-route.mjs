// DEVICE FABRIC V2 Phase 3/4/5 — HTTP route tests for the OMEGA V2 outbound
// link/status and closed VIEW+INTERACTIVE+ADMIN API: loopback/Host/Origin
// guard, body limits, strict input validation, safe errors, and no generic
// executor/raw-admin surface.
// Run with: node --test test-device-fabric-omega-v2-route.mjs
import './test-setup.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { initSqlite } from './src/lib/sqlite.js';
import { createDeviceFabricRoute } from './src/routes/device-fabric.js';
import { upsertOutboundTrust } from './src/lib/omega-outbound-store.js';
import { DeviceFabricOmegaV2AdminError } from './src/lib/device-fabric-omega-v2-admin.js';

const TEST_ROOT = './data-test-device-fabric-omega-v2-route';
const BASE = 'http://localhost/device-fabric';
let local;
let remote;
let deviceId;
let hostId;
let hostFingerprint;
const viewCalls = { start: [], status: [], stopView: [], stopSession: [] };
const interactiveCalls = { start: [], status: [], stop: [] };
const viewState = id => ({ fabricDeviceId: id, omegaV2HostId: hostId, linkId: 'flnk-route', linkVersion: 1,
  sessionId: 'session-route', sessionStatus: 'CONNECTED', sessionReason: null,
  viewStatus: 'VIEWING', streamId: 'stream-route', screenIndex: 0, interactiveStatus: 'STOPPED', linkChanged: false });
const interactiveState = id => ({ ...viewState(id), interactiveStatus: 'INTERACTIVE' });
const omegaV2View = {
  startViewForFabricDevice: async (id, body) => { viewCalls.start.push({ id, body }); return viewState(id); },
  getViewStateForFabricDevice: id => { viewCalls.status.push(id); return viewState(id); },
  stopViewForFabricDevice: async id => { viewCalls.stopView.push(id); return { ...viewState(id), viewStatus: 'STOPPED', streamId: null }; },
  stopSessionForFabricDevice: async id => { viewCalls.stopSession.push(id); return { ...viewState(id), viewStatus: 'STOPPED', sessionStatus: 'DISCONNECTED' }; },
  startInteractiveForFabricDevice: async (id, body) => { interactiveCalls.start.push({ id, body }); return interactiveState(id); },
  getInteractiveStateForFabricDevice: id => { interactiveCalls.status.push(id); return interactiveState(id); },
  stopInteractiveForFabricDevice: async id => { interactiveCalls.stop.push(id); return viewState(id); },
};
const adminCalls = { read: [], highImpact: [], status: [], cancel: [], stop: [], stopAll: [] };
const adminReadResult = (id, action) => ({ fabricDeviceId: id, omegaV2HostId: hostId, sessionId: 'admin-session-route', status: 'EXECUTED', actionType: action, result: {} });
const adminOperation = (id, action) => ({ fabricDeviceId: id, omegaV2HostId: hostId, sessionId: 'admin-session-route', operationId: '11111111-1111-4111-8111-111111111111', actionType: action, status: 'PENDING_APPROVAL', error: null });
const omegaV2Admin = {
  getSystemInfoForFabricDevice: async id => { adminCalls.read.push({ id, action: 'GET_SYSTEM_INFO' }); return adminReadResult(id, 'GET_SYSTEM_INFO'); },
  listProcessesForFabricDevice: async id => { adminCalls.read.push({ id, action: 'PROCESS_LIST' }); return adminReadResult(id, 'PROCESS_LIST'); },
  getServiceStatusForFabricDevice: async id => { adminCalls.read.push({ id, action: 'SERVICE_STATUS' }); return adminReadResult(id, 'SERVICE_STATUS'); },
  getNetworkStatusForFabricDevice: async id => { adminCalls.read.push({ id, action: 'NETWORK_STATUS' }); return adminReadResult(id, 'NETWORK_STATUS'); },
  getDiskStatusForFabricDevice: async id => { adminCalls.read.push({ id, action: 'DISK_STATUS' }); return adminReadResult(id, 'DISK_STATUS'); },
  // Mirrors the real service's own confirm-token gate so the route test can
  // prove end-to-end wiring, not just that a mock was called.
  lockFabricDevice: async (id, body) => { if (body?.confirm !== 'LOCK') throw new DeviceFabricOmegaV2AdminError('OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED', 400); adminCalls.highImpact.push({ id, body, action: 'LOCK' }); return adminOperation(id, 'LOCK'); },
  logoffFabricDevice: async (id, body) => { if (body?.confirm !== 'LOGOFF') throw new DeviceFabricOmegaV2AdminError('OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED', 400); adminCalls.highImpact.push({ id, body, action: 'LOGOFF' }); return adminOperation(id, 'LOGOFF'); },
  restartFabricDevice: async (id, body) => { if (body?.confirm !== 'RESTART') throw new DeviceFabricOmegaV2AdminError('OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED', 400); adminCalls.highImpact.push({ id, body, action: 'RESTART' }); return adminOperation(id, 'RESTART'); },
  shutdownFabricDevice: async (id, body) => { if (body?.confirm !== 'SHUTDOWN') throw new DeviceFabricOmegaV2AdminError('OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED', 400); adminCalls.highImpact.push({ id, body, action: 'SHUTDOWN' }); return adminOperation(id, 'SHUTDOWN'); },
  getAdminStateForFabricDevice: id => ({ fabricDeviceId: id, omegaV2HostId: hostId, sessionId: null, sessionStatus: 'DISCONNECTED', linkChanged: false }),
  operationStatusForFabricDevice: async (id, body) => { adminCalls.status.push({ id, body }); return adminOperation(id, 'LOCK'); },
  cancelOperationForFabricDevice: async (id, body) => { adminCalls.cancel.push({ id, body }); return { ...adminOperation(id, 'LOCK'), status: 'CANCELLED' }; },
  stopDeviceForFabricDevice: async id => { adminCalls.stop.push(id); return { fabricDeviceId: id, sessionId: null, stopped: true }; },
  stopAllForFabricDevices: async () => { adminCalls.stopAll.push(true); return [{ fabricDeviceId: deviceId, sessionId: null, stopped: true }]; },
};

function fp(seed) { return crypto.createHash('sha256').update(seed).digest('hex'); }
const json = (method, body, headers = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

before(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  initSqlite(`${TEST_ROOT}/test.db`);
  hostId = `ov2h-${crypto.randomUUID()}`;
  hostFingerprint = fp('route-host-1');
  upsertOutboundTrust({
    remoteDeviceId: hostId, host: '192.168.1.60', port: 3100,
    certificatePem: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
    certificateFingerprint: fp('route-cert-1'), publicKeyPem: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
    identityFingerprint: hostFingerprint, maxPermission: 'ADMIN', createdAt: new Date().toISOString(),
  });
  local = createDeviceFabricRoute({ isLocal: () => true, omegaV2View, omegaV2Admin });
  remote = createDeviceFabricRoute({ isLocal: () => false, omegaV2View, omegaV2Admin });
  const created = await local.request(`${BASE}/devices`, json('POST', { displayName: 'OMEGA V2 route test device' }));
  assert.equal(created.status, 201);
  deviceId = (await created.json()).device.fabricDeviceId;
});

test('GET hosts lists the registered OMEGA V2 outbound trust, safely projected', async () => {
  const response = await local.request(`${BASE}/omega-v2/hosts`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const row = body.hosts.find(item => item.omegaV2HostId === hostId);
  assert.ok(row);
  assert.equal(row.identityFingerprint, hostFingerprint);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('BEGIN CERTIFICATE'), false);
  assert.equal(serialized.includes('BEGIN PUBLIC KEY'), false);
});

test('GET link is null before linking, POST link succeeds, GET status reflects it', async () => {
  const before = await local.request(`${BASE}/devices/${deviceId}/omega-v2`);
  assert.equal(before.status, 200);
  assert.equal((await before.json()).link, null);

  const linked = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, json('POST', { omegaV2HostId: hostId, confirmFingerprint: hostFingerprint }));
  assert.equal(linked.status, 201);
  const linkedBody = await linked.json();
  assert.equal(linkedBody.link.linkState, 'OK');
  assert.equal(linkedBody.link.omegaV2HostId, hostId);

  const status = await local.request(`${BASE}/devices/${deviceId}/omega-v2/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).link.omegaV2HostId, hostId);

  const unlinked = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, { method: 'DELETE' });
  assert.equal(unlinked.status, 200);
  assert.equal((await unlinked.json()).unlinked, true);
});

test('link rejects unknown fields, wrong types, and malformed ids with safe codes', async () => {
  const unknownField = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`,
    json('POST', { omegaV2HostId: hostId, confirmFingerprint: hostFingerprint, extra: 'x' }));
  assert.equal(unknownField.status, 400);
  assert.equal((await unknownField.json()).error, 'unknown_field');

  const badId = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, json('POST', { omegaV2HostId: 'not-ov2h', confirmFingerprint: hostFingerprint }));
  assert.equal(badId.status, 400);
  assert.equal((await badId.json()).error, 'omega_v2_host_id_invalid');

  const badFingerprint = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, json('POST', { omegaV2HostId: hostId, confirmFingerprint: 'short' }));
  assert.equal(badFingerprint.status, 400);
  assert.equal((await badFingerprint.json()).error, 'confirm_fingerprint_invalid');

  // command/script/executable-shaped fields are just unknown fields: rejected the same way.
  for (const field of ['command', 'script', 'executable', 'shell', 'rawPayload']) {
    const withCommand = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`,
      json('POST', { omegaV2HostId: hostId, confirmFingerprint: hostFingerprint, [field]: 'x' }));
    assert.equal(withCommand.status, 400, field);
    assert.equal((await withCommand.json()).error, 'unknown_field', field);
  }
});

test('unknown Fabric device id on link/status/unlink returns a safe 404, never creates a device', async () => {
  const fakeId = 'fdev-00000000-0000-4000-8000-000000000000';
  const link = await local.request(`${BASE}/devices/${fakeId}/omega-v2/link`, json('POST', { omegaV2HostId: hostId, confirmFingerprint: hostFingerprint }));
  assert.equal(link.status, 404);
  assert.equal((await link.json()).error, 'fabric_device_not_found');

  const status = await local.request(`${BASE}/devices/${fakeId}/omega-v2/status`);
  assert.equal(status.status, 404);

  const unlink = await local.request(`${BASE}/devices/${fakeId}/omega-v2/link`, { method: 'DELETE' });
  assert.equal(unlink.status, 404);
});

test('security guard: remote caller 403, foreign Origin 403, non-JSON POST 415, oversized body 413', async () => {
  const remoteCall = await remote.request(`${BASE}/omega-v2/hosts`);
  assert.equal(remoteCall.status, 403);

  const foreignOrigin = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`,
    json('POST', { omegaV2HostId: hostId, confirmFingerprint: hostFingerprint }, { origin: 'https://evil.example' }));
  assert.equal(foreignOrigin.status, 403);

  const nonJson = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, { method: 'POST', body: 'x=1' });
  assert.equal(nonJson.status, 415);

  const oversized = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`,
    json('POST', { omegaV2HostId: hostId, confirmFingerprint: hostFingerprint, padding: 'x'.repeat(9_000) }));
  assert.equal(oversized.status, 413);
});

test('malformed JSON body and non-object JSON body rejected safely', async () => {
  const malformed = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'json_invalid');

  const array = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, json('POST', ['x']));
  assert.equal(array.status, 400);
  assert.equal((await array.json()).error, 'json_object_required');
});

test('the four semantic VIEW/session routes are strict and use only the closed VIEW service', async () => {
  const linked = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, json('POST', { omegaV2HostId: hostId, confirmFingerprint: hostFingerprint }));
  const link = (await linked.json()).link;
  const body = { screenIndex: 0, linkId: link.linkId, linkVersion: link.linkVersion,
    omegaV2HostId: link.omegaV2HostId, fingerprint: link.linkedFingerprint };
  const start = await local.request(`${BASE}/devices/${deviceId}/omega-v2/view/start`, json('POST', body));
  assert.equal(start.status, 201);
  assert.equal((await start.json()).view.omegaV2HostId, hostId);
  assert.deepEqual(viewCalls.start.at(-1), { id: deviceId, body });

  const status = await local.request(`${BASE}/devices/${deviceId}/omega-v2/view/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).view.sessionId, 'session-route');
  assert.equal(viewCalls.status.at(-1), deviceId);

  assert.equal((await local.request(`${BASE}/devices/${deviceId}/omega-v2/view/stop`, json('POST', {}))).status, 200);
  assert.equal((await local.request(`${BASE}/devices/${deviceId}/omega-v2/session/stop`, json('POST', {}))).status, 200);
  assert.equal(viewCalls.stopView.at(-1), deviceId);
  assert.equal(viewCalls.stopSession.at(-1), deviceId);

  const unknown = await local.request(`${BASE}/devices/${deviceId}/omega-v2/view/start`, json('POST', { ...body, command: 'x' }));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, 'unknown_field');
  await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, { method: 'DELETE' });
});

test('the three semantic INTERACTIVE routes are strict, take no body fields, and use only the closed service', async () => {
  const start = await local.request(`${BASE}/devices/${deviceId}/omega-v2/interactive/start`, json('POST', {}));
  assert.equal(start.status, 201);
  assert.equal((await start.json()).view.interactiveStatus, 'INTERACTIVE');
  assert.deepEqual(interactiveCalls.start.at(-1), { id: deviceId, body: {} });

  const status = await local.request(`${BASE}/devices/${deviceId}/omega-v2/interactive/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).view.interactiveStatus, 'INTERACTIVE');
  assert.equal(interactiveCalls.status.at(-1), deviceId);

  const stop = await local.request(`${BASE}/devices/${deviceId}/omega-v2/interactive/stop`, json('POST', {}));
  assert.equal(stop.status, 200);
  assert.equal(interactiveCalls.stop.at(-1), deviceId);

  // No field is accepted on start or stop: input is delegated to OMEGA's own
  // certified /input/* routes, never proxied through this one.
  const withField = await local.request(`${BASE}/devices/${deviceId}/omega-v2/interactive/start`, json('POST', { screenIndex: 0 }));
  assert.equal(withField.status, 400);
  assert.equal((await withField.json()).error, 'unknown_field');
  for (const field of ['command', 'key', 'x', 'y', 'button', 'pointer']) {
    const withInputField = await local.request(`${BASE}/devices/${deviceId}/omega-v2/interactive/start`, json('POST', { [field]: 'x' }));
    assert.equal(withInputField.status, 400, field);
  }
});

test('no generic/connect/raw-input/raw-admin route exists under the Fabric OMEGA V2 prefix (Phase 5: only VIEW+INTERACTIVE+closed-ADMIN start/status/stop are real)', async () => {
  const forbidden = ['input/mouse', 'input/keyboard', 'input/pointer', 'input/key',
    'admin', 'admin/execute', 'admin/command', 'admin/shell', 'admin/rpc', 'admin/raw', 'admin/action',
    'admin/registry', 'admin/service-start', 'admin/service-stop', 'admin/process-kill', 'admin/file-read', 'admin/file-write',
    'connect', 'execute', 'command', 'shell', 'rpc', 'raw'];
  for (const suffix of forbidden) {
    const getResponse = await local.request(`${BASE}/devices/${deviceId}/omega-v2/${suffix}`);
    assert.equal(getResponse.status, 404, `GET ${suffix}`);
    const postResponse = await local.request(`${BASE}/devices/${deviceId}/omega-v2/${suffix}`, json('POST', {}));
    assert.equal(postResponse.status, 404, `POST ${suffix}`);
  }
  // The generic Fabric routing endpoint (RASSILON only) must reject an OMEGA_V2 actionType, never route it.
  const routed = await local.request(`${BASE}/route`, json('POST', { fabricDeviceId: deviceId, actionType: 'OMEGA_V2_VIEW', semanticPayload: {} }));
  assert.equal(routed.status, 400);
  const routedAdmin = await local.request(`${BASE}/route`, json('POST', { fabricDeviceId: deviceId, actionType: 'OMEGA_V2_ADMIN', semanticPayload: {} }));
  assert.equal(routedAdmin.status, 400);
});

test('the nine typed ADMIN routes and STOP DEVICE/STOP ALL are strict, take exactly their documented body, and use only the closed service', async () => {
  const reads = ['system-info', 'processes', 'service-status', 'network-status', 'disk-status'];
  for (const name of reads) {
    const okResponse = await local.request(`${BASE}/devices/${deviceId}/omega-v2/admin/${name}`, json('POST', {}));
    assert.equal(okResponse.status, 200, name);
    const rejected = await local.request(`${BASE}/devices/${deviceId}/omega-v2/admin/${name}`, json('POST', { extra: 1 }));
    assert.equal(rejected.status, 400, `${name} rejects unknown field`);
  }
  const highImpact = ['lock', 'logoff', 'restart', 'shutdown'];
  for (const name of highImpact) {
    const missing = await local.request(`${BASE}/devices/${deviceId}/omega-v2/admin/${name}`, json('POST', {}));
    assert.equal(missing.status, 400, `${name} requires confirm`);
    const wrongField = await local.request(`${BASE}/devices/${deviceId}/omega-v2/admin/${name}`, json('POST', { confirm: name.toUpperCase(), extra: 1 }));
    assert.equal(wrongField.status, 400, `${name} rejects extra fields`);
  }
  const statusResponse = await local.request(`${BASE}/devices/${deviceId}/omega-v2/admin/status`);
  assert.equal(statusResponse.status, 200);
  const stopResponse = await local.request(`${BASE}/devices/${deviceId}/omega-v2/stop`, json('POST', {}));
  assert.equal(stopResponse.status, 200);
  const stopAllResponse = await local.request(`${BASE}/omega-v2/stop-all`, json('POST', {}));
  assert.equal(stopAllResponse.status, 200);
});

test('GET status/link/hosts never mutate the database (no side effect through the HTTP layer)', async () => {
  const linked = await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, json('POST', { omegaV2HostId: hostId, confirmFingerprint: hostFingerprint }));
  assert.equal(linked.status, 201);
  const before = await (await local.request(`${BASE}/devices/${deviceId}/omega-v2/status`)).json();
  for (let i = 0; i < 5; i += 1) await local.request(`${BASE}/devices/${deviceId}/omega-v2/status`);
  for (let i = 0; i < 5; i += 1) await local.request(`${BASE}/omega-v2/hosts`);
  const after = await (await local.request(`${BASE}/devices/${deviceId}/omega-v2/status`)).json();
  assert.deepEqual(after, before);
  await local.request(`${BASE}/devices/${deviceId}/omega-v2/link`, { method: 'DELETE' });
});
