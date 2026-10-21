// [GAME-3] Arcade local saves in real Chromium: host-owned IndexedDB, postMessage-only game access, persistence
// across iframe teardown and page reload, bounds, forged senders, explicit reset, storage failures, 360 px and
// keyboard. Every scenario runs in its own fresh browser context (own storage); data is synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { arcadeGameBundlePlugin } from './vite-arcade-game-bundle.mjs';

const GAME = 'synapse-run', KEY = 'arcade:v1:synapse-run', MARKER = 'SYNTHETIC-SAVE-MARKER';
let browser, server, origin, assertions = 0;
const scenarios = [];
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };
const ok = (value, label) => { assert.ok(value, label); assertions++; };
const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/arcade-save-harness.jsx");mount();</script>';
const network = { requests: 0, api: [], external: [], unexpectedGameRequests: [], gameAssets: 0 };
let perf = null;
const watchdog = setTimeout(() => { console.error('Arcade save browser deadline'); process.exit(1); }, 300_000);

const fromGame = request => { try { return request.frame().parentFrame() !== null; } catch { return false; } };

/** One isolated context per scenario: fresh IndexedDB/localStorage, no order dependency. */
async function scenario(name, run, { init, viewport = { width: 1280, height: 900 }, seed } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [], logs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => logs.push(message.text()));
  if (init) await context.addInitScript(init);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    network.requests++;
    if (fromGame(request)) {
      if (url.origin !== origin || !/^\/arcade\/synapse-run\/(index\.html|foundation\.(js|css)|game\.js)$/.test(url.pathname)) { network.unexpectedGameRequests.push(url.href); return route.abort('blockedbyclient'); }
      network.gameAssets++;
      return route.continue();
    }
    if (url.pathname === '/__arcade_save_test') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/__arcade_blank') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' });
    if (url.pathname.startsWith('/api/')) { network.api.push(url.pathname); return route.abort('blockedbyclient'); }
    if (url.origin !== origin) { network.external.push(url.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  if (seed) {
    await page.goto(`${origin}/__arcade_blank`);
    await page.evaluate(seed.fn ?? seed, seed.arg);
  }
  await page.goto(`${origin}/__arcade_save_test`);
  await page.getByTestId('arcade-panel').waitFor();
  try {
    await run(page, context);
    eq(errors, [], `${name}: page errors`);
    ok(logs.every(text => !text.includes(MARKER)), `${name}: save contents never logged`);
  } finally {
    await context.close();
  }
  scenarios.push(name);
  console.log(`PASS ${name}`);
}

// ── page helpers ──────────────────────────────────────────────────────────────────────────────────────────────
const frameOf = page => page.frames().find(f => f.url().includes('/arcade/synapse-run/'));
const waitPhase = (page, value) => page.waitForFunction(value => document.querySelector('[data-testid="arcade-host"]')?.dataset.phase === value, value);
const waitFrameSave = (page, value) => frameOf(page).waitForFunction(v => document.documentElement.dataset.save === v, value);
const waitCard = (page, value) => page.waitForFunction(value => document.querySelector('[data-testid="arcade-save-synapse-run"]')?.dataset.saveState === value, value);
async function launch(page, save = 'EMPTY') {
  await page.getByTestId(`arcade-launch-${GAME}`).click();
  await waitPhase(page, 'active');
  if (save) await waitFrameSave(page, save);
}
async function stop(page) {
  await page.getByTestId('arcade-stop').click();
  await page.getByTestId(`arcade-launch-${GAME}`).waitFor();
}

/**
 * Sends one request FROM the game frame (its own realm, via postMessage only) and waits for the correlated result.
 * `dataKind` builds a non-JSON value inside the frame (the page CSP forbids eval, so builders are fixed here).
 */
function gameRequest(page, type, payload = {}, { changes = {}, dataKind } = {}) {
  return frameOf(page).evaluate(async ({ type, payload, changes, dataKind }) => {
    const makers = {
      x65534: () => 'x'.repeat(65_534), x65535: () => 'x'.repeat(65_535), e32768: () => 'é'.repeat(32_768), zeros: () => Array(40_000).fill(0),
      date: () => new Date(0), blob: () => new Blob(['x']), nan: () => ({ n: NaN }), bytes: () => new Uint8Array(4), map: () => new Map([[1, 2]]),
      deep: () => { let d = 0; for (let i = 0; i < 40; i++) d = [d]; return d; }, undef: () => undefined,
    };
    const instanceId = location.hash.slice('#instance='.length);
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
    const data = dataKind ? { saveVersion: 1, data: makers[dataKind]() } : payload;
    const message = { channel: 'docteur-arcade', v: 1, type, gameId: 'synapse-run', instanceId, requestId, payload: data, ...changes };
    return new Promise(resolve => {
      const timer = setTimeout(() => { removeEventListener('message', onMessage); resolve('NO_REPLY'); }, 1_000);
      function onMessage(event) {
        if (event.source !== parent || event.data?.type !== 'ARCADE_SAVE_RESULT' || event.data.requestId !== message.requestId) return;
        clearTimeout(timer); removeEventListener('message', onMessage);
        resolve(event.data);
      }
      addEventListener('message', onMessage);
      parent.postMessage(message, '*');
    });
  }, { type, payload, changes, dataKind });
}
const write = (page, data, saveVersion = 1) => gameRequest(page, 'ARCADE_SAVE_WRITE', { saveVersion, data });
const load = page => gameRequest(page, 'ARCADE_SAVE_LOAD');

/** Parent-origin test fixture access to the dedicated DB (same open contract as the app: v1 + "saves"). */
function raw(page, op, key = KEY, value) {
  return page.evaluate(({ op, key, value }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('docteur-arcade', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('saves');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('saves', op === 'get' || op === 'keys' ? 'readonly' : 'readwrite'), store = tx.objectStore('saves');
      const r = op === 'get' ? store.get(key) : op === 'keys' ? store.getAllKeys() : op === 'put' ? store.put(value, key) : store.delete(key);
      tx.oncomplete = () => { db.close(); resolve(op === 'get' || op === 'keys' ? r.result : null); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { op, key, value });
}
const seedRecord = arg => ({ arg, fn: value => new Promise((resolve, reject) => {
    const request = indexedDB.open('docteur-arcade', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('saves');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put(value, 'arcade:v1:synapse-run');
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  }) });
async function dropped(page, send) {
  const before = Number(await page.getByTestId('arcade-host').getAttribute('data-dropped-messages') || 0);
  await send();
  await page.waitForFunction(n => Number(document.querySelector('[data-testid="arcade-host"]')?.dataset.droppedMessages) > n, before);
}

try {
  server = await createServer({ configFile: false, plugins: [react(), arcadeGameBundlePlugin()], cacheDir: '.tmp/vite-arcade-save-tests', optimizeDeps: { entries: ['scripts/arcade-save-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  await scenario('1-2 foundation launches under the unchanged GAME-2 sandbox (no allow-same-origin)', async page => {
    await launch(page);
    const frame = page.getByTestId('arcade-frame');
    eq(await frame.getAttribute('sandbox'), 'allow-scripts');
    eq(await page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => [...f.sandbox])), [['allow-scripts']]);
    eq(await frameOf(page).evaluate(() => self.origin), 'null');
    ok((await frame.getAttribute('allow')).includes("camera 'none'"));
    eq(await frameOf(page).locator('html').getAttribute('data-state'), 'active');
  });

  await scenario('3-4 game reaches its save only through the host: fresh store is empty', async page => {
    await waitCard(page, 'EMPTY');
    eq(await page.getByTestId(`arcade-save-status-${GAME}`).innerText(), 'Sauvegarde locale : aucune');
    eq(await page.getByTestId(`arcade-save-reset-${GAME}`).count(), 0);
    await launch(page, 'EMPTY');
    eq(await page.getByTestId('arcade-host').getAttribute('data-save-requests'), '1'); // the foundation's single LOAD
    eq(await frameOf(page).locator('#sr-save').innerText(), 'Sauvegarde locale : aucune');
    eq(await frameOf(page).evaluate(() => { try { indexedDB.open('docteur-arcade'); return 'OPENED'; } catch (e) { return e.name; } }), 'SecurityError');
    eq((await load(page)).payload, { op: 'LOAD', status: 'EMPTY' });
    eq(await raw(page, 'keys'), []);
    const result = await write(page, { marker: MARKER, level: 1 });
    eq(result.payload.status, 'SAVED');
    eq(await raw(page, 'keys'), [KEY]); // written by the host into the parent-origin Arcade DB
  });

  await scenario('5 valid write: host timestamps, typed result, host status line', async page => {
    await launch(page);
    const before = await page.evaluate(() => Date.now());
    const result = await write(page, { marker: MARKER, list: [1, 'é', null], nested: { ok: true } });
    const after = await page.evaluate(() => Date.now());
    eq(Object.keys(result).sort(), ['channel', 'gameId', 'instanceId', 'payload', 'requestId', 'type', 'v']);
    eq([result.payload.op, result.payload.status, result.payload.save.saveVersion], ['WRITE', 'SAVED', 1]);
    ok(result.payload.save.createdAt >= before && result.payload.save.updatedAt <= after && result.payload.save.createdAt === result.payload.save.updatedAt);
    eq(Object.keys(result.payload.save).sort(), ['createdAt', 'saveVersion', 'updatedAt']);
    const stored = await raw(page, 'get');
    eq(Object.keys(stored).sort(), ['bytes', 'createdAt', 'gameId', 'payload', 'saveVersion', 'schema', 'updatedAt']);
    eq([stored.schema, stored.gameId, stored.createdAt], [1, GAME, result.payload.save.createdAt]);
    eq(await page.getByTestId('arcade-save-status').innerText(), 'Sauvegarde locale : enregistrée sur cet appareil');
    ok(!(await page.getByTestId('arcade-panel').innerText()).includes(MARKER), 'raw save never displayed');
  });

  await scenario('6/22 persistence survives iframe teardown, a new launch and a page reload', async page => {
    await launch(page);
    const data = { marker: MARKER, checkpoint: 'synthetic-7', values: [3, 1, 4] };
    const saved = await write(page, data);
    const firstInstance = await frameOf(page).evaluate(() => location.hash);
    await stop(page);
    eq(await page.getByTestId('arcade-frame').count(), 0);
    await waitCard(page, 'FOUND');
    ok((await page.getByTestId(`arcade-save-status-${GAME}`).innerText()).startsWith('Sauvegarde locale disponible'));
    await launch(page, 'FOUND');
    ok(await frameOf(page).evaluate(() => location.hash) !== firstInstance, 'new instance id');
    eq(await frameOf(page).locator('#sr-save').innerText(), 'Sauvegarde locale : disponible');
    const relaunch = await load(page);
    eq(relaunch.payload, { op: 'LOAD', status: 'FOUND', save: { ...saved.payload.save, data } });
    await page.reload();
    await waitCard(page, 'FOUND');
    await launch(page, 'FOUND');
    eq((await load(page)).payload.save.data, data);
  });

  await scenario('7 oversized write rejected before persistence; exact 64 KiB accepted', async page => {
    await launch(page);
    await write(page, { marker: MARKER, keep: true });
    const before = await raw(page, 'get');
    for (const dataKind of ['x65535', 'e32768', 'zeros']) {
      eq((await gameRequest(page, 'ARCADE_SAVE_WRITE', null, { dataKind })).payload, { op: 'WRITE', status: 'ERROR', code: 'SAVE_TOO_LARGE' }, dataKind);
    }
    eq(await raw(page, 'get'), before);
    eq(await page.getByTestId('arcade-save-status').innerText(), 'Sauvegarde locale : refusée (plus de 64 Kio)');
    const exact = await gameRequest(page, 'ARCADE_SAVE_WRITE', null, { dataKind: 'x65534' });
    eq(exact.payload.status, 'SAVED');
    eq((await raw(page, 'get')).bytes, 65_536);
  });

  await scenario('8 malformed requests: bad envelopes dropped, invalid contents typed, record unchanged', async page => {
    await launch(page);
    await write(page, { marker: MARKER, keep: true });
    const before = await raw(page, 'get');
    const requestsBefore = await page.getByTestId('arcade-host').getAttribute('data-save-requests');
    for (const changes of [{ extra: 1 }, { requestId: 'nothex' }, { requestId: 'ABCDEF0123456789' }, { type: 'ARCADE_SAVE_LIST' }, { type: 'ARCADE_STORAGE_COMMAND' }, { type: 'ARCADE_DB' }, { payload: { saveVersion: 1 } }, { payload: { saveVersion: 1, data: {}, key: 'arcade:v1:other' } }, { payload: null }]) {
      await dropped(page, async () => eq(await gameRequest(page, 'ARCADE_SAVE_WRITE', { saveVersion: 1, data: {} }, { changes }), 'NO_REPLY'));
    }
    eq(await page.getByTestId('arcade-host').getAttribute('data-save-requests'), requestsBefore);
    for (const dataKind of ['date', 'blob', 'nan', 'bytes', 'map', 'deep', 'undef']) {
      eq((await gameRequest(page, 'ARCADE_SAVE_WRITE', null, { dataKind })).payload, { op: 'WRITE', status: 'ERROR', code: 'INVALID_SAVE_PAYLOAD' }, dataKind);
    }
    for (const saveVersion of [0, 2, 1.5, '1', null]) eq((await write(page, {}, saveVersion)).payload.code, 'INVALID_SAVE_VERSION');
    eq(await raw(page, 'get'), before);
    eq(await frameOf(page).locator('html').getAttribute('data-state'), 'active');
  });

  await scenario('9-11 wrong instance, stale iframe and unrelated windows cannot write or delete', async page => {
    await launch(page);
    await write(page, { marker: MARKER, owner: 'first' });
    const baseline = await raw(page, 'get');
    const forged = async send => { await dropped(page, send); eq(await raw(page, 'get'), baseline); };
    // 9 the live frame itself, but with a wrong instance id
    await forged(() => gameRequest(page, 'ARCADE_SAVE_WRITE', { saveVersion: 1, data: { owner: 'forged' } }, { changes: { instanceId: 'b'.repeat(32) } }));
    await forged(() => gameRequest(page, 'ARCADE_SAVE_DELETE', {}, { changes: { instanceId: 'c'.repeat(32) } }));
    // 10 stale iframe: keep the old window + id, relaunch, replay from the old window and with the old id
    const oldId = await frameOf(page).evaluate(() => location.hash.slice('#instance='.length));
    await page.evaluate(() => { window.__oldArcadeWindow = document.querySelector('[data-testid="arcade-frame"]').contentWindow; });
    await stop(page);
    await launch(page, 'FOUND');
    const envelope = (type, payload, instanceId) => ({ channel: 'docteur-arcade', v: 1, type, gameId: GAME, instanceId, requestId: 'feedfacecafebeef', payload });
    const liveId = await frameOf(page).evaluate(() => location.hash.slice('#instance='.length));
    await forged(() => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data, source: window.__oldArcadeWindow })), envelope('ARCADE_SAVE_WRITE', { saveVersion: 1, data: { owner: 'stale' } }, liveId)));
    await forged(() => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data, source: window.__oldArcadeWindow })), envelope('ARCADE_SAVE_DELETE', {}, liveId)));
    await forged(() => gameRequest(page, 'ARCADE_SAVE_WRITE', { saveVersion: 1, data: { owner: 'old-id' } }, { changes: { instanceId: oldId } }));
    // 11 unrelated windows: the parent itself, and another sandboxed frame that knows the live instance id
    await forged(() => page.evaluate(data => window.postMessage(data, '*'), envelope('ARCADE_SAVE_WRITE', { saveVersion: 1, data: { owner: 'parent' } }, liveId)));
    await forged(() => page.evaluate(data => new Promise(resolve => {
      const intruder = document.createElement('iframe');
      intruder.setAttribute('sandbox', 'allow-scripts');
      intruder.srcdoc = `<script>parent.postMessage(${JSON.stringify(data)}, '*');<\/script>`;
      intruder.onload = () => resolve();
      document.body.appendChild(intruder);
    }), envelope('ARCADE_SAVE_DELETE', {}, liveId)));
    eq((await load(page)).payload.save.data, baseline.payload);
    eq(await page.evaluate(() => document.querySelectorAll('iframe').length), 2); // the live game + the intruder
  });

  await scenario('12 game delete removes only its own save', async page => {
    await launch(page);
    await write(page, { marker: MARKER });
    await raw(page, 'put', 'arcade:v1:other-game', { synthetic: 'other' });
    await raw(page, 'put', 'unrelated-key', 'unrelated');
    eq((await gameRequest(page, 'ARCADE_SAVE_DELETE')).payload, { op: 'DELETE', status: 'DELETED' });
    eq((await raw(page, 'keys')).sort(), ['arcade:v1:other-game', 'unrelated-key']);
    eq((await load(page)).payload, { op: 'LOAD', status: 'EMPTY' });
    eq(await page.getByTestId('arcade-save-status').innerText(), 'Sauvegarde locale : aucune');
  });

  await scenario('13 UI reset needs an explicit confirmation and touches only this game', async page => {
    await launch(page);
    await write(page, { marker: MARKER });
    await raw(page, 'put', 'unrelated-key', 'unrelated');
    await stop(page);
    await waitCard(page, 'FOUND');
    await page.getByTestId(`arcade-save-reset-${GAME}`).click();
    eq(await page.getByTestId(`arcade-save-confirm-${GAME}`).count(), 1);
    eq((await raw(page, 'keys')).sort(), [KEY, 'unrelated-key']); // one click deletes nothing
    await page.getByTestId(`arcade-save-cancel-${GAME}`).click();
    eq(await page.getByTestId(`arcade-save-confirm-${GAME}`).count(), 0);
    eq((await raw(page, 'keys')).sort(), [KEY, 'unrelated-key']);
    await page.getByTestId(`arcade-save-reset-${GAME}`).click();
    await page.getByTestId(`arcade-save-confirm-delete-${GAME}`).click();
    await waitCard(page, 'EMPTY');
    eq(await raw(page, 'keys'), ['unrelated-key']);
    eq(await page.getByTestId(`arcade-save-reset-${GAME}`).count(), 0);
    eq(await page.evaluate(() => [localStorage.getItem('docteur.arcade-test-secret'), sessionStorage.getItem('docteur.arcade-test-secret')]), ['PARENT-LS-SECRET-27fa', 'PARENT-SS-SECRET-61d0']);
  });

  await scenario('14-15 parent storage, Arcade DB and Docteur API stay unreachable from the game', async page => {
    await launch(page);
    const result = await frameOf(page).evaluate(() => {
      const read = fn => { try { return fn(); } catch (e) { return e.name; } };
      return [read(() => parent.localStorage.getItem('docteur.arcade-test-secret')), read(() => parent.sessionStorage.length), read(() => parent.document.cookie), read(() => parent.indexedDB.open('docteur-arcade')),
        read(() => localStorage.length), read(() => document.cookie), read(() => indexedDB.open('docteur-arcade')), read(() => parent.document.querySelector('[data-testid="parent-secret"]').textContent), read(() => parent.__arcadeSaveBench)];
    });
    eq(result, Array(9).fill('SecurityError'));
    const probe = await frameOf(page).evaluate(async () => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective));
      const out = [];
      for (const url of ['http://127.0.0.1:3001/api/notebooks', 'http://127.0.0.1:3001/api/companion/status', 'https://arcade-save-probe.invalid/sync']) {
        try { await fetch(url, { method: 'POST', body: 'synthetic' }); out.push('SUCCESS'); } catch { out.push('BLOCKED'); }
      }
      out.push(await new Promise(resolve => { const x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:3001/api/health'); x.onload = () => resolve('SUCCESS'); x.onerror = () => resolve('BLOCKED'); x.send(); }));
      await new Promise(resolve => setTimeout(resolve, 30));
      return { out, violations };
    });
    eq(probe.out, ['BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED']);
    ok(probe.violations.length >= 4 && probe.violations.every(v => v === 'connect-src'));
  });

  await scenario('17 360 px: status, reset and confirmation fit without horizontal overflow', async page => {
    await launch(page);
    await write(page, { marker: MARKER });
    eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    eq(await frameOf(page).evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await stop(page);
    await waitCard(page, 'FOUND');
    await page.getByTestId(`arcade-save-reset-${GAME}`).click();
    eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    eq(await page.getByTestId('arcade-panel').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    for (const id of [`arcade-save-confirm-delete-${GAME}`, `arcade-save-cancel-${GAME}`]) {
      const box = await page.getByTestId(id).boundingBox();
      ok(box && box.x >= 0 && box.x + box.width <= 360 && box.height >= 24, id);
    }
  }, { viewport: { width: 360, height: 800 } });

  await scenario('18 keyboard: reset, cancel, confirm and focus placement', async page => {
    await launch(page);
    await write(page, { marker: MARKER });
    await stop(page);
    await waitCard(page, 'FOUND');
    const reset = page.getByTestId(`arcade-save-reset-${GAME}`);
    await page.getByTestId(`arcade-launch-${GAME}`).focus();
    await page.keyboard.press('Shift+Tab');
    eq(await reset.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    eq(await page.getByTestId(`arcade-save-cancel-${GAME}`).evaluate(el => el === document.activeElement), true); // safe default
    await page.keyboard.press('Enter');
    eq(await reset.evaluate(el => el === document.activeElement), true);
    eq(await raw(page, 'keys'), [KEY]);
    await page.keyboard.press('Space');
    await page.keyboard.press('Shift+Tab');
    eq(await page.getByTestId(`arcade-save-confirm-delete-${GAME}`).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    await waitCard(page, 'EMPTY');
    eq(await page.getByTestId(`arcade-save-status-${GAME}`).evaluate(el => el === document.activeElement), true);
    eq(await raw(page, 'keys'), []);
  });

  await scenario('17a IndexedDB unavailable: typed error, Arcade usable, no fallback storage', async page => {
    await waitCard(page, 'STORAGE_UNAVAILABLE');
    eq(await page.getByTestId(`arcade-save-status-${GAME}`).innerText(), 'Sauvegarde locale : indisponible dans ce navigateur');
    await launch(page, 'ERROR');
    eq(await frameOf(page).locator('#sr-save').innerText(), 'Sauvegarde locale : indisponible');
    eq((await write(page, { marker: MARKER })).payload, { op: 'WRITE', status: 'ERROR', code: 'STORAGE_UNAVAILABLE' });
    eq(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [1, 1]); // only the harness's own synthetic keys
    eq(await frameOf(page).locator('html').getAttribute('data-state'), 'active');
  }, { init: () => { if (window === window.top) Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }); } });

  await scenario('17b IndexedDB open throws: typed error, Arcade usable', async page => {
    await waitCard(page, 'STORAGE_UNAVAILABLE');
    await launch(page, 'ERROR');
    eq((await load(page)).payload, { op: 'LOAD', status: 'ERROR', code: 'STORAGE_UNAVAILABLE' });
  }, { init: () => { if (window === window.top) IDBFactory.prototype.open = function () { throw new DOMException('synthetic', 'SecurityError'); }; } });

  await scenario('17c IndexedDB open fails asynchronously (newer DB version): typed error', async page => {
    await waitCard(page, 'STORAGE_UNAVAILABLE');
    await launch(page, 'ERROR');
    eq((await write(page, { marker: MARKER })).payload.code, 'STORAGE_UNAVAILABLE');
  }, { seed: () => new Promise(resolve => { const r = indexedDB.open('docteur-arcade', 5); r.onupgradeneeded = () => r.result.createObjectStore('saves'); r.onsuccess = () => { r.result.close(); resolve(); }; }) });

  await scenario('17d transaction aborts: typed error, previous record intact', async page => {
    await launch(page);
    await write(page, { marker: MARKER, generation: 1 });
    const before = await raw(page, 'get');
    await page.evaluate(() => { window.__arcadeFailPut = true; });
    eq((await write(page, { marker: MARKER, generation: 2 })).payload, { op: 'WRITE', status: 'ERROR', code: 'STORAGE_FAILED' });
    eq(await raw(page, 'get'), before);
    await page.evaluate(() => { window.__arcadeFailPut = false; });
    eq((await write(page, { marker: MARKER, generation: 3 })).payload.status, 'SAVED'); // the store recovers
  }, { init: () => {
    if (window !== window.top) return;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { const request = put.apply(this, args); if (window.__arcadeFailPut) this.transaction.abort(); return request; };
  } });

  const corruptCases = [
    ['17e corrupt record', 'garbage-string', 'CORRUPT_SAVE', 'Sauvegarde locale : illisible ; conservée telle quelle, effaçable depuis la liste de l’Arcade'],
    ['17f oversized legacy record', { schema: 1, gameId: GAME, saveVersion: 1, createdAt: 1, updatedAt: 2, bytes: 70_002, payload: 'x'.repeat(70_000) }, 'CORRUPT_SAVE', null],
    ['17g unsupported future schema', { schema: 2, gameId: GAME, futureField: 'kept' }, 'UNSUPPORTED_SAVE_VERSION', 'Sauvegarde locale : créée par une version plus récente ; conservée sans être chargée'],
  ];
  for (const [name, stored, code, text] of corruptCases) {
    await scenario(`${name}: typed error, preserved, game refused, explicit reset possible`, async page => {
      await waitCard(page, code);
      if (text) eq(await page.getByTestId(`arcade-save-status-${GAME}`).innerText(), text);
      await launch(page, 'ERROR');
      eq((await load(page)).payload, { op: 'LOAD', status: 'ERROR', code });
      eq((await write(page, { marker: MARKER })).payload, { op: 'WRITE', status: 'ERROR', code });
      eq(await raw(page, 'get'), stored);
      await stop(page);
      await page.getByTestId(`arcade-save-reset-${GAME}`).click();
      await page.getByTestId(`arcade-save-confirm-delete-${GAME}`).click();
      await waitCard(page, 'EMPTY');
      eq(await raw(page, 'keys'), []);
    }, { seed: seedRecord(stored) });
  }

  await scenario('extra in-flight bound: a request burst gets SAVE_BUSY, never a broken record', async page => {
    await launch(page);
    const results = await frameOf(page).evaluate(() => {
      const instanceId = location.hash.slice('#instance='.length);
      const ids = Array.from({ length: 12 }, (_, i) => (0xa0 + i).toString(16).padStart(16, '0'));
      return new Promise(resolve => {
        const got = {};
        addEventListener('message', event => {
          if (event.data?.type !== 'ARCADE_SAVE_RESULT' || !ids.includes(event.data.requestId)) return;
          got[event.data.requestId] = event.data.payload.status === 'ERROR' ? event.data.payload.code : event.data.payload.status;
          if (Object.keys(got).length === ids.length) resolve(Object.values(got));
        });
        for (const [i, requestId] of ids.entries()) parent.postMessage({ channel: 'docteur-arcade', v: 1, type: 'ARCADE_SAVE_WRITE', gameId: 'synapse-run', instanceId, requestId, payload: { saveVersion: 1, data: { burst: i } } }, '*');
      });
    });
    ok(results.includes('SAVE_BUSY') && results.includes('SAVED') && results.every(r => r === 'SAVED' || r === 'SAVE_BUSY'), JSON.stringify(results));
    const loaded = await load(page);
    eq(loaded.payload.status, 'FOUND');
    ok(Number.isInteger(loaded.payload.save.data.burst));
  });

  await scenario('25 latency observations (synthetic data, real IndexedDB adapter)', async page => {
    perf = await page.evaluate(() => window.__arcadeSaveBench(10));
    for (const entry of Object.values(perf)) ok(entry.allOk);
  });

  eq(network.api, [], 'backend requests');
  eq(network.external, [], 'external requests');
  eq(network.unexpectedGameRequests, [], 'game requests beyond its 3 static files');
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync('.tmp/arcade-saves-browser-evidence.json', JSON.stringify({ scenarios, assertions, network, perf }, null, 2));
  console.log(JSON.stringify({ scenarios: scenarios.length, assertions, network: { routed: network.requests, gameStaticAssets: network.gameAssets, backend: 0, external: 0, unexpectedGame: 0 }, perf }, null, 2));
} finally {
  clearTimeout(watchdog);
  await browser?.close(); await server?.close();
}
