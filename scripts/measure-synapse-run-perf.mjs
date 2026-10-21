// [GAME-4] Synapse Run — frame-rate observation in real Chromium (not a pass/fail test, nothing is guaranteed).
// Runs the real game loop inside the real Arcade sandbox with the test-only autopilot keeping the run alive, then
// reports FPS, frame-time distribution, simulation steps/s, main-thread CPU (CDP Performance.TaskDuration), JS heap,
// entity counts and the WebGL renderer actually used.
// Usage: node scripts/measure-synapse-run-perf.mjs [seconds=180] [gpu|swiftshader]
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { arcadeGameBundlePlugin } from './vite-arcade-game-bundle.mjs';

const seconds = Number(process.argv[2] ?? 180);
const mode = process.argv[3] ?? 'gpu';
const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/arcade-save-harness.jsx");mount();</script>';
const args = mode === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
let browser, server;
const external = [];
try {
  server = await createServer({ configFile: false, plugins: [react(), arcadeGameBundlePlugin({ testHooks: true })], cacheDir: '.tmp/vite-synapse-run-perf', optimizeDeps: { entries: ['scripts/arcade-save-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__synapse_perf') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.origin !== origin || url.pathname.startsWith('/api/')) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await page.goto(`${origin}/__synapse_perf`);
  await page.getByTestId('arcade-launch-synapse-run').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="arcade-host"]')?.dataset.phase === 'active');
  const frame = page.frames().find(f => f.url().includes('/arcade/synapse-run/'));
  await frame.waitForFunction(() => window.__synapseRunTest?.snapshot().host === 'active');
  const gpu = await frame.evaluate(() => {
    const gl = document.querySelector('canvas')?.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) ?? null;
  });
  await frame.evaluate(() => window.__synapseRunTest.setAutopilot(20261021));
  await frame.locator('#sr-action').focus();
  await page.keyboard.press('Enter');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  await page.waitForTimeout(3000); // warm-up
  const before = await metric();
  const perfBefore = await frame.evaluate(() => window.__synapseRunTest.perf());
  const wallStart = Date.now();
  const samples = [];
  for (let t = 0; t < seconds; t += 10) {
    await page.waitForTimeout(10_000);
    const p = await frame.evaluate(() => window.__synapseRunTest.perf());
    const s = await frame.evaluate(() => window.__synapseRunTest.snapshot());
    samples.push({ t: t + 10, fps: Number(p.fps.toFixed(1)), p95: Number(p.p95.toFixed(1)), status: s.status, distance: Math.floor(s.distance), entities: p.entities, heapMB: p.heapBytes ? Number((p.heapBytes / 1048576).toFixed(1)) : null });
  }
  const wallS = (Date.now() - wallStart) / 1000;
  const after = await metric();
  const perf = await frame.evaluate(() => window.__synapseRunTest.perf());
  const snap = await frame.evaluate(() => window.__synapseRunTest.snapshot());
  const result = {
    mode, seconds: Number(wallS.toFixed(1)), webglRenderer: gpu, viewport: perf.view ? { width: perf.view.width, height: perf.view.height, pixelRatio: perf.view.pixelRatio } : null,
    fps: Number(perf.fps.toFixed(1)), frameMs: { mean: Number(perf.meanMs.toFixed(2)), p50: Number(perf.p50.toFixed(2)), p95: Number(perf.p95.toFixed(2)), p99: Number(perf.p99.toFixed(2)), max: Number(perf.maxMs.toFixed(2)), lastSamples: perf.samples },
    simStepsPerSecond: Number(((perf.steps - perfBefore.steps) / wallS).toFixed(1)), droppedTicks: perf.dropped,
    mainThreadCpuPercent: Number((((after.TaskDuration - before.TaskDuration) / wallS) * 100).toFixed(1)),
    scriptCpuPercent: Number((((after.ScriptDuration - before.ScriptDuration) / wallS) * 100).toFixed(1)),
    jsHeapMB: { start: Number((before.JSHeapUsedSize / 1048576).toFixed(1)), end: Number((after.JSHeapUsedSize / 1048576).toFixed(1)) },
    drawCalls: perf.view?.calls ?? null, triangles: perf.view?.triangles ?? null, geometries: perf.view?.geometries ?? null,
    run: { status: snap.status, distance: Math.floor(snap.distance), shards: snap.shardsCollected }, samples, externalRequests: external.length,
  };
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync(`.tmp/synapse-run-perf-${mode}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close(); await server?.close();
}
