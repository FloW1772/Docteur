import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
// Professeur V2 (PROF-2) — dual-track model, structured verdicts, independent remediation, attempt history, server gate.
// In-memory SQLite only (never the real database); the local model is a scripted fake.
// Run: node --test test-teacher-dual-track.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings, updateLearningPathStep, getStepsByPathId } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import {
  createTracks, canAdvance, canAttempt, applyVerdict, activateTracks, deriveStepStatus, TRACK_STATES as S, EVIDENCE,
} from './src/lib/teacher-progress.js';
import { validateVerdict, selfReportVerdict, deterministicPracticeCheck, PASS_THRESHOLD } from './src/lib/teacher-evaluation.js';
import { presentStep } from './src/lib/teacher-legacy.js';

initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-local-model' }); // local model only: no network at all

// ── scripted local model ────────────────────────────────────────────────────────────────────────────────────────────
const script = [];
const PLAN = JSON.stringify([{ title: 'Bases', summary: 'Les bases' }, { title: 'Suite', summary: 'La suite' }, { title: 'Fin', summary: 'La fin' }]);
const ollamaClient = {
  chat: async ({ messages }) => {
    if (script.length) return { message: { content: script.shift() } };
    const system = messages.map(m => m.content).join('\n');
    if (/plan d'apprentissage/.test(system)) return { message: { content: PLAN } };
    return { message: { content: 'Explication de l\'étape.\n\nQuestion : peux-tu reformuler l\'idée principale ?' } };
  },
};
const app = new Hono();
app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));
const call = async (method, path, body) => {
  const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
const pass = (extra = {}) => JSON.stringify({ passed: true, score: 85, criteria: [{ name: 'Idée principale', met: true }], feedback: 'Bien.', ...extra });
const fail = () => JSON.stringify({ passed: false, score: 30, criteria: [{ name: 'Idée principale', met: false, comment: 'confus' }], feedback: 'À revoir.' });

async function newPath(schemaVersion) {
  const created = await call('POST', '/teacher/paths', { subject: 'Thermodynamique', register: 'standard', ...(schemaVersion ? { schema_version: schemaVersion } : {}) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const started = await call('POST', `/teacher/paths/${created.body.path.id}/start`);
  assert.equal(started.status, 200);
  return started.body;
}
const stepOf = (body, i) => body.steps.find(s => s.step_index === i);

// ═══ pure model ════════════════════════════════════════════════════════════════════════════════════════════════════
test('tracks: first module ACTIVE on both tracks, others LOCKED; gate needs BOTH passed', () => {
  const t0 = createTracks({ active: true, planStep: { title: 'Bases' } });
  const t1 = createTracks({ active: false, planStep: { title: 'Suite' } });
  assert.deepEqual([t0.theory.state, t0.practice.state], [S.ACTIVE, S.ACTIVE]);
  assert.deepEqual([t1.theory.state, t1.practice.state], [S.LOCKED, S.LOCKED]);
  assert.match(t0.practice.spec.instructions, /Bases/);
  assert.equal(t0.practice.spec.generated, false, 'nothing pretended: default spec flagged as not generated');
  assert.equal(canAdvance({ tracks: t0 }), false, 'nothing passed');
  const now = '2026-10-06T10:00:00.000Z';
  const theoryOnly = applyVerdict(t0, 'theory', { passed: true }, { now });
  assert.equal(canAdvance({ tracks: theoryOnly }), false, 'theory only cannot advance');
  const practiceOnly = applyVerdict(t0, 'practice', { passed: true }, { now, evidence: EVIDENCE.SELF_REPORTED });
  assert.equal(canAdvance({ tracks: practiceOnly }), false, 'practice only cannot advance');
  const both = applyVerdict(theoryOnly, 'practice', { passed: true }, { now, evidence: EVIDENCE.MODEL_ASSESSED });
  assert.equal(canAdvance({ tracks: both }), true, 'theory + practice can advance');
  assert.equal(canAdvance({ tracks: null }), false, 'a V1 step never goes through the V2 gate');
  assert.equal(canAdvance({}), false);
});

test('independent remediation both ways; passedAt preserved; input never mutated; PASSED is final', () => {
  const t = createTracks({ active: true });
  const theoryPassed = applyVerdict(t, 'theory', { passed: true }, { now: 'T1' });
  const snapshot = JSON.stringify(theoryPassed);
  const practiceFailed = applyVerdict(theoryPassed, 'practice', { passed: false }, { now: 'T2', evidence: EVIDENCE.SELF_REPORTED });
  assert.equal(JSON.stringify(theoryPassed), snapshot, 'input not mutated');
  assert.equal(practiceFailed.theory.state, S.PASSED, 'theory stays PASSED');
  assert.equal(practiceFailed.theory.passedAt, 'T1', 'theory passedAt kept');
  assert.equal(practiceFailed.practice.state, S.REMEDIATION, 'only practice in remediation');
  const inverse = applyVerdict(applyVerdict(t, 'practice', { passed: true }, { now: 'T3', evidence: EVIDENCE.VERIFIED }), 'theory', { passed: false }, { now: 'T4' });
  assert.deepEqual([inverse.theory.state, inverse.practice.state, inverse.practice.passedAt], [S.REMEDIATION, S.PASSED, 'T3'], 'and the inverse');
  const bothFailed = applyVerdict(applyVerdict(t, 'theory', { passed: false }), 'practice', { passed: false }, { evidence: EVIDENCE.SELF_REPORTED });
  assert.deepEqual([bothFailed.theory.state, bothFailed.practice.state], [S.REMEDIATION, S.REMEDIATION]);
  assert.equal(applyVerdict(bothFailed, 'theory', { passed: true }, { now: 'T5' }).practice.state, S.REMEDIATION, 'retrying one track leaves the other one alone');
  assert.deepEqual(canAttempt(theoryPassed, 'theory'), { ok: false, code: 'TRACK_ALREADY_PASSED' });
  assert.throws(() => applyVerdict(theoryPassed, 'theory', { passed: false }), /TRACK_ALREADY_PASSED/, 'a passed track can not regress');
  assert.throws(() => applyVerdict(createTracks({ active: false }), 'theory', { passed: true }), /TRACK_LOCKED/);
  assert.throws(() => applyVerdict(t, 'practice', { passed: true }), /PRACTICE_EVIDENCE_REQUIRED/, 'practice always records its provenance');
  assert.throws(() => applyVerdict(t, 'practice', { passed: true }, { evidence: 'TRUST_ME' }), /PRACTICE_EVIDENCE_REQUIRED/);
  assert.equal(applyVerdict(t, 'theory', { passed: 'true' }).theory.state, S.REMEDIATION, 'only passed === true passes');
  assert.equal(activateTracks(createTracks({ active: false })).theory.state, S.ACTIVE);
  assert.equal(activateTracks(practiceFailed).practice.state, S.REMEDIATION, 'activation never resets a track');
  assert.equal(deriveStepStatus({ tracks: practiceFailed }, { isCurrent: true }), 'active');
});

test('structured verdict contract: valid PASS / FAIL, bounded, inconsistencies downgraded, malformed rejected', () => {
  const ok = validateVerdict({ passed: true, score: 80, criteria: [{ name: 'A', met: true, comment: 'x' }], feedback: 'ok' });
  assert.equal(ok.ok, true); assert.equal(ok.verdict.passed, true); assert.equal(ok.verdict.score, 80);
  const ko = validateVerdict({ passed: false, score: 20, criteria: [], feedback: 'non' });
  assert.equal(ko.ok, true); assert.equal(ko.verdict.passed, false);
  const lowScore = validateVerdict({ passed: true, score: PASS_THRESHOLD - 1, criteria: [] });
  assert.equal(lowScore.verdict.passed, false, 'passed:true with a low score is not a pass');
  assert.equal(lowScore.verdict.inconsistent, true);
  assert.equal(validateVerdict({ passed: true, score: 90, criteria: [{ name: 'A', met: false }] }).verdict.passed, false, 'an unmet criterion is not a pass');
  for (const bad of [null, 'VALIDÉ', 42, [], { score: 90 }, { passed: 'true', score: 90 }, { passed: true }, { passed: true, score: 150 },
    { passed: true, score: -1 }, { passed: true, score: Number.NaN }, { passed: true, score: 90, criteria: 'all good' },
    { passed: true, score: 90, criteria: Array.from({ length: 11 }, (_, i) => ({ name: `c${i}`, met: true })) },
    { passed: true, score: 90, criteria: [{ name: '', met: true }] }, { passed: true, score: 90, criteria: [{ name: 'a', met: 'yes' }] },
    { passed: true, score: 90, feedback: 12 }]) {
    assert.equal(validateVerdict(bad).ok, false, JSON.stringify(bad));
  }
  const long = validateVerdict({ passed: false, score: 10, criteria: [{ name: 'n'.repeat(999), met: false, comment: 'c'.repeat(9999) }], feedback: 'f'.repeat(99999) });
  assert.ok(long.verdict.criteria[0].name.length <= 160 && long.verdict.criteria[0].comment.length <= 600 && long.verdict.feedback.length <= 4000, 'strings bounded');
});

test('self-report and deterministic checks: SELF_REPORTED needs every item confirmed; VERIFIED only from a server-side expected value', () => {
  const spec = { kind: 'checklist', checklist: ['a', 'b', 'c'] };
  assert.equal(selfReportVerdict(spec, [true, true, true]).verdict.passed, true);
  assert.equal(selfReportVerdict(spec, [true, false, true]).verdict.passed, false);
  assert.equal(selfReportVerdict(spec, [true, true]).ok, false, 'one answer per item');
  assert.equal(selfReportVerdict(spec, [true, 'yes', true]).ok, false);
  assert.equal(selfReportVerdict({ kind: 'checklist', checklist: [] }, []).ok, false);
  assert.equal(deterministicPracticeCheck({ kind: 'checklist' }, '42'), null, 'no deterministic check → never VERIFIED');
  assert.equal(deterministicPracticeCheck({ kind: 'result' }, '42'), null);
  assert.equal(deterministicPracticeCheck({ kind: 'result', expected: ' 42 ' }, '42').passed, true);
  assert.equal(deterministicPracticeCheck({ kind: 'result', expected: '42' }, '41').passed, false);
});

// ═══ routes: V1 unchanged ══════════════════════════════════════════════════════════════════════════════════════════
test('V1 (default) parcours: schema 1, no tracks, historical answer + advance behaviour unchanged, V2 endpoints refused', async () => {
  const body = await newPath();
  assert.equal(body.path.schema_version, 1); assert.equal(body.path.mode, 'standard'); assert.equal(body.path.legacy, true);
  const s0 = stepOf(body, 0);
  assert.equal(s0.tracks, null, 'no track invented for a V1 step');
  assert.deepEqual(s0.track_view.practice, { state: 'NOT_APPLICABLE' });
  assert.equal(s0.track_view.theory.state, 'ACTIVE');
  script.push('Très bien, VALIDÉ.');
  const answered = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/answer`, { answer: 'réponse' });
  assert.equal(answered.status, 200); assert.equal(answered.body.validated, true, 'V1 keeps its historical rule');
  const advanced = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/advance`);
  assert.equal(advanced.status, 200); assert.equal(advanced.body.path.current_step_index, 1);
  const s1 = stepOf(advanced.body, 1);
  const unvalidated = await call('POST', `/teacher/paths/${body.path.id}/steps/${s1.id}/advance`);
  assert.equal(unvalidated.status, 200, 'V1 /advance stays ungated, exactly as before PROF-2');
  for (const [path, payload] of [[`/theory/answer`, { answer: 'x' }], [`/practice/submit`, { mode: 'self_report', confirmations: [true, true] }]]) {
    const r = await call('POST', `/teacher/paths/${body.path.id}/steps/${s1.id}${path}`, payload);
    assert.equal(r.status, 409); assert.equal(r.body.code, 'NOT_DUAL_TRACK');
  }
});

// ═══ routes: V2 ════════════════════════════════════════════════════════════════════════════════════════════════════
test('V2 creation: schema 2, mode standard, tracks on every module, server gate on /advance, V1 regex endpoint refused', async () => {
  const body = await newPath(2);
  assert.equal(body.path.schema_version, 2); assert.equal(body.path.mode, 'standard'); assert.equal(body.path.legacy, false);
  assert.equal(body.steps.length, 3);
  assert.deepEqual(body.steps.map(s => [s.tracks.theory.state, s.tracks.practice.state]), [[S.ACTIVE, S.ACTIVE], [S.LOCKED, S.LOCKED], [S.LOCKED, S.LOCKED]]);
  const s0 = stepOf(body, 0); const s1 = stepOf(body, 1);
  const denied = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/advance`);
  assert.equal(denied.status, 409); assert.equal(denied.body.code, 'TRACKS_NOT_PASSED');
  assert.deepEqual([denied.body.theory, denied.body.practice], [S.ACTIVE, S.ACTIVE]);
  const skip = await call('POST', `/teacher/paths/${body.path.id}/steps/${s1.id}/advance`);
  assert.equal(skip.status, 409, 'a direct call on a later module is refused too');
  const locked = await call('POST', `/teacher/paths/${body.path.id}/steps/${s1.id}/theory/answer`, { answer: 'x' });
  assert.equal(locked.status, 409); assert.equal(locked.body.code, 'TRACK_LOCKED');
  script.push('Très bien, VALIDÉ.');
  const regex = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/answer`, { answer: 'x' });
  assert.equal(regex.status, 409); assert.equal(regex.body.code, 'USE_DUAL_TRACK_ENDPOINTS');
  script.length = 0;
  const after = await call('GET', `/teacher/paths/${body.path.id}`);
  assert.equal(after.body.path.current_step_index, 0, 'nothing moved');
  assert.equal(stepOf(after.body, 0).status, 'active');
});

test('V2 full module: theory PASS alone cannot advance; practice SELF_REPORTED PASS → advance → next module unlocked', async () => {
  const body = await newPath(2);
  const id = body.path.id; const s0 = stepOf(body, 0);
  script.push(pass());
  const theory = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/theory/answer`, { answer: 'La chaleur va du chaud vers le froid.' });
  assert.equal(theory.status, 200); assert.equal(theory.body.evaluated, true); assert.equal(theory.body.verdict.passed, true);
  assert.equal(theory.body.can_advance, false);
  assert.equal((await call('POST', `/teacher/paths/${id}/steps/${s0.id}/advance`)).status, 409, 'theory only: denied');
  const items = stepOf(theory.body, 0).tracks.practice.spec.checklist;
  const practice = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: items.map(() => true), evidence: 'VERIFIED' });
  assert.equal(practice.status, 200); assert.equal(practice.body.can_advance, true);
  const p = stepOf(practice.body, 0).tracks.practice;
  assert.equal(p.state, S.PASSED);
  assert.equal(p.evidence, EVIDENCE.SELF_REPORTED, 'a client claim of VERIFIED is ignored');
  assert.equal(stepOf(practice.body, 0).tracks.theory.state, S.PASSED);
  const advanced = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/advance`);
  assert.equal(advanced.status, 200); assert.equal(advanced.body.finished, false); assert.equal(advanced.body.path.current_step_index, 1);
  assert.equal(stepOf(advanced.body, 0).status, 'done');
  assert.deepEqual([stepOf(advanced.body, 1).tracks.theory.state, stepOf(advanced.body, 1).tracks.practice.state], [S.ACTIVE, S.ACTIVE], 'next module unlocked');
  assert.deepEqual([stepOf(advanced.body, 2).tracks.theory.state], [S.LOCKED], 'the one after stays locked');
  const again = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/theory/answer`, { answer: 'x' });
  assert.equal(again.status, 409); assert.equal(again.body.code, 'TRACK_ALREADY_PASSED');
});

test('V2 remediation + history: practice FAIL then PASS, theory untouched; every attempt kept in order', async () => {
  const body = await newPath(2);
  const id = body.path.id; const s0 = stepOf(body, 0);
  script.push(pass());
  const theory = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/theory/answer`, { answer: 'ok' });
  const theoryPassedAt = stepOf(theory.body, 0).tracks.theory.passedAt;
  const n = stepOf(theory.body, 0).tracks.practice.spec.checklist.length;
  const failed = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: [true, ...Array(n - 1).fill(false)] });
  assert.equal(stepOf(failed.body, 0).tracks.practice.state, S.REMEDIATION);
  assert.equal(stepOf(failed.body, 0).tracks.theory.state, S.PASSED);
  assert.equal(stepOf(failed.body, 0).tracks.theory.passedAt, theoryPassedAt, 'theory passedAt preserved');
  assert.equal((await call('POST', `/teacher/paths/${id}/steps/${s0.id}/advance`)).status, 409);
  const retried = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: Array(n).fill(true), note: 'fait ce soir' });
  assert.equal(stepOf(retried.body, 0).tracks.practice.state, S.PASSED);
  assert.equal(stepOf(retried.body, 0).tracks.practice.attempts, 2);
  const history = await call('GET', `/teacher/paths/${id}/steps/${s0.id}/attempts`);
  assert.deepEqual(history.body.attempts.map(a => [a.track, a.passed, a.evidence]), [['theory', true, null], ['practice', false, 'SELF_REPORTED'], ['practice', true, 'SELF_REPORTED']]);
  assert.equal(history.body.attempts[2].payload.note, 'fait ce soir');
  assert.equal((await call('GET', `/teacher/paths/${id}/steps/${s0.id}/attempts?track=practice`)).body.attempts.length, 2);
  assert.equal((await call('GET', `/teacher/paths/${id}/steps/${s0.id}/attempts?track=other`)).status, 400);
});

test('V2 fail closed: free text "non VALIDÉ" / malformed JSON never passes, state unchanged, attempt recorded as invalid', async () => {
  const body = await newPath(2);
  const id = body.path.id; const s0 = stepOf(body, 0);
  script.push('Ta réponse est non VALIDÉ, désolé.', 'Toujours non VALIDÉ.'); // first answer + the single reformulation retry
  const r = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/theory/answer`, { answer: 'x' });
  assert.equal(r.status, 200); assert.equal(r.body.evaluated, false); assert.equal(r.body.verdict.passed, false); assert.equal(r.body.verdict.invalid, true);
  assert.equal(stepOf(r.body, 0).tracks.theory.state, S.ACTIVE, 'neither passed nor counted as a learner failure');
  script.push(JSON.stringify({ passed: 'true', score: 99 }));
  const malformed = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/theory/answer`, { answer: 'x' });
  assert.equal(malformed.body.evaluated, false); assert.equal(stepOf(malformed.body, 0).tracks.theory.state, S.ACTIVE);
  script.push(JSON.stringify({ passed: true, score: 15, criteria: [] }));
  const inconsistent = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/theory/answer`, { answer: 'x' });
  assert.equal(inconsistent.body.evaluated, true); assert.equal(inconsistent.body.verdict.passed, false, 'inconsistent PASS downgraded');
  assert.equal(stepOf(inconsistent.body, 0).tracks.theory.state, S.REMEDIATION);
  const attempts = (await call('GET', `/teacher/paths/${id}/steps/${s0.id}/attempts`)).body.attempts;
  assert.deepEqual(attempts.map(a => [a.passed, a.verdict.invalid === true]), [[false, true], [false, true], [false, false]]);
  assert.equal((await call('POST', `/teacher/paths/${id}/steps/${s0.id}/advance`)).status, 409);
});

test('V2 practice provenance: deliverable → MODEL_ASSESSED; VERIFIED only from a server-side expected result', async () => {
  const body = await newPath(2);
  const id = body.path.id; const s0 = stepOf(body, 0);
  script.push(pass());
  const assessed = await call('POST', `/teacher/paths/${id}/steps/${s0.id}/practice/submit`, { mode: 'deliverable', submission: 'Mon compte rendu…', evidence: 'VERIFIED' });
  assert.equal(stepOf(assessed.body, 0).tracks.practice.evidence, EVIDENCE.MODEL_ASSESSED);
  // a module whose spec carries a server-side expected value (as PROF-3 generation may set) → deterministic VERIFIED
  const other = await newPath(2);
  const t0 = stepOf(other, 0);
  updateLearningPathStep(t0.id, { tracks: { ...t0.tracks, practice: { ...t0.tracks.practice, spec: { kind: 'result', instructions: 'Calcule 6×7', expected: '42' } } } });
  const wrong = await call('POST', `/teacher/paths/${other.path.id}/steps/${t0.id}/practice/submit`, { mode: 'deliverable', submission: '41' });
  assert.deepEqual([stepOf(wrong.body, 0).tracks.practice.state, stepOf(wrong.body, 0).tracks.practice.evidence], [S.REMEDIATION, EVIDENCE.VERIFIED]);
  const right = await call('POST', `/teacher/paths/${other.path.id}/steps/${t0.id}/practice/submit`, { mode: 'deliverable', submission: ' 42 ' });
  assert.deepEqual([stepOf(right.body, 0).tracks.practice.state, stepOf(right.body, 0).tracks.practice.evidence], [S.PASSED, EVIDENCE.VERIFIED]);
  const fresh = await newPath(2); // practice still open there (an already-passed track answers 409 before reading the body)
  const f0 = stepOf(fresh, 0);
  for (const bad of [{}, { mode: 'self_report', confirmations: [true] }, { mode: 'deliverable', submission: '' }, { mode: 'teleport' }]) {
    assert.equal((await call('POST', `/teacher/paths/${fresh.path.id}/steps/${f0.id}/practice/submit`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(stepOf((await call('GET', `/teacher/paths/${fresh.path.id}`)).body, 0).tracks.practice.attempts, 0, 'rejected inputs are not attempts');
  assert.equal((await call('POST', `/teacher/paths/${id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: [true, true] })).body.code, 'TRACK_ALREADY_PASSED');
});

test('reload persistence: states, evidence and history are read back identically; back never resets a track', async () => {
  const body = await newPath(2);
  const id = body.path.id; const s0 = stepOf(body, 0);
  script.push(pass());
  await call('POST', `/teacher/paths/${id}/steps/${s0.id}/theory/answer`, { answer: 'ok' });
  const n = s0.tracks.practice.spec.checklist.length;
  await call('POST', `/teacher/paths/${id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: Array(n).fill(true) });
  await call('POST', `/teacher/paths/${id}/steps/${s0.id}/advance`);
  const s1 = stepOf((await call('GET', `/teacher/paths/${id}`)).body, 1);
  await call('POST', `/teacher/paths/${id}/steps/${s1.id}/back`);
  const reloaded = await call('GET', `/teacher/paths/${id}`);
  const r0 = stepOf(reloaded.body, 0);
  assert.deepEqual([r0.tracks.theory.state, r0.tracks.practice.state, r0.tracks.practice.evidence], [S.PASSED, S.PASSED, EVIDENCE.SELF_REPORTED]);
  assert.equal(stepOf(reloaded.body, 1).tracks.theory.state, S.ACTIVE, 'going back does not relock or reset');
  assert.equal((await call('POST', `/teacher/paths/${id}/steps/${s0.id}/advance`)).status, 200, 'and the gate lets the validated module through again');
  assert.equal(getStepsByPathId(id).find(s => s.step_index === 0).tracks.theory.state, S.PASSED, 'same through the data layer');
  assert.equal(presentStep(reloaded.body.path, r0).legacy, false);
});

test('parcours deletion also deletes its attempt history (no orphan rows)', async () => {
  const body = await newPath(2);
  const id = body.path.id; const s0 = stepOf(body, 0);
  script.push(fail());
  await call('POST', `/teacher/paths/${id}/steps/${s0.id}/theory/answer`, { answer: 'x' });
  assert.equal((await call('GET', `/teacher/paths/${id}/steps/${s0.id}/attempts`)).body.attempts.length, 1);
  assert.equal((await call('DELETE', `/teacher/paths/${id}`)).status, 200);
  const { getTrackAttempts } = await import('./src/lib/sqlite.js');
  assert.deepEqual(getTrackAttempts(s0.id), []);
});

test('schema_version validation on creation', async () => {
  assert.equal((await call('POST', '/teacher/paths', { subject: 'x', schema_version: 3 })).status, 400);
  assert.equal((await call('POST', '/teacher/paths', { subject: 'x', schema_version: 'two' })).status, 400);
});
