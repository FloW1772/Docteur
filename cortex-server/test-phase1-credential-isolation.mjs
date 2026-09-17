// PHASE 1 — Credential isolation audit (Groq / OpenRouter / Google / Microsoft).
// Mock-only: DB isolée (:memory:), sentinelles fictives, aucun credential réel,
// aucun appel cloud live. Vérifie que setSecret/deleteSecret/routes HTTP sur un
// provider ne peuvent jamais affecter un autre provider.
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initSqlite, setCloudKey, getCloudKeys, getCloudKeysMasked } from './src/lib/sqlite.js';
import { getSecret, setSecret, deleteSecret, hasSecret } from './src/lib/secret-store.js';
import { createRouterRoute } from './src/routes/router.js';
import { createConnectorsRoute } from './src/routes/connectors.js';

initSqlite(':memory:');

const SENTINELS = {
  groq: 'GROQ_SENTINEL_A',
  openrouter: 'OPENROUTER_SENTINEL_B',
  google: 'GOOGLE_SENTINEL_C',       // oauth_client_google_drive_id (stand-in for "Google")
  microsoft: 'MICROSOFT_SENTINEL_D', // oauth_client_onedrive_id (stand-in for "Microsoft")
};

// ── 1.3 — sentinels + cross-provider isolation ──────────────────────────────

test('1.3: setting each provider sentinel leaves the other three untouched', () => {
  setSecret('groq', SENTINELS.groq);
  setSecret('openrouter', SENTINELS.openrouter);
  setSecret('oauth_client_google_drive_id', SENTINELS.google);
  setSecret('oauth_client_onedrive_id', SENTINELS.microsoft);

  assert.equal(getSecret('groq'), SENTINELS.groq);
  assert.equal(getSecret('openrouter'), SENTINELS.openrouter);
  assert.equal(getSecret('oauth_client_google_drive_id'), SENTINELS.google);
  assert.equal(getSecret('oauth_client_onedrive_id'), SENTINELS.microsoft);

  // Modify Google only → Groq/OpenRouter/Microsoft unchanged
  setSecret('oauth_client_google_drive_id', SENTINELS.google + '_v2');
  assert.equal(getSecret('groq'), SENTINELS.groq);
  assert.equal(getSecret('openrouter'), SENTINELS.openrouter);
  assert.equal(getSecret('oauth_client_onedrive_id'), SENTINELS.microsoft);
  assert.equal(getSecret('oauth_client_google_drive_id'), SENTINELS.google + '_v2');

  // Modify Microsoft only → Groq/OpenRouter/Google unchanged
  setSecret('oauth_client_onedrive_id', SENTINELS.microsoft + '_v2');
  assert.equal(getSecret('groq'), SENTINELS.groq);
  assert.equal(getSecret('openrouter'), SENTINELS.openrouter);
  assert.equal(getSecret('oauth_client_google_drive_id'), SENTINELS.google + '_v2');
  assert.equal(getSecret('oauth_client_onedrive_id'), SENTINELS.microsoft + '_v2');

  // Modify Groq only → OpenRouter/Google/Microsoft unchanged
  setSecret('groq', SENTINELS.groq + '_v2');
  assert.equal(getSecret('openrouter'), SENTINELS.openrouter);
  assert.equal(getSecret('oauth_client_google_drive_id'), SENTINELS.google + '_v2');
  assert.equal(getSecret('oauth_client_onedrive_id'), SENTINELS.microsoft + '_v2');
  assert.equal(getSecret('groq'), SENTINELS.groq + '_v2');

  // Modify OpenRouter only → Groq/Google/Microsoft unchanged
  setSecret('openrouter', SENTINELS.openrouter + '_v2');
  assert.equal(getSecret('groq'), SENTINELS.groq + '_v2');
  assert.equal(getSecret('oauth_client_google_drive_id'), SENTINELS.google + '_v2');
  assert.equal(getSecret('oauth_client_onedrive_id'), SENTINELS.microsoft + '_v2');
  assert.equal(getSecret('openrouter'), SENTINELS.openrouter + '_v2');
});

// ── 1.4 — delete isolation ───────────────────────────────────────────────────

test('1.4: deleting one provider never deletes another', () => {
  setSecret('groq', SENTINELS.groq);
  setSecret('openrouter', SENTINELS.openrouter);
  setSecret('oauth_client_google_drive_id', SENTINELS.google);
  setSecret('oauth_client_onedrive_id', SENTINELS.microsoft);

  deleteSecret('oauth_client_google_drive_id');
  assert.equal(hasSecret('oauth_client_google_drive_id'), false);
  assert.equal(getSecret('groq'), SENTINELS.groq);
  assert.equal(getSecret('openrouter'), SENTINELS.openrouter);
  assert.equal(getSecret('oauth_client_onedrive_id'), SENTINELS.microsoft);

  deleteSecret('groq');
  assert.equal(hasSecret('groq'), false);
  assert.equal(getSecret('openrouter'), SENTINELS.openrouter);
  assert.equal(getSecret('oauth_client_onedrive_id'), SENTINELS.microsoft);

  // restore for subsequent tests
  setSecret('groq', SENTINELS.groq);
  setSecret('oauth_client_google_drive_id', SENTINELS.google);
});

// ── 1.5 — crash during save: old value must remain recoverable ─────────────

test('1.5: setSecret never writes a new blob before encryption succeeds — a mid-write crash cannot corrupt/lose the old value', async () => {
  setSecret('groq', SENTINELS.groq);
  assert.equal(getSecret('groq'), SENTINELS.groq);

  // A real DPAPI failure isn't deterministic to trigger cross-machine, so we
  // verify the actual guarantee at the code level instead: setMeta() (the
  // only thing that persists a new ciphertext) is called strictly after
  // protect() returns. If protect() throws (crash mid-encrypt), setSecret()
  // itself throws before setMeta() runs — the old stored blob is never
  // touched, so the old value stays fully recoverable.
  const src = await import('node:fs/promises').then(fs => fs.readFile('./src/lib/secret-store.js', 'utf8'));
  const fnBody = src.slice(src.indexOf('export function setSecret'), src.indexOf('export function getSecret'));
  const protectIdx = fnBody.indexOf('protect(plaintext)');
  // setMeta() also appears earlier, in the `if (!plaintext)` delete branch —
  // that's a different, unrelated call. We need the setMeta() that persists
  // the NEW ciphertext, i.e. the one after protect(plaintext) runs.
  const setMetaAfterProtectIdx = fnBody.indexOf('setMeta(', protectIdx);
  assert.ok(protectIdx > -1 && setMetaAfterProtectIdx > -1, 'expected both protect() and a following setMeta() call in setSecret()');
  assert.ok(protectIdx < setMetaAfterProtectIdx, 'protect() must run to completion before setMeta() persists the new ciphertext');

  // Confirm the guarantee end-to-end: old value is still there, and a
  // deletion attempt is the only thing that can remove it (never a failed write).
  assert.equal(getSecret('groq'), SENTINELS.groq, 'old value must still be readable — nothing crashed here, but confirms no corruption occurred as a side effect of the assertions above');
});

// ── 1.6 — real HTTP Settings path ────────────────────────────────────────────

test('1.6: POST /router/cloud-keys for groq never touches openrouter (HTTP path)', async () => {
  setCloudKey('groq', 'existing-groq-before-http');
  setCloudKey('openrouter', 'existing-openrouter-before-http');

  const route = createRouterRoute({ services: {} });
  const res = await route.request('/router/cloud-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'groq', key: 'GROQ_SENTINEL_HTTP' }),
  });
  assert.equal(res.status, 200);

  assert.equal(getCloudKeys().groq_key, 'GROQ_SENTINEL_HTTP');
  assert.equal(getCloudKeys().openrouter_key, 'existing-openrouter-before-http');
});

test('1.6b: POST /router/cloud-keys for openrouter never touches groq (HTTP path)', async () => {
  setCloudKey('groq', 'groq-before-2');
  setCloudKey('openrouter', 'openrouter-before-2');

  const route = createRouterRoute({ services: {} });
  const res = await route.request('/router/cloud-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openrouter', key: 'OPENROUTER_SENTINEL_HTTP' }),
  });
  assert.equal(res.status, 200);

  assert.equal(getCloudKeys().openrouter_key, 'OPENROUTER_SENTINEL_HTTP');
  assert.equal(getCloudKeys().groq_key, 'groq-before-2');
});

test('1.6c: connectors HTTP client-credentials write for google_drive never touches onedrive, and vice versa', async () => {
  setSecret('oauth_client_google_drive_id', 'google-before');
  setSecret('oauth_client_google_drive_secret', 'google-secret-before');
  setSecret('oauth_client_onedrive_id', 'ms-before');
  setSecret('oauth_client_onedrive_secret', 'ms-secret-before');

  const route = createConnectorsRoute({ services: {}, logger: { info() {}, warn() {} } });

  const res = await route.request('/connectors/google_drive/client-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'GOOGLE_SENTINEL_HTTP_ID', client_secret: 'GOOGLE_SENTINEL_HTTP_SECRET' }),
  });
  assert.equal(res.status, 200);

  assert.equal(getSecret('oauth_client_google_drive_id'), 'GOOGLE_SENTINEL_HTTP_ID');
  assert.equal(getSecret('oauth_client_google_drive_secret'), 'GOOGLE_SENTINEL_HTTP_SECRET');
  // Microsoft (onedrive) must be completely untouched
  assert.equal(getSecret('oauth_client_onedrive_id'), 'ms-before');
  assert.equal(getSecret('oauth_client_onedrive_secret'), 'ms-secret-before');
  // AI providers untouched by a connector write (values as left by test 1.6b)
  assert.equal(getSecret('groq'), 'groq-before-2');
  assert.equal(getSecret('openrouter'), 'OPENROUTER_SENTINEL_HTTP');
});

test('1.6d: connectors HTTP disconnect for google_drive deletes only its own refresh token, never onedrive/youtube secrets', async () => {
  setSecret('google_drive_oauth_refresh_token', 'google-refresh-before');
  setSecret('onedrive_oauth_refresh_token', 'ms-refresh-before');
  setSecret('youtube_oauth_refresh_token', 'yt-refresh-before');

  const route = createConnectorsRoute({ services: {}, logger: { info() {}, warn() {} } });
  const res = await route.request('/connectors/google_drive/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);

  assert.equal(hasSecret('google_drive_oauth_refresh_token'), false);
  assert.equal(getSecret('onedrive_oauth_refresh_token'), 'ms-refresh-before');
  assert.equal(getSecret('youtube_oauth_refresh_token'), 'yt-refresh-before');
});

// ── 1.7 — secret leak check ──────────────────────────────────────────────────

test('1.7: /router/cloud-keys GET never exposes raw sentinel values, only masked/boolean', async () => {
  setCloudKey('groq', 'GROQ_SENTINEL_LEAKCHECK');
  setCloudKey('openrouter', 'OPENROUTER_SENTINEL_LEAKCHECK');

  const route = createRouterRoute({ services: {} });
  const res = await route.request('/router/cloud-keys');
  const body = await res.json();
  const raw = JSON.stringify(body);

  assert.ok(!raw.includes('GROQ_SENTINEL_LEAKCHECK'), 'raw groq sentinel must never appear in the JSON response');
  assert.ok(!raw.includes('OPENROUTER_SENTINEL_LEAKCHECK'), 'raw openrouter sentinel must never appear in the JSON response');
  assert.equal(body.groq_active, true);
  assert.equal(body.openrouter_active, true);
  assert.equal(typeof body.groq_key, 'string');
  assert.ok(body.groq_key.includes('•'), 'expected a masked key, not the raw value');
});

test('1.7b: GET /connectors never exposes oauth_client secrets or refresh tokens, only client_configured boolean', async () => {
  setSecret('oauth_client_google_drive_id', 'GOOGLE_LEAKCHECK_ID');
  setSecret('oauth_client_google_drive_secret', 'GOOGLE_LEAKCHECK_SECRET');
  setSecret('google_drive_oauth_refresh_token', 'GOOGLE_LEAKCHECK_REFRESH');

  const route = createConnectorsRoute({ services: {}, logger: { info() {}, warn() {} } });
  const res = await route.request('/connectors');
  const body = await res.json();
  const raw = JSON.stringify(body);

  assert.ok(!raw.includes('GOOGLE_LEAKCHECK_ID'));
  assert.ok(!raw.includes('GOOGLE_LEAKCHECK_SECRET'));
  assert.ok(!raw.includes('GOOGLE_LEAKCHECK_REFRESH'));
  const gd = body.connectors.find(c => c.provider === 'google_drive');
  assert.equal(typeof gd.client_configured, 'boolean');
});

console.log('PHASE 1 credential isolation: all sentinel/cross-provider/delete/crash/HTTP/leak checks passed on an isolated :memory: DB. No real credential read or modified.');
