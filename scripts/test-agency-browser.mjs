// Agency V1 — REAL AgencyStudioModal against the REAL agency route + service, in-process, on an
// in-memory SQLite (never the real DB), scripted model (no network, no Ollama).
// Usage: node scripts/test-agency-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { initSqlite } from '../cortex-server/src/lib/sqlite.js';
import { createAgencyService } from '../cortex-server/src/lib/agency.js';
import { createAgencyStore } from '../cortex-server/src/lib/agency-store.js';
import { createAgencyRoute } from '../cortex-server/src/routes/agency.js';

let assertions = 0;
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(60); } return false; }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

initSqlite(':memory:');
// Scripted model, steered by markers in the objective.
const gates = new Map();
const calls = [];
const saved = [];
const complete = async ({ messages, strictLocal, purpose }) => {
  const prompt = messages.at(-1).content;
  calls.push({ purpose, strictLocal });
  if (purpose === 'agency_plan') {
    if (prompt.includes('PLANNER_DOWN')) throw new Error('ECONNREFUSED 127.0.0.1:11434');
    return { text: JSON.stringify({ tasks: [
      { key: 'recherche', agent: 'researcher', title: 'Chercher dans les neurones', instructions: 'Trouver les éléments utiles.' },
      { key: 'analyse', agent: 'analyst', title: 'Analyser les tendances', instructions: 'Analyser.' },
      { key: 'plan', agent: 'writer', title: 'Rédiger le plan', instructions: 'Rédiger.', dependsOn: ['recherche', 'analyse'] },
    ] }) };
  }
  const title = prompt.match(/Ta tâche : (.+)/)?.[1]?.trim();
  if (prompt.includes('FLAKY') && title === 'Analyser les tendances' && !gates.get('flaky-fixed')) throw new Error('Ollama: model not loaded');
  if (prompt.includes('SLOW') && gates.has('slow')) await gates.get('slow').promise;
  return { text: `Résultat — ${title}`, model: 'scripted-local' };
};
const service = createAgencyService({
  store: createAgencyStore(), complete,
  searchKnowledge: async () => [{ id: 'n1', title: 'Cosmologie', excerpt: 'Notes sur Hubble.' }],
  saveOutput: async (o) => { saved.push(o); return { outputId: `out-${saved.length}` }; },
});
const api = createAgencyRoute({ service }); // a Hono app (hono lives in cortex-server)

const PORT = 5251;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/agency-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-agency', plugins: [react()], optimizeDeps: { entries: ['scripts/agency-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { errors: [], external: [], foreign: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };

async function openPage(viewport = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (!u.pathname.startsWith('/api/agency')) { net.foreign.push(u.pathname); return route.fulfill({ status: 404, headers: cors, body: '{}' }); }
    const res = await api.request(`${u.pathname.replace(/^\/api/, '')}${u.search}`, { method: req.method(), headers: { 'content-type': 'application/json' }, ...(req.postData() ? { body: req.postData() } : {}) });
    return route.fulfill({ status: res.status, contentType: 'application/json', headers: cors, body: await res.text() });
  });
  await ctx.route('**/__agency', r => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__agency`);
  await page.getByRole('dialog', { name: 'Agency' }).waitFor({ timeout: 30_000 });
  return { ctx, page };
}

const runStatus = (page) => page.locator('.agency-run-head .studio-status-label').first().innerText().catch(() => '');
const taskStatus = (page, key) => page.locator(`[data-task-key="${key}"] .studio-status-label`).innerText().catch(() => '');
async function plan(page, objective, { save = false, strict = true } = {}) {
  await page.getByLabel('Objectif').fill(objective);
  const strictBox = page.getByLabel('Strict Local (aucun cloud)');
  if ((await strictBox.isChecked()) !== strict) await strictBox.setChecked(strict);
  await page.getByLabel(/Proposer d’enregistrer la synthèse/).setChecked(save);
  await page.getByRole('button', { name: 'Planifier' }).click();
  ok(await until(async () => (await runStatus(page)) === 'Plan prêt'), `plan ready for "${objective}"`);
}

let failed = null;
try {
  const { ctx, page } = await openPage();
  ok(await page.getByText(/Formulez un objectif/).isVisible(), 'empty state');
  await page.getByLabel('Objectif').fill('court');
  ok(await page.getByRole('button', { name: 'Planifier' }).isDisabled(), 'objective validated before sending');
  ok(await page.getByLabel('Strict Local (aucun cloud)').isChecked(), 'Strict Local checked by default');

  // ── 1. Multi-agent run with approval ────────────────────────────────────────────
  await plan(page, 'Préparer une synthèse cosmologie avec enregistrement', { save: true });
  const tasks = page.locator('.agency-task');
  eq(await tasks.count(), 5, 'plan: 3 planned tasks + synthesis + save proposal');
  ok((await page.locator('[data-task-key="recherche"] .agency-task-meta').innerText()).includes('Agent : Chercheur · Outils : knowledge.search, ai.reason'), 'agent + tools shown');
  ok((await page.locator('[data-task-key="plan"] .agency-task-meta').innerText()).includes('Dépend de : Chercher dans les neurones, Analyser les tendances'), 'dependencies shown');
  eq(await taskStatus(page, 'plan'), 'Attend ses dépendances');
  ok((await page.locator('.agency-run-head').innerText()).includes('Strict Local'), 'Strict Local badge');
  await page.getByRole('button', { name: 'Démarrer' }).click();
  const approval = page.getByRole('region', { name: 'Approbation requise' });
  await approval.waitFor({ timeout: 15_000 });
  ok((await approval.innerText()).includes('Résultat — Synthèse finale'), 'approval shows the exact content to save');
  eq(saved.length, 0, 'nothing saved before approval');
  eq(await runStatus(page), 'Approbation requise');
  const bar = page.locator('.agency-progress [role="progressbar"]');
  eq(await bar.getAttribute('aria-valuenow'), '4', 'progress 4/5');
  await approval.getByRole('button', { name: 'Approuver l’enregistrement' }).click();
  ok(await until(async () => (await runStatus(page)) === 'Terminé'), 'run completed after approval');
  eq(saved.length, 1, 'saved once');
  eq(saved[0].content, 'Résultat — Synthèse finale', 'exactly the approved synthesis');
  eq(await page.evaluate(() => window.__agency.imports), 1, 'UI imported the output through the existing pipeline');
  ok(await page.getByRole('region', { name: 'Synthèse finale' }).isVisible(), 'synthesis displayed');
  ok(calls.every(c => c.strictLocal === true), 'every model call Strict Local');

  // ── 2. Failure isolation + retry ────────────────────────────────────────────────
  await plan(page, 'Objectif FLAKY pour tester un échec');
  await page.getByRole('button', { name: 'Démarrer' }).click();
  ok(await until(async () => (await runStatus(page)) === 'Échec partiel'), 'run failed partially');
  eq(await taskStatus(page, 'analyse'), 'Échec');
  eq(await taskStatus(page, 'recherche'), 'Terminée', 'independent sibling completed');
  eq(await taskStatus(page, 'plan'), 'Bloquée (dépendance)');
  ok((await page.locator('[data-task-key="analyse"] .agency-task-error').innerText()).includes('model not loaded'), 'real error shown');
  gates.set('flaky-fixed', true);
  await page.locator('[data-task-key="analyse"]').getByRole('button', { name: 'Réessayer' }).click();
  ok(await until(async () => (await runStatus(page)) === 'Terminé'), 'retry completed the run');

  // ── 3. STOP during execution: final, nothing resumes ───────────────────────────
  gates.set('slow', deferred());
  await plan(page, 'Objectif SLOW pour tester STOP');
  await page.getByRole('button', { name: 'Démarrer' }).click();
  ok(await until(async () => (await taskStatus(page, 'recherche')) === 'En cours'), 'tasks running');
  const stop = page.locator('.agency-actions').getByRole('button', { name: 'STOP' });
  await stop.focus();
  await page.keyboard.press('Enter');
  ok(await until(async () => (await runStatus(page)) === 'Arrêté (STOP)'), 'STOP applied (keyboard)');
  gates.get('slow').resolve();
  await sleep(1_800);
  eq(await runStatus(page), 'Arrêté (STOP)', 'stays stopped after the model answers');
  for (const key of ['recherche', 'analyse', 'plan', 'synthese']) eq(await taskStatus(page, key), 'Révoquée', `${key} revoked`);
  eq(await page.getByRole('button', { name: /Démarrer|Reprendre|Réessayer/ }).count(), 0, 'no way to resume a STOPPED run');
  eq(await page.locator('.agency-actions').getByRole('button', { name: 'STOP' }).count(), 0);

  // ── 4. Global STOP + planner failure fallback ───────────────────────────────────
  await plan(page, 'Objectif PLANNER_DOWN avec plan de secours');
  ok((await page.getByRole('note').filter({ hasText: 'Plan de secours' }).innerText()).includes('planner_failed'), 'fallback plan explained');
  await page.getByRole('button', { name: 'STOP — tout arrêter' }).click();
  ok(await until(async () => (await runStatus(page)) === 'Arrêté (STOP)'), 'global STOP stopped the queued run');
  ok(await page.getByText(/STOP : \d+ exécution\(s\) arrêtée\(s\)/).isVisible());

  // ── 5. Reload: state rebuilt from the server ────────────────────────────────────
  await page.reload();
  await page.getByRole('dialog', { name: 'Agency' }).waitFor();
  const items = page.locator('.agency-run-item');
  ok(await until(async () => (await items.count()) === 4), 'runs listed after reload');
  await items.filter({ hasText: 'synthèse cosmologie' }).click();
  ok(await until(async () => (await runStatus(page)) === 'Terminé'), 'completed run restored');
  eq(await page.locator('.agency-task').count(), 5);
  eq(await page.locator('[aria-current="true"]').count(), 1, 'selected run marked for assistive tech');
  await ctx.close();

  // ── 6. Mobile width: usable, no horizontal scroll ───────────────────────────────
  const mobile = await openPage({ width: 375, height: 800 });
  const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `no horizontal scroll at 375 px (overflow ${overflow})`);
  ok(await mobile.page.getByRole('button', { name: 'STOP — tout arrêter' }).isVisible(), 'STOP visible on mobile');
  await mobile.ctx.close();

  eq(net.errors.length, 0, `no page errors: ${net.errors.join(' | ')}`);
  eq(net.external.length, 0, 'no external request');
  eq(net.foreign.length, 0, `only /api/agency called: ${net.foreign.join(', ')}`);
} catch (error) {
  failed = error;
} finally {
  await service.idle().catch(() => {});
  await browser.close();
  await server.close();
}
if (failed) throw failed;
console.log(`AGENCY_BROWSER_PASS assertions=${assertions}`);
