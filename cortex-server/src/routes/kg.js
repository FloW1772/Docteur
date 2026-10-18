// Knowledge Graph V1 — HTTP API (read-only).
//
// KG-7 pre-gate: ONE read stack. Every data-returning route goes through the
// KG-5 visibility context (includePrivate + provider + scope): private sources
// are invisible by default; a private item needs an explicit includePrivate AND
// an explicit scope ({ notebookId } | { sourceIds } | { all: true }, local only);
// a Notebook scope never reaches another notebook. "Not visible" and "absent"
// answer the same 404, so nothing private can be enumerated.
//
// The KG-2 / KG-3 / KG-4 raw read routes (entities, aliases, sources, claims,
// evidence, neighbours, subgraph, identifiers, refs, resolutions, statistics,
// verify, explain, valid-at, conflicts) returned unfiltered rows. They are
// removed: 410 KG_ROUTE_REMOVED with the safe replacement, whatever the id
// (no existence signal). Store methods remain for tests / tooling only.
//
// Nothing here writes. A relation never grants a permission.

import { Hono } from 'hono';
import { KG_DEFAULT_LIMITS, KG_ENTITY_TYPES, KG_SOURCE_TYPES, KG_CLAIM_TYPES, KG_EVIDENCE_TYPES, KG_RELATIONSHIP_TYPES, getSchemaVersion } from '../lib/kg-schema.js';
import { retrieveKnowledge, RETRIEVAL_MODES } from '../lib/kg-retrieval.js';
import { viewNeighborhood, viewEntity, viewClaim, viewRelation, viewTimeline, viewSource, viewCitation } from '../lib/kg-view.js';
import { verifyOpenTarget } from '../lib/kg-integration.js';

/** Removed raw routes → their safe replacement (documented in the 410 answer). */
export const KG_REMOVED_ROUTES = Object.freeze([
  ['/statistics', 'none (store tooling only)'],
  ['/verify', 'none (store tooling only)'],
  ['/entities/search', 'POST /search'],
  ['/entities/fts', 'POST /search'],
  ['/entities/batch', 'POST /view/entity'],
  ['/entities/:id', 'POST /view/entity'],
  ['/entities/:id/logical', 'POST /view/entity'],
  ['/entities/:id/identifiers', 'POST /view/entity'],
  ['/entities/:id/resolutions', 'POST /view/entity'],
  ['/entities/:entityId/claims', 'POST /view/entity'],
  ['/entities/:entityId/claims/valid-at', 'POST /retrieve (temporal)'],
  ['/entities/:entityId/conflicts', 'POST /view/entity, POST /view/claim'],
  ['/entities/:entityId/neighbors', 'POST /view/neighborhood'],
  ['/entities/:entityId/relationships', 'POST /view/neighborhood'],
  ['/entities/:entityId/subgraph', 'POST /view/neighborhood'],
  ['/sources/batch', 'POST /view/source'],
  ['/sources/:id', 'POST /view/source'],
  ['/sources/:sourceId/claims', 'POST /view/source'],
  ['/sources/:sourceId/refs', 'POST /view/source'],
  ['/aliases/find', 'POST /search'],
  ['/aliases/entity/:entityId', 'POST /view/entity'],
  ['/claims/search', 'POST /search'],
  ['/claims/:id', 'POST /view/claim'],
  ['/claims/:id/explain', 'POST /view/claim'],
  ['/claims/:claimId/evidence', 'POST /view/claim'],
  ['/evidence/:id', 'POST /view/claim, POST /view/citation'],
  ['/evidence/:id/claims', 'POST /view/claim'],
  ['/identifiers/:scheme/:value', 'POST /search'],
]);

const VIEW_HANDLERS = {
  neighborhood: viewNeighborhood, entity: viewEntity, claim: viewClaim, relation: viewRelation, timeline: viewTimeline,
  source: viewSource, citation: viewCitation,
};

export function createKnowledgeGraphRoute(kgStore, { disabledReason = 'KG_DISABLED', semantic = null, readers = null } = {}) {
  const kg = new Hono();

  // KG-3: until KG-CERT the KG is normally not opened at boot (kg-boot.js).
  if (!kgStore) {
    kg.all('*', (c) => c.json({ error: 'KG_DISABLED', reason: disabledReason }, 503));
    return kg;
  }

  const now = () => new Date().toISOString();
  const badRequest = (c, error) => c.json({ error: error.code, message: error.message }, 400);

  /** Health: schema version only (no counts, nothing about the data). */
  kg.get('/health', (c) => {
    try {
      return c.json({ status: 'healthy', kgReady: kgStore.initialized, schemaVersion: getSchemaVersion(kgStore.db), timestamp: now() });
    } catch (error) {
      return c.json({ status: 'error', error: error.message, timestamp: now() }, 500);
    }
  });

  kg.get('/migration-status', (c) => {
    try {
      const s = kgStore.getMigrationStatus();
      return c.json({ currentVersion: s.currentVersion, targetVersion: s.targetVersion, pendingMigrations: s.pendingMigrations });
    } catch (error) {
      return c.json({ error: error.message, timestamp: now() }, 500);
    }
  });

  for (const [path, replacement] of KG_REMOVED_ROUTES) {
    kg.all(path, (c) => c.json({ error: 'KG_ROUTE_REMOVED', replacement }, 410));
  }

  // KG-5 hybrid retrieval: POST carries a structured READ query; nothing is written.
  async function retrievalRequest(c, { assembleContext }) {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'KG_QUERY_INVALID', message: 'JSON object body required' }, 400);
    if (typeof body.query !== 'string') return c.json({ error: 'KG_QUERY_INVALID', message: 'query must be a string' }, 400);
    if (body.mode !== undefined && !RETRIEVAL_MODES.includes(body.mode)) return c.json({ error: 'KG_MODE_INVALID' }, 400);
    if (body.temporal !== undefined && (typeof body.temporal !== 'object' || body.temporal === null || Array.isArray(body.temporal))) return c.json({ error: 'KG_TEMPORAL_INVALID' }, 400);
    if (body.budget !== undefined && (typeof body.budget !== 'object' || body.budget === null || Array.isArray(body.budget))) return c.json({ error: 'KG_BUDGET_INVALID' }, 400);
    try {
      const result = await retrieveKnowledge(kgStore, {
        query: body.query, mode: body.mode ?? 'hybrid', temporal: body.temporal ?? null, includePrivate: body.includePrivate === true,
        provider: body.provider ?? 'local', scope: body.scope ?? null,
        budget: body.budget ?? {}, semantic, assembleContext,
      });
      return c.json({ success: true, ...result, timestamp: now() });
    } catch (error) {
      if (error.code?.startsWith?.('KG_')) return badRequest(c, error);
      return c.json({ error: error.message }, 500);
    }
  }
  kg.post('/search', (c) => retrievalRequest(c, { assembleContext: false }));
  kg.post('/retrieve', (c) => retrievalRequest(c, { assembleContext: true }));

  // KG-6 / KG-7 views (bounded, visibility-filtered; not visible = not found)
  for (const [name, handler] of Object.entries(VIEW_HANDLERS)) {
    kg.post(`/view/${name}`, async (c) => {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'KG_VIEW_INVALID', message: 'JSON object body required' }, 400);
      try {
        const result = handler(kgStore, {
          entityId: body.entityId, claimId: body.claimId, relationshipId: body.relationshipId, sourceId: body.sourceId, evidenceId: body.evidenceId,
          depth: body.depth, maxNodes: body.maxNodes, maxEdges: body.maxEdges, fanout: body.fanout, offset: body.offset, filters: body.filters ?? {},
          includePrivate: body.includePrivate === true, provider: body.provider ?? 'local', scope: body.scope ?? null, now: body.now,
        });
        if (!result) return c.json({ error: 'KG_NOT_FOUND' }, 404);
        // KG-7: a citation says whether its target still reopens (Notebook chunk of THAT notebook, neuron) — read-only check
        if (name === 'citation' && readers) result.open = verifyOpenTarget(readers, result.open);
        return c.json({ success: true, ...result, timestamp: now() });
      } catch (error) {
        if (error.code?.startsWith?.('KG_')) return badRequest(c, error);
        return c.json({ error: error.message }, 500);
      }
    });
  }

  // static vocabularies (no data)
  kg.get('/config/entity-types', (c) => c.json({ entityTypes: KG_ENTITY_TYPES }));
  kg.get('/config/source-types', (c) => c.json({ sourceTypes: KG_SOURCE_TYPES }));
  kg.get('/config/claim-types', (c) => c.json({ claimTypes: KG_CLAIM_TYPES }));
  kg.get('/config/evidence-types', (c) => c.json({ evidenceTypes: KG_EVIDENCE_TYPES }));
  kg.get('/config/relationship-types', (c) => c.json({ relationshipTypes: KG_RELATIONSHIP_TYPES }));
  kg.get('/config/limits', (c) => c.json({ limits: KG_DEFAULT_LIMITS }));

  return kg;
}

export { KG_ENTITY_TYPES, KG_CLAIM_TYPES, KG_EVIDENCE_TYPES, KG_RELATIONSHIP_TYPES };
