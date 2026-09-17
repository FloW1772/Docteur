import './test-setup.mjs';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, getPageFromStore, getConnectorState, deleteConnectorSyncItems, getMeta, setMeta, createNotebook, getNotebook } from './src/lib/sqlite.js';
import { setSecret, getSecret, deleteSecret } from './src/lib/secret-store.js';
import { createConnectorsRoute } from './src/routes/connectors.js';
import { createNotebookRoute } from './src/routes/notebook.js';
import { generateCodeVerifier, deriveCodeChallenge } from './src/lib/pkce.js';
import * as drive from './src/lib/connectors/google-drive-connector.js';
import * as onedrive from './src/lib/connectors/onedrive-connector.js';
import * as youtube from './src/lib/connectors/youtube-connector.js';
import { fetchWithDriveRetry } from './src/lib/connectors/google-drive-rate-limit.js';
import { downloadWithSizeLimit } from './src/lib/connectors/download-limits.js';
import { privacyFromSource, addEpisodicMemoryDeduped, selectMemoriesForBudget } from './src/lib/memory.js';
import { markPrivate, guardCloudCall } from './src/lib/privacy-guard.js';
import { isLocalOnlySource } from './src/lib/source-privacy.js';

const connectors = { youtube, onedrive, google_drive: drive };
const aiSecrets = ['groq', 'openrouter', 'gemini', 'anthropic', 'openai', 'freellmapi', 'notebooklm'];
const redirect = 'http://localhost:5173/oauth/test';
let app, indexed, calls, originalFetch;
before(() => initSqlite(':memory:'));
beforeEach(() => {
  for (const [id, connector] of Object.entries(connectors)) {
    connector.disconnect();
    deleteSecret(`oauth_client_${id}_id`);
    deleteSecret(`oauth_client_${id}_secret`);
    deleteConnectorSyncItems(id);
  }
  indexed = []; calls = [];
  app = new Hono();
  app.route('/api', createConnectorsRoute({ services: { indexNeuron: async p => indexed.push(p) }, logger: null }));
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`UNMOCKED_FETCH ${url}`); };
});
afterEach(() => { globalThis.fetch = originalFetch; });

const post = (path, body = {}) => app.request(`/api/connectors/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function configure(provider) {
  assert.equal((await post(`${provider}/client-credentials`, { client_id: `fake-${provider}`, client_secret: `fake-secret-${provider}` })).status, 200);
}
async function begin(provider) { return (await app.request(`/api/connectors/${provider}/auth-url?redirect_uri=${encodeURIComponent(redirect)}`)).json(); }
function mockTokens() {
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.ok(String(url).endsWith('/token'));
    return Response.json({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 });
  };
}
async function connect(provider) {
  await configure(provider); const auth = await begin(provider); mockTokens();
  const res = await post(`${provider}/callback`, { code: 'fake-code', state: auth.state, redirect_uri: redirect });
  assert.equal(res.status, 200); return auth;
}

test('PKCE S256: RFC vector and random server verifier', () => {
  assert.equal(deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const values = Array.from({ length: 100 }, generateCodeVerifier);
  assert.equal(new Set(values).size, 100);
  for (const value of values) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
});

test('privacy survives missing/cleared page flags and memory dedup cannot merge private into public', () => {
  for (const provider of Object.keys(connectors)) {
    const source = { private: false, metadata: { source: `${provider}_private`, egress_policy: 'local_only' } };
    assert.equal(isLocalOnlySource(source), true);
    assert.equal(privacyFromSource({ metadata: source.metadata }).egressPolicy, 'local_only');
  }
  const text = 'Unique confidential dedup content sentinel 56789';
  const publicMemory = addEpisodicMemoryDeduped({ text, privacy: false, egressPolicy: 'cloud_allowed' });
  const privateMemory = addEpisodicMemoryDeduped({ text, privacy: true, egressPolicy: 'local_only' });
  assert.notEqual(publicMemory.id, privateMemory.id);
  assert.equal(privateMemory.deduped, false);
  assert.equal(selectMemoriesForBudget({ query: text }).find(m => m.id === privateMemory.id).egressPolicy, 'local_only');
});

test('connector reads never trigger the legacy AI key migration or change unrelated metadata', async () => {
  const legacy = { groq_key: 'FAKE_LEGACY_GROQ', openrouter_key: 'FAKE_LEGACY_OPENROUTER' };
  setMeta('cloud_api_keys', legacy);
  try {
    for (const provider of Object.keys(connectors)) {
      await configure(provider);
      await begin(provider);
      await app.request('/api/connectors');
    }
    assert.deepEqual(getMeta('cloud_api_keys'), legacy);
    assert.equal(getMeta('secret_dpapi:groq', null), null);
    assert.equal(getMeta('secret_dpapi:openrouter', null), null);
  } finally { setMeta('cloud_api_keys', null); }
});

for (const provider of Object.keys(connectors)) {
  test(`${provider}: S256 challenge, secret verifier only in token request, state single use`, async () => {
    const auth = await connect(provider);
    const params = new URL(auth.auth_url).searchParams;
    assert.equal(params.get('code_challenge_method'), 'S256');
    const verifier = calls[0].options.body.get('code_verifier');
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(deriveCodeChallenge(verifier), params.get('code_challenge'));
    assert.equal(JSON.stringify(auth).includes(verifier), false);
    assert.equal((await post(`${provider}/callback`, { code: 'fake', state: auth.state, redirect_uri: redirect })).status, 400);
    assert.equal(calls.length, 1);
    const status = await (await app.request('/api/connectors')).text();
    for (const secret of [verifier, 'fake-refresh', 'fake-access', `fake-secret-${provider}`]) assert.equal(status.includes(secret), false);
  });

  test(`${provider}: disconnect during token exchange cannot resurrect credentials`, async () => {
    await configure(provider); const auth = await begin(provider);
    let started, finish;
    const ready = new Promise(resolve => { started = resolve; });
    globalThis.fetch = async () => { started(); return new Promise(resolve => { finish = resolve; }); };
    const callback = post(`${provider}/callback`, { code: 'fake-code', state: auth.state, redirect_uri: redirect });
    await ready; await post(`${provider}/disconnect`);
    finish(Response.json({ access_token: 'fake-access', refresh_token: 'fake-refresh' }));
    assert.equal((await callback).status, 502);
    assert.equal(getSecret(`${provider}_oauth_refresh_token`, { migrateLegacy: false }), null);
    assert.equal(getConnectorState(provider)?.connected ?? false, false);
  });
}

test('state rejects provider mismatch, redirect mismatch, and expires at the exact TTL', async () => {
  await configure('youtube'); const auth = await begin('youtube');
  for (const [provider, uri] of [['onedrive', redirect], ['youtube', `${redirect}/other`]]) {
    assert.equal((await post(`${provider}/callback`, { code: 'fake', state: auth.state, redirect_uri: uri })).status, 400);
  }
  const now = Date.now;
  Date.now = () => now() + 600_001;
  try { assert.equal((await post('youtube/callback', { code: 'fake', state: auth.state, redirect_uri: redirect })).status, 400); }
  finally { Date.now = now; }
});

test('state is consumed BEFORE a failing token exchange, with no error secret in responses/status', async () => {
  await configure('google_drive'); const auth = await begin('google_drive'); let count = 0;
  globalThis.fetch = async () => { count++; return Response.json({ error: 'SECRET_DEBUG_TOKEN' }, { status: 400 }); };
  const body = { code: 'fake', state: auth.state, redirect_uri: redirect };
  const first = await post('google_drive/callback', body);
  assert.equal(first.status, 502); assert.equal((await first.text()).includes('SECRET_DEBUG_TOKEN'), false);
  assert.equal((await post('google_drive/callback', body)).status, 400); assert.equal(count, 1);
});

test('registry gates unsupported/unknown/prototype providers on every operation without network', async () => {
  const status = await (await app.request('/api/connectors')).json();
  assert.equal(status.connectors.find(c => c.id === 'google_drive').status, 'active');
  for (const id of ['dropbox', 'github', 'notion', 'google_calendar', 'outlook_calendar', 'unknown', 'constructor', '__proto__']) {
    for (const [method, path] of [['GET', 'auth-url'], ['POST', 'callback'], ['POST', 'sync'], ['POST', 'disconnect'], ['POST', 'cancel'], ['POST', 'client-credentials'], ['DELETE', 'client-credentials'], ['PUT', 'auto-sync']]) {
      assert.equal((await app.request(`/api/connectors/${id}/${path}`, { method })).status, 404, `${id}/${path}`);
    }
  }
});

test('credential changes/deletion/disconnect never overwrite any AI secret or sibling connector', async () => {
  const snapshot = {};
  for (const id of aiSecrets) { setSecret(id, `SENTINEL_${id}`); snapshot[id] = getMeta(`secret_dpapi:${id}`); }
  await configure('youtube');
  const youtubeCipher = getMeta('secret_dpapi:oauth_client_youtube_secret');
  for (const id of ['google_drive', 'onedrive']) {
    await connect(id);
    await post(`${id}/client-credentials`, { client_id: 'replacement-id', client_secret: 'replacement-secret', groq: 'overwrite-attempt', openrouter: 'overwrite-attempt' });
    await post(`${id}/disconnect`);
    assert.equal((await app.request(`/api/connectors/${id}/client-credentials`, { method: 'DELETE' })).status, 200);
    for (const ai of aiSecrets) {
      assert.equal(getSecret(ai), `SENTINEL_${ai}`);
      assert.deepEqual(getMeta(`secret_dpapi:${ai}`), snapshot[ai], 'ciphertext itself must remain unchanged');
    }
    assert.deepEqual(getMeta('secret_dpapi:oauth_client_youtube_secret'), youtubeCipher);
  }
});

test('credential deletion/disconnect invalidates pending OAuth states', async () => {
  await configure('youtube'); const first = await begin('youtube');
  await app.request('/api/connectors/youtube/client-credentials', { method: 'DELETE' });
  await configure('youtube');
  assert.equal((await post('youtube/callback', { code: 'fake', state: first.state, redirect_uri: redirect })).status, 400);
  const second = await begin('youtube'); await post('youtube/disconnect');
  assert.equal((await post('youtube/callback', { code: 'fake', state: second.state, redirect_uri: redirect })).status, 400);
});

test('Drive uses only drive.file and rejects absent/malformed IDs before any API call', async () => {
  const auth = await connect('google_drive');
  assert.equal(new URL(auth.auth_url).searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  globalThis.fetch = async () => assert.fail('no API request permitted');
  for (const ids of [undefined, [], ['../secrets'], Array(51).fill('x'), [123]]) {
    assert.equal((await post('google_drive/sync', { file_ids: ids })).status, 400);
  }
});

function mockFile({ id = 'fileA', name = 'private.md', mimeType = 'text/markdown', text = 'Je préfère les notes confidentielles __PRIVATE_DRIVE_TEST__.' } = {}) {
  const urls = [];
  globalThis.fetch = async (url, opts) => {
    urls.push(String(url)); assert.equal(opts.headers.Authorization, 'Bearer fake-access');
    assert.ok(String(url).startsWith(`https://www.googleapis.com/drive/v3/files/${id}?`) || String(url).includes(`/${id}/export?`));
    if (String(url).includes('fields=')) return Response.json({ id, name, mimeType, size: text.length, md5Checksum: 'mock-hash' });
    return new Response(text);
  };
  return urls;
}

test('Drive import carries private/local_only through page, neuron, Notebook, memory and cloud guard; dedup', async () => {
  await connect('google_drive'); const urls = mockFile();
  const first = await post('google_drive/sync', { file_ids: ['fileA', 'fileA'] });
  assert.equal(first.status, 200); assert.equal((await first.json()).imported, 1);
  assert.equal(urls.length, 2); assert.equal(indexed.length, 1);
  const neuron = indexed[0]; const page = getPageFromStore(neuron.id);
  assert.equal(page.private, true); assert.equal(neuron.private, true);
  assert.equal(page.metadata.egress_policy, 'local_only'); assert.equal(neuron.metadata.egress_policy, 'local_only');
  assert.match(neuron.content, /__PRIVATE_DRIVE_TEST__/);
  createNotebook({ id: 'drive-notebook', title: 'Drive notebook' });
  const notebookApp = new Hono(); notebookApp.route('/api', createNotebookRoute({ env: { LANCEDB_PATH: './data-test-batch-d/test.lance' }, logger: null }));
  const res = await notebookApp.request('/api/notebooks/drive-notebook/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_id: neuron.id, title: neuron.title, privacy: false, egress_policy: 'cloud_allowed' }) });
  assert.equal(res.status, 201); assert.equal(getNotebook('drive-notebook').egress_policy, 'local_only');
  const privacy = privacyFromSource({ connectorSource: neuron.metadata.source, isPrivatePage: page.private });
  assert.deepEqual(privacy, { privacy: true, egressPolicy: 'local_only' });
  addEpisodicMemoryDeduped({ text: neuron.content, source: 'neuron', sourceRef: neuron.id, ...privacy });
  const memory = selectMemoriesForBudget({ query: '__PRIVATE_DRIVE_TEST__' }).find(m => m.text === neuron.content);
  assert.equal(memory.egressPolicy, 'local_only');
  const messages = [{ role: 'user', content: markPrivate(memory.text) }];
  for (const provider of [...aiSecrets, 'codex', 'claude-oauth']) assert.throws(() => guardCloudCall({ messages, provider, functionCalled: 'test' }), e => e.isPrivacyViolation);
  const second = await (await post('google_drive/sync', { file_ids: ['fileA'] })).json();
  assert.equal(second.already_synced, 1); assert.equal(urls.length, 2);
  await post('google_drive/disconnect'); assert.ok(getPageFromStore(neuron.id));
});

test('Google Docs export is text/plain; unsupported Workspace formats are explicitly skipped', async () => {
  await connect('google_drive'); const urls = mockFile({ id: 'doc', name: 'Document', mimeType: 'application/vnd.google-apps.document' });
  assert.equal((await (await post('google_drive/sync', { file_ids: ['doc'] })).json()).imported, 1);
  assert.ok(urls[1].endsWith('/doc/export?mimeType=text%2Fplain'));
  const skippedUrls = mockFile({ id: 'slides', name: 'Presentation', mimeType: 'application/vnd.google-apps.presentation' });
  const res = await (await post('google_drive/sync', { file_ids: ['slides'] })).json();
  assert.equal(res.skipped, 1); assert.equal(res.imported, 0); assert.equal(skippedUrls.length, 1);
});

test('Drive refresh uses its own token and does not touch YouTube refresh credentials', async () => {
  setSecret('google_drive_oauth_refresh_token', 'fake-drive-refresh');
  setSecret('youtube_oauth_refresh_token', 'SENTINEL_YOUTUBE_REFRESH');
  let refreshes = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/token')) { refreshes++; assert.equal(opts.body.get('refresh_token'), 'fake-drive-refresh'); return Response.json({ access_token: 'fresh', refresh_token: 'rotated' }); }
    if (String(url).includes('fields=')) return Response.json({ name: 'note.txt', mimeType: 'text/plain' });
    return new Response('contents');
  };
  assert.equal((await drive.readFile('file', { clientId: 'fake', clientSecret: 'fake' })).description, 'contents');
  assert.equal(refreshes, 1); assert.equal(getSecret('google_drive_oauth_refresh_token'), 'rotated');
  assert.equal(getSecret('youtube_oauth_refresh_token'), 'SENTINEL_YOUTUBE_REFRESH');
});

for (const [label, headers, chunks, shouldFail] of [
  ['under limit', {}, [new Uint8Array(2)], false],
  ['exact limit', {}, [new Uint8Array(4)], false],
  ['no header over limit', {}, [new Uint8Array(3), new Uint8Array(3)], true],
  ['lying header', { 'content-length': '1' }, [new Uint8Array(5)], true],
  ['declared oversize', { 'content-length': '8' }, [new Uint8Array(8)], true],
]) {
  test(`Drive bounded download: ${label}`, async () => {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } }), { headers });
    const run = () => drive.downloadFileContent('id', { accessToken: 'fake', maxBytes: 4 });
    if (shouldFail) await assert.rejects(run, e => e instanceof drive.GoogleDriveFileTooLargeError && e.code === 'GOOGLE_DRIVE_FILE_TOO_LARGE');
    else assert.equal((await run()).byteLength, chunks[0].length);
  });
}

test('no-body never calls arrayBuffer; invalid limits rejected before network; stream errors sanitized', async () => {
  globalThis.fetch = async () => ({ ok: true, headers: new Headers(), body: null, arrayBuffer() { assert.fail('unbounded fallback'); } });
  await assert.rejects(() => onedrive.downloadFileContent('https://mock.invalid'), /sans corps/);
  globalThis.fetch = async () => assert.fail('invalid limit must not fetch');
  for (const limit of [NaN, Infinity, -1, 0]) await assert.rejects(() => onedrive.downloadFileContent('https://mock.invalid', { maxBytes: limit }), /Limite/);
  globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) { c.error(new Error('SECRET_BEARER_URL')); } }));
  await assert.rejects(() => onedrive.downloadFileContent('https://mock.invalid'), e => !e.message.includes('SECRET') && /OneDrive/.test(e.message));
  await assert.rejects(() => downloadWithSizeLimit('https://mock.invalid', { maxBytes: 10, ErrorClass: Error }), e => !e.message.includes('SECRET'));
});

test('caller cancellation before fetch and during body read cancels reader and preserves clean errors', async () => {
  const aborted = AbortSignal.abort(); let count = 0;
  globalThis.fetch = async () => { count++; assert.fail('pre-aborted must not fetch'); };
  await assert.rejects(() => onedrive.downloadFileContent('https://mock.invalid', { signal: aborted }), /OneDrive/); assert.equal(count, 0);
  const controller = new AbortController(); let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ pull() { controller.abort(); }, cancel() { cancelled = true; } }));
  await assert.rejects(() => drive.downloadFileContent('file', { signal: controller.signal }), /annulé/);
  assert.equal(cancelled, true);
  const pending = new AbortController(); let pendingCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull() { setImmediate(() => pending.abort()); },
    cancel() { pendingCancelled = true; },
  }));
  await assert.rejects(() => drive.downloadFileContent('file', { signal: pending.signal }), /annulé/);
  assert.equal(pendingCancelled, true, 'abort must also interrupt an already-pending reader.read()');
});

test('Drive cancel endpoint interrupts in-flight fetch, imports nothing and unlocks next sync', async () => {
  await connect('google_drive');
  let started; const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); started();
  });
  const sync = post('google_drive/sync', { file_ids: ['cancelMe'] }); await ready;
  assert.equal((await post('google_drive/sync', { file_ids: ['cancelMe'] })).status, 409);
  assert.equal((await (await post('google_drive/cancel')).json()).cancelled, true);
  const result = await sync; assert.equal(result.status, 409); assert.equal((await result.json()).cancelled, true);
  assert.equal(indexed.length, 0); assert.equal(getConnectorState('google_drive').last_sync_status, 'cancelled');
  mockFile({ id: 'afterCancel' });
  assert.equal((await post('google_drive/sync', { file_ids: ['afterCancel'] })).status, 200);
});

for (const [status, reason, retry] of [[429, null, true], [503, null, true], [403, 'rateLimitExceeded', true], [403, 'userRateLimitExceeded', true], [403, 'insufficientPermissions', false], [401, null, false]]) {
  test(`Drive rate limit: ${status}/${reason} retries=${retry}`, async () => {
    let count = 0; const waits = [];
    globalThis.fetch = async () => { count++; return Response.json({ error: { errors: [{ reason }] } }, { status, headers: { 'retry-after': '2' } }); };
    const res = await fetchWithDriveRetry('https://mock.invalid', {}, { maxRetries: 2, random: () => 0, sleep: async ms => waits.push(ms) });
    assert.equal(res.status, status); assert.equal(count, retry ? 3 : 1);
    assert.deepEqual(waits, retry ? [2000, 2000] : []);
  });
}

test('retry delay is bounded and abortable; no second request after cancellation', async () => {
  const controller = new AbortController(); let count = 0;
  globalThis.fetch = async () => { count++; return new Response(null, { status: 429, headers: { 'retry-after': '999999' } }); };
  await assert.rejects(() => fetchWithDriveRetry('https://mock.invalid', { signal: controller.signal }, { sleep: async (ms, signal) => {
    assert.equal(ms, 30_000); controller.abort(); signal.throwIfAborted();
  } }));
  assert.equal(count, 1);
});
