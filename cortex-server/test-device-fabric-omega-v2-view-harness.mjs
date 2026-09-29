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
import Database from 'better-sqlite3';
import { getCertificate } from '@vitejs/plugin-basic-ssl';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createFabricDevice } from './src/lib/device-fabric.js';
import { linkOmegaV2Host } from './src/lib/device-fabric-omega-v2.js';
import { createFabricOmegaV2ViewService } from './src/lib/device-fabric-omega-v2-routing.js';
import { ensureOmegaV2Identity } from './src/lib/omega-outbound-identity.js';
import { registerOmegaOutboundHost, connectOmegaDevice, fetchOmegaOutboundViewFrame,
  getOmegaOutboundSession, startOmegaOutboundView, stopOmegaOutboundSession, stopOmegaOutboundView } from './src/lib/omega-outbound-client.js';

function waitMessage(child, type, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`child_${type}_timeout`)); }, timeout);
    const onMessage = message => { if (message?.type === type) { cleanup(); resolve(message); } };
    const onExit = code => { cleanup(); reject(new Error(`child_exited_${code}`)); };
    function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); }
    child.on('message', onMessage); child.on('exit', onExit);
  });
}

async function closeChild(child) {
  if (!child.connected) return;
  const exited = once(child, 'exit');
  const closed = waitMessage(child, 'closed').catch(() => null);
  child.send({ type: 'shutdown' });
  await closed;
  await exited;
}

test('Fabric two-target harness routes authenticated VIEW only to exact TLS host A and never host B', { timeout: 90_000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-fabric-omega-v2-view-'));
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

  function spawnHost(label) {
    const dbPath = path.join(scratch, `host-${label}.sqlite`);
    const child = fork(path.join(testDir, 'fixtures', 'omega-outbound-server-child.mjs'), [], {
      cwd: testDir, silent: true,
      env: { ...process.env, OMEGA_HARNESS_DB: dbPath, OMEGA_HARNESS_CERT: certPath, OMEGA_HARNESS_KEY: keyPath,
        OMEGA_HARNESS_CONTROLLER_ID: controller.deviceId,
        OMEGA_HARNESS_CONTROLLER_KEY: Buffer.from(controller.publicKeyPem).toString('base64'),
        OMEGA_HARNESS_CONTROLLER_FP: controller.fingerprint, OMEGA_HARNESS_VIEW: '1' },
    });
    child.stderr?.pipe(process.stderr);
    return { child, dbPath, label };
  }

  const hostA = spawnHost('a');
  const hostB = spawnHost('b');
  t.after(async () => {
    await Promise.allSettled([closeChild(hostA.child), closeChild(hostB.child)]);
    if (getDatabase()?.open) getDatabase().close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const [readyA, readyB] = await Promise.all([waitMessage(hostA.child, 'ready'), waitMessage(hostB.child, 'ready')]);
  assert.notEqual(readyA.host.deviceId, readyB.host.deviceId);
  const x509 = new crypto.X509Certificate(certificatePem);
  for (const ready of [readyA, readyB]) {
    registerOmegaOutboundHost({ remoteDeviceId: ready.host.deviceId, host: '127.0.0.1', port: ready.port,
      certificatePem, certificateFingerprint: x509.fingerprint256, publicKeyPem: ready.host.publicKeyPem,
      identityFingerprint: ready.host.fingerprint, maxPermission: 'VIEW' });
  }

  const fabricA = createFabricDevice({ displayName: 'Fabric exact A' });
  const fabricB = createFabricDevice({ displayName: 'Fabric exact B' });
  const linkA = linkOmegaV2Host(fabricA.fabricDeviceId,
    { omegaV2HostId: readyA.host.deviceId, confirmFingerprint: readyA.host.fingerprint });
  linkOmegaV2Host(fabricB.fabricDeviceId,
    { omegaV2HostId: readyB.host.deviceId, confirmFingerprint: readyB.host.fingerprint });

  const options = { allowLoopback: true, timeoutMs: 5_000 };
  const service = createFabricOmegaV2ViewService({
    connectView: (hostId, permission) => connectOmegaDevice(hostId, permission, options),
    startView: (sessionId, screenIndex) => startOmegaOutboundView(sessionId, screenIndex, options),
    getSession: getOmegaOutboundSession,
    stopView: sessionId => stopOmegaOutboundView(sessionId, options),
    stopSession: sessionId => stopOmegaOutboundSession(sessionId, options),
  });
  const startInput = { screenIndex: 0, linkId: linkA.linkId, linkVersion: linkA.linkVersion,
    omegaV2HostId: linkA.omegaV2HostId, fingerprint: linkA.linkedFingerprint };
  const started = await service.startViewForFabricDevice(fabricA.fabricDeviceId, startInput);
  assert.equal(started.omegaV2HostId, readyA.host.deviceId);
  assert.equal(started.viewStatus, 'VIEW_STARTING');
  const frame = await fetchOmegaOutboundViewFrame(started.sessionId, options);
  assert.equal(frame.mimeType, 'image/png');
  assert.equal(frame.width, 1);
  assert.equal(frame.height, 1);

  const dbA = new Database(hostA.dbPath, { readonly: true });
  const dbB = new Database(hostB.dbPath, { readonly: true });
  try {
    assert.equal(dbA.prepare("SELECT count(*) AS count FROM omega_v2_sessions WHERE direction = 'INBOUND'").get().count, 1);
    assert.equal(dbB.prepare("SELECT count(*) AS count FROM omega_v2_sessions WHERE direction = 'INBOUND'").get().count, 0);
  } finally { dbA.close(); dbB.close(); }

  assert.equal((await service.stopViewForFabricDevice(fabricA.fabricDeviceId)).viewStatus, 'STOPPED');
  assert.equal((await service.stopSessionForFabricDevice(fabricA.fabricDeviceId)).sessionStatus, 'DISCONNECTED');

  // A is now unavailable while B remains live. A second explicit attempt must
  // fail against A; B still receives zero session and zero VIEW request.
  await closeChild(hostA.child);
  await assert.rejects(service.startViewForFabricDevice(fabricA.fabricDeviceId, startInput),
    error => error.code === 'OMEGA_V2_NETWORK_UNAVAILABLE');
  const dbBAfter = new Database(hostB.dbPath, { readonly: true });
  try { assert.equal(dbBAfter.prepare("SELECT count(*) AS count FROM omega_v2_sessions WHERE direction = 'INBOUND'").get().count, 0); }
  finally { dbBAfter.close(); }
});
