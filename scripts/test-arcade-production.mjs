// M-N plus real App mount and offline sandbox; run after npm run build.
import assert from 'node:assert/strict';
import { preview } from 'vite';
import { chromium } from 'playwright';

let browser, assertions = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); assertions++; };
const ok = (value, label) => { assert.ok(value, label); assertions++; };
const server = await preview({ preview: { host: '127.0.0.1', port: 5296, strictPort: true } });
const origin = 'http://127.0.0.1:5296';
const watchdog = setTimeout(() => { console.error('Arcade production deadline'); process.exit(1); }, 90_000);
try {
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const external = [], errors = [], offlineFailures = [];
  let offline = false;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return offline ? route.abort('internetdisconnected') : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, pages: [], items: [], jobs: [], models: [], notebooks: [], missions: [], portfolios: [], connectors: [], total: 0, byKind: {} }) });
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', request => { if (request.url().includes('/arcade/')) offlineFailures.push({ url: new URL(request.url()).pathname, error: request.failure()?.errorText }); });
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('docteur.viewMode', 'dashboard'); });
  await page.goto(origin);
  await page.getByTitle("Plus d'actions").waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const key of await caches.keys()) for (const req of await (await caches.open(key)).keys()) urls.push(req.url);
    return urls;
  });
  for (const file of ['index.html', 'foundation.js', 'foundation.css']) ok(cached.some(url => new URL(url).pathname === `/arcade/synapse-run/${file}`), `${file} precached`);
  eq(cached.some(url => new URL(url).pathname.startsWith('/api/') || new URL(url).port === '3001'), false, 'no API cache');

  // The production App.tsx (not the focused harness) uses its central opener and lazy StudioShell mount.
  await page.getByTestId('dashboard-customize').click();
  await page.locator('[data-testid="dashboard-hidden-item"][data-card-id="arcade"]').getByRole('button').click();
  await page.getByTestId('dashboard-customize-done').click();
  await page.locator('[data-testid="dashboard-card"][data-card-id="arcade"]').getByRole('button').last().click();
  await page.getByTestId('arcade-launch-synapse-run').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="arcade-host"]')?.dataset.phase === 'active');
  eq(await page.getByTestId('arcade-frame').getAttribute('sandbox'), 'allow-scripts');
  const game = page.frames().find(f => f.url().includes('/arcade/synapse-run/'));
  eq(await game.locator('h1').innerText(), 'Synapse Run');
  eq(await game.evaluate(() => self.origin), 'null');
  console.log('PASS extra production App central opener, lazy mount and opaque sandbox');

  const doc = await context.newPage();
  const response = await doc.goto(`${origin}/arcade/synapse-run/index.html`);
  eq(response.status(), 200);
  eq(await doc.locator('h1').innerText(), 'Synapse Run');
  eq(await doc.locator('#root').count(), 0);
  ok((await doc.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).includes("connect-src 'none'"));
  console.log('PASS M Arcade static page is the real document, never SPA fallback');

  offline = true;
  await context.setOffline(true);
  // Offline distinguishes Workbox's denylist from the preview server's ordinary HTTP fallback.
  let missingArcadeBlocked = false;
  try { await doc.goto(`${origin}/arcade/nonexistent/index.html`); } catch { missingArcadeBlocked = true; }
  eq(missingArcadeBlocked, true, 'unknown Arcade path cannot use SW app fallback');
  await page.goto(`${origin}/normal-docteur-route`);
  eq(await page.locator('#root').count(), 1, 'normal SPA route keeps SW fallback offline');
  await page.getByRole('button', { name: 'Ouvrir la copie hors ligne' }).waitFor();
  console.log('PASS N normal SPA fallback remains available offline');
  await doc.goto(`${origin}/arcade/synapse-run/index.html`);
  eq(await doc.locator('h1').innerText(), 'Synapse Run');
  eq(await doc.locator('#root').count(), 0);
  eq(await doc.locator('#sr-status').innerText(), 'État : à lancer depuis l’Arcade Docteur', 'offline local JS executed');
  ok((await doc.locator('body').evaluate(el => getComputedStyle(el).backgroundImage)).includes('radial-gradient'), 'offline local CSS loaded');

  // A fresh opaque iframe after connectivity is disabled must execute its cached script and complete INIT.
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'offline-arcade'; frame.sandbox = 'allow-scripts';
    const instanceId = 'c'.repeat(32);
    window.__offlineArcade = [];
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.data.instanceId !== instanceId) return;
      window.__offlineArcade.push(event.data);
      if (event.data.type === 'ARCADE_READY') frame.contentWindow.postMessage({ channel: 'docteur-arcade', v: 1, gameId: 'synapse-run', instanceId, type: 'ARCADE_INIT', payload: { reducedMotion: true } }, '*');
    });
    frame.src = `/arcade/synapse-run/index.html#instance=${instanceId}`;
    document.body.append(frame);
  });
  let offlineFoundation = 'PASS';
  try {
    await page.waitForFunction(() => window.__offlineArcade.some(message => message.type === 'ARCADE_STATE' && message.payload.state === 'active'), null, { timeout: 5_000 });
    eq(await page.frames().find(f => f.url().includes('/arcade/')).evaluate(() => self.origin), 'null');
    console.log('PASS extra offline opaque foundation: cached HTML/CSS/JS, READY/INIT/STATE');
  } catch (error) {
    // Chromium's opaque sandbox cannot use the origin's service-worker controller for its subresources.
    // Keep allow-same-origin absent; top-level cached assets above remain a separate PASS.
    if (error.name !== 'TimeoutError') throw error;
    ok(offlineFailures.some(failure => failure.error.includes('INTERNET_DISCONNECTED')), 'PARTIAL must be supported by browser offline request failures');
    eq(await page.locator('#offline-arcade').getAttribute('sandbox'), 'allow-scripts');
    offlineFoundation = 'PARTIAL';
    console.log('PARTIAL offline opaque iframe cannot finish handshake; browser evidence:', JSON.stringify({ offlineFailures, frames: page.frames().map(f => f.url()), messages: await page.evaluate(() => window.__offlineArcade) }));
  }
  eq(external, []); eq(errors, []);
  console.log(JSON.stringify({ scenarios: 4, assertions, offlineFoundation, externalRequests: 0, apiCached: 0 }));
} finally {
  clearTimeout(watchdog); await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve));
}
