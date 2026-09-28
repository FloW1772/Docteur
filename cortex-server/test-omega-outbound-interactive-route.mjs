import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createOmegaOutboundRoute } from './src/routes/omega-outbound.js';
import { ensureOmegaV2Identity } from './src/lib/omega-outbound-identity.js';
import { upsertInboundTrust, revokeInboundTrust, insertSession, getSession, listAudit } from './src/lib/omega-outbound-store.js';
import { identityFingerprint, requestFields, randomNonce, signMessage } from './src/lib/omega-outbound-protocol.js';

// Host adapter security matrix for OMEGA V2 INTERACTIVE. In-memory SQLite only;
// the input provider is a recorder, so no real SendInput is ever issued.
initSqlite(':memory:');
const screens = [{ index: 0, x: 0, y: 0, width: 200, height: 100, primary: true }];
const executed = [];
const released = [];
const viewStops = [];
const viewing = new Map();
const outboundViewManager = {
  status: sessionId => viewing.get(sessionId) ?? { status: 'STOPPED' },
  stop: async (sessionId, reason) => { viewStops.push({ sessionId, reason }); viewing.delete(sessionId); },
  onStop: () => {}, start: async () => { throw new Error('unused'); }, frame: async () => { throw new Error('unused'); },
};
const interactiveProvider = {
  listScreens: async () => screens,
  showSessionIndicator: async () => ({ ok: true }),
  executeSemanticInput: async prepared => { executed.push(prepared); return { requested: 1, sent: 1 }; },
  releaseSemanticInput: async (kind, value) => { released.push(`${kind}:${value}`); return { requested: 1, sent: 1 }; },
};
const app = new Hono();
app.route('/api', createOmegaOutboundRoute({ certificateFingerprint: 'aa'.repeat(32), isLocal: () => false, isTls: () => true,
  outboundViewManager, interactiveProvider }));
const localApp = new Hono();
localApp.route('/api', createOmegaOutboundRoute({ certificateFingerprint: 'aa'.repeat(32), isLocal: () => true, isTls: () => true,
  outboundViewManager, interactiveProvider }));
const host = ensureOmegaV2Identity('HOST');

function controller(maxPermission = 'ADMIN') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const deviceId = `ov2c-${crypto.randomUUID()}`;
  upsertInboundTrust({ controllerDeviceId: deviceId, publicKeyPem, identityFingerprint: identityFingerprint(publicKeyPem),
    maxPermission, createdAt: new Date().toISOString() });
  return { deviceId, privateKey };
}

function session(ctrl, permission, { expiresInMs = 60_000, streamId = 'stream-1' } = {}) {
  const sessionId = crypto.randomUUID();
  insertSession({ sessionId, direction: 'INBOUND', localDeviceId: host.deviceId, remoteDeviceId: ctrl.deviceId, permission,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInMs).toISOString(), status: 'CONNECTED' });
  viewing.set(sessionId, { status: 'VIEWING', streamId, screenIndex: 0 });
  return { sessionId, ctrl, streamId };
}

function envelope(target, action, payload, overrides = {}) {
  const path = `/api/omega-v2/sessions/${target.sessionId}/${action}`;
  const fields = requestFields({ localDeviceId: overrides.localDeviceId ?? target.ctrl.deviceId, remoteDeviceId: host.deviceId,
    sessionId: overrides.sessionId ?? target.sessionId, requestId: crypto.randomUUID(), timestamp: overrides.timestamp ?? new Date().toISOString(),
    nonce: overrides.nonce ?? randomNonce(), method: 'POST', path, bodyBytes: Buffer.from(JSON.stringify(payload), 'utf8') });
  const signature = signMessage(overrides.signingKey ?? target.ctrl.privateKey, 'OMEGA-V2/CONTROLLER/REQUEST', fields);
  return { payload, auth: { ...fields, signature } };
}

async function post(target, action, payload, overrides = {}, raw) {
  const response = await app.request(`https://localhost/api/omega-v2/sessions/${target.sessionId}/${action}`, {
    method: 'POST', headers: { 'content-type': overrides.contentType ?? 'application/json' },
    body: raw ?? JSON.stringify(envelope(target, action, payload, overrides)),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: response.status, error: body?.payload?.error ?? body?.error, body };
}

const input = (target, extra) => ({ operationId: crypto.randomUUID(), streamId: target.streamId, screenIndex: 0, ...extra });
async function startInteractive(target) {
  const result = await post(target, 'interactive/start', { streamId: target.streamId, screenIndex: 0 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}

test('VIEW-only session cannot start INTERACTIVE nor send any input category', async () => {
  const target = session(controller('ADMIN'), 'VIEW');
  const before = executed.length;
  assert.equal((await post(target, 'interactive/start', { streamId: target.streamId, screenIndex: 0 })).error, 'PERMISSION_DENIED');
  for (const [category, extra] of [['pointer', { x: 0.5, y: 0.5 }], ['button', { button: 'LEFT', state: 'DOWN', x: 0.5, y: 0.5 }],
    ['wheel', { delta: 1, x: 0.5, y: 0.5 }], ['key', { key: 'KeyA', state: 'DOWN' }]]) {
    const result = await post(target, `input/${category}`, input(target, extra));
    assert.equal(result.status, 403); assert.equal(result.error, 'PERMISSION_DENIED');
  }
  assert.equal(executed.length, before);
});

test('INTERACTIVE session: signed input accepted, replay, stale, wrong session/device/stream rejected', async () => {
  const ctrl = controller('INTERACTIVE');
  const target = session(ctrl, 'INTERACTIVE');
  await startInteractive(target);
  const accepted = await post(target, 'input/pointer', input(target, { x: 0.25, y: 0.75 }));
  assert.equal(accepted.status, 200); assert.equal(accepted.body.payload.accepted, true);
  assert.ok(accepted.body.auth.signature, 'response is host-signed');
  const before = executed.length;

  const replayBody = JSON.stringify(envelope(target, 'input/key', input(target, { key: 'KeyA', state: 'DOWN' })));
  assert.equal((await post(target, 'input/key', null, {}, replayBody)).status, 200);
  const replayed = await post(target, 'input/key', null, {}, replayBody);
  assert.equal(replayed.status, 409); assert.equal(replayed.error, 'REPLAY_REJECTED');
  const sameNonce = JSON.parse(replayBody).auth.nonce;
  assert.equal((await post(target, 'input/key', input(target, { key: 'KeyB', state: 'DOWN' }), { nonce: sameNonce })).error, 'REPLAY_REJECTED');

  const operationId = crypto.randomUUID();
  assert.equal((await post(target, 'input/key', { ...input(target, { key: 'KeyC', state: 'DOWN' }), operationId })).status, 200);
  assert.equal((await post(target, 'input/key', { ...input(target, { key: 'KeyD', state: 'DOWN' }), operationId })).error, 'OPERATION_REPLAYED');

  assert.equal((await post(target, 'input/key', input(target, { key: 'KeyE', state: 'DOWN' }), { timestamp: new Date(Date.now() - 120_000).toISOString() })).error, 'AUTH_FAILURE');
  assert.equal((await post(target, 'input/key', input(target, { key: 'KeyE', state: 'DOWN' }), { timestamp: new Date(Date.now() + 120_000).toISOString() })).error, 'AUTH_FAILURE');
  const other = session(controller('INTERACTIVE'), 'INTERACTIVE');
  assert.equal((await post(target, 'input/key', input(target, { key: 'KeyE', state: 'DOWN' }), { sessionId: other.sessionId })).error, 'AUTH_FAILURE');
  assert.equal((await post(target, 'input/key', input(target, { key: 'KeyE', state: 'DOWN' }), { localDeviceId: other.ctrl.deviceId })).error, 'AUTH_FAILURE');
  assert.equal((await post(target, 'input/key', input(target, { key: 'KeyE', state: 'DOWN' }), { signingKey: other.ctrl.privateKey })).error, 'AUTH_FAILURE');
  const unknownSession = { ...target, sessionId: crypto.randomUUID() };
  assert.equal((await post(unknownSession, 'input/key', input(target, { key: 'KeyE', state: 'DOWN' }))).status, 404);
  assert.equal((await post(target, 'input/key', { ...input(target, { key: 'KeyE', state: 'DOWN' }), streamId: 'stream-other' })).error, 'WRONG_STREAM');
  assert.equal((await post(target, 'input/key', { ...input(target, { key: 'KeyE', state: 'DOWN' }), screenIndex: 1 })).error, 'WRONG_SCREEN');
  assert.equal(executed.length, before + 2, 'only the two genuine key downs executed');
  assert.equal((await post(target, 'interactive/stop', { streamId: target.streamId })).status, 200);
  assert.ok(released.includes('key:KeyA') && released.includes('key:KeyC'));
});

test('payload matrix: enums, huge values, prototype pollution, oversized, content type and malformed body', async () => {
  const target = session(controller('ADMIN'), 'ADMIN');
  await startInteractive(target);
  const before = executed.length;
  const cases = [
    ['button', { button: 'X1', state: 'DOWN', x: 0.5, y: 0.5 }, 'BUTTON_INVALID'],
    ['key', { key: 'Escape', state: 'DOWN' }, 'KEY_INVALID'],
    ['key', { key: 'NumpadEnter', state: 'DOWN' }, 'KEY_INVALID'],
    ['key', { key: 27, state: 'DOWN' }, 'KEY_INVALID'],
    ['wheel', { delta: 1_000_000, x: 0.5, y: 0.5 }, 'WHEEL_DELTA_INVALID'],
    ['pointer', { x: 1e300, y: 1e300 }, 'POINTER_OUT_OF_BOUNDS'],
    ['pointer', { x: -1, y: 0.5 }, 'POINTER_OUT_OF_BOUNDS'],
    ['pointer', { x: '0.5', y: 0.5 }, 'POINTER_OUT_OF_BOUNDS'],
    ['pointer', { x: 0.5, y: 0.5, text: 'calc' }, 'INPUT_INVALID'],
  ];
  for (const [category, extra, code] of cases) {
    const result = await post(target, `input/${category}`, input(target, extra));
    assert.equal(result.error, code, `${category} ${JSON.stringify(extra)}`);
  }
  const polluted = JSON.parse(`{"operationId":"${crypto.randomUUID()}","streamId":"${target.streamId}","screenIndex":0,"key":"KeyA","state":"DOWN","__proto__":{"polluted":true}}`);
  assert.equal((await post(target, 'input/key', polluted)).error, 'INPUT_INVALID');
  assert.equal(({}).polluted, undefined);
  const huge = await post(target, 'input/key', input(target, { key: 'KeyA', state: 'DOWN', pad: 'x'.repeat(20_000) }));
  assert.equal(huge.status, 413);
  assert.equal((await post(target, 'input/key', input(target, { key: 'KeyA', state: 'DOWN' }), { contentType: 'text/plain' })).status, 415);
  assert.equal((await post(target, 'input/key', input(target, { key: 'KeyA', state: 'DOWN' }), { contentType: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post(target, 'input/key', null, {}, '{"payload":')).status, 400);
  assert.equal((await post(target, 'input/key', null, {}, '[]')).status, 400);
  assert.equal((await post(target, 'input/key', null, {}, 'null')).status, 400);
  assert.equal(executed.length, before, 'no rejected payload reached SendInput');
  await post(target, 'interactive/stop', { streamId: target.streamId });
});

test('expired session rejects input and releases held input immediately', async () => {
  const target = session(controller('INTERACTIVE'), 'INTERACTIVE');
  await startInteractive(target);
  assert.equal((await post(target, 'input/key', input(target, { key: 'AltLeft', state: 'DOWN' }))).status, 200);
  getDatabase().prepare('UPDATE omega_v2_sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), target.sessionId);
  released.length = 0;
  const result = await post(target, 'input/key', input(target, { key: 'KeyA', state: 'DOWN' }));
  assert.equal(result.status, 410); assert.equal(result.error, 'SESSION_EXPIRED');
  assert.deepEqual(released, ['key:AltLeft'], 'held key released at once, not after the lease');
  assert.equal(getSession(target.sessionId).status, 'EXPIRED');
  assert.ok(viewStops.some(value => value.sessionId === target.sessionId), 'VIEW stopped too');
});

test('revoked controller rejects input and releases held input immediately', async () => {
  const ctrl = controller('INTERACTIVE');
  const target = session(ctrl, 'INTERACTIVE');
  await startInteractive(target);
  assert.equal((await post(target, 'input/button', input(target, { button: 'RIGHT', state: 'DOWN', x: 0.5, y: 0.5 }))).status, 200);
  revokeInboundTrust(ctrl.deviceId);
  released.length = 0;
  const result = await post(target, 'input/pointer', input(target, { x: 0.5, y: 0.5 }));
  assert.equal(result.status, 403); assert.equal(result.error, 'DEVICE_REVOKED');
  assert.deepEqual(released, ['button:RIGHT']);
});

test('remote session STOP kills INTERACTIVE, releases input and rejects later input', async () => {
  const target = session(controller('INTERACTIVE'), 'INTERACTIVE');
  await startInteractive(target);
  assert.equal((await post(target, 'input/key', input(target, { key: 'ShiftRight', state: 'DOWN' }))).status, 200);
  released.length = 0;
  const stopped = await post(target, 'stop', {});
  assert.equal(stopped.status, 200); assert.equal(stopped.body.payload.status, 'TERMINATED');
  assert.deepEqual(released, ['key:ShiftRight']);
  const before = executed.length;
  const late = await post(target, 'input/key', input(target, { key: 'KeyA', state: 'DOWN' }));
  assert.equal(late.status, 409); assert.equal(late.error, 'REMOTE_STOPPED');
  assert.equal(executed.length, before);
});

test('no text channel, command, RPC or ADMIN action route exists (local API and host adapter)', async () => {
  const target = session(controller('ADMIN'), 'ADMIN');
  const forbidden = ['input/text', 'input/sendText', 'input/typeText', 'input/pasteText', 'input/raw', 'input/rawInput',
    'input/clipboard', 'sendText', 'typeText', 'pasteText', 'sendCommand', 'execute', 'rpc', 'rawInput', 'clipboard',
    'file', 'upload', 'download', 'admin', 'admin/lock', 'admin/logoff', 'admin/restart', 'admin/shutdown',
    'lock', 'logoff', 'restart', 'shutdown', 'sleep', 'hibernate', 'interactive/admin', 'interactive/execute'];
  for (const action of forbidden) {
    const remote = await post(target, action, { streamId: target.streamId });
    assert.equal(remote.status, 404, `host adapter ${action}`);
    const local = await localApp.request(`http://localhost/api/omega/outbound/sessions/${target.sessionId}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(local.status, 404, `local API ${action}`);
  }
});

test('audit stays aggregated: no key names, coordinates or typed content persisted', async () => {
  const target = session(controller('INTERACTIVE'), 'INTERACTIVE');
  await startInteractive(target);
  for (const key of ['KeyP', 'KeyA', 'KeyS', 'KeyW']) {
    await post(target, 'input/key', input(target, { key, state: 'DOWN' }));
    await post(target, 'input/key', input(target, { key, state: 'UP' }));
  }
  await post(target, 'input/key', input(target, { key: 'NotAKey', state: 'DOWN' }));
  await post(target, 'input/pointer', input(target, { x: 0.123456, y: 0.654321 }));
  await post(target, 'interactive/stop', { streamId: target.streamId });
  const rows = getDatabase().prepare('SELECT * FROM omega_v2_audit WHERE session_id = ?').all(target.sessionId);
  const serialized = JSON.stringify(rows);
  for (const secret of ['KeyP', 'KeyW', 'NotAKey', '0.123456', '0.654321', 'PASW']) assert.equal(serialized.includes(secret), false, secret);
  const stop = rows.find(row => row.event_type === 'OUTBOUND_INTERACTIVE_STOPPED');
  assert.deepEqual(JSON.parse(stop.detail).counts, { pointer: 1, button: 0, wheel: 0, key: 8 });
  assert.ok(listAudit(100).length > 0);
  const tables = getDatabase().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'omega_v2_%'").all().map(row => row.name);
  assert.deepEqual(tables.filter(name => /input|key|frame|screen|clip/i.test(name)), [], 'no input/frame persistence table');
});
