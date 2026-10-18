// Knowledge Graph V1 — KG-6 read-only view API for the interactive graph.
//
// Everything here is bounded and filtered server-side; the UI never receives
// the whole graph:
//   • neighbourhood: depth ≤ 2, nodes ≤ 150, edges ≤ 300, per-node fan-out ≤ 100,
//     timeout; each node reports how many edges were NOT sent (manual expansion);
//   • visibility = KG-5 rules (includePrivate, provider, scope): an entity, claim,
//     relation, alias, identifier or evidence is only returned through an
//     allowed source — nothing private without explicit opt-in;
//   • a claim edge in an OPEN conflict always comes with its visible counterpart
//     (both sides, beyond the limits if needed);
//   • an AMBIGUOUS entity stays flagged with its candidates;
//   • a relation is descriptive only: it never grants anything.
// No write, no model, no network.

import { KG_ENTITY_TYPES, KG_CLAIM_STATUSES } from './kg-schema.js';
import { resolveVisibility, createRetrievalContext, claimCitations, resolveBudget, RetrievalError } from './kg-retrieval.js';
import { explainClaim } from './kg-claims.js';
import { normalizeKgDate, temporalState } from './kg-claim-model.js';

export const VIEW_LIMITS = Object.freeze({
  depth: { default: 1, max: 2 },
  maxNodes: { default: 60, max: 150 },
  maxEdges: { default: 120, max: 300 },
  fanout: { default: 40, max: 100 },
  timeoutMs: { default: 2000, max: 5000 },
  offset: { default: 0, max: 10000 },
  contradictionReserve: 20,
  timelineItems: 200,
  timelineBucketAbove: 60,
});
const LIVE_STATUSES = ['SUPPORTED', 'ASSERTED', 'DISPUTED', 'HYPOTHESIS'];
const parseJson = (v, f) => { try { return v ? JSON.parse(v) : f; } catch { return f; } };

function bounded(value, { default: def, max }) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : def;
}

function viewContext(store, opts) {
  const visibility = resolveVisibility(store, { includePrivate: opts.includePrivate === true, provider: opts.provider ?? 'local', scope: opts.scope ?? null, domain: opts.domain ?? 'knowledge' });
  const timeoutMs = bounded(opts.timeoutMs, VIEW_LIMITS.timeoutMs);
  return createRetrievalContext(store, visibility, resolveBudget({ timeoutMs }), Date.now());
}

/** Validated filters: entity types, claim statuses, source ids, validity window. */
export function normalizeFilters(filters = {}) {
  if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) throw new RetrievalError('KG_FILTERS_INVALID', 'filters must be an object');
  const list = (v, allowed, name) => {
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v) || v.length > 200) throw new RetrievalError('KG_FILTERS_INVALID', `${name} must be a bounded array`);
    const out = v.filter(x => typeof x === 'string' && (!allowed || allowed.includes(x)));
    if (out.length !== v.length) throw new RetrievalError('KG_FILTERS_INVALID', `${name} contains invalid values`);
    return new Set(out);
  };
  const date = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    const d = normalizeKgDate(v);
    if (!d) throw new RetrievalError('KG_FILTERS_INVALID', `${name} is not a valid date`);
    return d;
  };
  const from = date(filters.from, 'from');
  const to = date(filters.to, 'to');
  if (from && to && !(from < to)) throw new RetrievalError('KG_FILTERS_INVALID', 'from must be before to');
  return {
    entityTypes: list(filters.entityTypes, KG_ENTITY_TYPES, 'entityTypes'),
    statuses: list(filters.statuses, KG_CLAIM_STATUSES, 'statuses') ?? new Set(LIVE_STATUSES),
    sourceIds: list(filters.sourceIds, null, 'sourceIds'),
    from,
    to,
    includeUndated: filters.includeUndated !== false,
  };
}

function claimPassesDates(row, f) {
  if (!f.from && !f.to) return true;
  if (!row.valid_from && !row.valid_to) return f.includeUndated;
  const start = row.valid_from;
  const end = row.valid_to;
  return (!f.to || !start || start < f.to) && (!f.from || !end || end > f.from);
}

/** Allowed (source, technical ref) pairs of a claim's active evidence → allowed source ids. */
function claimEvidenceSources(store, claimId, ctx) {
  const rows = store.prepare(`SELECT DISTINCT e.source_id, e.source_ref_id FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
    WHERE ce.claim_id = ? AND ce.status = 'ACTIVE' AND e.status = 'ACTIVE'`).all(claimId);
  return [...new Set(rows.filter(r => ctx.evidenceAllowed(r.source_id, r.source_ref_id)).map(r => r.source_id))];
}

function openConflictCounterparts(store, ctx, claimId) {
  return store.prepare("SELECT claim_a_id, claim_b_id, conflict_id FROM kg_claim_conflicts WHERE (claim_a_id = ? OR claim_b_id = ?) AND status = 'OPEN'").all(claimId, claimId)
    .map(k => ({ conflictId: k.conflict_id, other: k.claim_a_id === claimId ? k.claim_b_id : k.claim_a_id }))
    .filter(k => {
      const row = store.prepare('SELECT status FROM kg_claims WHERE claim_id = ?').get(k.other);
      return row && !['INVALIDATED', 'SUPERSEDED'].includes(row.status) && ctx.claimVisible(k.other);
    });
}

function nodeOf(store, ctx, rootId, depth) {
  const e = store.getEntity(rootId);
  return {
    id: rootId,
    label: ctx.entityLabel(e.entity_id),
    type: e.entity_type,
    status: e.status,
    ambiguous: e.status === 'AMBIGUOUS',
    memberCount: store.getLogicalMemberIds(rootId).length,
    depth,
    shownEdges: 0,
    hiddenEdges: 0,
  };
}

/**
 * Bounded neighbourhood of an entity for the graph view. Returns null when
 * the entity does not exist or is not visible with these options.
 */
export function viewNeighborhood(store, opts = {}) {
  const ctx = viewContext(store, opts);
  const f = normalizeFilters(opts.filters ?? {});
  const depthMax = bounded(opts.depth, VIEW_LIMITS.depth);
  const maxNodes = Math.max(1, bounded(opts.maxNodes, VIEW_LIMITS.maxNodes));
  const maxEdges = bounded(opts.maxEdges, VIEW_LIMITS.maxEdges);
  const fanout = Math.max(1, bounded(opts.fanout, VIEW_LIMITS.fanout));
  // paging through a high fan-out node: the centre's edges start at `offset` (the next slice)
  const offset = bounded(opts.offset, VIEW_LIMITS.offset);
  const center = typeof opts.entityId === 'string' ? ctx.root(opts.entityId) : null;
  if (!center || !ctx.entityVisible(center)) return null;

  const nodes = new Map([[center, nodeOf(store, ctx, center, 0)]]);
  const edges = new Map();
  const limitsHit = new Set();
  const typeOk = (rootId) => rootId === center || !f.entityTypes || f.entityTypes.has(store.getEntity(rootId).entity_type);
  const sourceOk = (sources) => !f.sourceIds || sources.some(s => f.sourceIds.has(s));

  const addClaimEdge = (row, a, b, { force = false } = {}) => {
    const id = `clm:${row.claim_id}`;
    if (edges.has(id)) return true;
    if (!force && edges.size >= maxEdges) { limitsHit.add('max_edges'); return false; }
    const conflicts = openConflictCounterparts(store, ctx, row.claim_id);
    edges.set(id, {
      id, kind: 'claim', claimId: row.claim_id, source: a, target: b, label: row.predicate ?? row.claim_type, status: row.status,
      extractionMethod: row.extraction_method, validFrom: row.valid_from, validTo: row.valid_to, observedAt: row.observed_at,
      evidenceCount: claimEvidenceSources(store, row.claim_id, ctx).length,
      contradiction: conflicts.length ? { status: 'OPEN_CONFLICT', conflictIds: conflicts.map(c => c.conflictId), counterpartClaimIds: conflicts.map(c => c.other) } : null,
    });
    return true;
  };

  let frontier = [center];
  for (let depth = 1; depth <= depthMax && frontier.length; depth++) {
    const next = [];
    for (const nodeId of frontier) {
      if (ctx.timedOut()) { limitsHit.add('timeout'); break; }
      const members = store.getLogicalMemberIds(nodeId);
      const ph = members.map(() => '?').join(', ');
      const candidates = [];
      // claims first (disputed first): the most informative edges get the slots; relations after
      for (const c of store.prepare(`SELECT * FROM kg_claims WHERE (entity_id IN (${ph}) OR object_entity_id IN (${ph})) AND object_entity_id IS NOT NULL
          ORDER BY CASE status WHEN 'DISPUTED' THEN 0 WHEN 'SUPPORTED' THEN 1 ELSE 2 END, claim_id LIMIT 1000`).all(...members, ...members)) {
        if (!f.statuses.has(c.status) || !claimPassesDates(c, f) || !ctx.claimVisible(c.claim_id)) continue;
        if (!sourceOk(claimEvidenceSources(store, c.claim_id, ctx))) continue;
        candidates.push({ kind: 'claim', row: c, other: members.includes(c.entity_id) ? c.object_entity_id : c.entity_id });
      }
      for (const r of store.prepare(`SELECT relationship_id, source_entity_id AS a, target_entity_id AS b, relationship_type, source_id, confidence FROM kg_relationships
          WHERE (source_entity_id IN (${ph}) OR target_entity_id IN (${ph})) AND is_active = 1 ORDER BY relationship_id LIMIT 1000`).all(...members, ...members)) {
        // KG-8: through a visible provenance (logical source AND, in a Notebook scope, a ref of that notebook)
        if (!ctx.relationVisible(r.relationship_id)) continue;
        if (f.sourceIds && !ctx.relationProvenance(r.relationship_id).some(p => f.sourceIds.has(p.source_id))) continue;
        candidates.push({ kind: 'relationship', row: r, other: members.includes(r.a) ? r.b : r.a });
      }
      const usable = [];
      for (const cand of candidates) {
        const otherRoot = ctx.root(cand.other);
        if (!otherRoot || otherRoot === nodeId || !ctx.entityVisible(otherRoot) || !typeOk(otherRoot)) continue;
        usable.push({ ...cand, otherRoot });
      }
      const node = nodes.get(nodeId);
      let shown = 0;
      const skip = nodeId === center ? offset : 0;
      for (const cand of usable.slice(skip)) {
        const edgeId = cand.kind === 'claim' ? `clm:${cand.row.claim_id}` : `rel:${cand.row.relationship_id}`;
        if (edges.has(edgeId)) { shown++; continue; }
        if (shown >= fanout) { limitsHit.add('fanout'); break; }
        if (!nodes.has(cand.otherRoot)) {
          if (nodes.size >= maxNodes) { limitsHit.add('max_nodes'); break; }
          nodes.set(cand.otherRoot, nodeOf(store, ctx, cand.otherRoot, depth));
          next.push(cand.otherRoot);
        }
        const [a, b] = cand.kind === 'claim'
          ? [ctx.root(cand.row.entity_id), ctx.root(cand.row.object_entity_id)]
          : [ctx.root(cand.row.a), ctx.root(cand.row.b)];
        let added;
        if (cand.kind === 'claim') added = addClaimEdge(cand.row, a, b);
        else if (edges.size < maxEdges) {
          edges.set(edgeId, { id: edgeId, kind: 'relationship', relationshipId: cand.row.relationship_id, source: a, target: b, label: cand.row.relationship_type, status: 'RELATION', confidence: cand.row.confidence });
          added = true;
        } else { limitsHit.add('max_edges'); added = false; }
        if (!added) break;
        shown++;
      }
      node.shownEdges = shown;
      node.hiddenEdges = Math.max(0, usable.length - skip - shown);
      if (nodeId === center) node.offset = skip;
    }
    frontier = next;
  }
  if (frontier.length && depthMax > 0) limitsHit.add('max_depth');

  // contradictions: a shown claim edge always comes with its visible counterpart(s)
  let reserve = VIEW_LIMITS.contradictionReserve;
  for (const edge of [...edges.values()]) {
    if (!edge.contradiction) continue;
    for (const otherId of edge.contradiction.counterpartClaimIds) {
      if (edges.has(`clm:${otherId}`) || reserve <= 0) continue;
      const row = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(otherId);
      if (!row.object_entity_id) { edge.contradiction.valueCounterparts = (edge.contradiction.valueCounterparts ?? 0) + 1; continue; }
      const [a, b] = [ctx.root(row.entity_id), ctx.root(row.object_entity_id)];
      for (const n of [a, b]) if (!nodes.has(n) && ctx.entityVisible(n)) nodes.set(n, nodeOf(store, ctx, n, (nodes.get(a)?.depth ?? 0) + 1));
      if (nodes.has(a) && nodes.has(b)) { addClaimEdge(row, a, b, { force: true }); reserve--; limitsHit.add('contradiction_completed'); }
    }
  }
  // sources behind the edges shown (allowed ones only) — what the "source" filter can offer
  const sourceCounts = new Map();
  const countSource = (id) => { if (id && ctx.sourceAllowed(id)) sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1); };
  for (const e of edges.values()) {
    if (e.kind === 'claim') for (const s of claimEvidenceSources(store, e.claimId, ctx)) countSource(s);
    else for (const s of new Set(ctx.relationProvenance(e.relationshipId).map(p => p.source_id))) countSource(s);
  }
  const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 30).map(([id, count]) => {
    const s = store.getSource(id);
    return { sourceId: id, name: ctx.sourceLabel(id), type: s.source_type, privacy: s.privacy, edges: count };
  });
  return {
    center,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    sources,
    limits: { depth: depthMax, maxNodes, maxEdges, fanout, offset },
    limitsHit: [...limitsHit],
    visibility: { includePrivate: ctx.visibility.includePrivate, provider: ctx.visibility.provider, scoped: Boolean(ctx.visibility.scopeSet) },
  };
}

function compactClaim(store, ctx, row, now) {
  const subject = store.getEntity(row.entity_id);
  const object = row.object_entity_id ? store.getEntity(row.object_entity_id) : null;
  const conflicts = openConflictCounterparts(store, ctx, row.claim_id);
  return {
    claimId: row.claim_id,
    subject: { entityId: row.entity_id, label: subject ? ctx.entityLabel(row.entity_id) : null },
    predicate: row.predicate ?? row.claim_type,
    object: object ? { kind: 'entity', entityId: object.entity_id, label: ctx.entityLabel(object.entity_id) } : (row.value_json ? { kind: 'value', value: parseJson(row.value_json, null) } : { kind: 'statement', text: row.statement }),
    status: row.status,
    extractionMethod: row.extraction_method,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    observedAt: row.observed_at,
    temporalState: temporalState({ validFrom: row.valid_from, validTo: row.valid_to }, now),
    contradiction: conflicts.length ? { status: 'OPEN_CONFLICT', counterpartClaimIds: conflicts.map(c => c.other) } : null,
    supersededBy: row.superseded_by_id,
  };
}

/** Entity details: aliases, identifiers, ambiguity, ledger, claims — through allowed sources only. */
export function viewEntity(store, opts = {}) {
  const ctx = viewContext(store, opts);
  const root = typeof opts.entityId === 'string' ? ctx.root(opts.entityId) : null;
  if (!root || !ctx.entityVisible(root)) return null;
  const e = store.getEntity(root);
  const members = store.getLogicalMemberIds(root);
  const ph = members.map(() => '?').join(', ');
  const now = normalizeKgDate(opts.now) ?? new Date().toISOString().slice(0, 10);
  const aliases = store.prepare(`SELECT DISTINCT a.alias, a.source_id, a.source_ref_id FROM kg_aliases a
      WHERE a.entity_id IN (${ph}) AND a.status IN ('CONFIRMED', 'PROPOSED') ORDER BY a.alias LIMIT 500`).all(...members)
    .filter(a => (a.source_id ? ctx.evidenceAllowed(a.source_id, a.source_ref_id) : ctx.unsourcedAllowed()))
    .map(a => ({ ...a, source_name: a.source_id ? ctx.sourceLabel(a.source_id) : null }));
  const aliasList = [];
  for (const a of aliases) {
    let item = aliasList.find(x => x.alias === a.alias);
    if (!item) { item = { alias: a.alias, sources: [] }; aliasList.push(item); }
    if (a.source_name && !item.sources.includes(a.source_name)) item.sources.push(a.source_name);
  }
  const identifiers = store.prepare(`SELECT scheme, normalized_value, status, source_id, source_ref_id FROM kg_entity_identifiers WHERE entity_id IN (${ph}) ORDER BY scheme, normalized_value LIMIT 100`).all(...members)
    .filter(i => (i.source_id ? ctx.evidenceAllowed(i.source_id, i.source_ref_id) : ctx.unsourcedAllowed()))
    .map(i => ({ scheme: i.scheme, value: i.normalized_value, status: i.status }));
  const visibleOther = (id) => { const r = ctx.root(id); return r && ctx.entityVisible(r); };
  const ambiguity = e.status === 'AMBIGUOUS' ? {
    status: 'AMBIGUOUS',
    candidates: store.prepare("SELECT target_entity_id, method FROM kg_entity_resolutions WHERE source_entity_id = ? AND decision = 'PROPOSED' ORDER BY created_at LIMIT 20").all(root)
      .filter(r => visibleOther(r.target_entity_id)).map(r => ({ entityId: r.target_entity_id, label: ctx.entityLabel(r.target_entity_id), method: r.method })),
  } : null;
  const resolutions = store.prepare(`SELECT * FROM kg_entity_resolutions WHERE source_entity_id IN (${ph}) OR target_entity_id IN (${ph}) ORDER BY created_at, resolution_id LIMIT 50`).all(...members, ...members)
    .filter(r => visibleOther(r.source_entity_id) && visibleOther(r.target_entity_id))
    .map(r => ({ resolutionId: r.resolution_id, sourceEntityId: r.source_entity_id, targetEntityId: r.target_entity_id, sourceLabel: ctx.entityLabel(r.source_entity_id), targetLabel: ctx.entityLabel(r.target_entity_id),
      decision: r.decision, method: r.method, actor: r.actor, createdAt: r.created_at, decidedAt: r.decided_at, reversedAt: r.reversed_at }));
  const claimRows = store.prepare(`SELECT * FROM kg_claims WHERE (entity_id IN (${ph}) OR object_entity_id IN (${ph})) AND status <> 'INVALIDATED'
      ORDER BY predicate, valid_from, claim_id LIMIT 300`).all(...members, ...members).filter(c => ctx.claimVisible(c.claim_id));
  const claims = claimRows.map(c => compactClaim(store, ctx, c, now));
  const provenance = store.prepare(`SELECT DISTINCT a.source_id, a.source_ref_id, s.name, s.source_type, s.privacy, s.egress_policy, r.adapter, r.source_ref FROM kg_aliases a
      JOIN kg_sources s ON s.source_id = a.source_id LEFT JOIN kg_source_refs r ON r.source_ref_id = a.source_ref_id
      WHERE a.entity_id IN (${ph}) ORDER BY s.name LIMIT 100`).all(...members).filter(p => ctx.evidenceAllowed(p.source_id, p.source_ref_id))
    .map(p => ({ sourceId: p.source_id, sourceName: ctx.sourceLabel(p.source_id), sourceType: p.source_type, privacy: p.privacy, egress: p.egress_policy, adapter: p.adapter, ref: p.source_ref }));
  return {
    entity: { id: root, label: ctx.entityLabel(root), type: e.entity_type, status: e.status, description: e.description || null, memberIds: members, createdAt: e.created_at },
    aliases: aliasList, identifiers, ambiguity, resolutions,
    claims: { history: claims.filter(c => c.status === 'SUPERSEDED'), live: claims.filter(c => c.status !== 'SUPERSEDED') },
    provenance,
    note: 'Relations and claims are descriptive: they never grant a permission.',
  };
}

/** Claim details: evidence + provenance (allowed sources only), both sides of a contradiction, supersession. */
export function viewClaim(store, opts = {}) {
  const ctx = viewContext(store, opts);
  if (typeof opts.claimId !== 'string' || !ctx.claimVisible(opts.claimId)) return null;
  const full = explainClaim(store, opts.claimId, { includePrivate: true, at: opts.now });
  if (!full) return null;
  const evidence = full.evidence.filter(e => ctx.evidenceAllowed(e.source.sourceId, e.sourceRef?.sourceRefId ?? null))
    .map(e => ({ ...e, source: { ...e.source, name: ctx.sourceLabel(e.source.sourceId) } }));
  // entity labels through the visibility (a name first seen in a hidden source is never shown)
  const relabel = (c) => ({
    ...c,
    subject: c.subject ? { ...c.subject, label: ctx.entityLabel(c.subject.entityId) } : c.subject,
    object: c.object?.kind === 'entity' ? { ...c.object, label: ctx.entityLabel(c.object.entityId) } : c.object,
  });
  full.claim = relabel(full.claim);
  const contradictions = full.contradictions.filter(k => ctx.claimVisible(k.otherClaim.claimId)).map(k => ({
    ...k,
    otherClaim: relabel(k.otherClaim),
    otherEvidence: claimCitations(store, k.otherClaim.claimId, { evidenceAllowed: (sid, rid) => ctx.evidenceAllowed(sid, rid), sourceLabel: (id) => ctx.sourceLabel(id), limit: 5 }),
  }));
  return {
    claim: full.claim,
    evidence,
    supportingEvidence: evidence.filter(e => e.stance === 'SUPPORTS' && e.linkStatus === 'ACTIVE' && e.status === 'ACTIVE').length,
    contradictingEvidence: evidence.filter(e => e.stance === 'CONTRADICTS' && e.linkStatus === 'ACTIVE' && e.status === 'ACTIVE').length,
    contradictions,
    supersedes: full.supersedes.filter(id => ctx.claimVisible(id)),
  };
}

/** Relation (kg_relationships) details: visible only through an allowed provenance. */
export function viewRelation(store, opts = {}) {
  const ctx = viewContext(store, opts);
  const row = typeof opts.relationshipId === 'string' ? store.prepare('SELECT * FROM kg_relationships WHERE relationship_id = ?').get(opts.relationshipId) : null;
  if (!row || !row.is_active || !ctx.relationVisible(row.relationship_id)) return null;
  const [a, b] = [ctx.root(row.source_entity_id), ctx.root(row.target_entity_id)];
  if (!ctx.entityVisible(a) || !ctx.entityVisible(b)) return null;
  // KG-8: only the provenances this context may see, each with the technical ref it came through (when known)
  const bySource = new Map();
  for (const p of ctx.relationProvenance(row.relationship_id)) {
    if (!bySource.has(p.source_id)) bySource.set(p.source_id, new Set());
    if (p.source_ref_id) bySource.get(p.source_id).add(p.source_ref_id);
  }
  const provenances = [...bySource.entries()].map(([sourceId, refIds]) => {
    const src = store.getSource(sourceId);
    return { sourceId, sourceName: ctx.sourceLabel(sourceId), sourceType: src.source_type, privacy: src.privacy, egress: src.egress_policy, status: src.status,
      refs: scopedRefs(store, ctx, sourceId).filter(r => refIds.has(r.source_ref_id)).map(r => ({ adapter: r.adapter, ref: r.source_ref, inputPath: r.input_path, status: r.status })) };
  });
  return {
    relation: { id: row.relationship_id, type: row.relationship_type, confidence: row.confidence, trustLevel: row.trust_level, verified: row.is_verified === 1, createdAt: row.created_at,
      source: { entityId: a, label: ctx.entityLabel(a) }, target: { entityId: b, label: ctx.entityLabel(b) } },
    provenance: provenances[0] ?? null,
    provenances,
    note: 'A relation is descriptive: it never grants a permission.',
  };
}

/**
 * Timeline of an entity's claims (live + superseded history): dated claims in
 * order; undated ones counted apart (never placed on a date). Dense timelines
 * are aggregated per year, items capped.
 */
export function viewTimeline(store, opts = {}) {
  const ctx = viewContext(store, opts);
  const root = typeof opts.entityId === 'string' ? ctx.root(opts.entityId) : null;
  if (!root || !ctx.entityVisible(root)) return null;
  const f = normalizeFilters({ ...(opts.filters ?? {}), statuses: opts.filters?.statuses ?? [...LIVE_STATUSES, 'SUPERSEDED'] });
  const members = store.getLogicalMemberIds(root);
  const ph = members.map(() => '?').join(', ');
  const now = normalizeKgDate(opts.now) ?? new Date().toISOString().slice(0, 10);
  const rows = store.prepare(`SELECT * FROM kg_claims WHERE (entity_id IN (${ph}) OR object_entity_id IN (${ph})) ORDER BY COALESCE(valid_from, valid_to), claim_id LIMIT 5000`).all(...members, ...members)
    .filter(c => f.statuses.has(c.status) && claimPassesDates(c, { ...f, includeUndated: true }) && ctx.claimVisible(c.claim_id));
  const dated = rows.filter(c => c.valid_from || c.valid_to);
  const undatedCount = rows.length - dated.length;
  const items = dated.slice(0, VIEW_LIMITS.timelineItems).map(c => compactClaim(store, ctx, c, now));
  let buckets = null;
  if (dated.length > VIEW_LIMITS.timelineBucketAbove) {
    const byYear = new Map();
    for (const c of dated) {
      const y = (c.valid_from ?? c.valid_to).slice(0, 4);
      const b = byYear.get(y) ?? { year: y, count: 0, disputed: 0 };
      b.count++;
      if (c.status === 'DISPUTED') b.disputed++;
      byYear.set(y, b);
    }
    buckets = [...byYear.values()].sort((x, y) => (x.year < y.year ? -1 : 1));
  }
  const minDate = dated.reduce((m, c) => [c.valid_from, c.valid_to].filter(Boolean).reduce((mm, d) => (mm === null || d < mm ? d : mm), m), null);
  const maxDate = dated.reduce((m, c) => [c.valid_from, c.valid_to].filter(Boolean).reduce((mm, d) => (mm === null || d > mm ? d : mm), m), null);
  return { entityId: root, items, totalDated: dated.length, truncated: dated.length > items.length, undatedCount, buckets, range: { min: minDate, max: maxDate }, now };
}

/** Technical refs of a source visible in this context (a Notebook scope only shows its own refs). */
function scopedRefs(store, ctx, sourceId) {
  return store.getSourceRefs(sourceId).filter(r => ctx.refShown(r.source_ref_id));
}

/** Where a technical ref can be reopened with Docteur's existing mechanisms. */
function openTargetOf(ref, evidence = null) {
  if (ref?.adapter === 'notebook_document') {
    return { kind: 'notebook_document', notebookId: ref.provenance?.notebookId ?? null, documentId: ref.source_ref, versionId: ref.version_ref ?? null, origin: ref.input_path ?? null,
      ...(evidence ? { chunkId: evidence.chunk_id ?? null, page: evidence.page ?? null, charStart: evidence.char_start ?? null, charEnd: evidence.char_end ?? null, messageId: evidence.message_id ?? null } : {}) };
  }
  if (ref?.adapter === 'article_capture' || ref?.adapter === 'neuron') return { kind: 'neuron', pageId: ref.source_ref, url: ref.original_url ?? null };
  return { kind: 'external', url: ref?.original_url ?? null };
}

/** A logical source: name, refs and claims visible in this context, with where each ref reopens. */
export function viewSource(store, opts = {}) {
  const ctx = viewContext(store, opts);
  const src = typeof opts.sourceId === 'string' ? store.getSource(opts.sourceId) : null;
  if (!src || !ctx.sourceAllowed(src.source_id)) return null;
  const refs = scopedRefs(store, ctx, src.source_id);
  if (ctx.labelRestricted(src.source_id) && refs.length === 0) return null;
  const now = normalizeKgDate(opts.now) ?? new Date().toISOString().slice(0, 10);
  const claimRows = store.prepare(`SELECT DISTINCT c.* FROM kg_claims c JOIN kg_claim_evidence ce ON ce.claim_id = c.claim_id JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
      WHERE e.source_id = ? AND c.status <> 'INVALIDATED' ORDER BY c.predicate, c.claim_id LIMIT 200`).all(src.source_id).filter(c => ctx.claimVisible(c.claim_id));
  return {
    source: { id: src.source_id, name: ctx.sourceLabel(src.source_id), type: src.source_type, status: src.status, privacy: src.privacy, egress: src.egress_policy,
      canonicalUrl: src.canonical_url, author: src.author, publisher: src.publisher, publishedAt: src.published_at },
    refs: refs.map(r => ({ sourceRefId: r.source_ref_id, adapter: r.adapter, ref: r.source_ref, inputPath: r.input_path, versionRef: r.version_ref, status: r.status, observedAt: r.observed_at,
      matchedBy: r.provenance?.matchedBy ?? null, divergences: r.provenance?.divergences ?? [], open: openTargetOf(r) })),
    claims: claimRows.map(c => compactClaim(store, ctx, c, now)),
  };
}

/** One evidence: exact locator and where to reopen it (Notebook chunk, neuron) — only through an allowed ref. */
export function viewCitation(store, opts = {}) {
  const ctx = viewContext(store, opts);
  const ev = typeof opts.evidenceId === 'string' ? store.prepare('SELECT * FROM kg_evidence WHERE evidence_id = ?').get(opts.evidenceId) : null;
  if (!ev || !ctx.evidenceAllowed(ev.source_id, ev.source_ref_id)) return null;
  const ref = ev.source_ref_id ? store.getSourceRef(ev.source_ref_id) : null;
  const src = store.getSource(ev.source_id);
  return {
    evidence: { evidenceId: ev.evidence_id, status: ev.status, preview: ev.content, excerptHash: ev.excerpt_hash,
      locator: { kind: ev.locator_kind, ref: ev.locator_ref, chunkId: ev.chunk_id, messageId: ev.message_id, page: ev.page, section: ev.section, charStart: ev.char_start, charEnd: ev.char_end } },
    source: { id: src.source_id, name: ctx.sourceLabel(src.source_id), type: src.source_type, status: src.status, privacy: src.privacy },
    open: ref ? openTargetOf(ref, ev) : { kind: 'external', url: src.canonical_url ?? null },
  };
}

export default { viewNeighborhood, viewEntity, viewClaim, viewRelation, viewTimeline, viewSource, viewCitation, normalizeFilters, VIEW_LIMITS };
