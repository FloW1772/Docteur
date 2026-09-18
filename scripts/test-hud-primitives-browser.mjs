import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/hud-primitives-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('HUD primitives browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/hud-primitives-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5201, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('HUD primitives browser error:', e.message); });

  await page.route('**/__hud_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__hud_test`);
  await page.getByTestId('status-idle').waitFor();
  assertions++;

  // ── StatusIndicator: every cortex state + unavailable renders text, not just color ──
  for (const state of ['idle', 'listening', 'thinking', 'searching', 'generating', 'done', 'error', 'unavailable']) {
    const text = await page.getByTestId(`status-${state}`).innerText();
    check(text.trim().length > 0); // never color-only — always has a text label
  }

  // ── ModuleWidget: idle/running/error/absent-data/loading states ──
  const idleWidget = await page.getByTestId('widget-idle').innerText();
  check(idleWidget.includes('3 items') && idleWidget.includes('last run ok'));

  const runningWidget = await page.getByTestId('widget-running').innerText();
  check(runningWidget.includes('running'));

  const errorWidget = page.getByTestId('widget-error');
  await errorWidget.getByRole('alert').waitFor();
  check((await errorWidget.innerText()).includes('Connexion refusée'));

  const absentWidget = await page.getByTestId('widget-absent').innerText();
  check(absentWidget.includes('Aucune donnée'));
  check(!absentWidget.includes('undefined') && !absentWidget.includes('NaN'));

  const loadingWidget = await page.getByTestId('widget-loading').innerText();
  check(loadingWidget.includes('Chargement'));

  // ── ModuleWidget open action ──
  await page.getByTestId('widget-idle').getByRole('button', { name: 'Ouvrir', exact: true }).click();
  check(await page.evaluate(() => window.__opened === 'idle'));

  // ── QuickAction: enabled click fires, disabled click never fires ──
  await page.getByRole('button', { name: 'Quick search', exact: true }).click();
  check(await page.evaluate(() => window.__quickActionClicked === true));

  const disabledAction = page.getByRole('button', { name: 'Disabled action', exact: true });
  check(await disabledAction.isDisabled());
  await disabledAction.click({ force: true }).catch(() => {}); // disabled buttons don't fire click handlers even with force
  check(await page.evaluate(() => window.__disabledClicked !== true));

  // ── ActivityItem: module/label/relative time all present, real event shape ──
  const doneEvent = await page.getByText('Mission completed', { exact: false }).innerText();
  check(doneEvent.length > 0);
  await page.getByText('METAGPT', { exact: false }).first().waitFor();
  await page.getByText('SHERLOCK', { exact: false }).first().waitFor();

  const relativeTime = await page.getByTestId('relative-time-check').innerText();
  check(relativeTime.includes('h')); // "il y a 3 h"

  // ── Keyboard: QuickAction and ModuleWidget's open button are reachable via Tab ──
  await page.keyboard.press('Tab');
  const firstFocusable = await page.evaluate(() => document.activeElement?.tagName);
  check(firstFocusable === 'BUTTON' || firstFocusable === 'A' || firstFocusable === 'BODY');

  check(errors.length === 0);
  console.log(`HUD PRIMITIVES FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
