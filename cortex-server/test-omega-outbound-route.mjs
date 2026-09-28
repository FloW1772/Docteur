import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createOmegaOutboundRoute } from './src/routes/omega-outbound.js';
import { recordAudit } from './src/lib/omega-outbound-store.js';

initSqlite(':memory:');

function app(options) {
  const value = new Hono();
  value.route('/api', createOmegaOutboundRoute({ certificateFingerprint: 'aa'.repeat(32), ...options }));
  return value;
}

const localTls = app({ isLocal: () => true, isTls: () => true, clientOptions: { allowLoopback: true } });
const remoteTls = app({ isLocal: () => false, isTls: () => true });
const localClear = app({ isLocal: () => true, isTls: () => false });

test('local outbound control API is loopback and Origin guarded', async () => {
  const denied = await remoteTls.request('http://localhost/api/omega/outbound/sessions');
  assert.equal(denied.status, 403);
  const origin = await localTls.request('http://localhost/api/omega/outbound/sessions', { headers: { origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
  const allowed = await localTls.request('http://localhost/api/omega/outbound/sessions', { headers: { origin: 'http://localhost:5173' } });
  assert.equal(allowed.status, 200);
});

test('local JSON controls enforce content type and reject oversized bodies', async () => {
  const missing = await localTls.request('http://localhost/api/omega/outbound/connect', { method: 'POST', body: '{}' });
  assert.equal(missing.status, 415);
  const huge = await localTls.request('http://localhost/api/omega/outbound/connect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(70_000) }),
  });
  assert.equal(huge.status, 413);
});

test('remote OMEGA V2 control refuses cleartext even on loopback', async () => {
  const response = await localClear.request('http://localhost/api/omega-v2/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 426);
  assert.equal((await response.json()).error, 'TLS_REQUIRED');
});

test('Phase 2 exposes no VIEW, INTERACTIVE, ADMIN, generic RPC or proxy route', async () => {
  for (const route of ['view', 'interactive', 'admin', 'sendRaw', 'request', 'execute', 'invoke', 'rpc', 'proxy']) {
    const response = await localTls.request(`https://localhost/api/omega-v2/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404, route);
  }
});

test('outbound trust is not inherited from OMEGA V1 tables', async () => {
  getDatabase().prepare(`INSERT INTO omega_devices
    (id, display_name, public_key_pem, fingerprint, permission_level, created_at)
    VALUES ('legacy-v1', 'Legacy', 'public', 'fingerprint', 3, ?)` ).run(new Date().toISOString());
  const response = await localTls.request('http://localhost/api/omega/outbound/connect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ remoteDeviceId: 'legacy-v1', permission: 'ADMIN' }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'DEVICE_UNTRUSTED');
});

test('outbound audit rejects arbitrary event types', () => {
  assert.throws(() => recordAudit('ARBITRARY_EVENT', { result: 'x' }), /omega_v2_audit_event_invalid/);
});

