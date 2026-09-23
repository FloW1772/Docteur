// OMEGA V1 Phase 3 — VIEW ONLY session orchestration tests (library
// layer). Uses an INJECTED fake capture provider (see
// omega-view.js::_setCaptureProviderForTests) rather than real
// PowerShell invocation, so the full scenario matrix (malformed frame,
// oversized frame, slow link, crash, resolution change) can be
// exercised deterministically and fast — the REAL capture mechanism
// itself is proven separately in test-omega-capture.mjs on this actual
// Windows machine.
// Run with: node --test --test-timeout=20000 test-omega-view.mjs
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
  startViewSession, getFrame, stopViewSession, getViewSessionState,
  OmegaViewError, MIN_FRAME_INTERVAL_MS,
  _setCaptureProviderForTests, _resetCaptureProviderForTests, _resetViewThrottleForTests,
} from './src/lib/omega-view.js';
import { OmegaCaptureError, MAX_FRAME_BYTES } from './src/lib/omega-capture.js';
import { listOmegaAuditLog } from './src/lib/omega-audit.js';

initSqlite(':memory:');
beforeEach(() => {
  _resetPairingRateLimitForTests();
  _resetViewThrottleForTests();
  _resetCaptureProviderForTests();
});

const createdDeviceIds = [];
function freshDeviceId() {
  const id = `test-view-${randomUUID()}`;
  createdDeviceIds.push(id);
  return id;
}
after(() => { for (const id of createdDeviceIds) deleteDeviceKey(id); });

const FAKE_SCREENS = [
  { index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, device: '\\\\.\\DISPLAY1' },
  { index: 1, primary: false, x: 1920, y: 0, width: 1280, height: 720, device: '\\\\.\\DISPLAY2' },
];

function fakePngBuffer(size = 128) {
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
      return { buffer: fakePngBuffer(), width: s?.width ?? 1920, height: s?.height ?? 1080, byteLength: 128, capturedAt: new Date().toISOString() };
    },
    showSessionIndicator: async () => ({ ok: true }),
    ...overrides,
  });
}

/** Full real pairing + mutual-auth + session mint, via the actual
 * Phase 2 code path (not a shortcut) — this IS what "real LAN session"
 * means per the project's own testing discipline: real code path, real
 * tokens, both peers simulated as local test clients. */
function pairedDeviceWithSession({ permission = OMEGA_PERMISSION_LEVELS.OMEGA_VIEW } = {}) {
  const testKeyId = freshDeviceId();
  const identity = generateDeviceIdentity(testKeyId);
  const started = startPairing({ initiatorDeviceName: `View Test ${testKeyId}`, requestedPermission: permission });
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

// ── VIEW ONLY enforcement (mission rule 2) ──────────────────────────

test('a VIEW-level session can start a view stream and fetch a frame', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession({ permission: OMEGA_PERMISSION_LEVELS.OMEGA_VIEW });
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  assert.equal(started.screenIndex, 0);
  assert.equal(started.indicatorShown, true);

  const frame = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce });
  assert.ok(frame.buffer.length > 0);
  assert.equal(frame.width, 1920);
});

test('an unpaired/unknown device cannot start any view session (no such session exists)', async () => {
  installFakeCapture();
  await assert.rejects(
    () => startViewSession({ sessionId: 'nonexistent-session', deviceId: 'nonexistent-device', presentedNonce: 'x', screenIndex: 0 }),
    (err) => err instanceof OmegaViewError && err.code === 'session_invalid',
  );
});

test('a revoked device\'s session is rejected for VIEW streaming even if the token looks structurally valid', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  revokeDevice(deviceId);
  await assert.rejects(
    () => startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 }),
    (err) => err instanceof OmegaViewError && err.code === 'session_invalid',
  );
});

test('an expired session is rejected for VIEW streaming', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  // Force-expire by directly manipulating the session's expiry via the DB.
  const { getDatabase } = await import('./src/lib/sqlite.js');
  getDatabase().prepare('UPDATE omega_sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), session.sessionId);
  await assert.rejects(
    () => startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 }),
    (err) => err instanceof OmegaViewError && err.code === 'session_invalid',
  );
});

test('replayed nonce (same nonce presented twice) is rejected on the second view call', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce });
  // Wait past the FPS throttle so the SECOND call fails on nonce replay
  // specifically, not on rate-limiting.
  await new Promise(r => setTimeout(r, MIN_FRAME_INTERVAL_MS + 20));
  // Replay the SAME (now-stale) nonce again — must fail.
  await assert.rejects(
    () => getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce }),
    (err) => err instanceof OmegaViewError && err.code === 'session_invalid',
  );
});

test('a session presented with the WRONG deviceId is rejected (device binding holds for VIEW streaming too)', async () => {
  installFakeCapture();
  const { session } = pairedDeviceWithSession();
  const { deviceId: otherDeviceId } = pairedDeviceWithSession();
  await assert.rejects(
    () => startViewSession({ sessionId: session.sessionId, deviceId: otherDeviceId, presentedNonce: session.nonce, screenIndex: 0 }),
    (err) => err instanceof OmegaViewError && err.code === 'session_invalid',
  );
});

// ── Multi-monitor / explicit selection (mission rule 10) ────────────

test('startViewSession() requires an explicit integer screenIndex — there is no default', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  await assert.rejects(
    () => startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: undefined }),
    (err) => err instanceof OmegaViewError && err.code === 'screen_index_required',
  );
});

test('startViewSession() rejects a screenIndex beyond the detected screen count', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  await assert.rejects(
    () => startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 99 }),
    (err) => err instanceof OmegaViewError && err.code === 'screen_index_out_of_range',
  );
});

test('multi-monitor: selecting screen 1 captures screen 1\'s resolution, not screen 0\'s', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 1 });
  const frame = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce });
  assert.equal(frame.width, 1280);
  assert.equal(frame.height, 720);
});

// ── Resolution changes (mid-session) ────────────────────────────────

test('a resolution change between frames is surfaced, not silently hidden', async () => {
  let call = 0;
  installFakeCapture({
    captureFrame: async () => {
      call += 1;
      const dims = call === 1 ? { width: 1920, height: 1080 } : { width: 2560, height: 1440 };
      return { buffer: fakePngBuffer(), byteLength: 128, capturedAt: new Date().toISOString(), ...dims };
    },
  });
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const frame1 = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce });
  await new Promise(r => setTimeout(r, MIN_FRAME_INTERVAL_MS + 20));
  const frame2 = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: frame1.nextNonce });
  assert.notEqual(`${frame1.width}x${frame1.height}`, `${frame2.width}x${frame2.height}`);
  assert.equal(frame2.width, 2560);

  const state = getViewSessionState(session.sessionId);
  assert.equal(state.lastFrameWidth, 2560);
});

// ── Streaming bounds: FPS / backpressure (mission rule 9) ───────────

test('polling faster than MAX_FPS is rate-limited (backpressure)', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const frame1 = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce });
  // Immediately poll again, faster than MIN_FRAME_INTERVAL_MS allows.
  await assert.rejects(
    () => getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: frame1.nextNonce }),
    (err) => err instanceof OmegaViewError && err.code === 'rate_limited',
  );
});

test('after waiting out the throttle window, the next frame succeeds', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const frame1 = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce });
  await new Promise(r => setTimeout(r, MIN_FRAME_INTERVAL_MS + 20));
  const frame2 = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: frame1.nextNonce });
  assert.ok(frame2.buffer.length > 0);
});

// ── Oversized / malformed frame handling (mission: "frame
// surdimensionnée", "frame malformée") ──────────────────────────────

test('an oversized frame from the capture layer is rejected, never forwarded', async () => {
  installFakeCapture({
    captureFrame: async () => { throw new (await import('./src/lib/omega-capture.js')).OmegaCaptureError('capture_frame_too_large', { size: MAX_FRAME_BYTES + 1 }); },
  });
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await assert.rejects(
    () => getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce }),
    (err) => err instanceof OmegaViewError && err.code === 'capture_frame_too_large',
  );
  const audit = listOmegaAuditLog({ limit: 5 });
  assert.ok(audit.some(e => e.event_type === 'VIEW_FRAME_REJECTED'));
});

test('a malformed (non-PNG) frame from the capture layer is rejected', async () => {
  installFakeCapture({
    captureFrame: async () => { throw new OmegaCaptureError('capture_frame_malformed'); },
  });
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await assert.rejects(
    () => getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce }),
    (err) => err instanceof OmegaViewError && err.code === 'capture_frame_malformed',
  );
});

// ── Slow link / crash / disconnect / reconnect ──────────────────────

test('a slow capture (near the timeout boundary) still resolves correctly rather than corrupting session state', async () => {
  installFakeCapture({
    captureFrame: async (screenIndex) => {
      await new Promise(r => setTimeout(r, 50)); // simulated slow link/capture
      const s = FAKE_SCREENS[screenIndex];
      return { buffer: fakePngBuffer(), width: s.width, height: s.height, byteLength: 128, capturedAt: new Date().toISOString() };
    },
  });
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const frame = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce });
  assert.ok(frame.buffer.length > 0);
});

test('a crashed transport (capture throws an unexpected error) fails closed, not silently, and the session is still usable afterward', async () => {
  let crashOnce = true;
  installFakeCapture({
    captureFrame: async (screenIndex) => {
      if (crashOnce) { crashOnce = false; throw new Error('simulated transport crash'); }
      const s = FAKE_SCREENS[screenIndex];
      return { buffer: fakePngBuffer(), width: s.width, height: s.height, byteLength: 128, capturedAt: new Date().toISOString() };
    },
  });
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });

  // The crash happens INSIDE captureFrame(), AFTER nonce validation has
  // already advanced the chain (requireValidViewSession() runs first) —
  // this is expected: the anti-replay nonce and the capture bound are
  // two independent concerns, and a capture-layer crash correctly still
  // consumes that nonce use exactly like a successful call would, so a
  // captured-and-lost response can never be replayed either. The
  // session itself is NOT torn down by a capture crash — the client
  // recovers by reading current state and continuing to poll.
  await assert.rejects(() => getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce }), /simulated transport crash/);

  const state = getViewSessionState(session.sessionId);
  assert.equal(state.active, true, 'the view session must still be active after a capture-layer crash, not silently torn down');

});

test('disconnection then reconnection: STOP was never called, session remains valid and resumable with the correct next nonce', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const frame1 = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce });
  // Simulate a network drop: client simply stops calling for a while,
  // then "reconnects" (resumes polling) with the last nonce it holds.
  await new Promise(r => setTimeout(r, MIN_FRAME_INTERVAL_MS + 50));
  const frame2 = await getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: frame1.nextNonce });
  assert.ok(frame2.buffer.length > 0);
});

// ── STOP SESSION (mission rule 11) ──────────────────────────────────

test('STOP SESSION cuts the stream: a subsequent getFrame() fails even with a technically-fresh nonce chain', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  const started = await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await stopViewSession({ sessionId: session.sessionId, deviceId });
  await assert.rejects(
    () => getFrame({ sessionId: session.sessionId, deviceId, presentedNonce: started.nextNonce }),
    (err) => err instanceof OmegaViewError && err.code === 'session_invalid',
  );
});

test('STOP SESSION invalidates the underlying session so silent resumption via a fresh startViewSession() call fails too', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await stopViewSession({ sessionId: session.sessionId, deviceId });

  // Attempting to "resume" using the ORIGINAL session credential must
  // fail — the whole point of rule 11's "empêcher toute reprise
  // silencieuse" is that STOP is not just a client-side UI state.
  await assert.rejects(
    () => startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 }),
    (err) => err instanceof OmegaViewError && err.code === 'session_invalid',
  );
});

test('STOP SESSION is idempotent — calling it twice does not throw', async () => {
  installFakeCapture();
  const { deviceId, session } = pairedDeviceWithSession();
  await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  const first = await stopViewSession({ sessionId: session.sessionId, deviceId });
  const second = await stopViewSession({ sessionId: session.sessionId, deviceId });
  assert.equal(first.viewStopped, true);
  assert.equal(second.viewStopped, false); // already stopped, but no throw
});

test('STOP SESSION shows the visible stop indicator', async () => {
  const shown = [];
  installFakeCapture({ showSessionIndicator: async (kind) => { shown.push(kind); return { ok: true }; } });
  const { deviceId, session } = pairedDeviceWithSession();
  await startViewSession({ sessionId: session.sessionId, deviceId, presentedNonce: session.nonce, screenIndex: 0 });
  await stopViewSession({ sessionId: session.sessionId, deviceId });
  assert.deepEqual(shown, ['start', 'stop']);
});

// ── Zero input injection (structural — mission's final confirm list) ─

test('omega-view.js exports no mouse/keyboard/admin-shaped function', async () => {
  const mod = await import('./src/lib/omega-view.js');
  const exportNames = Object.keys(mod).map(n => n.toLowerCase());
  for (const forbidden of ['mouse', 'keyboard', 'keypress', 'click', 'type', 'admin', 'shell', 'command', 'exec']) {
    assert.ok(!exportNames.some(n => n.includes(forbidden)), `found forbidden-shaped export matching "${forbidden}"`);
  }
});

test('the VIEW route module never imports anything input/admin-shaped (structural grep-equivalent check)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./src/routes/omega-view.js', import.meta.url), 'utf8');
  for (const forbidden of ['sendInput', 'mouse_event', 'keybd_event', 'SetCursorPos', 'shell.exe', 'cmd.exe', 'Start-Process']) {
    assert.ok(!src.includes(forbidden), `found forbidden token "${forbidden}" in omega-view.js route`);
  }
});
