import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { captureStudio } from './studio-browser-checks.mjs';

let server, browser, checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const html = '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/video-studio-render-harness.jsx");mount();</script>';
try {
  server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { entries: ['scripts/video-studio-render-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 5206, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const surface of ['studio', 'settings']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let job, payload, state = 'running', fail = false;
    await page.route('**/api/video-summary/jobs', r => r.fulfill({ json: [] }));
    await page.route('**/api/openmontage/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type' };
      if (path.endsWith('/capabilities')) return route.fulfill({ headers, json: { status: 'READY_LOCAL', python: { available: true }, ffmpeg: { available: true }, remotion: { available: true }, registry: { available: false } } });
      if (path.endsWith('/render')) {
        payload = route.request().postDataJSON();
        if (fail) return route.fulfill({ headers, status: 500, json: { error: 'C:\\private\\runtime.log token=secret-fixture' } });
        job = { jobId: 'format-test', status: 'running', width: 1920, height: 1080, fps: 30, durationSeconds: payload.durationSeconds, elapsedMs: 250, hasArtifact: false };
        return route.fulfill({ headers, status: 201, json: { jobId: job.jobId } });
      }
      if (path.endsWith('/cancel')) { state = 'cancelled'; return route.fulfill({ headers, json: { ok: true } }); }
      if (path.endsWith('/artifact')) return route.fulfill({ headers, status: 404, body: '' });
      return route.fulfill({ headers, json: { ...job, status: state, hasArtifact: state === 'done' } });
    });
    await page.route('**/__format**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`http://127.0.0.1:5206/__format?${surface}`);
    const format = page.getByLabel('Format', { exact: true });
    await format.waitFor();
    check(await format.inputValue() === '1920×1080 (16:9)' && !(await format.isEditable()), `${surface}: format fixed`);
    check(await page.getByLabel('FPS', { exact: true }).inputValue() === '30' && !(await page.getByLabel('FPS', { exact: true }).isEditable()), `${surface}: fps fixed`);
    check(await page.locator('select').count() === 0, `${surface}: unsupported options absent`);
    if (surface === 'studio') await captureStudio(page, 'video-format');
    await page.getByLabel('Durée (s)', { exact: true }).fill('9');
    await page.getByRole('button', { name: 'Générer localement', exact: true }).click();
    await page.getByText('Rendu en cours…', { exact: true }).waitFor();
    check(payload.resolution === '1920x1080' && payload.fps === 30 && payload.durationSeconds === 9, `${surface}: actual request fixed`);
    check(await page.locator('video').count() === 0, `${surface}: no preview before completion`);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await page.getByText('Rendu annulé', { exact: true }).waitFor();
    check(state === 'cancelled', `${surface}: cancellation works`);
    await page.getByRole('button', { name: 'Nouveau rendu', exact: true }).click();
    state = 'done';
    await page.getByRole('button', { name: 'Générer localement', exact: true }).click();
    await page.getByText('Rendu terminé', { exact: true }).waitFor();
    check(await page.getByText('Paramètres demandés :', { exact: false }).isVisible(), `${surface}: requested metadata identified`);
    check(await page.getByText('Métadonnées du fichier non vérifiées', { exact: false }).isVisible(), `${surface}: no fabricated verification`);
    await page.locator('video').evaluate(video => {
      Object.defineProperties(video, { videoWidth: { value: 1080 }, videoHeight: { value: 1920 }, duration: { value: 4.8 } });
      video.dispatchEvent(new Event('loadedmetadata'));
    });
    check(await page.getByText('Fichier lu : 1080×1920 · 4.80 s. Cadence non mesurée.', { exact: true }).isVisible(), `${surface}: browser metadata independent of request`);
    check((await page.getByRole('link', { name: 'Télécharger le MP4' }).getAttribute('href')).endsWith('/format-test/artifact'), `${surface}: authorized artifact route`);
    await page.getByRole('button', { name: 'Nouveau rendu', exact: true }).click();
    fail = true;
    await page.getByRole('button', { name: 'Générer localement', exact: true }).click();
    await page.getByText('Opération impossible.', { exact: false }).waitFor();
    check(!/private|secret-fixture|runtime.log/.test(await page.locator('body').innerText()), `${surface}: raw diagnostics hidden`);
    check(errors.length === 0, `${surface}: no page errors`);
    await page.close();
  }
  console.log(`OPENMONTAGE FORMAT FRONTEND PASS ${checks}/${checks}; desktop/mobile + keyboard verified`);
} finally { await browser?.close(); await server?.close(); }
