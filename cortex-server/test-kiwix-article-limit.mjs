// [KWX-3] Kiwix article size budget — the REAL getContent() and the REAL content route against a loopback stub of kiwix-serve.
// Payloads are generated in memory (no large fixture files). Proves: accepted articles reach the sanitizer byte-for-byte
// (identity, chunked, gzip, multibyte UTF-8), the budget is exact (limit passes, limit + 1 is refused), an over-budget body is
// refused whole and its read is cancelled (never fully buffered), Content-Length is trusted alone only when uncompressed, the
// route answers a typed 413 with no partial content, and the backend keeps serving afterwards.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { Hono } from 'hono';
import * as db from './src/lib/sqlite.js';
import { getContent, KIWIX_ARTICLE_MAX_BYTES } from './src/lib/kiwix-client.js';
import { KiwixError, KIWIX_ERROR_CODES } from './src/lib/kiwix-policy.js';
import { sanitizeZimHtml } from './src/lib/kiwix-sanitize.js';
import { createKiwixRoute } from './src/routes/kiwix.js';

db.initSqlite(':memory:');
const LARGEST_LEGITIMATE = 2_663_508; // largest article measured in the installed archives (KWX-3 survey)

/** HTML of exactly `bytes` UTF-8 bytes, with multibyte characters spread through it (é = 2 bytes, 🐭 = 4 bytes). */
function htmlOfBytes(bytes) {
  const headOpen = '<html><head><title>T</title></head><body><div id="mw-content-text">';
  const close = '</div></body></html>';
  const unit = '<p>Pokémon 🐭 <a href="../A/Pikachu">lien</a></p>';
  const room = bytes - Buffer.byteLength(headOpen + close);
  const n = Math.floor(room / Buffer.byteLength(unit));
  const html = headOpen + unit.repeat(n) + 'x'.repeat(room - n * Buffer.byteLength(unit)) + close; // ASCII pad to the exact byte count
  assert.equal(Buffer.byteLength(html), bytes);
  return html;
}

// ── loopback stub of kiwix-serve: /content/book/<name> serves the registered payload in the registered way ──
const routes = new Map(); // name → { html, mode: 'identity-length' | 'chunked' | 'gzip' | 'slow-chunked', written, closedEarly }
let server; let port;
before(async () => {
  server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.replace(/^\/content\/book\//, ''));
    const r = routes.get(name);
    if (!r) { res.writeHead(404); res.end(); return; }
    const buf = Buffer.from(r.html, 'utf8');
    r.written = 0; r.closedEarly = false;
    res.on('close', () => { if (!res.writableFinished) r.closedEarly = true; });
    if (r.mode === 'identity-length') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length }); r.written = buf.length; res.end(buf); return; }
    if (r.mode === 'identity-length-headers-only') { res.writeHead(200, { 'content-type': 'text/html', 'content-length': buf.length }); res.flushHeaders(); r.pending = setTimeout(() => { if (!res.destroyed) { r.written = buf.length; res.end(buf); } }, 3000); res.on('close', () => clearTimeout(r.pending)); return; }
    if (r.mode === 'gzip') { const gz = zlib.gzipSync(buf); res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': gz.length }); r.written = gz.length; res.end(gz); return; }
    // chunked (no Content-Length): write 64 KiB at a time, yielding between chunks so a cancelled read stops the stream early
    res.writeHead(200, { 'content-type': 'text/html' });
    let off = 0;
    const pump = () => {
      while (off < buf.length) {
        if (res.destroyed) return;
        const chunk = buf.subarray(off, off + 65_536); off += chunk.length; r.written = off;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
        if (r.mode === 'slow-chunked') { setImmediate(pump); return; }
      }
      res.end();
    };
    pump();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  db.setKiwixSettings({ port });
});
after(() => new Promise(r => server.close(r)));
const serve = (name, html, mode) => routes.set(name, { html, mode });
const tooLarge = (e) => e instanceof KiwixError && e.code === KIWIX_ERROR_CODES.ARTICLE_TOO_LARGE;

test('the budget is the documented derivation (3 × largest legitimate article), not an arbitrary round number', () => {
  assert.equal(KIWIX_ARTICLE_MAX_BYTES, 3 * LARGEST_LEGITIMATE);
  assert.equal(KIWIX_ARTICLE_MAX_BYTES, 7_990_524);
});

test('A/B. small and largest-legitimate articles pass byte-for-byte in every transfer mode (multibyte UTF-8 intact)', async () => {
  for (const [name, bytes] of [['small', 4_096], ['largest-legitimate', LARGEST_LEGITIMATE]]) {
    const html = htmlOfBytes(bytes);
    for (const mode of ['identity-length', 'chunked', 'gzip']) {
      serve(`${name}-${mode}`, html, mode);
      const got = await getContent('book', `${name}-${mode}`);
      assert.equal(got.html, html, `${name} via ${mode}`);
    }
  }
});

test('C. exactly the budget and budget − 1 pass; D/E. budget + 1 is refused whole (typed error, no content) in every mode', async () => {
  for (const mode of ['identity-length', 'chunked', 'gzip']) {
    for (const bytes of [KIWIX_ARTICLE_MAX_BYTES - 1, KIWIX_ARTICLE_MAX_BYTES]) {
      const html = htmlOfBytes(bytes); serve(`ok-${mode}-${bytes}`, html, mode);
      assert.equal((await getContent('book', `ok-${mode}-${bytes}`)).html.length, html.length, `${mode} ${bytes}`);
    }
    serve(`over-${mode}`, htmlOfBytes(KIWIX_ARTICLE_MAX_BYTES + 1), mode);
    await assert.rejects(getContent('book', `over-${mode}`), tooLarge, `${mode}: one byte over is refused`);
  }
});

test('Content-Length: an uncompressed over-budget body is refused from its headers — before the body is even sent', async () => {
  serve('declared-over', htmlOfBytes(KIWIX_ARTICLE_MAX_BYTES + 10_000), 'identity-length-headers-only'); // body only after 3 s
  const t0 = Date.now();
  await assert.rejects(getContent('book', 'declared-over'), tooLarge);
  assert.ok(Date.now() - t0 < 2_000, 'rejected on the declared length, without waiting for the body');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(routes.get('declared-over').written, 0, 'the body was never sent');
});

test('no Content-Length: a streamed over-budget body is cancelled as soon as the budget is crossed (never fully buffered)', async () => {
  const total = KIWIX_ARTICLE_MAX_BYTES * 3;
  serve('streamed-over', htmlOfBytes(total), 'slow-chunked');
  await assert.rejects(getContent('book', 'streamed-over'), tooLarge);
  await new Promise(r => setTimeout(r, 200));
  const r = routes.get('streamed-over');
  assert.ok(r.closedEarly, 'the server saw the connection closed before finishing');
  assert.ok(r.written < total, `stopped early: ${r.written} of ${total} bytes written`);
});

test('gzip: a small compressed Content-Length does not hide an over-budget decoded body', async () => {
  serve('gzip-over', htmlOfBytes(KIWIX_ARTICLE_MAX_BYTES * 2), 'gzip');
  await assert.rejects(getContent('book', 'gzip-over'), tooLarge);
  const r = routes.get('gzip-over');
  assert.ok(r.written < KIWIX_ARTICLE_MAX_BYTES, `the compressed wire size (${r.written} B) is below the budget, yet the decoded size is refused`);
});

test('route: over budget ⇒ 413 typed code only (no html/title/text); accepted articles are sanitized exactly as before; F. backend still serving', async () => {
  const app = new Hono().route('/api', createKiwixRoute({}));
  const get = async (p) => { const res = await app.request(`http://127.0.0.1/api/kiwix/content/book/${p}`); return { status: res.status, json: await res.json() }; };
  serve('route-over', htmlOfBytes(KIWIX_ARTICLE_MAX_BYTES + 1), 'chunked');
  const over = await get('route-over');
  assert.equal(over.status, 413);
  assert.deepEqual(over.json, { error: 'KIWIX_ARTICLE_TOO_LARGE' }, 'no partial article');
  const html = htmlOfBytes(LARGEST_LEGITIMATE); serve('route-ok', html, 'gzip');
  const ok = await get('route-ok');
  assert.equal(ok.status, 200);
  const expected = sanitizeZimHtml(html, 'book');
  assert.equal(ok.json.html, expected.html, 'the sanitizer received the accepted article unchanged');
  assert.equal(ok.json.text, expected.text);
  assert.ok(ok.json.html.includes('zim://book/A/Pikachu'), 'internal links still rewritten');
  serve('route-small', htmlOfBytes(4_096), 'identity-length');
  assert.equal((await get('route-small')).status, 200, 'served normally right after a refusal');
});

test('import route: an over-budget article is refused with a public error and nothing is imported', async () => {
  const app = new Hono().route('/api', createKiwixRoute({}));
  serve('import-over', htmlOfBytes(KIWIX_ARTICLE_MAX_BYTES + 1), 'chunked');
  const res = await app.request('http://127.0.0.1/api/kiwix/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ book: 'book', path: 'import-over', title: 'X' }) });
  assert.equal(res.status, 502);
  const body = JSON.stringify(await res.json());
  assert.ok(!body.includes('Pokémon'), 'no article content in the error');
});
