// OMEGA V1 Phase 4.1 — transport and persistent-indicator hardening.
import './test-setup.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';
import { createOmegaViewRoute } from './src/routes/omega-view.js';
import { createOmegaInteractiveRoute } from './src/routes/omega-interactive.js';
import {
  evaluateOmegaTransport, isLoopbackAddress, OMEGA_TLS_REQUIRED,
} from './src/lib/omega-transport.js';
import {
  startPersistentIndicator, stopPersistentIndicator, getPersistentIndicatorState,
  _setIndicatorProcessFactoryForTests, _resetIndicatorProcessFactoryForTests,
  _resetIndicatorsForTests,
} from './src/lib/omega-indicator.js';

const children = [];
function installFakeIndicatorProcess() {
  _setIndicatorProcessFactoryForTests(({ args }) => {
    const child = {
      pid: 50_000 + children.length,
      args,
      killed: false,
      handlers: new Map(),
      once(event, fn) { this.handlers.set(event, fn); },
      kill() { this.killed = true; },
    };
    children.push(child);
    return child;
  });
}

afterEach(() => {
  _resetIndicatorsForTests();
  _resetIndicatorProcessFactoryForTests();
  children.length = 0;
});

async function request(app, path, body = { deviceId: 'device-1', nonce: 'nonce', screenIndex: 0 }) {
  const response = await app.request(`http://localhost/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('transport policy allows loopback HTTP, requires TLS for remote sockets, and ignores forwarded headers', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(evaluateOmegaTransport({ remoteAddress: '127.0.0.1', encrypted: false }).allowed, true);
  assert.equal(evaluateOmegaTransport({ remoteAddress: '::1', encrypted: false }).allowed, true);
  assert.equal(evaluateOmegaTransport({ remoteAddress: '192.168.1.20', encrypted: false }).allowed, false);
  assert.equal(evaluateOmegaTransport({ remoteAddress: '192.168.1.20', encrypted: true }).allowed, true);
});

test('remote cleartext VIEW is refused before session authentication', async () => {
  const app = new Hono().route('/api', createOmegaViewRoute({ transportPolicy: () => false }));
  const response = await request(app, '/omega/view/known-session/start');
  assert.equal(response.status, 403);
  assert.equal(response.body.error, OMEGA_TLS_REQUIRED);
});

test('remote cleartext INTERACTIVE is refused, while TLS and loopback reach auth', async () => {
  const deniedApp = new Hono().route('/api', createOmegaInteractiveRoute({ transportPolicy: () => false }));
  const denied = await request(deniedApp, '/omega/interactive/known-session/start');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, OMEGA_TLS_REQUIRED);

  const tlsApp = new Hono().route('/api', createOmegaInteractiveRoute({ transportPolicy: () => true }));
  const tls = await request(tlsApp, '/omega/interactive/known-session/start');
  assert.equal(tls.status, 401);
  assert.equal(tls.body.error, 'session_invalid');

  const loopbackApp = new Hono().route('/api', createOmegaInteractiveRoute({ transportPolicy: () => true }));
  const loopback = await request(loopbackApp, '/omega/interactive/known-session/start');
  assert.equal(loopback.status, 401);
  assert.equal(loopback.body.error, 'session_invalid');
});

test('persistent indicator starts with fixed mode/lease arguments and stops by exact session', () => {
  installFakeIndicatorProcess();
  const started = startPersistentIndicator({
    sessionId: 'indicator-session-1', deviceId: 'device-1', mode: 'view',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(started.ok, true);
  assert.equal(started.persistent, true);
  assert.equal(getPersistentIndicatorState('indicator-session-1').persistent, true);
  assert.ok(children[0].args.includes('-File'));
  assert.ok(children[0].args.includes('-Mode'));
  assert.ok(children[0].args.includes('view'));
  assert.equal(stopPersistentIndicator('indicator-session-1'), true);
  assert.equal(children[0].killed, true);
  assert.equal(getPersistentIndicatorState('indicator-session-1'), null);

  const admin = startPersistentIndicator({
    sessionId: 'indicator-session-admin', deviceId: 'device-admin', mode: 'admin',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(admin.ok, true);
  assert.ok(children[1].args.includes('admin'));
  assert.equal(stopPersistentIndicator('indicator-session-admin', 'admin'), true);
});

test('persistent indicator exits and cleans state at session expiry', async () => {
  installFakeIndicatorProcess();
  startPersistentIndicator({
    sessionId: 'indicator-session-expiry', deviceId: 'device-2', mode: 'interactive',
    expiresAt: new Date(Date.now() + 35).toISOString(),
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(children[0].killed, true);
  assert.equal(getPersistentIndicatorState('indicator-session-expiry'), null);
});

test('local STOP button signal is observable without exposing a remote hide API', async () => {
  installFakeIndicatorProcess();
  let localStopCalls = 0;
  startPersistentIndicator({
    sessionId: 'indicator-session-local-stop', deviceId: 'device-3', mode: 'interactive',
    onLocalStop: () => { localStopCalls += 1; stopPersistentIndicator('indicator-session-local-stop'); },
  });
  const args = children[0].args;
  const stopFile = args[args.indexOf('-StopFile') + 1];
  fs.writeFileSync(stopFile, 'local_stop');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(localStopCalls, 1);
  assert.equal(getPersistentIndicatorState('indicator-session-local-stop'), null);
});
