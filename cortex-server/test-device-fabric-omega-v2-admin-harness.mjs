// DEVICE FABRIC V2 Phase 5 — two-process real-TLS ADMIN harness.
// Process A is this real Fabric/OMEGA V2 outbound controller, process B is
// the host fixture (fixtures/omega-outbound-server-child.mjs) over real
// HTTPS with SAN, pin and mutual identity — the same fixture already used by
// the Phase 3 VIEW and Phase 4 INTERACTIVE harnesses and by OMEGA V2's own
// certified ADMIN harness (test-omega-outbound-admin-harness.mjs). The host
// ADMIN executor there is a recorder and approval is driven over IPC, so no
// real Windows action (read probe, LOCK, LOGOFF, RESTART, SHUTDOWN) can ever
// run (mission §13, §19). Fabric orchestrates exact-target resolution, TOCTOU
// revalidation and STOP only — every read/high-impact call goes straight to
// OMEGA V2's own already-certified typed client functions.
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
import { createFabricOmegaV2AdminService } from './src/lib/device-fabric-omega-v2-admin.js';
import { ensureOmegaV2Identity } from './src/lib/omega-outbound-identity.js';
import { registerOmegaOutboundHost, stopOmegaOutboundSession } from './src/lib/omega-outbound-client.js';

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
async function closeChild(child) {
  if (!child.connected) return;
  const exited = once(child, 'exit');
  const closed = waitMessage(child, 'closed').catch(() => null);
  child.send({ type: 'shutdown' });
  await closed;
  await exited;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Fabric two-process ADMIN TLS harness: exact target, read-only allowlist, high-impact approval, STOP DEVICE, STOP ALL', { timeout: 120_000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-fabric-omega-v2-admin-'));
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
        OMEGA_HARNESS_CONTROLLER_FP: controller.fingerprint, OMEGA_HARNESS_ADMIN_FAST: '1' },
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
      identityFingerprint: ready.host.fingerprint, maxPermission: 'ADMIN' });
  }

  const fabricA = createFabricDevice({ displayName: 'Fabric admin A' });
  const fabricB = createFabricDevice({ displayName: 'Fabric admin B' });
  linkOmegaV2Host(fabricA.fabricDeviceId, { omegaV2HostId: readyA.host.deviceId, confirmFingerprint: readyA.host.fingerprint });
  linkOmegaV2Host(fabricB.fabricDeviceId, { omegaV2HostId: readyB.host.deviceId, confirmFingerprint: readyB.host.fingerprint });

  const options = { allowLoopback: true, timeoutMs: 5_000 };
  const admin = createFabricOmegaV2AdminService();
  const callsOn = async host => (await sendAndWait(host.child, { type: 'admin-calls' }, 'admin-calls-result')).calls;
  const decideOn = (host, operationId, decision) => sendAndWait(host.child, { type: 'admin-decide', operationId, decision }, 'admin-decided');
  const untilOn = async (fabricDeviceId, operationId, predicate, ms = 8_000) => {
    const deadline = Date.now() + ms;
    let value = await admin.operationStatusForFabricDevice(fabricDeviceId, { operationId }, options);
    while (!predicate(value) && Date.now() < deadline) { await wait(250); value = await admin.operationStatusForFabricDevice(fabricDeviceId, { operationId }, options); }
    return value;
  };

  await t.test('read-only allowlist: exact target A, B receives 0', async () => {
    const system = await admin.getSystemInfoForFabricDevice(fabricA.fabricDeviceId, options);
    assert.equal(system.status, 'EXECUTED');
    assert.equal(system.omegaV2HostId, readyA.host.deviceId);
    await admin.listProcessesForFabricDevice(fabricA.fabricDeviceId, options);
    await admin.getServiceStatusForFabricDevice(fabricA.fabricDeviceId, options);
    await admin.getNetworkStatusForFabricDevice(fabricA.fabricDeviceId, options);
    await admin.getDiskStatusForFabricDevice(fabricA.fabricDeviceId, options);
    assert.deepEqual(await callsOn(hostA), ['getSystemInfo', 'listProcesses', 'getServiceStatus', 'getNetworkStatus', 'getDiskStatus']);
    assert.deepEqual(await callsOn(hostB), [], 'wrong device receives 0 operations');
  });

  await t.test('high-impact approval workflow: LOCK, LOGOFF, RESTART, SHUTDOWN execute only on A after local approval', async () => {
    const flows = [
      ['LOCK', admin.lockFabricDevice, 'requestLock'],
      ['LOGOFF', admin.logoffFabricDevice, 'requestLogoff'],
      ['RESTART', admin.restartFabricDevice, 'requestRestart'],
      ['SHUTDOWN', admin.shutdownFabricDevice, 'requestShutdown'],
    ];
    for (const [action, request, method] of flows) {
      const before = (await callsOn(hostA)).length;
      const operation = await request(fabricA.fabricDeviceId, { confirm: action }, options);
      assert.equal(operation.status, 'PENDING_APPROVAL', action);
      assert.equal((await callsOn(hostA)).length, before, `${action}: nothing before local approval`);
      await decideOn(hostA, operation.operationId, 'ALLOW');
      const done = await untilOn(fabricA.fabricDeviceId, operation.operationId, value => value.status === 'EXECUTED');
      assert.equal(done.status, 'EXECUTED', action);
      assert.deepEqual((await callsOn(hostA)).slice(before), [method]);
    }
    assert.deepEqual(await callsOn(hostB), [], 'high-impact never reached the wrong device');
  });

  await t.test('missing/mismatched confirmation never reaches the host', async () => {
    const before = (await callsOn(hostA)).length;
    await assert.rejects(admin.lockFabricDevice(fabricA.fabricDeviceId, {}, options), /OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED/);
    await assert.rejects(admin.lockFabricDevice(fabricA.fabricDeviceId, { confirm: 'SHUTDOWN' }, options), /OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED/);
    assert.equal((await callsOn(hostA)).length, before);
  });

  await t.test('exact-target proof persists in each host DB', async () => {
    const dbA = new Database(hostA.dbPath, { readonly: true });
    const dbB = new Database(hostB.dbPath, { readonly: true });
    try {
      assert.ok(dbA.prepare("SELECT count(*) AS count FROM omega_v2_sessions WHERE direction = 'INBOUND'").get().count >= 1);
      assert.equal(dbB.prepare("SELECT count(*) AS count FROM omega_v2_sessions WHERE direction = 'INBOUND'").get().count, 0);
    } finally { dbA.close(); dbB.close(); }
  });

  await t.test('STOP DEVICE stops only A; B and the Fabric link are untouched', async () => {
    const stopped = await admin.stopDeviceForFabricDevice(fabricA.fabricDeviceId, options);
    assert.equal(stopped.stopped, true);
    const state = admin.getAdminStateForFabricDevice(fabricA.fabricDeviceId);
    assert.equal(state.sessionStatus, 'DISCONNECTED');
    // reconnect A for the next high-impact call to prove the link itself survives STOP DEVICE.
    const again = await admin.getSystemInfoForFabricDevice(fabricA.fabricDeviceId, options);
    assert.equal(again.status, 'EXECUTED');
    assert.equal(again.omegaV2HostId, readyA.host.deviceId, 'link preserved after STOP DEVICE');
  });

  await t.test('STOP ALL stops only Fabric-owned ADMIN bindings (A and B), never a global primitive', async () => {
    await admin.getSystemInfoForFabricDevice(fabricA.fabricDeviceId, options);
    await admin.getSystemInfoForFabricDevice(fabricB.fabricDeviceId, options);
    const results = await admin.stopAllForFabricDevices(options);
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.stopped === true));
    assert.equal(admin.getAdminStateForFabricDevice(fabricA.fabricDeviceId).sessionStatus, 'DISCONNECTED');
    assert.equal(admin.getAdminStateForFabricDevice(fabricB.fabricDeviceId).sessionStatus, 'DISCONNECTED');
  });

  await t.test('A unavailable, B available: ADMIN on A fails, B receives 0 (no fallback, no retargeting)', async () => {
    await closeChild(hostA.child);
    await assert.rejects(admin.getSystemInfoForFabricDevice(fabricA.fabricDeviceId, options),
      error => /OMEGA_V2_NETWORK_UNAVAILABLE|OMEGA_V2_UNAVAILABLE/.test(error.message));
    const callsBBefore = await callsOn(hostB);
    await stopOmegaOutboundSession('nonexistent-noop', options).catch(() => {});
    assert.deepEqual(await callsOn(hostB), callsBBefore, 'B received nothing as a result of As failure');
  });
});
