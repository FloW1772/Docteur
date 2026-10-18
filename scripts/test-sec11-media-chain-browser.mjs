// SEC-REMED-2 / SEC-11 — the REAL product chain, end to end, with the SEC-11 payload:
//   Markdown link in a neuron (real src/App.tsx, renderMd) → "open in Docteur" (MediaOpenButton) → Media Reader web card
//   → "Ouvrir dans le navigateur" (client.openInBrowser) → POST /api/browser/open
//   → REAL cortex-server route (routes/browser.js) → REAL lib/browser.js (real registry resolution) → spawn
// The only substitution is at the very last step: spawn is a recorder, so no browser starts and the .test hosts are never
// resolved (the real-launch proof on 127.0.0.1:9 is test-sec11-browser-open.mjs, opt-in). Every other /api/** is mocked by
// the audit harness, external requests are aborted, temp DB only.
// Usage: node scripts/test-sec11-media-chain-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, openApp, until } from './audit-queue-lib.mjs';
import { initSqlite } from '../cortex-server/src/lib/sqlite.js';
import { assertOpenableUrl, resolveDefaultBrowserExecutable, setBrowserSettings, SAFE_BROWSER_OPEN_UNAVAILABLE } from '../cortex-server/src/lib/browser.js';
import { createBrowserRoute } from '../cortex-server/src/routes/browser.js';

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const DISPATCHERS = /^(cmd|explorer|rundll32|powershell|pwsh|mshta|wscript|cscript|conhost)\.exe$/i;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-sec11-chain-'));
initSqlite(path.join(dir, 'settings.db'));
setBrowserSettings({ selected: 'system', customPath: null });
const launched = [];
const backend = createBrowserRoute({ // the route's own Hono app (mounted under /api by server.js)
  spawnImpl: (command, args, options) => { launched.push({ command, args: [...args], options: { ...options } }); return { unref() {} }; },
});
let expectedExe = null;
try { expectedExe = resolveDefaultBrowserExecutable('https'); } catch (e) { if (e.code !== SAFE_BROWSER_OPEN_UNAVAILABLE) throw e; }

// SEC-11 payloads as they would appear in a note, a captured page or model output
const L = {
  markdown: String.raw`https://docs.sec11-test.example/guide?a,/root,C:\TEMP\sec11-marker.cmd`, // [text](url): commas + backslashes kept
  bare: 'https://wiki.sec11-test.example/page?a,/select,C:/TEMP/sec11-marker.cmd',           // bare link (no backslash in that regex)
  captured: String.raw`https://news.sec11-test.example/article?a,/root,C:\TEMP\sec11-marker.cmd`, // a captured article's source URL
};
const now = Date.now();
const notePage = {
  id: 'sec11-note', title: 'SEC-11 note', kind: 'note', createdAt: now - 1000, updatedAt: now, links: [], metadata: {},
  blocks: [
    { id: 'b1', type: 'paragraph', content: `Voir [Documentation SEC11](${L.markdown}) pour les détails.` },
    { id: 'b2', type: 'paragraph', content: `Lien brut ${L.bare}` },
    { id: 'b3', type: 'paragraph', content: `Article [Article SEC11](${L.captured})` },
  ],
};
const articlePage = {
  id: 'sec11-article', title: 'Article capturé SEC-11', kind: 'reference', createdAt: now - 5000, updatedAt: now - 5000, links: [],
  metadata: { url: L.captured }, blocks: [{ id: 'a1', type: 'paragraph', content: 'Corps de l’article capturé (fixture).' }],
};
const seedPages = [notePage, articlePage];
const posted = [];

async function apiRoutes({ route, p, m, body, json }) {
  if (p === '/api/agents/pending-outputs') { await json(route, []); return true; }
  if (p.startsWith('/api/neuron/') && m === 'GET') { const pg = seedPages.find(x => x.id === decodeURIComponent(p.split('/').pop())); await json(route, pg ? { page: pg } : { error: 'nf' }, pg ? 200 : 404); return true; }
  if (p === '/api/browser/open' && m === 'POST') {
    // forwarded byte-for-byte to the REAL backend route
    posted.push(body()?.url);
    const res = await backend.request('/browser/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() ?? '' });
    await json(route, await res.json(), res.status);
    return true;
  }
  return false;
}

const h = await startHarness({ port: 5241 });
try {
  const app = await openApp(h, { seedPages, extra: apiRoutes, indexMs: 30 });
  const { page, net } = app;
  await page.locator('.sidebar-item[data-neuron-id="sec11-note"]').first().dispatchEvent('click');
  const reader = page.locator('[data-testid="media-reader"]');

  for (const [label, kind, url] of [['Documentation SEC11', 'markdown', L.markdown], [L.bare, 'bare', L.bare], ['Article SEC11', 'captured', L.captured]]) {
    const anchor = page.locator('a', { hasText: label }).first();
    await anchor.waitFor({ timeout: 15_000 });
    eq(await anchor.getAttribute('href'), url, `${kind}: the rendered link keeps the payload intact (commas, backslashes)`);
    await anchor.locator('xpath=following-sibling::button[@data-testid="open-in-docteur"]').first().click();
    await reader.waitFor({ timeout: 5_000 });
    if (kind === 'captured') {
      check(await until(async () => (await page.locator('[data-testid="media-reader-web-captured"]').count()) > 0, 8_000), 'captured page shown from Docteur');
    }
    const before = launched.length;
    await page.locator('[data-testid="media-reader-open-browser"]').click();
    check(await until(() => posted.length > 0 && posted.at(-1) === url, 5_000), `${kind}: POST /api/browser/open carries the payload`);
    const status = page.locator('[data-testid="media-reader-browser-status"]');
    if (expectedExe) {
      check(await until(() => launched.length === before + 1, 5_000), `${kind}: exactly one launch`);
      const c = launched.at(-1);
      eq(c.command, expectedExe, `${kind}: the default browser's own executable`);
      check(!DISPATCHERS.test(path.win32.basename(c.command)), `${kind}: not a dispatcher (${c.command})`);
      assert.deepEqual(c.args, [assertOpenableUrl(url)]); assertions += 1;
      eq(c.options.shell, false, `${kind}: shell:false`);
      check(await until(async () => /Ouvert dans le navigateur/.test(await status.innerText()), 3_000), `${kind}: status shown`);
    } else {
      check(await until(async () => /SAFE_BROWSER_OPEN_UNAVAILABLE/.test(await status.innerText()), 3_000), `${kind}: explicit fail-closed message`);
      eq(launched.length, before, `${kind}: 0 process`);
    }
    await page.locator('[data-testid="media-reader-close"]').click();
    await until(async () => (await reader.count()) === 0, 3_000, 50);
  }
  eq(launched.filter(c => DISPATCHERS.test(path.win32.basename(c.command))).length, 0, 'no dispatcher ever launched');
  eq(net.errors.length, 0, `no page error: ${net.errors.join(' | ')}`);
  const network = net.external.filter(u => /^https?:/.test(u) && !u.startsWith('https://fonts.'));
  eq(network.length, 0, `nothing left the machine: ${network.join(', ')}`);
  await app.ctx.close();
  console.log(`SEC-11 MEDIA CHAIN BROWSER: PASS (${assertions} assertions; ${launched.length} launches → ${expectedExe ? path.win32.basename(expectedExe) : 'fail-closed'})`);
} finally {
  await h.browser.close().catch(() => {});
  await h.server.close().catch(() => {});
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp DB still open on Windows: best-effort */ }
}
