// Knowledge Graph V1 — KG-6 read-only view API (graph UI backend): bounded
// neighbourhood, progressive expansion, filters, details, timeline, privacy,
// contradictions, ambiguity. Temporary databases only.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeGraphStore } from './src/lib/kg-store.js';
import { viewNeighborhood, viewEntity, viewClaim, viewRelation, viewTimeline, VIEW_LIMITS } from './src/lib/kg-view.js';
import { createKnowledgeGraphRoute } from './src/routes/kg.js';
import { buildGraphWorld } from './fixtures/kg6-graph-world.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg6-'));
let store;
let w;
before(async () => {
  store = await KnowledgeGraphStore.createTestStore(path.join(TMP, 'kg6.db'));
  w = await buildGraphWorld(store);
});
after(() => { store?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const nodeIds = (v) => v.nodes.map(n => n.id);
const edgeOf = (v, claimId) => v.edges.find(e => e.claimId === claimId);
const NOW = '2026-10-08';
const ALL = { all: true };

test('initial neighbourhood is bounded (depth 1, ≤ 60 nodes, ≤ 120 edges) even on a 1 200-node network', () => {
  assert.ok(store.getStatistics().entities.total > 2000);
  const v = viewNeighborhood(store, { entityId: w.entities.network0 });
  assert.equal(v.limits.depth, 1);
  assert.ok(v.nodes.length <= 60 && v.edges.length <= 120);
  assert.ok(v.nodes.every(n => n.depth <= 1));
  const capped = viewNeighborhood(store, { entityId: w.entities.network0, depth: 9, maxNodes: 9999, maxEdges: 9999, fanout: 9999 });
  assert.deepEqual(capped.limits, { depth: VIEW_LIMITS.depth.max, maxNodes: VIEW_LIMITS.maxNodes.max, maxEdges: VIEW_LIMITS.maxEdges.max, fanout: VIEW_LIMITS.fanout.max, offset: 0 });
  assert.ok(capped.nodes.length <= 150 && capped.edges.length <= 300 + VIEW_LIMITS.contradictionReserve);
  assert.ok(capped.limitsHit.includes('max_nodes') || capped.limitsHit.includes('max_depth'));
});

test('high fan-out: the hub shows a bounded slice and reports what was not sent; expansion is manual and progressive', () => {
  const v = viewNeighborhood(store, { entityId: w.entities.hub });
  const hub = v.nodes.find(n => n.id === w.entities.hub);
  assert.equal(hub.shownEdges, VIEW_LIMITS.fanout.default);
  assert.equal(hub.hiddenEdges, 800 - VIEW_LIMITS.fanout.default);
  assert.ok(v.limitsHit.includes('fanout'));
  // paging: the next slice is different and the hidden count goes down
  const page2 = viewNeighborhood(store, { entityId: w.entities.hub, offset: hub.shownEdges });
  const hub2 = page2.nodes.find(n => n.id === w.entities.hub);
  assert.equal(hub2.hiddenEdges, 800 - 2 * VIEW_LIMITS.fanout.default);
  const first = new Set(v.nodes.map(n => n.id));
  assert.ok(page2.nodes.filter(n => n.id !== w.entities.hub).every(n => !first.has(n.id)), 'a new slice');
  const spoke = v.nodes.find(n => n.id !== w.entities.hub);
  const exp = viewNeighborhood(store, { entityId: spoke.id });
  assert.ok(nodeIds(exp).includes(w.entities.hub), 'expanding a spoke reaches the hub back');
  assert.ok(exp.nodes.length <= 60);
});

test('cycles: every node and edge once', () => {
  const v = viewNeighborhood(store, { entityId: w.entities.ca, depth: 2 });
  assert.deepEqual(new Set(nodeIds(v)), new Set([w.entities.ca, w.entities.cb, w.entities.cc]));
  assert.equal(v.edges.length, 3);
  assert.equal(new Set(v.edges.map(e => e.id)).size, 3);
});

test('contradictions: both sides always shown (even with maxEdges = 1) and both detailed with their evidence', () => {
  const v = viewNeighborhood(store, { entityId: w.entities.globex, maxEdges: 1 });
  const chloe = edgeOf(v, w.claims.chloeCeo);
  const david = edgeOf(v, w.claims.davidCeo);
  assert.ok(chloe && david, 'both sides');
  assert.equal(chloe.contradiction.status, 'OPEN_CONFLICT');
  assert.deepEqual(chloe.contradiction.counterpartClaimIds, [w.claims.davidCeo]);
  assert.ok(nodeIds(v).includes(w.entities.chloe) && nodeIds(v).includes(w.entities.david));
  const details = viewClaim(store, { claimId: w.claims.chloeCeo });
  assert.equal(details.claim.status, 'DISPUTED');
  assert.equal(details.contradictions.length, 1);
  assert.equal(details.contradictions[0].otherClaim.object.label, 'David Roux');
  assert.equal(details.contradictions[0].otherEvidence.length, 1, 'the other side comes with its own evidence');
});

test('ambiguous entities stay explicitly ambiguous, with their candidates', () => {
  const v = viewNeighborhood(store, { entityId: w.entities.appleAmb });
  assert.equal(v.nodes[0].ambiguous, true);
  const e = viewEntity(store, { entityId: w.entities.appleAmb });
  assert.equal(e.entity.status, 'AMBIGUOUS');
  assert.deepEqual(new Set(e.ambiguity.candidates.map(c => c.entityId)), new Set([w.entities.appleInc, w.entities.appleRec]));
});

test('privacy: nothing private without includePrivate; with it, explicitly marked; not visible = 404', async () => {
  assert.equal(viewNeighborhood(store, { entityId: w.entities.shadow }), null, 'private-only entity invisible');
  assert.equal(viewEntity(store, { entityId: w.entities.shadow }), null);
  assert.equal(viewClaim(store, { claimId: w.claims.shadow }), null);
  const acme = viewNeighborhood(store, { entityId: w.entities.acme });
  assert.ok(!nodeIds(acme).includes(w.entities.shadow), 'no edge through a private relation');
  const e = viewEntity(store, { entityId: w.entities.acme });
  assert.ok(!e.aliases.some(a => a.alias === 'Code Noir'), 'private alias hidden');
  assert.ok(!JSON.stringify(e).includes('Carnet confidentiel'));
  const bob = viewClaim(store, { claimId: w.claims.bobCeo });
  assert.equal(bob.evidence.length, 1, 'only the public evidence');
  assert.ok(!JSON.stringify(bob).includes('Note interne'));
  // KG-7: includePrivate alone is refused — an explicit scope is required
  assert.throws(() => viewEntity(store, { entityId: w.entities.acme, includePrivate: true }), e => e.code === 'KG_SCOPE_REQUIRED');
  const withPrivate = viewEntity(store, { entityId: w.entities.acme, includePrivate: true, scope: ALL });
  assert.ok(withPrivate.aliases.some(a => a.alias === 'Code Noir'));
  assert.ok(viewNeighborhood(store, { entityId: w.entities.acme, includePrivate: true, scope: ALL }).nodes.some(n => n.id === w.entities.shadow));
  assert.equal(viewClaim(store, { claimId: w.claims.bobCeo, includePrivate: true, scope: ALL }).evidence.length, 2);
  // cloud provider: private data is never assembled for it; local-only sources excluded
  assert.throws(() => viewClaim(store, { claimId: w.claims.bobCeo, includePrivate: true, scope: ALL, provider: 'cloud' }), e => e.code === 'KG_PRIVATE_NOT_FOR_CLOUD');
  assert.equal(viewClaim(store, { claimId: w.claims.bobCeo, provider: 'cloud' }).evidence.length, 1);
  // the route answers 404 identically for "absent" and "filtered"
  const app = createKnowledgeGraphRoute(store);
  const post = (p, body) => app.request(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  assert.equal((await post('/view/entity', { entityId: w.entities.shadow })).status, 404);
  assert.equal((await post('/view/entity', { entityId: 'ent_does_not_exist' })).status, 404);
});

test('filters: entity type, claim status, source, validity window', () => {
  const types = viewNeighborhood(store, { entityId: w.entities.acme, filters: { entityTypes: ['PERSON'] } });
  assert.ok(types.nodes.filter(n => n.id !== w.entities.acme).every(n => n.type === 'PERSON'));
  assert.ok(nodeIds(types).includes(w.entities.alice) && !nodeIds(types).includes(w.entities.nantes));
  const disputed = viewNeighborhood(store, { entityId: w.entities.globex, filters: { statuses: ['DISPUTED'] } });
  assert.ok(disputed.edges.filter(e => e.kind === 'claim').every(e => e.status === 'DISPUTED'));
  const all = viewNeighborhood(store, { entityId: w.entities.acme });
  assert.deepEqual(new Set(all.sources.map(s => s.name)), new Set(['Journal économique', 'Registre des sociétés']), 'visible sources of the shown edges (no private one)');
  assert.ok(viewNeighborhood(store, { entityId: w.entities.acme, includePrivate: true, scope: ALL }).sources.some(s => s.name === 'Carnet confidentiel'));
  const bySource = viewNeighborhood(store, { entityId: w.entities.acme, filters: { sourceIds: [w.sources.pub2.sourceId] } });
  assert.ok(edgeOf(bySource, w.claims.bobCeo) && edgeOf(bySource, w.claims.hq));
  assert.ok(!edgeOf(bySource, w.claims.aliceCeo), 'Alice is only in the other source');
  const window = viewNeighborhood(store, { entityId: w.entities.acme, filters: { from: '2011-01-01', to: '2012-01-01', includeUndated: false } });
  assert.ok(edgeOf(window, w.claims.aliceCeo) && !edgeOf(window, w.claims.bobCeo) && !edgeOf(window, w.claims.hq));
  for (const bad of [{ entityTypes: ['ROBOT'] }, { statuses: 'ALL' }, { from: 'hier' }, { from: '2020', to: '2010' }, []]) {
    assert.throws(() => viewNeighborhood(store, { entityId: w.entities.acme, filters: bad }), e => e.code === 'KG_FILTERS_INVALID', JSON.stringify(bad));
  }
});

test('details: entity, claim (evidence + provenance + locator), relation (descriptive, provenance)', () => {
  const e = viewEntity(store, { entityId: w.entities.acme, now: NOW });
  assert.equal(e.entity.label, 'Acme Industries');
  assert.ok(e.identifiers.some(i => i.scheme === 'domain' && i.value === 'acme.example'));
  assert.ok(e.claims.live.some(c => c.predicate === 'ceo' && c.object.label === 'Bob Durand' && c.temporalState === 'CURRENT'));
  assert.ok(e.claims.live.some(c => c.object.label === 'Alice Martin' && c.temporalState === 'PAST'));
  assert.ok(e.provenance.length >= 1);
  const c = viewClaim(store, { claimId: w.claims.aliceCeo });
  assert.equal(c.evidence[0].locator.page, 3);
  assert.equal(c.evidence[0].source.name, 'Journal économique');
  assert.ok(c.evidence[0].sourceRef?.adapter);
  const r = viewRelation(store, { relationshipId: w.relations.widgetMaker });
  assert.equal(r.relation.type, 'CREATED_BY');
  assert.equal(r.provenance.sourceName, 'Journal économique');
  assert.match(r.note, /never grants a permission/);
});

test('timeline: dense history aggregated by year, undated claims counted apart (no invented date), superseded kept', () => {
  const t = viewTimeline(store, { entityId: w.entities.chronos, now: NOW });
  assert.equal(t.totalDated, 151);
  assert.equal(t.items.length, VIEW_LIMITS.timelineItems > 151 ? 151 : VIEW_LIMITS.timelineItems);
  assert.ok(t.buckets.length >= 150 && t.buckets.every(b => /^\d{4}$/.test(b.year)));
  assert.equal(t.undatedCount, 0);
  assert.deepEqual([t.range.min, t.range.max], ['1900-01-01', '2050-01-01']);
  const g = viewTimeline(store, { entityId: w.entities.globex });
  assert.equal(g.totalDated, 0);
  assert.equal(g.undatedCount, 2, 'the two undated CEO claims are not placed on a date');
});

test('API is read-only and the neighbourhood of a 1 000+ node graph stays fast', async () => {
  const app = createKnowledgeGraphRoute(store);
  const changes = () => store.db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const post = (p, body) => app.request(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const r = await post('/view/neighborhood', { entityId: w.network[i * 37] });
    times.push(performance.now() - t);
    assert.equal(r.status, 200);
  }
  for (const p of ['/view/entity', '/view/timeline']) assert.equal((await post(p, { entityId: w.entities.acme })).status, 200);
  assert.equal((await post('/view/claim', { claimId: w.claims.hq })).status, 200);
  assert.equal((await post('/view/relation', { relationshipId: w.relations.widgetMaker })).status, 200);
  assert.equal((await post('/view/neighborhood', { entityId: w.entities.acme, filters: { entityTypes: ['ROBOT'] } })).status, 400);
  assert.equal((await post('/view/neighborhood', [])).status, 400);
  assert.equal(changes(), before, 'nothing written');
  times.sort((a, b) => a - b);
  console.log(`# KG-6 view API: neighbourhood median ${times[10].toFixed(1)} ms, max ${times[19].toFixed(1)} ms on ${store.getStatistics().entities.total} entities / ${store.getStatistics().relationships.total} relations`);
});
