// Simulate the exact extractWithPlaywright flow on a live MSN article
import { chromium } from 'playwright';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const SHADOW_TEXT_FN = String.raw`
function getShadowText(root, depth) {
  if (depth > 20) return '';
  let text = '';
  for (const node of root.childNodes) {
    if (node.nodeType === 3) {
      text += node.textContent;
    } else if (node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' ||
          tag === 'nav' || tag === 'header' || tag === 'footer') continue;
      if (node.shadowRoot) text += getShadowText(node.shadowRoot, depth + 1);
      text += getShadowText(node, depth + 1);
    }
  }
  return text;
}`;

const CONSENT_SELECTORS = [
  'button#cmp-accept-btn-handler',
  'button#cmp-reject-all-handler',
  'button#acceptButton',
  '#didomi-notice-agree-button',
  'button#onetrust-accept-btn-handler',
];

async function extractFromPage(page, url) {
  // 1. Readability on static HTML
  const html = await page.content();
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const words = article?.textContent?.split(/\s+/).filter(Boolean).length ?? 0;
    if (words >= 200) {
      console.log(`  Readability: ${words} words ✓`);
      return { title: article.title, text: article.textContent };
    }
    console.log(`  Readability: ${words} words (too short)`);
  } catch(e) { console.log('  Readability error:', e.message); }

  // 2. Live DOM + shadow DOM
  const result = await page.evaluate(new Function(String.raw`
    ${SHADOW_TEXT_FN}
    const candidates = ['article', 'main article', '[role="main"]', 'main'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const t = (el.innerText || getShadowText(el, 0)).trim();
        if (t.split(/\s+/).length > 200) return { text: t, title: document.title };
      }
    }
    const bodyText = document.body.innerText.trim();
    if (bodyText.split(/\s+/).length > 200) return { text: bodyText, title: document.title };
    const shadowText = getShadowText(document.body, 0).replace(/\s+/g, ' ').trim();
    if (shadowText.split(/\s+/).length > 200) return { text: shadowText, title: document.title };
    return null;
  `)).catch(() => null);

  if (!result) return null;
  return { title: result.title, text: result.text.replace(/\s+/g, ' ').trim() };
}

async function dismissConsent(page) {
  for (const sel of CONSENT_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 600 })) {
        await btn.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        console.log('  Consent dismissed via:', sel);
        return true;
      }
    } catch {}
  }
  return false;
}

// --- Main test ---
const url = 'https://www.msn.com/fr-fr/actualite/france/avant-d-%C3%AAtre-condamn%C3%A9e-marine-le-pen-r%C3%A9clamait-l-in%C3%A9ligibilit%C3%A9-%C3%A0-vie-pour-les-%C3%A9lus-reconnus-coupables/ar-AA27oWyi';

console.log('=== Full extractWithPlaywright simulation (fresh context) ===');
console.log('URL:', url.split('/ar-')[0].split('/').pop(), '...');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'fr-FR',
  extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' },
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR','fr','en'] });
  globalThis.chrome = { runtime: {} };
});

const page = await ctx.newPage();
console.log('\n[1] Navigating...');
await page.goto(url, { waitUntil: 'load', timeout: 25000 });
await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

console.log('\n[2] First extractFromPage attempt...');
let parsed = await extractFromPage(page, url);

if (!parsed) {
  console.log('\n[3] No content — trying dismissConsent...');
  const dismissed = await dismissConsent(page);

  if (dismissed) {
    console.log('\n[4] Waiting for content (shadow DOM aware)...');
    await page.waitForFunction(new Function(String.raw`
      ${SHADOW_TEXT_FN}
      const body = document.body.innerText.trim();
      if (body.split(/\s+/).length > 300) return true;
      return getShadowText(document.body, 0).replace(/\s+/g,' ').trim().split(/\s+/).length > 300;
    `), { timeout: 10000 }).catch(() => console.log('  waitForFunction timed out'));

    const shadowNow = await page.evaluate(new Function(String.raw`
      ${SHADOW_TEXT_FN}
      return getShadowText(document.body, 0).replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    `)).catch(() => 0);
    console.log('  shadow DOM words after wait:', shadowNow);

    console.log('\n[5] Second extractFromPage attempt...');
    parsed = await extractFromPage(page, url);
  }
}

if (parsed) {
  const words = parsed.text.split(/\s+/).filter(Boolean).length;
  console.log('\n✅ SUCCESS');
  console.log('Title:', parsed.title);
  console.log('Words:', words);
  console.log('Preview:', parsed.text.slice(0, 400));
} else {
  console.log('\n❌ FAILED — fallback capture simple would be used');
}

await browser.close();
process.exit(0);
