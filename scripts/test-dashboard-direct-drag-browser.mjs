// Customizable Dashboard V1.1 — direct drag of the cards AROUND THE CORTEX (not only in the panel). Real Chromium, the
// isolated historical harness (scripts/dashboard-harness.jsx: the real Dashboard + an "opened-log" of every Open click),
// network mocked. Usage: node scripts/test-dashboard-direct-drag-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { defaultDashboardLayout, moveCard, resolveDashboardLayout, visibleCards } from '../src/lib/dashboard/dashboard-layout.ts';

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); assertions += 1; };
const KEY = 'docteur.dashboardLayout';
const HISTORICAL = visibleCards(defaultDashboardLayout());
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/dashboard-harness.jsx");mount();</script>';

const server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { entries: ['scripts/dashboard-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 5240, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const origin = 'http://127.0.0.1:5240';
const browser = await chromium.launch({ headless: true });
const errors = [];

async function newPage(context) {
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const ok = (body) => (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/metagpt/missions**', ok({ ok: true, missions: [] }));
  await page.route('**/api/investment/portfolios', ok({ ok: true, portfolios: [] }));
  await page.route('**/api/openmontage/status', ok({ status: 'READY_LOCAL' }));
  await page.route('**/api/connectors', ok({ connectors: [] }));
  await page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/__dashboard_test', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${origin}/__dashboard_test`);
  await page.getByLabel('Module MetaGPT').waitFor({ timeout: 60_000 });
  await page.evaluate(k => {
    window.__dashWrites = 0;
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key === k) window.__dashWrites += 1; return orig.call(this, key, value); };
  }, KEY);
  return page;
}

let page;
const cards = () => page.locator('[data-testid="dashboard-card"]');
const order = () => cards().evaluateAll(els => els.map(e => e.dataset.cardId));
/** the order once React has committed the drop (polls up to 2 s; returns whatever is there at the end) */
const settledOrder = async (want) => {
  const t0 = Date.now();
  let now = await order();
  while (JSON.stringify(now) !== JSON.stringify(want) && Date.now() - t0 < 2_000) { await new Promise(r => setTimeout(r, 50)); now = await order(); }
  return now;
};
const panelOrder = () => page.locator('[data-testid="dashboard-card-item"]').evaluateAll(els => els.map(e => e.dataset.cardId));
const card = (id) => page.locator(`[data-testid="dashboard-card"][data-card-id="${id}"]`);
const writes = () => page.evaluate(() => window.__dashWrites);
const log = () => page.getByTestId('opened-log').innerText();
// measured once the corners' 0.32 s entrance animation (translateY 4px → 0) is over
const boxes = async () => {
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="dashboard-card"]')].every(e => e.getAnimations().every(a => a.playState !== 'running')));
  return cards().evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [e.dataset.cardId, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
};
const stored = () => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY);
const center = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const edit = async () => { await page.getByTestId('dashboard-customize').click(); await page.getByTestId('dashboard-customizer').waitFor(); };
const doneEdit = async () => { await page.getByTestId('dashboard-customize-done').click(); await page.getByTestId('dashboard-customizer').waitFor({ state: 'detached' }); };

/** real mouse drag from a card to a point; checks the drop target while hovering and that nothing is written before the drop */
async function dragTo(fromId, to, { expectTarget = null, release = true } = {}) {
  const a = await center(card(fromId));
  const b = 'x' in to ? to : await center(card(to.id));
  const before = await writes();
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + (b.x - a.x) * (i / 10), a.y + (b.y - a.y) * (i / 10), { steps: 2 });
  if (expectTarget) {
    eq(await card(expectTarget).getAttribute('data-drop-target'), 'true', `drop target shown on ${expectTarget}`);
    check(/Déposer ici \(position \d+\)/.test(await card(expectTarget).getByTestId('dashboard-card-grip').innerText()), 'target label');
    eq(await card(fromId).getAttribute('data-dragging'), 'true', 'dragged card marked');
    check((await page.getByTestId('dashboard-drag-ghost').innerText()).length > 2, 'a labelled ghost follows the pointer');
  }
  eq(await writes(), before, `nothing persisted while dragging ${fromId}`);
  if (release) {
    await page.mouse.up();
    check(await page.getByTestId('dashboard-drag-ghost').count() === 0 || await new Promise(r => setTimeout(r, 100)).then(() => page.getByTestId('dashboard-drag-ghost').count()).then(n => n === 0), 'ghost gone after release');
  }
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await newPage(ctx);

  // ═══ N — normal mode: no grip, no draggable, clicks open as before; geometry recorded ═══
  eq(await order(), HISTORICAL, 'default order');
  eq(await page.locator('[data-testid="dashboard-card-grip"], [data-testid="dashboard-card"][draggable]').count(), 0, 'no grip / draggable outside PERSONNALISER');
  const normalBoxes = await boxes();
  await card('metagpt').getByRole('button', { name: 'Ouvrir Studio' }).click();
  eq(await log(), 'metagpt', 'normal click opens as before');
  await page.getByRole('button', { name: 'Nouvelle mission MetaGPT' }).click();
  eq(await log(), 'quick-metagpt', 'baseline log for the "no Open during edit" checks');

  // ═══ E — edit mode: every visible card grabbable, geometry unchanged, the panel never covers a card ═══
  await edit();
  eq(await page.getByTestId('dashboard-card-grip').count(), HISTORICAL.length, 'one grip per visible card');
  eq(await cards().evaluateAll(els => els.every(e => e.dataset.editing === 'true' && getComputedStyle(e.querySelector('.hud2-card-edit-overlay')).touchAction === 'none')), true, 'cards movable (mouse, pen, touch)');
  eq(await boxes(), normalBoxes, 'edit mode does not move or resize any card');
  for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    // the claim: the customizer panel never sits on a card (cards scrolled out of the right column are reached by scrolling it)
    const covered = await cards().evaluateAll(els => els.filter(e => { const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return Boolean(hit?.closest('[data-testid="dashboard-customizer"]')); }).map(e => e.dataset.cardId));
    eq(covered, [], `${w}x${h}: no card under the customizer panel`);
    const corners = await page.locator('.hud2-corner').evaluateAll(els => els.every(e => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.hud2-corner') === e; }));
    eq(corners, true, `${w}x${h}: the four corner cards are directly grabbable`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ═══ D1 — first → last (corner → end of the rail) ═══
  let expected = defaultDashboardLayout();
  await dragTo('metagpt', { id: 'activity' }, { expectTarget: 'activity' });
  expected = moveCard(expected, 'metagpt', 'activity');
  eq(await settledOrder(visibleCards(expected)), visibleCards(expected), `first → last`);
  eq(await writes(), 1, 'exactly one write for the drop');
  eq(await card('sherlock').getAttribute('data-slot'), 'tl', 'the others moved up: sherlock now in the first corner');
  eq(await panelOrder(), await order(), 'panel shows the same order (one model)');

  // ═══ D2 — last → first ═══
  await dragTo('metagpt', { id: 'sherlock' }, { expectTarget: 'sherlock' });
  expected = moveCard(expected, 'metagpt', 'sherlock');
  eq(await settledOrder(visibleCards(expected)), visibleCards(expected), 'last → first');
  eq(await writes(), 2);

  // ═══ D3 — middle → middle, then several in a row (rail ↔ corner both ways) ═══
  for (const [from, to] of [['observateur', 'investment'], ['video-studio', 'maitre'], ['quick-actions', 'sherlock'], ['connectors', 'video-studio']]) {
    await dragTo(from, { id: to }, { expectTarget: to });
    expected = moveCard(expected, from, to);
    eq(await settledOrder(visibleCards(expected)), visibleCards(expected), `${from} → ${to}`);
  }
  eq(await writes(), 6, 'one write per drop, nothing else');
  const savedNow = await stored();
  eq(resolveDashboardLayout(savedNow).order, expected.order, 'persisted order = the model order (same key, same format as the panel)');

  // ═══ C — cancelled drag, drop outside any card, back onto itself, click without drag, drag from the Open button ═══
  const beforeCancel = await order();
  await dragTo('maitre', { id: 'metagpt' }, { expectTarget: 'metagpt', release: false });
  await page.keyboard.press('Escape');
  const empty = { x: 720, y: 450 }; // Cortex area: no card there
  await page.mouse.move(empty.x, empty.y, { steps: 4 });
  await page.mouse.up();
  eq(await order(), beforeCancel, 'cancelled drag: unchanged');
  eq(await page.locator('[data-drop-target="true"], [data-dragging="true"]').count(), 0, 'no stuck highlight');
  await dragTo('maitre', empty);
  eq(await order(), beforeCancel, 'drop outside the cards: unchanged');
  await dragTo('maitre', { id: 'maitre' });
  eq(await order(), beforeCancel, 'drop on itself: unchanged');
  eq(await writes(), 6, 'no write for cancelled / outside / self drops');
  await card('investment').click({ position: { x: 40, y: 60 } });
  await card('metagpt').getByTestId('dashboard-card-grip').click();
  eq(await log(), 'quick-metagpt', 'a click in edit mode never triggers Open');
  const openBtn = await card('investment').getByRole('button', { name: 'Ouvrir Studio' }).boundingBox();
  const target = await center(card(beforeCancel[0]));
  await page.mouse.move(openBtn.x + openBtn.width / 2, openBtn.y + openBtn.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(openBtn.x + (target.x - openBtn.x) * (i / 8), openBtn.y + (target.y - openBtn.y) * (i / 8), { steps: 2 });
  await page.mouse.up();
  eq(await log(), 'quick-metagpt', 'a drag started on "Ouvrir" does not open');
  check(beforeCancel[0] !== 'investment', 'precondition: investment is not already first');
  eq((await order())[0], 'investment', 'and it moved the card to the first slot instead');

  // ═══ T — touch (pointerType "touch", the browser's own PointerEvent): same gesture, same result, one write ═══
  {
    const cur = await order();
    const [touchFrom, touchTo] = [cur[3], cur[0]];
    const want = visibleCards(moveCard({ order: cur, hidden: new Set() }, touchFrom, touchTo));
    const w0 = await writes();
    await page.evaluate(([fromId, toId]) => {
      const grip = document.querySelector(`[data-testid="dashboard-card"][data-card-id="${fromId}"] [data-testid="dashboard-card-grip"]`);
      const r = grip.getBoundingClientRect();
      const t = document.querySelector(`[data-testid="dashboard-card"][data-card-id="${toId}"]`).getBoundingClientRect();
      const a = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; const b = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
      const fire = (type, p) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
      fire('pointerdown', a);
      for (let i = 1; i <= 8; i++) fire('pointermove', { x: a.x + (b.x - a.x) * (i / 8), y: a.y + (b.y - a.y) * (i / 8) });
      fire('pointerup', b);
    }, [touchFrom, touchTo]);
    eq(await settledOrder(want), want, `touch drag ${touchFrom} → ${touchTo}`);
    eq(await writes(), w0 + 1, 'touch drop: one write');
  }

  // ═══ H — hide / show / keyboard / ▲▼ in the panel still work and stay consistent with direct drag ═══
  await page.locator('[data-testid="dashboard-card-item"][data-card-id="observateur"] [data-testid="dashboard-card-hide"]').click();
  eq(await card('observateur').count(), 0, 'hidden card leaves the dashboard');
  await dragTo('activity', { id: (await order())[1] }, { expectTarget: (await order())[1] });
  await page.locator('[data-testid="dashboard-hidden-item"][data-card-id="observateur"] [data-testid="dashboard-card-show"]').click();
  eq((await order()).at(-1), 'observateur', 'shown again at the end');
  const second = (await panelOrder())[1];
  await page.locator(`[data-testid="dashboard-card-item"][data-card-id="${second}"] [data-testid="dashboard-card-handle"]`).focus();
  await page.keyboard.press('ArrowUp');
  eq((await order())[0], second, 'keyboard move reflected on the dashboard');
  await page.locator(`[data-testid="dashboard-card-item"][data-card-id="${second}"] [data-testid="dashboard-card-down"]`).click();
  eq((await order())[1], second, '▼ reflected on the dashboard');
  check(!(await page.locator('[data-testid="dashboard-hidden-item"]').evaluateAll(els => els.map(e => e.dataset.cardId))).some(id => ['metagpt', 'sherlock'].includes(id)), 'default cards still visible');
  check((await stored()).hidden.includes('notebook') && (await stored()).hidden.includes('omega'), 'the 13 launchers keep their hidden-by-default policy');

  // ═══ P — persistence: reload and a simulated restart (fresh browser context, same stored profile) ═══
  const finalOrder = await order();
  await doneEdit();
  await page.reload();
  await page.getByLabel('Module MetaGPT').waitFor();
  eq(await order(), finalOrder, 'same order after reload');
  const persisted = await page.evaluate(k => localStorage.getItem(k), KEY);
  check(await page.evaluate(() => Object.keys(localStorage).filter(k => /dashboard/i.test(k))).then(keys => keys.length === 1 && keys[0] === 'docteur.dashboardLayout'), 'one single configuration key');
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx2.addInitScript(([k, v]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); } }, [KEY, persisted]);
  page = await newPage(ctx2);
  eq(await order(), finalOrder, 'same order after a restart');

  // ═══ R — restore defaults, then normal mode is pixel-identical to the start ═══
  await edit();
  await page.getByTestId('dashboard-reset').click();
  await page.getByTestId('dashboard-reset-confirm').click();
  eq(await order(), HISTORICAL, 'defaults restored');
  await doneEdit();
  eq(await page.locator('[data-testid="dashboard-card-grip"], [data-testid="dashboard-card"][draggable]').count(), 0, 'no grip after Terminer');
  eq(await boxes(), normalBoxes, 'normal-mode geometry identical to the original');
  await card('sherlock').getByRole('button', { name: 'Ouvrir' }).click();
  eq(await log(), 'sherlock', 'normal clicks work again');

  eq(errors, [], `no page error: ${errors.join(' | ')}`);
  await ctx2.close();
  console.log(`DASHBOARD DIRECT DRAG: PASS (${assertions} assertions)`);
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
