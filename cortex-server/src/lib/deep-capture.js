import { YoutubeTranscript } from 'youtube-transcript';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright';
import { assertSafeUrl } from './url-security.js';
import { getVideoDuration } from './whisper.js';

const MAX_WORDS      = 8_000;
const FETCH_TIMEOUT  = 15_000;
const PW_TIMEOUT     = 25_000;  // per-page Playwright timeout (raised: domcontentloaded fires fast but some sites are slow to serve HTML)
const PW_IDLE_MS     = 5 * 60 * 1000; // close browser after 5 min inactivity
const MIN_WORDS_FAST = 200;     // below this threshold → try Playwright

// ── Browser pool (single reusable instance) ───────────────────────────────────

let _browser    = null;
let _idleTimer  = null;

async function getBrowser() {
  if (_browser) {
    resetIdleTimer();
    return _browser;
  }
  _browser = await chromium.launch({ headless: true });
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
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

function parseReadability(html, url) {
  try {
    // Extract images from raw HTML BEFORE Readability mutates the DOM —
    // Readability strips lazy-load attributes (data-src etc.) from <img> tags.
    const imageUrls = extractImagesFromHtml(html, url);

    const dom     = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.textContent || countWords(article.textContent) < MIN_WORDS_FAST) return null;
    return { title: article.title ?? '', text: article.textContent.replace(/\s+/g, ' ').trim(), imageUrls };
  } catch {
    return null;
  }
}

function getYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    return u.searchParams.get('v') ?? null;
  } catch {
    return null;
  }
}

async function httpFetch(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
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

// Tries Readability first; falls back to innerText, then Shadow DOM traversal.
// This handles SPAs (body.innerText works) and Web Component sites like MSN
// (body.innerText is empty but shadow DOM has the content).
async function extractFromPage(page, url) {
  // Capture rendered HTML once — reused for both text extraction and image extraction.
  // page.content() returns the live DOM after JS execution, including any JS-injected
  // data-src attributes, which is better than the initial static HTML for lazy-loaded images.
  const html = await page.content();

  // 1. Readability on rendered HTML (fastest, best structure); includes imageUrls
  const parsed = parseReadability(html, url);
  if (parsed) return parsed;

  // 2. Live DOM — standard innerText + shadow DOM fallback (for SPAs / MSN)
  const result = await page.evaluate(new Function(`
    ${SHADOW_TEXT_FN}
    // Standard selectors first
    const candidates = ['article', 'main article', '[role="main"]', 'main'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const t = (el.innerText || getShadowText(el, 0)).trim();
        if (t.split(/\\s+/).length > 200) return { text: t, title: document.title };
      }
    }
    // Full body — standard innerText
    const bodyText = document.body.innerText.trim();
    if (bodyText.split(/\\s+/).length > 200) return { text: bodyText, title: document.title };
    // Shadow DOM fallback (Web Components / MSN)
    const shadowText = getShadowText(document.body, 0).replace(/\\s+/g, ' ').trim();
    if (shadowText.split(/\\s+/).length > 200) return { text: shadowText, title: document.title };
    return null;
  `)).catch(() => null);

  if (!result) return null;

  const text = result.text.replace(/\s+/g, ' ').trim();
  if (isVideoPlayerGarbage(text)) {
    return { videoGarbage: true, title: result.title };
  }

  // Reuse the rendered HTML for image extraction (same page, same attributes)
  const imageUrls = extractImagesFromHtml(html, url);
  return { title: result.title, text, imageUrls };
}

async function extractWithPlaywright(url) {
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

  const page = await ctx.newPage();
  try {
    // domcontentloaded fires as soon as the HTML is parsed (~1-4s), regardless of
    // how many tracker/analytics sub-resources are still loading. This avoids the
    // 15+ second timeout that 'load' causes on MSN (persistent beacon streams keep
    // the load event from ever firing). The networkidle race below compensates for
    // JS-heavy SPAs that need a bit more time to inject their content.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PW_TIMEOUT });

    // After DOMContentLoaded, give JS time to inject article content.
    // Fast/simple sites: networkidle fires in ~1-2 s and we proceed immediately.
    // Tracker-heavy sites (MSN, news portals): networkidle never fires, so we
    // proceed after the 3 s cap and let the shadow DOM extractor do its work.
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 3_500 }),
      new Promise(resolve => setTimeout(resolve, 3_000)),
    ]).catch(() => {});

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

    const extracted = await extractFromPage(page, url);

    if (extracted?.videoGarbage) return { videoGarbage: true, title: extracted.title };

    if (!extracted) {
      // Probe word count before closing the page — distinguishes expired articles
      // (shell with <80 words of navigation chrome) from genuine extraction failures.
      const wc = await page.evaluate(new Function(
        `${SHADOW_TEXT_FN}\nreturn getShadowText(document.body,0).replace(/\\s+/g,' ').trim().split(/\\s+/).filter(Boolean).length;`,
      )).catch(() => 0);
      return wc < 80 ? { expired: true } : null;
    }

    return extracted;
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
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(8_000) },
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
  // Step 1: fast fetch + Readability
  let parsed = null;
  try {
    const html = await httpFetch(url);
    parsed = parseReadability(html, url);
  } catch { /* network error → go straight to Playwright */ }

  // Step 2: Playwright fallback when fetch fails or content too short
  if (!parsed) {
    let pw = null;
    try {
      pw = await extractWithPlaywright(url);
    } catch { /* Playwright error → fallback below */ }

    if (pw?.videoGarbage) return { fallback: true, reason: 'video_content',    source_type: 'web' };
    if (pw?.expired)      return { fallback: true, reason: 'article_expired',  source_type: 'web' };
    if (!pw)              return { fallback: true, reason: 'extraction_failed', source_type: 'web' };
    parsed = pw;
  }

  const word_count = countWords(parsed.text);
  const { text, truncated } = truncateForModel(parsed.text);
  return { fallback: false, text, title: parsed.title, source_type: 'web', word_count, truncated, imageUrls: parsed.imageUrls ?? [] };
}

// ── Public ────────────────────────────────────────────────────────────────────

export async function extractContent(url) {
  try {
    assertSafeUrl(url);  // SSRF guard — rejects internal addresses
    const u    = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return extractYouTube(url);
    return extractArticle(url);
  } catch (err) {
    return { fallback: true, reason: 'invalid_url', error: String(err?.message ?? err) };
  }
}
