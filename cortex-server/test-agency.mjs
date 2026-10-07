// Agency V1 — orchestration tests. In-memory SQLite (real store), scripted model,
// no network, no real database. A real process restart is exercised on a temp DB file.
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import {
  AGENTS, TOOLS, RUN_STATUS, TASK_STATUS, SYNTHESIS_KEY, SAVE_KEY, LIMITS,
  validatePlan, parsePlanResponse, buildExecutionGraph, fallbackPlan, topoOrder,
  createAgencyService, createRouterComplete, createKnowledgeSearch,
} from './src/lib/agency.js';
import { createAgencyStore } from './src/lib/agency-store.js';
import { createAgencyRoute } from './src/routes/agency.js';

initSqlite(':memory:');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const store = createAgencyStore();

const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const planText = (tasks) => JSON.stringify({ tasks });
const titleOf = (messages) => messages.at(-1).content.match(/Ta tâche : (.+)/)?.[1]?.trim() ?? null;

/** Scripted model: `plan` answers the planner; `task(title, messages)` answers each task. */
function scripted({ plan, task } = {}) {
  const calls = [];
  const timeline = [];
  const complete = async ({ messages, strictLocal, purpose }) => {
    calls.push({ purpose, strictLocal, title: titleOf(messages), messages });
    if (purpose === 'agency_plan') {
      if (typeof plan === 'function') return { text: await plan(messages), model: 'scripted-planner' };
      return { text: plan ?? planText([{ key: 'redaction', agent: 'writer', title: 'Rédiger', instructions: 'Rédiger un court texte.' }]), model: 'scripted-planner' };
    }
    const title = titleOf(messages);
    const entry = { title, start: performance.now(), end: null };
    timeline.push(entry);
    try {
      const text = task ? await task(title, messages) : `Résultat de « ${title} ».`;
      return { text, model: 'scripted-model' };
    } finally { entry.end = performance.now(); }
  };
  return { complete, calls, timeline };
}

function makeService({ model = scripted(), knowledge = [], saveOutput, globalMaxConcurrency = 3, now } = {}) {
  const saved = [];
  const service = createAgencyService({
    store,
    complete: model.complete,
    searchKnowledge: async () => knowledge,
    saveOutput: saveOutput ?? (async (o) => { saved.push(o); return { outputId: `out-${saved.length}` }; }),
    globalMaxConcurrency,
    ...(now ? { now } : {}),
  });
  return { service, saved, model };
}

async function runToEnd(service, input) {
  const created = service.createRun(input);
  await service.idle();
  if (service.getRun(created.run.id).run.status === RUN_STATUS.QUEUED) service.startRun(created.run.id);
  await service.idle();
  return service.getRun(created.run.id);
}
const task = (snap, key) => snap.tasks.find(t => t.key === key);
const OBJ = 'Préparer une synthèse sur la cosmologie observationnelle';

// ── Plan validation ───────────────────────────────────────────────────────────

test('plan validation: tools beyond the role, unknown tools, archivist, cycles, bad dependencies are refused', () => {
  const ok = validatePlan({ tasks: [
    { key: 'a', agent: 'researcher', title: 'A', instructions: 'x' },
    { key: 'b', agent: 'analyst', title: 'B', instructions: 'y', dependsOn: ['a'], tools: ['ai.reason'] },
  ] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.tasks[0].tools, AGENTS.researcher.tools, 'default = the role tools');
  const reasons = (raw) => validatePlan(raw).errors ?? [];
  assert.ok(reasons({ tasks: [{ key: 'a', agent: 'writer', title: 'A', instructions: 'x', tools: ['shell.exec'] }] }).includes('task_a_tool_not_allowed:shell.exec'));
  assert.ok(reasons({ tasks: [{ key: 'a', agent: 'writer', title: 'A', instructions: 'x', tools: ['knowledge.search'] }] }).includes('task_a_tool_not_allowed:knowledge.search'), 'a writer cannot read the knowledge base');
  assert.ok(reasons({ tasks: [{ key: 'a', agent: 'archivist', title: 'A', instructions: 'x' }] }).includes('task_a_agent_not_allowed'), 'the planner cannot add the archivist');
  assert.ok(reasons({ tasks: [{ key: 'a', agent: 'shell', title: 'A', instructions: 'x' }] }).includes('task_a_agent_not_allowed'));
  assert.ok(reasons({ tasks: [{ key: 'a', agent: 'writer', title: 'A', instructions: 'x', dependsOn: ['b'] }, { key: 'b', agent: 'writer', title: 'B', instructions: 'y', dependsOn: ['a'] }] }).includes('plan_cycle'));
  assert.ok(reasons({ tasks: [{ key: 'a', agent: 'writer', title: 'A', instructions: 'x', dependsOn: ['zz'] }] }).includes('task_a_unknown_dependency:zz'));
  assert.ok(reasons({ tasks: [{ key: 'a', agent: 'writer', title: 'A', instructions: 'x', dependsOn: ['a'] }] }).includes('task_a_self_dependency'));
  assert.ok(reasons({ tasks: [{ key: 'a', agent: 'writer', title: 'A', instructions: 'x' }, { key: 'a', agent: 'writer', title: 'B', instructions: 'y' }] }).includes('task_a_duplicate_key'));
  assert.ok(reasons({ tasks: [{ key: SYNTHESIS_KEY, agent: 'writer', title: 'A', instructions: 'x' }] }).includes('task_0_invalid_key'), 'reserved system key');
  assert.ok(reasons({ tasks: Array.from({ length: 9 }, (_, i) => ({ key: `t${i}`, agent: 'writer', title: 'T', instructions: 'x' })) }).includes('plan_too_many_tasks'));
  assert.deepEqual(reasons({ tasks: [] }), ['plan_empty']);
  assert.equal(parsePlanResponse('blabla ```json\n{"tasks":[]}\n``` fin').tasks.length, 0);
  assert.equal(parsePlanResponse('pas de json'), null);
  assert.deepEqual(topoOrder([{ key: 'b', dependsOn: ['a'] }, { key: 'a', dependsOn: [] }]), ['a', 'b']);
});

test('execution graph: synthesis always last, save stage only on opt-in, no tool outside the catalogue', () => {
  const graph = buildExecutionGraph(fallbackPlan(OBJ), { saveResult: true });
  assert.deepEqual(graph.map(t => t.key), ['recherche', 'analyse', SYNTHESIS_KEY, SAVE_KEY]);
  assert.deepEqual(graph.find(t => t.key === SYNTHESIS_KEY).dependsOn, ['analyse'], 'synthesis depends on the leaves');
  assert.deepEqual(graph.find(t => t.key === SAVE_KEY).dependsOn, [SYNTHESIS_KEY]);
  assert.equal(buildExecutionGraph(fallbackPlan(OBJ)).some(t => t.key === SAVE_KEY), false);
  for (const t of graph) for (const tool of t.tools) assert.ok(TOOLS[tool], tool);
  assert.deepEqual(Object.keys(TOOLS).sort(), ['ai.reason', 'knowledge.save', 'knowledge.search'], 'no shell / fs / network / process tool exists');
});

// ── Execution ─────────────────────────────────────────────────────────────────

test('1 agent: objective → plan → task → synthesis → COMPLETED (Strict Local by default)', async () => {
  const { service, model } = makeService();
  const created = service.createRun({ objective: OBJ });
  assert.equal(created.run.status, RUN_STATUS.PLANNING);
  await service.idle();
  const planned = service.getRun(created.run.id);
  assert.equal(planned.run.status, RUN_STATUS.QUEUED, 'plan ready, waits for the user to start');
  assert.equal(planned.run.plan.source, 'model');
  assert.deepEqual(planned.tasks.map(t => [t.key, t.status]), [['redaction', 'QUEUED'], [SYNTHESIS_KEY, 'WAITING']]);
  assert.equal(model.calls.filter(c => c.purpose !== 'agency_plan').length, 0, 'nothing runs before start');
  service.startRun(created.run.id);
  await service.idle();
  const done = service.getRun(created.run.id);
  assert.equal(done.run.status, RUN_STATUS.COMPLETED);
  assert.equal(done.run.synthesis, 'Résultat de « Synthèse finale ».');
  assert.deepEqual(done.artifacts.map(a => a.kind), ['task_result', 'synthesis']);
  assert.ok(model.calls.every(c => c.strictLocal === true), 'Strict Local on every call (plan + tasks)');
  assert.ok(done.events.some(e => e.type === 'run_completed'));
});

test('multi-agent, dependencies and real parallelism within the configured limit', async () => {
  const gates = { a: deferred(), b: deferred() };
  const model = scripted({
    plan: planText([
      { key: 'a', agent: 'researcher', title: 'Chercher A', instructions: 'A' },
      { key: 'b', agent: 'analyst', title: 'Analyser B', instructions: 'B' },
      { key: 'c', agent: 'writer', title: 'Écrire C', instructions: 'C', dependsOn: ['a', 'b'] },
    ]),
    task: async (title) => {
      if (title === 'Chercher A') { await gates.a.promise; return 'A ok'; }
      if (title === 'Analyser B') { await gates.b.promise; return 'B ok'; }
      return `${title} ok`;
    },
  });
  const { service } = makeService({ model, knowledge: [{ id: 'n1', title: 'Neurone 1', excerpt: 'Hubble' }] });
  const created = service.createRun({ objective: OBJ, maxConcurrency: 2 });
  await service.idle();
  service.startRun(created.run.id);
  await new Promise(r => setTimeout(r, 30));
  const mid = service.getRun(created.run.id);
  assert.deepEqual(['a', 'b', 'c'].map(k => task(mid, k).status), ['RUNNING', 'RUNNING', 'WAITING'], 'independent tasks run in parallel; dependent one waits');
  gates.a.resolve();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(task(service.getRun(created.run.id), 'c').status, 'WAITING', 'never started while a direct dependency is still running');
  gates.b.resolve();
  await service.idle();
  const done = service.getRun(created.run.id);
  assert.equal(done.run.status, RUN_STATUS.COMPLETED);
  const t = Object.fromEntries(model.timeline.map(e => [e.title, e]));
  assert.ok(t['Chercher A'].start < t['Analyser B'].end && t['Analyser B'].start < t['Chercher A'].end, 'A and B overlapped');
  assert.ok(t['Écrire C'].start >= Math.max(t['Chercher A'].end, t['Analyser B'].end), 'C after both dependencies');
  assert.ok(t['Synthèse finale'].start >= t['Écrire C'].end);
  // Agent assignment: the researcher got the knowledge extracts, the writer got the dependency results only.
  const researcherCall = model.calls.find(c => c.title === 'Chercher A');
  assert.match(researcherCall.messages.at(-1).content, /Neurone 1\nHubble/);
  const writerCall = model.calls.find(c => c.title === 'Écrire C');
  assert.match(writerCall.messages.at(-1).content, /### Chercher A\nA ok/);
  assert.doesNotMatch(writerCall.messages.at(-1).content, /Extraits des neurones/);
  assert.deepEqual(task(done, 'a').tools, ['knowledge.search', 'ai.reason']);
  assert.deepEqual(task(done, 'c').tools, ['ai.reason']);
});

test('concurrency limit 1: independent tasks never overlap; global limit across runs is respected', async () => {
  const model = scripted({
    plan: planText(['a', 'b', 'c'].map(k => ({ key: k, agent: 'writer', title: `T${k}`, instructions: k }))),
    task: async (title) => { await new Promise(r => setTimeout(r, 15)); return `${title} ok`; },
  });
  const { service } = makeService({ model });
  await runToEnd(service, { objective: OBJ, maxConcurrency: 1 });
  const spans = model.timeline.filter(e => /^T[abc]$/.test(e.title)).sort((x, y) => x.start - y.start);
  for (let i = 1; i < spans.length; i += 1) assert.ok(spans[i].start >= spans[i - 1].end, 'sequential under limit 1');

  let active = 0; let peak = 0;
  const model2 = scripted({
    plan: planText(['a', 'b', 'c'].map(k => ({ key: k, agent: 'writer', title: `G${k}`, instructions: k }))),
    task: async (title) => { active += 1; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); active -= 1; return `${title} ok`; },
  });
  const { service: s2 } = makeService({ model: model2, globalMaxConcurrency: 2 });
  const r1 = s2.createRun({ objective: OBJ, maxConcurrency: 4 });
  const r2 = s2.createRun({ objective: OBJ, maxConcurrency: 4 });
  await s2.idle();
  s2.startRun(r1.run.id); s2.startRun(r2.run.id);
  await s2.idle();
  assert.equal(peak, 2, 'never more than the global limit across runs');
  assert.equal(s2.getRun(r1.run.id).run.status, RUN_STATUS.COMPLETED);
  assert.equal(s2.getRun(r2.run.id).run.status, RUN_STATUS.COMPLETED);
});

test('failure isolation + automatic retry + manual retry', async () => {
  let failA = true; let flakyB = 1;
  const model = scripted({
    plan: planText([
      { key: 'a', agent: 'writer', title: 'TA', instructions: 'a' },
      { key: 'b', agent: 'writer', title: 'TB', instructions: 'b' },
      { key: 'c', agent: 'writer', title: 'TC', instructions: 'c', dependsOn: ['a'] },
    ]),
    task: async (title) => {
      if (title === 'TA' && failA) throw new Error('ollama: model not found');
      if (title === 'TB' && flakyB-- > 0) throw new Error('ECONNRESET');
      return `${title} ok`;
    },
  });
  const { service } = makeService({ model });
  const snap = await runToEnd(service, { objective: OBJ });
  assert.equal(task(snap, 'a').status, TASK_STATUS.FAILED);
  assert.equal(task(snap, 'a').attempt, 2, 'one automatic retry');
  assert.match(task(snap, 'a').error, /model not found/);
  assert.equal(task(snap, 'b').status, TASK_STATUS.COMPLETED, 'independent sibling not affected');
  assert.equal(task(snap, 'b').attempt, 2, 'transient provider error recovered by the automatic retry');
  assert.equal(task(snap, 'c').status, TASK_STATUS.BLOCKED);
  assert.equal(task(snap, SYNTHESIS_KEY).status, TASK_STATUS.BLOCKED);
  assert.equal(snap.run.status, RUN_STATUS.FAILED);
  assert.ok(snap.artifacts.some(a => a.title === 'TB'), 'completed work kept');
  // Manual retry: the failed task and what it blocked are re-opened, nothing else re-runs.
  failA = false;
  const callsBefore = model.calls.filter(c => c.title === 'TB').length;
  service.retryTask(task(snap, 'a').id);
  await service.idle();
  const after = service.getRun(snap.run.id);
  assert.equal(after.run.status, RUN_STATUS.COMPLETED);
  assert.deepEqual(['a', 'c', SYNTHESIS_KEY].map(k => task(after, k).status), ['COMPLETED', 'COMPLETED', 'COMPLETED']);
  assert.equal(model.calls.filter(c => c.title === 'TB').length, callsBefore, 'completed sibling not re-run');
});

test('cancel a running task: aborted, late result discarded, dependents blocked, retry possible', async () => {
  const gate = deferred();
  const model = scripted({
    plan: planText([{ key: 'a', agent: 'writer', title: 'Lente', instructions: 'a' }, { key: 'b', agent: 'writer', title: 'Suite', instructions: 'b', dependsOn: ['a'] }]),
    task: async (title) => (title === 'Lente' ? (await gate.promise, 'trop tard') : `${title} ok`),
  });
  const { service } = makeService({ model });
  const created = service.createRun({ objective: OBJ });
  await service.idle();
  service.startRun(created.run.id);
  await new Promise(r => setTimeout(r, 20));
  service.cancelTask(task(service.getRun(created.run.id), 'a').id);
  gate.resolve();
  await service.idle();
  const snap = service.getRun(created.run.id);
  assert.equal(task(snap, 'a').status, TASK_STATUS.CANCELLED);
  assert.equal(task(snap, 'a').result, null, 'late result discarded');
  assert.ok(snap.events.some(e => e.type === 'late_result_discarded'));
  assert.equal(task(snap, 'b').status, TASK_STATUS.BLOCKED);
  assert.equal(snap.run.status, RUN_STATUS.FAILED);
});

test('STOP: immediate, final, revokes everything; nothing resumes; late results discarded', async () => {
  const gate = deferred();
  const model = scripted({
    plan: planText([{ key: 'a', agent: 'writer', title: 'Longue', instructions: 'a' }, { key: 'b', agent: 'writer', title: 'Autre', instructions: 'b' }]),
    task: async () => { await gate.promise; return 'résultat tardif'; },
  });
  const { service } = makeService({ model });
  const created = service.createRun({ objective: OBJ });
  await service.idle();
  service.startRun(created.run.id);
  await new Promise(r => setTimeout(r, 20));
  const stopped = service.stopRun(created.run.id);
  assert.equal(stopped.run.status, RUN_STATUS.REVOKED);
  assert.ok(stopped.tasks.every(t => t.status === TASK_STATUS.REVOKED), 'every task revoked');
  gate.resolve();
  await service.idle();
  await new Promise(r => setTimeout(r, 30));
  const snap = service.getRun(created.run.id);
  assert.equal(snap.run.status, RUN_STATUS.REVOKED);
  assert.ok(snap.tasks.every(t => t.status === TASK_STATUS.REVOKED && t.result === null), 'no late result written');
  assert.equal(snap.artifacts.length, 0);
  assert.equal(snap.run.synthesis, null);
  for (const action of [() => service.startRun(created.run.id), () => service.resumeRun(created.run.id), () => service.retryTask(snap.tasks[0].id), () => service.cancelRun(created.run.id)]) {
    assert.throws(action, (err) => err.status === 409, 'a REVOKED run never acts again');
  }
  assert.equal(service.stopRun(created.run.id).run.status, RUN_STATUS.REVOKED, 'STOP is idempotent');
  const calls = model.calls.length;
  await new Promise(r => setTimeout(r, 50));
  assert.equal(model.calls.length, calls, 'no spontaneous resumption');
});

test('STOP all: every active run (planning, queued, running, waiting approval) is revoked', async () => {
  const gate = deferred();
  const model = scripted({ plan: async () => { await gate.promise; return planText([{ key: 'a', agent: 'writer', title: 'X', instructions: 'x' }]); } });
  const { service } = makeService({ model });
  const planning = service.createRun({ objective: OBJ });
  const result = service.stopAll();
  assert.ok(result.stopped >= 1);
  gate.resolve();
  await service.idle();
  const snap = service.getRun(planning.run.id);
  assert.equal(snap.run.status, RUN_STATUS.REVOKED);
  assert.equal(snap.tasks.length, 0, 'a plan arriving after STOP is discarded');
  assert.ok(snap.events.some(e => e.type === 'late_plan_discarded'));
});

// ── Approvals ─────────────────────────────────────────────────────────────────

test('approval: save waits for a human, digest-bound, single use, saves exactly what was approved', async () => {
  const { service, saved } = makeService();
  const snap = await runToEnd(service, { objective: OBJ, saveResult: true });
  assert.equal(snap.run.status, RUN_STATUS.WAITING_APPROVAL);
  assert.equal(task(snap, SAVE_KEY).status, TASK_STATUS.WAITING_APPROVAL);
  assert.equal(saved.length, 0, 'nothing saved without approval');
  const approval = snap.approvals[0];
  assert.equal(approval.status, 'PENDING');
  assert.equal(approval.action, 'knowledge.save');
  await assert.rejects(service.decideApproval(approval.id, { accepted: true, digest: 'f'.repeat(64) }), (e) => e.code === 'approval_digest_mismatch');
  await assert.rejects(service.decideApproval(approval.id, { accepted: true }), (e) => e.code === 'approval_digest_mismatch', 'no blind approval');
  const after = await service.decideApproval(approval.id, { accepted: true, digest: approval.digest });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].content, snap.run.synthesis, 'exactly the approved synthesis');
  assert.equal(after.run.status, RUN_STATUS.COMPLETED);
  assert.equal(task(after, SAVE_KEY).status, TASK_STATUS.COMPLETED);
  assert.equal(after.approvals[0].status, 'CONSUMED');
  assert.equal(after.artifacts.find(a => a.kind === 'saved_output').outputId, 'out-1');
  await assert.rejects(service.decideApproval(approval.id, { accepted: true, digest: approval.digest }), (e) => e.code === 'approval_not_pending', 'single use');
  assert.equal(saved.length, 1);
});

test('approval refused, expired, content changed after approval request, revoked by STOP', async () => {
  // Refused → nothing saved, run completes with its synthesis.
  const refused = makeService();
  let snap = await runToEnd(refused.service, { objective: OBJ, saveResult: true });
  let after = await refused.service.decideApproval(snap.approvals[0].id, { accepted: false, digest: snap.approvals[0].digest });
  assert.equal(task(after, SAVE_KEY).status, TASK_STATUS.CANCELLED);
  assert.equal(after.run.status, RUN_STATUS.COMPLETED);
  assert.equal(refused.saved.length, 0);

  // Expired.
  let clock = Date.now();
  const expiring = makeService({ now: () => clock });
  snap = await runToEnd(expiring.service, { objective: OBJ, saveResult: true });
  clock += LIMITS.approvalTtlMs + 1;
  await assert.rejects(expiring.service.decideApproval(snap.approvals[0].id, { accepted: true, digest: snap.approvals[0].digest }), (e) => e.code === 'approval_expired' && e.status === 410);
  assert.equal(expiring.saved.length, 0);
  assert.equal(task(expiring.service.getRun(snap.run.id), SAVE_KEY).status, TASK_STATUS.FAILED);

  // The synthesis changes between the request and the decision → refused, nothing saved.
  const tampered = makeService();
  snap = await runToEnd(tampered.service, { objective: OBJ, saveResult: true });
  getDatabase().prepare('UPDATE agency_tasks SET result = ? WHERE run_id = ? AND task_key = ?').run('contenu modifié', snap.run.id, SYNTHESIS_KEY);
  await assert.rejects(tampered.service.decideApproval(snap.approvals[0].id, { accepted: true, digest: snap.approvals[0].digest }), (e) => e.code === 'approved_content_changed');
  assert.equal(tampered.saved.length, 0);

  // STOP revokes the pending approval.
  const stopped = makeService();
  snap = await runToEnd(stopped.service, { objective: OBJ, saveResult: true });
  stopped.service.stopRun(snap.run.id);
  after = stopped.service.getRun(snap.run.id);
  assert.equal(after.approvals[0].status, 'REVOKED');
  await assert.rejects(stopped.service.decideApproval(snap.approvals[0].id, { accepted: true, digest: snap.approvals[0].digest }), (e) => e.code === 'approval_not_pending');
  assert.equal(stopped.saved.length, 0);
});

// ── Tools, provider failure, Strict Local ─────────────────────────────────────

test('unauthorised tool: refused at plan time (fallback plan) and at execution time (tampered task)', async () => {
  const model = scripted({ plan: planText([{ key: 'a', agent: 'writer', title: 'A', instructions: 'x', tools: ['shell.exec'] }]) });
  const { service } = makeService({ model });
  const created = service.createRun({ objective: OBJ });
  await service.idle();
  const planned = service.getRun(created.run.id);
  assert.equal(planned.run.plan.source, 'fallback');
  assert.ok(planned.run.plan.warnings.includes('task_a_tool_not_allowed:shell.exec'));
  assert.ok(planned.tasks.every(t => t.tools.every(tool => TOOLS[tool])));
  // Tamper the stored grant of the researcher: knowledge.search removed → refused at execution, no retry, no model call.
  getDatabase().prepare("UPDATE agency_tasks SET tools = ? WHERE run_id = ? AND task_key = 'recherche'").run(JSON.stringify(['ai.reason']), created.run.id);
  service.startRun(created.run.id);
  await service.idle();
  const snap = service.getRun(created.run.id);
  assert.equal(task(snap, 'recherche').status, TASK_STATUS.FAILED);
  assert.equal(task(snap, 'recherche').error, 'tool_not_allowed:knowledge.search');
  assert.equal(task(snap, 'recherche').attempt, 1, 'not retried');
  assert.equal(model.calls.filter(c => c.title === 'Ce que Docteur sait déjà').length, 0);
});

test('provider failure: planner down → fallback plan; model down for a task → FAILED with the error', async () => {
  const model = scripted({ plan: async () => { throw new Error('ECONNREFUSED 127.0.0.1:11434'); }, task: async () => { throw new Error('ECONNREFUSED 127.0.0.1:11434'); } });
  const { service } = makeService({ model });
  const snap = await runToEnd(service, { objective: OBJ });
  assert.equal(snap.run.plan.source, 'fallback');
  assert.match(snap.run.plan.warnings[0], /planner_failed:ECONNREFUSED/);
  assert.equal(task(snap, 'recherche').status, TASK_STATUS.FAILED);
  assert.match(task(snap, 'recherche').error, /ECONNREFUSED/);
  assert.equal(snap.run.status, RUN_STATUS.FAILED);
});

test('Strict Local: forced on the router for a strict run; global settings untouched otherwise; private neurons never reach an agent', async () => {
  const seen = [];
  const complete = createRouterComplete({
    routedCompletion: async (_client, req) => { seen.push(req.settings); return { response: 'ok', model: 'm', level: 1, provider: 'local' }; },
    client: {}, getSettings: () => ({ strict_local_mode: false, cloud_enabled: true }), getInstalledNames: async () => [],
  });
  await complete({ messages: [{ role: 'user', content: 'x' }], strictLocal: true, purpose: 'agency_writer' });
  await complete({ messages: [{ role: 'user', content: 'x' }], strictLocal: false, purpose: 'agency_writer' });
  assert.equal(seen[0].strict_local_mode, true);
  assert.equal(seen[1].strict_local_mode, false, 'opt-out keeps the user settings as they are');
  const search = createKnowledgeSearch(async () => ({ results: [
    { id: 'p', title: 'CV', content_preview: 'secret', private: true },
    { id: 'n', title: 'Public', content_preview: 'ok', private: false },
  ] }));
  assert.deepEqual(await search('x', { limit: 5 }), [{ id: 'n', title: 'Public', excerpt: 'ok' }]);
  const { service, model } = makeService();
  await runToEnd(service, { objective: OBJ, strictLocal: false });
  assert.ok(model.calls.every(c => c.strictLocal === false));
});

// ── Persistence and restart ───────────────────────────────────────────────────

test('restart (service rebuilt on the same DB): RUNNING → UNKNOWN, never COMPLETED, nothing resumes by itself', async () => {
  const gate = deferred();
  const model = scripted({ plan: planText([{ key: 'a', agent: 'writer', title: 'Interrompue', instructions: 'a' }, { key: 'b', agent: 'writer', title: 'Pas commencée', instructions: 'b', dependsOn: ['a'] }]), task: async () => { await gate.promise; return 'x'; } });
  const { service } = makeService({ model });
  const created = service.createRun({ objective: OBJ });
  await service.idle();
  service.startRun(created.run.id);
  await new Promise(r => setTimeout(r, 20));
  // "Restart": a new service instance, the old in-memory state is gone.
  const fresh = scripted();
  const { service: rebooted } = makeService({ model: fresh });
  assert.ok(rebooted.recoverAfterRestart().interrupted >= 1);
  let snap = rebooted.getRun(created.run.id);
  assert.equal(snap.run.status, RUN_STATUS.WAITING);
  assert.equal(task(snap, 'a').status, TASK_STATUS.UNKNOWN);
  assert.equal(task(snap, 'b').status, TASK_STATUS.WAITING);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(fresh.calls.length, 0, 'nothing resumed automatically');
  rebooted.retryTask(task(snap, 'a').id);
  await rebooted.idle();
  snap = rebooted.getRun(created.run.id);
  assert.equal(snap.run.status, RUN_STATUS.COMPLETED, 'completed only after an explicit user retry');
  gate.resolve();
  await service.idle();
});

test('real process restart on a DB file: state persisted, honest recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-restart-'));
  const dbFile = path.join(dir, 'agency.db').replace(/\\/g, '/');
  const lib = (p) => JSON.stringify(new URL(`./src/lib/${p}`, `file:///${HERE.replace(/\\/g, '/')}/`).href);
  const phase1 = `
    import { initSqlite } from ${lib('sqlite.js')};
    import { createAgencyService } from ${lib('agency.js')};
    import { createAgencyStore } from ${lib('agency-store.js')};
    initSqlite(${JSON.stringify(dbFile)});
    const s = createAgencyService({ store: createAgencyStore(), searchKnowledge: async () => [], saveOutput: async () => ({ outputId: 'x' }),
      complete: async ({ purpose }) => purpose === 'agency_plan'
        ? { text: JSON.stringify({ tasks: [{ key: 'a', agent: 'writer', title: 'A', instructions: 'a' }] }) }
        : new Promise(() => {}) });
    const r = s.createRun({ objective: 'Objectif interrompu par un redémarrage' });
    await s.idle();
    s.startRun(r.run.id);
    await new Promise(res => setTimeout(res, 50));
    console.log(JSON.stringify({ id: r.run.id, status: s.getRun(r.run.id).run.status }));
    process.exit(0);`;
  const phase2 = (id) => `
    import { initSqlite } from ${lib('sqlite.js')};
    import { createAgencyService } from ${lib('agency.js')};
    import { createAgencyStore } from ${lib('agency-store.js')};
    initSqlite(${JSON.stringify(dbFile)});
    let calls = 0;
    const s = createAgencyService({ store: createAgencyStore(), searchKnowledge: async () => [], saveOutput: async () => ({ outputId: 'x' }), complete: async () => { calls += 1; return { text: 'x' }; } });
    const rec = s.recoverAfterRestart();
    await new Promise(res => setTimeout(res, 50));
    const snap = s.getRun(${JSON.stringify(id)});
    console.log(JSON.stringify({ rec, run: snap.run.status, tasks: snap.tasks.map(t => [t.key, t.status]), calls }));
    process.exit(0);`;
  const run = (code) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: HERE, env: { ...process.env, DOCTEUR_TEST_MODE: '1' }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  };
  try {
    const first = run(phase1);
    assert.equal(first.status, RUN_STATUS.RUNNING);
    const second = run(phase2(first.id));
    assert.equal(second.rec.interrupted, 1);
    assert.equal(second.run, RUN_STATUS.WAITING);
    assert.deepEqual(second.tasks, [['a', 'UNKNOWN'], [SYNTHESIS_KEY, 'WAITING']]);
    assert.equal(second.calls, 0, 'no automatic resumption after the restart');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── HTTP route ────────────────────────────────────────────────────────────────

test('route: validation errors, 404, start/stop, approval digest enforced by the backend', async () => {
  const { service } = makeService();
  const app = new Hono();
  app.route('/api', createAgencyRoute({ service }));
  const call = (method, url, body) => app.request(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call('POST', '/api/agency/runs', { objective: 'court' })).status, 400);
  assert.equal((await call('POST', '/api/agency/runs', { objective: OBJ, maxConcurrency: 9 })).status, 400);
  assert.equal((await call('GET', '/api/agency/runs/nope')).status, 404);
  const created = await (await call('POST', '/api/agency/runs', { objective: OBJ, saveResult: true })).json();
  assert.equal(created.run.strictLocal, true, 'Strict Local unless explicitly false');
  await service.idle();
  assert.equal((await call('POST', `/api/agency/runs/${created.run.id}/start`)).status, 200);
  await service.idle();
  const snap = await (await call('GET', `/api/agency/runs/${created.run.id}`)).json();
  const approval = snap.approvals[0];
  const bad = await call('POST', `/api/agency/approvals/${approval.id}`, { accepted: true, digest: 'nope' });
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).error, 'approval_digest_mismatch');
  const stop = await call('POST', `/api/agency/runs/${created.run.id}/stop`);
  assert.equal((await stop.json()).run.status, RUN_STATUS.REVOKED);
  assert.equal((await call('POST', `/api/agency/approvals/${approval.id}`, { accepted: true, digest: approval.digest })).status, 409, 'revoked approval cannot be used');
  assert.equal((await call('POST', `/api/agency/runs/${created.run.id}/start`)).status, 409);
  const all = await call('POST', '/api/agency/stop-all');
  assert.equal(all.status, 200);
  const catalog = await (await call('GET', '/api/agency/catalog')).json();
  assert.deepEqual(Object.keys(catalog.tools).sort(), ['ai.reason', 'knowledge.save', 'knowledge.search']);
});

// ── Static audit ──────────────────────────────────────────────────────────────

test('static audit: no shell/process/fs/network capability, no Root Policy internals, no direct cloud provider', () => {
  for (const file of ['src/lib/agency.js', 'src/lib/agency-store.js', 'src/routes/agency.js']) {
    const src = fs.readFileSync(path.join(HERE, file), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    for (const banned of ['node:child_process', 'child_process', 'node:fs', 'fs', 'node:net', 'node:http', 'node:https', 'node:dgram']) {
      assert.ok(!imports.includes(banned), `${file} imports ${banned}`);
    }
    assert.ok(!imports.some(i => i.includes('root-policy') || i.includes('/providers/')), `${file}: no Root Policy internals / direct provider`);
    assert.doesNotMatch(src, /\b(exec|execFile|spawn|fork)\s*\(/, `${file}: no process execution`);
    assert.doesNotMatch(src, /\bfetch\s*\(/, `${file}: no network access`);
  }
  const server = fs.readFileSync(path.join(HERE, 'src/server.js'), 'utf8');
  assert.match(server, /createRouterComplete\(\{\s*routedCompletion, client: ollamaClient/, 'AI calls go through the existing router');
  assert.match(server, /searchKnowledge: createKnowledgeSearch\(searchNeuronsEndpoint\)/);
  assert.match(server, /agencyService\.recoverAfterRestart\(\)/);
  // Root Policy V1 reserves the module "agency" / domain AGENCY for a FUTURE explicit outbound send
  // (SOCIAL/EMAIL/SUPPORT draft/send, roadmap P8). Agency V1 performs none of those actions and never
  // calls the policy engine itself: the signed policy is neither needed nor touched.
  const agencySrc = ['src/lib/agency.js', 'src/lib/agency-store.js', 'src/routes/agency.js'].map(f => fs.readFileSync(path.join(HERE, f), 'utf8')).join('\n');
  assert.doesNotMatch(agencySrc, /\b(SOCIAL|EMAIL|SUPPORT)_(DRAFT|SEND|PUBLISH)\b|\benforce\(|\bdecide\(|approvals\.issue/);
});
