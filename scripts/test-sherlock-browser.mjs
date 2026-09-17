import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
let server, browser, submitted = [], cancelled = 0, checks = 0;
const check = value => { assert.ok(value); checks++; };
try {
  const html = '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/sherlock-harness.jsx");mount();</script>';
  server = await createServer({ configFile: false, plugins: [react(), { name: 'sherlock-harness', configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== '/__sherlock_test') return next(); res.setHeader('Content-Type', 'text/html'); res.end(html); }); } }], optimizeDeps: { entries: ['scripts/sherlock-harness.jsx'] }, server: { host: '127.0.0.1', port: 5198, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen(); browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.route('**/api/sherlock/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    let data;
    if (pathname.endsWith('/status')) data = { status: 'installed', version: '0.16.2' };
    else if (pathname.endsWith('/search')) { submitted.push(request.postDataJSON()); data = { jobId: String(submitted.length), username: submitted.at(-1).username }; }
    else if (pathname.endsWith('/cancel')) { cancelled++; data = { cancelled: true }; }
    else data = { id: String(submitted.length), username: submitted.at(-1).username, status: submitted.length === 1 ? 'done' : cancelled ? 'cancelled' : 'running', duration: 1200, current: 3, total: 3, summary: { results: submitted.length === 1 ? [{ site: 'GitHub', status: 'found', profileUrl: 'https://github.com/docteur-fixture' }, { site: 'Reddit', status: 'absent' }, { site: 'GitLab', status: 'error' }] : [] } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto('http://127.0.0.1:5198/__sherlock_test');
  await page.getByPlaceholder(/Rechercher/).fill('Sherlock').catch(async error => { console.error(await page.locator('input').evaluateAll(nodes => nodes.map(n => ({ placeholder: n.placeholder, label: n.getAttribute('aria-label') })))); throw error; }); await page.getByRole('button', { name: 'Ouvrir', exact: true }).click();
  await page.getByRole('heading', { name: 'Recherche de pseudonyme — Sherlock' }).waitFor(); checks++;
  await page.getByLabel('Pseudonyme public').fill('--help'); await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await page.getByRole('alert').waitFor(); check(submitted.length === 0);
  await page.getByLabel('Pseudonyme public').fill('docteur-fixture'); await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await page.getByText(/État : Terminée/).waitFor(); check(submitted[0].username === 'docteur-fixture');
  check(await page.getByText('3/3 sites — 1 trouvés — 1 absents — 1 erreurs').isVisible());
  check(await page.getByText(/Durée : 1.2 s/).isVisible());
  check(await page.getByRole('link', { name: 'Voir le profil public' }).getAttribute('href') === 'https://github.com/docteur-fixture');
  check(await page.getByRole('button', { name: /neurone|Installer|Désinstaller/i }).count() === 0);
  await page.getByLabel('Pseudonyme public').fill('élève42'); await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await page.getByRole('button', { name: 'Annuler' }).click(); await page.getByText(/État : Annulée/).waitFor();
  check(cancelled === 1); check(submitted[1].username === 'élève42'); check(errors.length === 0);
  console.log(`SHERLOCK UI + Help: ${checks}/${checks} PASS`);
} finally { await browser?.close(); await server?.close(); }

