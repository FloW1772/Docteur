// Professeur V2 (PROF-5) — Sport Coach in the REAL TeacherModal: profile form, field errors, pain stop, program
// preview, workout module (theory + SELF_REPORTED practice), equipment honoured, mobile layout.
// Real Hono teacher route in-process, in-memory SQLite (never the real DB), scripted local model, no network.
// Usage: node scripts/test-teacher-sport-browser.mjs
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
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-sport-ui' });
const model = { program: null };
const ollamaClient = {
  chat: async ({ messages }) => {
    const p = messages.map(m => m.content).join('\n');
    if (p.includes('modèles de séance')) return { message: { content: model.program ?? 'pas de JSON' } };
    if (p.includes('Explique la séance suivante')) return { message: { content: '## Objectif\n\nRenforcer le corps entier. Vise un **RPE 6**.\n\nQuestion : que veut dire RPE 6 ?' } };
    if (p.includes('évalue la partie THÉORIE')) return { message: { content: JSON.stringify({ passed: true, score: 88, criteria: [{ name: 'RPE', met: true }], feedback: 'Exact.' }) } };
    return { message: { content: 'ok' } };
  },
};
const teacher = createTeacherRoute({ services: {}, ollamaClient, logger: null });
const serverPaths = async () => (await (await teacher.request('/teacher/paths')).json()).paths;
const serverPath = async (id) => (await (await teacher.request(`/teacher/paths/${id}`)).json());

const PORT = 5249;
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
  await page.goto(`http://127.0.0.1:${PORT}/__teacher`);
  await page.getByText('APPRENDS-MOI…').waitFor({ timeout: 30_000 });
  return { ctx, page };
}

let failed = null;
let page;
try {
  ({ page } = await openPage({ width: 1400, height: 1000 }));
  const T = (id) => page.locator(`[data-testid="${id}"]`);
  const attr = (id, name) => T(id).first().getAttribute(name);

  // ── standard course stays the default; Sport Coach is a separate tab ──
  check(await page.getByText('APPRENDS-MOI…').isVisible(), 'course creation by default');
  await T('teacher-mode-sport').click();
  await T('sport-form').waitFor();
  eq(await page.getByText('APPRENDS-MOI…').count(), 0, 'course form hidden in sport mode');
  check((await T('sport-form').innerText()).includes('ni un médecin ni un kinésithérapeute'), 'scope stated once');
  eq(await T('sport-equipment-aucun').isChecked(), true, 'no equipment by default');

  // ── invalid input → readable field errors, nothing created ──
  await T('sport-minutes').fill('999');
  await T('sport-create').click();
  check(await until(async () => (await T('sport-field-errors').count()) === 1), 'field errors shown');
  check((await T('sport-field-errors').innerText()).includes('Durée par séance'), 'field named');
  eq((await serverPaths()).length, 0, 'nothing created');
  await T('sport-minutes').fill('30');

  // ── high pain → stop + professional, nothing created ──
  await T('sport-pain-present').check();
  await T('sport-pain-area-genou').check();
  await T('sport-pain-intensity').fill('8');
  await T('sport-create').click();
  check(await until(async () => (await T('sport-pain-stop').count()) === 1), 'pain stop message');
  check((await T('sport-pain-stop').innerText()).includes('professionnel de santé'), 'professional advice');
  eq((await serverPaths()).length, 0, 'no program with high pain');

  // ── mild knee pain + dumbbells: program built, knee spared, dumbbells used, no barbell ──
  await T('sport-pain-intensity').fill('3');
  await T('sport-equipment-halteres').check();
  eq(await T('sport-equipment-aucun').isChecked(), false, '"aucun" unticked when gear is picked');
  await T('sport-level').selectOption('intermediaire');
  await T('sport-goal').selectOption('force');
  await T('sport-create').click();
  await T('sport-preview').waitFor();
  eq(await attr('sport-preview', 'data-source'), 'catalog', 'invalid model output → catalog program');
  eq(await page.locator('[data-testid="sport-preview-session"]').count(), 8, '2 sessions × 4 weeks');
  check((await T('sport-notice').innerText()).includes('Genou'), 'one calm notice about the spared area');
  const created = (await serverPaths())[0];
  const program = (await serverPath(created.id)).path.profile.program;
  const exercises = program.sessions.flatMap(s => s.exercises);
  check(!exercises.some(e => e.areas.includes('genou')), 'no knee-loading exercise');
  check(exercises.some(e => e.equipment.includes('halteres')), 'dumbbells used');
  check(!exercises.some(e => e.equipment.includes('barre')), 'no barbell');
  check(exercises.every(e => e.rpe <= 8), 'intermediate intensity cap');

  // ── start: workout module, theory lesson, SELF_REPORTED practice only ──
  await T('sport-start').click();
  await T('teacher-v2-lesson').waitFor();
  check(await until(async () => (await T('workout-view').count()) === 1), 'workout view in Practice');
  const rows = page.locator('[data-testid="workout-exercise"]');
  eq(await rows.count(), program.sessions[0].exercises.length, 'every exercise listed');
  check((await rows.first().locator('[data-testid="workout-dose"]').innerText()).includes('×'), 'sets × reps/duration');
  check((await rows.first().locator('[data-testid="workout-rpe"]').innerText()).startsWith('RPE'), 'RPE shown');
  check((await T('workout-warmup').innerText()).includes('ÉCHAUFFEMENT') && (await T('workout-cooldown').innerText()).includes('RETOUR AU CALME'), 'warm-up and cool-down');
  eq(await T('practice-mode-deliverable').count(), 0, 'no "deliverable" pseudo-verification for a physical session');
  check(await until(async () => (await T('theory-content').innerText()).includes('RPE 6')), 'session theory lesson');
  await T('theory-answer').fill('Un effort modéré, je peux encore parler.');
  await T('theory-submit').click();
  check(await until(async () => (await attr('track-theory', 'data-state')) === 'PASSED'), 'theory PASSED');
  const boxes = page.locator('[data-testid^="practice-check-"]');
  eq(await boxes.count(), program.sessions[0].exercises.length + 2, 'checklist: warm-up + exercises + cool-down');
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check();
  await T('practice-submit').click();
  check(await until(async () => (await attr('track-practice', 'data-state')) === 'PASSED'), 'session declared done');
  eq(await page.locator('[data-testid="track-practice"] [data-testid="evidence-label"]').getAttribute('data-evidence'), 'SELF_REPORTED');
  await T('advance-button').click();
  check(await until(async () => (await T('module-title').innerText()).startsWith('Module 2 / 8')), 'next session unlocked');
  await page.getByRole('button', { name: 'Retour à la liste' }).click();
  check(await until(async () => (await T('teacher-path-sport-badge').count()) === 1), 'Sport Coach badge in the list');

  // ── mobile: form usable, workout readable in the Practice tab ──
  const mobile = await openPage({ width: 390, height: 844 });
  const M = (id) => mobile.page.locator(`[data-testid="${id}"]`);
  await M('teacher-mode-sport').click();
  await M('sport-form').waitFor();
  check(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile form: no horizontal scroll');
  await mobile.page.getByText('Sport Coach — Force').first().click();
  await M('teacher-v2-lesson').waitFor();
  eq(await M('teacher-v2-lesson').getAttribute('data-layout'), 'tabs');
  await M('tab-practice').click();
  check(await until(async () => (await M('workout-view').count()) === 1), 'mobile workout view');
  check(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile workout: no horizontal scroll');
  await mobile.ctx.close();

  eq(net.errors.length, 0, `page errors: ${net.errors.join(' | ')}`);
  eq(net.external.length, 0, `external: ${net.external.join(' | ')}`);
} catch (err) {
  failed = err;
  if (process.env.SPORT_DEBUG && page) { try { console.error((await page.locator('body').innerText()).slice(0, 2500)); } catch { /* debug only */ } }
} finally {
  await browser.close();
  await server.close();
}
if (failed) { console.error(`FAIL after ${assertions} assertions:`, failed.message); process.exit(1); }
console.log(`PROF-5 sport browser: ${assertions}/${assertions} assertions PASS`);
