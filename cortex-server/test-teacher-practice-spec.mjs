import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
// Professeur V2 (PROF-3) — generated practice specs, practice modes per kind, server-side expected never exposed.
// In-memory SQLite only (never the real database); the local model is a scripted fake (strict local, no network).
// Run: node --test test-teacher-practice-spec.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings, updateLearningPathStep, getStepsByPathId } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import {
  allowedPracticeModes, publicPracticeSpec, canReplacePracticeSpec, createTracks, applyVerdict, GENERATED_PRACTICE_KINDS, EVIDENCE,
} from './src/lib/teacher-progress.js';
import { validatePracticeSpec } from './src/lib/teacher-evaluation.js';

initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-local-model' });

// ── scripted local model ────────────────────────────────────────────────────────────────────────────────────────────
const PLAN = JSON.stringify([{ title: 'Bases', summary: 'Les bases' }, { title: 'Suite', summary: 'La suite' }]);
const SPEC = { kind: 'exercise', instructions: 'Mesure la température de trois objets.', checklist: ['J’ai mesuré trois objets', 'J’ai noté les valeurs'], rubric: ['Mesures cohérentes'] };
const PASS = JSON.stringify({ passed: true, score: 90, criteria: [{ name: 'Idée', met: true }], feedback: 'Bien.' });
const model = { specReplies: [], specGate: null, specCalls: 0 };
const ollamaClient = {
  chat: async ({ messages }) => {
    const system = messages.map(m => m.content).join('\n');
    if (/plan d'apprentissage/.test(system)) return { message: { content: PLAN } };
    if (/partie PRATIQUE du module/.test(system)) {
      model.specCalls += 1;
      if (model.specGate) await model.specGate;
      const next = model.specReplies.length ? model.specReplies.shift() : JSON.stringify(SPEC);
      if (next instanceof Error) throw next;
      return { message: { content: next } };
    }
    if (/évalue la partie THÉORIE/.test(system) || /évalue la partie PRATIQUE/.test(system)) return { message: { content: PASS } };
    return { message: { content: 'Explication.\n\nQuestion : reformule l’idée.' } };
  },
};
const app = new Hono();
app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));
const call = async (method, path, body) => {
  const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
async function newPath(schemaVersion = 2) {
  const created = await call('POST', '/teacher/paths', { subject: 'Thermodynamique', register: 'standard', schema_version: schemaVersion });
  assert.equal(created.status, 201);
  const started = await call('POST', `/teacher/paths/${created.body.path.id}/start`);
  assert.equal(started.status, 200);
  return started.body;
}
const stepOf = (body, i) => body.steps.find(s => s.step_index === i);
const specUrl = (p, s) => `/teacher/paths/${p}/steps/${s}/practice/spec`;
const storedStep = (pathId, i) => getStepsByPathId(pathId).find(s => s.step_index === i);

// ═══ pure ═════════════════════════════════════════════════════════════════════════════════════════════════════════
test('validatePracticeSpec: accepts the three generated kinds, bounded; drops any model-written expected answer', () => {
  const ok = validatePracticeSpec({ ...SPEC, expected: '42', evil: 'x' });
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.spec).sort(), ['checklist', 'generated', 'instructions', 'kind', 'rubric']);
  assert.equal(ok.spec.generated, true);
  assert.equal(validatePracticeSpec({ kind: 'deliverable', instructions: 'Rédige un plan.' }).ok, true);
  assert.deepEqual(validatePracticeSpec({ kind: 'deliverable', instructions: 'x', checklist: ['a'] }).spec.checklist, [], 'deliverable: nothing to self-declare');
  assert.equal(validatePracticeSpec({ kind: 'checklist', instructions: 'Fais', checklist: ['a', 'b'] }).ok, true);
  assert.equal(validatePracticeSpec({ ...SPEC, instructions: 'y'.repeat(5000) }).spec.instructions.length, 1500);
  assert.deepEqual(GENERATED_PRACTICE_KINDS, ['exercise', 'deliverable', 'checklist']);
});

test('validatePracticeSpec: rejects (fail closed) anything outside the contract', () => {
  const bad = [
    null, [], 'texte', {},
    { kind: 'result', instructions: 'Calcule 6×7', expected: '42' }, // a model may never create a VERIFIED-able spec
    { kind: 'mcq', instructions: 'x', checklist: ['a'] },
    { kind: 'exercise', instructions: '   ', checklist: ['a'] },
    { kind: 'exercise', instructions: 'x' }, // no checklist to confirm
    { kind: 'exercise', instructions: 'x', checklist: [] },
    { kind: 'exercise', instructions: 'x', checklist: ['a', 2] },
    { kind: 'exercise', instructions: 'x', checklist: Array(7).fill('a') },
    { kind: 'exercise', instructions: 'x', checklist: ['a'], rubric: 'pas un tableau' },
  ];
  for (const raw of bad) assert.equal(validatePracticeSpec(raw).ok, false, JSON.stringify(raw));
});

test('practice modes per kind; public spec never carries expected; spec replaceable only before any attempt', () => {
  assert.deepEqual(allowedPracticeModes({ kind: 'result', checklist: ['a'] }), ['deliverable']);
  assert.deepEqual(allowedPracticeModes({ kind: 'deliverable' }), ['deliverable']);
  assert.deepEqual(allowedPracticeModes({ kind: 'exercise', checklist: ['a'] }), ['self_report', 'deliverable']);
  assert.deepEqual(allowedPracticeModes({ kind: 'checklist', checklist: ['a'] }), ['self_report', 'deliverable'], 'PROF-2 default spec keeps both modes');
  assert.deepEqual(allowedPracticeModes({ kind: 'exercise', checklist: [] }), ['deliverable']);
  assert.deepEqual(publicPracticeSpec({ kind: 'result', instructions: 'x', expected: '42' }), { kind: 'result', instructions: 'x' });
  const t = createTracks({ active: true, planStep: { title: 'B' } });
  assert.equal(canReplacePracticeSpec(t).ok, true);
  assert.equal(canReplacePracticeSpec(createTracks({ active: false })).code, 'TRACK_LOCKED');
  const failed = applyVerdict(t, 'practice', { passed: false }, { evidence: EVIDENCE.SELF_REPORTED });
  assert.equal(canReplacePracticeSpec(failed).code, 'SPEC_FROZEN');
  const passed = applyVerdict(t, 'practice', { passed: true }, { evidence: EVIDENCE.SELF_REPORTED });
  assert.equal(canReplacePracticeSpec(passed).code, 'TRACK_ALREADY_PASSED');
  const authored = { ...t, practice: { ...t.practice, spec: { kind: 'result', instructions: 'x', expected: '42' } } };
  assert.equal(canReplacePracticeSpec(authored).code, 'SPEC_NOT_DEFAULT', 'a server-authored spec is never replaced by a model');
  const generated = { ...t, practice: { ...t.practice, spec: { ...SPEC, generated: true } } };
  assert.equal(canReplacePracticeSpec(generated).code, 'SPEC_NOT_DEFAULT');
});

// ═══ route ════════════════════════════════════════════════════════════════════════════════════════════════════════
test('generation: valid model spec stored once (generated:true), second call served from storage without the model', async () => {
  const body = await newPath();
  const s0 = stepOf(body, 0);
  assert.equal(s0.tracks.practice.spec.generated, false);
  const before = model.specCalls;
  const gen = await call('POST', specUrl(body.path.id, s0.id));
  assert.equal(gen.status, 200);
  assert.equal(gen.body.generated, true);
  assert.equal(gen.body.cached, false);
  const spec = stepOf(gen.body, 0).tracks.practice.spec;
  assert.equal(spec.kind, 'exercise');
  assert.deepEqual(spec.checklist, SPEC.checklist);
  assert.equal(storedStep(body.path.id, 0).tracks.practice.spec.generated, true, 'persisted');
  assert.equal(stepOf(gen.body, 0).tracks.theory.state, 'ACTIVE', 'theory untouched');
  const again = await call('POST', specUrl(body.path.id, s0.id));
  assert.equal(again.body.cached, true);
  assert.equal(model.specCalls, before + 1, 'no second model call');
});

test('generation fail-closed: non-JSON, invalid or result-kind output keeps the generic default spec', async () => {
  for (const replies of [['pas du json', 'toujours pas'], [JSON.stringify({ kind: 'result', instructions: 'Calcule', expected: '42' })], [JSON.stringify({ kind: 'exercise', instructions: 'x' })]]) {
    const body = await newPath();
    const s0 = stepOf(body, 0);
    model.specReplies.push(...replies);
    const gen = await call('POST', specUrl(body.path.id, s0.id));
    assert.equal(gen.status, 200);
    assert.equal(gen.body.generated, false);
    assert.ok(gen.body.reason);
    const stored = storedStep(body.path.id, 0).tracks.practice.spec;
    assert.equal(stored.generated, false, 'default kept');
    assert.equal(stored.expected, undefined, 'no model-written expected stored');
    assert.equal(stored.kind, 'checklist');
    model.specReplies.length = 0;
  }
});

test('generation: provider failure → 503, default spec kept and still usable', async () => {
  const body = await newPath();
  const s0 = stepOf(body, 0);
  model.specReplies.push(new Error('ollama down'));
  const gen = await call('POST', specUrl(body.path.id, s0.id));
  assert.equal(gen.status, 503);
  const n = s0.tracks.practice.spec.checklist.length;
  const submit = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: Array(n).fill(true) });
  assert.equal(submit.status, 200);
  assert.equal(submit.body.verdict.passed, true);
});

test('generation refused: LOCKED module, V1 parcours, after an attempt (frozen), already passed', async () => {
  const body = await newPath();
  const [s0, s1] = [stepOf(body, 0), stepOf(body, 1)];
  assert.equal((await call('POST', specUrl(body.path.id, s1.id))).body.code, 'TRACK_LOCKED');
  const v1 = await newPath(1);
  assert.equal((await call('POST', specUrl(v1.path.id, stepOf(v1, 0).id))).body.code, 'NOT_DUAL_TRACK');
  const n = s0.tracks.practice.spec.checklist.length;
  await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: [false, ...Array(n - 1).fill(true)] });
  const frozen = await call('POST', specUrl(body.path.id, s0.id));
  assert.equal(frozen.status, 409);
  assert.equal(frozen.body.code, 'SPEC_FROZEN');
  await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: Array(n).fill(true) });
  assert.equal((await call('POST', specUrl(body.path.id, s0.id))).body.code, 'TRACK_ALREADY_PASSED');
});

test('generation race: an attempt recorded during the model call is never orphaned from its exercise', async () => {
  const body = await newPath();
  const s0 = stepOf(body, 0);
  let release;
  model.specGate = new Promise(r => { release = r; });
  const pending = call('POST', specUrl(body.path.id, s0.id));
  await new Promise(r => setTimeout(r, 20));
  const n = s0.tracks.practice.spec.checklist.length;
  const submit = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: [false, ...Array(n - 1).fill(true)] });
  assert.equal(submit.status, 200);
  release();
  model.specGate = null;
  const gen = await pending;
  assert.equal(gen.body.generated, false);
  assert.equal(gen.body.reason, 'SPEC_FROZEN');
  assert.equal(storedStep(body.path.id, 0).tracks.practice.spec.generated, false, 'the attempted exercise is unchanged');
});

test('modes enforced server-side: a checkable result cannot be self-declared; a deliverable needs a submission', async () => {
  const body = await newPath();
  const s0 = stepOf(body, 0);
  const stored = storedStep(body.path.id, 0);
  updateLearningPathStep(s0.id, { tracks: { ...stored.tracks, practice: { ...stored.tracks.practice, spec: { kind: 'result', instructions: 'Calcule 6×7', checklist: ['fait'], expected: '42' } } } });
  const selfReport = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: [true] });
  assert.equal(selfReport.status, 409);
  assert.equal(selfReport.body.code, 'PRACTICE_MODE_NOT_ALLOWED');
  assert.deepEqual(selfReport.body.allowed_modes, ['deliverable']);
  assert.equal(storedStep(body.path.id, 0).tracks.practice.attempts, 0, 'refused mode is not an attempt');
  const right = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/practice/submit`, { mode: 'deliverable', submission: '42' });
  assert.equal(right.body.verdict.passed, true);
  assert.equal(stepOf(right.body, 0).tracks.practice.evidence, 'VERIFIED');

  const other = await newPath();
  const o0 = stepOf(other, 0);
  model.specReplies.push(JSON.stringify({ kind: 'deliverable', instructions: 'Rédige un compte rendu.' }));
  await call('POST', specUrl(other.path.id, o0.id));
  const declared = await call('POST', `/teacher/paths/${other.path.id}/steps/${o0.id}/practice/submit`, { mode: 'self_report', confirmations: [] });
  assert.equal(declared.body.code, 'PRACTICE_MODE_NOT_ALLOWED');
});

test('a server-side expected answer never appears in any response', async () => {
  const body = await newPath();
  const s0 = stepOf(body, 0);
  const stored = storedStep(body.path.id, 0);
  const SECRET = 'reponse-secrete-4242';
  updateLearningPathStep(s0.id, { tracks: { ...stored.tracks, practice: { ...stored.tracks.practice, spec: { kind: 'result', instructions: 'Calcule', expected: SECRET } } } });
  const responses = [
    await call('GET', `/teacher/paths/${body.path.id}`),
    await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/explain`),
    await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/explain`), // cached branch
    await call('POST', specUrl(body.path.id, s0.id)),
    await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/theory/answer`, { answer: 'ma réponse' }),
    await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/practice/submit`, { mode: 'deliverable', submission: 'faux' }),
    await call('GET', `/teacher/paths/${body.path.id}/steps/${s0.id}/attempts`),
  ];
  for (const r of responses) {
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(SECRET), text.slice(0, 200));
    assert.ok(!text.includes('"expected"'), text.slice(0, 200));
  }
  assert.equal(responses[3].status, 409);
  assert.equal(responses[3].body.code, 'SPEC_NOT_DEFAULT', 'generation never replaces a server-authored spec');
  assert.equal(storedStep(body.path.id, 0).tracks.practice.spec.expected, SECRET, 'still stored server-side for the deterministic check');
});

test('end to end: generated exercise self-reported + theory passed → gate opens, next module unlocked and can generate its own', async () => {
  const body = await newPath();
  const s0 = stepOf(body, 0);
  const gen = await call('POST', specUrl(body.path.id, s0.id));
  const checklist = stepOf(gen.body, 0).tracks.practice.spec.checklist;
  assert.equal((await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/advance`)).status, 409, 'nothing passed yet');
  const theory = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/theory/answer`, { answer: 'La chaleur va du chaud vers le froid.' });
  assert.equal(theory.body.can_advance, false);
  const practice = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: checklist.map(() => true) });
  assert.equal(practice.body.can_advance, true);
  assert.equal(stepOf(practice.body, 0).tracks.practice.evidence, 'SELF_REPORTED');
  const advanced = await call('POST', `/teacher/paths/${body.path.id}/steps/${s0.id}/advance`);
  assert.equal(advanced.status, 200);
  const s1 = stepOf(advanced.body, 1);
  assert.deepEqual([s1.tracks.theory.state, s1.tracks.practice.state], ['ACTIVE', 'ACTIVE']);
  assert.equal((await call('POST', specUrl(body.path.id, s1.id))).body.generated, true);
});
