import './test-setup.mjs'; // must be first: isolates providers and the database from the real installation
// PROF-2 finalization: bounded register matrix. Every real pedagogical register
// runs through the same deterministic V1 and V2 architecture; no cloud call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import { TEACHER_REGISTERS, teacherRegisterInstruction } from './src/lib/teacher-register.js';

initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-register-matrix' });

const PLAN = JSON.stringify([
  { title: 'Fondations', summary: 'Comprendre les fondations' },
  { title: 'Application', summary: 'Appliquer les acquis' },
]);
const PASS = JSON.stringify({
  passed: true,
  score: 90,
  criteria: [{ name: 'Compréhension', met: true }],
  feedback: 'Acquis.',
});
const modelCalls = [];
const ollamaClient = {
  chat: async ({ messages }) => {
    modelCalls.push(messages);
    const prompt = messages.map((message) => message.content).join('\n');
    if (prompt.includes("plan d'apprentissage")) return { message: { content: PLAN } };
    if (prompt.includes('partie THÉORIE') || prompt.includes('partie PRATIQUE')) {
      return { message: { content: PASS } };
    }
    return { message: { content: 'Bonne réponse, VALIDÉ.' } };
  },
};

const app = new Hono();
app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));

async function call(method, path, body) {
  const response = await app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function assertLastPromptUses(register) {
  const expected = teacherRegisterInstruction(register);
  const prompt = modelCalls.at(-1).map((message) => message.content).join('\n');
  assert.ok(prompt.includes(expected), `${register}: its exact pedagogical instruction must reach the model`);
}

for (const register of TEACHER_REGISTERS) {
  test(`register ${register}: V1 + V2 creation, evaluation, gate and reload`, async () => {
    // V1: creation/read and the historical answer -> VALIDÉ -> advance path.
    const v1Created = await call('POST', '/teacher/paths', { subject: `V1 ${register}`, register });
    assert.equal(v1Created.status, 201);
    assert.equal(v1Created.body.path.register, register);
    assert.equal(v1Created.body.path.schema_version, 1);
    assert.equal(v1Created.body.path.mode, 'standard');
    assert.equal(v1Created.body.path.profile, null);
    assertLastPromptUses(register);

    const v1Started = await call('POST', `/teacher/paths/${v1Created.body.path.id}/start`);
    assert.equal(v1Started.status, 200);
    const v1Step = v1Started.body.steps[0];
    assert.equal(v1Step.tracks, null);
    const v1Read = await call('GET', `/teacher/paths/${v1Created.body.path.id}`);
    assert.equal(v1Read.status, 200);
    assert.equal(v1Read.body.path.register, register);
    assert.equal(v1Read.body.steps[0].track_view.practice.state, 'NOT_APPLICABLE');

    const v1Answered = await call('POST', `/teacher/paths/${v1Created.body.path.id}/steps/${v1Step.id}/answer`, { answer: 'Reformulation' });
    assert.equal(v1Answered.status, 200);
    assert.equal(v1Answered.body.validated, true);
    assertLastPromptUses(register);
    const v1Advanced = await call('POST', `/teacher/paths/${v1Created.body.path.id}/steps/${v1Step.id}/advance`);
    assert.equal(v1Advanced.status, 200);
    assert.equal(v1Advanced.body.path.current_step_index, 1);

    // V2: both tracks are initialized identically for every register. The
    // register changes prompts, never persistence/progression semantics.
    const v2Created = await call('POST', '/teacher/paths', { subject: `V2 ${register}`, register, schema_version: 2 });
    assert.equal(v2Created.status, 201);
    assert.equal(v2Created.body.path.register, register);
    assert.equal(v2Created.body.path.schema_version, 2);
    assert.equal(v2Created.body.path.mode, 'standard');
    assertLastPromptUses(register);

    const v2Started = await call('POST', `/teacher/paths/${v2Created.body.path.id}/start`);
    assert.equal(v2Started.status, 200);
    const [v2Step, v2NextStep] = v2Started.body.steps;
    assert.deepEqual(
      [v2Step.tracks.theory.state, v2Step.tracks.practice.state, v2NextStep.tracks.theory.state, v2NextStep.tracks.practice.state],
      ['ACTIVE', 'ACTIVE', 'LOCKED', 'LOCKED'],
    );
    assert.equal((await call('POST', `/teacher/paths/${v2Created.body.path.id}/steps/${v2Step.id}/advance`)).status, 409);

    const theory = await call('POST', `/teacher/paths/${v2Created.body.path.id}/steps/${v2Step.id}/theory/answer`, { answer: 'Réponse théorique' });
    assert.equal(theory.status, 200);
    assert.equal(theory.body.verdict.passed, true);
    assert.equal(theory.body.can_advance, false);
    assertLastPromptUses(register);

    const practice = await call('POST', `/teacher/paths/${v2Created.body.path.id}/steps/${v2Step.id}/practice/submit`, {
      mode: 'deliverable',
      submission: 'Livrable pratique vérifiable par la grille.',
    });
    assert.equal(practice.status, 200);
    assert.equal(practice.body.verdict.passed, true);
    assert.equal(practice.body.can_advance, true);
    assert.equal(practice.body.steps[0].tracks.practice.evidence, 'MODEL_ASSESSED');
    assertLastPromptUses(register);

    const persisted = await call('GET', `/teacher/paths/${v2Created.body.path.id}`);
    assert.equal(persisted.status, 200);
    assert.deepEqual(
      [persisted.body.steps[0].tracks.theory.state, persisted.body.steps[0].tracks.practice.state],
      ['PASSED', 'PASSED'],
    );

    const v2Advanced = await call('POST', `/teacher/paths/${v2Created.body.path.id}/steps/${v2Step.id}/advance`);
    assert.equal(v2Advanced.status, 200);
    assert.equal(v2Advanced.body.path.current_step_index, 1);
    assert.deepEqual(
      [v2Advanced.body.steps[1].tracks.theory.state, v2Advanced.body.steps[1].tracks.practice.state],
      ['ACTIVE', 'ACTIVE'],
    );
    const reloaded = await call('GET', `/teacher/paths/${v2Created.body.path.id}`);
    assert.equal(reloaded.body.path.current_step_index, 1);
    assert.equal(reloaded.body.path.register, register);
  });
}
