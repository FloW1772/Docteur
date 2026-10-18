// Knowledge Graph V1 — KG-CERT final certification checks (temporary databases only).
//
//   CERT-1  architecture: the graph is DERIVED — rebuilt from the same Notebook /
//           neuron sources into an empty KG, it is the same graph (no KG table is an
//           autonomous source of truth); read paths never import a writer.
//   CERT-2  every schema generation (fresh, KG-2 1.3.0, 2.0.0, 2.1.0, 2.2.0, 2.3.0)
//           converges to the same 2.3.0 schema (tables, FKs, indexes, FTS, triggers);
//           repeated migration, interruption + rollback, export / import.
//   CERT-3/4 invariants: no forced merge, reversible resolution without loss, no
//           claim without evidence (except USER), no model claim promoted to fact.
//   CERT-5  privacy red team over every remaining read surface (HTTP, consumer API,
//           semantic), incl. the scope:sources audit (shared logical document).
//   CERT-6  relationship provenance: never guessed, always coherent.
//   CERT-10 security red team: injection, oversized / malformed input, traversal
//           bounds, enumeration, scope escalation, identity spoofing, mutations.
//   CERT-12 restart / persistence in a NEW process.
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { KnowledgeGraphStore } from './src/lib/kg-store.js';
import { KG_SCHEMA_VERSION, KG_TABLES, getSchemaVersion } from './src/lib/kg-schema.js';
import { tableShape } from './src/lib/kg-migrations.js';
import { resolveEntityMention, mergeEntities, reverseResolution } from './src/lib/kg-resolution.js';
import { assertClaim, supersedeClaim } from './src/lib/kg-claims.js';
import { extractClaimsWithLocalModel } from './src/lib/kg-extraction.js';
import { retrieveKnowledge } from './src/lib/kg-retrieval.js';
import { KgSemanticIndex } from './src/lib/kg-semantic.js';
import { createKnowledgeGraphRoute, KG_REMOVED_ROUTES } from './src/routes/kg.js';
import { createKnowledgeGraphApi, KNOWLEDGE_GRAPH_API_VERSION } from './src/lib/kg-consumer-api.js';
import { buildSharedWorld, SHARED_MARKERS } from './fixtures/kgcert-shared-world.mjs';
import { sweepHttp, sweepConsumer, countMarkers } from './fixtures/kgcert-sweep.mjs';
import { buildGraphWorld } from './fixtures/kg6-graph-world.mjs';
import { fakeLocalEmbedder } from './fixtures/kg5-retrieval-world.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kgcert-'));
const NOW = '2026-10-12';
const OUT = process.env.KGCERT_OUT ?? null;
const report = {};
let n = 0;
const tmpDb = () => path.join(TMP, `db-${++n}.sqlite`);
after(() => {
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  fs.rmSync(TMP, { recursive: true, force: true });
});
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const V = KNOWLEDGE_GRAPH_API_VERSION;

/** Every schema object (FTS shadow tables excluded), normalised — the whole physical contract. */
function schemaSignature(db) {
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").all()
    .filter(o => !/_fts_(data|idx|content|docsize|config)$/.test(o.name))
    .map(o => ({ type: o.type, name: o.name, table: o.tbl_name, sql: (o.sql ?? '').replace(/\s+/g, ' ').replace(/IF NOT EXISTS /g, '').trim() }));
  const tables = Object.fromEntries(KG_TABLES.map(t => [t, tableShape(db, t)]));
  // table bodies are compared through tableShape (name-independent); everything else by its SQL
  return { tables, others: objects.filter(o => o.type !== 'table').map(o => `${o.type}|${o.name}|${o.table}|${o.sql}`) };
}

/** Content of every KG table (rows as JSON, sorted) — used to prove "nothing lost / nothing changed". */
function contentHash(db, { exclude = [] } = {}) {
  const h = crypto.createHash('sha256');
  const counts = {};
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kg\\_%' ESCAPE '\\' ORDER BY name").all().map(r => r.name)) {
    if (/_fts_(data|idx|content|docsize|config)$/.test(t) || exclude.includes(t)) continue;
    const rows = db.prepare(`SELECT * FROM "${t}"`).all().map(r => JSON.stringify(r)).sort();
    counts[t] = rows.length;
    h.update(t); h.update(JSON.stringify(rows));
  }
  return { hash: h.digest('hex'), counts };
}

// ── CERT-2 ──────────────────────────────────────────────────────────────────

/** Sample rows written in the dialect of each generation (what an existing user database may hold). */
const SAMPLES = {
  legacy: `INSERT INTO kg_entities (entity_id, entity_type, name, normalized_name) VALUES ('e1', 'ORGANIZATION', 'Acme Corp', 'acme corp'), ('e2', 'PERSON', 'Alice Martin', 'alice martin');
    INSERT INTO kg_sources (source_id, source_type, name) VALUES ('s1', 'ARTICLE', 'Gazette');
    INSERT INTO kg_aliases (alias_id, entity_id, alias, normalized_alias, source_id) VALUES ('a1', 'e1', 'Acme', 'acme', 's1');
    INSERT INTO kg_claims (claim_id, entity_id, claim_type, statement, normalized_statement, source_id) VALUES ('c1', 'e1', 'FACT', 'Acme Corp emploie Alice', 'acme corp emploie alice', 's1');
    INSERT INTO kg_evidence (evidence_id, claim_id, evidence_type, content, normalized_content, source_id) VALUES ('v1', 'c1', 'DIRECT', 'Alice travaille chez Acme', 'alice travaille chez acme', 's1');
    INSERT INTO kg_relationships (relationship_id, source_entity_id, target_entity_id, relationship_type, source_id) VALUES ('r1', 'e2', 'e1', 'MEMBER_OF', 's1'), ('r2', 'e1', 'e2', 'RELATED_TO', NULL);`,
  v2: `INSERT INTO kg_entities (entity_id, entity_type, name, normalized_name, label_key, status) VALUES ('e1', 'ORGANIZATION', 'Acme Corp', 'acme corp', 'acme corp', 'ACTIVE'), ('e2', 'PERSON', 'Alice Martin', 'alice martin', 'alice martin', 'ACTIVE');
    INSERT INTO kg_sources (source_id, source_type, name, status) VALUES ('s1', 'ARTICLE', 'Gazette', 'ACTIVE');
    INSERT INTO kg_source_refs (source_ref_id, source_id, adapter, source_ref) VALUES ('sr1', 's1', 'manual', 'gazette');
    INSERT INTO kg_aliases (alias_id, entity_id, alias, normalized_alias, source_id, source_ref_id) VALUES ('a1', 'e1', 'Acme', 'acme', 's1', 'sr1');
    INSERT INTO kg_claims (claim_id, entity_id, claim_type, statement, normalized_statement, predicate, object_entity_id, source_id, status, extraction_method)
      VALUES ('c1', 'e1', 'RELATIONSHIP', 'Acme Corp emploie Alice', 'acme corp emploie alice', 'ceo', 'e2', 's1', 'SUPPORTED', 'DETERMINISTIC');
    INSERT INTO kg_evidence (evidence_id, evidence_type, content, normalized_content, source_id, source_ref_id, status, excerpt_hash) VALUES ('v1', 'DIRECT', 'Alice travaille chez Acme', 'alice travaille chez acme', 's1', 'sr1', 'ACTIVE', 'h');
    INSERT INTO kg_claim_evidence (claim_id, evidence_id, stance, status) VALUES ('c1', 'v1', 'SUPPORTS', 'ACTIVE');
    INSERT INTO kg_relationships (relationship_id, source_entity_id, target_entity_id, relationship_type, source_id) VALUES ('r1', 'e2', 'e1', 'MEMBER_OF', 's1'), ('r2', 'e1', 'e2', 'RELATED_TO', NULL);`,
};
const GENERATIONS = [
  { name: 'A fresh', sql: null, sample: null },
  { name: 'B KG-2 (1.3.0)', sql: 'kg2-legacy-schema.sql', sample: 'legacy' },
  { name: 'C KG-3 (2.0.0)', sql: 'kg3-schema-2.0.0.sql', sample: 'v2' },
  { name: 'D KG-4 (2.1.0, reconstructed)', sql: 'kgcert-schema-2.1.0.sql', sample: 'v2' },
  { name: 'E KG-5/6/7 (2.2.0)', sql: 'kgcert-schema-2.2.0.sql', sample: 'v2' },
  { name: 'F current (2.3.0)', sql: 'current', sample: 'v2' },
];

function seedGeneration(g) {
  const file = tmpDb();
  if (g.sql === 'current') {
    const raw = new Database(file);
    raw.close();
    return { file, prepare: async () => { const s = await KnowledgeGraphStore.createTestStore(file); s.db.exec(SAMPLES.v2); s.close(); } };
  }
  if (g.sql) {
    const raw = new Database(file);
    raw.exec(fixture(g.sql));
    raw.exec(SAMPLES[g.sample]);
    raw.close();
  }
  return { file, prepare: async () => {} };
}

test('CERT-2 schema convergence: fresh, KG-2, 2.0.0, 2.1.0, 2.2.0, 2.3.0 → the same 2.3.0 schema; data, FTS, FKs kept; no guessed provenance', async () => {
  const fresh = await KnowledgeGraphStore.createTempStore();
  const expected = schemaSignature(fresh.db);
  fresh.close();
  assert.equal(KG_SCHEMA_VERSION, '2.3.0');
  const rows = [];
  for (const g of GENERATIONS) {
    const { file, prepare } = seedGeneration(g);
    await prepare();
    const t0 = performance.now();
    const store = await KnowledgeGraphStore.createTestStore(file);
    const migrationMs = Math.round(performance.now() - t0);
    const db = store.db;
    assert.equal(getSchemaVersion(db), '2.3.0', g.name);
    const sig = schemaSignature(db);
    for (const t of KG_TABLES) assert.deepEqual(sig.tables[t], expected.tables[t], `${g.name}: table ${t}`);
    assert.deepEqual(sig.others, expected.others, `${g.name}: indexes / FTS / triggers`);
    assert.deepEqual(db.pragma('foreign_key_check'), [], g.name);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok', g.name);
    if (g.sample) {
      const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      assert.deepEqual([count('kg_entities'), count('kg_sources'), count('kg_claims'), count('kg_evidence'), count('kg_relationships')], [2, 1, 1, 1, 2], `${g.name}: data kept`);
      assert.equal(count('kg_claim_evidence'), 1, `${g.name}: claim ↔ evidence link`);
      // FTS rebuilt once per row (no duplicates), evidence FTS present
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kg_entities_fts WHERE kg_entities_fts MATCH '\"acme\"'").get().n, 1, `${g.name}: entity FTS`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kg_evidence_fts WHERE kg_evidence_fts MATCH '\"travaille\"'").get().n, 1, `${g.name}: evidence FTS`);
      // CERT-6: pre-2.3 relations keep their logical source; the technical ref is NEVER guessed
      const prov = db.prepare('SELECT relationship_id, source_id, source_ref_id FROM kg_relationship_provenance ORDER BY relationship_id').all();
      if (g.sql !== 'current') assert.deepEqual(prov, [{ relationship_id: 'r1', source_id: 's1', source_ref_id: null }], `${g.name}: provenance backfill`);
      // triggers live: an update keeps one FTS row
      db.prepare("UPDATE kg_entities SET name = 'Acme Corporation', normalized_name = 'acme corporation' WHERE entity_id = 'e1'").run();
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kg_entities_fts WHERE kg_entities_fts MATCH '\"corporation\"'").get().n, 1);
    }
    // repeated migration: reopening changes nothing
    const before = contentHash(db);
    store.close();
    const again = await KnowledgeGraphStore.createTestStore(file);
    assert.equal(again.getMigrationStatus().pendingMigrations, 0);
    assert.deepEqual(contentHash(again.db), before, `${g.name}: repeated open is a no-op`);
    assert.deepEqual(schemaSignature(again.db), expected);
    again.close();
    rows.push({ generation: g.name, migrationMs, sizeBytes: fs.statSync(file).size });
  }
  report.migrations = rows;
});

test('CERT-2 interruption → rollback: a crash inside 008 or mid-chain leaves the previous version intact; the next start converges', async () => {
  // inside 008 (2.2.0 → 2.3.0)
  {
    const { file } = seedGeneration(GENERATIONS[4]);
    const raw = new Database(file);
    const pre = contentHash(raw);
    raw.close();
    await assert.rejects(KnowledgeGraphStore.createTestStore(file, { onMigrationStep: (id, step) => { if (id === '008' && step === 'relationship-provenance') throw new Error('simulated crash'); } }), /simulated crash/);
    const check = new Database(file);
    assert.equal(getSchemaVersion(check), '2.2.0');
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'kg_relationship_provenance'").get().n, 0, 'the new table rolled back');
    assert.deepEqual(contentHash(check), pre, 'data identical after the rollback');
    check.close();
    const ok = await KnowledgeGraphStore.createTestStore(file);
    assert.equal(getSchemaVersion(ok.db), '2.3.0');
    assert.equal(ok.getRelationshipProvenance('r1').length, 1);
    ok.close();
  }
  // mid-chain from KG-2: 005 and 006 commit, 007 crashes → 2.1.0, consistent; restart converges
  {
    const { file } = seedGeneration(GENERATIONS[1]);
    await assert.rejects(KnowledgeGraphStore.createTestStore(file, { onMigrationStep: (id, step) => { if (id === '007' && step === 'fts') throw new Error('simulated crash'); } }), /simulated crash/);
    const check = new Database(file);
    assert.equal(getSchemaVersion(check), '2.1.0');
    assert.deepEqual(check.pragma('foreign_key_check'), []);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM kg_claims').get().n, 1);
    check.close();
    const ok = await KnowledgeGraphStore.createTestStore(file);
    const fresh = await KnowledgeGraphStore.createTempStore();
    assert.deepEqual(schemaSignature(ok.db), schemaSignature(fresh.db));
    ok.close();
    fresh.close();
  }
});

/** A world that exercises every table: resolution (merge, ambiguity), conflicts, supersession, temporal claims, provenance. */
async function richWorld(store) {
  const shared = buildSharedWorld(store);
  const s = shared.sources.pub;
  const m = (label, type, extra = {}) => resolveEntityMention(store, { label, type, sourceRefId: s.refId, ...extra }).entityId;
  const ibm = m('IBM', 'ORGANIZATION', { identifiers: [{ scheme: 'domain', value: 'ibm.example' }] });
  const ibm2 = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'International Business Machines' }).id;
  const merge = mergeEntities(store, ibm2, ibm, { reason: 'same company (user)' });
  const globex = m('Globex', 'ORGANIZATION');
  const chloe = m('Chloé Petit', 'PERSON');
  const david = m('David Roux', 'PERSON');
  const ev = (excerpt) => [{ sourceId: s.sourceId, sourceRefId: s.refId, excerpt }];
  const c1 = assertClaim(store, { subjectEntityId: globex, predicate: 'ceo', objectEntityId: chloe, extractionMethod: 'DETERMINISTIC', evidence: ev('Chloé dirige Globex'), validFrom: '2015-01-01', validTo: '2020-01-01' }).claimId;
  const c2 = assertClaim(store, { subjectEntityId: globex, predicate: 'ceo', objectEntityId: david, extractionMethod: 'DETERMINISTIC', evidence: ev('David dirige Globex'), validFrom: '2018-01-01' }).claimId;
  const c3 = assertClaim(store, { subjectEntityId: globex, predicate: 'founded_on', value: { type: 'date', value: '1999' }, extractionMethod: 'DETERMINISTIC', evidence: ev('fondée en 1999') }).claimId;
  const c4 = assertClaim(store, { subjectEntityId: globex, predicate: 'founded_on', value: { type: 'date', value: '1998' }, extractionMethod: 'USER', evidence: ev('fondée en 1998, corrigé') }).claimId;
  supersedeClaim(store, c3, c4, { reason: 'user correction' });
  return { shared, ibm, ibm2, merge, claims: { c1, c2, c3, c4 } };
}

test('CERT-12 restart / persistence in a NEW process: every table, field and index identical', async () => {
  const file = tmpDb();
  const store = await KnowledgeGraphStore.createTestStore(file);
  await richWorld(store);
  await buildGraphWorld(store, { networkSize: 60, hubSpokes: 40, timelineClaims: 20 });
  const before = { content: contentHash(store.db), schema: schemaSignature(store.db) };
  for (const t of ['kg_entities', 'kg_entity_identifiers', 'kg_aliases', 'kg_source_refs', 'kg_claims', 'kg_evidence', 'kg_claim_evidence', 'kg_entity_resolutions', 'kg_relationship_provenance', 'kg_claim_conflicts']) {
    assert.ok(before.content.counts[t] > 0, `${t} populated`);
  }
  assert.ok(store.prepare("SELECT COUNT(*) AS n FROM kg_claims WHERE valid_from IS NOT NULL AND valid_to IS NOT NULL").get().n > 0);
  store.close();
  const script = `
    import { KnowledgeGraphStore } from './src/lib/kg-store.js';
    import { tableShape } from './src/lib/kg-migrations.js';
    const s = await KnowledgeGraphStore.createTestStore(${JSON.stringify(file)});
    const rows = {};
    for (const t of s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kg\\\\_%' ESCAPE '\\\\' ORDER BY name").all().map(r => r.name)) {
      if (/_fts_(data|idx|content|docsize|config)$/.test(t)) continue;
      rows[t] = s.db.prepare('SELECT * FROM "' + t + '"').all().map(r => JSON.stringify(r)).sort();
    }
    const indexes = s.db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name").all();
    process.stdout.write(JSON.stringify({ rows, indexes, version: s.getMigrationStatus().currentVersion, fk: s.db.pragma('foreign_key_check').length }));
    s.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout);
  assert.equal(out.version, '2.3.0');
  assert.equal(out.fk, 0);
  const h = crypto.createHash('sha256');
  const counts = {};
  for (const [t, r] of Object.entries(out.rows)) { counts[t] = r.length; h.update(t); h.update(JSON.stringify(r)); }
  assert.deepEqual(counts, before.content.counts, 'same rows per table');
  assert.equal(h.digest('hex'), before.content.hash, 'byte-identical content after a real process restart');
  const reopened = new Database(file, { readonly: true });
  assert.deepEqual(schemaSignature(reopened), before.schema, 'same tables / indexes / FTS / triggers');
  reopened.close();
  report.restart = { tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0) };
});

test('CERT-2 export / import: every row of every KG table survives a round trip into an empty store', async () => {
  const src = await KnowledgeGraphStore.createTempStore();
  await richWorld(src);
  const data = src.exportData();
  const dst = await KnowledgeGraphStore.createTempStore();
  const r = dst.importData(data);
  for (const [k, v] of Object.entries(r)) assert.equal(v.failed, 0, `${k}: ${JSON.stringify(v)}`);
  const pick = (db, sql) => db.prepare(sql).all();
  for (const [what, sql] of [
    ['entities', 'SELECT entity_id, entity_type, name, status, merged_into_id FROM kg_entities ORDER BY entity_id'],
    ['identifiers', 'SELECT identifier_id, entity_id, scheme, normalized_value, status, source_ref_id FROM kg_entity_identifiers ORDER BY identifier_id'],
    ['aliases', 'SELECT entity_id, normalized_alias, source_id, source_ref_id, status FROM kg_aliases ORDER BY entity_id, normalized_alias, source_ref_id'],
    ['sources', 'SELECT source_id, name, privacy, egress_policy, status FROM kg_sources ORDER BY source_id'],
    ['refs', 'SELECT source_ref_id, source_id, adapter, source_ref, status, privacy FROM kg_source_refs ORDER BY source_ref_id'],
    ['claims', 'SELECT claim_id, status, claim_key, valid_from, valid_to, superseded_by_id, extraction_method FROM kg_claims ORDER BY claim_id'],
    ['evidence', 'SELECT evidence_id, source_id, source_ref_id, status, chunk_id, char_start, char_end, excerpt_hash FROM kg_evidence ORDER BY evidence_id'],
    ['claimEvidence', 'SELECT claim_id, evidence_id, stance, status FROM kg_claim_evidence ORDER BY claim_id, evidence_id'],
    ['relations', 'SELECT relationship_id, relationship_type, source_id FROM kg_relationships ORDER BY relationship_id'],
    ['relationProvenance', 'SELECT provenance_id, relationship_id, source_id, source_ref_id, status FROM kg_relationship_provenance ORDER BY provenance_id'],
    ['resolutions', 'SELECT resolution_id, source_entity_id, target_entity_id, decision, method, actor FROM kg_entity_resolutions ORDER BY resolution_id'],
    ['conflicts', 'SELECT conflict_id, claim_a_id, claim_b_id, status FROM kg_claim_conflicts ORDER BY conflict_id'],
  ]) assert.deepEqual(pick(dst.db, sql), pick(src.db, sql), what);
  assert.throws(() => dst.importData(data, { reset: true }), /KG_RESET_NOT_SUPPORTED/);
  src.close();
  dst.close();
});

// ── CERT-3 / CERT-4 invariants ──────────────────────────────────────────────

function invariants(store) {
  const one = (sql) => store.prepare(sql).get().n;
  return {
    forcedAmbiguousMerges: one(`SELECT COUNT(*) AS n FROM kg_entity_resolutions WHERE decision = 'CONFIRMED' AND actor = 'SYSTEM'
      AND method IN ('SAME_LABEL_UNCORROBORATED', 'SIMILARITY_CANDIDATE', 'LLM_CANDIDATE')`),
    mergedWithoutLedger: one(`SELECT COUNT(*) AS n FROM kg_entities e WHERE e.merged_into_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM kg_entity_resolutions r WHERE r.source_entity_id = e.entity_id AND r.decision = 'CONFIRMED')`),
    claimsWithoutEvidence: one(`SELECT COUNT(*) AS n FROM kg_claims c WHERE COALESCE(c.extraction_method, '') <> 'USER'
      AND NOT EXISTS (SELECT 1 FROM kg_claim_evidence ce WHERE ce.claim_id = c.claim_id)`),
    modelClaimsPromoted: one("SELECT COUNT(*) AS n FROM kg_claims WHERE extraction_method = 'MODEL_PROPOSAL' AND status IN ('SUPPORTED', 'ASSERTED')"),
    evidenceWithoutSource: one('SELECT COUNT(*) AS n FROM kg_evidence e LEFT JOIN kg_sources s ON s.source_id = e.source_id WHERE s.source_id IS NULL'),
    evidenceRefOfOtherSource: one('SELECT COUNT(*) AS n FROM kg_evidence e JOIN kg_source_refs r ON r.source_ref_id = e.source_ref_id WHERE r.source_id <> e.source_id'),
    relationProvenanceRefOfOtherSource: one('SELECT COUNT(*) AS n FROM kg_relationship_provenance p JOIN kg_source_refs r ON r.source_ref_id = p.source_ref_id WHERE r.source_id <> p.source_id'),
    activeEvidenceOfDeletedSource: one("SELECT COUNT(*) AS n FROM kg_evidence e JOIN kg_sources s ON s.source_id = e.source_id WHERE s.status <> 'ACTIVE' AND e.status = 'ACTIVE'"),
    activeProvenanceOfDeletedSource: one("SELECT COUNT(*) AS n FROM kg_relationship_provenance p JOIN kg_sources s ON s.source_id = p.source_id WHERE s.status <> 'ACTIVE' AND p.status = 'ACTIVE'"),
  };
}

test('CERT-3 / CERT-4 invariants: no forced or destructive merge, reversible resolution, evidence for every non-user claim, model never promoted', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const w = await richWorld(store);
  await buildGraphWorld(store, { networkSize: 60, hubSpokes: 40, timelineClaims: 20 });
  // same-name different-domain organisations and homonyms of different types are never merged by the system
  const pub = w.shared.sources.pub;
  const forum = { sourceId: store.upsertSource({ source_type: 'SOCIAL_MEDIA', name: 'Forum', logical_key: 'cert:forum', privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id };
  forum.refId = store.upsertSourceRef({ source_id: forum.sourceId, adapter: 'manual', source_ref: 'cert:forum', privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
  const meridianA = resolveEntityMention(store, { label: 'Meridian', type: 'ORGANIZATION', sourceRefId: pub.refId, identifiers: [{ scheme: 'domain', value: 'meridian-bank.example' }] }).entityId;
  const meridianB = resolveEntityMention(store, { label: 'Meridian', type: 'ORGANIZATION', sourceRefId: forum.refId, identifiers: [{ scheme: 'domain', value: 'meridian-games.example' }] }).entityId;
  assert.notEqual(meridianA, meridianB, 'same name, different strong identifiers: two organisations');
  const jaguarCar = resolveEntityMention(store, { label: 'Jaguar', type: 'PRODUCT', sourceRefId: pub.refId }).entityId;
  const jaguarAnimal = resolveEntityMention(store, { label: 'Jaguar', type: 'CONCEPT', sourceRefId: pub.refId }).entityId;
  assert.notEqual(jaguarCar, jaguarAnimal, 'cross-type homonyms are not merged');
  const vague = resolveEntityMention(store, { label: 'Meridian', type: 'ORGANIZATION', sourceRefId: forum.refId });
  assert.ok(![meridianA, meridianB].includes(vague.entityId) || store.getEntity(vague.entityId).status === 'AMBIGUOUS' || vague.decision !== 'MERGED', 'an unqualified mention is never force-merged');
  // reversible resolution, nothing lost: merge then reverse restores every row (a CONCEPT never merges into a PRODUCT)
  assert.throws(() => mergeEntities(store, jaguarAnimal, jaguarCar, { reason: 'test' }), /KG_INCOMPATIBLE_TYPES/);
  const jaguarDup = store.upsertEntity({ entity_type: 'PRODUCT', name: 'Jaguar XJ' }).id;
  const before = contentHash(store.db, { exclude: ['kg_entity_resolutions', 'kg_metadata'] });
  const aliasRows = store.prepare('SELECT COUNT(*) AS n FROM kg_aliases').get().n;
  const merged = mergeEntities(store, jaguarDup, jaguarCar, { reason: 'test' });
  assert.equal(store.getLogicalRootId(jaguarDup), jaguarCar);
  assert.equal(store.prepare('SELECT COUNT(*) AS n FROM kg_aliases').get().n, aliasRows, 'a merge deletes nothing');
  assert.ok(store.getEntity(jaguarDup), 'the merged entity row still exists');
  reverseResolution(store, merged.resolutionId, { reason: 'test' });
  assert.equal(store.getLogicalRootId(jaguarDup), jaguarDup);
  const restored = contentHash(store.db, { exclude: ['kg_entity_resolutions', 'kg_metadata'] });
  assert.deepEqual(restored.counts, before.counts, 'same rows after merge + reversal');
  // model extraction: local only, stored as HYPOTHESIS, never promoted even with corroboration
  const local = async () => ({ provider: 'local', model: 'fixture', text: JSON.stringify({ claims: [{ subject: { label: 'Globex', type: 'ORGANIZATION' }, predicate: 'ceo', object: { label: 'Zoé Model', type: 'PERSON' }, quote: 'Zoé Model dirige Globex', confidence: 0.99 }] }) });
  const text = 'Selon la note, Zoé Model dirige Globex depuis peu.';
  const r1 = await extractClaimsWithLocalModel(store, { text, sourceId: pub.sourceId, sourceRefId: pub.refId, complete: local });
  const r2 = await extractClaimsWithLocalModel(store, { text, sourceId: forum.sourceId, sourceRefId: forum.refId, complete: local });
  assert.ok(r1.stored.length === 1 && r2.stored.length === 1);
  const modelClaim = store.prepare("SELECT status FROM kg_claims WHERE extraction_method = 'MODEL_PROPOSAL'").all();
  assert.ok(modelClaim.length > 0 && modelClaim.every(c => ['HYPOTHESIS', 'DISPUTED'].includes(c.status)), JSON.stringify(modelClaim));
  await assert.rejects(extractClaimsWithLocalModel(store, { text, sourceId: pub.sourceId, complete: async () => ({ provider: 'cloud', text: '{}' }) }), /KG_STRICT_LOCAL_REQUIRED/);
  // contradictions kept, supersession recorded, temporal fields intact
  const statuses = Object.fromEntries(Object.entries(w.claims).map(([k, id]) => [k, store.getClaim(id).status]));
  assert.equal(statuses.c3, 'SUPERSEDED');
  assert.ok(['DISPUTED', 'SUPPORTED'].includes(statuses.c1) && ['DISPUTED', 'SUPPORTED'].includes(statuses.c2));
  assert.ok(store.prepare("SELECT COUNT(*) AS n FROM kg_claim_conflicts WHERE status = 'OPEN'").get().n >= 1);
  // source invalidation: claims recomputed, nothing deleted
  const counts0 = contentHash(store.db).counts;
  store.invalidateSource(forum.sourceId, { reason: 'retracted' });
  const counts1 = contentHash(store.db).counts;
  for (const t of Object.keys(counts0)) assert.equal(counts1[t], counts0[t], `${t}: invalidation deletes nothing`);
  const inv = invariants(store);
  report.invariants = inv;
  assert.deepEqual(inv, {
    forcedAmbiguousMerges: 0, mergedWithoutLedger: 0, claimsWithoutEvidence: 0, modelClaimsPromoted: 0, evidenceWithoutSource: 0,
    evidenceRefOfOtherSource: 0, relationProvenanceRefOfOtherSource: 0, activeEvidenceOfDeletedSource: 0, activeProvenanceOfDeletedSource: 0,
  });
  store.close();
});

// ── CERT-5 privacy red team ─────────────────────────────────────────────────

test('CERT-5 privacy red team: every surface × every context, incl. scope:sources on a shared logical document', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const w = buildSharedWorld(store);
  const shared = w.sources.sharedA.sourceId;
  const queries = ['Acme', 'Alice Martin', 'Bob Durand', 'Orion', 'Rapport', 'dirige', 'acme.example', ...Object.values(SHARED_MARKERS).flat()];
  const relIn = (t) => Object.entries(w.relations).filter(([, id]) => t.includes(id)).map(([k]) => k).sort();
  const CONTEXTS = {
    default: {},
    cloud: { provider: 'cloud' },
    nbA: { includePrivate: true, scope: { notebookId: 'nbA' } },
    nbB: { includePrivate: true, scope: { notebookId: 'nbB' } },
    nbAWithoutOptIn: { scope: { notebookId: 'nbA' } },
    wrongNotebook: { includePrivate: true, scope: { notebookId: 'nbZ' } },
    sourcesShared: { includePrivate: true, scope: { sourceIds: [shared] } },
    sourcesSharedNoOptIn: { scope: { sourceIds: [shared] } },
    sourcesSharedAndPublic: { includePrivate: true, scope: { sourceIds: [shared, w.sources.pub.sourceId] } },
    sourcesPrivate: { includePrivate: true, scope: { sourceIds: [w.sources.priv.sourceId] } },
    all: { includePrivate: true, scope: { all: true } },
  };
  const result = {};
  for (const [name, vis] of Object.entries(CONTEXTS)) {
    const r = await sweepHttp(store, vis, queries);
    result[name] = { nbA: countMarkers(r.text, SHARED_MARKERS.nbA), nbB: countMarkers(r.text, SHARED_MARKERS.nbB), priv: countMarkers(r.text, SHARED_MARKERS.privateSource), relations: relIn(r.text), calls: r.calls };
  }
  // consumer API: a companion working in notebook A, then trying to widen through the logical source id it saw
  const consumer = {};
  for (const [name, ctx] of Object.entries({
    companionNbA: ['companion', { scope: { kind: 'notebook', notebookId: 'nbA' }, includePrivate: true, provider: 'local' }],
    companionSourcesShared: ['companion', { scope: { kind: 'sources', sourceIds: [shared] }, includePrivate: true, provider: 'local' }],
    investigatorSourcesSharedPublic: ['investigator', { scope: { kind: 'sources', sourceIds: [shared, w.sources.pub.sourceId] }, includePrivate: true, provider: 'local' }],
    professorPublicCloud: ['professor', { scope: { kind: 'public' }, includePrivate: false, provider: 'cloud' }],
  })) {
    const r = await sweepConsumer(store, ctx[0], ctx[1], queries);
    consumer[name] = { nbA: countMarkers(r.text, SHARED_MARKERS.nbA), nbB: countMarkers(r.text, SHARED_MARKERS.nbB), priv: countMarkers(r.text, SHARED_MARKERS.privateSource), relations: relIn(r.text), calls: r.calls, sharedIdSeen: r.text.includes(shared) };
  }
  // semantic layer (local fake embedder): the same gate applies
  const semDir = path.join(TMP, 'sem.lance');
  const sem = new KgSemanticIndex({ lancedbPath: semDir, embedder: fakeLocalEmbedder() });
  await sem.rebuild(store);
  const semantic = {};
  for (const [name, vis] of Object.entries(CONTEXTS)) {
    let text = '';
    for (const q of queries) {
      const r = await retrieveKnowledge(store, { query: q, mode: 'semantic', semantic: sem, now: NOW, ...vis });
      text += JSON.stringify({ results: r.results, context: r.context });
    }
    semantic[name] = { nbA: countMarkers(text, SHARED_MARKERS.nbA), nbB: countMarkers(text, SHARED_MARKERS.nbB), priv: countMarkers(text, SHARED_MARKERS.privateSource) };
  }
  await sem.close();
  report.privacy = { http: result, consumer, semantic };

  const none = { nbA: 0, nbB: 0, priv: 0 };
  const pick = (x) => ({ nbA: x.nbA, nbB: x.nbB, priv: x.priv });
  for (const name of ['default', 'cloud', 'nbAWithoutOptIn', 'wrongNotebook', 'sourcesShared', 'sourcesSharedNoOptIn', 'sourcesSharedAndPublic']) {
    assert.deepEqual(pick(result[name]), none, `http ${name}`);
    assert.deepEqual(pick(semantic[name]), none, `semantic ${name}`);
  }
  assert.ok(result.nbA.nbA > 0 && result.nbA.nbB === 0 && result.nbA.priv === 0, JSON.stringify(result.nbA));
  assert.ok(result.nbB.nbB > 0 && result.nbB.nbA === 0 && result.nbB.priv === 0, JSON.stringify(result.nbB));
  assert.ok(result.sourcesPrivate.priv > 0 && result.sourcesPrivate.nbA === 0 && result.sourcesPrivate.nbB === 0);
  assert.ok(result.all.nbA > 0 && result.all.nbB > 0 && result.all.priv > 0, 'the gate filters; `all` (explicit) sees everything');
  for (const ctx of ['nbA', 'nbB']) assert.equal(semantic[ctx][ctx === 'nbA' ? 'nbB' : 'nbA'], 0);
  // relations: through their provenance only
  assert.deepEqual(result.sourcesSharedAndPublic.relations, ['pub']);
  assert.deepEqual(result.default.relations, ['pub']);
  assert.deepEqual(result.all.relations, ['logical', 'nbA', 'nbB', 'pub']);
  for (const name of ['nbA', 'nbB', 'sourcesShared', 'wrongNotebook']) assert.ok(!result[name].relations.includes(name === 'nbA' ? 'nbB' : 'nbA') && !result[name].relations.includes('logical'), name);
  // consumer: no widening from a notebook context through the logical source id
  assert.ok(consumer.companionNbA.sharedIdSeen, 'the logical source id IS visible to notebook A (its citations)');
  assert.ok(consumer.companionNbA.nbA > 0 && consumer.companionNbA.nbB === 0);
  assert.deepEqual(pick(consumer.companionSourcesShared), none, 'scope:sources cannot widen to notebook B');
  assert.deepEqual(pick(consumer.investigatorSourcesSharedPublic), none);
  assert.deepEqual(pick(consumer.professorPublicCloud), none);

  // removed raw routes: 410 for any method / id; hidden = absent (identical bodies)
  const app = createKnowledgeGraphRoute(store);
  let removed = 0;
  for (const [p] of KG_REMOVED_ROUTES) {
    for (const method of ['GET', 'POST', 'DELETE', 'PUT', 'PATCH']) {
      const res = await app.request(p.replace(/:[a-zA-Z]+/g, w.entities.acme), { method });
      assert.equal(res.status, 410, `${method} ${p}`);
      assert.equal((await res.json()).error, 'KG_ROUTE_REMOVED');
      removed++;
    }
  }
  const body = async (p, b) => { const r = await app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return `${r.status}|${await r.text()}`; };
  for (const [p, key, hidden] of [['/view/claim', 'claimId', w.claims.nbB], ['/view/relation', 'relationshipId', w.relations.nbB], ['/view/citation', 'evidenceId', w.evidence.nbB], ['/view/source', 'sourceId', w.sources.priv.sourceId]]) {
    for (const vis of [CONTEXTS.nbA, CONTEXTS.sourcesShared, CONTEXTS.default]) {
      assert.equal(await body(p, { [key]: hidden, ...vis }), await body(p, { [key]: `${hidden.slice(0, 4)}nonexistent`, ...vis }), `${p} hidden vs absent`);
    }
  }
  report.privacy.removedRouteChecks = removed;
  store.close();
});

// ── CERT-10 security red team ───────────────────────────────────────────────

test('CERT-10 security red team: injection, malformed input, bounds, enumeration, escalation, spoofing, mutation attempts', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const w = buildSharedWorld(store);
  const g = await buildGraphWorld(store, { networkSize: 200, hubSpokes: 600, timelineClaims: 20 });
  const app = createKnowledgeGraphRoute(store);
  const post = async (p, b, raw = false) => { const r = await app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? b : JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const writes0 = store.db.prepare('SELECT total_changes() AS n').get().n;
  const content0 = contentHash(store.db);
  const sec = {};
  // SQL injection through every id field and the query
  const SQLI = ["' OR 1=1 --", '"; DROP TABLE kg_entities; --', "x' UNION SELECT name FROM sqlite_master --", 'kg_entities', '%', '_'];
  for (const s of SQLI) {
    for (const [p, key] of [['/view/entity', 'entityId'], ['/view/neighborhood', 'entityId'], ['/view/claim', 'claimId'], ['/view/relation', 'relationshipId'], ['/view/source', 'sourceId'], ['/view/citation', 'evidenceId'], ['/view/timeline', 'entityId']]) {
      assert.equal((await post(p, { [key]: s })).status, 404, `${p} ${s}`);
    }
    const r = await post('/search', { query: s });
    assert.equal(r.status, 200);
  }
  sec.sqlInjection = SQLI.length * 8;
  // FTS operator injection: quoted, never interpreted
  const FTS = ['NEAR(Acme Alice)', 'Acme AND NOT Alice', 'name:Acme', '"unterminated', '*', 'Acme*', '^Acme', 'Acme OR', '(((', '{name}: x', 'Acme -Alice', '"" ""'];
  for (const q of FTS) for (const mode of ['fts', 'hybrid', 'exact']) assert.equal((await post('/search', { query: q, mode })).status, 200, `${mode} ${q}`);
  sec.ftsInjection = FTS.length * 3;
  // oversized / malformed / invalid inputs
  const big = await post('/search', { query: 'Acme '.repeat(5000) });
  assert.equal(big.status, 200);
  assert.equal(big.json.query.truncated, true);
  for (const b of [null, [], 'x', { query: 42 }, { query: ['a'] }, { query: 'a', mode: 'sql' }, { query: 'a', temporal: 'now' }, { query: 'a', budget: [] }]) {
    assert.equal((await post('/search', b)).status, 400, JSON.stringify(b));
  }
  assert.equal((await post('/search', '{not json', true)).status, 400);
  for (const id of [42, null, { $ne: 1 }, ['a'], 'x'.repeat(100_000), '\u0000']) assert.ok([400, 404].includes((await post('/view/entity', { entityId: id })).status), String(id).slice(0, 20));
  // malformed scope / escalation
  for (const scope of [{ notebookId: 'nbA', all: true }, { all: 'yes' }, { all: true, extra: 1 }, { sourceIds: 'x' }, { sourceIds: Array.from({ length: 10_001 }, (_, i) => `s${i}`) }, [], 'all', 1]) {
    assert.equal((await post('/search', { query: 'Acme', includePrivate: true, scope })).status, 400, JSON.stringify(scope).slice(0, 60));
  }
  assert.equal((await post('/search', { query: 'Acme', includePrivate: true })).json.error, 'KG_SCOPE_REQUIRED');
  assert.equal((await post('/search', { query: 'Acme', includePrivate: true, provider: 'cloud', scope: { all: true } })).json.error, 'KG_PRIVATE_NOT_FOR_CLOUD');
  assert.equal((await post('/search', { query: 'Acme', includePrivate: 'true', scope: { notebookId: 'nbA' } })).status, 200, 'a non-boolean opt-in is NOT an opt-in');
  const notOptIn = await post('/search', { query: 'ALIASNBA EVNBA', includePrivate: 'true', scope: { notebookId: 'nbA' } });
  assert.ok(!JSON.stringify(notOptIn.json.results).match(/ALIASNBA|EVNBA/));
  // deep traversal / huge fan-out / cycles: bounded
  const deep = await post('/view/neighborhood', { entityId: g.entities.hub, depth: 99, maxNodes: 99999, maxEdges: 99999, fanout: 99999 });
  assert.equal(deep.status, 200);
  assert.ok(deep.json.limits.depth <= 2 && deep.json.limits.maxNodes <= 150 && deep.json.limits.maxEdges <= 300 && deep.json.limits.fanout <= 100, JSON.stringify(deep.json.limits));
  assert.ok(deep.json.nodes.length <= 150 && deep.json.edges.length <= 300);
  const retr = await post('/retrieve', { query: 'Hub Central', mode: 'graph', budget: { maxDepth: 50, maxNodes: 1e9, maxEdges: 1e9, maxFanout: 1e9, timeoutMs: 1e9, maxChars: 1e9 } });
  assert.ok(retr.json.stats.budget.maxDepth <= 2 && retr.json.stats.budget.maxNodes <= 1000 && retr.json.stats.budget.timeoutMs <= 10000 && retr.json.stats.budget.maxChars <= 20000);
  const cyc = await post('/view/neighborhood', { entityId: g.entities.cycleA ?? Object.values(g.entities)[0], depth: 2 });
  assert.equal(cyc.status, 200);
  // consumer API: identity spoofing / escalation
  const api = createKnowledgeGraphApi(store, { today: () => NOW });
  const agency = api.forConsumer('agency');
  const req = (context, params) => ({ apiVersion: V, context, params });
  await assert.rejects(agency.searchKnowledge({ ...req({ scope: { kind: 'public' }, includePrivate: false, provider: 'local' }, { query: 'Acme' }), consumer: 'investigator' }), /KG_REQUEST_INVALID/);
  await assert.rejects(agency.searchKnowledge(req({ scope: { kind: 'public' }, includePrivate: false, provider: 'local', consumer: 'investigator' }, { query: 'Acme' })), /KG_PRIVACY_CONTEXT_INVALID/);
  await assert.rejects(agency.searchKnowledge(req({ scope: { kind: 'all' }, includePrivate: true, provider: 'local' }, { query: 'Acme' })), /KG_SCOPE_FORBIDDEN|KG_PRIVATE_FORBIDDEN/);
  await assert.rejects(api.request('Investigator', 'getEntity', req({ scope: { kind: 'public' }, includePrivate: false, provider: 'local' }, { entityId: w.entities.acme })), /KG_CONSUMER_UNKNOWN/);
  await assert.rejects(api.request('constructor', 'getEntity', req({ scope: { kind: 'public' }, includePrivate: false, provider: 'local' }, { entityId: w.entities.acme })), /KG_CONSUMER_UNKNOWN/);
  await assert.rejects(api.request('agency', 'constructor', req({ scope: { kind: 'public' }, includePrivate: false, provider: 'local' }, {})), /KG_OPERATION_UNKNOWN/);
  await assert.rejects(api.request('agency', 'resetGraph', {}), /KG_OPERATION_FORBIDDEN/);
  const proto = JSON.parse('{"apiVersion":1,"context":{"scope":{"kind":"public"},"includePrivate":false,"provider":"local","__proto__":{"includePrivate":true}},"params":{"query":"Acme"}}');
  await assert.rejects(agency.searchKnowledge(proto), /KG_PRIVACY_CONTEXT_INVALID|KG_REQUEST_INVALID/);
  // private-source enumeration: hidden vs absent, bodies and (roughly) timing
  const timeIt = async (b) => { const xs = []; for (let i = 0; i < 25; i++) { const t = performance.now(); await post('/view/claim', b); xs.push(performance.now() - t); } xs.sort((a, c) => a - c); return xs[12]; };
  const hiddenMs = await timeIt({ claimId: w.claims.priv });
  const absentMs = await timeIt({ claimId: 'clm_nonexistent_0000000000' });
  sec.enumerationTiming = { hiddenMedianMs: Math.round(hiddenMs * 100) / 100, absentMedianMs: Math.round(absentMs * 100) / 100 };
  // mutation / import / reset attempts: no public mutation route
  const MUTATIONS = ['/', '/import', '/reset', '/entities', '/claims', '/sources', '/relationships', '/evidence', '/merge', '/sync', '/migrate', '/view/entity', '/search', '/admin', '/consumer'];
  let mutationStatuses = {};
  for (const p of MUTATIONS) {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await app.request(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset: true, entity: { name: 'x' } }) });
      assert.ok(res.status >= 400, `${method} ${p} → ${res.status}`);
      mutationStatuses[res.status] = (mutationStatuses[res.status] ?? 0) + 1;
    }
    if (!['/view/entity', '/search'].includes(p)) {
      const res = await app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset: true, data: { entities: [{ entity_type: 'PERSON', name: 'Injected' }] } }) });
      assert.ok(res.status >= 400, `POST ${p} → ${res.status}`);
      mutationStatuses[res.status] = (mutationStatuses[res.status] ?? 0) + 1;
    }
  }
  sec.mutationAttempts = mutationStatuses;
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes0, 'no row changed by any request');
  assert.deepEqual(contentHash(store.db), content0);
  // XSS / javascript: payloads are stored and returned as inert JSON text (the UI renders text; see browser suite)
  const xss = store.upsertEntity({ entity_type: 'PERSON', name: '<img src=x onerror=alert(1)>Mallory' }).id;
  const xssView = await post('/view/entity', { entityId: xss });
  assert.equal(xssView.json.entity.label, '<img src=x onerror=alert(1)>Mallory');
  const res = await app.request('/view/entity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entityId: xss }) });
  assert.match(res.headers.get('content-type'), /application\/json/);
  report.security = sec;
  store.close();
});

// ── CERT-1 architecture: derived, reconstructible ───────────────────────────

test('CERT-1 architecture: the graph is derived — rebuilt from the same sources into an empty KG it is the same graph; read paths import no writer', async () => {
  const s1 = await KnowledgeGraphStore.createTempStore();
  const s2 = await KnowledgeGraphStore.createTempStore();
  // the same "source system" read twice (adapters: Notebook documents + article neurons through the frozen shapes)
  const { ingestNotebookDocument } = await import('./src/lib/kg-adapters.js');
  const { extractArticleMetadataClaims } = await import('./src/lib/kg-extraction.js');
  const { buildCanonicalArticle, buildArticleNeurons } = await import('./src/lib/canonical-article.js');
  const article = buildCanonicalArticle({ path: 'url', url: 'https://www.msn.com/fr-fr/actualite/sciences/vera/ar-AA1', title: 'Vera Rubin', text: 'Le télescope Vera Rubin publie des images. '.repeat(8), siteName: 'MSN', author: 'Jean Dupont', publishedAt: '2026-10-03T08:15:00Z' });
  const { child } = buildArticleNeurons(article, { analysis: 'Résumé', title: article.title, modelUsed: 'scripted', captureId: 'cap-1' });
  const page = { id: 'page-1', ...child, createdAt: NOW, updatedAt: NOW, blocks: [] };
  const local = async (messages) => {
    const text = messages[1].content;
    const claims = [...text.matchAll(/(\p{Lu}\p{L}+ \p{Lu}\p{L}+) dirige (\p{Lu}\p{L}+)/gu)].map(m => ({ subject: { label: m[2], type: 'ORGANIZATION' }, predicate: 'ceo', object: { label: m[1], type: 'PERSON' }, quote: m[0], confidence: 0.8 }));
    return { provider: 'local', model: 'fixture', text: JSON.stringify({ claims }) };
  };
  const derive = async (store) => {
    extractArticleMetadataClaims(store, page);
    const docs = [['nbA', 'doc-1', 'Rapport', 'Alice Martin dirige Acme. Bob Durand dirige Globex.'], ['nbB', 'doc-2', 'Copie', 'Alice Martin dirige Acme. Bob Durand dirige Globex.'], ['nbB', 'doc-3', 'Note', 'Chloé Petit dirige Initech.']];
    for (const [notebookId, documentId, title, text] of docs) {
      const r = ingestNotebookDocument(store, { document: { documentId, notebookId, title, hash: crypto.createHash('sha256').update(text).digest('hex'), currentVersionId: `${documentId}-v1`, origin: 'upload', status: 'READY' }, notebook: { notebookId, privacy: true, egress_policy: 'local_only' } });
      await extractClaimsWithLocalModel(store, { text, sourceId: r.sourceId, sourceRefId: r.sourceRefId, complete: local, locator: { kind: 'CHUNK', chunkId: `${documentId}-c1` } });
    }
  };
  await derive(s1);
  await derive(s2);
  const sig = (store) => ({
    sources: store.prepare('SELECT source_id, logical_key, privacy, egress_policy, status FROM kg_sources ORDER BY source_id').all(),
    refs: store.prepare('SELECT source_ref_id, source_id, adapter, source_ref, status FROM kg_source_refs ORDER BY source_ref_id').all(),
    entities: store.prepare('SELECT entity_type, name, status FROM kg_entities ORDER BY entity_type, name').all(),
    claims: store.prepare(`SELECT s.name AS subject, c.predicate, COALESCE(o.name, c.value_json) AS object, c.status, c.extraction_method FROM kg_claims c JOIN kg_entities s ON s.entity_id = c.entity_id
      LEFT JOIN kg_entities o ON o.entity_id = c.object_entity_id ORDER BY 1, 2, 3`).all(),
    evidence: store.prepare('SELECT source_ref_id, chunk_id, char_start, char_end, excerpt_hash, status FROM kg_evidence ORDER BY source_ref_id, chunk_id, char_start, excerpt_hash').all(),
  });
  const a = sig(s1);
  assert.ok(a.claims.length >= 4 && a.refs.length === 4, JSON.stringify({ claims: a.claims.length, refs: a.refs.length }));
  assert.deepEqual(sig(s2), a, 'same sources → same graph (sources, refs, entities, claims, evidence locators)');
  // every derived fact points back to a source; no KG-only facts besides explicit user claims
  assert.equal(s1.prepare("SELECT COUNT(*) AS n FROM kg_claims c WHERE c.extraction_method <> 'USER' AND NOT EXISTS (SELECT 1 FROM kg_claim_evidence ce WHERE ce.claim_id = c.claim_id)").get().n, 0);
  s1.close();
  s2.close();
  // read paths never import a writer of Notebook / neurons, nor a network / provider module
  for (const f of ['src/lib/kg-retrieval.js', 'src/lib/kg-view.js', 'src/lib/kg-consumer-api.js', 'src/lib/kg-consumer-adapters.js', 'src/routes/kg.js']) {
    const imports = [...fs.readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]);
    for (const i of imports) assert.ok(/^(hono|\.\/kg-[a-z-]+\.js|\.\.\/lib\/kg-[a-z-]+\.js|\.\/notebook-docs-store\.js)$/.test(i), `${f} imports ${i}`);
  }
  // the Notebook / neuron integration imports READERS only from the frozen modules
  const integration = fs.readFileSync('src/lib/kg-integration.js', 'utf8');
  const fromFrozen = [...integration.matchAll(/import \{([^}]+)\} from '\.\/(sqlite|notebook-[a-z-]+)\.js'/g)].flatMap(m => m[1].split(',').map(x => x.trim()));
  assert.deepEqual(fromFrozen.sort(), ['getAllPagesMetaFromStore', 'getChunkAnyVersion', 'getCurrentChunkRows', 'getDocument', 'getNotebook', 'getPageFromStore', 'listDocuments']);
  assert.ok(!/getDatabase|savePage|deletePage|importDocument|deleteDocument|setNotebook/.test(integration));
});
