import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

// One-off visual-audit tool for the V2.1 polish mission — captures the
// current Cortex Command Center composition at the required breakpoints so
// it can be reviewed before any CSS/component changes are made. Not a test.

const outDir = process.env.V21_QA_DIR || '.tmp/v21/after';
mkdirSync(outDir, { recursive: true });

const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/v21-audit-harness.jsx");mount();</script>';

let browser, server;
const watchdog = setTimeout(() => { console.error('Audit deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 90000);

try {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/v21-audit-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5299, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });

  const viewports = [
    { name: '1920x1080', width: 1920, height: 1080 },
    { name: '1440x900', width: 1440, height: 900 },
    { name: '1366x768', width: 1366, height: 768 },
    { name: '390x844', width: 390, height: 844 },
  ];

  for (const vp of viewports) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    page.on('pageerror', e => console.error(`[${vp.name}] pageerror:`, e.message));
    await page.route('**/__v21_audit', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
    await page.goto(`${origin}/__v21_audit`);
    await page.locator('.hud2-command-bar').waitFor();
    await page.waitForTimeout(1200); // let Three.js scene settle

    // Dashboard mode (default)
    await page.screenshot({ path: `${outDir}/dashboard-${vp.name}.png` });

    // Focus mode — mode toggle is hidden below 768px (mobile stays Focus-only
    // by design), so only exercise it at desktop/tablet widths.
    if (vp.width >= 768) {
      await page.getByTestId('mode-toggle').click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${outDir}/focus-${vp.name}.png` });
      await page.getByTestId('mode-toggle').click();
      await page.waitForTimeout(300);
    }

    // Cortex states (dashboard mode, primary viewport only to save time)
    if (vp.name === '1920x1080') {
      for (const state of ['listening', 'thinking', 'searching', 'generating', 'error']) {
        await page.getByTestId(`set-state-${state}`).click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${outDir}/state-${state}-${vp.name}.png` });
      }
    }

    await context.close();
  }

  console.log(`Screenshots written to ${outDir}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
