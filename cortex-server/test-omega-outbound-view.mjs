import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createOmegaOutboundViewManager, inspectPng, OMEGA_V2_VIEW_LIMITS } from './src/lib/omega-outbound-view.js';
import { validateOmegaOutboundFrame } from './src/lib/omega-outbound-client.js';
import { responseFields, signMessage, verifyMessage, viewFrameFields } from './src/lib/omega-outbound-protocol.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const session = { id: crypto.randomUUID(), local_device_id: `ov2h-${crypto.randomUUID()}`,
  remote_device_id: `ov2c-${crypto.randomUUID()}`, expires_at: new Date(Date.now() + 60_000).toISOString() };

test('VIEW manager is explicit, pull-only, bounded and cleans up on STOP', async () => {
  let captures = 0;
  let indicatorStops = 0;
  const manager = createOmegaOutboundViewManager({
    listScreens: async () => [{ index: 0, primary: true, width: 1, height: 1 }],
    captureFrame: async () => { captures += 1; return { buffer: Buffer.from(PNG), width: 1, height: 1, byteLength: PNG.length }; },
    showSessionIndicator: async kind => { if (kind === 'stop') indicatorStops += 1; return { ok: true }; },
  });
  const started = await manager.start(session, 0);
  assert.equal(started.status, 'VIEW_STARTING');
  await assert.rejects(manager.start(session, 0), /VIEW_ALREADY_STARTED/);
  await assert.rejects(manager.frame(session.id, crypto.randomUUID()), /WRONG_STREAM/);
  const frame = await manager.frame(session.id, started.streamId);
  assert.deepEqual(inspectPng(frame.buffer), { width: 1, height: 1 });
  assert.equal(captures, 1);
  await assert.rejects(manager.frame(session.id, started.streamId), /RATE_LIMITED/);
  assert.equal(manager._streams.size, 1);
  await manager.stop(session.id, 'controller_view_stop', started.streamId);
  assert.equal(manager._streams.size, 0);
  assert.equal(indicatorStops, 1);
  assert.ok(frame.buffer.every(byte => byte === 0));
  await assert.rejects(manager.frame(session.id, started.streamId), /REMOTE_STOPPED/);

  let releaseCapture;
  let markCaptureStarted;
  const captureStarted = new Promise(resolve => { markCaptureStarted = resolve; });
  const staleBuffer = Buffer.from(PNG);
  const slowSession = { ...session, id: crypto.randomUUID() };
  const slowManager = createOmegaOutboundViewManager({
    listScreens: async () => [{ index: 0 }],
    captureFrame: async () => {
      markCaptureStarted();
      return new Promise(resolve => { releaseCapture = () => resolve({ buffer: staleBuffer, width: 1, height: 1 }); });
    },
    showSessionIndicator: async () => ({ ok: true }),
  });
  const slowStarted = await slowManager.start(slowSession, 0);
  const pendingFrame = slowManager.frame(slowSession.id, slowStarted.streamId);
  await captureStarted;
  await slowManager.stop(slowSession.id, 'controller_view_stop', slowStarted.streamId);
  releaseCapture();
  await assert.rejects(pendingFrame, /REMOTE_STOPPED/);
  assert.ok(staleBuffer.every(byte => byte === 0));

  let expiryStops = 0;
  const expirySession = { ...session, id: crypto.randomUUID(), expires_at: new Date(Date.now() + 50).toISOString() };
  const expiryManager = createOmegaOutboundViewManager({
    listScreens: async () => [{ index: 0 }],
    captureFrame: async () => ({ buffer: Buffer.from(PNG), width: 1, height: 1 }),
    showSessionIndicator: async kind => { if (kind === 'stop') expiryStops += 1; return { ok: true }; },
  });
  await expiryManager.start(expirySession, 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(expiryManager._streams.size, 0);
  assert.equal(expiryStops, 1);
});

test('VIEW manager rejects malformed, mismatched and oversized PNG frames', async () => {
  for (const captured of [
    { buffer: Buffer.from('not png'), width: 1, height: 1 },
    { buffer: PNG, width: 2, height: 1 },
    { buffer: Buffer.alloc(OMEGA_V2_VIEW_LIMITS.maxFrameBytes + 1), width: 1, height: 1 },
  ]) {
    const manager = createOmegaOutboundViewManager({
      listScreens: async () => [{ index: 0 }], captureFrame: async () => captured,
      showSessionIndicator: async () => ({ ok: true }),
    });
    const candidate = { ...session, id: crypto.randomUUID() };
    const started = await manager.start(candidate, 0);
    await assert.rejects(manager.frame(candidate.id, started.streamId), /FRAME_INVALID|FRAME_TOO_LARGE/);
  }
});

function signedFrame() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const row = { id: crypto.randomUUID(), local_device_id: `ov2c-${crypto.randomUUID()}`, remote_device_id: `ov2h-${crypto.randomUUID()}` };
  const stateView = { streamId: crypto.randomUUID(), lastSequence: 0, recentFrameIds: new Set() };
  const requestId = crypto.randomUUID();
  const frameId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const fields = viewFrameFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId: row.id, requestId, streamId: stateView.streamId, frameId, sequence: 1, timestamp,
    mimeType: 'image/png', width: 1, height: 1, screenIndex: 0, bodyBytes: PNG });
  const responseTimestamp = new Date().toISOString();
  const response = responseFields({ localDeviceId: row.local_device_id, remoteDeviceId: row.remote_device_id,
    sessionId: row.id, requestId, timestamp: responseTimestamp, statusCode: 200, bodyBytes: PNG });
  const headers = { 'content-type': 'image/png', 'x-omega-frame-id': frameId,
    'x-omega-stream-id': stateView.streamId, 'x-omega-frame-timestamp': timestamp,
    'x-omega-frame-sequence': '1', 'x-omega-frame-width': '1', 'x-omega-frame-height': '1',
    'x-omega-screen-index': '0', 'x-omega-session-id': row.id,
    'x-omega-remote-device-id': row.remote_device_id, 'x-omega-response-timestamp': responseTimestamp,
    'x-omega-response-signature': signMessage(privateKey, 'OMEGA-V2/HOST/RESPONSE', response),
    'x-omega-frame-signature': signMessage(privateKey, 'OMEGA-V2/HOST/VIEW_FRAME', fields) };
  return { row, stateView, publicKeyPem, requestId, fields, response,
    result: { status: 200, headers, body: PNG } };
}

test('authenticated frame validation rejects binding, replay, tamper, MIME, size and PNG attacks', () => {
  const validate = value => validateOmegaOutboundFrame({ row: value.row, stateView: value.stateView,
    peerPublicKeyPem: value.publicKeyPem, requestId: value.requestId, result: value.result });
  const valid = signedFrame();
  assert.equal(verifyMessage(valid.publicKeyPem, valid.result.headers['x-omega-frame-signature'], 'OMEGA-V2/HOST/VIEW_FRAME', valid.fields), true);
  assert.equal(verifyMessage(valid.publicKeyPem, valid.result.headers['x-omega-response-signature'], 'OMEGA-V2/HOST/RESPONSE', valid.response), true);
  assert.doesNotThrow(() => validate(valid));
  const attacks = [
    value => { value.result.headers['x-omega-session-id'] = crypto.randomUUID(); },
    value => { value.result.headers['x-omega-remote-device-id'] = `ov2h-${crypto.randomUUID()}`; },
    value => { value.result.headers['x-omega-stream-id'] = crypto.randomUUID(); },
    value => { value.stateView.lastSequence = 1; },
    value => { value.stateView.recentFrameIds.add(value.result.headers['x-omega-frame-id']); },
    value => { value.result.body = Buffer.from(value.result.body); value.result.body[40] ^= 1; },
    value => { value.result.headers['content-type'] = 'image/jpeg'; },
    value => { value.result.body = Buffer.from('invalid png'); },
    value => { value.result.body = Buffer.alloc(OMEGA_V2_VIEW_LIMITS.maxFrameBytes + 1); },
  ];
  for (const mutate of attacks) {
    const value = signedFrame();
    mutate(value);
    assert.throws(() => validate(value), /INVALID_FRAME/);
  }
});
