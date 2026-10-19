// REC-WIRE-1 — real App shell → Help directory → RecorderPanel → temporary Recorder backend → native download.
// Chromium uses a synthetic canvas screen; no physical camera/screen, user DB, user recordings or external network.
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { RecorderStore } from '../cortex-server/src/lib/recorder-store.js';
import { createRecorderService } from '../cortex-server/src/lib/recorder-service.js';
import { createRecorderRoute } from '../cortex-server/src/routes/recorder.js';

const { serve } = await import(pathToFileURL(createRequire(path.resolve('cortex-server', 'package.json')).resolve('@hono/node-server')).href);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-wire-product-'));
const ROOT = path.join(TMP, 'recordings');
const SAVED = path.join(TMP, 'downloads');
fs.mkdirSync(SAVED);
const REAL_DATA = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.resolve('cortex-server', 'data', f));
const fileSha = (p) => fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent';
const realBefore = REAL_DATA.map(fileSha);
let store = RecorderStore.open({ root: ROOT });
let service = createRecorderService({ store, limits: { minFreeBytes: 0 } });
let recorderRoute = createRecorderRoute({ service });
const calls = [];
const serverCalls = [];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin ?? 'http://127.0.0.1:5281',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Docteur-Recorder-Session',
  };
}
const apiServer = serve({
  hostname: '127.0.0.1', port: 0,
  fetch: async (req) => {
    const u = new URL(req.url); const origin = req.headers.get('origin');
    serverCalls.push(`${req.method} ${u.pathname} origin=${origin ?? '-'}`);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (!u.pathname.startsWith('/api/recorder/')) {
      return new Response(JSON.stringify({ error: 'test endpoint unavailable' }), { status: 503, headers: { ...corsHeaders(origin), 'content-type': 'application/json' } });
    }
    calls.push(`${req.method} ${u.pathname}${u.search}`);
    const local = new Request(`http://127.0.0.1${u.pathname.replace(/^\/api/, '')}${u.search}`, req);
    const result = await recorderRoute.fetch(local);
    const headers = new Headers(result.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    return new Response(result.body, { status: result.status, headers });
  },
});
await new Promise((resolve, reject) => {
  if (apiServer.listening) return resolve();
  apiServer.once('listening', resolve); apiServer.once('error', reject);
});
const API_PORT = apiServer.address().port;
assert.equal((await fetch(`http://127.0.0.1:${API_PORT}/api/recorder/recordings?limit=1`)).status, 200, 'temporary Recorder HTTP server reachable');
calls.length = 0; serverCalls.length = 0;

const FRONTEND_PORT = 5281;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/recorder-product-harness.jsx");mount();</script>';
const vite = await createServer({
  configFile: false, cacheDir: '.tmp/vite-rec-wire-product', plugins: [react()],
  define: { 'import.meta.env.VITE_RECORDER_SAME_ORIGIN': JSON.stringify('true') },
  optimizeDeps: { entries: ['scripts/recorder-product-harness.jsx'] },
  server: {
    watch: null, host: '127.0.0.1', port: FRONTEND_PORT, strictPort: true, hmr: false,
    proxy: { '/api/recorder': { target: `http://127.0.0.1:${API_PORT}` } },
  },
  logLevel: 'error',
});
await vite.listen();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await context.addInitScript(() => {
  localStorage.setItem('docteur.showHomeScreen', 'false');
  window.__recProduct = { displayCalls: 0, userCalls: 0, tracks: [] };
  const createScreen = () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const g = canvas.getContext('2d'); let n = 0;
    const draw = () => { g.fillStyle = `hsl(${(n * 11) % 360} 55% 35%)`; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '18px sans-serif'; g.fillText(`REC-WIRE SYNTHETIC ${n++}`, 20, 92); };
    draw(); const timer = setInterval(draw, 60);
    const stream = canvas.captureStream(15); const track = stream.getVideoTracks()[0]; const stop = track.stop.bind(track);
    track.stop = () => { clearInterval(timer); stop(); };
    window.__recProduct.tracks.push(track); return stream;
  };
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => { window.__recProduct.displayCalls++; return createScreen(); } });
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async (...args) => { window.__recProduct.userCalls++; return gum(...args); } });
});
const page = await context.newPage();
const pageErrors = []; const external = []; const requestFailures = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('requestfailed', r => requestFailures.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
await page.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { external.push(r.request().url()); return r.abort(); });
await page.route('**/__rec_wire_product', r => r.fulfill({ contentType: 'text/html', body: html }));
const until = async (fn, timeout = 20_000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return true; await page.waitForTimeout(50); } return false; };
const openRecorder = async () => {
  await page.keyboard.press('F1');
  const search = page.getByLabel('Rechercher une fonctionnalité');
  await search.waitFor(); await search.fill('Recorder');
  const row = page.locator('div').filter({ has: page.getByText('Recorder', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Ouvrir' }) }).last();
  await row.getByRole('button', { name: 'Ouvrir' }).click();
  await page.getByTestId('rec-panel').waitFor();
};

try {
  await page.goto(`http://127.0.0.1:${FRONTEND_PORT}/__rec_wire_product`);
  await page.getByText('DOCTEUR', { exact: true }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(700);
  assert.deepEqual(await page.evaluate(() => [window.__recProduct.displayCalls, window.__recProduct.userCalls]), [0, 0], 'no permission request at App load');
  assert.equal(calls.length, 0, 'Recorder backend untouched until the user opens Recorder');

  await openRecorder();
  assert.deepEqual(await page.evaluate(() => [window.__recProduct.displayCalls, window.__recProduct.userCalls]), [0, 0], 'opening Recorder only lists metadata');
  assert.ok(calls.every(c => c.startsWith('GET /api/recorder/recordings?')), calls.join(', '));
  await page.getByLabel('Titre de l’enregistrement').fill('REC-WIRE produit');
  await page.getByTestId('rec-start').focus(); await page.keyboard.press('Space');
  const recordingStarted = await until(async () => (await page.getByTestId('rec-panel').getAttribute('data-state')) === 'RECORDING');
  if (!recordingStarted) console.log('REC-WIRE diagnostic', {
    state: await page.getByTestId('rec-panel').getAttribute('data-state'),
    error: await page.getByTestId('rec-error').textContent().catch(() => null), calls, serverCalls, external, requestFailures, pageErrors,
    probe: await page.evaluate(async () => { try { const r = await fetch('/api/recorder/recordings?limit=1'); return [r.status, await r.text()]; } catch (e) { return String(e); } }),
  });
  assert.ok(recordingStarted, 'RECORDING from the real App');
  assert.equal(await page.evaluate(() => window.__recProduct.displayCalls), 1, 'one synthetic screen request after the gesture');
  assert.ok(await until(() => service.listRecordings({ limit: 1 }).items[0]?.chunkCount >= 2), 'multiple chunks reached the temporary backend');
  assert.ok(await page.evaluate(() => document.activeElement?.dataset?.testid === 'rec-stop-live'), 'focus moved to Stop');
  await page.keyboard.press('Enter');
  assert.ok(await until(async () => (await page.getByTestId('rec-panel').getAttribute('data-state')) === 'READY'), 'READY after Stop');
  const ready = service.listRecordings({ limit: 1 }).items[0];
  assert.equal(ready.status, 'READY'); assert.equal(ready.title, 'REC-WIRE produit');
  const opened = await service.openRecording(ready.recordingId, { verifyChecksum: true }); const pieces = [];
  for await (const chunk of opened.stream()) pieces.push(chunk); const original = Buffer.concat(pieces);

  const button = page.locator(`[data-testid="rec-download"][data-recording-id="${ready.recordingId}"]`).first().getByTestId('rec-download-btn');
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const saved = path.join(SAVED, download.suggestedFilename()); await download.saveAs(saved);
  assert.equal(download.suggestedFilename(), 'REC-WIRE produit.webm');
  assert.ok(fs.readFileSync(saved).equals(original), 'native browser download is byte-identical to the original');
  assert.equal(ready.mimeType.startsWith('video/webm'), true); assert.equal(ready.sizeBytes, original.length);

  // Reopen the same temporary catalogue as a backend restart would, then reopen Recorder in the real App.
  service.shutdown(); store.close(); store = RecorderStore.open({ root: ROOT }); service = createRecorderService({ store, limits: { minFreeBytes: 0 } });
  const recovery = await service.recoverAfterRestart(); recorderRoute = createRecorderRoute({ service });
  assert.equal(recovery.flagged, 0); assert.equal(service.getRecording(ready.recordingId).status, 'READY');
  await page.getByRole('button', { name: 'Fermer Recorder' }).click(); await openRecorder();
  const recent = page.locator(`[data-testid="rec-recent"] li[data-recording-id="${ready.recordingId}"]`); await recent.waitFor();
  const [afterRestart] = await Promise.all([page.waitForEvent('download'), recent.getByTestId('rec-download-btn').click()]);
  const savedAgain = path.join(SAVED, `restart-${afterRestart.suggestedFilename()}`); await afterRestart.saveAs(savedAgain);
  assert.ok(fs.readFileSync(savedAgain).equals(original), 'download remains byte-identical after restart');

  // [MASTER WS2] delete UI: two-step confirm removes the recording from the list and from the backend.
  await recent.getByTestId('rec-delete').click();
  await recent.getByTestId('rec-delete-confirm').click();
  assert.ok(await until(() => service.listRecordings({ limit: 100 }).items.every(r => r.recordingId !== ready.recordingId)), 'recording deleted from the backend');
  await page.locator(`[data-testid="rec-recent"] li[data-recording-id="${ready.recordingId}"]`).waitFor({ state: 'detached' });

  assert.equal(await page.evaluate(() => window.__recProduct.tracks.filter(t => t.readyState !== 'ended').length), 0, 'all synthetic tracks stopped');
  assert.deepEqual(external, [], 'no external network'); assert.deepEqual(pageErrors, [], 'no uncaught UI error');
  assert.deepEqual(REAL_DATA.map(fileSha), realBefore, 'real user DB unchanged');
  assert.equal(fs.existsSync(path.resolve('cortex-server', 'data', 'recordings')), false, 'no real recordings directory created');
  console.log(`PASS REC-WIRE-1 product browser: ${ready.recordingId}, ${original.length} bytes, restart + download verified`);
} finally {
  await context.close(); await browser.close(); await vite.close();
  await new Promise(resolve => apiServer.close(resolve));
  try { service.shutdown(); } catch { /* closed */ } try { store.close(); } catch { /* closed */ }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp cleanup */ }
}
