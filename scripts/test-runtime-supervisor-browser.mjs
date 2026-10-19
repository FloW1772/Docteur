// Runtime Supervisor V1 — browser suite. The REAL SettingsModal / Runtime tab in Chromium; /api/runtime/* answered
// in-process by the REAL route + supervisor driving REAL test fixture processes (127.0.0.1, random ports). Every other
// request (the Models tab's own calls) is aborted and counted — nothing reaches a real Docteur, Ollama or the Internet.
// Usage: node scripts/test-runtime-supervisor-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { createRuntimeSupervisor, createRuntimeAuditLog } from '../cortex-server/src/lib/runtime-supervisor.js';
import { createRuntimeSupervisorRoute } from '../cortex-server/src/routes/runtime-supervisor.js';
import { killProcessTree } from '../cortex-server/src/lib/process-tree.js';

let assertions = 0; const results = [];
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const REAL = ['cortex.sqlite', 'cortex.sqlite-wal', path.join('companion-v1', 'companion.sqlite')].map(f => path.resolve('cortex-server', 'data', f));
const realBefore = REAL.map(sha);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-browser-'));
const FIXTURE = path.resolve('cortex-server', 'fixtures', 'runtime-fixture-service.mjs');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// ── backend: real supervisor over fixture processes ──
async function fixture(id, name, mode, extra = []) {
  const port = await freePort(); const control = path.join(TMP, `${id}.ctl`);
  return { control, def: {
    serviceId: id, displayName: name, ownershipClass: 'DOCTEUR_OWNED', kind: 'SPAWN', optional: true,
    launch: { executable: process.execPath, args: [FIXTURE, '--port', String(port), '--mode', mode, '--control', control, ...extra], cwd: path.dirname(FIXTURE) },
    healthCheck: { host: '127.0.0.1', port, path: '/health', identity: true, timeoutMs: 800 },
    gracefulStop: { kind: 'HTTP_POST', path: '/shutdown' }, gracefulStopTimeoutMs: 1_500, startTimeoutMs: 4_000,
  } };
}
const F = {
  healthy: await fixture('fixture-healthy', 'Service sain (fixture)', 'healthy'),
  crash: await fixture('fixture-crash', 'Service qui plante (fixture)', 'crash-after', ['--after', '500']),
  unhealthy: await fixture('fixture-degraded', 'Service dégradé (fixture)', 'unhealthy'),
  loop: await fixture('fixture-loop', 'Service en boucle de plantage (fixture)', 'crash-on-start'),
};
const observed = { serviceId: 'external-runtime', displayName: 'Runtime externe (observé)', ownershipClass: 'EXTERNAL_OBSERVED', kind: 'OBSERVED', optional: true,
  observe: async () => ({ state: 'HEALTHY', health: { status: 'HEALTHY', code: 'API_OK' }, portListening: true }) };
const self = { serviceId: 'docteur-backend', displayName: 'Serveur Docteur (cortex-server)', ownershipClass: 'DOCTEUR_OWNED', kind: 'SELF', optional: false,
  observe: async () => ({ state: 'HEALTHY', health: { status: 'HEALTHY', code: 'IN_PROCESS' }, pid: process.pid, uptimeMs: 123_000, processRunning: true }) };
const services = [self, F.healthy.def, F.crash.def, F.unhealthy.def, F.loop.def, observed];
const spawned = [];
const spawnSpy = (exe, args, opts) => { const c = spawn(exe, args, opts); spawned.push(c); return c; };
const limits = { backoffBaseMs: 3_000, backoffMaxMs: 3_000, healthPollMs: 50, portReleaseTimeoutMs: 2_000 };
const allowSup = createRuntimeSupervisor({ services, spawnImpl: spawnSpy, killTree: killProcessTree, policyDecide: () => ({ decision: 'ALLOW', code: 'ALLOW_TEST' }), audit: createRuntimeAuditLog(), limits });
const realPolicySup = createRuntimeSupervisor({ services: [self, F.healthy.def, observed], spawnImpl: spawnSpy, killTree: killProcessTree, audit: createRuntimeAuditLog(), limits }); // real sealed Root Policy
// the route module carries its own Hono app (mounted under /api in server.js): requests are forwarded without the prefix
const apps = { allow: createRuntimeSupervisorRoute({ supervisor: allowSup }), real: createRuntimeSupervisorRoute({ supervisor: realPolicySup }) };
let currentApp = apps.allow; const restartPosts = []; let aborted = 0; const pageErrors = [];

// prepare states: healthy, crashed, degraded, blocked
await allowSup.restart('fixture-healthy'); await allowSup.whenIdle('fixture-healthy');
await allowSup.restart('fixture-degraded'); await allowSup.whenIdle('fixture-degraded');
await allowSup.restart('fixture-crash'); await allowSup.whenIdle('fixture-crash');
for (let i = 0; i < 3; i++) {
  const s = await allowSup.get('fixture-loop');
  if (s.state === 'BLOCKED') break;
  if (s.state === 'BACKOFF' || s.state === 'CRASHED') await sleep(limits.backoffBaseMs + 100);
  await allowSup.restart('fixture-loop').catch(() => {}); await allowSup.whenIdle('fixture-loop');
}
for (let i = 0; i < 60 && (await allowSup.get('fixture-crash')).state !== 'CRASHED'; i++) await sleep(50);

// ── browser plumbing ──
const PORT = 5272;
const htmlFor = (cfg) => `<div id="root"></div><script>window.__rsHarness=${JSON.stringify(cfg)};</script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/runtime-supervisor-ui-harness.jsx");mount();</script>`;
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-runtime-supervisor', plugins: [react()], optimizeDeps: { entries: ['scripts/runtime-supervisor-ui-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
async function openPage({ mode = 'modal', viewport = { width: 1100, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('pageerror', (e) => { pageErrors.push(String(e?.message ?? e).slice(0, 200)); });
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.pathname.startsWith('/api/runtime/')) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
      if (req.method() === 'POST') restartPosts.push(url.pathname);
      const res = await currentApp.request(url.pathname.slice('/api'.length), { method: req.method(), headers: { 'content-type': 'application/json' }, body: req.method() === 'POST' ? req.postData() ?? '' : undefined });
      return route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text(), headers: cors });
    }
    if (url.origin === `http://127.0.0.1:${PORT}` && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: htmlFor({ mode }) });
    if (url.origin === `http://127.0.0.1:${PORT}`) return route.continue();
    aborted += 1; return route.abort();
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  return { page, context };
}
const card = (page, id) => page.locator(`[data-testid="rs-service-${id}"]`);
const waitState = async (page, id, state, timeout = 15_000) => page.waitForFunction(([i, s]) => document.querySelector(`[data-testid="rs-service-${i}"]`)?.dataset.state === s, [id, state], { timeout });
async function scenario(name, fn) { const t = Date.now(); await fn(); results.push(`✔ ${name} (${Date.now() - t} ms)`); }

try {
  const { page, context } = await openPage();
  await scenario('1. Settings opens; the Runtime / Services tab is listed and opens the section', async () => {
    await page.getByRole('dialog', { name: 'Paramètres' }).waitFor();
    const tab = page.getByRole('button', { name: 'RUNTIME / SERVICES', exact: true });
    await tab.click();
    await page.getByTestId('runtime-services').waitFor();
    ok(await page.getByRole('heading', { name: 'RUNTIME / SERVICES' }).isVisible(), 'section heading');
    await card(page, 'fixture-healthy').waitFor();
    eq(await page.locator('[data-testid^="rs-service-"]').count(), 6, 'one card per registered service');
  });

  await scenario('2. healthy / degraded / crashed / blocked states, ownership, PID, uptime, last exit, sanitized error', async () => {
    eq(await card(page, 'fixture-healthy').getAttribute('data-state'), 'HEALTHY');
    eq(await card(page, 'fixture-degraded').getAttribute('data-state'), 'DEGRADED');
    eq(await card(page, 'fixture-crash').getAttribute('data-state'), 'CRASHED');
    eq(await card(page, 'fixture-loop').getAttribute('data-state'), 'BLOCKED');
    ok((await card(page, 'fixture-healthy').innerText()).includes('Sain'));
    ok((await card(page, 'fixture-degraded').innerText()).includes('Dégradé'));
    const crash = await card(page, 'fixture-crash').innerText();
    ok(crash.includes('Planté') && /Dernier code de sortie\s*3/.test(crash), 'crashed + exit code 3');
    ok(crash.includes('Le processus s’est arrêté de façon inattendue.'), 'sanitized last error');
    ok((await card(page, 'fixture-loop').innerText()).includes('Bloqué'));
    const selfText = await card(page, 'docteur-backend').innerText();
    ok(selfText.includes(String(process.pid)) && selfText.includes('2 min') && selfText.includes('Docteur (propriétaire)'), 'PID / uptime / ownership');
    ok((await card(page, 'external-runtime').innerText()).includes('Externe — observé seulement'));
    const all = await page.getByTestId('runtime-services').innerText();
    ok(!all.includes(FIXTURE) && !all.includes(process.execPath) && !all.includes('--port'), 'no command line / path in the UI');
  });

  await scenario('3. restart forbidden ⇒ disabled button with an explained reason (external, self)', async () => {
    for (const [id, text] of [['external-runtime', 'Service non détenu par Docteur'], ['docteur-backend', 'ne peut pas se relancer lui-même']]) {
      const b = card(page, id).getByTestId('rs-restart');
      ok(await b.isDisabled(), `${id} disabled`);
      const described = await b.getAttribute('aria-describedby');
      ok(described && (await page.locator(`#${described}`).innerText()).includes(text), `${id} reason linked by aria-describedby`);
    }
  });

  await scenario('4. keyboard: Tab reaches « Relancer », Enter opens the confirmation, focus on confirm, Escape cancels', async () => {
    const b = card(page, 'fixture-healthy').getByTestId('rs-restart');
    await b.focus();
    eq(await page.evaluate(() => document.activeElement?.dataset.testid), 'rs-restart');
    await page.keyboard.press('Enter');
    await card(page, 'fixture-healthy').getByRole('alertdialog').waitFor();
    eq(await page.evaluate(() => document.activeElement?.dataset.testid), 'rs-confirm-yes', 'focus moved to confirm');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="rs-service-fixture-healthy"] [role="alertdialog"]'));
    eq(restartPosts.length, 0, 'cancel sends nothing');
  });

  await scenario('5. restart with confirmation: in progress (disabled, busy), repeated clicks ignored, then success', async () => {
    fs.writeFileSync(F.healthy.control, 'slow'); // the relaunch takes ~1.5 s so "in progress" is observable
    const before = restartPosts.length;
    await card(page, 'fixture-healthy').getByTestId('rs-restart').click();
    await card(page, 'fixture-healthy').getByTestId('rs-confirm-yes').click();
    const b = card(page, 'fixture-healthy').getByTestId('rs-restart');
    await page.waitForFunction(() => document.querySelector('[data-testid="rs-service-fixture-healthy"] [data-testid="rs-restart"]')?.getAttribute('aria-busy') === 'true');
    ok(await b.isDisabled(), 'disabled while in progress');
    await b.click({ force: true }).catch(() => {}); await b.click({ force: true }).catch(() => {});
    await waitState(page, 'fixture-healthy', 'HEALTHY', 20_000);
    await page.waitForFunction(() => (document.querySelector('[data-testid="rs-service-fixture-healthy"] [data-testid="rs-message"]')?.textContent ?? '').includes('Relance réussie'), null, { timeout: 15_000 });
    eq(restartPosts.length - before, 1, 'exactly one restart request');
    ok((await card(page, 'fixture-healthy').innerText()).includes('Dernière relance'));
  });

  await scenario('6. failure: a crashed service relaunched into a crash ⇒ sanitized failure message', async () => {
    fs.writeFileSync(F.crash.control, 'crash-on-start');
    await sleep(limits.backoffMaxMs + 200); // let the crash backoff window pass, then refresh explicitly
    await page.getByTestId('rs-refresh').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="rs-service-fixture-crash"] [data-testid="rs-restart"]')?.disabled, null, { timeout: 5_000 });
    await card(page, 'fixture-crash').getByTestId('rs-restart').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="rs-service-fixture-crash"] [data-testid="rs-message"]')?.textContent ?? '').startsWith('Relance échouée'), null, { timeout: 15_000 });
    eq(await card(page, 'fixture-crash').getAttribute('data-state'), 'CRASHED');
    const msg = await card(page, 'fixture-crash').getByTestId('rs-message').innerText();
    ok(!/exit|Error:|node|\\|\//i.test(msg), 'no raw process text');
  });

  await scenario('7. backoff refusal is explained with the retry time', async () => {
    const b = card(page, 'fixture-crash').getByTestId('rs-restart');
    ok(await b.isDisabled(), 'backoff ⇒ disabled');
    ok((await card(page, 'fixture-crash').getByTestId('rs-restart-reason').innerText()).includes('Relance suspendue'));
  });

  await scenario('8. blocked: « Débloquer et relancer » requires an explicit reset confirmation, then recovers', async () => {
    fs.writeFileSync(F.loop.control, 'healthy');
    const b = card(page, 'fixture-loop').getByTestId('rs-restart');
    eq((await b.innerText()).trim(), 'Débloquer et relancer');
    await b.click();
    const dlg = card(page, 'fixture-loop').getByRole('alertdialog');
    ok((await dlg.innerText()).includes('planté plusieurs fois'), 'reset explanation');
    await card(page, 'fixture-loop').getByTestId('rs-confirm-yes').click();
    await waitState(page, 'fixture-loop', 'HEALTHY', 20_000);
  });

  await scenario('9. accessibility basics: named list, labelled dialog, every button has an accessible name', async () => {
    ok(await page.getByRole('list', { name: 'Services Docteur' }).isVisible());
    const unnamed = await page.$$eval('[data-testid="runtime-services"] button', (bs) => bs.filter(b => !(b.textContent ?? '').trim() && !b.getAttribute('aria-label')).length);
    eq(unnamed, 0);
    await card(page, 'fixture-healthy').getByTestId('rs-restart').click();
    const dlg = card(page, 'fixture-healthy').getByRole('alertdialog');
    ok(Boolean(await dlg.getAttribute('aria-labelledby')));
    await card(page, 'fixture-healthy').getByTestId('rs-confirm-no').click();
  });
  await context.close();

  await scenario('10. sealed Root Policy: restart disabled with the policy reason; nothing launched', async () => {
    currentApp = apps.real;
    const before = spawned.length;
    const { page: p2, context: c2 } = await openPage();
    await p2.getByRole('button', { name: 'RUNTIME / SERVICES', exact: true }).click();
    await card(p2, 'fixture-healthy').waitFor();
    const b = card(p2, 'fixture-healthy').getByTestId('rs-restart');
    ok(await b.isDisabled(), 'disabled under the sealed policy');
    ok((await card(p2, 'fixture-healthy').getByTestId('rs-restart-reason').innerText()).includes('Root Policy'), 'policy reason');
    eq(spawned.length, before, 'nothing launched');
    await c2.close();
    currentApp = apps.allow;
  });

  await scenario('11. responsive: 375 px wide, no horizontal overflow in the Runtime section, actions reachable', async () => {
    const { page: p3, context: c3 } = await openPage({ mode: 'tab', viewport: { width: 375, height: 800 } });
    await card(p3, 'fixture-healthy').waitFor();
    const overflow = await p3.evaluate(() => { const el = document.querySelector('[data-testid="runtime-services"]'); return el.scrollWidth - el.clientWidth; });
    ok(overflow <= 1, `overflow ${overflow}px`);
    const docOverflow = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(docOverflow <= 1, `page overflow ${docOverflow}px`);
    ok(await card(p3, 'fixture-healthy').getByTestId('rs-restart').isVisible());
    await c3.close();
  });
} finally {
  await browser.close();
  await server.close();
  await allowSup.shutdown(); await realPolicySup.shutdown();
  for (const c of spawned) if (c.exitCode === null) await killProcessTree(c);
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
}

eq(spawned.every(c => c.exitCode !== null || c.signalCode !== null), true, 'no fixture left running');
assert.deepEqual(pageErrors, [], 'no page error'); assertions += 1;
assert.deepEqual(REAL.map(sha), realBefore, 'real DB and Companion store untouched'); assertions += 1;
console.log(results.join('\n'));
console.log(`aborted non-runtime requests (Models tab calls, never sent): ${aborted}`);
console.log(`RUNTIME SUPERVISOR BROWSER: ${results.length} scenarios, ${assertions} assertions — PASS`);
