import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createOmegaOutboundRoute } from './src/routes/omega-outbound.js';
import { ensureOmegaV2Identity } from './src/lib/omega-outbound-identity.js';
import { upsertInboundTrust, revokeInboundTrust, insertSession, getSession, endSession } from './src/lib/omega-outbound-store.js';
import { identityFingerprint, requestFields, responseFields, randomNonce, signMessage, verifyMessage } from './src/lib/omega-outbound-protocol.js';

// Host adapter + local API security matrix for OMEGA V2 ADMIN. In-memory SQLite,
// recorder executor and a fake approval channel: nothing real is ever executed.
initSqlite(':memory:');
const executed = [];
const approvals = [];
const adminExecutor = Object.fromEntries(['getSystemInfo', 'listProcesses', 'getServiceStatus', 'getNetworkStatus',
  'getDiskStatus', 'requestLock', 'requestLogoff', 'requestRestart', 'requestShutdown'].map(method => [method, async () => {
  executed.push(method);
  if (method === 'getSystemInfo') return { ok: true, system: { computerName: 'B', osCaption: 'W', osVersion: '10', architecture: 'x64', lastBootUpTime: 't' } };
  if (method === 'listProcesses') return { ok: true, processes: [{ pid: 1, name: '<img src=x onerror=alert(1)>', commandLine: 'secret' }] };
  if (method.startsWith('get')) return { ok: true, services: [], interfaces: [], disks: [] };
  return { ok: true, accepted: true };
}]));
const adminApprovalProvider = { request(request) { approvals.push(request); return { ok: true, cancel: () => { request.cancelled = true; } }; } };
const adminIndicatorProvider = { showSessionIndicator: async () => ({ ok: true }) };
const viewStub = { status: () => ({ status: 'STOPPED' }), stop: async () => ({ stopped: false }), onStop: () => {},
  start: async () => { throw new Error('unused'); }, frame: async () => { throw new Error('unused'); }, stopForController: async () => 0 };
const options = { certificateFingerprint: 'aa'.repeat(32), outboundViewManager: viewStub, adminExecutor, adminApprovalProvider, adminIndicatorProvider };
const app = new Hono();
app.route('/api', createOmegaOutboundRoute({ ...options, isLocal: () => false, isTls: () => true }));
const localApp = new Hono();
localApp.route('/api', createOmegaOutboundRoute({ ...options, isLocal: () => true, isTls: () => true }));
const host = ensureOmegaV2Identity('HOST');

function controller(maxPermission = 'ADMIN') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const deviceId = `ov2c-${crypto.randomUUID()}`;
  upsertInboundTrust({ controllerDeviceId: deviceId, publicKeyPem, identityFingerprint: identityFingerprint(publicKeyPem),
    maxPermission, createdAt: new Date().toISOString() });
  return { deviceId, privateKey };
}
function session(permission = 'ADMIN', ctrl = controller(), expiresInMs = 60_000) {
  const sessionId = crypto.randomUUID();
  insertSession({ sessionId, direction: 'INBOUND', localDeviceId: host.deviceId, remoteDeviceId: ctrl.deviceId, permission,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInMs).toISOString(), status: 'CONNECTED' });
  return { sessionId, ctrl };
}
function envelope(target, action, payload, overrides = {}) {
  const path = `/api/omega-v2/sessions/${target.sessionId}/${action}`;
  const fields = requestFields({ localDeviceId: overrides.localDeviceId ?? target.ctrl.deviceId, remoteDeviceId: host.deviceId,
    sessionId: overrides.sessionId ?? target.sessionId, requestId: crypto.randomUUID(), timestamp: overrides.timestamp ?? new Date().toISOString(),
    nonce: overrides.nonce ?? randomNonce(), method: 'POST', path, bodyBytes: Buffer.from(JSON.stringify(payload), 'utf8') });
  return { payload, auth: { ...fields, signature: signMessage(overrides.signingKey ?? target.ctrl.privateKey, 'OMEGA-V2/CONTROLLER/REQUEST', fields) } };
}
async function post(target, action, payload, overrides = {}, raw) {
  const body = raw ?? JSON.stringify(envelope(target, action, payload, overrides));
  const response = await app.request(`https://localhost/api/omega-v2/sessions/${target.sessionId}/${action}`, {
    method: 'POST', headers: { 'content-type': overrides.contentType ?? 'application/json' }, body });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, error: parsed?.payload?.error ?? parsed?.error, payload: parsed?.payload, body: parsed, sent: body };
}
const adminOp = (actionType, extra = {}) => ({ operationId: crypto.randomUUID(), actionType, ...extra });
const ask = (target, actionType, extra) => post(target, 'admin/request', adminOp(actionType, extra));
const bind = (request, overrides = {}) => ({ operationId: request.operationId, sessionId: request.sessionId,
  controllerDeviceId: request.controllerDeviceId, actionType: request.actionType, approvalNonce: request.approvalNonce, ...overrides });
async function decide(request, decision, overrides) {
  // Local host decision path only: the fake channel hands back what the visible prompt would.
  return new Promise(resolve => { request.onDecision(decision, bind(request, overrides)); setTimeout(resolve, 20); });
}

test('ADMIN session: signed, result-bound read with an exact safe schema', async () => {
  const target = session();
  const operation = adminOp('PROCESS_LIST');
  const result = await post(target, 'admin/request', operation);
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { type: 'ADMIN_RESULT', sessionId: target.sessionId, controllerDeviceId: target.ctrl.deviceId,
    hostDeviceId: host.deviceId, operationId: operation.operationId, actionType: 'PROCESS_LIST', status: 'EXECUTED',
    createdAt: result.payload.createdAt, expiresAt: null,
    result: { processes: [{ pid: 1, name: '<img src=x onerror=alert(1)>', memoryBytes: null, cpuSeconds: null }], count: 1, truncated: false } });
  const auth = result.body.auth;
  const sentAuth = JSON.parse(result.sent).auth;
  assert.ok(verifyMessage(host.publicKeyPem, auth.signature, 'OMEGA-V2/HOST/RESPONSE', responseFields({
    localDeviceId: target.ctrl.deviceId, remoteDeviceId: host.deviceId, sessionId: target.sessionId, requestId: sentAuth.requestId,
    timestamp: auth.timestamp, statusCode: 200, bodyBytes: Buffer.from(JSON.stringify(result.payload)) })), 'host-signed result');
  assert.equal(JSON.stringify(result.payload).includes('secret'), false, 'command line never projected');
});

test('VIEW and INTERACTIVE sessions are rejected for every ADMIN message', async () => {
  const before = executed.length;
  for (const permission of ['VIEW', 'INTERACTIVE']) {
    const target = session(permission, controller('ADMIN'));
    for (const actionType of ['GET_SYSTEM_INFO', 'PROCESS_LIST', 'LOCK', 'SHUTDOWN']) {
      const result = await ask(target, actionType);
      assert.equal(result.status, 403); assert.equal(result.error, 'PERMISSION_DENIED');
    }
    for (const action of ['admin/status', 'admin/cancel']) {
      assert.equal((await post(target, action, { operationId: crypto.randomUUID() })).error, 'PERMISSION_DENIED');
    }
    assert.equal(getSession(target.sessionId).permission, permission, 'no silent upgrade');
  }
  assert.equal(executed.length, before);
});

test('unknown actions and command-like parameters are rejected', async () => {
  const target = session();
  const before = executed.length;
  for (const actionType of ['EXECUTE', 'RUN', 'SHELL', 'POWERSHELL', 'lock', 'LOCK_WORKSTATION', 'SERVICE_RESTART']) {
    assert.equal((await ask(target, actionType)).error, 'ADMIN_ACTION_INVALID', actionType);
  }
  for (const extra of [{ command: 'calc' }, { script: 'x.ps1' }, { arguments: ['/c', 'dir'] }, { executable: 'cmd.exe' },
    { powershell: 'iex' }, { query: 'SELECT * FROM Win32_Process' }, { registryPath: 'HKLM\\...\\Run' }]) {
    assert.equal((await ask(target, 'GET_SYSTEM_INFO', extra)).error, 'ADMIN_PAYLOAD_INVALID', JSON.stringify(extra));
  }
  assert.equal(executed.length, before);
});

test('wrong device, wrong session, unknown session, expired and revoked are rejected', async () => {
  const target = session();
  const other = session();
  assert.equal((await ask(target, 'GET_SYSTEM_INFO', {}).then(() => post(target, 'admin/request', adminOp('GET_SYSTEM_INFO'), { localDeviceId: other.ctrl.deviceId }))).error, 'AUTH_FAILURE');
  assert.equal((await post(target, 'admin/request', adminOp('GET_SYSTEM_INFO'), { signingKey: other.ctrl.privateKey })).error, 'AUTH_FAILURE');
  assert.equal((await post(target, 'admin/request', adminOp('GET_SYSTEM_INFO'), { sessionId: other.sessionId })).error, 'AUTH_FAILURE');
  const misrouted = JSON.stringify(envelope(other, 'admin/request', adminOp('GET_SYSTEM_INFO')));
  assert.equal((await post(target, 'admin/request', null, {}, misrouted)).error, 'AUTH_FAILURE', 'envelope for another session');
  assert.equal((await post({ ...target, sessionId: crypto.randomUUID() }, 'admin/request', adminOp('GET_SYSTEM_INFO'))).status, 404);
  const expired = session('ADMIN', controller(), 60_000);
  getDatabase().prepare('UPDATE omega_v2_sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), expired.sessionId);
  const late = await ask(expired, 'GET_SYSTEM_INFO');
  assert.equal(late.status, 410); assert.equal(late.error, 'SESSION_EXPIRED');
  const revoked = session();
  revokeInboundTrust(revoked.ctrl.deviceId);
  assert.equal((await ask(revoked, 'GET_SYSTEM_INFO')).error, 'DEVICE_REVOKED');
});

test('replay, reused nonce, duplicate operationId and stale/future timestamps are rejected', async () => {
  const target = session();
  const body = JSON.stringify(envelope(target, 'admin/request', adminOp('DISK_STATUS')));
  assert.equal((await post(target, 'admin/request', null, {}, body)).status, 200);
  const before = executed.length;
  const replay = await post(target, 'admin/request', null, {}, body);
  assert.equal(replay.status, 409); assert.equal(replay.error, 'REPLAY_REJECTED');
  const nonce = JSON.parse(body).auth.nonce;
  assert.equal((await post(target, 'admin/request', adminOp('DISK_STATUS'), { nonce })).error, 'REPLAY_REJECTED');
  const duplicate = { ...JSON.parse(body).payload };
  assert.equal((await post(target, 'admin/request', duplicate)).error, 'OPERATION_DUPLICATE');
  assert.equal((await post(target, 'admin/request', { ...duplicate, actionType: 'SHUTDOWN' })).error, 'OPERATION_DUPLICATE');
  assert.equal((await post(target, 'admin/request', adminOp('DISK_STATUS'), { timestamp: new Date(Date.now() - 120_000).toISOString() })).error, 'AUTH_FAILURE');
  assert.equal((await post(target, 'admin/request', adminOp('DISK_STATUS'), { timestamp: new Date(Date.now() + 120_000).toISOString() })).error, 'AUTH_FAILURE');
  assert.equal(executed.length, before, 'no replayed execution');
  const audited = getDatabase().prepare("SELECT event_type FROM omega_v2_audit WHERE event_type='OUTBOUND_ADMIN_REPLAY_REJECTED' AND session_id=?").all(target.sessionId);
  assert.ok(audited.length >= 4);
});

test('oversized, wrong content type and malformed bodies are rejected', async () => {
  const target = session();
  const huge = await ask(target, 'GET_SYSTEM_INFO', { pad: 'x'.repeat(20_000) });
  assert.equal(huge.status, 413);
  assert.equal((await post(target, 'admin/request', adminOp('GET_SYSTEM_INFO'), { contentType: 'text/plain' })).status, 415);
  assert.equal((await post(target, 'admin/request', adminOp('GET_SYSTEM_INFO'), { contentType: 'application/x-www-form-urlencoded' })).status, 415);
  for (const raw of ['{"payload":', '[]', 'null', '"LOCK"']) assert.equal((await post(target, 'admin/request', null, {}, raw)).status, 400, raw);
});

test('high-impact: pending without approval, wrong-device approval rejected, then approval executes once', async () => {
  const target = session();
  const before = executed.length;
  const pending = await ask(target, 'LOCK');
  assert.equal(pending.status, 200); assert.equal(pending.payload.status, 'PENDING_APPROVAL'); assert.equal(pending.payload.type, 'ADMIN_STATUS');
  const request = approvals.at(-1);
  assert.equal(request.operationId, pending.payload.operationId);
  assert.equal((await post(target, 'admin/status', { operationId: request.operationId })).payload.status, 'PENDING_APPROVAL');
  assert.equal(executed.length, before, 'nothing executed without approval');
  await decide(request, 'ALLOW', { controllerDeviceId: controller().deviceId });
  assert.equal((await post(target, 'admin/status', { operationId: request.operationId })).payload.status, 'PENDING_APPROVAL');
  assert.equal(executed.length, before, 'approval naming another device is rejected');
  await decide(request, 'ALLOW');
  const done = await post(target, 'admin/status', { operationId: request.operationId });
  assert.equal(done.payload.status, 'EXECUTED'); assert.deepEqual(done.payload.result, { accepted: true });
  assert.deepEqual(executed.slice(before), ['requestLock']);
});

test('the controller cannot approve: no approval route, approval fields rejected, deny and cancel never execute', async () => {
  const target = session();
  for (const action of ['admin/approve', 'admin/approve-local', 'admin/allow', 'admin/decision', 'admin/confirm']) {
    assert.equal((await post(target, action, { operationId: crypto.randomUUID(), decision: 'ALLOW' })).status, 404, action);
  }
  assert.equal((await ask(target, 'SHUTDOWN', { approved: true })).error, 'ADMIN_PAYLOAD_INVALID');
  assert.equal((await ask(target, 'SHUTDOWN', { approval: { decision: 'ALLOW' } })).error, 'ADMIN_PAYLOAD_INVALID');
  const before = executed.length;
  const pending = await ask(target, 'SHUTDOWN');
  await decide(approvals.at(-1), 'DENY');
  const denied = await post(target, 'admin/status', { operationId: pending.payload.operationId });
  assert.equal(denied.payload.status, 'DENIED'); assert.equal(denied.payload.type, 'ADMIN_RESULT'); assert.equal(denied.payload.error, 'LOCAL_DENY');
  const next = session();
  const second = await ask(next, 'RESTART');
  const cancelled = await post(next, 'admin/cancel', { operationId: second.payload.operationId });
  assert.equal(cancelled.payload.status, 'CANCELLED'); assert.equal(cancelled.payload.error, 'CONTROLLER_CANCEL');
  assert.equal(approvals.at(-1).cancelled, true);
  await decide(approvals.at(-1), 'ALLOW');
  assert.equal(executed.length, before);
  // Another controller cannot observe or cancel it.
  const intruder = session();
  assert.equal((await post(intruder, 'admin/status', { operationId: second.payload.operationId })).error, 'OPERATION_NOT_FOUND');
});

test('remote STOP, STOP SESSION, revocation and expiry cancel pending ADMIN and block new ADMIN', async () => {
  const before = executed.length;
  const cases = [
    ['remote STOP', async target => endSession(target.sessionId, 'remote_stop'), 'REMOTE_STOPPED'],
    ['STOP SESSION', async target => assert.equal((await post(target, 'stop', {})).status, 200), 'REMOTE_STOPPED'],
    ['revocation', async target => revokeInboundTrust(target.ctrl.deviceId), 'DEVICE_REVOKED'],
    ['expiry', async target => getDatabase().prepare('UPDATE omega_v2_sessions SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), target.sessionId), 'SESSION_EXPIRED'],
  ];
  for (const [name, stop, code] of cases) {
    const target = session();
    await ask(target, 'LOGOFF');
    const request = approvals.at(-1);
    await stop(target);
    const blocked = await ask(target, 'GET_SYSTEM_INFO');
    assert.equal(blocked.error, code, name);
    assert.equal(request.cancelled, true, `${name}: pending approval closed`);
    await decide(request, 'ALLOW');
  }
  assert.equal(executed.length, before, 'no pending high-impact action survived STOP/revocation/expiry');
});

test('read-only quota is enforced at the host adapter', async () => {
  const target = session();
  for (let index = 0; index < 30; index += 1) assert.equal((await ask(target, 'NETWORK_STATUS')).status, 200);
  const limited = await ask(target, 'NETWORK_STATUS');
  assert.equal(limited.status, 429); assert.equal(limited.error, 'RATE_LIMITED');
});

test('no generic executor, shell, command, script, raw, RPC, file or credential route exists', async () => {
  const target = session();
  const forbidden = ['admin', 'admin/execute', 'admin/exec', 'admin/run', 'admin/shell', 'admin/terminal', 'admin/command',
    'admin/script', 'admin/raw', 'admin/rpc', 'admin/powershell', 'admin/cmd', 'admin/process/start', 'admin/process/kill',
    'admin/service/start', 'admin/service/stop', 'admin/registry', 'admin/file', 'admin/upload', 'admin/download',
    'admin/clipboard', 'admin/credentials', 'admin/lock', 'admin/shutdown', 'execute', 'shell', 'command', 'script', 'raw', 'rpc'];
  for (const action of forbidden) {
    assert.equal((await post(target, action, { operationId: crypto.randomUUID() })).status, 404, `host ${action}`);
    const local = await localApp.request(`http://localhost/api/omega/outbound/sessions/${target.sessionId}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(local.status, 404, `local ${action}`);
  }
  for (const path of ['/api/omega-v2/admin', '/api/omega-v2/execute', '/api/omega/outbound/execute', '/api/omega/outbound/shell',
    '/api/omega/outbound/command', '/api/omega/outbound/script', '/api/omega/outbound/raw', '/api/omega/outbound/rpc']) {
    const response = await localApp.request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 404, path);
  }
});

test('local ADMIN API is loopback-only, Origin-guarded and demands typed confirmation', async () => {
  const id = crypto.randomUUID();
  const local = (path, init = {}) => localApp.request(`http://localhost/api/omega/outbound/sessions/${id}/admin/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, body: init.body ?? '{}' });
  const remote = await app.request(`http://localhost/api/omega/outbound/sessions/${id}/admin/system-info`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(remote.status, 403);
  assert.equal((await local('system-info', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await localApp.request(`http://localhost/api/omega/outbound/sessions/${id}/admin/system-info`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await local('lock/request')).status, 400, 'first click without confirmation');
  assert.equal((await (await local('lock/request', { body: '{"confirm":"SHUTDOWN"}' })).json()).error, 'CONFIRMATION_REQUIRED');
  assert.equal((await local('lock/request', { body: '{"confirm":"LOCK","command":"x"}' })).status, 400);
  assert.equal((await (await local('system-info', { body: '{"command":"whoami"}' })).json()).error, 'ADMIN_PAYLOAD_INVALID');
  const noSession = await local('lock/request', { body: '{"confirm":"LOCK"}' });
  assert.equal(noSession.status, 409); assert.equal((await noSession.json()).error, 'SESSION_EXPIRED');
  assert.equal((await localApp.request(`http://localhost/api/omega/outbound/sessions/not-a-session/admin/system-info`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  const huge = await local('system-info', { body: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
  assert.equal(huge.status, 413);
});
