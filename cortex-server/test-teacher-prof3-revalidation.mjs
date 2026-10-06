import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
// Professeur V2 — PROF-3R master revalidation (no product change): PROF-3 additions for EVERY existing register,
// Strict Local / cloud opt-in on the new practice-spec endpoint, provider failures never yield a false PASS.
// In-memory SQLite only; scripted local model; fetch is a spy (no real network).
// Run: node --test test-teacher-prof3-revalidation.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings, setCloudKey, setTeacherSettings, getTrackAttempts } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import { TEACHER_REGISTERS, teacherRegisterInstruction } from './src/lib/teacher-register.js';

initSqlite(':memory:');
const LOCAL = () => setRouterSettings({ strict_local_mode: true, chat_model: 'fake-prof3r' });
LOCAL();

const PLAN = JSON.stringify([{ title: 'Fondations', summary: 'Les bases' }, { title: 'Application', summary: 'Appliquer' }]);
const SPEC = JSON.stringify({ kind: 'exercise', instructions: 'Réalise un mini-exercice concret.', checklist: ['Fait', 'Vérifié'], rubric: [] });
const verdict = (passed) => JSON.stringify(passed
  ? { passed: true, score: 90, criteria: [{ name: 'Compréhension', met: true }], feedback: 'Acquis.' }
  : { passed: false, score: 20, criteria: [{ name: 'Compréhension', met: false, comment: 'confus' }], feedback: 'À revoir.' });
const calls = [];
const failNext = { kind: null }; // 'throw' | 'garbage'
const ollamaClient = {
  chat: async ({ messages }) => {
    const prompt = messages.map(m => m.content).join('\n');
    calls.push(prompt);
    if (failNext.kind === 'throw') { failNext.kind = null; throw Object.assign(new Error('ollama down'), { code: 'ECONNREFUSED' }); }
    if (failNext.kind === 'garbage') return { message: { content: 'pas du json du tout' } }; // twice: first try + reformulation
    if (prompt.includes("plan d'apprentissage")) return { message: { content: PLAN } };
    if (prompt.includes('partie PRATIQUE du module')) return { message: { content: SPEC } };
    if (prompt.includes('évalue la partie THÉORIE')) return { message: { content: verdict(/BONNE/.test(prompt)) } };
    if (prompt.includes('évalue la partie PRATIQUE')) return { message: { content: verdict(true) } };
    return { message: { content: 'Leçon.\n\nQuestion : reformule.' } };
  },
};
const makeApp = () => { const app = new Hono(); app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null })); return app; };
let app = makeApp();
const call = async (method, path, body, on = app) => {
  const res = await on.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
};
const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error(`unexpected network call: ${url}`); };
test.after(() => { globalThis.fetch = realFetch; });

async function startV2(register) {
  const created = await call('POST', '/teacher/paths', { subject: `PROF-3R ${register}`, register, schema_version: 2 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const started = await call('POST', `/teacher/paths/${created.body.path.id}/start`);
  assert.equal(started.status, 200);
  return { id: created.body.path.id, steps: started.body.steps };
}
const base = (id, stepId) => `/teacher/paths/${id}/steps/${stepId}`;

for (const register of TEACHER_REGISTERS) {
  test(`PROF-3R register ${register}: lesson, generated exercise, remediation, self-report, gate, reload`, async () => {
    const instruction = teacherRegisterInstruction(register);
    const { id, steps } = await startV2(register);
    const s0 = steps[0];
    assert.equal((await call('POST', `${base(id, s0.id)}/explain`)).status, 200);
    assert.ok(calls.at(-1).includes(instruction), 'lesson prompt uses the register');
    const spec = await call('POST', `${base(id, s0.id)}/practice/spec`);
    assert.equal(spec.body.generated, true);
    assert.ok(calls.at(-1).includes(instruction), 'exercise prompt uses the register');
    const generated = spec.body.steps[0].tracks.practice.spec;
    assert.deepEqual(generated.checklist, ['Fait', 'Vérifié']);

    const failed = await call('POST', `${base(id, s0.id)}/theory/answer`, { answer: 'mauvaise' });
    assert.equal(failed.body.verdict.passed, false);
    assert.deepEqual([failed.body.steps[0].tracks.theory.state, failed.body.steps[0].tracks.practice.state], ['REMEDIATION', 'ACTIVE']);
    assert.ok(calls.at(-1).includes(instruction), 'evaluation prompt uses the register');
    const passed = await call('POST', `${base(id, s0.id)}/theory/answer`, { answer: 'BONNE réponse' });
    assert.equal(passed.body.steps[0].tracks.theory.state, 'PASSED');
    assert.equal((await call('POST', `${base(id, s0.id)}/advance`)).status, 409, 'theory alone never opens the gate');

    const practice = await call('POST', `${base(id, s0.id)}/practice/submit`, { mode: 'self_report', confirmations: [true, true] });
    assert.equal(practice.body.can_advance, true);
    assert.equal(practice.body.steps[0].tracks.practice.evidence, 'SELF_REPORTED');

    // reload = a fresh route instance reading the same storage
    const fresh = makeApp();
    const reloaded = await call('GET', `/teacher/paths/${id}`, undefined, fresh);
    assert.equal(reloaded.body.path.register, register);
    assert.equal(reloaded.body.path.schema_version, 2);
    const r0 = reloaded.body.steps[0];
    assert.deepEqual([r0.tracks.theory.state, r0.tracks.practice.state, r0.tracks.practice.evidence], ['PASSED', 'PASSED', 'SELF_REPORTED']);
    assert.equal(r0.tracks.practice.spec.generated, true);
    assert.equal((await call('POST', `${base(id, s0.id)}/advance`, undefined, fresh)).status, 200);
    assert.equal(fetchCalls.length, 0, 'strict local: no network');
  });
}

test('PROF-3R Strict Local: a cloud teacher model configured with a key is never called, on every PROF-3 path', async () => {
  setCloudKey('groq', 'fake-groq-key-prof3r');
  setTeacherSettings({ model: 'groq:llama-3.1-8b-instant' });
  try {
    const { id, steps } = await startV2('standard');
    const explain = await call('POST', `${base(id, steps[0].id)}/explain`);
    assert.match(explain.body.model_used, /^local\//);
    assert.equal(explain.body.fallback_reason_code, 'strict_local');
    assert.equal((await call('POST', `${base(id, steps[0].id)}/practice/spec`)).body.generated, true);
    await call('POST', `${base(id, steps[0].id)}/theory/answer`, { answer: 'BONNE' });
    await call('POST', `${base(id, steps[0].id)}/practice/submit`, { mode: 'deliverable', submission: 'livrable' });
    assert.equal(fetchCalls.length, 0, 'zero network call under Strict Local');
  } finally {
    setTeacherSettings({ model: 'local' });
  }
});

test('PROF-3R cloud opt-in: with Strict Local OFF the exercise goes through the existing guarded Groq provider only', async () => {
  const { id, steps } = await startV2('expert'); // created under strict local (plan from local model)
  setRouterSettings({ strict_local_mode: false, chat_model: 'fake-prof3r' });
  setTeacherSettings({ model: 'groq:llama-3.1-8b-instant' });
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    const body = JSON.parse(init.body);
    assert.ok(body.messages.some(m => m.content.includes(teacherRegisterInstruction('expert'))));
    return new Response(JSON.stringify({ model: 'llama-3.1-8b-instant', choices: [{ message: { content: SPEC } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const before = calls.length;
    const spec = await call('POST', `${base(id, steps[0].id)}/practice/spec`);
    assert.equal(spec.status, 200, JSON.stringify(spec.body));
    assert.equal(spec.body.generated, true);
    assert.ok(seen.length >= 1 && seen.every(u => u.startsWith('https://api.groq.com/')), `only the selected provider: ${seen}`);
    assert.equal(calls.length, before, 'no silent local call when the cloud answered');
  } finally {
    globalThis.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error(`unexpected network call: ${url}`); };
    setTeacherSettings({ model: 'local' });
    LOCAL();
  }
});

test('PROF-3R provider failure / malformed output on theory and practice never yields a PASS and changes nothing', async () => {
  const { id, steps } = await startV2('debutant');
  const s0 = steps[0];
  failNext.kind = 'throw';
  const t503 = await call('POST', `${base(id, s0.id)}/theory/answer`, { answer: 'BONNE' });
  assert.equal(t503.status, 503);
  failNext.kind = 'throw';
  const p503 = await call('POST', `${base(id, s0.id)}/practice/submit`, { mode: 'deliverable', submission: 'x' });
  assert.equal(p503.status, 503);
  failNext.kind = 'throw';
  assert.equal((await call('POST', `${base(id, s0.id)}/practice/spec`)).status, 503);
  let state = (await call('GET', `/teacher/paths/${id}`)).body.steps[0].tracks;
  assert.deepEqual([state.theory.state, state.practice.state, state.theory.attempts, state.practice.attempts], ['ACTIVE', 'ACTIVE', 0, 0]);
  assert.equal(state.practice.spec.generated, false, 'generic exercise kept');

  failNext.kind = 'garbage';
  const tBad = await call('POST', `${base(id, s0.id)}/theory/answer`, { answer: 'BONNE' });
  const pBad = await call('POST', `${base(id, s0.id)}/practice/submit`, { mode: 'deliverable', submission: 'x' });
  const sBad = await call('POST', `${base(id, s0.id)}/practice/spec`);
  failNext.kind = null;
  assert.deepEqual([tBad.body.evaluated, tBad.body.verdict.passed, tBad.body.verdict.invalid], [false, false, true]);
  assert.deepEqual([pBad.body.evaluated, pBad.body.verdict.passed], [false, false]);
  assert.equal(sBad.body.generated, false);
  state = (await call('GET', `/teacher/paths/${id}`)).body.steps[0].tracks;
  assert.deepEqual([state.theory.state, state.practice.state], ['ACTIVE', 'ACTIVE'], 'no state change on unusable output');
  assert.ok(getTrackAttempts(s0.id).every(a => a.passed === false), 'recorded attempts are all non-passing');
  assert.equal((await call('POST', `${base(id, s0.id)}/advance`)).status, 409);
});
