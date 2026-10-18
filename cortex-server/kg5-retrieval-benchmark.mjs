// Knowledge Graph V1 — KG-5 retrieval latency on synthetic data (temporary files only).
// Usage: node kg5-retrieval-benchmark.mjs [entities…]   (default 1000 10000)
// Measures FTS, semantic (local deterministic embedder + LanceDB), graph expansion,
// hybrid and context assembly. No threshold: numbers are reported, not judged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeGraphStore } from './src/lib/kg-store.js';
import { assertClaim } from './src/lib/kg-claims.js';
import { retrieveKnowledge } from './src/lib/kg-retrieval.js';
import { KgSemanticIndex } from './src/lib/kg-semantic.js';
import { fakeLocalEmbedder } from './fixtures/kg5-retrieval-world.mjs';

const sizes = process.argv.slice(2).map(Number).filter(n => n >= 100);
const SIZES = sizes.length ? sizes : [1000, 10000];
const SUF = ['Alpha', 'Beta', 'Gamma', 'Delta'];

async function median(fn, n = 21) {
  const xs = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn(i);
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return +xs[Math.floor(n / 2)].toFixed(2);
}

async function run(entities) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg5-bench-'));
  try {
    const g = await KnowledgeGraphStore.createTestStore(path.join(dir, 'bench.db'));
    const orgCount = Math.round(entities * 0.4);
    const personCount = entities - orgCount;
    const src = Array.from({ length: 50 }, (_, i) => g.upsertSource({ source_type: 'ARTICLE', name: `Source ${i}`, logical_key: `b:${i}`, privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id);
    const orgs = [];
    const people = [];
    const t0 = performance.now();
    g.transaction(() => {
      for (let i = 0; i < orgCount; i++) orgs.push(g.upsertEntity({ entity_type: 'ORGANIZATION', name: `Société ${i} ${SUF[i % 4]}` }).id);
      for (let i = 0; i < personCount; i++) people.push(g.upsertEntity({ entity_type: 'PERSON', name: `Personne ${i} ${['Martin', 'Durand', 'Petit'][i % 3]}` }).id);
    });
    let claims = 0;
    for (let i = 0; i < orgCount; i++) {
      const ev = (k) => [{ sourceId: src[(i + k) % 50], excerpt: `Société ${i} fait ${k}` }, { sourceId: src[(i + k + 7) % 50], excerpt: `Société ${i} (bis) fait ${k}` }];
      g.transaction(() => {
        for (let k = 0; k < 3; k++) assertClaim(g, { subjectEntityId: orgs[i], predicate: 'ceo', objectEntityId: people[(i * 3 + k) % personCount], validFrom: `${2000 + k * 6}`, validTo: `${2006 + k * 6}`, extractionMethod: 'DETERMINISTIC', evidence: ev(k) });
        assertClaim(g, { subjectEntityId: orgs[i], predicate: 'founder', objectEntityId: people[(i * 5) % personCount], extractionMethod: 'DETERMINISTIC', evidence: ev(10) });
        if (i % 5 === 0) assertClaim(g, { subjectEntityId: orgs[i], predicate: 'ceo', objectEntityId: people[(i + 1) % personCount], extractionMethod: 'DETERMINISTIC', evidence: ev(11) });
        g.upsertRelationship({ source_entity_id: orgs[i], target_entity_id: orgs[(i + 1) % orgCount], relationship_type: 'RELATED_TO', source_id: src[i % 50] });
      });
      claims += i % 5 === 0 ? 5 : 4;
    }
    const buildMs = performance.now() - t0;
    const sem = new KgSemanticIndex({ lancedbPath: path.join(dir, 'bench.lance'), embedder: fakeLocalEmbedder() });
    const ts = performance.now();
    const rebuilt = await sem.rebuild(g);
    const semIndexMs = performance.now() - ts;
    const name = (n) => `Société ${n % orgCount} ${SUF[(n % orgCount) % 4]}`;
    const fts = await median(i => retrieveKnowledge(g, { query: name(i * 7), mode: 'fts' }));
    const semantic = await median(i => retrieveKnowledge(g, { query: `Personne ${(i * 11) % personCount} Martin`, mode: 'semantic', semantic: sem }));
    const graph = await median(i => retrieveKnowledge(g, { query: name(i * 13), mode: 'graph', budget: { maxDepth: 2 } }));
    const hybrid = await median(i => retrieveKnowledge(g, { query: `Qui dirigeait ${name(i * 17)} en 2009 ?`, semantic: sem }));
    const noContext = await median(i => retrieveKnowledge(g, { query: `Qui dirigeait ${name(i * 17)} en 2009 ?`, semantic: sem, assembleContext: false }));
    const sample = await retrieveKnowledge(g, { query: `Qui dirigeait ${name(34)} en 2009 ?`, semantic: sem });
    const stats = g.getStatistics();
    await sem.close();
    g.close();
    return {
      entities, claims, evidences: stats.evidence.total, relations: stats.relationships.total, conflicts: stats.conflicts.total,
      buildSeconds: +(buildMs / 1000).toFixed(1), semanticIndexed: rebuilt.indexed, semanticIndexMs: Math.round(semIndexMs),
      medianMs: { fts, semantic, graphDepth2: graph, hybrid, hybridWithoutContext: noContext, contextAssembly: +(hybrid - noContext).toFixed(2) },
      context: { chars: sample.context.chars, claims: sample.context.counts.claims, evidences: sample.context.counts.evidences, limitsHit: sample.stats.limitsHit },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const n of SIZES) console.log(JSON.stringify(await run(n)));
