// Professeur V2 (PROF-4) — REAL TeacherModal: targeted remediation, attempt history, page reload + reopen, read-only
// navigation to finished modules, completed parcours review, mobile layout. Real Hono teacher route in-process on an
// in-memory SQLite (never the real DB), scripted local model (strict local, no network).
// Usage: node scripts/test-teacher-prof4-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { initSqlite, setRouterSettings } from '../cortex-server/src/lib/sqlite.js';
import { createTeacherRoute } from '../cortex-server/src/routes/teacher.js';

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }

initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-prof4-ui' });
const PLAN = JSON.stringify([{ title: 'Chaleur', summary: 'c' }, { title: 'Transferts', summary: 't' }]);
const SPEC = JSON.stringify({ kind: 'exercise', instructions: 'Compare deux cuillères.', checklist: ['Cuillère métal touchée', 'Cuillère bois touchée'], rubric: [] });
const verdict = (answer) => {
  if (/BONNE/.test(answer)) return { passed: true, score: 90, criteria: [{ name: 'Idée clé', met: true }], feedback: 'Acquis.' };
  if (/SANSREM/.test(answer)) return { passed: false, score: 30, criteria: [{ name: 'Distinction état / transfert', met: false, comment: 'non faite' }], feedback: 'Pas encore.' };
  return { passed: false, score: 20, criteria: [{ name: 'Idée clé', met: false }], feedback: 'À revoir.', remediation: { focus: 'Chaleur ≠ température', why: 'Tu décris un état au lieu d’un transfert.', retry: 'Explique ce qui se passe quand tu touches une casserole chaude.' } };
};
const ollamaClient = {
  chat: async ({ messages }) => {
    const p = messages.map(m => m.content).join('\n');
    if (p.includes("plan d'apprentissage")) return { message: { content: PLAN } };
    if (p.includes('partie PRATIQUE du module')) return { message: { content: SPEC } };
    if (p.includes('évalue la partie THÉORIE')) return { message: { content: JSON.stringify(verdict(p.split("Réponse de l'apprenant")[1] ?? '')) } };
    if (p.includes('évalue la partie PRATIQUE')) return { message: { content: JSON.stringify(verdict(p.split('Livrable de l')[1] ?? '')) } };
    return { message: { content: 'Leçon du module.\n\nQuestion : reformule.' } };
  },
};
const teacher = createTeacherRoute({ services: {}, ollamaClient, logger: null });
const serverPath = async () => (await (await teacher.request('/teacher/paths')).json()).paths[0];

const PORT = 5248;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/teacher-v2-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-teacher-v2', plugins: [react()], optimizeDeps: { entries: ['scripts/teacher-v2-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { errors: [], external: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };

async function openPage(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (!u.pathname.startsWith('/api/teacher/')) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' });
    const res = await teacher.request(`${u.pathname.replace(/^\/api/, '')}${u.search}`, { method: req.method(), headers: { 'content-type': 'application/json' }, ...(req.postData() ? { body: req.postData() } : {}) });
    return route.fulfill({ status: res.status, contentType: 'application/json', headers: cors, body: await res.text() });
  });
  await ctx.route('**/__teacher', r => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  return { ctx, page };
}

let failed = null;
let page;
try {
  ({ page } = await openPage({ width: 1400, height: 1000 }));
  const T = (id) => page.locator(`[data-testid="${id}"]`);
  const attr = (id, name) => T(id).first().getAttribute(name);
  const load = async () => { await page.goto(`http://127.0.0.1:${PORT}/__teacher`); await page.getByText('APPRENDS-MOI…').waitFor({ timeout: 30_000 }); };
  const items = (track) => page.locator(`[data-testid="history-${track}"] [data-testid="history-item"]`);
  const openHistory = async (track) => { const d = T(`history-${track}`); if (!(await d.evaluate(el => el.open))) await d.locator('summary').click(); };
  const statuses = async (track) => items(track).evaluateAll(els => els.map(e => `${e.dataset.index}:${e.dataset.status}`));

  await load();
  await page.getByPlaceholder('ex: les bases de la thermodynamique').fill('Chaleur');
  await page.getByRole('button', { name: 'Créer le plan' }).click();
  await page.getByRole('button', { name: 'Commencer' }).click();
  await T('teacher-v2-lesson').waitFor();
  check(await until(async () => (await attr('practice-spec', 'data-generated')) === 'true'), 'exercise generated');

  // ── theory fail (model remediation) ──
  await T('theory-answer').fill('la chaleur c’est la température');
  await T('theory-submit').click();
  check(await until(async () => (await attr('track-theory', 'data-state')) === 'REMEDIATION'), 'theory → REMEDIATION');
  const rem = page.locator('[data-testid="track-theory"] [data-testid="remediation"]');
  eq(await rem.getAttribute('data-source'), 'model');
  eq(await rem.locator('[data-testid="remediation-focus"]').innerText(), 'Chaleur ≠ température', 'what to rework');
  check((await rem.innerText()).includes('Tu décris un état'), 'why');
  check((await rem.locator('[data-testid="remediation-retry"]').innerText()).includes('casserole'), 'targeted retry');
  check((await page.getByText('NOUVELLE RÉPONSE (REMÉDIATION)').count()) === 1, 'targeted new attempt offered');
  eq(await attr('track-practice', 'data-state'), 'ACTIVE', 'practice untouched by theory failure');
  check(await until(async () => (await items('theory').count()) === 1), 'history: 1 theory attempt');

  // ── theory fail without model remediation → deterministic one ──
  await T('theory-answer').fill('SANSREM');
  await T('theory-submit').click();
  check(await until(async () => (await items('theory').count()) === 2), 'history: 2 theory attempts');
  eq(await rem.getAttribute('data-source'), 'criteria', 'deterministic remediation from unmet criteria');
  eq(await rem.locator('[data-testid="remediation-focus"]').innerText(), 'Distinction état / transfert');

  // ── theory pass ──
  await T('theory-answer').fill('BONNE : la chaleur est un transfert d’énergie');
  await T('theory-submit').click();
  check(await until(async () => (await attr('track-theory', 'data-state')) === 'PASSED'), 'theory PASSED after remediation');
  eq(await rem.count(), 0, 'no remediation on a passing verdict');
  check(await until(async () => (await items('theory').count()) === 3), 'history: 3 theory attempts');
  await openHistory('theory');
  eq((await statuses('theory')).join(','), '1:failed,2:failed,3:passed', 'ordered, numbered history');
  check((await items('theory').nth(0).innerText()).includes('« la chaleur c’est la température »'), 'learner submission shown');
  check(!(await T('history-theory').innerText()).includes('not_json'), 'no internal code');
  const passedText = await T('theory-passed').innerText();

  // ── practice partial self-report → checklist remediation; theory kept ──
  await T('practice-mode-self_report').click();
  await T('practice-check-0').check();
  await T('practice-submit').click();
  check(await until(async () => (await attr('track-practice', 'data-state')) === 'REMEDIATION'), 'practice → REMEDIATION');
  const prem = page.locator('[data-testid="track-practice"] [data-testid="remediation"]');
  eq(await prem.getAttribute('data-source'), 'checklist');
  eq(await prem.locator('[data-testid="remediation-focus"]').innerText(), 'Cuillère bois touchée', 'exactly the unchecked point');
  eq(await attr('track-theory', 'data-state'), 'PASSED', 'theory still PASSED');
  eq(await T('theory-passed').innerText(), passedText, 'theory passedAt unchanged');
  eq(await T('advance-button').isDisabled(), true, 'gate closed');

  // ── page reload + reopen: everything restored ──
  await load();
  await page.getByText('Chaleur').first().click();
  await T('teacher-v2-lesson').waitFor();
  eq(await attr('track-theory', 'data-state'), 'PASSED', 'reload: theory');
  eq(await attr('track-practice', 'data-state'), 'REMEDIATION', 'reload: practice');
  eq(await T('theory-passed').innerText(), passedText, 'reload: passedAt');
  check(await until(async () => (await items('theory').count()) === 3 && (await items('practice').count()) === 1), 'reload: history');
  eq(await prem.locator('[data-testid="remediation-focus"]').innerText(), 'Cuillère bois touchée', 'reload: remediation');

  // ── practice pass, advance, read-only consultation of module 1 ──
  await T('practice-mode-self_report').click();
  await T('practice-check-0').check();
  await T('practice-check-1').check();
  await T('practice-submit').click();
  check(await until(async () => (await attr('track-practice', 'data-state')) === 'PASSED'), 'practice PASSED');
  await T('advance-button').click();
  check(await until(async () => (await T('module-title').innerText()).startsWith('Module 2 / 2')), 'module 2');
  eq((await serverPath()).current_step_index, 1);
  await page.locator('[data-testid="module-pill"][data-step-index="0"]').click();
  check(await until(async () => (await T('module-title').innerText()).startsWith('Module 1 / 2')), 'viewing module 1');
  eq(await attr('teacher-v2-lesson', 'data-read-only'), 'true');
  check(await T('review-banner').isVisible(), 'read-only banner');
  eq(await T('theory-answer').count(), 0, 'no theory input when viewing');
  eq(await T('practice-submit').count(), 0, 'no practice input when viewing');
  eq(await T('advance-button').count(), 0, 'no advance when viewing');
  check(await until(async () => (await items('theory').count()) === 3 && (await items('practice').count()) === 2), 'module 1 history while viewing');
  eq((await serverPath()).current_step_index, 1, 'viewing never moved the server pointer');
  eq(await page.locator('[data-testid="module-pill"][data-step-index="1"]').isDisabled(), false);
  await T('back-to-current').click();
  check(await until(async () => (await T('module-title').innerText()).startsWith('Module 2 / 2')), 'back to current module');
  eq(await attr('teacher-v2-lesson', 'data-read-only'), 'false');

  // ── finish; completed parcours review ──
  check(await until(async () => (await T('theory-answer').count()) === 1), 'module 2 theory input ready');
  await T('theory-answer').fill('BONNE conduction');
  await T('theory-submit').click();
  check(await until(async () => (await attr('track-theory', 'data-state')) === 'PASSED'), 'module 2 theory');
  await T('practice-mode-self_report').click();
  await T('practice-check-0').check();
  await T('practice-check-1').check();
  await T('practice-submit').click();
  check(await until(async () => (await T('advance-button').innerText()).includes('Terminer')), 'finish label');
  await T('advance-button').click();
  check(await until(async () => (await page.getByText('Parcours terminé — Chaleur').count()) > 0), 'completed');
  check(await until(async () => (await T('review-banner').count()) === 1), 'completed parcours: review view');
  eq(await T('advance-button').count(), 0);
  eq(await T('theory-answer').count(), 0);
  await page.locator('[data-testid="module-pill"][data-step-index="0"]').click();
  check(await until(async () => (await T('module-title').innerText()).startsWith('Module 1 / 2') && (await items('theory').count()) === 3), 'completed: module 1 + history readable');
  eq((await serverPath()).status, 'completed');

  // ── mobile: tabs, states distinct, history reachable ──
  const mobile = await openPage({ width: 390, height: 844 });
  await mobile.page.goto(`http://127.0.0.1:${PORT}/__teacher`);
  await mobile.page.getByText('APPRENDS-MOI…').waitFor({ timeout: 30_000 });
  await mobile.page.getByText('Chaleur').first().click();
  const M = (id) => mobile.page.locator(`[data-testid="${id}"]`);
  await M('teacher-v2-lesson').waitFor();
  eq(await M('teacher-v2-lesson').getAttribute('data-layout'), 'tabs', 'mobile: tabs');
  await M('tab-practice').click();
  check(await until(async () => (await mobile.page.locator('[data-testid="history-practice"] [data-testid="history-item"]').count()) >= 1), 'mobile: practice history');
  check(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile: no horizontal scroll');
  await mobile.ctx.close();

  eq(net.errors.length, 0, `page errors: ${net.errors.join(' | ')}`);
  eq(net.external.length, 0, `external: ${net.external.join(' | ')}`);
} catch (err) {
  failed = err;
  if (process.env.PROF4_DEBUG && page) { try { console.error((await page.locator('body').innerText()).slice(0, 2000)); } catch { /* debug only */ } }
} finally {
  await browser.close();
  await server.close();
}
if (failed) { console.error(`FAIL after ${assertions} assertions:`, failed.message); process.exit(1); }
console.log(`PROF-4 browser: ${assertions}/${assertions} assertions PASS`);
