// Knowledge Graph V1 — KG-8 external consumer adapters (read-only).
//
// Thin adapters over a consumer client (createKnowledgeGraphApi().forConsumer):
// they translate the versioned KG contract into the shapes the existing
// product modules already consume, WITHOUT modifying those modules:
//
//   • Professor: concept → prerequisites / parts / related concepts + sources
//     (pedagogical reading of REQUIRES / DEPENDS_ON / PRECEDES / PART_OF …);
//   • Agency: the `searchKnowledge(query, { limit })` dependency of
//     createAgencyService → [{ id, title, excerpt }] — the same shape as the
//     neuron-backed search. It returns data only: the Agency tool catalogue,
//     approvals and Root Policy stay the only authorities.
//
// Investigator / Companion / Code Intelligence have a contract (profiles in
// kg-consumer-api.js) but no adapter: those products are not started here.

import { KNOWLEDGE_GRAPH_API_VERSION, KgApiError } from './kg-consumer-api.js';

const PREREQUISITE_OUT = new Set(['REQUIRES', 'DEPENDS_ON']);   // concept —REQUIRES→ X : X is a prerequisite
const PREREQUISITE_IN = new Set(['REQUIRED_BY', 'PRECEDES']);    // X —REQUIRED_BY / PRECEDES→ concept : X is a prerequisite
const PART_TYPES = new Set(['PART_OF', 'HAS_PART', 'CONTAINS', 'CONTAINED_IN', 'SUBTYPE_OF', 'INSTANCE_OF']);

function requireClient(client, consumer) {
  if (!client || client.consumer !== consumer || client.apiVersion !== KNOWLEDGE_GRAPH_API_VERSION) {
    throw new KgApiError('KG_CONSUMER_MISMATCH', `this adapter needs a ${consumer} client of apiVersion ${KNOWLEDGE_GRAPH_API_VERSION}`);
  }
}

function requireContext(context) {
  if (!context || typeof context !== 'object') throw new KgApiError('KG_PRIVACY_CONTEXT_REQUIRED', 'the adapter is created with an explicit context { scope, includePrivate, provider }');
  return context;
}

const sourcesOf = (items) => {
  const out = [];
  for (const i of items) for (const c of i.citations ?? []) if (!out.some(s => s.id === c.source.id)) out.push({ id: c.source.id, label: c.source.label, sourceType: c.source.sourceType });
  return out;
};

/**
 * Professor: pedagogical reading of a concept. Read-only; nothing is written
 * to the KG or to the Professor stores.
 */
export function createProfessorKnowledgeAdapter(client, { context } = {}) {
  requireClient(client, 'professor');
  const ctx = requireContext(context);
  const call = (op, params, bounds) => client[op]({ apiVersion: KNOWLEDGE_GRAPH_API_VERSION, context: ctx, ...(bounds ? { bounds } : {}), params });
  return Object.freeze({
    async conceptContext(concept, { maxNeighbours = 40 } = {}) {
      const found = await call('searchKnowledge', { query: concept, mode: 'exact', types: ['entity'] }, { maxResults: 5 });
      const entity = found.items.find(i => i.entityType === 'CONCEPT') ?? found.items[0] ?? null;
      if (!entity) return { apiVersion: KNOWLEDGE_GRAPH_API_VERSION, concept: null, prerequisites: [], parts: [], related: [], sources: [], complete: found.complete };
      const hood = await call('getNeighborhood', { entityId: entity.id }, { maxDepth: 1, maxEdges: Math.min(maxNeighbours, 120), maxNodes: Math.min(maxNeighbours + 1, 60) });
      const label = new Map(hood.items.filter(i => i.type === 'entity').map(i => [i.id, i]));
      const prerequisites = [];
      const parts = [];
      const related = [];
      for (const edge of hood.items.filter(i => i.type === 'relation')) {
        const otherId = edge.from === entity.id ? edge.to : edge.from;
        const other = label.get(otherId);
        if (!other) continue;
        const entry = { id: otherId, label: other.label, entityType: other.entityType, via: edge.label, relationKind: edge.relationKind, citations: edge.citations };
        if ((edge.from === entity.id && PREREQUISITE_OUT.has(edge.label)) || (edge.to === entity.id && PREREQUISITE_IN.has(edge.label))) prerequisites.push(entry);
        else if (PART_TYPES.has(edge.label)) parts.push(entry);
        else related.push(entry);
      }
      return {
        apiVersion: KNOWLEDGE_GRAPH_API_VERSION,
        concept: { id: entity.id, label: entity.label, entityType: entity.entityType, ambiguous: entity.ambiguous },
        prerequisites, parts, related,
        sources: sourcesOf([entity, ...hood.items]),
        complete: found.complete && hood.complete,
      };
    },
  });
}

/**
 * Agency: drop-in `searchKnowledge` dependency for createAgencyService (same
 * output shape as createKnowledgeSearch). Context only — never an action.
 */
export function createAgencyKnowledgeSearch(client, { context } = {}) {
  requireClient(client, 'agency');
  const ctx = requireContext(context);
  return async (query, { limit } = {}) => {
    const maxResults = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 5, client.profile.caps.maxResults));
    const r = await client.searchKnowledge({ apiVersion: KNOWLEDGE_GRAPH_API_VERSION, context: ctx, bounds: { maxResults }, params: { query } });
    return r.items.map(i => ({
      id: i.id,
      title: String(i.label ?? '').slice(0, 200),
      excerpt: [i.label, ...(i.citations ?? []).map(c => c.excerpt).filter(Boolean)].join(' — ').slice(0, 800),
    }));
  };
}

export default { createProfessorKnowledgeAdapter, createAgencyKnowledgeSearch };
