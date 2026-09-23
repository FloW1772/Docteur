// OMEGA ADMIN V1 semantic action tests.
// High-impact execution is always injected and mocked here; no lock, logoff,
// restart or shutdown is ever performed by the test suite.
import './test-setup.mjs';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { initSqlite, insertOmegaDevice } from './src/lib/sqlite.js';
import { createSession, endSession } from './src/lib/omega-session.js';
import { revokeDevice } from './src/lib/omega-devices.js';
import { OMEGA_PERMISSION_LEVELS } from './src/lib/omega-pairing.js';
import {
  requestAdminAction, executeAdminReadAction, getAdminActionStatus,
  approveAdminActionLocally, denyAdminActionLocally, OmegaAdminError,
  _setAdminExecutorForTests, _resetAdminExecutorForTests,
  _setAdminIndicatorProviderForTests, _resetAdminIndicatorProviderForTests,
  _setAdminPromptProcessFactoryForTests, _resetAdminPromptProcessFactoryForTests,
  _resetAdminStateForTests, _expireAdminActionForTests,
} from './src/lib/omega-admin.js';
import { createOmegaAdminRoute } from './src/routes/omega-admin.js';

let nextId = 0;
const fakeChildren = [];
const executorCalls = [];

function deviceSession(permission) {
  const deviceId = `admin-test-device-${++nextId}`;
  insertOmegaDevice({
    id: deviceId,
    display_name: 'Admin test fixture',
    public_key_pem: 'fixture-public-key',
    fingerprint: `fixture-fingerprint-${deviceId}`,
    permission_level: permission,
  });
  return { deviceId, session: createSession({ deviceId }) };
}

function fakeChild() {
  const listeners = new Map();
  const child = {
    pid: 50_000 + fakeChildren.length,
    killed: false,
    once(event, callback) { listeners.set(event, callback); return child; },
    kill() { child.killed = true; return true; },
    emit(event) { listeners.get(event)?.(); },
  };
  fakeChildren.push(child);
  return child;
}

function installFakes() {
  executorCalls.length = 0;
  _setAdminExecutorForTests(async (action) => {
    executorCalls.push(action);
    if (action === 'GET_PROCESS_LIST') {
      return { ok: true, action, processes: Array.from({ length: 250 }, (_, i) => ({ pid: i, name: `p${i}` })) };
    }
    return { ok: true, action, value: 'safe-result' };
  });
  _setAdminIndicatorProviderForTests({
    start: () => ({ ok: true, persistent: true }),
    stop: () => true,
    get: () => null,
  });
  _setAdminPromptProcessFactoryForTests(() => fakeChild());
}

before(() => initSqlite(':memory:'));
beforeEach(() => {
  _resetAdminStateForTests();
  _resetAdminExecutorForTests();
  _resetAdminIndicatorProviderForTests();
  _resetAdminPromptProcessFactoryForTests();
  fakeChildren.length = 0;
  installFakes();
});
after(() => {
  _resetAdminStateForTests();
  _resetAdminExecutorForTests();
  _resetAdminIndicatorProviderForTests();
  _resetAdminPromptProcessFactoryForTests();
});

const app = new Hono().route('/api', createOmegaAdminRoute({
  transportPolicy: () => true,
  isLocal: () => true,
}));

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const hasBody = body !== undefined;
  const response = await app.request(`http://localhost/api${path}`, {
    method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

function adminBody(fixture, nonce, extra = {}) {
  return { sessionId: fixture.session.sessionId, deviceId: fixture.deviceId, nonce, ...extra };
}

function authQuery(fixture, nonce, extra = {}) {
  const query = new URLSearchParams({ sessionId: fixture.session.sessionId, deviceId: fixture.deviceId, nonce, ...extra });
  return `?${query}`;
}

test('ADMIN status and read-only actions require server-side OMEGA_ADMIN', async () => {
  const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
  const status = await request(`/omega/admin/status${authQuery(fixture, fixture.session.nonce)}`);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.highImpactActions, ['LOCK_WORKSTATION', 'REQUEST_LOGOFF', 'REQUEST_RESTART', 'REQUEST_SHUTDOWN']);

  const processes = await request(`/omega/admin/processes${authQuery(fixture, status.body.nextNonce)}`);
  assert.equal(processes.status, 200);
  assert.equal(processes.body.result.processes.length, 200);
  assert.equal(executorCalls.at(-1), 'GET_PROCESS_LIST');
});

test('remote cleartext ADMIN is refused before authentication', async () => {
  const cleartextApp = new Hono().route('/api', createOmegaAdminRoute({ transportPolicy: () => false, isLocal: () => false }));
  const response = await cleartextApp.request('http://remote.invalid/api/omega/admin/status');
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'OMEGA_TLS_REQUIRED');
});

test('VIEW and INTERACTIVE sessions cannot use ADMIN, including fake client permission fields', async () => {
  for (const permission of [OMEGA_PERMISSION_LEVELS.OMEGA_VIEW, OMEGA_PERMISSION_LEVELS.OMEGA_INTERACTIVE]) {
    const fixture = deviceSession(permission);
    const response = await request('/omega/admin/actions', {
      method: 'POST',
      body: adminBody(fixture, fixture.session.nonce, {
        requestId: `blocked-${++nextId}`,
        action: 'REQUEST_RESTART',
        permissionLevel: OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN,
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'ACTION_NOT_ALLOWED');
  }
});

test('high-impact action remains pending until local ALLOW ONCE, then executes once', async () => {
  const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
  const pending = await request('/omega/admin/actions', {
    method: 'POST',
    body: adminBody(fixture, fixture.session.nonce, { requestId: `restart-${++nextId}`, action: 'REQUEST_RESTART' }),
  });
  assert.equal(pending.status, 202);
  assert.equal(pending.body.approvalState, 'pending');
  assert.equal(executorCalls.length, 0);

  const approved = await request(`/omega/admin/actions/${pending.body.actionId}/approve-local`, {
    method: 'POST', headers: { origin: 'http://localhost' },
  });
  assert.equal(approved.status, 200);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(executorCalls, ['REQUEST_RESTART']);

  assert.throws(
    () => approveAdminActionLocally(pending.body.actionId),
    error => error instanceof OmegaAdminError && error.code === 'APPROVAL_EXPIRED',
  );
});

test('remote controller cannot self-approve and Origin is checked for local approval', async () => {
  const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
  const pending = await request('/omega/admin/actions', {
    method: 'POST',
    body: adminBody(fixture, fixture.session.nonce, { requestId: `shutdown-${++nextId}`, action: 'REQUEST_SHUTDOWN' }),
  });
  const remoteApp = new Hono().route('/api', createOmegaAdminRoute({ transportPolicy: () => true, isLocal: () => false }));
  const remote = await remoteApp.request(`http://localhost/api/omega/admin/actions/${pending.body.actionId}/approve-local`, { method: 'POST' });
  assert.equal(remote.status, 403);

  const badOrigin = await request(`/omega/admin/actions/${pending.body.actionId}/approve-local`, {
    method: 'POST', headers: { origin: 'https://attacker.invalid' },
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(executorCalls.length, 0);
});

test('STOP invalidates pending ADMIN and kills only its prompt process', async () => {
  const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
  const pending = await request('/omega/admin/actions', {
    method: 'POST',
    body: adminBody(fixture, fixture.session.nonce, { requestId: `lock-${++nextId}`, action: 'LOCK_WORKSTATION' }),
  });
  assert.equal(pending.status, 202);
  endSession(fixture.session.sessionId);
  assert.equal(fakeChildren[0].killed, true);
  assert.throws(
    () => approveAdminActionLocally(pending.body.actionId),
    error => error instanceof OmegaAdminError && error.code === 'APPROVAL_EXPIRED',
  );
  assert.equal(executorCalls.length, 0);
});

test('device revocation invalidates pending ADMIN immediately', async () => {
  const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
  const pending = await request('/omega/admin/actions', {
    method: 'POST',
    body: adminBody(fixture, fixture.session.nonce, { requestId: `logoff-${++nextId}`, action: 'REQUEST_LOGOFF' }),
  });
  revokeDevice(fixture.deviceId);
  assert.throws(
    () => approveAdminActionLocally(pending.body.actionId),
    error => error instanceof OmegaAdminError && error.code === 'APPROVAL_EXPIRED',
  );
  assert.equal(executorCalls.length, 0);
});

test('closed semantic allowlist rejects shell, file, clipboard, credential and arbitrary command shapes', async () => {
  const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
  for (const action of ['RUN_SHELL', 'EXEC', 'POWERSHELL', 'CMD', 'DELETE_FILE', 'DOWNLOAD_FILE', 'UPLOAD_FILE', 'READ_CLIPBOARD', 'DUMP_CREDENTIALS', 'DISABLE_SECURITY', 'INSTALL_SERVICE']) {
    const current = action === 'RUN_SHELL' ? fixture : deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
    const response = await request('/omega/admin/actions', {
      method: 'POST',
      body: adminBody(current, current.session.nonce, { requestId: `deny-${++nextId}`, action, arguments: { command: '&& shutdown' } }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'ACTION_NOT_ALLOWED');
  }
});

test('requestId is bound to one action and duplicate requestId is idempotent', async () => {
  const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
  const requestId = `idempotent-${++nextId}`;
  const first = await request('/omega/admin/actions', {
    method: 'POST', body: adminBody(fixture, fixture.session.nonce, { requestId, action: 'REQUEST_RESTART' }),
  });
  const status = await request(`/omega/admin/status${authQuery(fixture, first.body.nextNonce)}`);
  const second = await request('/omega/admin/actions', {
    method: 'POST', body: adminBody(fixture, status.body.nextNonce, { requestId, action: 'REQUEST_RESTART' }),
  });
  assert.equal(second.status, 202);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.actionId, first.body.actionId);
});

test('real high-impact executor is never used by the unapproved request path', async () => {
  const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
  const pending = await request('/omega/admin/actions', {
    method: 'POST', body: adminBody(fixture, fixture.session.nonce, { requestId: `safe-${++nextId}`, action: 'REQUEST_SHUTDOWN' }),
  });
  assert.equal(pending.status, 202);
  assert.equal(executorCalls.includes('REQUEST_SHUTDOWN'), false);
});

test('each high-impact semantic action uses the same one-time local approval workflow', async () => {
  for (const action of ['LOCK_WORKSTATION', 'REQUEST_LOGOFF', 'REQUEST_RESTART', 'REQUEST_SHUTDOWN']) {
    const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
    const pending = await request('/omega/admin/actions', {
      method: 'POST', body: adminBody(fixture, fixture.session.nonce, { requestId: `approve-${action.replaceAll('_', '-')}-${++nextId}`, action }),
    });
    assert.equal(pending.status, 202);
    approveAdminActionLocally(pending.body.actionId);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.deepEqual(executorCalls, ['LOCK_WORKSTATION', 'REQUEST_LOGOFF', 'REQUEST_RESTART', 'REQUEST_SHUTDOWN']);
});

test('approval expiry is fail-closed and cannot be approved afterward', async () => {
  const fixture = deviceSession(OMEGA_PERMISSION_LEVELS.OMEGA_ADMIN);
  const pending = await request('/omega/admin/actions', {
    method: 'POST', body: adminBody(fixture, fixture.session.nonce, { requestId: `expire-${++nextId}`, action: 'REQUEST_RESTART' }),
  });
  _expireAdminActionForTests(pending.body.actionId);
  assert.throws(
    () => approveAdminActionLocally(pending.body.actionId),
    error => error instanceof OmegaAdminError && error.code === 'APPROVAL_EXPIRED',
  );
  assert.equal(executorCalls.length, 0);
});
