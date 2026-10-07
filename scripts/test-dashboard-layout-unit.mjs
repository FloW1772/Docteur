// Customizable Dashboard V1 — unit tests of the pure layout model (src/lib/dashboard/dashboard-layout.ts, Node type stripping).
// Usage: node --test scripts/test-dashboard-layout-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DASHBOARD_CARDS, DASHBOARD_STORAGE_KEY, defaultDashboardLayout, hideCard, loadDashboardLayout, moveCard, moveCardBy, placeCards,
  resolveDashboardLayout, sameLayout, saveDashboardLayout, showCard, toPreference, visibleCards,
} from '../src/lib/dashboard/dashboard-layout.ts';

const HISTORICAL = ['metagpt', 'sherlock', 'investment', 'video-studio', 'connectors', 'observateur', 'maitre', 'quick-actions', 'activity'];
const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; };

test('catalog: stable unique ids (never titles), the 9 historical cards visible by default in their V2.1 order', () => {
  const ids = DASHBOARD_CARDS.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/, id);
  assert.deepEqual(visibleCards(defaultDashboardLayout()), HISTORICAL);
  const { corners, rail } = placeCards(defaultDashboardLayout());
  assert.deepEqual(corners, [{ slot: 'tl', id: 'metagpt' }, { slot: 'tr', id: 'sherlock' }, { slot: 'bl', id: 'investment' }, { slot: 'br', id: 'video-studio' }], 'same corners as V2.1');
  assert.deepEqual(rail, ['connectors', 'observateur', 'maitre', 'quick-actions', 'activity'], 'same rail as V2.1');
  assert.ok(['notebook', 'teacher', 'omega', 'capture'].every(id => defaultDashboardLayout().hidden.has(id)), 'launcher cards are opt-in');
});

test('drag first → last, last → first, and several reorders', () => {
  let l = defaultDashboardLayout();
  l = moveCard(l, 'metagpt', 'activity');
  assert.deepEqual(visibleCards(l).slice(-2), ['activity', 'metagpt'], 'first dropped on the last → last');
  l = moveCard(l, 'metagpt', 'sherlock');
  assert.equal(visibleCards(l)[0], 'metagpt', 'last dropped on the first → first');
  l = moveCard(defaultDashboardLayout(), 'activity', 'metagpt');
  assert.equal(visibleCards(l)[0], 'activity');
  // the user example: Notebook, OMEGA, Media, Professeur, YouTube → YouTube, Notebook, Media(=video-studio), Professeur, OMEGA
  l = { order: ['notebook', 'omega', 'video-studio', 'teacher', 'capture'], hidden: new Set() };
  l = moveCard(l, 'capture', 'notebook');
  l = moveCard(l, 'omega', 'teacher');
  assert.deepEqual(visibleCards(l), ['capture', 'notebook', 'video-studio', 'teacher', 'omega']);
  assert.equal(moveCard(l, 'notebook', 'notebook'), l, 'drop on itself: same object, nothing to save');
  assert.equal(moveCard(l, 'ghost', 'notebook'), l, 'unknown id: no change');
});

test('keyboard / button moves among visible cards, bounded at both ends, hidden cards keep their place', () => {
  let l = hideCard(defaultDashboardLayout(), 'sherlock');
  l = moveCardBy(l, 'investment', -1);
  assert.deepEqual(visibleCards(l).slice(0, 3), ['investment', 'metagpt', 'video-studio'], 'skips the hidden card');
  assert.equal(moveCardBy(l, 'investment', -1), l, 'already first');
  const last = visibleCards(l).at(-1);
  assert.equal(moveCardBy(l, last, 1), l, 'already last');
  assert.ok(l.hidden.has('sherlock'));
});

test('hide / show: hidden card leaves the dashboard only, comes back visible at the end', () => {
  let l = hideCard(defaultDashboardLayout(), 'maitre');
  assert.ok(!visibleCards(l).includes('maitre'));
  assert.ok(l.order.includes('maitre'), 'its place is kept in the order (not deleted)');
  assert.equal(hideCard(l, 'maitre'), l, 'hiding twice is a no-op');
  l = showCard(l, 'maitre');
  assert.equal(visibleCards(l).at(-1), 'maitre');
  l = showCard(l, 'notebook');
  assert.equal(visibleCards(l).at(-1), 'notebook', 'an opt-in launcher can be shown');
  assert.equal(showCard(l, 'notebook'), l, 'showing a visible card is a no-op');
});

test('all cards hidden: empty dashboard, nothing in the corners, every card still listed', () => {
  let l = defaultDashboardLayout();
  for (const id of visibleCards(l)) l = hideCard(l, id);
  assert.deepEqual(visibleCards(l), []);
  assert.deepEqual(placeCards(l), { corners: [], rail: [] });
  assert.equal(l.hidden.size, DASHBOARD_CARDS.length);
  l = showCard(l, 'activity');
  assert.deepEqual(placeCards(l).corners, [{ slot: 'tl', id: 'activity' }]);
});

test('persistence: save → load round trip (reload / restart), only stable ids stored, no secrets', () => {
  const store = memoryStorage();
  let l = moveCard(hideCard(defaultDashboardLayout(), 'sherlock'), 'activity', 'metagpt');
  l = showCard(l, 'notebook');
  assert.equal(saveDashboardLayout(l, store), true);
  const raw = JSON.parse(store.getItem(DASHBOARD_STORAGE_KEY));
  assert.deepEqual(Object.keys(raw).sort(), ['hidden', 'order', 'version']);
  assert.equal(raw.version, 1);
  assert.ok(raw.order.every(id => DASHBOARD_CARDS.some(c => c.id === id)), 'ids only, never titles');
  assert.ok(sameLayout(loadDashboardLayout(store), l), 'identical after a reload');
  const restarted = loadDashboardLayout({ getItem: k => store.map.get(k) ?? null }); // a brand-new process reading the same storage
  assert.ok(sameLayout(restarted, l), 'identical after a restart');
});

test('robustness: unknown ids ignored, duplicates removed, junk filtered', () => {
  const l = resolveDashboardLayout({ version: 1, order: ['sherlock', 'ghost-module', 'sherlock', 42, null, 'metagpt', '<script>', 'investment'], hidden: ['ghost', 'investment', 'investment'] });
  assert.deepEqual(l.order.slice(0, 3), ['sherlock', 'metagpt', 'investment']);
  assert.equal(l.order.length, DASHBOARD_CARDS.length, 'every known card exactly once');
  assert.equal(new Set(l.order).size, l.order.length, 'no duplicate');
  assert.ok(l.hidden.has('investment') && !l.hidden.has('ghost'));
});

test('future module absent from an old preference: inserted at its default place with its default visibility', () => {
  const v1Catalog = DASHBOARD_CARDS.filter(c => c.id !== 'quick-actions' && c.id !== 'notebook');
  const old = toPreference(moveCard(defaultDashboardLayout(v1Catalog), 'activity', 'metagpt')); // saved by an "older" Docteur
  const l = resolveDashboardLayout(old);
  assert.equal(visibleCards(l)[0], 'activity', 'user order kept');
  assert.equal(l.order.indexOf('quick-actions'), l.order.indexOf('maitre') + 1, 'new visible card: right after its default predecessor');
  assert.ok(visibleCards(l).includes('quick-actions'), 'default-visible new card is shown');
  assert.ok(l.hidden.has('notebook'), 'default-hidden new card stays opt-in');
  const shownLauncher = resolveDashboardLayout(toPreference(showCard(defaultDashboardLayout(), 'notebook')));
  assert.ok(!shownLauncher.hidden.has('notebook'), 'a launcher the user showed stays shown');
});

test('corrupt / empty / foreign preference → default layout, never a crash', () => {
  for (const bad of [null, undefined, '', 42, [], {}, { version: 2, order: ['activity'] }, { version: '1' }, { version: 1, order: 'metagpt', hidden: {} }]) {
    const l = resolveDashboardLayout(bad);
    assert.equal(l.order.length, DASHBOARD_CARDS.length, JSON.stringify(bad));
  }
  assert.deepEqual(visibleCards(resolveDashboardLayout({ version: 1, order: [], hidden: [] })), HISTORICAL, 'empty state = defaults (new cards appear)');
  const corrupt = { getItem: () => '{"version":1,"order":["sherlock"' };
  assert.ok(sameLayout(loadDashboardLayout(corrupt), defaultDashboardLayout()));
  const throwing = { getItem: () => { throw new Error('SecurityError'); } };
  assert.ok(sameLayout(loadDashboardLayout(throwing), defaultDashboardLayout()));
  assert.equal(saveDashboardLayout(defaultDashboardLayout(), { setItem: () => { throw new Error('QuotaExceeded'); } }), false);
  assert.equal(saveDashboardLayout(defaultDashboardLayout(), null), false);
});

test('restore defaults = historical order and every default card visible again', () => {
  let l = defaultDashboardLayout();
  for (const id of visibleCards(l)) l = hideCard(l, id);
  l = showCard(l, 'omega');
  assert.ok(!sameLayout(l, defaultDashboardLayout()));
  assert.deepEqual(visibleCards(defaultDashboardLayout()), HISTORICAL);
});

test('static audit: no capability, route, permission or Root Policy touched; frozen modules untouched; no network', () => {
  const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  for (const f of ['src/lib/dashboard/dashboard-layout.ts', 'src/components/hud/DashboardCustomizer.tsx', 'src/components/hud/Dashboard.tsx']) {
    const t = read(f).split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).map(l => l.replace(/\s\/\/.*$/, '')).join('\n'); // code only
    assert.doesNotMatch(t, /fetch\(|apiFetch|cortexClient|\/api\/|root-policy|permission|setFeatureEnabled|disable[A-Z]/, `${f}: layout only`);
  }
  const app = read('src/App.tsx');
  const launchers = app.slice(app.indexOf('launchers={{'), app.indexOf('}}', app.indexOf('launchers={{')));
  // launchers reuse the central existing opener (voice / help use it too); its cases are untouched
  for (const key of ['notebook', 'teacher', 'capture', 'kiwix', 'images', 'agents', 'skills', 'prompt-generator', 'corpus', 'todo']) {
    assert.ok(launchers.includes(`handleOpenFeature('${key}')`), `launcher ${key} → handleOpenFeature`);
    assert.match(app, new RegExp(`case '${key}':\\s*set\\w+Open\\(true\\); break;`), `handleOpenFeature still opens ${key}`);
  }
  for (const opener of ['onNotebookOpen={() => setNotebookOpen(true)}', 'onTeacherOpen={() => setTeacherOpen(true)}', 'onKiwixOpen={() => setKiwixOpen(true)}']) {
    assert.ok(app.includes(opener), `TopBar path kept: ${opener}`);
  }
  // OMEGA / Devices: their existing path is the Settings modal tab list (Paramètres → OMEGA VIEW / APPAREILS)
  assert.ok(launchers.includes("setSettingsInitialTab('omega')") && launchers.includes("setSettingsInitialTab('devices')"));
  const settings = read('src/components/modals/SettingsModal.tsx');
  assert.match(settings, /\(\[[^\]]*'devices', 'omega'[^\]]*\] as const\)\.map/, 'OMEGA and Devices tabs still listed in Settings');
});
