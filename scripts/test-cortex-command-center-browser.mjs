import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/cortex-command-center-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('CCC browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    plugins: [react(), { name: 'ccc-harness', configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/__ccc_test') return next(); res.setHeader('Content-Type', 'text/html'); res.end(harnessHtml); }); } }],
    optimizeDeps: { entries: ['scripts/cortex-command-center-harness.jsx'] },
    server: { host: '127.0.0.1', port: 5198, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });

  // ── Desktop viewport ──────────────────────────────────────────────────
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('CCC browser error:', e.message); });

  await page.goto(`${origin}/__ccc_test`);
  await page.getByTestId('cortex-state').waitFor();
  assertions++;

  // Initial state: idle.
  assert.equal(await page.getByTestId('cortex-state').innerText(), 'idle');
  assertions++;

  // Toggle busy -> thinking.
  await page.getByRole('button', { name: 'Toggle busy', exact: true }).click();
  assert.equal(await page.getByTestId('cortex-state').innerText(), 'thinking');
  assertions++;
  await page.getByRole('button', { name: 'Toggle busy', exact: true }).click();

  // Toggle listening -> listening (voiceState recording).
  await page.getByRole('button', { name: 'Toggle listening', exact: true }).click();
  assert.equal(await page.getByTestId('cortex-state').innerText(), 'listening');
  assertions++;
  await page.getByRole('button', { name: 'Toggle listening', exact: true }).click();

  // Toggle generating -> generating.
  await page.getByRole('button', { name: 'Toggle generating', exact: true }).click();
  assert.equal(await page.getByTestId('cortex-state').innerText(), 'generating');
  assertions++;

  // Toggle available off -> error state wins over generating (priority order).
  await page.getByRole('button', { name: 'Toggle available', exact: true }).click();
  assert.equal(await page.getByTestId('cortex-state').innerText(), 'error');
  assertions++;
  await page.getByRole('button', { name: 'Toggle available', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle generating', exact: true }).click();

  // Activity panel: closed by default.
  check(!(await page.getByRole('dialog', { name: "Panneau d'activité" }).isVisible().catch(() => false)));
  await page.getByRole('button', { name: 'Toggle panel', exact: true }).click();
  await page.getByRole('dialog', { name: "Panneau d'activité" }).waitFor();
  assertions++;

  // Keyboard: close button is focusable and reachable via Tab (accessibility).
  const closeBtn = page.getByRole('button', { name: "Fermer le panneau d'activité" });
  await closeBtn.waitFor();
  await closeBtn.focus();
  check(await closeBtn.evaluate(el => el === document.activeElement));
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: "Panneau d'activité" }).waitFor({ state: 'hidden' });
  assertions++;

  check(errors.length === 0);
  await context.close();

  // ── Mobile viewport (drawer layout) ─────────────────────────────────────
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(`${origin}/__ccc_test`);
  await mobilePage.getByRole('button', { name: 'Toggle panel', exact: true }).click();
  const panel = mobilePage.getByRole('dialog', { name: "Panneau d'activité" });
  await panel.waitFor();
  const box = await panel.boundingBox();
  check(box && box.width >= 380); // full-width drawer on mobile
  assertions++;
  await mobileContext.close();

  // ── Reduced motion ────────────────────────────────────────────────────
  // .activity-panel-cortex-state has a real `transition: color 0.6s ease`
  // declared in globals.css — this is the element that actually exercises
  // the prefers-reduced-motion override (unlike the close button, which
  // has no transition to begin with and would trivially read 0s either way).
  const rmContext = await browser.newContext({ reducedMotion: 'reduce' });
  const rmPage = await rmContext.newPage();
  await rmPage.goto(`${origin}/__ccc_test`);
  await rmPage.getByRole('button', { name: 'Toggle panel', exact: true }).click();
  const stateLabel = rmPage.locator('.activity-panel-cortex-state');
  await stateLabel.waitFor();
  // getComputedStyle normalizes the unit (e.g. "0.001ms" -> "1e-06s"), so
  // parse the numeric value in seconds rather than comparing raw strings.
  const transitionDurationSeconds = await stateLabel.evaluate(el => parseFloat(getComputedStyle(el).transitionDuration));
  check(transitionDurationSeconds < 0.0001); // effectively instant, vs. the real 0.6s
  assertions++;
  await rmContext.close();

  fs.mkdirSync('reports/cortex-command-center-evidence', { recursive: true });
  console.log(`CORTEX COMMAND CENTER FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
