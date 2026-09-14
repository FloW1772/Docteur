import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Self-contained server, deterministic mock API, hard deadline, finally cleanup.
let browser, server;
const watchdog = setTimeout(() => { console.error('Frontend external agents: global timeout'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 45000);
try {
  server = await createServer({configFile: false, plugins: [react()], oxc: {jsx: {runtime: 'automatic'}}, optimizeDeps: {entries: ['scripts/external-agents-harness.jsx']}, server: {host: '127.0.0.1', port: 0}, logLevel: 'error'});
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  await page.addInitScript(() => { window.EventSource = class {addEventListener() {} close() {}}; });
  let job, approved = 0, cancelled = 0;
  const clients = {codex: {installed: true, ready: true, reason: 'ready', version: '0.153.4'}, claude: {installed: false, ready: false, reason: 'not_installed', version: null}};
  await page.route('**/api/external-agents/**', async route => {
    const suffix = new URL(route.request().url()).pathname.split('/external-agents')[1];
    let result;
    if (suffix === '/settings') result = {allowedRoots: ['C:\\project'], strictLocal: false, features: [], limitations: []};
    else if (suffix === '/clients') result = clients;
    else if (suffix.startsWith('/test/')) result = clients[suffix.split('/').at(-1)];
    else if (suffix === '/jobs' && route.request().method() === 'GET') result = [];
    else if (suffix === '/jobs') {
      const body = route.request().postDataJSON();
      job = {id: 'fixture', provider: body.provider, task: 'code_analysis', workspace: body.cwd, status: 'waiting_approval', created_at: new Date().toISOString(), started_at: null, duration: 0, exit_code: null, output: '', error: null, review: 'none', tests: 'Aucune commande de test exécutée.', changes: [], scope: {prompt: body.prompt, files: body.files, bytes: 42}};
      result = job;
    } else if (suffix.endsWith('/approval')) { approved++; job.status = 'running'; job.started_at = new Date().toISOString(); result = job; }
    else if (suffix.endsWith('/cancel')) { cancelled++; job.status = 'cancelled'; job.output = '[stdout] partial output'; result = job; }
    else if (suffix === '/history/delete') result = [];
    else throw new Error(`Unexpected API route ${suffix}`);
    await route.fulfill({contentType: 'application/json', body: JSON.stringify(result), headers: {'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET,POST,OPTIONS'}});
  });
  await page.route('**/__external_test', route => route.fulfill({contentType: 'text/html', body: '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'}));
  await page.goto(`${origin}/__external_test`);
  await page.evaluate(async () => { const harness = await import('/scripts/external-agents-harness.jsx'); harness.mount(); });
  await page.getByText('Client non installé', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Tester Codex', exact: true}).click();
  await page.getByLabel('Agent', {exact: true}).selectOption('none');
  assert.ok(await page.getByRole('button', {name: 'Prévisualiser l’envoi'}).isDisabled());
  await page.getByLabel('Agent', {exact: true}).selectOption('codex');
  await page.getByLabel('Instruction', {exact: true}).fill('Analyse le fichier sélectionné.');
  await page.getByLabel('Fichiers sélectionnés', {exact: true}).fill('src/example.ts');
  await page.getByRole('button', {name: 'Prévisualiser l’envoi'}).click();
  await page.getByRole('button', {name: 'Confirmer et lancer'}).waitFor(); assert.equal(approved, 0);
  await page.getByRole('button', {name: 'Confirmer et lancer'}).click();
  await page.getByRole('button', {name: 'Arrêter', exact: true}).click();
  await page.getByLabel('Logs du job').getByText('[stdout] partial output').waitFor();
  assert.equal(approved, 1); assert.equal(cancelled, 1);
  await page.getByRole('button', {name: 'Supprimer l’historique terminé'}).click();
  await page.getByRole('button', {name: 'Supprimer l’historique terminé'}).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: détection, aucun agent, aperçu sans envoi, confirmation, arrêt, logs conservés, suppression historique; aucune erreur React.');
} finally { clearTimeout(watchdog); await browser?.close(); await server?.close(); }
