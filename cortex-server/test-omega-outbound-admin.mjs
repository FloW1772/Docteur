import './test-setup.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { upsertInboundTrust, revokeInboundTrust, insertSession, getSession, endSession } from './src/lib/omega-outbound-store.js';
import { identityFingerprint } from './src/lib/omega-outbound-protocol.js';

// OMEGA V2 ADMIN manager + schema tests. The V1 executor module is replaced by
// recorders BEFORE the V2 module is loaded, and every test refuses to run if
// that replacement is not verifiably in place: no real LOCK, LOGOFF, RESTART,
// SHUTDOWN or Windows probe can be reached from this file.
const V1_NAMES = { getSystemInfo: 'GET_SYSTEM_INFO', getProcessList: 'GET_PROCESS_LIST', getServiceStatus: 'GET_SERVICE_STATUS',
  getNetworkStatus: 'GET_NETWORK_STATUS', getDiskStatus: 'GET_DISK_STATUS', lockWorkstation: 'LOCK_WORKSTATION',
  requestLogoff: 'REQUEST_LOGOFF', requestRestart: 'REQUEST_RESTART', requestShutdown: 'REQUEST_SHUTDOWN' };
const v1Calls = [];
const v1Mocks = Object.fromEntries(Object.entries(V1_NAMES).map(([name, action]) => [name, async (...args) => {
  v1Calls.push({ name, args: args.length });
  return action.startsWith('GET_') ? { ok: true, action, system: { computerName: 'B', osCaption: 'W', osVersion: '10',
    architecture: '64-bit', lastBootUpTime: 'now' }, processes: [], services: [], interfaces: [], disks: [] }
    : { ok: true, action, accepted: true };
}]));
mock.module('./src/lib/omega-admin.js', { namedExports: v1Mocks });
const v1Module = await import('./src/lib/omega-admin.js');
const MOCKED = Object.keys(V1_NAMES).every(name => v1Module[name] === v1Mocks[name]);
const admin = await import('./src/lib/omega-outbound-admin.js');
const { createOmegaOutboundAdminManager, createOmegaV2AdminPromptApprovalProvider, projectAdminResult,
  validateAdminResult, OMEGA_V2_ADMIN_ACTIONS, OMEGA_V2_ADMIN_REAL_EXECUTOR, OMEGA_V2_ADMIN_LIMITS } = admin;
const guarded = { skip: MOCKED ? false : 'V1 executor mock not active: refusing to run' };

initSqlite(':memory:');
const HOST_ID = `ov2h-${crypto.randomUUID()}`;
const SECRETS = ['TOKEN123', 'sk-live-abc', 'hunter2', 'SECRET-PRODUCT-KEY', 'AA:BB:CC:DD:EE:FF', 'wpa-secret',
  'proxy-secret', 'spoolsv', 'LocalSystem', 'secret.txt', 'flow-user', 'BIOS-SERIAL'];

function controller(maxPermission = 'ADMIN') {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const deviceId = `ov2c-${crypto.randomUUID()}`;
  upsertInboundTrust({ controllerDeviceId: deviceId, publicKeyPem, identityFingerprint: identityFingerprint(publicKeyPem),
    maxPermission, createdAt: new Date().toISOString() });
  return deviceId;
}
function session(permission = 'ADMIN', { ctrl = controller(), expiresInMs = 60_000 } = {}) {
  const sessionId = crypto.randomUUID();
  insertSession({ sessionId, direction: 'INBOUND', localDeviceId: HOST_ID, remoteDeviceId: ctrl, permission,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInMs).toISOString(), status: 'CONNECTED' });
  return getSession(sessionId);
}

const FIXTURES = {
  getSystemInfo: { ok: true, action: 'GET_SYSTEM_INFO', system: { computerName: 'HOST-B', osCaption: 'Windows 11 Pro',
    osVersion: '10.0.26200', architecture: '64-bit', lastBootUpTime: '28/09/2026 08:00:00', productKey: 'SECRET-PRODUCT-KEY',
    domainPassword: 'hunter2', serialNumber: 'BIOS-SERIAL' } },
  listProcesses: { ok: true, action: 'GET_PROCESS_LIST', processes: [
    { pid: 42, name: 'node', sessionId: 1, memoryBytes: 1000, cpuSeconds: 1.23456, commandLine: 'node --secret=TOKEN123',
      environment: { API_KEY: 'sk-live-abc' }, user: 'flow-user' },
    { pid: 4, name: 'System', sessionId: 0, memoryBytes: null, cpuSeconds: null }] },
  getServiceStatus: { ok: true, action: 'GET_SERVICE_STATUS', services: [
    { name: 'Spooler', displayName: 'Print Spooler', state: 'Running', startMode: 'Auto',
      pathName: 'C:\\Windows\\System32\\spoolsv.exe', startName: 'LocalSystem' }] },
  getNetworkStatus: { ok: true, action: 'GET_NETWORK_STATUS', interfaces: [
    { description: 'Ethernet', macAddress: 'AA:BB:CC:DD:EE:FF', dhcpEnabled: true, addresses: ['192.168.1.14', 'fe80::1'],
      gateways: ['192.168.1.1'], dnsServers: ['192.168.1.1'], wifiPassword: 'wpa-secret', proxyPassword: 'proxy-secret' }] },
  getDiskStatus: { ok: true, action: 'GET_DISK_STATUS', disks: [
    { drive: 'C:', filesystem: 'NTFS', totalBytes: 512_000_000_000, freeBytes: 100_000_000_000, files: ['C:\\secret.txt'] }] },
};
const HIGH = { requestLock: 'LOCK_WORKSTATION', requestLogoff: 'REQUEST_LOGOFF', requestRestart: 'REQUEST_RESTART', requestShutdown: 'REQUEST_SHUTDOWN' };

function fakeExecutor(overrides = {}) {
  const calls = [];
  const executor = {};
  for (const method of [...Object.keys(FIXTURES), ...Object.keys(HIGH)]) {
    executor[method] = async (...args) => {
      calls.push({ method, args: args.length });
      if (overrides[method]) return overrides[method]();
      return FIXTURES[method] ?? { ok: true, action: HIGH[method], accepted: true };
    };
  }
  return { executor, calls };
}
function fakeApproval({ ok = true } = {}) {
  const requests = [];
  return { requests, provider: { request(request) {
    requests.push(request);
    return ok ? { ok: true, cancel: () => { request.cancelled = true; } } : { ok: false };
  } } };
}
function binding(request, overrides = {}) {
  return { operationId: request.operationId, sessionId: request.sessionId, controllerDeviceId: request.controllerDeviceId,
    actionType: request.actionType, approvalNonce: request.approvalNonce, ...overrides };
}
const indicatorOk = { showSessionIndicator: async () => ({ ok: true }) };
function manager({ executor = fakeExecutor(), approval = fakeApproval(), limits, indicator = indicatorOk } = {}) {
  return { executor, approval, admin: createOmegaOutboundAdminManager({ executor: executor.executor,
    approvalProvider: approval.provider, indicatorProvider: indicator, limits }) };
}
const op = (actionType, extra = {}) => ({ operationId: crypto.randomUUID(), actionType, ...extra });
async function rejects(promise, code) {
  await assert.rejects(Promise.resolve().then(() => promise), error => error.code === code, code);
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('read-only actions return the exact safe schema and drop every non-allowlisted field', guarded, async () => {
  const { admin: m } = manager();
  const target = session();
  const results = {};
  for (const actionType of ['GET_SYSTEM_INFO', 'PROCESS_LIST', 'SERVICE_STATUS', 'NETWORK_STATUS', 'DISK_STATUS']) {
    const result = await m.request(target, op(actionType));
    assert.equal(result.status, 'EXECUTED', actionType);
    assert.equal(result.type, 'ADMIN_RESULT');
    assert.ok(validateAdminResult(actionType, result.result), actionType);
    results[actionType] = result.result;
  }
  assert.deepEqual(Object.keys(results.GET_SYSTEM_INFO.system), ['computerName', 'osCaption', 'osVersion', 'architecture', 'lastBootUpTime']);
  assert.deepEqual(results.PROCESS_LIST.processes, [
    { pid: 4, name: 'System', memoryBytes: null, cpuSeconds: null },
    { pid: 42, name: 'node', memoryBytes: 1000, cpuSeconds: 1.235 }]);
  assert.deepEqual(results.SERVICE_STATUS.services, [{ name: 'Spooler', displayName: 'Print Spooler', state: 'Running', startMode: 'Auto' }]);
  assert.deepEqual(results.NETWORK_STATUS.interfaces, [{ description: 'Ethernet', dhcpEnabled: true,
    addresses: ['192.168.1.14', 'fe80::1'], gateways: ['192.168.1.1'], dnsServers: ['192.168.1.1'] }]);
  assert.deepEqual(results.DISK_STATUS.disks, [{ drive: 'C:', filesystem: 'NTFS', totalBytes: 512_000_000_000, freeBytes: 100_000_000_000 }]);
  const serialized = JSON.stringify(results);
  for (const secret of SECRETS) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(validateAdminResult('PROCESS_LIST', { ...results.PROCESS_LIST, extra: 1 }), false, 'strict key set');
  assert.equal(validateAdminResult('PROCESS_LIST', { processes: [{ pid: 1, name: 'x', memoryBytes: 1, cpuSeconds: 1, commandLine: 'y' }], count: 1, truncated: false }), false);
});

test('process list DoS is truncated deterministically by count and by bytes', guarded, async () => {
  const huge = { ok: true, action: 'GET_PROCESS_LIST', processes: Array.from({ length: 5_000 }, (_, index) => ({
    pid: 5_000 - index, name: `p${'x'.repeat(300)}`, memoryBytes: index, cpuSeconds: 0.5 })) };
  const executor = fakeExecutor({ listProcesses: () => huge });
  const { admin: m } = manager({ executor });
  const first = await m.request(session(), op('PROCESS_LIST'));
  const second = await m.request(session(), op('PROCESS_LIST'));
  assert.equal(first.result.processes.length, 200);
  assert.equal(first.result.count, 200);
  assert.equal(first.result.truncated, true);
  assert.deepEqual(first.result.processes.map(row => row.pid), Array.from({ length: 200 }, (_, index) => index + 1));
  assert.ok(first.result.processes.every(row => row.name.length <= 128));
  assert.deepEqual(first.result, second.result, 'deterministic');
  assert.ok(Buffer.byteLength(JSON.stringify(first.result)) <= OMEGA_V2_ADMIN_LIMITS.maxResultBytes);
  const small = projectAdminResult('PROCESS_LIST', huge, 4_096);
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 4_096 && small.truncated && small.processes.length < 200);
  assert.deepEqual(small.processes.map(row => row.pid), Array.from({ length: small.processes.length }, (_, index) => index + 1));
  assert.equal(projectAdminResult('SERVICE_STATUS', { services: Array.from({ length: 900 }, (_, i) => ({ name: `s${i}`, displayName: 'd', state: 'Running', startMode: 'Auto' })) }).services.length, 200);
  assert.equal(projectAdminResult('NETWORK_STATUS', { interfaces: Array.from({ length: 90 }, (_, i) => ({ description: `n${i}`, addresses: Array(40).fill('10.0.0.1') })) }).interfaces[0].addresses.length, 16);
  assert.equal(projectAdminResult('DISK_STATUS', { disks: Array.from({ length: 90 }, (_, i) => ({ drive: `D${i}`, filesystem: 'NTFS', totalBytes: 1, freeBytes: 1 })) }).disks.length, 32);
});

test('only an ADMIN session may use ADMIN: VIEW and INTERACTIVE are rejected with no silent upgrade', guarded, async () => {
  const { admin: m, executor } = manager();
  for (const permission of ['VIEW', 'INTERACTIVE']) {
    const target = session(permission, { ctrl: controller('ADMIN') });
    for (const actionType of OMEGA_V2_ADMIN_ACTIONS) await rejects(m.request(target, op(actionType)), 'PERMISSION_DENIED');
    await rejects(m.request({ ...target, permissionOverride: 'ADMIN' }, op('LOCK', {})), 'PERMISSION_DENIED');
  }
  assert.equal(executor.calls.length, 0);
});

test('closed allowlist: unknown actions and command-like parameters are rejected before any executor', guarded, async () => {
  const { admin: m, executor, approval } = manager({ limits: { invalidPerMinute: 1_000 } });
  const target = session();
  for (const actionType of ['EXECUTE', 'RUN_COMMAND', 'SHELL', 'lock', 'Lock', 'LOCK_WORKSTATION', 'GET_PROCESS_LIST',
    'toString', '__proto__', 'constructor', 'SERVICE_START', 'SERVICE_STOP', 'SLEEP', '', 7, null, ['LOCK'], { LOCK: 1 }]) {
    await rejects(m.request(target, op(actionType)), 'ADMIN_ACTION_INVALID');
  }
  for (const extra of [{ command: 'calc' }, { script: 'x' }, { executable: 'cmd.exe' }, { arguments: ['/c'] }, { args: [] },
    { shell: true }, { powershell: 'Get-Process' }, { cmd: 'dir' }, { path: 'C:\\x.exe' }, { query: 'SELECT *' },
    { wmi: 'Win32_Process' }, { registryPath: 'HKLM\\Run' }, { approved: true }, { approval: 'ALLOW' }, { permission: 'ADMIN' }]) {
    await rejects(m.request(target, op('GET_SYSTEM_INFO', extra)), 'ADMIN_PAYLOAD_INVALID');
    await rejects(m.request(target, op('LOCK', extra)), 'ADMIN_PAYLOAD_INVALID');
  }
  const polluted = JSON.parse(`{"operationId":"${crypto.randomUUID()}","actionType":"LOCK","__proto__":{"approved":true}}`);
  await rejects(m.request(target, polluted), 'ADMIN_PAYLOAD_INVALID');
  await rejects(m.request(target, { operationId: 'not-a-uuid', actionType: 'LOCK' }), 'OPERATION_ID_INVALID');
  await rejects(m.request(target, null), 'ADMIN_PAYLOAD_INVALID');
  await rejects(m.request(target, ['LOCK']), 'ADMIN_PAYLOAD_INVALID');
  assert.equal(executor.calls.length, 0);
  assert.equal(approval.requests.length, 0);
});

test('duplicate operationId is rejected and audited as replay', guarded, async () => {
  const { admin: m, executor } = manager();
  const target = session();
  const first = op('GET_SYSTEM_INFO');
  assert.equal((await m.request(target, first)).status, 'EXECUTED');
  await rejects(m.request(target, first), 'OPERATION_DUPLICATE');
  await rejects(m.request(target, { ...first, actionType: 'SHUTDOWN' }), 'OPERATION_DUPLICATE');
  assert.equal(executor.calls.length, 1);
  const audit = getDatabase().prepare("SELECT * FROM omega_v2_audit WHERE event_type='OUTBOUND_ADMIN_REPLAY_REJECTED' AND session_id=?").all(target.id);
  assert.equal(audit.length, 2);
});

test('LOCK, LOGOFF, RESTART and SHUTDOWN need local approval and run exactly the matching typed mock', guarded, async () => {
  const { admin: m, executor, approval } = manager();
  const methods = { LOCK: 'requestLock', LOGOFF: 'requestLogoff', RESTART: 'requestRestart', SHUTDOWN: 'requestShutdown' };
  for (const [actionType, method] of Object.entries(methods)) {
    const target = session();
    const pending = await m.request(target, op(actionType));
    assert.equal(pending.status, 'PENDING_APPROVAL');
    assert.equal(pending.type, 'ADMIN_STATUS');
    assert.equal(executor.calls.length, 0, 'nothing runs before approval');
    const request = approval.requests.at(-1);
    assert.equal(request.actionType, actionType);
    assert.equal(request.controllerDeviceId, target.remote_device_id);
    assert.deepEqual(await m.decide(request.operationId, 'ALLOW', binding(request)), { accepted: true, status: 'EXECUTED' });
    const done = m.status(target, { operationId: request.operationId });
    assert.equal(done.status, 'EXECUTED');
    assert.deepEqual(done.result, { accepted: true });
    assert.deepEqual(executor.calls.splice(0), [{ method, args: 0 }]);
    assert.deepEqual(await m.decide(request.operationId, 'ALLOW', binding(request)), { accepted: false, code: 'APPROVAL_EXPIRED' }, 'one-time approval');
    assert.equal(executor.calls.length, 0);
  }
});

test('approval must match device, session, action and nonce; mismatches never execute', guarded, async () => {
  const { admin: m, executor, approval } = manager();
  const target = session();
  await m.request(target, op('SHUTDOWN'));
  const request = approval.requests.at(-1);
  const other = session();
  for (const wrong of [{ controllerDeviceId: other.remote_device_id }, { sessionId: other.id }, { actionType: 'LOCK' }]) {
    assert.equal((await m.decide(request.operationId, 'ALLOW', binding(request, wrong))).code, 'APPROVAL_BINDING_MISMATCH');
    if (m.status(target, { operationId: request.operationId }).status !== 'PENDING_APPROVAL') break;
  }
  assert.equal(executor.calls.length, 0);
  const final = m.status(target, { operationId: request.operationId });
  assert.equal(final.status, 'DENIED', 'three bad approvals deny the request');
  const second = session();
  await m.request(second, op('LOCK'));
  const next = approval.requests.at(-1);
  assert.equal((await m.decide(next.operationId, 'ALLOW', binding(next, { approvalNonce: 'forged' }))).code, 'APPROVAL_BINDING_MISMATCH');
  assert.equal((await m.decide(next.operationId, 'ALLOW', binding(next))).status, 'EXECUTED');
  assert.deepEqual(executor.calls.map(call => call.method), ['requestLock']);
  // The other controller cannot even see the operation.
  await rejects(Promise.resolve().then(() => m.status(other, { operationId: request.operationId })), 'OPERATION_NOT_FOUND');
  await rejects(Promise.resolve().then(() => m.cancel(other, { operationId: next.operationId })), 'OPERATION_NOT_FOUND');
});

test('deny, unavailable approval channel and approval timeout all fail closed', guarded, async () => {
  const { admin: m, executor, approval } = manager({ limits: { approvalTimeoutMs: 80 } });
  const denied = session();
  await m.request(denied, op('RESTART'));
  const request = approval.requests.at(-1);
  await m.decide(request.operationId, 'DENY', binding(request));
  const deniedState = m.status(denied, { operationId: request.operationId });
  assert.equal(deniedState.status, 'DENIED'); assert.equal(deniedState.error, 'LOCAL_DENY');

  const unavailable = manager({ approval: fakeApproval({ ok: false }) });
  const u = await unavailable.admin.request(session(), op('SHUTDOWN'));
  assert.equal(u.status, 'DENIED'); assert.equal(u.error, 'APPROVAL_UNAVAILABLE');
  const throwing = createOmegaOutboundAdminManager({ executor: executor.executor, indicatorProvider: indicatorOk,
    approvalProvider: { request() { throw new Error('no desktop'); } } });
  assert.equal((await throwing.request(session(), op('LOCK'))).error, 'APPROVAL_UNAVAILABLE');
  const noProvider = createOmegaOutboundAdminManager({ executor: executor.executor, indicatorProvider: indicatorOk, approvalProvider: null });
  assert.equal((await noProvider.request(session(), op('LOCK'))).error, 'APPROVAL_UNAVAILABLE');

  const timed = session();
  await m.request(timed, op('SHUTDOWN'));
  const late = approval.requests.at(-1);
  await wait(150);
  const expired = m.status(timed, { operationId: late.operationId });
  assert.equal(expired.status, 'EXPIRED'); assert.equal(expired.error, 'APPROVAL_TIMEOUT');
  assert.equal(late.cancelled, true, 'prompt closed');
  assert.equal((await m.decide(late.operationId, 'ALLOW', binding(late))).accepted, false);
  assert.equal(executor.calls.length, 0);
});

test('controller cancel, STOP, remote STOP, revocation, expiry and lease loss cancel a pending action', guarded, async () => {
  const { admin: m, executor, approval } = manager({ limits: { approvalLeaseMs: 120 } });
  const scenarios = [
    ['CONTROLLER_CANCEL', async target => m.cancel(target, { operationId: approval.requests.at(-1).operationId })],
    ['CONTROLLER_STOP', async target => m.stop(target.id, 'CONTROLLER_STOP')],
    ['REMOTE_STOPPED', async target => endSession(target.id, 'remote_stop')],
    ['DEVICE_REVOKED', async target => revokeInboundTrust(target.remote_device_id)],
    ['SESSION_EXPIRED', async target => getDatabase().prepare('UPDATE omega_v2_sessions SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), target.id)],
  ];
  for (const [code, action] of scenarios) {
    const target = session();
    await m.request(target, op('LOGOFF'));
    const request = approval.requests.at(-1);
    await action(target);
    const decision = await m.decide(request.operationId, 'ALLOW', binding(request));
    assert.equal(decision.accepted, false, code);
    assert.equal(executor.calls.length, 0, `${code}: no execution`);
    if (['CONTROLLER_CANCEL'].includes(code)) {
      assert.equal(m.status(target, { operationId: request.operationId }).status, 'CANCELLED');
      assert.equal(request.cancelled, true);
    }
  }
  // STOP blocks every later ADMIN request on that session.
  const stopped = session();
  await m.stop(stopped.id, 'CONTROLLER_STOP');
  endSession(stopped.id, 'controller_stop');
  await rejects(m.request(stopped, op('GET_SYSTEM_INFO')), 'REMOTE_STOPPED');
  // Lease: pending approval without controller status is cancelled; status keeps it alive.
  const alive = session();
  await m.request(alive, op('LOCK'));
  const kept = approval.requests.at(-1);
  for (let index = 0; index < 5; index += 1) { await wait(50); m.status(alive, { operationId: kept.operationId }); }
  assert.equal(m.status(alive, { operationId: kept.operationId }).status, 'PENDING_APPROVAL');
  await wait(200);
  const lost = m.status(alive, { operationId: kept.operationId });
  assert.equal(lost.status, 'CANCELLED'); assert.equal(lost.error, 'NETWORK_TIMEOUT');
  assert.equal(executor.calls.length, 0);
});

test('execution failures and timeouts are bounded and reported without raw detail', guarded, async () => {
  const hang = fakeExecutor({ getSystemInfo: () => new Promise(() => {}), getDiskStatus: () => ({ ok: false, error: 'ACCESS_DENIED' }),
    getNetworkStatus: () => { throw new Error('C:\\secret\\path failure'); }, getServiceStatus: () => ({ ok: true, action: 'GET_DISK_STATUS', disks: [] }),
    listProcesses: () => ({ ok: true, action: 'GET_PROCESS_LIST', processes: 'not-a-list' }) });
  const { admin: m } = manager({ executor: hang, limits: { executionTimeoutMs: 50 } });
  const target = session();
  const expected = { GET_SYSTEM_INFO: 'EXECUTION_TIMEOUT', DISK_STATUS: 'ACCESS_DENIED', NETWORK_STATUS: 'ADMIN_EXECUTION_FAILED',
    SERVICE_STATUS: 'ADMIN_RESULT_INVALID', PROCESS_LIST: 'ADMIN_RESULT_INVALID' };
  for (const [actionType, code] of Object.entries(expected)) {
    const result = await m.request(target, op(actionType));
    assert.equal(result.status, 'FAILED', actionType); assert.equal(result.error, code, actionType);
    assert.equal(result.result, undefined);
  }
  const audit = JSON.stringify(getDatabase().prepare('SELECT * FROM omega_v2_audit WHERE session_id=?').all(target.id));
  assert.equal(audit.includes('secret'), false);
});

test('rate limits: read quota, one pending high-impact, interval and invalid-attempt lockout', guarded, async () => {
  const { admin: m, approval } = manager();
  const target = session();
  for (let index = 0; index < 30; index += 1) assert.equal((await m.request(target, op('DISK_STATUS'))).status, 'EXECUTED');
  await rejects(m.request(target, op('DISK_STATUS')), 'RATE_LIMITED');
  const high = session();
  await m.request(high, op('LOCK'));
  await rejects(m.request(high, op('SHUTDOWN')), 'ADMIN_HIGH_IMPACT_PENDING');
  const request = approval.requests.at(-1);
  await m.decide(request.operationId, 'ALLOW', binding(request));
  await rejects(m.request(high, op('SHUTDOWN')), 'RATE_LIMITED');
  const noisy = session();
  for (let index = 0; index < 20; index += 1) await rejects(m.request(noisy, op('NOPE')), 'ADMIN_ACTION_INVALID');
  await rejects(m.request(noisy, op('GET_SYSTEM_INFO')), 'RATE_LIMITED');
  const statusFlood = session();
  const read = await m.request(statusFlood, op('GET_SYSTEM_INFO'));
  for (let index = 0; index < 120; index += 1) m.status(statusFlood, { operationId: read.operationId });
  await rejects(Promise.resolve().then(() => m.status(statusFlood, { operationId: read.operationId })), 'RATE_LIMITED');
});

test('host indicator is mandatory and its local STOP ends the session and pending ADMIN', guarded, async () => {
  const refused = manager({ indicator: { showSessionIndicator: async () => ({ ok: false }) } });
  await rejects(refused.admin.request(session(), op('GET_SYSTEM_INFO')), 'REMOTE_CONSENT_UNAVAILABLE');
  assert.equal(refused.executor.calls.length, 0);
  let localStop;
  const kinds = [];
  const remoteStops = [];
  const executor = fakeExecutor();
  const approval = fakeApproval();
  const m = createOmegaOutboundAdminManager({ executor: executor.executor, approvalProvider: approval.provider,
    onRemoteLocalStop: sessionId => remoteStops.push(sessionId),
    indicatorProvider: { showSessionIndicator: async (kind, _id, _device, _expiresAt, onLocalStop) => {
      kinds.push(kind); if (onLocalStop) localStop = onLocalStop; return { ok: true }; } } });
  const target = session();
  await m.request(target, op('SHUTDOWN'));
  const request = approval.requests.at(-1);
  localStop();
  await wait(20);
  assert.equal(getSession(target.id).ended_at !== null, true, 'session terminated by host STOP');
  assert.deepEqual(remoteStops, [target.id]);
  assert.deepEqual(kinds, ['admin_start', 'admin_stop']);
  assert.equal((await m.decide(request.operationId, 'ALLOW', binding(request))).accepted, false);
  assert.equal(executor.calls.length, 0);
});

test('audit is closed and privacy-safe: no results, secrets or payload echo', guarded, async () => {
  const rows = getDatabase().prepare("SELECT * FROM omega_v2_audit WHERE event_type LIKE 'OUTBOUND_ADMIN_%'").all();
  const types = new Set(rows.map(row => row.event_type));
  for (const type of ['OUTBOUND_ADMIN_REQUESTED', 'OUTBOUND_ADMIN_APPROVAL_REQUIRED', 'OUTBOUND_ADMIN_APPROVED',
    'OUTBOUND_ADMIN_DENIED', 'OUTBOUND_ADMIN_EXECUTED', 'OUTBOUND_ADMIN_FAILED', 'OUTBOUND_ADMIN_CANCELLED',
    'OUTBOUND_ADMIN_REPLAY_REJECTED']) assert.ok(types.has(type), type);
  const serialized = JSON.stringify(rows);
  for (const secret of [...SECRETS, 'Print Spooler', '192.168.1.14', 'HOST-B', 'calc', 'cmd.exe', 'Get-Process', 'approvalNonce']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  for (const row of rows) {
    const keys = Object.keys(JSON.parse(row.detail));
    assert.ok(keys.every(key => ['operationId', 'actionType', 'status', 'expiresAt', 'attempt', 'permission'].includes(key)), keys.join());
  }
});

test('default executor is the typed V1 binding (verified against the mocked V1 module only)', guarded, async () => {
  assert.deepEqual(Object.keys(OMEGA_V2_ADMIN_REAL_EXECUTOR).sort(), ['getDiskStatus', 'getNetworkStatus', 'getServiceStatus',
    'getSystemInfo', 'listProcesses', 'requestLock', 'requestLogoff', 'requestRestart', 'requestShutdown']);
  assert.ok(Object.values(OMEGA_V2_ADMIN_REAL_EXECUTOR).every(fn => fn.length === 0), 'no parameters accepted');
  const approval = fakeApproval();
  const m = createOmegaOutboundAdminManager({ approvalProvider: approval.provider, indicatorProvider: indicatorOk });
  v1Calls.length = 0;
  for (const actionType of ['GET_SYSTEM_INFO', 'PROCESS_LIST', 'SERVICE_STATUS', 'NETWORK_STATUS', 'DISK_STATUS']) await m.request(session(), op(actionType));
  for (const actionType of ['LOCK', 'LOGOFF', 'RESTART', 'SHUTDOWN']) {
    await m.request(session(), op(actionType));
    const request = approval.requests.at(-1);
    await m.decide(request.operationId, 'ALLOW', binding(request));
  }
  assert.deepEqual(v1Calls, ['getSystemInfo', 'getProcessList', 'getServiceStatus', 'getNetworkStatus', 'getDiskStatus',
    'lockWorkstation', 'requestLogoff', 'requestRestart', 'requestShutdown'].map(name => ({ name, args: 0 })));
});

test('real approval channel reuses the fixed V1 prompt with enum-only arguments and fails closed', guarded, async () => {
  const calls = [];
  const decisions = [];
  const allow = createOmegaV2AdminPromptApprovalProvider({ windows: () => true, runScript: async (scriptPath, args, options) => {
    calls.push({ scriptPath, args, options });
    fs.writeFileSync(args[5], 'ALLOW', 'utf8');
    return { ok: true, stdout: '' };
  } });
  const request = { operationId: crypto.randomUUID(), sessionId: crypto.randomUUID(), controllerDeviceId: `ov2c-${crypto.randomUUID()}`,
    actionType: 'SHUTDOWN', approvalNonce: 'nonce', expiresAt: new Date(Date.now() + 30_000).toISOString(),
    onDecision: (decision, value) => decisions.push({ decision, value }) };
  assert.equal(allow.request(request).ok, true);
  await wait(50);
  assert.match(calls[0].scriptPath, /omega-admin-prompt\.ps1$/);
  assert.deepEqual(calls[0].args.filter((_, index) => ![5, 7].includes(index)),
    ['-Action', 'REQUEST_SHUTDOWN', '-DeviceId', request.controllerDeviceId, '-ApprovalFile', '-LeaseFile', '-LeaseTimeoutMs', '5000', '-TimeoutSeconds', '30']);
  assert.ok(calls[0].args.every(arg => /^[A-Za-z0-9_.:\\/-]{1,260}$/.test(arg)), 'V1 fixed-runner argument policy');
  assert.equal(decisions[0].decision, 'ALLOW');
  assert.equal(decisions[0].value.approvalNonce, 'nonce');
  assert.equal(fs.existsSync(calls[0].args[5]), false, 'approval files removed');

  const cancelled = [];
  let leaseGone = false;
  const cancellable = createOmegaV2AdminPromptApprovalProvider({ windows: () => true, runScript: async (_path, args) => {
    while (fs.existsSync(args[7])) await wait(10);
    leaseGone = true;
    fs.writeFileSync(args[5], 'DENY', 'utf8');
    return { ok: true };
  } });
  const handle = cancellable.request({ ...request, onDecision: decision => cancelled.push(decision) });
  await wait(30);
  handle.cancel();
  await wait(80);
  assert.equal(leaseGone, true, 'cancel removes the lease so the prompt closes itself');
  assert.deepEqual(cancelled, [], 'no decision after cancel');

  const unavailable = [];
  createOmegaV2AdminPromptApprovalProvider({ windows: () => true, runScript: async () => { throw new Error('unsafe argument'); } })
    .request({ ...request, onDecision: decision => unavailable.push(decision) });
  await wait(30);
  assert.deepEqual(unavailable, ['UNAVAILABLE']);
  assert.equal(createOmegaV2AdminPromptApprovalProvider({ windows: () => false }).request(request).ok, false);
});
