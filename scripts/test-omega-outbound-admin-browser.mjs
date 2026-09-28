import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// OMEGA V2 Phase 5 controller ADMIN UI harness. The local API is fully mocked
// with page.route: no Cortex server, no host and no real ADMIN action exists.
const sessionId = '22222222-2222-4222-8222-222222222222';
const XSS = '<img src=x onerror="window.__xssFired=true">';
let browser;
let server;
let assertions = 0;
let permission = 'VIEW';
let expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
let stoppedSession = false;
let adminMode = 'ok';
let pollMode = 'ok';
const operations = new Map();
const adminRequests = [];
const requests = [];
const check = (value, message) => { assert.ok(value, message); assertions += 1; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/omega-outbound-view-harness.jsx");mount();</script>';
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const READ_RESULTS = {
  'system-info': ['GET_SYSTEM_INFO', { system: { computerName: 'HOST-B', osCaption: 'Windows 11', osVersion: '10.0', architecture: '64-bit', lastBootUpTime: 'boot' } }],
  processes: ['PROCESS_LIST', { processes: [{ pid: 4, name: XSS, memoryBytes: 10, cpuSeconds: null }, { pid: 8, name: 'svchost', memoryBytes: 20, cpuSeconds: 1.5 }], count: 2, truncated: true }],
  services: ['SERVICE_STATUS', { services: [{ name: 'Spooler', displayName: 'Print Spooler', state: 'Running', startMode: 'Auto' }], count: 1, truncated: false }],
  network: ['NETWORK_STATUS', { interfaces: [{ description: 'Ethernet', dhcpEnabled: true, addresses: ['192.168.1.14'], gateways: ['192.168.1.1'], dnsServers: [] }], count: 1, truncated: false }],
  disks: ['DISK_STATUS', { disks: [{ drive: 'C:', filesystem: 'NTFS', totalBytes: 1000, freeBytes: 400 }], count: 1, truncated: false }],
};

try {
  server = await createServer({ configFile: false, cacheDir: '.tmp/vite-omega-admin', plugins: [react()],
    optimizeDeps: { entries: ['scripts/omega-outbound-view-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5223, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() ?? '' }));
  await page.addInitScript(() => { window.__xssFired = undefined; });
  await page.route('**:3001/api/omega/outbound/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/sessions') && request.method() === 'GET') {
      return json(route, 200, { sessions: stoppedSession ? [] : [{ sessionId, remoteOmegaDeviceId: XSS, permission, status: 'CONNECTED', expiresAt }] });
    }
    const admin = path.match(/\/admin\/(.+)$/);
    if (admin) {
      const body = request.postData() ?? '';
      adminRequests.push({ path: admin[1], method: request.method(), body });
      if (adminMode !== 'ok') return json(route, 409, { error: adminMode });
      if (READ_RESULTS[admin[1]]) {
        const [actionType, result] = READ_RESULTS[admin[1]];
        return json(route, 200, { admin: { operationId: crypto.randomUUID(), actionType, status: 'EXECUTED', result } });
      }
      const high = admin[1].match(/^(lock|logoff|restart|shutdown)\/request$/);
      if (high) {
        const actionType = high[1].toUpperCase();
        if (body !== JSON.stringify({ confirm: actionType })) return json(route, 400, { error: 'CONFIRMATION_REQUIRED' });
        const operation = { operationId: crypto.randomUUID(), actionType, status: 'PENDING_APPROVAL', error: null,
          expiresAt: new Date(Date.now() + 30_000).toISOString() };
        operations.set(operation.operationId, operation);
        return json(route, 202, { admin: operation });
      }
      const status = admin[1].match(/^operations\/([^/]+)(\/cancel)?$/);
      if (status && operations.has(status[1])) {
        if (pollMode !== 'ok') return json(route, 409, { error: pollMode });
        const operation = operations.get(status[1]);
        if (status[2] && operation.status === 'PENDING_APPROVAL') Object.assign(operation, { status: 'CANCELLED', error: 'CONTROLLER_CANCEL' });
        return json(route, 200, { admin: operation });
      }
      return json(route, 404, { error: 'route_not_found' });
    }
    if (path.endsWith('/stop')) { stoppedSession = true; return json(route, 200, { stopped: true }); }
    return json(route, 404, { error: 'route_not_found' });
  });
  await page.route('**/__omega_admin_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto('http://127.0.0.1:5223/__omega_admin_test');
  await page.getByRole('heading', { name: 'OMEGA VIEW ONLY' }).waitFor();

  const settle = (ms = 150) => page.waitForTimeout(ms);
  const adminHeading = page.getByRole('heading', { name: 'OMEGA ADMIN' });
  const adminState = page.getByLabel('ADMIN state');
  const operationStatus = page.getByLabel('ADMIN operation status');
  const button = name => page.getByRole('button', { name, exact: true });
  const refresh = async value => {
    permission = value;
    await button('Refresh sessions').click();
    if (value === 'ADMIN') await adminHeading.waitFor();
    else await adminHeading.waitFor({ state: 'detached' });
    await settle();
  };
  const highImpactButtons = ['Request LOCK', 'Request LOGOFF', 'Request RESTART', 'Request SHUTDOWN'];
  const readButtons = ['Read system info', 'Read processes', 'Read services', 'Read network', 'Read disks'];
  const allDisabled = async () => {
    for (const name of [...readButtons, ...highImpactButtons]) if (!(await button(name).isDisabled())) return false;
    return true;
  };
  const request = async action => {
    await button(`Request ${action}`).click();
    await page.getByRole('dialog', { name: 'Confirm high-impact ADMIN action' }).waitFor();
    await button(`Confirm ${action} request`).click();
    await operationStatus.getByText(`${action}: PENDING_APPROVAL`).waitFor();
    return [...operations.values()].at(-1);
  };

  // 1-2. ADMIN hidden for VIEW and INTERACTIVE sessions.
  await settle(300);
  check(await adminHeading.count() === 0, 'ADMIN hidden on VIEW session');
  check(await button('Request LOCK').count() === 0 && await button('Read system info').count() === 0, 'no ADMIN control on VIEW session');
  await refresh('INTERACTIVE');
  check(await adminHeading.count() === 0, 'ADMIN hidden on INTERACTIVE session');
  check(adminRequests.length === 0, 'VIEW/INTERACTIVE never call ADMIN');

  // 3. ADMIN visible for ADMIN, with separated READ-ONLY and HIGH-IMPACT sections; nothing automatic.
  await refresh('ADMIN');
  await adminHeading.waitFor();
  check(await page.getByLabel('READ-ONLY STATUS').isVisible(), 'READ-ONLY STATUS section visible');
  check(await page.getByLabel('HIGH-IMPACT ACTIONS').isVisible(), 'HIGH-IMPACT ACTIONS section visible and separate');
  check(await page.getByRole('heading', { name: 'HIGH-IMPACT ACTIONS' }).isVisible(), 'high-impact heading explicit');
  check((await adminState.textContent()) === 'ADMIN: AVAILABLE', 'ADMIN available state');
  await settle(500);
  check(adminRequests.length === 0, 'no ADMIN request without a local click (no autonomous ADMIN)');

  // 4. Read-only actions display, XSS-inert remote strings, truncation notice.
  await button('Read system info').click();
  await page.getByLabel('ADMIN system info').getByText('HOST-B').waitFor();
  check(true, 'system info displayed');
  await button('Read processes').click();
  await page.getByRole('table', { name: 'ADMIN result' }).getByText('svchost').waitFor();
  check(await page.getByRole('table', { name: 'ADMIN result' }).getByText(XSS, { exact: true }).count() === 1, 'remote process name rendered as literal text');
  check(await page.evaluate(() => window.__xssFired === undefined && !document.querySelector('table img')), 'remote results are XSS inert');
  check(await page.getByText('Truncated to 2 entries').isVisible(), 'truncation indicated safely');
  for (const [name, text] of [['Read services', 'Print Spooler'], ['Read network', '192.168.1.14'], ['Read disks', 'NTFS']]) {
    await button(name).click();
    await page.getByRole('table', { name: 'ADMIN result' }).getByText(text).waitFor();
    check(true, `${name} displayed`);
  }
  check(adminRequests.every(value => value.body === '{}' || value.method === 'GET'), 'read requests carry no parameters');

  // 5. High-impact confirmation: first click only opens the confirmation; Back sends nothing.
  let before = adminRequests.length;
  await button('Request LOCK').click();
  const dialog = page.getByRole('dialog', { name: 'Confirm high-impact ADMIN action' });
  await dialog.waitFor();
  await settle();
  check(adminRequests.length === before, 'first click does not execute or send anything');
  check((await dialog.textContent()).includes(XSS) && await page.evaluate(() => window.__xssFired === undefined), 'confirmation names the device as literal text');
  check(await button('Request SHUTDOWN').isDisabled(), 'other high-impact buttons locked during confirmation');
  await button('Back').click();
  await settle();
  check(await dialog.count() === 0 && adminRequests.length === before, 'Back cancels locally with no request');

  // Approval flow: confirmed request stays pending until the remote approves.
  const shutdown = await request('SHUTDOWN');
  check(adminRequests.at(-1).path === 'shutdown/request' && adminRequests.at(-1).body === '{"confirm":"SHUTDOWN"}', 'explicit typed confirmation sent');
  check(await button('Request LOCK').isDisabled(), 'one pending high-impact request at a time');
  await settle(1_700);
  check(await operationStatus.getByText('SHUTDOWN: PENDING_APPROVAL').isVisible(), 'still pending without remote approval');
  Object.assign(shutdown, { status: 'EXECUTED', result: { accepted: true } });
  await operationStatus.getByText('SHUTDOWN: EXECUTED').waitFor();
  check(true, 'approved request reported executed');

  // 6. Deny flow.
  const logoff = await request('LOGOFF');
  Object.assign(logoff, { status: 'DENIED', error: 'LOCAL_DENY' });
  await operationStatus.getByText('LOGOFF: DENIED (LOCAL_DENY)').waitFor();
  check(true, 'deny flow displayed');

  // 7. Cancel flow.
  await request('RESTART');
  await button('Cancel ADMIN request').click();
  await operationStatus.getByText('RESTART: CANCELLED (CONTROLLER_CANCEL)').waitFor();
  check(adminRequests.some(value => /\/cancel$/.test(value.path)), 'cancel request sent');

  // 8. Revocation disables ADMIN.
  adminMode = 'DEVICE_REVOKED';
  await button('Read disks').click();
  await adminState.getByText('ADMIN DISABLED: DEVICE_REVOKED').waitFor();
  check(await allDisabled(), 'revocation disables every ADMIN control');
  adminMode = 'ok';

  // 9. Remote STOP while a request is pending disables ADMIN and stops polling.
  await refresh('INTERACTIVE'); await refresh('ADMIN');
  await request('LOCK');
  pollMode = 'REMOTE_STOPPED';
  await adminState.getByText('ADMIN DISABLED: REMOTE_STOPPED').waitFor({ timeout: 5_000 });
  check(await allDisabled(), 'remote STOP disables ADMIN');
  before = adminRequests.length;
  await settle(3_500);
  check(adminRequests.length === before, 'no polling or retry after remote STOP');
  pollMode = 'ok';

  // 10. Expired session disables ADMIN.
  expiresAt = new Date(Date.now() + 4_000).toISOString();
  await refresh('INTERACTIVE'); await refresh('ADMIN');
  check((await adminState.textContent()) === 'ADMIN: AVAILABLE', 'fresh ADMIN session available');
  await adminState.getByText('ADMIN DISABLED: SESSION_EXPIRED').waitFor({ timeout: 8_000 });
  check(await allDisabled(), 'expired session disables ADMIN');
  expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

  // 11. XSS-safe remote error.
  await refresh('INTERACTIVE'); await refresh('ADMIN');
  adminMode = XSS;
  await button('Read system info').click();
  await page.getByLabel('ADMIN error').waitFor();
  check((await page.getByLabel('ADMIN error').textContent()) === XSS, 'remote error rendered as literal text');
  check(await page.evaluate(() => window.__xssFired === undefined), 'remote error XSS inert');
  adminMode = 'ok';

  // 12. STOP SESSION removes ADMIN and stops pending polling.
  await request('LOGOFF');
  await button('Stop session').click();
  await page.getByText(/CONNECTION: DISCONNECTED/).waitFor();
  check(await adminHeading.count() === 0, 'STOP SESSION removes the ADMIN section');
  before = adminRequests.length;
  await settle(3_500);
  check(adminRequests.length === before, 'no ADMIN request after STOP SESSION');

  // 13. Only explicit clicks, only semantic loopback routes.
  const confirms = adminRequests.filter(value => /\/request$/.test(value.path));
  check(confirms.length === 5 && confirms.every(value => /^\{"confirm":"(LOCK|LOGOFF|RESTART|SHUTDOWN)"\}$/.test(value.body)), 'every high-impact request came from a confirmed click');
  check(adminRequests.every(value => /^(system-info|processes|services|network|disks|(lock|logoff|restart|shutdown)\/request|operations\/[0-9a-f-]{36}(\/cancel)?)$/.test(value.path)), 'semantic ADMIN routes only');
  check(!requests.some(value => /\/(execute|shell|command|script|raw|rpc)\b/.test(value.url)), 'no generic execution route used');
  check(requests.every(value => /^(http:\/\/127\.0\.0\.1[:/]|data:|blob:)/.test(value.url)), 'all requests stay on loopback');
  check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
  console.log(`OMEGA ADMIN BROWSER PASS ${assertions}/${assertions}`);
} finally {
  await browser?.close();
  await server?.close();
}
