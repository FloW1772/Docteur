import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { captureStudio } from './studio-browser-checks.mjs';
const real = process.env.MG6_REAL_SMOKE === '1';
let browser, server, mission, approved = 0, applied = 0, cancelled = 0, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/metagpt-studio-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('MG6 browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, real ? 360000 : 60000);
try {
  server = await createServer({ configFile: false, plugins: [react(), { name: 'mg6-harness', configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/__metagpt_test') return next(); res.setHeader('Content-Type', 'text/html'); res.end(harnessHtml); }); } }], optimizeDeps: { entries: ['scripts/metagpt-studio-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 5197, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(real ? 240000 : 30000);
  page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
  page.on('requestfailed', request => console.error('Request failed:', request.url(), request.failure()?.errorText));
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error('MG6 browser error:', e.message); });
  const diff = { ok: true, job_id: 'fixture', diff_sha256: 'a'.repeat(64), package_sha256: 'b'.repeat(64), diff_text: '--- before\n+++ after\n+export const sample = 1;', files: [{ source: 'sample.js', destination: 'src/_metagpt_generated_samples/fixture/sample.js', operation: 'CREATE' }], security_findings: [], dependency_requests: [], blocked_findings: 0 };
  await page.route('**/api/metagpt/missions**', async route => {
    const req = route.request(); const pathname = new URL(req.url()).pathname;
    let data, status = 200;
    if (real) {
      const response = await fetch(`http://127.0.0.1:3099${pathname}`, { method: req.method(), ...(req.postData() ? { headers: { 'Content-Type': 'application/json' }, body: req.postData() } : {}) });
      status = response.status; data = await response.json();
      if (pathname.endsWith('/missions') && req.method() === 'POST') console.log(`REAL_MISSION_ID=${data.id}`);
      assert.ok(!pathname.endsWith('/apply') && !pathname.endsWith('/approve'), 'real smoke stops before approval/apply');
    } else {
      const suffix = pathname.split('/missions')[1];
      if (!suffix && req.method() === 'GET') data = { ok: true, missions: mission ? [mission] : [] };
      else if (!suffix) { const body = req.postDataJSON(); mission = { id: 'fixture', title: body.title, mode: body.mode, current_state: 'CREATED', approved: false, diff_sha256: null, metadata: {}, events: [] }; data = { ok: true, id: mission.id }; }
      else if (suffix.endsWith('/artifacts')) data = { ok: true, planning: { prd: 'PRD fixture document', design: 'Design fixture document', tasks: 'Tasks fixture document' }, codegen: mission.current_state === 'CREATED' ? [] : [{ path: 'sample.js', content: 'export const sample = 1;' }, { path: 'notes.js', content: 'export const note = "fixture";' }] };
      else if (suffix.endsWith('/plan')) { mission.current_state = 'PLANNING'; await new Promise(resolve => setTimeout(resolve, 1600)); mission.current_state = 'TASKS_READY'; data = { ok: true }; }
      else if (suffix.endsWith('/generate')) { mission.current_state = 'CODE_READY'; data = { ok: true }; }
      else if (suffix.endsWith('/prepare-apply')) { mission.current_state = 'AWAITING_APPROVAL'; mission.diff_sha256 = diff.diff_sha256; mission.metadata.prepare_apply = diff; data = { ok: true }; }
      else if (suffix.endsWith('/approve')) { const body = req.postDataJSON(); assert.deepEqual(body, { diff_sha256: diff.diff_sha256, files: diff.files.map(f => f.destination) }); approved++; mission.approved = true; mission.metadata.approval = body; data = { ok: true }; }
      else if (suffix.endsWith('/apply')) { applied++; assert.equal(approved, 1); mission.current_state = 'APPLIED'; data = { ok: true }; }
      else if (suffix.endsWith('/cancel')) { cancelled++; mission.current_state = 'CANCELLED'; data = { ok: true }; }
      else data = { ok: true, mission };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
  });
  const open = async () => { await page.getByPlaceholder(/Rechercher/).fill('MetaGPT'); await page.getByRole('button', { name: 'Ouvrir', exact: true }).click(); await page.getByRole('dialog', { name: 'Studio MetaGPT' }).waitFor(); };
  await page.goto(`${origin}/__metagpt_test`); await open().catch(async error => { console.error(await page.locator('body').innerText()); throw error; }); assertions++;
  await page.getByLabel('Titre', { exact: true }).fill(real ? 'MG6 UI real isolated smoke' : 'MG6 browser fixture');
  await page.getByLabel('Requirement', { exact: true }).fill('Design one sample.js JavaScript file exporting a pure greet(name) function returning a hello string. Fictitious project. No dependencies, network, filesystem, terminal, browser or code execution.');
  await page.getByLabel('Mode', { exact: true }).selectOption('PLAN_AND_CODE_TEXT_ONLY');
  await page.getByRole('button', { name: 'Créer la mission', exact: true }).click();
  await page.getByText('État : CREATED', { exact: true }).waitFor(); assertions++;
  await page.getByRole('button', { name: 'Démarrer', exact: true }).click();
  await page.getByText('État : PLANNING', { exact: true }).waitFor(); assertions++;
  await page.getByText('État : TASKS_READY', { exact: true }).waitFor(); assertions++;
  // PRD/Design/Tasks now live under their own tabs (Phase UX-3 restructure).
  for (const [tabName, summaryName] of [['PRD', 'PRD'], ['DESIGN', 'Design'], ['TASKS', 'Tasks']]) {
    await page.getByRole('tab', { name: tabName, exact: true }).click();
    await page.locator('summary').filter({ hasText: new RegExp(`^${summaryName}$`) }).waitFor();
    assertions++;
  }
  await page.reload(); await open(); await page.getByText('État : TASKS_READY', { exact: true }).waitFor(); assertions++;
  await page.getByRole('button', { name: 'Générer le code texte', exact: true }).click();
  await page.getByText('État : CODE_READY', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'CODE', exact: true }).click();
  await page.getByText('Code — sample.js', { exact: true }).waitFor(); assertions++;
  if (!real) {
    await page.getByRole('button', { name: 'Fichier suivant', exact: true }).click();
    await page.getByText('Code — notes.js', { exact: true }).waitFor(); assertions++;
    await page.getByRole('button', { name: 'Fichier précédent', exact: true }).click();
    check(await page.getByLabel('Fichier généré', { exact: true }).inputValue() === 'sample.js');
  }
  await page.getByRole('button', { name: 'Préparer le diff', exact: true }).click();
  await page.getByText('État : AWAITING_APPROVAL', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'DIFF', exact: true }).click();
  await page.getByText('Diff complet', { exact: true }).waitFor(); assertions++;
  check(await page.getByRole('button', { name: 'Appliquer', exact: true }).isDisabled());
  check(await page.getByRole('button', { name: 'Approuver CE diff', exact: true }).isEnabled());
  if (!real) await captureStudio(page, 'metagpt-approval');
  if (!real) {
    await page.getByRole('button', { name: 'Approuver CE diff', exact: true }).click();
    await page.getByText('Ce diff a été approuvé.', { exact: false }).waitFor();
    check(applied === 0 && approved === 1);
    await page.getByRole('button', { name: 'Appliquer', exact: true }).click();
    await page.getByText('État : APPLIED', { exact: true }).waitFor(); check(applied === 1);
    mission.current_state = 'AWAITING_APPROVAL'; mission.approved = false; diff.blocked_findings = 1; diff.security_findings = [{ file: 'sample.js', classification: 'BLOCKED', pattern: 'eval denied' }]; mission.error_message = 'BLOCKED_BY_POLICY';
    await page.reload(); await open(); await page.getByRole('alert').filter({ hasText: 'BLOCKED_BY_POLICY' }).waitFor();
    check(await page.getByRole('button', { name: 'Approuver CE diff', exact: true }).isDisabled());
    check(await page.getByRole('button', { name: 'Appliquer', exact: true }).isDisabled());

    // SECURITY tab now surfaces findings with a readable classification chip
    // instead of a raw JSON dump (Phase UX-3 requirement 6).
    await page.getByRole('tab', { name: 'SECURITY', exact: true }).click();
    await page.getByText('BLOCKED', { exact: true }).waitFor();
    await page.getByText('eval denied', { exact: false }).waitFor();
    assertions++;

    // DEPENDENCIES tab: empty state shown when no dependency requests exist,
    // never fabricated.
    await page.getByRole('tab', { name: 'DEPENDENCIES', exact: true }).click();
    await page.getByText('Aucune dépendance demandée.', { exact: true }).waitFor();
    assertions++;

    await page.getByRole('button', { name: 'Annuler', exact: true }).click(); await page.getByText('État : CANCELLED', { exact: true }).waitFor(); check(cancelled === 1);
  }
  check(errors.length === 0);
  fs.mkdirSync('reports/metagpt-evidence', { recursive: true });
  await page.screenshot({ path: `reports/metagpt-evidence/${real ? 'real-review' : 'browser'}.png`, fullPage: true });
  console.log(`MG6 ${real ? 'REAL UI/API REVIEW (NO APPLY)' : 'FRONTEND'} PASS ${assertions}/${assertions}`);
} finally { clearTimeout(watchdog); await browser?.close(); await server?.close(); }
