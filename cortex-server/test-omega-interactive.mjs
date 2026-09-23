// OMEGA V1 Phase 4 — OMEGA_INTERACTIVE session orchestration tests
// (library layer). Uses an INJECTED fake input provider (see
// omega-interactive.js::_setInputProviderForTests) rather than real
// PowerShell/SendInput invocation, so the full scenario matrix (VIEW
// cannot inject, revoked device, replay, malformed input, oversized
// batch, rate limit, out-of-screen coords, STOP SESSION) can be
// exercised deterministically and fast — the REAL SendInput mechanism
// itself is proven separately in test-omega-input.mjs on this actual
// Windows machine.
// Run with: node --test --test-timeout=20000 test-omega-interactive.mjs
import './test-setup.mjs';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initSqlite } from './src/lib/sqlite.js';
import {
  startPairing, verifyPairingCode, approvePairing, issueChallenge, verifyDeviceChallenge,
  _resetPairingRateLimitForTests, OMEGA_PERMISSION_LEVELS,
} from './src/lib/omega-pairing.js';
import { generateDeviceIdentity, signWithDeviceKey, deleteDeviceKey } from './src/lib/omega-identity.js';
import { revokeDevice } from './src/lib/omega-devices.js';
import { createSession } from './src/lib/omega-session.js';
import {
  startInteractiveSession, submitInputBatch, stopInteractiveSession, getInteractiveSessionState,
  OmegaInteractiveError, MIN_REQUEST_INTERVAL_MS, MAX_EVENTS_PER_BATCH,
  _setInputProviderForTests, _resetInputProviderForTests, _resetInteractiveThrottleForTests,
} from './src/lib/omega-interactive.js';
import { OMEGA_INPUT_EVENT_TYPES } from './src/lib/omega-input.js';
import { listOmegaAuditLog } from './src/lib/omega-audit.js';

initSqlite(':memory:');
beforeEach(() => {
  _resetPairingRateLimitForTests();
  _resetInteractiveThrottleForTests();
  _resetInputProviderForTests();
});

const createdDeviceIds = [];
function freshDeviceId() {
  const id = `test-interactive-${randomUUID()}`;
  createdDeviceIds.push(id);
  return id;
}
after(() => { for (const id of createdDeviceIds) deleteDeviceKey(id); });

const FAKE_SCREENS = [
  { index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, device: '\\\\.\\DISPLAY1' },
  { index: 1, primary: false, x: 1920, y: 0, width: 1280, height: 720, device: '\\\\.\\DISPLAY2' },
];

function installFakeInput(overrides = {}) {
  _setInputProviderForTests({
    listScreens: async () => FAKE_SCREENS,
    sendInputBatch: async (tuples) => ({ requested: tuples.length, sent: tuples.length, results: tuples.map(() => ({ ok: true, sent: 1 })) }),
    showSessionIndicator: async () => ({ ok: true }),
    ...overrides,
  });
}

/** Full real pairing + mutual-auth + session mint, via the actual
 * Phase 2 code path — same discipline as test-omega-view.mjs. */
function pairedDeviceWithSession({ permission = OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE } = {}) {
  const testKeyId = freshDeviceId();
  const identity = generateDeviceIdentity(testKeyId);
  const started = startPairing({ initiatorDeviceName: `Interactive Test ${testKeyId}`, requestedPermission: permission });
  verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem });
  const approved = approvePairing(started.pairingId);
  const deviceId = approved.deviceId;

  const challenge = issueChallenge();
  const signature = signWithDeviceKey(testKeyId, challenge).toString('base64');
  const auth = verifyDeviceChallenge({ deviceId, challenge, signatureB64: signature });
  assert.equal(auth.valid, true);

  const session = createSession({ deviceId });
  return { deviceId, testKeyId, session };
}

function moveEvent(x = 100, y = 100) { return { type: OMEGA_INPUT_EVENT_TYPES.MOVE, x, y }; }

// ── INTERACTIVE permission enforcement (mission rules 2/3) ──────────

test('an INTERACTIVE-level session can start an interactive session and submit a mouse move', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE });
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  assert.equal(started.screenIndex, 0);
  assert.equal(started.indicatorShown, true);

  const result = await submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent()] });
  assert.equal(result.requested, 1);
  assert.equal(result.sent, 1);
});

test('a VIEW-level session CANNOT start an interactive session — refused with permission_insufficient', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_VIEW });
  await assert.rejects(
    () => startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'permission_insufficient',
  );
  const audit = listOmegaAuditLog({ limit: 5 });
  assert.ok(audit.some(e => e.event_type === 'INTERACTIVE_PERMISSION_DENIED'));
});

test('a VIEW-level session CANNOT submit input even by calling submitInputBatch directly (no interactive session was ever started)', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_VIEW });
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0, events: [moveEvent()] }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'permission_insufficient',
  );
});

test('an ADMIN-level device (ceiling higher than INTERACTIVE) also passes the INTERACTIVE gate (hierarchical capability)', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN });
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  assert.equal(started.screenIndex, 0);
});

// ── Device identity binding / revocation / replay / wrong identity ──

test('an unpaired/unknown device cannot start any interactive session', async () => {
  installFakeInput();
  await assert.rejects(
    () => startInteractiveSession({ sessionId: 'nonexistent-session', deviceId: 'nonexistent-device', presentedNonce: 'x', screenIndex: 0 }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'session_invalid',
  );
});

test('a revoked device is rejected for INTERACTIVE input, even with a structurally-valid token', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  revokeDevice(deviceId);
  await assert.rejects(
    () => startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'session_invalid',
  );
});

test('a device revoked MID-SESSION is rejected on its next input submission', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  revokeDevice(deviceId);
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent()] }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'session_invalid',
  );
});

test('an expired session is rejected for INTERACTIVE input', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const { getDatabase } = await import('./src/lib/sqlite.js');
  getDatabase().prepare('UPDATE omega_sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), session.sessionId);
  await assert.rejects(
    () => startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'session_invalid',
  );
});

test('replayed nonce (same nonce presented twice) is rejected on the second input call', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const first = await submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent()] });
  await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS + 20));
  // Replay the SAME (now-stale) nonce again — must fail even though we
  // waited past the rate-limit window, proving this is a REPLAY
  // rejection, not a rate-limit rejection.
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent()] }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'session_invalid',
  );
  void first;
});

test('a session presented with the WRONG deviceId is rejected (device binding holds for INTERACTIVE input too)', async () => {
  installFakeInput();
  const { session } = pairedDeviceWithSession();
  const { deviceId: otherDeviceId } = pairedDeviceWithSession();
  await assert.rejects(
    () => startInteractiveSession({ sessionId: session.sessionId, deviceId: otherDeviceId, presentedNonce: session.nonce, screenIndex: 0 }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'session_invalid',
  );
});

// ── Malformed input / disallowed keys / out-of-screen coords ────────

test('submitInputBatch rejects a batch containing one malformed event — fail-closed on the WHOLE batch, not partial', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await assert.rejects(
    () => submitInputBatch({
      sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0,
      events: [moveEvent(10, 10), { type: OMEGA_INPUT_EVENT_TYPES.KEY_DOWN, vk: 0xE7 }], // disallowed vk
    }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'vk_not_allowed',
  );
  const audit = listOmegaAuditLog({ limit: 5 });
  assert.ok(audit.some(e => e.event_type === 'INTERACTIVE_INPUT_REJECTED'));
});

test('submitInputBatch rejects out-of-screen-bounds coordinates', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent(99999, 99999)] }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'coords_out_of_bounds',
  );
});

test('submitInputBatch rejects an invalid vk (not on the keyboard allowlist)', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [{ type: OMEGA_INPUT_EVENT_TYPES.KEY_DOWN, vk: 0xAD }] }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'vk_not_allowed',
  );
});

// ── Multi-monitor: coordinates checked against the SELECTED screen ──

test('multi-monitor: a coordinate valid for screen 1 is rejected when submitted against screen 0\'s selection', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  // 1920 is out of bounds for screen 0 (width 1920, 0-indexed) even
  // though it would be in-bounds if screen 1 were selected instead.
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent(1920, 10)] }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'coords_out_of_bounds',
  );
});

test('multi-monitor: selecting screen 1 and submitting a valid screen-1 coordinate succeeds', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 1 });
  const result = await submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 1, events: [moveEvent(100, 100)] });
  assert.equal(result.sent, 1);
});

// ── Oversized batch / rate limit (mission's own list) ────────────────

test('submitInputBatch rejects a batch larger than MAX_EVENTS_PER_BATCH', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const oversized = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => moveEvent());
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: oversized }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'batch_too_large',
  );
});

test('submitInputBatch rejects an empty batch', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [] }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'batch_empty',
  );
});

test('submitting input faster than the per-session rate limit is rejected (429-equivalent)', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const first = await submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent()] });
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: first.nextNonce, screenIndex: 0, events: [moveEvent()] }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'rate_limited',
  );
  const audit = listOmegaAuditLog({ limit: 5 });
  assert.ok(audit.some(e => e.event_type === 'INTERACTIVE_RATE_LIMITED'));
});

test('after waiting out the rate-limit window, the next input submission succeeds', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const first = await submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent()] });
  await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS + 20));
  const second = await submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: first.nextNonce, screenIndex: 0, events: [moveEvent()] });
  assert.equal(second.sent, 1);
});

// ── Crash transport / UIPI partial success ────────────────────────────

test('a crashed transport (SendInput provider throws) fails closed, session remains usable afterward', async () => {
  let crashOnce = true;
  installFakeInput({
    sendInputBatch: async (tuples) => {
      if (crashOnce) { crashOnce = false; throw new Error('simulated transport crash'); }
      return { requested: tuples.length, sent: tuples.length, results: tuples.map(() => ({ ok: true, sent: 1 })) };
    },
  });
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await assert.rejects(() => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent()] }), /simulated transport crash/);

  const state = getInteractiveSessionState(session.sessionId);
  assert.equal(state.active, true, 'the interactive session must still be active after a transport-layer crash, not silently torn down');
});

test('a UIPI-blocked target (sent < requested) is reported honestly, never silently treated as full success', async () => {
  installFakeInput({
    sendInputBatch: async (tuples) => ({ requested: tuples.length, sent: 0, results: tuples.map(() => ({ ok: true, sent: 0 })) }),
  });
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const result = await submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent()] });
  assert.equal(result.requested, 1);
  assert.equal(result.sent, 0);
});

// ── STOP SESSION (mission rule 11) ────────────────────────────────────

test('STOP SESSION cuts INTERACTIVE capability: a subsequent submitInputBatch() fails even with a fresh nonce', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await stopInteractiveSession({ sessionId: session.sessionId, deviceId });
  await assert.rejects(
    () => submitInputBatch({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce, screenIndex: 0, events: [moveEvent()] }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'session_invalid',
  );
});

test('STOP SESSION invalidates the underlying session so silent resumption fails too', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await stopInteractiveSession({ sessionId: session.sessionId, deviceId });
  await assert.rejects(
    () => startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 }),
    (err) => err instanceof OmegaInteractiveError && err.code === 'session_invalid',
  );
});

test('STOP SESSION is idempotent', async () => {
  installFakeInput();
  const { deviceId, session } = pairedDeviceWithSession();
  await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const first = await stopInteractiveSession({ sessionId: session.sessionId, deviceId });
  const second = await stopInteractiveSession({ sessionId: session.sessionId, deviceId });
  assert.equal(first.interactiveStopped, true);
  assert.equal(second.interactiveStopped, false);
});

test('STOP SESSION shows the visible "interactive_stop" indicator, start shows "interactive_start"', async () => {
  const shown = [];
  installFakeInput({ showSessionIndicator: async (kind) => { shown.push(kind); return { ok: true }; } });
  const { deviceId, session } = pairedDeviceWithSession();
  await startInteractiveSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await stopInteractiveSession({ sessionId: session.sessionId, deviceId });
  assert.deepEqual(shown, ['interactive_start', 'interactive_stop']);
});

// ── Zero admin/shell (structural) ─────────────────────────────────────

test('omega-interactive.js exports no admin/shell-shaped function', async () => {
  const mod = await import('./src/lib/omega-interactive.js');
  const exportNames = Object.keys(mod).map(n => n.toLowerCase());
  for (const forbidden of ['admin', 'shell', 'command', 'exec', 'clipboard', 'file']) {
    assert.ok(!exportNames.some(n => n.includes(forbidden)), `found forbidden-shaped export matching "${forbidden}"`);
  }
});

test('the interactive route module never imports anything admin/shell-shaped', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./src/routes/omega-interactive.js', import.meta.url), 'utf8');
  for (const forbidden of ['shell.exe', 'cmd.exe', 'Start-Process', '-Command', 'eval(']) {
    assert.ok(!src.includes(forbidden), `found forbidden token "${forbidden}" in omega-interactive.js route`);
  }
});

test('XSS-shaped device display name flows through untouched (inert data, never interpreted) for an interactive-capable device', async () => {
  installFakeInput();
  const testKeyId = freshDeviceId();
  const identity = generateDeviceIdentity(testKeyId);
  const xssName = '<script>alert(1)</script>';
  const started = startPairing({ initiatorDeviceName: xssName, requestedPermission: OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE });
  verifyPairingCode({ pairingId: started.pairingId, code: started.code, publicKeyPem: identity.publicKeyPem });
  const approved = approvePairing(started.pairingId);
  const { getOmegaDeviceById } = await import('./src/lib/sqlite.js');
  const row = getOmegaDeviceById(approved.deviceId);
  assert.equal(row.display_name, xssName); // stored verbatim, inert — never interpreted/escaped-differently
});
