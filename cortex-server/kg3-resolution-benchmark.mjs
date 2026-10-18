// Knowledge Graph V1 — KG-3 entity-resolution cost on synthetic data
// (100 / 1 000 / 10 000). Temporary file database only, removed at the end.
// Measures; asserts only correctness invariants (no forced merge) — no
// arbitrary time threshold. Usage: node kg3-resolution-benchmark.mjs [sizes…]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeGraphStore } from './src/lib/kg-store.js';
import { resolveEntityMention } from './src/lib/kg-resolution.js';

const sizes = process.argv.slice(2).map(Number).filter(n => n > 0);
const SIZES = sizes.length ? sizes : [100, 1000, 10000];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg3-bench-'));
const FIRST = ['Jean', 'Marie', 'Ahmed', 'Li', 'Sofia', 'Kenji', 'Ana', 'Olu', 'Élodie', 'Søren'];
const LAST = ['Martin', 'Bernard', 'Dubois', 'Nguyen', 'García', 'Müller', 'Rossi', 'Tanaka', 'Okafor', 'Ivanova'];

function plan(db, sql, ...args) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail).join(' | ');
}

async function run(n) {
  const file = path.join(TMP, `bench-${n}.db`);
  const store = await KnowledgeGraphStore.createTestStore(file);
  const src = store.upsertSource({ source_type: 'ARTICLE', name: 'bench', logical_key: `bench:${n}` }).id;
  const refs = Array.from({ length: 10 }, (_, i) => store.upsertSourceRef({ source_id: src, adapter: 'manual', source_ref: `bench-ref-${i}` }).id);

  // Phase A: n entities — organisations with a stable domain, and people drawn from a
  // small name pool (many homonyms on purpose: the expensive case for resolution).
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) resolveEntityMention(store, { label: `Organisation ${i}`, type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: `org${i}.example` }], sourceRefId: refs[i % 10] });
    else resolveEntityMention(store, { label: `${FIRST[i % 10]} ${LAST[Math.floor(i / 10) % 10]}`, type: 'PERSON', context: { attributes: { idx: String(i) } }, sourceRefId: refs[i % 10] });
  }
  const aMs = performance.now() - t0;

  // Phase B: n mentions — ⅓ stable identifier, ⅓ bare homonym label, ⅓ typo (similarity candidate).
  const outcomes = {};
  const t1 = performance.now();
  for (let i = 0; i < n; i++) {
    let m;
    if (i % 3 === 0) m = { label: `ORGANISATION ${i - (i % 2)}`, type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: `www.org${i - (i % 2)}.example` }] };
    else if (i % 3 === 1) m = { label: `${FIRST[i % 10]} ${LAST[Math.floor(i / 10) % 10]}`, type: 'PERSON' };
    else m = { label: `Organisaton ${i}`, type: 'ORGANIZATION' };
    const r = resolveEntityMention(store, m);
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  }
  const bMs = performance.now() - t1;

  const forced = store.db.prepare("SELECT COUNT(*) AS n FROM kg_entity_resolutions WHERE decision = 'CONFIRMED'").get().n;
  const stats = store.getStatistics();
  const plans = {
    identifier: plan(store.db, "SELECT entity_id FROM kg_entity_identifiers WHERE scheme = ? AND normalized_value = ? AND status = 'ACTIVE'", 'domain', 'x'),
    label: plan(store.db, "SELECT entity_id FROM kg_entities WHERE normalized_name = ? AND entity_type IN (?) AND status <> 'INVALIDATED'", 'x', 'PERSON'),
    alias: plan(store.db, "SELECT entity_id FROM kg_aliases WHERE normalized_alias = ? AND status IN ('CONFIRMED', 'PROPOSED')", 'x'),
    replay: plan(store.db, 'SELECT entity_id FROM kg_aliases WHERE source_ref_id = ? AND normalized_alias = ?', 'r', 'x'),
    tokens: plan(store.db, 'SELECT entity_id FROM kg_entities WHERE token_key = ? AND entity_type IN (?)', 'x', 'PERSON'),
    similarity: plan(store.db, 'SELECT entity_id FROM kg_entities WHERE entity_type IN (?) AND normalized_name >= ? AND normalized_name < ?', 'PERSON', 'ab', 'ab\u{10FFFF}'),
  };
  store.close();
  const sizeKb = Math.round((fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0)) / 1024);
  return {
    n,
    createMs: Math.round(aMs), createPerMentionMs: +(aMs / n).toFixed(3),
    resolveMs: Math.round(bMs), resolvePerMentionMs: +(bMs / n).toFixed(3),
    outcomes, entities: stats.entities.total, aliases: stats.aliases.total, proposals: stats.resolutions.byDecision.PROPOSED ?? 0,
    systemConfirmedMerges: forced, dbSizeKb: sizeKb, plans,
  };
}

const results = [];
try {
  for (const n of SIZES) {
    const r = await run(n);
    results.push(r);
    console.log(JSON.stringify(r));
    if (r.systemConfirmedMerges !== 0) throw new Error(`forced merges at n=${n}`);
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(JSON.stringify({ summary: results.map(r => ({ n: r.n, createPerMentionMs: r.createPerMentionMs, resolvePerMentionMs: r.resolvePerMentionMs, systemConfirmedMerges: r.systemConfirmedMerges })) }));
