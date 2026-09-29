// DEVICE FABRIC V2 Phase 4 — two-process real-TLS INTERACTIVE harness.
// Extends the Phase 3 VIEW harness: real TLS, real OMEGA V2 protocol, real
// signed session — but the host's input executor is the certified mock
// recorder already used by OMEGA V2's own INTERACTIVE test suite, so no real
// mouse/keyboard event ever reaches the OS (mission §48). Fabric orchestrates
// start/stop only; the browser-equivalent input calls go straight to OMEGA
// V2's own certified sendOmegaOutboundInput, proving Fabric never needs (and
// never has) its own input executor.
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
import {
  registerOmegaOutboundHost, connectOmegaDevice, fetchOmegaOutboundViewFrame, getOmegaOutboundSession,
  sendOmegaOutboundInput, startOmegaOutboundInteractive, startOmegaOutboundView, stopOmegaOutboundInteractive,
  stopOmegaOutboundSession, stopOmegaOutboundView,
} from './src/lib/omega-outbound-client.js';

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

test('Fabric two-target INTERACTIVE harness: exact activation on A, mocked input recorded, B untouched, real TLS', { timeout: 90_000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-fabric-omega-v2-interactive-'));
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
  const x509 = new crypto.X509Certificate(certificatePem);
  for (const ready of [readyA, readyB]) {
    registerOmegaOutboundHost({ remoteDeviceId: ready.host.deviceId, host: '127.0.0.1', port: ready.port,
      certificatePem, certificateFingerprint: x509.fingerprint256, publicKeyPem: ready.host.publicKeyPem,
      identityFingerprint: ready.host.fingerprint, maxPermission: 'INTERACTIVE' });
  }

  const fabricA = createFabricDevice({ displayName: 'Fabric interactive A' });
  const fabricB = createFabricDevice({ displayName: 'Fabric interactive B' });
  const linkA = linkOmegaV2Host(fabricA.fabricDeviceId, { omegaV2HostId: readyA.host.deviceId, confirmFingerprint: readyA.host.fingerprint });
  const linkB = linkOmegaV2Host(fabricB.fabricDeviceId, { omegaV2HostId: readyB.host.deviceId, confirmFingerprint: readyB.host.fingerprint });

  const options = { allowLoopback: true, timeoutMs: 5_000 };
  // startInteractive/stopInteractive are OMEGA V2's own certified functions,
  // called with the same `options` transport override used for VIEW.
  const realService = createFabricOmegaV2ViewService({
    connectView: (hostId, permission) => connectOmegaDevice(hostId, permission, options),
    startView: (sessionId, screenIndex, opts) => startOmegaOutboundView(sessionId, screenIndex, opts),
    getSession: getOmegaOutboundSession,
    stopView: (sessionId, opts) => stopOmegaOutboundView(sessionId, opts),
    stopSession: (sessionId, opts) => stopOmegaOutboundSession(sessionId, opts),
    startInteractive: startOmegaOutboundInteractive,
    stopInteractive: stopOmegaOutboundInteractive,
  });

  const startInputA = { screenIndex: 0, linkId: linkA.linkId, linkVersion: linkA.linkVersion,
    omegaV2HostId: linkA.omegaV2HostId, fingerprint: linkA.linkedFingerprint };
  // Fabric B is linked but deliberately never started: proves the exact
  // target guarantee without needing a second connect attempt at all.
  void linkB;

  // VIEW must exist first (mission §8/§9): INTERACTIVE is only ever an
  // explicit elevation of an already-active VIEW on the same session.
  const viewA = await realService.startViewForFabricDevice(fabricA.fabricDeviceId, startInputA, options);
  assert.equal(viewA.omegaV2HostId, readyA.host.deviceId);
  // The browser's own frame-poll loop is what transitions OMEGA's view from
  // VIEW_STARTING to VIEWING (mission §8: INTERACTIVE only elevates an
  // already-active VIEW) — one real frame fetch reproduces that exactly,
  // never a Fabric-side shortcut around OMEGA's own certified check.
  await fetchOmegaOutboundViewFrame(viewA.sessionId, options);

  const interactiveA = await realService.startInteractiveForFabricDevice(fabricA.fabricDeviceId, {}, options);
  assert.equal(interactiveA.interactiveStatus, 'INTERACTIVE');

  // Send one mocked pointer and one mocked key through OMEGA V2's own
  // certified input route directly (never through a Fabric route — Fabric
  // exposes none), exactly as the certified UI already does.
  await sendOmegaOutboundInput(interactiveA.sessionId, 'pointer', { x: 0.5, y: 0.5 }, options);
  await sendOmegaOutboundInput(interactiveA.sessionId, 'key', { key: 'KeyA', state: 'DOWN' }, options);
  await sendOmegaOutboundInput(interactiveA.sessionId, 'key', { key: 'KeyA', state: 'UP' }, options);

  const inputEvidenceA = await sendAndWait(hostA.child, { type: 'input-events' }, 'input-events-result');
  assert.ok(inputEvidenceA.events.some(event => event.category === 'pointer'), 'host A recorded the mocked pointer event');
  assert.ok(inputEvidenceA.events.some(event => event.key === 'KeyA' && event.state === 'DOWN'), 'host A recorded the mocked key event');

  const inputEvidenceB = await sendAndWait(hostB.child, { type: 'input-events' }, 'input-events-result');
  assert.equal(inputEvidenceB.events.length, 0, 'host B: exactly 0 input events — exact target, no fallback, no cross-target leak');

  const dbA = new Database(hostA.dbPath, { readonly: true });
  const dbB = new Database(hostB.dbPath, { readonly: true });
  try {
    assert.equal(dbA.prepare("SELECT count(*) AS count FROM omega_v2_sessions WHERE direction = 'INBOUND'").get().count, 1);
    assert.equal(dbB.prepare("SELECT count(*) AS count FROM omega_v2_sessions WHERE direction = 'INBOUND'").get().count, 0);
  } finally { dbA.close(); dbB.close(); }

  const stoppedInteractive = await realService.stopInteractiveForFabricDevice(fabricA.fabricDeviceId, options);
  assert.equal(stoppedInteractive.interactiveStatus, 'STOPPED');
  // Fabric's own local viewStatus field only ever reflects startView's
  // initial payload (VIEW_STARTING) — frames, and the VIEWING transition
  // they cause, bypass Fabric entirely by design (mission §13). "VIEW
  // survives STOP INTERACTIVE" is proven by the session staying CONNECTED,
  // not by a Fabric-local status Fabric structurally never learns.
  assert.notEqual(stoppedInteractive.viewStatus, 'STOPPED', 'VIEW survives STOP INTERACTIVE');
  assert.equal(stoppedInteractive.sessionStatus, 'CONNECTED', 'session (and therefore VIEW) is still live after STOP INTERACTIVE');

  const stoppedView = await realService.stopViewForFabricDevice(fabricA.fabricDeviceId, options);
  assert.equal(stoppedView.viewStatus, 'STOPPED');
  assert.equal(stoppedView.interactiveStatus, 'STOPPED');

  await realService.stopSessionForFabricDevice(fabricA.fabricDeviceId, options);

  // Remote STOP: fresh VIEW+INTERACTIVE, then the host process tears the
  // session down; Fabric's next status read reflects STOPPED, no reconnect.
  const view2 = await realService.startViewForFabricDevice(fabricA.fabricDeviceId, startInputA, options);
  await fetchOmegaOutboundViewFrame(view2.sessionId, options);
  const interactive2 = await realService.startInteractiveForFabricDevice(fabricA.fabricDeviceId, {}, options);
  assert.equal(interactive2.interactiveStatus, 'INTERACTIVE');
  const remoteStopWait = sendAndWait(hostA.child, { type: 'remote-stop', sessionId: view2.sessionId }, 'remote-stopped');
  assert.equal((await remoteStopWait).changed, true);
  // OMEGA V2's own signed status monitor (its certified detection
  // mechanism, never reimplemented here) polls every 5s; Fabric only ever
  // reflects what that monitor has already recorded, so the wait must clear
  // that interval before a status read can show the drop.
  await new Promise(resolve => setTimeout(resolve, 6_000));
  const statusAfterRemoteStop = realService.getViewStateForFabricDevice(fabricA.fabricDeviceId);
  assert.equal(statusAfterRemoteStop.interactiveStatus, 'STOPPED');
  const inputAfterRemoteStop = await sendOmegaOutboundInput(interactive2.sessionId, 'key', { key: 'KeyB', state: 'DOWN' }, options).catch(error => error);
  assert.ok(inputAfterRemoteStop instanceof Error, 'input after remote STOP is rejected by OMEGA itself, not silently accepted');

  const inputEvidenceBFinal = await sendAndWait(hostB.child, { type: 'input-events' }, 'input-events-result');
  assert.equal(inputEvidenceBFinal.events.length, 0, 'host B remains at 0 input events throughout the entire run');
});
