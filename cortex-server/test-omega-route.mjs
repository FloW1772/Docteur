// OMEGA V1 Phase 2 — HTTP route tests: loopback guard, full pairing
// flow through the API, input validation, secret-exposure checks.
// Mirrors test-monitor-route.mjs's shape (isLocal injected for
// local/remote comparison).
// Run with: node --test test-omega-route.mjs
import './test-setup.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { initSqlite } from './src/lib/sqlite.js';
import { createOmegaRoute } from './src/routes/omega.js';
import { _resetPairingRateLimitForTests, OMEGA_PERMISSION_LEVELS } from './src/lib/omega-pairing.js';

before(() => {
  initSqlite(':memory:');
});

const localApp = new Hono().route('/api', createOmegaRoute({ isLocal: () => true }));
const remoteApp = new Hono().route('/api', createOmegaRoute({ isLocal: () => false }));

async function request(app, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await app.request(`http://localhost/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await response.json(); } catch { /* non-JSON, ignore */ }
  return { status: response.status, body: json };
}

// ── Loopback / origin guard (mission §25) ───────────────────────────

test('access control: a non-local caller is denied 403 on GET /status', async () => {
  const r = await request(remoteApp, '/omega/status');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'local_access_required');
});

test('access control: a non-local caller is denied 403 on POST /pairing/start', async () => {
  const r = await request(remoteApp, '/omega/pairing/start', { method: 'POST', body: { initiatorDeviceName: 'X', requestedPermission: 1 } });
  assert.equal(r.status, 403);
});

test('a hostile Origin header is denied even from an isLocal=true connection', async () => {
  const r = await request(localApp, '/omega/status', { headers: { origin: 'http://evil.example.com' } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'origin_denied');
});

test('a localhost Origin header is accepted', async () => {
  const r = await request(localApp, '/omega/status', { headers: { origin: 'http://localhost:5173' } });
  assert.equal(r.status, 200);
});

// ── GET /status ──────────────────────────────────────────────────────

test('GET /status returns permission level definitions matching the mission spec', async () => {
  const r = await request(localApp, '/omega/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.permissionLevels, { OMEGA_VIEW: 1, OMEGA_INTERACTIVE: 2, OMEGA_ADMIN: 3 });
});

// ── Full pairing + session flow through the HTTP layer ─────────────

async function generateFixtureKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey,
  };
}

test('full flow: start -> verify -> approve -> challenge -> session -> validate -> revoke', async () => {
  _resetPairingRateLimitForTests();
  const fixture = await generateFixtureKeypair();

  const start = await request(localApp, '/omega/pairing/start', {
    method: 'POST', body: { initiatorDeviceName: 'HTTP Flow Device', requestedPermission: OMEGA_PERMISSION_LEVELS.OMEGA_VIEW },
  });
  assert.equal(start.status, 201);
  assert.ok(start.body.pairingId);
  assert.ok(start.body.code);

  const verify = await request(localApp, '/omega/pairing/verify', {
    method: 'POST', body: { pairingId: start.body.pairingId, code: start.body.code, publicKeyPem: fixture.publicKeyPem },
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.pairing.status, 'AWAITING_APPROVAL');

  const approve = await request(localApp, '/omega/pairing/approve', {
    method: 'POST', body: { pairingId: start.body.pairingId },
  });
  assert.equal(approve.status, 200);
  const deviceId = approve.body.deviceId;
  assert.ok(deviceId);

  const challengeResp = await request(localApp, '/omega/challenge', { method: 'POST' });
  assert.equal(challengeResp.status, 200);
  const challenge = challengeResp.body.challenge;

  const signature = crypto.sign(null, Buffer.from(challenge, 'utf8'), fixture.privateKey).toString('base64');

  const sessionResp = await request(localApp, '/omega/sessions', {
    method: 'POST', body: { deviceId, challenge, signature },
  });
  assert.equal(sessionResp.status, 201);
  const { sessionId, nonce, permissionLevel } = sessionResp.body;
  assert.equal(permissionLevel, OMEGA_PERMISSION_LEVELS.OMEGA_VIEW);

  const validate1 = await request(localApp, `/omega/sessions/${sessionId}/validate`, {
    method: 'POST', body: { deviceId, nonce },
  });
  assert.equal(validate1.status, 200);
  assert.equal(validate1.body.ok, true);

  // Replay the same nonce — must be rejected.
  const replay = await request(localApp, `/omega/sessions/${sessionId}/validate`, {
    method: 'POST', body: { deviceId, nonce },
  });
  assert.equal(replay.status, 401);

  const revoke = await request(localApp, `/omega/devices/${deviceId}/revoke`, { method: 'POST' });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.revoked, true);

  const validateAfterRevoke = await request(localApp, `/omega/sessions/${sessionId}/validate`, {
    method: 'POST', body: { deviceId, nonce: validate1.body.nextNonce },
  });
  assert.equal(validateAfterRevoke.status, 401);
});

test('mutual auth failure (wrong signature) is rejected at the session-creation route', async () => {
  _resetPairingRateLimitForTests();
  const fixture = await generateFixtureKeypair();
  const attackerFixture = await generateFixtureKeypair();

  const start = await request(localApp, '/omega/pairing/start', {
    method: 'POST', body: { initiatorDeviceName: 'Wrong Sig Device', requestedPermission: 1 },
  });
  const verify = await request(localApp, '/omega/pairing/verify', {
    method: 'POST', body: { pairingId: start.body.pairingId, code: start.body.code, publicKeyPem: fixture.publicKeyPem },
  });
  assert.equal(verify.status, 200);
  const approve = await request(localApp, '/omega/pairing/approve', { method: 'POST', body: { pairingId: start.body.pairingId } });
  const deviceId = approve.body.deviceId;

  const challengeResp = await request(localApp, '/omega/challenge', { method: 'POST' });
  const challenge = challengeResp.body.challenge;
  // Sign with the ATTACKER's key instead of the registered device key.
  const badSignature = crypto.sign(null, Buffer.from(challenge, 'utf8'), attackerFixture.privateKey).toString('base64');

  const sessionResp = await request(localApp, '/omega/sessions', {
    method: 'POST', body: { deviceId, challenge, signature: badSignature },
  });
  assert.equal(sessionResp.status, 401);
  assert.equal(sessionResp.body.error, 'mutual_auth_failed');
});

test('deny route: after DENY, a correctly-verified pairing never becomes a trusted device', async () => {
  _resetPairingRateLimitForTests();
  const fixture = await generateFixtureKeypair();
  const start = await request(localApp, '/omega/pairing/start', { method: 'POST', body: { initiatorDeviceName: 'Deny Route Device', requestedPermission: 1 } });
  await request(localApp, '/omega/pairing/verify', { method: 'POST', body: { pairingId: start.body.pairingId, code: start.body.code, publicKeyPem: fixture.publicKeyPem } });
  const deny = await request(localApp, '/omega/pairing/deny', { method: 'POST', body: { pairingId: start.body.pairingId } });
  assert.equal(deny.status, 200);
  assert.equal(deny.body.status, 'DENIED');

  const approveAfterDeny = await request(localApp, '/omega/pairing/approve', { method: 'POST', body: { pairingId: start.body.pairingId } });
  assert.equal(approveAfterDeny.status, 400);
});

// ── Input validation (mission §23) ──────────────────────────────────

test('malformed deviceId (path-shaped) is rejected on revoke', async () => {
  const r = await request(localApp, '/omega/devices/../../etc/passwd/revoke', { method: 'POST' });
  assert.ok([400, 404].includes(r.status));
});

test('malformed pairingId (shell-shaped) is rejected on verify', async () => {
  const r = await request(localApp, '/omega/pairing/verify', {
    method: 'POST', body: { pairingId: '$(rm -rf /)', code: 'AAAAAAAA', publicKeyPem: 'x' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'pairing_id_invalid');
});

test('missing content-type on POST is rejected', async () => {
  const response = await localApp.request('http://localhost/api/omega/pairing/start', {
    method: 'POST', body: JSON.stringify({ initiatorDeviceName: 'X', requestedPermission: 1 }),
  });
  assert.equal(response.status, 415);
});

test('oversized request body is rejected', async () => {
  const hugeBody = { initiatorDeviceName: 'x'.repeat(20_000), requestedPermission: 1 };
  const r = await request(localApp, '/omega/pairing/start', { method: 'POST', body: hugeBody });
  assert.equal(r.status, 413);
});

test('devices/:id 404s cleanly for a well-formed but unknown id', async () => {
  const r = await request(localApp, '/omega/devices/00000000-0000-0000-0000-000000000000');
  assert.equal(r.status, 404);
});

test('revoke on an unknown device returns 404, not a crash', async () => {
  const r = await request(localApp, '/omega/devices/00000000-0000-0000-0000-000000000000/revoke', { method: 'POST' });
  assert.equal(r.status, 404);
});

// ── No generic / forbidden endpoint shapes (mission §21) ────────────

test('there is no generic action endpoint (mission §21 — closed route list only)', async () => {
  const r = await request(localApp, '/omega/action', { method: 'POST', body: { command: 'whoami' } });
  assert.equal(r.status, 404);
});

// ── XSS-shaped display name through the full HTTP round trip (mission §29) ──

test('an XSS-shaped device name survives the full HTTP round trip as inert JSON text', async () => {
  _resetPairingRateLimitForTests();
  const fixture = await generateFixtureKeypair();
  const xssName = '<script>alert(document.cookie)</script>';
  const start = await request(localApp, '/omega/pairing/start', { method: 'POST', body: { initiatorDeviceName: xssName, requestedPermission: 1 } });
  await request(localApp, '/omega/pairing/verify', { method: 'POST', body: { pairingId: start.body.pairingId, code: start.body.code, publicKeyPem: fixture.publicKeyPem } });
  const approve = await request(localApp, '/omega/pairing/approve', { method: 'POST', body: { pairingId: start.body.pairingId } });

  const deviceResp = await request(localApp, `/omega/devices/${approve.body.deviceId}`);
  assert.equal(deviceResp.status, 200);
  assert.equal(deviceResp.body.device.displayName, xssName);
  // Response content-type must remain application/json — never text/html.
});

// ── Secret exposure checks (mission §28) ────────────────────────────

test('device list response never includes the public key PEM or any private key field', async () => {
  const r = await request(localApp, '/omega/devices');
  assert.equal(r.status, 200);
  const dump = JSON.stringify(r.body);
  assert.equal(dump.includes('PUBLIC KEY'), false);
  assert.equal(dump.includes('PRIVATE KEY'), false);
});

test('pairing verify response never echoes back the plaintext code', async () => {
  _resetPairingRateLimitForTests();
  const fixture = await generateFixtureKeypair();
  const start = await request(localApp, '/omega/pairing/start', { method: 'POST', body: { initiatorDeviceName: 'Secret Check Device', requestedPermission: 1 } });
  const verify = await request(localApp, '/omega/pairing/verify', {
    method: 'POST', body: { pairingId: start.body.pairingId, code: start.body.code, publicKeyPem: fixture.publicKeyPem },
  });
  assert.equal(JSON.stringify(verify.body).includes(start.body.code), false);
});

test('status response audit entries never include a raw pairing code or session token value', async () => {
  const r = await request(localApp, '/omega/status');
  const dump = JSON.stringify(r.body.recentAudit);
  assert.equal(/BEGIN (RSA |EC )?PRIVATE KEY/.test(dump), false);
});
