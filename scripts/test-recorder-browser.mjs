// [Native Recorder] RECORDER-1 — browser suite: REAL RecorderPanel / capture controller / HTTP port / MediaRecorder in
// Chromium, REAL route factory + service + catalogue in-process on a TEMPORARY root. Camera / mic = Chromium fake
// devices; screen = synthetic canvas (the real getDisplayMedia throws in the harness). No physical device, no real
// user recording, no external request (aborted and counted), real user data untouched.
// Usage: node scripts/test-recorder-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { RecorderStore } from '../cortex-server/src/lib/recorder-store.js';
import { createRecorderService } from '../cortex-server/src/lib/recorder-service.js';
import { createRecorderRoute } from '../cortex-server/src/routes/recorder.js';
import { sniffMedia } from '../cortex-server/src/lib/media-studio.js';

let assertions = 0; const results = [];
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const REAL_DATA = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.resolve('cortex-server', 'data', f));
const realBefore = REAL_DATA.map(sha);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder1-browser-'));

const store = RecorderStore.open({ root: path.join(TMP, 'recordings') });
const service = createRecorderService({ store, limits: { minFreeBytes: 0 } });
const api = createRecorderRoute({ service });
const faults = { failChunkSeq: null, unavailable: false };
const net = { external: [], errors: [], recorderCalls: [], downloads: 0 };

const PORT = 5277;
const htmlFor = (cfg) => `<div id="root"></div><script>window.__recHarness=${JSON.stringify(cfg)};</script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/recorder-harness.jsx");mount();</script>`;
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-recorder1', plugins: [react()], optimizeDeps: { entries: ['scripts/recorder-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

async function openPage(cfg = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.grantPermissions(['camera', 'microphone'], { origin: `http://127.0.0.1:${PORT}` });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/api/recorder/**', async r => {
    const req = r.request(); const u = new URL(req.url());
    const sub = u.pathname.replace(/^\/api/, '');
    net.recorderCalls.push(`${req.method()} ${sub}`);
    if (faults.unavailable) return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'RECORDER_UNAVAILABLE', message: 'Recorder indisponible.' } }) });
    const m = /\/chunks\/(\d+)$/.exec(sub);
    if (m && faults.failChunkSeq !== null && Number(m[1]) === faults.failChunkSeq) return r.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'DISK_FULL', message: 'Disque plein (injecté).' } }) });
    const body = req.postDataBuffer();
    const headers = { ...req.headers() };
    const res = await api.request(`${sub}${u.search}`, { method: req.method(), headers, ...(body ? { body } : {}) });
    return r.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }, body: Buffer.from(await res.arrayBuffer()) });
  });
  await ctx.route('**/__rec', r => r.fulfill({ contentType: 'text/html', body: htmlFor(cfg) }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  page.on('download', () => { net.downloads++; });
  await page.goto(`http://127.0.0.1:${PORT}/__rec`);
  await page.getByTestId('rec-panel').waitFor({ timeout: 60_000 });
  return { ctx, page };
}
const state = (page) => page.getByTestId('rec-panel').getAttribute('data-state');
const waitState = (page, s, ms) => until(async () => (await state(page)) === s, ms);
const liveTracks = (page) => page.evaluate(() => window.__rec.liveTracks());
const latest = () => service.listRecordings({ limit: 1 }).items[0];
async function scenario(name, fn) {
  const before = assertions;
  faults.failChunkSeq = null; faults.unavailable = false;
  try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name} (${assertions - before})`); }
  catch (e) { results.push({ name, ok: false }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

try {
  await scenario('Recorder unavailable: structured message, Start disabled, no permission request', async () => {
    faults.unavailable = true;
    const { ctx, page } = await openPage();
    await page.getByTestId('rec-unavailable').waitFor();
    ok((await page.getByTestId('rec-unavailable').innerText()).includes('Recorder indisponible'), 'safe unavailable message');
    eq(await page.getByTestId('rec-start').isDisabled(), true, 'Start disabled');
    eq(await page.evaluate(() => window.__rec.gum + window.__rec.gdm), 0, 'no media permission request');
    await ctx.close();
  });

  await scenario('no capture at load: no getUserMedia / getDisplayMedia, no session, Stop disabled, no Pause button', async () => {
    const { ctx, page } = await openPage();
    await sleep(800);
    eq(await page.evaluate(() => window.__rec.gum + window.__rec.gdm), 0, 'no device requested at load');
    ok(net.recorderCalls.every(c => c === 'GET /recorder/recordings'), `only the metadata list at load (REC-DL-1 recent list): no session, chunk or download (${net.recorderCalls.join(', ')})`);
    eq(await state(page), 'IDLE');
    ok(await page.getByTestId('rec-start').isEnabled() && await page.getByTestId('rec-stop').isDisabled() && await page.getByTestId('rec-cancel').isDisabled(), 'button states');
    eq(await page.getByTestId('rec-pause').count(), 0, 'no Pause before recording');
    eq(await page.getByTestId('rec-live').count(), 0, 'no live indicator');
    await ctx.close();
  });

  await scenario('SCREEN: visible indicator (source, elapsed, Stop) → chunks → Stop → READY original WebM in the catalogue, tracks stopped', async () => {
    const { ctx, page } = await openPage();
    await page.getByTestId('rec-start').click();
    ok(await waitState(page, 'RECORDING'), 'RECORDING');
    const live = page.getByTestId('rec-live');
    const lt = await live.innerText();
    ok(lt.includes('ENREGISTREMENT EN COURS') && lt.includes('Écran'), `indicator: ${lt}`);
    const t0 = await page.getByTestId('rec-elapsed').innerText();
    await sleep(2300);
    const t1 = await page.getByTestId('rec-elapsed').innerText();
    ok(t1 !== t0, `elapsed advances (${t0} → ${t1})`);
    eq(await page.getByTestId('rec-start').isDisabled(), true, 'Start disabled while recording');
    ok(latest().chunkCount >= 3, `several chunks already stored (${latest().chunkCount})`);
    eq(latest().status, 'RECORDING');
    await live.getByRole('button', { name: /Arrêter/ }).click();
    ok(await waitState(page, 'READY'), 'READY');
    const r = latest();
    eq(r.status, 'READY'); eq(r.type, 'SCREEN'); eq(r.mimeType, 'video/webm;codecs=vp9,opus', 'actual MIME selected by Chromium');
    ok(r.filename.endsWith('.webm'), 'extension from the sniffed container');
    const h = await service.openRecording(r.recordingId, { verifyChecksum: true });
    const parts = []; for await (const c of h.stream()) parts.push(c);
    const file = Buffer.concat(parts);
    eq(file.length, r.sizeBytes); eq(sniffMedia(file.subarray(0, 64)).ext, 'webm', 'real WebM bytes (EBML)');
    ok(r.durationMs >= 2000 && r.width === 320 && r.height === 180, `metadata ${r.durationMs} ms ${r.width}x${r.height}`);
    eq(await liveTracks(page), 0, 'every track stopped');
    ok((await page.getByTestId('rec-result').innerText()).includes('Enregistré localement'), 'result shown');
    eq(await page.getByTestId('rec-format').innerText().then(t => t.startsWith('WebM')), true);
    eq(await page.locator(`[data-testid="rec-download"][data-recording-id="${r.recordingId}"]`).count() >= 1, true, 'REC-DL-1: a READY recording offers Télécharger');
    ok(!(await page.content()).includes(store.root), 'no absolute path in the page');
    await ctx.close();
  });

  await scenario('CAMERA + mic (Chromium fake devices): preview, READY with audio, tracks stopped', async () => {
    const { ctx, page } = await openPage();
    await page.getByRole('radio', { name: 'Caméra', exact: true }).check();
    await page.getByLabel('Inclure le micro').check();
    await page.getByLabel('Titre de l’enregistrement').fill('Démo caméra — été 2026');
    await page.getByTestId('rec-start').click();
    ok(await waitState(page, 'RECORDING'), 'RECORDING');
    await page.getByTestId('rec-preview').waitFor();
    ok((await page.getByTestId('rec-live').innerText()).includes('Caméra + micro'), 'source in the indicator');
    await sleep(1500);
    await page.getByTestId('rec-stop').click();
    ok(await waitState(page, 'READY'), 'READY');
    const r = latest();
    eq(r.type, 'CAMERA_WITH_MIC'); eq(r.hasAudio, true); eq(r.title, 'Démo caméra — été 2026');
    eq(await liveTracks(page), 0, 'camera + mic tracks stopped');
    eq(await page.getByTestId('rec-preview').count(), 0, 'preview gone');
    await ctx.close();
  });

  await scenario('pause / resume (real MediaRecorder support): elapsed frozen while paused, READY afterwards', async () => {
    const { ctx, page } = await openPage();
    await page.getByTestId('rec-start').click();
    ok(await waitState(page, 'RECORDING'), 'RECORDING');
    await sleep(900);
    await page.getByTestId('rec-pause').click();
    ok(await waitState(page, 'PAUSED'), 'PAUSED');
    ok((await page.getByTestId('rec-live').innerText()).includes('EN PAUSE'), 'paused indicator still visible');
    const a = await page.getByTestId('rec-elapsed').innerText(); await sleep(1300); const b = await page.getByTestId('rec-elapsed').innerText();
    eq(a, b, 'elapsed frozen while paused');
    await page.getByTestId('rec-resume').click();
    ok(await waitState(page, 'RECORDING'), 'RECORDING again');
    await sleep(700);
    await page.getByTestId('rec-stop').click();
    ok(await waitState(page, 'READY'), 'READY');
    ok(latest().durationMs < 2600, `paused time excluded (${latest().durationMs} ms)`);
    await ctx.close();
  });

  await scenario('cancel: CANCELLED, nothing kept, tracks stopped', async () => {
    const { ctx, page } = await openPage();
    await page.getByTestId('rec-start').click();
    ok(await waitState(page, 'RECORDING'), 'RECORDING');
    await sleep(900);
    await page.getByTestId('rec-cancel').click();
    ok(await waitState(page, 'CANCELLED'), 'CANCELLED');
    ok(await until(() => latest().status === 'CANCELLED'), 'server row CANCELLED');
    eq(fs.readdirSync(path.join(store.root, 'partial')).length, 0, 'partial removed');
    eq(await liveTracks(page), 0, 'tracks stopped');
    await ctx.close();
  });

  await scenario('screen share ended by the browser / OS: stops and finalizes, never stuck RECORDING', async () => {
    const { ctx, page } = await openPage();
    await page.getByTestId('rec-start').click();
    ok(await waitState(page, 'RECORDING'), 'RECORDING');
    await sleep(1000);
    await page.evaluate(() => window.__rec.endScreen());
    ok(await waitState(page, 'READY'), 'READY after the share ended');
    eq(latest().status, 'READY');
    eq(await liveTracks(page), 0);
    await ctx.close();
  });

  await scenario('permission denied (screen, camera, mic after screen granted): clear error, no session, no READY, tracks stopped', async () => {
    for (const [cfg, act] of [[{ screenDenied: true }, async () => {}], [{ cameraDenied: true }, async (p) => p.getByRole('radio', { name: 'Caméra', exact: true }).check()], [{ micDenied: true }, async (p) => p.getByLabel('Inclure le micro').check()]]) {
      const before = service.listRecordings({ limit: 100 }).total;
      const { ctx, page } = await openPage(cfg);
      await act(page);
      await page.getByTestId('rec-start').click();
      ok(await waitState(page, 'FAILED'), `FAILED ${JSON.stringify(cfg)}`);
      eq(await page.getByTestId('rec-error').getAttribute('data-error-code'), 'PERMISSION_DENIED');
      eq(service.listRecordings({ limit: 100 }).total, before, 'no session created');
      eq(await liveTracks(page), 0, 'already-granted tracks stopped');
      await ctx.close();
    }
  });

  await scenario('zero data from MediaRecorder: FAILED / EMPTY_RECORDING, never READY', async () => {
    const { ctx, page } = await openPage({ zeroData: true });
    await page.getByTestId('rec-start').click();
    ok(await waitState(page, 'RECORDING'), 'RECORDING');
    await sleep(800);
    await page.getByTestId('rec-stop').click();
    ok(await waitState(page, 'FAILED'), 'FAILED');
    eq(await page.getByTestId('rec-error').getAttribute('data-error-code'), 'EMPTY_RECORDING');
    eq(latest().status, 'FAILED'); eq(latest().error, 'EMPTY_RECORDING');
    await ctx.close();
  });

  await scenario('backend error mid-capture: FAILED with its code, capture stopped, session cancelled, tracks stopped', async () => {
    faults.failChunkSeq = 2;
    const { ctx, page } = await openPage();
    await page.getByTestId('rec-start').click();
    ok(await waitState(page, 'FAILED', 10_000), 'FAILED');
    eq(await page.getByTestId('rec-error').getAttribute('data-error-code'), 'DISK_FULL');
    ok(await until(() => latest().status === 'CANCELLED'), 'server session cancelled');
    eq(await liveTracks(page), 0);
    await ctx.close();
  });

  await scenario('unmount during a capture: tracks stopped, server session cancelled; one active recording only', async () => {
    const { ctx, page } = await openPage();
    await page.getByTestId('rec-start').click();
    ok(await waitState(page, 'RECORDING'), 'RECORDING');
    const busy = await page.evaluate(async () => {
      const r = await fetch('/api/recorder/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'CAMERA', mimeType: 'video/webm' }) });
      return [r.status, (await r.json()).error.code];
    });
    eq(JSON.stringify(busy), JSON.stringify([409, 'RECORDER_BUSY']), 'second concurrent recording refused');
    await page.locator('#unmount').click();
    ok(await until(async () => (await liveTracks(page)) === 0), 'tracks stopped on unmount');
    ok(await until(() => latest().status === 'CANCELLED'), 'session cancelled on unmount');
    await ctx.close();
  });

  await scenario('keyboard: Space on Démarrer starts, focus lands on the live Stop, Enter stops', async () => {
    const { ctx, page } = await openPage();
    await page.getByTestId('rec-start').focus();
    await page.keyboard.press('Space');
    ok(await waitState(page, 'RECORDING'), 'RECORDING by keyboard');
    ok(await until(() => page.evaluate(() => document.activeElement?.dataset?.testid === 'rec-stop-live')), 'focus on the live Stop');
    await sleep(800);
    await page.keyboard.press('Enter');
    ok(await waitState(page, 'READY'), 'READY by keyboard');
    eq(await page.getByRole('radio', { name: 'Écran', exact: true }).isEnabled(), true, 'source choice available again');
    await ctx.close();
  });

  eq(net.external.length, 0, `no external request (${net.external.join(', ')})`);
  eq(net.errors.length, 0, `no page error (${net.errors.join(' | ')})`);
  eq(net.downloads, 0, 'no download triggered');
  ok(!net.recorderCalls.some(c => /download|\/file|path=/i.test(c)), 'no download / file / path request');
  eq(JSON.stringify(REAL_DATA.map(sha)), JSON.stringify(realBefore), 'real user DB untouched');
} finally {
  await browser.close();
  await server.close();
  store.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
}
const failed = results.filter(r => !r.ok);
console.log(`${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length} scenarios, ${assertions} assertions`);
process.exit(failed.length ? 1 : 0);
