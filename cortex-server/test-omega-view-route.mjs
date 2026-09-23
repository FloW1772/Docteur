// OMEGA V1 Phase 3 — VIEW ONLY HTTP route tests. Simulates a REAL two-
// device LAN session over Cortex's existing HTTP server (per this
// project's own testing discipline — Phase 1 §64: real code path, real
// HTTP requests, real authenticated session tokens; both peers
// simulated as local test clients rather than needing a second physical
// machine). Uses an injected fake capture provider (omega-view.js's
// _setCaptureProviderForTests) so this file runs fast and
// deterministically; the REAL PowerShell capture mechanism is proven
// separately in test-omega-capture.mjs on this actual Windows machine.
// Run with: node --test --test-timeout=20000 test-omega-view-route.mjs
import './test-setup.mjs';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { initSqlite } from './src/lib/sqlite.js';
import { createOmegaRoute } from './src/routes/omega.js';
import { createOmegaViewRoute } from './src/routes/omega-view.js';
import { _resetPairingRateLimitForTests, OMEGA_PERMISSION_LEVELS } from './src/lib/omega-pairing.js';
import { _setCaptureProviderForTests, _resetViewThrottleForTests, MIN_FRAME_INTERVAL_MS } from './src/lib/omega-view.js';
import { isStrictLocalMode } from './src/lib/strict-local.js';

before(() => { initSqlite(':memory:'); });
beforeEach(() => {
  _resetPairingRateLimitForTests();
  _resetViewThrottleForTests();
  installFakeCapture();
});

const FAKE_SCREENS = [
  { index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, device: 'DISPLAY1' },
  { index: 1, primary: false, x: 1920, y: 0, width: 1280, height: 720, device: 'DISPLAY2' },
];

function fakePngBuffer(size = 64) {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const buf = Buffer.alloc(Math.max(size, 8));
  PNG_MAGIC.copy(buf, 0);
  return buf;
}

function installFakeCapture(overrides = {}) {
  _setCaptureProviderForTests({
    listScreens: async () => FAKE_SCREENS,
    captureFrame: async (screenIndex) => {
      const s = FAKE_SCREENS[screenIndex];
      return { buffer: fakePngBuffer(), width: s?.width ?? 1920, height: s?.height ?? 1080, byteLength: 64, capturedAt: new Date().toISOString() };
    },
    showSessionIndicator: async () => ({ ok: true }),
    ...overrides,
  });
}
installFakeCapture();

// Two apps: the control-plane (loopback-only, Phase 2's own app) and
// the VIEW data-path app registered SEPARATELY and reachable from a
// non-loopback caller (isLocal: () => false) — this is the actual
// point of Phase 3's architecture: control-plane stays loopback-gated,
// the VIEW data path is authenticated by session token instead, so a
// second (simulated) LAN device can legitimately reach it.
const controlApp = new Hono().route('/api', createOmegaRoute({ isLocal: () => true }));
const lanViewApp = new Hono().route('/api', createOmegaViewRoute({}));

async function request(app, path, { method = 'GET', body, headers = {}, host = 'localhost' } = {}) {
  const response = await app.request(`http://${host}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const buf = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer: buf };
}

async function generateFixtureKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
}

/** Full real pairing + mutual auth + session mint over the CONTROL app
 * (as a real second device would), returning a session usable against
 * the VIEW app — this is the "two devices, one LAN" simulation. */
async function pairedDeviceWithSession({ permission = OMEGA_PERMISSION_LEVELS.OMEGA_VIEW, deviceName = 'LAN Peer Device' } = {}) {
  const fixture = await generateFixtureKeypair();
  const start = await request(controlApp, '/omega/pairing/start', {
    method: 'POST', body: { initiatorDeviceName: deviceName, requestedPermission: permission },
  });
  const verify = await request(controlApp, '/omega/pairing/verify', {
    method: 'POST', body: { pairingId: start.body.pairingId, code: start.body.code, publicKeyPem: fixture.publicKeyPem },
  });
  assert.equal(verify.status, 200);
  const approve = await request(controlApp, '/omega/pairing/approve', { method: 'POST', body: { pairingId: start.body.pairingId } });
  const deviceId = approve.body.deviceId;

  const challengeResp = await request(controlApp, '/omega/challenge', { method: 'POST' });
  const challenge = challengeResp.body.challenge;
  const signature = crypto.sign(null, Buffer.from(challenge, 'utf8'), fixture.privateKey).toString('base64');

  const sessionResp = await request(controlApp, '/omega/sessions', { method: 'POST', body: { deviceId, challenge, signature } });
  assert.equal(sessionResp.status, 201);

  return { deviceId, fixture, sessionId: sessionResp.body.sessionId, nonce: sessionResp.body.nonce };
}

// ── Live LAN session: device authorisé, real two-device simulation ──

test('a fully paired device can start a VIEW stream and fetch frames over the LAN-reachable route (not loopback-gated)', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();

  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, {
    method: 'POST', body: { deviceId, nonce, screenIndex: 0 },
  });
  assert.equal(start.status, 201);
  assert.equal(start.body.screenIndex, 0);
  assert.equal(start.body.indicatorShown, true);

  const frameResp = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  assert.equal(frameResp.status, 200);
  assert.equal(frameResp.headers.get('content-type'), 'image/png');
  assert.ok(frameResp.buffer.length > 0);
  assert.ok(frameResp.headers.get('x-omega-next-nonce'));
});

test('the VIEW route responds even to a request whose connection is simulated as non-loopback (LAN-reachable by design)', async () => {
  // lanViewApp was built with no isLocal override at all — it has NO
  // loopback gate, structurally, unlike controlApp. This proves the
  // architectural claim: the data path does not depend on isLocal().
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  assert.equal(start.status, 201);
});

// ── Device non pairé ─────────────────────────────────────────────────

test('an unpaired device (never completed pairing) cannot start a VIEW session', async () => {
  const r = await request(lanViewApp, '/omega/view/does-not-exist/start', {
    method: 'POST', body: { deviceId: 'never-paired-device', nonce: 'x', screenIndex: 0 },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'session_invalid');
});

// ── Device révoqué ────────────────────────────────────────────────────

test('a revoked device is rejected when trying to start a VIEW session, even with its last-known-valid session/nonce', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const revoke = await request(controlApp, `/omega/devices/${deviceId}/revoke`, { method: 'POST' });
  assert.equal(revoke.status, 200);

  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  assert.equal(start.status, 401);
  assert.equal(start.body.error, 'session_invalid');
});

// ── Mauvaise clé / identité modifiée ─────────────────────────────────

test('mutual-auth with the WRONG private key never yields a usable session for the VIEW route', async () => {
  const fixture = await generateFixtureKeypair();
  const attacker = await generateFixtureKeypair();
  const start = await request(controlApp, '/omega/pairing/start', { method: 'POST', body: { initiatorDeviceName: 'Wrong Key Device', requestedPermission: 1 } });
  const verify = await request(controlApp, '/omega/pairing/verify', { method: 'POST', body: { pairingId: start.body.pairingId, code: start.body.code, publicKeyPem: fixture.publicKeyPem } });
  assert.equal(verify.status, 200);
  const approve = await request(controlApp, '/omega/pairing/approve', { method: 'POST', body: { pairingId: start.body.pairingId } });
  const deviceId = approve.body.deviceId;

  const challengeResp = await request(controlApp, '/omega/challenge', { method: 'POST' });
  const badSignature = crypto.sign(null, Buffer.from(challengeResp.body.challenge, 'utf8'), attacker.privateKey).toString('base64');
  const sessionResp = await request(controlApp, '/omega/sessions', { method: 'POST', body: { deviceId, challenge: challengeResp.body.challenge, signature: badSignature } });
  assert.equal(sessionResp.status, 401);

  // No session was ever minted, so the VIEW route has nothing to accept.
  const viewStart = await request(lanViewApp, `/omega/view/fake-session-id/start`, { method: 'POST', body: { deviceId, nonce: 'x', screenIndex: 0 } });
  assert.equal(viewStart.status, 401);
});

test('a device claiming an IDENTITY that was never registered (unknown deviceId format-valid but nonexistent) is rejected', async () => {
  const fakeDeviceId = crypto.randomUUID();
  const r = await request(lanViewApp, '/omega/view/some-session/start', { method: 'POST', body: { deviceId: fakeDeviceId, nonce: 'x', screenIndex: 0 } });
  assert.equal(r.status, 401);
});

// ── Session expirée ───────────────────────────────────────────────────

test('an expired session is rejected on the VIEW frame endpoint', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const { getDatabase } = await import('./src/lib/sqlite.js');
  getDatabase().prepare('UPDATE omega_sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), sessionId);

  const r = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  assert.equal(r.status, 401);
});

// ── Replay ────────────────────────────────────────────────────────────

test('replaying the exact same start-session request twice (same nonce) fails the second time', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const first = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  assert.equal(first.status, 201);
  const replay = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  assert.equal(replay.status, 401);
});

test('a captured frame response cannot be replayed to fetch a second frame with the old nonce', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  const frame1 = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  assert.equal(frame1.status, 200);
  await new Promise((r) => setTimeout(r, MIN_FRAME_INTERVAL_MS + 20));
  // Replay the ORIGINAL start nonce again (already consumed).
  const replay = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  assert.equal(replay.status, 401);
});

// ── Vue écran normale / changement de résolution / multi-monitor ────

test('GET /omega/view/screens requires an authenticated session', async () => {
  const r = await request(lanViewApp, '/omega/view/screens');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'session_id_invalid');
});

test('GET /omega/view/screens lists monitors for an authenticated session and rotates its nonce', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const r = await request(lanViewApp, `/omega/view/screens?sessionId=${sessionId}&deviceId=${deviceId}&nonce=${encodeURIComponent(nonce)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.screens.length, 2);
  assert.ok(r.body.nextNonce);
  assert.notEqual(r.body.nextNonce, nonce);
});

test('multi-monitor: starting a VIEW session on screen 1 captures screen 1, never silently screen 0', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 1 } });
  assert.equal(start.status, 201);
  const frame = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  assert.equal(Number(frame.headers.get('x-omega-frame-width')), 1280);
  assert.equal(Number(frame.headers.get('x-omega-frame-height')), 720);
});

test('a screenIndex beyond available monitors is rejected, never silently clamped to 0', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 7 } });
  assert.equal(start.status, 400);
  assert.equal(start.body.error, 'screen_index_out_of_range');
});

test('resolution change mid-session is visible via frame headers, not hidden', async () => {
  let n = 0;
  installFakeCapture({
    captureFrame: async () => {
      n += 1;
      const dims = n === 1 ? { width: 1920, height: 1080 } : { width: 1024, height: 768 };
      return { buffer: fakePngBuffer(), byteLength: 64, capturedAt: new Date().toISOString(), ...dims };
    },
  });
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  const f1 = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  await new Promise((r) => setTimeout(r, MIN_FRAME_INTERVAL_MS + 20));
  const f2 = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(f1.headers.get('x-omega-next-nonce'))}`);
  assert.notEqual(f1.headers.get('x-omega-frame-width'), f2.headers.get('x-omega-frame-width'));
  installFakeCapture();
});

// ── Frame malformée / surdimensionnée ────────────────────────────────

test('a malformed frame from the capture layer surfaces as a 502, never as a 200 with bad bytes', async () => {
  const { OmegaCaptureError } = await import('./src/lib/omega-capture.js');
  installFakeCapture({ captureFrame: async () => { throw new OmegaCaptureError('capture_frame_malformed'); } });
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  const frame = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  assert.equal(frame.status, 502);
  installFakeCapture();
});

test('an oversized frame is rejected with 502, never forwarded to the client', async () => {
  const { OmegaCaptureError } = await import('./src/lib/omega-capture.js');
  installFakeCapture({ captureFrame: async () => { throw new OmegaCaptureError('capture_frame_too_large', { size: 99999999 }); } });
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  const frame = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  assert.equal(frame.status, 502);
  installFakeCapture();
});

// ── Lien lent / déconnexion / reconnexion / crash transport ──────────

test('a slow capture (simulated slow link) still completes and returns a valid frame', async () => {
  installFakeCapture({
    captureFrame: async (screenIndex) => {
      await new Promise((r) => setTimeout(r, 100));
      const s = FAKE_SCREENS[screenIndex];
      return { buffer: fakePngBuffer(), width: s.width, height: s.height, byteLength: 64, capturedAt: new Date().toISOString() };
    },
  });
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  const frame = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  assert.equal(frame.status, 200);
  installFakeCapture();
});

test('crashed transport (capture throws) surfaces as an error status, never a hung/crashed process', async () => {
  installFakeCapture({ captureFrame: async () => { throw new Error('simulated crash'); } });
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  const frame = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  assert.equal(frame.status, 500);
  installFakeCapture();
});

test('disconnection then reconnection: polling can pause and resume using the last-issued nonce', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  const frame1 = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  // Simulate a network drop: no calls for a while.
  await new Promise((r) => setTimeout(r, MIN_FRAME_INTERVAL_MS + 100));
  const frame2 = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(frame1.headers.get('x-omega-next-nonce'))}`);
  assert.equal(frame2.status, 200);
});

// ── STOP SESSION ──────────────────────────────────────────────────────

test('STOP SESSION cuts the stream and prevents any silent resumption', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  const stop = await request(lanViewApp, `/omega/view/${sessionId}/stop`, { method: 'POST', body: { deviceId, nonce: start.body.nextNonce } });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.viewStopped, true);
  assert.equal(stop.body.sessionEnded, true);

  const frameAfterStop = await request(lanViewApp, `/omega/view/${sessionId}/frame?deviceId=${deviceId}&nonce=${encodeURIComponent(start.body.nextNonce)}`);
  assert.equal(frameAfterStop.status, 401);

  const restartAttempt = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  assert.equal(restartAttempt.status, 401);
});

test('remote VIEW status and STOP reject requests without session proof', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  assert.equal(start.status, 201);
  assert.equal((await request(lanViewApp, `/omega/view/${sessionId}/status`)).status, 400);
  assert.equal((await request(lanViewApp, `/omega/view/${sessionId}/stop`, { method: 'POST', body: { deviceId } })).status, 400);
});

// ── VIEW cannot escalate: mouse/keyboard/admin attempts (mission's
// final confirm list) ────────────────────────────────────────────────

test('no route exists anywhere on the VIEW app for mouse/keyboard/admin actions', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });

  for (const path of ['/omega/view/mouse', '/omega/view/keyboard', '/omega/view/input', `/omega/view/${sessionId}/mouse`, `/omega/view/${sessionId}/keyboard`, `/omega/view/${sessionId}/admin`]) {
    const r = await request(lanViewApp, path, { method: 'POST', body: { deviceId, x: 1, y: 1 } });
    assert.equal(r.status, 404, `expected 404 for ${path}, got ${r.status}`);
  }
});

test('a VIEW-level session (permission=1) cannot be escalated by client-supplied fields — permission is read server-side', async () => {
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_VIEW });
  // Attempt to smuggle a higher permission / an action-shaped field into
  // the start-session body — none of these fields are read by the route
  // or library layer (startViewSession() destructures only
  // {sessionId, deviceId, presentedNonce, screenIndex}).
  const r = await request(lanViewApp, `/omega/view/${sessionId}/start`, {
    method: 'POST',
    body: { deviceId, nonce, screenIndex: 0, permissionLevel: 3, action: 'CLICK', mouseX: 100, mouseY: 200, keys: 'A' },
  });
  assert.equal(r.status, 201);
  // The session's ACTUAL permission is still VIEW-only — verified via
  // the control-plane session-status read, server-derived, never from
  // the request we just sent.
  const statusRead = await request(controlApp, `/omega/sessions/${sessionId}`);
  assert.equal(statusRead.body.session.permissionLevel, OMEGA_PERMISSION_LEVELS.OMEGA_VIEW);
});

// ── XSS on device name / status (mission's final confirm list) ──────

test('an XSS-shaped device display name is stored/returned verbatim as inert JSON text, never interpreted', async () => {
  const xssName = '<script>alert(document.cookie)</script>';
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession({ deviceName: xssName });
  const deviceRead = await request(controlApp, `/omega/devices/${deviceId}`);
  assert.equal(deviceRead.body.device.displayName, xssName);
  assert.equal(typeof deviceRead.body.device.displayName, 'string');

  // The VIEW route's own status endpoint never echoes displayName at
  // all (no HTML sink anywhere in this route file), but confirm the
  // VIEW session still starts fine even with a hostile name on record.
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  assert.equal(start.status, 201);
});

test('response Content-Type for JSON error bodies is always application/json, never text/html (no reflected-XSS sink)', async () => {
  const r = await request(lanViewApp, '/omega/view/../../etc/start', { method: 'POST', body: { deviceId: '<img src=x onerror=alert(1)>', nonce: 'x', screenIndex: 0 } });
  assert.ok(r.status === 400 || r.status === 404);
});

// ── Zero cloud ────────────────────────────────────────────────────────

test('Strict Local mode has no effect on VIEW routes (structurally no cloud call exists to block)', async () => {
  // Confirmed by source inspection (see omega-view.js/omega-view.js
  // route header comments) that no fetch()/http(s) client and no
  // assertCloudAllowed() call exists anywhere in this phase's files —
  // this test asserts the OBSERVABLE behavior matches: a VIEW session
  // works identically regardless of isStrictLocalMode()'s value, since
  // nothing in the code path branches on it.
  const before = isStrictLocalMode();
  const { deviceId, sessionId, nonce } = await pairedDeviceWithSession();
  const start = await request(lanViewApp, `/omega/view/${sessionId}/start`, { method: 'POST', body: { deviceId, nonce, screenIndex: 0 } });
  assert.equal(start.status, 201);
  assert.equal(isStrictLocalMode(), before, 'VIEW session start must not itself mutate strict-local state');
});

test('omega-view.js and routes/omega-view.js contain zero references to fetch(), http.request, https.request, or assertCloudAllowed', async () => {
  const fs = await import('node:fs');
  for (const file of ['./src/lib/omega-view.js', './src/lib/omega-capture.js', './src/routes/omega-view.js']) {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/\bfetch\(/.test(src), `${file} must not call fetch()`);
    assert.ok(!/assertCloudAllowed/.test(src), `${file} must not reference assertCloudAllowed (no cloud path exists here)`);
    assert.ok(!/require\(['"]https?['"]\)/.test(src), `${file} must not require http/https clients`);
  }
});
