// [Knowledge Graph V1] KG-6 — REAL KnowledgeGraphModal against the REAL KG route, in-process, on a
// TEMPORARY SQLite database (never the user database) holding a large synthetic graph
// (1 200-node network, 800-edge hub, cycle, contradiction, ambiguity, private sources,
// dense timeline). No model, no network.
// Usage: node scripts/test-knowledge-graph-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { KnowledgeGraphStore } from '../cortex-server/src/lib/kg-store.js';
import { createKnowledgeGraphRoute } from '../cortex-server/src/routes/kg.js';
import { resolveEntityMention } from '../cortex-server/src/lib/kg-resolution.js';
import { assertClaim } from '../cortex-server/src/lib/kg-claims.js';
import { buildGraphWorld } from '../cortex-server/fixtures/kg6-graph-world.mjs';

let assertions = 0;
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(40); } return false; }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg6-browser-'));
const store = await KnowledgeGraphStore.createTestStore(path.join(TMP, 'kg6.db'));
const tBuild = Date.now();
const world = await buildGraphWorld(store);
// KG-CERT: hostile content — HTML / script in labels and evidence, a javascript: source URL
const xssSrc = store.upsertSource({ source_type: 'WEB', name: '<b>Bulletin</b><script>window.__xss=5</script>', logical_key: 'cert:xss', privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
const xssRef = store.upsertSourceRef({ source_id: xssSrc, adapter: 'manual', source_ref: 'cert:xss', original_url: 'javascript:window.__xss=3', privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
const mallory = resolveEntityMention(store, { label: '<img src=x onerror="window.__xss=1">Mallory', type: 'ORGANIZATION', sourceRefId: xssRef }).entityId;
const eve = resolveEntityMention(store, { label: '<script>window.__xss=2</script>Eve', type: 'PERSON', sourceRefId: xssRef }).entityId;
const xssClaim = assertClaim(store, { subjectEntityId: mallory, predicate: 'ceo', objectEntityId: eve, extractionMethod: 'DETERMINISTIC',
  evidence: [{ sourceId: xssSrc, sourceRefId: xssRef, excerpt: '<svg onload="window.__xss=4"></svg> Eve dirige Mallory' }] }).claimId;
const stats = store.getStatistics();
console.log(`# dataset: ${stats.entities.total} entities, ${stats.relationships.total} relations, ${stats.claims.total} claims (built in ${((Date.now() - tBuild) / 1000).toFixed(1)} s)`);
let api = createKnowledgeGraphRoute(store);
const disabledApi = createKnowledgeGraphRoute(null, { disabledReason: 'KG_UNCERTIFIED_DISABLED' });
const writesBefore = store.db.prepare('SELECT total_changes() AS n').get().n;

const PORT = 5261;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/knowledge-graph-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-kg6', plugins: [react()], optimizeDeps: { entries: ['scripts/knowledge-graph-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { errors: [], external: [], foreign: [], calls: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };
const metrics = { initial: [], expand: [], maxNodes: 0, maxEdges: 0 };

async function openPage({ viewport = { width: 1400, height: 950 }, reducedMotion = 'no-preference', route = () => api } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/api/**', async r => {
    const req = r.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (!u.pathname.startsWith('/api/kg/')) { net.foreign.push(u.pathname); return r.fulfill({ status: 404, headers: cors, body: '{}' }); }
    net.calls.push(`${req.method()} ${u.pathname}`);
    const res = await route().request(u.pathname.replace(/^\/api\/kg/, ''), { method: req.method(), headers: { 'content-type': 'application/json' }, ...(req.postData() ? { body: req.postData() } : {}) });
    return r.fulfill({ status: res.status, contentType: 'application/json', headers: cors, body: await res.text() });
  });
  await ctx.route('**/__kg', r => r.fulfill({ contentType: 'text/html', body: html }));
  await ctx.addInitScript(() => {
    window.__longTasks = [];
    try { new PerformanceObserver(list => { for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__kg`);
  await page.getByRole('dialog', { name: 'Knowledge Graph' }).waitFor({ timeout: 60_000 });
  return { ctx, page };
}

const nodeCount = (page) => page.locator('[data-node-id]').count();
const edgeCount = (page) => page.locator('[data-edge-id]').count();
async function track(page) {
  metrics.maxNodes = Math.max(metrics.maxNodes, await nodeCount(page));
  metrics.maxEdges = Math.max(metrics.maxEdges, await edgeCount(page));
}

async function searchAndOpen(page, query, { label = query, pick = 0 } = {}) {
  await page.getByLabel('Rechercher une entité').fill(query);
  await page.getByRole('button', { name: 'Rechercher' }).click();
  const hits = page.getByRole('region', { name: 'Résultats de recherche' }).or(page.locator('.kg-hits'));
  await hits.first().waitFor();
  const buttons = page.locator('.kg-hit', { hasText: label });
  ok(await until(async () => (await buttons.count()) > pick), `search hit "${label}"`);
  const t0 = Date.now();
  await buttons.nth(pick).click();
  ok(await until(async () => (await nodeCount(page)) > 0 && !(await page.locator('.kg-busy').isVisible().catch(() => false))), `graph for ${query}`);
  const ms = Date.now() - t0;
  metrics.initial.push(ms);
  await track(page);
  return ms;
}

async function expandSelected(page) {
  const before = await nodeCount(page);
  const t0 = Date.now();
  await page.locator('.kg-toolbar button', { hasText: 'Développer' }).click();
  await until(async () => !(await page.locator('.kg-busy').isVisible().catch(() => false)));
  metrics.expand.push(Date.now() - t0);
  await track(page);
  return (await nodeCount(page)) - before;
}

const node = (page, label) => page.locator('[data-node-id]', { has: page.locator('.kg-node-label', { hasText: new RegExp(`^${label}$`) }) }).first();
const domHas = async (page, text) => (await page.content()).includes(text);

let failed = null;
try {
  // ── basics, search, bounded initial graph, details, evidence, private evidence hidden ──
  {
    const { ctx, page } = await openPage();
    ok(await page.getByText(/Recherchez une entité pour afficher son voisinage/).isVisible(), 'empty state');
    eq(await nodeCount(page), 0, 'nothing loaded before a search');
    await searchAndOpen(page, 'Acme Industries');
    const n = await nodeCount(page);
    ok(n >= 4 && n <= 60, `initial neighbourhood bounded (${n})`);
    ok(await until(() => page.getByTestId('kg-entity-details').isVisible()), 'centre details');
    ok(await until(() => page.getByTestId('kg-entity-details').getByText('acme.example').isVisible()), 'identifier shown');
    ok(!(await domHas(page, 'Code Noir')), 'private alias hidden by default');
    ok(!(await domHas(page, 'Projet Ombre')), 'private-only entity not in the graph');
    ok((await page.getByTestId('kg-live').innerText()).includes('nœuds'), 'live announcement');
    // node selection
    await node(page, 'Bob Durand').click();
    ok(await until(async () => (await page.getByTestId('kg-entity-details').locator('.kg-details-title').innerText().catch(() => '')) === 'Bob Durand'), 'node selected → entity details');
    // edge selection → claim details with evidence + provenance; the private evidence is not there
    await page.locator('[data-edge-id]', { has: page.locator('.kg-edge-label', { hasText: 'ceo' }) }).first().waitFor();
    const bobEdge = page.locator(`[data-edge-id="clm:${world.claims.bobCeo}"]`);
    await bobEdge.click({ force: true });
    await page.getByTestId('kg-claim-details').waitFor();
    ok(await page.getByTestId('kg-claim-details').getByText('Registre des sociétés', { exact: true }).isVisible(), 'evidence source');
    ok(!(await domHas(page, 'Note interne')), 'private evidence not shown');
    ok(!(await domHas(page, 'Carnet confidentiel')), 'private source name not shown');
    await page.locator(`[data-edge-id="clm:${world.claims.aliceCeo}"]`).click({ force: true });
    await until(async () => (await page.getByTestId('kg-claim-details').innerText()).includes('p. 3'));
    ok((await page.getByTestId('kg-claim-details').innerText()).includes('p. 3'), 'locator (page) shown');
    ok((await page.getByTestId('kg-claim-details').innerText()).includes('2010-01-01 → 2015-07-01'), 'validity period');
    // KG-7: "Ouvrir la source" — a manual source has no reopen mechanism: the stored excerpt is shown, nothing foreign is requested
    await page.getByTestId('kg-claim-details').getByRole('button', { name: /^Ouvrir la source/ }).first().click();
    await page.getByTestId('kg-source-preview').waitFor();
    ok((await page.getByTestId('kg-source-preview').innerText()).includes('Alice Martin dirige Acme'), 'source preview shows the stored excerpt');
    await page.getByTestId('kg-source-preview').getByRole('button', { name: 'Fermer' }).click();
    ok(await until(async () => (await page.getByTestId('kg-source-preview').count()) === 0), 'source preview closed');
    // relation details (descriptive, provenance)
    await searchAndOpen(page, 'Widget X');
    await page.locator(`[data-edge-id="rel:${world.relations.widgetMaker}"]`).click({ force: true });
    await page.getByTestId('kg-relation-details').waitFor();
    ok((await page.getByTestId('kg-relation-details').innerText()).includes('n’accorde aucune permission'), 'relation is descriptive');
    // includePrivate: explicit opt-in shows private items (local)
    await page.getByLabel(/Inclure les sources privées/).check();
    await sleep(300);
    await page.getByLabel('Rechercher une entité').fill('Projet Ombre');
    await page.getByRole('button', { name: 'Rechercher' }).click();
    ok(await until(async () => (await page.locator('.kg-hit', { hasText: 'Projet Ombre' }).count()) > 0), 'private entity visible after explicit opt-in');
    await ctx.close();
  }

  // ── contradictions, ambiguity ──
  {
    const { ctx, page } = await openPage();
    await searchAndOpen(page, 'Globex');
    const conflictEdges = page.locator('.kg-edge--conflict');
    eq(await conflictEdges.count(), 2, 'both sides of the contradiction drawn');
    await page.locator(`[data-edge-id="clm:${world.claims.chloeCeo}"]`).click({ force: true });
    const c = page.getByTestId('kg-contradiction');
    await c.waitFor();
    ok((await c.innerText()).includes('David Roux'), 'other side shown in the details');
    ok((await c.innerText()).includes('directeur général de Globex'), 'other side with its evidence');
    ok((await c.innerText()).includes('aucune n’est choisie'), 'no side chosen');
    await page.getByLabel('Rechercher une entité').fill('Apple');
    await page.getByRole('button', { name: 'Rechercher' }).click();
    const amb = page.locator('.kg-hit', { has: page.locator('.kg-status--ambiguous') });
    ok(await until(async () => (await amb.count()) > 0), 'ambiguous badge in search results');
    await amb.first().click();
    ok(await until(async () => (await page.locator('.kg-node--ambiguous').count()) > 0), 'ambiguous node style');
    ok((await page.locator('.kg-node--ambiguous').first().getAttribute('aria-label')).includes('entité ambiguë'), 'ambiguity in the accessible name');
    ok(await until(() => page.getByTestId('kg-entity-details').getByText('Entité ambiguë', { exact: true }).isVisible()), 'ambiguity explained in the details');
    ok(await until(async () => (await page.locator('.kg-ambiguity .kg-link').count()) >= 1), 'candidates listed');
    await ctx.close();
  }

  // ── fan-out, progressive expansion, cycle, 1 000+ node network, list view ──
  {
    const { ctx, page } = await openPage();
    await searchAndOpen(page, 'Hub Central');
    const hubLabel = await node(page, 'Hub Central').getAttribute('aria-label');
    ok(/760 non chargées/.test(hubLabel), `hub reports what was not loaded (${hubLabel})`);
    ok(await page.locator('.kg-node-more').count() >= 1, '+N badge');
    ok((await nodeCount(page)) <= 60, 'hub slice bounded');
    // paging through the hub: each expansion loads the NEXT slice, until the render limit refuses
    await node(page, 'Hub Central').click();
    const hubGrowth = [await nodeCount(page)];
    for (let i = 0; i < 12; i++) {
      await expandSelected(page);
      hubGrowth.push(await nodeCount(page));
      if (await page.locator('.kg-notice', { hasText: 'Limite d’affichage atteinte' }).count()) break;
    }
    console.log(`# KG-6 hub paging growth: ${hubGrowth.join(' → ')}`);
    ok(hubGrowth[1] > hubGrowth[0], 'the next slice of the hub is loaded');
    ok(await page.locator('.kg-notice', { hasText: 'Limite d’affichage atteinte' }).count() === 1, 'render limit reached and refused explicitly');
    const atCap = await nodeCount(page);
    ok(atCap >= 200 && atCap <= 250, `render cap respected (${atCap} nodes)`);
    const tFit = Date.now();
    await page.getByRole('button', { name: 'Ajuster à la vue' }).click();
    await page.getByRole('button', { name: 'Zoom avant' }).click();
    metrics.capInteractionMs = Date.now() - tFit;
    // cycle
    await searchAndOpen(page, 'Cycle A');
    for (const lbl of ['Cycle B', 'Cycle C']) {
      await node(page, lbl).click();
      await expandSelected(page);
    }
    eq(await nodeCount(page), 3, 'cycle: three nodes, no duplicates');
    eq(await edgeCount(page), 3, 'cycle: three edges');
    // large network: progressive manual expansion stays bounded
    await searchAndOpen(page, 'Nœud 0');
    let lastCount = await nodeCount(page);
    const expandedLabels = new Set(['Nœud 0']);
    const growth = [lastCount];
    for (let i = 0; i < 25; i++) {
      const labels = await page.locator('[data-node-id] .kg-node-label').allTextContents();
      const target = labels.find(l => /^Nœud \d+$/.test(l) && !expandedLabels.has(l));
      if (!target) break;
      expandedLabels.add(target);
      await page.getByRole('button', { name: 'Ajuster à la vue' }).click(); // the view grows: fit before pointing at a node
      await node(page, target).click();
      await expandSelected(page);
      lastCount = await nodeCount(page);
      growth.push(lastCount);
    }
    console.log(`# KG-6 network expansion growth: ${growth.join(' → ')}`);
    ok(lastCount >= 30, `progressive expansion really grows the view (${lastCount} nodes)`);
    ok(lastCount <= 250, `progressive expansion bounded (${lastCount} nodes)`);
    ok((await edgeCount(page)) <= 500, 'edges bounded');
    // list / table view (accessible alternative)
    await page.getByRole('radio', { name: 'Liste' }).click();
    await page.getByTestId('kg-list').waitFor();
    eq(await page.locator('.kg-table').first().locator('tbody tr').count(), lastCount, 'list rows = nodes');
    await page.locator('.kg-table').first().getByRole('button', { name: /^Détails de/ }).first().click();
    ok(await until(async () => page.getByTestId('kg-entity-details').isVisible()), 'details from the list');
    await page.getByRole('radio', { name: 'Graphe' }).click();
    const longTasks = await page.evaluate(() => window.__longTasks);
    ok(longTasks.every(d => d < 200), `no UI freeze (long tasks: ${JSON.stringify(longTasks)})`);
    metrics.longTasks = longTasks;
    await ctx.close();
  }

  // ── timeline, filters ──
  {
    const { ctx, page } = await openPage();
    await searchAndOpen(page, 'Projet Chronos');
    await page.getByRole('tab', { name: 'Chronologie' }).click();
    const tl = page.getByTestId('kg-timeline');
    await tl.waitFor();
    ok((await tl.innerText()).includes('151 affirmations datées'), 'dense timeline counted');
    ok(await tl.locator('.kg-hist-bar').count() >= 150, 'per-year histogram for a dense history');
    eq(await tl.locator('.kg-timeline-list li').count(), 60, 'list capped');
    await tl.locator('.kg-timeline-list button').first().click();
    await page.getByTestId('kg-claim-details').waitFor();
    ok((await page.getByTestId('kg-claim-details').innerText()).includes('1900-01-01'), 'timeline item → claim details');
    await searchAndOpen(page, 'Globex');
    await page.getByRole('tab', { name: 'Chronologie' }).click();
    await tl.waitFor();
    ok((await tl.innerText()).includes('2 sans date'), 'undated claims counted, not placed');
    // filters: person only, then disputed only
    await searchAndOpen(page, 'Acme Industries');
    await page.getByRole('button', { name: 'Filtres' }).click();
    await page.getByRole('group', { name: 'Types d’entité' }).getByLabel('personne').check();
    ok(await until(async () => !(await domHas(page, '>Nantes<'))), 'type filter applied (Nantes gone)');
    ok(await node(page, 'Alice Martin').isVisible(), 'persons kept');
    await page.getByRole('group', { name: 'Types d’entité' }).getByLabel('personne').uncheck();
    // source filter: only what the "Registre des sociétés" supports
    const sourcesGroup = page.getByRole('group', { name: 'Sources' });
    ok(!(await sourcesGroup.innerText()).includes('Carnet confidentiel'), 'no private source offered by default');
    await sourcesGroup.getByLabel('Registre des sociétés').check();
    ok(await until(async () => (await page.locator(`[data-edge-id="clm:${world.claims.aliceCeo}"]`).count()) === 0 && (await page.locator(`[data-edge-id="clm:${world.claims.bobCeo}"]`).count()) === 1), 'source filter applied');
    await sourcesGroup.getByLabel('Registre des sociétés').uncheck();
    ok(await until(async () => (await page.locator(`[data-edge-id="clm:${world.claims.aliceCeo}"]`).count()) === 1), 'source filter removed');
    await page.getByLabel('Valide après').fill('2011-01-01');
    await page.getByLabel('avant', { exact: true }).fill('2012-01-01');
    await page.getByLabel('garder les affirmations sans date').uncheck();
    ok(await until(async () => (await page.locator(`[data-edge-id="clm:${world.claims.aliceCeo}"]`).count()) === 1 && (await page.locator(`[data-edge-id="clm:${world.claims.bobCeo}"]`).count()) === 0), 'date filter applied');
    await ctx.close();
  }

  // ── keyboard, focus visible, ARIA, zoom / pan ──
  {
    const { ctx, page } = await openPage();
    await searchAndOpen(page, 'Acme Industries');
    const svg = page.locator('svg.kg-svg');
    eq(await svg.getAttribute('role'), 'application', 'graph widget role');
    ok((await svg.getAttribute('aria-label')).includes('Flèches'), 'keyboard help in the accessible name');
    eq(await page.locator('[data-node-id][tabindex="0"]').count(), 1, 'roving tabindex');
    await page.locator('[data-node-id][tabindex="0"]').focus();
    const first = await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'));
    ok(first, 'a node has the focus');
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement.querySelector('.kg-node-ring')).stroke);
    ok(ring && ring !== 'transparent' && ring !== 'none' && !ring.includes('rgba(0, 0, 0, 0)'), `focus visible (${ring})`);
    let moved = false;
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await page.keyboard.press(key);
      if (await until(() => page.evaluate(f => document.activeElement?.getAttribute('data-node-id') !== f && Boolean(document.activeElement?.getAttribute('data-node-id')), first), 1000)) { moved = true; break; }
    }
    ok(moved, 'arrow keys move between nodes');
    const focusedLabel = await page.evaluate(() => document.activeElement?.querySelector('.kg-node-label')?.textContent);
    await page.keyboard.press('Enter');
    ok(await until(async () => (await page.getByTestId('kg-entity-details').locator('.kg-details-title').innerText().catch(() => '')) === focusedLabel), 'Enter opens details');
    const tBefore = await page.locator('.kg-viewport').getAttribute('transform');
    await page.keyboard.press('+');
    ok(await until(async () => (await page.locator('.kg-viewport').getAttribute('transform')) !== tBefore), 'keyboard zoom');
    const tZoom = await page.locator('.kg-viewport').getAttribute('transform');
    await page.keyboard.press('Shift+ArrowLeft');
    ok(await until(async () => (await page.locator('.kg-viewport').getAttribute('transform')) !== tZoom), 'keyboard pan');
    await page.keyboard.press('e');
    await until(async () => !(await page.locator('.kg-busy').isVisible().catch(() => false)));
    ok(true, 'E expands without error');
    // pointer: buttons, wheel, drag
    const t1 = await page.locator('.kg-viewport').getAttribute('transform');
    await page.getByRole('button', { name: 'Zoom arrière' }).click();
    ok((await page.locator('.kg-viewport').getAttribute('transform')) !== t1, 'zoom button');
    const box = await page.locator('.kg-canvas').boundingBox();
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.wheel(0, -300);
    const t2 = await page.locator('.kg-viewport').getAttribute('transform');
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 90, { steps: 5 });
    await page.mouse.up();
    ok((await page.locator('.kg-viewport').getAttribute('transform')) !== t2, 'drag pans');
    await page.getByRole('button', { name: 'Ajuster à la vue' }).click();
    // ARIA structure
    ok(await page.getByRole('search').isVisible(), 'search landmark');
    ok(await page.getByRole('toolbar', { name: 'Commandes du graphe' }).isVisible(), 'toolbar');
    ok(await page.getByRole('tablist', { name: 'Panneau' }).isVisible(), 'tabs');
    eq(await page.locator('[data-node-id][role="button"][aria-label]').count(), await nodeCount(page), 'every node is a labelled button');
    eq(await page.locator('[data-edge-id][role="button"][aria-label]').count(), await edgeCount(page), 'every edge is a labelled button');
    // Escape closes the dialog
    await page.keyboard.press('Escape');
    ok(await until(async () => (await page.evaluate(() => window.__kg.closed)) === 1), 'Escape closes');
    await ctx.close();
  }

  // ── reduced motion ──
  {
    const motion = await openPage();
    await searchAndOpen(motion.page, 'Acme Industries');
    ok((await motion.page.locator('.kg-viewport').evaluate(el => getComputedStyle(el).transitionDuration)) !== '0s', 'animated by default');
    await motion.ctx.close();
    const reduced = await openPage({ reducedMotion: 'reduce' });
    await searchAndOpen(reduced.page, 'Acme Industries');
    eq(await reduced.page.locator('.kg-viewport').evaluate(el => getComputedStyle(el).transitionDuration), '0s', 'no animation under prefers-reduced-motion');
    await reduced.ctx.close();
  }

  // ── responsive ──
  for (const viewport of [{ width: 1400, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    const { ctx, page } = await openPage({ viewport });
    await searchAndOpen(page, 'Acme Industries');
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const stage = document.querySelector('.kg-stage').getBoundingClientRect();
      const side = document.querySelector('.kg-side').getBoundingClientRect();
      return { overflowX: document.documentElement.scrollWidth > window.innerWidth + 1, dialogFits: dialog.getBoundingClientRect().width <= window.innerWidth, stageH: stage.height, stageW: stage.width, stacked: side.top >= stage.bottom - 1 };
    });
    ok(!layout.overflowX && layout.dialogFits, `no horizontal overflow at ${viewport.width}px`);
    ok(layout.stageH >= 250 && layout.stageW >= 300, `usable canvas at ${viewport.width}px (${Math.round(layout.stageW)}×${Math.round(layout.stageH)})`);
    eq(layout.stacked, viewport.width < 900, `panels ${viewport.width < 900 ? 'stacked' : 'side by side'} at ${viewport.width}px`);
    await ctx.close();
  }

  // ── KG-CERT: hostile content is inert text; a javascript: source URL is blocked by the Media Reader classifier ──
  {
    const { ctx, page } = await openPage();
    await searchAndOpen(page, 'Mallory', { label: 'Mallory' });
    await page.locator(`[data-edge-id="clm:${xssClaim}"]`).click({ force: true });
    await page.getByTestId('kg-claim-details').waitFor();
    ok((await page.getByTestId('kg-claim-details').innerText()).includes('<svg onload'), 'hostile evidence rendered as text');
    ok(await domHas(page, '&lt;img src=x onerror'), 'hostile label escaped in the DOM');
    await page.getByTestId('kg-claim-details').getByRole('button', { name: /^Ouvrir la source/ }).first().click();
    ok(await until(async () => (await page.evaluate(() => window.__kg.opened.length)) > 0, 5000), 'source URL handed to the reader');
    const opened = await page.evaluate(() => window.__kg.opened);
    eq(opened[0].url, 'javascript:window.__xss=3', 'the stored URL is passed as data');
    eq(opened[0].blocked, 'dangerous_scheme', 'javascript: is blocked by the Media Reader classifier');
    await sleep(200);
    eq(await page.evaluate(() => window.__xss ?? null), null, 'no injected script ran');
    eq(await page.locator('img[src="x"], [onerror], [onload]').count(), 0, 'no injected element / handler in the DOM');
    ok(page.url().endsWith('/__kg'), 'no navigation');
    await ctx.close();
  }

  // ── KG disabled at boot (uncertified) ──
  {
    const { ctx, page } = await openPage({ route: () => disabledApi });
    await page.getByLabel('Rechercher une entité').fill('Acme');
    await page.getByRole('button', { name: 'Rechercher' }).click();
    await page.getByTestId('kg-disabled').waitFor();
    ok((await page.getByTestId('kg-disabled').innerText()).includes('KG-CERT'), 'disabled state explained');
    await ctx.close();
  }

  eq(net.errors.length, 0, `no page error ${JSON.stringify(net.errors)}`);
  eq(net.external.length, 0, 'no external network');
  eq(net.foreign.length, 0, `no non-KG API call ${JSON.stringify(net.foreign)}`);
  eq(store.db.prepare('SELECT total_changes() AS n').get().n, writesBefore, 'the UI never wrote anything');
  ok(net.calls.every(c => c.startsWith('POST /api/kg/view/') || c === 'POST /api/kg/search'), 'only read-only KG calls');
} catch (error) {
  failed = error;
} finally {
  await browser.close();
  await server.close();
  store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
console.log(`# KG-6 expansion samples (ms): ${JSON.stringify(metrics.expand)}`);
console.log(`# KG-6 UI: initial display median ${med(metrics.initial)} ms (max ${Math.max(...metrics.initial)}), expansion median ${med(metrics.expand)} ms (max ${Math.max(0, ...metrics.expand)}), max rendered ${metrics.maxNodes} nodes / ${metrics.maxEdges} edges, long tasks ${JSON.stringify(metrics.longTasks ?? [])}, interaction at the render cap ${metrics.capInteractionMs} ms`);
if (failed) { console.error(failed); console.log("calls:", net.calls.slice(-8), "errors:", net.errors); console.log(`FAIL after ${assertions} assertions`); process.exit(1); }
console.log(`PASS ${assertions} assertions`);
