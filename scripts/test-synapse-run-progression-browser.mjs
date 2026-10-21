// [GAME-5] Synapse Run — touch/mobile controls, pause reasons and local progression in real Chromium, through the
// REAL Arcade host, foundation.js bridge, GAME-3 save store and IndexedDB (fresh browser context per scenario).
// Gameplay uses the test-only manual clock / autopilot; touches are real touch input (Playwright tap + CDP
// Input.dispatchTouchEvent). Direct IndexedDB access below is test setup / inspection on the PARENT origin only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { arcadeGameBundlePlugin } from './vite-arcade-game-bundle.mjs';
import { LANE_CHANGE_TICKS } from '../src/arcade/synapse-run/simulation.ts';
import { defaultProfile, serializeProfile } from '../src/arcade/synapse-run/progression.ts';

const GAME = 'synapse-run', KEY = 'arcade:v1:synapse-run';
let browser, server, origin, assertions = 0;
const scenarios = [];
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };
const ok = (value, label) => { assert.ok(value, label); assertions++; };
const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/arcade-save-harness.jsx");mount();</script>';
const network = { api: [], external: [], unexpectedGameRequests: [] };
const watchdog = setTimeout(() => { console.error('Synapse Run progression browser deadline'); process.exit(1); }, 600_000);
const fromGame = request => { try { return request.frame().parentFrame() !== null; } catch { return false; } };
const MOBILE = { viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

async function scenario(name, run, { context: contextOptions = {}, init, seed } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...contextOptions });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (init) await context.addInitScript(init);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (fromGame(request)) {
      if (url.origin !== origin || !/^\/arcade\/synapse-run\/(index\.html|foundation\.(js|css)|game\.js)$/.test(url.pathname)) { network.unexpectedGameRequests.push(url.href); return route.abort('blockedbyclient'); }
      return route.continue();
    }
    if (url.pathname === '/__progress_test') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/__blank') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' });
    if (url.pathname.startsWith('/api/')) { network.api.push(url.pathname); return route.abort('blockedbyclient'); }
    if (url.origin !== origin) { network.external.push(url.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  if (seed) { await page.goto(`${origin}/__blank`); await page.evaluate(seed.fn, seed.arg); }
  await page.goto(`${origin}/__progress_test`);
  await page.getByTestId('arcade-panel').waitFor();
  try {
    await run(page, context);
    eq(errors, [], `${name}: page errors`);
  } finally {
    await context.close();
  }
  scenarios.push(name);
  console.log(`PASS ${name}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────
const frameOf = page => page.frames().find(f => f.url().includes('/arcade/synapse-run/'));
const waitPhase = (page, v) => page.waitForFunction(v => document.querySelector('[data-testid="arcade-host"]')?.dataset.phase === v, v);
const snap = page => frameOf(page).evaluate(() => window.__synapseRunTest.snapshot());
const hook = (page, name, ...args) => frameOf(page).evaluate(([name, args]) => window.__synapseRunTest[name](...args), [name, args]);
/** waits until the snapshot matches every given field (the frame CSP forbids eval, so no predicate source) */
const waitSnap = (page, fields) => frameOf(page).waitForFunction(fields => {
  const s = window.__synapseRunTest.snapshot();
  return Object.entries(fields).every(([k, v]) => (k === 'totalRuns' ? s.profile.totalRuns : s[k]) === v);
}, fields);
async function launch(page, progress = 'READY') {
  await page.getByTestId(`arcade-launch-${GAME}`).click();
  await waitPhase(page, 'active');
  await frameOf(page).waitForFunction(p => document.documentElement.dataset.gameState === 'READY' && document.documentElement.dataset.progress === p, progress);
}
async function startManual(page, seed, { touch = false } = {}) {
  await hook(page, 'setManual', true);
  await hook(page, 'restart', seed);
  if (touch) await frameOf(page).locator('#sr-action').tap();
  else { await frameOf(page).locator('#sr-action').focus(); await page.keyboard.press('Enter'); }
  await hook(page, 'advance', 1);
  eq((await snap(page)).status, 'RUNNING');
}
/** Plays a deterministic run long enough for all three missions, then lets it end against an obstacle. */
async function playLongRunToGameOver(page, seed) {
  await startManual(page, seed);
  await hook(page, 'setAutopilot', 99);
  await hook(page, 'advance', 3600);
  await hook(page, 'advance', 600);
  await hook(page, 'setAutopilot', null);
  for (let i = 0; i < 10 && (await snap(page)).status !== 'GAME_OVER'; i++) await hook(page, 'advance', 600);
  const s = await snap(page);
  eq(s.status, 'GAME_OVER');
  return s;
}
async function playShortRunToGameOver(page, seed) {
  await startManual(page, seed);
  for (let i = 0; i < 10 && (await snap(page)).status !== 'GAME_OVER'; i++) await hook(page, 'advance', 600);
  const s = await snap(page);
  eq(s.status, 'GAME_OVER');
  return s;
}
function raw(page, op, key = KEY, value) {
  return page.evaluate(({ op, key, value }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('docteur-arcade', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('saves');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('saves', op === 'get' ? 'readonly' : 'readwrite'), store = tx.objectStore('saves');
      const r = op === 'get' ? store.get(key) : store.put(value, key);
      tx.oncomplete = () => { db.close(); resolve(op === 'get' ? r.result : null); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { op, key, value });
}
const seedRecord = value => ({ arg: value, fn: value => new Promise(resolve => {
  const request = indexedDB.open('docteur-arcade', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('saves');
  request.onsuccess = () => { const db = request.result, tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put(value, 'arcade:v1:synapse-run'); tx.oncomplete = () => { db.close(); resolve(); }; };
}) });
/** a GAME-3-valid envelope around any inner payload (exact UTF-8 byte count) */
const envelope = (payload, saveVersion = 1) => ({ schema: 1, gameId: GAME, saveVersion, createdAt: 1, updatedAt: 2, bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'), payload });

/** real touch swipe (CDP), from the centre of the game frame, in page CSS pixels */
async function swipe(page, context, dx, dy, steps = 6) {
  const box = await page.getByTestId('arcade-frame').boundingBox();
  const x0 = box.x + box.width / 2, y0 = box.y + box.height * 0.4;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const noOverflow = async page => (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) && (await frameOf(page).evaluate(() => document.documentElement.scrollWidth <= innerWidth));

try {
  server = await createServer({ configFile: false, plugins: [react(), arcadeGameBundlePlugin({ testHooks: true })], cacheDir: '.tmp/vite-synapse-progress-tests', optimizeDeps: { entries: ['scripts/arcade-save-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  // ── mobile / touch ──────────────────────────────────────────────────────────────────────────────────────
  await scenario('M1-2/12-13 360 px touch layout: five ≥ 44 px native buttons, labelled, no overflow', async page => {
    await launch(page);
    eq((await snap(page)).controlsVisible, false, 'hidden before the run starts');
    await startManual(page, 7, { touch: true });
    eq((await snap(page)).controlsVisible, true);
    const buttons = frameOf(page).locator('#sr-controls button');
    eq(await buttons.count(), 5);
    const labels = [];
    for (let i = 0; i < 5; i++) {
      const b = buttons.nth(i);
      const box = await b.boundingBox();
      ok(box.width >= 44 && box.height >= 44, `touch target ${JSON.stringify(box)}`);
      labels.push(await b.getAttribute('aria-label'));
      eq(await b.evaluate(el => el.tagName), 'BUTTON');
    }
    eq(labels, ['Couloir de gauche', 'Glissade', 'Pause', 'Saut', 'Couloir de droite']);
    const frameBox = await page.getByTestId('arcade-frame').boundingBox();
    const bar = await frameOf(page).locator('#sr-controls').boundingBox();
    ok(bar.x >= frameBox.x && bar.x + bar.width <= frameBox.x + frameBox.width, 'bar inside the frame');
    ok(await noOverflow(page));
    eq(await frameOf(page).locator('#sr-controls').evaluate(el => getComputedStyle(el).opacity), '1', 'full opacity on touch screens');
  }, { context: MOBILE });

  await scenario('M3-6 tap left / right / jump / slide', async page => {
    await launch(page);
    await startManual(page, 7, { touch: true });
    const tap = async (label, ticks) => { await frameOf(page).getByRole('button', { name: label, exact: true }).tap(); await hook(page, 'advance', ticks); return snap(page); };
    eq((await tap('Couloir de gauche', LANE_CHANGE_TICKS)).lane, 0);
    eq((await tap('Couloir de droite', LANE_CHANGE_TICKS)).lane, 1);
    eq((await tap('Couloir de droite', LANE_CHANGE_TICKS)).lane, 2);
    let s = await tap('Saut', 5);
    ok(s.mode === 'JUMP' && s.y > 0);
    await hook(page, 'advance', 45);
    s = await tap('Glissade', 1);
    eq(s.mode, 'SLIDE');
    eq(await frameOf(page).evaluate(() => document.activeElement?.closest?.('#sr-controls') ?? null), null, 'tapping a control does not move keyboard focus onto it');
    ok(await noOverflow(page));
  }, { context: MOBILE });

  await scenario('M7-11 swipe left / right / up / down; a tiny swipe is ignored', async (page, context) => {
    await launch(page);
    await startManual(page, 7, { touch: true });
    const after = async (dx, dy, ticks) => { await swipe(page, context, dx, dy); await hook(page, 'advance', ticks); return snap(page); };
    eq((await after(-90, 8, LANE_CHANGE_TICKS)).lane, 0, 'swipe left');
    eq((await after(90, -10, LANE_CHANGE_TICKS)).lane, 1, 'swipe right');
    let s = await after(5, -100, 3);
    ok(s.mode === 'JUMP' && s.y > 0, 'swipe up = jump');
    await hook(page, 'advance', 50);
    eq((await after(-6, 100, 1)).mode, 'SLIDE', 'swipe down = slide');
    await hook(page, 'advance', 40);
    const before = await snap(page);
    s = await after(12, -8, 2);
    eq([s.lane, s.mode, s.laneProgress], [before.lane, 'RUN', 0], 'tiny swipe ignored');
    s = await after(-70, -70, LANE_CHANGE_TICKS);
    eq([s.lane, s.mode], [0, 'RUN'], 'exact diagonal → horizontal only');
    ok(await noOverflow(page));
  }, { context: MOBILE });

  await scenario('M14-15 pause and resume by touch; pause menu content', async page => {
    await launch(page);
    await startManual(page, 7, { touch: true });
    await frameOf(page).getByRole('button', { name: 'Pause', exact: true }).tap();
    let s = await snap(page);
    eq([s.pause, s.overlay, s.loopActive], [['PLAYER'], 'Pause', false]);
    const tick = s.tick;
    await hook(page, 'advance', 120);
    eq((await snap(page)).tick, tick, 'paused: no advancement');
    const menu = await frameOf(page).locator('#sr-overlay').innerText();
    ok(menu.includes('Reprendre') && menu.includes('Recommencer la partie') && menu.includes('Échap ou P'), menu);
    ok(await frameOf(page).locator('#sr-missions li').count() === 3);
    await frameOf(page).getByRole('button', { name: 'Reprendre', exact: true }).tap();
    s = await snap(page);
    eq([s.pause, s.overlay, s.status], [[], '', 'RUNNING']);
    await hook(page, 'advance', 10);
    eq((await snap(page)).tick, tick + 10);
  }, { context: MOBILE });

  await scenario('M16 same seed: touch commands and keyboard commands give the same state', async (page, context) => {
    await launch(page);
    const playVia = async mode => {
      await startManual(page, 31337, { touch: mode === 'touch' });
      const steps = [['left', 'ArrowLeft', [-80, 0]], ['jump', 'ArrowUp', [0, -90]], ['right', 'ArrowRight', [80, 0]], ['slide', 'ArrowDown', [0, 90]]];
      for (const [, keyName, [dx, dy]] of steps) {
        if (mode === 'touch') await swipe(page, context, dx, dy); else await page.keyboard.press(keyName);
        await hook(page, 'advance', 45);
      }
      const s = await snap(page);
      return { tick: s.tick, lane: s.lane, y: s.y, mode: s.mode, distance: s.distance, status: s.status, shards: s.shardsCollected };
    };
    const viaKeys = await playVia('keys');
    const viaTouch = await playVia('touch');
    eq(viaTouch, viaKeys);
  }, { context: MOBILE });

  await scenario('keyboard: on-screen controls are keyboard operable; Escape / P toggle the player pause', async page => {
    await launch(page);
    await startManual(page, 7);
    await frameOf(page).getByRole('button', { name: 'Couloir de gauche', exact: true }).focus();
    await page.keyboard.press('Enter');
    await hook(page, 'advance', LANE_CHANGE_TICKS);
    eq((await snap(page)).lane, 0, 'Enter on the focused control');
    await page.keyboard.press('Escape');
    eq((await snap(page)).pause, ['PLAYER']);
    await page.keyboard.press('Escape');
    eq((await snap(page)).pause, []);
    await page.keyboard.press('p');
    eq((await snap(page)).pause, ['PLAYER']);
    await page.keyboard.press('Enter'); // focus is on Reprendre: Enter resumes
    eq((await snap(page)).pause, []);
  });

  await scenario('combined pause reasons: host resume never cancels the player pause (and vice versa)', async page => {
    await launch(page);
    await startManual(page, 7);
    await frameOf(page).locator('body').focus();
    await page.keyboard.press('p');
    await page.getByTestId('arcade-pause-toggle').click();
    await waitPhase(page, 'paused');
    eq((await snap(page)).pause, ['HOST', 'PLAYER']);
    await page.getByTestId('arcade-pause-toggle').click();
    await waitPhase(page, 'active');
    let s = await snap(page);
    eq([s.pause, s.overlay, s.loopActive], [['PLAYER'], 'Pause', false], 'host resumed, player pause remains');
    await page.getByTestId('arcade-pause-toggle').click();
    await waitPhase(page, 'paused');
    await frameOf(page).getByRole('button', { name: 'Reprendre', exact: true }).click();
    s = await snap(page);
    eq([s.pause, s.overlay], [['HOST'], 'En pause'], 'player resumed, host pause remains');
    await page.getByTestId('arcade-pause-toggle').click();
    await waitPhase(page, 'active');
    s = await snap(page);
    eq([s.pause, s.loopActive], [[], true], 'all reasons cleared');
  });

  // ── progression through the real host / bridge / GAME-3 store ────────────────────────────────────────────
  await scenario('P1-6 fresh profile → deterministic run → GAME_OVER → saved → relaunch and reload restore it', async page => {
    await launch(page);
    let s = await snap(page);
    eq([s.saveStatus, s.profile], ['READY', defaultProfile()]);
    ok((await frameOf(page).locator('#sr-missions').innerText()).includes('0 / 500 m'));
    eq(await frameOf(page).evaluate(() => { try { indexedDB.open('docteur-arcade'); return 'OPENED'; } catch (e) { return e.name; } }), 'SecurityError', 'no direct iframe storage');
    const end = await playLongRunToGameOver(page, 2026);
    await waitSnap(page, { writeStatus: 'SAVED' });
    s = await snap(page);
    const distance = Math.floor(end.distance);
    eq([s.profile.totalRuns, s.profile.bestDistanceM, s.profile.bestScore, s.profile.totalDistanceM, s.profile.totalShards], [1, distance, end.score, distance, end.shardsCollected]);
    ok(distance >= 500 && end.shardsCollected >= 10 && end.score >= 750, JSON.stringify({ distance, shards: end.shardsCollected, score: end.score }));
    eq(Object.values(s.profile.missions).map(m => m.completed), [true, true, true]);
    const overlay = await frameOf(page).locator('#sr-overlay').innerText();
    ok(overlay.includes('Nouveau record de distance') && overlay.includes('Mission accomplie') && overlay.includes(`Record ${distance} m`) && overlay.includes('1 course'), overlay);
    ok((await frameOf(page).locator('#sr-missions').innerText()).match(/✓ .*terminée/), 'completion written out, not colour only');
    const stored = await raw(page, 'get');
    eq([stored.saveVersion, stored.payload], [1, serializeProfile(s.profile)], 'host stored exactly the profile');
    ok(stored.bytes < 512, `payload ${stored.bytes} bytes`);
    eq(s.writes, 1);
    await hook(page, 'advance', 300);
    eq((await snap(page)).writes, 1, 'GAME_OVER settles and writes once');
    const profile = s.profile;
    // new iframe launch
    await page.getByTestId('arcade-stop').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="arcade-save-synapse-run"]')?.dataset.saveState === 'FOUND');
    await launch(page);
    eq((await snap(page)).profile, profile, 'relaunch restores the profile');
    ok((await frameOf(page).locator('#sr-profile').innerText()).startsWith(`Record ${distance} m · meilleur score ${end.score} · 1 course`));
    // page reload
    await page.reload();
    await page.getByTestId('arcade-panel').waitFor();
    await launch(page);
    eq((await snap(page)).profile, profile, 'reload restores the profile');
    const missionsText = await frameOf(page).locator('#sr-missions').innerText();
    ok(missionsText.split('\n').every(line => line.includes('terminée')), missionsText);
    // a worse second run keeps the bests and adds to the totals
    const second = await playShortRunToGameOver(page, 1);
    await waitSnap(page, { writeStatus: 'SAVED', totalRuns: 2 });
    s = await snap(page);
    eq([s.profile.bestDistanceM, s.profile.bestScore, s.profile.totalDistanceM], [distance, end.score, distance + Math.floor(second.distance)]);
  });

  await scenario('P abandoned run (Recommencer la partie) settles nothing; restart cannot duplicate a settlement', async page => {
    await launch(page);
    await startManual(page, 5);
    await hook(page, 'advance', 120);
    await page.keyboard.press('Escape');
    await frameOf(page).getByRole('button', { name: 'Recommencer la partie', exact: true }).click();
    await hook(page, 'advance', 1);
    let s = await snap(page);
    eq([s.status, s.tick, s.profile.totalRuns, s.writes, s.pause], ['RUNNING', 1, 0, 0, []], 'abandon = no run counted, nothing written');
    eq(await raw(page, 'get'), undefined);
    const end = await playShortRunToGameOver(page, 1);
    await waitSnap(page, { writeStatus: 'SAVED' });
    await page.keyboard.press('Enter'); // Rejouer
    await hook(page, 'advance', 1);
    s = await snap(page);
    eq([s.status, s.profile.totalRuns, s.writes], ['RUNNING', 1, 1], 'the next run starts; the previous one stays settled once');
    eq(s.profile.totalDistanceM, Math.floor(end.distance));
  });

  // ── save failures ────────────────────────────────────────────────────────────────────────────────────────
  await scenario('F1 write failure: reported, game keeps playing, no retry loop', async page => {
    await launch(page);
    await page.evaluate(() => { window.__arcadeFailPut = true; });
    await playShortRunToGameOver(page, 1);
    await waitSnap(page, { writeStatus: 'FAILED' });
    ok((await frameOf(page).locator('#sr-progress-save').innerText()).startsWith('Échec de l’enregistrement local'));
    await page.waitForTimeout(500);
    eq((await snap(page)).writes, 1, 'no automatic retry');
    eq(await raw(page, 'get'), undefined, 'nothing half-written');
    await page.keyboard.press('Enter');
    await hook(page, 'advance', 1);
    eq((await snap(page)).status, 'RUNNING', 'still playable');
  }, { init: () => { if (window !== window.top) return; const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...a) { const r = put.apply(this, a); if (window.__arcadeFailPut) this.transaction.abort(); return r; }; } });

  await scenario('F2 load failure (IndexedDB unavailable): plays without persistence, never writes', async page => {
    await launch(page, 'UNAVAILABLE');
    ok((await frameOf(page).locator('#sr-progress-save').innerText()).includes('indisponible'));
    await playShortRunToGameOver(page, 1);
    const s = await snap(page);
    eq([s.saveStatus, s.writes, s.profile.totalRuns], ['UNAVAILABLE', 0, 1], 'session counts in memory only');
  }, { init: () => { if (window === window.top) Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }); } });

  const badInner = { ...serializeProfile(defaultProfile()), bestDistanceM: -1 };
  for (const [name, stored] of [
    ['F3 logically invalid inner payload', envelope(badInner)],
    ['F4 GAME-3 CORRUPT_SAVE record', 'corrupt-synthetic-bytes'],
    ['F5 future saveVersion (UNSUPPORTED_SAVE_VERSION)', envelope(serializeProfile(defaultProfile()), 2)],
  ]) {
    await scenario(`${name}: protected, game playable, never overwritten`, async page => {
      await launch(page, 'PROTECTED');
      ok((await frameOf(page).locator('#sr-progress-save').innerText()).includes('conservée telle quelle'));
      await playShortRunToGameOver(page, 1);
      await page.waitForTimeout(300);
      const s = await snap(page);
      eq([s.saveStatus, s.writes], ['PROTECTED', 0]);
      eq(await raw(page, 'get'), stored, 'stored bytes untouched');
    }, { seed: seedRecord(stored) });
  }

  eq(network.api, [], 'backend requests');
  eq(network.external, [], 'external requests');
  eq(network.unexpectedGameRequests, [], 'game requests beyond its 4 static files');
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync('.tmp/synapse-run-progression-evidence.json', JSON.stringify({ scenarios, assertions, network }, null, 2));
  console.log(JSON.stringify({ scenarios: scenarios.length, assertions, network: { backend: 0, external: 0, unexpectedGame: 0 } }));
} finally {
  clearTimeout(watchdog);
  await browser?.close(); await server?.close();
}
