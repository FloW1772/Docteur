// [LOAD-1/LOAD-2] Boot screen in Chromium with a deterministic fake clock (page.clock) — no real 15 s / 120 s waits.
//   A  backend already ready → the app replaces the screen, mounted exactly once (StrictMode, like main.tsx)
//   B  ready after several refused probes → WAITING ("Connexion au serveur en cours…") then the app
//   C  slower than expected → DELAYED message + offline copy, polling continues, no Retry yet
//   D  never ready → FAILED (alert, reason, Retry, offline copy), polling stops
//   E  Retry after FAILED (keyboard) → readiness checked again → app
//   F  a stale late answer (timed-out probe released after READY) never replaces the app
//   G  unmount → no further probe, no timer
//   H  the page only talks to the local ping (every other request aborted and counted)
//   I  desktop and narrow (360 px) layouts: no horizontal overflow, actions visible
//   J  accessibility: status / alert roles, aria-busy, heading, decorative logo, focus, reduced motion
//   K  unexpected HTTP answer is reported safely; offline copy opens the app and stops polling
// Usage: node scripts/test-startup-screen-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let assertions = 0; const results = [];
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const PORT = 5278;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PING = 'http://127.0.0.1:3001/api/ping';
const T = {
  waiting: 'Connexion au serveur en cours…',
  delayed: 'Docteur met plus de temps que prévu à démarrer.',
  failed: 'Le serveur local de Docteur ne répond pas.',
};

const HARNESS_HTML = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/startup-screen-harness.jsx");mount();</script></body></html>';
const harnessPage = { name: 'load-harness-page', configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url === '/__load') { res.setHeader('content-type', 'text/html'); res.end(HARNESS_HTML); } else next(); }); } };
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-load', plugins: [react(), harnessPage], optimizeDeps: { entries: ['scripts/startup-screen-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
let externalAborted = 0;

/**
 * A fresh page with a fake clock and a ping stub. `answer(n)` decides the n-th ping: 'refuse' | 'ready' |
 * { status, body } | 'hold' (kept pending until released).
 */
async function openPage(answer, { viewport = { width: 1280, height: 800 }, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // the browser itself logs every refused / failed ping ("Failed to load resource") — expected while the server is down
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  const pings = { count: 0, held: [] };
  await page.clock.install();
  await page.route(() => true, async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === ORIGIN) return route.continue();
    if (u.href !== PING) { externalAborted += 1; return route.abort(); }
    pings.count += 1;
    const a = answer(pings.count);
    const fulfill = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': ORIGIN }, body: JSON.stringify(body) }).catch(() => {});
    if (a === 'refuse') return route.abort('connectionrefused').catch(() => {});
    if (a === 'ready') return fulfill(200, { ok: true });
    if (a === 'hold') { await new Promise((release) => pings.held.push(release)); return fulfill(200, { ok: false, late: true }); }
    return fulfill(a.status, a.body);
  });
  await page.goto(`${ORIGIN}/__load`);
  return { page, context, pings, errors };
}
const phase = (page) => page.getByTestId('startup-screen').getAttribute('data-phase', { timeout: 2000 }).catch(() => null);
const appShown = (page) => page.getByTestId('fake-app').waitFor({ timeout: 10_000 });
/** Moves the fake clock in steps, letting the probes run, until `done()` or `maxMs` of fake time. */
async function advanceUntil(page, done, { stepMs = 1000, maxMs = 200_000 } = {}) {
  for (let t = 0; t <= maxMs; t += stepMs) {
    if (await done()) return true;
    await page.clock.fastForward(stepMs);
    await page.waitForTimeout(15);
  }
  return done();
}
async function scenario(name, fn) {
  const t = Date.now();
  try { await fn(); } catch (e) { console.error(`✖ ${name}`); throw e; }
  results.push(`✔ ${name} (${Date.now() - t} ms)`);
}

try {
  await scenario('A. backend already ready: the app replaces the screen and is mounted exactly once', async () => {
    const { page, context, errors } = await openPage(() => 'ready');
    await appShown(page);
    eq(await page.getByTestId('startup-screen').count(), 0, 'no startup overlay left behind');
    eq(await page.getByTestId('fake-app').count(), 1, 'one app in the DOM');
    eq(await page.evaluate(() => window.__appNet), 1, 'net app mounts = 1 (StrictMode)');
    await page.clock.fastForward(300_000);
    await page.waitForTimeout(50);
    eq(await page.getByTestId('fake-app').count(), 1, 'nothing replaces READY later');
    eq(errors.length, 0, errors.join(' | '));
    await context.close();
  });

  await scenario('B. ready after several refused probes: WAITING status ("Connexion au serveur en cours…"), then the app', async () => {
    const { page, context, pings } = await openPage((n) => (n <= 3 ? 'refuse' : 'ready'));
    const status = page.getByRole('status').filter({ hasText: 'Connexion au serveur en cours' });
    await status.waitFor();
    eq(await phase(page), 'WAITING');
    ok(await page.getByText('Serveur local : en attente').isVisible(), 'real step shown');
    ok(await page.getByText('Interface : chargée').isVisible());
    await advanceUntil(page, async () => (await page.getByTestId('fake-app').count()) === 1);
    await appShown(page);
    eq(await page.getByTestId('startup-screen').count(), 0);
    ok(pings.count >= 4, `several probes (${pings.count})`);
    await context.close();
  });

  await scenario('C. slower than expected: DELAYED message and offline copy after 15 s, polling continues, no Retry yet', async () => {
    const { page, context, pings } = await openPage(() => 'refuse');
    await page.getByRole('status').filter({ hasText: 'Connexion au serveur en cours' }).waitFor();
    ok(await advanceUntil(page, async () => (await phase(page)) === 'DELAYED', { maxMs: 30_000 }), 'DELAYED reached');
    ok(await page.getByRole('status').filter({ hasText: T.delayed }).isVisible(), 'calm delayed message');
    ok(await page.getByRole('button', { name: 'Ouvrir la copie hors ligne' }).isVisible());
    eq(await page.getByRole('button', { name: 'Réessayer' }).count(), 0, 'no Retry while still checking');
    eq(await page.getByRole('alert').count(), 0, 'not presented as a failure');
    const before = pings.count;
    await advanceUntil(page, async () => pings.count > before + 1, { maxMs: 20_000 });
    ok(pings.count > before + 1, 'polling continues in DELAYED');
    const meta = await page.locator('.dl-loading-meta').innerText();
    ok(/\d+ s/.test(meta) && !/%/.test(meta), `elapsed time, no percentage (${meta})`);
    await context.close();
  });

  let failedPage;
  await scenario('D. never ready: FAILED after the 120 s budget — alert, reason, Retry, offline copy; polling stops', async () => {
    const { page, context, pings, errors } = await openPage(() => 'refuse');
    ok(await advanceUntil(page, async () => (await phase(page)) === 'FAILED', { stepMs: 5000, maxMs: 200_000 }), 'FAILED reached');
    const alert = page.getByRole('alert');
    ok((await alert.innerText()).includes(T.failed));
    ok((await alert.innerText()).includes('Aucune connexion au serveur local.'), 'safe reason');
    ok(/s’est arrêtée après (1[2-9]\d|2\d\d) s/.test(await alert.innerText()), 'states when automatic checking stopped');
    ok(await page.getByRole('button', { name: 'Réessayer' }).isVisible());
    ok(await page.getByRole('button', { name: 'Ouvrir la copie hors ligne' }).isVisible());
    eq(await page.getByTestId('startup-step-server').getAttribute('data-state'), 'failed');
    eq(await page.getByTestId('startup-screen').getAttribute('aria-busy'), 'false');
    const body = await page.locator('body').innerText();
    ok(!/[A-Z]:\\|\/Users\/|stack|Error:|at \w+ \(|token|secret|https?:\/\//i.test(body), 'no path / stack / secret / URL shown');
    const before = pings.count;
    await page.clock.fastForward(120_000);
    await page.waitForTimeout(50);
    eq(pings.count, before, 'no probe after FAILED');
    eq(errors.length, 0, errors.join(' | '));
    failedPage = { page, context, pings };
  });

  await scenario('E. Retry (keyboard) re-runs the readiness check and reaches the app', async () => {
    const { page, context, pings } = failedPage;
    const before = pings.count;
    const retry = page.getByRole('button', { name: 'Réessayer' });
    await retry.focus();
    eq(await page.evaluate(() => document.activeElement?.textContent), 'Réessayer', 'Retry is focusable');
    // the next probe succeeds
    await page.unroute(() => true);
    await page.route(() => true, (route) => {
      const u = new URL(route.request().url());
      if (u.origin === ORIGIN) return route.continue();
      if (u.href !== PING) { externalAborted += 1; return route.abort(); }
      pings.count += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': ORIGIN }, body: '{"ok":true}' });
    });
    await page.keyboard.press('Enter');
    await appShown(page);
    eq(pings.count, before + 1, 'exactly one new readiness check');
    eq(await page.evaluate(() => window.__appNet), 1);
    await context.close();
  });

  await scenario('F. stale answer: a timed-out probe released after READY never replaces the app', async () => {
    const { page, context, pings } = await openPage((n) => (n === 1 ? 'hold' : 'ready'));
    await advanceUntil(page, async () => pings.held.length === 1, { maxMs: 5000 });
    // StrictMode's first mount is aborted on cleanup; the held request belongs to the live run → its 2 s timeout fires
    await advanceUntil(page, async () => (await page.getByTestId('fake-app').count()) === 1, { maxMs: 20_000 });
    await appShown(page);
    for (const release of pings.held) release();
    await page.waitForTimeout(100);
    await page.clock.fastForward(300_000);
    await page.waitForTimeout(50);
    eq(await page.getByTestId('fake-app').count(), 1, 'app still shown');
    eq(await page.getByTestId('startup-screen').count(), 0, 'screen not resurrected');
    eq(await page.evaluate(() => window.__appNet), 1);
    await context.close();
  });

  await scenario('G. unmount while waiting: no further probe and no timer firing afterwards', async () => {
    const { page, context, pings, errors } = await openPage(() => 'refuse');
    await page.getByRole('status').filter({ hasText: 'Connexion au serveur en cours' }).waitFor();
    await page.evaluate(() => window.__unmountGate());
    const before = pings.count;
    await page.clock.fastForward(300_000);
    await page.waitForTimeout(50);
    eq(pings.count, before, 'polling stopped with the component');
    eq(errors.length, 0, errors.join(' | '));
    await context.close();
  });

  await scenario('I. responsive: desktop 1280 px and narrow 360 px — no horizontal overflow, actions reachable', async () => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 740 }]) {
      const { page, context } = await openPage(() => 'refuse', { viewport });
      await advanceUntil(page, async () => (await phase(page)) === 'FAILED', { stepMs: 5000, maxMs: 200_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      eq(overflow, 0, `no horizontal scroll at ${viewport.width}px`);
      for (const name of ['Réessayer', 'Ouvrir la copie hors ligne']) {
        const box = await page.getByRole('button', { name }).boundingBox();
        ok(box && box.x >= 0 && box.x + box.width <= viewport.width && box.height >= 36, `${name} inside the viewport at ${viewport.width}px`);
      }
      const card = await page.locator('.startup-card').boundingBox();
      ok(card.x >= 15 && card.x + card.width <= viewport.width - 15, `card keeps a side gutter at ${viewport.width}px`);
      await page.screenshot({ path: `.tmp/startup-${viewport.width}.png` });
      await context.close();
    }
  });

  await scenario('J. accessibility: roles, heading, decorative logo, aria-busy, reduced motion freezes the spinner (text stays)', async () => {
    const { page, context } = await openPage(() => 'refuse', { reducedMotion: 'reduce' });
    const status = page.getByRole('status').filter({ hasText: 'Connexion au serveur en cours' });
    await status.waitFor();
    eq(await status.getAttribute('aria-live'), 'polite', 'polite live region');
    eq(await page.locator('.dl-loading-meta').getAttribute('aria-live'), 'off', 'ticking time is not announced');
    eq(await page.getByRole('heading', { level: 1 }).innerText(), 'Docteur');
    eq(await page.locator('.startup-logo').getAttribute('alt'), '', 'logo is decorative');
    eq(await page.getByTestId('startup-screen').getAttribute('aria-busy'), 'true');
    eq(await page.getByRole('list', { name: 'État du démarrage' }).count(), 1, 'steps announced as text, not only by colour');
    const anim = await page.locator('.startup .dl-spinner').evaluate((el) => getComputedStyle(el).animationName);
    eq(anim, 'none', 'spinner frozen under prefers-reduced-motion');
    await context.close();
  });

  await scenario('K. unexpected HTTP answer is reported safely; offline copy opens the app and stops polling', async () => {
    const { page, context, pings } = await openPage(() => ({ status: 503, body: { error: 'C:\\Users\\x\\secret.db at foo (bar.js:1)' } }));
    await advanceUntil(page, async () => (await phase(page)) === 'DELAYED', { maxMs: 30_000 });
    await page.getByText('Détails techniques').click();
    ok(await page.getByText('Le serveur local a répondu de façon inattendue (HTTP 503).').first().isVisible(), 'status code only');
    ok(!(await page.locator('body').innerText()).includes('secret.db'), 'server body never displayed');
    await page.getByRole('button', { name: 'Ouvrir la copie hors ligne' }).click();
    await appShown(page);
    const before = pings.count;
    await page.clock.fastForward(300_000);
    await page.waitForTimeout(50);
    eq(pings.count, before, 'no probe after opening the offline copy');
    eq(await page.evaluate(() => window.__appNet), 1);
    await context.close();
  });

  await scenario('H. loopback only: no request left the page for anything but the local ping', async () => {
    eq(externalAborted, 0, 'no external request');
  });
} finally {
  await browser.close();
  await server.close();
}
for (const r of results) console.log(r);
console.log(`STARTUP SCREEN BROWSER: ${results.length} scenarios, ${assertions} assertions — PASS`);
