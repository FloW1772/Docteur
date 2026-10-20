// [RS-KIWIX-RESTART] browser suite — the REAL Runtime / Services UI in Chromium (inside the REAL SettingsModal for scenario 1).
// /api/runtime/* is served over REAL loopback HTTP (@hono/node-server) by the REAL route + supervisor + restart authority over a REAL
// Kiwix lifecycle (fixture process on 127.0.0.1, random port), behind the product's own CORS + applyLocalApiSecurity guard: the
// UI-only ceremony gate sees exactly what the browser sends (Origin, Sec-Fetch-Site) and the real peer address (getConnInfo).
//   • "LIVE"           : the authority uses the REAL Root Policy (the shipped signed V2, read-only) ⇒ only Kiwix « Relancer » offered
//   • "V1_HISTORICAL"  : the historical signed V1 (public fixture) in an in-memory engine ⇒ Kiwix restart refused with the policy reason
//   • "V2"             : the reviewed V2 in an in-memory engine ⇒ the ceremony runs end to end (never touches the live policy)
// Every other request is aborted and counted — nothing reaches a real Docteur, Ollama or the Internet.
// Usage: node scripts/test-runtime-kiwix-restart-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import * as db from '../cortex-server/src/lib/sqlite.js';
import { createKiwixLifecycle, createKiwixLifecyclePort, KIWIX_BINARY_NAME } from '../cortex-server/src/lib/kiwix.js';
import { createRuntimeSupervisor, createRuntimeAuditLog } from '../cortex-server/src/lib/runtime-supervisor.js';
import { createProductRuntimeServices } from '../cortex-server/src/lib/runtime-supervisor-services.js';
import { createRuntimeSupervisorRoute } from '../cortex-server/src/routes/runtime-supervisor.js';
import { createRestartAuthority } from '../cortex-server/src/lib/runtime-restart-authority.js';
import { createEngine } from '../cortex-server/src/lib/root-policy/engine.js';
import { buildCandidateText } from '../cortex-server/root-policy-v2-candidate.mjs';
import { SHIPPED_POLICY, loadHistoricalV1 } from '../cortex-server/fixtures/root-policy-history.mjs';
import { killProcessTree } from '../cortex-server/src/lib/process-tree.js';
import { applyLocalApiSecurity } from '../cortex-server/src/lib/local-api-policy.js';

// the server's own hono / node-server / cors (resolved from cortex-server, as the route module does)
const fromServer = createRequire(path.resolve('cortex-server', 'package.json'));
const load = (id) => import(pathToFileURL(fromServer.resolve(id)).href);
const [{ Hono }, { serve }, { cors }] = await Promise.all([load('hono'), load('@hono/node-server'), load('hono/cors')]);

db.initSqlite(':memory:');
let assertions = 0; const results = [];
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const REAL = ['cortex.sqlite', 'cortex.sqlite-wal', path.join('companion-v1', 'companion.sqlite')].map(f => path.resolve('cortex-server', 'data', f));
const POLICY = ['root-policy.json', 'root-policy.sig.json', 'signing-log.jsonl'].map(f => path.resolve('cortex-server', 'policy', f));
const realBefore = REAL.map(sha); const policyBefore = POLICY.map(sha);
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rskr-browser-')));
const FIXTURE = path.resolve('cortex-server', 'fixtures', 'kiwix-fixture-serve.mjs');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const PORT = 5274;
const PAGE_ORIGIN = `http://127.0.0.1:${PORT}`;
process.env.DOCTEUR_ALLOWED_ORIGINS = PAGE_ORIGIN; // the product's own allow-list mechanism for an extra frontend origin

// ── backend: a real Kiwix lifecycle over the fixture, two supervisors (active V1 / candidate V2) ──
const BIN_DIR = path.join(TMP, 'Kiwix Tools'); fs.mkdirSync(BIN_DIR); fs.writeFileSync(path.join(BIN_DIR, KIWIX_BINARY_NAME), 'stand-in, never executed');
const ZIM_DIR = path.join(TMP, 'ZIM'); fs.mkdirSync(ZIM_DIR); fs.writeFileSync(path.join(ZIM_DIR, 'pokepedia.zim'), 'archive');
const settings = { kiwixServePath: BIN_DIR, archivesFolder: ZIM_DIR, port: await freePort() };
const spawned = [];
const lc = createKiwixLifecycle({
  spawnFn: (binary, args, opts) => { const c = spawn(process.execPath, [FIXTURE, '--fixture-mode=slow', '--fixture-delay=900', ...args], opts); spawned.push(c); return c; },
  getSettings: () => settings, limits: { healthAttempts: 40, healthIntervalMs: 100, verifyWindowMs: 5_000, stopGraceMs: 1_500, forceWaitMs: 2_000, portReleaseMs: 1_500 },
});
const V2 = JSON.parse(buildCandidateText({ issuedAt: SHIPPED_POLICY.issuedAt }));
const candidate = createEngine({ getPolicy: () => ({ valid: true, policy: V2, version: 2 }) });
const V1 = loadHistoricalV1().policy; // the HISTORICAL signed V1 (public fixture) — never the live file
const historical = createEngine({ getPolicy: () => ({ valid: true, policy: V1, version: 1 }) });
/** 'LIVE' = the real Root Policy (real decide + real view of the shipped signed policy) · 'V2' = in-memory reviewed V2 · 'V1_HISTORICAL' = in-memory historical V1 */
const AUTHORITIES = {
  LIVE: () => createRestartAuthority({ services: ['kiwix-serve'] }),
  V1_HISTORICAL: () => createRestartAuthority({ services: ['kiwix-serve'], policyDecide: (q) => historical.decide(q), policyView: () => ({ status: { state: 'VALID', version: 1 }, policy: V1 }) }),
  V2: () => createRestartAuthority({ services: ['kiwix-serve'], policyDecide: (q) => candidate.decide(q), policyView: () => ({ status: { state: 'VALID' }, policy: V2 }) }),
};
/** [RS-UI-1] a stub Kiwix port that only REPORTS a lifecycle status (nothing is spawned, hung or killed). */
const reportingPort = (reported) => ({
  serviceId: 'kiwix-serve',
  getLifecycleStatus: () => ({ serviceId: 'kiwix-serve', port: 18_000, startedAt: new Date(Date.now() - 60_000).toISOString(), generation: 2, definitionDigest: 'a'.repeat(64), ...reported }),
  restartOwnedKiwix: async () => ({ ok: false, error: 'restart_not_authorized' }),
});
function supervisorFor(mode, kiwixPort = null) {
  const authority = AUTHORITIES[mode]();
  const port = kiwixPort ?? createKiwixLifecyclePort({ lifecycle: lc, redeemRestartAuthorization: authority.redeem });
  const services = createProductRuntimeServices({ ollamaUrl: 'http://127.0.0.1:9', kiwixDelegate: port, comfy: { installState: () => ({ kind: 'none', status: 'not_installed' }) }, uptime: () => 123_000 });
  const sup = createRuntimeSupervisor({ services, restartAuthority: authority, audit: createRuntimeAuditLog(), probe: async (r) => (r.port === 9 ? { code: 'OK', headers: {} } : { code: 'REFUSED' }) });
  // product-shaped HTTP stack: CORS for the page origin → NB-7 local API guard → the REAL route (default loopback peer check)
  const app = new Hono();
  app.use('*', cors({ origin: (o) => (o === PAGE_ORIGIN ? o : null), allowMethods: ['GET', 'POST'], allowHeaders: ['content-type'] }));
  applyLocalApiSecurity(app, { isAllowedOrigin: (o) => o === PAGE_ORIGIN });
  app.use('/api/runtime/*', async (c, next) => { // test recorder: what the SERVER received
    if (c.req.method === 'POST') posts.push({ mode, path: new URL(c.req.url).pathname, origin: c.req.header('origin') ?? null, site: c.req.header('sec-fetch-site') ?? null, body: await c.req.text() });
    await next();
    if (c.req.method === 'POST') {
      const text = await c.res.clone().text();
      responses.push({ mode, path: new URL(c.req.url).pathname, status: c.res.status, body: text.slice(0, 200) });
      if (c.req.url.endsWith('/restart-challenge') && c.res.status === 201) challengeIds.push(JSON.parse(text).value.challengeId);
    }
  });
  app.route('/api', createRuntimeSupervisorRoute({ supervisor: sup }));
  return new Promise((resolve) => { const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => resolve({ sup, server: s, origin: `http://127.0.0.1:${info.port}` })); });
}
const posts = []; const responses = []; const challengeIds = []; let aborted = 0; const pageErrors = [];
const worlds = { LIVE: await supervisorFor('LIVE'), V1_HISTORICAL: await supervisorFor('V1_HISTORICAL'), V2: await supervisorFor('V2') };
const uiWorlds = {
  STOP_TIMEOUT: await supervisorFor('V2', reportingPort({ state: 'DEGRADED', owned: true, pid: 4242, lastError: 'stop_timeout' })),
  OTHER_DEGRADED: await supervisorFor('V2', reportingPort({ state: 'DEGRADED', owned: true, pid: 4242, lastError: 'start_timeout' })),
  STOPPED: await supervisorFor('V2', reportingPort({ state: 'STOPPED', owned: false, pid: null, lastError: null })),
};

// ── browser plumbing ──
// the harness page is SERVED BY VITE ON LOOPBACK (like the product UI), not fulfilled by Playwright: a fulfilled document has no local
// address space, and Chromium's private-network checks would then (rightly) block its calls to a loopback API. Config = URL hash.
const HARNESS_HTML = '<div id="root"></div><script>window.__rsHarness=JSON.parse(decodeURIComponent(location.hash.slice(1)||"%7B%7D"));</script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/runtime-supervisor-ui-harness.jsx");mount();</script>';
const harnessPage = { name: 'rskr-harness-page', configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url === '/__rskr') { res.setHeader('content-type', 'text/html'); res.end(HARNESS_HTML); } else next(); }); } };
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-runtime-kiwix-restart', plugins: [react(), harnessPage], optimizeDeps: { entries: ['scripts/runtime-supervisor-ui-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
/**
 * tab mode: the Runtime tab talks straight to the world's REAL loopback API (not intercepted: real headers, real peer).
 * modal mode: the REAL SettingsModal (its tab targets :3001) — those requests are re-addressed to the world's API (V1 check, GETs only).
 */
async function openPage(world, { mode = 'tab', viewport = { width: 1100, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('pageerror', (e) => { pageErrors.push(String(e?.message ?? e).slice(0, 200)); });
  page.on('requestfailed', (r) => { if (!new URL(r.url()).pathname.startsWith('/api/runtime/') || new URL(r.url()).port === '3001') return; console.error(`request failed: ${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`); });
  await page.route((url) => url.origin !== world.origin && url.origin !== PAGE_ORIGIN, async (route) => {
    const url = new URL(route.request().url());
    if (mode === 'modal' && url.port === '3001' && url.pathname.startsWith('/api/runtime/') && route.request().method() === 'GET') {
      const response = await route.fetch({ url: `${world.origin}${url.pathname}${url.search}`, headers: { origin: PAGE_ORIGIN } });
      return route.fulfill({ response });
    }
    aborted += 1; return route.abort();
  });
  await page.goto(`${PAGE_ORIGIN}/__rskr#${encodeURIComponent(JSON.stringify({ mode, baseUrl: world.origin }))}`);
  if (mode === 'modal') { await page.getByRole('dialog', { name: 'Paramètres' }).waitFor(); await page.getByRole('button', { name: 'RUNTIME / SERVICES', exact: true }).click(); }
  await page.getByTestId('rs-service-kiwix-serve').waitFor();
  return { page, context };
}
const card = (page, id) => page.locator(`[data-testid="rs-service-${id}"]`);
const confirmPosts = () => posts.filter(p => p.path.endsWith('/restart-confirm')).length;
async function scenario(name, fn) {
  const t = Date.now();
  try { await fn(); } catch (e) { console.error(`✖ ${name}\n  last posts: ${JSON.stringify(posts.slice(-3))}\n  last responses: ${JSON.stringify(responses.slice(-3))}`); throw e; }
  results.push(`✔ ${name} (${Date.now() - t} ms)`);
}
const waitText = (page, id, testid, re, timeout = 20_000) => page.waitForFunction(([i, t, src]) => new RegExp(src).test(document.querySelector(`[data-testid="rs-service-${i}"] [data-testid="${t}"]`)?.textContent ?? ''), [id, testid, re.source], { timeout });

try {
  await lc.start();
  const firstPid = lc.status().pid;

  await scenario('1. REAL SettingsModal — LIVE shipped signed V2: Kiwix « Relancer » enabled, every other service disabled with a reason; HISTORICAL V1: Kiwix disabled with the Root Policy reason and a forced challenge is refused', async () => {
    const live = await openPage(worlds.LIVE, { mode: 'modal' });
    ok(!(await card(live.page, 'kiwix-serve').getByTestId('rs-restart').isDisabled()), 'kiwix enabled under the live V2');
    for (const id of ['ollama', 'docteur-backend', 'docteur-frontend', 'comfyui']) ok(await card(live.page, id).getByTestId('rs-restart').isDisabled(), `${id} disabled under the live V2`);
    eq(posts.length, 0, 'nothing posted by the UI');
    eq(lc.status().pid, firstPid, 'nothing restarted');
    await live.context.close();
    const { page, context } = await openPage(worlds.V1_HISTORICAL, { mode: 'modal' });
    const b = card(page, 'kiwix-serve').getByTestId('rs-restart');
    ok(await b.isDisabled(), 'disabled under the historical V1');
    ok((await card(page, 'kiwix-serve').getByTestId('rs-restart-reason').innerText()).includes('Root Policy'), 'policy reason shown');
    eq(posts.length, 0, 'nothing posted by the UI');
    const forced = await page.evaluate(async (api) => { const r = await fetch(`${api}/api/runtime/services/kiwix-serve/restart-challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: r.status, code: (await r.json()).error?.code }; }, worlds.V1_HISTORICAL.origin);
    eq(forced.status, 403); eq(forced.code, 'RS_POLICY_APPROVAL_REQUIRED');
    eq(lc.status().pid, firstPid, 'nothing restarted');
    await context.close();
  });

  const { page, context } = await openPage(worlds.V2);
  await scenario('2. CANDIDATE: « Relancer » enabled ONLY for Kiwix; Ollama (external), backend (self), frontend and ComfyUI stay disabled with reasons', async () => {
    ok(!(await card(page, 'kiwix-serve').getByTestId('rs-restart').isDisabled()), 'kiwix enabled');
    for (const id of ['ollama', 'docteur-backend', 'docteur-frontend', 'comfyui']) {
      ok(await card(page, id).getByTestId('rs-restart').isDisabled(), `${id} disabled`);
      ok((await card(page, id).getByTestId('rs-restart-reason').innerText()).length > 0, `${id} reason`);
    }
    ok((await card(page, 'ollama').innerText()).includes('Externe — observé seulement'));
    ok((await card(page, 'docteur-backend').getByTestId('rs-restart-reason').innerText()).includes('ne peut pas se relancer lui-même'));
  });

  await scenario('3. the confirmation dialog shows Kiwix, its state, what is interrupted, archives unchanged, the operation — never a token, path, PID action or policy detail', async () => {
    await card(page, 'kiwix-serve').getByTestId('rs-restart').click();
    const dlg = card(page, 'kiwix-serve').getByTestId('rs-ceremony');
    await dlg.waitFor();
    const text = await dlg.innerText();
    for (const s of ['Relancer Kiwix (archives hors-ligne)', 'État actuel : Sain', 'interrompues', 'archives locales restent inchangées', 'Opération : arrêt vérifié du service, puis redémarrage local']) ok(text.includes(s), s);
    const all = await page.getByTestId('runtime-services').innerText();
    ok(!all.includes(challengeIds.at(-1)), 'challenge id never displayed');
    for (const leak of [TMP, BIN_DIR, '--blockexternal', '--port', 'certified', 'ALLOW', 'SERVICE_RESTART']) ok(!all.includes(leak), `no ${leak.slice(0, 20)}`);
    eq(await page.evaluate(() => document.activeElement?.dataset.testid), 'rs-ceremony-confirm', 'focus on confirm');
    const req = posts.at(-1);
    eq(req.path, '/api/runtime/services/kiwix-serve/restart-challenge'); eq(req.origin, PAGE_ORIGIN); ok(['same-origin', 'same-site'].includes(req.site), `fetch metadata ${req.site}`);
    eq(req.body, '{}', 'the challenge request carries nothing');
  });

  await scenario('4. cancel (button) and Escape close the dialog and send nothing', async () => {
    await card(page, 'kiwix-serve').getByTestId('rs-ceremony-cancel').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="rs-ceremony"]'));
    ok((await card(page, 'kiwix-serve').getByTestId('rs-message').innerText()).includes('Relance annulée'));
    await card(page, 'kiwix-serve').getByTestId('rs-restart').click();
    await card(page, 'kiwix-serve').getByTestId('rs-ceremony').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="rs-ceremony"]'));
    eq(confirmPosts(), 0, 'no confirmation sent');
    eq(lc.status().pid, firstPid, 'nothing restarted');
  });

  await scenario('5. a script-dispatched (untrusted) click is refused client-side; nothing is sent', async () => {
    await card(page, 'kiwix-serve').getByTestId('rs-restart').click();
    await card(page, 'kiwix-serve').getByTestId('rs-ceremony').waitFor();
    await page.evaluate(() => document.querySelector('[data-testid="rs-ceremony-confirm"]').click());
    await waitText(page, 'kiwix-serve', 'rs-message', /geste non reconnu/);
    eq(confirmPosts(), 0); eq(lc.status().pid, firstPid);
  });

  let restartedPid;
  await scenario('6. confirm with a real click: progress shown, repeated clicks ignored, exactly one confirmation, Kiwix back HEALTHY with a new process', async () => {
    await card(page, 'kiwix-serve').getByTestId('rs-restart').click();
    await card(page, 'kiwix-serve').getByTestId('rs-ceremony').waitFor();
    const before = confirmPosts();
    await card(page, 'kiwix-serve').getByTestId('rs-ceremony-confirm').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="rs-service-kiwix-serve"] [data-testid="rs-restart"]')?.getAttribute('aria-busy') === 'true', null, { timeout: 5_000 });
    const b = card(page, 'kiwix-serve').getByTestId('rs-restart');
    ok(await b.isDisabled(), 'disabled while in progress');
    await b.click({ force: true }).catch(() => {}); await b.click({ force: true }).catch(() => {});
    await waitText(page, 'kiwix-serve', 'rs-message', /Relance réussie/);
    eq(await card(page, 'kiwix-serve').getAttribute('data-state'), 'HEALTHY');
    eq(confirmPosts() - before, 1, 'exactly one confirmation');
    const sent = JSON.parse(posts.filter(p => p.path.endsWith('/restart-confirm')).at(-1).body);
    eq(JSON.stringify(Object.keys(sent).sort()), '["challengeId","gesture"]'); eq(sent.gesture.kind, 'POINTER'); eq(sent.gesture.trusted, true);
    restartedPid = lc.status().pid;
    ok(restartedPid !== firstPid, 'new process'); eq(spawned[0].exitCode !== null || spawned[0].signalCode !== null, true, 'old process exited');
  });

  await scenario('7. replay of the used challenge (from the page) is refused by the server; nothing restarts', async () => {
    const used = challengeIds.at(-1);
    const r = await page.evaluate(async ([api, id]) => { const res = await fetch(`${api}/api/runtime/services/kiwix-serve/restart-confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: id, gesture: { kind: 'POINTER', trusted: true } }) }); return { status: res.status, code: (await res.json()).error?.code }; }, [worlds.V2.origin, used]);
    eq(r.status, 409); eq(r.code, 'RS_CHALLENGE_REPLAYED');
    eq(lc.status().pid, restartedPid, 'still the same process');
  });

  await scenario('8. stale confirmation (Kiwix restarted elsewhere while the dialog was open) ⇒ sanitized failure, nothing restarted by the ceremony', async () => {
    await card(page, 'kiwix-serve').getByTestId('rs-restart').click();
    await card(page, 'kiwix-serve').getByTestId('rs-ceremony').waitFor();
    await lc.stop(); await lc.start(); // e.g. the user restarted Kiwix from its own settings
    const pidNow = lc.status().pid; const launches = spawned.length;
    await card(page, 'kiwix-serve').getByTestId('rs-ceremony-confirm').click();
    await waitText(page, 'kiwix-serve', 'rs-message', /changé depuis la demande/);
    const msg = await card(page, 'kiwix-serve').getByTestId('rs-message').innerText();
    ok(!/RS_|INSTANCE|digest|Error|\\|\//.test(msg), `sanitized: ${msg}`);
    eq(lc.status().pid, pidNow); eq(spawned.length, launches);
  });

  await scenario('9. keyboard only: Tab-focus « Relancer », Enter opens, focus on confirm, Enter confirms (gesture KEYBOARD) → HEALTHY', async () => {
    await page.waitForFunction(() => !document.querySelector('[data-testid="rs-service-kiwix-serve"] [data-testid="rs-restart"]')?.disabled, null, { timeout: 10_000 });
    await card(page, 'kiwix-serve').getByTestId('rs-restart').focus();
    await page.keyboard.press('Enter');
    await card(page, 'kiwix-serve').getByTestId('rs-ceremony').waitFor();
    eq(await page.evaluate(() => document.activeElement?.dataset.testid), 'rs-ceremony-confirm');
    const dlg = card(page, 'kiwix-serve').getByRole('alertdialog');
    ok(Boolean(await dlg.getAttribute('aria-labelledby')) && Boolean(await dlg.getAttribute('aria-describedby')), 'labelled + described dialog');
    const pidBefore = lc.status().pid;
    await page.keyboard.press('Enter');
    await waitText(page, 'kiwix-serve', 'rs-message', /Relance réussie/);
    eq(JSON.parse(posts.filter(p => p.path.endsWith('/restart-confirm')).at(-1).body).gesture.kind, 'KEYBOARD');
    ok(lc.status().pid !== pidBefore && lc.status().state === 'HEALTHY');
  });
  await context.close();

  await scenario('10. responsive: 375 px, no horizontal overflow, the dialog and its buttons stay reachable', async () => {
    const { page: p, context: c } = await openPage(worlds.V2, { viewport: { width: 375, height: 800 } });
    await card(p, 'kiwix-serve').getByTestId('rs-restart').click();
    await card(p, 'kiwix-serve').getByTestId('rs-ceremony').waitFor();
    const overflow = await p.evaluate(() => { const el = document.querySelector('[data-testid="runtime-services"]'); return el.scrollWidth - el.clientWidth; });
    ok(overflow <= 1, `section overflow ${overflow}px`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, 'page overflow');
    ok(await card(p, 'kiwix-serve').getByTestId('rs-ceremony-confirm').isVisible() && await card(p, 'kiwix-serve').getByTestId('rs-ceremony-cancel').isVisible());
    await card(p, 'kiwix-serve').getByTestId('rs-ceremony-cancel').click();
    await c.close();
  });

  await scenario('11. [RS-UI-1] stop timeout: DEGRADED + « Arrêt expiré » + explanation + may still run — never « Arrêté »; another DEGRADED reason and a genuine stop keep their own presentation', async () => {
    const view = async (w) => {
      const { page: p, context: c } = await openPage(w);
      const k = card(p, 'kiwix-serve');
      const textIfPresent = async (id) => ((await k.getByTestId(id).count()) ? (await k.getByTestId(id).innerText()).replace(/\s+/g, ' ') : ''); // absent ⇒ '' without waiting
      const out = { state: await k.getAttribute('data-state'), badge: await k.getByTestId('rs-state').innerText(), notice: await k.getByTestId('rs-stop-timeout').count(),
        noticeText: await textIfPresent('rs-stop-timeout'), error: await textIfPresent('rs-error'),
        all: (await k.innerText()).replace(/\s+/g, ' '), restartDisabled: await k.getByTestId('rs-restart').isDisabled() };
      await c.close();
      return out;
    };
    const postsBefore = posts.length;
    const t = await view(uiWorlds.STOP_TIMEOUT);
    eq(t.state, 'DEGRADED'); eq(t.badge, 'Dégradé', 'badge stays DEGRADED');
    eq(t.notice, 1, 'stop-timeout notice shown');
    ok(t.noticeText.includes('Arrêt expiré'), t.noticeText);
    ok(t.noticeText.includes('Docteur n’a pas pu confirmer l’arrêt du service dans le délai prévu.'), 'explanation');
    ok(t.noticeText.includes('Le service peut encore être actif.'), 'owned process still reported running');
    ok(!/\bArrêté\b/.test(t.all), 'never presented as stopped');
    ok(t.all.includes('arrêt non confirmé dans le délai prévu'), 'health detail is the stop timeout, not a health-check failure');
    ok(!t.noticeText.includes('forcé') && !t.all.includes('port libéré'), 'no claim of a forced kill or a released port');
    eq(t.restartDisabled, false, 'restart offered exactly as the backend rules say (ceremony retries a verified stop of the owned child)');

    const o = await view(uiWorlds.OTHER_DEGRADED);
    eq(o.state, 'DEGRADED'); eq(o.badge, 'Dégradé');
    eq(o.notice, 0, 'another DEGRADED reason is not labelled a stop timeout');
    ok(!o.all.includes('Arrêt expiré'));
    ok(o.error.includes('Le module Kiwix signale une erreur.'), 'existing generic detail kept');

    const s = await view(uiWorlds.STOPPED);
    eq(s.state, 'STOPPED'); eq(s.badge, 'Arrêté', 'a genuine stop is shown as stopped');
    eq(s.notice, 0); eq(s.error, '', 'no error on a clean stop');
    eq(s.restartDisabled, true, 'nothing to restart');
    eq(posts.length, postsBefore, 'presentation only: nothing was posted');
  });
} finally {
  await browser.close();
  await server.close();
  for (const w of [...Object.values(worlds), ...Object.values(uiWorlds)]) await new Promise(r => w.server.close(() => r()));
  await lc.stop().catch(() => {});
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null) await killProcessTree(c).catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
}

for (let i = 0; i < 40 && spawned.some(c => c.exitCode === null && c.signalCode === null); i++) await sleep(50);
eq(spawned.every(c => c.exitCode !== null || c.signalCode !== null), true, 'no fixture left running');
assert.deepEqual(pageErrors, [], 'no page error'); assertions += 1;
assert.deepEqual(REAL.map(sha), realBefore, 'real DB and Companion store untouched'); assertions += 1;
assert.deepEqual(POLICY.map(sha), policyBefore, 'active Root Policy files untouched'); assertions += 1;
console.log(results.join('\n'));
console.log(`aborted non-runtime requests (other Settings tabs, never sent): ${aborted}`);
console.log(`RUNTIME KIWIX RESTART BROWSER: ${results.length} scenarios, ${assertions} assertions — PASS`);
