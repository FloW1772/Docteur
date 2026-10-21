// [GAME-6] Synapse Run polish in real Chromium, inside the real Arcade sandbox: synthesised audio (gesture unlock,
// mute, effects, failures, node cleanup, STOP), rendering semantics (silhouettes, lane highlight, crash tint, shard
// pop, reduced motion, low-effects path, context loss), accessibility (keyboard/focus path, names, announcements,
// 360 px) and a repeated-cycle memory check. No speaker output is needed: the engine reports what it played.
// One scenario uses a real GPU browser when available (DPR cap 2 on hardware); it is reported NOT_RUN otherwise.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { arcadeGameBundlePlugin } from './vite-arcade-game-bundle.mjs';
import { LANE_CHANGE_TICKS, createSim } from '../src/arcade/synapse-run/simulation.ts';

const GAME = 'synapse-run';
let browser, gpuBrowser, server, origin, assertions = 0;
const scenarios = [], notRun = [];
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };
const ok = (value, label) => { assert.ok(value, label); assertions++; };
const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/arcade-save-harness.jsx");mount();</script>';
const network = { api: [], external: [], unexpectedGameRequests: [] };
const watchdog = setTimeout(() => { console.error('Synapse Run polish browser deadline'); process.exit(1); }, 720_000);
const fromGame = request => { try { return request.frame().parentFrame() !== null; } catch { return false; } };

// counts AudioContext construction / close inside the game frame only (wrapping, not replacing, the real one)
const audioSpy = () => {
  if (window === window.top || typeof AudioContext !== 'function') return;
  const Real = AudioContext;
  window.__audioSpy = { created: 0, closed: 0 };
  window.AudioContext = class extends Real {
    constructor(...a) { super(...a); window.__audioSpy.created++; }
    close() { window.__audioSpy.closed++; return super.close(); }
  };
};

async function scenario(name, run, { context: contextOptions = {}, init = audioSpy, useBrowser } = {}) {
  const context = await (useBrowser ?? browser).newContext({ viewport: { width: 1280, height: 900 }, ...contextOptions });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [], consoleLines = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => consoleLines.push(`${message.type()}: ${message.text()}`));
  if (init) await context.addInitScript(init);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (fromGame(request)) {
      if (url.origin !== origin || !/^\/arcade\/synapse-run\/(index\.html|foundation\.(js|css)|game\.js)$/.test(url.pathname)) { network.unexpectedGameRequests.push(url.href); return route.abort('blockedbyclient'); }
      return route.continue();
    }
    if (url.pathname === '/__polish_test') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname.startsWith('/api/')) { network.api.push(url.pathname); return route.abort('blockedbyclient'); }
    if (url.origin !== origin) { network.external.push(url.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  await page.goto(`${origin}/__polish_test`);
  await page.getByTestId('arcade-panel').waitFor();
  try {
    await run(page, { context, consoleLines });
    eq(errors, [], `${name}: page errors`);
    ok(consoleLines.every(line => !/AudioContext was not allowed|autoplay/i.test(line)), `${name}: no autoplay warning`);
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
const spy = page => frameOf(page).evaluate(() => window.__audioSpy ?? null);
const nextFrames = (page, n = 2) => frameOf(page).evaluate(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
async function launch(page) {
  await page.getByTestId(`arcade-launch-${GAME}`).click();
  await waitPhase(page, 'active');
  await frameOf(page).waitForFunction(() => document.documentElement.dataset.gameState === 'READY' && window.__synapseRunTest?.snapshot().host === 'active');
}
/** manual clock; started with a real Enter key on the focused Démarrer button (a user gesture) */
async function startManual(page, seed) {
  await hook(page, 'setManual', true);
  await hook(page, 'restart', seed);
  await frameOf(page).locator('#sr-action').focus();
  await page.keyboard.press('Enter');
  await hook(page, 'advance', 1);
  eq((await snap(page)).status, 'RUNNING');
}
function firstRow(seed) {
  const s = createSim(seed);
  const z = Math.min(...s.obstacles.map(o => o.z));
  return { z, row: s.obstacles.filter(o => o.z === z), shardsBefore: s.shards.filter(x => x.z < z) };
}
const findSeed = predicate => { for (let seed = 1; seed < 5000; seed++) if (predicate(firstRow(seed))) return seed; throw new Error('no seed'); };
const SEED_BLOCK = findSeed(r => r.row.length === 1 && r.row[0].type === 'BLOCK');
const SEED_SHARD = findSeed(r => r.shardsBefore.length >= 3);
/** an opening course that contains both obstacle types (the silhouette check must not depend on a random seed) */
const SEED_BOTH = (() => { for (let seed = 1; seed < 5000; seed++) { const types = new Set(createSim(seed).obstacles.map(o => o.type)); if (types.size === 2) return seed; } throw new Error('no seed'); })();
async function toLane(page, lane) {
  let s = await snap(page);
  while (s.lane !== lane) { await page.keyboard.press(lane < s.lane ? 'ArrowLeft' : 'ArrowRight'); await hook(page, 'advance', LANE_CHANGE_TICKS); s = await snap(page); }
}
async function crashOnFirstBlock(page) {
  const { z, row } = firstRow(SEED_BLOCK);
  await startManual(page, SEED_BLOCK);
  await toLane(page, row[0].lane);
  const s = await snap(page);
  await hook(page, 'advance', Math.round((z + 2) * 5) - s.tick);
  eq((await snap(page)).status, 'GAME_OVER');
}

try {
  server = await createServer({ configFile: false, plugins: [react(), arcadeGameBundlePlugin({ testHooks: true })], cacheDir: '.tmp/vite-synapse-polish-tests', optimizeDeps: { entries: ['scripts/arcade-save-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  // ── audio ────────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('A1-2 silent until a gesture; the first key press inside the game unlocks audio', async page => {
    await launch(page);
    await page.waitForTimeout(500);
    let s = await snap(page);
    eq([s.audio.state, s.audio.unlockAttempts, (await spy(page)).created], ['locked', 0, 0], 'no AudioContext before a gesture');
    await startManual(page, SEED_BLOCK);
    await frameOf(page).waitForFunction(() => window.__synapseRunTest.snapshot().audio.state === 'running');
    s = await snap(page);
    eq([s.audio.state, (await spy(page)).created], ['running', 1]);
    await page.keyboard.press('ArrowUp');
    await hook(page, 'advance', 1);
    s = await snap(page);
    eq(s.audio.history.at(-1), 'jump');
  });

  await scenario('A3 mute / unmute: button state, text and label; muted effects are not played', async page => {
    await launch(page);
    await startManual(page, SEED_BLOCK);
    const mute = frameOf(page).locator('#sr-mute');
    eq([await mute.innerText(), await mute.getAttribute('aria-pressed'), await mute.getAttribute('aria-label')], ['Son activé', 'false', 'Couper le son']);
    await mute.focus();
    await page.keyboard.press('Enter');
    eq([await mute.innerText(), await mute.getAttribute('aria-pressed'), await mute.getAttribute('aria-label')], ['Son coupé', 'true', 'Rétablir le son']);
    let s = await snap(page);
    const played = s.audio.played;
    await page.keyboard.press('ArrowLeft'); await hook(page, 'advance', LANE_CHANGE_TICKS);
    await page.keyboard.press('ArrowUp'); await hook(page, 'advance', 2);
    s = await snap(page);
    eq([s.audio.muted, s.audio.played, s.lane, s.mode], [true, played, 0, 'JUMP'], 'gameplay unchanged, nothing played');
    eq(s.announced.at(-1), 'Son coupé.');
    await mute.click();
    await hook(page, 'advance', 60);
    const beforeUnmuted = (await snap(page)).audio.played;
    await page.keyboard.press('ArrowRight'); await hook(page, 'advance', 1);
    s = await snap(page);
    // other events (a shard) may sound on the same tick: the lane effect must be among the newly played ones
    eq([s.audio.muted, s.audio.history.slice(-(s.audio.played - beforeUnmuted)).includes('lane')], [false, true]);
  });

  await scenario('A4 effects follow simulation events: shard, crash, mission (with visual + text equivalents)', async page => {
    await launch(page);
    const { shardsBefore } = firstRow(SEED_SHARD);
    await startManual(page, SEED_SHARD);
    await toLane(page, shardsBefore[0].lane);
    await hook(page, 'advance', Math.round((shardsBefore[0].z + 1) * 5) - (await snap(page)).tick);
    let s = await snap(page);
    ok(s.shardsCollected >= 1 && s.audio.history.includes('shard'), 'shard sound');
    ok((await frameOf(page).locator('#sr-shards').innerText()).startsWith(`${s.shardsCollected} éclat`), 'shard counter is the visual equivalent');
    // a mission reached during a run: toast + announcement + sound
    await hook(page, 'setAutopilot', 99);
    // small steps so the check happens right when the toast appears (the effect history keeps the last 20 only)
    for (let i = 0; i < 200 && !(await snap(page)).toast; i++) await hook(page, 'advance', 30);
    s = await snap(page);
    ok(s.toast.startsWith('✓ Mission accomplie') && s.announced.some(a => a.startsWith('Mission accomplie')) && s.audio.history.includes('mission'), JSON.stringify({ toast: s.toast, announced: s.announced.slice(-4), history: s.audio.history, audio: s.audio.state, voices: s.audio.activeVoices }));
    await hook(page, 'setAutopilot', null);
    for (let i = 0; i < 10 && (await snap(page)).status !== 'GAME_OVER'; i++) await hook(page, 'advance', 600);
    s = await snap(page);
    eq(s.status, 'GAME_OVER');
    ok(s.audio.history.includes('crash') && s.announced.some(a => a.startsWith('Fin de course')) && s.overlay === 'Fin de course' && s.view.player.crashed, 'crash: sound + overlay + announcement + red construct');
  });

  await scenario('A5 no AudioContext at all: silent, fully playable, visual feedback intact', async page => {
    await launch(page);
    await startManual(page, SEED_BLOCK);
    await page.keyboard.press('ArrowUp'); await hook(page, 'advance', 5);
    const s = await snap(page);
    eq([s.audio.state, s.audio.played, s.mode, s.status], ['unavailable', 0, 'JUMP', 'RUNNING']);
    eq(await frameOf(page).locator('#sr-mute').isVisible(), true, 'the control stays usable');
  }, { init: () => { if (window !== window.top) { delete window.AudioContext; window.AudioContext = undefined; } } });

  await scenario('A6 resume() rejected: bounded attempts, no console spam, game playable', async (page, { consoleLines }) => {
    await launch(page);
    await startManual(page, SEED_BLOCK);
    for (let i = 0; i < 8; i++) { await page.keyboard.press('ArrowLeft'); await hook(page, 'advance', LANE_CHANGE_TICKS); await page.keyboard.press('ArrowRight'); await hook(page, 'advance', LANE_CHANGE_TICKS); }
    const s = await snap(page);
    eq([s.audio.state, s.audio.unlockAttempts <= 3, s.audio.played, s.status], ['blocked', true, 0, 'RUNNING']);
    ok(consoleLines.filter(l => /audio/i.test(l)).length === 0, 'no audio console output');
  }, { init: () => {
    if (window === window.top || typeof AudioContext !== 'function') return;
    const Real = AudioContext;
    window.AudioContext = class extends Real { get state() { return 'suspended'; } resume() { return Promise.reject(new DOMException('synthetic', 'NotAllowedError')); } };
  } });

  await scenario('A7-8 many effects leave no voices behind; ARCADE_STOP closes the audio graph and timers', async page => {
    await launch(page);
    await startManual(page, 3);
    // real time between presses (the manual clock compresses game time, not audio time)
    for (let i = 0; i < 20; i++) { await page.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight'); await hook(page, 'advance', LANE_CHANGE_TICKS); await page.waitForTimeout(120); }
    let s = await snap(page);
    ok(s.audio.played >= 20, `played ${s.audio.played}`);
    await frameOf(page).waitForFunction(() => window.__synapseRunTest.snapshot().audio.activeVoices === 0, null, { timeout: 5000 });
    await page.evaluate(() => {
      const frame = document.querySelector('[data-testid="arcade-frame"]');
      frame.contentWindow.postMessage({ channel: 'docteur-arcade', v: 1, type: 'ARCADE_STOP', gameId: 'synapse-run', instanceId: frame.getAttribute('src').split('#instance=')[1], payload: {} }, '*');
    });
    await frameOf(page).waitForFunction(() => window.__synapseRunTest.snapshot().host === 'stopped');
    s = await snap(page);
    eq([s.audio.state, s.audio.activeVoices, s.loopActive, s.toastTimer, s.listeners, s.canvas], ['closed', 0, false, false, 0, 0]);
    eq((await spy(page)).closed, 1, 'AudioContext closed');
  });

  // ── rendering ────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('R1-3 silhouettes differ by shape; current lane lit; instanced decor; crash tint', async page => {
    await launch(page);
    await hook(page, 'restart', SEED_BOTH);
    await nextFrames(page, 3);
    let s = await snap(page);
    const blocks = s.view.silhouettes.filter(x => x.type === 'BLOCK'), gates = s.view.silhouettes.filter(x => x.type === 'HIGH_GATE');
    ok(blocks.length > 0 && gates.length > 0, 'both types on the opening course');
    ok(blocks.every(b => b.openBelow === 0 && b.top <= 1.1 && b.parts === 2), `BLOCK: solid from the ground, low (${JSON.stringify(blocks[0])})`);
    ok(gates.every(g => g.openBelow >= 1 && g.top >= 2.5 && g.parts === 4), `HIGH_GATE: open below the bar, tall (${JSON.stringify(gates[0])})`);
    ok(s.view.calls <= 60, `draw calls ${s.view.calls} (decor instanced)`);
    eq(s.view.activeLane, 1);
    await startManual(page, SEED_BLOCK);
    await page.keyboard.press('ArrowLeft'); await hook(page, 'advance', 2); await nextFrames(page);
    eq((await snap(page)).view.activeLane, 0, 'the target lane lights up as soon as the change starts');
    eq((await snap(page)).view.player.crashed, false);
  });

  await scenario('R4-5 shard pop is decorative and off under reduced motion; HUD cue off too', async page => {
    await launch(page);
    const { shardsBefore } = firstRow(SEED_SHARD);
    await startManual(page, SEED_SHARD);
    await toLane(page, shardsBefore[0].lane);
    await hook(page, 'advance', Math.round((shardsBefore[0].z + 0.2) * 5) - (await snap(page)).tick);
    await nextFrames(page, 1);
    const s = await snap(page);
    ok(s.shardsCollected >= 1, 'collected');
    eq(s.view.poppingShards, 0, 'no pop under reduced motion');
    eq(await frameOf(page).locator('#sr-shards').evaluate(el => getComputedStyle(el).animationName), 'none');
    eq(await frameOf(page).locator('html').getAttribute('data-reduced-motion'), 'true');
  }, { context: { reducedMotion: 'reduce' } });

  await scenario('R4b shard pop plays with normal motion', async page => {
    await launch(page);
    const { shardsBefore } = firstRow(SEED_SHARD);
    await startManual(page, SEED_SHARD);
    await toLane(page, shardsBefore[0].lane);
    await hook(page, 'advance', Math.round((shardsBefore[0].z + 0.2) * 5) - (await snap(page)).tick);
    await nextFrames(page, 1);
    const s = await snap(page);
    ok(s.shardsCollected >= 1 && s.view.poppingShards >= 1, JSON.stringify({ got: s.shardsCollected, popping: s.view.poppingShards }));
  });

  await scenario('R6 software renderer detected once → low-effects layout, buffer at DPR 1', async page => {
    await launch(page);
    const s = await snap(page);
    eq([s.view.software, s.effects, s.view.pixelRatio], [true, 'low', 1]);
    eq(await frameOf(page).locator('.sr-hud').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
    eq(await page.locator('.studio-shell').evaluate(el => getComputedStyle(el).backdropFilter), 'none', 'shell blur off while the game runs');
    await page.getByTestId('arcade-stop').click();
    await page.getByTestId(`arcade-launch-${GAME}`).waitFor();
    ok((await page.locator('.studio-shell').evaluate(el => getComputedStyle(el).backdropFilter)).includes('blur'), 'glass look back once the game is closed');
  }, { context: { deviceScaleFactor: 2 } });

  await scenario('R7 WebGL context loss: frozen, clear message, no recreation loop, host intact', async page => {
    await launch(page);
    await startManual(page, SEED_BLOCK);
    await frameOf(page).evaluate(() => document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await frameOf(page).waitForFunction(() => document.documentElement.dataset.webgl === 'lost');
    const a = await snap(page);
    await page.waitForTimeout(800);
    const b = await snap(page);
    eq([a.overlay, a.loopActive, a.canvas, b.tick, b.frames], ['Affichage 3D interrompu', false, 1, a.tick, a.frames]);
    ok(b.announced.some(x => x.startsWith('Affichage 3D interrompu')));
    eq(await page.getByTestId('arcade-host').getAttribute('data-phase'), 'active', 'host not closed');
    await page.keyboard.press('ArrowLeft');
    await hook(page, 'advance', 10);
    eq((await snap(page)).tick, a.tick + 10, 'only the test clock moves it; real input changes nothing visible');
    await page.getByTestId('arcade-stop').click();
    eq(await page.getByTestId('arcade-frame').count(), 0);
  });

  // ── accessibility ────────────────────────────────────────────────────────────────────────────────────────
  await scenario('X1 keyboard-only path with sensible focus at each step', async page => {
    await launch(page);
    await hook(page, 'setManual', true);
    await hook(page, 'restart', SEED_BLOCK);
    await page.locator('#arc-host-title').focus();
    let tabs = 0;
    while (tabs < 4 && !(await frameOf(page).evaluate(() => document.hasFocus()))) { await page.keyboard.press('Tab'); tabs++; }
    eq((await snap(page)).focus, 'sr-action', 'Tab reaches Démarrer first');
    eq(await frameOf(page).locator('#sr-action').evaluate(el => getComputedStyle(el).outlineStyle), 'solid', 'visible focus');
    await page.keyboard.press('Enter'); await hook(page, 'advance', 1);
    eq((await snap(page)).focus, 'sr-viewport', 'focus moves to the play area when the menu closes');
    await page.keyboard.press('Escape');
    eq((await snap(page)).focus, 'sr-action', 'pause menu: focus on Reprendre');
    eq(await frameOf(page).locator('#sr-action').innerText(), 'Reprendre');
    await page.keyboard.press('Enter');
    eq([(await snap(page)).focus, (await snap(page)).pause], ['sr-viewport', []], 'resume: back to the play area');
    const { z, row } = firstRow(SEED_BLOCK);
    await toLane(page, row[0].lane);
    await hook(page, 'advance', Math.round((z + 2) * 5) - (await snap(page)).tick);
    eq([(await snap(page)).status, (await snap(page)).focus, await frameOf(page).locator('#sr-action').innerText()], ['GAME_OVER', 'sr-action', 'Rejouer'], 'game over: Rejouer focused');
  });

  await scenario('X2-3 accessible names; announcements only on meaningful changes', async page => {
    await launch(page);
    const viewport = frameOf(page).locator('#sr-viewport');
    eq(await viewport.getAttribute('role'), 'img');
    ok((await viewport.getAttribute('aria-label')).includes('trois couloirs'));
    eq(await frameOf(page).locator('canvas').getAttribute('aria-hidden'), 'true');
    eq(await frameOf(page).locator('#sr-announce').getAttribute('aria-live'), 'polite');
    eq(await frameOf(page).locator('#sr-overlay').getAttribute('aria-live'), null, 'no second live region');
    eq(await frameOf(page).locator('.sr-hud [aria-live], .sr-stats[aria-live]').count(), 0, 'HUD numbers are not announced');
    await startManual(page, 3);
    const names = await frameOf(page).locator('#sr-controls button, #sr-mute').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    eq(names, ['Couloir de gauche', 'Glissade', 'Pause', 'Saut', 'Couloir de droite', 'Couper le son']);
    await hook(page, 'setAutopilot', 4);
    const before = (await snap(page)).announced.length;
    await hook(page, 'advance', 600); // 10 s of play, distance and score change every tick
    const during = (await snap(page)).announced;
    ok(during.length - before <= 1, `no per-tick announcements (${during.length - before} new)`);
    await page.keyboard.press('Escape');
    eq((await snap(page)).announced.at(-1), 'Jeu en pause.');
    await page.keyboard.press('Escape');
    eq((await snap(page)).announced.at(-1), 'Reprise.');
    eq((await snap(page)).announced[0], 'Course lancée.');
  });

  await scenario('X4-5 360 px: no overlap or overflow, ≥ 44 px targets, no colour-only state', async page => {
    await launch(page);
    await startManual(page, 3);
    const box = sel => frameOf(page).locator(sel).boundingBox();
    const mute = await box('#sr-mute'), stats = await box('.sr-stats'), bar = await box('#sr-controls');
    ok(mute.width >= 44 && mute.height >= 44, `mute ${JSON.stringify(mute)}`);
    const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    ok(!overlap(mute, stats) && !overlap(mute, bar), 'mute overlaps neither the score nor the controls');
    eq(await frameOf(page).evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // states carried by text or ARIA, never colour alone
    await frameOf(page).locator('#sr-mute').tap();
    eq([await frameOf(page).locator('#sr-mute').innerText(), await frameOf(page).locator('#sr-mute').getAttribute('aria-pressed')], ['Son coupé', 'true']);
    await frameOf(page).getByRole('button', { name: 'Pause', exact: true }).tap();
    eq(await frameOf(page).locator('#sr-pause').getAttribute('aria-pressed'), 'true');
    const missions = await frameOf(page).locator('#sr-missions li').allInnerTexts();
    ok(missions.length === 3 && missions.every(t => /\d+ \/ \d+/.test(t)), 'missions show progress as text');
    const fontPx = await frameOf(page).locator('.sr-missions li, .sr-progress-save, .sr-overlay-text').evaluateAll(els => Math.min(...els.map(e => parseFloat(getComputedStyle(e).fontSize))));
    ok(fontPx >= 11.5, `smallest overlay text ${fontPx}px`);
  }, { context: { viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true } });

  // ── memory ───────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('M1 repeated restart / pause / game over / mission cycles do not leak', async (page, { context }) => {
    await launch(page);
    const cdp = await context.newCDPSession(page);
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
    await startManual(page, 11);
    await hook(page, 'setAutopilot', 5);
    await hook(page, 'advance', 600);
    const cycle = async i => {
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await hook(page, 'setAutopilot', null);
      for (let k = 0; k < 10 && (await snap(page)).status !== 'GAME_OVER'; k++) await hook(page, 'advance', 600);
      await nextFrames(page, 1);
      await page.keyboard.press('Enter'); // Rejouer
      await hook(page, 'setAutopilot', 100 + i);
      await hook(page, 'advance', 600);
      await nextFrames(page, 1);
    };
    await cycle(0);
    const base = { heap: await heap(), s: await snap(page) };
    for (let i = 1; i <= 15; i++) await cycle(i);
    const end = { heap: await heap(), s: await snap(page) };
    eq([end.s.view.geometries, end.s.view.programs], [base.s.view.geometries, base.s.view.programs], 'no geometry / shader program growth');
    ok(end.s.view.meshes <= 60, `entity meshes bounded (${end.s.view.meshes})`);
    eq([end.s.listeners, end.s.runId - base.s.runId], [base.s.listeners, 15]);
    await frameOf(page).waitForFunction(() => window.__synapseRunTest.snapshot().audio.activeVoices === 0, null, { timeout: 5000 });
    const growthMB = (end.heap - base.heap) / 1048576;
    ok(growthMB < 3, `heap growth after GC ${growthMB.toFixed(2)} MB over 15 cycles`);
    console.log(`# memory: heap ${(base.heap / 1048576).toFixed(1)} → ${(end.heap / 1048576).toFixed(1)} MB; geometries ${end.s.view.geometries}, programs ${end.s.view.programs}, meshes ${end.s.view.meshes}, profile runs ${end.s.profile.totalRuns}`);
  });

  // ── hardware path (only when a GPU is available) ─────────────────────────────────────────────────────────
  try { gpuBrowser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] }); } catch { gpuBrowser = null; }
  let gpuChecked = false;
  if (gpuBrowser) {
    await scenario('R8 hardware renderer: full effects, DPR 3 capped at 2', async page => {
      await launch(page);
      const s = await snap(page);
      if (s.view.software) { notRun.push('R8 (no hardware WebGL in this environment)'); return; }
      gpuChecked = true;
      eq([s.effects, s.view.pixelRatio], ['full', 2]);
      ok((await frameOf(page).locator('.sr-hud').evaluate(el => getComputedStyle(el).backgroundImage)).includes('gradient'), 'full layout keeps its gradients');
    }, { useBrowser: gpuBrowser, context: { deviceScaleFactor: 3 } });
  } else notRun.push('R8 (GPU browser could not start)');

  eq(network.api, [], 'backend requests');
  eq(network.external, [], 'external requests');
  eq(network.unexpectedGameRequests, [], 'game requests beyond its 4 static files');
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync('.tmp/synapse-run-polish-evidence.json', JSON.stringify({ scenarios, assertions, notRun, gpuChecked, network }, null, 2));
  console.log(JSON.stringify({ scenarios: scenarios.length, assertions, gpuChecked, notRun, network: { backend: 0, external: 0, unexpectedGame: 0 } }));
} finally {
  clearTimeout(watchdog);
  await browser?.close(); await gpuBrowser?.close(); await server?.close();
}
