// KG-CERT privacy sweep helper (temporary databases only): every id of a world
// through every remaining read surface — HTTP /search, /retrieve, /view/* and
// the consumer API — in one visibility context; returns the concatenated
// answers so a test can count markers / ids that the context may not see.
import { createKnowledgeGraphRoute } from '../src/routes/kg.js';
import { createKnowledgeGraphApi, KNOWLEDGE_GRAPH_API_VERSION } from '../src/lib/kg-consumer-api.js';

const all = (store, sql) => store.prepare(sql).all().map(r => Object.values(r)[0]);

export async function sweepHttp(store, vis, queries, { now = '2026-10-12' } = {}) {
  const app = createKnowledgeGraphRoute(store);
  const calls = [];
  for (const id of all(store, 'SELECT entity_id FROM kg_entities')) {
    calls.push(['/view/entity', { entityId: id }], ['/view/neighborhood', { entityId: id, depth: 2 }], ['/view/timeline', { entityId: id }]);
  }
  for (const id of all(store, 'SELECT claim_id FROM kg_claims')) calls.push(['/view/claim', { claimId: id }]);
  for (const id of all(store, 'SELECT relationship_id FROM kg_relationships')) calls.push(['/view/relation', { relationshipId: id }]);
  for (const id of all(store, 'SELECT source_id FROM kg_sources')) calls.push(['/view/source', { sourceId: id }]);
  for (const id of all(store, 'SELECT evidence_id FROM kg_evidence')) calls.push(['/view/citation', { evidenceId: id }]);
  for (const q of queries) for (const mode of ['hybrid', 'exact', 'fts', 'graph']) calls.push(['/search', { query: q, mode }], ['/retrieve', { query: q, mode }]);
  let text = '';
  const statuses = {};
  for (const [p, body] of calls) {
    const res = await app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...vis, now }) });
    const t = await res.text();
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    // a search answer echoes the query (the caller's own data): only results / context count
    if (res.status === 200) text += p === '/search' || p === '/retrieve' ? JSON.stringify((({ results, context }) => ({ results, context }))(JSON.parse(t))) : t;
  }
  return { text, calls: calls.length, statuses };
}

/** The consumer API (investigator / companion profiles allow private data with an explicit scope). */
export async function sweepConsumer(store, consumer, context, queries) {
  const client = createKnowledgeGraphApi(store, { today: () => '2026-10-12' }).forConsumer(consumer);
  const req = (params) => ({ apiVersion: KNOWLEDGE_GRAPH_API_VERSION, context, params });
  let text = '';
  let calls = 0;
  const run = async (op, params) => {
    if (!client[op]) return;
    calls++;
    const r = await client[op](req(params));
    text += JSON.stringify(r.items) + JSON.stringify(r.context ?? '') + JSON.stringify(r.claim ?? '');
  };
  for (const id of all(store, 'SELECT entity_id FROM kg_entities')) {
    await run('getEntity', { entityId: id });
    await run('getClaims', { entityId: id, includeHistory: true });
    await run('getNeighborhood', { entityId: id });
    await run('getTimeline', { entityId: id });
    await run('getContradictions', { entityId: id });
  }
  for (const id of all(store, 'SELECT claim_id FROM kg_claims')) await run('getEvidence', { claimId: id, includeInactive: true });
  for (const q of queries) { await run('searchKnowledge', { query: q }); await run('retrieveKnowledge', { query: q }); }
  return { text, calls };
}

export const countMarkers = (text, markers) => markers.reduce((n, m) => n + text.split(m).length - 1, 0);
