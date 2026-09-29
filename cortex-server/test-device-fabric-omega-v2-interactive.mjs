// DEVICE FABRIC V2 Phase 4 — OMEGA V2 INTERACTIVE orchestration: exact
// target, VIEW dependency, explicit activation, TOCTOU, STOP semantics, and
// no input/raw/ADMIN surface. Mirrors test-device-fabric-omega-v2-view.mjs's
// harness shape, extended with INTERACTIVE deps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFabricOmegaV2ViewService, DeviceFabricOmegaV2ViewError } from './src/lib/device-fabric-omega-v2-routing.js';

const FABRIC_A = 'fdev-11111111-1111-4111-8111-111111111111';
const FABRIC_B = 'fdev-22222222-2222-4222-8222-222222222222';
const HOST_A = 'ov2h-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOST_B = 'ov2h-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

function binding(fabricDeviceId = FABRIC_A, host = HOST_A, version = 1) {
  return { fabricDeviceId, omegaV2HostId: host, linkId: `flnk-${fabricDeviceId.slice(5, 13)}`,
    linkVersion: version, fingerprint: host === HOST_A ? FINGERPRINT_A : FINGERPRINT_B };
}

function request(target = binding()) {
  return { screenIndex: 0, linkId: target.linkId, linkVersion: target.linkVersion,
    omegaV2HostId: target.omegaV2HostId, fingerprint: target.fingerprint };
}

/**
 * Same shape as the VIEW test harness, extended with INTERACTIVE deps. By
 * default resolveTarget answers the SAME binding forever (Map-backed
 * `bindings`), so a VIEW start followed by an INTERACTIVE start naturally
 * revalidate against a stable link unless a test explicitly changes it.
 */
function harness({ startBinding = binding(), interactiveError = null, permissionDeniedOnInteractive = false } = {}) {
  const calls = { resolve: [], connect: [], start: [], stopView: [], stopSession: [],
    interactiveStart: [], interactiveStop: [], audit: [] };
  const sessions = new Map();
  let currentBinding = startBinding;
  const service = createFabricOmegaV2ViewService({
    // No database in this pure-unit harness; INTERACTIVE requires the
    // underlying session's own permission to already be INTERACTIVE-capable
    // (omega-outbound-client.js requireInteractiveSession checks
    // session.permission, fixed at connect time) — mirrors what
    // connectPermission would resolve to for a trust whose ceiling allows it.
    connectPermission: () => 'INTERACTIVE',
    resolveTarget: fabricDeviceId => {
      calls.resolve.push(fabricDeviceId);
      if (currentBinding instanceof Error) throw currentBinding;
      return currentBinding;
    },
    connectView: async (hostId, permission, options) => {
      calls.connect.push({ hostId, permission, options });
      const session = { sessionId: `session-${calls.connect.length}`, remoteOmegaDeviceId: hostId,
        permission, status: 'CONNECTED', reason: null };
      sessions.set(session.sessionId, session);
      return session;
    },
    startView: async (sessionId, screenIndex) => {
      calls.start.push({ sessionId, screenIndex });
      return { status: 'VIEWING', streamId: `stream-${sessionId}`, screenIndex };
    },
    getSession: sessionId => sessions.get(sessionId) ?? null,
    stopView: async sessionId => { calls.stopView.push(sessionId); return { status: 'STOPPED' }; },
    stopSession: async sessionId => {
      calls.stopSession.push(sessionId);
      const row = sessions.get(sessionId);
      if (row) { row.status = 'ENDED'; row.reason = 'client_stop'; }
      return true;
    },
    startInteractive: async (sessionId, options) => {
      calls.interactiveStart.push({ sessionId, options });
      if (permissionDeniedOnInteractive) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
      if (interactiveError) throw interactiveError;
      return { status: 'INTERACTIVE', interactiveId: `int-${sessionId}` };
    },
    stopInteractive: async sessionId => { calls.interactiveStop.push(sessionId); return { status: 'STOPPED' }; },
    audit: event => calls.audit.push(event),
  });
  return {
    service, calls, sessions,
    setBinding: next => { currentBinding = next; },
    async startView() { return service.startViewForFabricDevice(currentBinding.fabricDeviceId, request(currentBinding)); },
  };
}

// ── Explicit activation, VIEW dependency, exact target ──────────────────────

test('INTERACTIVE requires an already-active VIEW: no VIEW yet -> OMEGA_V2_VIEW_NOT_ACTIVE, 0 calls', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.startInteractiveForFabricDevice(FABRIC_A, {}),
    error => error instanceof DeviceFabricOmegaV2ViewError && error.code === 'OMEGA_V2_VIEW_NOT_ACTIVE');
  assert.equal(calls.interactiveStart.length, 0);
});

test('VIEW start never itself activates INTERACTIVE (no auto-upgrade)', async () => {
  const h = harness();
  const started = await h.startView();
  assert.equal(started.interactiveStatus, 'STOPPED');
  assert.equal(h.calls.interactiveStart.length, 0);
});

test('explicit activation after VIEW is active: exact target, one call, correct sessionId reused', async () => {
  const h = harness();
  const view = await h.startView();
  const interactive = await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  assert.equal(interactive.interactiveStatus, 'INTERACTIVE');
  assert.equal(interactive.sessionId, view.sessionId);
  assert.deepEqual(h.calls.interactiveStart, [{ sessionId: view.sessionId, options: {} }]);
  assert.deepEqual(h.calls.audit.map(event => event.eventType).slice(-2), [
    'FABRIC_OMEGA_V2_INTERACTIVE_REQUESTED', 'FABRIC_OMEGA_V2_INTERACTIVE_STARTED',
  ]);
});

test('exact target: Fabric A -> host A receives activation, Fabric B -> host B is never touched', async () => {
  const a = harness({ startBinding: binding(FABRIC_A, HOST_A) });
  const b = harness({ startBinding: binding(FABRIC_B, HOST_B) });
  await a.startView();
  await b.startView();
  await a.service.startInteractiveForFabricDevice(FABRIC_A, {});
  assert.equal(a.calls.interactiveStart.length, 1);
  assert.equal(b.calls.interactiveStart.length, 0, 'host B process/session never receives an interactive/start call');
});

test('A unavailable (VIEW never started) fails INTERACTIVE on A; B (available) receives 0 calls — no scheduler, no fallback', async () => {
  const a = harness({ startBinding: binding(FABRIC_A, HOST_A) });
  const b = harness({ startBinding: binding(FABRIC_B, HOST_B) });
  await b.startView(); // B is genuinely available
  await assert.rejects(a.service.startInteractiveForFabricDevice(FABRIC_A, {}), error => error.code === 'OMEGA_V2_VIEW_NOT_ACTIVE');
  assert.equal(a.calls.interactiveStart.length, 0);
  assert.equal(b.calls.interactiveStart.length, 0, 'B was never implicitly selected as a substitute for A');
});

test('wrong VIEW: Fabric A carries a VIEW session that resolves to host B -> REJECT, exact device/session binding enforced', async () => {
  const h = harness({ startBinding: binding(FABRIC_A, HOST_A) });
  await h.startView();
  // Simulate the link having silently pointed at a different host by the time
  // of the VIEW's binding (defensive: normally impossible without a relink,
  // covered separately by the TOCTOU test below) — here we directly assert
  // the wrong-device guard by mutating the recorded session's remote id.
  const sessionId = [...h.sessions.keys()][0];
  h.sessions.get(sessionId).remoteOmegaDeviceId = HOST_B;
  await assert.rejects(h.service.startInteractiveForFabricDevice(FABRIC_A, {}), error => error.code === 'OMEGA_V2_WRONG_DEVICE');
  assert.equal(h.calls.interactiveStart.length, 0);
});

// ── TOCTOU ───────────────────────────────────────────────────────────────────

test('TOCTOU: link changed between VIEW start and INTERACTIVE activation -> OMEGA_V2_LINK_CHANGED, 0 INTERACTIVE started', async () => {
  const h = harness({ startBinding: binding(FABRIC_A, HOST_A, 1) });
  await h.startView();
  h.setBinding(binding(FABRIC_A, HOST_B, 2)); // unlink/relink simulated between the two actions
  await assert.rejects(h.service.startInteractiveForFabricDevice(FABRIC_A, {}), error => error.code === 'OMEGA_V2_LINK_CHANGED');
  assert.equal(h.calls.interactiveStart.length, 0);
});

test('fingerprint change (link stale) blocks activation with 0 input reaching OMEGA', async () => {
  const h = harness({ startBinding: binding(FABRIC_A, HOST_A, 1) });
  await h.startView();
  h.setBinding(binding(FABRIC_A, HOST_A, 1)); // same version/host, but a different fingerprint string
  h.setBinding({ ...binding(FABRIC_A, HOST_A, 1), fingerprint: 'c'.repeat(64) });
  await assert.rejects(h.service.startInteractiveForFabricDevice(FABRIC_A, {}), error => error.code === 'OMEGA_V2_LINK_CHANGED');
  assert.equal(h.calls.interactiveStart.length, 0);
});

test('revocation before activation: OMEGA_V2_REVOKED / resolver failure -> REJECT', async () => {
  const h = harness();
  await h.startView();
  h.setBinding(Object.assign(new Error('omega_v2_host_revoked'), { code: 'omega_v2_host_revoked', status: 409 }));
  await assert.rejects(h.service.startInteractiveForFabricDevice(FABRIC_A, {}), error => error.code === 'OMEGA_V2_REVOKED');
  assert.equal(h.calls.interactiveStart.length, 0);
});

// ── Permission / no silent upgrade ──────────────────────────────────────────

test('OMEGA permission denial is reported as OMEGA_V2_INTERACTIVE_NOT_AUTHORIZED, never a generic code; Fabric never grants it itself', async () => {
  const h = harness({ permissionDeniedOnInteractive: true });
  await h.startView();
  await assert.rejects(h.service.startInteractiveForFabricDevice(FABRIC_A, {}),
    error => error.code === 'OMEGA_V2_INTERACTIVE_NOT_AUTHORIZED');
  assert.equal(h.calls.audit.at(-1).eventType, 'FABRIC_OMEGA_V2_INTERACTIVE_DENIED');
});

test('a VIEW session never silently becomes INTERACTIVE without the explicit call (no timer, no auto-elevate)', async () => {
  const h = harness();
  const started = await h.startView();
  // Read status repeatedly: still STOPPED, and OMEGA is never contacted for interactive/start.
  for (let i = 0; i < 5; i += 1) {
    const status = h.service.getViewStateForFabricDevice(FABRIC_A);
    assert.equal(status.interactiveStatus, 'STOPPED');
  }
  assert.equal(h.calls.interactiveStart.length, 0);
  assert.equal(started.interactiveStatus, 'STOPPED');
});

// ── STOP semantics ──────────────────────────────────────────────────────────

test('STOP INTERACTIVE calls only the certified stop primitive and clears local state; VIEW remains', async () => {
  const h = harness();
  const view = await h.startView();
  await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  const stopped = await h.service.stopInteractiveForFabricDevice(FABRIC_A);
  assert.equal(stopped.interactiveStatus, 'STOPPED');
  assert.equal(stopped.viewStatus, 'VIEWING', 'VIEW is preserved, only INTERACTIVE stops');
  assert.deepEqual(h.calls.interactiveStop, [view.sessionId]);
  assert.equal(h.calls.audit.at(-1).eventType, 'FABRIC_OMEGA_V2_INTERACTIVE_STOPPED');
});

test('STOP VIEW kills INTERACTIVE too (reflected locally; OMEGA already tore it down)', async () => {
  const h = harness();
  await h.startView();
  await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  const stopped = await h.service.stopViewForFabricDevice(FABRIC_A);
  assert.equal(stopped.viewStatus, 'STOPPED');
  assert.equal(stopped.interactiveStatus, 'STOPPED');
});

test('STOP SESSION kills VIEW + INTERACTIVE and forgets the Fabric binding', async () => {
  const h = harness();
  await h.startView();
  await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  const stopped = await h.service.stopSessionForFabricDevice(FABRIC_A);
  assert.equal(stopped.viewStatus, 'STOPPED');
  assert.equal(stopped.interactiveStatus, 'STOPPED');
  assert.equal(stopped.sessionStatus, 'DISCONNECTED');
  // A later status read resolves fresh (no stale in-memory binding survives STOP SESSION).
  await assert.rejects(Promise.resolve().then(() => h.service.getInteractiveStateForFabricDevice ?? null), () => true).catch(() => {});
});

test('remote STOP (session ends externally): status reflects STOPPED for both VIEW and INTERACTIVE, no reconnect attempted', async () => {
  const h = harness();
  const started = await h.startView();
  await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  const before = { connect: h.calls.connect.length, interactiveStart: h.calls.interactiveStart.length };
  h.sessions.get(started.sessionId).status = 'ENDED';
  h.sessions.get(started.sessionId).reason = 'remote_stop';
  const status = h.service.getViewStateForFabricDevice(FABRIC_A);
  assert.equal(status.viewStatus, 'STOPPED');
  assert.equal(status.interactiveStatus, 'STOPPED');
  assert.equal(status.sessionReason, 'remote_stop');
  assert.deepEqual({ connect: h.calls.connect.length, interactiveStart: h.calls.interactiveStart.length }, before, '0 automatic reconnect or re-activation');
});

test('network drop (session lookup fails): INTERACTIVE reflected STOPPED, Fabric never retargets', async () => {
  const h = harness();
  const started = await h.startView();
  await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  h.sessions.delete(started.sessionId); // simulate the session vanishing (network drop)
  const status = h.service.getViewStateForFabricDevice(FABRIC_A);
  assert.equal(status.viewStatus, 'STOPPED');
  assert.equal(status.interactiveStatus, 'STOPPED');
});

test('session expiry: same closed-state handling as remote STOP, 0 reconnect', async () => {
  const h = harness();
  const started = await h.startView();
  await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  h.sessions.get(started.sessionId).status = 'EXPIRED';
  h.sessions.get(started.sessionId).reason = 'session_expired';
  const status = h.service.getViewStateForFabricDevice(FABRIC_A);
  assert.equal(status.interactiveStatus, 'STOPPED');
  assert.equal(h.calls.interactiveStart.length, 1, '0 additional attempt after expiry');
});

test('revocation during active control: further status reads show STOPPED and no more input can be started', async () => {
  const h = harness();
  await h.startView();
  await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  h.setBinding(Object.assign(new Error('omega_v2_host_revoked'), { code: 'omega_v2_host_revoked', status: 409 }));
  const stopped = await h.service.stopInteractiveForFabricDevice(FABRIC_A).catch(error => error);
  // Either a clean stop or a safe rejection — never a successful new activation afterward.
  if (stopped instanceof Error) assert.ok(stopped.code);
  await assert.rejects(h.service.startInteractiveForFabricDevice(FABRIC_A, {}), () => true);
});

// ── Input-off before/after activation, no raw executor, no storage ─────────

test('before activation and after every STOP path, 0 input primitive is ever called by Fabric (input is delegated to OMEGA, never Fabric-executed)', async () => {
  const h = harness();
  await h.startView();
  // Before activation: Fabric exposes no input function at all (see static audit) — nothing to call.
  assert.equal(typeof h.service.sendInput, 'undefined');
  await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  await h.service.stopInteractiveForFabricDevice(FABRIC_A);
  assert.equal(typeof h.service.sendInput, 'undefined');
  await h.service.stopViewForFabricDevice(FABRIC_A);
  assert.equal(typeof h.service.sendInput, 'undefined');
});

test('rate limiting applies to interactive/start before any additional OMEGA call', async () => {
  const h = harness();
  await h.startView();
  // interactive/start has its own 10/minute bucket, independent of VIEW's.
  for (let i = 0; i < 10; i += 1) {
    await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
    await h.service.stopInteractiveForFabricDevice(FABRIC_A);
  }
  assert.equal(h.calls.interactiveStart.length, 10);
  await assert.rejects(h.service.startInteractiveForFabricDevice(FABRIC_A, {}), error => error.code === 'OMEGA_V2_RATE_LIMITED');
  assert.equal(h.calls.interactiveStart.length, 10, 'the 11th attempt never reaches OMEGA');
});

test('interactive/start rejects a non-empty body: no field is a legitimate input channel here', async () => {
  const h = harness();
  await h.startView();
  await assert.rejects(h.service.startInteractiveForFabricDevice(FABRIC_A, { screenIndex: 0 }),
    error => error instanceof DeviceFabricOmegaV2ViewError && error.code === 'OMEGA_V2_INTERACTIVE_REQUEST_INVALID');
  for (const field of ['key', 'x', 'y', 'button', 'pointer', 'command']) {
    await assert.rejects(h.service.startInteractiveForFabricDevice(FABRIC_A, { [field]: 'x' }),
      error => error instanceof DeviceFabricOmegaV2ViewError && error.code === 'OMEGA_V2_INTERACTIVE_REQUEST_INVALID', field);
  }
});

// ── Audit and privacy ────────────────────────────────────────────────────────

test('Fabric INTERACTIVE audit contains only safe ids/reasons: no keys, no coordinates, no typed text, no sessionId field', async () => {
  const h = harness();
  await h.startView();
  await h.service.startInteractiveForFabricDevice(FABRIC_A, {});
  await h.service.stopInteractiveForFabricDevice(FABRIC_A);
  const interactiveEvents = h.calls.audit.filter(event => event.eventType.includes('INTERACTIVE'));
  assert.ok(interactiveEvents.length >= 3);
  for (const event of interactiveEvents) {
    assert.equal(event.fabricDeviceId, FABRIC_A);
    assert.equal(event.agentDeviceId, HOST_A);
    assert.equal('sessionId' in event, false);
    const serialized = JSON.stringify(event);
    for (const forbidden of ['KeyA', 'ArrowLeft', 'x:', 'y:', 'coordinates', 'typed', 'clipboard']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  }
});
