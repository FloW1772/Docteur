// [Knowledge Graph V1] KG-6 — unit tests of the pure graph view model (Node type stripping).
// Usage: node --test scripts/test-kg-graph-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGraph, mergeNeighborhood, recenter, nearestInDirection, fitTransform, zoomAt, clampZoom, centerOn, radialLayout,
  describeNode, describeEdge, timelineBars, MAX_RENDERED_NODES, MAX_RENDERED_EDGES, RING,
} from '../src/lib/kg/graph-model.ts';

const node = (id, label = id, extra = {}) => ({ id, label, type: 'CONCEPT', status: 'ACTIVE', ambiguous: false, memberCount: 1, depth: 1, shownEdges: 1, hiddenEdges: 0, ...extra });
const edge = (a, b, extra = {}) => ({ id: `rel:${a}-${b}`, kind: 'relationship', source: a, target: b, label: 'RELATED_TO', status: 'RELATION', ...extra });
const nb = (center, nodes, edges) => ({ center, nodes, edges, limits: {}, limitsHit: [], visibility: {} });

test('radial layout: centre at the origin, one ring per distance, deterministic', () => {
  const n = nb('c', [node('c', 'C', { depth: 0 }), node('a', 'A'), node('b', 'B'), node('d', 'D', { depth: 2 })], [edge('c', 'a'), edge('c', 'b'), edge('a', 'd')]);
  const g1 = createGraph(n);
  const g2 = createGraph(n);
  assert.deepEqual([...g1.nodes.values()].map(x => [x.id, x.x, x.y]), [...g2.nodes.values()].map(x => [x.id, x.x, x.y]));
  assert.deepEqual([g1.nodes.get('c').x, g1.nodes.get('c').y], [0, 0]);
  assert.equal(Math.round(Math.hypot(g1.nodes.get('a').x, g1.nodes.get('a').y)), RING);
  assert.equal(Math.round(Math.hypot(g1.nodes.get('d').x, g1.nodes.get('d').y)), RING * 2);
});

test('cycles: layout terminates and places each node once', () => {
  const pos = radialLayout(new Map([['a', node('a')], ['b', node('b')], ['c', node('c')]]), new Map([['1', edge('a', 'b')], ['2', edge('b', 'c')], ['3', edge('c', 'a')]]), 'a');
  assert.equal(pos.size, 3);
});

test('progressive expansion: existing nodes do not move, new nodes fan out around the anchor, duplicates ignored', () => {
  const g = createGraph(nb('c', [node('c', 'C', { depth: 0 }), node('a', 'A', { hiddenEdges: 3 })], [edge('c', 'a')]));
  const before = { ...g.nodes.get('a') };
  const r = mergeNeighborhood(g, nb('a', [node('a', 'A', { hiddenEdges: 0 }), node('x'), node('y'), node('c', 'C')], [edge('a', 'x'), edge('a', 'y'), edge('c', 'a')]), 'a');
  assert.equal(r.refused, null);
  assert.equal(r.addedNodes, 2);
  assert.equal(r.addedEdges, 2);
  assert.deepEqual([r.state.nodes.get('a').x, r.state.nodes.get('a').y], [before.x, before.y]);
  assert.equal(r.state.nodes.get('a').expanded, true);
  assert.equal(r.state.nodes.get('a').hiddenEdges, 0);
  for (const id of ['x', 'y']) assert.ok(Math.hypot(r.state.nodes.get(id).x - before.x, r.state.nodes.get(id).y - before.y) >= 140);
  assert.equal(mergeNeighborhood(r.state, nb('a', [node('a'), node('x')], [edge('a', 'x')]), 'a').addedNodes, 0);
  // paging: the anchor remembers where its next slice starts
  assert.equal(r.state.nodes.get('a').nextOffset, 1);
  const paged = mergeNeighborhood(r.state, nb('a', [node('a', 'A', { shownEdges: 2, offset: 1 }), node('z')], [edge('a', 'z')]), 'a');
  assert.equal(paged.state.nodes.get('a').nextOffset, 3);
  assert.equal(createGraph(nb('c', [node('c', 'C', { depth: 0, shownEdges: 4 })], [])).nodes.get('c').nextOffset, 4);
});

test('render bounds: an expansion that would exceed the node cap is refused whole; edges capped', () => {
  const many = Array.from({ length: MAX_RENDERED_NODES - 1 }, (_, i) => node(`n${i}`));
  const g = createGraph(nb('c', [node('c', 'C', { depth: 0 }), ...many], many.map(n => edge('c', n.id))));
  assert.equal(g.nodes.size, MAX_RENDERED_NODES);
  const r = mergeNeighborhood(g, nb('n0', [node('n0'), node('extra')], [edge('n0', 'extra')]), 'n0');
  assert.equal(r.refused, 'NODE_LIMIT');
  assert.equal(r.state.nodes.size, MAX_RENDERED_NODES);
  const huge = createGraph(nb('c', [node('c', 'C', { depth: 0 }), ...Array.from({ length: 1000 }, (_, i) => node(`z${i}`))], Array.from({ length: 1000 }, (_, i) => edge('c', `z${i}`))));
  assert.ok(huge.nodes.size <= MAX_RENDERED_NODES && huge.edges.size <= MAX_RENDERED_EDGES);
});

test('recentre and keyboard navigation by direction', () => {
  const g = createGraph(nb('c', [node('c', 'C', { depth: 0 }), node('a', 'A'), node('b', 'B'), node('d', 'D'), node('e', 'E')], [edge('c', 'a'), edge('c', 'b'), edge('c', 'd'), edge('c', 'e')]));
  const r = recenter(g, 'a');
  assert.deepEqual([r.nodes.get('a').x, r.nodes.get('a').y], [0, 0]);
  assert.equal(r.centerId, 'a');
  const up = nearestInDirection(g, 'c', 'up');
  assert.ok(up && g.nodes.get(up).y < 0);
  const down = nearestInDirection(g, 'c', 'down');
  assert.ok(down && g.nodes.get(down).y > 0);
  assert.equal(nearestInDirection(g, 'missing', 'up'), null);
});

test('zoom / pan / fit', () => {
  assert.equal(clampZoom(10), 3);
  assert.equal(clampZoom(0.01), 0.2);
  const t = zoomAt({ x: 0, y: 0, k: 1 }, 2, 100, 100);
  assert.deepEqual(t, { k: 2, x: -100, y: -100 }, 'the point under the cursor stays fixed');
  const g = createGraph(nb('c', [node('c', 'C', { depth: 0 }), node('a', 'A')], [edge('c', 'a')]));
  const fit = fitTransform(g, 800, 600);
  assert.ok(fit.k > 0.2 && fit.k <= 1.4);
  assert.deepEqual(centerOn({ x: 0, y: 0, k: 1 }, { x: 50, y: 20 }, 800, 600), { k: 1, x: 350, y: 280 });
});

test('ARIA descriptions say ambiguity, hidden edges, contradictions and dates', () => {
  const n = { ...node('a', 'Apple', { type: 'ORGANIZATION', ambiguous: true, shownEdges: 2, hiddenEdges: 5 }), x: 0, y: 0, expanded: false };
  assert.equal(describeNode(n), 'Apple, organisation, entité ambiguë, 2 relations affichées, 5 non chargées (développer)');
  const nodes = new Map([['a', n], ['b', { ...node('b', 'Bob'), x: 0, y: 0, expanded: false }]]);
  assert.equal(describeEdge(edge('a', 'b', { label: 'ceo', status: 'DISPUTED', validFrom: '2015-07-01', contradiction: { status: 'OPEN_CONFLICT', conflictIds: [], counterpartClaimIds: ['x'] } }), nodes),
    'Apple — ceo — Bob, contesté, du 2015-07-01 au …, contradiction ouverte');
});

test('timeline: dated claims only, open-ended to now, packed lanes, dense overflow counted', () => {
  const c = (id, from, to, status = 'SUPPORTED') => ({ claimId: id, subject: { entityId: 's', label: 'S' }, predicate: 'ceo', object: { kind: 'entity', entityId: id, label: id }, status, extractionMethod: null, validFrom: from, validTo: to, observedAt: null, temporalState: 'PAST', contradiction: null, supersededBy: null });
  const t = timelineBars([c('a', '2010-01-01', '2015-07-01'), c('b', '2015-07-01', null), c('u', null, null)], 1000, '2026-10-08');
  assert.equal(t.bars.length, 2, 'undated claim never placed on a date');
  assert.equal(t.bars[0].x, 0);
  assert.equal(t.bars[1].open, true);
  assert.ok(Math.abs(t.bars[1].x + t.bars[1].width - 1000) < 1e-6);
  assert.equal(t.bars[0].lane, t.bars[1].lane, 'consecutive periods share a lane');
  const dense = timelineBars(Array.from({ length: 40 }, (_, i) => c(`d${i}`, '2000-01-01', '2001-01-01')), 1000, '2026-10-08', 8);
  assert.equal(dense.bars.length, 8);
  assert.equal(dense.overflow, 32);
});
