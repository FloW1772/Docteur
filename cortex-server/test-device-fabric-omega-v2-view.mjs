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

function harness({ resolveSequence = [binding(), binding()], connectError = null, sessionHost = HOST_A, connectPermission = 'VIEW' } = {}) {
  const calls = { resolve: [], connect: [], start: [], stopView: [], stopSession: [], audit: [] };
  const sessions = new Map();
  let resolveIndex = 0;
  const service = createFabricOmegaV2ViewService({
    // No database exists in this pure-unit harness; the default dep would
    // read the real trust via getOmegaV2LinkView(), so it is overridden to
    // a plain constant, defaulting to VIEW (this file's Phase 3 behavior
    // unchanged unless a test explicitly requests a higher ceiling).
    connectPermission: () => connectPermission,
    resolveTarget: fabricDeviceId => {
      calls.resolve.push(fabricDeviceId);
      const next = resolveSequence[Math.min(resolveIndex++, resolveSequence.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    connectView: async (hostId, permission, options) => {
      calls.connect.push({ hostId, permission, options });
      if (connectError) throw connectError;
      const session = { sessionId: `session-${calls.connect.length}`, remoteOmegaDeviceId: sessionHost,
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
    stopSession: async sessionId => { calls.stopSession.push(sessionId); const row = sessions.get(sessionId); if (row) { row.status = 'ENDED'; row.reason = 'client_stop'; } return true; },
    audit: event => calls.audit.push(event),
  });
  return { service, calls, sessions };
}

test('explicit VIEW resolves and revalidates the exact target before one VIEW-only connection', async () => {
  const { service, calls } = harness();
  const view = await service.startViewForFabricDevice(FABRIC_A, request());
  assert.equal(view.omegaV2HostId, HOST_A);
  assert.equal(view.sessionStatus, 'CONNECTED');
  assert.equal(view.viewStatus, 'VIEWING');
  assert.deepEqual(calls.resolve, [FABRIC_A, FABRIC_A]);
  assert.deepEqual(calls.connect.map(call => call.hostId), [HOST_A]);
  assert.deepEqual(calls.start, [{ sessionId: 'session-1', screenIndex: 0 }]);
  assert.deepEqual(calls.audit.map(event => event.eventType), [
    'FABRIC_OMEGA_V2_VIEW_REQUESTED', 'FABRIC_OMEGA_V2_VIEW_STARTED',
  ]);
});

test('Fabric A routes to A and Fabric B routes to B with no cross-target call', async () => {
  const calls = [];
  const make = target => createFabricOmegaV2ViewService({
    resolveTarget: () => target,
    connectPermission: () => 'VIEW',
    connectView: async hostId => { calls.push(hostId); return { sessionId: `s-${hostId}`, remoteOmegaDeviceId: hostId, permission: 'VIEW', status: 'CONNECTED' }; },
    startView: async () => ({ status: 'VIEWING', streamId: 'stream' }),
    getSession: () => ({ status: 'CONNECTED' }), stopView: async () => ({}), stopSession: async () => true, audit: () => {},
  });
  await make(binding(FABRIC_A, HOST_A)).startViewForFabricDevice(FABRIC_A, request(binding(FABRIC_A, HOST_A)));
  await make(binding(FABRIC_B, HOST_B)).startViewForFabricDevice(FABRIC_B, request(binding(FABRIC_B, HOST_B)));
  assert.deepEqual(calls, [HOST_A, HOST_B]);
});

test('A unavailable fails without ever attempting available B', async () => {
  const unavailable = Object.assign(new Error('NETWORK_UNAVAILABLE'), { code: 'NETWORK_UNAVAILABLE' });
  const { service, calls } = harness({ connectError: unavailable });
  // Renamed to match the mission's explicit safe-error vocabulary
  // (OMEGA_NETWORK_UNAVAILABLE, Phase 4 §36) rather than the generic
  // OMEGA_V2_UNAVAILABLE catch-all used for genuinely unclassified errors.
  await assert.rejects(service.startViewForFabricDevice(FABRIC_A, request()), error => error.code === 'OMEGA_V2_NETWORK_UNAVAILABLE');
  assert.deepEqual(calls.connect.map(call => call.hostId), [HOST_A]);
  assert.equal(calls.connect.some(call => call.hostId === HOST_B), false);
  assert.equal(calls.start.length, 0);
});

test('stale fingerprint fails closed with zero connection', async () => {
  const stale = Object.assign(new Error('omega_v2_link_stale'), { code: 'omega_v2_link_stale', status: 409 });
  const { service, calls } = harness({ resolveSequence: [stale] });
  await assert.rejects(service.startViewForFabricDevice(FABRIC_A, request()), error => error.code === 'OMEGA_V2_LINK_STALE');
  assert.equal(calls.connect.length, 0);
  assert.equal(calls.start.length, 0);
});

test('TOCTOU link version/target change is FABRIC link changed with zero connect and zero VIEW', async () => {
  const { service, calls } = harness({ resolveSequence: [binding(), binding(FABRIC_A, HOST_B, 2)] });
  await assert.rejects(service.startViewForFabricDevice(FABRIC_A, request()), error => error.code === 'OMEGA_V2_LINK_CHANGED');
  assert.equal(calls.connect.length, 0);
  assert.equal(calls.start.length, 0);
});

test('revocation between resolution and connect fails with zero fallback', async () => {
  const revoked = Object.assign(new Error('omega_v2_host_revoked'), { code: 'omega_v2_host_revoked', status: 409 });
  const { service, calls } = harness({ resolveSequence: [binding(), revoked] });
  await assert.rejects(service.startViewForFabricDevice(FABRIC_A, request()), error => error.code === 'OMEGA_V2_REVOKED');
  assert.equal(calls.connect.length, 0);
  assert.equal(calls.start.length, 0);
});

test('wrong-device session response is rejected and the exact returned session is stopped', async () => {
  const { service, calls } = harness({ sessionHost: HOST_B });
  await assert.rejects(service.startViewForFabricDevice(FABRIC_A, request()), error => error.code === 'OMEGA_V2_WRONG_DEVICE');
  assert.deepEqual(calls.connect.map(call => call.hostId), [HOST_A]);
  assert.deepEqual(calls.stopSession, ['session-1']);
  assert.equal(calls.start.length, 0);
});

test('status is local/read-only and reflects remote stop without connect, start, or reconnect', async () => {
  const { service, calls, sessions } = harness();
  const started = await service.startViewForFabricDevice(FABRIC_A, request());
  const before = { connect: calls.connect.length, start: calls.start.length };
  sessions.get(started.sessionId).status = 'ENDED';
  sessions.get(started.sessionId).reason = 'remote_stop';
  const status = service.getViewStateForFabricDevice(FABRIC_A);
  assert.equal(status.viewStatus, 'STOPPED');
  assert.equal(status.sessionReason, 'remote_stop');
  assert.deepEqual({ connect: calls.connect.length, start: calls.start.length }, before);
});

test('STOP VIEW and STOP SESSION act only on the opaque session created for the exact Fabric device', async () => {
  const { service, calls } = harness();
  const started = await service.startViewForFabricDevice(FABRIC_A, request());
  const stopped = await service.stopViewForFabricDevice(FABRIC_A);
  assert.equal(stopped.viewStatus, 'STOPPED');
  assert.deepEqual(calls.stopView, [started.sessionId]);
  await service.stopSessionForFabricDevice(FABRIC_A);
  assert.deepEqual(calls.stopSession, [started.sessionId]);
  assert.equal(calls.audit.at(-1).reason, 'user_stop_session');
});

test('link change after start never retargets the established session and safety STOP remains exact', async () => {
  const first = binding();
  const changed = binding(FABRIC_A, HOST_B, 2);
  const { service, calls } = harness({ resolveSequence: [first, first, changed] });
  const started = await service.startViewForFabricDevice(FABRIC_A, request(first));
  const status = service.getViewStateForFabricDevice(FABRIC_A);
  assert.equal(status.linkChanged, true);
  await service.stopViewForFabricDevice(FABRIC_A);
  assert.deepEqual(calls.stopView, [started.sessionId]);
  assert.deepEqual(calls.connect.map(call => call.hostId), [HOST_A]);
});

test('request schema is closed and rate limiting applies before additional connect attempts', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.startViewForFabricDevice(FABRIC_A, { ...request(), action: 'INTERACTIVE' }),
    error => error instanceof DeviceFabricOmegaV2ViewError && error.code === 'OMEGA_V2_VIEW_REQUEST_INVALID');
  await service.startViewForFabricDevice(FABRIC_A, request());
  for (let index = 0; index < 9; index += 1) {
    await assert.rejects(service.startViewForFabricDevice(FABRIC_A, request()), error => error.code === 'OMEGA_V2_VIEW_ALREADY_STARTED');
  }
  await assert.rejects(service.startViewForFabricDevice(FABRIC_A, request()), error => error.code === 'OMEGA_V2_RATE_LIMITED');
  assert.equal(calls.connect.length, 1);
});

test('Fabric audit contains only safe ids/reasons and never session or frame material', async () => {
  const { service, calls } = harness();
  await service.startViewForFabricDevice(FABRIC_A, request());
  for (const event of calls.audit) {
    assert.equal(event.fabricDeviceId, FABRIC_A);
    assert.equal(event.agentDeviceId, HOST_A);
    assert.equal('sessionId' in event, false);
    assert.equal(JSON.stringify(event).includes('stream-'), false);
    assert.equal(JSON.stringify(event).includes('PNG'), false);
  }
});
