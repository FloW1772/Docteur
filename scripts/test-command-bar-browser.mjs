import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/command-bar-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('Command bar browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false, plugins: [react()],
    optimizeDeps: { entries: ['scripts/command-bar-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5204, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Command bar browser error:', e.message); });

  await page.route('**/__cmdbar_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__cmdbar_test`);
  await page.getByRole('search', { name: 'Commande principale' }).waitFor();
  assertions++;

  // ── Text submission: reaches the callback, never a fake local echo ──
  const input = page.getByLabel('Commande ou question');
  await input.fill('Résume le dernier neurone');
  await page.getByRole('button', { name: 'Envoyer' }).click();
  check(await page.getByTestId('submitted-log').innerText() === 'Résume le dernier neurone');
  check(await input.inputValue() === ''); // cleared after submit

  // ── Empty submission does nothing (send button disabled) ──
  check(await page.getByRole('button', { name: 'Envoyer' }).isDisabled());

  // ── Keyboard: Enter submits, field stays keyboard-accessible ──
  await input.fill('Deuxième commande');
  await input.press('Enter');
  check(await page.getByTestId('submitted-log').innerText() === 'Deuxième commande');

  // ── Voice: idle state shows MicOff, clicking mic calls onVoiceClick ──
  const micButton = page.getByRole('button', { name: 'Activer le micro' });
  await micButton.waitFor();
  await micButton.click();
  check(await page.getByTestId('voice-clicks').innerText() === '1');

  // ── Listening state: label changes, not just color (accessibility requirement) ──
  await page.getByRole('button', { name: 'Toggle voice state (test-only)' }).click();
  await page.getByRole('button', { name: 'Enregistrement…' }).waitFor();
  assertions++;

  // ── Cortex state label shown (aria-live, not color-only) ──
  await page.getByText('Réflexion…', { exact: true }).waitFor();
  assertions++;

  // ── Cancel button: only appears when a real cancellable action exists ──
  check(!(await page.getByRole('button', { name: "Annuler l'action en cours" }).isVisible().catch(() => false)));
  await page.getByRole('button', { name: 'Toggle cancel button (test-only)' }).click();
  await page.getByRole('button', { name: "Annuler l'action en cours" }).click();
  check(await page.getByTestId('cancelled-log').innerText() === 'cancelled');

  check(errors.length === 0);
  await context.close();

  // ── Mobile viewport: command bar remains the dominant, full-width element ──
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.route('**/__cmdbar_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await mobilePage.goto(`${origin}/__cmdbar_test`);
  const bar = mobilePage.getByRole('search', { name: 'Commande principale' });
  await bar.waitFor();
  const box = await bar.boundingBox();
  check(box && box.width >= 360); // near-full-width on mobile
  await mobileContext.close();

  // ── Reduced motion: command bar still fully usable (no functionality lost) ──
  const rmContext = await browser.newContext({ reducedMotion: 'reduce' });
  const rmPage = await rmContext.newPage();
  await rmPage.route('**/__cmdbar_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await rmPage.goto(`${origin}/__cmdbar_test`);
  await rmPage.getByLabel('Commande ou question').fill('Test reduced motion');
  await rmPage.getByRole('button', { name: 'Envoyer' }).click();
  check(await rmPage.getByTestId('submitted-log').innerText() === 'Test reduced motion');
  await rmContext.close();

  console.log(`COMMAND BAR FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
