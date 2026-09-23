// OMEGA V1 Phase 4 — HTTP/Hono route tests.
// Uses real pairing, mutual-auth, session and Hono route code paths, with
// only the screen/input provider replaced by a safe deterministic fixture.
// No real click or keyboard event is sent by this file.
import './test-setup.mjs';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createOmegaRoute } from './src/routes/omega.js';
import { createOmegaInteractiveRoute } from './src/routes/omega-interactive.js';
import {
  _setInputProviderForTests, _resetInputProviderForTests,
  _resetInteractiveThrottleForTests, MAX_EVENTS_PER_BATCH,
} from './src/lib/omega-interactive.js';
import { _resetPairingRateLimitForTests, OMEGA_PERMISSION_LEVELS } from './src/lib/omega-pairing.js';
import { OMEGA_INPUT_EVENT_TYPES } from './src/lib/omega-input.js';

const SCREENS = [
  { index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, device: 'DISPLAY1' },
  { index: 1, primary: false, x: 1920, y: 0, width: 1280, height: 720, device: 'DISPLAY2' },
];

const sentBatches = [];
const shownIndicators = [];

function installFakeInput() {
  _setInputProviderForTests({
    listScreens: async () => SCREENS,
    sendInputBatch: async (tuples) => {
      sentBatches.push(tuples);
      return { requested: tuples.length, sent: tuples.length, results: tuples.map(() => ({ ok: true, sent: 1 })) };
    },
    showSessionIndicator: async (kind) => {
      shownIndicators.push(kind);
      return { ok: true };
    },
  });
}

before(() => { initSqlite(':memory:'); });
beforeEach(() => {
  _resetPairingRateLimitForTests();
  _resetInteractiveThrottleForTests();
  sentBatches.length = 0;
  shownIndicators.length = 0;
  installFakeInput();
});
after(() => { _resetInputProviderForTests(); });

const controlApp = new Hono().route('/api', createOmegaRoute({ isLocal: () => true }));
const interactiveApp = new Hono().route('/api', createOmegaInteractiveRoute());

async function request(app, path, { method = 'GET', body, rawBody, headers = {} } = {}) {
  const hasBody = rawBody !== undefined || body !== undefined;
  const response = await app.request(`http://localhost/api${path}`, {
    method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    body: contentType.includes('application/json') ? await response.json() : await response.text(),
  };
}

async function generateFixtureKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
}

async function pairedDeviceWithSession({ permission = OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE, deviceName = 'Interactive HTTP Fixture' } = {}) {
  const fixture = await generateFixtureKeypair();
  const start = await request(controlApp, '/omega/pairing/start', {
    method: 'POST', body: { initiatorDeviceName: deviceName, requestedPermission: permission },
  });
  assert.equal(start.status, 201);
  const verify = await request(controlApp, '/omega/pairing/verify', {
    method: 'POST', body: { pairingId: start.body.pairingId, code: start.body.code, publicKeyPem: fixture.publicKeyPem },
  });
  assert.equal(verify.status, 200);
  const approve = await request(controlApp, '/omega/pairing/approve', {
    method: 'POST', body: { pairingId: start.body.pairingId },
  });
  assert.equal(approve.status, 200);
  const deviceId = approve.body.deviceId;

  const challengeResponse = await request(controlApp, '/omega/challenge', { method: 'POST' });
  const challenge = challengeResponse.body.challenge;
  const signature = crypto.sign(null, Buffer.from(challenge, 'utf8'), fixture.privateKey).toString('base64');
  const sessionResponse = await request(controlApp, '/omega/sessions', {
    method: 'POST', body: { deviceId, challenge, signature },
  });
  assert.equal(sessionResponse.status, 201);
  return { deviceId, fixture, sessionId: sessionResponse.body.sessionId, nonce: sessionResponse.body.nonce };
}

function move(x = 100, y = 100) { return { type: OMEGA_INPUT_EVENT_TYPES.MOVE, x, y }; }

async function startInteractive(session, screenIndex = 0, extra = {}) {
  return request(interactiveApp, `/omega/interactive/${session.sessionId}/start`, {
    method: 'POST', body: { deviceId: session.deviceId, nonce: session.nonce, screenIndex, ...extra },
  });
}

async function submitInteractive(session, nonce, events, screenIndex = 0, extra = {}) {
  return request(interactiveApp, `/omega/interactive/${session.sessionId}/input`, {
    method: 'POST', body: { deviceId: session.deviceId, nonce, screenIndex, events, ...extra },
  });
}

test('a valid INTERACTIVE session starts and submits through the real Hono route', async () => {
  const session = await pairedDeviceWithSession();
  const start = await startInteractive(session);
  assert.equal(start.status, 201);
  assert.equal(start.body.indicatorShown, true);
  const input = await submitInteractive(session, start.body.nextNonce, [move()]);
  assert.equal(input.status, 200);
  assert.equal(input.body.sent, 1);
  assert.deepEqual(shownIndicators, ['interactive_start']);
});

test('VIEW sessions cannot inject mouse or keyboard, even when the client falsifies permission', async () => {
  const view = await pairedDeviceWithSession({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_VIEW });
  const mouse = await request(interactiveApp, `/omega/interactive/${view.sessionId}/input`, {
    method: 'POST', body: { deviceId: view.deviceId, nonce: view.nonce, screenIndex: 0, permissionLevel: 3, events: [move()] },
  });
  assert.equal(mouse.status, 403);
  assert.equal(mouse.body.error, 'permission_insufficient');

  const view2 = await pairedDeviceWithSession({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_VIEW });
  const keyboard = await request(interactiveApp, `/omega/interactive/${view2.sessionId}/input`, {
    method: 'POST', body: { deviceId: view2.deviceId, nonce: view2.nonce, screenIndex: 0, events: [{ type: OMEGA_INPUT_EVENT_TYPES.KEY_DOWN, vk: 0x41 }] },
  });
  assert.equal(keyboard.status, 403);
  assert.equal(keyboard.body.error, 'permission_insufficient');
  assert.equal(sentBatches.length, 0);
});

test('wrong session identity, nonce and replay are rejected over HTTP', async () => {
  const session = await pairedDeviceWithSession();
  const other = await pairedDeviceWithSession();
  const wrongDevice = await request(interactiveApp, `/omega/interactive/${session.sessionId}/start`, {
    method: 'POST', body: { deviceId: other.deviceId, nonce: session.nonce, screenIndex: 0 },
  });
  assert.equal(wrongDevice.status, 401);

  const badNonce = await startInteractive({ ...session, nonce: 'wrong-nonce' });
  assert.equal(badNonce.status, 401);

  const start = await startInteractive(session);
  assert.equal(start.status, 201);
  const replay = await startInteractive(session);
  assert.equal(replay.status, 401);
});

test('expired and revoked sessions are rejected before any provider call', async () => {
  const expired = await pairedDeviceWithSession();
  getDatabase().prepare('UPDATE omega_sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expired.sessionId);
  const expiredResponse = await startInteractive(expired);
  assert.equal(expiredResponse.status, 401);

  const revoked = await pairedDeviceWithSession();
  const revoke = await request(controlApp, `/omega/devices/${revoked.deviceId}/revoke`, { method: 'POST' });
  assert.equal(revoke.status, 200);
  const revokedResponse = await startInteractive(revoked);
  assert.equal(revokedResponse.status, 401);
  assert.equal(sentBatches.length, 0);
});

test('malformed JSON and malformed request bodies fail closed with 4xx responses', async () => {
  const malformedJson = await request(interactiveApp, '/omega/interactive/valid-session-id/start', {
    method: 'POST', rawBody: '{',
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.body.error, 'json_invalid');

  const session = await pairedDeviceWithSession();
  const missingDevice = await request(interactiveApp, `/omega/interactive/${session.sessionId}/start`, {
    method: 'POST', body: { nonce: session.nonce, screenIndex: 0 },
  });
  assert.equal(missingDevice.status, 400);
  assert.equal(missingDevice.body.error, 'device_id_invalid');

  const invalidEvents = await request(interactiveApp, `/omega/interactive/${session.sessionId}/input`, {
    method: 'POST', body: { deviceId: session.deviceId, nonce: session.nonce, screenIndex: 0, events: 'not-an-array' },
  });
  assert.equal(invalidEvents.status, 400);
  assert.equal(invalidEvents.body.error, 'events_invalid');
});

test('unknown event, invalid vk, negative/out-of-screen coordinates and invalid screen are rejected', async () => {
  const unknown = await pairedDeviceWithSession();
  const unknownStart = await startInteractive(unknown);
  const unknownEvent = await submitInteractive(unknown, unknownStart.body.nextNonce, [{ type: 99, x: 1, y: 1 }]);
  assert.equal(unknownEvent.status, 400);
  assert.equal(unknownEvent.body.error, 'event_type_invalid');

  const invalidVk = await pairedDeviceWithSession();
  const invalidVkStart = await startInteractive(invalidVk);
  const vk = await submitInteractive(invalidVk, invalidVkStart.body.nextNonce, [{ type: OMEGA_INPUT_EVENT_TYPES.KEY_DOWN, vk: 0xE7 }]);
  assert.equal(vk.status, 400);
  assert.equal(vk.body.error, 'vk_not_allowed');

  const negative = await pairedDeviceWithSession();
  const negativeStart = await startInteractive(negative);
  const negativeCoords = await submitInteractive(negative, negativeStart.body.nextNonce, [move(-1, 1)]);
  assert.equal(negativeCoords.status, 400);
  assert.equal(negativeCoords.body.error, 'coords_out_of_bounds');

  const outside = await pairedDeviceWithSession();
  const outsideStart = await startInteractive(outside);
  const outsideCoords = await submitInteractive(outside, outsideStart.body.nextNonce, [move(1920, 10)]);
  assert.equal(outsideCoords.status, 400);
  assert.equal(outsideCoords.body.error, 'coords_out_of_bounds');

  const invalidScreen = await pairedDeviceWithSession();
  const invalidScreenResponse = await startInteractive(invalidScreen, 9);
  assert.equal(invalidScreenResponse.status, 400);
  assert.equal(invalidScreenResponse.body.error, 'screen_index_out_of_range');
});

test('multi-monitor selection and all allowlisted event shapes reach only the fake provider', async () => {
  const session = await pairedDeviceWithSession();
  const start = await startInteractive(session, 1);
  assert.equal(start.status, 201);
  const events = [
    move(100, 100),
    { type: OMEGA_INPUT_EVENT_TYPES.LEFT_DOWN, x: 100, y: 100 },
    { type: OMEGA_INPUT_EVENT_TYPES.LEFT_UP, x: 100, y: 100 },
    { type: OMEGA_INPUT_EVENT_TYPES.RIGHT_DOWN, x: 100, y: 100 },
    { type: OMEGA_INPUT_EVENT_TYPES.RIGHT_UP, x: 100, y: 100 },
    { type: OMEGA_INPUT_EVENT_TYPES.WHEEL, x: 100, y: 100, wheelDelta: 1 },
    { type: OMEGA_INPUT_EVENT_TYPES.KEY_DOWN, vk: 0x41 },
    { type: OMEGA_INPUT_EVENT_TYPES.KEY_UP, vk: 0x41 },
  ];
  const input = await submitInteractive(session, start.body.nextNonce, events, 1);
  assert.equal(input.status, 200);
  assert.equal(input.body.requested, events.length);
  assert.equal(sentBatches.length, 1);
  assert.equal(sentBatches[0].length, events.length);
});

test('oversized batches and oversized bodies are rejected before injection', async () => {
  const session = await pairedDeviceWithSession();
  const start = await startInteractive(session);
  const oversizedBatch = await submitInteractive(session, start.body.nextNonce,
    Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => move()));
  assert.equal(oversizedBatch.status, 413);
  assert.equal(oversizedBatch.body.error, 'batch_too_large');

  const huge = JSON.stringify({ deviceId: session.deviceId, nonce: start.body.nextNonce, screenIndex: 0, events: [move()], padding: 'x'.repeat(9000) });
  const oversizedBody = await request(interactiveApp, `/omega/interactive/${session.sessionId}/input`, { method: 'POST', rawBody: huge });
  assert.equal(oversizedBody.status, 413);
  assert.equal(oversizedBody.body.error, 'request_too_large');
  assert.equal(sentBatches.length, 0);
});

test('per-session rate limiting returns 429 and prevents the second provider call', async () => {
  const session = await pairedDeviceWithSession();
  const start = await startInteractive(session);
  const first = await submitInteractive(session, start.body.nextNonce, [move()]);
  assert.equal(first.status, 200);
  const second = await submitInteractive(session, first.body.nextNonce, [move()]);
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'rate_limited');
  assert.equal(sentBatches.length, 1);
});

test('STOP ends the interactive session, emits the stop indicator and blocks later input', async () => {
  const session = await pairedDeviceWithSession();
  const start = await startInteractive(session);
  const stop = await request(interactiveApp, `/omega/interactive/${session.sessionId}/stop`, {
    method: 'POST', body: { deviceId: session.deviceId, nonce: start.body.nextNonce },
  });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.interactiveStopped, true);
  assert.deepEqual(shownIndicators, ['interactive_start', 'interactive_stop']);

  const status = await request(interactiveApp, `/omega/interactive/${session.sessionId}/status`);
  assert.equal(status.status, 400);

  const afterStop = await submitInteractive(session, start.body.nextNonce, [move()]);
  assert.equal(afterStop.status, 401);
  assert.equal(afterStop.body.error, 'session_invalid');
});

test('remote INTERACTIVE status and STOP reject requests without session proof', async () => {
  const session = await pairedDeviceWithSession();
  const start = await startInteractive(session);
  assert.equal(start.status, 201);
  assert.equal((await request(interactiveApp, `/omega/interactive/${session.sessionId}/status`)).status, 400);
  assert.equal((await request(interactiveApp, `/omega/interactive/${session.sessionId}/stop`, {
    method: 'POST', body: { deviceId: session.deviceId },
  })).status, 400);
});

test('XSS-shaped device names remain inert data and no forbidden route surface is present', async () => {
  const xss = await pairedDeviceWithSession({ deviceName: '<script>alert(1)</script>' });
  const devices = await request(controlApp, '/omega/devices');
  assert.equal(devices.status, 200);
  assert.ok(devices.body.devices.some(d => d.displayName === '<script>alert(1)</script>'));
  assert.equal(xss.deviceId.length > 0, true);

  const routeSource = await import('node:fs').then(fs => fs.readFileSync(new URL('./src/routes/omega-interactive.js', import.meta.url), 'utf8'));
  for (const forbidden of ['cmd.exe', 'bash', 'Start-Process', 'clipboard', 'file transfer', 'admin action', '.listen(']) {
    assert.equal(routeSource.includes(forbidden), false, `forbidden route token: ${forbidden}`);
  }
});
