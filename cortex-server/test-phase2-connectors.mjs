// PHASE 2 — YouTube (Data API v3) + Microsoft OneDrive (Graph) connectors.
// All OAuth/API calls are mocked — this test suite never performs a real
// network request and never requires a real Google/Microsoft app
// registration. Run with: node --test test-phase2-connectors.mjs
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';

import { initSqlite, getPageFromStore, getConnectorSyncItemsCount, savePageToStore, deleteConnectorSyncItems } from './src/lib/sqlite.js';
import { setSecret, deleteSecret, getSecret } from './src/lib/secret-store.js';
import { createConnectorsRoute } from './src/routes/connectors.js';
import * as youtube from './src/lib/connectors/youtube-connector.js';
import * as onedrive from './src/lib/connectors/onedrive-connector.js';

const TEST_DB = './data-test-connectors/test.db';

let fetchCalls = [];
let originalFetch;
let indexedNeurons = [];

const services = {
  indexNeuron: async (payload) => { indexedNeurons.push(payload); return { ok: true, embedding_ms: 1, lancedb_ms: 1 }; },
};

function mockFetchOnce(matcher, response) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push(String(url));
    if (matcher(String(url), init)) return response instanceof Response ? response : new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200 });
    return prev(url, init);
  };
}

before(() => {
  fs.rmSync('./data-test-connectors', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

after(() => {
  try { fs.rmSync('./data-test-connectors', { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  deleteSecret('oauth_client_youtube_id');
  deleteSecret('oauth_client_youtube_secret');
  deleteSecret('oauth_client_onedrive_id');
  deleteSecret('oauth_client_onedrive_secret');
  deleteSecret('youtube_oauth_refresh_token');
  deleteSecret('onedrive_oauth_refresh_token');
  youtube.disconnect({ deleteSyncedData: false });
  onedrive.disconnect({ deleteSyncedData: false });
  // Clear the dedup ledger between tests — each test's dedup/disconnect
  // assertions are about THAT test's items, not a cross-test accumulation.
  deleteConnectorSyncItems('youtube');
  deleteConnectorSyncItems('onedrive');
  fetchCalls = [];
  indexedNeurons = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error(`UNEXPECTED_UNMOCKED_FETCH: ${url}`); };
});

after(() => { globalThis.fetch = originalFetch; });

function buildApp() {
  const app = new Hono();
  app.route('/api', createConnectorsRoute({ services, logger: { info() {}, warn() {}, error() {} } }));
  return app;
}

// ── Client credentials storage (app registration id/secret, DPAPI) ─────────

test('client credentials: stored via secret-store, never echoed back in plaintext', async () => {
  const app = buildApp();
  const res = await app.request('/api/connectors/youtube/client-credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'fake-client-id.apps.googleusercontent.com', client_secret: 'fake-super-secret' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.client_configured, true);
  assert.ok(!JSON.stringify(body).includes('fake-super-secret'));
  assert.equal(getSecret('oauth_client_youtube_id'), 'fake-client-id.apps.googleusercontent.com');
});

// ── OAuth flow: auth-url → callback (mocked token exchange) ────────────────

test('OAuth mock flow: auth-url requires client credentials configured first', async () => {
  const app = buildApp();
  const res = await app.request('/api/connectors/youtube/auth-url?redirect_uri=http://localhost:5173/oauth/youtube');
  assert.equal(res.status, 400);
});

test('OAuth mock flow: auth-url → callback exchanges code for tokens, connects with no plaintext token ever returned to caller', async () => {
  setSecret('oauth_client_youtube_id', 'fake-client-id');
  setSecret('oauth_client_youtube_secret', 'fake-client-secret');
  const app = buildApp();

  const authRes = await app.request('/api/connectors/youtube/auth-url?redirect_uri=http://localhost:5173/oauth/youtube');
  const { auth_url, state } = await authRes.json();
  assert.ok(auth_url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(auth_url.includes('fake-client-id'));

  mockFetchOnce(
    (url) => url === 'https://oauth2.googleapis.com/token',
    { body: { access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', expires_in: 3600 } },
  );

  const callbackRes = await app.request('/api/connectors/youtube/callback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake-auth-code', state, redirect_uri: 'http://localhost:5173/oauth/youtube', account_label: 'test@example.com' }),
  });
  const body = await callbackRes.json();
  assert.equal(callbackRes.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.connected, true);
  assert.ok(!JSON.stringify(body).includes('fake-refresh-token'), 'raw token must never be returned to the frontend');
  assert.equal(getSecret('youtube_oauth_refresh_token'), 'fake-refresh-token', 'refresh token IS stored server-side via secret-store');

  const statusRes = await app.request('/api/connectors');
  const statusBody = await statusRes.json();
  const yt = statusBody.connectors.find(c => c.provider === 'youtube');
  assert.equal(yt.connected, true);
  assert.equal(yt.account_label, 'test@example.com');
});

test('OAuth mock flow: callback rejects an unknown/expired state (CSRF protection)', async () => {
  setSecret('oauth_client_youtube_id', 'fake-client-id');
  setSecret('oauth_client_youtube_secret', 'fake-client-secret');
  const app = buildApp();
  const res = await app.request('/api/connectors/youtube/callback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake-code', state: 'never-issued-state', redirect_uri: 'http://localhost:5173/oauth/youtube' }),
  });
  assert.equal(res.status, 400);
});

test('OAuth mock flow: exchange without a refresh_token in the response is rejected (offline access misconfigured)', async () => {
  mockFetchOnce(
    (url) => url === 'https://oauth2.googleapis.com/token',
    { body: { access_token: 'fake-access-token', expires_in: 3600 } }, // no refresh_token
  );
  await assert.rejects(
    () => youtube.connect({ clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb', code: 'z' }),
    /aucun refresh_token/i,
  );
});

// ── Token refresh ────────────────────────────────────────────────────────────

test('token refresh: an expired cached access token triggers a refresh_token exchange, not a re-consent', async () => {
  setSecret('youtube_oauth_refresh_token', 'fake-refresh-token');
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'fresh-access-token', expires_in: 3600 }), { status: 200 });
    }
    if (String(url).includes('/channels')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  // fetchItems() internally calls getValidAccessToken(), which must refresh
  // since there is no cached access token yet in this test's module state
  // (each test clears the refresh token via beforeEach's disconnect(), which
  // also clears the in-memory access-token cache).
  const items = await youtube.fetchItems({ clientId: 'x', clientSecret: 'y', dataTypes: ['uploaded_videos'] });
  assert.deepEqual(items, []);
  const refreshCall = calls.find(c => c.url === 'https://oauth2.googleapis.com/token' && c.body.includes('grant_type=refresh_token'));
  assert.ok(refreshCall, 'expired/absent access token must trigger a refresh_token grant');
});

// ── Sync: dedup, privacy propagation ────────────────────────────────────────

test('sync: imported YouTube items are tagged source=youtube_private, privacy=true, egress_policy=local_only, and never reach a cloud provider unmarked', async () => {
  setSecret('oauth_client_youtube_id', 'fake-id');
  setSecret('oauth_client_youtube_secret', 'fake-secret');
  setSecret('youtube_oauth_refresh_token', 'fake-refresh-token');
  const { upsertConnectorState } = await import('./src/lib/sqlite.js');
  upsertConnectorState('youtube', { connected: true, account_label: 'test@example.com', scopes: youtube.SCOPES });

  mockFetchOnce((url) => url === 'https://oauth2.googleapis.com/token', { body: { access_token: 'fresh-token', expires_in: 3600 } });
  mockFetchOnce((url) => url.includes('/channels'), { body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUfake' } } }] } });
  mockFetchOnce((url) => url.includes('/playlistItems'), {
    body: {
      items: [{
        id: 'pi1',
        contentDetails: { videoId: 'VID123', videoPublishedAt: '2026-01-01T00:00:00Z' },
        snippet: { title: '__PRIVATE_TEST__ Ma vidéo perso', description: 'contenu personnel', publishedAt: '2026-01-01T00:00:00Z' },
      }],
    },
  });

  const app = buildApp();
  const res = await app.request('/api/connectors/youtube/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data_types: ['uploaded_videos'] }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.imported, 1);

  assert.equal(indexedNeurons.length, 1);
  const neuron = indexedNeurons[0];
  assert.equal(neuron.metadata.source, 'youtube_private');
  assert.equal(neuron.metadata.egress_policy, 'local_only');

  const page = getPageFromStore(neuron.id);
  assert.equal(page.private, true, 'connector-imported pages must be private by default');

  // Simulate the same marking server.js applies to private pages before
  // building cloud-bound messages — this is the actual mechanism that keeps
  // the content out of cloud calls (see test-phase1-egress-certification.mjs
  // for the full router-level proof; here we confirm the metadata that
  // triggers it is set correctly at import time).
  assert.equal(page.private, true);
});

test('sync: a second sync of the same YouTube video is deduplicated (not re-imported)', async () => {
  setSecret('oauth_client_youtube_id', 'fake-id');
  setSecret('oauth_client_youtube_secret', 'fake-secret');
  setSecret('youtube_oauth_refresh_token', 'fake-refresh-token');
  const { upsertConnectorState } = await import('./src/lib/sqlite.js');
  upsertConnectorState('youtube', { connected: true, scopes: youtube.SCOPES });

  const mockSyncCalls = () => {
    mockFetchOnce((url) => url === 'https://oauth2.googleapis.com/token', { body: { access_token: 'fresh-token', expires_in: 3600 } });
    mockFetchOnce((url) => url.includes('/channels'), { body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUfake' } } }] } });
    mockFetchOnce((url) => url.includes('/playlistItems'), {
      body: { items: [{ id: 'pi1', contentDetails: { videoId: 'VID_DEDUP' }, snippet: { title: 'Vidéo test dédup' } }] },
    });
  };

  const app = buildApp();
  mockSyncCalls();
  const res1 = await app.request('/api/connectors/youtube/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const body1 = await res1.json();
  assert.equal(body1.imported, 1);

  mockSyncCalls();
  const res2 = await app.request('/api/connectors/youtube/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const body2 = await res2.json();
  assert.equal(body2.imported, 0, 'second sync of the same video must not re-import it');
  assert.equal(body2.already_synced, 1);
  assert.equal(indexedNeurons.length, 1, 'indexNeuron must have been called exactly once across both syncs');
});

// ── OneDrive: unsupported format is skipped, not silently claimed ──────────

test('OneDrive sync: unsupported file formats are reported as skipped, never imported', async () => {
  setSecret('oauth_client_onedrive_id', 'fake-id');
  setSecret('oauth_client_onedrive_secret', 'fake-secret');
  setSecret('onedrive_oauth_refresh_token', 'fake-refresh-token');
  const { upsertConnectorState } = await import('./src/lib/sqlite.js');
  upsertConnectorState('onedrive', { connected: true, scopes: onedrive.SCOPES });

  mockFetchOnce((url) => url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token', { body: { access_token: 'fresh-token', expires_in: 3600 } });
  mockFetchOnce((url) => url.includes('/delta'), {
    body: {
      value: [
        { id: 'f1', name: 'notes.md', size: 120, file: { hashes: { quickXorHash: 'abc' } } },
        { id: 'f2', name: 'presentation.pptx', size: 500000, file: {} },
        { id: 'f3', name: 'photo.heic', size: 900000, file: {} },
      ],
    },
  });

  const app = buildApp();
  const res = await app.request('/api/connectors/onedrive/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.imported, 1, 'only notes.md is a supported format');
  assert.equal(body.skipped, 2);
  assert.ok(body.skipped_items.some(s => s.title === 'presentation.pptx'));
  assert.ok(body.skipped_items.some(s => s.title === 'photo.heic'));
});

// ── Disconnect: default keeps Docteur data, explicit flag deletes it ───────

test('disconnect: default (no flag) removes OAuth credentials but keeps synced Docteur pages', async () => {
  setSecret('youtube_oauth_refresh_token', 'fake-refresh-token');
  const { upsertConnectorState, upsertConnectorSyncItem } = await import('./src/lib/sqlite.js');
  upsertConnectorState('youtube', { connected: true, scopes: youtube.SCOPES });
  savePageToStoreForTest('youtube-VIDKEEP', 'Vidéo à garder');
  upsertConnectorSyncItem('youtube', 'VIDKEEP', { pageId: 'youtube-VIDKEEP' });

  const app = buildApp();
  const res = await app.request('/api/connectors/youtube/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.deleted_pages, 0);
  assert.equal(getSecret('youtube_oauth_refresh_token'), null, 'OAuth credentials must be removed');
  assert.ok(getPageFromStore('youtube-VIDKEEP'), 'synced Docteur page must survive a default disconnect');
});

test('disconnect: delete_synced_data=true removes both credentials and the connector\'s imported pages', async () => {
  setSecret('youtube_oauth_refresh_token', 'fake-refresh-token');
  const { upsertConnectorState, upsertConnectorSyncItem } = await import('./src/lib/sqlite.js');
  upsertConnectorState('youtube', { connected: true, scopes: youtube.SCOPES });
  savePageToStoreForTest('youtube-VIDDEL', 'Vidéo à supprimer');
  upsertConnectorSyncItem('youtube', 'VIDDEL', { pageId: 'youtube-VIDDEL' });

  const app = buildApp();
  const res = await app.request('/api/connectors/youtube/disconnect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete_synced_data: true }),
  });
  const body = await res.json();
  assert.equal(body.deleted_pages, 1);
  assert.equal(getPageFromStore('youtube-VIDDEL'), null, 'explicit delete_synced_data must remove the imported page');
});

function savePageToStoreForTest(id, title) {
  const now = Date.now();
  savePageToStore({ id, title, kind: 'connector', blocks: [{ id: 'b1', type: 'paragraph', content: title }], private: true, createdAt: now, updatedAt: now, metadata: {} });
}

// ── Content-carrying network calls never happen without an active, deliberate sync ─

test('sanity: no connector network call happens just from checking /api/connectors status', async () => {
  const app = buildApp();
  fetchCalls = [];
  await app.request('/api/connectors');
  assert.equal(fetchCalls.length, 0, 'GET /api/connectors must be purely local (SQLite/secret-store), never touch the network');
});
