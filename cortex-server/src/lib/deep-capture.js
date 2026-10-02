import { YoutubeTranscript } from 'youtube-transcript';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright';
import { assertSafeUrl } from './url-security.js';
import { safeFetch, installBrowserEgressGuard, getSharedBrowserEgressProxy, closeSharedBrowserEgressProxy } from './web-egress-guard.js';
import { getVideoDuration } from './whisper.js';

const MAX_WORDS      = 8_000;
const FETCH_TIMEOUT  = 15_000;
const PW_TIMEOUT     = 25_000;  // per-page Playwright timeout (raised: domcontentloaded fires fast but some sites are slow to serve HTML)
const PW_IDLE_MS     = 5 * 60 * 1000; // close browser after 5 min inactivity
const MIN_WORDS_FAST = 200;     // below this threshold → try Playwright
const MIN_ARTICLE_WORDS = 90;
const MIN_ARTICLE_CHARS = 500;

// ── Browser pool (single reusable instance) ───────────────────────────────────

let _browser    = null;
let _idleTimer  = null;

// WEB EGRESS GUARD: Chromium is forced through a loopback forwarding proxy that validates + pins EVERY connection
// (main document, redirect hops, sub-resources, page scripts). A Playwright route() filter alone does not see redirect hops.

async function getBrowser() {
  if (_browser) {
    resetIdleTimer();
    return _browser;
  }
  const proxy = await getSharedBrowserEgressProxy();
  _browser = await chromium.launch({ headless: true, ...proxy.launchOptions() });
  resetIdleTimer();
  return _browser;
}

function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    if (_browser) {
      const b = _browser;
      _browser = null;
      _idleTimer = null;
      try { await b.close(); } catch { /* ignore */ }
    }
  }, PW_IDLE_MS);
}

export async function closeDeepCaptureBrowserForTests() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = null;
  const browser = _browser;
  _browser = null;
  if (browser) await browser.close().catch(() => {});
  await closeSharedBrowserEgressProxy().catch(() => {});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function cleanArticleText(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .split(/\n{2,}|(?=<\/p>)/i)
    .map(part => part.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

const BOILERPLATE_RE = /(?:tout accepter|gérer (?:mes )?cookies|politique de confidentialité|abonnez-vous|se connecter|publicité|contenu sponsorisé|newsletter)/i;

export function assessArticleQuality(text, { semantic = false, paragraphCount } = {}) {
  const clean = cleanArticleText(text);
  const chars = clean.length;
  const words = countWords(clean);
  const paragraphs = paragraphCount ?? clean.split(/\n{2,}/).filter(p => countWords(p) >= 8).length;
  const lines = clean.split(/\n+/).filter(Boolean);
  const boilerplateWords = lines.filter(line => BOILERPLATE_RE.test(line)).reduce((n, line) => n + countWords(line), 0);
  const boilerplateRatio = words ? boilerplateWords / words : 1;
  const complete = boilerplateRatio < 0.45 && (
    (words >= MIN_WORDS_FAST && chars >= 1_000) ||
    (semantic && words >= MIN_ARTICLE_WORDS && chars >= MIN_ARTICLE_CHARS) ||
    (words >= 120 && chars >= 700 && paragraphs >= 2)
  );
  return {
    complete,
    chars,
    words,
    paragraphs,
    boilerplateRatio: Number(boilerplateRatio.toFixed(3)),
    score: words + Math.min(paragraphs, 12) * 12 + (semantic ? 35 : 0) - Math.round(boilerplateRatio * 200),
  };
}

// Detects MSN/web video player UI text that got scraped instead of article content.
// Two or more of these markers in the same text → it's the player interface, not an article.
function isVideoPlayerGarbage(text) {
  const markers = ['Video Player is loading', 'Playback Speed', 'Play Video', 'Heure actuelle'];
  return markers.filter(m => text.includes(m)).length >= 2;
}

function truncateForModel(text) {
  const words = text.trim().split(/\s+/);
  if (words.length <= MAX_WORDS) return { text, truncated: false };
  const half = Math.floor(MAX_WORDS / 2);
  const head = words.slice(0, half).join(' ');
  const tail = words.slice(-half).join(' ');
  return {
    text: `${head}\n\n[… contenu tronqué — ${words.length - MAX_WORDS} mots omis …]\n\n${tail}`,
    truncated: true,
  };
}

// Lazy-load attributes ordered by priority (real URL first, fallback src last).
// 'src' is last because it's often a base64 placeholder on lazy-loaded images.
const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-lazy', 'data-original', 'data-img', 'src'];

// Conservative junk filter — only patterns that are UNAMBIGUOUSLY noise.
// Deliberately avoids broad terms (media, img, thumb…) that appear in CDN URLs.
const JUNK_PATTERNS = [
  { re: /\/favicon/i,                                    reason: 'favicon'   },
  { re: /\btracking[_.-]pixel\b/i,                       reason: 'trk-pixel' },
  { re: /[?&](width=1&|height=1&|w=1&|h=1[&$])/i,       reason: '1x1-qs'   },
  { re: /\/1x1\./i,                                      reason: '1x1-path'  },
  { re: /\bbeacon\b/i,                                   reason: 'beacon'    },
  { re: /\/ads?\//i,                                     reason: 'ad-path'   },
  { re: /\.svg(\?|$)/i,                                  reason: 'svg'       },
];

// DOM zones that never contain article body images: ads, suggestions, related posts…
const NOISE_ZONE_SEL =
  'aside, footer, nav, ' +
  '[class*="suggest"], [class*="related"], [class*="recommend"], ' +
  '[class*="promo"], [class*="sponsor"], [class*="partner"], ' +
  '[class*="publi"], [class*="commercial"], ' +
  '[id*="suggest"], [id*="related"], [id*="sponsor"], [id*="promo"]';

// Extract image width from CDN URL patterns, e.g. "1444x920_", "?w=1280", "?width=800".
function widthFromUrl(url) {
  const m = url.match(/[/_-](\d{3,5})x(\d{3,5})[/_.-]/i);
  if (m) return parseInt(m[1], 10);
  try {
    const u = new URL(url);
    const w = u.searchParams.get('w') || u.searchParams.get('width') || u.searchParams.get('imwidth');
    if (w) { const n = parseInt(w, 10); if (n > 0) return n; }
  } catch { /* skip */ }
  return 0;
}

// Take the highest-resolution URL from a srcset string.
// srcset = "url1 320w, url2 640w, url3 1280w" → last valid entry (highest w/x).
function bestFromSrcset(srcset, baseUrl) {
  if (!srcset) return '';
  const entries = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
  // Iterate in reverse to find highest-res entry first
  for (let i = entries.length - 1; i >= 0; i--) {
    const u = entries[i];
    if (!u || u.startsWith('data:')) continue;
    try {
      const abs = new URL(u, baseUrl).href;
      if (/^https?:\/\//i.test(abs)) return abs;
    } catch { /* skip */ }
  }
  return '';
}

// Return the best real image URL from an <img> or <picture source> element.
// Skips data: URIs and blank values. For <source>, reads srcset (highest res).
function bestSrc(el, baseUrl) {
  const tag = (el.tagName || '').toLowerCase();

  if (tag === 'source') {
    // <source> inside <picture> — srcset is the primary attribute
    return bestFromSrcset(el.getAttribute('srcset') || el.getAttribute('data-srcset') || '', baseUrl);
  }

  // <img> — check lazy-load attributes before 'src' to skip base64 placeholders
  for (const attr of LAZY_ATTRS) {
    const val = (el.getAttribute(attr) || '').trim();
    if (!val || val.startsWith('data:')) continue;
    try {
      const abs = new URL(val, baseUrl).href;
      if (/^https?:\/\//i.test(abs)) return abs;
    } catch { /* skip */ }
  }
  // srcset fallback for <img> (take highest-res)
  const ss = el.getAttribute('srcset') || el.getAttribute('data-srcset') || '';
  return bestFromSrcset(ss, baseUrl);
}

// Check URL against junk patterns; returns reason string if junk, '' if clean.
function junkReason(url) {
  for (const { re, reason } of JUNK_PATTERNS) {
    if (re.test(url)) return reason;
  }
  return '';
}

// Extract article image URLs from raw page HTML.
// Scans <img> AND <picture>/<source> elements. Tries article-scoped containers
// first; falls back to full body when the restricted scope has < 2 elements.
// Logs detailed per-element decisions for diagnosis.
function extractImagesFromHtml(rawHtml, baseUrl) {
  if (!rawHtml) return [];
  const rejectLog = [];
  try {
    const dom = new JSDOM(rawHtml, { url: baseUrl });
    const doc = dom.window.document;

    // Candidate scopes from narrowest to broadest
    const scopeSelectors = [
      'article',
      '[class*="article-body"], [class*="article-content"]',
      '[class*="post-content"], [class*="entry-content"]',
      'main, [role="main"]',
    ];

    // Pick narrowest scope that contains at least 2 image elements
    let scope = doc.body;
    for (const sel of scopeSelectors) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const count = el.querySelectorAll('img, picture > source').length;
      if (count >= 2) { scope = el; break; }
      if (count === 1) { scope = el; /* keep looking for better */ }
    }

    // Scan both <img> and <picture> > <source> to catch modern responsive images
    const elements = [...scope.querySelectorAll('img, picture > source')];
    const seen = new Set();
    const candidates = []; // { url, w } — collected before sort

    for (const el of elements) {
      // Skip elements inside noise zones (ads, suggestions, related articles)
      if (el.closest(NOISE_ZONE_SEL)) {
        rejectLog.push({ tag: el.tagName, reason: 'noise-zone' });
        continue;
      }

      const absUrl = bestSrc(el, baseUrl);
      if (!absUrl) {
        rejectLog.push({ tag: el.tagName, reason: 'no-src' });
        continue;
      }
      if (seen.has(absUrl)) {
        rejectLog.push({ url: absUrl, reason: 'duplicate' });
        continue;
      }

      // Junk URL filter (tracking pixels, favicons, SVG…)
      const jr = junkReason(absUrl);
      if (jr) {
        rejectLog.push({ url: absUrl, reason: `junk:${jr}` });
        continue;
      }

      // Determine effective width: URL-encoded dimension > HTML attr > unknown
      const attrW = parseInt(el.getAttribute('width')  || '0', 10);
      const attrH = parseInt(el.getAttribute('height') || '0', 10);
      const urlW  = widthFromUrl(absUrl);
      const effW  = urlW || attrW;

      // Reject thumbnails/vignettes: width < 600 px
      // (article hero images are typically 800-1500 px; ad thumbnails ~480 px)
      if (effW > 0 && effW < 600) {
        rejectLog.push({ url: absUrl, reason: `narrow:${effW}px` });
        continue;
      }
      // Also reject by height attr alone when width is unknown
      if (attrH > 0 && attrH < 300 && effW === 0) {
        rejectLog.push({ url: absUrl, reason: `short-attr:${attrH}px` });
        continue;
      }

      // SSRF guard
      try { assertSafeUrl(absUrl); } catch (e) {
        rejectLog.push({ url: absUrl, reason: `ssrf:${e.message}` });
        continue;
      }

      seen.add(absUrl);
      candidates.push({ url: absUrl, w: effW });
    }

    // Sort widest-first (hero image most likely to be largest) then cap at 2
    candidates.sort((a, b) => b.w - a.w);
    return candidates.slice(0, 2).map(c => c.url);
  } catch {
    return [];
  }
}

function jsonLdNodes(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) jsonLdNodes(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  out.push(value);
  if (Array.isArray(value['@graph'])) jsonLdNodes(value['@graph'], out);
  return out;
}

function isArticleJsonLd(node) {
  const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']];
  return types.some(type => /^(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle|BlogPosting)$/i.test(String(type ?? '')));
}

function jsonLdImageUrls(image, baseUrl) {
  const values = Array.isArray(image) ? image : [image];
  const urls = [];
  for (const value of values) {
    const raw = typeof value === 'string' ? value : (value?.url ?? value?.contentUrl);
    if (!raw) continue;
    try {
      const absolute = new URL(raw, baseUrl).href;
      assertSafeUrl(absolute);
      if (!junkReason(absolute)) urls.push(absolute);
    } catch { /* invalid or unsafe image */ }
  }
  return [...new Set(urls)].slice(0, 2);
}

function articleCandidate(source, title, text, imageUrls = [], extra = {}) {
  const clean = cleanArticleText(text);
  if (!clean) return null;
  const semantic = source !== 'readability';
  const quality = assessArticleQuality(clean, { semantic, paragraphCount: extra.paragraphCount });
  return {
    source,
    title: String(title ?? '').replace(/\s+/g, ' ').trim(),
    text: clean,
    imageUrls: [...new Set(imageUrls)].slice(0, 2),
    quality,
    ...extra,
  };
}

function selectBestArticleCandidate(candidates) {
  return candidates.filter(Boolean).sort((a, b) =>
    Number(b.quality.complete) - Number(a.quality.complete) ||
    b.quality.score - a.quality.score ||
    b.quality.chars - a.quality.chars
  )[0] ?? null;
}

function metricFor(candidates, source) {
  const found = candidates.filter(c => c.source === source).sort((a, b) => b.quality.chars - a.quality.chars)[0];
  return { chars: found?.quality.chars ?? 0, words: found?.quality.words ?? 0, paragraphs: found?.quality.paragraphs ?? 0 };
}

export function extractArticleCandidatesFromHtml(html, url) {
  try {
    // Extract images before Readability mutates the DOM and strips lazy attributes.
    const domImages = extractImagesFromHtml(html, url);
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    const candidates = [];

    // Structured data is often the authoritative article body on hydrated news sites.
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent?.trim() ?? 'null');
        for (const node of jsonLdNodes(parsed)) {
          if (!isArticleJsonLd(node) || typeof node.articleBody !== 'string') continue;
          const candidate = articleCandidate(
            'json-ld',
            node.headline ?? node.name ?? doc.title,
            node.articleBody,
            [...jsonLdImageUrls(node.image, url), ...domImages],
            {
              author: Array.isArray(node.author) ? node.author.map(a => a?.name ?? a).filter(Boolean).join(', ') : (node.author?.name ?? node.author ?? ''),
              datePublished: node.datePublished ?? '',
            },
          );
          if (candidate) candidates.push(candidate);
        }
      } catch { /* malformed JSON-LD is ignored; other extractors remain available */ }
    }

    const readabilityDom = new JSDOM(html, { url });
    const readability = new Readability(readabilityDom.window.document).parse();
    if (readability?.textContent) {
      const candidate = articleCandidate('readability', readability.title ?? doc.title, readability.textContent, domImages);
      if (candidate) candidates.push(candidate);
    }

    // Generic semantic DOM fallback. Clone before deleting boilerplate zones so the live page is never mutated.
    const selectors = ['[itemprop="articleBody"]', 'article', '[role="article"]', '.article-body', '.article-content', '.post-content', '.entry-content', 'main'];
    const seen = new Set();
    for (const selector of selectors) {
      for (const element of doc.querySelectorAll(selector)) {
        if (seen.has(element) || element.closest(NOISE_ZONE_SEL)) continue;
        seen.add(element);
        const clone = element.cloneNode(true);
        clone.querySelectorAll(`script, style, noscript, nav, aside, footer, form, ${NOISE_ZONE_SEL}`).forEach(node => node.remove());
        const paragraphs = [...clone.querySelectorAll('p')]
          .map(p => p.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .filter(p => countWords(p) >= 5);
        const text = paragraphs.length ? paragraphs.join('\n\n') : clone.textContent;
        const candidate = articleCandidate(
          'semantic-dom',
          element.querySelector('h1')?.textContent ?? doc.querySelector('h1')?.textContent ?? doc.title,
          text,
          domImages,
          { paragraphCount: paragraphs.length },
        );
        if (candidate) candidates.push(candidate);
      }
    }

    let best = selectBestArticleCandidate(candidates);
    if (best) {
      const mergedImages = [...new Set(candidates.flatMap(candidate => candidate.imageUrls ?? []))].slice(0, 2);
      best = { ...best, imageUrls: mergedImages };
    }
    return {
      best,
      candidates,
      metrics: {
        rawChars: String(html ?? '').length,
        readability: metricFor(candidates, 'readability'),
        structured: metricFor(candidates, 'json-ld'),
        semantic: metricFor(candidates, 'semantic-dom'),
        chosenExtractor: best?.source ?? null,
        finalChars: best?.quality.chars ?? 0,
        finalWords: best?.quality.words ?? 0,
        finalParagraphs: best?.quality.paragraphs ?? 0,
        qualityStatus: best?.quality.complete ? 'COMPLETE' : (best ? 'PARTIAL_EXTRACTION' : 'NO_CONTENT'),
      },
    };
  } catch {
    return { best: null, candidates: [], metrics: { rawChars: String(html ?? '').length, chosenExtractor: null, finalChars: 0, finalWords: 0, finalParagraphs: 0, qualityStatus: 'NO_CONTENT' } };
  }
}

export function extractArticleFromHtml(html, url) {
  const inspected = extractArticleCandidatesFromHtml(html, url);
  if (!inspected.best?.quality.complete) return null;
  return { ...inspected.best, diagnostics: inspected.metrics };
}

function getYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    const shortMatch = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})(?:\/)?$/);
    return shortMatch?.[1] ?? u.searchParams.get('v') ?? null;
  } catch {
    return null;
  }
}

async function httpFetch(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // WEB EGRESS GUARD: DNS-validated + pinned connection, redirects revalidated per hop, bounded body.
    const res = await safeFetch(url, {
      signal: controller.signal,
      timeoutMs,
      maxBytes: 8 * 1024 * 1024,
      purpose: 'deep-capture',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, finalUrl: res.url });
    return { html: await res.text(), status: res.status, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

// ── Playwright fallback ───────────────────────────────────────────────────────

// Pre-set consent cookies for sites that use headless bot detection after the
// consent click (the reload returns an empty body). Injected before navigation
// so the consent wall never appears.
const CONSENT_COOKIES = {
  'msn.com': [
    {
      name: 'eupubconsent-v2',
      value: 'CQj44sAQj44sAHjABBFRCQFgAAAAAAAAACiQAAAAAAAA.IL8tR_G__bXlv-bb36ftkeYxf9_hr7sQxBgbJs24FzLvW7JwX32E7NEzatqYKmRIAu3TBIQNtHJjURUChKIgVrzDsaEyU4TtKJ-BkiHMZY2tYCFxvm4tjWQCZ4vr_91d9mT-t7dr-2dzy27hnv3a9_-S1UJidKYetHfv8ZBKT-_IU9_x-_4v4_MbpE2-eS1v_tWvt43d-4vP_dpuxt-Tyff7____73_e7X__c__33___Xf_7__-__________f____gA.YAAAAAAAAAAA',
      domain: '.msn.com', path: '/', secure: true, sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180,
    },
    {
      name: 'OptanonConsent',
      value: 'isGpcEnabled=1&datestamp=Fri+May+08+2026+14%3A58%3A21+GMT%2B0200&version=202501.2.0&browserGpcFlag=1&isIABGlobal=false&hosts=&landingPath=NotLandingPage&groups=C0001%3A1%2CC0003%3A0%2CC0002%3A0%2CC0004%3A0',
      domain: '.msn.com', path: '/', secure: true, sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180,
    },
    {
      name: 'OptanonAlertBoxClosed',
      value: new Date().toISOString(),
      domain: '.msn.com', path: '/', secure: true, sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180,
    },
  ],
};

function getConsentCookies(hostname) {
  for (const [domain, cookies] of Object.entries(CONSENT_COOKIES)) {
    if (hostname === domain || hostname.endsWith('.' + domain)) return cookies;
  }
  return null;
}

// Common consent/cookie button selectors (EU GDPR popups, ordered by specificity).
// Using id-based selectors first — they're immune to apostrophe encoding issues.
const CONSENT_SELECTORS = [
  // MSN / Microsoft CMP
  'button#cmp-accept-btn-handler',
  'button#cmp-reject-all-handler',  // reject also dismisses the wall
  // Generic id patterns
  'button#acceptButton',
  'button[id="accept-all"]',
  // Sourcepoint CMP "Accept all" button
  '.sp_choice_type_11',
  // Didomi CMP
  '#didomi-notice-agree-button',
  '.didomi-continue-without-agreeing',
  // Onetrust CMP
  'button#onetrust-accept-btn-handler',
  // Text-based fallbacks (Playwright normalises whitespace; apostrophe variant handled by substring)
  'button:has-text("Tout accepter")',
  'button:has-text("Accept all")',
  'button:has-text("Accepter tout")',
  'button:has-text("Accepter")',
  'button:has-text("accepte")',   // matches both "J'accepte" and "J’accepte"
  'button:has-text("I Accept")',
  'button:has-text("Agree")',
  // Attribute patterns
  '[data-testid*="accept" i]',
  '[class*="accept-all" i]',
];

async function dismissConsent(page) {
  for (const sel of CONSENT_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 600 })) {
        await btn.click();
        // Wait for the overlay to disappear and real content to settle
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
        return true;
      }
    } catch { /* not found — try next */ }
  }
  return false;
}

// Recursive Shadow DOM text extractor (runs inside page.evaluate).
// MSN and other Web Component sites render content inside open shadow roots
// that are invisible to document.body.innerText.
const SHADOW_TEXT_FN = `
function getShadowText(root, depth) {
  if (depth > 20) return '';
  let text = '';
  for (const node of root.childNodes) {
    if (node.nodeType === 3) { // TEXT_NODE
      text += node.textContent;
    } else if (node.nodeType === 1) { // ELEMENT_NODE
      const tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' ||
          tag === 'nav' || tag === 'header' || tag === 'footer') continue;
      if (node.shadowRoot) text += getShadowText(node.shadowRoot, depth + 1);
      text += getShadowText(node, depth + 1);
    }
  }
  return text;
}`;

const ARTICLE_READY_FN = `
(() => {
  const wordCount = value => String(value || '').trim().split(/\\s+/).filter(Boolean).length;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const value = JSON.parse(script.textContent || 'null');
      const queue = Array.isArray(value) ? [...value] : [value];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
        if (wordCount(item.articleBody) >= 80) return true;
      }
    } catch {}
  }
  for (const selector of ['[itemprop="articleBody"]', 'article', '[role="article"]', '.article-body', '.article-content', 'main']) {
    for (const element of document.querySelectorAll(selector)) {
      if (wordCount(element.innerText || element.textContent) >= 90) return true;
    }
  }
  return false;
})()`;

// Tries Readability first; falls back to innerText, then Shadow DOM traversal.
// This handles SPAs (body.innerText works) and Web Component sites like MSN
// (body.innerText is empty but shadow DOM has the content).
async function extractFromPage(page, url) {
  // Capture rendered HTML once — reused for both text extraction and image extraction.
  // page.content() returns the live DOM after JS execution, including any JS-injected
  // data-src attributes, which is better than the initial static HTML for lazy-loaded images.
  const html = await page.content();

  const inspected = extractArticleCandidatesFromHtml(html, url);
  const candidates = inspected.candidates.map(candidate => ({ ...candidate, source: `playwright-${candidate.source}` }));
  if (inspected.best?.quality.complete) {
    const best = selectBestArticleCandidate(candidates);
    return { ...best, renderedChars: html.length, candidates };
  }

  // 2. Live DOM — standard innerText + shadow DOM fallback (for SPAs / MSN)
  const result = await page.evaluate(new Function(`
    ${SHADOW_TEXT_FN}
    // Standard selectors first
    const candidates = ['article', 'main article', '[role="main"]', 'main'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const t = (el.innerText || getShadowText(el, 0)).trim();
        if (t.split(/\\s+/).length > 40) return { text: t, title: document.title, paragraphs: el.querySelectorAll('p').length };
      }
    }
    // Full body — standard innerText
    const bodyText = document.body.innerText.trim();
    if (bodyText.split(/\\s+/).length > 40) return { text: bodyText, title: document.title, paragraphs: document.body.querySelectorAll('p').length };
    // Shadow DOM fallback (Web Components / MSN)
    const shadowText = getShadowText(document.body, 0).replace(/\\s+/g, ' ').trim();
    if (shadowText.split(/\\s+/).length > 40) return { text: shadowText, title: document.title, paragraphs: 0 };
    return null;
  `)).catch(() => null);

  if (!result) return inspected.best ? { ...selectBestArticleCandidate(candidates), renderedChars: html.length, candidates } : null;

  const text = result.text.replace(/\s+/g, ' ').trim();
  if (isVideoPlayerGarbage(text)) {
    return { videoGarbage: true, title: result.title };
  }

  // Reuse the rendered HTML for image extraction (same page, same attributes)
  const imageUrls = extractImagesFromHtml(html, url);
  const live = articleCandidate('playwright-dom', result.title, text, imageUrls, { paragraphCount: result.paragraphs });
  if (live) candidates.push(live);
  const best = selectBestArticleCandidate(candidates);
  return best ? { ...best, renderedChars: html.length, candidates } : null;
}

export async function extractWithPlaywright(url) {
  const browser  = await getBrowser();
  const hostname = new URL(url).hostname.toLowerCase();
  const ctx      = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:    'fr-FR',
    extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' },
  });

  // Hide headless indicators — helps with bot-detection on many sites
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en'] });
    globalThis.chrome = { runtime: {} };
  });

  // Pre-inject consent cookies for known bot-detecting sites to bypass the
  // consent wall before the page loads (avoids the empty-body reload issue).
  const consentCookies = getConsentCookies(hostname);
  if (consentCookies) await ctx.addCookies(consentCookies);

  // WEB EGRESS GUARD: early static filter (schemes / ports / literal addresses / local names). The network boundary itself is
  // the egress proxy the browser was launched with (redirect hops and DNS are handled there).
  await installBrowserEgressGuard(ctx, { resolve: false });

  const page = await ctx.newPage();
  try {
    // domcontentloaded fires as soon as the HTML is parsed (~1-4s), regardless of
    // how many tracker/analytics sub-resources are still loading. This avoids the
    // 15+ second timeout that 'load' causes on MSN (persistent beacon streams keep
    // the load event from ever firing). The networkidle race below compensates for
    // JS-heavy SPAs that need a bit more time to inject their content.
    const navigationStarted = performance.now();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PW_TIMEOUT });
    const navigationMs = Math.round(performance.now() - navigationStarted);

    // After DOMContentLoaded, give JS time to inject article content.
    // Fast/simple sites: networkidle fires in ~1-2 s and we proceed immediately.
    // Tracker-heavy sites (MSN, news portals): networkidle never fires, so we
    // proceed after the 3 s cap and let the shadow DOM extractor do its work.
    const waitStarted = performance.now();
    await Promise.race([
      page.waitForFunction(ARTICLE_READY_FN, { timeout: 8_000 }),
      page.waitForLoadState('networkidle', { timeout: 8_000 }),
    ]).catch(() => {});
    const waitMs = Math.round(performance.now() - waitStarted);

    // Dismiss consent wall BEFORE extracting — prevents shadow DOM returning
    // consent banner text as article content (MSN renders consent UI in shadow DOM).
    const dismissed = await dismissConsent(page);
    if (dismissed) {
      await page.waitForFunction(
        new Function(
          `${SHADOW_TEXT_FN}\n` +
          'const b=document.body.innerText.trim();' +
          'if(b.split(/\\s+/).length>300)return true;' +
          'return getShadowText(document.body,0).replace(/\\s+/g," ").trim().split(/\\s+/).length>300;'
        ),
        { timeout: 10_000 },
      ).catch(() => {});
    }

    const extractionStarted = performance.now();
    const finalUrl = page.url() || url;
    const extracted = await extractFromPage(page, finalUrl);
    const extractionMs = Math.round(performance.now() - extractionStarted);

    if (extracted?.videoGarbage) return { videoGarbage: true, title: extracted.title, navigationMs, waitMs, extractionMs, status: response?.status(), finalUrl };

    if (!extracted) {
      // Probe word count before closing the page — distinguishes expired articles
      // (shell with <80 words of navigation chrome) from genuine extraction failures.
      const wc = await page.evaluate(new Function(
        `${SHADOW_TEXT_FN}\nreturn getShadowText(document.body,0).replace(/\\s+/g,' ').trim().split(/\\s+/).filter(Boolean).length;`,
      )).catch(() => 0);
      if ([404, 410].includes(response?.status())) return { expired: true, navigationMs, waitMs, extractionMs, status: response.status(), finalUrl };
      return { noContent: true, observedWords: wc, navigationMs, waitMs, extractionMs, status: response?.status(), finalUrl };
    }

    return { ...extracted, navigationMs, waitMs, extractionMs, status: response?.status(), finalUrl };
  } catch {
    return null;
  } finally {
    await ctx.close().catch(() => {});
    resetIdleTimer();
  }
}

// ── YouTube ───────────────────────────────────────────────────────────────────

async function extractYouTube(url) {
  let title = '';
  let channel = '';
  try {
    const res = await safeFetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(8_000), maxBytes: 256 * 1024, purpose: 'oembed' },
    );
    if (res.ok) {
      const data = await res.json();
      title   = String(data?.title       ?? '').trim();
      channel = String(data?.author_name ?? '').trim();
    }
  } catch { /* ignore */ }

  const videoId = getYouTubeVideoId(url);
  if (!videoId) {
    return { fallback: true, reason: 'no_transcript', title, channel, source_type: 'youtube' };
  }

  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    if (!Array.isArray(segments) || segments.length === 0) {
      const video_duration = await getVideoDuration(url).catch(() => null);
      return { fallback: true, reason: 'no_transcript', needs_whisper: true, video_duration, title, channel, source_type: 'youtube' };
    }
    const raw        = segments.map(s => String(s.text ?? '')).join(' ').replace(/\s+/g, ' ').trim();
    const word_count = countWords(raw);
    const { text, truncated } = truncateForModel(raw);
    return { fallback: false, text, title, channel, source_type: 'youtube', word_count, truncated };
  } catch {
    const video_duration = await getVideoDuration(url).catch(() => null);
    return { fallback: true, reason: 'no_transcript', needs_whisper: true, video_duration, title, channel, source_type: 'youtube' };
  }
}

// ── Article (fetch → Readability → Playwright fallback) ───────────────────────

async function extractArticle(url) {
  const extractionStarted = performance.now();
  let fetchMs = 0;
  let readabilityMs = 0;
  let playwrightMs = 0;
  let fetchStatus = null;
  let finalUrl = url;
  let rawChars = 0;
  let staticInspection = null;
  let playwright = null;

  // Step 1: fast fetch, then evaluate every static candidate instead of
  // letting the first extractor win regardless of quality.
  const fetchStarted = performance.now();
  try {
    const fetched = await httpFetch(url);
    fetchStatus = fetched.status;
    finalUrl = fetched.finalUrl;
    rawChars = fetched.html.length;
    const readabilityStarted = performance.now();
    staticInspection = extractArticleCandidatesFromHtml(fetched.html, finalUrl);
    readabilityMs = Math.round(performance.now() - readabilityStarted);
  } catch (error) {
    fetchStatus = error?.status ?? null;
    finalUrl = error?.finalUrl ?? url;
  }
  finally { fetchMs = Math.round(performance.now() - fetchStarted); }

  let chosen = staticInspection?.best?.quality.complete ? staticInspection.best : null;

  // Step 2: render only when the static candidates fail the quality gate.
  if (!chosen) {
    const playwrightStarted = performance.now();
    try {
      playwright = await extractWithPlaywright(url);
    } catch { /* Playwright error → fallback below */ }
    finally { playwrightMs = Math.round(performance.now() - playwrightStarted); }
    if (playwright && !playwright.videoGarbage && !playwright.expired && !playwright.noContent) {
      chosen = playwright.quality?.complete ? playwright : null;
    }
  }

  const staticCandidates = staticInspection?.candidates ?? [];
  const renderedCandidates = playwright?.candidates ?? (playwright?.quality ? [playwright] : []);
  const bestObserved = selectBestArticleCandidate([...staticCandidates, ...renderedCandidates]);
  const readability = metricFor(staticCandidates, 'readability');
  const structured = metricFor(staticCandidates, 'json-ld');
  const semantic = metricFor(staticCandidates, 'semantic-dom');
  const playwrightBest = selectBestArticleCandidate(renderedCandidates);
  const extraction = {
    httpStatus: fetchStatus,
    finalUrl,
    rawChars,
    renderedChars: playwright?.renderedChars ?? 0,
    readabilityChars: readability.chars,
    readabilityWords: readability.words,
    structuredChars: structured.chars,
    structuredWords: structured.words,
    semanticChars: semantic.chars,
    semanticWords: semantic.words,
    playwrightChars: playwrightBest?.quality.chars ?? 0,
    playwrightWords: playwrightBest?.quality.words ?? 0,
    finalChars: (chosen ?? bestObserved)?.quality.chars ?? 0,
    finalWords: (chosen ?? bestObserved)?.quality.words ?? 0,
    finalParagraphs: (chosen ?? bestObserved)?.quality.paragraphs ?? 0,
    chosenExtractor: chosen?.source ?? null,
    fallbackReason: null,
    qualityStatus: chosen ? 'COMPLETE' : (bestObserved ? 'PARTIAL_EXTRACTION' : 'NO_CONTENT'),
    navigationMs: playwright?.navigationMs ?? 0,
    waitMs: playwright?.waitMs ?? 0,
    playwrightExtractionMs: playwright?.extractionMs ?? 0,
  };
  const timings = { fetchMs, readabilityMs, playwrightMs, extractionMs: Math.round(performance.now() - extractionStarted) };

  if (playwright?.videoGarbage) {
    extraction.fallbackReason = 'video_content';
    return { fallback: true, reason: 'video_content', source_type: 'web', extraction, timings };
  }
  if (playwright?.expired) {
    extraction.fallbackReason = 'article_expired';
    return { fallback: true, reason: 'article_expired', source_type: 'web', extraction, timings };
  }
  if (!chosen) {
    const reason = bestObserved ? 'partial_extraction' : 'extraction_failed';
    extraction.fallbackReason = reason;
    return {
      fallback: true,
      reason,
      source_type: 'web',
      title: bestObserved?.title ?? '',
      imageUrls: bestObserved?.imageUrls ?? [],
      partial: bestObserved ? {
        title: bestObserved.title,
        text: bestObserved.text,
        word_count: bestObserved.quality.words,
        imageUrls: bestObserved.imageUrls,
      } : null,
      extraction,
      timings,
    };
  }

  const word_count = chosen.quality.words;
  const { text, truncated } = truncateForModel(chosen.text);
  return {
    fallback: false, text, title: chosen.title, source_type: 'web', word_count, truncated,
    imageUrls: chosen.imageUrls ?? [],
    extraction,
    timings,
  };
}

// ── Public ────────────────────────────────────────────────────────────────────

export async function extractContent(url) {
  const started = performance.now();
  try {
    assertSafeUrl(url);  // SSRF guard — rejects internal addresses
    const u    = new URL(url);
    const host = u.hostname.toLowerCase();
    const result = host.includes('youtube.com') || host === 'youtu.be'
      ? await extractYouTube(url)
      : await extractArticle(url);
    result.timings = { ...(result.timings ?? {}), extractionMs: Math.round(performance.now() - started) };
    return result;
  } catch (err) {
    return {
      fallback: true, reason: 'invalid_url', error: String(err?.message ?? err),
      timings: { extractionMs: Math.round(performance.now() - started) },
    };
  }
}
