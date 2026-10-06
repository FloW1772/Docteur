// Professeur V2 (PROF-6) — Sport Coach adaptation loop in the REAL TeacherModal: check-in, observation, adaptation with
// its reason, pain → pause → explicit resume, dashboard, history with check-ins, reload, mobile, keyboard / a11y basics.
// Real Hono teacher route in-process, in-memory SQLite (never the real DB), scripted local model, no network.
// Usage: node scripts/test-teacher-sport-adaptation-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { initSqlite, setRouterSettings, getLearningPathById } from '../cortex-server/src/lib/sqlite.js';
import { createTeacherRoute } from '../cortex-server/src/routes/teacher.js';

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }

initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-prof6-ui' });
const ollamaClient = {
  chat: async ({ messages }) => {
    const p = messages.map(m => m.content).join('\n');
    if (p.includes('modèles de séance')) return { message: { content: 'non' } };
    if (p.includes('Explique la séance suivante')) return { message: { content: 'Objectif de la séance. Vise le RPE indiqué.\n\nQuestion : que veut dire RPE ?' } };
    if (p.includes('évalue la partie THÉORIE')) return { message: { content: JSON.stringify({ passed: true, score: 90, criteria: [{ name: 'RPE', met: true }], feedback: 'Exact.' }) } };
    return { message: { content: 'ok' } };
  },
};
const teacher = createTeacherRoute({ services: {}, ollamaClient, logger: null });
const firstPathId = async () => (await (await teacher.request('/teacher/paths')).json()).paths[0]?.id;
const program = async () => getLearningPathById(await firstPathId()).profile.program;

const PORT = 5250;
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

const SHOTS = process.env.TEACHER_V2_SHOTS; // optional: directory for visual-check screenshots
const shot = async (pg, name) => { if (SHOTS) await pg.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
let failed = null;
let page;
try {
  ({ page } = await openPage({ width: 1400, height: 1100 }));
  const T = (id) => page.locator(`[data-testid="${id}"]`);
  const attr = (id, name) => T(id).first().getAttribute(name);
  const moduleIs = (n) => until(async () => (await T('module-title').innerText()).startsWith(`Module ${n} /`));

  async function doSession({ rpe, pain = null, completed = true }) {
    check(await until(async () => (await T('theory-answer').count()) === 1 || (await attr('track-theory', 'data-state')) === 'PASSED'), 'theory ready');
    if ((await attr('track-theory', 'data-state')) !== 'PASSED') {
      await T('theory-answer').fill('Effort modéré, je peux parler.');
      await T('theory-submit').click();
      check(await until(async () => (await attr('track-theory', 'data-state')) === 'PASSED'), 'theory PASSED');
    }
    const boxes = page.locator('[data-testid^="practice-check-"]');
    for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check();
    if (!completed) await T('checkin-completed-no').check();
    else await T(`checkin-rpe-${rpe}`).check();
    if (pain) {
      await T('checkin-pain').check();
      for (const a of pain.areas) await T(`sport-checkin-pain-area-${a}`).check();
      if (pain.worsening) await T('checkin-pain-worsening').check();
    }
    await T('practice-submit').click();
    check(await until(async () => (await T('sport-loop-result').count()) === 1 || (await attr('track-practice', 'data-state')) === 'PASSED'), 'declaration processed');
  }

  await T('teacher-mode-sport').click();
  await T('sport-form').waitFor();
  await T('sport-level').selectOption('intermediaire');
  await T('sport-equipment-halteres').check();
  await T('sport-minutes').fill('40');
  await T('sport-create').click();
  await T('sport-preview').waitFor();
  await T('sport-start').click();
  await T('teacher-v2-lesson').waitFor();
  check(await until(async () => (await T('sport-dashboard').count()) === 1), 'program dashboard');
  eq(await T('sport-progress').innerText(), '0/8 séances faites');
  eq(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '0');
  check(await until(async () => (await T('checkin-fields').count()) === 1), 'check-in fields in Practice');
  eq(await T('workout-view').locator('text=professionnel').count(), 0, 'no warning repeated on every exercise');

  // keyboard: radio scales are real radios
  await T('checkin-rpe-8').focus();
  await page.keyboard.press('Space');
  eq(await T('checkin-rpe-8').isChecked(), true, 'RPE selectable with the keyboard');
  eq(await page.locator('[role="radiogroup"][aria-label="EFFORT RESSENTI (RPE)"]').count(), 1, 'labelled radio group');

  // session 1: hard once → observation only
  const p0 = await program();
  const target = (s) => Math.round(s.exercises.filter(e => e.pattern !== 'mobility').reduce((a, e) => a + e.rpe, 0) / s.exercises.filter(e => e.pattern !== 'mobility').length);
  await doSession({ rpe: Math.min(10, target(p0.sessions[0]) + 3) });
  check(await until(async () => (await attr('sport-loop-result', 'data-kind')) === 'observe'), 'single hard session → observation');
  check((await T('sport-loop-result').innerText()).includes('Une seule séance'), 'observation explained');
  eq(JSON.stringify((await program()).sessions), JSON.stringify(p0.sessions), 'program unchanged after one hard session');
  check(await until(async () => (await T('sport-progress').innerText()) === '1/8 séances faites'), 'progress 1/8');
  await T('advance-button').click();
  check(await moduleIs(2), 'session 2');

  // session 2: hard again → adaptation with reason; future sessions lighter
  await doSession({ rpe: Math.min(10, target(p0.sessions[1]) + 3) });
  check(await until(async () => (await attr('sport-loop-result', 'data-rule')) === 'hard_reduce'), 'two hard sessions → hard_reduce');
  check((await T('sport-loop-result').innerText()).includes('plus dures'), 'reason readable');
  check(await until(async () => (await page.locator('[data-testid="sport-adaptation"][data-rule="hard_reduce"]').count()) === 1), 'adaptation listed in the dashboard');
  const p2 = await program();
  check(p2.sessions[2].exercises.every((e, i) => e.rpe <= p0.sessions[2].exercises[i].rpe), 'next sessions lighter');
  eq(JSON.stringify(p2.sessions.slice(0, 2)), JSON.stringify(p0.sessions.slice(0, 2)), 'past sessions untouched');
  await T('advance-button').click();
  check(await moduleIs(3), 'session 3');
  const s3 = p2.sessions[2];
  check((await page.locator('[data-testid="workout-exercise"]').first().locator('[data-testid="workout-rpe"]').innerText()).includes(`RPE ${s3.exercises[0].rpe}/10`), 'module shows the adapted session');

  // session 3: worsening pain → pause, gate closed, explicit resume
  await doSession({ rpe: 5, pain: { areas: ['dos'], worsening: true } });
  check(await until(async () => (await attr('sport-loop-result', 'data-kind')) === 'pause'), 'worsening pain → pause');
  check(await until(async () => (await T('sport-pause').count()) === 1), 'pause banner');
  check((await T('sport-pause').innerText()).includes('professionnel de santé'), 'professional advice');
  eq(await T('sport-pause').getAttribute('role'), 'alert');
  eq(await T('advance-button').isDisabled(), true, 'next session blocked while paused');
  check((await T('gate-hint').innerText()).includes('pause'), 'gate hint explains the pause');
  eq(await T('sport-resume').isDisabled(), true, 'resume needs an explicit confirmation');
  await shot(page, 'prof6-desktop-pause');
  check(((await page.locator('[data-testid="history-practice"] [data-testid="history-checkin"]').first().textContent()) ?? '').includes('douleur inhabituelle'), 'check-in visible in history');

  // reload: pause, adaptations, progress restored
  await page.goto(`http://127.0.0.1:${PORT}/__teacher`);
  await page.getByText('APPRENDS-MOI…').waitFor();
  await page.getByText('Sport Coach — Remise en forme').first().click();
  await T('teacher-v2-lesson').waitFor();
  check(await until(async () => (await T('sport-pause').count()) === 1), 'reload: still paused');
  eq(await page.locator('[data-testid="sport-adaptation"][data-rule="hard_reduce"]').count(), 1, 'reload: adaptation log');
  eq(await T('sport-progress').innerText(), '3/8 séances faites', 'reload: progress');

  await T('sport-resume-confirm').check();
  await T('sport-resume').click();
  check(await until(async () => (await T('sport-pause').count()) === 0), 'resumed');
  check(await until(async () => (await page.locator('[data-testid="sport-adaptation"][data-rule="resume"]').count()) === 1), 'gentle resume listed');
  eq(await T('advance-button').isDisabled(), false, 'progress allowed again');
  await T('advance-button').click();
  check(await moduleIs(4), 'session 4 after resume');
  check((await program()).sessions.slice(3).every(s => s.exercises.every(e => !e.areas.includes('dos'))), 'painful area spared afterwards');

  // mobile: dashboard + check-in usable without horizontal scroll
  const mobile = await openPage({ width: 390, height: 844 });
  const M = (id) => mobile.page.locator(`[data-testid="${id}"]`);
  await mobile.page.getByText('Sport Coach — Remise en forme').first().click();
  await M('teacher-v2-lesson').waitFor();
  check(await until(async () => (await M('sport-dashboard').count()) === 1), 'mobile dashboard');
  await M('tab-practice').click();
  check(await until(async () => (await M('checkin-fields').count()) === 1), 'mobile check-in');
  check(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile: no horizontal scroll');
  await shot(mobile.page, 'prof6-mobile-checkin');
  await mobile.ctx.close();

  eq(net.errors.length, 0, `page errors: ${net.errors.join(' | ')}`);
  eq(net.external.length, 0, `external: ${net.external.join(' | ')}`);
} catch (err) {
  failed = err;
  if (process.env.PROF6_DEBUG && page) { try { console.error((await page.locator('body').innerText()).slice(0, 3000)); } catch { /* debug only */ } }
} finally {
  await browser.close();
  await server.close();
}
if (failed) { console.error(`FAIL after ${assertions} assertions:`, failed.message); process.exit(1); }
console.log(`PROF-6 sport adaptation browser: ${assertions}/${assertions} assertions PASS`);
