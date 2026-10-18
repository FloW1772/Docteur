// Actual React hook, IndexedDB and in-memory SQLite API; never the user's server.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const backend = spawn(process.execPath, ['cortex-server/test-regression-api.mjs'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
let vite, browser;
const results = [];
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture API startup timeout')), 15000);
    backend.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture API exited ${code}`)); });
    backend.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timeout); resolve(); } });
  });
  vite = await createServer({ server: { host: '127.0.0.1', port: 5175, strictPort: true }, optimizeDeps: { entries: ['scripts/regression-harness.jsx'] } });
  await vite.listen();
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let deletionSeen = false, deletionCalls = 0, unblockDelete;
  let hydrationSeen = false, unblockHydration;
  const hydrationGate = new Promise(resolve => { unblockHydration = resolve; });
  const deletionGate = new Promise(resolve => { unblockDelete = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (request.method() === 'DELETE' && new URL(request.url()).pathname.endsWith('/review-race')) {
      deletionSeen = true;
      deletionCalls++;
      await deletionGate;
    }
    const response = await route.fetch({ url: request.url().replace(/:\d+\/api\//, ':3002/api/') });
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/fixture-40')) {
      hydrationSeen = true;
      await hydrationGate;
    }
    await route.fulfill({ response });
  });
  await page.route('**/__final_review', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;import("/scripts/regression-harness.jsx").then(m=>m.mount());</script>' }));
  await page.goto('http://127.0.0.1:5175/__final_review');
  await page.waitForFunction(() => window.regression && !window.regression.loading);
  const read = async id => {
    const response = await fetch(`http://127.0.0.1:3002/api/neuron/${id}`);
    return response.status === 404 ? null : (await response.json()).page;
  };
  const check = async (name, run) => {
    try { await run(); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
  };

  await check('delete must not leave a persisted backlink on an unhydrated neighbour', async () => {
    await page.evaluate(async () => {
      await window.regression.createPageFromData({ id: 'review-linked', title: 'Linked', blocks: [{ id: 'b', type: 'paragraph', content: 'Do not lose me' }], links: ['fixture-79'] });
      await window.regression.loadPage('fixture-79');
      await window.regression.updatePage('fixture-79', { links: ['review-linked'] });
      await window.regression.flushAllSaves();
    });
    // A fresh document makes both pages metadata-only again.
    await page.reload();
    await page.waitForFunction(() => window.regression && !window.regression.loading);
    assert.deepEqual(await page.evaluate(() => window.regression.pages.find(p => p.id === 'fixture-79').blocks), []);
    await page.evaluate(async () => { await window.regression.removePage('review-linked'); await window.regression.flushAllSaves(); });
    const neighbour = await read('fixture-79');
    assert.deepEqual(neighbour.links, []);
    assert.equal(neighbour.blocks[0].content, 'Persistent fixture 79');
    assert.equal(await read('review-linked'), null);
  });
  await check('an edit while DELETE is pending cannot recreate the deleted page', async () => {
    await page.evaluate(async () => {
      await window.regression.createPageFromData({ id: 'review-race', title: 'Race', blocks: [] });
      await window.regression.updatePage('review-race', { title: 'Before delete' });
      window.reviewDeletion = Promise.all([window.regression.removePage('review-race'), window.regression.removePage('review-race')]);
    });
    const deadline = Date.now() + 5000;
    while (!deletionSeen && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(deletionSeen, true);
    await page.evaluate(async () => { try { await window.regression.updatePage('review-race', { title: 'During delete' }); } catch { /* refusing an edit is valid */ } });
    unblockDelete();
    await page.evaluate(() => window.reviewDeletion);
    await page.waitForTimeout(1000); // Exceeds the real 800 ms debounce.
    assert.equal(await read('review-race'), null);
    assert.equal(deletionCalls, 1, 'double-click joins the existing deletion');
    assert.equal(await page.evaluate(async () => !!(await (await import('/src/lib/storage.ts')).getPage('review-race'))), false);
  });
  await check('a stale content response cannot reinsert a page deleted during hydration', async () => {
    await page.evaluate(() => { window.reviewHydration = window.regression.loadPage('fixture-40'); });
    const deadline = Date.now() + 5000;
    while (!hydrationSeen && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(hydrationSeen, true);
    await page.evaluate(() => window.regression.removePage('fixture-40'));
    unblockHydration();
    await page.evaluate(() => window.reviewHydration);
    assert.equal(await page.evaluate(() => window.regression.pages.some(p => p.id === 'fixture-40')), false);
    assert.equal(await read('fixture-40'), null);
  });
  await check('actual backup UI preserves server dates, skips invalid pages and hydrates the offline cache', async () => {
    const app = await browser.newPage();
    try {
    await app.addInitScript(() => { localStorage.setItem('docteur.showHomeScreen', 'false'); localStorage.setItem('docteur.viewMode', 'focus'); });
    app.on('pageerror', error => errors.push(error.message));
    const writes = [];
    const order = [];
    await app.route('**/api/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/neuron') || pathname === '/api/backup/import') {
        if (request.method() === 'PUT') { writes.push(pathname); order.push('edit'); }
        if (pathname === '/api/backup/import') order.push('import');
        const response = await route.fetch({ url: request.url().replace(/:\d+\/api\//, ':3002/api/') });
        await route.fulfill({ response });
      } else {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, pages: [], items: [], jobs: [], backups: [], models: [], total: 0, byKind: {} }) });
      }
    });
    await app.goto('http://127.0.0.1:5175');
    await app.getByRole('button', { name: 'Déployer la navigation', exact: true }).click();
    await app.locator('.sidebar-item[data-neuron-id="fixture-79"]').click();
    await app.locator('.shell-editor textarea').first().waitFor();
    await app.clock.install();
    await app.clock.pauseAt(new Date());
    await app.locator('.shell-editor textarea').first().fill('Pending obsolete edit');
    await app.getByTitle("Plus d'actions").click();
    await app.getByRole('menuitem', { name: 'Backup & restauration' }).click();
    const restored = { id: 'fixture-79', title: 'Validated restore', kind: 'note', blocks: [{ id: 'b', type: 'paragraph', content: 'Authoritative content' }], createdAt: 333, updatedAt: 444, links: [], metadata: {} };
    const data = { version: '1.2', neurons: [restored, { id: 'restore-invalid', title: 'Reject', blocks: [null] }, { id: 'restore-legacy', title: 'Legacy', content: 'Rebuilt by server' }], links: [] };
    await app.locator('input[type=file]').setInputFiles({ name: 'hostile-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
    await app.getByText('2/3 neurones restaurés', { exact: false }).waitFor();
    assert.deepEqual(await read(restored.id), restored);
    assert.equal(await read('restore-invalid'), null);
    assert.deepEqual(writes, ['/api/neuron/fixture-79'], 'only the pre-import edit may be flushed; raw input must not be replayed');
    assert.deepEqual(order, ['edit', 'import']);
    assert.deepEqual(await app.evaluate(async id => (await import('/src/lib/storage.ts')).getPage(id), restored.id), restored);
    const legacy = await read('restore-legacy');
    assert.equal(legacy.blocks[0].content, 'Rebuilt by server');
    assert.deepEqual(await app.evaluate(async id => (await import('/src/lib/storage.ts')).getPage(id), legacy.id), legacy);
    } finally { await app.close(); }
  });
  await check('GPU resources are released after StrictMode and component recreation', async () => {
    const gpu = await browser.newPage({ viewport: { width: 600, height: 400 } });
    gpu.on('pageerror', error => errors.push(error.message));
    await gpu.route('**/__gpu_review', route => route.fulfill({ contentType: 'text/html', body: '<style>html,body,#root{width:100%;height:100%;margin:0}</style><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;import("/scripts/final-review-gpu-harness.jsx");</script>' }));
    await gpu.goto('http://127.0.0.1:5175/__gpu_review');
    await gpu.waitForFunction(() => window.gpuReview);
    await gpu.evaluate(() => window.gpuReview.render(false));
    await gpu.waitForFunction(() => window.gpuReview.counters.environments >= 2);
    await gpu.setViewportSize({ width: 390, height: 844 });
    await gpu.evaluate(() => window.gpuReview.render(true));
    await gpu.waitForFunction(() => window.gpuReview.counters.environments >= 3);
    await gpu.evaluate(() => window.gpuReview.unmount());
    const counters = await gpu.evaluate(() => window.gpuReview.counters);
    console.log('GPU lifecycle:', counters);
    await gpu.close();
    for (const key of ['environmentDisposals', 'roomDisposals', 'bloomDisposals', 'vignetteDisposals']) {
      assert.equal(counters[key], counters.environments, key);
    }
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every(result => result.pass), 'Hostile browser scenarios must all pass');
} finally {
  await browser?.close();
  await vite?.close();
  backend.kill();
}
