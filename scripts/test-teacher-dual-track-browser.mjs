// Professeur V2 (PROF-3) — REAL TeacherModal in Chromium, wired to the REAL Hono teacher route running in this process
// on an in-memory SQLite (never the real database) with a scripted local model (strict local mode: no network).
// Every /api/teacher/** request from the page is answered by createTeacherRoute(); anything else is refused/stubbed.
// Usage: node scripts/test-teacher-dual-track-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { initSqlite, setRouterSettings, updateLearningPathStep, getStepsByPathId } from '../cortex-server/src/lib/sqlite.js';
import { createTeacherRoute } from '../cortex-server/src/routes/teacher.js';

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15_000, step = 50) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(step); } return false; }

// ── the real database must not be touched by this suite ────────────────────────────────────────────────────────────
const DATA_DIR = path.resolve('cortex-server/data');
const realDbFiles = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).filter(f => f.startsWith('cortex.sqlite')) : [];
const hashFile = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DATA_DIR, f))).digest('hex');
const realDbBefore = Object.fromEntries(realDbFiles.map(f => [f, hashFile(f)]));

// ── backend: real route, in-memory DB, scripted model ─────────────────────────────────────────────────────────────
initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-local-model' });
const PLAN = JSON.stringify([{ title: 'Chaleur et température', summary: 'Distinguer les deux notions' }, { title: 'Transferts', summary: 'Conduction, convection, rayonnement' }]);
const SPEC = { kind: 'exercise', instructions: 'Touche une cuillère en métal et une en bois restées dans la même pièce, puis compare.', checklist: ['J’ai touché les deux cuillères', 'J’ai noté laquelle semble la plus froide'], rubric: ['Observation notée'] };
const model = { specFail: false, calls: [] };
const verdict = (passed) => JSON.stringify(passed
  ? { passed: true, score: 88, criteria: [{ name: 'Distingue chaleur et température', met: true }], feedback: 'Très bien expliqué.' }
  : { passed: false, score: 25, criteria: [{ name: 'Distingue chaleur et température', met: false, comment: 'les deux sont confondues' }], feedback: 'Reprends la différence entre énergie transférée et état.' });
const ollamaClient = {
  chat: async ({ messages }) => {
    const all = messages.map(m => m.content).join('\n');
    if (/plan d'apprentissage/.test(all)) { model.calls.push('plan'); return { message: { content: PLAN } }; }
    if (/partie PRATIQUE du module/.test(all)) { model.calls.push('spec'); return { message: { content: model.specFail ? 'désolé, pas de JSON' : JSON.stringify(SPEC) } }; }
    if (/évalue la partie THÉORIE/.test(all)) { model.calls.push('theory'); return { message: { content: verdict(/énergie/i.test(all.split('Réponse de l\'apprenant')[1] ?? '')) } }; }
    if (/évalue la partie PRATIQUE/.test(all)) { model.calls.push('practice'); return { message: { content: verdict(true) } }; }
    model.calls.push('explain');
    return { message: { content: '## Leçon\n\nLa **température** décrit un état ; la **chaleur** est une énergie transférée.\n\nQuestion : quelle est la différence entre chaleur et température ?' } };
  },
};
const teacher = createTeacherRoute({ services: {}, ollamaClient, logger: null }); // routes are '/teacher/...' (server.js mounts them under /api)

// ── frontend: vite + Chromium ─────────────────────────────────────────────────────────────────────────────────────
const PORT = 5246;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/teacher-v2-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-teacher-v2', plugins: [react()], optimizeDeps: { entries: ['scripts/teacher-v2-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { external: [], errors: [], teacherCalls: [], other: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };

async function openPage(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await page.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (!u.pathname.startsWith('/api/teacher/')) { net.other.push(u.pathname); return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' }); }
    net.teacherCalls.push(`${req.method()} ${u.pathname.replace(/[0-9a-f-]{36}/g, ':id')}`);
    const res = await teacher.request(`${u.pathname.replace(/^\/api/, '')}${u.search}`, { method: req.method(), headers: { 'content-type': 'application/json' }, ...(req.postData() ? { body: req.postData() } : {}) });
    return route.fulfill({ status: res.status, contentType: 'application/json', headers: cors, body: await res.text() });
  });
  await page.route('**/__teacher', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`http://127.0.0.1:${PORT}/__teacher`);
  await page.getByText('APPRENDS-MOI…').waitFor({ timeout: 30_000 });
  return { ctx, page };
}

const SHOTS = process.env.TEACHER_V2_SHOTS; // optional: directory for visual-check screenshots
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const T = (page, id) => page.locator(`[data-testid="${id}"]`);
const attr = (page, id, name) => T(page, id).first().getAttribute(name);
async function createAndStart(page, subject, { dual = true } = {}) {
  const toggle = T(page, 'teacher-dual-track-toggle');
  if ((await toggle.isChecked()) !== dual) await toggle.click();
  await page.getByPlaceholder('ex: les bases de la thermodynamique').fill(subject);
  await page.getByRole('button', { name: 'Créer le plan' }).click();
  await page.getByRole('button', { name: 'Commencer' }).click();
}

let failed = null;
try {
  // ═══ 1. wide viewport: creation (V2 by default), columns, lesson + generated exercise ═══════════════════════════
  const { ctx, page } = await openPage({ width: 1400, height: 950 });
  eq(await T(page, 'teacher-dual-track-toggle').isChecked(), true, 'new parcours: Théorie + Pratique by default');
  await createAndStart(page, 'Chaleur et température');
  await T(page, 'teacher-v2-lesson').waitFor();
  check(await until(async () => (await attr(page, 'teacher-v2-lesson', 'data-layout')) === 'columns'), 'two columns at 1400 px');
  check(await T(page, 'dual-track-columns').isVisible(), 'columns container visible');
  check(await until(async () => (await T(page, 'theory-content').innerText()).includes('énergie transférée')), 'lesson rendered (Markdown)');
  eq(await page.locator('[data-testid="theory-content"] strong').first().innerText(), 'température', 'Markdown bold rendered, not raw **');
  check(await until(async () => (await attr(page, 'practice-spec', 'data-generated')) === 'true'), 'practice exercise generated');
  eq(await attr(page, 'practice-spec', 'data-kind'), 'exercise');
  check((await T(page, 'practice-spec').innerText()).includes('cuillère'), 'generated instructions shown');
  eq(await attr(page, 'track-theory', 'data-state'), 'ACTIVE');
  eq(await attr(page, 'track-practice', 'data-state'), 'ACTIVE');
  eq(await T(page, 'advance-button').isDisabled(), true, 'gate closed: nothing passed');
  eq(model.calls.filter(c => c === 'spec').length, 1, 'one spec generation');

  // ═══ 2. theory: failure → REMEDIATION, practice untouched; then success ═══════════════════════════════════════════
  await T(page, 'theory-answer').fill('Chaleur et température c’est pareil.');
  await T(page, 'theory-submit').click();
  check(await until(async () => (await attr(page, 'track-theory', 'data-state')) === 'REMEDIATION'), 'theory → REMEDIATION');
  eq(await attr(page, 'verdict', 'data-tone'), 'failed');
  check((await T(page, 'track-theory').innerText()).includes('les deux sont confondues'), 'criterion comment shown');
  eq(await attr(page, 'track-practice', 'data-state'), 'ACTIVE', 'practice unaffected by a theory failure');
  await T(page, 'theory-answer').fill('La température est un état, la chaleur une énergie qui passe du chaud au froid.');
  await T(page, 'theory-submit').click();
  check(await until(async () => (await attr(page, 'track-theory', 'data-state')) === 'PASSED'), 'theory → PASSED');
  check(await T(page, 'theory-passed').isVisible(), 'theory acquired message');
  eq(await T(page, 'theory-answer').count(), 0, 'no more theory input once passed');
  eq(await T(page, 'advance-button').isDisabled(), true, 'gate still closed: practice not passed');

  // ═══ 3. practice: self-report partial → REMEDIATION (theory stays PASSED), then full ═════════════════════════════
  await T(page, 'practice-mode-self_report').click();
  check((await T(page, 'self-report-warning').innerText()).includes('ne peut pas observer'), 'self-report honesty warning');
  await T(page, 'practice-check-0').check();
  await T(page, 'practice-submit').click();
  check(await until(async () => (await attr(page, 'track-practice', 'data-state')) === 'REMEDIATION'), 'practice → REMEDIATION');
  eq(await attr(page, 'track-theory', 'data-state'), 'PASSED', 'independent remediation: theory kept');
  eq(await page.locator('[data-testid="track-practice"] [data-testid="evidence-label"]').getAttribute('data-evidence'), 'SELF_REPORTED');
  await T(page, 'practice-check-0').check();
  await T(page, 'practice-check-1').check();
  await T(page, 'practice-note').fill('fait dans la cuisine');
  await T(page, 'practice-submit').click();
  check(await until(async () => (await attr(page, 'track-practice', 'data-state')) === 'PASSED'), 'practice → PASSED');
  check((await T(page, 'practice-passed').innerText()).includes('Auto-déclaré'), 'passed practice keeps its SELF_REPORTED provenance');
  eq(await T(page, 'advance-button').isDisabled(), false, 'gate open: both passed');
  await shot(page, 'wide-both-passed');
  eq((await T(page, 'advance-button').innerText()).trim(), 'Module suivant');

  // ═══ 4. the server gate cannot be bypassed from the page ════════════════════════════════════════════════════════
  const ids = await page.evaluate(async () => {
    const list = await (await fetch('http://127.0.0.1:3001/api/teacher/paths')).json();
    const p = list.paths[0];
    const detail = await (await fetch(`http://127.0.0.1:3001/api/teacher/paths/${p.id}`)).json();
    return { pathId: p.id, step1: detail.steps.find(s => s.step_index === 1).id };
  });
  const bypass = await page.evaluate(async ({ pathId, step1 }) => {
    const r = await fetch(`http://127.0.0.1:3001/api/teacher/paths/${pathId}/steps/${step1}/advance`, { method: 'POST' });
    return { status: r.status, body: await r.json() };
  }, ids);
  eq(bypass.status, 409, 'direct /advance on a non-validated module refused');
  eq(bypass.body.code, 'TRACKS_NOT_PASSED');

  // ═══ 5. next module unlocked; deliverable path → MODEL_ASSESSED; finish ═════════════════════════════════════════
  await T(page, 'advance-button').click();
  check(await until(async () => (await T(page, 'teacher-v2-lesson').innerText()).includes('Module 2 / 2')), 'module 2 opened');
  check(await until(async () => (await attr(page, 'practice-spec', 'data-generated')) === 'true'), 'module 2 exercise generated');
  eq(await attr(page, 'track-theory', 'data-state'), 'ACTIVE');
  const pill1 = page.locator('[data-testid="module-pill"]').first();
  eq(await pill1.getAttribute('data-theory'), 'PASSED');
  eq(await pill1.getAttribute('data-practice'), 'PASSED');
  eq((await T(page, 'advance-button').innerText()).trim(), 'Valide la théorie ET la pratique pour continuer');
  await T(page, 'practice-mode-deliverable').click();
  await T(page, 'practice-deliverable').fill('Compte rendu : la cuillère en métal semble plus froide car elle conduit mieux la chaleur.');
  await T(page, 'practice-submit').click();
  check(await until(async () => (await attr(page, 'track-practice', 'data-state')) === 'PASSED'), 'deliverable → PASSED');
  eq(await page.locator('[data-testid="track-practice"] [data-testid="evidence-label"]').getAttribute('data-evidence'), 'MODEL_ASSESSED');
  await T(page, 'theory-answer').fill('Conduction : l’énergie passe de proche en proche.');
  await T(page, 'theory-submit').click();
  check(await until(async () => (await T(page, 'advance-button').innerText()).includes('Terminer le parcours')), 'last module: finish label');
  await T(page, 'advance-button').click();
  check(await until(async () => (await page.getByText('Parcours terminé').count()) > 0), 'parcours completed');
  await page.getByRole('button', { name: 'Retour à la liste' }).click();
  check(await until(async () => (await T(page, 'teacher-path-dual-badge').count()) === 1), 'V2 badge in the list');
  await ctx.close();

  // ═══ 6. narrow viewport: tabs, distinct states; spec generation failure → generic exercise kept ═════════════════
  model.specFail = true;
  const narrow = await openPage({ width: 820, height: 900 });
  await createAndStart(narrow.page, 'Électricité');
  await T(narrow.page, 'teacher-v2-lesson').waitFor();
  check(await until(async () => (await attr(narrow.page, 'teacher-v2-lesson', 'data-layout')) === 'tabs'), 'tabs under 900 px');
  eq(await T(narrow.page, 'dual-track-columns').count(), 0);
  check(await T(narrow.page, 'track-theory').isVisible(), 'theory tab shown first');
  eq(await T(narrow.page, 'track-practice').count(), 0, 'one track at a time');
  await T(narrow.page, 'tab-practice').click();
  check(await until(async () => (await T(narrow.page, 'spec-notice').count()) > 0), 'generation failure surfaced');
  eq(await attr(narrow.page, 'practice-spec', 'data-generated'), 'false', 'generic exercise kept (fail closed)');
  check(await T(narrow.page, 'spec-retry').isVisible(), 'retry offered');
  await shot(narrow.page, 'narrow-practice-generic');
  eq(await T(narrow.page, 'practice-check-0').count(), 1, 'generic checklist still usable');
  model.specFail = false;
  await T(narrow.page, 'spec-retry').click();
  check(await until(async () => (await attr(narrow.page, 'practice-spec', 'data-generated')) === 'true'), 'retry generates the exercise');
  eq(await T(narrow.page, 'spec-notice').count(), 0);
  const scroll = await narrow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(scroll, 'no horizontal page scroll at 820 px');

  // ═══ 7. server-authored expected answer never reaches the page ═════════════════════════════════════════════════
  const SECRET = 'valeur-attendue-9137';
  const pathId = (await narrow.page.evaluate(async () => (await (await fetch('http://127.0.0.1:3001/api/teacher/paths')).json()).paths.find(p => p.subject === 'Électricité').id));
  const s0 = getStepsByPathId(pathId).find(s => s.step_index === 0);
  updateLearningPathStep(s0.id, { tracks: { ...s0.tracks, practice: { ...s0.tracks.practice, spec: { kind: 'result', instructions: 'Calcule la résistance : 12 V / 2 A.', expected: SECRET } } } });
  await narrow.page.getByRole('button', { name: 'Retour à la liste' }).click();
  await narrow.page.getByText('Électricité').first().click();
  await T(narrow.page, 'tab-practice').click();
  check(await until(async () => (await attr(narrow.page, 'practice-spec', 'data-kind')) === 'result'), 'result exercise displayed');
  eq(await T(narrow.page, 'practice-mode-self_report').count(), 0, 'a checkable result cannot be self-declared');
  check(await T(narrow.page, 'practice-deliverable').isVisible(), 'result → submission field');
  check(!(await narrow.page.content()).includes(SECRET), 'expected answer absent from the DOM');
  await narrow.ctx.close();

  // ═══ 8. V1 parcours: historical single-track view, unchanged ═══════════════════════════════════════════════════
  const v1 = await openPage({ width: 1400, height: 950 });
  await createAndStart(v1.page, 'Histoire', { dual: false });
  check(await until(async () => (await v1.page.getByText('TA RÉPONSE À LA QUESTION').count()) > 0), 'V1 lesson view');
  eq(await T(v1.page, 'teacher-v2-lesson').count(), 0, 'no dual-track view for V1');
  const panelWidth = await v1.page.evaluate(() => [...document.querySelectorAll('div')].find(d => d.style.width === '820px')?.getBoundingClientRect().width ?? 0);
  eq(Math.round(panelWidth), 820, 'V1 keeps the historical 820 px panel');
  await v1.ctx.close();

  // ═══ 9. hygiene ═══════════════════════════════════════════════════════════════════════════════════════════════
  eq(net.errors.length, 0, `page errors: ${net.errors.join(' | ')}`);
  eq(net.external.length, 0, `external requests: ${net.external.join(' | ')}`);
  check(net.teacherCalls.some(c => c.endsWith('/practice/spec')), 'spec endpoint used by the UI');
  const realDbAfter = Object.fromEntries(realDbFiles.map(f => [f, hashFile(f)]));
  assert.deepEqual(realDbAfter, realDbBefore, 'real database files unchanged');
  assertions += 1;
} catch (err) {
  failed = err;
} finally {
  await browser.close();
  await server.close();
}

if (failed) {
  console.error(`FAIL after ${assertions} assertions:`, failed.message);
  process.exit(1);
}
console.log(`PROF-3 browser: ${assertions}/${assertions} assertions PASS (other API paths stubbed: ${[...new Set(net.other)].join(', ') || 'none'})`);
