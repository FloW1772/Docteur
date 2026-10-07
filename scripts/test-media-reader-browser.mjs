// Media Reader V1 — REAL src/App.tsx in Chromium (audit harness: every /api/** mocked, no real server, no real DB).
// Media fixtures are generated locally (ffmpeg) and served by Playwright routes on a fake public host + Docteur's own
// local audio route; nothing reaches the Internet. One seeded neuron holds one link per kind.
// Usage: node scripts/test-media-reader-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startHarness, openApp, until, sleep } from './audit-queue-lib.mjs';

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };

// ─── fixtures (generated, no private data) ──────────────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-media-reader-'));
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=2', '-c:v', 'libvpx', '-b:v', '200k', path.join(dir, 'clip.webm'));
ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path.join(dir, 'tone.wav'));
ff('-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:a', 'libmp3lame', path.join(dir, 'tone.mp3'));
ff('-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1', path.join(dir, 'photo.png'));
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const MD = '# Notes de test\n\nTexte **gras** et un lien https://example.org/x\n\n<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned = 2">\n';
const file = (n) => fs.readFileSync(path.join(dir, n));

const HOST = 'https://media.docteur-test.example';
const LOCAL_AUDIO = `http://127.0.0.1:3001/api/audio-player/file?path=${encodeURIComponent('C:\\Musique\\tone.wav')}`;
const L = {
  youtube: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
  video: `${HOST}/clip.webm`, audio: `${HOST}/tone.mp3`, image: `${HOST}/photo.png`, pdf: `${HOST}/rapport.pdf`, text: `${HOST}/notes.md`,
  unsupported: `${HOST}/film.mkv`, missing: `${HOST}/missing.png`, slow: `${HOST}/slow.mp4`,
  captured: 'https://www.lemonde.fr/article-capture', web: 'https://example.org/page', privateLan: 'http://192.168.1.20/cam.mp4',
};
const now = Date.now();
const mediaPage = {
  id: 'media-test', title: 'Médiathèque test', kind: 'note', createdAt: now - 1000, updatedAt: now, links: [], metadata: {},
  blocks: [
    { id: 'b1', type: 'paragraph', content: `YouTube Short ${L.youtube}` },
    { id: 'b2', type: 'list', content: `Vidéo ${L.video}` },
    { id: 'b3', type: 'paragraph', content: `Audio distant ${L.audio}` },
    { id: 'b4', type: 'list', content: `Audio local ${LOCAL_AUDIO}` },
    { id: 'b5', type: 'paragraph', content: `Image ${L.image}` },
    { id: 'b6', type: 'paragraph', content: `PDF ${L.pdf}` },
    { id: 'b7', type: 'paragraph', content: `Texte ${L.text}` },
    { id: 'b8', type: 'paragraph', content: `MKV ${L.unsupported}` },
    { id: 'b9', type: 'paragraph', content: `Absent ${L.missing}` },
    { id: 'b10', type: 'paragraph', content: `Lent ${L.slow}` },
    { id: 'b11', type: 'paragraph', content: `Article ${L.captured}` },
    { id: 'b12', type: 'paragraph', content: `Page ${L.web}` },
    { id: 'b13', type: 'paragraph', content: `Caméra LAN ${L.privateLan}` },
  ],
};
const articlePage = {
  id: 'article-captured', title: 'Article capturé (test)', kind: 'reference', createdAt: now - 5000, updatedAt: now - 5000, links: [],
  metadata: { url: L.captured }, blocks: [{ id: 'a1', type: 'paragraph', content: 'Corps de l’article capturé, lu sans réseau.' }],
};
const seedPages = [mediaPage, articlePage];

const api = { browserOpen: [], audioRanges: [] };
async function apiRoutes({ route, p, m, body, json, url }) {
  if (p === '/api/agents/pending-outputs') { await json(route, []); return true; }
  if (p.startsWith('/api/neuron/') && m === 'GET') { const pg = seedPages.find(x => x.id === decodeURIComponent(p.split('/').pop())); await json(route, pg ? { page: pg } : { error: 'nf' }, pg ? 200 : 404); return true; }
  if (p === '/api/browser/open' && m === 'POST') { api.browserOpen.push(body()?.url); await json(route, { opened: true, url: body()?.url }); return true; }
  if (p === '/api/audio-player/file') {
    api.audioRanges.push(route.request().headers().range ?? null);
    eq(url.searchParams.get('path'), 'C:\\Musique\\tone.wav', 'local audio requested through Docteur\'s own route');
    await route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' }, body: file('tone.wav') });
    return true;
  }
  return false;
}

const slowGate = { release: null, hits: 0 };
async function installFixtureHost(page) {
  const cors = { 'access-control-allow-origin': '*' };
  await page.route(`${HOST}/**`, async route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const send = (body, type, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': type }, body });
    // like a real media server / CDN: byte ranges (206) so the browser can seek and stream
    const sendRanged = (buf, type) => {
      const m = /bytes=(\d*)-(\d*)/.exec(route.request().headers().range ?? '');
      if (!m) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': type, 'accept-ranges': 'bytes' }, body: buf });
      const start = m[1] ? Number(m[1]) : 0; const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      return route.fulfill({ status: 206, headers: { ...cors, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${buf.length}` }, body: buf.subarray(start, end + 1) });
    };
    if (name === 'clip.webm') return sendRanged(file('clip.webm'), 'video/webm');
    if (name === 'tone.mp3') return sendRanged(file('tone.mp3'), 'audio/mpeg');
    if (name === 'photo.png') return send(file('photo.png'), 'image/png');
    if (name === 'rapport.pdf') return send(Buffer.from(PDF), 'application/pdf');
    if (name === 'notes.md') return send(MD, 'text/markdown; charset=utf-8');
    if (name === 'film.mkv') return send(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)), 'video/x-matroska');
    if (name === 'slow.mp4') { slowGate.hits += 1; await new Promise(r => { slowGate.release = r; }); return route.abort().catch(() => {}); }
    return send('not found', 'text/plain', 404);
  });
  // the YouTube embed (same URL as the historical player) — served locally, nothing leaves the machine
  await page.route('https://www.youtube-nocookie.com/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>yt</title><p>embed</p>' }));
}

const h = await startHarness({ port: 5238 });
// the old headless shell has no PDF viewer (navigator.pdfViewerEnabled === false); the new headless mode is a full Chromium
await h.browser.close();
h.browser = await chromium.launch({ headless: true, channel: 'chromium' });
const reader = (page) => page.locator('[data-testid="media-reader"]');
const phase = (page) => reader(page).getAttribute('data-phase');
const btn = (page, block, kind) => page.locator(`[data-testid="open-in-docteur"][data-media-kind="${kind}"]`).nth(block);
async function openFor(page, url) {
  // the button right after the anchor of this URL (the anchor itself is the untouched "open the source" link)
  const anchor = page.locator(`a[href="${url}"]`).first();
  await anchor.waitFor({ timeout: 10_000 });
  await anchor.locator('xpath=following-sibling::button[@data-testid="open-in-docteur"]').first().click();
  await reader(page).waitFor({ timeout: 5_000 });
}
const waitPhase = async (page, wanted, ms = 15_000) => until(async () => (await reader(page).count()) > 0 && wanted.includes(await phase(page)), ms, 50);
const close = async (page) => { await page.locator('[data-testid="media-reader-close"]').click(); await until(async () => (await reader(page).count()) === 0, 3_000, 50); };

try {
  const app = await openApp(h, { seedPages, extra: apiRoutes, indexMs: 30 });
  const { page, net } = app;
  await installFixtureHost(page);
  await page.locator('.sidebar-item[data-neuron-id="media-test"]').first().dispatchEvent('click'); // sidebar may be collapsed in this viewport: selection only
  await page.locator(`a[href="${L.video}"]`).first().waitFor({ timeout: 15_000 });

  // ═══ S1 — every link keeps its source link; the Docteur button exists for every kind; private hosts get none ═══
  for (const [kind, url] of [['youtube', L.youtube], ['video', L.video], ['audio', L.audio], ['image', L.image], ['pdf', L.pdf], ['text', L.text], ['web', L.web]]) {
    const a = page.locator(`a[href="${url}"]`).first();
    eq(await a.getAttribute('target'), '_blank', `${kind}: source link unchanged (new tab)`);
    eq(await a.getAttribute('rel'), 'noopener noreferrer', `${kind}: source link keeps noopener`);
    eq(await a.locator('xpath=following-sibling::button[@data-testid="open-in-docteur"]').first().getAttribute('data-media-kind'), kind, `${kind}: Docteur button`);
  }
  eq(await page.locator(`a[href="${L.privateLan}"] ~ button[data-testid="open-in-docteur"]`).count(), 0, 'no reader button for a LAN address');
  eq(await page.locator(`a[href="${LOCAL_AUDIO}"]`).count(), 1, 'Docteur-local link rendered');
  const pagesBefore = h.browser.contexts()[0].pages().length;

  // ═══ S2 — YouTube Short: same embed as the historical player (Shorts had no button before) ═══
  await openFor(page, L.youtube);
  check(await waitPhase(page, ['READY']), `youtube ready (${await phase(page)})`);
  const yt = page.locator('[data-testid="media-reader-youtube"]');
  eq(await yt.getAttribute('src'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1');
  check((await yt.getAttribute('allow')).includes('autoplay') && (await yt.getAttribute('allowfullscreen')) !== null, 'same permissions + fullscreen');
  eq(await page.locator('[data-testid="media-reader-source"]').getAttribute('href'), L.youtube, 'reader offers the original source separately');
  eq(h.browser.contexts()[0].pages().length, pagesBefore, 'the Docteur button never opened a new tab');
  await close(page);

  // ═══ S3 — video: real loading → ready, play / pause / seek / volume, close stops the download ═══
  await openFor(page, L.video);
  check(['OPENING', 'LOADING', 'READY'].includes(await phase(page)), 'opens on a state, never an empty box');
  check(await waitPhase(page, ['READY']), `video ready (${await phase(page)})`);
  const media = await page.evaluate(async () => {
    const v = document.querySelector('[data-testid="media-reader-video"]');
    v.muted = true; await v.play().catch(() => {}); await new Promise(r => setTimeout(r, 300));
    const playing = !v.paused; v.pause(); const paused = v.paused;
    v.currentTime = 1.0; await new Promise(r => v.addEventListener('seeked', r, { once: true }));
    v.volume = 0.3;
    return { playing, paused, time: v.currentTime, volume: v.volume, controls: v.controls, duration: v.duration };
  });
  check(media.playing && media.paused, `play then pause: ${JSON.stringify(media)}`);
  check(Math.abs(media.time - 1) < 0.2 && media.volume === 0.3 && media.controls && media.duration > 1.5, `seek/volume/controls: ${JSON.stringify(media)}`);
  await close(page);

  // ═══ S4 — switch media + reopen: each open starts a fresh state ═══
  await openFor(page, L.audio);
  check(await waitPhase(page, ['READY']), `remote mp3 ready (${await phase(page)})`);
  eq(await reader(page).getAttribute('data-kind'), 'audio');
  const audio = await page.evaluate(async () => {
    const a = document.querySelector('[data-testid="media-reader-audio"]');
    a.muted = true; await a.play().catch(() => {}); await new Promise(r => setTimeout(r, 200));
    const playing = !a.paused; a.pause(); a.currentTime = 0.5; a.volume = 0.5;
    return { playing, paused: a.paused, duration: a.duration, volume: a.volume };
  });
  check(audio.playing && audio.paused && audio.duration > 1.5 && audio.volume === 0.5, `audio controls: ${JSON.stringify(audio)}`);
  await page.keyboard.press('Escape');
  check(await until(async () => (await reader(page).count()) === 0, 3_000, 50), 'Escape closes the reader');
  eq(await page.locator('.sidebar-item[data-selected="true"]').getAttribute('data-neuron-id'), 'media-test', 'Escape did not close the neuron underneath');
  await openFor(page, LOCAL_AUDIO);
  check(await waitPhase(page, ['READY']), `local audio (Docteur route) ready (${await phase(page)})`);
  check(api.audioRanges.length >= 1, 'served by /api/audio-player/file (existing Range route)');
  await close(page);
  await openFor(page, L.audio);
  check(await waitPhase(page, ['READY']), 'reopen works');
  await close(page);

  // ═══ S5 — image: fit to window, zoom toggle ═══
  await openFor(page, L.image);
  check(await waitPhase(page, ['READY']), `image ready (${await phase(page)})`);
  const img = page.locator('[data-testid="media-reader-image"]');
  check(await img.evaluate(el => el.naturalWidth === 640 && el.getBoundingClientRect().width <= window.innerWidth), 'image decoded and fitted');
  await page.locator('[data-testid="media-reader-zoom"]').click();
  check(await img.evaluate(el => Math.round(el.getBoundingClientRect().width) === 640), 'actual size');
  await close(page);

  // ═══ S6 — PDF: verified bytes in a blob iframe, object URL revoked on close ═══
  await openFor(page, L.pdf);
  check(await waitPhase(page, ['READY']), `pdf ready (${await phase(page)})`);
  const blobUrl = await page.locator('[data-testid="media-reader-pdf"]').getAttribute('data-object-url');
  check(blobUrl?.startsWith('blob:'), `pdf shown from a local blob: ${blobUrl}`);
  check(await page.evaluate(u => fetch(u).then(r => r.ok, () => false), blobUrl), 'blob alive while open');
  await close(page);
  check(await page.evaluate(u => fetch(u).then(() => false, () => true), blobUrl), 'object URL revoked after close');
  // a browser whose PDF viewer is disabled: immediate explicit fallback, no wait for the timeout
  await page.evaluate(() => Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { configurable: true, get: () => false }));
  const t0 = Date.now();
  await openFor(page, L.pdf);
  check(await waitPhase(page, ['UNSUPPORTED'], 5_000), `no PDF viewer → UNSUPPORTED (${await phase(page)})`);
  check(Date.now() - t0 < 5_000, 'immediately, not after the 20 s timeout');
  check(/visualiseur PDF/.test(await page.locator('[data-testid="media-reader-message"]').innerText()), 'explains why');
  eq(await page.locator('[data-testid="media-reader-fallback-source"]').getAttribute('href'), L.pdf, 'fallback: source');
  await close(page);
  await page.evaluate(() => { delete Navigator.prototype.pdfViewerEnabled; });

  // ═══ S7 — text / markdown: rendered safely, embedded HTML never executed ═══
  await openFor(page, L.text);
  check(await waitPhase(page, ['READY']), `text ready (${await phase(page)})`);
  const textBox = page.locator('[data-testid="media-reader-text"]');
  check(await textBox.locator('h1', { hasText: 'Notes de test' }).count() === 1, 'markdown heading rendered');
  const shown = await textBox.innerText();
  check(shown.includes('<script>') && shown.includes('</script>') && shown.includes('onerror'), `HTML shown as inert text: ${JSON.stringify(shown.slice(-140))}`);
  await sleep(300);
  eq(await page.evaluate(() => window.__pwned), undefined, 'no script / onerror executed');
  eq(await textBox.locator('script, img').count(), 0, 'no element created from the markdown HTML');
  await close(page);

  // ═══ S8 — unsupported codec → explicit fallback (no broken player); missing file → error + retry ═══
  await openFor(page, L.unsupported);
  check(await waitPhase(page, ['UNSUPPORTED']), `mkv garbage → UNSUPPORTED (${await phase(page)})`);
  check((await page.locator('[data-testid="media-reader-message"]').innerText()).startsWith('Ce format ne peut pas être prévisualisé directement dans Docteur.'), 'explicit message');
  eq(await page.locator('[data-testid="media-reader-video"]').count(), 0, 'no broken player left on screen');
  eq(await page.locator('[data-testid="media-reader-fallback-source"]').getAttribute('href'), L.unsupported, 'fallback: open the source');
  eq(await page.locator('[data-testid="media-reader-open-browser"]').count(), 1, 'fallback: open in the browser');
  await close(page);
  await openFor(page, L.missing);
  check(await waitPhase(page, ['ERROR']), `404 image → ERROR (${await phase(page)})`);
  await page.locator('[data-testid="media-reader-retry"]').click();
  check(await waitPhase(page, ['ERROR']), 'retry runs again and ends in a state');
  await close(page);

  // ═══ S9 — slow media: loader with title, "slow" hint, close during loading cleans up, reopen is fresh ═══
  await openFor(page, L.slow);
  const loading = page.locator('[data-testid="media-reader-loading"]');
  check(await loading.isVisible() && /Chargement du média…/.test(await loading.innerText()), 'loading screen (spinner + text)');
  check(/Vidéo/.test(await loading.innerText()), 'loading screen names the media type');
  check(await until(async () => (await page.locator('[data-testid="media-reader-slow"]').count()) === 1, 7_000, 100), 'slow-loading hint after a few seconds');
  await close(page);
  slowGate.release?.();
  await sleep(200);
  await openFor(page, L.slow);
  check(['OPENING', 'LOADING'].includes(await phase(page)) && (await page.locator('[data-testid="media-reader-slow"]').count()) === 0, 'reopen starts a fresh loading state');
  // never answers → the real timeout ends the spinner (no infinite loading)
  const tTimeout = Date.now();
  check(await waitPhase(page, ['ERROR'], 26_000), `timeout → ERROR (${await phase(page)})`);
  const waited = Date.now() - tTimeout;
  check(waited > 15_000 && waited < 25_000, `after the ~20 s timeout (${waited} ms)`);
  check(/délai dépassé/.test(await page.locator('[data-testid="media-reader-message"]').innerText()), 'timeout explained');
  eq(await page.locator('[data-testid="media-reader-retry"]').count(), 1, 'retry offered');
  await close(page);
  slowGate.release?.();

  // ═══ S10 — web: captured article shown from Docteur (no network), uncaptured page = card + existing browser module ═══
  await openFor(page, L.captured);
  check(await waitPhase(page, ['READY']), 'web ready');
  check((await page.locator('[data-testid="media-reader-web-captured"]').innerText()).includes('Corps de l’article capturé'), 'captured content shown');
  eq(await page.locator('[data-testid="media-reader"] iframe').count(), 0, 'no remote page iframed');
  await page.locator('[data-testid="media-reader-open-page"]').click();
  check(await until(async () => (await page.locator('.sidebar-item[data-selected="true"]').getAttribute('data-neuron-id')) === 'article-captured', 5_000), 'navigates to the captured neuron');
  eq(await reader(page).count(), 0, 'reader closed on navigation');
  await page.locator('.sidebar-item[data-neuron-id="media-test"]').first().dispatchEvent('click'); // sidebar may be collapsed in this viewport: selection only
  await page.locator(`a[href="${L.web}"]`).first().waitFor({ timeout: 10_000 });
  await openFor(page, L.web);
  check(/Page web · example\.org/.test(await page.locator('[data-testid="media-reader-web"]').innerText()), 'web card');
  await page.locator('[data-testid="media-reader-open-browser"]').click();
  check(await until(() => api.browserOpen.includes(L.web), 5_000), 'existing /api/browser/open used');
  check(await until(async () => /Ouvert dans le navigateur/.test(await page.locator('[data-testid="media-reader-browser-status"]').innerText()), 3_000), 'status shown');
  await close(page);

  eq(net.errors.length, 0, `no page error: ${net.errors.join(' | ')}`);
  // chrome-extension:// and chrome:// = Chromium's built-in PDF viewer files (inside the browser, not network)
  const network = net.external.filter(u => /^https?:/.test(u) && !u.startsWith('https://fonts.'));
  eq(network.length, 0, `nothing left the machine: ${network.join(', ')}`);
  await app.ctx.close();
  console.log(`MEDIA READER BROWSER: PASS (${assertions} assertions)`);
} finally {
  slowGate.release?.();
  await h.browser.close().catch(() => {});
  await h.server.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
