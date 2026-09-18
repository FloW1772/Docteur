import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/dashboard-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('Dashboard browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/dashboard-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5202, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });

  // ── Desktop viewport: both rails visible ──────────────────────────────
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Dashboard browser error:', e.message); });

  await page.route('**/api/metagpt/missions**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, missions: [] }) }));
  await page.route('**/api/investment/portfolios', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, portfolios: [] }) }));
  await page.route('**/api/openmontage/status', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'READY_LOCAL' }) }));
  await page.route('**/api/connectors', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connectors: [] }) }));

  await page.route('**/__dashboard_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__dashboard_test`);
  // V2.1: the 4 primary modules dock to the 4 corners around the Cortex
  // instead of a single stacked left rail; Connecteurs + Actions rapides +
  // Activité récente stay in a secondary top-right rail.
  await page.getByLabel('Module MetaGPT').waitFor();
  await page.getByLabel('Module Sherlock').waitFor();
  await page.getByLabel('Module Investment').waitFor();
  await page.getByLabel('Module Studio Vidéo').waitFor();
  await page.getByLabel('Connecteurs et actions').waitFor();
  assertions++;

  // ── All 5 module widgets present with real (non-fabricated) statuses ──
  for (const name of ['MetaGPT', 'Sherlock', 'Investment', 'Studio Vidéo', 'Connecteurs']) {
    await page.getByText(name, { exact: true }).waitFor();
  }
  assertions++;

  // No financial values ever fabricated (mission requirement 11) — with an
  // empty portfolios response, Investment widget must show "unavailable",
  // never a fake dollar amount.
  await page.getByText('Aucun portefeuille simulé', { exact: false }).waitFor();
  assertions++;

  // Sherlock with no lastJobId shows "no recent search", never a fake status
  await page.getByText('Aucune recherche récente', { exact: false }).waitFor();
  assertions++;

  // ── Quick actions open the correct existing flow, never duplicate logic ──
  await page.getByRole('button', { name: 'Nouvelle mission MetaGPT', exact: true }).click();
  check(await page.getByTestId('opened-log').innerText() === 'quick-metagpt');

  await page.getByRole('button', { name: 'Recherche Sherlock', exact: true }).click();
  check(await page.getByTestId('opened-log').innerText() === 'quick-sherlock');

  await page.getByRole('button', { name: 'Analyse investissement', exact: true }).click();
  check(await page.getByTestId('opened-log').innerText() === 'quick-investment');

  await page.getByRole('button', { name: 'Nouveau rendu vidéo', exact: true }).click();
  check(await page.getByTestId('opened-log').innerText() === 'quick-video');

  // ── Module widget "Open" buttons ──
  await page.getByRole('button', { name: 'Ouvrir Studio', exact: true }).first().click();
  check(await page.getByTestId('opened-log').innerText() === 'metagpt');

  // ── Real activity event displayed (module, label, relative time) ──
  await page.getByText('Mission completed', { exact: false }).waitFor();
  await page.getByText('METAGPT', { exact: false }).first().waitFor();
  assertions++;

  // ── No fake BUY/SELL or fabricated ticker prices anywhere in the DOM ──
  const bodyText = await page.locator('body').innerText();
  check(!/\$\d/.test(bodyText)); // no dollar-prefixed numeric literal anywhere
  check(!bodyText.includes('BTC') && !bodyText.includes('AAPL'));

  check(errors.length === 0);
  await context.close();

  // ── Tablet viewport (1024-1439, per mission's 4-tier responsive spec) ──
  const tabletContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const tabletPage = await tabletContext.newPage();
  await tabletPage.route('**/api/metagpt/missions**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, missions: [] }) }));
  await tabletPage.route('**/api/investment/portfolios', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, portfolios: [] }) }));
  await tabletPage.route('**/api/openmontage/status', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'READY_LOCAL' }) }));
  await tabletPage.route('**/api/connectors', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connectors: [] }) }));
  await tabletPage.route('**/__dashboard_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await tabletPage.goto(`${origin}/__dashboard_test`);
  await tabletPage.getByLabel('Module MetaGPT').waitFor();
  const cornerBox = await tabletPage.getByLabel('Module MetaGPT').boundingBox();
  check(cornerBox && cornerBox.width <= 240); // narrower corner widget at tablet width
  await tabletContext.close();

  // ── Below-768px viewport: rails hidden entirely (mobile stays Focus mode) ──
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.route('**/api/metagpt/missions**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, missions: [] }) }));
  await mobilePage.route('**/api/investment/portfolios', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, portfolios: [] }) }));
  await mobilePage.route('**/api/openmontage/status', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'READY_LOCAL' }) }));
  await mobilePage.route('**/api/connectors', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connectors: [] }) }));
  await mobilePage.route('**/__dashboard_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await mobilePage.goto(`${origin}/__dashboard_test`);
  await mobilePage.waitForTimeout(300);
  check(!(await mobilePage.getByLabel('Module MetaGPT').isVisible().catch(() => false)));
  await mobileContext.close();

  console.log(`DASHBOARD FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
