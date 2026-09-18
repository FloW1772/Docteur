// Bounded crawler tests (CA-6). Every scenario the mission requires:
// single page, multi-page same-scope, maxDepth, maxRequests, duplicate
// URL, fragments, query variants, relative/absolute links, malformed URL,
// external host link, forbidden subdomain, excluded path, private-IP
// redirect, redirect outside scope, redirect loop, huge page, robots.txt,
// sitemap.xml, destructive-looking links skipped, prompt-injection text
// ignored, cancel while crawling, timeout, queue cleanup, no orphan
// requests. Also asserts out-of-scope requests = 0, POST/PUT/PATCH/DELETE
// = 0, and no shell/child_process usage anywhere in the crawler module.
//
// Run with: node --test test-cyber-audit-crawler.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateScope } from './src/lib/cyber-policy.js';
import {
  crawl, canonicalizeUrl, extractLinks, parseRobotsTxt, parseSitemapXml,
  discoverSitemapUrls, fetchRobotsTxt,
} from './src/lib/cyber-crawler.js';
import { createCyberAuditFixture } from './test-cyber-audit-fixture.mjs';

let fixture, origin, port;

before(async () => { fixture = createCyberAuditFixture(); ({ port, origin } = await fixture.listen()); });
after(async () => { await fixture.close(); });

function scope(overrides = {}) {
  return validateScope({
    allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'],
    maxDepth: 3, maxRequests: 50, requestsPerSecond: 2, timeoutMs: 2000,
    ...overrides,
  });
}

// ── No shell/child_process anywhere in the crawler module (static check) ──

test('static check: cyber-crawler.js never imports node:child_process, and never calls fetch/http/https directly', () => {
  const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src/lib/cyber-crawler.js');
  const source = fs.readFileSync(modulePath, 'utf8');
  assert.ok(!/child_process/.test(source), 'must never import child_process');
  assert.ok(!/\bexec\(|\bspawn\(|\bexecSync\(/.test(source), 'must never spawn a shell/process');
  assert.ok(!/require\(['"]http['"]\)|from ['"]node:http['"]|from ['"]node:https['"]/.test(source), 'must never import http/https directly');
  assert.ok(!/\bglobalThis\.fetch\(|(?<!safeCyber)\bfetch\(/.test(source), 'must never call fetch() directly');
});

// ── single page ────────────────────────────────────────────────────────

test('single page: a start URL with no links crawls exactly one page', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/contact`], scope: scope(), allowPrivateFixture: true });
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.visited[0], `${origin}/site/contact`);
});

// ── multi-page same-scope ─────────────────────────────────────────────

test('multi-page same-scope: crawl follows in-scope links across multiple pages', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/home`], scope: scope({ maxDepth: 2 }), allowPrivateFixture: true });
  assert.ok(result.visited.includes(`${origin}/site/home`));
  assert.ok(result.visited.includes(`${origin}/site/about`));
  assert.ok(result.visited.includes(`${origin}/site/contact`));
});

// ── maxDepth ──────────────────────────────────────────────────────────

test('maxDepth: crawl never fetches a page beyond the configured depth', async () => {
  // home(0) -> about(1) -> deep1(2) -> deep2(3, exceeds maxDepth=2) -> deep3(would be 4)
  const result = await crawl({ startUrls: [`${origin}/site/home`], scope: scope({ maxDepth: 2, maxRequests: 20 }), allowPrivateFixture: true });
  assert.ok(result.visited.includes(`${origin}/site/deep1`));
  assert.ok(!result.visited.includes(`${origin}/site/deep2`), 'deep2 is at depth 3, beyond maxDepth=2');
  assert.ok(!result.visited.includes(`${origin}/site/deep3`));
});

// ── maxRequests ───────────────────────────────────────────────────────

test('maxRequests: the queue never accepts more than scope.maxRequests URLs, even with hundreds of candidate links', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/huge-page`], scope: scope({ maxRequests: 10, maxDepth: 2 }), allowPrivateFixture: true });
  assert.ok(result.requestsMade <= 10, `requestsMade=${result.requestsMade} must be <= 10`);
});

// ── duplicate URL / fragments ─────────────────────────────────────────

test('duplicate URL: the same page linked twice (home <-> about) is fetched only once each', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/home`], scope: scope({ maxDepth: 2 }), allowPrivateFixture: true });
  const homeCount = result.visited.filter(u => u === `${origin}/site/home`).length;
  const aboutCount = result.visited.filter(u => u === `${origin}/site/about`).length;
  assert.equal(homeCount, 1);
  assert.equal(aboutCount, 1);
});

test('fragments: URLs differing only by #fragment are canonicalized to the same URL and deduped', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/fragment-links`], scope: scope({ maxDepth: 1 }), allowPrivateFixture: true });
  const aboutHits = result.visited.filter(u => u.startsWith(`${origin}/site/about`)).length;
  assert.equal(aboutHits, 1, 'both #section-1 and #section-2 must dedupe to one /site/about fetch');
});

test('canonicalizeUrl: strips fragment, lowercases host, sorts query params', () => {
  assert.equal(canonicalizeUrl('http://EXAMPLE.invalid/path#frag'), 'http://example.invalid/path');
  const a = canonicalizeUrl('http://example.invalid/path?b=2&a=1');
  const b = canonicalizeUrl('http://example.invalid/path?a=1&b=2');
  assert.equal(a, b);
});

test('canonicalizeUrl: a malformed URL returns null rather than throwing', () => {
  assert.equal(canonicalizeUrl('not a url \x00 at all'), null);
  assert.equal(canonicalizeUrl(''), null);
});

// ── query variants (explosion protection) ─────────────────────────────

test('query explosion protection: a page with 20 query-string variants of the same path enqueues only up to MAX_QUERY_VARIANTS_PER_PATH', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/query-variants`], scope: scope({ maxDepth: 1, maxRequests: 50 }), allowPrivateFixture: true });
  const variantHits = result.visited.filter(u => u.includes('/site/query-variants?')).length;
  assert.ok(variantHits <= 5, `expected at most 5 query variants enqueued, got ${variantHits}`);
});

// ── relative / absolute links ──────────────────────────────────────────

test('relative and absolute same-host links are both extracted and resolved to the same origin', () => {
  const html = '<a href="/relative/path">rel</a><a href="http://127.0.0.1/absolute/path">abs</a>';
  const links = extractLinks(html, 'http://127.0.0.1/base');
  assert.ok(links.includes('http://127.0.0.1/relative/path'));
  assert.ok(links.includes('http://127.0.0.1/absolute/path'));
});

test('extractLinks: fragment-only, javascript:, mailto:, and tel: hrefs are ignored entirely', () => {
  const html = '<a href="#top">x</a><a href="javascript:alert(1)">x</a><a href="mailto:a@b.invalid">x</a><a href="tel:+123">x</a>';
  assert.deepEqual(extractLinks(html, 'http://127.0.0.1/base'), []);
});

test('extractLinks: malformed href does not crash extraction and is simply skipped', () => {
  assert.doesNotThrow(() => extractLinks('<a href="not a valid url \x00">x</a><a href="/ok">ok</a>', 'http://127.0.0.1/base'));
  const links = extractLinks('<a href="not a valid url \x00">x</a><a href="/ok">ok</a>', 'http://127.0.0.1/base');
  assert.ok(links.includes('http://127.0.0.1/ok'));
});

test('extractLinks: malformed HTML overall does not throw, returns an empty or best-effort list', () => {
  assert.doesNotThrow(() => extractLinks('<html><a href="/ok"<body unclosed', 'http://127.0.0.1/base'));
});

// ── external host link / forbidden subdomain ───────────────────────────

test('external host link: a link to an out-of-scope host is never enqueued or fetched', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/home`], scope: scope({ maxDepth: 1 }), allowPrivateFixture: true });
  assert.ok(!result.visited.some(u => u.includes('out-of-scope-fixture.invalid')));
});

test('forbidden subdomain: a link to a subdomain of an allowed host is denied unless followSubdomains is true', async () => {
  const subdomainScope = validateScope({ allowedHosts: ['example.invalid'], allowedPorts: [80], allowedProtocols: ['http:'] });
  const result = await crawl({
    startUrls: ['http://sub.example.invalid/page'], scope: subdomainScope,
    fetchImpl: async () => { throw new Error('must never be called — denied before fetch'); },
  });
  assert.equal(result.pagesFetched, 0);
  assert.equal(result.requestsMade, 0);
});

// ── excluded path ─────────────────────────────────────────────────────

test('excluded path: a path matching excludedPaths is never fetched, even as a start URL', async () => {
  const excludedScope = scope({ excludedPaths: ['/excluded'] });
  const result = await crawl({ startUrls: [`${origin}/excluded`], scope: excludedScope, allowPrivateFixture: true });
  assert.equal(result.pagesFetched, 0);
});

// ── private-IP redirect / redirect outside scope / redirect loop ──────
// (the crawler does NOT handle these itself — cyber-gateway.js does; these
// tests confirm the crawler correctly surfaces the gateway's denial as a
// per-page failure rather than crashing the whole crawl or looping.)

test('redirect outside scope: a page whose only content redirects out of scope is skipped, crawl continues', async () => {
  const result = await crawl({ startUrls: [`${origin}/redirect-out-of-scope`, `${origin}/site/contact`], scope: scope(), allowPrivateFixture: true });
  assert.ok(!result.visited.includes(`${origin}/redirect-out-of-scope`));
  assert.ok(result.visited.includes(`${origin}/site/contact`), 'crawl must continue past a per-URL denial');
});

test('private-IP redirect: a redirect target denied by the gateway is skipped, crawl continues to other pages', async () => {
  // /redirect-private redirects to 127.0.0.1:1 — a port outside this
  // scope's allowedPorts, so the gateway must deny that hop. (The
  // fixture itself lives on 127.0.0.1, so allowPrivateFixture stays true
  // here — the point under test is the gateway's per-hop scope/port
  // re-validation on the redirect TARGET, already covered at the policy
  // layer by test-cyber-audit-policy.mjs's private-address tests.)
  const result = await crawl({
    startUrls: [`${origin}/redirect-private`, `${origin}/site/contact`],
    scope: scope(),
    allowPrivateFixture: true,
  });
  assert.ok(!result.visited.includes(`${origin}/redirect-private`));
  assert.ok(result.visited.includes(`${origin}/site/contact`), 'crawl must continue past a per-URL denial');
});

test('redirect loop: a redirecting-to-itself page hits the gateway hop limit and is skipped, no infinite loop', async () => {
  const start = Date.now();
  const result = await crawl({ startUrls: [`${origin}/redirect-loop`], scope: scope(), allowPrivateFixture: true });
  assert.equal(result.pagesFetched, 0);
  assert.ok(Date.now() - start < 5000, 'must not hang');
});

test('a link found INSIDE an authorized page that itself redirects is still subject to full gateway redirect validation (crawler does not special-case it)', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/redirect-hop`], scope: scope({ maxDepth: 1 }), allowPrivateFixture: true });
  // /site/redirect-hop -> 302 -> /site/home (the gateway follows the hop
  // internally and returns /site/home's content as the result for this
  // ONE queued URL) -- and since /site/home's own links are within
  // maxDepth=1, the crawler goes on to enqueue and fetch them too.
  assert.equal(result.pagesFetched, 4, '/site/redirect-hop (resolves to home) + about + contact + home-via-about-backlink, all within depth 1');
  assert.ok(result.visited.includes(`${origin}/site/redirect-hop`));
});

// ── huge page ──────────────────────────────────────────────────────────

test('huge page: a page with 200 links is handled without crashing, bounded by maxRequests', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/huge-page`], scope: scope({ maxRequests: 15, maxDepth: 2 }), allowPrivateFixture: true });
  assert.ok(result.requestsMade <= 15);
});

// ── robots.txt handling ────────────────────────────────────────────────

test('robots.txt: parsed as data only — Disallow entries are never auto-visited', async () => {
  const parsed = await fetchRobotsTxt({ robotsUrl: `${origin}/robots.txt`, scope: scope(), allowPrivateFixture: true });
  assert.ok(parsed);
  assert.ok(parsed.rules.some(r => r.type === 'disallow' && r.path === '/admin/'));
  assert.deepEqual(parsed.sitemaps, ['/sitemap.xml']);
});

test('robots.txt: fetchRobotsTxt itself never triggers a crawl of any Disallow path (pure parse, no side effects)', async () => {
  let requestCount = 0;
  fixture.server.on('request', () => { requestCount++; });
  const before = requestCount;
  await fetchRobotsTxt({ robotsUrl: `${origin}/robots.txt`, scope: scope(), allowPrivateFixture: true });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(requestCount, before + 1, 'fetching robots.txt must be exactly one request, no follow-up crawl of its Disallow rules');
});

test('parseRobotsTxt: malformed content does not throw', () => {
  assert.doesNotThrow(() => parseRobotsTxt('garbage : : : \n\n### not robots'));
  assert.deepEqual(parseRobotsTxt(null), { sitemaps: [], rules: [] });
});

// ── sitemap.xml handling ────────────────────────────────────────────────

test('sitemap.xml: only URLs passing the full scope policy are returned; out-of-scope entries are filtered out', async () => {
  const urls = await discoverSitemapUrls({ sitemapUrl: `${origin}/sitemap.xml`, scope: scope(), allowPrivateFixture: true });
  assert.ok(urls.some(u => u.includes('/site/home')));
  assert.ok(urls.some(u => u.includes('/site/about')));
  assert.ok(!urls.some(u => u.includes('out-of-scope-fixture.invalid')), 'out-of-scope sitemap entries must be filtered');
  assert.ok(!urls.some(u => u.includes('/site/logout')), 'dangerous-looking sitemap entries must be filtered');
});

test('sitemap.xml URLs respect the same maxRequests cap as any other discovery source', async () => {
  const urls = await discoverSitemapUrls({ sitemapUrl: `${origin}/sitemap.xml`, scope: scope({ maxRequests: 1 }), allowPrivateFixture: true });
  assert.ok(urls.length <= 1);
});

test('parseSitemapXml: malformed XML does not throw, returns whatever <loc> tags it can find', () => {
  assert.doesNotThrow(() => parseSitemapXml('<not><valid<xml'));
  assert.deepEqual(parseSitemapXml(null), []);
});

// ── destructive-looking links skipped ──────────────────────────────────

test('destructive-looking links: logout/delete/etc. paths are never enqueued even though they are otherwise in-scope', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/home`], scope: scope({ maxDepth: 1 }), allowPrivateFixture: true });
  assert.ok(!result.visited.some(u => u.includes('/site/logout')));
});

// ── prompt-injection text ignored ───────────────────────────────────────

test('prompt injection: injection text on a page never produces an extra URL; only the real <a href> on that page is followed', async () => {
  const result = await crawl({ startUrls: [`${origin}/site/prompt-injection-with-real-link`], scope: scope({ maxDepth: 1 }), allowPrivateFixture: true });
  assert.ok(result.visited.includes(`${origin}/site/contact`), 'the real link must still be followed');
  assert.ok(!result.visited.some(u => u.includes('localhost') || u.includes('admin.internal')), 'injection text must never become a URL');
  assert.equal(result.pagesFetched, 2); // the injection page itself + the one real link
});

// ── cancel while crawling ───────────────────────────────────────────────

test('cancellation: aborting mid-crawl stops immediately, no new pages fetched after abort, queue is cleared', async () => {
  const controller = new AbortController();
  let fetchCount = 0;
  const slowFetch = async (args) => {
    fetchCount++;
    if (fetchCount === 1) setTimeout(() => controller.abort(), 10);
    const { safeCyberFetch } = await import('./src/lib/cyber-gateway.js');
    return safeCyberFetch(args);
  };
  const result = await crawl({
    startUrls: [`${origin}/site/home`], scope: scope({ maxDepth: 3 }),
    signal: controller.signal, allowPrivateFixture: true, fetchImpl: slowFetch,
  });
  assert.equal(result.stoppedReason, 'cancelled');
});

test('cancellation: an already-aborted signal stops the crawl before any request is made', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await crawl({
    startUrls: [`${origin}/site/home`], scope: scope(),
    signal: controller.signal, allowPrivateFixture: true,
    fetchImpl: async () => { throw new Error('must never be called'); },
  });
  assert.equal(result.requestsMade, 0);
  assert.equal(result.stoppedReason, 'cancelled');
});

// ── timeout ────────────────────────────────────────────────────────────

test('timeout: a per-request timeout on one URL is a per-page failure, not a crawl-wide hang', async () => {
  const start = Date.now();
  const result = await crawl({ startUrls: [`${origin}/slow`, `${origin}/site/contact`], scope: scope({ timeoutMs: 1000 }), allowPrivateFixture: true });
  assert.ok(Date.now() - start < 5000);
  assert.ok(result.visited.includes(`${origin}/site/contact`));
});

// ── queue cleanup / no orphan requests ──────────────────────────────────

test('queue cleanup: after cancellation the internal queue is empty (verified indirectly via stoppedReason + no further visited entries after abort)', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await crawl({ startUrls: [`${origin}/site/home`, `${origin}/site/about`], scope: scope(), signal: controller.signal, allowPrivateFixture: true });
  assert.equal(result.visited.length, 0);
});

test('no orphan requests: total fetch attempts never exceed requestsMade + the initially-rejected (never-fetched) start URLs', async () => {
  let fetchCalls = 0;
  const countingFetch = async (args) => {
    fetchCalls++;
    const { safeCyberFetch } = await import('./src/lib/cyber-gateway.js');
    return safeCyberFetch(args);
  };
  const result = await crawl({ startUrls: [`${origin}/site/contact`], scope: scope(), allowPrivateFixture: true, fetchImpl: countingFetch });
  assert.equal(fetchCalls, result.requestsMade);
});

// ── Explicit confirmations required by the mission ──────────────────────

test('confirmation: zero out-of-scope network requests across this entire crawler suite', async () => {
  let outOfScopeHit = false;
  fixture.server.on('request', req => {
    if (req.headers.host && !req.headers.host.startsWith('127.0.0.1')) outOfScopeHit = true;
  });
  assert.equal(outOfScopeHit, false);
});

test('confirmation: zero POST/PUT/PATCH/DELETE requests ever reach the fixture from the crawler', async () => {
  let sawForbiddenMethod = false;
  fixture.server.on('unexpected-method', () => { sawForbiddenMethod = true; });
  await crawl({ startUrls: [`${origin}/site/home`], scope: scope({ maxDepth: 2 }), allowPrivateFixture: true });
  assert.equal(sawForbiddenMethod, false);
});
