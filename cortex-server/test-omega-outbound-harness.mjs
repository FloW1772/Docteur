import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { getCertificate } from '@vitejs/plugin-basic-ssl';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { ensureOmegaV2Identity, signWithOmegaV2Identity } from './src/lib/omega-outbound-identity.js';
import { registerOmegaOutboundHost, connectOmegaDevice, refreshOmegaOutboundSession,
  startOmegaOutboundView, getOmegaOutboundViewStatus, fetchOmegaOutboundViewFrame,
  stopOmegaOutboundView, startOmegaOutboundInteractive, getOmegaOutboundInteractiveStatus,
  sendOmegaOutboundInput, stopOmegaOutboundInteractive,
  stopOmegaOutboundSession, stopAllOmegaOutboundSessions } from './src/lib/omega-outbound-client.js';
import { getOutboundTrust, getSession } from './src/lib/omega-outbound-store.js';
import { requestFields, randomNonce } from './src/lib/omega-outbound-protocol.js';
import { tlsJsonRequest } from './src/lib/omega-outbound-network.js';

function waitMessage(child, type, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`child_${type}_timeout`)); }, timeout);
    const onMessage = message => { if (message?.type === type) { cleanup(); resolve(message); } };
    const onExit = code => { cleanup(); reject(new Error(`child_exited_${code}`)); };
    function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); }
    child.on('message', onMessage); child.on('exit', onExit);
  });
}

function sendAndWait(child, message, type) {
  const waiting = waitMessage(child, type);
  child.send(message);
  return waiting;
}

test('two-process TLS harness authenticates, binds, rejects and stops safely', { timeout: 90_000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-omega-v2-'));
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
    env: { ...process.env, OMEGA_HARNESS_DB: path.join(scratch, 'host.sqlite'),
      OMEGA_HARNESS_CERT: certPath, OMEGA_HARNESS_KEY: keyPath,
      OMEGA_HARNESS_CONTROLLER_ID: controller.deviceId,
      OMEGA_HARNESS_CONTROLLER_KEY: Buffer.from(controller.publicKeyPem).toString('base64'),
      OMEGA_HARNESS_CONTROLLER_FP: controller.fingerprint,
      OMEGA_HARNESS_REAL_VIEW: process.env.OMEGA_REAL_CAPTURE === '1' ? '1' : '0',
      OMEGA_HARNESS_VIEW: '1' },
  });
  child.stderr?.pipe(process.stderr);
  let closed = false;
  t.after(async () => {
    if (!closed && child.connected) {
      try {
        const exited = once(child, 'exit');
        await sendAndWait(child, { type: 'shutdown' }, 'closed');
        await exited;
      } catch { child.kill(); }
    }
    if (getDatabase()?.open) getDatabase().close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const ready = await waitMessage(child, 'ready');
  assert.notEqual(controller.deviceId, ready.host.deviceId);
  assert.match(controller.deviceId, /^ov2c-/);
  assert.match(ready.host.deviceId, /^ov2h-/);
  const x509 = new crypto.X509Certificate(certificatePem);
  assert.match(x509.subjectAltName, /DNS:localhost/);
  assert.match(x509.subjectAltName, /IP Address:127\.0\.0\.1/);
  assert.equal(x509.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(x509.checkIP('192.168.250.250'), undefined);

  registerOmegaOutboundHost({ remoteDeviceId: ready.host.deviceId, host: '127.0.0.1', port: ready.port,
    certificatePem, certificateFingerprint: x509.fingerprint256,
    publicKeyPem: ready.host.publicKeyPem, identityFingerprint: ready.host.fingerprint, maxPermission: 'ADMIN' });
  assert.throws(() => registerOmegaOutboundHost({ remoteDeviceId: ready.host.deviceId, host: '127.0.0.1', port: ready.port,
    certificatePem, certificateFingerprint: x509.fingerprint256, publicKeyPem: ready.host.publicKeyPem,
    identityFingerprint: ready.host.fingerprint, maxPermission: 'ADMIN' }), /outbound_trust_already_exists/);

  const options = { allowLoopback: true, timeoutMs: 5_000 };
  const view = await connectOmegaDevice(ready.host.deviceId, 'VIEW', options).catch(error => {
    throw new Error(`connect_failed:${error.code}:${error.statusCode ?? ''}`, { cause: error });
  });
  assert.equal(view.status, 'CONNECTED');
  assert.equal(view.permission, 'VIEW');
  assert.equal(view.remoteOmegaDeviceId, ready.host.deviceId);
  assert.ok(Date.parse(view.expiresAt) - Date.parse(view.createdAt) <= 15 * 60_000);
  t.diagnostic('connected VIEW; refreshing signed session status');
  assert.equal((await refreshOmegaOutboundSession(view.sessionId, options)).status, 'CONNECTED');

  const startedView = await startOmegaOutboundView(view.sessionId, 0, options);
  assert.equal(startedView.status, 'VIEW_STARTING');
  await assert.rejects(startOmegaOutboundView(view.sessionId, 0, options), /VIEW_ALREADY_STARTED/);
  const frame = await fetchOmegaOutboundViewFrame(view.sessionId, options);
  assert.equal(frame.mimeType, 'image/png');
  if (process.env.OMEGA_REAL_CAPTURE === '1') {
    assert.ok(frame.width >= 1 && frame.height >= 1);
    assert.ok(frame.buffer.length > 24);
    t.diagnostic(`real Windows frame ${frame.width}x${frame.height}, ${frame.buffer.length} bytes`);
  } else {
    assert.equal(frame.width, 1);
    assert.equal(frame.height, 1);
  }
  assert.equal(frame.streamId, startedView.streamId);
  assert.equal((await getOmegaOutboundViewStatus(view.sessionId, options)).status, 'VIEWING');
  const remoteViewStop = await sendAndWait(child, { type: 'remote-view-stop', sessionId: view.sessionId }, 'remote-view-stopped');
  assert.equal(remoteViewStop.result.status, 'STOPPED');
  await assert.rejects(fetchOmegaOutboundViewFrame(view.sessionId, options), /REMOTE_STOPPED/);
  assert.equal((await refreshOmegaOutboundSession(view.sessionId, options)).status, 'CONNECTED');
  await startOmegaOutboundView(view.sessionId, 0, options);
  assert.equal((await stopOmegaOutboundView(view.sessionId, options)).status, 'STOPPED');

  t.diagnostic('refresh passed; testing wrong pin and target');
  await assert.rejects(tlsJsonRequest({ host: '127.0.0.1', port: ready.port, certificatePem,
    expectedFingerprint: '00'.repeat(32), requestPath: '/api/omega-v2/challenge',
    body: { expectedRemoteDeviceId: ready.host.deviceId, localDeviceId: controller.deviceId, clientNonce: randomNonce() } }), /TLS_IDENTITY_MISMATCH|fingerprint/i);
  const otherCombined = await getCertificate(path.join(scratch, 'other-cert-cache'));
  const otherCertificate = otherCombined.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0];
  await assert.rejects(tlsJsonRequest({ host: '127.0.0.1', port: ready.port, certificatePem: otherCertificate,
    expectedFingerprint: x509.fingerprint256, requestPath: '/api/omega-v2/challenge',
    body: { expectedRemoteDeviceId: ready.host.deviceId, localDeviceId: controller.deviceId, clientNonce: randomNonce() } }), /certificate|self-signed|verify|issuer|unable/i);
  const wrongTarget = await tlsJsonRequest({ host: '127.0.0.1', port: ready.port, certificatePem,
    expectedFingerprint: x509.fingerprint256, requestPath: '/api/omega-v2/challenge',
    body: { expectedRemoteDeviceId: `ov2h-${crypto.randomUUID()}`, localDeviceId: `ov2c-${crypto.randomUUID()}`, clientNonce: randomNonce() } });
  assert.equal(wrongTarget.status, 409);
  assert.equal(wrongTarget.body.error, 'wrong_device');
  const untrusted = await tlsJsonRequest({ host: '127.0.0.1', port: ready.port, certificatePem,
    expectedFingerprint: x509.fingerprint256, requestPath: '/api/omega-v2/challenge',
    body: { expectedRemoteDeviceId: ready.host.deviceId, localDeviceId: `ov2c-${crypto.randomUUID()}`, clientNonce: randomNonce() } });
  assert.equal(untrusted.status, 403);

  const row = getSession(view.sessionId);
  const peer = getOutboundTrust(ready.host.deviceId);
  const payload = {};
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = randomNonce();
  const requestPath = `/api/omega-v2/sessions/${view.sessionId}/status`;
  const fields = requestFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId: row.id, requestId, timestamp, nonce, method: 'POST', path: requestPath,
    bodyBytes: Buffer.from(JSON.stringify(payload)) });
  const signature = signWithOmegaV2Identity('CONTROLLER', controller.deviceId, 'OMEGA-V2/CONTROLLER/REQUEST', fields);
  const envelope = { payload, auth: { ...fields, signature } };
  const first = await tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
    expectedFingerprint: peer.certificate_fingerprint, requestPath, body: envelope });
  assert.equal(first.status, 200);
  t.diagnostic('manual signed status passed; replaying');
  const replay = await tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
    expectedFingerprint: peer.certificate_fingerprint, requestPath, body: envelope });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.payload.error, 'REPLAY_REJECTED');
  const badNonceFields = requestFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId: row.id, requestId: crypto.randomUUID(), timestamp: new Date().toISOString(), nonce: 'bad',
    method: 'POST', path: requestPath, bodyBytes: Buffer.from('{}') });
  const badNonce = await tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
    expectedFingerprint: peer.certificate_fingerprint, requestPath,
    body: { payload: {}, auth: { ...badNonceFields,
      signature: signWithOmegaV2Identity('CONTROLLER', controller.deviceId, 'OMEGA-V2/CONTROLLER/REQUEST', badNonceFields) } } });
  assert.equal(badNonce.status, 401);
  const staleFields = requestFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId: row.id, requestId: crypto.randomUUID(), timestamp: new Date(Date.now() - 120_000).toISOString(), nonce: randomNonce(),
    method: 'POST', path: requestPath, bodyBytes: Buffer.from('{}') });
  const stale = await tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
    expectedFingerprint: peer.certificate_fingerprint, requestPath,
    body: { payload: {}, auth: { ...staleFields,
      signature: signWithOmegaV2Identity('CONTROLLER', controller.deviceId, 'OMEGA-V2/CONTROLLER/REQUEST', staleFields) } } });
  assert.equal(stale.status, 401);
  const wrongSession = await tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
    expectedFingerprint: peer.certificate_fingerprint, requestPath: `/api/omega-v2/sessions/${crypto.randomUUID()}/status`, body: envelope });
  assert.equal(wrongSession.status, 404);

  const interactive = await connectOmegaDevice(ready.host.deviceId, 'INTERACTIVE', options);
  const admin = await connectOmegaDevice(ready.host.deviceId, 'ADMIN', options);
  const stopAllCandidate = await connectOmegaDevice(ready.host.deviceId, 'VIEW', options);
  assert.deepEqual([view.permission, interactive.permission, admin.permission], ['VIEW', 'INTERACTIVE', 'ADMIN']);
  await assert.rejects(startOmegaOutboundInteractive(view.sessionId, options), /PERMISSION_DENIED/);
  await startOmegaOutboundView(interactive.sessionId, 0, options);
  await fetchOmegaOutboundViewFrame(interactive.sessionId, options);
  assert.equal((await startOmegaOutboundInteractive(interactive.sessionId, options)).status, 'INTERACTIVE');
  await sendOmegaOutboundInput(interactive.sessionId, 'pointer', { x: 0.5, y: 0.5 }, options);
  await sendOmegaOutboundInput(interactive.sessionId, 'button', { button: 'MIDDLE', state: 'DOWN', x: 0.5, y: 0.5 }, options);
  await sendOmegaOutboundInput(interactive.sessionId, 'key', { key: 'KeyA', state: 'DOWN' }, options);
  assert.equal((await getOmegaOutboundInteractiveStatus(interactive.sessionId, options)).status, 'INTERACTIVE');
  assert.equal((await stopOmegaOutboundInteractive(interactive.sessionId, options)).status, 'STOPPED');
  const inputEvidence = await sendAndWait(child, { type: 'input-events' }, 'input-events-result');
  assert.ok(inputEvidence.events.some(event => event.category === 'pointer'));
  assert.ok(inputEvidence.events.some(event => event.middle === true && event.state === 'DOWN'));
  assert.ok(inputEvidence.events.some(event => event.release && event.kind === 'button' && event.value === 'MIDDLE'));
  assert.ok(inputEvidence.events.some(event => event.release && event.kind === 'key' && event.value === 'KeyA'));
  await assert.rejects(tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
    expectedFingerprint: peer.certificate_fingerprint, requestPath: `/api/omega-v2/sessions/${admin.sessionId}/view`, body: {} }),
  error => error.code === 'INVALID_RESPONSE' && error.statusCode === 404);

  const remoteStopWait = sendAndWait(child, { type: 'remote-stop', sessionId: interactive.sessionId }, 'remote-stopped');
  assert.equal((await remoteStopWait).changed, true);
  await new Promise(resolve => setTimeout(resolve, 5_500));
  assert.equal(getSession(interactive.sessionId).reason, 'REMOTE_STOPPED');
  assert.equal((await sendAndWait(child, { type: 'expire-session', sessionId: admin.sessionId }, 'expired')).changed, true);
  await assert.rejects(refreshOmegaOutboundSession(admin.sessionId, options), /SESSION_EXPIRED/);
  assert.equal(await stopOmegaOutboundSession(view.sessionId, options), true);
  assert.ok(await stopAllOmegaOutboundSessions(options) >= 1);
  assert.equal(getSession(stopAllCandidate.sessionId).reason, 'client_stop');

  const beforeRevoke = await connectOmegaDevice(ready.host.deviceId, 'VIEW', options);
  const revokedWait = sendAndWait(child, { type: 'revoke-controller' }, 'revoked');
  assert.equal((await revokedWait).changed, true);
  await assert.rejects(refreshOmegaOutboundSession(beforeRevoke.sessionId, options), /DEVICE_REVOKED/);
  const revokedConnect = await tlsJsonRequest({ host: peer.host, port: peer.port, certificatePem: peer.certificate_pem,
    expectedFingerprint: peer.certificate_fingerprint, requestPath: '/api/omega-v2/challenge',
    body: { expectedRemoteDeviceId: ready.host.deviceId, localDeviceId: controller.deviceId, clientNonce: randomNonce() } });
  assert.equal(revokedConnect.status, 403);
  assert.equal(revokedConnect.body.error, 'DEVICE_REVOKED');

  const restored = await sendAndWait(child, { type: 'restore-controller' }, 'restored');
  assert.equal(restored.controllerDeviceId, controller.deviceId);
  const beforeDrop = await connectOmegaDevice(ready.host.deviceId, 'VIEW', options);
  await startOmegaOutboundView(beforeDrop.sessionId, 0, options);
  await fetchOmegaOutboundViewFrame(beforeDrop.sessionId, options);

  await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: ready.port, path: '/api/omega-v2/challenge', method: 'POST' });
    req.on('error', () => resolve()); req.end('{}');
  });
  const exited = once(child, 'exit');
  await sendAndWait(child, { type: 'drop' }, 'closed');
  await exited;
  closed = true;
  await assert.rejects(fetchOmegaOutboundViewFrame(beforeDrop.sessionId, options), /NETWORK_UNAVAILABLE/);
  assert.equal(getSession(beforeDrop.sessionId).reason, 'network_drop');
  assert.equal(child.exitCode === 0 || child.exitCode === null, true);
});
