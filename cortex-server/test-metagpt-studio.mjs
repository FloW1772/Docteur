import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import * as db from './src/lib/sqlite.js';
import * as mg from './src/lib/metagpt-orchestrator.js';
import { createMetaGptRoute } from './src/routes/metagpt.js';
import { isValidTransition } from './src/lib/metagpt-node-policy.js';

db.initSqlite(':memory:');
const app = new Hono().route('/api', createMetaGptRoute({ isLocal: () => true }));
const ids = [];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const request = async (suffix, body, method = 'POST') => {
  const response = await app.request(`http://localhost/api/metagpt/missions${suffix}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};
async function create() {
  const r = await request('', { title: 'MG6 isolated test', requirement: 'Fictitious greeting', mode: 'PLAN_AND_CODE_TEXT_ONLY' });
  assert.equal(r.status, 201);
  ids.push(r.body.id);
  return r.body.id;
}
async function prepared(content = 'export const greeting = "hello";\n') {
  const id = await create();
  const workspace = path.join(mg.WORKSPACES_ROOT, id);
  fs.writeFileSync(path.join(workspace, 'generated', 'greeting.js'), content);
  fs.writeFileSync(path.join(workspace, 'manifest.json'), JSON.stringify({ job_id: id, files: [{ path: 'greeting.js', size: Buffer.byteLength(content), sha256: digest(content) }] }));
  db.updateMetaGptMission(id, { current_state: 'CODE_READY' });
  const r = await request(`/${id}/prepare-apply`);
  return { id, workspace, r };
}
async function approve(id) {
  const { body: d } = await request(`/${id}/diff`, undefined, 'GET');
  return request(`/${id}/approve`, { diff_sha256: d.diff_sha256, files: d.files.map(f => f.destination) });
}
after(() => {
  for (const id of ids) {
    const workspace = path.resolve(mg.WORKSPACES_ROOT, id);
    assert.equal(path.dirname(workspace), path.resolve(mg.WORKSPACES_ROOT));
    fs.rmSync(workspace, { recursive: true, force: true });
    const output = path.resolve('../src/_metagpt_generated_samples', id);
    assert.equal(path.basename(output), id);
    fs.rmSync(output, { recursive: true, force: true });
  }
});
test('API create, get, list and invalid mode', async () => {
  const id = await create();
  assert.equal((await request(`/${id}`, undefined, 'GET')).body.mission.current_state, 'CREATED');
  assert.ok((await request('', undefined, 'GET')).body.missions.some(m => m.id === id));
  assert.equal((await request('', { title: 'Denied', requirement: 'Denied', mode: 'AUTO_EXECUTE' })).status, 400);
});
test('state machine: entire forward contract, error states and denied jumps', () => {
  const states = ['CREATED', 'PLANNING', 'PRD_READY', 'DESIGN_READY', 'TASKS_READY', 'GENERATING', 'CODE_READY', 'PREPARING_DIFF', 'AWAITING_APPROVAL', 'APPLYING', 'APPLIED'];
  states.slice(0, -1).forEach((s, i) => assert.ok(isValidTransition(s, states[i + 1])));
  for (const terminal of ['FAILED', 'CANCELLED', 'BLOCKED_BY_POLICY', 'APPROVAL_INVALIDATED']) {
    assert.ok(isValidTransition('PLANNING', terminal));
    assert.equal(isValidTransition(terminal, 'PLANNING'), false);
  }
  assert.equal(isValidTransition('CREATED', 'APPLIED'), false);
  assert.equal(isValidTransition('UNKNOWN', 'FAILED'), false);
});
test('invalid API transition denied', async () => {
  const id = await create();
  assert.equal((await request(`/${id}/prepare-apply`)).status, 409);
});
test('prepare without body, full diff, exact approval and isolated apply', async () => {
  const { id, r } = await prepared();
  assert.equal(r.status, 200);
  const d = (await request(`/${id}/diff`, undefined, 'GET')).body;
  assert.ok(d.diff_text.includes('+export const greeting'));
  assert.equal(digest(d.diff_text), d.diff_sha256);
  assert.equal((await request(`/${id}/approve`, { diff_sha256: '0'.repeat(64), files: d.files.map(f => f.destination) })).status, 409);
  assert.equal((await request(`/${id}/approve`, { diff_sha256: d.diff_sha256, files: ['wrong.js'] })).status, 409);
  assert.equal((await approve(id)).status, 200);
  const applied = await request(`/${id}/apply`);
  assert.equal(applied.body.state, 'APPLIED', JSON.stringify(applied));
  assert.equal(digest(fs.readFileSync(path.resolve('..', d.files[0].destination))), d.files[0].proposed_result_sha256);
});
test('apply without approval denied', async () => {
  const { id } = await prepared();
  assert.equal((await request(`/${id}/apply`)).body.state, 'APPROVAL_INVALIDATED');
});
for (const drift of ['source', 'target', 'package']) test(`${drift} drift denied`, async () => {
  const { id, workspace } = await prepared();
  assert.equal((await approve(id)).status, 200);
  if (drift === 'source') fs.appendFileSync(path.join(workspace, 'generated', 'greeting.js'), '// drift');
  if (drift === 'target') {
    const target = path.resolve('../src/_metagpt_generated_samples', id);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'greeting.js'), 'existing');
  }
  if (drift === 'package') {
    const p = path.join(workspace, 'approval', 'mg5a-approval-package.json');
    const data = JSON.parse(fs.readFileSync(p));
    data.files[0].destination = `src/_metagpt_generated_samples/${id}/unapproved.js`;
    fs.writeFileSync(p, JSON.stringify(data));
  }
  const r = await request(`/${id}/apply`);
  assert.equal(r.body.state, 'APPROVAL_INVALIDATED', JSON.stringify(r));
});
test('blocked finding prevents approval', async () => {
  const { id, r } = await prepared('eval("denied");\n');
  assert.equal(r.body.state, 'BLOCKED_BY_POLICY');
  assert.equal((await request(`/${id}/approve`, { diff_sha256: '0'.repeat(64), files: [] })).status, 409);
});
test('cancel persists and forbids subsequent work', async () => {
  const id = await create();
  assert.equal((await request(`/${id}/cancel`)).status, 200);
  assert.equal(mg.getMission(id).current_state, 'CANCELLED');
  assert.equal((await request(`/${id}/plan`)).status, 409);
});
test('protected destination denied', async () => {
  const id = await create();
  const workspace = path.join(mg.WORKSPACES_ROOT, id);
  const content = '{}';
  fs.writeFileSync(path.join(workspace, 'generated', 'package.json'), content);
  fs.writeFileSync(path.join(workspace, 'manifest.json'), JSON.stringify({ job_id: id, files: [{ path: 'package.json', size: 2, sha256: digest(content) }] }));
  db.updateMetaGptMission(id, { current_state: 'CODE_READY' });
  assert.equal((await request(`/${id}/prepare-apply`)).body.state, 'BLOCKED_BY_POLICY');
});
test('real Python runner timeout waits for process termination', async () => {
  const id = await create();
  const fixture = path.join(mg.WORKSPACES_ROOT, id, 'input', 'timeout_fixture.py');
  fs.writeFileSync(fixture, 'import time\ntime.sleep(60)\n');
  const started = Date.now();
  const result = await mg.runPythonScript(fixture, [], { timeout: 500, missionId: id });
  assert.ok(Date.now() - started < 5000, 'timeout must kill, not wait for natural exit');
  assert.equal(result.timedOut, true);
  assert.throws(() => process.kill(result.pid, 0));
});
test('real running child cancelled; state cannot be resurrected', async () => {
  const id = await create();
  db.updateMetaGptMission(id, { current_state: 'PLANNING' });
  const fixture = path.join(mg.WORKSPACES_ROOT, id, 'input', 'cancel_fixture.py');
  fs.writeFileSync(fixture, 'import time\ntime.sleep(60)\n');
  const pending = mg.runPythonScript(fixture, [], { timeout: 5000, missionId: id });
  mg.cancelMission(id);
  const result = await pending;
  assert.throws(() => process.kill(result.pid, 0));
  assert.equal(mg.getMission(id).current_state, 'CANCELLED');
});
