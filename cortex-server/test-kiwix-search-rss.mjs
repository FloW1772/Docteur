// [KIWIX-RSS] Search result parsing for the REAL kiwix-serve 3.x answer (RSS 2.0 <item>s) + the legacy <result>
// shape, and the real search() → route → getContent() path against a loopback stand-in for kiwix-serve (no mock of
// the client: test-kiwix-route.mjs injects kiwixSearch, which is how the RSS defect went unnoticed).
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { Hono } from 'hono';
import * as db from './src/lib/sqlite.js';
import { parseSearchResults, search, getContent } from './src/lib/kiwix-client.js';
import { createKiwixRoute } from './src/routes/kiwix.js';
import { MAX_SEARCH_PAGE_LENGTH } from './src/lib/kiwix-policy.js';

const FIXTURE = fs.readFileSync(new URL('./fixtures/kiwix-search-rss-3.7.xml', import.meta.url), 'utf8');
const NOPIC = 'pokepedia_fr_all_nopic_2026-04';
const MAXI = 'pokepedia_fr_all_maxi_2026-04';

const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Search: x</title>`
  + `<link>/search?pattern=x</link><description>Search result for x</description>${items.join('')}</channel></rss>`;
const item = (link, { title = 'T', description = 'D' } = {}) =>
  `<item><title>${title}</title><link>${link}</link><description>${description}</description>`
  + `<book><title>Archive</title></book><wordCount>10</wordCount></item>`;
const GOOD = `/content/${NOPIC}/Pikachu`;

// ── Real 3.7 format ──────────────────────────────────────────────────────

test('real kiwix-serve 3.7 RSS fixture: every item becomes a result, in order, with the documented contract', () => {
  const results = parseSearchResults(FIXTURE);
  assert.deepEqual(results.map(r => r.path), [
    'Pikachu',
    'Pokémon_électrique',
    'Pikachu_&_Raichu_(anime)',
    'Pikachu de Sacha',
    'Qui_est_ce_Pokémon_%3F',
    'Cartes/Pikachu_(carte)',
  ]);
  assert.deepEqual(results.map(r => r.bookName), [NOPIC, NOPIC, NOPIC, NOPIC, NOPIC, MAXI]);
  for (const r of results) assert.deepEqual(Object.keys(r).sort(), ['bookName', 'path', 'snippet', 'title']);
});

test('RSS: the article <title> wins over the nested <book><title>; channel title / link are not results', () => {
  const results = parseSearchResults(FIXTURE);
  assert.equal(results[0].title, 'Pikachu');
  assert.equal(results[5].title, 'Pikachu (carte)');
  assert.ok(results.every(r => !/Poképédia|Search:/.test(r.title)));
  const bookFirst = parseSearchResults(rss([`<item><book><title>Archive</title></book><title>Article</title><link>${GOOD}</link></item>`]));
  assert.equal(bookFirst[0].title, 'Article');
});

test('RSS: titles and snippets are plain text — <b> highlights stripped, entities decoded once, wordCount ignored', () => {
  const [first, second, third] = parseSearchResults(FIXTURE);
  assert.equal(first.snippet, 'Pikachu est un Pokémon de type Électrik. Pikachu évolue en Raichu & vient de Pichu...');
  assert.equal(second.snippet, 'Liste incluant Pikachu, ses PV < 50 au niveau 5...');
  assert.equal(third.title, 'Pikachu & Raichu (anime)');
  assert.ok(!/4211/.test(first.snippet + first.title));
});

test('RSS: links are percent-decoded per segment; ? # % / inside a segment stay escaped for the raw /content append', () => {
  const r = parseSearchResults(rss([
    item(`/content/${NOPIC}/A/Pok%C3%A9mon%20Rouge`),
    item(`/content/${NOPIC}/Pourquoi%3F%23intro`),
    item(`/content/${NOPIC}/100%25_Pikachu`),
    item(`/content/${NOPIC}/Rouge%2FBleu`),
    item(`/content/pokepedia%20fr/Pikachu`),
  ]));
  assert.deepEqual(r.map(x => x.path), ['A/Pokémon Rouge', 'Pourquoi%3F%23intro', '100%25_Pikachu', 'Rouge%2FBleu', 'Pikachu']);
  assert.equal(r[4].bookName, 'pokepedia fr');
});

// ── Link safety ──────────────────────────────────────────────────────────

test('RSS: only Kiwix-local /content/<book>/<path> links survive; each bad item is skipped alone', () => {
  const bad = [
    'http://evil.example/content/x/y', 'https://evil.example/', '//evil.example/content/x/y', 'javascript:alert(1)',
    'data:text/html,<b>x</b>', 'file:///C:/Windows/win.ini', 'JAVASCRIPT:alert(1)', '/content/', `/content/${NOPIC}`,
    `/content/${NOPIC}/`, '/content//Pikachu', `/content/${NOPIC}//Pikachu`, `/content/${NOPIC}/../../etc/passwd`,
    `/content/${NOPIC}/A/%2e%2e/%2e%2e/secret`, `/content/%2e%2e/Pikachu`, `/content/${NOPIC}/Pika%E0%A4%A`,
    `/content/${NOPIC}/Pika%ZZ`, `/content/${NOPIC}/Pikachu?x=1`, `/content/${NOPIC}/Pikachu#top`,
    `/content/${NOPIC}/A%5C..%5Cb`, `/content/${NOPIC}/A%5Cb`, `/content/a%2Fb/Pikachu`, `/content/a%5Cb/Pikachu`, `/content/${NOPIC}/Pika%0Achu`,
    `/content/${NOPIC}/Pika%00chu`, '/contentx/a/b', '/search?pattern=x', 'content/a/b', '', `/content/${NOPIC}/${'a'.repeat(600)}`,
  ];
  const r = parseSearchResults(rss([item(GOOD, { title: 'first' }), ...bad.map(l => item(l, { title: 'bad' })), item(GOOD, { title: 'last' })]));
  assert.deepEqual(r.map(x => x.title), ['first', 'last']);
});

test('RSS: an item without <link> is skipped; surrounding whitespace around a good link is tolerated', () => {
  const r = parseSearchResults(rss([
    '<item><title>no link</title><description>x</description></item>',
    item(`\n        ${GOOD}\n      `, { title: 'spaced' }),
  ]));
  assert.deepEqual(r.map(x => [x.title, x.path, x.bookName]), [['spaced', 'Pikachu', NOPIC]]);
});

test('RSS: an item without <title> keeps its link and gets an empty title (same as legacy)', () => {
  const r = parseSearchResults(rss([`<item><link>${GOOD}</link></item>`]));
  assert.deepEqual(r, [{ title: '', path: 'Pikachu', snippet: '', bookName: NOPIC }]);
});

// ── Text decoding ────────────────────────────────────────────────────────

test('RSS: numeric references decode; invalid ones stay literal; double-escaped text is decoded exactly once', () => {
  const r = parseSearchResults(rss([
    item(GOOD, { title: 'Pok&#233;mon &#x26A1; &#0; &#xD800; &#99999999;', description: '&amp;lt;b&amp;gt;literal&amp;lt;/b&amp;gt;' }),
  ]));
  assert.equal(r[0].title, 'Pokémon ⚡ &#0; &#xD800; &#99999999;');
  assert.equal(r[0].snippet, '&lt;b&gt;literal&lt;/b&gt;');
});

test('RSS: escaped and CDATA-wrapped HTML in description is reduced to plain text', () => {
  const r = parseSearchResults(rss([
    item(GOOD, { description: '&lt;i&gt;Souris&lt;/i&gt; &lt;script&gt;alert(1)&lt;/script&gt;électrique' }),
    item(GOOD, { description: '<![CDATA[<b>Pikachu</b> & <a href="javascript:x">Raichu</a>]]>' }),
    item(GOOD, { title: '<![CDATA[Pika & chu]]>' }),
  ]));
  assert.equal(r[0].snippet, 'Souris alert(1)électrique');
  assert.equal(r[1].snippet, 'Pikachu & Raichu');
  assert.equal(r[2].title, 'Pika & chu');
  assert.ok(r.every(x => !/[<>]/.test(x.snippet + x.title)));
});

test('RSS: DOCTYPE / custom entities are never resolved (no XXE, no entity expansion)', () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">`
    + `<!ENTITY lol "lollollollol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>`
    + rss([item(GOOD, { title: '&xxe;', description: '&lol2;' })]).replace(/^<\?xml[^>]*\?>\n/, '');
  const r = parseSearchResults(xml);
  assert.equal(r.length, 1);
  assert.equal(r[0].title, '&xxe;');
  assert.equal(r[0].snippet, '&lol2;');
});

// ── Bounds ───────────────────────────────────────────────────────────────

test('RSS: results are capped at MAX_SEARCH_PAGE_LENGTH, titles at 512 and snippets at 2000 chars', () => {
  const many = Array.from({ length: 80 }, (_, i) => item(`/content/${NOPIC}/A${i}`, { title: 'x'.repeat(900), description: 'y '.repeat(3000) }));
  const r = parseSearchResults(rss(many));
  assert.equal(r.length, MAX_SEARCH_PAGE_LENGTH);
  assert.equal(r[49].path, 'A49');
  assert.equal(r[0].title.length, 512);
  assert.ok(r[0].snippet.length <= 2000);
});

test('input beyond the scan bound is ignored (items past 2,000,000 chars are not parsed)', () => {
  const padding = `<!--${'p'.repeat(2_000_000)}-->`;
  const r = parseSearchResults(rss([item(GOOD, { title: 'kept' }), padding, item(GOOD, { title: 'beyond' })]));
  assert.deepEqual(r.map(x => x.title), ['kept']);
});

test('empty RSS, unknown XML, HTML error pages and non-strings give no results', () => {
  assert.deepEqual(parseSearchResults(rss([])), []);
  assert.deepEqual(parseSearchResults('<?xml version="1.0"?><feed><entry><title>x</title></entry></feed>'), []);
  assert.deepEqual(parseSearchResults('<html><body><h1>No such book</h1></body></html>'), []);
  assert.deepEqual(parseSearchResults(''), []);
  assert.deepEqual(parseSearchResults(null), []);
  assert.deepEqual(parseSearchResults(undefined), []);
  assert.deepEqual(parseSearchResults({ length: 3 }), []);
});

test('parsing never touches the network', () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network used during parse'); };
  try {
    assert.equal(parseSearchResults(FIXTURE).length, 6);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Legacy <result> compatibility ────────────────────────────────────────

test('legacy <result> format is still parsed exactly as before', () => {
  const xml = '<results><result><title>Pikachu</title><link>A/Pikachu</link>'
    + '<snippet>A <b>yellow</b> mouse</snippet><bookName>pokepedia_fr</bookName></result>'
    + '<result><title>Raichu</title><link href="A/Raichu"/></result>'
    + '<result><snippet>no title nor link</snippet></result></results>';
  assert.deepEqual(parseSearchResults(xml), [
    { title: 'Pikachu', path: 'A/Pikachu', snippet: 'A yellow mouse', bookName: 'pokepedia_fr' },
    { title: 'Raichu', path: 'A/Raichu', snippet: '', bookName: '' },
  ]);
});

test('legacy <result> format is capped at MAX_SEARCH_PAGE_LENGTH too', () => {
  const xml = `<results>${Array.from({ length: 70 }, (_, i) => `<result><title>R${i}</title><link>A/${i}</link></result>`).join('')}</results>`;
  assert.equal(parseSearchResults(xml).length, MAX_SEARCH_PAGE_LENGTH);
});

// ── Real client + real route against a loopback stand-in for kiwix-serve ──

const seen = [];
let server;
let app;

before(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith('/search?')) {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(FIXTURE);
    } else if (req.url.startsWith('/content/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>t</title></head><body><h1>${encodeURIComponent(req.url)}</h1><p>ok</p></body></html>`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  db.initSqlite(':memory:');
  db.setKiwixSettings({ port: server.address().port });
  const quiet = { warn: () => {}, error: () => {}, info: () => {} };
  // No kiwixSearch / kiwixGetContent injection: the shipped kiwix-client functions are exercised.
  app = new Hono().route('/api', createKiwixRoute({ services: { indexNeuron: async () => {} }, logger: quiet }));
});

after(() => new Promise(r => server.close(r)));

// what a percent-encoded request path means once decoded (kiwix-serve decodes it the same way)
const decodedPath = (url) => url.split('?')[0].split('/').map(s => decodeURIComponent(s)).join('/');

test('real search(): sends the documented query to loopback kiwix-serve and returns the RSS items', async () => {
  seen.length = 0;
  const results = await search(NOPIC, 'Pikachu', { pageLength: 25 });
  assert.equal(results.length, 6);
  assert.equal(seen.length, 1);
  const q = new URL(seen[0], 'http://x').searchParams;
  assert.deepEqual([q.get('pattern'), q.get('pageLength'), q.get('format'), q.get('books.name')], ['Pikachu', '25', 'xml', NOPIC]);
});

test('product route /api/kiwix/search (real client) returns results > 0; every result opens via /api/kiwix/content', async () => {
  const s = await app.request(`http://localhost/api/kiwix/search?${new URLSearchParams({ book: NOPIC, pattern: 'Pikachu' })}`);
  assert.equal(s.status, 200);
  const { results } = await s.json();
  assert.equal(results.length, 6);
  const original = [...FIXTURE.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map(m => m[1]);
  for (const [i, r] of results.entries()) {
    seen.length = 0;
    // exactly how the frontend builds it (client.ts kiwixArticle): encoded book + raw result path
    const c = await app.request(`http://localhost/api/kiwix/content/${encodeURIComponent(r.bookName)}/${r.path.replace(/^\/+/, '')}`);
    assert.equal(c.status, 200, `content for ${r.path}`);
    const body = await c.json();
    assert.equal(body.book, r.bookName);
    assert.equal(seen.length, 1);
    assert.equal(decodedPath(seen[0]), decodedPath(original[i]), `kiwix-serve received the article the RSS item linked to (${r.path})`);
  }
});

test('server.js chat enrichment path: getContent(result.bookName, result.path) reaches the linked article', async () => {
  const results = await search('', 'Pikachu', { pageLength: 3 });
  const original = [...FIXTURE.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map(m => m[1]);
  for (const [i, r] of results.entries()) {
    seen.length = 0;
    const { html } = await getContent(r.bookName, r.path);
    assert.ok(html.includes('<p>ok</p>'));
    assert.equal(decodedPath(seen[0]), decodedPath(original[i]));
  }
});

test('route: an RSS-derived path with an escaped % / ? / # / slash still reaches the same article', async () => {
  for (const link of [`/content/${NOPIC}/100%25_Pikachu`, `/content/${NOPIC}/Pourquoi%3F%23intro`, `/content/${NOPIC}/Rouge%2FBleu`]) {
    const [r] = parseSearchResults(rss([item(link)]));
    seen.length = 0;
    const c = await app.request(`http://localhost/api/kiwix/content/${encodeURIComponent(r.bookName)}/${r.path}`);
    assert.equal(c.status, 200, link);
    assert.equal(seen.length, 1);
    assert.equal(decodedPath(seen[0]), decodedPath(link), link);
  }
});
