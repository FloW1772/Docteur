import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
// Professeur V2 (PROF-2) — non-destructive migration of EXISTING data. Temporary file databases only (os.tmpdir), never
// cortex-server/data. Each step runs in its own Node process, like a real restart of Docteur.
//   • V1 fixture shaped like the real one (1 active parcours, register "enfant", 6 steps: done / active / 4 pending)
//   • migration adds columns + the attempts table, rewrites NO existing value, is idempotent, works on an empty DB
//   • V1 progression after migration = historical; V2 progress survives a restart
//   • rollback: the PRE-PROF-2 data layer (git HEAD) still reads and writes a migrated database containing V2 rows
// Run: node --test test-teacher-migration.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_DB = path.join(HERE, 'data', 'cortex.sqlite');
const realDbBefore = fs.existsSync(REAL_DB) ? fs.statSync(REAL_DB).mtimeMs : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-prof2-migration-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const lib = (f) => pathToFileURL(path.join(HERE, 'src', 'lib', f)).href;
const routes = (f) => pathToFileURL(path.join(HERE, 'src', 'routes', f)).href;

/** Runs an ES module snippet in a NEW Node process (= a Docteur restart) and returns its JSON output. */
function runProcess(code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import '${pathToFileURL(path.join(HERE, 'test-setup.mjs')).href}';\n${code}`], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr.slice(-1500)}`);
  const line = r.stdout.trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop();
  return JSON.parse(line);
}

// The learning tables exactly as they were before PROF-2 (same DDL as git HEAD).
const V1_DDL = `
  CREATE TABLE learning_paths (id TEXT PRIMARY KEY, subject TEXT NOT NULL, register TEXT NOT NULL DEFAULT 'standard', teacher_model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning', plan TEXT NOT NULL DEFAULT '[]', current_step_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, recap_neuron_id TEXT);
  CREATE TABLE learning_path_steps (id TEXT PRIMARY KEY, path_id TEXT NOT NULL, step_index INTEGER NOT NULL, title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', comprehension_check TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`;
const PLAN = [1, 2, 3, 4, 5, 6].map(i => ({ title: `Étape ${i}`, summary: `Résumé ${i}` }));
const STEP_STATUS = ['done', 'active', 'pending', 'pending', 'pending', 'pending'];

function makeV1Fixture(file) {
  const db = new Database(file);
  db.exec(V1_DDL);
  db.prepare(`INSERT INTO learning_paths (id, subject, register, teacher_model, status, plan, current_step_index, created_at, updated_at)
    VALUES ('v1-path', 'Les volcans', 'enfant', 'local/fake', 'active', ?, 1, '2026-09-30T08:00:00.000Z', '2026-09-30T09:00:00.000Z')`).run(JSON.stringify(PLAN));
  STEP_STATUS.forEach((status, i) => db.prepare(`INSERT INTO learning_path_steps (id, path_id, step_index, title, content, status, comprehension_check, created_at, updated_at)
    VALUES (?, 'v1-path', ?, ?, ?, ?, ?, '2026-09-30T08:00:00.000Z', '2026-09-30T08:30:00.000Z')`)
    .run(`v1-step-${i}`, i, PLAN[i].title, i < 2 ? `Explication ${i}\nQuestion ?` : '', status,
      JSON.stringify(i === 0 ? [{ question: 'Q', answer: 'R', evaluation: 'VALIDÉ', reask: null }] : [])));
  db.close();
}
const V1_COLUMNS_PATH = 'id, subject, register, teacher_model, status, plan, current_step_index, created_at, updated_at, completed_at, recap_neuron_id';
const V1_COLUMNS_STEP = 'id, path_id, step_index, title, content, status, comprehension_check, created_at, updated_at';
function snapshotV1(file) {
  const db = new Database(file, { readonly: true });
  const out = {
    paths: db.prepare(`SELECT ${V1_COLUMNS_PATH} FROM learning_paths ORDER BY id`).all(),
    steps: db.prepare(`SELECT ${V1_COLUMNS_STEP} FROM learning_path_steps ORDER BY id`).all(),
  };
  db.close();
  return out;
}
function schemaOf(file) {
  const db = new Database(file, { readonly: true });
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => `${c.name}:${c.type}:${c.dflt_value}:${c.notnull}`);
  const out = { paths: cols('learning_paths'), steps: cols('learning_path_steps'), attempts: cols('learning_track_attempts') };
  db.close();
  return out;
}
const initIn = (file) => runProcess(`import { initSqlite } from '${lib('sqlite.js')}'; initSqlite(${JSON.stringify(file)}); console.log('{"ok":true}');`);

test('migration on the V1 fixture: additive, no existing value rewritten, defaults = V1', () => {
  const file = path.join(tmp, 'v1.sqlite');
  makeV1Fixture(file);
  const before = snapshotV1(file);
  initIn(file);
  const after = snapshotV1(file);
  assert.deepEqual(after, before, 'every pre-existing column value is byte-identical');
  const db = new Database(file, { readonly: true });
  const p = db.prepare('SELECT schema_version, mode, profile FROM learning_paths').get();
  assert.deepEqual(p, { schema_version: 1, mode: 'standard', profile: null }, 'existing parcours = V1, not rewritten as V2');
  assert.deepEqual(db.prepare('SELECT DISTINCT tracks FROM learning_path_steps').all(), [{ tracks: null }], 'no track invented for V1 steps');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM learning_track_attempts').get().n, 0);
  db.close();
});

test('migration is idempotent: a second and third boot change neither schema nor data', () => {
  const file = path.join(tmp, 'idem.sqlite');
  makeV1Fixture(file);
  initIn(file);
  const schema1 = schemaOf(file); const data1 = snapshotV1(file);
  initIn(file); initIn(file);
  assert.deepEqual(schemaOf(file), schema1);
  assert.deepEqual(snapshotV1(file), data1);
  assert.ok(schema1.paths.some(c => c.startsWith('schema_version:INTEGER:1:1')));
  assert.ok(schema1.paths.some(c => c.startsWith('mode:TEXT:')));
  assert.ok(schema1.paths.some(c => c.startsWith('profile:TEXT')));
  assert.ok(schema1.steps.some(c => c.startsWith('tracks:TEXT')));
  assert.ok(schema1.attempts.length >= 9);
});

test('migration on an empty database: every table and column created', () => {
  const file = path.join(tmp, 'empty.sqlite');
  initIn(file);
  const s = schemaOf(file);
  for (const col of ['schema_version', 'mode', 'profile']) assert.ok(s.paths.some(c => c.startsWith(`${col}:`)), col);
  assert.ok(s.steps.some(c => c.startsWith('tracks:')));
  for (const col of ['id', 'path_id', 'step_id', 'track', 'payload', 'verdict', 'passed', 'evidence', 'created_at']) assert.ok(s.attempts.some(c => c.startsWith(`${col}:`)), col);
});

// route helper for the child processes: scripted local model, strict local (no network)
const ROUTE_PRELUDE = (file, script) => `
  import { Hono } from 'hono';
  import { initSqlite, setRouterSettings } from '${lib('sqlite.js')}';
  import { createTeacherRoute } from '${routes('teacher.js')}';
  initSqlite(${JSON.stringify(file)});
  setRouterSettings({ strict_local_mode: true, chat_model: 'fake' });
  const script = ${JSON.stringify(script)};
  const ollamaClient = { chat: async ({ messages }) => ({ message: { content: /plan d'apprentissage/.test(messages.map(m => m.content).join(''))
    ? '[{"title":"A","summary":"a"},{"title":"B","summary":"b"}]' : (script.length ? script.shift() : 'Explication. Question ?') } }) };
  const app = new Hono(); app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));
  const call = async (method, p, body) => { const r = await app.request('/api' + p, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };`;

test('V1 progression on the migrated fixture behaves as before (answer → VALIDÉ rule, advance), still schema 1', () => {
  const file = path.join(tmp, 'v1-progress.sqlite');
  makeV1Fixture(file);
  const out = runProcess(`${ROUTE_PRELUDE(file, ['Bravo, VALIDÉ.'])}
    const before = await call('GET', '/teacher/paths/v1-path');
    const answered = await call('POST', '/teacher/paths/v1-path/steps/v1-step-1/answer', { answer: 'lave' });
    const advanced = await call('POST', '/teacher/paths/v1-path/steps/v1-step-1/advance');
    console.log(JSON.stringify({ before: before.body, validated: answered.body.validated, status: advanced.status, after: advanced.body }));`);
  assert.equal(out.before.path.schema_version, 1); assert.equal(out.before.path.legacy, true);
  assert.equal(out.before.steps.find(s => s.step_index === 0).track_view.theory.state, 'PASSED', 'legacy done → theory PASSED (view only)');
  assert.equal(out.before.steps.find(s => s.step_index === 0).track_view.practice.state, 'NOT_APPLICABLE');
  assert.equal(out.validated, true);
  assert.equal(out.status, 200);
  assert.equal(out.after.path.current_step_index, 2);
  assert.equal(out.after.path.schema_version, 1, 'still V1 after use');
  assert.ok(out.after.steps.every(s => s.tracks === null), 'still no tracks');
});

test('restart persistence: V2 progress + history written by one process are read back by the next one', () => {
  const file = path.join(tmp, 'restart.sqlite');
  const first = runProcess(`${ROUTE_PRELUDE(file, ['{"passed":true,"score":90,"criteria":[{"name":"c","met":true}],"feedback":"ok"}'])}
    const created = await call('POST', '/teacher/paths', { subject: 'Restart', schema_version: 2 });
    const started = await call('POST', '/teacher/paths/' + created.body.path.id + '/start');
    const s0 = started.body.steps.find(s => s.step_index === 0);
    await call('POST', '/teacher/paths/' + created.body.path.id + '/steps/' + s0.id + '/theory/answer', { answer: 'ok' });
    await call('POST', '/teacher/paths/' + created.body.path.id + '/steps/' + s0.id + '/practice/submit', { mode: 'self_report', confirmations: s0.tracks.practice.spec.checklist.map(() => false) });
    console.log(JSON.stringify({ id: created.body.path.id, stepId: s0.id }));`);
  const second = runProcess(`${ROUTE_PRELUDE(file, [])}
    const got = await call('GET', '/teacher/paths/${first.id}');
    const attempts = await call('GET', '/teacher/paths/${first.id}/steps/${first.stepId}/attempts');
    const advance = await call('POST', '/teacher/paths/${first.id}/steps/${first.stepId}/advance');
    console.log(JSON.stringify({ got: got.body, attempts: attempts.body.attempts, advance: advance.status }));`);
  const s0 = second.got.steps.find(s => s.step_index === 0);
  assert.equal(second.got.path.schema_version, 2);
  assert.deepEqual([s0.tracks.theory.state, s0.tracks.practice.state, s0.tracks.practice.evidence], ['PASSED', 'REMEDIATION', 'SELF_REPORTED']);
  assert.deepEqual(second.attempts.map(a => [a.track, a.passed]), [['theory', true], ['practice', false]]);
  assert.equal(second.advance, 409, 'the gate still holds after a restart');
});

test('rollback compatibility: the pre-PROF-2 data layer (git HEAD) reads + writes a migrated database holding V2 rows', (t) => {
  let headSource;
  try { headSource = execFileSync('git', ['show', 'HEAD:cortex-server/src/lib/sqlite.js'], { cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }); } catch {
    return t.skip('git unavailable: rollback check not executed');
  }
  if (/learning_track_attempts|schema_version INTEGER/.test(headSource)) return t.skip('HEAD already contains PROF-2: no older layer to test');
  const require = createRequire(import.meta.url);
  const oldLib = path.join(tmp, 'sqlite-pre-prof2.mjs');
  fs.writeFileSync(oldLib, headSource
    .replace("from 'better-sqlite3'", `from '${pathToFileURL(require.resolve('better-sqlite3')).href}'`)
    .replace("from './secret-store.js'", `from '${lib('secret-store.js')}'`)
    .replace("from './radio-catalog.js'", `from '${lib('radio-catalog.js')}'`));
  const file = path.join(tmp, 'rollback.sqlite');
  makeV1Fixture(file);
  const v2 = runProcess(`${ROUTE_PRELUDE(file, ['{"passed":true,"score":90,"criteria":[],"feedback":"ok"}'])}
    const created = await call('POST', '/teacher/paths', { subject: 'Rollback', schema_version: 2 });
    const started = await call('POST', '/teacher/paths/' + created.body.path.id + '/start');
    const s0 = started.body.steps.find(s => s.step_index === 0);
    await call('POST', '/teacher/paths/' + created.body.path.id + '/steps/' + s0.id + '/theory/answer', { answer: 'ok' });
    await call('POST', '/teacher/paths/' + created.body.path.id + '/steps/' + s0.id + '/practice/submit', { mode: 'self_report', confirmations: s0.tracks.practice.spec.checklist.map(() => true) });
    console.log(JSON.stringify({ id: created.body.path.id }));`);
  const old = runProcess(`
    import { initSqlite, getAllLearningPaths, getStepsByPathId, insertLearningPath, getLearningPathById } from '${pathToFileURL(oldLib).href}';
    initSqlite(${JSON.stringify(file)});
    const paths = getAllLearningPaths();
    const v2Steps = getStepsByPathId('${v2.id}');
    insertLearningPath({ id: 'written-by-old-build', subject: 'Old', register: 'standard', teacher_model: 'x', plan: [] });
    console.log(JSON.stringify({ subjects: paths.map(p => p.subject).sort(), v2Status: v2Steps.map(s => s.status), oldRow: getLearningPathById('written-by-old-build') }));`);
  assert.deepEqual(old.subjects, ['Les volcans', 'Rollback'], 'the old build lists V1 and V2 parcours');
  assert.equal(old.v2Status[0], 'done', 'the legacy status column of a fully validated V2 module reads as done');
  assert.equal(old.oldRow.schema_version, 1, 'a row inserted by the old build defaults to V1');
  initIn(file); // and the new build boots again on it
  const check = new Database(file, { readonly: true });
  try { assert.equal(check.prepare('SELECT COUNT(*) n FROM learning_paths').get().n, 3); } finally { check.close(); }
});

test('the real user database was never touched by this suite', () => {
  if (realDbBefore === null) return;
  assert.equal(fs.statSync(REAL_DB).mtimeMs, realDbBefore);
});
