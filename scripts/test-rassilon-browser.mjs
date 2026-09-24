import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser;
let server;
let assertions = 0;
const check = (value, message) => { assert.ok(value, message); assertions += 1; };
const now = new Date().toISOString();
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/rassilon-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => {
  console.error('RASSILON browser deadline');
  void browser?.close();
  void server?.close();
  process.exitCode = 1;
}, 60_000);

const settings = {
  enabled: false, maxCpuPercent: 25, maxRamMb: 2048, maxConcurrentJobs: 1,
  maxJobDurationSec: 300, maxScratchMb: 1024, pauseOnBattery: true,
  minimumBatteryPercent: 30, pauseWhenUserActive: true, acceptedJobTypes: [],
  approvalMode: 'ASK_EACH_JOB', updatedAt: now,
};
let workerState = 'DISABLED';
let lanState = 'DISABLED';
let fixtureError = null;
let pairingState = 'REQUESTED';
let stopCalls = 0;
let revokeCalls = 0;
let enableCalls = 0;
let pauseCalls = 0;
let resumeCalls = 0;
let lanEnableCalls = 0;
let lanDisableCalls = 0;
let pairingRejectCalls = 0;
let revoked = false;
let apiDown = false;
let releaseGate = null;
const XSS_IMG = '<img src=x onerror="window.__xssFired=true">';
const XSS_JS = 'javascript:window.__xssFired=true';

function statusBody() {
  return {
    ok: true, state: workerState, enabled: settings.enabled, queueDepth: workerState === 'WORKING' ? 1 : 0,
    activeJob: workerState === 'WORKING' ? { jobId: 'job-browser', jobType: 'SAFE_CPU_TASK', startedAt: now } : null,
    remoteController: workerState === 'WORKING' ? { deviceId: 'controller-browser', displayName: '<img src=x onerror="window.__xssFired=true">', fingerprint: 'AA:BB' } : null,
    settings,
    error: fixtureError ? { code: 'fixture_error', message: '<script>window.__xssFired=true</script>', timestamp: now } : null,
  };
}

try {
  server = await createServer({
    configFile: false,
    cacheDir: '.tmp/vite-rassilon',
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/rassilon-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5215, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => { window.__xssFired = undefined; });

  await page.route('**/api/rassilon/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    let body;
    let responseStatus = 200;
    if (releaseGate) await releaseGate.promise;

    if (apiDown) { body = { ok: false, error: XSS_IMG }; responseStatus = 503; }
    else if (pathname === '/api/rassilon/status') body = statusBody();
    else if (pathname === '/api/rassilon/lan/status') body = { ok: true, lan: { state: lanState, error: null, bindAddress: lanState === 'LISTENING' ? '192.168.1.20' : null, port: lanState === 'LISTENING' ? 3443 : null, certificateFingerprint: lanState === 'LISTENING' ? '11:22:33:44' : null } };
    else if (pathname === '/api/rassilon/devices') body = { ok: true, devices: [{
      deviceId: 'controller-browser', displayName: '<img src=x onerror="window.__xssFired=true">', fingerprint: 'AA:BB:CC:DD:EE:FF',
      role: 'CONTROLLER', permissions: ['RASSILON_COMPUTE_SAFE'], status: revoked ? 'REVOKED' : 'ONLINE', presence: revoked ? 'REVOKED' : 'ONLINE',
      createdAt: now, lastSeenAt: now, revokedAt: revoked ? now : null,
      session: { direction: 'INBOUND', createdAt: now, expiresAt: new Date(Date.now() + 900_000).toISOString(), lastSeenAt: now, active: !revoked, revokedAt: revoked ? now : null },
    }, {
      deviceId: 'worker-browser-js', displayName: XSS_JS, fingerprint: '<b>FF</b>:EE', role: 'WORKER', permissions: ['<script>window.__xssFired=true</script>'],
      status: 'OFFLINE', presence: 'OFFLINE', createdAt: now, lastSeenAt: null, revokedAt: null, session: null,
    }] };
    else if (pathname === '/api/rassilon/audit') body = { ok: true, events: [
      { id: 1, eventType: 'RASSILON_ENABLED', deviceId: 'controller-browser', jobId: null, jobType: null, timestamp: now, status: 'OK' },
      { id: 2, eventType: XSS_IMG, deviceId: XSS_JS, jobId: '<script>window.__xssFired=true</script>', jobType: '<b>SAFE</b>', timestamp: 'not-a-date', status: 'ERROR' },
    ] };
    else if (pathname === '/api/rassilon/enable' && method === 'POST') {
      const posted = request.postDataJSON();
      assert.equal(posted.maxCpuPercent, 25);
      settings.enabled = true; settings.acceptedJobTypes = posted.acceptedJobTypes; workerState = 'IDLE'; enableCalls += 1; body = statusBody();
    } else if (pathname === '/api/rassilon/disable' && method === 'POST') {
      settings.enabled = false; workerState = 'DISABLED'; lanState = 'DISABLED'; body = statusBody();
    } else if (pathname === '/api/rassilon/pause' && method === 'POST') {
      workerState = 'PAUSED'; pauseCalls += 1; body = statusBody();
    } else if (pathname === '/api/rassilon/resume' && method === 'POST') {
      workerState = 'IDLE'; resumeCalls += 1; body = statusBody();
    } else if (pathname === '/api/rassilon/stop' && method === 'POST') {
      settings.enabled = false; workerState = 'DISABLED'; lanState = 'DISABLED'; stopCalls += 1; body = statusBody();
    } else if (pathname === '/api/rassilon/settings' && method === 'PUT') {
      Object.assign(settings, request.postDataJSON()); body = { ok: true, settings };
    } else if (pathname === '/api/rassilon/lan/enable' && method === 'POST') {
      const posted = request.postDataJSON();
      assert.equal(posted.networkProfile, 'Private'); assert.equal(posted.allowUnknownNetworkProfile, false);
      lanState = 'LISTENING'; lanEnableCalls += 1; body = { ok: true, lan: { state: lanState, error: null, bindAddress: posted.bindAddress, port: posted.port, certificateFingerprint: '11:22:33:44' } };
    } else if (pathname === '/api/rassilon/lan/disable' && method === 'POST') {
      lanState = 'DISABLED'; lanDisableCalls += 1; body = { ok: true, lan: { state: lanState, error: null, bindAddress: null, port: null, certificateFingerprint: null } };
    } else if (pathname === '/api/rassilon/pairing/start' && method === 'POST') {
      body = { ok: true, pairing: { pairingId: 'pair-browser', code: '12345678', expiresAt: new Date(Date.now() + 120_000).toISOString(), workerNonce: 'public-worker-challenge-browser', worker: { deviceId: 'worker-browser', displayName: 'Worker', fingerprint: '11:22:33:44' } } };
    } else if (pathname === '/api/rassilon/pairing/pair-browser' && method === 'GET') {
      body = { ok: true, pairing: { pairingId: 'pair-browser', state: pairingState, controllerDeviceId: 'controller-browser', controllerDisplayName: '<script>window.__xssFired=true</script>', controllerFingerprint: 'AA:BB:CC:DD', requestedPermissions: ['RASSILON_COMPUTE_SAFE'], approvedPermissions: [], createdAt: now, expiresAt: new Date(Date.now() + 120_000).toISOString(), confirmedAt: null, usedAt: null, cancelledAt: null } };
    } else if (pathname === '/api/rassilon/pairing/pair-browser/reject' && method === 'POST') {
      pairingState = 'CANCELLED'; pairingRejectCalls += 1; body = { ok: true, pairing: { pairingId: 'pair-browser', state: pairingState } };
    } else if (pathname === '/api/rassilon/devices/controller-browser/revoke' && method === 'POST') {
      revoked = true; revokeCalls += 1; body = { ok: true, revoked: true, cancelledJobs: 0 };
    } else {
      body = { ok: false, error: 'fixture_route_missing' }; responseStatus = 404;
    }
    await route.fulfill({ status: responseStatus, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });

  await page.route('**/__rassilon_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__rassilon_test`);
  const badge = page.getByTestId('rassilon-badge-slot').getByRole('button');
  await badge.getByText('RASSILON OFF', { exact: true }).waitFor();
  check((await badge.getAttribute('aria-label')) === 'RASSILON OFF · LAN OFF', 'status badge shows OFF + LAN OFF from API');

  // Loading state: while the first API answers are pending, nothing is assumed.
  let release;
  releaseGate = { promise: new Promise(resolve => { release = resolve; }) };
  await badge.click();
  await page.getByTestId('rassilon-panel').waitFor();
  check(await page.getByText('RASSILON UNKNOWN', { exact: true }).isVisible(), 'loading shows RASSILON UNKNOWN');
  check(await page.getByText('LAN UNKNOWN', { exact: true }).first().isVisible(), 'loading shows LAN UNKNOWN');
  releaseGate = null; release();
  check(await page.getByRole('button', { name: 'OPEN RASSILON' }).count() === 0, 'badge click opens RASSILON tab');

  await page.getByText('RASSILON DISABLED', { exact: true }).waitFor();
  check(await page.getByText('RASSILON DISABLED', { exact: true }).isVisible(), 'default OFF visible');
  check(await page.getByText('LAN OFF', { exact: true }).first().isVisible(), 'LAN OFF visible');
  check(await page.getByRole('button', { name: /STOP RASSILON/ }).isVisible(), 'STOP visible');
  check(await page.getByText('LOCAL USER HAS FINAL AUTHORITY', { exact: true }).isVisible(), 'local authority visible');

  const cpu = page.getByLabel('CPU cible / soft limit (%)');
  await cpu.fill('91');
  check(await page.getByText(/CPU doit être compris/).isVisible(), 'frontend bounds visible');
  check(await page.getByRole('button', { name: /ENREGISTRER LES RÉGLAGES/ }).isDisabled(), 'invalid settings cannot submit');
  await cpu.fill('25');
  await page.getByLabel('Calcul déterministe sûr (SAFE_CPU_TASK)').check();

  await page.getByRole('button', { name: 'ENABLE', exact: true }).click();
  await page.getByText('RASSILON IDLE', { exact: true }).waitFor();
  check(enableCalls === 1, 'enable reached API');
  await page.getByRole('button', { name: /PAUSE/ }).click();
  await page.getByText('RASSILON PAUSED', { exact: true }).waitFor();
  check(pauseCalls === 1, 'pause reached API');
  await page.getByRole('button', { name: /RESUME/ }).click();
  await page.getByText('RASSILON IDLE', { exact: true }).waitFor();
  check(resumeCalls === 1, 'resume reached API');

  workerState = 'WORKING';
  await page.getByRole('button', { name: /Actualiser/ }).click();
  await page.getByText('RASSILON WORKING', { exact: true }).waitFor();
  check(await page.getByText(XSS_IMG, { exact: true }).first().isVisible(), 'remote controller name rendered as inert text');
  check(await page.evaluate(() => window.__xssFired === undefined), 'worker/controller name XSS inert');
  workerState = 'IDLE';
  await page.getByRole('button', { name: /Actualiser/ }).click();
  await page.getByText('RASSILON IDLE', { exact: true }).waitFor();

  await page.getByRole('button', { name: /LAN ENABLE/ }).click();
  await page.getByText('LAN ACTIVE', { exact: true }).first().waitFor();
  check(lanEnableCalls === 1, 'LAN enable reached API');

  await page.getByRole('button', { name: /OUVRIR UN PAIRING/ }).click();
  await page.getByText('12345678', { exact: true }).waitFor();
  check(await page.getByLabel('Autoriser SAFE_CPU_TASK').isVisible(), 'requested permission rendered');
  check(await page.evaluate(() => window.__xssFired === undefined), 'pairing/device XSS inert');
  await page.getByRole('button', { name: /REFUSER/ }).click();
  check(pairingRejectCalls === 1, 'pairing reject reached API');

  const revoke = page.getByRole('button', { name: 'REVOKE DEVICE', exact: true }).first();
  await revoke.click();
  await page.getByRole('button', { name: /CONFIRMER LA RÉVOCATION/ }).click();
  await page.getByText('REVOKED', { exact: true }).waitFor();
  check(revokeCalls === 1, 'revoke reached API');

  await page.getByRole('button', { name: /LAN DISABLE/ }).click();
  check(lanDisableCalls === 1, 'LAN disable reached API');

  await page.getByRole('button', { name: 'STOP RASSILON', exact: true }).click();
  await page.getByRole('button', { name: /CONFIRMER STOP ALL/ }).click();
  await page.getByText(/STOP exécuté/).waitFor();
  check(stopCalls === 1 && workerState === 'DISABLED' && lanState === 'DISABLED', 'STOP UI -> API -> worker state');

  fixtureError = true; workerState = 'ERROR'; settings.enabled = true;
  await page.getByRole('button', { name: /Actualiser/ }).click();
  await page.getByText(/Erreur sûre : fixture_error/).waitFor();
  check(await page.evaluate(() => window.__xssFired === undefined), 'error XSS inert');
  check(await page.getByText('RASSILON_ENABLED', { exact: true }).isVisible(), 'audit visible');
  check(await page.getByText(XSS_JS, { exact: true }).isVisible(), 'javascript: device name rendered as text');
  const activeMarkup = await page.getByTestId('rassilon-panel').evaluate(root => ({
    img: root.querySelectorAll('img').length, script: root.querySelectorAll('script').length, bold: root.querySelectorAll('b').length,
    jsLinks: root.querySelectorAll('[href^="javascript:" i], [src^="javascript:" i]').length,
  }));
  check(activeMarkup.img === 0 && activeMarkup.script === 0 && activeMarkup.bold === 0 && activeMarkup.jsLinks === 0, `no active HTML from untrusted data: ${JSON.stringify(activeMarkup)}`);
  check(await page.evaluate(() => window.__xssFired === undefined), 'audit/device/job metadata XSS inert');

  // Status honesty: a previously good IDLE / LAN ACTIVE must not survive an unreachable API.
  fixtureError = null; workerState = 'IDLE'; lanState = 'LISTENING';
  await page.getByRole('button', { name: /Actualiser/ }).click();
  await page.getByText('RASSILON IDLE', { exact: true }).waitFor();
  check(await page.getByText('LAN ACTIVE', { exact: true }).first().isVisible(), 'LAN ACTIVE from API');
  apiDown = true;
  await page.getByRole('button', { name: /Actualiser/ }).click();
  await page.getByText('RASSILON UNKNOWN', { exact: true }).waitFor();
  check(await page.getByText('RASSILON IDLE', { exact: true }).count() === 0, 'stale IDLE not shown when API unreachable');
  check(await page.getByText('LAN ACTIVE', { exact: true }).count() === 0, 'stale LAN ACTIVE not shown when API unreachable');
  check(await page.getByRole('alert').isVisible(), 'API error state visible');
  check(await page.getByRole('button', { name: 'STOP RASSILON', exact: true }).isEnabled(), 'STOP stays available when API unreachable');
  check(await page.evaluate(() => window.__xssFired === undefined), 'API error message XSS inert');
  await page.reload();
  await badge.getByText('RASSILON UNKNOWN', { exact: true }).waitFor();
  check((await badge.getAttribute('aria-label')).startsWith('État indisponible'), 'badge UNKNOWN when backend unreachable');
  apiDown = false;

  const bodyText = await page.locator('body').innerText();
  check(!/PRIVATE KEY|session-browser-secret|token-browser-secret|password-browser-secret/.test(bodyText), 'no secret rendering');
  check(pageErrors.length === 0, `page errors: ${pageErrors.join(', ')}`);
  console.log(`RASSILON BROWSER PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
