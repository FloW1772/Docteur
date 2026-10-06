import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
// Professeur V2 (PROF-4) — targeted remediation, append-only attempt history, resume (reload + real process restart),
// navigation, completed parcours, V1 compatibility, every register, Strict Local, provider failure.
// In-memory SQLite for the main process; temporary file DBs for the restart children. Scripted local model.
// Run: node --test test-teacher-prof4.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings, getDatabase, getStepsByPathId, updateLearningPathStep } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import { validateRemediation, deterministicRemediation, withRemediation, selfReportVerdict } from './src/lib/teacher-evaluation.js';
import { presentHistory } from './src/lib/teacher-history.js';
import { TEACHER_REGISTERS, teacherRegisterInstruction } from './src/lib/teacher-register.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-prof4-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-prof4' });

// ── scripted local model: the answer text decides the verdict ─────────────────────────────────────────────────────
const PLAN = JSON.stringify([{ title: 'Bases', summary: 'b' }, { title: 'Suite', summary: 's' }]);
const SPEC = JSON.stringify({ kind: 'exercise', instructions: 'Fais l’exercice.', checklist: ['Point A', 'Point B'], rubric: [] });
const REMEDIATION = { focus: 'La différence chaleur / température', why: 'Tu confonds un état et un transfert.', retry: 'Explique avec un exemple de casserole.' };
const verdictFor = (answer) => {
  if (/BONNE/.test(answer)) return { passed: true, score: 92, criteria: [{ name: 'Idée clé', met: true }], feedback: 'Acquis.', remediation: REMEDIATION };
  if (/SANSREM/.test(answer)) return { passed: false, score: 30, criteria: [{ name: 'Idée clé', met: false, comment: 'absente' }], feedback: 'Non.' };
  if (/MALREM/.test(answer)) return { passed: false, score: 30, criteria: [{ name: 'Idée clé', met: false }], feedback: 'Non.', remediation: { focus: 42, why: '', retry: null } };
  return { passed: false, score: 25, criteria: [{ name: 'Idée clé', met: false, comment: 'confusion' }], feedback: 'À revoir.', remediation: REMEDIATION };
};
const calls = [];
const fail = { next: false };
const ollamaClient = {
  chat: async ({ messages }) => {
    const p = messages.map(m => m.content).join('\n');
    calls.push(p);
    if (fail.next) { fail.next = false; throw Object.assign(new Error('ollama down'), { code: 'ECONNREFUSED' }); }
    if (p.includes("plan d'apprentissage")) return { message: { content: PLAN } };
    if (p.includes('partie PRATIQUE du module')) return { message: { content: SPEC } };
    if (p.includes('évalue la partie THÉORIE')) return { message: { content: JSON.stringify(verdictFor(p.split("Réponse de l'apprenant")[1] ?? '')) } };
    if (p.includes('évalue la partie PRATIQUE')) return { message: { content: JSON.stringify(verdictFor(p.split('Livrable de l')[1] ?? '')) } };
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
globalThis.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error(`network forbidden in PROF-4 tests: ${url}`); };
test.after(() => { globalThis.fetch = realFetch; });

async function newV2(register = 'standard', subject = 'PROF-4') {
  const created = await call('POST', '/teacher/paths', { subject, register, schema_version: 2 });
  assert.equal(created.status, 201);
  const started = await call('POST', `/teacher/paths/${created.body.path.id}/start`);
  return { id: created.body.path.id, s0: started.body.steps[0], s1: started.body.steps[1] };
}
const at = (id, stepId) => `/teacher/paths/${id}/steps/${stepId}`;
const theory = (id, stepId, answer) => call('POST', `${at(id, stepId)}/theory/answer`, { answer });
const selfReport = (id, stepId, confirmations) => call('POST', `${at(id, stepId)}/practice/submit`, { mode: 'self_report', confirmations });
const deliverable = (id, stepId, submission) => call('POST', `${at(id, stepId)}/practice/submit`, { mode: 'deliverable', submission });
const tracksOf = async (id, i = 0) => (await call('GET', `/teacher/paths/${id}`)).body.steps.find(s => s.step_index === i).tracks;
const history = async (id, stepId, q = '') => (await call('GET', `${at(id, stepId)}/attempts${q}`)).body.attempts;

// ═══ pure ═════════════════════════════════════════════════════════════════════════════════════════════════════════
test('remediation contract: valid model remediation kept & bounded; malformed → null', () => {
  assert.deepEqual(validateRemediation(REMEDIATION), { ...REMEDIATION, source: 'model' });
  assert.equal(validateRemediation({ ...REMEDIATION, why: 'x'.repeat(5000) }).why.length, 600);
  for (const bad of [null, [], 'texte', {}, { focus: 'a', why: 'b' }, { focus: 42, why: 'b', retry: 'c' }, { focus: ' ', why: 'b', retry: 'c' }]) {
    assert.equal(validateRemediation(bad), null, JSON.stringify(bad));
  }
});

test('withRemediation never changes passed; passing / invalid verdicts never carry one; fallback from unmet criteria', () => {
  const failing = { passed: false, score: 20, criteria: [{ name: 'A', met: false, comment: 'manque A' }, { name: 'B', met: true }], feedback: 'non' };
  const model = withRemediation(failing, { track: 'theory', rawRemediation: REMEDIATION });
  assert.equal(model.passed, false);
  assert.equal(model.remediation.source, 'model');
  const fallback = withRemediation(failing, { track: 'theory', rawRemediation: { focus: 1 } });
  assert.deepEqual([fallback.remediation.source, fallback.remediation.focus, fallback.remediation.why], ['criteria', 'A', 'manque A']);
  assert.match(fallback.remediation.retry, /Réponds à nouveau/);
  assert.match(withRemediation(failing, { track: 'practice' }).remediation.retry, /Reprends l’exercice/);
  const passing = withRemediation({ passed: true, score: 90, criteria: [], feedback: '', remediation: REMEDIATION }, { track: 'theory', rawRemediation: REMEDIATION });
  assert.equal(passing.remediation, undefined);
  assert.equal(passing.passed, true);
  assert.equal(withRemediation({ passed: false, score: 0, criteria: [], feedback: '', invalid: true }, { track: 'theory', rawRemediation: REMEDIATION }).remediation, undefined);
  const sr = selfReportVerdict({ checklist: ['Point A', 'Point B'] }, [true, false]).verdict;
  assert.deepEqual(deterministicRemediation(sr, { track: 'practice' }), { focus: 'Point B', why: 'Ces points de la checklist ne sont pas encore réalisés.', retry: 'Réalise les points restants, puis déclare-les à nouveau.', source: 'checklist' });
  assert.equal(deterministicRemediation({ passed: false, criteria: [], feedback: '' }, { track: 'theory' }).focus, 'la notion principale du module');
});

test('history presentation: per-track numbering, whitelisted fields, corrupted / malformed rows tolerated', () => {
  const rows = [
    { id: 'a', path_id: 'P', step_id: 'S', track: 'theory', created_at: '2026-10-06T10:00:00.000Z', passed: false, evidence: null, payload: { answer: 'x', secret: 's' }, verdict: { passed: false, score: 10, criteria: [{ name: 'c', met: false }, { bogus: 1 }], feedback: 'f', invalid: true, reason: 'not_json' } },
    { id: 'b', path_id: 'P', step_id: 'S', track: 'practice', created_at: '2026-10-06T10:01:00.000Z', passed: false, evidence: 'HACKED', payload: { mode: 'self_report', confirmations: [true, 'yes'] }, verdict: {} },
    { id: 'c', path_id: 'P', step_id: 'S', track: 'theory', created_at: '2026-10-06T10:02:00.000Z', passed: true, evidence: null, payload: 'not-an-object', verdict: { passed: true, score: 999, criteria: 'x', feedback: 3, remediation: { focus: 'a' } } },
  ];
  const out = presentHistory(rows);
  assert.deepEqual(out.map(a => [a.id, a.track, a.index]), [['a', 'theory', 1], ['b', 'practice', 1], ['c', 'theory', 2]]);
  for (const a of out) for (const k of ['path_id', 'step_id']) assert.equal(k in a, false, `${k} not exposed`);
  assert.deepEqual(out[0].payload, { answer: 'x' }, 'unknown payload keys dropped');
  assert.equal('reason' in out[0].verdict, false, 'internal failure code not exposed');
  assert.equal(out[0].verdict.criteria.length, 1);
  assert.equal(out[1].corrupted, true, 'unreadable verdict flagged');
  assert.equal(out[1].evidence, null, 'unknown evidence never shown');
  assert.deepEqual(out[1].payload, { mode: 'self_report' }, 'malformed confirmations dropped');
  assert.deepEqual([out[2].verdict.score, out[2].verdict.criteria, out[2].verdict.feedback, out[2].verdict.remediation], [100, [], '', undefined]);
});

// ═══ route ════════════════════════════════════════════════════════════════════════════════════════════════════════
test('theory failure only: theory → REMEDIATION with targeted remediation; practice left exactly as it was', async () => {
  const { id, s0 } = await newV2();
  const before = await tracksOf(id);
  const r = await theory(id, s0.id, 'mauvaise');
  assert.equal(r.body.verdict.passed, false);
  assert.deepEqual(r.body.verdict.remediation, { ...REMEDIATION, source: 'model' });
  const after = await tracksOf(id);
  assert.equal(after.theory.state, 'REMEDIATION');
  assert.deepEqual(after.practice, before.practice, 'practice untouched (state, spec, attempts, evidence)');
});

test('practice failure only: practice → REMEDIATION (checklist remediation); a PASSED theory keeps state and passedAt', async () => {
  const { id, s0 } = await newV2();
  await theory(id, s0.id, 'BONNE');
  const passedTheory = (await tracksOf(id)).theory;
  assert.equal(passedTheory.state, 'PASSED');
  const r = await selfReport(id, s0.id, [true, false]);
  assert.equal(r.body.verdict.remediation.source, 'checklist');
  assert.equal(r.body.verdict.remediation.focus, s0.tracks.practice.spec.checklist[1]);
  await deliverable(id, s0.id, 'mauvais livrable');
  const after = await tracksOf(id);
  assert.equal(after.practice.state, 'REMEDIATION');
  assert.deepEqual(after.theory, passedTheory, 'theory identical, passedAt intact');
});

test('both tracks fail independently; fail → fail → pass; history append-only and ordered', async () => {
  const { id, s0 } = await newV2();
  await theory(id, s0.id, 'mauvaise 1');
  await selfReport(id, s0.id, [false, false]);
  let t = await tracksOf(id);
  assert.deepEqual([t.theory.state, t.practice.state], ['REMEDIATION', 'REMEDIATION']);
  const h1 = await history(id, s0.id);
  await theory(id, s0.id, 'SANSREM');
  const h2 = await history(id, s0.id);
  assert.deepEqual(h2.slice(0, h1.length), h1, 'earlier entries never rewritten');
  const passed = await theory(id, s0.id, 'BONNE');
  assert.equal(passed.body.verdict.remediation, undefined, 'a passing verdict carries no remediation');
  t = await tracksOf(id);
  assert.deepEqual([t.theory.state, t.theory.attempts, t.practice.state], ['PASSED', 3, 'REMEDIATION']);
  const theoryHistory = await history(id, s0.id, '?track=theory');
  assert.deepEqual(theoryHistory.map(a => [a.index, a.passed]), [[1, false], [2, false], [3, true]]);
  assert.deepEqual(theoryHistory.map(a => a.payload.answer), ['mauvaise 1', 'SANSREM', 'BONNE']);
  assert.equal(theoryHistory[1].verdict.remediation.source, 'criteria', 'missing model remediation → deterministic one');
  assert.equal(theoryHistory[1].verdict.remediation.why, 'absente');
  assert.ok(theoryHistory.every((a, i, all) => i === 0 || a.created_at >= all[i - 1].created_at), 'chronological');
  assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM learning_track_attempts WHERE step_id = ?').get(s0.id).n, 4, '3 theory + 1 practice rows');
});

test('malformed model remediation is replaced, never trusted; it never changes the verdict', async () => {
  const { id, s0 } = await newV2();
  const r = await theory(id, s0.id, 'MALREM');
  assert.equal(r.body.verdict.passed, false);
  assert.equal(r.body.verdict.remediation.source, 'criteria');
  assert.equal(r.body.verdict.remediation.focus, 'Idée clé');
});

test('VERIFIED mismatch remediation never reveals the server-side expected answer', async () => {
  const { id, s0 } = await newV2();
  const stored = getStepsByPathId(id).find(s => s.step_index === 0);
  updateLearningPathStep(s0.id, { tracks: { ...stored.tracks, practice: { ...stored.tracks.practice, spec: { kind: 'result', instructions: 'Calcule', expected: 'secret-7741' } } } });
  const r = await deliverable(id, s0.id, '12');
  assert.equal(r.body.verdict.passed, false);
  assert.ok(r.body.verdict.remediation);
  assert.ok(!JSON.stringify(r.body).includes('secret-7741'));
  assert.ok(!JSON.stringify(await history(id, s0.id)).includes('secret-7741'));
});

test('provider failure: 503, no attempt recorded, state and history unchanged', async () => {
  const { id, s0 } = await newV2();
  await theory(id, s0.id, 'mauvaise');
  const [t0, h0] = [await tracksOf(id), await history(id, s0.id)];
  fail.next = true;
  assert.equal((await theory(id, s0.id, 'BONNE')).status, 503);
  fail.next = true;
  assert.equal((await deliverable(id, s0.id, 'BONNE')).status, 503);
  assert.deepEqual(await tracksOf(id), t0);
  assert.deepEqual(await history(id, s0.id), h0);
});

test('corrupted history rows in storage: endpoint still answers, row flagged, other rows intact', async () => {
  const { id, s0 } = await newV2();
  await theory(id, s0.id, 'mauvaise');
  getDatabase().prepare(`INSERT INTO learning_track_attempts (id, path_id, step_id, track, payload, verdict, passed, evidence, created_at)
    VALUES ('corrupt-1', ?, ?, 'theory', '{not json', '{also not json', 0, 'FORGED', '2099-01-01T00:00:00.000Z')`).run(id, s0.id);
  const h = await history(id, s0.id);
  assert.equal(h.length, 2);
  assert.equal(h[0].verdict.passed, false);
  assert.deepEqual([h[1].corrupted, h[1].verdict, h[1].evidence, h[1].payload], [true, null, null, {}]);
  assert.equal((await tracksOf(id)).theory.state, 'REMEDIATION', 'a corrupted history row never changes the state');
});

test('navigation: back then forward never changes validations (passedAt kept); completed parcours stays readable', async () => {
  const { id, s0, s1 } = await newV2();
  await theory(id, s0.id, 'BONNE');
  await selfReport(id, s0.id, [true, true]);
  const passed0 = await tracksOf(id, 0);
  assert.equal((await call('POST', `${at(id, s0.id)}/advance`)).status, 200);
  assert.equal((await call('POST', `${at(id, s1.id)}/back`)).status, 200);
  assert.deepEqual(await tracksOf(id, 0), passed0, 'going back keeps module 1 validations');
  assert.equal((await call('POST', `${at(id, s0.id)}/advance`)).status, 200);
  assert.deepEqual(await tracksOf(id, 0), passed0, 'and so does going forward again');
  await theory(id, s1.id, 'BONNE');
  await selfReport(id, s1.id, [true, true]);
  const done = await call('POST', `${at(id, s1.id)}/advance`);
  assert.equal(done.body.finished, true);
  const reopened = await call('GET', `/teacher/paths/${id}`);
  assert.equal(reopened.body.path.status, 'completed');
  assert.ok(reopened.body.steps.every(s => s.tracks.theory.state === 'PASSED' && s.tracks.practice.state === 'PASSED'));
  assert.equal((await history(id, s0.id)).length, 2);
  assert.equal((await history(id, s1.id)).length, 2);
});

test('V1 parcours: no tracks, no history endpoint, historical flow unchanged', async () => {
  const created = await call('POST', '/teacher/paths', { subject: 'V1', register: 'enfant' });
  const started = await call('POST', `/teacher/paths/${created.body.path.id}/start`);
  const step = started.body.steps[0];
  assert.equal(step.tracks, null);
  assert.equal((await call('GET', `${at(created.body.path.id, step.id)}/attempts`)).body.code, 'NOT_DUAL_TRACK');
  const answered = await call('POST', `${at(created.body.path.id, step.id)}/answer`, { answer: 'ok' });
  assert.equal(answered.body.validated, true);
  const advanced = await call('POST', `${at(created.body.path.id, step.id)}/advance`);
  assert.equal(advanced.body.path.current_step_index, 1);
  assert.equal(advanced.body.path.schema_version, 1);
});

for (const register of TEACHER_REGISTERS) {
  test(`register ${register}: remediation in the register, history + reload (fresh route instance)`, async () => {
    const { id, s0 } = await newV2(register, `PROF-4 ${register}`);
    const r = await theory(id, s0.id, 'mauvaise');
    assert.ok(calls.at(-1).includes(teacherRegisterInstruction(register)), 'remediation produced under the register instruction');
    assert.ok(calls.at(-1).includes('"remediation"'), 'the model is asked for a targeted remediation');
    assert.ok(r.body.verdict.remediation);
    await theory(id, s0.id, 'BONNE');
    await selfReport(id, s0.id, [true, false]);
    const fresh = makeApp();
    const reloaded = await call('GET', `/teacher/paths/${id}`, undefined, fresh);
    const t = reloaded.body.steps[0].tracks;
    assert.deepEqual([reloaded.body.path.register, t.theory.state, t.practice.state], [register, 'PASSED', 'REMEDIATION']);
    const h = (await call('GET', `${at(id, s0.id)}/attempts`, undefined, fresh)).body.attempts;
    assert.deepEqual(h.map(a => [a.track, a.index, a.passed]), [['theory', 1, false], ['theory', 2, true], ['practice', 1, false]]);
  });
}

test('Strict Local: the whole PROF-4 flow made zero network calls', () => {
  assert.equal(fetchCalls.length, 0);
});

// ═══ real restart (separate Node processes on a temp file DB) ═══════════════════════════════════════════════════════
const lib = (f) => pathToFileURL(path.join(HERE, 'src', 'lib', f)).href;
const routes = (f) => pathToFileURL(path.join(HERE, 'src', 'routes', f)).href;
function runProcess(code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import '${pathToFileURL(path.join(HERE, 'test-setup.mjs')).href}';\n${code}`], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr.slice(-1500)}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop());
}
const PRELUDE = (file) => `
  import { Hono } from 'hono';
  import { initSqlite, setRouterSettings } from '${lib('sqlite.js')}';
  import { createTeacherRoute } from '${routes('teacher.js')}';
  initSqlite(${JSON.stringify(file)});
  setRouterSettings({ strict_local_mode: true, chat_model: 'fake' });
  const verdict = (a) => /BONNE/.test(a) ? '{"passed":true,"score":90,"criteria":[{"name":"c","met":true}],"feedback":"ok"}'
    : '{"passed":false,"score":20,"criteria":[{"name":"c","met":false,"comment":"non"}],"feedback":"non","remediation":{"focus":"F","why":"W","retry":"R"}}';
  const ollamaClient = { chat: async ({ messages }) => { const p = messages.map(m => m.content).join('\\n');
    if (/plan d'apprentissage/.test(p)) return { message: { content: '[{"title":"A","summary":"a"},{"title":"B","summary":"b"}]' } };
    if (/évalue la partie/.test(p)) return { message: { content: verdict(p.split('apprenant').pop()) } };
    return { message: { content: 'Leçon. Question ?' } }; } };
  const app = new Hono(); app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));
  const call = async (method, p, body) => { const r = await app.request('/api' + p, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };`;

test('restart: module, both track states, passedAt, remediation, history and gate survive a process restart', () => {
  const file = path.join(tmp, 'prof4-restart.sqlite');
  const first = runProcess(`${PRELUDE(file)}
    const created = await call('POST', '/teacher/paths', { subject: 'Restart', register: 'socratique', schema_version: 2 });
    const id = created.body.path.id;
    const s0 = (await call('POST', '/teacher/paths/' + id + '/start')).body.steps[0];
    await call('POST', '/teacher/paths/' + id + '/steps/' + s0.id + '/theory/answer', { answer: 'mauvaise' });
    await call('POST', '/teacher/paths/' + id + '/steps/' + s0.id + '/theory/answer', { answer: 'BONNE' });
    const last = await call('POST', '/teacher/paths/' + id + '/steps/' + s0.id + '/practice/submit', { mode: 'self_report', confirmations: s0.tracks.practice.spec.checklist.map((_, i) => i === 0) });
    const attempts = await call('GET', '/teacher/paths/' + id + '/steps/' + s0.id + '/attempts');
    console.log(JSON.stringify({ id, stepId: s0.id, path: last.body.path, step: last.body.steps[0], attempts: attempts.body.attempts }));`);
  const second = runProcess(`${PRELUDE(file)}
    const got = await call('GET', '/teacher/paths/${first.id}');
    const attempts = await call('GET', '/teacher/paths/${first.id}/steps/${first.stepId}/attempts');
    const gate = await call('POST', '/teacher/paths/${first.id}/steps/${first.stepId}/advance');
    console.log(JSON.stringify({ path: got.body.path, step: got.body.steps.find(s => s.step_index === 0), attempts: attempts.body.attempts, gate: gate.status }));`);
  assert.equal(second.path.current_step_index, first.path.current_step_index);
  assert.equal(second.path.register, 'socratique');
  assert.deepEqual(second.step.tracks, first.step.tracks, 'states, passedAt, attempts counters, lastVerdict (with remediation) identical');
  assert.equal(second.step.tracks.theory.state, 'PASSED');
  assert.equal(second.step.tracks.practice.state, 'REMEDIATION');
  assert.equal(second.step.tracks.practice.lastVerdict.remediation.source, 'checklist');
  assert.deepEqual(second.attempts, first.attempts, 'history identical after restart');
  assert.equal(second.attempts.length, 3);
  assert.equal(second.gate, 409, 'gate still closed after restart');
});
