// [GAME-4] Synapse Run playable core in real Chromium, inside the real Arcade sandbox (allow-scripts only).
// The game bundle is built with test hooks (window.__synapseRunTest inside the game frame only): a manual clock and
// sanitized game state make every gameplay scenario deterministic; real-time scenarios only check monotonic facts.
// Known seeds are chosen in Node from the very same simulation module the bundle is built from.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { arcadeGameBundlePlugin } from './vite-arcade-game-bundle.mjs';
import { LANE_CHANGE_TICKS, SLIDE_TICKS, createSim } from '../src/arcade/synapse-run/simulation.ts';

const GAME = 'synapse-run';
let browser, server, origin, assertions = 0;
const scenarios = [];
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };
const ok = (value, label) => { assert.ok(value, label); assertions++; };
const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/arcade-save-harness.jsx");mount();</script>';
const network = { api: [], external: [], unexpectedGameRequests: [], gameAssets: 0 };
const watchdog = setTimeout(() => { console.error('Synapse Run browser deadline'); process.exit(1); }, 420_000);
const fromGame = request => { try { return request.frame().parentFrame() !== null; } catch { return false; } };

// ── seeds with a known first row (same module as the bundle) ─────────────────────────────────────────────
function firstRow(seed) {
  const s = createSim(seed);
  const z = Math.min(...s.obstacles.map(o => o.z));
  return { z, row: s.obstacles.filter(o => o.z === z), shardsBefore: s.shards.filter(x => x.z < z), obstacles: s.obstacles };
}
const findSeed = predicate => { for (let seed = 1; seed < 5000; seed++) if (predicate(firstRow(seed))) return seed; throw new Error('no seed'); };
const SEED_BLOCK = findSeed(r => r.row.length === 1 && r.row[0].type === 'BLOCK');
const SEED_GATE = findSeed(r => r.row.length === 1 && r.row[0].type === 'HIGH_GATE');
const SEED_SHARD = findSeed(r => r.shardsBefore.length >= 3);
const SEED_PLAIN = 20261021;

async function scenario(name, run, { init, viewport = { width: 1280, height: 900 }, deviceScaleFactor = 1, reducedMotion = 'no-preference', probesNetwork = false } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor, reducedMotion });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [], consoleErrors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  if (init) await context.addInitScript(init);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (fromGame(request)) {
      if (url.origin !== origin || !/^\/arcade\/synapse-run\/(index\.html|foundation\.(js|css)|game\.js)$/.test(url.pathname)) { network.unexpectedGameRequests.push(url.href); return route.abort('blockedbyclient'); }
      network.gameAssets++;
      return route.continue();
    }
    if (url.pathname === '/__synapse_test') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname.startsWith('/api/')) { network.api.push(url.pathname); return route.abort('blockedbyclient'); }
    if (url.origin !== origin) { network.external.push(url.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  await page.goto(`${origin}/__synapse_test`);
  await page.getByTestId('arcade-panel').waitFor();
  try {
    await run(page, { consoleErrors });
    eq(errors, [], `${name}: page errors`);
    // the only tolerated refusals are the deliberate connect-src probes of scenario 19
    ok(consoleErrors.every(text => !/Content Security Policy|Refused to/.test(text) || (probesNetwork && /connect-src|Refused to connect/.test(text))), `${name}: no CSP violation from the game`);
  } finally {
    await context.close();
  }
  scenarios.push(name);
  console.log(`PASS ${name}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────
const frameOf = page => page.frames().find(f => f.url().includes('/arcade/synapse-run/'));
const waitPhase = (page, value) => page.waitForFunction(v => document.querySelector('[data-testid="arcade-host"]')?.dataset.phase === v, value);
const snap = page => frameOf(page).evaluate(() => window.__synapseRunTest.snapshot());
const hook = (page, name, ...args) => frameOf(page).evaluate(([name, args]) => window.__synapseRunTest[name](...args), [name, args]);
const nextFrames = (page, n = 2) => frameOf(page).evaluate(n => new Promise(resolve => { let k = 0; const f = () => (++k >= n ? resolve() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
async function launch(page) {
  await page.getByTestId(`arcade-launch-${GAME}`).click();
  await waitPhase(page, 'active');
  await frameOf(page).waitForFunction(() => document.documentElement.dataset.gameState === 'READY' && window.__synapseRunTest?.snapshot().host === 'active');
}
/** Manual clock, explicit seed, started with the real Enter key inside the focused game frame. */
async function startManual(page, seed) {
  await launch(page);
  await hook(page, 'setManual', true);
  await hook(page, 'restart', seed);
  await frameOf(page).locator('#sr-action').focus();
  await page.keyboard.press('Enter');
  await hook(page, 'advance', 1);
  const s = await snap(page);
  eq([s.status, s.seed, s.tick], ['RUNNING', seed, 1]);
  return s;
}
async function press(page, key, ticks = 1) { await page.keyboard.press(key); await hook(page, 'advance', ticks); return snap(page); }
async function toLane(page, lane) {
  let s = await snap(page);
  while (s.lane !== lane) s = await press(page, lane < s.lane ? 'ArrowLeft' : 'ArrowRight', LANE_CHANGE_TICKS);
  return s;
}
/** advance until the player is `ahead` metres before z (0.2 m per tick) */
async function advanceTo(page, z, ahead) {
  const s = await snap(page);
  const target = Math.round((z - ahead) * 5);
  if (target > s.tick) await hook(page, 'advance', target - s.tick);
  return snap(page);
}

try {
  server = await createServer({ configFile: false, plugins: [react(), arcadeGameBundlePlugin({ testHooks: true })], cacheDir: '.tmp/vite-synapse-run-tests', optimizeDeps: { entries: ['scripts/arcade-save-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  await scenario('1 game reaches READY with a live WebGL renderer', async page => {
    await launch(page);
    const s = await snap(page);
    eq([s.status, s.host, s.renderer, s.canvas, s.overlay, s.loopActive], ['READY', 'active', 'active', 1, 'Prêt', true]);
    eq(await frameOf(page).locator('html').getAttribute('data-webgl'), 'ready');
    eq(await frameOf(page).locator('#sr-action').innerText(), 'Démarrer');
    eq(s.obstacles, createSim(s.seed).obstacles.map(({ id, type, lane, z }) => ({ id, type, lane, z })), 'browser course = Node simulation for the same seed');
    eq(await page.getByTestId(`arcade-game-${GAME}`).count(), 0); // list replaced by the host while running
  });

  await scenario('2/12 start runs in real time; distance and score increase', async page => {
    await launch(page);
    await hook(page, 'setAutopilot', 7); // keeps the run alive; the real loop drives it
    await frameOf(page).locator('#sr-action').focus();
    await page.keyboard.press('Enter');
    await frameOf(page).waitForFunction(() => window.__synapseRunTest.snapshot().status === 'RUNNING');
    const a = await snap(page);
    // [GAME-6] wait for real progress instead of a fixed 700 ms window (software rendering warms up for ~1 s)
    await frameOf(page).waitForFunction(t => window.__synapseRunTest.snapshot().tick > t + 10, a.tick);
    const b = await snap(page);
    ok(b.tick > a.tick + 10 && b.distance > a.distance && b.score >= a.score, JSON.stringify({ a: a.tick, b: b.tick }));
    eq(await frameOf(page).locator('#sr-distance').innerText(), `${Math.floor((await snap(page)).distance)} m`);
    eq(await frameOf(page).locator('#sr-overlay').isHidden(), true);
  });

  await scenario('3-5 left / right lane changes and lane bounds (also A / D keys)', async page => {
    await startManual(page, SEED_PLAIN);
    eq((await press(page, 'ArrowLeft', LANE_CHANGE_TICKS)).lane, 0);
    let s = await press(page, 'a', LANE_CHANGE_TICKS);
    eq([s.lane, s.laneProgress], [0, 0], 'left bound');
    eq((await press(page, 'ArrowRight', LANE_CHANGE_TICKS)).lane, 1);
    eq((await press(page, 'd', LANE_CHANGE_TICKS)).lane, 2);
    s = await press(page, 'ArrowRight', LANE_CHANGE_TICKS);
    eq([s.lane, s.laneProgress], [2, 0], 'right bound');
    eq(s.view.player.x, 2.2);
  });

  await scenario('6-7 jump and slide happen logically and visually; a held key cannot extend the slide', async page => {
    await startManual(page, SEED_PLAIN);
    let s = await press(page, 'ArrowUp', 10);
    await nextFrames(page);
    s = await snap(page);
    ok(s.mode === 'JUMP' && s.y > 1 && s.view.player.y === s.y, JSON.stringify({ mode: s.mode, y: s.y, view: s.view.player }));
    s = await press(page, 'Space', 1);
    ok(s.y < 1.6, 'no double jump from Space in mid-air');
    await hook(page, 'advance', 40);
    s = await snap(page);
    eq([s.mode, s.y], ['RUN', 0]);
    await page.keyboard.down('ArrowDown');
    await page.keyboard.down('ArrowDown'); // auto-repeat
    await page.keyboard.down('ArrowDown');
    await hook(page, 'advance', 1);
    await nextFrames(page);
    s = await snap(page);
    ok(s.mode === 'SLIDE' && s.view.player.scaleY < 0.5, JSON.stringify(s.view.player));
    await hook(page, 'advance', SLIDE_TICKS);
    await page.keyboard.up('ArrowDown');
    await nextFrames(page);
    s = await snap(page);
    eq(s.mode, 'RUN');
    ok(s.view.player.scaleY >= 0.86 && s.view.player.scaleY <= 1, 'GAME-7 presentation-only landing compression');
  });

  await scenario('8 a known seeded obstacle ends the run (GAME_OVER with stats and Rejouer)', async page => {
    const { z, row } = firstRow(SEED_BLOCK);
    await startManual(page, SEED_BLOCK);
    await toLane(page, row[0].lane);
    await advanceTo(page, z, -2);
    const s = await snap(page);
    eq([s.status, s.crash], ['GAME_OVER', { obstacleId: row[0].id, type: 'BLOCK' }]);
    await nextFrames(page);
    eq((await snap(page)).overlay, 'Fin de course');
    ok((await frameOf(page).locator('#sr-overlay-text').innerText()).startsWith(`Distance ${Math.floor(s.distance)} m`));
    eq(await frameOf(page).locator('#sr-action').innerText(), 'Rejouer');
    await hook(page, 'advance', 120);
    eq((await snap(page)).tick, s.tick, 'GAME_OVER freezes the run');
  });

  await scenario('9 a timed jump clears the known BLOCK', async page => {
    const { z, row } = firstRow(SEED_BLOCK);
    await startManual(page, SEED_BLOCK);
    await toLane(page, row[0].lane);
    await advanceTo(page, z, 4);
    await press(page, 'ArrowUp', 1);
    await hook(page, 'advance', 60);
    const s = await snap(page);
    ok(s.status === 'RUNNING' && s.distance > z + 2, JSON.stringify({ status: s.status, d: s.distance, z }));
  });

  await scenario('10 a timed slide clears the known HIGH_GATE (and a jump does not)', async page => {
    const { z, row } = firstRow(SEED_GATE);
    await startManual(page, SEED_GATE);
    await toLane(page, row[0].lane);
    await advanceTo(page, z, 4);
    await press(page, 'ArrowDown', 1);
    await hook(page, 'advance', 60);
    let s = await snap(page);
    ok(s.status === 'RUNNING' && s.distance > z + 2, JSON.stringify({ status: s.status, d: s.distance }));
    await hook(page, 'restart', SEED_GATE);
    await page.keyboard.press('Enter'); await hook(page, 'advance', 1);
    await toLane(page, row[0].lane);
    await advanceTo(page, z, 4);
    await press(page, 'ArrowUp', 60);
    s = await snap(page);
    eq([s.status, s.crash?.type], ['GAME_OVER', 'HIGH_GATE']);
  });

  await scenario('11 known shards are collected once and counted in the HUD', async page => {
    const { shardsBefore } = firstRow(SEED_SHARD);
    await startManual(page, SEED_SHARD);
    await toLane(page, shardsBefore[0].lane);
    const last = shardsBefore.filter(x => x.lane === shardsBefore[0].lane).at(-1);
    await advanceTo(page, last.z, -1);
    await nextFrames(page);
    const s = await snap(page);
    // straight down the shard lane: every shard of that lane is collected exactly once (pruned ones included)
    const inLane = shardsBefore.filter(x => x.lane === shardsBefore[0].lane).length;
    eq(s.shardsCollected, inLane);
    ok(s.shards.filter(x => x.lane === shardsBefore[0].lane && x.z <= s.distance - 1).every(x => x.collected));
    eq(await frameOf(page).locator('#sr-shards').innerText(), `${s.shardsCollected} éclat${s.shardsCollected > 1 ? 's' : ''}`);
    eq(s.score, Math.floor(s.distance) + 10 * s.shardsCollected);
  });

  await scenario('13-14 pause freezes the run, resume continues without catching up paused time', async page => {
    await launch(page);
    await hook(page, 'setAutopilot', 11);
    await frameOf(page).locator('#sr-action').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.getByTestId('arcade-pause-toggle').click();
    await waitPhase(page, 'paused');
    const a = await snap(page);
    await page.waitForTimeout(800);
    const b = await snap(page);
    eq([b.tick, b.pause, b.loopActive, b.overlay], [a.tick, ['HOST'], false, 'En pause']); // [GAME-5] host pause = HOST reason
    await page.getByTestId('arcade-pause-toggle').click();
    await waitPhase(page, 'active');
    const c = await snap(page);
    const resumedAt = Date.now();
    // [GAME-6] wait for progress, then bound it by the real time elapsed (no catch-up of the paused 800 ms)
    await frameOf(page).waitForFunction(t => window.__synapseRunTest.snapshot().tick > t + 3, c.tick);
    const d = await snap(page);
    const elapsed = Date.now() - resumedAt;
    ok(c.tick - b.tick <= 6, `no jump on resume (${c.tick - b.tick})`);
    ok(d.tick > c.tick && d.tick - c.tick <= Math.ceil((elapsed * 60) / 1000) + 6, `continues at real speed (${d.tick - c.tick} ticks in ${elapsed} ms)`);
    eq(d.status, 'RUNNING');
  });

  await scenario('15 restart from GAME_OVER (Enter) starts a new active run with a fresh seed', async page => {
    const { z, row } = firstRow(SEED_BLOCK);
    await startManual(page, SEED_BLOCK);
    await toLane(page, row[0].lane);
    await advanceTo(page, z, -2);
    eq((await snap(page)).status, 'GAME_OVER');
    await nextFrames(page);
    eq(await frameOf(page).evaluate(() => document.activeElement?.id), 'sr-action', 'focus on Rejouer');
    await page.keyboard.press('Enter');
    await hook(page, 'advance', 1);
    const s = await snap(page);
    ok(s.status === 'RUNNING' && s.tick === 1 && s.crash === null && s.shardsCollected === 0 && s.lane === 1 && s.seed !== SEED_BLOCK, JSON.stringify({ status: s.status, tick: s.tick, seed: s.seed }));
    eq(s.obstacles.every(o => o.z >= 36), true);
    // same-seed restart reproduces the opening course
    await hook(page, 'restart', SEED_BLOCK);
    eq((await snap(page)).obstacles, firstRow(SEED_BLOCK).obstacles.map(({ id, type, lane, z: oz }) => ({ id, type, lane, z: oz })));
  });

  await scenario('16 keyboard focus: keys reach the game only when it is focused; Tab enters and leaves the frame', async page => {
    await launch(page);
    await hook(page, 'setManual', true);
    await page.getByTestId('arcade-pause-toggle').focus();
    await page.keyboard.press('Enter'); // parent button, not the game
    await waitPhase(page, 'paused');
    await page.keyboard.press('Enter');
    await waitPhase(page, 'active');
    await hook(page, 'advance', 3);
    eq((await snap(page)).status, 'READY', 'parent keystrokes never reach the game');
    await page.locator('#arc-host-title').focus();
    let tabs = 0; // the shell's close button comes first in tab order, then the game frame
    while (tabs < 4 && !(await frameOf(page).evaluate(() => document.hasFocus()))) { await page.keyboard.press('Tab'); tabs++; }
    eq(await frameOf(page).evaluate(() => document.activeElement?.id), 'sr-action', 'Tab lands on the game control');
    ok(tabs <= 2, `reached in ${tabs} Tab presses`);
    await page.keyboard.press('Enter');
    await hook(page, 'advance', 1);
    eq((await snap(page)).status, 'RUNNING');
    await page.keyboard.press('ArrowLeft');
    await hook(page, 'advance', LANE_CHANGE_TICKS);
    eq((await snap(page)).lane, 0);
    // [GAME-5] Tab first visits the on-screen controls (5 buttons) [GAME-6] and the mute toggle, then leaves the frame
    let out = 0;
    while (out < 9 && !(await page.getByTestId('arcade-pause-toggle').evaluate(el => el === document.activeElement))) { await page.keyboard.press('Tab'); out++; }
    eq(await page.getByTestId('arcade-pause-toggle').evaluate(el => el === document.activeElement), true, 'Tab leaves the frame');
    ok(out <= 8, `left the frame after ${out} Tab presses (GAME-7 fullscreen control included)`);
    await page.keyboard.press('ArrowRight');
    await hook(page, 'advance', LANE_CHANGE_TICKS);
    eq((await snap(page)).lane, 0);
  });

  const scripted = async page => {
    await startManual(page, SEED_BLOCK);
    const { z, row } = firstRow(SEED_BLOCK);
    await toLane(page, row[0].lane);
    await advanceTo(page, z, 4);
    await press(page, 'ArrowUp', 80);
    await press(page, 'ArrowDown', 50);
    const s = await snap(page);
    return { seed: s.seed, tick: s.tick, status: s.status, lane: s.lane, y: s.y, mode: s.mode, distance: s.distance, score: s.score, obstacles: s.obstacles, shards: s.shards };
  };
  let normalRun = null;
  await scenario('17a reference run (reduced motion off)', async page => {
    normalRun = await scripted(page);
    eq(await frameOf(page).locator('html').getAttribute('data-reduced-motion'), 'false');
  });
  await scenario('17 reduced motion: identical gameplay, decorative motion off', async page => {
    const reduced = await scripted(page);
    eq(await frameOf(page).locator('html').getAttribute('data-reduced-motion'), 'true');
    eq(reduced, normalRun, 'same seed + same inputs ⇒ same state with reduced motion');
  }, { reducedMotion: 'reduce' });

  await scenario('18 ARCADE_STOP stops the loop, removes listeners and disposes the renderer; host teardown removes the frame', async page => {
    await launch(page);
    await hook(page, 'setAutopilot', 3);
    await frameOf(page).locator('#sr-action').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    eq((await snap(page)).listeners, 11); // [GAME-5] keyboard, 2 overlay buttons, 2 control-bar, 4 pointer, visibility; [GAME-6] mute
    // the host's own STOP command, delivered while the frame still exists
    await page.evaluate(() => {
      const frame = document.querySelector('[data-testid="arcade-frame"]');
      const instanceId = frame.getAttribute('src').split('#instance=')[1];
      frame.contentWindow.postMessage({ channel: 'docteur-arcade', v: 1, type: 'ARCADE_STOP', gameId: 'synapse-run', instanceId, payload: {} }, '*');
    });
    await frameOf(page).waitForFunction(() => window.__synapseRunTest.snapshot().host === 'stopped');
    const a = await snap(page);
    eq([a.loopActive, a.renderer, a.canvas, a.listeners, a.status], [false, 'none', 0, 0, 'STOPPED']);
    eq(await frameOf(page).locator('html').getAttribute('data-webgl'), 'disposed');
    await page.waitForTimeout(300);
    const b = await snap(page);
    eq([b.frames, b.tick], [a.frames, a.tick], 'no frame or tick after STOP');
    await waitPhase(page, 'stopped');
    await page.getByTestId('arcade-stop').click();
    eq(await page.getByTestId('arcade-frame').count(), 0);
  });

  await scenario('19 sandbox isolation intact with the game running', async page => {
    await launch(page);
    eq(await page.getByTestId('arcade-frame').getAttribute('sandbox'), 'allow-scripts');
    eq(await frameOf(page).evaluate(() => self.origin), 'null');
    const result = await frameOf(page).evaluate(async () => {
      const read = fn => { try { return fn(); } catch (e) { return e.name; } };
      const out = [read(() => parent.document.body.innerHTML), read(() => parent.localStorage.length), read(() => localStorage.length), read(() => indexedDB.open('docteur-arcade')), read(() => document.cookie)];
      for (const url of ['http://127.0.0.1:3001/api/health', 'https://synapse-probe.invalid/x']) { try { await fetch(url); out.push('SUCCESS'); } catch { out.push('BLOCKED'); } }
      return out;
    });
    eq(result, ['SecurityError', 'SecurityError', 'SecurityError', 'SecurityError', 'SecurityError', 'BLOCKED', 'BLOCKED']);
    eq(await page.evaluate(() => typeof window.__synapseRunTest), 'undefined', 'test hooks live only inside the game frame');
  }, { probesNetwork: true });

  await scenario('35 360 px with DPR 3: canvas fills the frame, buffer capped at DPR 2, no overflow', async page => {
    await launch(page);
    const s = await snap(page);
    const frameBox = await page.getByTestId('arcade-frame').boundingBox();
    const canvas = await frameOf(page).evaluate(() => { const c = document.querySelector('canvas'); return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, sw: document.documentElement.scrollWidth, iw: innerWidth }; });
    // [GAME-6] DPR 3 is capped at 2 on hardware and at 1 on a software renderer (these tests run on SwiftShader)
    eq(s.view.software, /swiftshader/i.test(s.view.renderer), 'software renderer detected from the WebGL renderer string');
    const cap = s.view.software ? 1 : 2;
    eq(s.view.pixelRatio, cap);
    eq([canvas.w, canvas.h], [canvas.cw * cap, canvas.ch * cap]);
    ok(canvas.cw <= Math.ceil(frameBox.width) && canvas.sw <= canvas.iw);
    eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const overlay = await frameOf(page).locator('#sr-overlay').boundingBox();
    // boundingBox() is in page coordinates: compare with the frame's own box
    ok(overlay.x >= frameBox.x - 1 && overlay.x + overlay.width <= frameBox.x + frameBox.width + 1, `overlay fits ${JSON.stringify({ overlay, frameBox })}`);
  }, { viewport: { width: 360, height: 800 }, deviceScaleFactor: 3 });

  await scenario('35b desktop: canvas buffer follows the frame size', async page => {
    await launch(page);
    const c = await frameOf(page).evaluate(() => { const el = document.querySelector('canvas'); return [el.width, el.height, el.clientWidth, el.clientHeight]; });
    eq([c[0], c[1]], [c[2], c[3]]);
    ok(c[2] > 600 && c[3] >= 240);
  });

  await scenario('36 WebGL failure: fixed fallback, host keeps running, no retry loop', async page => {
    await page.getByTestId(`arcade-launch-${GAME}`).click();
    await waitPhase(page, 'active');
    await frameOf(page).waitForFunction(() => document.documentElement.dataset.webgl === 'unavailable');
    const calls = await frameOf(page).evaluate(() => window.__glCalls);
    await page.waitForTimeout(800);
    eq(await frameOf(page).evaluate(() => window.__glCalls), calls, 'no retry');
    eq(await frameOf(page).locator('#sr-overlay-title').innerText(), 'Affichage 3D indisponible');
    eq(await page.getByTestId('arcade-host').getAttribute('data-phase'), 'active', 'host not closed by an error');
    const s = await snap(page);
    eq([s.renderer, s.loopActive, s.canvas], ['none', false, 0]);
  }, { init: () => { if (window === window.top) return; window.__glCalls = 0; HTMLCanvasElement.prototype.getContext = function () { window.__glCalls += 1; return null; }; } });

  eq(network.api, [], 'backend requests');
  eq(network.external, [], 'external requests');
  eq(network.unexpectedGameRequests, [], 'game requests beyond its 4 static files');
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync('.tmp/synapse-run-browser-evidence.json', JSON.stringify({ scenarios, assertions, network, seeds: { SEED_BLOCK, SEED_GATE, SEED_SHARD, SEED_PLAIN } }, null, 2));
  console.log(JSON.stringify({ scenarios: scenarios.length, assertions, seeds: { SEED_BLOCK, SEED_GATE, SEED_SHARD }, network: { gameStaticAssets: network.gameAssets, backend: 0, external: 0, unexpectedGame: 0 } }));
} finally {
  clearTimeout(watchdog);
  await browser?.close(); await server?.close();
}
