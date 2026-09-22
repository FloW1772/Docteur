import './test-setup.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import * as db from './src/lib/sqlite.js';
import { createKiwixRoute } from './src/routes/kiwix.js';
import { KIWIX_ERROR_CODES } from './src/lib/kiwix-policy.js';

db.initSqlite(':memory:');

// Deterministic mocks for the kiwix-serve sidecar client — no real process
// spawned and no real network call in this suite, same discipline as
// test-sales-route.mjs's mockSearch/mockFetchContent.
const mockSuggest = async () => [{ label: 'Pikachu', value: 'A/Pikachu', path: 'A/Pikachu', kind: 'path' }];
const mockSearch = async () => [{ title: 'Pikachu', path: 'A/Pikachu', snippet: 'A yellow mouse', bookName: 'pokepedia_fr' }];
const mockListBooks = async () => [{ id: '1', name: 'pokepedia_fr', title: 'Poképédia FR' }];
const mockGetContent = async () => ({ html: '<html><body><h1>Pikachu</h1><p>Test</p></body></html>', contentType: 'text/html' });
const mockGetRawAsset = async () => ({ buffer: Buffer.from('fake-image-bytes'), contentType: 'image/png' });
const mockSearchCatalog = async () => [{ id: 'cat1', name: 'wikipedia_fr', title: 'Wikipédia FR', downloadUrl: 'https://download.kiwix.org/zim/wikipedia/wikipedia_fr.zim' }];
const mockServices = { indexNeuron: async () => {} };
const mockLogger = { warn: () => {}, error: () => {}, info: () => {} };

function buildApp() {
  return new Hono().route('/api', createKiwixRoute({
    services: mockServices,
    logger: mockLogger,
    kiwixSuggest: mockSuggest,
    kiwixSearch: mockSearch,
    kiwixListBooks: mockListBooks,
    kiwixGetContent: mockGetContent,
    kiwixGetRawAsset: mockGetRawAsset,
    kiwixSearchCatalog: mockSearchCatalog,
  }));
}

const request = async (app, path, body, method = 'GET') => {
  const response = await app.request(`http://localhost/api${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
};

beforeEach(() => {
  db.setRouterSettings({ strict_local_mode: false });
});

// ── Local search/suggest/content/raw — never gated by Strict Local ──────

test('search returns mocked results for a valid pattern', async () => {
  const app = buildApp();
  const r = await request(app, '/kiwix/search?pattern=Pikachu');
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 1);
  assert.equal(r.body.results[0].title, 'Pikachu');
});

test('search works even when Strict Local Mode is ON (local sidecar, not cloud)', async () => {
  db.setRouterSettings({ strict_local_mode: true });
  const app = buildApp();
  const r = await request(app, '/kiwix/search?pattern=Pikachu');
  assert.equal(r.status, 200);
});

test('empty search pattern returns empty results without calling the sidecar', async () => {
  const app = buildApp();
  const r = await request(app, '/kiwix/search?pattern=');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, []);
});

test('overlong search query rejected with KIWIX_INVALID_PATH, 400', async () => {
  const app = buildApp();
  const r = await request(app, `/kiwix/search?pattern=${'a'.repeat(400)}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, KIWIX_ERROR_CODES.INVALID_PATH);
});

test('control-char search query rejected with KIWIX_INVALID_PATH, 400', async () => {
  const app = buildApp();
  const r = await request(app, `/kiwix/search?pattern=${encodeURIComponent('test\x01query')}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, KIWIX_ERROR_CODES.INVALID_PATH);
});

test('content route returns sanitized article for a valid book/path', async () => {
  const app = buildApp();
  const r = await request(app, '/kiwix/content/pokepedia_fr/A/Pikachu');
  assert.equal(r.status, 200);
  assert.equal(r.body.book, 'pokepedia_fr');
  assert.ok(r.body.html.includes('Pikachu'));
});

test('content route rejects a traversal path segment with KIWIX_INVALID_PATH, 400 — never reaches the sidecar client', async () => {
  // A plain "../../etc/passwd" in the URL is already collapsed by the
  // standard URL parser before Hono's router ever sees it (the request
  // simply 404s, one layer earlier — confirmed empirically: `new
  // URL('http://x/api/kiwix/content/book/../../etc/passwd').pathname` -> a
  // normalized path that no longer matches this route at all). The
  // realistic bypass this test targets is a double-encoded "../" segment
  // ("..%2f..%2f", i.e. a literal %2f the URL parser does NOT decode to a
  // real slash), which survives normalization and reaches the handler as a
  // literal path-segment string — exactly what assertSafeZimSegment's own
  // `.includes('..')` check exists to catch as defense-in-depth.
  const app = buildApp();
  const r = await request(app, '/kiwix/content/pokepedia_fr/..%2f..%2fetc%2fpasswd');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, KIWIX_ERROR_CODES.INVALID_PATH);
});

test('content route rejects a null-byte path segment', async () => {
  const app = buildApp();
  const r = await request(app, `/kiwix/content/pokepedia_fr/A%00Pikachu`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, KIWIX_ERROR_CODES.INVALID_PATH);
});

test('raw asset route returns the proxied binary with the mock content-type', async () => {
  const app = buildApp();
  const r = await request(app, '/kiwix/raw/pokepedia_fr/I/pikachu.png');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
});

test('raw asset route rejects a double-encoded traversal path segment with KIWIX_INVALID_PATH, 400', async () => {
  // Same rationale as the content-route traversal test above: a plain
  // "../../" is collapsed by URL normalization before Hono's router sees
  // it; the double-encoded "..%2f" form is the realistic bypass that
  // reaches the handler as a literal segment.
  const app = buildApp();
  const r = await request(app, '/kiwix/raw/pokepedia_fr/..%2f..%2fsecret.png');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, KIWIX_ERROR_CODES.INVALID_PATH);
});

// ── Error normalization — mocked failures never leak raw err.message ────

test('search backend failure is normalized, raw message never in the response body', async () => {
  const app = new Hono().route('/api', createKiwixRoute({
    services: mockServices, logger: mockLogger,
    kiwixSearch: async () => { throw new Error('ECONNREFUSED secret-internal-detail 127.0.0.1:8090'); },
  }));
  const r = await request(app, '/kiwix/search?pattern=Pikachu');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, KIWIX_ERROR_CODES.BACKEND_UNAVAILABLE);
  assert.ok(!JSON.stringify(r.body).includes('secret-internal-detail'));
});

test('article-not-found failure is normalized to KIWIX_ARTICLE_NOT_FOUND, 404', async () => {
  const app = new Hono().route('/api', createKiwixRoute({
    services: mockServices, logger: mockLogger,
    kiwixGetContent: async () => { throw new Error('kiwix-serve a répondu 404 pour /content/book/Missing'); },
  }));
  const r = await request(app, '/kiwix/content/book/Missing');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, KIWIX_ERROR_CODES.ARTICLE_NOT_FOUND);
});

test('search timeout failure is normalized to KIWIX_SEARCH_TIMEOUT, 504', async () => {
  const app = new Hono().route('/api', createKiwixRoute({
    services: mockServices, logger: mockLogger,
    kiwixSearch: async () => { const e = new Error('timeout'); e.name = 'AbortError'; throw e; },
  }));
  const r = await request(app, '/kiwix/search?pattern=Pikachu');
  assert.equal(r.status, 504);
  assert.equal(r.body.error, KIWIX_ERROR_CODES.SEARCH_TIMEOUT);
});

// ── Strict Local gating — catalogue/download are genuine internet calls ─

test('catalog route blocked with 503 when Strict Local Mode is ON', async () => {
  db.setRouterSettings({ strict_local_mode: true });
  const app = buildApp();
  const r = await request(app, '/kiwix/catalog?q=wikipedia');
  assert.equal(r.status, 503);
  assert.equal(r.body.strict_local, true);
});

test('catalog route allowed when Strict Local Mode is OFF', async () => {
  db.setRouterSettings({ strict_local_mode: false });
  const app = buildApp();
  const r = await request(app, '/kiwix/catalog?q=wikipedia');
  assert.equal(r.status, 200);
  assert.equal(r.body.entries.length, 1);
});

test('download route blocked with 503 when Strict Local Mode is ON, before any URL validation runs', async () => {
  db.setRouterSettings({ strict_local_mode: true });
  const app = buildApp();
  const r = await request(app, '/kiwix/download', { url: 'not-even-a-valid-url', fileName: 'x.zim' }, 'POST');
  assert.equal(r.status, 503);
  assert.equal(r.body.strict_local, true);
});

// ── Explicit delete-archive path validation (pre-existing, still enforced) ─

test('delete-archive route rejects a traversal filename', async () => {
  db.setRouterSettings({ strict_local_mode: false });
  const app = buildApp();
  const r = await request(app, `/kiwix/archives/${encodeURIComponent('../../evil.zim')}`, undefined, 'DELETE');
  assert.equal(r.status, 400);
});
