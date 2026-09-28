import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const XSS_DEVICE = '<img src=x onerror="window.__xssFired=true">';
const XSS_ERROR = '<script>window.__xssFired=true</script>';
const sessionId = '11111111-1111-4111-8111-111111111111';
let browser;
let server;
let assertions = 0;
let frameMode = 'ok';
let nextStartFrameMode = 'ok';
let stoppedSession = false;
let frameCalls = 0;
let inputCalls = 0;
let delayNextStart = false;
const trace = [];
const check = (value, message) => { assert.ok(value, message); assertions += 1; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/omega-outbound-view-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { void browser?.close(); void server?.close(); process.exitCode = 1; }, 90_000);

try {
  server = await createServer({ configFile: false, cacheDir: '.tmp/vite-omega-view', plugins: [react()],
    optimizeDeps: { entries: ['scripts/omega-outbound-view-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5221, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => { window.__xssFired = undefined; });
  await page.route('**:3001/api/omega/outbound/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (/mouse|keyboard|input|wheel|pointer|interactive|admin/i.test(path)) inputCalls += 1;
    if (path.endsWith('/sessions') && request.method() === 'GET') {
      const sessions = stoppedSession ? [] : [{ sessionId, remoteOmegaDeviceId: XSS_DEVICE,
        permission: 'VIEW', status: 'CONNECTED', expiresAt: new Date(Date.now() + 60_000).toISOString() }];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sessions }) });
    }
    if (path.endsWith('/view/start')) {
      frameMode = nextStartFrameMode;
      nextStartFrameMode = 'ok';
      trace.push(`start:${frameMode}`);
      if (delayNextStart) {
        delayNextStart = false;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ view: { status: 'VIEW_STARTING' } }) });
    }
    if (path.endsWith('/view/frame')) {
      frameCalls += 1;
      const mode = frameMode;
      frameMode = 'ok';
      trace.push(`frame:${mode}`);
      if (mode === 'network') return route.abort('failed');
      if (mode === 'invalid-png') return route.fulfill({ status: 200, contentType: 'image/png', body: 'not a png' });
      if (mode !== 'ok') {
        const error = mode === 'xss' ? XSS_ERROR : mode;
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error }) });
      }
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    if (path.endsWith('/view/stop')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ view: { status: 'STOPPED' } }) });
    }
    if (path.endsWith('/stop')) {
      stoppedSession = true;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stopped: true }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'route_not_found' }) });
  });
  await page.route('**/__omega_view_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto('http://127.0.0.1:5221/__omega_view_test');
  await page.getByRole('heading', { name: 'OMEGA VIEW ONLY' }).waitFor();
  check(await page.getByText('OMEGA VIEW ONLY').isVisible(), 'VIEW ONLY label visible');
  check(await page.getByText(/CONNECTION: CONNECTED/).isVisible(), 'connected session status visible');
  check(await page.getByText(XSS_DEVICE, { exact: false }).count() >= 1, 'device name rendered as text');

  delayNextStart = true;
  const framesBeforeStartCompletes = frameCalls;
  await page.getByRole('button', { name: 'Start VIEW' }).click();
  await page.waitForTimeout(100);
  check(frameCalls === framesBeforeStartCompletes, 'frame polling waits for VIEW_START response');
  await page.getByText('VIEW: VIEWING').waitFor();
  const image = page.getByRole('img', { name: 'Remote screen' });
  await image.waitFor();
  check(await image.evaluate(node => node.naturalWidth === 1 && node.naturalHeight === 1), 'decoded frame displayed');
  const viewport = page.getByLabel('Read-only remote viewport');
  await viewport.click();
  await viewport.press('A');
  await viewport.dispatchEvent('wheel', { deltaY: 100 });
  await viewport.dispatchEvent('pointermove', { clientX: 5, clientY: 5 });
  await page.waitForTimeout(100);
  check(inputCalls === 0, 'viewport events produce zero remote input request');

  await page.getByRole('button', { name: 'Stop VIEW' }).click();
  await page.getByText('VIEW: STOPPED').waitFor();
  check(await image.count() === 0, 'STOP VIEW clears viewport');

  const exerciseError = async (mode, label) => {
    nextStartFrameMode = mode;
    await page.getByRole('button', { name: 'Start VIEW' }).click();
    const alert = page.getByRole('alert').getByText(label, { exact: true });
    await alert.waitFor();
    check(await alert.isVisible(), `${label} is safe and visible`);
    await page.getByText('VIEW: STOPPED').waitFor({ timeout: 5_000 }).catch(async error => {
      throw new Error(`${error.message}\nTRACE:${trace.join(',')}\nSTATE:\n${await page.locator('body').innerText()}`);
    });
  };
  await exerciseError('REMOTE_STOPPED', 'REMOTE_STOPPED');
  await exerciseError('network', 'NETWORK_UNAVAILABLE');
  await exerciseError('SESSION_EXPIRED', 'SESSION_EXPIRED');
  await exerciseError('TLS_IDENTITY_MISMATCH', 'TLS_IDENTITY_MISMATCH');
  await exerciseError('invalid-png', 'FRAME_INVALID');
  await exerciseError('xss', XSS_ERROR);
  check(await page.locator('script').count() === 1 && await page.locator('img[src="x"]').count() === 0, 'device/error HTML remains inert');
  check(await page.evaluate(() => window.__xssFired === undefined), 'no XSS executed');

  await page.getByRole('button', { name: 'Stop session' }).click();
  await page.getByText(/CONNECTION: DISCONNECTED/).waitFor();
  check(true, 'STOP SESSION clears selected session');
  check(pageErrors.length === 0, `no page errors: ${pageErrors.join(', ')}`);
  console.log(`OMEGA VIEW BROWSER PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
