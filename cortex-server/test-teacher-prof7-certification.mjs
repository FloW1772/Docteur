import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
// Professeur V2 — PROF-7 certification matrix (no product change). For EVERY existing register:
//   V1 · V2 · THEORY · PRACTICE · EVALUATION · REMEDIATION · RELOAD · SPORT (applicable, with youth caps for "enfant")
// plus Sport Coach under Strict Local (zero network) and under cloud opt-in (only the selected, guarded provider).
// In-memory SQLite only; scripted local model; fetch is a spy / a mocked Groq endpoint.
// Run: node --test test-teacher-prof7-certification.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings, setCloudKey, setTeacherSettings } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import { TEACHER_REGISTERS, teacherRegisterInstruction } from './src/lib/teacher-register.js';
import { sessionTargetRpe } from './src/lib/sport-adaptation.js';

initSqlite(':memory:');
const STRICT = () => setRouterSettings({ strict_local_mode: true, chat_model: 'fake-prof7' });
STRICT();

const PLAN = JSON.stringify([{ title: 'Bases', summary: 'b' }, { title: 'Suite', summary: 's' }]);
const SPEC = JSON.stringify({ kind: 'exercise', instructions: 'Applique.', checklist: ['A', 'B'], rubric: [] });
const verdict = (pass) => JSON.stringify(pass
  ? { passed: true, score: 90, criteria: [{ name: 'Idée', met: true }], feedback: 'Acquis.' }
  : { passed: false, score: 20, criteria: [{ name: 'Idée', met: false, comment: 'confus' }], feedback: 'Non.', remediation: { focus: 'Idée clé', why: 'Confusion.', retry: 'Reformule avec un exemple.' } });
const prompts = [];
const ollamaClient = {
  chat: async ({ messages }) => {
    const p = messages.map(m => m.content).join('\n');
    prompts.push(p);
    if (p.includes("plan d'apprentissage")) return { message: { content: PLAN } };
    if (p.includes('modèles de séance')) return { message: { content: 'non' } };
    if (p.includes('partie PRATIQUE du module')) return { message: { content: SPEC } };
    if (p.includes('Explique la séance suivante')) return { message: { content: 'Leçon de séance. Question : RPE ?' } };
    if (p.includes('évalue la partie THÉORIE')) return { message: { content: verdict(/BONNE/.test(p.split("Réponse de l'apprenant")[1] ?? '')) } };
    if (p.includes('évalue la partie PRATIQUE')) return { message: { content: verdict(true) } };
    if (p.includes("question de compréhension sur l'étape")) return { message: { content: 'Bravo, VALIDÉ.' } };
    return { message: { content: 'Leçon.\n\nQuestion : reformule.' } };
  },
};
const makeApp = () => { const a = new Hono(); a.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null })); return a; };
const app = makeApp();
const call = async (method, p, body, on = app) => {
  const r = await on.request(`/api${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
};
const fetchCalls = [];
const realFetch = globalThis.fetch;
const forbidFetch = async (url) => { fetchCalls.push(String(url)); throw new Error(`network forbidden: ${url}`); };
globalThis.fetch = forbidFetch;
test.after(() => { globalThis.fetch = realFetch; });

const SPORT = { goal: 'force', level: 'experimente', locations: ['salle'], equipment: ['barre', 'rack', 'halteres', 'banc'], sessions_per_week: 2, session_minutes: 60, days: ['lundi', 'jeudi'] };
const CHECKIN = { completed: true, rpe: 6, unusual_pain: false, technique_confidence: 4, energy: 4 };
const MATRIX = [];

for (const register of TEACHER_REGISTERS) {
  test(`certification matrix — ${register}`, async () => {
    const row = { register, V1: 'FAIL', V2: 'FAIL', THEORY: 'FAIL', PRACTICE: 'FAIL', EVALUATION: 'FAIL', REMEDIATION: 'FAIL', RELOAD: 'FAIL', SPORT: 'FAIL' };
    MATRIX.push(row);
    const instruction = teacherRegisterInstruction(register);

    // V1 — historical flow, unchanged, never converted
    const v1 = (await call('POST', '/teacher/paths', { subject: `V1 ${register}`, register })).body.path;
    const v1s = (await call('POST', `/teacher/paths/${v1.id}/start`)).body.steps[0];
    assert.equal((await call('POST', `/teacher/paths/${v1.id}/steps/${v1s.id}/answer`, { answer: 'ok' })).body.validated, true);
    const v1a = await call('POST', `/teacher/paths/${v1.id}/steps/${v1s.id}/advance`);
    assert.deepEqual([v1a.body.path.schema_version, v1a.body.path.current_step_index, v1a.body.steps[0].tracks], [1, 1, null]);
    row.V1 = 'PASS';

    // V2 — dual track
    const v2 = (await call('POST', '/teacher/paths', { subject: `V2 ${register}`, register, schema_version: 2 })).body.path;
    const s0 = (await call('POST', `/teacher/paths/${v2.id}/start`)).body.steps[0];
    assert.deepEqual([s0.tracks.theory.state, s0.tracks.practice.state], ['ACTIVE', 'ACTIVE']);
    row.V2 = 'PASS';

    // THEORY + EVALUATION + REMEDIATION (structured verdict, register reaches the model, targeted remediation)
    await call('POST', `/teacher/paths/${v2.id}/steps/${s0.id}/explain`);
    assert.ok(prompts.at(-1).includes(instruction));
    const failed = await call('POST', `/teacher/paths/${v2.id}/steps/${s0.id}/theory/answer`, { answer: 'non' });
    assert.ok(prompts.at(-1).includes(instruction));
    assert.deepEqual([failed.body.verdict.passed, failed.body.steps[0].tracks.theory.state, failed.body.steps[0].tracks.practice.state], [false, 'REMEDIATION', 'ACTIVE']);
    assert.equal(failed.body.verdict.remediation.focus, 'Idée clé');
    row.REMEDIATION = 'PASS';
    const passed = await call('POST', `/teacher/paths/${v2.id}/steps/${s0.id}/theory/answer`, { answer: 'BONNE' });
    assert.deepEqual([passed.body.verdict.passed, typeof passed.body.verdict.score, Array.isArray(passed.body.verdict.criteria)], [true, 'number', true]);
    row.EVALUATION = 'PASS';
    assert.equal((await call('POST', `/teacher/paths/${v2.id}/steps/${s0.id}/advance`)).status, 409, 'theory alone never unlocks');
    row.THEORY = 'PASS';

    // PRACTICE (generated exercise, SELF_REPORTED) + gate
    assert.equal((await call('POST', `/teacher/paths/${v2.id}/steps/${s0.id}/practice/spec`)).body.generated, true);
    const pr = await call('POST', `/teacher/paths/${v2.id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: [true, true] });
    assert.deepEqual([pr.body.can_advance, pr.body.steps[0].tracks.practice.evidence], [true, 'SELF_REPORTED']);
    row.PRACTICE = 'PASS';

    // RELOAD (fresh route instance, same storage): states + history
    const fresh = makeApp();
    const reloaded = await call('GET', `/teacher/paths/${v2.id}`, undefined, fresh);
    assert.deepEqual([reloaded.body.steps[0].tracks.theory.state, reloaded.body.steps[0].tracks.practice.state, reloaded.body.path.register], ['PASSED', 'PASSED', register]);
    const history = (await call('GET', `/teacher/paths/${v2.id}/steps/${s0.id}/attempts`, undefined, fresh)).body.attempts;
    assert.deepEqual(history.map(a => [a.track, a.passed]), [['theory', false], ['theory', true], ['practice', true]]);
    assert.equal((await call('POST', `/teacher/paths/${v2.id}/steps/${s0.id}/advance`, undefined, fresh)).status, 200);
    row.RELOAD = 'PASS';

    // SPORT — applicable to every register; "enfant" = youth caps (RPE ≤ 7, no advanced lifts)
    const sp = await call('POST', '/teacher/sport/paths', { register, profile: SPORT });
    assert.equal(sp.status, 201);
    assert.ok(prompts.some(p => p.includes('modèles de séance') && p.includes(instruction)));
    const rpes = sp.body.path.profile.program.sessions.flatMap(s => s.exercises.map(e => e.rpe));
    if (register === 'enfant') assert.ok(Math.max(...rpes) <= 7); else assert.ok(Math.max(...rpes) > 7);
    const w0 = (await call('POST', `/teacher/paths/${sp.body.path.id}/start`)).body.steps[0];
    await call('POST', `/teacher/paths/${sp.body.path.id}/steps/${w0.id}/theory/answer`, { answer: 'BONNE' });
    // a normal session = check-in at the session's own target intensity (same source of truth as the adaptation loop)
    const target = sessionTargetRpe(w0.tracks.practice.spec.workout);
    const done = await call('POST', `/teacher/paths/${sp.body.path.id}/steps/${w0.id}/practice/submit`, { mode: 'self_report', confirmations: w0.tracks.practice.spec.checklist.map(() => true), checkin: { ...CHECKIN, rpe: target } });
    assert.deepEqual([done.body.can_advance, done.body.sport.decision.kind], [true, 'none']);
    // PROF-6 behaviour kept explicit: ONE session clearly below target → observation only (program unchanged)
    assert.equal((await call('POST', `/teacher/paths/${sp.body.path.id}/steps/${w0.id}/advance`)).status, 200);
    const w1 = (await call('GET', `/teacher/paths/${sp.body.path.id}`)).body.steps.find(s => s.step_index === 1);
    const before = (await call('GET', `/teacher/paths/${sp.body.path.id}`)).body.path.profile.program.sessions;
    const easyRpe = sessionTargetRpe(w1.tracks.practice.spec.workout) - 3;
    assert.ok(easyRpe >= 1, 'fixture: target leaves room for a clearly easier session');
    await call('POST', `/teacher/paths/${sp.body.path.id}/steps/${w1.id}/theory/answer`, { answer: 'BONNE' });
    const easy = await call('POST', `/teacher/paths/${sp.body.path.id}/steps/${w1.id}/practice/submit`, { mode: 'self_report', confirmations: w1.tracks.practice.spec.checklist.map(() => true), checkin: { ...CHECKIN, rpe: easyRpe } });
    assert.deepEqual([easy.body.can_advance, easy.body.sport.decision.kind], [true, 'observe']);
    assert.deepEqual(easy.body.path.profile.program.sessions, before, 'one easy session changes nothing');
    row.SPORT = register === 'enfant' ? 'PASS (youth caps)' : 'PASS';
  });
}

test('certification matrix — every mandatory cell PASS (printed)', () => {
  console.log(['PROFILE/REGISTER', 'V1', 'V2', 'THEORY', 'PRACTICE', 'EVALUATION', 'REMEDIATION', 'RELOAD', 'SPORT'].join(' | '));
  for (const r of MATRIX) console.log([r.register, r.V1, r.V2, r.THEORY, r.PRACTICE, r.EVALUATION, r.REMEDIATION, r.RELOAD, r.SPORT].join(' | '));
  assert.equal(MATRIX.length, TEACHER_REGISTERS.length);
  for (const r of MATRIX) for (const [k, v] of Object.entries(r)) if (k !== 'register') assert.match(v, /^PASS/, `${r.register}.${k}`);
});

test('Strict Local: the whole certification matrix made zero network calls', () => { assert.equal(fetchCalls.length, 0); });

test('Sport Coach under cloud opt-in: program and lesson go only through the selected, guarded provider', async () => {
  setRouterSettings({ strict_local_mode: false, chat_model: 'fake-prof7' });
  setCloudKey('groq', 'fake-groq-key-prof7');
  setTeacherSettings({ model: 'groq:llama-3.1-8b-instant' });
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    const body = JSON.parse(init.body);
    const text = body.messages.map(m => m.content).join('\n');
    const content = text.includes('modèles de séance') ? 'non' : 'Leçon de séance. Question : RPE ?';
    return new Response(JSON.stringify({ model: 'llama-3.1-8b-instant', choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const before = prompts.length;
    const sp = await call('POST', '/teacher/sport/paths', { register: 'standard', profile: { ...SPORT, limitations: { declared: 'asthme léger (privé)', areas: [] }, age: 41 } });
    assert.equal(sp.status, 201);
    const w0 = (await call('POST', `/teacher/paths/${sp.body.path.id}/start`)).body.steps[0];
    const lesson = await call('POST', `/teacher/paths/${sp.body.path.id}/steps/${w0.id}/explain`);
    assert.equal(lesson.body.lesson_source, 'model');
    assert.ok(seen.length >= 2 && seen.every(u => u.startsWith('https://api.groq.com/')), `only the selected provider: ${seen}`);
    assert.equal(prompts.length, before, 'no silent local call when the cloud answered');
  } finally {
    globalThis.fetch = forbidFetch;
    setTeacherSettings({ model: 'local' });
    STRICT();
  }
});

test('Sport Coach privacy: declared limitation text, age and check-in comments never reach a model prompt', async () => {
  const before = prompts.length;
  const sp = await call('POST', '/teacher/sport/paths', { register: 'standard', profile: { ...SPORT, limitations: { declared: 'SECRET-LIMITATION-4711', areas: [] }, age: 41 } });
  const w0 = (await call('POST', `/teacher/paths/${sp.body.path.id}/start`)).body.steps[0];
  await call('POST', `/teacher/paths/${sp.body.path.id}/steps/${w0.id}/explain`);
  await call('POST', `/teacher/paths/${sp.body.path.id}/steps/${w0.id}/theory/answer`, { answer: 'BONNE' });
  await call('POST', `/teacher/paths/${sp.body.path.id}/steps/${w0.id}/practice/submit`, { mode: 'self_report', confirmations: w0.tracks.practice.spec.checklist.map(() => true), checkin: { ...CHECKIN, comment: 'SECRET-COMMENT-4712' } });
  const sent = prompts.slice(before).join('\n');
  assert.ok(!sent.includes('SECRET-LIMITATION-4711'));
  assert.ok(!sent.includes('SECRET-COMMENT-4712'));
  assert.ok(!/\b41 ans\b|âge\s*:?\s*41/.test(sent));
});
