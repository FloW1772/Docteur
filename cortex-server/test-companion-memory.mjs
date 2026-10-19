// Companion V1 — COMP-2 suite: the thin Companion layer over Docteur Memory (NB-5).
// NB-5 runs for real on a TEMPORARY Docteur database (initSqlite on a temp path, fake embeddings, in-memory vector
// store) — the Companion only calls its public service. The Companion store lives in separate temporary databases.
// No network, no model, no cloud, no process except the two restart children; the real user DB is never opened.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createMemoryService } from './src/lib/notebook-memory.js';
import { ensureMemorySchema } from './src/lib/notebook-memory-schema.js';
import * as C from './src/lib/companion-contracts.js';
import { detectSecretMemory, MAX_SCAN_CHARS } from './src/lib/companion-secrets.js';
import { COMPANION_MIGRATIONS, COMPANION_SCHEMA_VERSION, runCompanionMigrations, companionSchemaVersion, assertAdditiveSql } from './src/lib/companion-schema.js';
import { CompanionStore, USER_DATA_DIR, PREFERENCE_DEFAULTS } from './src/lib/companion-store.js';
import { CompanionMemory, NB5_PORT } from './src/lib/companion-memory.js';
import { CompanionSessionStore } from './src/lib/companion-session.js';
import { COMPANION_CERTIFIED, COMPANION_ACTIVATION, resolveCompanionBoot, openCompanionAtBoot } from './src/lib/companion-boot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comp2-'));
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const code = (c) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`); return true; };
let realDbBefore; let fetchCalls = 0; const realFetch = globalThis.fetch; const opened = [];

before(() => {
  realDbBefore = REAL_DB.map(fileHash);
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network is not allowed in COMP-2 tests'); };
  initSqlite(path.join(TMP, 'docteur-temp.sqlite')); // NB-5's global DB → a TEMPORARY Docteur database
  ensureMemorySchema(getDatabase());
});
after(() => {
  globalThis.fetch = realFetch;
  for (const s of opened) s.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

// ── NB-5 (real service) with fake embeddings and an inspectable in-memory vector store ──
const DIM = 32;
const embed = async (t) => { const v = new Array(DIM).fill(0); for (const w of String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % DIM] += 1; } const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
function memVectors({ failDelete = false } = {}) {
  const rows = new Map();
  return { rows, failDelete,
    upsert: async (l) => { for (const r of l) rows.set(r.memory_id, { ...r }); },
    search: async () => [],
    delete: async (ids) => { if (this?.failDelete ?? failDelete) throw new Error('lance down'); for (const i of ids) rows.delete(i); } };
}
let docService = null;
function nb5({ vectors = memVectors() } = {}) {
  if (!docService) docService = createNotebookDocumentService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: { upsert: async () => {}, search: async () => [], delete: async () => {} }, lancedbPath: path.join(TMP, 'unused.lance'), localComplete: async () => 'ok' });
  return { svc: createMemoryService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: vectors, localComplete: async () => 'ok' }), vectors };
}
let n = 0;
let clockMs = Date.parse('2026-10-13T10:00:00.000Z');
const clock = () => clockMs;
function fresh({ vectors, settings = {}, caches = [], vectorProbe = null, vectorPurge = null, nb5Override = null } = {}) {
  const store = CompanionStore.open({ dbPath: path.join(TMP, `companion-${++n}.sqlite`), now: clock }); opened.push(store);
  const { svc, vectors: vec } = nb5({ vectors });
  const mem = new CompanionMemory({ store, nb5: nb5Override ? nb5Override(svc) : svc, getSettings: () => settings, caches,
    vectorProbe: vectorProbe ?? (async (id) => vec.rows.has(id)), vectorPurge: vectorPurge ?? (async (id) => { vec.rows.delete(id); }) });
  return { store, mem, nb5: svc, vec };
}
const USER = (extra = {}) => ({ origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT', ...extra });
const DERIVED = (extra = {}) => ({ origin: 'DERIVED', sourceType: 'MODEL', derivedBy: { producer: 'MODEL', modelId: 'qwen2.5:7b' }, ...extra });
const IMPORTED = (extra = {}) => ({ origin: 'IMPORTED', sourceType: 'IMPORT_FILE', sourceReference: { kind: 'IMPORT_RECORD', ref: 'import-2026-10-13#3' }, ...extra });
const nb5Count = () => getDatabase().prepare('SELECT COUNT(*) AS n FROM dmem_items').get().n;
const companionText = (store) => JSON.stringify(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'companion_%'").all().map(t => store.db.prepare(`SELECT * FROM ${t.name}`).all()));

// ── schema ──

test('schema v1: fresh, additive companion_* objects only, idempotent, no memory-content table, foreign tables untouched', () => {
  assert.equal(COMPANION_SCHEMA_VERSION, 4); // additive activation-state migration
  for (const m of COMPANION_MIGRATIONS) assert.doesNotThrow(() => assertAdditiveSql(m.sql));
  for (const bad of ['DROP TABLE companion_audit', 'ALTER TABLE dmem_items ADD COLUMN x', 'CREATE TABLE IF NOT EXISTS dmem_x (x)', 'DELETE FROM dmem_items', 'CREATE TABLE IF NOT EXISTS kg_x (x)']) assert.throws(() => assertAdditiveSql(bad), /not (additive|an additive)/, bad);
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE dmem_items (memory_id TEXT PRIMARY KEY, statement TEXT); INSERT INTO dmem_items VALUES ('m1', 'x'); CREATE TABLE preference_facts (id INTEGER, fact TEXT); INSERT INTO preference_facts VALUES (1, 'y');");
  const fp = () => JSON.stringify([db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'companion%' AND tbl_name NOT LIKE 'companion%' ORDER BY name").all(), db.prepare('SELECT * FROM dmem_items').all(), db.prepare('SELECT * FROM preference_facts').all()]);
  const before = fp();
  assert.deepEqual(runCompanionMigrations(db).applied, [1, 2, 3, 4]);
  assert.deepEqual(runCompanionMigrations(db).applied, []);
  assert.equal(companionSchemaVersion(db), 4);
  assert.equal(fp(), before, 'NB-5 / legacy tables untouched');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'companion%' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(tables, ['companion_action_approvals', 'companion_action_audit', 'companion_action_proposals', 'companion_activation', 'companion_audit', 'companion_installation', 'companion_memory_metadata', 'companion_memory_proposals', 'companion_model_audit', 'companion_preferences', 'companion_schema_migrations']);
  const metaCols = db.prepare('PRAGMA table_info(companion_memory_metadata)').all().map(c => c.name);
  for (const forbidden of ['statement', 'value', 'text', 'content', 'conflict', 'revision']) assert.ok(!metaCols.some(c => c.includes(forbidden)), `metadata never holds ${forbidden}`);
  db.close();
});

// ── NB-5 ownership, durable paths ──

test('NB-5 stays the durable source of truth: USER_EXPLICIT goes through createManual; the Companion keeps metadata only, never a second copy', async () => {
  const { store, mem, nb5: svc } = fresh();
  const before = nb5Count();
  const v = await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère des réponses courtes et en français.', provenance: USER({ sessionId: 's-1' }) });
  assert.equal(nb5Count(), before + 1);
  const m = svc.getMemory(v.memoryId);
  assert.deepEqual([m.status, m.type, m.approvalSource, m.statement], ['APPROVED', 'PREFERENCE', 'COMPANION_USER_EXPLICIT', 'Je préfère des réponses courtes et en français.']);
  assert.deepEqual([v.state, v.durableOwner, v.privacyScope, v.companion.category, v.companion.provenance.origin, v.companion.provenance.sessionId], ['ACTIVE', 'NB5', 'PRIVATE_LOCAL', 'USER_PREFERENCE', 'USER_EXPLICIT', 's-1']);
  assert.equal(companionText(store).includes('réponses courtes'), false, 'the statement is never stored by the Companion');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'dmem_%'").get().n, 0, 'no dmem_* table in the Companion store');
  // a fact needs NB-5's own sensitivity rule (PERSONAL_NOTE): NB-5 invariants are not bypassed
  await assert.rejects(mem.rememberExplicit({ category: 'USER_FACT', value: 'Ma fille est née en 2015.', provenance: USER() }), (e) => e.code === 'APPROVAL_REQUIRED');
  const fact = await mem.rememberExplicit({ category: 'USER_FACT', value: 'Ma fille est née en 2015.', provenance: USER(), sensitivity: 'SENSITIVE' });
  assert.deepEqual([svc.getMemory(fact.memoryId).type, fact.privacyScope], ['PERSONAL_NOTE', 'PRIVATE_LOCAL']);
  const hs = await mem.rememberExplicit({ category: 'USER_FACT', value: 'Mon dossier médical est chez le Dr Martin.', provenance: USER(), sensitivity: 'HIGHLY_SENSITIVE' });
  assert.equal(hs.privacyScope, 'NEVER_CLOUD', 'HIGHLY_SENSITIVE ⇒ NEVER_CLOUD by default');
  await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère des réponses courtes et en français.', provenance: USER() }), (e) => e.code === 'DUPLICATE_MEMORY', 'NB-5 dedup applies');
  // NB-5 failures leave no Companion metadata behind
  assert.equal(store.listMetadata().length, 3);
});

test('direct durable writes are refused for DERIVED, IMPORTED, external sources and the legacy adaptive memory; nothing reaches NB-5', async () => {
  const { store, mem } = fresh();
  const before = nb5Count();
  const value = "L'utilisateur préfère le mode sombre.";
  await assert.rejects(mem.rememberExplicit({ category: 'USER_FACT', value, provenance: DERIVED() }), code('COMP_DERIVED_NEEDS_PROPOSAL'));
  await assert.rejects(mem.rememberExplicit({ category: 'USER_FACT', value, provenance: IMPORTED() }), code('COMP_IMPORTED_NEEDS_REVIEW'));
  for (const sourceType of ['WEB', 'EXTERNAL_DOCUMENT', 'NOTEBOOK_SOURCE', 'MODEL', 'RULE', 'IMPORT_FILE', 'SESSION']) {
    await assert.rejects(mem.rememberExplicit({ category: 'USER_FACT', value, provenance: { origin: 'USER_EXPLICIT', sourceType }, sensitivity: 'SENSITIVE' }), code('COMP_DIRECT_DURABLE_REFUSED'), sourceType);
  }
  await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value, provenance: { origin: 'USER_EXPLICIT', sourceType: 'LEGACY_ADAPTIVE' } }), code('COMP_LEGACY_ADAPTIVE_UNSUPPORTED'));
  assert.throws(() => mem.propose({ kind: 'USER_PREFERENCE', value, provenance: { origin: 'IMPORTED', sourceType: 'LEGACY_ADAPTIVE', sourceReference: { kind: 'IMPORT_RECORD', ref: 'preference_facts#1' } } }), code('COMP_LEGACY_ADAPTIVE_UNSUPPORTED'));
  await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value, provenance: { origin: 'USER_CONFIRMED', sourceType: 'USER_INPUT' } }), code('COMP_UNKNOWN_PROVENANCE'), 'USER_CONFIRMED is never given by a caller');
  await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value, provenance: { origin: 'TRUSTED', sourceType: 'USER_INPUT' } }), code('COMP_UNKNOWN_PROVENANCE'));
  await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value, provenance: { origin: 'USER_EXPLICIT', sourceType: 'TELEPATHY' } }), code('COMP_UNKNOWN_PROVENANCE'));
  await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value }), code('COMP_INVALID_FIELD'), 'no memory from nowhere');
  for (const category of ['DERIVED_CONTEXT', 'TASK_CONTEXT', 'SOURCE_REFERENCE', 'SESSION_CONTEXT']) await assert.rejects(mem.rememberExplicit({ category, value, provenance: USER() }), code('COMP_NOT_DURABLE_CATEGORY'), category);
  await assert.rejects(mem.rememberExplicit({ category: 'USER_SECRET', value, provenance: USER() }), code('COMP_UNKNOWN_CATEGORY'));
  assert.equal(nb5Count(), before, 'DERIVED / IMPORTED / external / legacy direct durable writes: 0');
  const refusals = store.listAudit().filter(a => a.action === 'MEMORY_REFUSED_SOURCE').map(a => a.details.code);
  assert.ok(refusals.includes('COMP_DIRECT_DURABLE_REFUSED') && refusals.includes('COMP_LEGACY_ADAPTIVE_UNSUPPORTED'));
  const src = ['companion-contracts.js', 'companion-memory.js', 'companion-store.js', 'companion-session.js', 'companion-schema.js', 'companion-secrets.js', 'companion-boot.js']
    .map(f => fs.readFileSync(path.join(HERE, 'src', 'lib', f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '')).join('\n');
  assert.equal(/preference_facts|episodic_memories|lib\/memory\.js|from '\.\/memory\.js'|selectMemoriesForBudget|addEpisodicMemory/.test(src), false, 'the legacy adaptive memory is never read');
});

test('memory proposals: PENDING writes nothing; acceptance needs an explicit user confirmation (and a review for IMPORTED); decided once; text cleared after decision', async () => {
  const { store, mem, nb5: svc } = fresh();
  const before = nb5Count();
  const p = mem.propose({ kind: 'USER_PREFERENCE', value: "L'utilisateur semble préférer le mode sombre.", provenance: DERIVED({ sessionId: 's-9', evidenceRefs: [{ kind: 'CONVERSATION', ref: 'conv-42#7' }] }) });
  assert.deepEqual([p.status, p.needsReview, p.provenance.origin, p.provenance.derivedBy.modelId, p.privacyScope], ['PENDING', false, 'DERIVED', 'qwen2.5:7b', 'PRIVATE_LOCAL']);
  assert.equal(nb5Count(), before, 'PENDING ⇒ no NB-5 write');
  await assert.rejects(mem.acceptProposal(p.id), code('COMP_USER_CONFIRMATION_REQUIRED'));
  await assert.rejects(mem.acceptProposal(p.id, { userConfirmed: 'yes' }), code('COMP_USER_CONFIRMATION_REQUIRED'));
  const v = await mem.acceptProposal(p.id, { userConfirmed: true, editedValue: "L'utilisateur préfère le mode sombre.", note: 'ok' });
  assert.equal(nb5Count(), before + 1);
  assert.deepEqual([svc.getMemory(v.memoryId).approvalSource, v.companion.provenance.origin, v.companion.provenance.proposalId, v.companion.provenance.derivedBy.producer], ['COMPANION_USER_CONFIRMED', 'USER_CONFIRMED', p.id, 'MODEL']);
  const decided = mem.getProposal(p.id);
  assert.deepEqual([decided.status, decided.value, decided.memoryId, decided.valueSha256], ['ACCEPTED', null, v.memoryId, p.valueSha256], 'the accepted text lives only in NB-5');
  await assert.rejects(mem.acceptProposal(p.id, { userConfirmed: true }), code('COMP_PROPOSAL_DECIDED'));
  assert.throws(() => store.db.prepare("UPDATE companion_memory_proposals SET status = 'PENDING', decided_at = NULL, memory_id = NULL").run(), /COMP_IMMUTABLE/);
  assert.throws(() => store.db.prepare("UPDATE companion_memory_proposals SET value = 'injected' WHERE proposal_id = ?").run(p.id), /COMP_IMMUTABLE/);
  // IMPORTED: needsReview
  const imp = mem.propose({ kind: 'USER_PREFERENCE', value: 'Préférence importée : réveil à 6h30.', provenance: IMPORTED() });
  assert.equal(imp.needsReview, true);
  await assert.rejects(mem.acceptProposal(imp.id, { userConfirmed: true }), code('COMP_REVIEW_REQUIRED'));
  assert.equal(nb5Count(), before + 1, 'IMPORTED without review durable writes: 0');
  assert.equal((await mem.acceptProposal(imp.id, { userConfirmed: true, reviewed: true })).companion.provenance.sourceType, 'IMPORT_FILE');
  assert.throws(() => store.db.prepare("INSERT INTO companion_memory_proposals (proposal_id, owner_id, kind, value, value_sha256, nb5_type, nb5_scope_json, privacy_scope, origin, source_type, evidence_refs_json, needs_review, status, created_at) VALUES ('x', ?, 'USER_FACT', 'v', ?, 'PERSONAL_NOTE', '{}', 'PRIVATE_LOCAL', 'IMPORTED', 'IMPORT_FILE', '[]', 0, 'PENDING', 'now')").run(store.ownerId, 'a'.repeat(64)), /CHECK/, 'IMPORTED ⇒ needs_review even in raw SQL');
  // reject / supersede / invalidate
  const r = mem.propose({ kind: 'USER_FACT', value: 'Habite probablement à Lyon.', provenance: DERIVED() });
  assert.deepEqual([mem.rejectProposal(r.id, { note: 'faux' }).status, mem.getProposal(r.id).value], ['REJECTED', null], 'a rejected text does not linger');
  const s1 = mem.propose({ kind: 'USER_FACT', value: 'Travaille dans la santé.', provenance: DERIVED() });
  const s2 = mem.supersedeProposal(s1.id, { kind: 'USER_FACT', value: 'Travaille comme infirmier.', provenance: DERIVED() });
  assert.deepEqual([mem.getProposal(s1.id).status, mem.getProposal(s1.id).supersededBy, s2.status], ['SUPERSEDED', s2.id, 'PENDING']);
  assert.equal(mem.invalidateProposal(s2.id, { reasonCode: 'SOURCE_FORGOTTEN' }).status, 'INVALIDATED');
  // bad proposals
  const bad = (input, c) => assert.throws(() => mem.propose({ kind: 'USER_PREFERENCE', value: 'Une préférence valable.', provenance: DERIVED(), ...input }), code(c), JSON.stringify(input).slice(0, 80));
  bad({ value: 'x'.repeat(401) }, 'COMP_TOO_LONG');
  bad({ kind: 'DERIVED_CONTEXT' }, 'COMP_NOT_DURABLE_CATEGORY');
  bad({ kind: 'TASK_CONTEXT' }, 'COMP_NOT_DURABLE_CATEGORY');
  bad({ kind: 'SOURCE_REFERENCE' }, 'COMP_NOT_DURABLE_CATEGORY');
  bad({ kind: 'MEMORY' }, 'COMP_UNKNOWN_CATEGORY');
  bad({ privacyScope: 'PUBLIC' }, 'COMP_INVALID_SCOPE');
  bad({ privacyScope: 'CLOUD_ALLOWED' }, 'COMP_CLOUD_SCOPE_NEEDS_DECISION');
  bad({ provenance: { origin: 'DERIVED', sourceType: 'MODEL' } }, 'COMP_PROVENANCE_REQUIRED');
  bad({ provenance: { origin: 'DERIVED', sourceType: 'MODEL', derivedBy: { producer: 'MODEL' } } }, 'COMP_PROVENANCE_REQUIRED');
  bad({ provenance: { origin: 'IMPORTED', sourceType: 'IMPORT_FILE' } }, 'COMP_PROVENANCE_REQUIRED');
  bad({ provenance: { origin: 'GUESSED', sourceType: 'MODEL' } }, 'COMP_UNKNOWN_PROVENANCE');
  bad({ provenance: USER() }, 'COMP_INVALID_FIELD');
  bad({ nb5Type: 'DECISION' }, 'COMP_INVALID_FIELD');
  bad({ provenance: DERIVED({ caseId: 'x' }) }, 'COMP_UNKNOWN_FIELD');
  bad({ provenance: DERIVED({ evidenceRefs: Array.from({ length: 11 }, (_, i) => ({ kind: 'CONVERSATION', ref: `c${i}` })) }) }, 'COMP_INVALID_FIELD');
  bad({ provenance: DERIVED({ evidenceRefs: [{ kind: 'URL', ref: 'https://evil.example' }] }) }, 'COMP_INVALID_FIELD');
  const dup = mem.propose({ kind: 'USER_PREFERENCE', value: 'Aime le jazz.', provenance: DERIVED() });
  assert.throws(() => mem.propose({ kind: 'USER_PREFERENCE', value: 'Aime le jazz.', provenance: DERIVED() }), code('COMP_DUPLICATE_PROPOSAL'));
  void dup;
});

// ── session ──

test('session context: process memory only, scoped by session, bounded, expires on inactivity / lifetime, purged on end; never promoted; never in SQLite', async () => {
  const { store, mem } = fresh();
  const S = mem.session;
  const a = S.openSession(); const b = S.openSession();
  S.add(a, { category: 'SESSION_CONTEXT', text: 'Bonjour, je prépare un voyage à Kyoto.', role: 'user' });
  S.add(a, { category: 'DERIVED_CONTEXT', text: "L'utilisateur voyage probablement en avril." });
  S.add(a, { category: 'TASK_CONTEXT', text: 'Étape 2 du plan', taskId: 'task-1' });
  S.add(a, { category: 'SOURCE_REFERENCE', reference: { kind: 'NOTEBOOK_CHUNK', ref: 'chunk-77', label: 'Guide Kyoto' } });
  assert.equal(S.list(a).length, 4);
  assert.ok(S.list(a).every(i => i.durable === false));
  assert.deepEqual(S.list(b), [], 'another session sees nothing');
  for (const id of ['nope', '', null, 42, b + 'x']) assert.throws(() => S.list(id), code('COMP_SESSION_NOT_FOUND'), String(id));
  assert.throws(() => S.add(a, { category: 'USER_FACT', text: 'x' }), code('COMP_UNKNOWN_CATEGORY'));
  assert.throws(() => S.add(a, { category: 'TASK_CONTEXT', text: 'x' }), code('COMP_REQUIRED_FIELD'));
  assert.throws(() => S.add(a, { category: 'SESSION_CONTEXT', text: 'x', taskId: 't' }), code('COMP_INVALID_FIELD'));
  assert.throws(() => S.add(a, { category: 'SOURCE_REFERENCE', text: 'Tout le contenu du guide…', reference: { kind: 'NOTEBOOK_CHUNK', ref: 'c' } }), code('COMP_SOURCE_COPY_REFUSED'));
  assert.throws(() => S.add(a, { category: 'SESSION_CONTEXT', text: 'x'.repeat(4001) }), code('COMP_TOO_LONG'));
  assert.throws(() => S.add(a, { category: 'SESSION_CONTEXT', text: 'mon mot de passe est Soleil2024!' }), code('COMP_REFUSE_MEMORY'));
  // bounds: oldest dropped, reported
  let dropped = 0;
  for (let i = 0; i < 60; i++) dropped += S.add(b, { category: 'SESSION_CONTEXT', text: `tour ${i} ` + 'x'.repeat(600) }).dropped;
  assert.ok(dropped > 0 && S.list(b).length <= C.limit('sessionItems'));
  assert.ok(S.list(b).reduce((s, i) => s + Buffer.byteLength(JSON.stringify(i)), 0) <= C.limit('sessionBytes') * 1.1);
  // no promotion, no SQLite
  assert.equal(mem.listProposals().length, 0);
  assert.equal(companionText(store).includes('Kyoto'), false);
  assert.equal(fs.readFileSync(path.join(TMP, `companion-${n}.sqlite`)).includes(Buffer.from('Kyoto')), false, 'not even in the database file');
  // expiry
  clockMs += C.limit('sessionIdleMs') + 1;
  assert.throws(() => S.list(a), code('COMP_SESSION_NOT_FOUND'), 'idle timeout');
  const c = S.openSession();
  const activityStep = C.limit('sessionIdleMs') - 1;
  const activeSteps = Math.floor(C.limit('sessionLifetimeMs') / activityStep);
  for (let i = 0; i < activeSteps; i++) {
    clockMs += activityStep;
    S.add(c, { category: 'SESSION_CONTEXT', text: `activité ${i}` });
  }
  clockMs += C.limit('sessionLifetimeMs') - activeSteps * activityStep + 1;
  assert.throws(() => S.list(c), code('COMP_SESSION_NOT_FOUND'), 'maximum lifetime');
  const d = S.openSession(); S.endSession(d);
  assert.throws(() => S.list(d), code('COMP_SESSION_NOT_FOUND'), 'purged at end of session');
  assert.throws(() => { const s = new CompanionSessionStore(); for (let i = 0; i <= C.limit('sessions'); i++) s.openSession(); }, code('COMP_LIMIT_REACHED'));
});

// ── privacy and the cloud contract ──

test('privacy scopes and the cloud gate contract: PRIVATE_LOCAL default, NEVER_CLOUD locked, CLOUD_ALLOWED explicit; ALLOW only with cloudAllowed === true AND cloud_enabled === true', async () => {
  const settings = {};
  const { store, mem } = fresh({ settings });
  const pref = await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère le format markdown.', provenance: USER() });
  assert.equal(pref.privacyScope, 'PRIVATE_LOCAL');
  assert.deepEqual(mem.cloudEligibility(pref.memoryId, { cloudAllowed: true }), { decision: 'DENY', reason: 'SCOPE_NOT_CLOUD_ALLOWED' }, 'PRIVATE_LOCAL ⇒ cloud eligibility false');
  assert.throws(() => mem.setPrivacyScope(pref.memoryId, 'CLOUD_ALLOWED'), code('COMP_CLOUD_SCOPE_NEEDS_DECISION'));
  assert.equal(mem.setPrivacyScope(pref.memoryId, 'CLOUD_ALLOWED', { explicit: true }).privacyScope, 'CLOUD_ALLOWED');
  const check = (s, prefs, cloudAllowed) => { Object.keys(settings).forEach(k => delete settings[k]); Object.assign(settings, s); mem.setPreferences(prefs); return mem.cloudEligibility(pref.memoryId, { cloudAllowed }).reason; };
  assert.equal(check({}, { cloudContextEnabled: true }, true), 'CLOUD_NOT_ENABLED', 'cloud_enabled missing ⇒ DENY');
  assert.equal(check({ cloud_enabled: false }, { cloudContextEnabled: true }, true), 'CLOUD_NOT_ENABLED', 'cloud_enabled false ⇒ DENY');
  assert.equal(check({ cloud_enabled: 'true' }, { cloudContextEnabled: true }, true), 'CLOUD_NOT_ENABLED', 'only the boolean true');
  assert.equal(check({ cloud_enabled: 1 }, { cloudContextEnabled: true }, true), 'CLOUD_NOT_ENABLED');
  assert.equal(check({ cloud_enabled: true, strict_local_mode: true }, { cloudContextEnabled: true }, true), 'STRICT_LOCAL');
  assert.equal(check({ cloud_enabled: true }, { cloudContextEnabled: false }, true), 'CLOUD_CONTEXT_DISABLED');
  assert.equal(check({ cloud_enabled: true }, { cloudContextEnabled: true }, false), 'NO_EXPLICIT_CLOUD_DECISION');
  assert.equal(check({ cloud_enabled: true }, { cloudContextEnabled: true }, 'yes'), 'NO_EXPLICIT_CLOUD_DECISION');
  assert.equal(check({ cloud_enabled: true }, { cloudContextEnabled: true }, true), 'ALL_CONDITIONS_MET');
  assert.equal(mem.cloudEligibility(pref.memoryId, { cloudAllowed: true }).decision, 'ALLOW', 'the contract decides only; nothing is sent');
  mem.setCompanionEnabled(pref.memoryId, false);
  assert.equal(mem.cloudEligibility(pref.memoryId, { cloudAllowed: true }).reason, 'DISABLED');
  // NEVER_CLOUD
  const nc = await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère ne jamais parler de ma santé.', provenance: USER(), privacyScope: 'NEVER_CLOUD' });
  assert.deepEqual(mem.cloudEligibility(nc.memoryId, { cloudAllowed: true }), { decision: 'DENY', reason: 'NEVER_CLOUD' });
  for (const to of ['CLOUD_ALLOWED', 'PRIVATE_LOCAL', 'LOCAL_SHARED_CONTEXT']) {
    assert.throws(() => mem.setPrivacyScope(nc.memoryId, to), code('COMP_NEVER_CLOUD_LOCKED'), to);
    assert.throws(() => mem.setPrivacyScope(nc.memoryId, to, { explicit: true }), code('COMP_NEVER_CLOUD_LOCKED'), `${to} explicit only`);
  }
  assert.equal(mem.setPrivacyScope(nc.memoryId, 'PRIVATE_LOCAL', { explicit: true, releaseNeverCloud: true }).privacyScope, 'PRIVATE_LOCAL', 'an explicit, confirmed release');
  const sens = await mem.rememberExplicit({ category: 'USER_FACT', value: 'Je suis suivi pour de l’asthme.', provenance: USER(), sensitivity: 'SENSITIVE' });
  assert.throws(() => mem.setPrivacyScope(sens.memoryId, 'CLOUD_ALLOWED', { explicit: true }), code('COMP_CLOUD_SCOPE_REFUSED'));
  await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Préférence cloud implicite.', provenance: USER(), privacyScope: 'CLOUD_ALLOWED' }), code('COMP_CLOUD_SCOPE_NEEDS_DECISION'));
  assert.throws(() => mem.setPrivacyScope(pref.memoryId, 'EVERYWHERE', { explicit: true }), code('COMP_INVALID_SCOPE'));
  // pure contract matrix
  const E = (o) => C.evaluateCloudEligibility({ privacyScope: 'CLOUD_ALLOWED', cloudAllowed: true, settings: { cloud_enabled: true }, preferences: { cloudContextEnabled: true }, ...o }).decision;
  assert.equal(E({}), 'ALLOW');
  for (const o of [{ privacyScope: 'NEVER_CLOUD' }, { privacyScope: 'PRIVATE_LOCAL' }, { privacyScope: 'LOCAL_SHARED_CONTEXT' }, { privacyScope: 'X' }, { cloudAllowed: undefined }, { settings: undefined }, { settings: {} }, { settings: { cloud_enabled: false } }, { preferences: undefined }]) assert.equal(E(o), 'DENY', JSON.stringify(o));
  assert.equal(store.listAudit().filter(a => a.action === 'PRIVACY_SCOPE_CHANGED').length, 2);
  assert.equal(fetchCalls, 0, 'cloud calls: 0');
});

// ── secrets ──

const SECRETS = {
  PASSWORD_FR: ['Mon mot de passe Gmail est Tr0ub4dor&3', 'le mdp du wifi : maison2024!', 'Le code PIN de ma carte est 4821'],
  PASSWORD_EN: ['my password is hunter22', 'Password: correcthorse', 'my PIN is 4821'],
  API_KEY: ['ma clé API est sk-proj-abcdefghijklmnopqrstuv123456', 'api_key = AbCdEf0123456789XyZ', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
  TOKENS: ['refresh token: 1//0gAbCdEfGhIjKlMnOpQrStUv', 'access_token=ya29.a0AfH6SMBxyz1234567890', 'Authorization: Bearer abcdef1234567890xyz', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  COOKIE: ['Cookie: sessionid=abc123def456ghi789', 'mon cookie de session = 9f8e7d6c5b4a39281706', 'PHPSESSID=abcdef0123456789abcd'],
  PRIVATE_KEY: ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA'],
  TOTP: ['otpauth://totp/ACME:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME', 'ma clé 2FA : JBSW Y3DP EHPK 3PXP', 'TOTP secret JBSWY3DPEHPK3PXPJBSWY3DP'],
  RECOVERY: ['codes de récupération : 1a2b-3c4d 5e6f-7g8h 9i0j-1k2l', 'GitHub recovery codes: abcde-12345 fghij-67890 klmno-13579', 'backup codes 84721593 16273849'],
};
const HARMLESS = ['Je préfère les réponses courtes', 'Mon projet utilise Rust et Tauri', "J'ai oublié mon mot de passe hier", 'Rappelle-moi de changer mon mot de passe', 'I prefer dark mode',
  'Je dois régénérer mes codes de récupération', 'Where are my backup codes stored?', 'La réunion est à 14h'];

test('secret memory protection: REFUSE_MEMORY everywhere (explicit, proposal, acceptance edit, session), FR + EN, kinds only — never the value, no Secret Store fallback', async () => {
  const { store, mem } = fresh();
  const before = nb5Count();
  const all = Object.entries(SECRETS).flatMap(([group, list]) => list.map(s => [group, s]));
  for (const [group, s] of all) {
    const r = detectSecretMemory(s);
    assert.ok(r.refused && r.kinds.length, `${group}: ${s}`);
    await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value: s, provenance: USER() }), (e) => e.code === 'COMP_REFUSE_MEMORY' && e.details.decision === 'REFUSE_MEMORY', `${group} explicit`);
    if (s.length <= 400) assert.throws(() => mem.propose({ kind: 'USER_FACT', value: s, provenance: DERIVED() }), code('COMP_REFUSE_MEMORY'), `${group} proposal`);
  }
  for (const h of HARMLESS) assert.equal(detectSecretMemory(h).refused, false, h);
  const p = mem.propose({ kind: 'USER_PREFERENCE', value: 'Préfère les notifications le matin.', provenance: DERIVED() });
  await assert.rejects(mem.acceptProposal(p.id, { userConfirmed: true, editedValue: 'Préfère le matin, mot de passe : Matin2024!' }), code('COMP_REFUSE_MEMORY'), 'an edit is re-scanned');
  const sid = mem.session.openSession();
  assert.throws(() => mem.session.add(sid, { category: 'SESSION_CONTEXT', text: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' }), code('COMP_REFUSE_MEMORY'));
  assert.equal(nb5Count(), before, 'nothing reached NB-5');
  const auditText = JSON.stringify(store.listAudit());
  for (const [, s] of all) for (const piece of s.split(/[\s:=]+/).filter(x => x.length >= 8)) assert.equal(auditText.includes(piece), false, `audit holds no secret value (${piece.slice(0, 6)}…)`);
  assert.ok(store.listAudit().filter(a => a.action === 'MEMORY_REFUSED_SECRET').length >= all.length);
  assert.throws(() => store.audit('MEMORY_ADDED', 'MEMORY', 'm', { details: { leaked: 'Bearer abcdef1234567890xyz' } }), code('COMP_INTERNAL'), 'the audit itself refuses a secret');
  assert.deepEqual(detectSecretMemory('x'.repeat(MAX_SCAN_CHARS + 1)).kinds, ['UNSCANNABLE_SIZE']);
  const t0 = performance.now();
  for (const evil of ['mot de passe ' + 'a '.repeat(2000), 'password' + ' x'.repeat(2000), 'A2B3 '.repeat(800), 'totp ' + 'AAAA-'.repeat(800), 'Cookie' + ': '.repeat(2000)]) detectSecretMemory(evil);
  assert.ok(performance.now() - t0 < 500, 'no catastrophic backtracking on hostile 4k inputs');
  assert.equal(fs.readFileSync(path.join(HERE, 'src', 'lib', 'companion-memory.js'), 'utf8').includes('secret-store'), false, 'no Secret Store fallback');
});

// ── state, metadata, freshness, context use, global OFF ──

test('Companion metadata: NB-5 state is derived (ACTIVE / DISPUTED / SUPERSEDED / INVALIDATED / ARCHIVED / MISSING), provenance immutable, reminder-only review, context use recorded', async () => {
  let conflictsFor = [];
  const { store, mem, nb5: svc } = fresh({ nb5Override: (s) => ({ ...s, listConflicts: (o) => [...s.listConflicts(o), ...conflictsFor.map(id => ({ memoryA: id, memoryB: 'other', status: 'OPEN' }))] }) });
  const a = await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère travailler le matin.', provenance: USER(), reviewAfterDays: 30 });
  assert.equal(mem.view(a.memoryId).state, 'ACTIVE');
  conflictsFor = [a.memoryId];
  assert.equal(mem.view(a.memoryId).state, 'DISPUTED', 'DISPUTED comes from NB-5 OPEN conflicts (not re-implemented)');
  conflictsFor = [];
  await svc.archive(a.memoryId);
  assert.equal(mem.view(a.memoryId).state, 'ARCHIVED');
  await svc.restore(a.memoryId);
  await svc.revoke(a.memoryId, { reason: 'plus vrai' });
  assert.equal(mem.view(a.memoryId).state, 'INVALIDATED');
  const meta = store.getMetadata(a.memoryId);
  assert.deepEqual([meta.provenance.origin, meta.provenance.sourceType, meta.category, typeof meta.createdAt, typeof meta.confirmedAt], ['USER_EXPLICIT', 'USER_INPUT', 'USER_PREFERENCE', 'string', 'string']);
  for (const sql of ["UPDATE companion_memory_metadata SET origin = 'USER_CONFIRMED'", "UPDATE companion_memory_metadata SET source_type = 'WEB'", "UPDATE companion_memory_metadata SET category = 'USER_FACT'", "UPDATE companion_memory_metadata SET evidence_refs_json = '[]', created_at = 'x'"]) {
    assert.throws(() => store.db.prepare(sql).run(), /COMP_IMMUTABLE/, sql);
  }
  assert.throws(() => store.db.prepare("INSERT INTO companion_memory_metadata (memory_id, owner_id, category, privacy_scope, companion_enabled, origin, source_type, evidence_refs_json, created_at, updated_at, confirmed_at) VALUES ('z', ?, 'USER_FACT', 'PRIVATE_LOCAL', 1, 'DERIVED', 'MODEL', '[]', 'n', 'n', 'n')").run(store.ownerId), /CHECK/, 'a DERIVED memory cannot exist');
  assert.throws(() => store.db.prepare("INSERT INTO companion_memory_metadata (memory_id, owner_id, category, privacy_scope, companion_enabled, origin, source_type, evidence_refs_json, created_at, updated_at, confirmed_at) VALUES ('z', ?, 'USER_FACT', 'PRIVATE_LOCAL', 1, 'USER_EXPLICIT', 'LEGACY_ADAPTIVE', '[]', 'n', 'n', 'n')").run(store.ownerId), /CHECK/, 'nor a legacy-sourced one');
  // freshness / reminder
  const b = await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère les cartes IGN au 1:25000.', provenance: USER(), reviewAfterDays: 1 });
  clockMs += 2 * 86_400_000;
  assert.ok(mem.dueForReview().includes(b.memoryId));
  assert.equal(svc.getMemory(b.memoryId).status, 'APPROVED', 'reviewAfter is a reminder: nothing deleted');
  const f = mem.view(b.memoryId).freshness;
  assert.ok(f.confirmedAt && f.validFrom && 'validTo' in f && 'expiresAt' in f && f.reviewAfter);
  // context use
  mem.markContextUsed([b.memoryId], { requestId: 'req-1' });
  assert.ok(mem.view(b.memoryId).freshness.lastPresentedAt);
  mem.setCompanionEnabled(b.memoryId, false);
  assert.throws(() => mem.markContextUsed([b.memoryId], { requestId: 'req-2' }), code('COMP_MEMORY_DISABLED'));
  assert.ok(['MEMORY_CONTEXT_USED', 'MEMORY_DISABLED', 'MEMORY_METADATA_CHANGED'].every(x => store.listAudit().some(a2 => a2.action === x)) || store.listAudit().some(a2 => a2.action === 'MEMORY_CONTEXT_USED'));
  assert.throws(() => mem.setPrivacyScope('not a valid id!', 'PRIVATE_LOCAL'), code('COMP_INVALID_ID'));
  assert.throws(() => mem.setCompanionEnabled('unknown-memory', true), code('COMP_NOT_FOUND'));
});

test('global memory OFF: no proposal, no durable write, no context use, session off and purged; forgetting still works; preferences have safe defaults', async () => {
  const { store, mem } = fresh();
  assert.deepEqual(mem.preferences(), PREFERENCE_DEFAULTS);
  assert.deepEqual(PREFERENCE_DEFAULTS, { memoryEnabled: true, sessionMemoryEnabled: true, proposalEnabled: true, cloudContextEnabled: false });
  const kept = await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère le café sans sucre.', provenance: USER() });
  const sid = mem.session.openSession(); mem.session.add(sid, { category: 'SESSION_CONTEXT', text: 'bonjour' });
  const before = nb5Count();
  const r = mem.setPreferences({ memoryEnabled: false });
  assert.equal(r.purgedSessions, 1);
  await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère le thé vert.', provenance: USER() }), code('COMP_MEMORY_DISABLED'));
  assert.throws(() => mem.propose({ kind: 'USER_PREFERENCE', value: 'Aime le thé.', provenance: DERIVED() }), code('COMP_MEMORY_DISABLED'));
  assert.throws(() => mem.markContextUsed([kept.memoryId], { requestId: 'r' }), code('COMP_MEMORY_DISABLED'));
  assert.throws(() => mem.session.openSession(), code('COMP_MEMORY_DISABLED'));
  assert.equal(nb5Count(), before);
  assert.equal((await mem.forget(kept.memoryId)).status, 'COMPLETE', 'forgetting is always possible');
  mem.setPreferences({ memoryEnabled: true, sessionMemoryEnabled: false });
  assert.throws(() => mem.session.openSession(), code('COMP_MEMORY_DISABLED'), 'session switch alone');
  mem.setPreferences({ sessionMemoryEnabled: true, proposalEnabled: false });
  assert.throws(() => mem.propose({ kind: 'USER_PREFERENCE', value: 'Aime le thé.', provenance: DERIVED() }), code('COMP_PROPOSALS_DISABLED'));
  assert.ok(await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère le thé vert.', provenance: USER() }));
  assert.throws(() => mem.setPreferences({ autoLearn: true }), code('COMP_UNKNOWN_FIELD'));
  assert.throws(() => mem.setPreferences({ memoryEnabled: 'false' }), code('COMP_INVALID_FIELD'));
  assert.ok(store.listAudit().filter(a => a.action === 'PREFERENCES_CHANGED').length >= 3);
});

// ── audit, forget ──

test('audit: every Companion event recorded, hash-chained, append-only (UPDATE / DELETE / REPLACE refused), tampering detected, ids / types / hashes only', async () => {
  const { store, mem } = fresh();
  const a = await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère les explications avec des exemples.', provenance: USER() });
  const p = mem.propose({ kind: 'USER_FACT', value: 'Travaille sur un projet Rust.', provenance: DERIVED() });
  mem.rejectProposal(p.id);
  const p2 = mem.propose({ kind: 'USER_PREFERENCE', value: 'Préfère les schémas.', provenance: DERIVED() });
  await mem.acceptProposal(p2.id, { userConfirmed: true });
  await assert.rejects(mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'mdp : Azerty123!', provenance: USER() }));
  mem.setPrivacyScope(a.memoryId, 'NEVER_CLOUD');
  mem.markContextUsed([a.memoryId], { requestId: 'q1' });
  mem.setCompanionEnabled(a.memoryId, false);
  mem.setReviewAfter(a.memoryId, 10);
  await mem.forget(a.memoryId);
  const actions = new Set(store.listAudit().map(x => x.action));
  for (const x of ['MEMORY_ADDED', 'MEMORY_PROPOSED', 'MEMORY_ACCEPTED', 'MEMORY_REJECTED', 'MEMORY_REFUSED_SECRET', 'MEMORY_METADATA_CHANGED', 'MEMORY_CONTEXT_USED', 'MEMORY_DISABLED', 'FORGET_REQUESTED', 'FORGET_COMPLETED', 'PRIVACY_SCOPE_CHANGED']) assert.ok(actions.has(x), x);
  const text = JSON.stringify(store.listAudit());
  for (const s of ['explications avec des exemples', 'projet Rust', 'Azerty123', 'schémas']) assert.equal(text.includes(s), false, s);
  assert.deepEqual(store.verifyAudit(), { ok: true, entries: store.listAudit().length, head: store.listAudit().at(-1).entryHash });
  for (const sql of ["UPDATE companion_audit SET action = 'MEMORY_ADDED'", 'DELETE FROM companion_audit',
    "INSERT OR REPLACE INTO companion_audit (seq, audit_id, owner_id, action, object_type, object_id, at, actor, details_json, prev_hash, entry_hash) SELECT seq, audit_id, owner_id, 'MEMORY_ADDED', object_type, object_id, at, actor, details_json, prev_hash, entry_hash FROM companion_audit LIMIT 1"]) {
    assert.throws(() => store.db.prepare(sql).run(), /COMP_IMMUTABLE/, sql);
  }
  store.db.exec('DROP TRIGGER companion_audit_no_update');
  store.db.prepare("UPDATE companion_audit SET details_json = '{\"forged\":true}' WHERE action = 'MEMORY_ADDED'").run();
  assert.equal(store.verifyAudit().ok, false, 'audit tampering detected');
});

test('forget: NB-5 purge + metadata + proposals + session references + caches, verified; partial purge = FORGET_INCOMPLETE (remainingStores, retryable, timestamp); retry completes', async () => {
  const cache = new Set(); const caches = [{ name: 'context-pack', purge: (id) => cache.delete(id), has: (id) => cache.has(id) }];
  const { store, mem, nb5: svc, vec } = fresh({ caches });
  const p = mem.propose({ kind: 'USER_PREFERENCE', value: 'Préfère les trains de nuit.', provenance: DERIVED() });
  const v = await mem.acceptProposal(p.id, { userConfirmed: true });
  await new Promise(r => setTimeout(r, 10));
  vec.rows.set(v.memoryId, { memory_id: v.memoryId }); // the vector NB-5 indexes
  cache.add(v.memoryId);
  const sid = mem.session.openSession();
  mem.session.add(sid, { category: 'SOURCE_REFERENCE', reference: { kind: 'NB5_MEMORY', ref: v.memoryId } });
  const ok = await mem.forget(v.memoryId);
  assert.deepEqual([ok.status, ok.remainingStores, ok.retryable, typeof ok.timestamp], ['COMPLETE', [], false, 'string']);
  assert.equal(svc.getMemory(v.memoryId), null);
  assert.equal(store.getMetadata(v.memoryId), null);
  assert.equal(store.countProposalsForMemory(v.memoryId), 0);
  assert.equal(vec.rows.has(v.memoryId), false);
  assert.equal(mem.session.list(sid).length, 0);
  assert.equal(cache.has(v.memoryId), false);
  assert.equal(mem.view(v.memoryId).state, 'MISSING');
  // partial: NB-5 swallows a vector delete failure → the Companion sees it
  const broken = memVectors(); broken.failDelete = true;
  const f2 = fresh({ vectors: broken, vectorPurge: async () => { throw new Error('still down'); } });
  const w = await f2.mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère la montagne à la mer.', provenance: USER() });
  broken.rows.set(w.memoryId, { memory_id: w.memoryId });
  broken.delete = async () => { throw new Error('lance down'); };
  const inc = await f2.mem.forget(w.memoryId);
  assert.deepEqual([inc.status, inc.remainingStores, inc.retryable], ['FORGET_INCOMPLETE', ['NB5_VECTOR'], true], 'never declared deleted without verification');
  assert.ok(f2.store.listAudit().some(a => a.action === 'FORGET_INCOMPLETE' && a.details.remainingStores.includes('NB5_VECTOR')));
  // retry once the vector store is back
  const f2b = new CompanionMemory({ store: f2.store, nb5: f2.nb5, vectorProbe: async (id) => broken.rows.has(id), vectorPurge: async (id) => { broken.rows.delete(id); } });
  assert.equal((await f2b.forget(w.memoryId)).status, 'COMPLETE');
  // NB-5 record cannot be deleted → metadata (privacy lock) is KEPT
  const f3 = fresh({ nb5Override: (s) => ({ ...s, deleteMemory: async () => { throw new Error('db locked'); } }) });
  const x = await f3.mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère ne pas être dérangé le soir.', provenance: USER(), privacyScope: 'NEVER_CLOUD' });
  const inc3 = await f3.mem.forget(x.memoryId);
  assert.deepEqual([inc3.status, inc3.remainingStores.includes('NB5_RECORD'), inc3.retryable], ['FORGET_INCOMPLETE', true, true]);
  assert.equal(f3.store.getMetadata(x.memoryId).privacyScope, 'NEVER_CLOUD', 'the privacy lock survives while the memory exists');
  // a cache that cannot purge
  const f4 = fresh({ caches: [{ name: 'sticky', purge: () => { throw new Error('nope'); }, has: () => true }] });
  const y = await f4.mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère les podcasts courts.', provenance: USER() });
  assert.deepEqual((await f4.mem.forget(y.memoryId)).remainingStores, ['CACHE:sticky']);
});

// ── ownership, persistence, boot, bounds, isolation ──

test('ownership: every Companion row belongs to the single local installation; no second installation; no row of an unknown owner', async () => {
  const { store, mem } = fresh();
  await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère les polices sans empattement.', provenance: USER() });
  mem.propose({ kind: 'USER_FACT', value: 'Utilise Windows 11.', provenance: DERIVED() });
  mem.setPreferences({ cloudContextEnabled: false, proposalEnabled: true });
  for (const t of ['companion_memory_metadata', 'companion_memory_proposals', 'companion_preferences', 'companion_audit']) {
    assert.deepEqual([...new Set(store.db.prepare(`SELECT owner_id FROM ${t}`).all().map(r => r.owner_id))], [store.ownerId], t);
  }
  assert.equal(store.db.prepare('SELECT profile FROM companion_installation').get().profile, 'LOCAL_SINGLE_USER');
  assert.throws(() => store.db.prepare("INSERT INTO companion_installation (singleton, installation_id, profile, created_at) VALUES (2, 'other', 'LOCAL_SINGLE_USER', 'n')").run(), /CHECK/);
  assert.throws(() => store.db.prepare("INSERT INTO companion_audit (audit_id, owner_id, action, object_type, object_id, at, actor, details_json, entry_hash) VALUES ('a', 'stranger', 'MEMORY_ADDED', 'MEMORY', 'm', 'n', 'USER', '{}', ?)").run('b'.repeat(64)), /FOREIGN KEY/);
});

test('restart persistence: metadata, proposals, preferences and audit survive a new process; session context does not (restart → 0 session memory)', () => {
  const dir = path.join(TMP, 'restart'); fs.mkdirSync(dir, { recursive: true });
  const lib = (f) => pathToFileURL(path.join(HERE, 'src', 'lib', f)).href;
  const common = `
    import path from 'node:path';
    import { initSqlite } from '${lib('sqlite.js')}';
    import { ensureMemorySchema } from '${lib('notebook-memory-schema.js')}';
    import { createNotebookDocumentService } from '${lib('notebook-documents.js')}';
    import { createMemoryService } from '${lib('notebook-memory.js')}';
    import { CompanionStore } from '${lib('companion-store.js')}';
    import { CompanionMemory } from '${lib('companion-memory.js')}';
    const dir = process.argv[2];
    const db = initSqlite(path.join(dir, 'docteur.sqlite')); ensureMemorySchema(db);
    const noVec = { upsert: async () => {}, search: async () => [], delete: async () => {} };
    createNotebookDocumentService({ embedText: async () => [1, 0], embeddingModel: 'm', embedFormat: {}, vectorStore: noVec, lancedbPath: path.join(dir, 'x.lance'), localComplete: async () => 'ok' });
    const nb5 = createMemoryService({ embedText: async () => [1, 0], embeddingModel: 'm', embedFormat: {}, vectorStore: noVec, localComplete: async () => 'ok' });
    const store = CompanionStore.open({ dbPath: path.join(dir, 'companion.sqlite') });
    const mem = new CompanionMemory({ store, nb5 });
    const dump = () => ({ ownerId: store.ownerId, metadata: store.listMetadata(), proposals: store.listProposals(), prefs: mem.preferences(), audit: store.listAudit(), chain: store.verifyAudit(), session: mem.session.stats(), version: store.schemaVersion() });`;
  const writer = path.join(TMP, 'comp-writer.mjs');
  fs.writeFileSync(writer, `${common}
    const v = await mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère les réponses structurées.', provenance: { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT' } });
    mem.propose({ kind: 'USER_FACT', value: 'Vit en Bretagne.', provenance: { origin: 'DERIVED', sourceType: 'MODEL', derivedBy: { producer: 'MODEL', modelId: 'm1' } } });
    mem.setPreferences({ proposalEnabled: true, cloudContextEnabled: false });
    const sid = mem.session.openSession(); mem.session.add(sid, { category: 'SESSION_CONTEXT', text: 'contexte de session' });
    console.log(JSON.stringify({ pid: process.pid, memoryId: v.memoryId, ...dump() })); store.close();`);
  const reader = path.join(TMP, 'comp-reader.mjs');
  fs.writeFileSync(reader, `${common}
    console.log(JSON.stringify({ pid: process.pid, nb5Statement: nb5.getMemory(process.argv[3])?.statement ?? null, ...dump() })); store.close();`);
  const w = spawnSync(process.execPath, [writer, dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(w.status, 0, w.stderr);
  const W = JSON.parse(w.stdout.trim().split('\n').pop());
  const r = spawnSync(process.execPath, [reader, dir, W.memoryId], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const R = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.notEqual(R.pid, W.pid);
  for (const k of ['ownerId', 'metadata', 'proposals', 'prefs', 'audit']) assert.deepEqual(R[k], W[k], k);
  assert.deepEqual([W.session.items, R.session.sessions, R.session.items, R.chain.ok, R.version, R.nb5Statement], [1, 0, 0, true, 4, 'Je préfère les réponses structurées.']);
});

test('boot gate: disabled by default; product route is gated; development store only outside user data; no companion table in the user DB', () => {
  assert.equal(COMPANION_CERTIFIED, true);
  assert.equal(COMPANION_ACTIVATION, 'DISABLED_PENDING_HUMAN_ACTIVATION');
  assert.deepEqual(resolveCompanionBoot({ env: {} }), { enabled: false, reason: 'COMPANION_NOT_REQUESTED' });
  // [COMPANION-BOOT-PROD-REMED-1] normal boot reads the production store's persisted state: use an isolated product root, never the real store.
  const prodRoot = fs.mkdtempSync(path.join(USER_DATA_DIR, '.test-companion-memory-boot-'));
  try { assert.equal(openCompanionAtBoot({ env: { SQLITE_PATH: path.relative(HERE, path.join(prodRoot, 'cortex.sqlite')) } }).store, null); } finally { fs.rmSync(prodRoot, { recursive: true, force: true }); }
  assert.equal(resolveCompanionBoot({ env: { DOCTEUR_COMPANION_DEV_DB: 'rel.sqlite' } }).reason, 'COMPANION_DEV_PATH_NOT_ABSOLUTE');
  assert.equal(resolveCompanionBoot({ env: { DOCTEUR_COMPANION_DEV_DB: path.join(USER_DATA_DIR, 'cortex.sqlite') } }).reason, 'COMPANION_DEV_PATH_IN_USER_DATA');
  assert.equal(resolveCompanionBoot({ env: { DOCTEUR_COMPANION_DEV_DB: path.join(USER_DATA_DIR, 'sub', 'c.sqlite') } }).reason, 'COMPANION_DEV_PATH_IN_USER_DATA');
  assert.throws(() => CompanionStore.open({ dbPath: path.join(USER_DATA_DIR, 'companion.sqlite') }), code('COMP_DB_IN_USER_DATA'));
  const dev = openCompanionAtBoot({ env: { DOCTEUR_COMPANION_DEV_DB: path.join(TMP, 'boot', 'c.sqlite') } });
  assert.equal(dev.store, null);
  const server = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  assert.ok(server.includes('openCompanionAtBoot') && server.includes('createCompanionUiRoute'), 'server wires the UI only through the boot gate');
  assert.ok(fs.existsSync(path.join(HERE, 'src', 'routes', 'companion.js')), 'typed Companion UI route exists');
  assert.equal(server.includes('createCompanionModel'), false, 'boot wiring never creates the model');
  if (fs.existsSync(REAL_DB[0])) {
    const ro = new Database(REAL_DB[0], { readonly: true, fileMustExist: true });
    try { assert.equal(ro.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'companion%'").get().n, 0, 'real companion tables: 0'); } finally { ro.close(); }
  }
});

test('bounds: every limit PROVISIONAL with a basis; evidence refs, metadata, audit details, pending queue bounded', () => {
  for (const [k, v] of Object.entries(C.LIMITS)) assert.ok(v.value > 0 && v.status === 'PROVISIONAL' && v.basis.length > 5, k);
  const { store, mem } = fresh();
  assert.throws(() => store.audit('MEMORY_ADDED', 'MEMORY', 'm', { details: { x: 'y'.repeat(3000) } }), code('COMP_TOO_LONG'));
  assert.throws(() => store.audit('NOT_AN_ACTION', 'MEMORY', 'm'), code('COMP_INTERNAL'));
  assert.throws(() => C.boundedJson({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } }, 9999, 'm'), code('COMP_INVALID_FIELD'));
  assert.throws(() => C.boundedJson({ n: Number.NaN }, 9999, 'm'), code('COMP_INVALID_FIELD'));
  assert.throws(() => C.cleanSourceReference({ kind: 'NOTEBOOK_CHUNK', ref: 'x'.repeat(201) }), code('COMP_TOO_LONG'));
  for (let i = 0; i < C.limit('pendingProposals'); i++) mem.propose({ kind: 'USER_PREFERENCE', value: `Préférence candidate numéro ${i}.`, provenance: DERIVED() });
  assert.throws(() => mem.propose({ kind: 'USER_PREFERENCE', value: 'Une de trop.', provenance: DERIVED() }), code('COMP_REVIEW_QUEUE_FULL'));
});

test('isolation of the modules: NB-5 public port only; no KG imports/raw SQL, router, provider, network, process or Investigator', () => {
  assert.deepEqual(NB5_PORT, ['createManual', 'getMemory', 'deleteMemory', 'listConflicts']);
  const allowed = ['node:crypto', 'node:fs', 'node:path', 'node:url', 'better-sqlite3', './notebook-security.js', './root-policy/engine.js'];
  // COMP-4: companion-model.js is the one Companion module allowed to reach Model Router V1 (decision D2); it has its own,
  // narrower isolation test in test-companion-model.mjs. Every other Companion module keeps this "no model" boundary.
  for (const f of fs.readdirSync(path.join(HERE, 'src', 'lib')).filter(x => x.startsWith('companion-') && x !== 'companion-model.js')) {
    const src = fs.readFileSync(path.join(HERE, 'src', 'lib', f), 'utf8');
    for (const i of [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])) assert.ok(allowed.includes(i) || i.startsWith('./companion-'), `${f} imports ${i}`);
    const code2 = src.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    assert.equal(/\bfetch\s*\(|child_process|node:(http|https|net|dns|tls)|\bdmem_|investigator|model-router|router\.js|providers\/|ollama|safeFetch|secret-store|sqlite\.js|(?<!\.)\b(spawn|exec|execFile|execSync)\(/i.test(code2), false, f);
  }
  assert.equal(fetchCalls, 0);
  assert.deepEqual(REAL_DB.map(fileHash), realDbBefore, 'real user DB byte-identical');
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'companion')), false);
});
