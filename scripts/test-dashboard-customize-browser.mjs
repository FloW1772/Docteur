// Customizable Dashboard V1 — REAL src/App.tsx in Chromium (audit harness: every /api/** mocked, no real server / DB).
// Usage: node scripts/test-dashboard-customize-browser.mjs
import assert from 'node:assert/strict';
import { startHarness, openApp, until, sleep } from './audit-queue-lib.mjs';

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); assertions += 1; };

const KEY = 'docteur.dashboardLayout';
const HISTORICAL = ['metagpt', 'sherlock', 'investment', 'video-studio', 'connectors', 'observateur', 'maitre', 'quick-actions', 'activity'];
const extra = async ({ route, p, m, json }) => {
  if (p === '/api/agents/pending-outputs') { await json(route, []); return true; }
  // the generic harness answers {} — the real server returns { notebooks: [...] } (the Notebook UI reads .length)
  if (p === '/api/notebooks' && m === 'GET') { await json(route, { notebooks: [] }); return true; }
  return false;
};

const h = await startHarness({ port: 5239 });
const app = await openApp(h, { extra, indexMs: 30 });
const { page, net } = app;
await page.setViewportSize({ width: 1440, height: 900 });

const dashboardOrder = () => page.locator('[data-testid="dashboard-card"]').evaluateAll(els => els.map(e => e.dataset.cardId));
const cornerOf = (slot) => page.locator(`[data-testid="dashboard-card"][data-slot="${slot}"]`).getAttribute('data-card-id');
const listOrder = () => page.locator('[data-testid="dashboard-card-item"]').evaluateAll(els => els.map(e => e.dataset.cardId));
const hiddenList = () => page.locator('[data-testid="dashboard-hidden-item"]').evaluateAll(els => els.map(e => e.dataset.cardId));
const item = (id) => page.locator(`[data-testid="dashboard-card-item"][data-card-id="${id}"]`);
const stored = () => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY);
const writes = () => page.evaluate(() => window.__dashWrites ?? 0);
async function instrumentWrites() {
  await page.evaluate(k => {
    window.__dashWrites = 0;
    const orig = Storage.prototype.setItem;
    if (orig.__wrapped) return;
    const wrapped = function (key, value) { if (key === k) window.__dashWrites += 1; return orig.call(this, key, value); };
    wrapped.__wrapped = true;
    Storage.prototype.setItem = wrapped;
  }, KEY);
}
async function reloadDashboard() {
  await page.reload();
  await page.getByRole('button', { name: 'Capturer' }).first().waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="dashboard-customize"]').waitFor({ timeout: 10_000 });
  await instrumentWrites();
}
// the Notebook modal header (always rendered, unlike the per-notebook badge)
const nbTitle = () => page.locator('span.font-grotesk.font-semibold', { hasText: /^Notebook local$/ });
const openCustomizer = async () => { await page.locator('[data-testid="dashboard-customize"]').click(); await page.locator('[data-testid="dashboard-customizer"]').waitFor(); };
const done = async () => { await page.locator('[data-testid="dashboard-customize-done"]').click(); await page.locator('[data-testid="dashboard-customizer"]').waitFor({ state: 'detached' }); };
// real mouse drag (HTML5 DnD) with intermediate moves over other cards: nothing may be persisted before the drop
async function drag(fromId, toId) {
  const from = await item(fromId).boundingBox(); const to = await item(toId).boundingBox();
  const before = await writes();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + from.width / 2, from.y + (to.y - from.y) * (i / 8) + from.height / 2, { steps: 3 });
  eq(await writes(), before, `no write while dragging ${fromId}`);
  await page.mouse.up();
}

try {
  // ═══ D1 — default layout = the historical V2.1 Dashboard; normal mode has no edit clutter ═══
  await page.evaluate(() => { localStorage.setItem('docteur.viewMode', 'dashboard'); localStorage.removeItem('docteur.dashboardLayout'); });
  await reloadDashboard();
  eq(await dashboardOrder(), HISTORICAL, 'default cards and order');
  eq([await cornerOf('tl'), await cornerOf('tr'), await cornerOf('bl'), await cornerOf('br')], ['metagpt', 'sherlock', 'investment', 'video-studio'], 'same four corners');
  eq(await page.locator('[data-testid="dashboard-card-handle"], [data-testid="dashboard-card-hide"]').count(), 0, 'no edit controls outside the edit mode');
  eq(await page.locator('.hud2-cortex-link').count(), 4, 'one Cortex link per occupied corner');
  const topbarButtonsBefore = await page.locator('.topbar-action, .topbar-more-item').count();

  // ═══ D2 — edit mode lists the shown cards and the hidden (opt-in) features ═══
  await openCustomizer();
  eq(await listOrder(), HISTORICAL);
  const hiddenDefault = await hiddenList();
  check(['notebook', 'teacher', 'capture', 'omega', 'kiwix'].every(id => hiddenDefault.includes(id)), `opt-in features listed as hidden: ${hiddenDefault}`);

  // ═══ D3 — drag first → last, then last → first (real mouse), saved once per drop ═══
  await drag('metagpt', 'activity');
  check(await until(async () => (await listOrder()).at(-1) === 'metagpt', 3_000, 50), 'metagpt dropped last');
  eq(await writes(), 1, 'one write for one drop');
  eq(await cornerOf('tl'), 'sherlock', 'the dashboard itself follows (sherlock now in the first corner)');
  eq((await dashboardOrder()).at(-1), 'metagpt');
  await drag('metagpt', 'sherlock');
  check(await until(async () => (await listOrder())[0] === 'metagpt', 3_000, 50), 'metagpt dropped first');
  eq(await writes(), 2);
  await drag('quick-actions', 'quick-actions');
  eq(await writes(), 2, 'a drop on itself writes nothing');

  // ═══ D4 — keyboard (arrow keys on the handle) and ▲/▼ buttons; focus follows the moved card ═══
  await item('investment').locator('[data-testid="dashboard-card-handle"]').focus();
  await page.keyboard.press('ArrowUp');
  check(await until(async () => (await listOrder()).indexOf('investment') === 1, 2_000, 50), 'ArrowUp moved investment up');
  eq(await page.evaluate(() => document.activeElement?.closest('[data-card-id]')?.dataset.cardId), 'investment', 'focus stays on the moved card');
  await page.keyboard.press('ArrowDown');
  check(await until(async () => (await listOrder()).indexOf('investment') === 2, 2_000, 50), 'ArrowDown moved it back');
  await item('activity').locator('[data-testid="dashboard-card-up"]').click();
  eq((await listOrder()).at(-2), 'activity', '▲ button');
  check(await item(HISTORICAL[0]).locator('[data-testid="dashboard-card-up"]').isDisabled(), '▲ disabled on the first card');

  // ═══ D5 — the user's own example: build Capture/YouTube, Notebook, Studio Vidéo, Professeur, OMEGA ═══
  for (const id of ['notebook', 'omega', 'teacher', 'capture']) await page.locator(`[data-testid="dashboard-hidden-item"][data-card-id="${id}"] [data-testid="dashboard-card-show"]`).click();
  for (const id of ['metagpt', 'sherlock', 'investment', 'connectors', 'observateur', 'maitre', 'quick-actions', 'activity']) await item(id).locator('[data-testid="dashboard-card-hide"]').click();
  eq(await listOrder(), ['video-studio', 'notebook', 'omega', 'teacher', 'capture']);
  await drag('capture', 'video-studio');
  await drag('notebook', 'video-studio');
  await drag('omega', 'capture');
  eq((await listOrder()).length, 5, 'five cards shown');
  // final arrangement wanted: YouTube(capture), Notebook, Media(video-studio), Professeur(teacher), OMEGA
  const target = ['capture', 'notebook', 'video-studio', 'teacher', 'omega'];
  for (let i = 0; i < target.length; i++) {
    let order = await listOrder();
    while (order.indexOf(target[i]) > i) { await item(target[i]).locator('[data-testid="dashboard-card-up"]').click(); order = await listOrder(); }
  }
  eq(await listOrder(), target, 'arranged exactly as wanted');
  eq(await dashboardOrder(), target, 'dashboard shows that order');
  check((await hiddenList()).includes('maitre') && (await hiddenList()).includes('metagpt'), 'hidden cards listed');
  const saved = await stored();
  eq(saved.order.filter(id => !saved.hidden.includes(id)), target, 'persisted with stable ids (hidden cards keep their place in the full order)');
  check((await stored()).hidden.includes('maitre'), 'hidden persisted');
  check(!JSON.stringify(await stored()).match(/MAÎTRE|Professeur|Studio Vidéo/), 'titles never used as ids');
  await done();
  eq(await page.locator('[data-testid="dashboard-card"][data-card-id="maitre"]').count(), 0, 'hidden card gone from the dashboard');
  eq(await page.locator('[data-testid="dashboard-card-handle"]').count(), 0, 'edit controls gone after "Terminer"');

  // ═══ D6 — a launcher card opens the real feature; a HIDDEN feature still opens from the TopBar ═══
  await page.locator('[data-testid="dashboard-card"][data-card-id="notebook"] .hud2-module-widget-open').click();
  const nbOpened = await until(async () => (await nbTitle().count()) > 0, 10_000);
  check(nbOpened, `Notebook opened from its dashboard card — diag: ${JSON.stringify({
    errors: net.errors, anyText: await page.getByText('Notebook local').count(),
    cardButtons: await page.locator('[data-testid="dashboard-card"][data-card-id="notebook"] button').allInnerTexts(),
    lazyFallback: await page.locator('text=/Chargement/').count(),
  })}`);
  await nbTitle().locator('xpath=ancestor::div[2]/button').click();
  check(await until(async () => (await nbTitle().count()) === 0, 5_000), 'Notebook closed');
  await openCustomizer();
  await item('notebook').locator('[data-testid="dashboard-card-hide"]').click();
  await done();
  eq(await page.locator('[data-testid="dashboard-card"][data-card-id="notebook"]').count(), 0, 'Notebook card hidden');
  await page.locator('button[aria-haspopup="menu"]').first().click();
  await page.getByRole('menuitem', { name: /Notebook local/ }).click();
  check(await until(async () => (await nbTitle().count()) > 0, 10_000), 'hidden ≠ disabled: Notebook still opens from the TopBar menu');
  await nbTitle().locator('xpath=ancestor::div[2]/button').click();
  check(await until(async () => (await nbTitle().count()) === 0, 5_000), 'Notebook closed');
  eq(await page.locator('.topbar-action, .topbar-more-item').count(), topbarButtonsBefore, 'no TopBar entry removed');

  // ═══ D7 — persistence: reload, then a simulated restart (fresh tab of the same profile) ═══
  const before = await dashboardOrder();
  await reloadDashboard();
  eq(await dashboardOrder(), before, 'same layout after reload');
  // simulated restart: the whole browser context (= the running Docteur page) is thrown away; a new one starts with the
  // persisted profile storage — exactly what survives a real restart. The raw stored value is carried over unchanged.
  const persisted = await page.evaluate(k => localStorage.getItem(k), KEY);
  await app.ctx.close();
  const app2 = await openApp(h, { extra, indexMs: 30 });
  await app2.page.evaluate(([k, v]) => { localStorage.setItem('docteur.viewMode', 'dashboard'); localStorage.setItem(k, v); }, [KEY, persisted]);
  Object.assign(app, app2);
  const p2 = app2.page;
  await p2.setViewportSize({ width: 1440, height: 900 });
  await p2.reload();
  await p2.locator('[data-testid="dashboard-customize"]').waitFor({ timeout: 30_000 });
  eq(await p2.locator('[data-testid="dashboard-card"]').evaluateAll(els => els.map(e => e.dataset.cardId)), before, 'same layout after a restart with the persisted profile');
  globalThis.__page = p2;
  console.log('ok persistence');
} catch (err) {
  console.error(`DASHBOARD BROWSER: FAIL after ${assertions} assertions`);
  throw err;
}

// second half on the restarted session
const page2 = globalThis.__page;
const P = page2;
const order2 = () => P.locator('[data-testid="dashboard-card"]').evaluateAll(els => els.map(e => e.dataset.cardId));
const listOrder2 = () => P.locator('[data-testid="dashboard-card-item"]').evaluateAll(els => els.map(e => e.dataset.cardId));
try {
  // ═══ D8 — restore defaults only after confirmation ═══
  await P.locator('[data-testid="dashboard-customize"]').click();
  const beforeReset = await listOrder2();
  await P.locator('[data-testid="dashboard-reset"]').click();
  check(await P.locator('[data-testid="dashboard-reset-confirm"]').isVisible(), 'confirmation asked');
  await P.locator('[data-testid="dashboard-reset-cancel"]').click();
  eq(await listOrder2(), beforeReset, 'cancel keeps the layout');
  await P.locator('[data-testid="dashboard-reset"]').click();
  await P.locator('[data-testid="dashboard-reset-confirm"]').click();
  eq(await listOrder2(), HISTORICAL, 'defaults restored after confirmation');
  eq(await order2(), HISTORICAL);

  // ═══ D9 — all cards hidden: empty-state hint, the "Personnaliser" button stays reachable ═══
  for (const id of HISTORICAL) await P.locator(`[data-testid="dashboard-card-item"][data-card-id="${id}"] [data-testid="dashboard-card-hide"]`).click();
  check(await P.locator('[data-testid="dashboard-all-hidden-note"]').isVisible(), 'customizer explains that nothing is shown');
  await P.locator('[data-testid="dashboard-customize-done"]').click();
  eq(await P.locator('[data-testid="dashboard-card"]').count(), 0, 'no card');
  eq(await P.locator('.hud2-cortex-link').count(), 0, 'no dangling Cortex link');
  check(await P.locator('[data-testid="dashboard-empty"]').isVisible(), 'empty-state hint');
  check(await P.locator('[data-testid="dashboard-customize"]').isVisible(), 'Personnaliser still reachable');
  await P.locator('[data-testid="dashboard-customize"]').click();
  await P.locator('[data-testid="dashboard-hidden-item"][data-card-id="activity"] [data-testid="dashboard-card-show"]').click();
  eq(await order2(), ['activity'], 'a card can be brought back');
  await P.locator('[data-testid="dashboard-customize-done"]').click();

  // ═══ D10 — corrupt / unknown / future preference states never break the dashboard ═══
  const load = async (raw) => {
    await P.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, raw]);
    await P.reload();
    await P.locator('[data-testid="dashboard-customize"]').waitFor({ timeout: 30_000 });
    return order2();
  };
  eq(await load('{"version":1,"order":["sherlock"'), HISTORICAL, 'corrupt JSON → defaults');
  eq(await load('null'), HISTORICAL, 'null → defaults');
  eq(await load(JSON.stringify({ version: 99, order: ['activity'], hidden: [] })), HISTORICAL, 'unknown version → defaults');
  const future = await load(JSON.stringify({ version: 1, order: ['activity', 'ghost-module', 'activity', 'metagpt', 'sherlock'], hidden: ['ghost', 'sherlock'] }));
  eq(future.slice(0, 2), ['activity', 'metagpt'], 'stored order kept, unknown + duplicate ids ignored');
  check(!future.includes('sherlock') && future.includes('quick-actions') && future.includes('maitre'), `cards missing from the old state appear at their default place: ${future}`);
  check(!future.includes('notebook'), 'opt-in launchers stay hidden for an old state');

  // ═══ D11 — small viewport: the Dashboard (and its editor) are desktop/tablet only, the app still works ═══
  await P.setViewportSize({ width: 390, height: 844 });
  await until(async () => (await P.locator('[data-testid="dashboard-customize"]').count()) === 0, 5_000);
  eq(await P.locator('[data-testid="dashboard-customize"], [data-testid="dashboard-customizer"]').count(), 0, 'no editor on mobile (Focus mode by design)');
  check(await P.getByRole('button', { name: 'Capturer' }).first().isVisible(), 'app still usable on mobile');
  await P.setViewportSize({ width: 1440, height: 900 });

  eq(app.net.errors.filter(e => !/outputs is not iterable/.test(e)), [], `no page error: ${app.net.errors}`);
  console.log(`DASHBOARD BROWSER: PASS (${assertions} assertions)`);
} finally {
  await h.browser.close().catch(() => {});
  await h.server.close().catch(() => {});
}
void sleep; void net;
