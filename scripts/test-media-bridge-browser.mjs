// Browser Media Bridge V1 — REAL src/App.tsx: every link kind → recognised media → "open in Docteur" → right
// reader → reuse/import (PDF → local PDF workshop, article / YouTube → capture flow), F2 loading, failure isolation,
// resource cleanup. Fixtures generated locally (ffmpeg, pdf-lib); fake public host; the Document Toolbox route runs
// in-process. Nothing reaches the Internet, no real server, no real DB.
// Usage: node scripts/test-media-bridge-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startHarness, openApp, until, sleep } from './audit-queue-lib.mjs';
import { createDocumentToolboxRoute } from '../cortex-server/src/routes/document-toolbox.js';

const requireCs = createRequire(new URL('../cortex-server/package.json', import.meta.url));
const { PDFDocument, StandardFonts } = requireCs('pdf-lib');

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };

// ─── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-media-bridge-'));
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=2', '-c:v', 'libvpx', '-b:v', '200k', path.join(dir, 'clip.webm'));
ff('-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:a', 'libmp3lame', path.join(dir, 'tone.mp3'));
ff('-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1', path.join(dir, 'photo.png'));
const file = (n) => fs.readFileSync(path.join(dir, n));
const pdfDoc = await PDFDocument.create();
const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 2; i += 1) pdfDoc.addPage([300, 200]).drawText(`Rapport ${i}`, { x: 20, y: 100, size: 20, font });
const PDF_BYTES = Buffer.from(await pdfDoc.save());

const HOST = 'https://media.docteur-test.example';
const ARTICLE = 'https://www.example-news.test/sciences/telescope';
const LOCAL_UNKNOWN = `http://127.0.0.1:3001/api/audio-player/file?path=${encodeURIComponent('C:\\Docs\\archive.xyz')}`;
const L = {
  youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', short: 'https://www.youtube.com/shorts/aBcDeFgHiJk',
  video: `${HOST}/clip.webm`, audio: `${HOST}/tone.mp3`, image: `${HOST}/photo.png`, pdf: `${HOST}/rapport.pdf`, text: `${HOST}/notes.txt`,
  unsupported: `${HOST}/film.mkv`, missing: `${HOST}/manquante.png`, slow: `${HOST}/lent.mp4`, article: ARTICLE, web: 'https://example.org/page',
};
const now = Date.now();
const mediaPage = {
  id: 'bridge', title: 'Pont média test', kind: 'note', createdAt: now - 1000, updatedAt: now, links: [], metadata: {},
  blocks: Object.entries(L).map(([k, url], i) => ({ id: `b${i}`, type: 'paragraph', content: `${k} ${url}` }))
    .concat([{ id: 'bx', type: 'paragraph', content: `inconnu ${LOCAL_UNKNOWN}` }]),
};
// Captured by Article Canonical V1: original link with tracking, canonical URL recorded in metadata.
const articlePage = {
  id: 'article-canonical', title: 'Télescope (capturé)', kind: 'link', createdAt: now - 5000, updatedAt: now - 5000, links: [],
  metadata: { url: `${ARTICLE}?utm_source=newsletter`, canonical_article: { version: 1, canonicalUrl: ARTICLE } },
  blocks: [{ id: 'a1', type: 'paragraph', content: 'Synthèse de l’article capturé, lue sans réseau.' }],
};
const seedPages = [mediaPage, articlePage];

const toolbox = createDocumentToolboxRoute();
const slow = { release: null, aborted: 0 };
async function apiRoutes({ route, p, m, json }) {
  if (p === '/api/agents/pending-outputs') { await json(route, []); return true; }
  if (p.startsWith('/api/neuron/') && m === 'GET') { const pg = seedPages.find(x => x.id === decodeURIComponent(p.split('/').pop())); await json(route, pg ? { page: pg } : { error: 'nf' }, pg ? 200 : 404); return true; }
  if (p === '/api/audio-player/file') { await route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }, body: 'xyz' }); return true; }
  if (p.startsWith('/api/document-toolbox/')) {
    const req = route.request();
    const u = new URL(req.url());
    const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => ['content-type', 'x-file-name'].includes(k)));
    const body = req.postDataBuffer();
    const res = await toolbox.request(`${u.pathname.replace(/^\/api/, '')}${u.search}`, { method: req.method(), headers, ...(body ? { body } : {}) });
    await route.fulfill({ status: res.status, headers: { 'access-control-allow-origin': '*', 'content-type': res.headers.get('content-type') ?? 'application/json' }, body: Buffer.from(await res.arrayBuffer()) });
    return true;
  }
  return false;
}
async function installFixtureHost(page) {
  await page.route(`${HOST}/**`, async route => {
    const cors = { 'access-control-allow-origin': '*' };
    const name = new URL(route.request().url()).pathname.slice(1);
    const send = (body, type, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': type }, body });
    const ranged = (buf, type) => {
      const r = /bytes=(\d*)-(\d*)/.exec(route.request().headers().range ?? '');
      if (!r) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': type, 'accept-ranges': 'bytes' }, body: buf });
      const start = r[1] ? Number(r[1]) : 0; const end = r[2] ? Math.min(Number(r[2]), buf.length - 1) : buf.length - 1;
      return route.fulfill({ status: 206, headers: { ...cors, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${buf.length}` }, body: buf.subarray(start, end + 1) });
    };
    if (name === 'clip.webm') return ranged(file('clip.webm'), 'video/webm');
    if (name === 'tone.mp3') return ranged(file('tone.mp3'), 'audio/mpeg');
    if (name === 'photo.png') return send(file('photo.png'), 'image/png');
    if (name === 'rapport.pdf') return send(PDF_BYTES, 'application/pdf');
    if (name === 'notes.txt') return send('Notes brutes du pont média.', 'text/plain; charset=utf-8');
    if (name === 'film.mkv') return send(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)), 'video/x-matroska');
    if (name === 'lent.mp4') { await new Promise(r => { slow.release = r; }); return route.abort().catch(() => {}); }
    return send('not found', 'text/plain', 404);
  });
  await page.route('https://www.youtube-nocookie.com/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>yt</title>' }));
}

const h = await startHarness({ port: 5257 });
await h.browser.close();
h.browser = await chromium.launch({ headless: true, channel: 'chromium' }); // full Chromium: built-in PDF viewer
const reader = (page) => page.locator('[data-testid="media-reader"]');
const phase = (page) => reader(page).getAttribute('data-phase');
async function openFor(page, url) {
  const anchor = page.locator(`a[href="${url}"]`).first();
  await anchor.waitFor({ timeout: 10_000 });
  await anchor.locator('xpath=following-sibling::button[@data-testid="open-in-docteur"]').first().click();
  await reader(page).waitFor({ timeout: 5_000 });
}
const waitPhase = (page, wanted, ms = 15_000) => until(async () => (await reader(page).count()) > 0 && wanted.includes(await phase(page)), ms, 50);
const close = async (page) => { await page.locator('[data-testid="media-reader-close"]').click(); await until(async () => (await reader(page).count()) === 0, 3_000, 50); };
const selectNeuron = async (page) => {
  await page.locator('.sidebar-item[data-neuron-id="bridge"]').first().dispatchEvent('click');
  await page.locator(`a[href="${L.video}"]`).first().waitFor({ timeout: 15_000 });
};

try {
  const app = await openApp(h, { seedPages, extra: apiRoutes, indexMs: 30 });
  const { page, net } = app;
  await installFixtureHost(page);
  await selectNeuron(page);

  // ═══ 1. Classification + right reader for every format ═══
  const matrix = [
    ['youtube', L.youtube, 'youtube', ['READY']], ['short', L.short, 'youtube', ['READY']], ['video', L.video, 'video', ['READY']],
    ['audio', L.audio, 'audio', ['READY']], ['image', L.image, 'image', ['READY']], ['pdf', L.pdf, 'pdf', ['READY']],
    ['text', L.text, 'text', ['READY']], ['article', L.article, 'web', ['READY']], ['web', L.web, 'web', ['READY']],
    ['unknown', LOCAL_UNKNOWN, 'unknown', ['UNSUPPORTED']], ['unsupported', L.unsupported, 'video', ['UNSUPPORTED', 'ERROR']],
  ];
  for (const [name, url, kind, phases] of matrix) {
    await openFor(page, url);
    eq(await reader(page).getAttribute('data-kind'), kind, `${name}: classified as ${kind}`);
    check(await waitPhase(page, phases), `${name}: ${phases.join('|')} (got ${await phase(page)})`);
    if (name === 'short') eq(await page.locator('[data-testid="media-reader-youtube"]').getAttribute('src'), 'https://www.youtube-nocookie.com/embed/aBcDeFgHiJk?autoplay=1', 'Short embedded');
    if (name === 'text') check((await page.locator('[data-testid="media-reader-text"]').innerText()).includes('Notes brutes'), 'text read');
    if (name === 'article') {
      check(await until(async () => (await page.locator('[data-testid="media-reader-web-captured"]').count()) === 1), 'captured article found through its canonical URL (F1)');
      check((await page.locator('[data-testid="media-reader-web-captured"]').innerText()).includes('Synthèse de l’article capturé'));
    }
    if (name === 'unknown' || name === 'unsupported') check(await page.locator('[data-testid="media-reader-fallback-source"]').count() + await page.locator('[data-testid="media-reader-download"]').count() >= 1, `${name}: fallback offers the source`);
    await close(page);
  }

  // ═══ 2. Loading = F2 panel, cancel really aborts, no timer after close ═══
  const failed = [];
  page.on('requestfailed', r => { if (r.url() === L.slow) failed.push(r.url()); });
  await openFor(page, L.slow);
  const panel = page.locator('[data-testid="media-reader-loading"] [data-operation-status="running"]');
  await panel.waitFor();
  eq(await panel.getAttribute('aria-busy'), 'true', 'F2 panel (aria-busy)');
  check(/Chargement du média…/.test(await panel.innerText()) && /Vidéo · media\.docteur-test\.example/.test(await panel.innerText()), 'label + step');
  check(await until(async () => /Écoulé : [1-9] s/.test(await panel.innerText()), 4_000), 'elapsed time ticks');
  check(await until(async () => (await page.locator('[data-testid="media-reader-slow"]').count()) === 1, 7_000), 'slow notice (same threshold as before)');
  await page.getByRole('button', { name: 'Annuler le chargement et fermer le lecteur' }).click();
  check(await until(async () => (await reader(page).count()) === 0, 3_000), 'cancel closes the reader');
  slow.release?.();
  check(await until(async () => failed.length >= 1, 5_000), 'the media request is aborted, not left running');
  await sleep(21_000);
  eq(await reader(page).count(), 0, 'no timer reopens or flips anything after close');

  // ═══ 3. PDF → local PDF workshop (bytes already read by the reader) ═══
  await openFor(page, L.pdf);
  check(await waitPhase(page, ['READY']), 'pdf ready');
  await page.locator('[data-testid="media-reader-open-toolbox"]').click();
  const workshop = page.getByRole('dialog', { name: 'Atelier PDF' });
  await workshop.waitFor({ timeout: 15_000 });
  eq(await reader(page).count(), 0, 'reader closed');
  check(await until(async () => (await workshop.locator('.tb-head h3').innerText().catch(() => '')) === 'rapport.pdf'), 'workshop opened on the PDF');
  check((await workshop.locator('.tb-head').innerText()).includes('2 pages'), 'real PDF imported (2 pages)');
  await workshop.getByRole('button', { name: 'Fermer Atelier PDF' }).click();

  // ═══ 4. Article / YouTube → existing capture flow, prefilled, the user confirms ═══
  await openFor(page, L.web);
  await page.locator('[data-testid="media-reader-capture"]').click();
  check(await until(async () => (await page.locator('.modal-box textarea').count()) === 1), 'capture window opened');
  eq(await page.locator('.modal-box textarea').inputValue(), `info ${L.web}`, 'prefilled with the deep-capture command');
  eq(await reader(page).count(), 0);
  await page.keyboard.press('Escape');
  await until(async () => (await page.locator('.modal-box').count()) === 0, 3_000);
  await openFor(page, L.youtube);
  eq(await page.locator('[data-testid="media-reader-capture"]').count(), 1, 'YouTube can be captured from the reader');
  await close(page);
  await openFor(page, L.image);
  eq(await page.locator('[data-testid="media-reader-capture"]').count(), 0, 'no capture action where none is planned');
  await close(page);

  // ═══ 5. One media failing never breaks the neuron ═══
  await openFor(page, L.missing);
  check(await waitPhase(page, ['ERROR']), 'missing image → explicit error');
  check(await page.locator('[data-testid="media-reader-retry"]').isVisible(), 'retry offered');
  await close(page);
  eq(await page.locator('textarea[placeholder="Titre du neurone"]').first().inputValue(), 'Pont média test', 'neuron still displayed');
  await openFor(page, L.image);
  check(await waitPhase(page, ['READY']), 'other media of the same neuron still open');
  await close(page);

  // ═══ 6. Cleanup: video unloaded, PDF object URL revoked ═══
  await openFor(page, L.video);
  check(await waitPhase(page, ['READY']), 'video ready');
  await close(page);
  eq(await page.locator('video').count(), 0, 'no video element left playing');
  await openFor(page, L.pdf);
  check(await waitPhase(page, ['READY']));
  const blob = await page.locator('[data-testid="media-reader-pdf"]').getAttribute('data-object-url');
  await close(page);
  check(await page.evaluate(u => fetch(u).then(() => false, () => true), blob), 'PDF object URL revoked on close');

  eq(net.errors.length, 0, `no page errors: ${net.errors.join(' | ')}`);
  // Chromium's built-in PDF viewer loads its own chrome-extension:// / chrome:// resources: browser internals, not network.
  const network = net.external.filter(u => /^https?:/i.test(u));
  eq(network.length, 0, `no external network request: ${network.join(', ')}`);
  await app.ctx.close();

  // ═══ 7. A crashing reader stays contained (real MediaReaderBoundary) ═══
  const ctx = await h.browser.newContext();
  const bp = await ctx.newPage();
  const errors = [];
  bp.on('pageerror', e => errors.push(e.message));
  await bp.route('**/__boundary', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/media-bridge-boundary-harness.jsx");mount();</script>' }));
  await bp.goto(`${h.origin}/__boundary`);
  await bp.locator('[data-testid="media-reader-crashed"]').waitFor({ timeout: 30_000 });
  check(await bp.getByTestId('neuron').isVisible(), 'the neuron next to the crashed reader is still rendered');
  check(await bp.evaluate(() => document.activeElement?.textContent === 'Fermer'), 'focus on Fermer');
  await bp.keyboard.press('Enter');
  check(await until(async () => (await bp.locator('[data-testid="media-reader-crashed"]').count()) === 0), 'closed with the keyboard');
  await bp.getByRole('button', { name: 'Compter 0' }).click();
  check(await bp.getByRole('button', { name: 'Compter 1' }).isVisible(), 'the app stays interactive after the crash');
  await ctx.close();
  console.log(`MEDIA_BRIDGE_BROWSER_PASS assertions=${assertions}`);
} finally {
  slow.release?.();
  await h.browser.close();
  await h.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
