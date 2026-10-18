// Knowledge Graph V1 — KG-5 hybrid retrieval: exact / FTS / semantic / graph /
// hybrid, temporal and privacy filters, contradictions and ambiguity kept,
// original-source citations, strict context budget, Notebook baseline comparison.
// Temporary databases only (SQLite + LanceDB in os.tmpdir()); the "embedding
// model" is a deterministic local function — no network, no model, no cloud.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { KnowledgeGraphStore } from './src/lib/kg-store.js';
import { assertClaim } from './src/lib/kg-claims.js';
import { resolveEntityMention } from './src/lib/kg-resolution.js';
import { retrieveKnowledge, normalizeQuery, buildFtsExpression, parseTemporalIntent, SIGNAL_WEIGHTS, resolveBudget, RetrievalError } from './src/lib/kg-retrieval.js';
import { KgSemanticIndex, createLocalEmbedder } from './src/lib/kg-semantic.js';
import { createKnowledgeGraphRoute } from './src/routes/kg.js';
import { buildWorld, evaluate, fakeLocalEmbedder, fakeEmbed, citationCorrect, kgDocuments } from './fixtures/kg5-retrieval-world.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg5-'));
const DB = path.join(TMP, 'world.db');
let store;
let world;
let semantic;
const NOW = '2026-10-07';
const scoped = () => ({ includePrivate: true, scope: { notebookId: world.nb }, now: NOW });

before(async () => {
  initSqlite(DB);
  store = await KnowledgeGraphStore.createTestStore(DB);
  world = await buildWorld({ tmpDir: TMP, store });
  semantic = new KgSemanticIndex({ lancedbPath: path.join(TMP, 'kg.lance'), embedder: fakeLocalEmbedder() });
  const rebuilt = await semantic.rebuild(store);
  assert.equal(rebuilt.ok, true);
});
after(async () => {
  await semantic?.close();
  store?.close();
  try { getDatabase().close(); } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const ids = (r, type) => r.results.filter(x => !type || x.resultType === type).map(x => x.id);
const claimObjects = (r) => r.results.filter(x => x.resultType === 'claim').map(x => x.object.label ?? x.object.value?.value);
const sumOk = (res) => Math.abs(res.ranking.reduce((s, x) => s + x.contribution, 0) - res.ownScore) < 1e-6;

// ── FTS / exact ─────────────────────────────────────────────────────────────

test('FTS: terms, phrase, prefix, accents, Unicode, punctuation, reserved words — user text is never an FTS expression', async () => {
  // AND / NOT are stopwords (dropped); NEAR is kept as a quoted literal; only our own OR / phrase / prefix syntax remains
  assert.equal(buildFtsExpression(normalizeQuery('Globex AND NOT "Chloé Petit" NEAR(x) prix*')), '"Chloé Petit" OR "Globex" OR "NEAR" OR "prix"*');
  assert.equal(buildFtsExpression(normalizeQuery('a* b: c^ -d')), '');
  for (const q of ['Globex', '"directrice générale"', 'Glob*', 'chloe petit', 'CHLOÉ', 'Chloé, Petit !', 'Globex AND OR NOT', 'NEAR(Globex, 2)', '*', '"', '()', 'col:Globex', '^Globex', '- Globex +']) {
    const r = await retrieveKnowledge(store, { query: q, mode: 'fts', ...scoped() });
    assert.ok(Array.isArray(r.results), q);
  }
  const phrase = await retrieveKnowledge(store, { query: '"directrice générale"', mode: 'fts', ...scoped() });
  assert.ok(kgDocuments(world, phrase).includes('D4'));
  const prefix = await retrieveKnowledge(store, { query: 'Glob*', mode: 'fts', ...scoped() });
  assert.ok(ids(prefix, 'entity').includes(world.entities.globex), 'prefix query');
  const noPrefix = await retrieveKnowledge(store, { query: 'Glob', mode: 'fts', ...scoped() });
  assert.ok(!ids(noPrefix, 'entity').includes(world.entities.globex), 'no implicit prefix');
  const accents = await retrieveKnowledge(store, { query: 'chloe', mode: 'fts', ...scoped() });
  assert.ok(ids(accents, 'entity').includes(world.entities.chloe), 'accent-insensitive (remove_diacritics)');
  const unicode = await retrieveKnowledge(store, { query: 'Phénix', mode: 'fts', ...scoped() });
  assert.ok(ids(unicode, 'entity').includes(world.entities.phenix));
});

test('exact search: whole label, alias absent from the text, identifier, mention inside a question', async () => {
  const label = await retrieveKnowledge(store, { query: 'Globex', mode: 'exact', ...scoped() });
  assert.equal(label.results.find(r => r.id === world.entities.globex).whyMatched[0], 'exact_entity_match');
  const alias = await retrieveKnowledge(store, { query: 'Géant de l’Enclume', mode: 'exact', ...scoped() });
  assert.ok(alias.results.find(r => r.id === world.entities.acme).whyMatched.includes('exact_entity_match'));
  const identifier = await retrieveKnowledge(store, { query: 'https://www.acme.example/fr', mode: 'exact', ...scoped() });
  assert.ok(identifier.results.find(r => r.id === world.entities.acme).whyMatched.includes('exact_identifier_match'));
  const mention = await retrieveKnowledge(store, { query: 'Que fait Eva Lambert ?', mode: 'exact', ...scoped() });
  assert.ok(mention.results.find(r => r.id === world.entities.eva).whyMatched.includes('entity_mention'));
});

// ── semantic ────────────────────────────────────────────────────────────────

test('semantic: local layer finds synonyms; unavailable / failing / non-local / missing index never break retrieval, no cloud fallback', async () => {
  const sem = await retrieveKnowledge(store, { query: 'automobile Initech', mode: 'semantic', semantic, ...scoped() });
  assert.equal(sem.semantic.state, 'AVAILABLE');
  assert.ok(sem.results.some(r => r.id === world.entities.car && r.whyMatched.includes('semantic_similarity')), 'voiture ≈ automobile');
  // a semantic-only match, isolated: no lexical overlap at all between query and entity
  const g = await KnowledgeGraphStore.createTempStore();
  const car = g.upsertEntity({ entity_type: 'PRODUCT', name: 'Voiture' }).id;
  g.upsertEntity({ entity_type: 'PRODUCT', name: 'Bicyclette' });
  const gs = new KgSemanticIndex({ lancedbPath: path.join(TMP, 'iso.lance'), embedder: fakeLocalEmbedder() });
  await gs.rebuild(g);
  assert.deepEqual(ids(await retrieveKnowledge(g, { query: 'automobile', mode: 'fts' })), []);
  const iso = await retrieveKnowledge(g, { query: 'automobile', mode: 'semantic', semantic: gs });
  assert.deepEqual(ids(iso, 'entity'), [car]);
  assert.deepEqual(iso.results[0].whyMatched, ['semantic_similarity']);
  const isoHybrid = await retrieveKnowledge(g, { query: 'automobile', semantic: gs });
  assert.deepEqual(ids(isoHybrid, 'entity'), [car], 'hybrid keeps a semantic-only match');
  await gs.close();
  g.close();

  const none = await retrieveKnowledge(store, { query: 'Globex automobile', semantic: null, ...scoped() });
  assert.deepEqual(none.semantic, { state: 'UNAVAILABLE', reason: 'NO_SEMANTIC_LAYER' });
  assert.ok(none.results.length > 0, 'FTS + graph still answer');
  const noEmbedder = new KgSemanticIndex({ lancedbPath: path.join(TMP, 'none.lance') });
  assert.equal((await noEmbedder.status()).reason, 'NO_LOCAL_EMBEDDER');

  let cloudCalls = 0;
  const cloud = new KgSemanticIndex({ lancedbPath: path.join(TMP, 'cloud.lance'), embedder: createLocalEmbedder({ embedOne: async (t) => { cloudCalls++; return fakeEmbed(t); }, model: 'x', provider: 'openai' }) });
  const refused = await retrieveKnowledge(store, { query: 'automobile', semantic: cloud, ...scoped() });
  assert.deepEqual(refused.semantic, { state: 'UNAVAILABLE', reason: 'STRICT_LOCAL_PROVIDER_REFUSED', hits: 0 });
  assert.equal(cloudCalls, 0, 'a non-local embedder is never called');

  const lying = new KgSemanticIndex({ lancedbPath: path.join(TMP, 'lying.lance'), embedder: { model: 'x', provider: 'local', embed: async (texts) => ({ vectors: texts.map(fakeEmbed), provider: 'openrouter' }) } });
  assert.equal((await lying.status()).reason, 'STRICT_LOCAL_PROVIDER_REFUSED', 'the provider reported at call time is checked too');

  const down = new KgSemanticIndex({ lancedbPath: path.join(TMP, 'down.lance'), embedder: createLocalEmbedder({ embedOne: async () => { throw new Error('ollama: model "nomic-embed-text" not found'); }, model: 'nomic-embed-text' }) });
  const degraded = await retrieveKnowledge(store, { query: 'Globex', semantic: down, ...scoped() });
  assert.equal(degraded.semantic.state, 'UNAVAILABLE');
  assert.equal(degraded.semantic.reason, 'EMBEDDER_FAILED');
  assert.ok(degraded.results.some(r => r.id === world.entities.globex));

  const missing = new KgSemanticIndex({ lancedbPath: path.join(TMP, 'missing.lance'), embedder: fakeLocalEmbedder() });
  const m = await retrieveKnowledge(store, { query: 'Globex', semantic: missing, ...scoped() });
  assert.deepEqual([m.semantic.state, m.semantic.reason], ['DEGRADED', 'INDEX_MISSING']);
  assert.ok(m.results.length > 0);
  await missing.close();
});

// ── graph ───────────────────────────────────────────────────────────────────

test('graph: bounded traversal — cycles, depth, node / edge / fan-out limits, timeout', async () => {
  const g = await KnowledgeGraphStore.createTempStore();
  const s = g.upsertSource({ source_type: 'ARTICLE', name: 'g', logical_key: 'g', privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
  const e = (name) => g.upsertEntity({ entity_type: 'CONCEPT', name }).id;
  const [a, b, c, d] = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(e);
  for (const [x, y] of [[a, b], [b, c], [c, a], [c, d]]) g.upsertRelationship({ source_entity_id: x, target_entity_id: y, relationship_type: 'RELATED_TO', source_id: s });
  const cyc = await retrieveKnowledge(g, { query: 'Alpha', mode: 'graph', budget: { maxDepth: 2 } });
  assert.deepEqual(new Set(ids(cyc, 'entity')), new Set([b, c, d]), 'Beta and Gamma at 1 hop (through the cycle), Delta at 2 hops');
  assert.equal(new Set(ids(cyc)).size, ids(cyc).length, 'no duplicate through the cycle');
  const depth1 = await retrieveKnowledge(g, { query: 'Alpha', mode: 'graph', budget: { maxDepth: 1 } });
  assert.ok(!ids(depth1, 'entity').includes(d), 'Delta is 2 hops away');
  assert.ok(depth1.stats.limitsHit.includes('max_depth'));
  const depth9 = await retrieveKnowledge(g, { query: 'Alpha', mode: 'graph', budget: { maxDepth: 9 } });
  assert.equal(depth9.stats.budget.maxDepth, 2, 'hard cap');

  const hub = e('Hub');
  const spokes = Array.from({ length: 3000 }, (_, i) => e(`Spoke ${i}`));
  g.transaction(() => spokes.forEach(sp => g.upsertRelationship({ source_entity_id: hub, target_entity_id: sp, relationship_type: 'RELATED_TO', source_id: s })));
  const t0 = performance.now();
  const fan = await retrieveKnowledge(g, { query: 'Hub', budget: { maxNodes: 50, maxEdges: 80, maxFanout: 60 } });
  const ms = performance.now() - t0;
  assert.ok(fan.stats.graph.nodes <= 50 && fan.stats.graph.edges <= 80, JSON.stringify(fan.stats.graph));
  assert.ok(fan.stats.limitsHit.some(l => ['fanout', 'max_edges', 'max_nodes'].includes(l)));
  assert.ok(fan.results.filter(r => r.resultType === 'entity').length <= 10);
  assert.ok(ms < 5000, `bounded expansion (${ms.toFixed(0)} ms)`);
  const timeout = await retrieveKnowledge(g, { query: 'Hub', budget: { timeoutMs: 0 } });
  assert.ok(timeout.stats.limitsHit.includes('timeout'));
  assert.ok(Array.isArray(timeout.results), 'partial result, no throw');
  g.close();
});

// ── ranking / temporal / contradictions / ambiguity ─────────────────────────

test('hybrid ranking is an explicit sum of named signals; whyMatched explains every result', async () => {
  const r = await retrieveKnowledge(store, { query: 'Qui dirige actuellement le fabricant du Widget X ?', semantic, ...scoped() });
  assert.ok(r.results.length > 0);
  for (const res of r.results) {
    for (const s of res.ranking) {
      assert.equal(s.weight, SIGNAL_WEIGHTS[s.signal], s.signal);
      assert.ok(Math.abs(s.contribution - Math.round(s.weight * s.value * 1e6) / 1e6) < 1e-6);
    }
    if (res.resultType === 'claim') assert.ok(sumOk(res), 'score = Σ contributions');
    assert.ok(res.whyMatched.length > 0);
    assert.ok(res.whyMatched.every(w => w in SIGNAL_WEIGHTS || w === 'contradiction_counterpart'));
  }
  const bob = r.results.find(x => x.resultType === 'claim' && x.object.label === 'Bob Durand');
  assert.ok(bob.whyMatched.includes('graph_1_hop') || bob.whyMatched.includes('claim_about_matched_entity'));
  assert.ok(bob.whyMatched.includes('predicate_match'), '"dirige" names the ceo predicate');
  assert.ok(!claimObjects(r).includes('Alice Martin'), '"actuellement": the former CEO is filtered by time');
  // same query, same result (deterministic)
  const again = await retrieveKnowledge(store, { query: 'Qui dirige actuellement le fabricant du Widget X ?', semantic, ...scoped() });
  assert.deepEqual(again.results.map(x => [x.id, x.score]), r.results.map(x => [x.id, x.score]));
  assert.equal(again.context.text, r.context.text);
});

test('temporal retrieval: current / past / at / during / before / after — undated claims are never given invented dates', async () => {
  assert.deepEqual(parseTemporalIntent('PDG actuel'), { kind: 'current', matched: 'actuel' });
  assert.equal(parseTemporalIntent('en 2012').kind, 'during');
  assert.deepEqual(parseTemporalIntent('au 03/10/2026'), { kind: 'at', date: '2026-10-03', matched: 'au 03/10/2026' });
  assert.equal(parseTemporalIntent('avant 2015').kind, 'before');
  assert.equal(parseTemporalIntent('après 2016-01-01').date, '2016-01-01');
  assert.equal(parseTemporalIntent('Acme').kind, 'any');
  const ceo = async (query, temporal) => claimObjects(await retrieveKnowledge(store, { query, temporal, ...scoped() })).filter(o => ['Alice Martin', 'Bob Durand'].includes(o)).sort();
  assert.deepEqual(await ceo('directeur général actuel d’Acme Industries'), ['Bob Durand']);
  assert.deepEqual(await ceo('ancienne directrice générale d’Acme Industries'), ['Alice Martin']);
  assert.deepEqual(await ceo('Qui dirigeait Acme Industries en 2012 ?'), ['Alice Martin']);
  assert.deepEqual(await ceo('directeur général d’Acme Industries', { kind: 'at', date: '2015-07-01' }), ['Bob Durand'], 'validTo exclusive');
  assert.deepEqual(await ceo('directeur général d’Acme Industries avant 2015'), ['Alice Martin']);
  assert.deepEqual(await ceo('directeur général d’Acme Industries après 2016'), ['Bob Durand']);
  assert.deepEqual(await ceo('directeur général d’Acme Industries'), ['Alice Martin', 'Bob Durand'], 'no temporal intent: both, with their dates');
  // Globex CEO claims have no dates: kept for "current" (basis undated), excluded from past / before / after
  const globexNow = await retrieveKnowledge(store, { query: 'directeur général actuel de Globex', ...scoped() });
  const undated = globexNow.results.filter(x => x.resultType === 'claim' && x.predicate === 'ceo');
  assert.equal(undated.length, 2);
  assert.ok(undated.every(x => x.temporal.basis === 'undated' && x.temporal.validFrom === null && x.temporal.validTo === null));
  assert.ok(!undated.some(x => x.whyMatched.includes('temporal_match')), 'no temporal credit without dates');
  const globexPast = await retrieveKnowledge(store, { query: 'ancien directeur de Globex', ...scoped() });
  assert.equal(globexPast.results.filter(x => x.resultType === 'claim' && x.predicate === 'ceo').length, 0);
  await assert.rejects(() => retrieveKnowledge(store, { query: 'x', temporal: { kind: 'at' } }), e => e.code === 'KG_TEMPORAL_INVALID');
});

test('contradictions are preserved: both sides with their evidence and dates, never one side alone (even under a tight budget)', async () => {
  const r = await retrieveKnowledge(store, { query: 'directeur général de Globex', ...scoped() });
  const sides = r.results.filter(x => x.resultType === 'claim' && x.predicate === 'ceo' && x.subject.entityId === world.entities.globex);
  assert.equal(sides.length, 2);
  assert.ok(sides.every(x => x.contradiction.status === 'OPEN_CONFLICT' && x.contradiction.counterpartIds.length === 1));
  assert.equal(sides[0].contradiction.groupId, sides[1].contradiction.groupId);
  assert.equal(sides[0].score, sides[1].score, 'a group is ranked as one unit');
  assert.ok(sides.every(x => x.citations.length >= 1));
  assert.match(r.context.text, /Chloé Petit.*CONTRADICTED/);
  assert.match(r.context.text, /David Roux.*CONTRADICTED/);
  // a side found alone pulls its counterpart in
  const one = await retrieveKnowledge(store, { query: 'Chloé Petit', ...scoped() });
  assert.deepEqual(claimObjects(one).filter(o => ['Chloé Petit', 'David Roux'].includes(o)).sort(), ['Chloé Petit', 'David Roux']);
  // budget too small for the pair → neither side, explicitly reported
  const tight = await retrieveKnowledge(store, { query: 'Chloé Petit', budget: { maxClaims: 1 }, ...scoped() });
  const kept = claimObjects(tight).filter(o => ['Chloé Petit', 'David Roux'].includes(o));
  assert.equal(kept.length, 0);
  assert.ok(tight.context.truncated.some(t => t.kind === 'contradiction_group' && t.ids.length === 2));
  const tightChars = await retrieveKnowledge(store, { query: 'directeur général de Globex', budget: { maxChars: 250 }, ...scoped() });
  const ctxSides = ['Chloé Petit', 'David Roux'].filter(n => tightChars.context.text.includes(`— ceo — ${n}`));
  assert.ok(ctxSides.length === 0 || ctxSides.length === 2, 'the context never shows one side only');
});

test('ambiguous entities keep their ambiguity: candidates listed, penalty applied, never a certain resolution', async () => {
  const g = await KnowledgeGraphStore.createTempStore();
  const s = g.upsertSource({ source_type: 'ARTICLE', name: 'a', logical_key: 'a', privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
  const ref = g.upsertSourceRef({ source_id: s, adapter: 'manual', source_ref: 'a', privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
  resolveEntityMention(g, { label: 'Apple', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'apple.com' }], sourceRefId: ref });
  resolveEntityMention(g, { label: 'Apple', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'applerecords.example' }], sourceRefId: ref });
  const r = await retrieveKnowledge(g, { query: 'Apple' });
  const amb = r.results.find(x => x.resultType === 'entity' && x.status === 'AMBIGUOUS');
  assert.ok(amb, 'the ambiguous entity is returned as such');
  assert.equal(amb.ambiguity.status, 'AMBIGUOUS');
  assert.equal(amb.ambiguity.candidates.length, 1);
  assert.ok(amb.whyMatched.includes('ambiguous_entity'));
  assert.ok(amb.ranking.find(x => x.signal === 'ambiguous_entity').contribution < 0);
  assert.match(r.context.text, /AMBIGUOUS, candidates: Apple/);
  g.close();
});

test('source invalidation: invalidated evidence never ranks or is cited; a claim kept by another source stays retrievable', async () => {
  const g = await KnowledgeGraphStore.createTempStore();
  const src = (n) => g.upsertSource({ source_type: 'ARTICLE', name: n, logical_key: n, privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id;
  const s1 = src('one');
  const s2 = src('two');
  const p = g.upsertEntity({ entity_type: 'PRODUCT', name: 'Zorglub' }).id;
  const q = g.upsertEntity({ entity_type: 'PRODUCT', name: 'Zorglub Mini' }).id;
  const kept = assertClaim(g, { subjectEntityId: p, predicate: 'price', value: { type: 'number', value: 10, unit: 'EUR' }, extractionMethod: 'DETERMINISTIC', evidence: [{ sourceId: s1, excerpt: 'Zorglub 10 €' }, { sourceId: s2, excerpt: 'Zorglub coûte 10 euros' }] });
  const lost = assertClaim(g, { subjectEntityId: q, predicate: 'price', value: { type: 'number', value: 5, unit: 'EUR' }, extractionMethod: 'DETERMINISTIC', evidence: [{ sourceId: s1, excerpt: 'Zorglub Mini 5 €' }] });
  g.invalidateSource(s1);
  const r = await retrieveKnowledge(g, { query: 'prix Zorglub' });
  assert.ok(ids(r, 'claim').includes(kept.claimId));
  assert.ok(!ids(r, 'claim').includes(lost.claimId), 'no active evidence left → not retrieved');
  const c = r.results.find(x => x.id === kept.claimId);
  assert.deepEqual(c.citations.map(x => x.sourceId), [s2], 'only the active source is cited');
  assert.equal(c.ranking.find(x => x.signal === 'evidence_count').value <= 1, true);
  g.close();
});

// ── privacy ─────────────────────────────────────────────────────────────────

test('privacy: private sources hidden by default, local-only kept from cloud contexts, notebook scope respected, no private evidence leak', async () => {
  // Notebook documents are local-only (Notebook strict-local contract) → private for the KG: invisible by default
  const def = await retrieveKnowledge(store, { query: 'Globex', now: NOW });
  assert.equal(def.results.length, 0);
  // the other (private) notebook is never reached from this notebook's scope
  const scopedPrivate = await retrieveKnowledge(store, { query: 'Bob Durand quittera Acme en 2027 Hooli', ...scoped() });
  const returned = JSON.stringify({ results: scopedPrivate.results, context: scopedPrivate.context });
  assert.ok(!returned.includes('Hooli'));
  assert.ok(!returned.includes('confidentielle'));
  for (const r of scopedPrivate.results) for (const c of r.citations) assert.notEqual(c.sourceId, world.src.P1.sourceId);
  assert.equal(scopedPrivate.context.egress, 'local_only', 'the context itself is marked local-only');

  const g = await KnowledgeGraphStore.createTempStore();
  const src = (n, privacy, egress) => {
    const id = g.upsertSource({ source_type: 'ARTICLE', name: n, logical_key: n, privacy, egress_policy: egress }).id;
    return { id, ref: g.upsertSourceRef({ source_id: id, adapter: 'manual', source_ref: n, privacy, egress_policy: egress }).id };
  };
  const pub = src('Journal public', 'STANDARD', 'cloud_allowed');
  const local = src('Note locale', 'STANDARD', 'local_only');
  const priv = src('Carnet secret', 'PRIVATE', 'local_only');
  const acme = resolveEntityMention(g, { label: 'Acme', type: 'ORGANIZATION', sourceRefId: pub.ref }).entityId;
  resolveEntityMention(g, { label: 'Acme', type: 'ORGANIZATION', aliases: ['Projet Ombre'], sourceRefId: priv.ref });
  const alice = resolveEntityMention(g, { label: 'Alice', type: 'PERSON', sourceRefId: pub.ref }).entityId;
  const ghost = resolveEntityMention(g, { label: 'Fantôme', type: 'PERSON', sourceRefId: priv.ref }).entityId;
  assertClaim(g, { subjectEntityId: acme, predicate: 'ceo', objectEntityId: alice, extractionMethod: 'DETERMINISTIC', evidence: [{ sourceId: pub.id, sourceRefId: pub.ref, excerpt: 'Alice dirige Acme (public)' }, { sourceId: priv.id, sourceRefId: priv.ref, excerpt: 'SECRET: Alice dirige Acme' }] });
  assertClaim(g, { subjectEntityId: acme, predicate: 'founder', objectEntityId: ghost, extractionMethod: 'DETERMINISTIC', evidence: [{ sourceId: priv.id, sourceRefId: priv.ref, excerpt: 'SECRET: Fantôme a fondé Acme' }] });
  assertClaim(g, { subjectEntityId: acme, predicate: 'website', value: { type: 'url', value: 'https://acme.example' }, extractionMethod: 'DETERMINISTIC', evidence: [{ sourceId: local.id, sourceRefId: local.ref, excerpt: 'site acme.example (note locale)' }] });

  const d = await retrieveKnowledge(g, { query: 'Acme' });
  const text = JSON.stringify({ results: d.results, context: d.context });
  for (const secret of ['SECRET', 'Carnet secret', 'Fantôme', 'Projet Ombre']) assert.ok(!text.includes(secret), `default leaks ${secret}`);
  assert.ok(ids(d, 'claim').length === 2, 'the public ceo claim + the local-only website claim');
  assert.equal(d.results.find(x => x.predicate === 'ceo').citations.length, 1, 'visible entity, private evidence not cited');
  assert.equal(d.context.egress, 'local_only');
  // a context for a cloud model drops local-only sources too
  const cloud = await retrieveKnowledge(g, { query: 'Acme', provider: 'cloud' });
  assert.ok(!JSON.stringify(cloud).includes('note locale'));
  assert.ok(cloud.results.every(r => r.egress === 'cloud_allowed'));
  assert.equal(cloud.context.egress, 'cloud_allowed');
  // explicit local opt-in sees everything
  await assert.rejects(() => retrieveKnowledge(g, { query: 'Acme', includePrivate: true }), e => e.code === 'KG_SCOPE_REQUIRED');
  await assert.rejects(() => retrieveKnowledge(g, { query: 'Acme', includePrivate: true, scope: { all: true }, provider: 'cloud' }), e => e.code === 'KG_PRIVATE_NOT_FOR_CLOUD');
  const all = await retrieveKnowledge(g, { query: 'Acme', includePrivate: true, scope: { all: true } });
  assert.ok(JSON.stringify(all).includes('Fantôme'));
  // the scope can be restricted to given sources
  const onlyPub = await retrieveKnowledge(g, { query: 'Acme', includePrivate: true, scope: { sourceIds: [pub.id] } });
  assert.ok(onlyPub.results.every(r => r.citations.every(c => c.sourceId === pub.id)));
  await assert.rejects(() => retrieveKnowledge(g, { query: 'Acme', provider: 'openai' }), e => e.code === 'KG_PROVIDER_INVALID');
  await assert.rejects(() => retrieveKnowledge(g, { query: 'Acme', scope: 'everything' }), e => e.code === 'KG_SCOPE_INVALID');
  g.close();
});

// ── citations / budget ──────────────────────────────────────────────────────

test('citations point to the original sources (Notebook document, chunk, offsets) and all resolve', async () => {
  const r = await retrieveKnowledge(store, { query: 'Où se trouve le siège du Géant de l’Enclume ?', ...scoped() });
  const hq = r.results.find(x => x.resultType === 'claim' && x.predicate === 'headquarters');
  assert.ok(hq);
  const c = hq.citations[0];
  assert.equal(c.sourceRef.adapter, 'notebook_document');
  assert.equal(world.docKey[c.sourceRef.ref], 'D7');
  assert.equal(c.locator.kind, 'CHUNK');
  assert.equal(c.locator.chunkId, world.src.D7.chunkId);
  assert.ok(Number.isInteger(c.locator.charStart));
  assert.ok(citationCorrect(world, store, c));
  for (const res of r.results) for (const cit of res.citations) assert.ok(citationCorrect(world, store, cit), JSON.stringify(cit));
  for (const cit of r.context.citations) assert.match(r.context.text, new RegExp(`\\[S${cit.n}\\]`));
});

test('context budget: strict limits, hard caps, deterministic truncation, never the whole graph', async () => {
  assert.deepEqual(resolveBudget({ maxChars: 1e9, maxDepth: 50, maxClaims: -3 }), { ...resolveBudget({}), maxChars: 20000, maxDepth: 2 });
  const big = await retrieveKnowledge(store, { query: 'Acme Globex Initech Widget Gizmo Phénix', ...scoped(), budget: { maxEntities: 3, maxClaims: 4, maxEvidences: 3, maxSnippets: 2, maxChars: 900 } });
  assert.ok(big.results.filter(r => r.resultType === 'entity').length <= 3);
  assert.ok(big.results.filter(r => r.resultType === 'claim').length <= 4);
  assert.ok(big.context.chars <= 900);
  assert.ok(big.context.counts.evidences <= 3 && big.context.counts.snippets <= 2);
  assert.ok(big.context.truncated.length > 0);
  const again = await retrieveKnowledge(store, { query: 'Acme Globex Initech Widget Gizmo Phénix', ...scoped(), budget: { maxEntities: 3, maxClaims: 4, maxEvidences: 3, maxSnippets: 2, maxChars: 900 } });
  assert.equal(again.context.text, big.context.text, 'deterministic');
  const totalClaims = store.db.prepare('SELECT COUNT(*) AS n FROM kg_claims').get().n;
  const full = await retrieveKnowledge(store, { query: 'Acme Globex Initech Widget Gizmo Phénix Nantes Alice Bob Chloé David Eva Farid', ...scoped() });
  assert.ok(full.context.counts.claims <= 20 && full.context.counts.claims < totalClaims, 'never a full-graph dump');
});

// ── failure modes / API ─────────────────────────────────────────────────────

test('failure modes: empty, enormous, hostile Unicode, invalid parameters', async () => {
  for (const q of ['', '   ', '​​', '"" ()', null, undefined, 42]) {
    const r = await retrieveKnowledge(store, { query: q, ...scoped() });
    assert.equal(r.error, 'QUERY_EMPTY', String(q));
    assert.deepEqual(r.results, []);
  }
  const huge = await retrieveKnowledge(store, { query: `Globex ${'x'.repeat(200_000)}`, ...scoped() });
  assert.equal(huge.query.truncated, true);
  assert.ok(huge.query.terms.length <= 16);
  for (const hostile of ['Glo‮bex', 'Ǵ̂̃lobex', '\uD800bad', '🚀🚀🚀 Globex 🚀', 'Globex\u0000', '%_\\*']) {
    const r = await retrieveKnowledge(store, { query: hostile, ...scoped() });
    assert.ok(Array.isArray(r.results), JSON.stringify(hostile));
  }
  await assert.rejects(() => retrieveKnowledge(store, { query: 'x', mode: 'everything' }), e => e instanceof RetrievalError && e.code === 'KG_MODE_INVALID');
});

test('API: POST /search and /retrieve are read-only queries; semantic UNAVAILABLE without a local layer; invalid bodies → 400', async () => {
  const app = createKnowledgeGraphRoute(store);
  const changes = () => store.db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const post = (p, body) => app.request(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const res = await post('/retrieve', { query: 'directeur général de Globex', includePrivate: true, scope: { notebookId: world.nb } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.semantic.state, 'UNAVAILABLE');
  assert.ok(body.context.text.length > 0);
  const search = await (await post('/search', { query: 'Globex', mode: 'exact', includePrivate: true, scope: { notebookId: world.nb } })).json();
  assert.equal(search.context.text, '', 'search returns ranked results, no assembled context');
  assert.ok(search.results.length > 0);
  for (const bad of [{}, { query: 5 }, { query: 'x', mode: 'nope' }, { query: 'x', temporal: 'now' }, { query: 'x', budget: [1] }, { query: 'x', provider: 'cloudy' }]) {
    assert.equal((await post('/retrieve', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await app.request('/retrieve', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal(changes(), before, 'nothing written');
  const withSemantic = createKnowledgeGraphRoute(store, { semantic });
  const s = await (await withSemantic.request('/retrieve', { method: 'POST', body: JSON.stringify({ query: 'automobile', includePrivate: true, scope: { notebookId: world.nb } }), headers: { 'content-type': 'application/json' } })).json();
  assert.equal(s.semantic.state, 'AVAILABLE');
});

// ── Notebook baseline / volume ──────────────────────────────────────────────

test('Notebook baseline (A) vs Notebook + KG (B) on the synthetic ground truth: recall, precision, citations, privacy, latency, context size', async () => {
  const ev = await evaluate(world, store, { k: 5, semantic });
  const m = ev.metrics;
  assert.equal(ev.citationCorrectness.rate, 1, 'every citation resolves to the original Notebook chunk');
  assert.equal(ev.privacy.privateCitations, 0, 'no private evidence leaked');
  assert.ok(m.kg_hybrid.recallAtK >= m.notebook.recallAtK);
  assert.ok(m.notebook_plus_kg.recallAtK >= m.notebook.recallAtK);
  for (const kind of ['alias', 'graph', 'contradiction']) assert.ok(m.notebook_plus_kg.perKind[kind].recall > m.notebook.perKind[kind].recall, kind);
  for (const kind of ['exact', 'temporal']) assert.ok(m.notebook_plus_kg.perKind[kind].recall >= m.notebook.perKind[kind].recall, kind);
  assert.ok(m.kg_hybrid.recallAtK >= Math.max(m.kg_exact.recallAtK, m.kg_fts.recallAtK, m.kg_semantic.recallAtK, m.kg_graph.recallAtK), 'hybrid ≥ every single signal');
  console.log(`# KG-5 baseline (k=${ev.k}, ${ev.scoredQueries} scored queries, synthetic ground truth): ${Object.entries(m).map(([name, v]) => `${name} P@5=${v.precisionAtK} R@5=${v.recallAtK} ${v.latencyMsMedian}ms`).join(' | ')}`);
  console.log(`# KG-5 citations ${ev.citationCorrectness.correct}/${ev.citationCorrectness.total}; private leaks ${ev.privacy.privateCitations}; context chars median ${ev.contextChars.median} max ${ev.contextChars.max}`);
});

test('volume: 1 000 entities, 5 000+ claims, relations — FTS, semantic, graph expansion, hybrid and context assembly measured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg5-vol-'));
  const g = await KnowledgeGraphStore.createTestStore(path.join(dir, 'vol.db'));
  const src = Array.from({ length: 20 }, (_, i) => g.upsertSource({ source_type: 'ARTICLE', name: `Source ${i}`, logical_key: `vol:${i}`, privacy: 'STANDARD', egress_policy: 'cloud_allowed' }).id);
  const t0 = performance.now();
  const orgs = [];
  const people = [];
  g.transaction(() => {
    for (let i = 0; i < 400; i++) orgs.push(g.upsertEntity({ entity_type: 'ORGANIZATION', name: `Société ${i} ${['Alpha', 'Beta', 'Gamma', 'Delta'][i % 4]}` }).id);
    for (let i = 0; i < 600; i++) people.push(g.upsertEntity({ entity_type: 'PERSON', name: `Personne ${i} ${['Martin', 'Durand', 'Petit'][i % 3]}` }).id);
  });
  let claims = 0;
  for (let i = 0; i < 400; i++) {
    const ev = (k) => [{ sourceId: src[(i + k) % 20], excerpt: `Société ${i} fait ${k}` }];
    g.transaction(() => {
      for (let k = 0; k < 4; k++) assertClaim(g, { subjectEntityId: orgs[i], predicate: 'ceo', objectEntityId: people[(i * 4 + k) % 600], validFrom: `${2000 + k * 5}`, validTo: `${2005 + k * 5}`, extractionMethod: 'DETERMINISTIC', evidence: ev(k) });
      for (let k = 0; k < 6; k++) assertClaim(g, { subjectEntityId: orgs[i], predicate: 'founder', objectEntityId: people[(i * 7 + k) % 600], extractionMethod: 'DETERMINISTIC', evidence: ev(10 + k) });
      assertClaim(g, { subjectEntityId: orgs[i], predicate: 'founded_on', value: { type: 'date', value: `${1950 + (i % 70)}` }, extractionMethod: 'DETERMINISTIC', evidence: ev(20) });
      assertClaim(g, { subjectEntityId: orgs[i], predicate: 'ceo', objectEntityId: people[(i + 300) % 600], extractionMethod: 'DETERMINISTIC', evidence: ev(21) });
      assertClaim(g, { subjectEntityId: orgs[i], predicate: 'website', value: { type: 'url', value: `https://societe-${i}.example` }, extractionMethod: 'DETERMINISTIC', evidence: ev(22) });
      g.upsertRelationship({ source_entity_id: orgs[i], target_entity_id: orgs[(i + 1) % 400], relationship_type: 'RELATED_TO', source_id: src[i % 20] });
    });
    claims += 13;
  }
  const buildMs = performance.now() - t0;
  assert.ok(claims >= 5000);
  const sem = new KgSemanticIndex({ lancedbPath: path.join(dir, 'vol.lance'), embedder: fakeLocalEmbedder() });
  const ts = performance.now();
  const rebuilt = await sem.rebuild(g);
  const semIndexMs = performance.now() - ts;
  const median = async (fn, n = 15) => { const xs = []; for (let i = 0; i < n; i++) { const t = performance.now(); await fn(i); xs.push(performance.now() - t); } xs.sort((a, b) => a - b); return xs[Math.floor(n / 2)]; };
  const SUF = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const orgName = (n) => `Société ${n % 400} ${SUF[(n % 400) % 4]}`;
  const fts = await median(i => retrieveKnowledge(g, { query: orgName(i * 7), mode: 'fts' }));
  const semantic0 = await median(i => retrieveKnowledge(g, { query: `Personne ${i * 11} Martin`, mode: 'semantic', semantic: sem }));
  const graph = await median(i => retrieveKnowledge(g, { query: orgName(i * 13), mode: 'graph', budget: { maxDepth: 2 } }));
  const hybrid = await median(i => retrieveKnowledge(g, { query: `Qui dirigeait ${orgName(i * 17)} en 2012 ?`, semantic: sem }));
  const noCtx = await median(i => retrieveKnowledge(g, { query: `Qui dirigeait ${orgName(i * 17)} en 2012 ?`, semantic: sem, assembleContext: false }));
  const graphSample = await retrieveKnowledge(g, { query: orgName(34), mode: 'graph', budget: { maxDepth: 2 } });
  assert.ok(graphSample.results.length > 0 && graphSample.stats.graph.nodes > 1, 'graph expansion really happens');
  const sample = await retrieveKnowledge(g, { query: `Qui dirigeait ${orgName(34)} en 2012 ?`, semantic: sem });
  assert.ok(sample.results.some(r => r.resultType === 'claim' && r.predicate === 'ceo'));
  assert.ok(sample.context.chars <= 6000);
  console.log(`# KG-5 volume: 1000 entities, ${claims} claims, ${claims} evidences, 400 relations, ${g.getStatistics().conflicts.total} conflicts — build ${(buildMs / 1000).toFixed(1)} s, semantic index ${rebuilt.indexed} items in ${semIndexMs.toFixed(0)} ms; `
    + `median latency: FTS ${fts.toFixed(1)} ms, semantic ${semantic0.toFixed(1)} ms, graph (depth 2) ${graph.toFixed(1)} ms, hybrid ${hybrid.toFixed(1)} ms (context assembly ≈ ${(hybrid - noCtx).toFixed(1)} ms), context ${sample.context.chars} chars`);
  await sem.close();
  g.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
