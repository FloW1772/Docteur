// [KWX-2] Kiwix article loading in the REAL library modal (Chromium), with a deterministic fake clock:
//   A  a small article loads normally (loading line shown, then the article)
//   B  an article answered after the OLD 15 s limit (here: +20 s) still renders within the dedicated 30 s content budget
//   C  search keeps its own 15 s limit (a search held past 15 s is abandoned)
//   D  status / settings / search / runtime budgets are unchanged in the source
//   E  an article held past 30 s ends with the clear French timeout message — nothing else is claimed
//   F  a slow earlier article never replaces a newer one, nor lands on a new search
//   G  the page only ever talks to the loopback API (every other request is aborted and counted)
//   H  [KWX-3] an article refused by the backend size budget (413 KIWIX_ARTICLE_TOO_LARGE) shows the typed French oversize
//      message — no partial article, not the timeout message — and I. the next article still opens normally
// /api/kiwix/* is answered in-process by stubs; no real Docteur, kiwix-serve or Internet is involved. No real 20 s wait.
// Usage: node scripts/test-kiwix-article-timeout-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let assertions = 0; const results = [];
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const PORT = 5276;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const API = 'http://127.0.0.1:3001';
const BOOK = 'book_a';
const TIMEOUT_TEXT = 'Le chargement de cet article a dépassé le délai prévu.';
const TOO_LARGE_TEXT = 'Cet article est trop volumineux pour être affiché en toute sécurité.';

// ── source contract (D): only the article budget changed ──
const client = fs.readFileSync('src/lib/cortex/client.ts', 'utf8');
const body = (name) => client.slice(client.indexOf(`async ${name}(`), client.indexOf('\n  },', client.indexOf(`async ${name}(`)));
const runtimeHttp = fs.readFileSync('src/lib/runtime/http-port.ts', 'utf8');

// ── stubs ──
const held = new Map(); // path → { release(json), hits }
const seen = []; let externalAborted = 0;
const hold = (path) => { let release; const p = new Promise((r) => { release = r; }); held.set(path, { promise: p, release, hits: 0 }); };
const article = (path) => ({ html: `<h2>${path}</h2><p>Contenu de ${path}.</p>`, title: path, text: `Contenu de ${path}.`, book: BOOK, path });
let searchHeld = null;
const fulfillJson = (route, value) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': ORIGIN }, body: JSON.stringify(value) });

const HARNESS_HTML = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/kiwix-article-harness.jsx");mount();</script>';
const harnessPage = { name: 'kwx2-harness-page', configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url === '/__kwx2') { res.setHeader('content-type', 'text/html'); res.end(HARNESS_HTML); } else next(); }); } };
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-kwx2', plugins: [react(), harnessPage], optimizeDeps: { entries: ['scripts/kiwix-article-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });

async function scenario(name, fn) {
  const t = Date.now();
  try { await fn(); } catch (e) { console.error(`✖ ${name}`); throw e; }
  results.push(`✔ ${name} (${Date.now() - t} ms)`);
}

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install();
  await page.route((url) => url.origin !== ORIGIN, async (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== API) { externalAborted += 1; return route.abort(); }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'GET,POST,PUT', 'access-control-allow-headers': 'content-type' } });
    seen.push(u.pathname + u.search);
    if (u.pathname === '/api/kiwix/settings') return fulfillJson(route, { kiwixServePath: 'C:/K', archivesFolder: 'C:/Z', port: 8090, autoDetect: true, binaryFound: true, kiwixToolsUrl: '' });
    if (u.pathname === '/api/kiwix/status') return fulfillJson(route, { running: true, port: 8090, archives: [], lastError: null, pid: 4242 });
    if (u.pathname === '/api/kiwix/archives') return fulfillJson(route, { folder: 'C:/Z', archives: [{ name: BOOK, fileName: 'a.zim', path: 'C:/Z/a.zim', sizeBytes: 1 }], totalBytes: 1 });
    if (u.pathname === '/api/kiwix/search-scope') return fulfillJson(route, { scope: 'neurones' });
    if (u.pathname === '/api/kiwix/search') {
      const value = { results: ['Petit', 'Grand', 'Bloque', 'Lent', 'Rapide', 'Orphelin', 'Enorme'].map(t => ({ title: t, path: t, snippet: `extrait ${t}`, bookName: BOOK })) };
      if (searchHeld) { await searchHeld.promise.catch(() => {}); return fulfillJson(route, value).catch(() => {}); }
      return fulfillJson(route, value);
    }
    const m = /^\/api\/kiwix\/content\/book_a\/(.+)$/.exec(u.pathname);
    if (m?.[1] === 'Enorme') return route.fulfill({ status: 413, contentType: 'application/json', headers: { 'access-control-allow-origin': ORIGIN }, body: JSON.stringify({ error: 'KIWIX_ARTICLE_TOO_LARGE' }) }); // [KWX-3] the backend's exact refusal
    if (m) {
      const h = held.get(m[1]);
      if (h) { h.hits += 1; await h.promise; return fulfillJson(route, article(m[1])).catch(() => {}); } // aborted client side ⇒ fulfill fails: fine
      return fulfillJson(route, article(m[1]));
    }
    return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': ORIGIN }, body: '{}' });
  });
  await page.goto(`${ORIGIN}/__kwx2`);
  await page.getByPlaceholder('Rechercher un article…').waitFor();
  const search = async () => { await page.getByPlaceholder('Rechercher un article…').fill('Pikachu'); await page.getByTitle('Rechercher', { exact: true }).click(); await page.getByRole('button', { name: /^Petit/ }).waitFor(); };
  const openResult = (t) => page.getByRole('button', { name: new RegExp(`^${t}\\b`) }).click();
  const heading = () => page.locator('h4').first().innerText().catch(() => null);
  const back = () => page.getByTitle('Retour aux résultats').click();

  await scenario('D. source budgets: article = dedicated 30 s; search 15 s, status/settings 8 s, default 90 s and runtime calls unchanged', async () => {
    ok(/KIWIX_ARTICLE_TIMEOUT_MS = 30_000;/.test(client), 'dedicated article budget');
    ok(body('kiwixArticle').includes('KIWIX_ARTICLE_TIMEOUT_MS'), 'used by the article call');
    ok(body('kiwixSearchArchives').includes(", { method: 'GET' }, 15_000)"), 'search keeps 15 s');
    ok(body('kiwixStatus').includes(", { method: 'GET' }, 8_000)"), 'status keeps 8 s');
    ok(body('kiwixSettings').includes(", { method: 'GET' }, 8_000)"), 'settings keep 8 s');
    ok(/const TIMEOUT {8}= 90_000;/.test(client), 'global default untouched');
    eq((client.match(/KIWIX_ARTICLE_TIMEOUT_MS/g) ?? []).length, 2, 'declared once, used once');
    ok(!/KIWIX_ARTICLE_TIMEOUT_MS|30_000/.test(runtimeHttp), 'runtime/health client unaffected');
  });

  await scenario('A. small article: loading line, then the article', async () => {
    await search();
    hold('Petit');
    await openResult('Petit');
    await page.getByTestId('kiwix-article-loading').waitFor();
    ok(await page.getByTestId('kiwix-article-loading').isVisible(), 'loading state visible while the article loads');
    held.get('Petit').release(); held.delete('Petit');
    await page.locator('.kiwix-article-content').waitFor();
    eq(await heading(), 'Petit');
    eq(await page.getByTestId('kiwix-article-loading').count(), 0, 'loading line gone');
    await back();
  });

  await scenario('B. an article answered after 20 s (beyond the OLD 15 s) renders within the 30 s content budget', async () => {
    hold('Grand');
    await openResult('Grand');
    await page.getByTestId('kiwix-article-loading').waitFor();
    await page.clock.fastForward(20_000);
    eq(await page.getByTestId('kiwix-article-error').count(), 0, 'not abandoned at 15 s any more');
    ok(await page.getByTestId('kiwix-article-loading').isVisible(), 'still loading, UI responsive');
    held.get('Grand').release(); held.delete('Grand');
    await page.locator('.kiwix-article-content').waitFor();
    eq(await heading(), 'Grand');
    await back();
  });

  await scenario('E. an article held past 30 s ends with the clear French timeout message (no crash / network / missing-article claim)', async () => {
    hold('Bloque');
    await openResult('Bloque');
    await page.getByTestId('kiwix-article-loading').waitFor();
    await page.clock.fastForward(31_000);
    await page.getByTestId('kiwix-article-error').waitFor();
    eq(await page.getByTestId('kiwix-article-error').innerText(), TIMEOUT_TEXT);
    eq(await page.getByTestId('kiwix-article-loading').count(), 0, 'loading ended');
    eq(await page.locator('.kiwix-article-content').count(), 0, 'no article claimed');
    held.get('Bloque').release(); held.delete('Bloque'); // the late server answer must not resurrect it
    await page.waitForTimeout(300);
    eq(await page.locator('.kiwix-article-content').count(), 0, 'a late answer after the timeout is ignored');
  });

  await scenario('F. stale responses: a slower earlier article never replaces a newer one, nor lands after a new search', async () => {
    hold('Lent');
    await openResult('Lent');
    await page.getByTestId('kiwix-article-loading').waitFor();
    await openResult('Rapide');
    await page.locator('.kiwix-article-content').waitFor();
    eq(await heading(), 'Rapide');
    held.get('Lent').release(); held.delete('Lent');
    await page.waitForTimeout(300);
    eq(await heading(), 'Rapide', 'the late « Lent » did not replace « Rapide »');
    await back();
    hold('Orphelin');
    await openResult('Orphelin');
    await page.getByTestId('kiwix-article-loading').waitFor();
    await search(); // a new search supersedes the pending article
    held.get('Orphelin').release(); held.delete('Orphelin');
    await page.waitForTimeout(300);
    eq(await page.locator('.kiwix-article-content').count(), 0, 'the pending article did not land on the new results');
    eq(await page.getByTestId('kiwix-article-loading').count(), 0);
  });

  await scenario('C. search keeps its own 15 s limit: a search held past 15 s is abandoned (results cleared, button usable again)', async () => {
    let release; searchHeld = { promise: new Promise((r) => { release = r; }) };
    await page.getByPlaceholder('Rechercher un article…').fill('Raichu');
    await page.getByTitle('Rechercher', { exact: true }).click();
    await page.clock.fastForward(16_000);
    await page.waitForFunction(() => !document.querySelector('button[title="Rechercher"]')?.disabled);
    eq(await page.getByRole('button', { name: /^Petit/ }).count(), 0, 'abandoned search shows no results');
    release(); searchHeld = null;
  });

  await scenario('H. [KWX-3] an over-budget article (413 KIWIX_ARTICLE_TOO_LARGE) shows the typed oversize message, never a partial article', async () => {
    await search(); // C left the list empty (its search was abandoned)
    eq(await page.getByRole('button', { name: /^Enorme/ }).count(), 1, 'results from the new search are listed');
    await openResult('Enorme');
    await page.getByTestId('kiwix-article-error').waitFor();
    eq(await page.getByTestId('kiwix-article-error').innerText(), TOO_LARGE_TEXT);
    ok((await page.getByTestId('kiwix-article-error').innerText()) !== TIMEOUT_TEXT, 'not mistaken for a timeout');
    eq(await page.locator('.kiwix-article-content').count(), 0, 'no article (partial or otherwise) rendered');
    eq(await page.getByTestId('kiwix-article-loading').count(), 0, 'loading ended');
    ok(!(await page.locator('body').innerText()).includes('KIWIX_ARTICLE_TOO_LARGE'), 'the raw code is never shown');
  });

  await scenario('I. [KWX-3] after an oversize refusal the next article opens normally (UI recovered, error cleared)', async () => {
    await openResult('Petit');
    await page.locator('.kiwix-article-content').waitFor();
    eq(await heading(), 'Petit');
    eq(await page.getByTestId('kiwix-article-error').count(), 0, 'the oversize message is cleared');
    await back();
  });

  await scenario('G. loopback only: no request left the page for anything but the local API', async () => {
    eq(externalAborted, 0, 'no external request');
    ok(seen.every(p => p.startsWith('/api/kiwix/')), `only Kiwix API calls: ${[...new Set(seen.map(p => p.split('?')[0].split('/').slice(0, 4).join('/')))].join(', ')}`);
  });
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
for (const r of results) console.log(r);
console.log(`KIWIX ARTICLE TIMEOUT BROWSER: ${results.length} scenarios, ${assertions} assertions — PASS`);
