// Knowledge Graph V1 — KG-3A: realignment of the KG-2 schema on the KG-1
// contract (identifiers, source refs, claim↔evidence N:N, resolution ledger,
// non-destructive foreign keys, no reset, boot gate).
// Temporary databases only (:memory: or os.tmpdir()); never the user database.
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { KnowledgeGraphStore, KgError } from './src/lib/kg-store.js';
import { runMigrations, tableShape, getMigrationStatus } from './src/lib/kg-migrations.js';
import { KG_TABLES, KG_INDEXES, KG_SCHEMA_VERSION, KG_FTS_TABLES } from './src/lib/kg-schema.js';
import { mergeEntities, reverseResolution } from './src/lib/kg-resolution.js';
import { createKnowledgeGraphRoute, KG_REMOVED_ROUTES } from './src/routes/kg.js';
import { resolveKnowledgeGraphBoot, openKnowledgeGraphAtBoot, KG_DEV_DB_ENV } from './src/lib/kg-boot.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg3a-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LEGACY_SQL = fs.readFileSync(new URL('./fixtures/kg2-legacy-schema.sql', import.meta.url), 'utf8');
let fileCounter = 0;
const tmpDb = () => path.join(TMP, `kg-${++fileCounter}.db`);

/** An early KG-2 database (exact legacy schema) with representative data. */
function legacyDatabase(file) {
  const db = new Database(file);
  db.exec(LEGACY_SQL);
  db.pragma('foreign_keys = ON');
  const ins = (sql, ...args) => db.prepare(sql).run(...args);
  ins("INSERT INTO kg_sources (source_id, source_type, name, uri) VALUES ('s1', 'ARTICLE', 'Article A', 'https://a.example/x')");
  ins("INSERT INTO kg_sources (source_id, source_type, name, is_active) VALUES ('s2', 'DOCUMENT', 'Doc B', 0)");
  ins("INSERT INTO kg_entities (entity_id, entity_type, name, normalized_name, metadata) VALUES ('e1', 'ORGANIZATION', 'Société Générale', 'societe generale', '{\"sector\":\"bank\"}')");
  ins("INSERT INTO kg_entities (entity_id, entity_type, name, normalized_name) VALUES ('e2', 'PERSON', 'Jean Martin', 'jean martin')");
  ins("UPDATE kg_entities SET description = 'banque' WHERE entity_id = 'e1'"); // KG-2 trigger bug: duplicates the FTS row
  ins("INSERT INTO kg_aliases (alias_id, entity_id, alias, normalized_alias, source_id) VALUES ('a1', 'e1', 'SocGen', 'socgen', 's1')");
  ins("INSERT INTO kg_claims (claim_id, entity_id, claim_type, statement, normalized_statement, source_id) VALUES ('c1', 'e1', 'FACT', 'SocGen is a bank', 'socgen is a bank', 's1')");
  ins("INSERT INTO kg_claims (claim_id, entity_id, claim_type, statement, normalized_statement, source_id, is_active) VALUES ('c2', 'e2', 'FACT', 'Jean Martin works at SocGen', 'x', 's2', 0)");
  ins("INSERT INTO kg_evidence (evidence_id, claim_id, evidence_type, content, normalized_content, source_id) VALUES ('v1', 'c1', 'DIRECT', 'La Société Générale est une banque.', 'x', 's1')");
  ins("INSERT INTO kg_evidence (evidence_id, claim_id, evidence_type, content, normalized_content, source_id) VALUES ('v2', 'c1', 'CONTRADICTING', 'Ce n est pas une banque.', 'x', 's1')");
  ins("INSERT INTO kg_relationships (relationship_id, source_entity_id, target_entity_id, relationship_type, source_id) VALUES ('r1', 'e2', 'e1', 'MEMBER_OF', 's1')");
  return db;
}

function schemaObjects(db) {
  return db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'kg_%' OR name LIKE 'idx_kg_%' ORDER BY type, name").all().map(r => `${r.type}:${r.name}`);
}

function sampleGraph(store) {
  const src = (name, extra = {}) => store.upsertSource({ source_type: 'ARTICLE', name, logical_key: `test:${name}`, ...extra }).id;
  const a = src('A');
  const b = src('B');
  const org = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Acme' }).id;
  const c1 = store.upsertClaim({ entity_id: org, claim_type: 'FACT', statement: 'Acme makes anvils', source_id: a }).id;
  const c2 = store.upsertClaim({ entity_id: org, claim_type: 'FACT', statement: 'Acme is in Arizona', source_id: a }).id;
  return { a, b, org, c1, c2 };
}

// ── migrations ──────────────────────────────────────────────────────────────

test('fresh migration: realigned schema 2.0.0, every contract table, clean integrity', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  assert.equal(store.getMigrationStatus().currentVersion, KG_SCHEMA_VERSION);
  for (const t of ['kg_entity_identifiers', 'kg_source_refs', 'kg_entity_resolutions', 'kg_claim_evidence']) {
    assert.ok(tableShape(store.db, t), `${t} exists`);
  }
  for (const t of KG_TABLES) for (const ddl of KG_INDEXES[t]) {
    const name = ddl.match(/INDEX IF NOT EXISTS (\w+)/)[1];
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name), `index ${name}`);
  }
  assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  store.close();
});

test('double migration: second run is a no-op (same schema, same data)', async () => {
  const file = tmpDb();
  const store = await KnowledgeGraphStore.createTestStore(file);
  sampleGraph(store);
  const before = { objects: schemaObjects(store.db), stats: store.getStatistics() };
  const second = runMigrations(store.db);
  assert.equal(second.success, true);
  assert.equal(second.changes.length, 0, 'nothing pending');
  store.close();
  const reopened = await KnowledgeGraphStore.createTestStore(file);
  assert.deepEqual(schemaObjects(reopened.db), before.objects);
  assert.deepEqual(reopened.getStatistics(), before.stats);
  reopened.close();
});

test('upgrade from an early KG-2 database: data kept, links converted, schema identical to a fresh install', async () => {
  const file = tmpDb();
  legacyDatabase(file).close();
  const store = await KnowledgeGraphStore.createTestStore(file);
  const fresh = await KnowledgeGraphStore.createTempStore();
  for (const t of KG_TABLES) assert.deepEqual(tableShape(store.db, t), tableShape(fresh.db, t), `shape of ${t}`);
  assert.deepEqual(schemaObjects(store.db).filter(o => !o.includes('_fts_')), schemaObjects(fresh.db).filter(o => !o.includes('_fts_')));
  assert.equal(store.getMigrationStatus().currentVersion, KG_SCHEMA_VERSION);
  assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  // every legacy row is still there, with its original id and label
  assert.deepEqual(store.db.prepare('SELECT entity_id, name, status FROM kg_entities ORDER BY entity_id').all(), [
    { entity_id: 'e1', name: 'Société Générale', status: 'ACTIVE' },
    { entity_id: 'e2', name: 'Jean Martin', status: 'ACTIVE' },
  ]);
  assert.equal(store.getSource('s2').status, 'INVALIDATED', 'inactive KG-2 source → INVALIDATED');
  assert.equal(store.getEntity('e1').label_key, 'société générale');
  assert.equal(store.getEntity('e1').normalized_name, 'societe generale');
  assert.equal(store.getAliasesForEntity('e1')[0].alias, 'SocGen');
  assert.equal(store.getClaim('c2').status, 'INVALIDATED', 'inactive KG-2 claim → INVALIDATED');
  // the 1:N evidence links became N:N rows (stance from the evidence type)
  assert.deepEqual(store.db.prepare('SELECT claim_id, evidence_id, stance FROM kg_claim_evidence ORDER BY evidence_id').all(), [
    { claim_id: 'c1', evidence_id: 'v1', stance: 'SUPPORTS' },
    { claim_id: 'c1', evidence_id: 'v2', stance: 'CONTRADICTS' },
  ]);
  assert.ok(store.getEvidence('v1').excerpt_hash, 'excerpt hash backfilled');
  assert.equal(store.getRelationships('e2').relationships.length, 1);
  // FTS: the duplicate rows of the KG-2 trigger are gone
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_entities_fts WHERE entity_id = 'e1'").get().n, 1);
  assert.equal(store.searchEntitiesFTS('banque').entities[0]?.entity_id, 'e1');
  store.close();
  fresh.close();
});

test('migration interruption: everything rolls back, the early schema and data stay intact, the next start completes', async () => {
  const file = tmpDb();
  legacyDatabase(file).close();
  const interrupted = new KnowledgeGraphStore(file, {
    onMigrationStep: (id, step) => { if (id === '005' && step === 'rebuild:kg_claims') throw new Error('simulated crash'); },
  });
  await assert.rejects(() => interrupted.initialize(), /simulated crash/);
  const raw = new Database(file, { readonly: true });
  assert.equal(raw.prepare("SELECT value FROM kg_metadata WHERE key = 'schema_version'").get().value, '1.3.0');
  assert.ok(raw.prepare('PRAGMA foreign_key_list(kg_claims)').all().some(fk => fk.on_delete === 'CASCADE'), 'early table untouched');
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'kg_source_refs'").get(), undefined, 'no partial new table');
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE '%__kgrebuild'").get(), undefined, 'no temporary rebuild table');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM kg_evidence').get().n, 2);
  raw.close();
  const store = await KnowledgeGraphStore.createTestStore(file);
  assert.equal(store.getMigrationStatus().currentVersion, KG_SCHEMA_VERSION);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM kg_claim_evidence').get().n, 2);
  store.close();
});

test('runMigrations refuses to run inside an open transaction', async () => {
  const db = new Database(':memory:');
  db.exec('BEGIN');
  assert.throws(() => runMigrations(db), /inside a transaction/);
  db.exec('ROLLBACK');
  db.close();
});

// ── constraints ─────────────────────────────────────────────────────────────

test('foreign keys: no destructive cascade left — every KG foreign key is ON DELETE RESTRICT', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const all = [];
  for (const t of KG_TABLES) {
    for (const fk of store.db.pragma(`foreign_key_list(${t})`)) all.push({ table: t, from: fk.from, on_delete: fk.on_delete, on_update: fk.on_update });
  }
  assert.ok(all.length >= 20, 'every reference is a declared foreign key');
  assert.deepEqual(all.filter(fk => fk.on_delete !== 'RESTRICT'), []);
  assert.deepEqual(all.filter(fk => !['NO ACTION', 'RESTRICT'].includes(fk.on_update)), []);
  // a physical DELETE of a referenced source is refused instead of cascading
  const { a, org, c1 } = sampleGraph(store);
  store.upsertEvidence({ source_id: a, claim_id: c1, evidence_type: 'DIRECT', content: 'proof' });
  assert.throws(() => store.db.prepare('DELETE FROM kg_sources WHERE source_id = ?').run(a), /FOREIGN KEY constraint failed/);
  assert.throws(() => store.db.prepare('DELETE FROM kg_entities WHERE entity_id = ?').run(org), /FOREIGN KEY constraint failed/);
  assert.equal(store.getClaim(c1).claim_id, c1);
  store.close();
});

test('FTS: one row per entity after updates, metadata text indexed, FTS syntax cannot be injected', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const id = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Orange', metadata: { sector: 'télécoms' } }).id;
  store.upsertEntity({ entity_id: id, entity_type: 'ORGANIZATION', name: 'Orange', description: 'opérateur' });
  store.upsertEntity({ entity_id: id, entity_type: 'ORGANIZATION', name: 'Orange', description: 'opérateur', metadata: { sector: 'télécoms' } });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM kg_entities_fts WHERE entity_id = ?').get(id).n, 1);
  assert.equal(store.searchEntitiesFTS('telecoms').entities[0]?.entity_id, id, 'metadata text + diacritics folded');
  assert.equal(store.searchEntitiesFTS('operateur').count, 1);
  for (const hostile of ['name:*', '"unterminated', 'a OR b NEAR(c)', '*', ') DROP TABLE kg_entities; --']) {
    assert.doesNotThrow(() => store.searchEntitiesFTS(hostile));
  }
  assert.ok(store.getEntity(id));
  for (const fts of KG_FTS_TABLES) assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(fts));
  store.close();
});

test('homonyms are never collapsed by the store: no name-derived entity id, entity type immutable', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const a = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Apple' });
  const b = store.upsertEntity({ entity_type: 'PERSON', name: 'apple' });
  const c = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Apple' });
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  assert.equal(store.getEntity(a.id).entity_type, 'ORGANIZATION');
  assert.throws(() => store.upsertEntity({ entity_id: a.id, entity_type: 'PERSON', name: 'Apple' }), e => e.code === 'KG_ENTITY_TYPE_IMMUTABLE');
  store.close();
});

// ── N:N claims ↔ evidence ───────────────────────────────────────────────────

test('claim with two evidences; one evidence supporting two claims (one row, two links)', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const { a, b, c1, c2 } = sampleGraph(store);
  const ev1 = store.upsertEvidence({ source_id: a, claim_id: c1, evidence_type: 'DIRECT', content: 'Acme makes anvils in Arizona.', locator_kind: 'PARAGRAPH', locator_ref: 'p3' });
  const ev2 = store.upsertEvidence({ source_id: b, claim_id: c1, evidence_type: 'DIRECT', content: 'Anvils by Acme.' });
  const shared = store.upsertEvidence({ source_id: a, claim_id: c2, evidence_type: 'DIRECT', content: 'Acme makes anvils in Arizona.', locator_kind: 'PARAGRAPH', locator_ref: 'p3' });
  assert.equal(shared.id, ev1.id, 'same source + locator + excerpt = same evidence');
  assert.equal(shared.isNew, false);
  assert.equal(store.getEvidenceForClaim(c1).length, 2);
  assert.deepEqual(store.getClaimsForEvidence(ev1.id).map(c => c.claim_id).sort(), [c1, c2].sort());
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM kg_evidence').get().n, 2);
  assert.equal(store.getClaim(c1).status, 'SUPPORTED');
  assert.ok(ev2.id);
  // a contradicting evidence: both claims and both evidences are kept, the claim is DISPUTED
  const contra = store.upsertEvidence({ source_id: b, claim_id: c1, evidence_type: 'CONTRADICTING', content: 'Acme closed its anvil plant.' });
  assert.equal(store.getClaim(c1).status, 'DISPUTED');
  store.detachEvidence(c1, contra.id);
  assert.equal(store.getClaim(c1).status, 'SUPPORTED', 'detached, not deleted');
  assert.equal(store.getEvidenceForClaim(c1, { includeDetached: true }).length, 3);
  // only a bounded preview of long evidence is stored; the hash covers the full excerpt
  const long = 'x'.repeat(5000);
  const lv = store.upsertEvidence({ source_id: a, evidence_type: 'DIRECT', content: long });
  assert.ok(store.getEvidence(lv.id).content.length <= 501);
  assert.equal(store.getEvidence(lv.id).metadata.preview_truncated, true);
  store.close();
});

// ── sources: logical vs technical, invalidation ─────────────────────────────

test('same logical source / several technical refs; a ref is never moved to another source', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const s = store.upsertSource({ source_type: 'ARTICLE', name: 'Same article', logical_key: 'article:url:https://x.example/a', canonical_url: 'https://x.example/a', privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
  const other = store.upsertSource({ source_type: 'ARTICLE', name: 'Other', logical_key: 'article:url:https://x.example/b' }).id;
  const r1 = store.upsertSourceRef({ source_id: s, adapter: 'article_capture', input_path: 'paste', source_ref: 'neuron-1', privacy: 'STANDARD', egress_policy: 'cloud_allowed' });
  const r2 = store.upsertSourceRef({ source_id: s, adapter: 'article_capture', input_path: 'url', source_ref: 'neuron-2', privacy: 'STANDARD', egress_policy: 'cloud_allowed' });
  const again = store.upsertSourceRef({ source_id: s, adapter: 'article_capture', input_path: 'url', source_ref: 'neuron-2', privacy: 'STANDARD', egress_policy: 'cloud_allowed' });
  assert.equal(again.id, r2.id);
  assert.equal(again.isNew, false);
  assert.deepEqual(store.getSourceRefs(s).map(r => r.input_path), ['paste', 'url']);
  assert.throws(() => store.upsertSourceRef({ source_id: other, adapter: 'article_capture', source_ref: 'neuron-1' }), e => e.code === 'KG_SOURCE_REF_CONFLICT');
  // privacy only tightens: a private ref makes the logical source private
  store.upsertSourceRef({ source_id: s, adapter: 'neuron', source_ref: 'private-neuron', privacy: 'PRIVATE', egress_policy: 'local_only' });
  assert.equal(store.getSource(s).privacy, 'PRIVATE');
  assert.equal(store.getSource(s).egress_policy, 'local_only');
  store.upsertSource({ source_id: s, source_type: 'ARTICLE', name: 'Same article', privacy: 'PUBLIC', egress_policy: 'cloud_allowed' });
  assert.equal(store.getSource(s).privacy, 'PRIVATE', 'never loosened');
  // bounded technical provenance
  assert.throws(() => store.upsertSourceRef({ source_id: s, adapter: 'manual', source_ref: 'big', provenance: { blob: 'x'.repeat(5000) } }), e => e.code === 'KG_PROVENANCE_TOO_LARGE');
  assert.ok(r1.id);
  store.close();
});

test('source invalidation: no deletion; evidence SOURCE_MISSING; claims recomputed from their other evidence; entities kept', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const { a, b, org, c1, c2 } = sampleGraph(store);
  store.upsertEvidence({ source_id: a, claim_id: c1, evidence_type: 'DIRECT', content: 'from A (c1)' });
  store.upsertEvidence({ source_id: b, claim_id: c1, evidence_type: 'DIRECT', content: 'from B (c1)' });
  store.upsertEvidence({ source_id: a, claim_id: c2, evidence_type: 'DIRECT', content: 'from A (c2)' });
  const counts = () => Object.fromEntries(['kg_sources', 'kg_entities', 'kg_claims', 'kg_evidence', 'kg_claim_evidence'].map(t => [t, store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  const before = counts();
  const result = store.invalidateSource(a, { reason: 'neuron deleted' });
  assert.deepEqual(counts(), before, 'nothing physically deleted');
  assert.equal(store.getSource(a).status, 'INVALIDATED');
  assert.equal(result.claimsRecomputed, 2);
  assert.equal(store.getClaim(c1).status, 'SUPPORTED', 'still supported by source B');
  assert.equal(store.getClaim(c2).status, 'INVALIDATED', 'only evidence came from A');
  assert.ok(store.getEvidenceForClaim(c2, { isActive: false }).every(e => e.status === 'SOURCE_MISSING'));
  assert.equal(store.getEntity(org).status, 'ACTIVE', 'entity untouched');
  assert.equal(store.verifyIntegrity().valid, true);
  store.close();
});

test('source ref invalidation: the logical source survives while another path exists, then becomes DELETED', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const s = store.upsertSource({ source_type: 'ARTICLE', name: 'A', logical_key: 'k:a' }).id;
  const org = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Acme' }).id;
  const claim = store.upsertClaim({ entity_id: org, claim_type: 'FACT', statement: 'x', source_id: s }).id;
  const msn = store.upsertSourceRef({ source_id: s, adapter: 'article_capture', input_path: 'paste', source_ref: 'n1' }).id;
  const url = store.upsertSourceRef({ source_id: s, adapter: 'article_capture', input_path: 'url', source_ref: 'n2' }).id;
  store.upsertEvidence({ source_id: s, source_ref_id: msn, claim_id: claim, evidence_type: 'DIRECT', content: 'proof' });
  const first = store.invalidateSourceRef(msn, { reason: 'MSN capture deleted' });
  assert.equal(first.sourceStillActive, true);
  assert.equal(store.getSource(s).status, 'ACTIVE');
  assert.equal(store.getClaim(claim).status, 'SUPPORTED', 'same logical article still available');
  const last = store.invalidateSourceRef(url);
  assert.equal(last.sourceStillActive, false);
  assert.equal(store.getSource(s).status, 'DELETED');
  assert.equal(store.getClaim(claim).status, 'INVALIDATED');
  assert.equal(store.getSourceRefs(s).length, 2, 'refs kept for audit');
  store.close();
});

// ── resolution ledger ───────────────────────────────────────────────────────

test('resolution ledger + reverse: logical redirect only, originals kept, view restored', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const s = store.upsertSource({ source_type: 'ARTICLE', name: 'A', logical_key: 'k:a' }).id;
  const a = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Microsoft' }).id;
  const b = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Microsoft Corporation' }).id;
  store.upsertAlias({ entity_id: b, alias: 'MSFT', source_id: s });
  const claim = store.upsertClaim({ entity_id: b, claim_type: 'FACT', statement: 'MSFT is listed', source_id: s }).id;
  const merged = mergeEntities(store, b, a, { actor: 'USER', reason: 'same company' });
  const ledger = store.getResolution(merged.resolutionId);
  assert.equal(ledger.decision, 'CONFIRMED');
  assert.equal(ledger.previous_status, 'ACTIVE');
  assert.equal(store.getEntity(b).status, 'MERGED');
  assert.equal(store.getEntity(b).merged_into_id, a);
  assert.equal(store.getEntity(a).name, 'Microsoft', 'canonical label not rewritten');
  const view = store.getLogicalEntity(b);
  assert.equal(view.entity.entity_id, a);
  assert.deepEqual(view.memberIds.sort(), [a, b].sort());
  assert.ok(view.aliases.some(x => x.alias === 'MSFT'));
  assert.deepEqual(view.claimIds, [claim]);
  assert.equal(store.getClaim(claim).entity_id, b, 'claims are never rewritten');
  assert.equal(store.verifyIntegrity().valid, true);
  reverseResolution(store, merged.resolutionId, { reason: 'mistake' });
  assert.equal(store.getEntity(b).status, 'ACTIVE');
  assert.equal(store.getEntity(b).merged_into_id, null);
  assert.equal(store.getResolution(merged.resolutionId).decision, 'REVERSED');
  assert.deepEqual(store.getLogicalEntity(a).memberIds, [a]);
  assert.equal(store.verifyIntegrity().valid, true);
  store.close();
});

// ── public surface ──────────────────────────────────────────────────────────

const POST_READ_ONLY = new Set(['/search', '/retrieve', '/view/neighborhood', '/view/entity', '/view/claim', '/view/relation', '/view/timeline', '/view/source', '/view/citation']);
const REMOVED = new Set(KG_REMOVED_ROUTES.map(([p]) => p));

test('public API: read-only (no mutating route, no reset), every call leaves the database unchanged', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const { a, org, c1 } = sampleGraph(store);
  const ev = store.upsertEvidence({ source_id: a, claim_id: c1, evidence_type: 'DIRECT', content: 'p' }).id;
  const app = createKnowledgeGraphRoute(store);
  const routes = app.routes.map(r => ({ method: r.method, path: r.path }));
  assert.ok(routes.length >= 30);
  for (const r of routes) {
    assert.ok(['GET', 'POST'].includes(r.method) || (r.method === 'ALL' && REMOVED.has(r.path)), `${r.method} ${r.path}`);
    if (r.method === 'POST') assert.ok(POST_READ_ONLY.has(r.path), `POST ${r.path} is a read-only query`);
    if (r.method === 'GET') assert.ok(['/health', '/migration-status'].includes(r.path) || r.path.startsWith('/config/'), `GET ${r.path}: no raw data route`);
    assert.doesNotMatch(r.path, /reset|import|delete|merge|confirm|reverse|invalidate|upsert|write/i);
  }
  const changes = () => store.db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const fill = (p) => p.replace(':entityId', org).replace(':sourceId', a).replace(':claimId', c1).replace(':id', org)
    .replace(':scheme', 'domain').replace(':value', 'acme.example');
  for (const r of routes) {
    const method = r.method === 'ALL' ? 'GET' : r.method;
    const body = method === 'POST' ? JSON.stringify({ query: 'acme', entityId: org, claimId: c1, sourceId: a, evidenceId: ev }) : undefined;
    const res = await app.request(fill(r.path), { method, body, headers: body ? { 'content-type': 'application/json' } : {} });
    assert.ok(res.status < 500, `${r.method} ${r.path} → ${res.status}`);
    if (r.method === 'ALL') assert.equal(res.status, 410, `${r.path} removed`);
  }
  await app.request(`/evidence/${ev}/claims`);
  assert.equal(changes(), before, 'no route wrote anything');
  store.close();
});

test('no production reset: importData({ reset }) is refused and the graph is intact', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  sampleGraph(store);
  const stats = store.getStatistics();
  assert.throws(() => store.importData({ entities: [] }, { reset: true }), e => e instanceof KgError && e.code === 'KG_RESET_NOT_SUPPORTED');
  assert.deepEqual(store.getStatistics(), stats);
  // the additive import round-trips into another store
  const copy = await KnowledgeGraphStore.createTempStore();
  const result = copy.importData(store.exportData());
  assert.equal(result.entities.failed, 0);
  assert.equal(copy.getStatistics().claims.total, stats.claims.total);
  store.close();
  copy.close();
});

test('disabled KG: every route answers 503 KG_DISABLED, nothing is opened', async () => {
  const app = createKnowledgeGraphRoute(null, { disabledReason: 'KG_UNCERTIFIED_DISABLED' });
  for (const [method, p] of [['GET', '/health'], ['GET', '/entities/x'], ['POST', '/entities/search']]) {
    const res = await app.request(p, { method });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'KG_DISABLED', reason: 'KG_UNCERTIFIED_DISABLED' });
  }
});

// ── boot gate ───────────────────────────────────────────────────────────────

test('boot gate: off by default, never on the user database or its data directory, only an explicit separate path', async () => {
  const userDbPath = path.join(TMP, 'userdata', 'cortex.sqlite');
  fs.mkdirSync(path.dirname(userDbPath), { recursive: true });
  assert.deepEqual(resolveKnowledgeGraphBoot({ env: {}, userDbPath }), { enabled: false, reason: 'KG_UNCERTIFIED_DISABLED' });
  assert.equal(resolveKnowledgeGraphBoot({ env: { [KG_DEV_DB_ENV]: userDbPath }, userDbPath }).reason, 'KG_DEV_DB_IS_USER_DB');
  assert.equal(resolveKnowledgeGraphBoot({ env: { [KG_DEV_DB_ENV]: userDbPath.toUpperCase() }, userDbPath }).enabled, false);
  assert.equal(resolveKnowledgeGraphBoot({ env: { [KG_DEV_DB_ENV]: path.join(path.dirname(userDbPath), 'kg.db') }, userDbPath }).reason, 'KG_DEV_DB_IN_USER_DATA_DIR');
  assert.equal(resolveKnowledgeGraphBoot({ env: { [KG_DEV_DB_ENV]: 'relative/kg.db' }, userDbPath }).reason, 'KG_DEV_DB_PATH_NOT_ABSOLUTE');
  const devPath = path.join(TMP, 'dev', 'kg-dev.db');
  assert.deepEqual(resolveKnowledgeGraphBoot({ env: { [KG_DEV_DB_ENV]: devPath }, userDbPath }), { enabled: true, reason: 'KG_DEV_SEPARATE_DB', dbPath: devPath });

  // default boot: no store, no file created, the user DB is not opened
  const off = await openKnowledgeGraphAtBoot({ env: {}, userDbPath });
  assert.equal(off.store, null);
  assert.equal(fs.existsSync(userDbPath), false);
  const on = await openKnowledgeGraphAtBoot({ env: { [KG_DEV_DB_ENV]: devPath }, userDbPath });
  assert.ok(on.store);
  assert.equal(getMigrationStatus(on.store.db).currentVersion, KG_SCHEMA_VERSION);
  on.store.close();
  assert.equal(fs.existsSync(userDbPath), false);
});

test('server.js boots the KG only through the gate (no direct store on SQLITE_PATH)', () => {
  const server = fs.readFileSync(new URL('./src/server.js', import.meta.url), 'utf8');
  assert.match(server, /openKnowledgeGraphAtBoot\(\{ env: process\.env, userDbPath: env\.SQLITE_PATH, logger \}\)/);
  assert.doesNotMatch(server, /KnowledgeGraphStore|createTestStore|createTempStore/);
});
