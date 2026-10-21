// A-L, O-P; M-N are exercised against the built service worker by test-arcade-production.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server, assertions = 0;
const scenarios = [];
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };
const ok = (value, label) => { assert.ok(value, label); assertions++; };
const scenario = async (name, run) => { await run(); scenarios.push(name); console.log(`PASS ${name}`); };
const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/arcade-harness.jsx");mount();</script>';
const network = { requests: [], responses: [], failed: [], routedProbes: [], unexpectedGameRequests: [] };
const watchdog = setTimeout(() => { console.error('Arcade browser deadline'); process.exit(1); }, 120_000);
try {
  server = await createServer({ configFile: false, plugins: [react()], cacheDir: '.tmp/vite-arcade-tests', optimizeDeps: { entries: ['scripts/arcade-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const category = request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) return 'api';
    if (url.origin !== origin) return 'external';
    return url.pathname.startsWith('/arcade/') ? 'sandbox-assets' : 'harness-assets';
  };
  const fromGame = request => { try { return request.frame().parentFrame() !== null; } catch { return false; } };
  page.on('request', request => network.requests.push({ url: request.url(), category: category(request), fromGame: fromGame(request) }));
  page.on('response', response => network.responses.push({ url: response.url(), category: category(response.request()), fromGame: fromGame(response.request()), status: response.status() }));
  page.on('requestfailed', request => network.failed.push({ url: request.url(), error: request.failure()?.errorText }));
  await context.addInitScript(() => {
    if (window !== window.top) return;
    const listeners = new Set(), timers = new Set();
    const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, fn, options) => { if (type === 'message') listeners.add(fn); return add(type, fn, options); };
    window.removeEventListener = (type, fn, options) => { if (type === 'message') listeners.delete(fn); return remove(type, fn, options); };
    const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => { const token = set(() => { timers.delete(token); fn(...args); }, ms); if (ms === 10_000) timers.add(token); return token; };
    window.clearTimeout = token => { timers.delete(token); return clear(token); };
    window.__arcadeResources = () => ({ listeners: listeners.size, timers: timers.size });
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (fromGame(request) && (url.origin !== origin || !/^\/arcade\/synapse-run\/(index\.html|foundation\.(js|css))$/.test(url.pathname))) {
      network.unexpectedGameRequests.push(url.href); return route.abort('blockedbyclient');
    }
    if (url.pathname === '/__arcade_test') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname.includes('arcade-probe') || url.origin !== origin && !url.pathname.startsWith('/api/')) {
      network.routedProbes.push(url.href); return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, missions: [], portfolios: [], connectors: [], status: 'READY_LOCAL' }) });
    return route.continue();
  });
  await page.goto(`${origin}/__arcade_test`);
  const resources = () => page.evaluate(() => window.__arcadeResources());
  const host = () => page.getByTestId('arcade-host');
  const phase = () => host().getAttribute('data-phase');
  const waitPhase = value => page.waitForFunction(value => document.querySelector('[data-testid="arcade-host"]')?.dataset.phase === value, value);
  const frame = () => page.frames().find(f => f.url().includes('/arcade/synapse-run/'));
  const launch = async () => { await page.getByTestId('arcade-launch-synapse-run').click(); await waitPhase('active'); };
  let baseline, oldId;

  await scenario('A opt-in, existing Dashboard and Help openers', async () => {
    await page.getByTestId('dashboard-customize').waitFor();
    eq(await page.locator('[data-testid="dashboard-card"][data-card-id="arcade"]').count(), 0);
    await page.getByTestId('dashboard-customize').click();
    const hidden = page.locator('[data-testid="dashboard-hidden-item"][data-card-id="arcade"]');
    await hidden.getByRole('button').click();
    await page.getByTestId('dashboard-customize-done').click();
    await page.locator('[data-testid="dashboard-card"][data-card-id="arcade"]').getByRole('button').last().click();
    await page.getByTestId('arcade-panel').waitFor();
    eq(await page.getByTestId('opened-log').innerText(), 'arcade');
    await page.getByRole('button', { name: 'Fermer Arcade', exact: true }).click();
    await page.getByTestId('open-help').click();
    await page.getByRole('textbox').fill('Synapse Run');
    await page.locator('.modal-box').getByRole('button', { name: 'Ouvrir', exact: true }).click();
    await page.getByTestId('arcade-panel').waitFor();
    ok((await page.getByTestId('arcade-panel').innerText()).includes('optionnelle'));
  });
  await scenario('B fixed registry foundation only', async () => {
    eq(await page.getByTestId('arcade-game-list').locator('li').count(), 1);
    eq(await page.getByTestId('arcade-game-synapse-run').getAttribute('data-status'), 'FOUNDATION_ONLY');
    ok((await page.getByTestId('arcade-game-list').innerText()).includes('GAME-4'));
    baseline = await resources();
  });
  await scenario('C actual sandbox foundation and pause/resume', async () => {
    await launch();
    eq(await page.getByTestId('arcade-frame').count(), 1);
    eq(await frame().locator('h1').innerText(), 'Synapse Run');
    eq(await frame().locator('html').getAttribute('data-state'), 'active');
    await page.getByTestId('arcade-pause-toggle').click(); await waitPhase('paused');
    eq(await frame().locator('html').getAttribute('data-state'), 'paused');
    await page.getByTestId('arcade-pause-toggle').click(); await waitPhase('active');
    eq((await resources()).listeners, baseline.listeners + 1);
    eq((await resources()).timers, baseline.timers);
  });
  await scenario('D opaque origin, scripts only', async () => {
    eq(await page.getByTestId('arcade-frame').getAttribute('sandbox'), 'allow-scripts');
    eq(await frame().evaluate(() => self.origin), 'null');
  });
  await scenario('E parent DOM and application state unreadable', async () => {
    const result = await frame().evaluate(() => {
      const read = fn => { try { return fn(); } catch (e) { return e.name; } };
      return [read(() => parent.document.querySelector('[data-testid="parent-secret"]').textContent), read(() => parent.__arcadeSyntheticState.secret)];
    });
    eq(result, ['SecurityError', 'SecurityError']);
  });
  await scenario('F parent storage/cookies and own origin storage unreadable', async () => {
    eq(await page.evaluate(() => [localStorage.getItem('docteur.arcade-test-secret'), sessionStorage.getItem('docteur.arcade-test-secret'), document.cookie.includes('PARENT-COOKIE-SECRET')]), ['PARENT-LS-SECRET-91c2', 'PARENT-SS-SECRET-44ab', true]);
    const result = await frame().evaluate(() => {
      const read = fn => { try { return fn(); } catch (e) { return e.name; } };
      return [read(() => parent.localStorage.getItem('docteur.arcade-test-secret')), read(() => parent.sessionStorage.getItem('docteur.arcade-test-secret')), read(() => parent.document.cookie), read(() => localStorage.length), read(() => sessionStorage.length), read(() => document.cookie), read(() => indexedDB.open('arcade-probe'))];
    });
    eq(result, Array(7).fill('SecurityError'));
  });
  async function probes(url) {
    return frame().evaluate(async url => {
      const violations = [];
      const listener = e => violations.push(e.effectiveDirective);
      document.addEventListener('securitypolicyviolation', listener);
      const result = [];
      for (const mode of ['cors', 'no-cors']) { try { await fetch(url, { mode }); result.push('SUCCESS'); } catch { result.push('BLOCKED'); } }
      result.push(await new Promise(resolve => { const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.onload = () => resolve('SUCCESS'); xhr.onerror = () => resolve('BLOCKED'); xhr.send(); }));
      try { result.push(navigator.sendBeacon(url, 'synthetic') ? 'BEACON_QUEUED' : 'BEACON_REFUSED'); } catch { result.push('BEACON_REFUSED'); }
      await new Promise(resolve => setTimeout(resolve, 30));
      document.removeEventListener('securitypolicyviolation', listener);
      return { result, violations };
    }, url);
  }
  await scenario('G loopback API blocked by browser CSP', async () => {
    const result = await probes('http://127.0.0.1:3001/api/arcade-probe');
    eq(result.result.slice(0, 3), ['BLOCKED', 'BLOCKED', 'BLOCKED']);
    ok(result.violations.length >= 4 && result.violations.every(v => v === 'connect-src'));
    eq(network.routedProbes, []);
  });
  await scenario('H external fetch/XHR/beacon blocked by browser CSP', async () => {
    const result = await probes('https://arcade-probe.invalid/probe');
    eq(result.result.slice(0, 3), ['BLOCKED', 'BLOCKED', 'BLOCKED']);
    ok(result.violations.length >= 4 && result.violations.every(v => v === 'connect-src'));
    eq(network.routedProbes, []);
  });
  const envelope = async (changes = {}) => ({ channel: 'docteur-arcade', v: 1, gameId: 'synapse-run', instanceId: await frame().evaluate(() => location.hash.slice('#instance='.length)), type: 'ARCADE_STATE', payload: { state: 'paused' }, ...changes });
  async function rejected(data, source = 'frame') {
    const dropped = Number(await host().getAttribute('data-dropped-messages') || 0);
    if (source === 'frame') await frame().evaluate(data => parent.postMessage(data, '*'), data);
    else await page.evaluate(({ data, source }) => { if (source === 'old') window.dispatchEvent(new MessageEvent('message', { data, source: window.__oldArcadeWindow })); else window.postMessage(data, '*'); }, { data, source });
    await page.waitForFunction(n => Number(document.querySelector('[data-testid="arcade-host"]')?.dataset.droppedMessages) > n, dropped);
    eq(await phase(), 'active');
  }
  await scenario('I exact live iframe source required', async () => { await rejected(await envelope(), 'unrelated'); });
  await scenario('J exact schema, game and instance required', async () => {
    for (const change of [{ type: 'EXECUTE' }, { payload: { state: 'paused', extra: true } }, { gameId: 'other' }, { instanceId: 'b'.repeat(32) }, { channel: 'other' }, { v: 2 }, { extra: true }, { payload: null }]) await rejected(await envelope(change));
  });
  await scenario('K stop/unmount clean listener, timer, iframe', async () => {
    oldId = (await envelope()).instanceId;
    await page.evaluate(() => { window.__oldArcadeWindow = document.querySelector('[data-testid="arcade-frame"]').contentWindow; });
    await page.getByTestId('arcade-stop').click();
    eq(await page.getByTestId('arcade-frame').count(), 0);
    eq(await resources(), baseline);
    await launch();
    await page.getByRole('button', { name: 'Fermer Arcade', exact: true }).click();
    eq(await page.getByTestId('arcade-frame').count(), 0);
    eq(await resources(), baseline);
    await page.locator('[data-testid="dashboard-card"][data-card-id="arcade"]').getByRole('button').last().click();
    await launch();
  });
  await scenario('L old window and old instance ignored after relaunch', async () => {
    ok((await envelope()).instanceId !== oldId);
    await rejected(await envelope({ instanceId: oldId }));
    await rejected(await envelope(), 'old');
    eq((await resources()).listeners, baseline.listeners + 1);
  });
  await scenario('O 360px host and frame have no horizontal overflow', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    ok(await page.getByTestId('arcade-panel').evaluate(el => el.scrollWidth <= el.clientWidth));
    ok(await frame().evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
  await scenario('P keyboard pause/resume, stop and focus restoration', async () => {
    const toggle = page.getByTestId('arcade-pause-toggle');
    await toggle.focus(); await page.keyboard.press('Space'); await waitPhase('paused');
    eq(await toggle.getAttribute('aria-pressed'), 'true');
    eq(await toggle.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter'); await waitPhase('active');
    await page.keyboard.press('Tab');
    eq(await page.getByTestId('arcade-stop').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.getByTestId('arcade-launch-synapse-run').waitFor();
    eq(await page.getByTestId('arcade-launch-synapse-run').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter'); await waitPhase('active');
    eq(await page.locator('#arc-host-title').evaluate(el => el === document.activeElement), true);
  });
  await scenario('extra replaced navigation fails closed and removes resources', async () => {
    await frame().evaluate(() => { location.href = 'about:blank'; });
    await waitPhase('error');
    eq(await page.getByTestId('arcade-frame').count(), 0);
    eq(await resources(), baseline);
  });
  await scenario('extra ready timeout fails closed and removes resources', async () => {
    await page.getByTestId('arcade-stop').click();
    await page.clock.install();
    await page.route('**/arcade/synapse-run/foundation.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.getByTestId('arcade-launch-synapse-run').click();
    await page.clock.runFor(10_001);
    await waitPhase('error');
    eq(await page.getByTestId('arcade-frame').count(), 0);
    eq(await resources(), baseline);
  });
  eq(errors, []);
  const successfulExternal = network.responses.filter(r => r.category === 'external' && r.status < 400);
  const successfulApiProbes = network.responses.filter(r => r.fromGame && r.category === 'api' && r.status < 400);
  eq(successfulExternal, []); eq(successfulApiProbes, []); eq(network.routedProbes, []); eq(network.unexpectedGameRequests, []);
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync('.tmp/arcade-browser-evidence.json', JSON.stringify({ scenarios, assertions, network }, null, 2));
  console.log(JSON.stringify({ scenarios: scenarios.length, assertions, covered: scenarios, network: { harnessLocalAssets: network.responses.filter(r => r.category === 'harness-assets').length, sandboxLocalAssets: network.responses.filter(r => r.category === 'sandbox-assets').length, mockedParentApi: network.responses.filter(r => r.category === 'api').length, blockedProbes: 8, successfulExternal: 0, successfulGameApi: 0, unexpectedSuccessful: 0, failed: network.failed } }, null, 2));
} finally {
  clearTimeout(watchdog);
  await browser?.close(); await server?.close();
}
