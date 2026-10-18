// Knowledge Graph V1 — KG-CERT performance on synthetic data (temporary files only).
// Usage: node kgcert-benchmark.mjs [entities…]   (default 1000 10000)
// Dense relations (each organisation linked to 3 others, with technical provenance), a high
// fan-out hub (2 000 relations), dated successions + undated contradictions, multi-evidence
// claims. Measures retrieval (FTS / semantic / graph / hybrid), the consumer API, migration
// 2.2.0 → 2.3.0 and DB size. No threshold: numbers are reported, not judged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeGraphStore } from './src/lib/kg-store.js';
import { assertClaim } from './src/lib/kg-claims.js';
import { retrieveKnowledge } from './src/lib/kg-retrieval.js';
import { KgSemanticIndex } from './src/lib/kg-semantic.js';
import { createKnowledgeGraphApi, KNOWLEDGE_GRAPH_API_VERSION } from './src/lib/kg-consumer-api.js';
import { fakeLocalEmbedder } from './fixtures/kg5-retrieval-world.mjs';

const sizes = process.argv.slice(2).map(Number).filter(n => n >= 100);
const SIZES = sizes.length ? sizes : [1000, 10000];
const SUF = ['Alpha', 'Beta', 'Gamma', 'Delta'];

async function stats(fn, n = 21) {
  const xs = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    last = await fn(i);
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return { medianMs: +xs[Math.floor(n / 2)].toFixed(1), p95Ms: +xs[Math.floor(n * 0.95)].toFixed(1), responseChars: JSON.stringify(last ?? '').length };
}

async function run(entities) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgcert-bench-'));
  const file = path.join(dir, 'bench.db');
  try {
    const g = await KnowledgeGraphStore.createTestStore(file);
    const orgCount = Math.round(entities * 0.4);
    const personCount = entities - orgCount;
    const src = Array.from({ length: 50 }, (_, i) => {
      const sourceId = g.upsertSource({ source_type: 'ARTICLE', name: `Source ${i}`, logical_key: `b:${i}`, privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
      return { sourceId, refId: g.upsertSourceRef({ source_id: sourceId, adapter: 'manual', source_ref: `b:${i}`, privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id };
    });
    const orgs = [];
    const people = [];
    const t0 = performance.now();
    g.transaction(() => {
      for (let i = 0; i < orgCount; i++) orgs.push(g.upsertEntity({ entity_type: 'ORGANIZATION', name: `Société ${i} ${SUF[i % 4]}` }).id);
      for (let i = 0; i < personCount; i++) people.push(g.upsertEntity({ entity_type: 'PERSON', name: `Personne ${i} ${['Martin', 'Durand', 'Petit'][i % 3]}` }).id);
    });
    let claims = 0;
    const BATCH = 100;
    for (let start = 0; start < orgCount; start += BATCH) {
      g.transaction(() => {
        for (let i = start; i < Math.min(orgCount, start + BATCH); i++) {
          const ev = (k) => [0, 1].map(j => ({ sourceId: src[(i + k + j * 7) % 50].sourceId, sourceRefId: src[(i + k + j * 7) % 50].refId, excerpt: `Société ${i} fait ${k} (${j})` }));
          for (let k = 0; k < 2; k++) assertClaim(g, { subjectEntityId: orgs[i], predicate: 'ceo', objectEntityId: people[(i * 2 + k) % personCount], validFrom: `${2000 + k * 10}`, validTo: `${2010 + k * 10}`, extractionMethod: 'DETERMINISTIC', evidence: ev(k) });
          assertClaim(g, { subjectEntityId: orgs[i], predicate: 'ceo', objectEntityId: people[(i + 7) % personCount], extractionMethod: 'DETERMINISTIC', evidence: ev(5) });
          assertClaim(g, { subjectEntityId: orgs[i], predicate: 'founder', objectEntityId: people[(i * 3 + 1) % personCount], extractionMethod: 'DETERMINISTIC', evidence: ev(9) });
          for (let r = 1; r <= 3; r++) {
            const s = src[(i + r) % 50];
            g.upsertRelationship({ source_entity_id: orgs[i], target_entity_id: orgs[(i * r + r) % orgCount], relationship_type: 'RELATED_TO', source_id: s.sourceId, source_ref_id: s.refId });
          }
          claims += 4;
        }
      });
    }
    const hub = g.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Hub Central' }).id;
    g.transaction(() => { for (let i = 0; i < Math.min(2000, personCount); i++) g.upsertRelationship({ source_entity_id: people[i], target_entity_id: hub, relationship_type: 'MEMBER_OF', source_id: src[i % 50].sourceId, source_ref_id: src[i % 50].refId }); });
    const buildMs = performance.now() - t0;
    const st = g.getStatistics();
    const sem = new KgSemanticIndex({ lancedbPath: path.join(dir, 'sem.lance'), embedder: fakeLocalEmbedder() });
    const ts = performance.now();
    const indexed = await sem.rebuild(g);
    const semIndexMs = performance.now() - ts;
    const orgName = (n) => `Société ${n % orgCount} ${SUF[(n % orgCount) % 4]}`;
    const retrieval = {
      fts: await stats(i => retrieveKnowledge(g, { query: orgName(i * 7), mode: 'fts' })),
      semantic: await stats(i => retrieveKnowledge(g, { query: `Personne ${i * 11} Martin`, mode: 'semantic', semantic: sem })),
      graphDepth2: await stats(i => retrieveKnowledge(g, { query: orgName(i * 13), mode: 'graph', budget: { maxDepth: 2 } })),
      hybrid: await stats(i => retrieveKnowledge(g, { query: `Qui dirigeait ${orgName(i * 17)} en 2005 ?`, semantic: sem })),
      hubGraph: await stats(() => retrieveKnowledge(g, { query: 'Hub Central', mode: 'graph', budget: { maxDepth: 2 } }), 9),
    };
    const api = createKnowledgeGraphApi(g, { semantic: sem });
    const req = (context, params, bounds) => ({ apiVersion: KNOWLEDGE_GRAPH_API_VERSION, context, params, ...(bounds ? { bounds } : {}) });
    const PUB = { scope: { kind: 'public' }, includePrivate: false, provider: 'local' };
    const consumer = {
      'professor.getNeighborhood(depth 2)': await stats(i => api.forConsumer('professor').getNeighborhood(req(PUB, { entityId: orgs[(i * 31) % orgCount] }, { maxDepth: 2, maxNodes: 60, maxEdges: 120 }))),
      'agency.retrieveKnowledge(cloud)': await stats(i => api.forConsumer('agency').retrieveKnowledge(req({ ...PUB, provider: 'cloud' }, { query: `Qui dirige ${orgName(i * 19)} ?` }))),
      'investigator.getClaims': await stats(i => api.forConsumer('investigator').getClaims(req(PUB, { entityId: orgs[(i * 23) % orgCount] }, { maxClaims: 100, maxEvidence: 100, maxChars: 40000 }))),
      'investigator.getContradictions': await stats(i => api.forConsumer('investigator').getContradictions(req(PUB, { entityId: orgs[(i * 29) % orgCount] }))),
      'investigator.getNeighborhood(hub, max caps)': await stats(() => api.forConsumer('investigator').getNeighborhood(req(PUB, { entityId: hub }, { maxDepth: 2, maxNodes: 150, maxEdges: 300, maxEvidence: 100, maxChars: 40000 })), 9),
    };
    await sem.close();
    g.close();
    const dbBytes = fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0);
    // migration 2.2.0 → 2.3.0 on this database (provenance table removed, version set back)
    const raw = await KnowledgeGraphStore.createTestStore(file);
    raw.db.exec('DROP TABLE kg_relationship_provenance');
    raw.db.prepare("UPDATE kg_metadata SET value = '2.2.0' WHERE key = 'schema_version'").run();
    raw.close();
    const tm = performance.now();
    const migrated = await KnowledgeGraphStore.createTestStore(file);
    const migrationMs = performance.now() - tm;
    const backfilled = migrated.prepare('SELECT COUNT(*) AS n FROM kg_relationship_provenance').get().n;
    const guessed = migrated.prepare('SELECT COUNT(*) AS n FROM kg_relationship_provenance WHERE source_ref_id IS NOT NULL').get().n;
    migrated.close();
    return {
      entities: st.entities.total, claims: st.claims.total, evidence: st.evidence?.total ?? null, relationships: st.relationships.total, conflicts: st.conflicts?.total ?? null,
      buildSeconds: +(buildMs / 1000).toFixed(1), semanticIndex: { items: indexed.indexed, ms: Math.round(semIndexMs) }, dbBytes,
      retrieval, consumer, migration008: { ms: Math.round(migrationMs), relationsBackfilled: backfilled, guessedRefs: guessed },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const n of SIZES) console.log(JSON.stringify(await run(n)));
