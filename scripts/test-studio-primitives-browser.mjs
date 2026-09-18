import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { captureStudio } from './studio-browser-checks.mjs';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/studio-primitives-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('Studio primitives browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    cacheDir: '.tmp/vite-studio-primitives',
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/studio-primitives-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5203, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Studio primitives browser error:', e.message); });

  await page.route('**/__studio_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__studio_test`);

  // ── StudioShell: dialog role, aria-label, subtitle, Escape closes ──
  await page.getByRole('dialog', { name: 'Test Studio' }).waitFor();
  await page.getByText('Sous-titre de sécurité', { exact: true }).waitFor();
  assertions++;

  // ── StudioTabs: switching updates active tab, badge renders ──
  check(await page.getByTestId('active-tab').innerText() === 'OVERVIEW');
  await page.getByRole('tab', { name: /HISTORY/, exact: false }).click();
  check(await page.getByTestId('active-tab').innerText() === 'HISTORY');
  const historyTab = page.getByRole('tab', { name: /HISTORY/, exact: false });
  check((await historyTab.innerText()).includes('2'));
  await historyTab.focus();
  await page.keyboard.press('ArrowRight');
  check(await page.getByTestId('active-tab').innerText() === 'OVERVIEW');
  await page.keyboard.press('End');
  check(await page.getByRole('tab', { name: /HISTORY/ }).getAttribute('aria-selected') === 'true');
  const close = page.getByRole('button', { name: 'Fermer Test Studio', exact: true });
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  check(await page.getByRole('button', { name: 'Annuler', exact: true }).evaluate(el => el === document.activeElement));
  await page.keyboard.press('Tab');
  check(await close.evaluate(el => el === document.activeElement));

  // ── StudioStatus: every tone renders a non-empty text label (never color-only) ──
  const statusesText = await page.getByTestId('statuses').innerText();
  for (const label of ['Actif', 'Réussi', 'Attention', 'Erreur', 'Neutre']) {
    check(statusesText.includes(label));
  }

  // ── StudioEmptyState: real caller-supplied message rendered, no invented copy ──
  check((await page.getByTestId('empty-state').innerText()).includes("Aucune donnée pour l'instant."));

  // ── StudioErrorState: role=alert, real message, retry fires callback ──
  const errorState = page.getByTestId('error-state');
  await errorState.getByRole('alert').waitFor();
  check((await errorState.innerText()).includes('job_not_found'));
  await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
  check(await page.getByTestId('retry-count').innerText() === '1');

  // ── StudioArtifactViewer: native <details>/<summary>, content shown, null content renders nothing ──
  await page.locator('summary').filter({ hasText: 'PRD' }).waitFor();
  await page.getByText('Fixture PRD content', { exact: false }).waitFor();
  await page.getByText('1.2 KB', { exact: true }).waitFor();
  check(!(await page.locator('summary').filter({ hasText: 'Empty artifact' }).isVisible().catch(() => false)));
  assertions++;

  // ── Copy button doesn't toggle the <details> open state (stopPropagation via preventDefault) ──
  const detailsEl = page.locator('details', { hasText: 'PRD' });
  check(await detailsEl.evaluate(el => el.open));
  await page.getByRole('button', { name: 'Copier PRD', exact: true }).click();
  check(await detailsEl.evaluate(el => el.open)); // still open after copy click
  assertions++;

  // ── StudioSourceBadge: link + recency + timestamp format ──
  // (recency is styled uppercase via CSS text-transform, so innerText() reflects
  // that rendered case — check case-insensitively rather than the source casing)
  const sourceBadge = await page.getByTestId('source-badge').innerText();
  check(sourceBadge.includes('Mock Filing') && /historical/i.test(sourceBadge) && sourceBadge.includes('récupéré le 2026-09-18'));
  const sourceLink = page.getByTestId('source-badge').getByRole('link', { name: 'Mock Filing', exact: true });
  check(await sourceLink.getAttribute('href') === 'https://example.com/filing');

  // ── StudioTimeline: reliable vs unreliable date, interpretation visually separated ──
  await page.getByText('Q3 beat', { exact: false }).waitFor();
  await page.getByText('date non fiable', { exact: false }).waitFor();
  await page.getByText('Speculative note', { exact: false }).waitFor();
  assertions++;

  // ── StudioToolbar: primary/secondary/destructive groups all render ──
  await page.getByRole('button', { name: 'Primaire', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Secondaire', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Annuler', exact: true }).waitFor();
  assertions++;

  // ── StudioSplitPane: main + secondary both render ──
  await page.getByTestId('split-main').waitFor();
  await page.getByTestId('split-secondary').waitFor();
  await page.getByLabel('Activité').waitFor();
  assertions++;

  // ── Keyboard: Escape closes the shell ──
  await captureStudio(page, 'shared-shell');
  await page.keyboard.press('Escape');
  await page.getByTestId('shell-closed').waitFor();
  assertions++;

  const opener = page.getByRole('button', { name: 'Ouvrir le Studio test', exact: true });
  await opener.click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  check(await opener.evaluate(el => el === document.activeElement));

  check(errors.length === 0);
  console.log(`STUDIO PRIMITIVES FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
