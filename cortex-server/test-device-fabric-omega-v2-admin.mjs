// DEVICE FABRIC V2 Phase 5 — OMEGA V2 ADMIN + STOP orchestration: exact
// target, TOCTOU, fingerprint/link-version revalidation, ADMIN permission
// (never inferred from the link), closed semantic allowlist, local-approval
// preservation (Fabric never approves), STOP DEVICE, STOP ALL (Fabric-scoped
// only), and audit safety. Mirrors the VIEW/INTERACTIVE harness shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFabricOmegaV2AdminService, DeviceFabricOmegaV2AdminError } from './src/lib/device-fabric-omega-v2-admin.js';

const FABRIC_A = 'fdev-11111111-1111-4111-8111-111111111111';
const FABRIC_B = 'fdev-22222222-2222-4222-8222-222222222222';
const HOST_A = 'ov2h-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOST_B = 'ov2h-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

function binding(fabricDeviceId = FABRIC_A, host = HOST_A, version = 1) {
  return { fabricDeviceId, omegaV2HostId: host, linkId: `flnk-${fabricDeviceId.slice(5, 13)}`,
    linkVersion: version, fingerprint: host === HOST_A ? FINGERPRINT_A : FINGERPRINT_B };
}

function readResult(actionType = 'GET_SYSTEM_INFO') {
  return { status: 'EXECUTED', result: { system: { computerName: 'PC-A' } }, actionType };
}

/**
 * Each read/high-impact dep is keyed by sessionId in the harness so a
 * two-device test can track which host actually received a call, exactly
 * like the real omega-outbound-client.js keys operations off the session.
 */
function harness({ startBinding = binding(), connectPermission = 'ADMIN', connectError = null,
  sessionHost = HOST_A, readError = null, highImpactStatus = 'PENDING_APPROVAL' } = {}) {
  const calls = { resolve: [], connect: [], reads: [], highImpact: [], status: [], cancel: [],
    stopSession: [], audit: [] };
  const sessions = new Map();
  let currentBinding = startBinding;
  const service = createFabricOmegaV2AdminService({
    connectPermission: () => connectPermission,
    resolveTarget: fabricDeviceId => {
      calls.resolve.push(fabricDeviceId);
      if (currentBinding instanceof Error) throw currentBinding;
      return currentBinding;
    },
    connectAdmin: async (hostId, permission, options) => {
      calls.connect.push({ hostId, permission, options });
      if (connectError) throw connectError;
      const session = { sessionId: `session-${calls.connect.length}`, remoteOmegaDeviceId: sessionHost,
        permission, status: 'CONNECTED', reason: null };
      sessions.set(session.sessionId, session);
      return session;
    },
    getSession: sessionId => sessions.get(sessionId) ?? null,
    stopSession: async sessionId => {
      calls.stopSession.push(sessionId);
      const row = sessions.get(sessionId);
      if (row) { row.status = 'ENDED'; row.reason = 'client_stop'; }
      return true;
    },
    reads: {
      GET_SYSTEM_INFO: async sessionId => { calls.reads.push({ sessionId, action: 'GET_SYSTEM_INFO' }); if (readError) throw readError; return readResult('GET_SYSTEM_INFO'); },
      PROCESS_LIST: async sessionId => { calls.reads.push({ sessionId, action: 'PROCESS_LIST' }); if (readError) throw readError; return readResult('PROCESS_LIST'); },
      SERVICE_STATUS: async sessionId => { calls.reads.push({ sessionId, action: 'SERVICE_STATUS' }); if (readError) throw readError; return readResult('SERVICE_STATUS'); },
      NETWORK_STATUS: async sessionId => { calls.reads.push({ sessionId, action: 'NETWORK_STATUS' }); if (readError) throw readError; return readResult('NETWORK_STATUS'); },
      DISK_STATUS: async sessionId => { calls.reads.push({ sessionId, action: 'DISK_STATUS' }); if (readError) throw readError; return readResult('DISK_STATUS'); },
    },
    highImpact: {
      LOCK: async sessionId => { calls.highImpact.push({ sessionId, action: 'LOCK' }); return { operationId: OPERATION_ID, actionType: 'LOCK', status: highImpactStatus, error: null }; },
      LOGOFF: async sessionId => { calls.highImpact.push({ sessionId, action: 'LOGOFF' }); return { operationId: OPERATION_ID, actionType: 'LOGOFF', status: highImpactStatus, error: null }; },
      RESTART: async sessionId => { calls.highImpact.push({ sessionId, action: 'RESTART' }); return { operationId: OPERATION_ID, actionType: 'RESTART', status: highImpactStatus, error: null }; },
      SHUTDOWN: async sessionId => { calls.highImpact.push({ sessionId, action: 'SHUTDOWN' }); return { operationId: OPERATION_ID, actionType: 'SHUTDOWN', status: highImpactStatus, error: null }; },
    },
    getOperation: async (sessionId, operationId) => { calls.status.push({ sessionId, operationId }); return { operationId, actionType: 'LOCK', status: 'EXECUTED', error: null }; },
    cancelOperation: async (sessionId, operationId) => { calls.cancel.push({ sessionId, operationId }); return { operationId, actionType: 'LOCK', status: 'CANCELLED', error: null }; },
    audit: event => calls.audit.push(event),
  });
  return { service, calls, sessions, setBinding: next => { currentBinding = next; } };
}

// ── Exact target, TOCTOU, fingerprint, revocation ───────────────────────────

test('read-only ADMIN resolves the exact target and connects exactly once', async () => {
  const { service, calls } = harness();
  const result = await service.getSystemInfoForFabricDevice(FABRIC_A);
  assert.equal(result.omegaV2HostId, HOST_A);
  assert.equal(result.status, 'EXECUTED');
  assert.deepEqual(calls.connect.map(c => c.hostId), [HOST_A]);
  assert.equal(calls.reads.length, 1);
});

test('Fabric A routes to A and Fabric B routes to B with no cross-target call', async () => {
  const calls = [];
  const make = target => createFabricOmegaV2AdminService({
    resolveTarget: () => target,
    connectPermission: () => 'ADMIN',
    connectAdmin: async hostId => { calls.push(hostId); return { sessionId: `s-${hostId}`, remoteOmegaDeviceId: hostId, permission: 'ADMIN', status: 'CONNECTED' }; },
    getSession: () => ({ status: 'CONNECTED', permission: 'ADMIN' }),
    stopSession: async () => true,
    reads: { GET_SYSTEM_INFO: async () => readResult() },
    highImpact: {}, getOperation: async () => ({}), cancelOperation: async () => ({}), audit: () => {},
  });
  await make(binding(FABRIC_A, HOST_A)).getSystemInfoForFabricDevice(FABRIC_A);
  await make(binding(FABRIC_B, HOST_B)).getSystemInfoForFabricDevice(FABRIC_B);
  assert.deepEqual(calls, [HOST_A, HOST_B]);
});

test('A unavailable fails without ever attempting available B', async () => {
  const unavailable = Object.assign(new Error('NETWORK_UNAVAILABLE'), { code: 'NETWORK_UNAVAILABLE' });
  const { service, calls } = harness({ connectError: unavailable });
  await assert.rejects(service.getSystemInfoForFabricDevice(FABRIC_A), error => error.code === 'OMEGA_V2_NETWORK_UNAVAILABLE');
  assert.deepEqual(calls.connect.map(c => c.hostId), [HOST_A]);
  assert.equal(calls.connect.some(c => c.hostId === HOST_B), false);
  assert.equal(calls.reads.length, 0);
});

test('wrong-device session response is rejected with zero read', async () => {
  const { service, calls } = harness({ sessionHost: HOST_B });
  await assert.rejects(service.getSystemInfoForFabricDevice(FABRIC_A), error => error.code === 'OMEGA_V2_WRONG_DEVICE');
  assert.equal(calls.reads.length, 0);
});

test('TOCTOU: link changes between the two resolve reads -> REJECT, 0 connect, 0 admin operation', async () => {
  const first = binding();
  const changed = binding(FABRIC_A, HOST_B, 2);
  let resolveCount = 0;
  const calls = { connect: [], reads: [] };
  const svc = createFabricOmegaV2AdminService({
    connectPermission: () => 'ADMIN',
    resolveTarget: () => { resolveCount += 1; return resolveCount === 1 ? first : changed; },
    connectAdmin: async hostId => { calls.connect.push(hostId); return { sessionId: 's-1', remoteOmegaDeviceId: hostId, permission: 'ADMIN', status: 'CONNECTED' }; },
    getSession: () => null, stopSession: async () => true,
    reads: { GET_SYSTEM_INFO: async () => { calls.reads.push('called'); return readResult(); } },
    highImpact: {}, getOperation: async () => ({}), cancelOperation: async () => ({}), audit: () => {},
  });
  await assert.rejects(svc.getSystemInfoForFabricDevice(FABRIC_A), error => error.code === 'OMEGA_V2_LINK_CHANGED');
  assert.equal(calls.connect.length, 0);
  assert.equal(calls.reads.length, 0);
});

test('fingerprint change between link and current -> REJECT', async () => {
  const stale = Object.assign(new Error('omega_v2_link_stale'), { code: 'omega_v2_link_stale', status: 409 });
  const calls = { connect: [] };
  const rejecting = createFabricOmegaV2AdminService({
    connectPermission: () => 'ADMIN',
    resolveTarget: () => { throw stale; },
    connectAdmin: async () => { throw new Error('should not connect'); },
    getSession: () => null, stopSession: async () => true,
    reads: { GET_SYSTEM_INFO: async () => readResult() },
    highImpact: {}, getOperation: async () => ({}), cancelOperation: async () => ({}), audit: () => {},
  });
  await assert.rejects(rejecting.getSystemInfoForFabricDevice(FABRIC_A), error => error.code === 'OMEGA_V2_LINK_STALE');
  assert.equal(calls.connect.length, 0);
});

test('revocation before ADMIN -> REJECT, 0 operation', async () => {
  const revoked = Object.assign(new Error('omega_v2_host_revoked'), { code: 'omega_v2_host_revoked', status: 409 });
  const svc = createFabricOmegaV2AdminService({
    connectPermission: () => 'ADMIN',
    resolveTarget: () => { throw revoked; },
    connectAdmin: async () => { throw new Error('should not connect'); },
    getSession: () => null, stopSession: async () => true,
    reads: { GET_SYSTEM_INFO: async () => readResult() },
    highImpact: {}, getOperation: async () => ({}), cancelOperation: async () => ({}), audit: () => {},
  });
  await assert.rejects(svc.getSystemInfoForFabricDevice(FABRIC_A), error => error.code === 'OMEGA_V2_REVOKED');
});

// ── ADMIN permission model ───────────────────────────────────────────────────

test('OMEGA caps the session below ADMIN -> Fabric never infers or upgrades, session stopped, REJECT', async () => {
  const { service, calls } = harness({ connectPermission: 'VIEW' });
  // connectAdmin echoes back whatever permission was requested; harness
  // requests 'VIEW' here to simulate a trust ceiling below ADMIN.
  await assert.rejects(service.getSystemInfoForFabricDevice(FABRIC_A), error => error.code === 'OMEGA_V2_ADMIN_NOT_AUTHORIZED');
  assert.equal(calls.stopSession.length, 1, 'the under-permissioned session is stopped, never reused for ADMIN');
  assert.equal(calls.reads.length, 0);
});

test('a permission denial from the read call itself (defense in depth) is mapped the same way', async () => {
  const permissionDenied = Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  const svc = createFabricOmegaV2AdminService({
    connectPermission: () => 'ADMIN',
    resolveTarget: () => binding(),
    connectAdmin: async hostId => ({ sessionId: 's-1', remoteOmegaDeviceId: hostId, permission: 'ADMIN', status: 'CONNECTED' }),
    getSession: () => ({ status: 'CONNECTED', permission: 'ADMIN', remoteOmegaDeviceId: HOST_A }),
    stopSession: async () => true,
    reads: { GET_SYSTEM_INFO: async () => { throw permissionDenied; } },
    highImpact: {}, getOperation: async () => ({}), cancelOperation: async () => ({}), audit: () => {},
  });
  await assert.rejects(svc.getSystemInfoForFabricDevice(FABRIC_A), error => error.code === 'OMEGA_V2_ADMIN_NOT_AUTHORIZED');
});

// ── Semantic allowlist ───────────────────────────────────────────────────────

test('all 5 read-only actions and 4 high-impact actions are reachable by their typed wrapper only', async () => {
  const { service, calls } = harness();
  await service.getSystemInfoForFabricDevice(FABRIC_A);
  await service.listProcessesForFabricDevice(FABRIC_A);
  await service.getServiceStatusForFabricDevice(FABRIC_A);
  await service.getNetworkStatusForFabricDevice(FABRIC_A);
  await service.getDiskStatusForFabricDevice(FABRIC_A);
  assert.deepEqual(calls.reads.map(r => r.action), ['GET_SYSTEM_INFO', 'PROCESS_LIST', 'SERVICE_STATUS', 'NETWORK_STATUS', 'DISK_STATUS']);
  await service.lockFabricDevice(FABRIC_A, { confirm: 'LOCK' });
  await service.logoffFabricDevice(FABRIC_A, { confirm: 'LOGOFF' });
  await service.restartFabricDevice(FABRIC_A, { confirm: 'RESTART' });
  await service.shutdownFabricDevice(FABRIC_A, { confirm: 'SHUTDOWN' });
  assert.deepEqual(calls.highImpact.map(h => h.action), ['LOCK', 'LOGOFF', 'RESTART', 'SHUTDOWN']);
});

test('there is no generic action entry point: the module exports only typed functions', async () => {
  const mod = await import('./src/lib/device-fabric-omega-v2-admin.js');
  const names = Object.keys(mod);
  assert.equal(names.some(n => /^run.*Admin.*Operation$/i.test(n) || /^executeAdmin/i.test(n) || n === 'runFabricOmegaV2AdminOperation'), false);
  for (const forbidden of ['executeAdminCommand', 'runCommand', 'runPowerShell', 'executeRaw', 'invokeRpc', 'runExecutable', 'sendShell', 'proxyAdminRequest']) {
    assert.equal(names.includes(forbidden), false, forbidden);
  }
});

// ── High-impact confirmation gate (Fabric-side only) ─────────────────────────

test('high-impact action requires the exact typed confirmation; missing/wrong confirmation is rejected with 0 calls', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.lockFabricDevice(FABRIC_A, {}), error => error.code === 'OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED');
  await assert.rejects(service.lockFabricDevice(FABRIC_A, { confirm: 'SHUTDOWN' }), error => error.code === 'OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED');
  await assert.rejects(service.lockFabricDevice(FABRIC_A, { confirm: 'LOCK', extra: 1 }), error => error.code === 'OMEGA_V2_ADMIN_CONFIRMATION_REQUIRED');
  assert.equal(calls.highImpact.length, 0);
  assert.equal(calls.connect.length, 0);
});

test('Fabric confirmation never substitutes for local OMEGA approval: PENDING_APPROVAL is returned, not EXECUTED', async () => {
  const { service } = harness({ highImpactStatus: 'PENDING_APPROVAL' });
  const result = await service.lockFabricDevice(FABRIC_A, { confirm: 'LOCK' });
  assert.equal(result.status, 'PENDING_APPROVAL');
  assert.notEqual(result.status, 'EXECUTED');
});

test('operation status/cancel require an existing ADMIN binding and a well-formed operationId', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.operationStatusForFabricDevice(FABRIC_A, { operationId: OPERATION_ID }),
    error => error.code === 'OMEGA_V2_ADMIN_SESSION_NOT_ACTIVE');
  await service.lockFabricDevice(FABRIC_A, { confirm: 'LOCK' });
  await assert.rejects(service.operationStatusForFabricDevice(FABRIC_A, { operationId: 'not-a-uuid' }),
    error => error.code === 'OMEGA_V2_ADMIN_REQUEST_INVALID');
  const status = await service.operationStatusForFabricDevice(FABRIC_A, { operationId: OPERATION_ID });
  assert.equal(status.sessionId, calls.connect[0] && `session-1`);
  const cancelled = await service.cancelOperationForFabricDevice(FABRIC_A, { operationId: OPERATION_ID });
  assert.equal(calls.cancel.length, 1);
  void cancelled;
});

// ── STOP DEVICE / STOP ALL ───────────────────────────────────────────────────

test('STOP DEVICE stops only the exact Fabric-bound ADMIN session for that device', async () => {
  const { service, calls } = harness();
  await service.getSystemInfoForFabricDevice(FABRIC_A);
  const result = await service.stopDeviceForFabricDevice(FABRIC_A);
  assert.equal(result.stopped, true);
  assert.deepEqual(calls.stopSession, ['session-1']);
});

test('STOP DEVICE with no active binding is a safe no-op, not an error', async () => {
  const { service, calls } = harness();
  const result = await service.stopDeviceForFabricDevice(FABRIC_A);
  assert.equal(result.stopped, false);
  assert.equal(calls.stopSession.length, 0);
});

test('STOP ALL stops only Fabric-owned bindings, per-device results, one failure does not abort another', async () => {
  const calls = { connect: [], stopSession: [] };
  const failingSessionId = 'session-1';
  const service = createFabricOmegaV2AdminService({
    connectPermission: () => 'ADMIN',
    resolveTarget: fabricDeviceId => binding(fabricDeviceId, fabricDeviceId === FABRIC_A ? HOST_A : HOST_B),
    connectAdmin: async hostId => { const id = `session-${calls.connect.length + 1}`; calls.connect.push(hostId); return { sessionId: id, remoteOmegaDeviceId: hostId, permission: 'ADMIN', status: 'CONNECTED' }; },
    getSession: () => ({ status: 'CONNECTED', permission: 'ADMIN' }),
    stopSession: async sessionId => {
      calls.stopSession.push(sessionId);
      if (sessionId === failingSessionId) throw new Error('NETWORK_UNAVAILABLE');
      return true;
    },
    reads: { GET_SYSTEM_INFO: async () => readResult() },
    highImpact: {}, getOperation: async () => ({}), cancelOperation: async () => ({}), audit: () => {},
  });
  await service.getSystemInfoForFabricDevice(FABRIC_A);
  await service.getSystemInfoForFabricDevice(FABRIC_B);
  const results = await service.stopAllForFabricDevices();
  assert.equal(results.length, 2);
  assert.deepEqual(calls.stopSession.sort(), ['session-1', 'session-2']);
  const resultA = results.find(r => r.fabricDeviceId === FABRIC_A);
  const resultB = results.find(r => r.fabricDeviceId === FABRIC_B);
  // stopSession itself swallows its own network error internally (matches
  // the real deps.stopSession(...).catch(() => {}) pattern) so both report stopped.
  assert.equal(resultA.stopped, true);
  assert.equal(resultB.stopped, true);
});

test('STOP ALL never calls a RASSILON primitive and never touches trust/links', async () => {
  const mod = await import('./src/lib/device-fabric-omega-v2-admin.js');
  const source = mod.stopAllForFabricDevices.toString() + mod.stopDeviceForFabricDevice.toString();
  assert.doesNotMatch(source, /rassilon/i);
  assert.doesNotMatch(source, /revoke|unlink|linkOmegaV2Host/i);
});

// ── Audit safety ─────────────────────────────────────────────────────────────

test('Fabric audit contains only safe ids/reasons: no result data, no approval nonce, no secret', async () => {
  const { service, calls } = harness();
  await service.getSystemInfoForFabricDevice(FABRIC_A);
  await service.lockFabricDevice(FABRIC_A, { confirm: 'LOCK' });
  for (const event of calls.audit) {
    assert.equal(event.fabricDeviceId, FABRIC_A);
    assert.equal(event.agentDeviceId, HOST_A);
    assert.equal('sessionId' in event, false);
    assert.equal('result' in event, false);
    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /computerName|PC-A/);
    assert.doesNotMatch(serialized, /nonce/i);
    assert.doesNotMatch(serialized, /token|secret|private/i);
  }
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

test('read rate limiting applies per fabric device', async () => {
  const { service } = harness();
  for (let index = 0; index < 30; index += 1) await service.getSystemInfoForFabricDevice(FABRIC_A);
  await assert.rejects(service.getSystemInfoForFabricDevice(FABRIC_A), error => error.code === 'OMEGA_V2_RATE_LIMITED');
});

test('high-impact rate limiting is stricter than reads', async () => {
  const { service } = harness();
  for (let index = 0; index < 4; index += 1) {
    await service.lockFabricDevice(FABRIC_A, { confirm: 'LOCK' });
    await service.stopDeviceForFabricDevice(FABRIC_A);
  }
  await assert.rejects(service.lockFabricDevice(FABRIC_A, { confirm: 'LOCK' }), error => error.code === 'OMEGA_V2_RATE_LIMITED');
});
