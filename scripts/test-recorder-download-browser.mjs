// [REC-DL-1] browser suite: the REAL RecorderPanel + RecordingDownloadButton + HTTP port in Chromium; /api/recorder/**
// answered in-process by the REAL route factory + service + catalogue on a TEMPORARY root. Downloads are REAL Chromium
// downloads (Playwright 'download' events, saved to a temp dir and compared byte-for-byte). The route runs on a REAL
// loopback HTTP server (@hono/node-server) behind Vite's proxy: Playwright request interception does not cover native
// downloads, and this way the GET really streams from the descriptor to Chromium. Synthetic fixtures + one
// end-to-end capture on the synthetic screen. No real camera / screen / user video; external requests aborted.
// Usage: node scripts/test-recorder-download-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { RecorderStore } from '../cortex-server/src/lib/recorder-store.js';
import { createRecorderService } from '../cortex-server/src/lib/recorder-service.js';
import { createRecorderRoute } from '../cortex-server/src/routes/recorder.js';

// the backend's own HTTP adapter (installed in cortex-server, not at the root): no new dependency
const { serve } = await import(pathToFileURL(createRequire(path.resolve('cortex-server', 'package.json')).resolve('@hono/node-server')).href);
let assertions = 0; const results = [];
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileSha = (p) => (fs.existsSync(p) ? sha(fs.readFileSync(p)) : 'absent');
const REAL_DATA = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.resolve('cortex-server', 'data', f));
const realBefore = REAL_DATA.map(fileSha);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recdl1-browser-'));
const SAVED = path.join(TMP, 'saved'); fs.mkdirSync(SAVED);

const store = RecorderStore.open({ root: path.join(TMP, 'recordings') });
const service = createRecorderService({ store, limits: { minFreeBytes: 0 } });
const api = createRecorderRoute({ service });
const WEBM = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), crypto.randomBytes(n)]);
const MP4 = (n) => Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(4), crypto.randomBytes(n)]);
async function fixture({ title, mimeType = 'video/webm;codecs=vp9,opus', chunks }) {
  const s = service.createSession({ type: 'SCREEN', mimeType, title }); service.markStarted(s);
  chunks.forEach((bytes, seq) => service.appendChunk({ ...s, seq, bytes }));
  const out = await service.finalize(s);
  return { id: s.recordingId, bytes: Buffer.concat(chunks), out };
}
const uni = await fixture({ title: 'Réunion d’équipe — été 🎥', chunks: [WEBM(2 * 1024 * 1024), crypto.randomBytes(1024 * 1024)] });
const mp4 = await fixture({ mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', chunks: [MP4(300_000)] });
const gone = await fixture({ title: 'Fichier effacé', chunks: [WEBM(50_000)] });
const failed = service.createSession({ type: 'CAMERA', mimeType: 'video/webm', title: 'Vide' }); await service.finalize(failed);
const cancelled = service.createSession({ type: 'CAMERA', mimeType: 'video/webm', title: 'Annulé' }); service.cancel(cancelled);

const faults = { headFailFor: null };
const net = { external: [], errors: [], calls: [], downloads: [] };
const PORT = 5279;
const htmlFor = (cfg) => `<div id="root"></div><script>window.__recHarness=${JSON.stringify(cfg)};</script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/recorder-harness.jsx");mount();</script>`;
const apiServer = serve({
  hostname: '127.0.0.1', port: 0,
  fetch: async (req) => {
    const u = new URL(req.url);
    net.calls.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.method === 'HEAD' && faults.headFailFor && u.pathname.includes(faults.headFailFor)) return new Response(null, { status: 500, headers: { 'x-docteur-recorder-error': 'INTERNAL_ERROR' } });
    return api.fetch(req);
  },
});
await new Promise(r => (apiServer.listening ? r() : apiServer.once('listening', r)));
const API_PORT = apiServer.address().port;
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-recdl1', plugins: [react()], optimizeDeps: { entries: ['scripts/recorder-harness.jsx'] },
  server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false, proxy: { '/api/recorder': { target: `http://127.0.0.1:${API_PORT}`, rewrite: (p) => p.replace(/^\/api/, '') } } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

async function openPage(cfg = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/__rec', r => r.fulfill({ contentType: 'text/html', body: htmlFor(cfg) }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  page.on('download', d => net.downloads.push(d.suggestedFilename()));
  await page.goto(`http://127.0.0.1:${PORT}/__rec`);
  await page.getByTestId('rec-panel').waitFor({ timeout: 60_000 });
  await page.getByTestId('rec-recent').waitFor();
  return { ctx, page };
}
const item = (page, id) => page.locator(`[data-testid="rec-recent"] li[data-recording-id="${id}"]`);
const callsFor = (id) => net.calls.filter(c => c.includes(`/recordings/${id}/download`));
async function download(page, trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), trigger()]);
  const target = path.join(SAVED, `${crypto.randomUUID()}-${dl.suggestedFilename()}`);
  await dl.saveAs(target);
  return { name: dl.suggestedFilename(), bytes: fs.readFileSync(target), failure: await dl.failure() };
}
async function scenario(name, fn) {
  const before = assertions; faults.headFailFor = null;
  try { await fn(); results.push({ ok: true }); console.log(`ok - ${name} (${assertions - before})`); }
  catch (e) { results.push({ ok: false }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

try {
  await scenario('load: no automatic download; Télécharger only on READY recordings (not FAILED / CANCELLED)', async () => {
    const before = net.calls.length;
    const { ctx, page } = await openPage();
    await sleep(800);
    eq(net.downloads.length, 0, 'no automatic download');
    ok(net.calls.slice(before).every(c => c.startsWith('GET /recorder/recordings?')), 'only the metadata list at load');
    for (const id of [uni.id, mp4.id, gone.id]) eq(await item(page, id).getByTestId('rec-download-btn').count(), 1, `button on READY ${id}`);
    for (const id of [failed.recordingId, cancelled.recordingId]) { await item(page, id).waitFor(); eq(await item(page, id).getByTestId('rec-download-btn').count(), 0, `no button on ${await item(page, id).getAttribute('data-status')}`); }
    eq(await page.evaluate(() => window.__rec.bodyReads.blob + window.__rec.bodyReads.arrayBuffer + window.__rec.bodyReads.fileReader + window.__rec.bodyReads.objectUrl), 0);
    await ctx.close();
  });

  await scenario('one click → real browser download: Unicode name, WebM extension, identical bytes and size, one HEAD + one GET, nothing buffered in the page', async () => {
    const { ctx, page } = await openPage();
    const before = callsFor(uni.id).length;
    const d = await download(page, () => item(page, uni.id).getByTestId('rec-download-btn').click());
    eq(d.failure, null, 'download completed');
    eq(d.name, 'Réunion d’équipe — été 🎥.webm', 'Unicode file name (filename*)');
    ok(d.bytes.equals(uni.bytes), 'byte-for-byte the recorded original');
    eq(d.bytes.length, uni.bytes.length, 'size');
    eq(JSON.stringify(callsFor(uni.id).slice(before)), JSON.stringify([`HEAD /recorder/recordings/${uni.id}/download`, `GET /recorder/recordings/${uni.id}/download`]), 'exactly one HEAD preflight and one GET');
    ok(callsFor(uni.id).every(c => !/[?&](path|file|storageKey)=/.test(c)), 'recordingId only');
    await until(async () => (await item(page, uni.id).getAttribute('data-download-state').catch(() => null)) === 'STARTED' || (await item(page, uni.id).getByTestId('rec-download').getAttribute('data-download-state')) === 'STARTED');
    eq(await item(page, uni.id).getByTestId('rec-download').getAttribute('data-download-state'), 'STARTED');
    ok((await item(page, uni.id).getByTestId('rec-download-status').innerText()).includes('Téléchargement lancé'), '"lancé", never "téléchargé"');
    eq(await page.evaluate(() => JSON.stringify(window.__rec.bodyReads)), JSON.stringify({ blob: 0, arrayBuffer: 0, fileReader: 0, objectUrl: 0 }), 'no blob / arrayBuffer / FileReader / object URL in the renderer');
    await ctx.close();
  });

  await scenario('MP4 recording downloads as MP4 (no conversion); untitled → deterministic recording-<date>-<id>.mp4', async () => {
    const { ctx, page } = await openPage();
    const d = await download(page, () => item(page, mp4.id).getByTestId('rec-download-btn').click());
    ok(new RegExp(`^recording-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}-${mp4.id.slice(4, 12)}\\.mp4$`).test(d.name), d.name);
    ok(d.bytes.equals(mp4.bytes), 'original MP4 bytes');
    await ctx.close();
  });

  await scenario('keyboard: Enter and Space on the button start the download', async () => {
    const { ctx, page } = await openPage();
    const btn = item(page, mp4.id).getByTestId('rec-download-btn');
    await btn.focus();
    const a = await download(page, () => page.keyboard.press('Enter'));
    ok(a.bytes.equals(mp4.bytes), 'Enter');
    await until(async () => !(await btn.isDisabled()));
    await btn.focus();
    const b = await download(page, () => page.keyboard.press('Space'));
    ok(b.bytes.equals(mp4.bytes), 'Space');
    ok((await btn.getAttribute('aria-label')).includes('Télécharger'), 'labelled button');
    await ctx.close();
  });

  await scenario('READY in the catalogue but the file was deleted: "Fichier manquant", no download, no GET', async () => {
    const { ctx, page } = await openPage();
    fs.unlinkSync(path.join(store.root, 'files', `${gone.id}.webm`));
    const before = net.downloads.length; const gets = callsFor(gone.id).filter(c => c.startsWith('GET')).length;
    await item(page, gone.id).getByTestId('rec-download-btn').click();
    ok(await until(async () => (await item(page, gone.id).getByTestId('rec-download').getAttribute('data-download-state')) === 'MISSING'), 'MISSING state');
    eq(await item(page, gone.id).getByTestId('rec-download-btn').innerText().then(t => t.trim()), 'Fichier manquant');
    ok(await item(page, gone.id).getByTestId('rec-download-btn').isDisabled(), 'disabled');
    await sleep(500);
    eq(net.downloads.length, before, 'no download');
    eq(callsFor(gone.id).filter(c => c.startsWith('GET')).length, gets, 'no GET after a failed preflight');
    await ctx.close();
  });

  await scenario('backend error on the preflight: "Erreur" shown, no download, button usable again', async () => {
    const { ctx, page } = await openPage();
    faults.headFailFor = uni.id;
    const before = net.downloads.length;
    await item(page, uni.id).getByTestId('rec-download-btn').click();
    ok(await until(async () => (await item(page, uni.id).getByTestId('rec-download').getAttribute('data-download-state')) === 'ERROR'), 'ERROR');
    ok((await item(page, uni.id).getByTestId('rec-download-status').innerText()).startsWith('Erreur'), 'error text');
    await sleep(400);
    eq(net.downloads.length, before);
    ok(await item(page, uni.id).getByTestId('rec-download-btn').isEnabled(), 'retry possible');
    await ctx.close();
  });

  await scenario('end-to-end: record (synthetic screen, real MediaRecorder) → READY → Télécharger on the result → the browser saves exactly the recorded file', async () => {
    const { ctx, page } = await openPage();
    await page.getByLabel('Titre de l’enregistrement').fill('Capture de démonstration');
    await page.getByTestId('rec-start').click();
    ok(await until(async () => (await page.getByTestId('rec-panel').getAttribute('data-state')) === 'RECORDING'), 'RECORDING');
    eq(await page.getByTestId('rec-result').count(), 0, 'no download button while recording');
    await sleep(1600);
    await page.getByTestId('rec-stop').click();
    ok(await until(async () => (await page.getByTestId('rec-panel').getAttribute('data-state')) === 'READY'), 'READY');
    const id = await page.getByTestId('rec-result').getAttribute('data-recording-id');
    const h = await service.openRecording(id); const parts = []; for await (const c of h.stream()) parts.push(c);
    const stored = Buffer.concat(parts);
    const d = await download(page, () => page.locator(`[data-testid="rec-download"][data-recording-id="${id}"]`).first().getByTestId('rec-download-btn').click());
    eq(d.name, 'Capture de démonstration.webm');
    ok(d.bytes.equals(stored), `downloaded bytes = stored original (${d.bytes.length} B)`);
    await ctx.close();
  });

  eq(net.external.length, 0, `no external request (${net.external.join(', ')})`);
  eq(net.errors.length, 0, `no page error (${net.errors.join(' | ')})`);
  ok(!net.calls.some(c => /[?&](path|file|storageKey)=|\/files\b/.test(c)), 'no path / file request ever');
  eq(JSON.stringify(REAL_DATA.map(fileSha)), JSON.stringify(realBefore), 'real user DB untouched');
} finally {
  await browser.close();
  await server.close();
  await new Promise(r => apiServer.close(() => r()));
  store.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
}
const bad = results.filter(r => !r.ok);
console.log(`${bad.length ? 'FAIL' : 'PASS'} ${results.length - bad.length}/${results.length} scenarios, ${assertions} assertions`);
process.exit(bad.length ? 1 : 0);
