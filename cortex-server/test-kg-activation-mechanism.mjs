// [KG-ACT-MECH-1] Official KG V1 production activation + migration mechanism.
// Every database here is a TEMPORARY copy of a canonical template built by the real initSqlite() (full Docteur schema +
// sentinel rows). The real cortex-server/data/cortex.sqlite and the real Companion store are hashed before/after and
// never opened for writing. No network, no model.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { initSqlite, getDatabase, setMeta, logRequest } from './src/lib/sqlite.js';
import {
  KG_CERTIFIED, KG_ACTIVE, KG_INACTIVE, KG_DEV_DB_ENV, KG_DEV_SYNC_ENV,
  activateKg, deactivateKg, prepareKgActivation, inspectKgTarget, openKnowledgeGraphAtBoot, resolveKgProductionTarget, startKnowledgeGraphDevSync,
} from './src/lib/kg-boot.js';
import { KG_SCHEMA_VERSION, getSchemaVersion } from './src/lib/kg-schema.js';
import { createKnowledgeGraphApi } from './src/lib/kg-consumer-api.js';
import { createKnowledgeGraphRoute } from './src/routes/kg.js';
import { assertClaim } from './src/lib/kg-claims.js';
import { buildSharedWorld } from './fixtures/kgcert-shared-world.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-act-mech-'));
const TEMPLATE = path.join(TMP, 'template', 'cortex.sqlite');
const REAL = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm', path.join('companion-v1', 'companion.sqlite')].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let realBefore;
let n = 0;
const opened = [];

before(() => {
  realBefore = REAL.map(fileHash);
  initSqlite(TEMPLATE); // the real canonical DDL
  setMeta('kg_act_sentinel', { keep: 'me' });
  for (let i = 0; i < 3; i++) logRequest({ endpoint: `GET /sentinel/${i}`, latencyMs: i, statusCode: 200, ok: true });
  getDatabase().close();
  for (const s of ['-wal', '-shm']) assert.equal(fs.existsSync(TEMPLATE + s), false, 'template fully checkpointed');
});

after(() => {
  for (const s of opened) { try { s.close(); } catch { /* closed */ } }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
});

/** A fresh canonical-like database (copy of the template) and the env that designates it as SQLITE_PATH. */
function canonical(label) {
  const dir = path.join(TMP, `${++n}-${label}`);
  fs.mkdirSync(dir);
  const dbPath = path.join(dir, 'cortex.sqlite');
  fs.copyFileSync(TEMPLATE, dbPath);
  return { dbPath, env: { SQLITE_PATH: dbPath } };
}

const kgObjects = (dbPath) => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'kg\\_%' ESCAPE '\\' ORDER BY type, name").all().map(o => `${o.type}:${o.name}`); } finally { db.close(); }
};
const kgMeta = (dbPath) => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return Object.fromEntries(db.prepare('SELECT key, value FROM kg_metadata').all().map(r => [r.key, r.value])); } finally { db.close(); }
};
/** Schema + content of every NON-KG object: proves unrelated canonical data is preserved. */
function nonKgDigest(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // A KG object is named kg_* or belongs to a kg_* table (its idx_kg_* indexes and triggers).
    const objs = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'kg\\_%' ESCAPE '\\' AND tbl_name NOT LIKE 'kg\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").all();
    const h = crypto.createHash('sha256').update(JSON.stringify(objs));
    for (const o of objs.filter(x => x.type === 'table')) {
      let rows;
      try { rows = db.prepare(`SELECT * FROM "${o.name}" ORDER BY rowid`).all(); } catch { rows = db.prepare(`SELECT * FROM "${o.name}"`).all().map(r => JSON.stringify(r)).sort(); }
      h.update(o.name).update(JSON.stringify(rows));
    }
    return h.digest('hex');
  } finally { db.close(); }
}
const boot = (dbPath, env = {}) => openKnowledgeGraphAtBoot({ env, userDbPath: dbPath });
const keep = (store) => {
  if (store) opened.push(store);
  return store;
};

test('1 + 3 + 15: certified ≠ active — a canonical DB stays inactive at boot, no kg_* object, no byte written', async () => {
  assert.equal(KG_CERTIFIED, true);
  const c = canonical('certified-only');
  const before = sha(c.dbPath);
  const r = await boot(c.dbPath);
  assert.equal(r.store, null);
  assert.deepEqual(r.decision, { enabled: false, reason: 'KG_NOT_ACTIVATED' });
  assert.deepEqual(kgObjects(c.dbPath), []);
  assert.equal(sha(c.dbPath), before, 'boot never writes the canonical DB');
  // 3: prepared (2.3.0) but still INACTIVE → stays disabled at boot
  const p = await prepareKgActivation({ env: c.env });
  assert.equal(p.ok, true);
  assert.equal(p.schemaVersion, KG_SCHEMA_VERSION);
  assert.equal(p.state, KG_INACTIVE);
  const prepared = sha(c.dbPath);
  const r2 = await boot(c.dbPath);
  assert.equal(r2.store, null);
  assert.equal(r2.decision.reason, 'KG_NOT_ACTIVATED');
  assert.equal(sha(c.dbPath), prepared);
});

test('2: an uncertified build cannot activate and never opens production even if ACTIVE is persisted', async () => {
  const src = fs.readFileSync(path.join(HERE, 'src', 'lib', 'kg-boot.js'), 'utf8');
  assert.match(src, /if \(!KG_CERTIFIED\) return refused\('KG_UNCERTIFIED_DISABLED'\)/);
  const req = createRequire(path.join(HERE, 'package.json'));
  const lib = (f) => pathToFileURL(path.join(HERE, 'src', 'lib', f)).href;
  const variant = src.replace('export const KG_CERTIFIED = true;', 'export const KG_CERTIFIED = false;')
    .replace("from 'better-sqlite3'", `from '${pathToFileURL(req.resolve('better-sqlite3')).href}'`)
    .replace(/from '\.\/(kg-[a-z-]+\.js)'/g, (_, f) => `from '${lib(f)}'`);
  assert.notEqual(variant, src);
  const file = path.join(TMP, 'kg-boot-uncertified.mjs');
  fs.writeFileSync(file, variant);
  const U = await import(pathToFileURL(file).href);
  assert.equal(U.KG_CERTIFIED, false);
  const c = canonical('uncertified');
  const before = sha(c.dbPath);
  const r = await U.activateKg({ env: c.env });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'KG_UNCERTIFIED_DISABLED');
  assert.equal(sha(c.dbPath), before, 'uncertified activation writes nothing');
  // ACTIVE persisted by the certified mechanism is still ignored by an uncertified boot
  assert.equal((await activateKg({ env: c.env })).state, KG_ACTIVE);
  const b = await U.openKnowledgeGraphAtBoot({ env: {}, userDbPath: c.dbPath });
  assert.equal(b.store, null);
  assert.equal(b.decision.reason, 'KG_UNCERTIFIED_DISABLED');
});

test('4 + 5 + 8: explicit activation migrates to 2.3.0, preserves every unrelated table/row, and a fresh boot opens the KG ACTIVE', async () => {
  const c = canonical('activate');
  const unrelated = nonKgDigest(c.dbPath);
  assert.deepEqual(inspectKgTarget(c.dbPath), { ok: true, schemaVersion: null, activation: KG_INACTIVE });
  const a = await activateKg({ env: c.env });
  assert.deepEqual({ ok: a.ok, reason: a.reason, state: a.state, schemaVersion: a.schemaVersion, target: a.target },
    { ok: true, reason: 'KG_ACTIVATED_EXPLICITLY', state: KG_ACTIVE, schemaVersion: KG_SCHEMA_VERSION, target: c.dbPath });
  assert.ok(kgObjects(c.dbPath).includes('table:kg_entities') && kgObjects(c.dbPath).includes('table:kg_relationship_provenance'));
  assert.equal(kgMeta(c.dbPath).schema_version, KG_SCHEMA_VERSION);
  assert.equal(kgMeta(c.dbPath).activation_state, KG_ACTIVE);
  assert.equal(nonKgDigest(c.dbPath), unrelated, '8: unrelated canonical schema and data byte-for-byte preserved');
  const db = new Database(c.dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key = 'kg_act_sentinel'").get().value, JSON.stringify({ keep: 'me' }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE endpoint LIKE 'GET /sentinel/%'").get().n, 3);
  db.close();

  const activeBytes = sha(c.dbPath);
  const r = await boot(c.dbPath);
  keep(r.store);
  assert.ok(r.store, '5: fresh boot opens the KG');
  assert.deepEqual(r.decision, { enabled: true, reason: 'KG_PRODUCTION_ACTIVE', dbPath: c.dbPath });
  assert.equal(r.store.options.production, true);
  assert.equal(getSchemaVersion(r.store.db), KG_SCHEMA_VERSION);
  r.store.close();
  assert.equal(sha(c.dbPath), activeBytes, 'an ACTIVE boot does not migrate or rewrite');
});

test('Phase 5: an ACTIVE production KG serves status, entities, claims, relationships, provenance, contradictions, timeline, search and the consumer API; INACTIVE stays 503', async () => {
  const c = canonical('surfaces');
  assert.equal((await activateKg({ env: c.env })).ok, true);
  const { store } = await boot(c.dbPath);
  keep(store);
  const w = buildSharedWorld(store); // isolated copy only: synthetic certified fixture
  assertClaim(store, { subjectEntityId: w.entities.acme, predicate: 'ceo', objectEntityId: w.entities.bob, extractionMethod: 'DETERMINISTIC',
    evidence: [{ sourceId: w.sources.pub.sourceId, sourceRefId: w.sources.pub.refId, excerpt: 'Bob Durand dirige aussi Acme' }] });
  assertClaim(store, { subjectEntityId: w.entities.orion, predicate: 'founded_on', value: { type: 'date', value: '2020' }, extractionMethod: 'DETERMINISTIC', validFrom: '2020-01-01',
    evidence: [{ sourceId: w.sources.pub.sourceId, sourceRefId: w.sources.pub.refId, excerpt: 'Orion lancé en 2020' }] });

  const app = createKnowledgeGraphRoute(store, { disabledReason: 'KG_PRODUCTION_ACTIVE' });
  const health = await (await app.request('/health')).json();
  assert.equal(health.status, 'healthy');
  assert.equal(health.schemaVersion, KG_SCHEMA_VERSION);
  const search = await app.request('/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Acme', includePrivate: false, provider: 'local' }) });
  assert.equal(search.status, 200, 'route search answers (no KG_DISABLED)');

  const api = createKnowledgeGraphApi(store);
  const inv = api.forConsumer('investigator');
  const PUB = { scope: { kind: 'public' }, includePrivate: false, provider: 'local' };
  const q = (params, bounds) => ({ apiVersion: 1, context: PUB, params, ...(bounds ? { bounds } : {}) });
  const entity = await inv.getEntity(q({ entityId: w.entities.acme }));
  assert.ok(JSON.stringify(entity).includes('Acme'), 'entities');
  const claims = await inv.getClaims(q({ entityId: w.entities.acme }));
  assert.ok(JSON.stringify(claims).includes(w.claims.pub), 'claims');
  const evidence = await inv.getEvidence(q({ claimId: w.claims.pub }));
  assert.ok(JSON.stringify(evidence).includes('Alice Martin dirige Acme'), 'provenance / evidence');
  const hood = await inv.getNeighborhood(q({ entityId: w.entities.alice }));
  assert.ok(JSON.stringify(hood).includes(w.relations.pub), 'relationships');
  const contra = await inv.getContradictions(q({ entityId: w.entities.acme }));
  assert.ok(JSON.stringify(contra).includes(w.entities.bob), 'contradictions (two single-valued ceo claims)');
  const timeline = await inv.getTimeline(q({ entityId: w.entities.orion }));
  assert.ok(JSON.stringify(timeline).includes('2020'), 'timeline / temporal data');
  const found = await inv.searchKnowledge(q({ query: 'Alice Martin' }));
  assert.ok(JSON.stringify(found).includes(w.entities.alice), 'search');
  const retrieved = await api.forConsumer('agency').retrieveKnowledge(q({ query: 'Qui dirige Acme ?' }));
  assert.ok(retrieved, 'consumer retrieveKnowledge');
  store.close();

  // INACTIVE: the existing disabled behaviour
  assert.equal(deactivateKg({ env: c.env }).state, KG_INACTIVE);
  const off = await boot(c.dbPath);
  assert.equal(off.store, null);
  const disabled = createKnowledgeGraphRoute(off.store, { disabledReason: off.decision.reason });
  const res = await disabled.request('/health');
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'KG_DISABLED', reason: 'KG_NOT_ACTIVATED' });
});

test('6 + 7: deactivation persists INACTIVE (schema and content kept); preparation and activation are idempotent', async () => {
  const c = canonical('idempotent');
  assert.equal((await prepareKgActivation({ env: c.env })).ok, true);
  const objectsOnce = kgObjects(c.dbPath);
  const p2 = await prepareKgActivation({ env: c.env });
  assert.equal(p2.ok, true);
  assert.equal(p2.migratedFrom, KG_SCHEMA_VERSION, 'second preparation has nothing to migrate');
  assert.deepEqual(kgObjects(c.dbPath), objectsOnce, 'no duplicated schema object');
  assert.equal((await activateKg({ env: c.env })).state, KG_ACTIVE);
  assert.equal((await activateKg({ env: c.env })).state, KG_ACTIVE, 're-activation is a no-op success');
  assert.deepEqual(kgObjects(c.dbPath), objectsOnce);
  const { store } = await boot(c.dbPath);
  keep(store);
  const marker = store.upsertSource({ source_type: 'ARTICLE', name: 'KEEP-AFTER-DEACTIVATION', logical_key: 'keep:1', privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
  store.close();
  const d = deactivateKg({ env: c.env });
  assert.deepEqual({ ok: d.ok, reason: d.reason, state: d.state }, { ok: true, reason: 'KG_DEACTIVATED_EXPLICITLY', state: KG_INACTIVE });
  assert.equal(kgMeta(c.dbPath).activation_state, KG_INACTIVE);
  assert.deepEqual(kgObjects(c.dbPath), objectsOnce, 'deactivation is not a destructive schema rollback');
  const db = new Database(c.dbPath, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kg_sources WHERE source_id = ?').get(marker).n, 1, 'KG content kept');
  db.close();
  assert.equal((await boot(c.dbPath)).decision.reason, 'KG_NOT_ACTIVATED');
  // deactivating a database that never had a KG creates nothing
  const fresh = canonical('deactivate-fresh');
  const before = sha(fresh.dbPath);
  assert.equal(deactivateKg({ env: fresh.env }).reason, 'KG_ALREADY_INACTIVE');
  assert.equal(sha(fresh.dbPath), before);
  assert.deepEqual(kgObjects(fresh.dbPath), []);
});

test('9: a failed or partial migration never marks ACTIVE, boot stays disabled, and activation resumes cleanly', async () => {
  const c = canonical('partial');
  const unrelated = nonKgDigest(c.dbPath);
  const fail008 = (id) => { if (id === '008') throw new Error('injected failure in 008'); };
  const r = await activateKg({ env: c.env, onMigrationStep: fail008 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'KG_MIGRATION_FAILED');
  assert.equal(r.state, KG_INACTIVE, 'refusal reports the persisted state');
  assert.equal(kgMeta(c.dbPath).schema_version, '2.2.0', '001-007 committed, 008 rolled back');
  assert.equal(kgMeta(c.dbPath).activation_state, undefined, 'ACTIVE never written');
  // (001 creates the current DDL directly on a fresh DB; 008's own effect — the 2.3.0 version stamp — was rolled back.)
  const ro = new Database(c.dbPath, { readonly: true });
  try { assert.equal(getSchemaVersion(ro), '2.2.0'); } finally { ro.close(); }
  assert.equal(nonKgDigest(c.dbPath), unrelated);
  assert.equal((await boot(c.dbPath)).store, null);
  const resumed = await activateKg({ env: c.env });
  assert.equal(resumed.ok, true);
  assert.equal(kgMeta(c.dbPath).schema_version, KG_SCHEMA_VERSION);
  // failure in the very first migration: a fresh target remains eligible
  const c1 = canonical('fail-001');
  const r1 = await activateKg({ env: c1.env, onMigrationStep: (id) => { if (id === '001') throw new Error('injected failure in 001'); } });
  assert.equal(r1.ok, false);
  assert.deepEqual(inspectKgTarget(c1.dbPath), { ok: true, schemaVersion: null, activation: KG_INACTIVE });
  assert.equal((await activateKg({ env: c1.env })).ok, true);
});

test('10: future, malformed and inconsistent KG metadata fail closed — never migrated, downgraded or activated', async () => {
  const cases = [
    ['future schema', "CREATE TABLE kg_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO kg_metadata VALUES ('schema_version', '9.0.0', 'x'), ('activation_state', 'ACTIVE', 'x');", 'KG_SCHEMA_UNSUPPORTED'],
    ['malformed version', "CREATE TABLE kg_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO kg_metadata VALUES ('schema_version', 'two.three', 'x');", 'KG_SCHEMA_METADATA_INVALID'],
    ['kg tables without metadata', 'CREATE TABLE kg_entities (entity_id TEXT PRIMARY KEY);', 'KG_SCHEMA_METADATA_INVALID'],
    ['kg_metadata not a table', 'CREATE VIEW kg_metadata AS SELECT 1 AS key;', 'KG_SCHEMA_METADATA_INVALID'],
    ['unknown activation state', "CREATE TABLE kg_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO kg_metadata VALUES ('schema_version', '2.3.0', 'x'), ('activation_state', 'MAYBE', 'x');", 'KG_ACTIVATION_STATE_INVALID'],
  ];
  for (const [label, sql, reason] of cases) {
    const c = canonical(label.replace(/\W+/g, '-'));
    const db = new Database(c.dbPath);
    db.exec(sql);
    db.close();
    const before = sha(c.dbPath);
    assert.deepEqual(inspectKgTarget(c.dbPath), { ok: false, reason }, label);
    const a = await activateKg({ env: c.env });
    assert.equal(a.ok, false, label);
    assert.equal(a.reason, reason, label);
    const b = await boot(c.dbPath);
    assert.equal(b.store, null, `${label}: boot fails closed`);
    assert.deepEqual(b.decision, { enabled: false, reason: 'KG_PRODUCTION_STATE_INVALID', detail: reason }, label);
    assert.equal(sha(c.dbPath), before, `${label}: never rewritten`);
  }
  // ACTIVE on an older known schema: boot refuses and does not migrate behind the user's back
  const old = canonical('active-old-schema');
  const db = new Database(old.dbPath);
  db.exec("CREATE TABLE kg_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO kg_metadata VALUES ('schema_version', '2.2.0', 'x'), ('activation_state', 'ACTIVE', 'x');");
  db.close();
  const before = sha(old.dbPath);
  const b = await boot(old.dbPath);
  assert.equal(b.store, null);
  assert.deepEqual(b.decision, { enabled: false, reason: 'KG_SCHEMA_MISMATCH', detail: '2.2.0' });
  assert.equal(sha(old.dbPath), before);
});

test('11 + 12 + 14: corrupt, missing, non-canonical, directory and caller-supplied targets fail closed; the target is only ever SQLITE_PATH', async () => {
  const corrupt = canonical('corrupt');
  fs.writeFileSync(corrupt.dbPath, Buffer.from('this is not a sqlite database at all'.repeat(64)));
  const bytes = fs.readFileSync(corrupt.dbPath);
  assert.equal((await activateKg({ env: corrupt.env })).reason, 'KG_TARGET_UNREADABLE');
  assert.equal((await boot(corrupt.dbPath)).decision.detail, 'KG_TARGET_UNREADABLE');
  assert.deepEqual(fs.readFileSync(corrupt.dbPath), bytes, 'corrupt DB neither deleted nor recreated');

  const missing = path.join(TMP, 'missing', 'cortex.sqlite');
  assert.equal((await activateKg({ env: { SQLITE_PATH: missing } })).reason, 'KG_TARGET_MISSING');
  assert.equal(deactivateKg({ env: { SQLITE_PATH: missing } }).reason, 'KG_TARGET_MISSING');
  assert.equal((await boot(missing)).decision.detail, 'KG_TARGET_MISSING');
  assert.equal(fs.existsSync(missing), false, 'never created');

  assert.equal((await activateKg({ env: { SQLITE_PATH: TMP } })).reason, 'KG_TARGET_INVALID', 'a directory is not a target');

  const foreign = path.join(TMP, 'foreign.sqlite');
  const f = new Database(foreign);
  f.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES (\'not docteur\');');
  f.close();
  const foreignBytes = sha(foreign);
  assert.equal((await activateKg({ env: { SQLITE_PATH: foreign } })).reason, 'KG_TARGET_NOT_CANONICAL');
  assert.equal(sha(foreign), foreignBytes);

  // 14: no caller-supplied target, ever; relative SQLITE_PATH resolves against cortex-server exactly like server.js
  const c = canonical('no-guess');
  const before = sha(c.dbPath);
  for (const extra of [{ dbPath: c.dbPath }, { target: c.dbPath }, { userDbPath: c.dbPath }]) {
    assert.equal((await activateKg({ env: c.env, ...extra })).reason, 'KG_TARGET_NOT_ACCEPTED');
    assert.equal((await prepareKgActivation({ env: c.env, ...extra })).reason, 'KG_TARGET_NOT_ACCEPTED');
    assert.equal(deactivateKg({ env: c.env, ...extra }).reason, 'KG_TARGET_NOT_ACCEPTED');
  }
  assert.equal(sha(c.dbPath), before);
  assert.equal(resolveKgProductionTarget({ env: { SQLITE_PATH: 'rel/x.sqlite' } }), path.join(HERE, 'rel', 'x.sqlite'));
  assert.equal(resolveKgProductionTarget({ env: {} }), path.join(HERE, 'data', 'cortex.sqlite'), 'default = server.js default (resolved, not opened)');
  const server = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  assert.match(server, /SQLITE_PATH: path\.resolve\(rootDir, process\.env\.SQLITE_PATH \?\? '\.\/data\/cortex\.sqlite'\)/, 'same resolution as server.js');
  assert.doesNotMatch(server, /activateKg|prepareKgActivation|deactivateKg/, 'no route or boot path activates the KG');
  assert.doesNotMatch(fs.readFileSync(path.join(HERE, 'src', 'routes', 'kg.js'), 'utf8'), /activateKg|prepareKgActivation|deactivateKg/);
});

test('13: DOCTEUR_KG_DEV_DB stays a dev/test selector — never the production flag, never the production target; dev sync never touches a production KG', async () => {
  const c = canonical('dev-vs-prod');
  assert.equal((await activateKg({ env: c.env })).ok, true);
  const prodBytes = sha(c.dbPath);
  const devDb = path.join(TMP, 'dev', 'kg-dev.db');
  const dev = await boot(c.dbPath, { [KG_DEV_DB_ENV]: devDb });
  keep(dev.store);
  assert.equal(dev.decision.reason, 'KG_DEV_SEPARATE_DB');
  assert.equal(path.resolve(dev.store.dbPath), devDb, 'dev selection opens the dev DB, not the ACTIVE production DB');
  assert.notEqual(dev.store.options.production, true);
  // dev sync: refused for a production store, allowed for the dev store
  const prod = await boot(c.dbPath);
  keep(prod.store);
  const noTouch = { syncNeurons() { throw new Error('must not sync'); }, syncNotebook() { throw new Error('must not sync'); } };
  assert.equal(startKnowledgeGraphDevSync({ store: prod.store, env: { [KG_DEV_SYNC_ENV]: '1' }, readers: { neuron: null, notebook: null }, listNotebooks: () => [], sync: noTouch }), null);
  const ran = startKnowledgeGraphDevSync({ store: dev.store, env: { [KG_DEV_SYNC_ENV]: '1' }, readers: { neuron: null, notebook: null }, listNotebooks: () => [], sync: { syncNeurons: () => ({ synced: 0 }), syncNotebook: async () => ({ documents: 0 }) } });
  assert.ok(ran);
  await ran;
  dev.store.close();
  prod.store.close();
  assert.equal(sha(c.dbPath), prodBytes, 'dev selection never writes production');
  // the dev DB can never be designated as the production target
  assert.equal((await activateKg({ env: { SQLITE_PATH: c.dbPath, [KG_DEV_DB_ENV]: c.dbPath } })).reason, 'KG_TARGET_IS_DEV_DB');
  // and the dev variable never activates a production DB
  const inactive = canonical('dev-env-inactive');
  const r = await boot(inactive.dbPath, { [KG_DEV_DB_ENV]: path.join(TMP, 'dev2', 'kg.db') });
  keep(r.store)?.close();
  assert.deepEqual(kgObjects(inactive.dbPath), []);
});

test('15 + 16: Companion↔KG coupling only through the certified COMP-7 port — real Companion store and real DB untouched', () => {
  const lib = path.join(HERE, 'src', 'lib');
  for (const f of fs.readdirSync(lib).filter(x => x.startsWith('companion'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(lib, f), 'utf8'), /from '\.\/kg-|knowledge-graph|createKnowledgeGraphApi/, f);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(HERE, 'src', 'routes', 'companion.js'), 'utf8'), /kg-|knowledge/i);
  for (const f of fs.readdirSync(lib).filter(x => x.startsWith('kg-'))) assert.doesNotMatch(fs.readFileSync(path.join(lib, f), 'utf8'), /from '\.\/companion-/, f);
  const server = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  const companionBlock = server.slice(server.indexOf('[Companion V1 COMP-6B]'), server.indexOf('const shutdownCompanion')).replace(/\/\/.*$/gm, '');
  // [COMP-7 PRODUCT WIRING] COMP-7 is now wired (was: "Companion wiring receives no KG"). The Companion block hands the
  // boot KG store to wireCompanionConversation only; no KG API / store / table is used in the block itself, and the
  // wiring module reaches the KG solely through createCompanionKgReadPort (fixed 'companion' consumer, read only).
  assert.deepEqual([...new Set(companionBlock.match(/\w*(?:kg|KnowledgeGraph)\w*/gi) ?? [])].sort(), ['kgContext', 'kgGate', 'kgStore'], 'KG identifiers in the Companion block');
  assert.match(companionBlock, /wireCompanionConversation\(\{[^}]*\bkgStore\b/, 'the KG store goes to the COMP-7 wiring only');
  const wiring = fs.readFileSync(path.join(lib, 'wire-companion-conversation.js'), 'utf8');
  assert.deepEqual([...wiring.matchAll(/from '(\.\/kg-[^']+)'/g)].map(m => m[1]), ['./kg-companion-context.js'], 'only the certified COMP-7 port');
  assert.doesNotMatch(wiring, /createKnowledgeGraphApi|KnowledgeGraphStore|kg-store|kg-consumer-api|kg-population|\bkg_[a-z]/, 'no direct KG API / store / table access');
  assert.equal(fs.readdirSync(lib).some(f => /comp-?7/i.test(f)), false, 'no COMP-7 module');
  assert.deepEqual(REAL.map(fileHash), realBefore, 'real cortex.sqlite (+wal/shm) and real Companion store untouched');
});
