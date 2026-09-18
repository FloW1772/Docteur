/**
 * Bounded, in-scope-only crawler for the Cyber Audit Agent (SENTINEL V1,
 * CA-6). Discovers pages ONLY from: (1) the mission's declared start
 * URL(s), (2) <a href> links found in already-authorized pages, (3)
 * robots.txt (data only, never auto-visited Disallow entries), (4)
 * sitemap.xml URLs that pass the full scope policy. No wordlists, no
 * brute force, no path guessing, no subdomain/DNS enumeration — this
 * module cannot generate a URL that wasn't already present somewhere in
 * scope-authorized content.
 *
 * This module NEVER calls fetch/http/https directly. Every single
 * network access goes through cyber-gateway.js's safeCyberFetch(), which
 * itself is built on cyber-policy.js's scope+DNS+redirect validation.
 * This file only decides WHICH already-safe-to-request URL to request
 * next and WHEN to stop — it is pure orchestration over an already-locked
 * policy boundary, not a second copy of that boundary.
 *
 * GET/HEAD only (enforced again here, redundantly with cyber-policy.js,
 * as defense in depth — a crawler bug here must never be the only thing
 * standing between "browsing" and "submitting").
 */

import { JSDOM } from 'jsdom';
import { authorizeCyberRequest, denied, ALLOWED_METHODS } from './cyber-policy.js';
import { safeCyberFetch } from './cyber-gateway.js';

// Path segments that suggest a state-changing/destructive action — a
// crawler must never auto-follow these even though they are otherwise
// in-scope, in-protocol, in-port links. This is a SECONDARY barrier
// (the crawler is GET/HEAD-only regardless, so nothing here can actually
// submit a destructive action) — its purpose is to avoid even OBSERVING
// a logout/delete/etc. link, which could have side effects on some badly
// designed sites that perform state changes on GET.
const DANGEROUS_PATH_PATTERN = /(logout|signout|sign-out|delete|remove|unsubscribe|destroy|checkout|payment|purchase|\/order\b|confirm|reset|terminate)/i;

const MAX_QUERY_VARIANTS_PER_PATH = 5;

/**
 * Canonicalizes a URL for dedup purposes: lowercases the host, strips the
 * fragment, sorts query parameters (so ?a=1&b=2 and ?b=2&a=1 dedupe to the
 * same key), but does NOT strip the query string outright — different
 * query values are treated as potentially different pages, bounded by
 * MAX_QUERY_VARIANTS_PER_PATH per path (see CrawlQueue.enqueue).
 */
export function canonicalizeUrl(raw, base) {
  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  url.hash = '';
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);
  url.hostname = url.hostname.toLowerCase();
  return url.href;
}

function pathQueryKey(url) {
  const u = new URL(url);
  return `${u.hostname}${u.pathname}`;
}

function isDangerousLink(url) {
  try {
    const u = new URL(url);
    return DANGEROUS_PATH_PATTERN.test(u.pathname) || DANGEROUS_PATH_PATTERN.test(u.search);
  } catch {
    return true; // malformed — treat conservatively as dangerous/unusable
  }
}

/**
 * Extracts <a href> targets from HTML, resolved against `baseUrl`. Uses
 * jsdom WITHOUT the `runScripts` option (the safe default — scripts are
 * parsed as inert text nodes, never executed; no `<script>` tag content
 * ever runs). No headless browser, no rendering, no onclick/event
 * handling — this only walks the static DOM tree jsdom builds from the
 * raw HTML string.
 */
export function extractLinks(html, baseUrl) {
  if (typeof html !== 'string' || !html) return [];
  let dom;
  try {
    dom = new JSDOM(html, { url: baseUrl });
  } catch {
    return []; // malformed HTML — never throws the crawl, just yields no links
  }
  const anchors = dom.window.document.querySelectorAll('a[href]');
  const links = [];
  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    const canonical = canonicalizeUrl(href, baseUrl);
    if (canonical) links.push(canonical);
  }
  dom.window.close();
  return links;
}

/**
 * Parses robots.txt content into structured data ONLY — never auto-visits
 * any Disallow entry. Returned purely for the report/evidence layer to
 * display; not consumed by the crawl loop's queueing logic at all.
 */
export function parseRobotsTxt(text) {
  if (typeof text !== 'string') return { sitemaps: [], rules: [] };
  const sitemaps = [];
  const rules = [];
  let currentAgent = '*';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'sitemap' && value) sitemaps.push(value);
    else if (key === 'user-agent' && value) currentAgent = value;
    else if ((key === 'disallow' || key === 'allow') && value !== undefined) {
      rules.push({ userAgent: currentAgent, type: key, path: value });
    }
  }
  return { sitemaps, rules };
}

/**
 * Parses sitemap.xml (a plain <loc> extraction — no XML entity expansion
 * beyond what Node's built-in string methods do, no external DTD
 * fetching, no XXE surface) into a flat URL list. Filtering against scope
 * happens in the crawl loop, not here — this function only extracts what
 * the file claims, same as extractLinks for HTML.
 */
export function parseSitemapXml(xml) {
  if (typeof xml !== 'string') return [];
  const matches = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)];
  return matches.map(m => m[1]).filter(Boolean);
}

/**
 * A bounded FIFO queue that enforces maxRequests and per-path query-variant
 * caps at enqueue time — never grows past scope.maxRequests entries ever
 * queued (not just "in flight"), so there is no path to an unbounded
 * queue even if link extraction finds thousands of candidate URLs.
 */
class BoundedCrawlQueue {
  constructor({ maxRequests }) {
    this.maxRequests = maxRequests;
    this.queue = [];
    this.seen = new Set(); // canonical URLs ever enqueued (dedup)
    this.queryVariantsByPath = new Map(); // pathQueryKey -> count
    this.totalEnqueued = 0;
  }

  canEnqueue(canonicalUrl) {
    if (this.totalEnqueued >= this.maxRequests) return false;
    if (this.seen.has(canonicalUrl)) return false;
    const key = pathQueryKey(canonicalUrl);
    const variants = this.queryVariantsByPath.get(key) || 0;
    return variants < MAX_QUERY_VARIANTS_PER_PATH;
  }

  enqueue(canonicalUrl, depth) {
    if (!this.canEnqueue(canonicalUrl)) return false;
    this.seen.add(canonicalUrl);
    const key = pathQueryKey(canonicalUrl);
    this.queryVariantsByPath.set(key, (this.queryVariantsByPath.get(key) || 0) + 1);
    this.queue.push({ url: canonicalUrl, depth });
    this.totalEnqueued += 1;
    return true;
  }

  dequeue() {
    return this.queue.shift();
  }

  clear() {
    this.queue = [];
  }

  get length() {
    return this.queue.length;
  }
}

/**
 * Runs a bounded crawl starting from `startUrls`, following only
 * in-scope <a href> links found in already-fetched pages (plus an
 * optional scope-filtered sitemap.xml seed). Every fetch goes through
 * safeCyberFetch; this function never opens a socket itself.
 *
 * @param {object} params
 * @param {string[]} params.startUrls
 * @param {object} params.scope - a validated, frozen scope from cyber-policy.js
 * @param {AbortSignal} [params.signal] - external cancellation; checked before every enqueue AND before every fetch
 * @param {boolean} [params.allowPrivateFixture] - test-only escape hatch, forwarded verbatim to safeCyberFetch
 * @param {function} [params.onPage] - called with { url, depth, status, html, headers } after each successful fetch
 * @param {function} [params.fetchImpl] - injectable for tests; defaults to safeCyberFetch
 * @returns {Promise<{ pagesFetched: number, requestsMade: number, stoppedReason: string, visited: string[] }>}
 */
export async function crawl({ startUrls, scope, signal, allowPrivateFixture = false, onPage = () => {}, fetchImpl = safeCyberFetch }) {
  const queue = new BoundedCrawlQueue({ maxRequests: scope.maxRequests });
  const visited = [];
  let requestsMade = 0;
  let stoppedReason = 'completed';

  // Seed the queue with the mission's declared start URLs — the ONLY
  // externally-supplied URLs this crawler ever accepts. Each is
  // canonicalized and policy-checked (syntactically) before queueing;
  // an out-of-scope start URL is simply never queued (not an error —
  // the mission may declare a start URL alongside an out-of-scope
  // exclusion by mistake, and this must fail closed, not throw and
  // abort the whole mission).
  for (const raw of startUrls) {
    if (signal?.aborted) { stoppedReason = 'cancelled'; break; }
    const canonical = canonicalizeUrl(raw);
    if (!canonical) continue;
    try {
      authorizeCyberRequest({ url: canonical, method: 'GET', scope });
    } catch {
      continue; // out of scope — never queued, never a crash
    }
    if (isDangerousLink(canonical)) continue;
    queue.enqueue(canonical, 0);
  }

  const startTime = Date.now();

  while (queue.length > 0) {
    if (signal?.aborted) { stoppedReason = 'cancelled'; queue.clear(); break; }
    if (Date.now() - startTime > scope.timeoutMs * Math.max(1, scope.maxRequests)) {
      // Defense in depth only — the real mission-level timeout is
      // enforced by the caller (CA-7's mission lifecycle), this is a
      // last-resort circuit breaker so a crawl can never spin forever
      // even if the caller forgot to wire mission-level cancellation.
      stoppedReason = 'timeout';
      queue.clear();
      break;
    }

    const { url, depth } = queue.dequeue();
    if (depth > scope.maxDepth) continue;

    let result;
    try {
      // GET/HEAD enforced redundantly here (cyber-policy.js already
      // enforces it too) — a crawler bug must never be the only thing
      // preventing a state-changing request.
      if (!ALLOWED_METHODS.has('GET')) throw denied('exploitation_method_denied');
      result = await fetchImpl({ url, method: 'GET', scope, signal, allowPrivateFixture });
    } catch (err) {
      if (err?.code === 'request_cancelled') { stoppedReason = 'cancelled'; queue.clear(); break; }
      // Any other denial (out of scope on a redirect target, timeout,
      // response too large, etc.) is a per-page failure, not a crawl
      // abort — record nothing further for this URL and move on.
      requestsMade += 1;
      continue;
    }
    requestsMade += 1;
    visited.push(url);

    const contentType = result.contentType || '';
    const isHtml = contentType.includes('text/html') || contentType === '';
    const bodyText = Buffer.from(result.body, 'base64').toString('utf8');

    onPage({ url, depth, status: result.status, html: isHtml ? bodyText : null, headers: result.headers });

    if (isHtml && depth < scope.maxDepth) {
      const links = extractLinks(bodyText, url);
      for (const link of links) {
        if (signal?.aborted) break;
        if (isDangerousLink(link)) continue;
        try {
          authorizeCyberRequest({ url: link, method: 'GET', scope });
        } catch {
          continue; // out of scope — never queued
        }
        queue.enqueue(link, depth + 1);
      }
    }
  }

  return { pagesFetched: visited.length, requestsMade, stoppedReason, visited };
}

/**
 * Fetches and parses sitemap.xml for a given origin, filtering every
 * extracted URL through the SAME scope policy as any other link (no
 * special trust). Returns only URLs that pass authorizeCyberRequest,
 * capped by scope.maxRequests — this function does not itself crawl
 * those URLs, it only returns a candidate seed list for crawl()'s
 * startUrls.
 */
export async function discoverSitemapUrls({ sitemapUrl, scope, signal, allowPrivateFixture = false, fetchImpl = safeCyberFetch }) {
  try {
    authorizeCyberRequest({ url: sitemapUrl, method: 'GET', scope });
  } catch {
    return [];
  }
  let result;
  try {
    result = await fetchImpl({ url: sitemapUrl, method: 'GET', scope, signal, allowPrivateFixture });
  } catch {
    return [];
  }
  if (result.status < 200 || result.status >= 300) return [];
  const xml = Buffer.from(result.body, 'base64').toString('utf8');
  const candidates = parseSitemapXml(xml);
  const authorized = [];
  for (const raw of candidates) {
    if (authorized.length >= scope.maxRequests) break;
    const canonical = canonicalizeUrl(raw);
    if (!canonical || isDangerousLink(canonical)) continue;
    try {
      authorizeCyberRequest({ url: canonical, method: 'GET', scope });
      authorized.push(canonical);
    } catch { /* not in scope — skipped */ }
  }
  return authorized;
}

/**
 * Fetches and parses robots.txt for a given origin. Returns the parsed
 * structure (rules + sitemap URLs) as DATA ONLY — the caller decides
 * whether to feed the discovered sitemap URLs into discoverSitemapUrls;
 * Disallow entries are never auto-visited by anything in this module.
 */
export async function fetchRobotsTxt({ robotsUrl, scope, signal, allowPrivateFixture = false, fetchImpl = safeCyberFetch }) {
  try {
    authorizeCyberRequest({ url: robotsUrl, method: 'GET', scope });
  } catch {
    return null;
  }
  let result;
  try {
    result = await fetchImpl({ url: robotsUrl, method: 'GET', scope, signal, allowPrivateFixture });
  } catch {
    return null;
  }
  if (result.status < 200 || result.status >= 300) return null;
  const text = Buffer.from(result.body, 'base64').toString('utf8');
  return parseRobotsTxt(text);
}
