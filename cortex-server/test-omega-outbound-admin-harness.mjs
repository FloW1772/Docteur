import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { getCertificate } from '@vitejs/plugin-basic-ssl';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { ensureOmegaV2Identity, signWithOmegaV2Identity } from './src/lib/omega-outbound-identity.js';
import {
  registerOmegaOutboundHost, connectOmegaDevice, refreshOmegaOutboundSession, stopOmegaOutboundSession,
  getOmegaOutboundAdminSystemInfo, listOmegaOutboundAdminProcesses, getOmegaOutboundAdminServiceStatus,
  getOmegaOutboundAdminNetworkStatus, getOmegaOutboundAdminDiskStatus, requestOmegaOutboundAdminLock,
  requestOmegaOutboundAdminLogoff, requestOmegaOutboundAdminRestart, requestOmegaOutboundAdminShutdown,
  getOmegaOutboundAdminOperation, cancelOmegaOutboundAdminOperation, verifyOmegaOutboundAdminPayload,
} from './src/lib/omega-outbound-client.js';
import { getOutboundTrust, getSession } from './src/lib/omega-outbound-store.js';
import { requestFields, responseFields, randomNonce, verifyMessage } from './src/lib/omega-outbound-protocol.js';
import { tlsJsonRequest } from './src/lib/omega-outbound-network.js';

// Two-process OMEGA V2 ADMIN harness: process A is this real outbound
// controller, process B is the host fixture over real HTTPS with SAN and pin.
// The host ADMIN executor is a recorder and approval is driven over IPC, so no
// real Windows action (read probe, LOCK, LOGOFF, RESTART, SHUTDOWN) can run.
function waitMessage(child, type, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`child_${type}_timeout`)); }, timeout);
    const onMessage = message => { if (message?.type === type) { cleanup(); resolve(message); } };
    const onExit = code => { cleanup(); reject(new Error(`child_exited_${code}`)); };
    function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); }
    child.on('message', onMessage); child.on('exit', onExit);
  });
}
function sendAndWait(child, message, type) { const waiting = waitMessage(child, type); child.send(message); return waiting; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const HIGH = { LOCK: [requestOmegaOutboundAdminLock, 'requestLock'], LOGOFF: [requestOmegaOutboundAdminLogoff, 'requestLogoff'],
  RESTART: [requestOmegaOutboundAdminRestart, 'requestRestart'], SHUTDOWN: [requestOmegaOutboundAdminShutdown, 'requestShutdown'] };

test('two-process TLS ADMIN harness: auth, read-only, approval, replay, STOP, revocation, network drop', { timeout: 120_000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-omega-v2-admin-'));
  const combined = await getCertificate(path.join(scratch, 'vite-cert-cache'));
  const keyPem = combined.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/)[0];
  const certificatePem = combined.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0];
  const keyPath = path.join(scratch, 'server-key.pem');
  const certPath = path.join(scratch, 'server-cert.pem');
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, certificatePem, { mode: 0o600 });
  initSqlite(path.join(scratch, 'controller.sqlite'));
  const controller = ensureOmegaV2Identity('CONTROLLER');
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const child = fork(path.join(testDir, 'fixtures', 'omega-outbound-server-child.mjs'), [], {
    cwd: testDir, silent: true,
    env: { ...process.env, OMEGA_HARNESS_DB: path.join(scratch, 'host.sqlite'), OMEGA_HARNESS_CERT: certPath,
      OMEGA_HARNESS_KEY: keyPath, OMEGA_HARNESS_CONTROLLER_ID: controller.deviceId,
      OMEGA_HARNESS_CONTROLLER_KEY: Buffer.from(controller.publicKeyPem).toString('base64'),
      OMEGA_HARNESS_CONTROLLER_FP: controller.fingerprint, OMEGA_HARNESS_VIEW: '1', OMEGA_HARNESS_REAL_VIEW: '0',
      OMEGA_HARNESS_ADMIN_FAST: '1' },
  });
  child.stderr?.pipe(process.stderr);
  let closed = false;
  t.after(async () => {
    if (!closed && child.connected) {
      try { const exited = once(child, 'exit'); await sendAndWait(child, { type: 'shutdown' }, 'closed'); await exited; }
      catch { child.kill(); }
    }
    if (getDatabase()?.open) getDatabase().close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const ready = await waitMessage(child, 'ready');
  const x509 = new crypto.X509Certificate(certificatePem);
  registerOmegaOutboundHost({ remoteDeviceId: ready.host.deviceId, host: '127.0.0.1', port: ready.port, certificatePem,
    certificateFingerprint: x509.fingerprint256, publicKeyPem: ready.host.publicKeyPem, identityFingerprint: ready.host.fingerprint,
    maxPermission: 'ADMIN' });
  const options = { allowLoopback: true, timeoutMs: 5_000 };
  const calls = async () => (await sendAndWait(child, { type: 'admin-calls' }, 'admin-calls-result')).calls;
  const decide = (operationId, decision, override) => sendAndWait(child, { type: 'admin-decide', operationId, decision, override }, 'admin-decided');
  const pending = async operationId => (await sendAndWait(child, { type: 'admin-pending' }, 'admin-pending-result')).pending.find(item => item.operationId === operationId);
  const until = async (sessionId, operationId, predicate, ms = 8_000) => {
    const deadline = Date.now() + ms;
    let value = await getOmegaOutboundAdminOperation(sessionId, operationId, options);
    while (!predicate(value) && Date.now() < deadline) { await wait(250); value = await getOmegaOutboundAdminOperation(sessionId, operationId, options); }
    return value;
  };
  let admin;

  await t.test('ADMIN auth: mutual TLS, pinned host, exact ADMIN permission', async () => {
    admin = await connectOmegaDevice(ready.host.deviceId, 'ADMIN', options);
    assert.equal(admin.permission, 'ADMIN');
    assert.equal(admin.remoteOmegaDeviceId, ready.host.deviceId);
    assert.equal((await refreshOmegaOutboundSession(admin.sessionId, options)).status, 'CONNECTED');
  });

  await t.test('VIEW and INTERACTIVE sessions are refused ADMIN by the controller and by the host', async () => {
    for (const permission of ['VIEW', 'INTERACTIVE']) {
      const session = await connectOmegaDevice(ready.host.deviceId, permission, options);
      await assert.rejects(getOmegaOutboundAdminSystemInfo(session.sessionId, options), /PERMISSION_DENIED/);
      await assert.rejects(requestOmegaOutboundAdminLock(session.sessionId, options), /PERMISSION_DENIED/);
      const row = getSession(session.sessionId);
      const peer = getOutboundTrust(ready.host.deviceId);
      const requestPath = `/api/omega-v2/sessions/${session.sessionId}/admin/request`;
      const payload = { operationId: crypto.randomUUID(), actionType: 'GET_SYSTEM_INFO' };
      const fields = requestFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id, sessionId: row.id,
        requestId: crypto.randomUUID(), timestamp: new Date().toISOString(), nonce: randomNonce(), method: 'POST', path: requestPath,
        bodyBytes: Buffer.from(JSON.stringify(payload)) });
      const direct = await tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
        expectedFingerprint: peer.certificate_fingerprint, requestPath,
        body: { payload, auth: { ...fields, signature: signWithOmegaV2Identity('CONTROLLER', controller.deviceId, 'OMEGA-V2/CONTROLLER/REQUEST', fields) } } });
      assert.equal(direct.status, 403);
      assert.equal(direct.body.payload.error, 'PERMISSION_DENIED');
      assert.equal((await refreshOmegaOutboundSession(session.sessionId, options)).permission, permission, 'no silent upgrade');
      await stopOmegaOutboundSession(session.sessionId, options);
    }
    assert.deepEqual(await calls(), []);
  });

  await t.test('read-only actions over real TLS return bounded safe schemas', async () => {
    const system = await getOmegaOutboundAdminSystemInfo(admin.sessionId, options);
    assert.equal(system.status, 'EXECUTED');
    assert.deepEqual(system.result.system, { computerName: 'HARNESS-B', osCaption: 'Harness OS', osVersion: '10.0', architecture: '64-bit', lastBootUpTime: 'boot' });
    const processes = await listOmegaOutboundAdminProcesses(admin.sessionId, options);
    assert.equal(processes.result.processes.length, 200);
    assert.equal(processes.result.truncated, true);
    assert.deepEqual(processes.result.processes.slice(0, 3).map(row => row.pid), [1, 2, 3]);
    assert.deepEqual(Object.keys(processes.result.processes[0]), ['pid', 'name', 'memoryBytes', 'cpuSeconds']);
    const services = await getOmegaOutboundAdminServiceStatus(admin.sessionId, options);
    assert.equal(services.result.services.length, 200);
    assert.ok(services.result.services.every(row => row.displayName.length === 256));
    assert.ok(JSON.stringify(services).length > 64 * 1024, 'bounded response larger than the Phase 2 64 KiB envelope');
    const network = await getOmegaOutboundAdminNetworkStatus(admin.sessionId, options);
    assert.deepEqual(network.result.interfaces, [{ description: 'Harness NIC', dhcpEnabled: false, addresses: ['192.168.50.2'], gateways: ['192.168.50.1'], dnsServers: [] }]);
    const disks = await getOmegaOutboundAdminDiskStatus(admin.sessionId, options);
    assert.deepEqual(disks.result, { disks: [{ drive: 'C:', filesystem: 'NTFS', totalBytes: 1000, freeBytes: 400 }], count: 1, truncated: false });
    const all = JSON.stringify([system, processes, services, network, disks]);
    for (const secret of ['HARNESS-SECRET', 'AA:BB:CC']) assert.equal(all.includes(secret), false, secret);
    assert.deepEqual(await calls(), ['getSystemInfo', 'listProcesses', 'getServiceStatus', 'getNetworkStatus', 'getDiskStatus']);
  });

  await t.test('high-impact approval workflow with the mock executor: LOCK, LOGOFF, RESTART, SHUTDOWN', async () => {
    for (const [actionType, [request, method]] of Object.entries(HIGH)) {
      const before = (await calls()).length;
      const operation = await request(admin.sessionId, options);
      assert.equal(operation.status, 'PENDING_APPROVAL', actionType);
      assert.equal(operation.actionType, actionType);
      assert.equal((await pending(operation.operationId)).controllerDeviceId, controller.deviceId);
      await wait(200);
      assert.equal((await calls()).length, before, `${actionType}: nothing before approval`);
      const wrong = await decide(operation.operationId, 'ALLOW', { controllerDeviceId: `ov2c-${crypto.randomUUID()}` });
      assert.equal(wrong.calls.length, before, `${actionType}: approval from wrong device rejected`);
      assert.equal((await getOmegaOutboundAdminOperation(admin.sessionId, operation.operationId, options)).status, 'PENDING_APPROVAL');
      await decide(operation.operationId, 'ALLOW');
      const done = await until(admin.sessionId, operation.operationId, value => value.status === 'EXECUTED');
      assert.equal(done.status, 'EXECUTED', actionType);
      assert.deepEqual(done.result, { accepted: true });
      assert.deepEqual((await calls()).slice(before), [method]);
    }
  });

  await t.test('deny, cancel, approval timeout and unavailable approval never execute', async () => {
    const second = await connectOmegaDevice(ready.host.deviceId, 'ADMIN', options);
    const before = (await calls()).length;
    const denied = await requestOmegaOutboundAdminLogoff(second.sessionId, options);
    await decide(denied.operationId, 'DENY');
    const deniedState = await until(second.sessionId, denied.operationId, value => value.status === 'DENIED');
    assert.equal(deniedState.status, 'DENIED'); assert.equal(deniedState.error, 'LOCAL_DENY');
    const cancel = await requestOmegaOutboundAdminRestart(second.sessionId, options);
    const cancelled = await cancelOmegaOutboundAdminOperation(second.sessionId, cancel.operationId, options);
    assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.error, 'CONTROLLER_CANCEL');
    assert.equal((await pending(cancel.operationId)).cancelled, true, 'host prompt closed');
    await decide(cancel.operationId, 'ALLOW');
    const timed = await requestOmegaOutboundAdminShutdown(second.sessionId, options);
    const expired = await until(second.sessionId, timed.operationId, value => value.status === 'EXPIRED', 8_000);
    assert.equal(expired.status, 'EXPIRED'); assert.equal(expired.error, 'APPROVAL_TIMEOUT');
    await decide(timed.operationId, 'ALLOW');
    await sendAndWait(child, { type: 'admin-approval-mode', mode: 'unavailable' }, 'admin-approval-mode-set');
    const unavailable = await requestOmegaOutboundAdminLock(second.sessionId, options);
    assert.equal(unavailable.status, 'DENIED'); assert.equal(unavailable.error, 'APPROVAL_UNAVAILABLE');
    await sendAndWait(child, { type: 'admin-approval-mode', mode: 'manual' }, 'admin-approval-mode-set');
    assert.equal((await calls()).length, before, 'deny/cancel/timeout/unavailable executed nothing');
    await stopOmegaOutboundSession(second.sessionId, options);
  });

  await t.test('replay, duplicate operation, stale timestamp, wrong device/session and result binding', async () => {
    const row = getSession(admin.sessionId);
    const peer = getOutboundTrust(ready.host.deviceId);
    const requestPath = `/api/omega-v2/sessions/${admin.sessionId}/admin/request`;
    const send = (payload, overrides = {}, pathOverride = requestPath) => {
      const fields = requestFields({ localDeviceId: overrides.localDeviceId ?? row.local_device_id, remoteDeviceId: row.remote_device_id,
        sessionId: row.id, requestId: crypto.randomUUID(), timestamp: overrides.timestamp ?? new Date().toISOString(),
        nonce: overrides.nonce ?? randomNonce(), method: 'POST', path: requestPath, bodyBytes: Buffer.from(JSON.stringify(payload)) });
      const body = overrides.body ?? { payload, auth: { ...fields,
        signature: signWithOmegaV2Identity('CONTROLLER', controller.deviceId, 'OMEGA-V2/CONTROLLER/REQUEST', fields) } };
      return tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
        expectedFingerprint: peer.certificate_fingerprint, requestPath: pathOverride, body }).then(result => ({ ...result, sent: body }));
    };
    const before = (await calls()).length;
    const payload = { operationId: crypto.randomUUID(), actionType: 'DISK_STATUS' };
    const first = await send(payload);
    assert.equal(first.status, 200);
    assert.equal(first.body.payload.status, 'EXECUTED');
    const replay = await send(null, { body: first.sent });
    assert.equal(replay.status, 409); assert.equal(replay.body.payload.error, 'REPLAY_REJECTED');
    const duplicate = await send(payload);
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.payload.error, 'OPERATION_DUPLICATE');
    assert.equal((await send({ operationId: crypto.randomUUID(), actionType: 'DISK_STATUS' }, { timestamp: new Date(Date.now() - 120_000).toISOString() })).status, 401);
    assert.equal((await send({ operationId: crypto.randomUUID(), actionType: 'DISK_STATUS' }, { localDeviceId: `ov2c-${crypto.randomUUID()}` })).status, 401);
    assert.equal((await send({ operationId: crypto.randomUUID(), actionType: 'DISK_STATUS' }, {}, `/api/omega-v2/sessions/${crypto.randomUUID()}/admin/request`)).status, 404);
    assert.equal((await calls()).length, before + 1, 'only the first genuine request executed');
    // Result binding on the controller: the same host-signed result cannot be accepted for another operation, action or device.
    const signedPayload = first.body.payload;
    assert.equal(verifyOmegaOutboundAdminPayload({ row, operationId: payload.operationId, actionType: 'DISK_STATUS', payload: signedPayload }).status, 'EXECUTED');
    assert.throws(() => verifyOmegaOutboundAdminPayload({ row, operationId: crypto.randomUUID(), actionType: 'DISK_STATUS', payload: signedPayload }), /ADMIN_RESULT_MISMATCH/);
    assert.throws(() => verifyOmegaOutboundAdminPayload({ row, operationId: payload.operationId, actionType: 'PROCESS_LIST', payload: signedPayload }), /ADMIN_RESULT_MISMATCH/);
    assert.throws(() => verifyOmegaOutboundAdminPayload({ row: { ...row, remote_device_id: `ov2h-${crypto.randomUUID()}` }, operationId: payload.operationId, actionType: 'DISK_STATUS', payload: signedPayload }), /ADMIN_RESULT_MISMATCH/);
    assert.throws(() => verifyOmegaOutboundAdminPayload({ row: { ...row, id: crypto.randomUUID() }, operationId: payload.operationId, actionType: 'DISK_STATUS', payload: signedPayload }), /ADMIN_RESULT_MISMATCH/);
    assert.throws(() => verifyOmegaOutboundAdminPayload({ row, operationId: payload.operationId, actionType: 'DISK_STATUS', payload: { ...signedPayload, result: { ...signedPayload.result, extra: 'x' } } }), /ADMIN_RESULT_INVALID/);
    const responseAuth = first.body.auth;
    const expected = { localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id, sessionId: row.id,
      requestId: first.sent.auth.requestId, timestamp: responseAuth.timestamp, statusCode: 200, bodyBytes: Buffer.from(JSON.stringify(signedPayload)) };
    assert.equal(verifyMessage(peer.public_key_pem, responseAuth.signature, 'OMEGA-V2/HOST/RESPONSE', responseFields(expected)), true);
    assert.equal(verifyMessage(peer.public_key_pem, responseAuth.signature, 'OMEGA-V2/HOST/RESPONSE',
      responseFields({ ...expected, remoteDeviceId: `ov2h-${crypto.randomUUID()}` })), false, 'wrong-device result signature rejected');
    assert.equal(verifyMessage(peer.public_key_pem, responseAuth.signature, 'OMEGA-V2/HOST/RESPONSE',
      responseFields({ ...expected, bodyBytes: Buffer.from(JSON.stringify({ ...signedPayload, operationId: crypto.randomUUID() })) })), false, 'wrong-operation result rejected');
  });

  await t.test('STOP SESSION cancels the pending high-impact action and blocks later ADMIN', async () => {
    const session = await connectOmegaDevice(ready.host.deviceId, 'ADMIN', options);
    const before = (await calls()).length;
    const operation = await requestOmegaOutboundAdminLock(session.sessionId, options);
    assert.equal(await stopOmegaOutboundSession(session.sessionId, options), true);
    assert.equal((await pending(operation.operationId)).cancelled, true);
    await decide(operation.operationId, 'ALLOW');
    assert.equal((await calls()).length, before);
    await assert.rejects(getOmegaOutboundAdminSystemInfo(session.sessionId, options), /SESSION_EXPIRED/);
  });

  await t.test('remote STOP on the host fails the pending action closed and blocks later ADMIN', async () => {
    const session = await connectOmegaDevice(ready.host.deviceId, 'ADMIN', options);
    const before = (await calls()).length;
    const operation = await requestOmegaOutboundAdminShutdown(session.sessionId, options);
    assert.equal((await sendAndWait(child, { type: 'remote-stop', sessionId: session.sessionId }, 'remote-stopped')).changed, true);
    await decide(operation.operationId, 'ALLOW');
    assert.equal((await calls()).length, before, 'approval after remote STOP never executes');
    await assert.rejects(getOmegaOutboundAdminDiskStatus(session.sessionId, options), /REMOTE_STOPPED|SESSION_EXPIRED/);
    assert.ok(getSession(session.sessionId).ended_at, 'controller session ended');
  });

  await t.test('revocation terminates pending ADMIN; no auto-reconnect', async () => {
    const session = await connectOmegaDevice(ready.host.deviceId, 'ADMIN', options);
    const before = (await calls()).length;
    const operation = await requestOmegaOutboundAdminRestart(session.sessionId, options);
    assert.equal((await sendAndWait(child, { type: 'revoke-controller' }, 'revoked')).changed, true);
    await decide(operation.operationId, 'ALLOW');
    assert.equal((await calls()).length, before);
    await assert.rejects(getOmegaOutboundAdminSystemInfo(session.sessionId, options), /DEVICE_REVOKED|SESSION_EXPIRED/);
    await assert.rejects(connectOmegaDevice(ready.host.deviceId, 'ADMIN', options), /DEVICE_REVOKED|DEVICE_UNTRUSTED/);
    await sendAndWait(child, { type: 'restore-controller' }, 'restored');
  });

  await t.test('network drop ends the session; the pending action is never reported executed', async () => {
    const session = await connectOmegaDevice(ready.host.deviceId, 'ADMIN', options);
    const operation = await requestOmegaOutboundAdminLogoff(session.sessionId, options);
    const executedBeforeDrop = await calls();
    assert.deepEqual(executedBeforeDrop.filter(name => name.startsWith('request')), ['requestLock', 'requestLogoff', 'requestRestart', 'requestShutdown'],
      'across the whole run, exactly the four approved high-impact mocks executed');
    const exited = once(child, 'exit');
    await sendAndWait(child, { type: 'drop' }, 'closed');
    await exited;
    closed = true;
    await assert.rejects(getOmegaOutboundAdminOperation(session.sessionId, operation.operationId, options), /NETWORK_UNAVAILABLE/);
    assert.equal(getSession(session.sessionId).reason, 'network_drop');
    await assert.rejects(getOmegaOutboundAdminSystemInfo(session.sessionId, options), /SESSION_EXPIRED/);
    const audit = JSON.stringify(getDatabase().prepare('SELECT * FROM omega_v2_audit').all());
    for (const secret of ['HARNESS-SECRET', 'HARNESS-B', 'proc-', 'Harness NIC', 'SSSSSSSS']) assert.equal(audit.includes(secret), false, secret);
  });
});
