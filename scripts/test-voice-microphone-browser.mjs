import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server;
const html = '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;import("/scripts/voice-microphone-harness.jsx").then(m=>m.mount());</script>';

try {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/voice-microphone-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5205, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__voice_test', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__voice_test`);

  await page.locator('option[value="usb-mic"]').waitFor({ state: 'attached' });
  assert.equal(await page.getByTestId('permission').innerText(), 'prompt');
  await page.getByLabel('device').selectOption('usb-mic');
  await page.getByRole('button', { name: 'Start test' }).click();
  await page.getByText('true', { exact: true }).waitFor();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="rms"]').textContent) > 0);
  await page.waitForFunction(() => document.querySelector('[data-testid="peak"]').textContent !== '0');
  await page.waitForFunction(() => document.querySelector('[data-testid="noise-floor"]').textContent !== 'calibrating');
  assert.equal(await page.getByTestId('clipping').innerText(), 'NO CLIPPING DETECTED');

  const capture = await page.evaluate(() => window.__voiceTest);
  assert.deepEqual(capture.constraints[0].audio.deviceId, { exact: 'usb-mic' });
  assert.equal(capture.fetches, 0);

  await page.getByRole('button', { name: 'Stop test' }).click();
  await page.getByText('false', { exact: true }).waitFor();
  const rmsAfterStop = await page.getByTestId('rms').innerText();
  await page.waitForTimeout(100);
  assert.equal(await page.getByTestId('rms').innerText(), rmsAfterStop);
  const stopped = await page.evaluate(() => ({
    tracksEnded: window.__voiceTest.activeTracks.every(track => track.readyState === 'ended'),
    closedContexts: window.__voiceTest.closedContexts,
  }));
  assert.equal(stopped.tracksEnded, true);
  assert.equal(stopped.closedContexts, 1);

  await page.evaluate(() => {
    window.__voiceTest.deviceList = [window.__voiceTest.deviceList[0]];
    window.__voiceTest.emitDeviceChange();
  });
  await page.waitForFunction(() => document.querySelector('[aria-label="device"]').value === '');

  await page.evaluate(() => {
    window.__voiceTest.deviceList = [
      { kind: 'audioinput', deviceId: 'default', label: 'Default Mic', groupId: 'group-default' },
      { kind: 'audioinput', deviceId: 'usb-mic', label: 'USB Mic', groupId: 'group-usb' },
    ];
    window.__voiceTest.emitDeviceChange();
  });
  await page.getByLabel('device').selectOption('usb-mic');
  await page.evaluate(() => { window.__voiceTest.failSelected = true; });
  await page.getByRole('button', { name: 'Start test' }).click();
  await page.getByText('true', { exact: true }).waitFor();
  const fallback = await page.evaluate(() => window.__voiceTest.constraints.at(-1));
  assert.equal(fallback.audio.deviceId, undefined);
  await page.getByRole('button', { name: 'Stop test' }).click();
  assert.equal(await page.evaluate(() => window.__voiceTest.deviceListeners.size), 1);
  await page.evaluate(() => window.__unmountMicrophone());
  await page.waitForFunction(() => window.__voiceTest.deviceListeners.size === 0);
  await page.evaluate(() => window.__remountMicrophone());
  await page.waitForFunction(() => window.__voiceTest.deviceListeners.size === 1);
  await page.evaluate(() => window.__unmountMicrophone());
  await page.waitForFunction(() => window.__voiceTest.deviceListeners.size === 0);
  assert.deepEqual(errors, []);
  console.log('VOICE MICROPHONE BROWSER PASS: enumeration, explicit device, permission state, RMS meter, fallback, cleanup, no transcription');
} finally {
  await browser?.close();
  await server?.close();
}
