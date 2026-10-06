// Professeur V2 — PROF-3R: every existing register through the REAL TeacherModal (V1 + V2, theory + practice, gate,
// page reload + reopen). Real Hono teacher route in-process, in-memory SQLite, scripted local model, no network.
// Usage: node scripts/test-teacher-prof3r-registers-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { initSqlite, setRouterSettings } from '../cortex-server/src/lib/sqlite.js';
import { createTeacherRoute } from '../cortex-server/src/routes/teacher.js';
import { TEACHER_REGISTERS, TEACHER_REGISTER_LABELS } from '../cortex-server/src/lib/teacher-register.js';

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }

initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-prof3r-ui' });
const PLAN = JSON.stringify([{ title: 'Fondations', summary: 'Les bases' }, { title: 'Application', summary: 'Appliquer' }]);
const SPEC = JSON.stringify({ kind: 'checklist', instructions: 'Applique la notion sur un cas réel.', checklist: ['Appliqué', 'Résultat noté'], rubric: [] });
const OK = JSON.stringify({ passed: true, score: 90, criteria: [{ name: 'Compréhension', met: true }], feedback: 'Acquis.' });
const prompts = [];
const ollamaClient = {
  chat: async ({ messages }) => {
    const p = messages.map(m => m.content).join('\n');
    prompts.push(p);
    if (p.includes("plan d'apprentissage")) return { message: { content: PLAN } };
    if (p.includes('partie PRATIQUE du module')) return { message: { content: SPEC } };
    if (p.includes('évalue la partie')) return { message: { content: OK } };
    if (p.includes('question de compréhension sur l\'étape')) {
      const answer = p.split('Réponse de l\'utilisateur à la dernière question :').pop();
      if (answer.includes('PANNE')) throw Object.assign(new Error('ollama down'), { code: 'ECONNREFUSED' });
      if (answer.includes('faux')) return { message: { content: 'Pas encore : reprenons la notion. Peux-tu reformuler ?' } };
      return { message: { content: 'Bonne réponse, VALIDÉ.' } };
    }
    // V1/V2 lesson: the NEXT step's explanation arrives late, so a stale callback has time to rewind the view
    const title = /Explique cette étape : "([^"]+)"/.exec(p)?.[1] ?? '';
    if (title === 'Application') await sleep(400);
    return { message: { content: `Leçon du module ${title}.\n\nQuestion : reformule.` } };
  },
};
const teacher = createTeacherRoute({ services: {}, ollamaClient, logger: null });
const serverPath = async (subject) => (await (await teacher.request('/teacher/paths')).json()).paths.find(p => p.subject === subject);

const PORT = 5247;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/teacher-v2-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-teacher-v2', plugins: [react()], optimizeDeps: { entries: ['scripts/teacher-v2-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { errors: [], external: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
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
const T = (id) => page.locator(`[data-testid="${id}"]`);
const attr = (id, name) => T(id).first().getAttribute(name);
async function load() { await page.goto(`http://127.0.0.1:${PORT}/__teacher`); await page.getByText('APPRENDS-MOI…').waitFor({ timeout: 30_000 }); }
async function create(subject, register, dual) {
  if ((await T('teacher-dual-track-toggle').isChecked()) !== dual) await T('teacher-dual-track-toggle').click();
  await page.locator('select').first().selectOption(register);
  await page.getByPlaceholder('ex: les bases de la thermodynamique').fill(subject);
  await page.getByRole('button', { name: 'Créer le plan' }).click();
  await page.getByRole('button', { name: 'Commencer' }).click();
}

let failed = null;
try {
  await load();
  for (const register of TEACHER_REGISTERS) {
    // V1 for this register: historical view, unchanged
    await create(`V1-${register}`, register, false);
    check(await until(async () => (await page.getByText('TA RÉPONSE À LA QUESTION').count()) > 0), `${register}: V1 lesson view`);
    eq(await T('teacher-v2-lesson').count(), 0, `${register}: no dual-track view for V1`);
    const v1 = () => serverPath(`V1-${register}`);
    const answerV1 = async (text) => { await page.locator('textarea').first().fill(text); await page.getByRole('button', { name: 'Envoyer' }).click(); };
    check(await until(async () => (await page.getByText('Leçon du module Fondations').count()) > 0), `${register}: V1 step 1 lesson loaded`);

    // not validated → same step, server unchanged
    await answerV1('réponse faux');
    check(await until(async () => (await page.getByText('Pas encore : reprenons').count()) > 0), `${register}: V1 not-validated feedback shown`);
    eq((await v1()).current_step_index, 0, `${register}: V1 not validated → backend stays on step 1`);
    check((await page.getByText('Étape 1 / 2').count()) === 1, `${register}: V1 not validated → UI stays on step 1`);

    // provider failure → error shown, no progression
    await answerV1('PANNE');
    check(await until(async () => (await page.getByText('ollama down').count()) > 0), `${register}: V1 provider failure surfaced`);
    eq((await v1()).current_step_index, 0, `${register}: V1 provider failure → no backend progression`);
    check((await page.getByText('Étape 1 / 2').count()) === 1, `${register}: V1 provider failure → UI stays on step 1`);

    // VALIDÉ → backend N+1 → UI N+1 → explanation N+1 arrives → UI STILL N+1 (the stale-state regression)
    await answerV1('ma réponse');
    check(await until(async () => (await page.getByText('Étape 2 / 2').count()) > 0), `${register}: V1 validated → UI shows step 2`);
    eq((await v1()).current_step_index, 1, `${register}: V1 validated → backend on step 2`);
    check(await until(async () => (await page.getByText('Leçon du module Application').count()) > 0), `${register}: V1 step 2 explanation loaded`);
    await sleep(300);
    eq(await page.getByText('Étape 2 / 2').count(), 1, `${register}: V1 UI still on step 2 after its explanation arrived`);
    eq(await page.getByText('Étape 1 / 2').count(), 0, `${register}: V1 previous step never reappears`);
    eq((await v1()).current_step_index, 1, `${register}: V1 single progression (no double advance)`);
    eq(prompts.filter(p => p.includes(`enseigne "V1-${register}" étape par étape`) && p.includes('"Application"')).length, 1, `${register}: V1 step 2 explanation requested once`);

    // close / reopen and full reload → correct step restored
    await page.getByRole('button', { name: 'Retour à la liste' }).click();
    await page.getByText(`V1-${register}`).first().click();
    check(await until(async () => (await page.getByText('Étape 2 / 2').count()) > 0), `${register}: V1 reopen → step 2`);
    await load();
    await page.getByText(`V1-${register}`).first().click();
    check(await until(async () => (await page.getByText('Étape 2 / 2').count()) > 0), `${register}: V1 reload → step 2`);
    eq(await page.getByText('Leçon du module Application').count(), 1, `${register}: V1 reload → step 2 content`);
    eq(await T('teacher-v2-lesson').count(), 0, `${register}: V1 stays V1 after reload`);
    const stored = await v1();
    eq(stored.schema_version, 1, `${register}: V1 never converted`);
    eq(stored.register, register, `${register}: V1 register unchanged`);
    await page.getByRole('button', { name: 'Retour à la liste' }).click();

    // V2 for this register
    await create(`V2-${register}`, register, true);
    await T('teacher-v2-lesson').waitFor();
    check(prompts.some(p => p.includes(`Registre pédagogique : ${register.toUpperCase().replace('DEBUTANT', 'DÉBUTANT')}`)), `${register}: register reaches the model`);
    check(await until(async () => (await attr('practice-spec', 'data-generated')) === 'true'), `${register}: exercise generated`);
    await T('theory-answer').fill('Explication');
    await T('theory-submit').click();
    check(await until(async () => (await attr('track-theory', 'data-state')) === 'PASSED'), `${register}: theory PASSED`);
    eq(await T('advance-button').isDisabled(), true, `${register}: gate closed with theory only`);
    await T('practice-mode-self_report').click();
    await T('practice-check-0').check();
    await T('practice-check-1').check();
    await T('practice-submit').click();
    check(await until(async () => (await attr('track-practice', 'data-state')) === 'PASSED'), `${register}: practice PASSED`);
    eq(await T('advance-button').isDisabled(), false, `${register}: gate open`);

    // full page reload, reopen the parcours: everything restored from the server
    await load();
    const row = page.getByText(`V2-${register}`).first();
    await row.click();
    await T('teacher-v2-lesson').waitFor();
    eq(await attr('track-theory', 'data-state'), 'PASSED', `${register}: theory restored after reload`);
    eq(await attr('track-practice', 'data-state'), 'PASSED', `${register}: practice restored after reload`);
    eq(await page.locator('[data-testid="track-practice"] [data-testid="evidence-label"]').getAttribute('data-evidence'), 'SELF_REPORTED', `${register}: provenance restored`);
    await page.getByRole('button', { name: 'Retour à la liste' }).click();
    const listRow = page.locator('div', { hasText: `V2-${register}` }).filter({ hasText: ' · ' }).last(); // subject + "Label · status" line
    check((await listRow.innerText()).includes(`${TEACHER_REGISTER_LABELS[register]} · `), `${register}: register label in the list`);
  }
  eq(net.errors.length, 0, `page errors: ${net.errors.join(' | ')}`);
  eq(net.external.length, 0, `external: ${net.external.join(' | ')}`);
} catch (err) {
  failed = err;
  if (process.env.PROF3R_DEBUG) { try { err.debugText = `${(await page.locator('body').innerText()).slice(0, 1500)}\nPROMPTS (user part):\n${prompts.slice(-3).map(p => p.split('\n').slice(-1)[0].slice(0, 200)).join('\n---\n')}\nSERVER:\n${JSON.stringify((await (await teacher.request('/teacher/paths')).json()).paths.map(p => ({ subject: p.subject, current_step_index: p.current_step_index, status: p.status })))}`; } catch { /* debug only */ } }
} finally {
  await browser.close();
  await server.close();
}
if (failed && process.env.PROF3R_DEBUG) { console.error("DEBUG", failed.debugText); }
if (failed) { console.error(`FAIL after ${assertions} assertions:`, failed.message); process.exit(1); }
console.log(`PROF-3R registers browser: ${assertions}/${assertions} assertions PASS (${TEACHER_REGISTERS.join(', ')})`);
