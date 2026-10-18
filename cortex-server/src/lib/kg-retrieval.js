// Knowledge Graph V1 — KG-5 hybrid retrieval (read-only).
//
// QUERY → NORMALIZATION → EXACT / FTS → SEMANTIC CANDIDATES → ENTITY MATCH →
// GRAPH NEIGHBORHOOD → TEMPORAL / PRIVACY FILTERS → RANKING → CONTEXT BUDGET →
// SOURCE CITATIONS → RESULT
//
// The KG enriches Notebook / RAG retrieval; it does not replace it.
//   • ranking is an explicit sum of named signals (SIGNAL_WEIGHTS) — every result
//     carries its per-signal contributions and `whyMatched`;
//   • contradictions are kept together: if one claim of an OPEN conflict is
//     selected, the visible counterpart(s) are selected with it, or none is;
//   • ambiguity is kept: an AMBIGUOUS entity is returned with its candidates and a
//     penalty, never as a certain resolution;
//   • privacy: private sources are filtered by default; an entity known only
//     through private sources is invisible; no private evidence is ever cited;
//   • invalidated sources / evidence never count as active evidence;
//   • graph expansion is bounded (depth, nodes, edges, per-node fan-out, timeout,
//     visited set); the whole graph is never sent to a model;
//   • every claim result cites its ORIGINAL sources (source, technical ref,
//     locator, chunk / page / message, excerpt hash).
// No write, no model call, no cloud. The semantic layer is optional and local.

import { KG_DEFAULT_LIMITS } from './kg-schema.js';
import { looseKey, normalizeIdentifier } from './kg-normalize.js';
import { normalizeKgDate, temporalState } from './kg-claim-model.js';
import { STOPWORDS } from './notebook-docs-store.js';

export const RETRIEVAL_MODES = ['hybrid', 'exact', 'fts', 'semantic', 'graph'];

/** Every ranking signal and its weight — the whole scoring model. */
export const SIGNAL_WEIGHTS = Object.freeze({
  exact_entity_match: 1.0,        // the whole query is an entity label / alias
  exact_identifier_match: 1.0,    // a stable identifier in the query
  exact_title_match: 0.9,         // the whole query is a source title
  entity_mention: 0.8,            // an entity label / alias appears in the query (× n-gram coverage)
  fts_match: 0.6,                 // FTS5 bm25, normalised to (0, 1]
  semantic_similarity: 0.5,       // cosine similarity ≥ SEMANTIC_FLOOR
  graph_1_hop: 0.3,               // reached from a matched entity in one hop
  graph_2_hop: 0.15,
  claim_about_matched_entity: 0.35, // × strength of the entity's own match
  predicate_match: 0.4,           // a query word names the claim's predicate (PREDICATE_LEXICON)
  evidence_text_match: 0.5,       // × share of query terms present in the claim's visible evidence
  // claim quality signals below are scaled by the claim's relevance (value = factor × relevance ≤ 1):
  // they order relevant claims, they never make an irrelevant claim relevant
  claim_supported: 0.2,
  claim_user_asserted: 0.15,      // written by the user (real "user-confirmed" signal)
  claim_disputed: 0.1,            // relevant, contested: kept, not hidden
  evidence_count: 0.05,           // per active supporting evidence (max 3)
  source_confidence: 0.1,         // × claim sourceConfidence
  model_confidence: 0.05,         // × modelConfidence (model hypotheses only)
  temporal_match: 0.15,           // explicit dates match the temporal intent
  ambiguous_entity: -0.2,         // never treated as a certain resolution
});
export const SEMANTIC_FLOOR = 0.55;

/**
 * Words (FR / EN, comparison keys) that name a registered predicate. Deterministic,
 * documented, deliberately small: it only lets a question about "le siège" reach
 * a `headquarters` claim; it never creates a claim.
 */
export const PREDICATE_LEXICON = Object.freeze({
  ceo: ['pdg', 'ceo', 'dirige', 'dirigeait', 'dirigeant', 'dirigeante', 'directeur', 'directrice', 'president', 'presidente', 'patron', 'patronne', 'chief', 'leads', 'led', 'runs'],
  headquarters: ['siege', 'headquarters', 'hq', 'situe', 'trouve', 'located'],
  parent_organization: ['maison', 'mere', 'parent', 'filiale', 'subsidiary'],
  located_in: ['situe', 'trouve', 'located', 'lieu'],
  publisher: ['editeur', 'publie', 'publisher', 'published'],
  published_on: ['publie', 'parution', 'published', 'date'],
  date_of_birth: ['ne', 'nee', 'naissance', 'born', 'birth'],
  founded_on: ['fonde', 'fondee', 'fondation', 'creation', 'founded'],
  price: ['prix', 'coute', 'coutent', 'tarif', 'price', 'cost', 'costs'],
  status: ['statut', 'etat', 'actif', 'active', 'status'],
  population: ['population', 'habitants', 'inhabitants'],
  author: ['auteur', 'autrice', 'ecrit', 'author', 'wrote'],
  founder: ['fondateur', 'fondatrice', 'fondateurs', 'fonde', 'founder', 'founders', 'founded'],
  employer: ['employeur', 'travaille', 'employer', 'works'],
  member_of: ['membre', 'member'],
  website: ['site', 'website', 'web'],
  version: ['version'],
});
const RELEVANCE_SIGNALS = new Set(['fts_match', 'semantic_similarity', 'graph_1_hop', 'graph_2_hop', 'claim_about_matched_entity', 'predicate_match', 'evidence_text_match']);
/** Results scoring below this fraction of the best score are dropped (a contradiction group counts as one unit). */
export const DEFAULT_MIN_RELATIVE_SCORE = 0.15;

const DEFAULT_BUDGET = Object.freeze({
  maxEntities: 10, maxClaims: 20, maxEvidences: 30, maxSnippets: 20, maxSources: 10,
  maxChars: 6000, maxDepth: 1, maxNodes: 200, maxEdges: 500, maxFanout: 100, maxSeeds: 5, timeoutMs: 2000,
});
const HARD_LIMITS = Object.freeze({
  maxEntities: 50, maxClaims: 100, maxEvidences: 150, maxSnippets: 100, maxSources: 50,
  maxChars: 20000, maxDepth: 2, maxNodes: 1000, maxEdges: 5000, maxFanout: 500, maxSeeds: 20, timeoutMs: 10000,
});
export const MAX_QUERY_CHARS = 2000;
const MAX_TERMS = 16;
const MAX_NGRAMS = 80;
const SNIPPET_CHARS = 280;
const CLAIMS_PER_ENTITY = 30;
// Candidate claims scored in full (preliminary order: their stage signals). Bounds the per-query work.
const CANDIDATE_CLAIMS_MIN = 100;

export function resolveBudget(budget = {}) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_BUDGET)) {
    const v = Number.isInteger(budget[k]) && budget[k] >= 0 ? budget[k] : def;
    out[k] = Math.min(v, HARD_LIMITS[k]);
  }
  return out;
}

// ── query normalisation ─────────────────────────────────────────────────────

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g;
const DATE_RE = String.raw`(\d{4}(?:-\d{2}(?:-\d{2})?)?|\d{1,2}/\d{1,2}/\d{4})`;
const TEMPORAL_PATTERNS = [
  { kind: 'before', re: new RegExp(String.raw`\b(?:avant|before|until|jusqu'en)\s+(?:le\s+|la\s+|l'|the\s+)?${DATE_RE}`, 'iu') },
  { kind: 'after', re: new RegExp(String.raw`\b(?:apr[eè]s|after|depuis|since)\s+(?:le\s+|la\s+|l'|the\s+)?${DATE_RE}`, 'iu') },
  { kind: 'at', re: new RegExp(String.raw`\b(?:en|in|au|le|on|as of|[àa] la date du|[àa]u?)\s+${DATE_RE}`, 'iu') },
  { kind: 'current', re: /\b(actuel(?:le)?s?|actuellement|aujourd'hui|en ce moment|currently|current|now|today)\b/iu },
  { kind: 'past', re: /\b(ancien(?:ne)?s?|anciennement|autrefois|pr[ée]c[ée]dent(?:e)?s?|former(?:ly)?|previous(?:ly)?)\b/iu },
];

function frenchDate(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
}

/**
 * Temporal intent from explicit words / dates in the query — never invented.
 * A bare year is a period ("en 2012" = during [2012-01-01, 2013-01-01)).
 */
export function parseTemporalIntent(query) {
  const text = String(query ?? '');
  for (const { kind, re } of TEMPORAL_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    if (kind === 'current' || kind === 'past') return { kind, matched: m[0] };
    const raw = frenchDate(m[1]);
    const date = normalizeKgDate(raw);
    if (!date) continue;
    if (kind === 'at' && /^\d{4}$/.test(raw)) return { kind: 'during', from: date, to: `${Number(raw) + 1}-01-01`, matched: m[0] };
    if (kind === 'at' && /^\d{4}-\d{2}$/.test(raw)) {
      const [y, mo] = raw.split('-').map(Number);
      return { kind: 'during', from: date, to: mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`, matched: m[0] };
    }
    return { kind, date, matched: m[0] };
  }
  return { kind: 'any' };
}

function normalizeTemporal(explicit, parsed) {
  if (!explicit) return parsed;
  const kind = explicit.kind ?? 'any';
  if (!['any', 'current', 'past', 'at', 'before', 'after', 'during'].includes(kind)) throw new RetrievalError('KG_TEMPORAL_INVALID', `unknown temporal kind ${kind}`);
  const out = { kind };
  for (const f of ['date', 'from', 'to']) {
    if (explicit[f] !== undefined) {
      const d = normalizeKgDate(explicit[f]);
      if (!d) throw new RetrievalError('KG_TEMPORAL_INVALID', `${f} is not a valid date`);
      out[f] = d;
    }
  }
  if (['at', 'before', 'after'].includes(kind) && !out.date) throw new RetrievalError('KG_TEMPORAL_INVALID', `${kind} needs a date`);
  if (kind === 'during' && (!out.from || !out.to)) throw new RetrievalError('KG_TEMPORAL_INVALID', 'during needs from and to');
  return out;
}

export class RetrievalError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'RetrievalError';
    this.code = code;
  }
}

/** User text → bounded, cleaned query + terms / phrases / prefixes for FTS. */
export function normalizeQuery(raw) {
  let text = typeof raw === 'string' ? raw : '';
  const truncated = text.length > MAX_QUERY_CHARS;
  if (truncated) text = text.slice(0, MAX_QUERY_CHARS);
  text = text.normalize('NFKC').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const temporal = parseTemporalIntent(text);
  const searchText = temporal.matched ? text.replace(temporal.matched, ' ').replace(/\s+/g, ' ').trim() : text;
  const phrases = [];
  for (const m of searchText.matchAll(/"([^"]{1,200})"/g)) {
    const tokens = m[1].match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length > 1) phrases.push(tokens.slice(0, 8));
  }
  const terms = [];
  for (const m of searchText.replace(/"[^"]*"/g, ' ').matchAll(/([\p{L}\p{N}]+)(\*?)/gu)) {
    const token = m[1];
    const key = looseKey(token);
    if (key.length < 2 || STOPWORDS.has(key)) continue;
    if (terms.some(t => t.token === token)) continue;
    terms.push({ token, prefix: m[2] === '*' && token.length >= 3 });
    if (terms.length >= MAX_TERMS) break;
  }
  return { text, searchText, loose: looseKey(searchText), terms, phrases, truncated, temporal };
}

/** Safe FTS5 expression: every token quoted; only our own OR / prefix / phrase syntax. */
export function buildFtsExpression(q) {
  const parts = [
    ...q.phrases.map(tokens => `"${tokens.join(' ')}"`),
    ...q.terms.map(t => `"${t.token}"${t.prefix ? '*' : ''}`),
  ];
  return parts.length ? parts.join(' OR ') : '';
}

// ── helpers ─────────────────────────────────────────────────────────────────

const parseJson = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

export const PROVIDERS = ['local', 'cloud'];

/**
 * Visibility of a retrieval:
 *   includePrivate  PRIVATE sources are visible (explicit local opt-in; default false);
 *   provider        'local' (default) or 'cloud': a context meant for a cloud model
 *                   excludes every local_only source as well;
 *   scope           { notebookId } | { sourceIds } | { all: true }: only these sources
 *                   count. A Notebook scope sees only what was read through THAT
 *                   notebook's refs; a sources scope names LOGICAL sources and never
 *                   sees through a Notebook ref (KG-CERT: no widening from the
 *                   logical id of a document shared by two notebooks).
 * A claim is visible through at least one allowed evidence source (a user claim
 * without evidence: through its origin source, or when unsourced and unscoped);
 * an entity through an allowed alias provenance, a visible claim, or when it has
 * no provenance at all (unscoped only). Citations only ever name allowed sources.
 */
export const KG_DOMAINS = ['knowledge', 'code'];

/** Technical paths that belong to ONE notebook: only that notebook's scope (or an explicit `all`) may see through them. */
const NOTEBOOK_ADAPTERS = new Set(['notebook_document', 'notebook_ai_message']);

/** Trust domain of a source: the Code Intelligence subgraph is marked metadata.domain = 'code'; everything else is personal knowledge. */
export const sourceDomainOf = (metadataDomain) => (metadataDomain === 'code' ? 'code' : 'knowledge');

export function resolveVisibility(store, { includePrivate = false, provider = 'local', scope = null, domain = 'knowledge' } = {}) {
  if (!PROVIDERS.includes(provider)) throw new RetrievalError('KG_PROVIDER_INVALID', `provider must be one of ${PROVIDERS.join(', ')}`);
  // KG-8: Code Intelligence (files / symbols / imports) and personal knowledge are separate trust domains, never mixed implicitly
  if (!KG_DOMAINS.includes(domain)) throw new RetrievalError('KG_DOMAIN_INVALID', `domain must be one of ${KG_DOMAINS.join(', ')}`);
  // KG-7: private data needs an explicit opt-in AND an explicit scope, and never goes to a cloud context
  if (includePrivate === true && (scope === null || scope === undefined)) {
    throw new RetrievalError('KG_SCOPE_REQUIRED', 'includePrivate needs an explicit scope: { notebookId } | { sourceIds } | { all: true }');
  }
  if (includePrivate === true && provider === 'cloud') throw new RetrievalError('KG_PRIVATE_NOT_FOR_CLOUD', 'private data is never assembled for a cloud provider');
  let scopeSet = null;
  let refScope = null;
  let excludedRefs = null;
  let notebookBound = null;
  let openRefSources = null;
  if (scope !== null && scope !== undefined) {
    if (typeof scope !== 'object' || Array.isArray(scope)) throw new RetrievalError('KG_SCOPE_INVALID', 'scope must be { notebookId } | { sourceIds } | { all: true }');
    // KG-CERT: one kind per scope, nothing else — an ambiguous scope ({ notebookId, all }, extra keys) is refused
    if (typeof scope.notebookId === 'string' && Object.keys(scope).length === 1) {
      // a Notebook scope is a set of technical refs: evidence counts only through a ref of THIS notebook
      const refs = store.prepare(`SELECT source_ref_id, source_id FROM kg_source_refs WHERE adapter = 'notebook_document' AND status = 'ACTIVE'
        AND json_extract(provenance, '$.notebookId') = ?`).all(scope.notebookId);
      scopeSet = new Set(refs.map(r => r.source_id));
      refScope = new Set(refs.map(r => r.source_ref_id));
    } else if (Array.isArray(scope.sourceIds) && scope.sourceIds.length <= KG_DEFAULT_LIMITS.MAX_RESULT_SIZE && Object.keys(scope).length === 1) {
      scopeSet = new Set(scope.sourceIds.filter(id => typeof id === 'string'));
      // KG-CERT: a sources scope names LOGICAL sources; it never widens to what a notebook read. A logical
      // document shared by notebooks A and B keeps A's and B's provenance (evidence, aliases, relations,
      // titles) behind their notebook scope; through a sources scope only its non-Notebook paths count.
      const ids = [...scopeSet];
      const refs = ids.length ? store.prepare(`SELECT source_ref_id, source_id, adapter, status FROM kg_source_refs WHERE source_id IN (${ids.map(() => '?').join(', ')})`).all(...ids) : [];
      const bound = refs.filter(r => NOTEBOOK_ADAPTERS.has(r.adapter));
      if (bound.length) {
        excludedRefs = new Set(bound.map(r => r.source_ref_id));
        notebookBound = new Set(bound.map(r => r.source_id));
        openRefSources = new Set(refs.filter(r => !NOTEBOOK_ADAPTERS.has(r.adapter) && r.status === 'ACTIVE').map(r => r.source_id));
      }
    } else if (scope.all === true && Object.keys(scope).length === 1) {
      scopeSet = null; // the whole local KG, explicitly
    } else {
      throw new RetrievalError('KG_SCOPE_INVALID', 'scope must be { notebookId } | { sourceIds } | { all: true }');
    }
  }
  return { includePrivate: includePrivate === true, provider, scopeSet, refScope, excludedRefs, notebookBound, openRefSources, scope: scope ?? null, domain };
}

function makeContext(store, visibility, budget, started) {
  const roots = new Map();
  const visibleEntity = new Map();
  const visibleClaim = new Map();
  const allowed = new Map();
  const labels = new Map();
  const refActive = new Map();
  const fullyVisible = new Map();
  const visibleRelation = new Map();
  const { includePrivate, provider, scopeSet } = visibility;
  const domain = visibility.domain ?? 'knowledge';
  return {
    store, budget, started, visibility, includePrivate,
    limitsHit: new Set(),
    timedOut() {
      if (Date.now() - started > budget.timeoutMs) { this.limitsHit.add('timeout'); return true; }
      return false;
    },
    root(id) {
      if (!roots.has(id)) roots.set(id, store.getLogicalRootId(id));
      return roots.get(id);
    },
    /** Evidence / alias provenance: its source AND (in a Notebook scope) its technical ref must be allowed. */
    evidenceAllowed(sourceId, sourceRefId) {
      if (!this.sourceAllowed(sourceId)) return false;
      // KG-7: what was only seen through a removed path (deleted Notebook document, deleted capture) is gone
      if (sourceRefId) {
        if (!refActive.has(sourceRefId)) refActive.set(sourceRefId, store.prepare('SELECT status FROM kg_source_refs WHERE source_ref_id = ?').get(sourceRefId)?.status === 'ACTIVE');
        if (!refActive.get(sourceRefId)) return false;
      }
      // KG-CERT: a sources scope never sees through a Notebook path, nor a logical-only row of a Notebook-bound source
      if (visibility.notebookBound?.has(sourceId) && (!sourceRefId || visibility.excludedRefs.has(sourceRefId))) return false;
      return !visibility.refScope || (Boolean(sourceRefId) && visibility.refScope.has(sourceRefId));
    },
    /** A technical ref of a source that this context may list (Notebook scope: its own refs; sources scope: no Notebook path). */
    refShown(sourceRefId) {
      return (!visibility.refScope || visibility.refScope.has(sourceRefId)) && !visibility.excludedRefs?.has(sourceRefId);
    },
    /** The logical source name may come from a path this context cannot see: match / display the scoped label only. */
    labelRestricted(sourceId) {
      return Boolean(visibility.refScope) || Boolean(visibility.notebookBound?.has(sourceId));
    },
    /** Rows without any source (internal / user rows): unscoped personal-knowledge contexts only (never the code domain). */
    unsourcedAllowed() {
      return !scopeSet && domain === 'knowledge';
    },
    /** An alias / identifier provenance row (source may be null for internal rows). */
    provenanceAllowed(sourceId, sourceRefId) {
      return sourceId ? this.evidenceAllowed(sourceId, sourceRefId) : this.unsourcedAllowed();
    },
    /**
     * Display label of an entity: its canonical name only when one of the
     * provenances of that name is allowed here; otherwise the first allowed
     * alias (a name first seen in a private source never leaks through a
     * visible entity).
     */
    entityLabel(entityId) {
      if (!entityId) return null;
      if (!labels.has(entityId)) {
        const e = store.getEntity(entityId);
        let label = null;
        if (e) {
          const rows = store.prepare(`SELECT alias, normalized_alias, source_id, source_ref_id FROM kg_aliases WHERE entity_id = ? AND status IN ('CONFIRMED', 'PROPOSED') ORDER BY created_at, alias LIMIT 200`).all(entityId);
          const own = rows.filter(r => r.normalized_alias === e.normalized_name);
          if (own.length === 0 ? !scopeSet || rows.length === 0 : own.some(r => this.provenanceAllowed(r.source_id, r.source_ref_id))) label = e.name;
          else label = rows.find(r => this.provenanceAllowed(r.source_id, r.source_ref_id))?.alias ?? 'Entité';
        }
        labels.set(entityId, label);
      }
      return labels.get(entityId);
    },
    nameAllowed(entityId) {
      const e = store.getEntity(entityId);
      return Boolean(e) && this.entityLabel(entityId) === e.name;
    },
    /** Every name / alias / identifier provenance of the logical entity is allowed (semantic text covers them all). */
    entityFullyVisible(rootId) {
      if (!fullyVisible.has(rootId)) {
        const members = store.getLogicalMemberIds(rootId);
        const ph = members.map(() => '?').join(', ');
        const rows = store.prepare(`SELECT source_id, source_ref_id FROM kg_aliases WHERE entity_id IN (${ph}) AND status IN ('CONFIRMED', 'PROPOSED')
          UNION SELECT source_id, source_ref_id FROM kg_entity_identifiers WHERE entity_id IN (${ph}) LIMIT 1000`).all(...members, ...members);
        fullyVisible.set(rootId, rows.every(r => this.provenanceAllowed(r.source_id, r.source_ref_id)));
      }
      return fullyVisible.get(rootId);
    },
    /** Display name of a source: in a Notebook scope, the title known by THAT notebook. */
    sourceLabel(sourceId) {
      const s = store.getSource(sourceId);
      if (!s) return null;
      if (visibility.notebookBound?.has(sourceId)) {
        // the logical name may be a notebook document title: use a path this context may see
        for (const r of store.getSourceRefs(sourceId)) if (r.status === 'ACTIVE' && this.refShown(r.source_ref_id)) return r.provenance?.title || r.original_url || r.source_ref;
        return 'Source';
      }
      if (!visibility.refScope) return s.name;
      for (const r of store.getSourceRefs(sourceId)) if (visibility.refScope.has(r.source_ref_id)) return r.provenance?.title || s.name;
      return s.name;
    },
    sourceAllowed(sourceId) {
      if (!sourceId) return false;
      if (!allowed.has(sourceId)) {
        const s = store.prepare("SELECT privacy, egress_policy, json_extract(metadata, '$.domain') AS domain FROM kg_sources WHERE source_id = ?").get(sourceId);
        allowed.set(sourceId, Boolean(s)
          && sourceDomainOf(s.domain) === domain
          && (includePrivate || s.privacy !== 'PRIVATE')
          && (provider !== 'cloud' || s.egress_policy === 'cloud_allowed')
          && (!scopeSet || scopeSet.has(sourceId))
          // a Notebook-bound source in a sources scope: only through another (non-Notebook) active path
          && (!visibility.notebookBound?.has(sourceId) || visibility.openRefSources.has(sourceId)));
      }
      return allowed.get(sourceId);
    },
    /**
     * KG-8: the provenances (logical source + technical ref) of a relation that
     * this context may see. Same rule as evidence: in a Notebook scope only a
     * ref of THAT notebook counts — a provenance known only at the logical-source
     * level (no ref) is not enough there. Invalidated provenances and inactive
     * sources never count.
     */
    relationProvenance(relationshipId) {
      return store.prepare(`SELECT p.source_id, p.source_ref_id FROM kg_relationship_provenance p JOIN kg_sources s ON s.source_id = p.source_id
          WHERE p.relationship_id = ? AND p.status = 'ACTIVE' AND s.status = 'ACTIVE' ORDER BY p.created_at, p.provenance_id LIMIT 200`).all(relationshipId)
        .filter(r => this.evidenceAllowed(r.source_id, r.source_ref_id));
    },
    /** A relation is visible only through a visible provenance; an unsourced relation (no provenance ever) only unscoped. */
    relationVisible(relationshipId) {
      if (!visibleRelation.has(relationshipId)) {
        let visible = this.relationProvenance(relationshipId).length > 0;
        if (!visible && this.unsourcedAllowed()) {
          const anyProvenance = store.prepare('SELECT 1 FROM kg_relationship_provenance WHERE relationship_id = ? LIMIT 1').get(relationshipId);
          const row = store.prepare('SELECT source_id FROM kg_relationships WHERE relationship_id = ?').get(relationshipId);
          visible = Boolean(row) && !anyProvenance && !row.source_id;
        }
        visibleRelation.set(relationshipId, visible);
      }
      return visibleRelation.get(relationshipId);
    },
    claimVisible(id) {
      if (!visibleClaim.has(id)) {
        const sources = store.prepare(`SELECT DISTINCT e.source_id, e.source_ref_id FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id WHERE ce.claim_id = ?`).all(id);
        let visible;
        if (sources.length) visible = sources.some(s => this.evidenceAllowed(s.source_id, s.source_ref_id));
        else {
          const row = store.prepare('SELECT source_id FROM kg_claims WHERE claim_id = ?').get(id);
          visible = Boolean(row) && (row.source_id ? this.sourceAllowed(row.source_id) : this.unsourcedAllowed());
        }
        visibleClaim.set(id, visible);
      }
      return visibleClaim.get(id);
    },
    /** A logical entity is visible unless it is known ONLY through sources this retrieval may not see. */
    entityVisible(rootId) {
      if (visibleEntity.has(rootId)) return visibleEntity.get(rootId);
      const members = store.getLogicalMemberIds(rootId);
      const ph = members.map(() => '?').join(', ');
      const aliasSources = store.prepare(`SELECT DISTINCT source_id, source_ref_id FROM kg_aliases WHERE entity_id IN (${ph}) AND source_id IS NOT NULL LIMIT 500`).all(...members);
      let visible = aliasSources.length === 0 ? this.unsourcedAllowed() : aliasSources.some(s => this.evidenceAllowed(s.source_id, s.source_ref_id));
      if (!visible) {
        const claims = store.prepare(`SELECT claim_id FROM kg_claims WHERE (entity_id IN (${ph}) OR object_entity_id IN (${ph})) AND status NOT IN ('INVALIDATED') LIMIT 50`).all(...members, ...members);
        visible = claims.some(c => this.claimVisible(c.claim_id));
      }
      visibleEntity.set(rootId, visible);
      return visible;
    },
  };
}

/** Egress constraint of a set of sources: the most restrictive wins. */
function egressOf(store, sourceIds) {
  let egress = 'cloud_allowed';
  for (const id of new Set(sourceIds)) {
    const s = store.prepare('SELECT egress_policy FROM kg_sources WHERE source_id = ?').get(id);
    if (s?.egress_policy === 'local_only') egress = 'local_only';
  }
  return egress;
}

function addSignal(item, signal, value = 1) {
  const weight = SIGNAL_WEIGHTS[signal];
  const contribution = Math.round(weight * value * 1e6) / 1e6;
  const prev = item.ranking.find(r => r.signal === signal);
  if (prev) {
    if (contribution > prev.contribution) Object.assign(prev, { value, contribution });
    return;
  }
  item.ranking.push({ signal, value: Math.round(value * 1e6) / 1e6, weight, contribution });
}

const scoreOf = (item) => Math.round(item.ranking.reduce((s, r) => s + r.contribution, 0) * 1e6) / 1e6;
/** How strongly an entity itself matched (0..1): its best direct signal value, else its graph strength. */
const strengthOf = (entity) => Math.min(1, Math.max(0, ...entity.ranking.filter(r => r.contribution > 0 && !r.signal.startsWith('graph')).map(r => Math.min(1, r.value)), entity.graphStrength ?? 0));

// ── stages ──────────────────────────────────────────────────────────────────

function exactStage(ctx, q, entities, sources) {
  const { store } = ctx;
  if (!q.loose) return;
  // whole query = label or alias
  const whole = store.prepare(`SELECT entity_id, 'name' AS via, NULL AS source_id, NULL AS source_ref_id FROM kg_entities WHERE normalized_name = ? AND status <> 'INVALIDATED'
    UNION SELECT a.entity_id, 'alias', a.source_id, a.source_ref_id FROM kg_aliases a WHERE a.normalized_alias = ? AND a.status IN ('CONFIRMED', 'PROPOSED') LIMIT 50`).all(q.loose, q.loose);
  for (const r of whole) if (matchAllowed(ctx, r)) bumpEntity(ctx, entities, r.entity_id, 'exact_entity_match', 1);
  // stable identifiers written in the query
  for (const token of q.text.split(/\s+/).slice(0, 40)) {
    for (const scheme of ['url', 'doi', 'isbn', 'wikidata', 'orcid', 'domain']) {
      const id = normalizeIdentifier(scheme, token.replace(/[),.;]+$/, ''));
      if (!id) continue;
      for (const e of store.prepare(`SELECT entity_id, source_id, source_ref_id FROM kg_entity_identifiers WHERE scheme = ? AND normalized_value = ? AND status = 'ACTIVE' LIMIT 50`).all(scheme, id.value)) {
        if (ctx.provenanceAllowed(e.source_id, e.source_ref_id)) bumpEntity(ctx, entities, e.entity_id, 'exact_identifier_match', 1);
      }
    }
  }
  // labels / aliases mentioned inside the query (n-grams, longest first)
  const tokens = q.loose.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean).slice(0, 40);
  const grams = [];
  for (let n = Math.min(5, tokens.length); n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const g = tokens.slice(i, i + n).join(' ');
      if (n === 1 && (g.length < 3 || STOPWORDS.has(g))) continue;
      if (g !== q.loose && !grams.some(x => x.g === g)) grams.push({ g, n });
      if (grams.length >= MAX_NGRAMS) break;
    }
    if (grams.length >= MAX_NGRAMS) break;
  }
  if (grams.length) {
    const ph = grams.map(() => '?').join(', ');
    const rows = store.prepare(`SELECT entity_id, normalized_name AS k, 'name' AS via, NULL AS source_id, NULL AS source_ref_id FROM kg_entities WHERE normalized_name IN (${ph}) AND status <> 'INVALIDATED'
      UNION SELECT entity_id, normalized_alias AS k, 'alias', source_id, source_ref_id FROM kg_aliases WHERE normalized_alias IN (${ph}) AND status IN ('CONFIRMED', 'PROPOSED') LIMIT 200`)
      .all(...grams.map(x => x.g), ...grams.map(x => x.g));
    for (const r of rows) {
      if (!matchAllowed(ctx, r)) continue;
      const coverage = Math.min(1, r.k.split(' ').length / Math.max(1, tokens.length) + 0.5);
      bumpEntity(ctx, entities, r.entity_id, 'entity_mention', coverage);
    }
  }
  // whole query = source title
  const expr = buildFtsExpression(q);
  const titles = expr ? store.prepare('SELECT source_id, name FROM kg_sources_fts WHERE kg_sources_fts MATCH ? LIMIT 20').all(expr) : [];
  for (const t of titles) if (looseKey(ctx.labelRestricted(t.source_id) ? (ctx.sourceLabel(t.source_id) ?? '') : t.name) === q.loose) bumpSource(ctx, sources, t.source_id, 'exact_title_match', 1);
}

/** A claim statement embeds its subject / object names: it only matches when those names are allowed here. */
function claimTextAllowed(ctx, claimId) {
  const row = ctx.store.prepare('SELECT entity_id, object_entity_id FROM kg_claims WHERE claim_id = ?').get(claimId);
  return Boolean(row) && ctx.nameAllowed(row.entity_id) && (!row.object_entity_id || ctx.nameAllowed(row.object_entity_id));
}

/** A name / alias match only counts through a provenance this retrieval may see (no oracle on private aliases). */
function matchAllowed(ctx, r) {
  return r.via === 'name' ? ctx.nameAllowed(r.entity_id) : ctx.provenanceAllowed(r.source_id, r.source_ref_id);
}

function ftsStage(ctx, q, entities, claims, sources) {
  const { store } = ctx;
  const expr = buildFtsExpression(q);
  if (!expr) return;
  const norm = (rows) => {
    const best = Math.min(...rows.map(r => r.rank), -1e-9);
    return rows.map(r => ({ ...r, s: Math.max(0.05, Math.min(1, r.rank / best)) }));
  };
  for (const r of norm(store.prepare('SELECT entity_id, rank FROM kg_entities_fts WHERE kg_entities_fts MATCH ? ORDER BY rank LIMIT 50').all(expr))) {
    if (!ctx.nameAllowed(r.entity_id)) continue;
    bumpEntity(ctx, entities, r.entity_id, 'fts_match', r.s);
  }
  for (const r of norm(store.prepare('SELECT claim_id, rank FROM kg_claims_fts WHERE kg_claims_fts MATCH ? ORDER BY rank LIMIT 50').all(expr))) {
    if (!claimTextAllowed(ctx, r.claim_id)) continue;
    bumpClaim(ctx, claims, r.claim_id, 'fts_match', r.s);
  }
  // evidence text → the claims it is ACTIVELY linked to (visibility checked per claim / source)
  const evRows = store.prepare('SELECT evidence_id, source_id, rank FROM kg_evidence_fts WHERE kg_evidence_fts MATCH ? ORDER BY rank LIMIT 50').all(expr);
  for (const r of norm(evRows)) {
    const ref = store.prepare('SELECT source_ref_id FROM kg_evidence WHERE evidence_id = ?').get(r.evidence_id)?.source_ref_id ?? null;
    if (!ctx.evidenceAllowed(r.source_id, ref)) continue;
    const links = store.prepare(`SELECT ce.claim_id FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
      WHERE ce.evidence_id = ? AND ce.status = 'ACTIVE' AND e.status = 'ACTIVE' LIMIT 20`).all(r.evidence_id);
    for (const l of links) bumpClaim(ctx, claims, l.claim_id, 'fts_match', r.s);
  }
  for (const r of norm(store.prepare('SELECT source_id, rank FROM kg_sources_fts WHERE kg_sources_fts MATCH ? ORDER BY rank LIMIT 20').all(expr))) {
    // a Notebook scope matches a shared logical source only through the title THIS notebook knows
    if (ctx.labelRestricted(r.source_id) && !scopedLabelMatches(ctx, r.source_id, q)) continue;
    bumpSource(ctx, sources, r.source_id, 'fts_match', r.s);
  }
}

function bumpEntity(ctx, entities, entityId, signal, value) {
  const root = ctx.root(entityId);
  if (!root || !ctx.entityVisible(root)) return null;
  let item = entities.get(root);
  if (!item) {
    item = { id: root, ranking: [], matchedVia: new Set(), graphDistance: signal.startsWith('graph') ? null : 0 };
    entities.set(root, item);
  }
  if (entityId !== root) item.matchedVia.add(entityId);
  if (!signal.startsWith('graph')) item.graphDistance = 0;
  addSignal(item, signal, value);
  return item;
}

function bumpClaim(ctx, claims, claimId, signal, value) {
  if (!ctx.claimVisible(claimId)) return null;
  let item = claims.get(claimId);
  if (!item) {
    item = { id: claimId, ranking: [] };
    claims.set(claimId, item);
  }
  addSignal(item, signal, value);
  return item;
}

function scopedLabelMatches(ctx, sourceId, q) {
  const label = looseKey(ctx.sourceLabel(sourceId) ?? '');
  return q.loose.split(' ').filter(Boolean).some(t => label.split(' ').includes(t));
}

function bumpSource(ctx, sources, sourceId, signal, value) {
  const s = ctx.store.getSource(sourceId);
  if (!s || s.status !== 'ACTIVE' || !ctx.sourceAllowed(sourceId)) return null;
  let item = sources.get(sourceId);
  if (!item) {
    item = { id: sourceId, ranking: [] };
    sources.set(sourceId, item);
  }
  addSignal(item, signal, value);
  return item;
}

async function semanticStage(ctx, q, semantic, entities, claims) {
  if (!semantic) return { state: 'UNAVAILABLE', reason: 'NO_SEMANTIC_LAYER' };
  const r = await semantic.search(q.searchText || q.text, { limit: 40 });
  for (const hit of r.results ?? []) {
    if (hit.similarity < SEMANTIC_FLOOR) continue;
    // the semantic text of an entity covers all its aliases: only fully visible entities answer semantically
    if (hit.itemType === 'entity') { if (ctx.entityFullyVisible(ctx.root(hit.id))) bumpEntity(ctx, entities, hit.id, 'semantic_similarity', hit.similarity); }
    else if (hit.itemType === 'claim') { if (claimTextAllowed(ctx, hit.id)) bumpClaim(ctx, claims, hit.id, 'semantic_similarity', hit.similarity); }
  }
  return { state: r.state, ...(r.reason ? { reason: r.reason } : {}), hits: (r.results ?? []).length };
}

/** Bounded BFS from the best matched entities (relationships + entity→entity claims). */
function graphStage(ctx, entities, claims, graphStats) {
  const { store, budget } = ctx;
  const seeds = [...entities.values()].filter(e => e.graphDistance === 0)
    .sort((a, b) => scoreOf(b) - scoreOf(a) || (a.id < b.id ? -1 : 1)).slice(0, budget.maxSeeds);
  const visited = new Set(seeds.map(s => s.id));
  let frontier = seeds.map(s => s.id);
  let edges = 0;
  for (let depth = 1; depth <= budget.maxDepth && frontier.length; depth++) {
    const next = [];
    for (const nodeId of frontier) {
      if (ctx.timedOut()) return;
      if (visited.size >= budget.maxNodes) { ctx.limitsHit.add('max_nodes'); return; }
      if (edges >= budget.maxEdges) { ctx.limitsHit.add('max_edges'); return; }
      const members = store.getLogicalMemberIds(nodeId);
      const ph = members.map(() => '?').join(', ');
      const cap = Math.min(budget.maxFanout, budget.maxEdges - edges) + 1;
      const rels = store.prepare(`SELECT r.relationship_id, r.source_entity_id AS a, r.target_entity_id AS b FROM kg_relationships r
          WHERE (r.source_entity_id IN (${ph}) OR r.target_entity_id IN (${ph})) AND r.is_active = 1 ORDER BY r.relationship_id LIMIT ?`)
        .all(...members, ...members, cap);
      const viaClaims = store.prepare(`SELECT claim_id, entity_id AS a, object_entity_id AS b FROM kg_claims
          WHERE (entity_id IN (${ph}) OR object_entity_id IN (${ph})) AND object_entity_id IS NOT NULL AND status NOT IN ('INVALIDATED', 'SUPERSEDED')
          ORDER BY claim_id LIMIT ?`).all(...members, ...members, cap);
      if (rels.length + viaClaims.length >= cap) ctx.limitsHit.add('fanout');
      const neighbours = [];
      for (const r of rels) {
        // a relation is followed only through a provenance visible to this retrieval (KG-8: source AND technical ref)
        if (!ctx.relationVisible(r.relationship_id)) continue;
        neighbours.push({ other: members.includes(r.a) ? r.b : r.a, claimId: null });
      }
      for (const c of viaClaims) {
        if (!ctx.claimVisible(c.claim_id)) continue;
        neighbours.push({ other: members.includes(c.a) ? c.b : c.a, claimId: c.claim_id });
      }
      for (const nb of neighbours.slice(0, budget.maxFanout)) {
        if (edges >= budget.maxEdges) { ctx.limitsHit.add('max_edges'); break; }
        edges++;
        const root = ctx.root(nb.other);
        if (!root) continue;
        if (nb.claimId) bumpClaim(ctx, claims, nb.claimId, depth === 1 ? 'graph_1_hop' : 'graph_2_hop', 1);
        if (visited.has(root)) continue; // cycle / already reached
        if (visited.size >= budget.maxNodes) { ctx.limitsHit.add('max_nodes'); break; }
        visited.add(root);
        const item = bumpEntity(ctx, entities, root, depth === 1 ? 'graph_1_hop' : 'graph_2_hop', 1);
        if (item) {
          if (item.graphDistance === null || item.graphDistance > depth) item.graphDistance = depth;
          item.graphStrength = Math.max(item.graphStrength ?? 0, depth === 1 ? 0.5 : 0.25);
          next.push(root);
        }
      }
    }
    frontier = next;
    if (depth === budget.maxDepth && frontier.length) ctx.limitsHit.add('max_depth');
  }
  graphStats.nodes = visited.size;
  graphStats.edges = edges;
}

/** Claims about the matched / reached entities, with their own signals. */
function claimStage(ctx, entities, claims) {
  const { store } = ctx;
  // only the best matched / reached entities feed claims (bounded work)
  const top = [...entities.values()].sort((a, b) => scoreOf(b) - scoreOf(a) || (a.id < b.id ? -1 : 1)).slice(0, ctx.budget.maxEntities + ctx.budget.maxSeeds);
  for (const e of top) {
    if (ctx.timedOut()) return;
    const members = store.getLogicalMemberIds(e.id);
    const ph = members.map(() => '?').join(', ');
    const rows = store.prepare(`SELECT claim_id FROM kg_claims WHERE (entity_id IN (${ph}) OR object_entity_id IN (${ph})) AND status <> 'INVALIDATED'
      ORDER BY CASE status WHEN 'SUPPORTED' THEN 0 WHEN 'DISPUTED' THEN 1 WHEN 'ASSERTED' THEN 2 WHEN 'HYPOTHESIS' THEN 3 ELSE 4 END, claim_id LIMIT ?`)
      .all(...members, ...members, CLAIMS_PER_ENTITY);
    const strength = strengthOf(e);
    for (const r of rows) bumpClaim(ctx, claims, r.claim_id, 'claim_about_matched_entity', strength);
  }
}

function temporalAccepts(row, intent, now) {
  const from = row.valid_from;
  const to = row.valid_to;
  const undated = !from && !to;
  switch (intent.kind) {
    case 'any': return { ok: row.status !== 'SUPERSEDED', basis: undated ? 'undated' : 'dated' };
    case 'current':
    case 'at': {
      if (row.status === 'SUPERSEDED') return { ok: false };
      const t = intent.kind === 'current' ? now : intent.date;
      if (undated) return { ok: true, basis: 'undated' };
      return { ok: (!from || from <= t) && (!to || to > t), basis: 'dated', explicit: true };
    }
    case 'during':
      if (row.status === 'SUPERSEDED') return { ok: false };
      if (undated) return { ok: true, basis: 'undated' };
      return { ok: (!from || from < intent.to) && (!to || to > intent.from), basis: 'dated', explicit: true };
    case 'past':
      // ended periods and superseded history; undated claims have no known past
      if (row.status === 'SUPERSEDED') return { ok: true, basis: undated ? 'superseded' : 'dated', explicit: !undated };
      return { ok: Boolean(to && to <= now), basis: 'dated', explicit: true };
    case 'before':
      if (undated) return { ok: false };
      return { ok: Boolean(from ? from < intent.date : to && to <= intent.date), basis: 'dated', explicit: true };
    case 'after':
      if (undated) return { ok: false };
      return { ok: Boolean(to ? to > intent.date : from && from >= intent.date) || (!to && Boolean(from)), basis: 'dated', explicit: true };
    default: return { ok: true, basis: undated ? 'undated' : 'dated' };
  }
}

function claimSignals(ctx, item, row, intent, now, q) {
  const tm = temporalAccepts(row, intent, now);
  if (!tm.ok) return false;
  item.temporalBasis = tm.basis;
  const qTerms = q ? q.terms.map(t => looseKey(t.token)) : [];
  if (row.predicate && qTerms.some(t => (PREDICATE_LEXICON[row.predicate] ?? []).includes(t))) addSignal(item, 'predicate_match', 1);
  if (qTerms.length) {
    const text = looseKey(ctx.store.prepare(`SELECT group_concat(e.content, ' ') AS t FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
        WHERE ce.claim_id = ? AND ce.status = 'ACTIVE' AND e.status = 'ACTIVE' AND e.source_id IN (SELECT source_id FROM kg_evidence WHERE evidence_id = e.evidence_id)`).get(row.claim_id)?.t ?? '');
    const visibleText = text && ctx.claimVisible(row.claim_id) ? text : '';
    const covered = qTerms.filter(t => visibleText.includes(t)).length;
    if (covered > 0) addSignal(item, 'evidence_text_match', covered / qTerms.length);
  }
  // quality signals, scaled by relevance (an irrelevant claim stays irrelevant)
  const relevance = Math.min(1, item.ranking.filter(r => RELEVANCE_SIGNALS.has(r.signal)).reduce((sum, r) => sum + r.contribution, 0));
  if (tm.explicit && intent.kind !== 'any') addSignal(item, 'temporal_match', relevance);
  if (row.status === 'SUPPORTED') addSignal(item, 'claim_supported', relevance);
  if (row.status === 'DISPUTED') addSignal(item, 'claim_disputed', relevance);
  if (row.extraction_method === 'USER') addSignal(item, 'claim_user_asserted', relevance);
  const active = ctx.store.prepare(`SELECT e.source_id, e.source_ref_id FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
      JOIN kg_sources s ON s.source_id = e.source_id
      WHERE ce.claim_id = ? AND ce.status = 'ACTIVE' AND ce.stance = 'SUPPORTS' AND e.status = 'ACTIVE' AND s.status = 'ACTIVE'`).all(row.claim_id)
    .filter(r => ctx.evidenceAllowed(r.source_id, r.source_ref_id)).length;
  if (active > 0) addSignal(item, 'evidence_count', Math.min(3, active) * relevance);
  if (row.source_confidence !== null && row.source_confidence !== undefined) addSignal(item, 'source_confidence', row.source_confidence * relevance);
  if (row.extraction_method === 'MODEL_PROPOSAL' && row.model_confidence !== null) addSignal(item, 'model_confidence', row.model_confidence * relevance);
  return true;
}

// ── citations ───────────────────────────────────────────────────────────────

/** Original-source citations of a claim: active evidence from visible, active sources only. */
export function claimCitations(store, claimId, { includePrivate = false, limit = 3, sourceAllowed = null, evidenceAllowed = null, sourceLabel = null } = {}) {
  const allowedSource = sourceAllowed ?? ((id) => includePrivate || store.getSource(id)?.privacy !== 'PRIVATE');
  const allowed = evidenceAllowed ?? ((sourceId) => allowedSource(sourceId));
  return store.prepare(`
    SELECT e.evidence_id, ce.stance, e.source_id, s.name AS source_name, s.source_type, s.privacy, s.egress_policy, s.canonical_url,
           e.source_ref_id, r.adapter, r.source_ref, r.input_path, r.version_ref, r.original_url,
           e.locator_kind, e.locator_ref, e.chunk_id, e.message_id, e.page, e.section, e.char_start, e.char_end, e.excerpt_hash, e.content
    FROM kg_claim_evidence ce
    JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
    JOIN kg_sources s ON s.source_id = e.source_id
    LEFT JOIN kg_source_refs r ON r.source_ref_id = e.source_ref_id
    WHERE ce.claim_id = ? AND ce.status = 'ACTIVE' AND e.status = 'ACTIVE' AND s.status = 'ACTIVE'
    ORDER BY CASE ce.stance WHEN 'SUPPORTS' THEN 0 ELSE 1 END, e.created_at, e.evidence_id
    LIMIT 200`).all(claimId).filter(c => allowed(c.source_id, c.source_ref_id)).slice(0, limit).map(c => ({
    evidenceId: c.evidence_id,
    stance: c.stance,
    sourceId: c.source_id,
    sourceName: sourceLabel ? sourceLabel(c.source_id) : c.source_name,
    sourceType: c.source_type,
    privacy: c.privacy,
    egress: c.egress_policy,
    canonicalUrl: c.canonical_url,
    sourceRef: c.source_ref_id ? { sourceRefId: c.source_ref_id, adapter: c.adapter, ref: c.source_ref, inputPath: c.input_path, versionRef: c.version_ref, originalUrl: c.original_url } : null,
    locator: { kind: c.locator_kind, ref: c.locator_ref, chunkId: c.chunk_id, messageId: c.message_id, page: c.page, section: c.section, charStart: c.char_start, charEnd: c.char_end },
    excerptHash: c.excerpt_hash,
    snippet: String(c.content ?? '').slice(0, SNIPPET_CHARS),
  }));
}

function entityCitations(ctx, rootId, limit = 2) {
  const { store } = ctx;
  const members = store.getLogicalMemberIds(rootId);
  const ph = members.map(() => '?').join(', ');
  return store.prepare(`SELECT DISTINCT a.source_id, s.name, s.source_type, s.privacy, s.egress_policy, a.source_ref_id, r.adapter, r.source_ref
      FROM kg_aliases a JOIN kg_sources s ON s.source_id = a.source_id LEFT JOIN kg_source_refs r ON r.source_ref_id = a.source_ref_id
      WHERE a.entity_id IN (${ph}) AND s.status = 'ACTIVE'
      ORDER BY a.source_id, a.source_ref_id LIMIT 200`).all(...members).filter(c => ctx.evidenceAllowed(c.source_id, c.source_ref_id)).slice(0, limit)
    .map(c => ({ sourceId: c.source_id, sourceName: ctx.sourceLabel(c.source_id), sourceType: c.source_type, privacy: c.privacy, egress: c.egress_policy, sourceRef: c.source_ref_id ? { sourceRefId: c.source_ref_id, adapter: c.adapter, ref: c.source_ref } : null, locator: { kind: 'SOURCE' } }));
}

// ── main ────────────────────────────────────────────────────────────────────

/**
 * Hybrid retrieval. Never writes. `semantic` is an optional KgSemanticIndex.
 * @returns {Promise<object>} { query, mode, temporal, semantic, results, context, stats }
 */
export async function retrieveKnowledge(store, {
  query, mode = 'hybrid', temporal = null, includePrivate = false, provider = 'local', scope = null, budget = {}, semantic = null, assembleContext = true, now = null,
  minRelativeScore = DEFAULT_MIN_RELATIVE_SCORE, domain = 'knowledge',
} = {}) {
  const started = Date.now();
  if (!RETRIEVAL_MODES.includes(mode)) throw new RetrievalError('KG_MODE_INVALID', `mode must be one of ${RETRIEVAL_MODES.join(', ')}`);
  const b = resolveBudget(budget);
  const q = normalizeQuery(query);
  const intent = normalizeTemporal(temporal, q.temporal);
  const today = normalizeKgDate(now ?? new Date().toISOString().slice(0, 10));
  const timings = {};
  const lap = (name, t0) => { timings[name] = Math.round((performance.now() - t0) * 100) / 100; };
  const visibility = resolveVisibility(store, { includePrivate, provider, scope, domain });
  const base = { query: { text: q.text, truncated: q.truncated, terms: q.terms.map(t => t.token) }, mode, temporal: intent, visibility: { includePrivate: visibility.includePrivate, provider, scope: visibility.scope } };
  if (!/[\p{L}\p{N}]/u.test(q.searchText) && !/[\p{L}\p{N}]/u.test(q.text)) {
    return { ...base, error: 'QUERY_EMPTY', semantic: { state: 'NOT_USED' }, results: [], context: emptyContext(b), stats: { timings, limitsHit: [] } };
  }
  const ctx = makeContext(store, visibility, b, started);
  const entities = new Map();
  const claims = new Map();
  const sources = new Map();
  let semanticState = { state: 'NOT_USED' };
  const graphStats = { nodes: 0, edges: 0 };

  let t = performance.now();
  if (['hybrid', 'exact', 'graph'].includes(mode)) exactStage(ctx, q, entities, sources);
  lap('exact', t);
  t = performance.now();
  if (['hybrid', 'fts'].includes(mode)) ftsStage(ctx, q, entities, claims, sources);
  lap('fts', t);
  t = performance.now();
  if (['hybrid', 'semantic'].includes(mode)) semanticState = await semanticStage(ctx, q, semantic, entities, claims);
  lap('semantic', t);
  t = performance.now();
  if (['hybrid', 'graph'].includes(mode) && !ctx.timedOut()) graphStage(ctx, entities, claims, graphStats);
  lap('graph', t);
  t = performance.now();
  if (mode !== 'fts' && mode !== 'semantic' && !ctx.timedOut()) claimStage(ctx, entities, claims);
  if (mode === 'graph') {
    // graph-only: what the graph adds — entities reached by traversal and the claims linking them
    for (const [id, e] of entities) if (e.graphDistance === 0) entities.delete(id);
    for (const [id, c] of claims) if (!c.ranking.some(r => r.signal.startsWith('graph'))) claims.delete(id);
    sources.clear();
  }

  // claim rows, temporal filter, claim-level signals — on the best candidates only
  const candidateLimit = Math.max(CANDIDATE_CLAIMS_MIN, b.maxClaims * 5);
  if (claims.size > candidateLimit) {
    const keepIds = new Set([...claims.values()].sort((x, y) => scoreOf(y) - scoreOf(x) || (x.id < y.id ? -1 : 1)).slice(0, candidateLimit).map(c => c.id));
    for (const id of [...claims.keys()]) if (!keepIds.has(id)) claims.delete(id);
    ctx.limitsHit.add('claim_candidates');
  }
  const claimRows = new Map();
  for (const [id, item] of claims) {
    const row = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(id);
    if (!row || row.status === 'INVALIDATED' || !claimSignals(ctx, item, row, intent, today, q)) { claims.delete(id); continue; }
    claimRows.set(id, row);
  }
  // contradictions: bring every visible counterpart of an OPEN conflict into the same group
  const groups = new Map();
  for (const id of [...claims.keys()]) {
    const conflicts = store.prepare("SELECT * FROM kg_claim_conflicts WHERE (claim_a_id = ? OR claim_b_id = ?) AND status = 'OPEN'").all(id, id);
    for (const k of conflicts) {
      const other = k.claim_a_id === id ? k.claim_b_id : k.claim_a_id;
      const otherRow = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(other);
      if (!otherRow || ['INVALIDATED', 'SUPERSEDED'].includes(otherRow.status) || !ctx.claimVisible(other)) continue;
      if (!claims.has(other)) {
        const item = { id: other, ranking: [], addedAsCounterpart: true };
        claims.set(other, item);
        claimRows.set(other, otherRow);
        claimSignals(ctx, item, otherRow, { kind: 'any' }, today, q);
      }
      const ga = groups.get(id) ?? groups.get(other) ?? `grp_${k.conflict_id}`;
      for (const member of [id, other]) groups.set(member, ga);
    }
  }
  lap('claims_temporal_privacy', t);

  // ranking
  t = performance.now();
  const rank = (list) => list.map(i => ({ ...i, score: scoreOf(i) })).sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
  for (const e of entities.values()) {
    const ent = store.getEntity(e.id);
    if (ent?.status === 'AMBIGUOUS') addSignal(e, 'ambiguous_entity', 1);
  }
  const rankedEntities = rank([...entities.values()]);
  const rankedClaims = rank([...claims.values()]);
  const groupScore = new Map();
  for (const c of rankedClaims) {
    const g = groups.get(c.id);
    if (g) groupScore.set(g, Math.max(groupScore.get(g) ?? -Infinity, c.score));
  }
  const rankedSources = rank([...sources.values()]);
  lap('ranking', t);

  // budget + presentation
  t = performance.now();
  // relative floor: weak tail results (e.g. distant graph neighbours) are dropped; a contradiction group
  // is judged by its best member, so one side is never dropped without the other
  const floor = Math.max(0, Math.min(1, Number(minRelativeScore) || 0));
  const top = Math.max(0, ...rankedEntities.map(e => e.score), ...rankedClaims.map(c => (groups.has(c.id) ? groupScore.get(groups.get(c.id)) : c.score)), ...rankedSources.map(x => x.score));
  const keep = (score) => top <= 0 || score >= floor * top;
  const droppedBelowFloor = rankedEntities.length + rankedClaims.length + rankedSources.length;
  const fEntities = rankedEntities.filter(e => keep(e.score));
  const fClaims = rankedClaims.filter(c => keep(groups.has(c.id) ? groupScore.get(groups.get(c.id)) : c.score));
  const fSources = rankedSources.filter(x => keep(x.score));
  const belowFloor = droppedBelowFloor - fEntities.length - fClaims.length - fSources.length;
  const out = assemble(ctx, { rankedEntities: fEntities, rankedClaims: fClaims, rankedSources: fSources, claimRows, groups, groupScore, today, assembleContext });
  lap('context', t);
  return {
    ...base,
    semantic: semanticState,
    results: out.results,
    context: out.context,
    stats: {
      timings, totalMs: Date.now() - started,
      candidates: { entities: entities.size, claims: claims.size, sources: sources.size, belowRelativeFloor: belowFloor },
      graph: graphStats, limitsHit: [...ctx.limitsHit], budget: b,
    },
  };
}

function emptyContext(b) {
  return { text: '', chars: 0, counts: { entities: 0, claims: 0, evidences: 0, snippets: 0, sources: 0 }, citations: [], truncated: [], budget: b };
}

function presentEntity(ctx, e) {
  const { store } = ctx;
  const ent = store.getEntity(e.id);
  const members = store.getLogicalMemberIds(e.id);
  const ph = members.map(() => '?').join(', ');
  const aliases = store.prepare(`SELECT DISTINCT a.alias, a.source_id, a.source_ref_id FROM kg_aliases a LEFT JOIN kg_sources s ON s.source_id = a.source_id
      WHERE a.entity_id IN (${ph}) AND a.status IN ('CONFIRMED', 'PROPOSED')
      ORDER BY a.alias LIMIT 200`).all(...members).filter(r => (r.source_id ? ctx.evidenceAllowed(r.source_id, r.source_ref_id) : ctx.unsourcedAllowed())).map(r => r.alias).filter((a, i, all) => all.indexOf(a) === i).slice(0, 8);
  let ambiguity = null;
  if (ent.status === 'AMBIGUOUS') {
    const candidates = store.prepare(`SELECT target_entity_id, method FROM kg_entity_resolutions WHERE source_entity_id = ? AND decision = 'PROPOSED' ORDER BY created_at LIMIT 10`).all(e.id)
      .filter(r => ctx.entityVisible(ctx.root(r.target_entity_id)))
      .map(r => ({ entityId: r.target_entity_id, label: ctx.entityLabel(r.target_entity_id), method: r.method }));
    ambiguity = { status: 'AMBIGUOUS', candidates };
  }
  return {
    resultType: 'entity',
    id: e.id,
    label: ctx.entityLabel(e.id),
    entityType: ent.entity_type,
    status: ent.status,
    aliases,
    memberIds: members,
    graphDistance: e.graphDistance,
    score: e.score,
    whyMatched: e.ranking.filter(r => r.contribution !== 0).map(r => r.signal),
    ranking: e.ranking,
    ambiguity,
    citations: entityCitations(ctx, e.id),
  };
}

function presentClaim(ctx, c, row, groups, groupScore, today) {
  const { store } = ctx;
  const subject = store.getEntity(row.entity_id);
  const object = row.object_entity_id ? store.getEntity(row.object_entity_id) : null;
  const value = row.value_json ? parseJson(row.value_json, null) : null;
  const group = groups.get(c.id) ?? null;
  const counterpartIds = group ? [...groups.entries()].filter(([id, g]) => g === group && id !== c.id).map(([id]) => id) : [];
  return {
    resultType: 'claim',
    id: c.id,
    subject: { entityId: row.entity_id, label: subject ? ctx.entityLabel(row.entity_id) : null, status: subject?.status ?? null },
    predicate: row.predicate,
    object: object ? { kind: 'entity', entityId: object.entity_id, label: ctx.entityLabel(object.entity_id) } : (value ? { kind: 'value', value } : { kind: 'statement', text: row.statement }),
    status: row.status,
    extractionMethod: row.extraction_method,
    modelConfidence: row.model_confidence,
    sourceConfidence: row.source_confidence,
    temporal: { observedAt: row.observed_at, validFrom: row.valid_from, validTo: row.valid_to, temporalState: temporalState({ validFrom: row.valid_from, validTo: row.valid_to }, today), basis: c.temporalBasis ?? null },
    contradiction: group ? { status: 'OPEN_CONFLICT', groupId: group, counterpartIds } : { status: row.status === 'DISPUTED' ? 'CONTRADICTED_BY_EVIDENCE' : 'NONE', groupId: null, counterpartIds: [] },
    score: group ? Math.max(c.score, groupScore.get(group) ?? c.score) : c.score,
    ownScore: c.score,
    whyMatched: [...c.ranking.filter(r => r.contribution !== 0).map(r => r.signal), ...(c.addedAsCounterpart ? ['contradiction_counterpart'] : [])],
    ranking: c.ranking,
    citations: claimCitations(store, c.id, { evidenceAllowed: (s, r) => ctx.evidenceAllowed(s, r), sourceLabel: (id) => ctx.sourceLabel(id) }),
  };
}

/** Deterministic budget: entities, claim units (a contradiction group is one unit), evidences, chars. */
function assemble(ctx, { rankedEntities, rankedClaims, rankedSources, claimRows, groups, groupScore, today, assembleContext }) {
  const b = ctx.budget;
  const truncated = [];
  const results = [];
  const entityResults = rankedEntities.slice(0, b.maxEntities).map(e => presentEntity(ctx, e));
  if (rankedEntities.length > b.maxEntities) truncated.push({ kind: 'entities', dropped: rankedEntities.length - b.maxEntities });

  // claim units
  const units = [];
  const seen = new Set();
  for (const c of rankedClaims) {
    if (seen.has(c.id)) continue;
    const g = groups.get(c.id);
    const members = g ? rankedClaims.filter(x => groups.get(x.id) === g) : [c];
    members.forEach(m => seen.add(m.id));
    units.push({ score: g ? groupScore.get(g) : c.score, members, group: g ?? null });
  }
  units.sort((x, y) => y.score - x.score || (x.members[0].id < y.members[0].id ? -1 : 1));
  const claimResults = [];
  for (const u of units) {
    if (claimResults.length + u.members.length > b.maxClaims) { truncated.push({ kind: u.group ? 'contradiction_group' : 'claim', ids: u.members.map(m => m.id), reason: 'maxClaims' }); continue; }
    for (const m of u.members) claimResults.push(presentClaim(ctx, m, claimRows.get(m.id), groups, groupScore, today));
  }
  const sourceResults = rankedSources.slice(0, b.maxSources).map(s => {
    const src = ctx.store.getSource(s.id);
    const label = ctx.sourceLabel(s.id);
    return { resultType: 'source', id: s.id, label, sourceType: src.source_type, canonicalUrl: src.canonical_url, score: s.score, whyMatched: s.ranking.filter(r => r.contribution !== 0).map(r => r.signal), ranking: s.ranking,
      citations: [{ sourceId: s.id, sourceName: label, sourceType: src.source_type, privacy: src.privacy, egress: src.egress_policy, sourceRef: null, locator: { kind: 'SOURCE' } }] };
  });
  results.push(...entityResults, ...claimResults, ...sourceResults);
  for (const r of results) r.egress = egressOf(ctx.store, (r.citations ?? []).map(c => c.sourceId));
  results.sort((x, y) => y.score - x.score || (x.resultType < y.resultType ? -1 : x.resultType > y.resultType ? 1 : (x.id < y.id ? -1 : 1)));
  if (!assembleContext) return { results, context: { ...emptyContext(b), truncated } };

  // context text with numbered original-source citations, evidence + char budgets
  const lines = [];
  const citations = [];
  const citationIndex = new Map();
  let chars = 0;
  let evidences = 0;
  let snippets = 0;
  const push = (line) => {
    if (chars + line.length + 1 > b.maxChars) return false;
    lines.push(line);
    chars += line.length + 1;
    return true;
  };
  const cite = (c) => {
    const key = c.evidenceId ?? `${c.sourceId}|${c.sourceRef?.sourceRefId ?? ''}`;
    if (!citationIndex.has(key)) {
      citationIndex.set(key, citations.length + 1);
      citations.push({ n: citations.length + 1, ...c });
    }
    return `[S${citationIndex.get(key)}]`;
  };
  let entitiesInContext = 0;
  for (const e of entityResults) {
    const line = `[E] ${e.label} (${e.entityType})${e.aliases.length ? ` — aliases: ${e.aliases.join(', ')}` : ''}${e.ambiguity ? ` — AMBIGUOUS, candidates: ${e.ambiguity.candidates.map(x => x.label).join(' | ')}` : ''}`;
    if (!push(line)) { truncated.push({ kind: 'chars', at: 'entity', id: e.id }); break; }
    entitiesInContext++;
  }
  // claims: a contradiction group goes in whole or not at all
  const claimsByGroup = [];
  for (const c of claimResults) {
    const last = claimsByGroup[claimsByGroup.length - 1];
    if (c.contradiction.groupId && last && last.group === c.contradiction.groupId) last.items.push(c);
    else claimsByGroup.push({ group: c.contradiction.groupId, items: [c] });
  }
  let claimsInContext = 0;
  for (const unit of claimsByGroup) {
    const block = [];
    let unitEvidences = 0;
    let unitSnippets = 0;
    const unitCitations = [];
    for (const c of unit.items) {
      const obj = c.object.kind === 'entity' ? c.object.label : c.object.kind === 'value' ? `${c.object.value.value}${c.object.value.unit ? ` ${c.object.value.unit}` : ''}` : c.object.text;
      const dates = c.temporal.validFrom || c.temporal.validTo ? `valid ${c.temporal.validFrom ?? '…'} → ${c.temporal.validTo ?? '…'}` : 'no validity dates';
      const cs = c.citations.slice(0, Math.max(0, Math.min(3, b.maxEvidences - evidences - unitEvidences)));
      unitEvidences += cs.length;
      unitCitations.push(cs);
      block.push({ c, head: `[C] ${c.subject.label} — ${c.predicate ?? 'statement'} — ${obj} | ${c.status} | ${dates} | observed ${c.temporal.observedAt ?? 'unknown'}${c.contradiction.groupId ? ' | CONTRADICTED by another claim in this context' : ''}`, cs });
    }
    const pending = [];
    for (const { head, cs } of block) {
      const markers = cs.map(x => cite({ ...x }));
      pending.push(`${head} ${markers.join('')}`);
      for (const x of cs) {
        if (snippets + unitSnippets >= b.maxSnippets) break;
        pending.push(`    ${x.stance === 'CONTRADICTS' ? 'contradicting' : 'supporting'} ${markers[cs.indexOf(x)]} "${x.snippet.replace(/\s+/g, ' ').slice(0, 200)}" — ${x.sourceName}${x.locator.page ? `, p. ${x.locator.page}` : ''}${x.locator.chunkId ? `, chunk ${x.locator.chunkId}` : ''}${x.locator.messageId ? `, message ${x.locator.messageId}` : ''}`);
        unitSnippets++;
      }
    }
    const size = pending.reduce((s, l) => s + l.length + 1, 0);
    if (chars + size > b.maxChars || evidences + unitEvidences > b.maxEvidences) {
      truncated.push({ kind: unit.group ? 'contradiction_group' : 'claim', ids: unit.items.map(i => i.id), reason: chars + size > b.maxChars ? 'maxChars' : 'maxEvidences' });
      continue;
    }
    pending.forEach(push);
    evidences += unitEvidences;
    snippets += unitSnippets;
    claimsInContext += unit.items.length;
  }
  // only citations actually referenced by kept lines
  const used = new Set(lines.join('\n').match(/\[S\d+\]/g) ?? []);
  const keptCitations = citations.filter(c => used.has(`[S${c.n}]`));
  return {
    results,
    context: {
      text: lines.join('\n'),
      chars,
      counts: { entities: entitiesInContext, claims: claimsInContext, evidences, snippets, sources: new Set(keptCitations.map(c => c.sourceId)).size },
      citations: keptCitations,
      // the assembled context may only go to a cloud model when every cited source allows it
      egress: egressOf(ctx.store, keptCitations.map(c => c.sourceId)),
      truncated,
      budget: b,
    },
  };
}

/**
 * Notebook + KG (document level): reciprocal-rank fusion of the Notebook ranking
 * and the documents cited by KG results. Pure; Notebook is only read.
 */
export function fuseNotebookAndKg(notebookDocIds, kgDocIds, { k = 60, kgWeight = 1, notebookWeight = 1 } = {}) {
  const scores = new Map();
  notebookDocIds.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + notebookWeight / (k + i + 1)));
  kgDocIds.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + kgWeight / (k + i + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
}

export { KG_DEFAULT_LIMITS };

/** Visibility context shared with the KG-6 view API (same rules as retrieval). */
export function createRetrievalContext(store, visibility, budget = resolveBudget({}), started = Date.now()) {
  return makeContext(store, visibility, budget, started);
}
