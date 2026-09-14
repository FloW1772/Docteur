import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [], writes = [];
const output = { ok: true, title: 'Agent persistence title long enough to wrap across several lines without horizontal clipping', content: 'Agent first paragraph.\n\nAgent second paragraph.', kind: 'recherche', run_id: 'regression-run' };
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/**', async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path.startsWith('/api/agents')) {
    const data = path.endsWith('/run') ? output : path.endsWith('/types') ? [] : [{ id: 'test-agent', name: 'Persistence agent', type: 'research', params: {}, active: true, trigger_type: 'manual' }];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    return;
  }
  if (request.method() === 'PUT') writes.push({ id: path.split('/').pop(), fields: Object.keys(request.postDataJSON().page) });
  const response = await route.fetch({ url: request.url().replace(/:\d+\/api\//, ':3002/api/') });
  await route.fulfill({ response });
});
await page.route('**/__six_test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;import("/scripts/regression-harness.jsx").then(m=>m.mount());</script>' }));
const read = async id => (await (await fetch(`http://127.0.0.1:3002/api/neuron/${id}`)).json()).page;
try {
  await page.goto('http://127.0.0.1:5173/__six_test');
  await page.waitForFunction(() => window.regression?.allMetaLoaded);
  const list = page.locator('.sidebar-list');
  await list.hover();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(400);
  console.log('MOUSE baseline', await list.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight, top: el.scrollTop })));
  assert.ok(await list.evaluate(el => el.scrollTop > 0), 'real mouse wheel must scroll the sidebar');
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(() => document.querySelector('.sidebar-list').scrollTop === 0);
  await page.evaluate(() => window.regression.openAgents());
  await page.waitForFunction(() => window.regression.modalOpen);
  await page.getByTitle('Exécuter maintenant').click();
  await page.waitForFunction(() => !window.regression.modalOpen && window.regression.pages.some(p => p.metadata?.run_id === 'regression-run'));
  const created = await page.evaluate(() => window.regression.pages.find(p => p.metadata?.run_id === 'regression-run'));
  console.log('PASS actual AgentsModal run action -> complete save -> modal unmounted and modal registry released');
  const before = await read(created.id);
  assert.deepEqual(before.blocks, created.blocks);
  assert.equal(writes.filter(w => w.id === created.id).length, 1, 'agent creation is one complete write');
  for (let i = 0; i < 10; i++) {
    await page.getByRole('button', { name: i % 2 ? /^Tout/ : /^Articles/ }).click();
  }
  await page.evaluate(id => window.regression.select(id), created.id);
  assert.deepEqual(await read(created.id), before);
  await page.reload();
  await page.waitForFunction(() => window.regression?.allMetaLoaded);
  await page.evaluate(id => window.regression.select(id), created.id);
  await page.waitForFunction(id => window.regression.pages.find(p => p.id === id)?.blocks.length === 2, created.id);
  assert.deepEqual(await read(created.id), before);
  assert.deepEqual(await page.evaluate(id => window.regression.pages.find(p => p.id === id), created.id), before);
  console.log('PASS agent persistence: one complete PUT, 10 menus, full reload, API and UI deep-equal including metadata');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 600 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const dimensions = await page.locator('.shell-editor').evaluate(el => {
      const r = el.getBoundingClientRect(); const title = el.querySelector('textarea');
      return { x: r.x, y: r.y, width: r.width, height: r.height, overflow: el.scrollWidth > el.clientWidth, titleOverflow: title.scrollWidth > title.clientWidth };
    });
    assert.ok(dimensions.x >= 0 && dimensions.y >= 0);
    assert.ok(dimensions.x + dimensions.width <= viewport.width && dimensions.y + dimensions.height <= viewport.height);
    assert.equal(dimensions.overflow, false); assert.equal(dimensions.titleOverflow, false);
    console.log('PASS editor dimensions', viewport, dimensions);
  }
  await page.locator('.shell-editor button[title]').evaluateAll(buttons => window.closeTitles = buttons.map(b => b.title));
  const close = page.locator('.shell-editor button').filter({ has: page.locator('svg.lucide-x') });
  await close.click();
  await page.locator('.shell-editor').waitFor({ state: 'detached' });
  console.log('PASS agent editor X click reaches handler');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: /^Articles/ }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('docteur-sidebar-gesture', { detail: { action: 'next' } })));
  const first = await page.locator('.sidebar-item[data-selected="true"]').getAttribute('data-neuron-id');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('docteur-sidebar-gesture', { detail: { action: 'next' } })));
  const second = await page.locator('.sidebar-item[data-selected="true"]').getAttribute('data-neuron-id');
  assert.notEqual(first, second); assert.equal((await read(second)).kind, 'link');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('docteur-sidebar-gesture', { detail: { action: 'scroll', direction: 1 } })));
  await page.waitForFunction(() => document.querySelector('.sidebar-list').scrollTop > 0);
  console.log('PASS sidebar filtered navigation, first selection, server hydration, vertical scrolling');
  await page.evaluate(async () => { await window.regression.updatePage('fixture-0', { title: 'Hydrated edit' }); await window.regression.flushAllSaves(); });
  assert.equal((await read('fixture-0')).blocks[0].content, 'Persistent fixture 0');
  console.log('PASS metadata stub hydrated before update; content preserved in SQLite');
  await page.evaluate(async () => {
    const api = window.regression;
    await api.updatePage('fixture-0', { title: 'Batched title' });
    await api.createLink('fixture-0', 'fixture-1');
    await api.createLink('fixture-0', 'fixture-2');
    await api.flushAllSaves();
  });
  const linked = await read('fixture-0');
  assert.equal(linked.title, 'Batched title');
  assert.ok(linked.links.includes('fixture-1') && linked.links.includes('fixture-2'));
  assert.equal(linked.blocks[0].content, 'Persistent fixture 0');
  console.log('PASS batched update + successive bidirectional links: latest title, both links and content saved');
  await page.route('**/api/neuron/**', async route => {
    if (route.request().method() === 'PUT') await route.abort('connectionrefused');
    else await route.fallback();
  });
  const offline = await page.evaluate(async () => {
    const { savePage, getPage } = await import('/src/lib/storage.ts');
    const page = { id: 'offline-note', title: 'Offline edit', kind: 'note', blocks: [], createdAt: 1, updatedAt: 1 };
    await savePage(page);
    let agentRejected = false;
    try { await window.regression.agent({ title: 'Unacknowledged agent', content: 'Keep locally', kind: 'rapport' }); }
    catch { agentRejected = true; }
    return { local: await getPage(page.id), agentRejected };
  });
  assert.equal(offline.local.title, 'Offline edit');
  assert.equal(offline.agentRejected, true);
  console.log('PASS offline PC copy retained; agent creation requires server acknowledgement');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
