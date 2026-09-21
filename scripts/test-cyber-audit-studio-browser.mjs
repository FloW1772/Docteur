import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { captureStudio } from './studio-browser-checks.mjs';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/cyber-audit-studio-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('Cyber Audit Studio browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    cacheDir: '.tmp/vite-cyber-audit-studio',
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/cyber-audit-studio-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5205, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Cyber Audit Studio browser error:', e.message); });

  // ── In-memory fixture backend, mirroring the real semantic API shape ──
  const missions = new Map();
  let missionCounter = 0;
  let postCount = 0, putCount = 0, patchCount = 0, deleteCount = 0;
  let createCalls = 0, startCalls = 0, cancelCalls = 0;
  let lastCreateBody = null;

  function newMission(body) {
    missionCounter += 1;
    const id = `mission-${missionCounter}`;
    const scope = body.scope || {};
    const m = {
      id, title: body.title, clientName: body.clientName, status: 'READY', mode: body.mode || 'PASSIVE',
      createdAt: new Date().toISOString(), startedAt: null, completedAt: null, cancelledAt: null, lastError: null,
      counts: { requests: 0, pages: 0, findings: 0 },
      scope: {
        allowedHosts: scope.allowedHosts || [], allowedPorts: scope.allowedPorts || [],
        allowedProtocols: scope.allowedProtocols || [], maxDepth: scope.maxDepth ?? 1, maxRequests: scope.maxRequests ?? 50,
      },
      _findings: [],
      _pollCount: 0,
    };
    missions.set(id, m);
    return m;
  }

  function apiShape(m) {
    const { _findings, _pollCount, ...rest } = m;
    return rest;
  }

  await page.route('**/api/cyber-audit/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const method = req.method();
    if (method === 'POST' && !pathname.endsWith('/missions')) postCount++; // creation counted separately below
    if (method === 'PUT') putCount++;
    if (method === 'PATCH') patchCount++;
    if (method === 'DELETE') deleteCount++;

    let data, status = 200;

    if (pathname === '/api/cyber-audit/missions' && method === 'POST') {
      postCount++;
      createCalls++;
      lastCreateBody = req.postDataJSON();
      if (lastCreateBody.authorizationConfirmed !== true) {
        status = 400; data = { error: 'authorization_not_confirmed' };
      } else if (!Array.isArray(lastCreateBody.scope?.allowedHosts) || lastCreateBody.scope.allowedHosts.length === 0
        || lastCreateBody.scope.allowedHosts.some(h => h.includes('*'))) {
        status = 400; data = { error: 'scope_wildcard_denied' };
      } else if (lastCreateBody.scope.allowedHosts.includes('out-of-scope.invalid')) {
        status = 400; data = { error: 'target_out_of_scope' };
      } else if (!lastCreateBody.scope.allowedProtocols?.every(p => ['http:', 'https:'].includes(p))) {
        status = 400; data = { error: 'scope_protocols_invalid' };
      } else {
        const m = newMission(lastCreateBody);
        data = { ok: true, mission: apiShape(m) };
      }
    } else if (pathname === '/api/cyber-audit/missions' && method === 'GET') {
      data = { ok: true, missions: Array.from(missions.values()).map(apiShape).reverse() };
    } else if (/^\/api\/cyber-audit\/missions\/[^/]+\/start$/.test(pathname) && method === 'POST') {
      startCalls++;
      const id = pathname.split('/')[4];
      const m = missions.get(id);
      if (!m) { status = 404; data = { error: 'mission_not_found' }; }
      else if (m.status !== 'READY') { status = 409; data = { error: `invalid_state_for_start:${m.status}` }; }
      else {
        m.status = 'RUNNING'; m.startedAt = new Date().toISOString();
        m._findings = [
          { id: 'header-missing-hsts', title: 'HSTS manquant', category: 'headers', severity: 'MEDIUM', confidence: 'HIGH', status: 'OPEN', asset: `https://${m.scope.allowedHosts[0]}/`, description: 'Aucun en-tête Strict-Transport-Security observé.', impact: 'Downgrade HTTP possible.', recommendation: 'Ajouter Strict-Transport-Security.', references: [], evidenceIds: ['ev-1'], firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() },
          { id: 'cookie-missing-secure-session', title: 'Cookie sans attribut Secure', category: 'cookies', severity: 'HIGH', confidence: 'MEDIUM', status: 'OPEN', asset: `https://${m.scope.allowedHosts[0]}/`, description: 'Le cookie de session ne porte pas Secure.', impact: 'Interception possible sur réseau non chiffré.', recommendation: 'Ajouter Secure et HttpOnly.', references: [], evidenceIds: ['ev-2'], firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() },
        ];
        data = { ok: true, mission: apiShape(m) };
      }
    } else if (/^\/api\/cyber-audit\/missions\/[^/]+\/cancel$/.test(pathname) && method === 'POST') {
      cancelCalls++;
      const id = pathname.split('/')[4];
      const m = missions.get(id);
      if (!m) { status = 404; data = { error: 'mission_not_found' }; }
      else if (['COMPLETED', 'CANCELLED', 'FAILED', 'BLOCKED_BY_POLICY'].includes(m.status)) {
        data = { ok: true, mission: { ...apiShape(m), alreadyFinished: true } };
      } else {
        m.status = 'CANCELLED'; m.cancelledAt = new Date().toISOString(); m.completedAt = new Date().toISOString();
        data = { ok: true, mission: apiShape(m) };
      }
    } else if (/^\/api\/cyber-audit\/missions\/[^/]+\/findings$/.test(pathname) && method === 'GET') {
      const id = pathname.split('/')[4];
      const m = missions.get(id);
      data = m ? { ok: true, findings: m._findings } : (status = 404, { error: 'mission_not_found' });
    } else if (/^\/api\/cyber-audit\/missions\/[^/]+\/evidence\/[^/]+$/.test(pathname) && method === 'GET') {
      const parts = pathname.split('/');
      const id = parts[4], evId = parts[6];
      const m = missions.get(id);
      if (!m) { status = 404; data = { error: 'mission_not_found' }; }
      else {
        data = {
          ok: true,
          evidence: {
            id: evId, url: `https://${m.scope.allowedHosts[0]}/`, method: 'GET', timestamp: new Date().toISOString(),
            responseStatus: 200, relevantHeaders: { 'content-type': 'text/html', authorization: '[REDACTED]' },
            excerpt: '<html>redacted sample</html>', sha256: 'deadbeef1234',
          },
        };
      }
    } else if (/^\/api\/cyber-audit\/missions\/[^/]+\/events$/.test(pathname) && method === 'GET') {
      data = { ok: true, events: [] };
    } else if (/^\/api\/cyber-audit\/missions\/[^/]+$/.test(pathname) && method === 'GET') {
      const id = pathname.split('/')[4];
      const m = missions.get(id);
      if (!m) { status = 404; data = { error: 'mission_not_found' }; }
      else {
        // Simulate progressive completion after a few polls.
        if (m.status === 'RUNNING') {
          m._pollCount += 1;
          m.counts = { requests: m._pollCount * 2, pages: m._pollCount, findings: m._findings.length };
          if (m._pollCount >= 3) { m.status = 'COMPLETED'; m.completedAt = new Date().toISOString(); }
        }
        data = { ok: true, mission: apiShape(m) };
      }
    } else {
      data = { ok: true };
    }

    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
  });

  await page.route('**/__cyber_audit_studio_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__cyber_audit_studio_test`);

  // ── Open Cyber Studio via Help Center search ──
  // Searching "Observateur" alone now also matches MAÎTRE's own
  // description text (which references Observateur as a data source) —
  // search by a keyword unique to this entry so exactly one "Ouvrir"
  // button exists.
  const openStudio = async () => {
    await page.getByPlaceholder(/Rechercher/).fill('sentinel');
    await page.getByRole('button', { name: 'Ouvrir', exact: true }).click();
    await page.getByRole('dialog', { name: /Audit Web/ }).waitFor();
  };
  await openStudio().catch(async e => { console.error(await page.locator('body').innerText()); throw e; });
  assertions++;

  // ── Empty state, then start the wizard ──
  await page.getByText('Aucune mission active.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Nouvel audit', exact: true }).click();
  assertions++;

  // ── Step 1: Mission ──
  await page.getByLabel('Titre de la mission', { exact: true }).fill('Audit fixture');
  await page.getByLabel('Client', { exact: true }).fill('Acme Corp');
  await page.getByRole('button', { name: 'Suivant', exact: true }).click();

  // ── Step 2: Authorization — SECURITY UI TEST: cannot advance without the checkbox ──
  const nextBtn = page.getByRole('button', { name: 'Suivant', exact: true });
  check(await nextBtn.isDisabled());
  await page.getByRole('checkbox').check();
  check(!(await nextBtn.isDisabled()));
  await nextBtn.click();

  // ── Step 3: Scope — SECURITY UI TEST: wildcard host blocks advance ──
  await page.getByLabel(/Hôtes autorisés/, { exact: false }).fill('*');
  check(await page.getByRole('button', { name: 'Suivant', exact: true }).isDisabled());
  await page.getByLabel(/Hôtes autorisés/, { exact: false }).fill('fixture.invalid');
  await page.getByLabel(/Ports autorisés/, { exact: false }).fill('443');
  check(!(await page.getByRole('button', { name: 'Suivant', exact: true }).isDisabled()));
  await page.getByRole('button', { name: 'Suivant', exact: true }).click();

  // ── Step 4: Mode — only PASSIVE/SAFE_ACTIVE are SELECTABLE options; the
  // reassurance text below the radios is allowed to name the forbidden
  // modes explicitly (to state they don't exist) without that counting as
  // offering them.
  const modeRadioCount = await page.getByRole('radio').count();
  check(modeRadioCount === 2);
  const modeRadioLabels = await Promise.all((await page.getByRole('radio').all()).map(async r => (await r.evaluate(el => el.closest('label')?.textContent)) ?? ''));
  check(modeRadioLabels.every(label => ['PASSIVE', 'SAFE_ACTIVE'].includes(label.trim())));
  await page.getByRole('button', { name: 'Suivant', exact: true }).click();

  // ── Step 5: Limits ──
  await page.getByRole('button', { name: 'Suivant', exact: true }).click();

  // ── Step 6: Review — verify all required fields shown, then start ──
  const reviewText = await page.locator('[role="dialog"]').last().innerText();
  check(reviewText.includes('Audit fixture') && reviewText.includes('Acme Corp') && reviewText.includes('fixture.invalid'));
  await page.getByRole('button', { name: 'START AUTHORIZED AUDIT', exact: true }).click();

  // ── RUNNING state ──
  await page.getByText('En cours', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'STOP AUDIT', exact: true }).waitFor();
  assertions++;

  // ── COMPLETED state (fixture auto-completes after a few polls) ──
  await page.getByText('Terminée', { exact: false }).first().waitFor({ timeout: 15000 });
  assertions++;

  // ── FINDINGS tab: filters + detail ──
  await page.getByRole('tab', { name: /FINDINGS/ }).click();
  await page.getByText('HSTS manquant', { exact: false }).waitFor();
  await page.getByText('Cookie sans attribut Secure', { exact: false }).waitFor();
  const severitySelect = page.getByLabel('Filtrer par sévérité');
  await severitySelect.selectOption('HIGH');
  check(!(await page.getByText('HSTS manquant').isVisible().catch(() => false)));
  await page.getByText('Cookie sans attribut Secure', { exact: false }).waitFor();
  await severitySelect.selectOption('all');
  await page.getByText('HSTS manquant', { exact: false }).click();

  // ── Finding detail: OBSERVED / INTERPRETATION / RECOMMENDATION separated ──
  await page.getByRole('heading', { name: 'OBSERVED' }).waitFor();
  await page.getByRole('heading', { name: 'INTERPRETATION' }).waitFor();
  await page.getByRole('heading', { name: 'RECOMMENDATION' }).waitFor();
  assertions++;
  await page.getByRole('button', { name: 'COPY EVIDENCE', exact: true }).first().waitFor();
  // Evidence must show only redacted fields, never a raw secret value.
  const detailText = await page.locator('[role="dialog"]').last().innerText();
  check(!/Bearer |sk-live|password=/i.test(detailText));
  await page.getByRole('button', { name: 'Fermer le détail', exact: true }).click();

  // ── EVIDENCE tab ──
  // getByText() normalizes whitespace by default, which is unreliable
  // against a <pre>-formatted JSON blob (preserves whitespace/newlines) —
  // read the panel's raw text content directly instead.
  await page.getByRole('tab', { name: /EVIDENCE/ }).click();
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes('[REDACTED]'));
  assertions++;

  // ── REMEDIATION tab: explicit priority groups, no opaque scoring ──
  await page.getByRole('tab', { name: /REMEDIATION/ }).click();
  await page.getByRole('heading', { name: 'Quick Wins' }).waitFor();
  await page.getByRole('heading', { name: 'Court terme' }).waitFor();
  await page.getByRole('heading', { name: 'Long terme' }).waitFor();
  assertions++;

  // ── REPORT tab: links present, no auto-fetch of arbitrary URL ──
  await page.getByRole('tab', { name: /REPORT/ }).click();
  await page.getByRole('link', { name: 'Ouvrir le rapport HTML', exact: true }).waitFor();
  await page.getByRole('link', { name: /Exporter les findings/, exact: false }).waitFor();
  await page.getByText('NOT IMPLEMENTED', { exact: false }).waitFor();
  assertions++;

  // ── HISTORY tab ──
  await page.getByRole('tab', { name: /HISTORY/ }).click();
  await page.getByRole('cell', { name: 'Audit fixture', exact: true }).waitFor();
  await page.getByText('RE-SCAN : NOT IMPLEMENTED', { exact: false }).waitFor();
  assertions++;

  // ── Security regression confirmations ──
  check(postCount === createCalls + startCalls + cancelCalls); // every POST accounted for by a known semantic action
  check(putCount === 0 && patchCount === 0 && deleteCount === 0);
  check(lastCreateBody.authorizationConfirmed === true);

  // ── Cancel-flow test on a second mission (fresh wizard) ──
  await page.getByRole('button', { name: 'Nouvel audit', exact: true }).click();
  await page.getByLabel('Titre de la mission', { exact: true }).fill('Audit 2');
  await page.getByLabel('Client', { exact: true }).fill('Acme Corp');
  await page.getByRole('button', { name: 'Suivant', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Suivant', exact: true }).click();
  await page.getByLabel(/Hôtes autorisés/, { exact: false }).fill('fixture.invalid');
  await page.getByLabel(/Ports autorisés/, { exact: false }).fill('443');
  await page.getByRole('button', { name: 'Suivant', exact: true }).click();
  await page.getByRole('button', { name: 'Suivant', exact: true }).click();
  await page.getByRole('button', { name: 'Suivant', exact: true }).click();
  await page.getByRole('button', { name: 'START AUTHORIZED AUDIT', exact: true }).click();
  await page.getByRole('button', { name: 'STOP AUDIT', exact: true }).waitFor();
  await page.getByRole('button', { name: 'STOP AUDIT', exact: true }).click();
  await page.getByText('Annulée', { exact: false }).first().waitFor();
  // No infinite spinner / no auto-resume: status stays CANCELLED, no RUNNING chip reappears.
  await page.waitForTimeout(2000);
  const postCancelText = await page.locator('[role="dialog"]').last().innerText();
  if (/En cours/.test(postCancelText)) console.error('POST-CANCEL DOM:\n' + postCancelText);
  check(!/En cours/.test(postCancelText));
  assertions++;

  // ── No raw backend/system leakage anywhere in the DOM ──
  const fullBodyText = await page.locator('body').innerText();
  check(!/venv|argv|python|filesystem|C:\\\\|\/usr\/|\/home\//i.test(fullBodyText));

  await captureStudio(page, 'cyber-audit-results');

  check(errors.length === 0);
  console.log(`CYBER AUDIT STUDIO FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
