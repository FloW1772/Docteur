import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/sherlock-studio-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('Sherlock Studio browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/sherlock-studio-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5204, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Sherlock Studio browser error:', e.message); });

  let job = null;
  let searchCount = 0;
  let lastSearchBody = null;

  await page.route('**/api/sherlock/**', async route => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    let data, status = 200;

    if (pathname === '/api/sherlock/status') {
      data = { status: 'installed', version: '1.0.0', installedAt: 1700000000000, lastError: null, pinnedSha: 'deadbeef' };
    } else if (pathname === '/api/sherlock/search' && req.method() === 'POST') {
      lastSearchBody = req.postDataJSON();
      searchCount++;
      job = { id: 'job-1', operation: 'Recherche', username: lastSearchBody.username, status: 'running', duration: 0, current: 0, total: 3, summary: null };
      data = { jobId: job.id, username: job.username };
    } else if (pathname === '/api/sherlock/jobs/job-1') {
      // Simulate progressive completion on repeated polls.
      if (job.status === 'running' && job.current < 3) {
        job = { ...job, current: job.current + 1, duration: job.duration + 300 };
      } else if (job.status === 'running') {
        job = {
          ...job, status: 'done', duration: 1200,
          summary: {
            results: [
              { site: 'GitHub', url: 'https://github.com/docteur-fixture', username: job.username, profileUrl: 'https://github.com/docteur-fixture', status: 'found', responseTime: 120 },
              { site: 'Reddit', url: '', username: job.username, profileUrl: '', status: 'absent', responseTime: 95 },
              { site: 'GitLab', url: '', username: job.username, profileUrl: '', status: 'error', responseTime: null },
            ],
            found: 1, absent: 1, errors: 1,
          },
        };
      }
      data = job;
    } else if (pathname === '/api/sherlock/jobs/job-1/cancel' && req.method() === 'POST') {
      job = { ...job, status: 'cancelled' };
      data = { cancelled: true };
    } else {
      data = { ok: true };
    }

    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
  });

  const open = async () => {
    await page.getByPlaceholder(/Rechercher/).fill('Sherlock');
    await page.getByRole('button', { name: 'Ouvrir', exact: true }).click();
    await page.getByRole('dialog', { name: 'Studio Sherlock' }).waitFor();
  };
  await page.route('**/__sherlock_studio_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__sherlock_studio_test`);
  await open().catch(async e => { console.error(await page.locator('body').innerText()); throw e; });
  assertions++;

  // ── Empty state before any search — inviting placeholder, no wall of nothing ──
  await page.getByText('Entrez un pseudonyme pour rechercher sa présence publique.', { exact: true }).waitFor();
  assertions++;

  // ── Environment status shown as a real StudioStatus chip, text + color ──
  await page.getByText('Environnement disponible', { exact: true }).waitFor();
  assertions++;

  // ── Search rejects an invalid username client-side without any network call ──
  await page.getByLabel('Pseudonyme public', { exact: true }).fill('--help');
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Pseudonyme' }).waitFor();
  check(searchCount === 0);

  // ── Valid search: timeout control passed through, job created and polled ──
  await page.getByLabel('Pseudonyme public', { exact: true }).fill('docteur-fixture');
  await page.getByLabel('Délai maximum par site', { exact: true }).fill('45');
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await page.getByText('État : En cours', { exact: false }).waitFor();
  check(lastSearchBody?.username === 'docteur-fixture' && lastSearchBody?.timeoutMs === 45000);
  assertions++;

  // ── Progress: site counter advances, cancel button available while running ──
  await page.getByText('/3 sites', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Annuler', exact: true }).waitFor();
  assertions++;

  // ── Completion: summary counts, per-site results with status + link, no
  //    Python/venv/argv/filesystem leakage anywhere in the DOM ──
  await page.getByText('État : Terminée', { exact: false }).waitFor({ timeout: 20000 });
  await page.getByText('1 trouvés — 1 absents — 1 erreurs', { exact: false }).waitFor();
  await page.getByRole('link', { name: 'Voir le profil public', exact: true }).waitFor();
  const bodyText = await page.locator('body').innerText();
  check(!/venv|argv|python|filesystem|C:\\\\|\/usr\/|\/home\//i.test(bodyText));
  assertions++;

  // ── Response time shown for a result that has one (previously invisible data) ──
  await page.getByText('120 ms', { exact: false }).waitFor();
  assertions++;

  // ── History section is honest about not persisting anything (no fake history) ──
  await page.getByText('Aucun historique persistant', { exact: false }).waitFor();
  assertions++;

  // ── onJobUpdate fires once the job is done, fixing the dead Dashboard-widget bug ──
  check(await page.getByTestId('last-job-id').innerText() === 'job-1');

  check(errors.length === 0);
  console.log(`SHERLOCK STUDIO FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
