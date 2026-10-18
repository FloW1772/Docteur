// Knowledge Graph V1 — KG-8 consumer API (read-only, bounded, versioned).
//
// The ONE contract future consumers (Professor, Agency, Investigator, Companion,
// Code Intelligence) use to read the graph. It sits on the KG-5 retrieval and
// KG-6/KG-7 view layers and never names a table: a consumer sees opaque ids,
// labels, statuses, temporal metadata, citations and provenance — never a row.
//
//   • READ-ONLY: only read operations exist; write / merge / reset / "act from
//     the graph" / "authorize from the graph" names are refused explicitly;
//   • EXPLICIT VISIBILITY: every call carries its privacy context (scope,
//     includePrivate, provider) — there is no implicit or privileged default;
//     the `all` scope only exists for consumers the server wiring authorises;
//   • BOUNDED: results, depth, nodes, edges, claims, evidence, characters and
//     time are capped per call AND per consumer profile; a request above a cap
//     is refused (never silently widened); nobody can ask for "the whole graph";
//   • TRUST: a KG fact is descriptive. Responses carry `authority: 'NONE'`; no
//     field, operation or consumer profile turns a relation into a permission,
//     a tool, a network call or a Device Fabric / OMEGA / RASSILON trust link;
//   • DOMAINS: personal knowledge and the Code Intelligence subgraph (files,
//     symbols, imports) are separate: a consumer only sees its profile's domain.
//
// Versioned: requests declare `apiVersion`; responses carry it. The output
// shapes below are the contract — a table change must not change them.

import {
  retrieveKnowledge as kgRetrieve, resolveVisibility, createRetrievalContext, resolveBudget, claimCitations,
  RETRIEVAL_MODES, PROVIDERS, RetrievalError,
} from './kg-retrieval.js';
import { viewEntity, viewClaim, viewNeighborhood, viewTimeline, viewRelation } from './kg-view.js';
import { normalizeKgDate } from './kg-claim-model.js';
import { KG_CLAIM_STATUSES, KG_RELATIONSHIP_TYPES } from './kg-schema.js';

export const KNOWLEDGE_GRAPH_API_VERSION = 1;
export const SUPPORTED_API_VERSIONS = Object.freeze([1]);

/** Every operation of the contract. All of them read; none of them writes. */
export const KG_API_OPERATIONS = Object.freeze([
  'searchKnowledge', 'retrieveKnowledge', 'getEntity', 'getClaims', 'getEvidence', 'getNeighborhood', 'getTimeline', 'getContradictions',
]);

/** Names a consumer might try; refused with KG_OPERATION_FORBIDDEN (the API is read-only by construction). */
export const KG_FORBIDDEN_OPERATIONS = Object.freeze([
  'createEntity', 'updateEntity', 'mergeEntity', 'splitEntity', 'deleteEntity', 'assertClaim', 'retractClaim', 'attachEvidence', 'addRelation',
  'deleteSource', 'invalidateSource', 'resetGraph', 'importGraph', 'syncNotebook', 'executeActionFromGraph', 'authorizeFromGraph', 'grantPermission',
]);

/** Global ceilings (a consumer profile can only be stricter). */
export const KG_API_BOUNDS = Object.freeze({
  maxResults: Object.freeze({ default: 10, max: 50 }),
  maxDepth: Object.freeze({ default: 1, max: 2 }),
  maxNodes: Object.freeze({ default: 40, max: 150 }),
  maxEdges: Object.freeze({ default: 80, max: 300 }),
  maxClaims: Object.freeze({ default: 20, max: 100 }),
  maxEvidence: Object.freeze({ default: 20, max: 100 }),
  maxChars: Object.freeze({ default: 12000, max: 40000 }),
  timeoutMs: Object.freeze({ default: 1500, max: 5000 }),
});

export const KG_SCOPE_KINDS = Object.freeze(['public', 'notebook', 'sources', 'all']);
const MAX_SOURCE_IDS = 200;
const MAX_ID_CHARS = 200;
const MAX_QUERY_CHARS = 2000;
const EXCERPT_CHARS = 280;
const CITATIONS_PER_ITEM = 5;

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
};

/**
 * Consumer profiles: allowed operations, visibility rules, per-call caps.
 * FUTURE_CONTRACT = the contract exists and is tested with a mock; the product
 * module does not exist / is not wired (Investigator is NOT started).
 */
export const KG_CONSUMER_PROFILES = deepFreeze({
  professor: {
    label: 'Professeur', status: 'ACTIVE_CONTRACT', domain: 'knowledge',
    operations: ['searchKnowledge', 'retrieveKnowledge', 'getEntity', 'getClaims', 'getEvidence', 'getNeighborhood', 'getTimeline'],
    // Professor already excludes private neurons: same rule here
    privacy: { allowPrivate: false, providers: ['local', 'cloud'], scopes: ['public', 'notebook', 'sources'] },
    caps: { maxResults: 20, maxDepth: 2, maxNodes: 60, maxEdges: 120, maxClaims: 40, maxEvidence: 40, maxChars: 12000, timeoutMs: 2000 },
  },
  agency: {
    label: 'Agency', status: 'ACTIVE_CONTRACT', domain: 'knowledge',
    operations: ['searchKnowledge', 'retrieveKnowledge', 'getEntity', 'getClaims', 'getEvidence', 'getNeighborhood'],
    // Agency never receives private content (its knowledge.search contract); context only, never an action
    privacy: { allowPrivate: false, providers: ['local', 'cloud'], scopes: ['public', 'sources'] },
    caps: { maxResults: 10, maxDepth: 1, maxNodes: 40, maxEdges: 80, maxClaims: 20, maxEvidence: 20, maxChars: 6000, timeoutMs: 1500 },
  },
  investigator: {
    label: 'Investigator (futur)', status: 'FUTURE_CONTRACT', domain: 'knowledge',
    operations: ['searchKnowledge', 'getEntity', 'getClaims', 'getEvidence', 'getNeighborhood', 'getTimeline', 'getContradictions'],
    // local only; private data needs an explicit notebook / sources scope; no Observateur inheritance
    privacy: { allowPrivate: true, providers: ['local'], scopes: ['public', 'notebook', 'sources'] },
    caps: { maxResults: 50, maxDepth: 2, maxNodes: 150, maxEdges: 300, maxClaims: 100, maxEvidence: 100, maxChars: 40000, timeoutMs: 5000 },
  },
  companion: {
    label: 'Companion (futur)', status: 'FUTURE_CONTRACT', domain: 'knowledge',
    operations: ['searchKnowledge', 'retrieveKnowledge', 'getEntity', 'getClaims', 'getTimeline'],
    privacy: { allowPrivate: true, providers: ['local'], scopes: ['public', 'notebook', 'sources'] },
    caps: { maxResults: 10, maxDepth: 1, maxNodes: 40, maxEdges: 80, maxClaims: 20, maxEvidence: 20, maxChars: 8000, timeoutMs: 1500 },
  },
  code_intelligence: {
    label: 'Code Intelligence (lecture seule, futur)', status: 'FUTURE_CONTRACT', domain: 'code',
    operations: ['searchKnowledge', 'getEntity', 'getNeighborhood'],
    // its own read-only subgraph: explicit code sources only, never personal knowledge
    privacy: { allowPrivate: true, providers: ['local'], scopes: ['sources'] },
    caps: { maxResults: 20, maxDepth: 2, maxNodes: 100, maxEdges: 200, maxClaims: 20, maxEvidence: 20, maxChars: 12000, timeoutMs: 2000 },
  },
});

export class KgApiError extends Error {
  constructor(code, message, details = null) {
    super(`${code}: ${message}`);
    this.name = 'KgApiError';
    this.code = code;
    if (details) this.details = details;
  }
}

// ── request validation ──────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS;

function onlyKeys(obj, allowed, code, what) {
  const extra = Object.keys(obj).filter(k => !allowed.includes(k));
  if (extra.length) throw new KgApiError(code, `${what}: unknown field(s) ${extra.join(', ')}`);
}

function validateContext(profile, consumerId, context, allowAll) {
  if (context === undefined) throw new KgApiError('KG_PRIVACY_CONTEXT_REQUIRED', 'every call carries an explicit context { scope, includePrivate, provider }');
  if (!isPlainObject(context)) throw new KgApiError('KG_PRIVACY_CONTEXT_INVALID', 'context must be an object');
  onlyKeys(context, ['scope', 'includePrivate', 'provider'], 'KG_PRIVACY_CONTEXT_INVALID', 'context');
  if (context.scope === undefined || context.scope === null) throw new KgApiError('KG_SCOPE_REQUIRED', 'context.scope is required: { kind: public | notebook | sources | all }');
  if (typeof context.includePrivate !== 'boolean') throw new KgApiError('KG_PRIVACY_CONTEXT_REQUIRED', 'context.includePrivate must be stated explicitly (true / false)');
  if (context.provider === undefined) throw new KgApiError('KG_PROVIDER_REQUIRED', 'context.provider must be stated explicitly (local / cloud)');
  if (!PROVIDERS.includes(context.provider)) throw new KgApiError('KG_PROVIDER_INVALID', `provider must be one of ${PROVIDERS.join(', ')}`);

  const scope = context.scope;
  if (!isPlainObject(scope) || !KG_SCOPE_KINDS.includes(scope.kind)) throw new KgApiError('KG_SCOPE_INVALID', `scope.kind must be one of ${KG_SCOPE_KINDS.join(', ')}`);
  let internalScope;
  if (scope.kind === 'public') {
    onlyKeys(scope, ['kind'], 'KG_SCOPE_INVALID', 'scope');
    internalScope = null;
  } else if (scope.kind === 'notebook') {
    onlyKeys(scope, ['kind', 'notebookId'], 'KG_SCOPE_INVALID', 'scope');
    if (!isId(scope.notebookId)) throw new KgApiError('KG_SCOPE_INVALID', 'scope.notebookId must be a non-empty id');
    internalScope = { notebookId: scope.notebookId };
  } else if (scope.kind === 'sources') {
    onlyKeys(scope, ['kind', 'sourceIds'], 'KG_SCOPE_INVALID', 'scope');
    if (!Array.isArray(scope.sourceIds) || scope.sourceIds.length === 0 || scope.sourceIds.length > MAX_SOURCE_IDS || !scope.sourceIds.every(isId)) {
      throw new KgApiError('KG_SCOPE_INVALID', `scope.sourceIds must hold 1..${MAX_SOURCE_IDS} ids`);
    }
    internalScope = { sourceIds: [...new Set(scope.sourceIds)] };
  } else {
    onlyKeys(scope, ['kind'], 'KG_SCOPE_INVALID', 'scope');
    internalScope = { all: true };
  }
  const scopeAllowed = scope.kind === 'all' ? allowAll.has(consumerId) : profile.privacy.scopes.includes(scope.kind);
  if (!scopeAllowed) throw new KgApiError('KG_SCOPE_FORBIDDEN', `scope ${scope.kind} is not allowed for consumer ${consumerId}`);
  if (!profile.privacy.providers.includes(context.provider)) throw new KgApiError('KG_PROVIDER_FORBIDDEN', `provider ${context.provider} is not allowed for consumer ${consumerId}`);
  if (context.includePrivate) {
    if (!profile.privacy.allowPrivate) throw new KgApiError('KG_PRIVATE_FORBIDDEN', `consumer ${consumerId} never receives private sources`);
    if (context.provider === 'cloud') throw new KgApiError('KG_PRIVATE_NOT_FOR_CLOUD', 'private data is never assembled for a cloud provider');
    if (scope.kind === 'public') throw new KgApiError('KG_SCOPE_REQUIRED', 'includePrivate needs an explicit notebook / sources scope');
  }
  return { includePrivate: context.includePrivate, provider: context.provider, scope: internalScope, scopeKind: scope.kind, domain: profile.domain };
}

function validateBounds(profile, consumerId, bounds) {
  if (bounds !== undefined && !isPlainObject(bounds)) throw new KgApiError('KG_BOUNDS_INVALID', 'bounds must be an object');
  const given = bounds ?? {};
  onlyKeys(given, Object.keys(KG_API_BOUNDS), 'KG_BOUNDS_INVALID', 'bounds');
  const out = {};
  for (const [name, def] of Object.entries(KG_API_BOUNDS)) {
    const cap = Math.min(def.max, profile.caps[name] ?? def.max);
    const v = given[name];
    if (v === undefined) { out[name] = Math.min(def.default, cap); continue; }
    if (!Number.isInteger(v) || v < 1) throw new KgApiError('KG_BOUNDS_INVALID', `${name} must be a positive integer`);
    if (v > cap) throw new KgApiError('KG_BOUND_EXCEEDED', `${name} ${v} exceeds the ${consumerId} cap ${cap}`, { bound: name, requested: v, max: cap });
    out[name] = v;
  }
  return out;
}

const stringList = (v, allowed, name, max = 50) => {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length === 0 || v.length > max || !v.every(x => typeof x === 'string' && (!allowed || allowed.includes(x)))) {
    throw new KgApiError('KG_PARAMS_INVALID', `${name} must be a bounded list${allowed ? ` of ${allowed.slice(0, 8).join(', ')}…` : ''}`);
  }
  return v;
};
const dateParam = (v, name) => {
  if (v === undefined) return null;
  const d = normalizeKgDate(v);
  if (!d) throw new KgApiError('KG_PARAMS_INVALID', `${name} is not a valid date`);
  return d;
};
const boolParam = (v, name) => {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw new KgApiError('KG_PARAMS_INVALID', `${name} must be a boolean`);
  return v;
};
const queryParam = (v) => {
  if (typeof v !== 'string' || !/[\p{L}\p{N}]/u.test(v)) throw new KgApiError('KG_PARAMS_INVALID', 'query must be a non-empty string');
  if (v.length > MAX_QUERY_CHARS) throw new KgApiError('KG_PARAMS_INVALID', `query is longer than ${MAX_QUERY_CHARS} characters`);
  return v;
};
const idParam = (v, name) => {
  if (!isId(v)) throw new KgApiError('KG_PARAMS_INVALID', `${name} must be a non-empty id`);
  return v;
};

const PARAM_SPECS = {
  searchKnowledge: { keys: ['query', 'mode', 'types', 'temporal'], parse: (p) => ({
    query: queryParam(p.query),
    mode: p.mode === undefined ? 'hybrid' : (RETRIEVAL_MODES.includes(p.mode) ? p.mode : (() => { throw new KgApiError('KG_PARAMS_INVALID', `mode must be one of ${RETRIEVAL_MODES.join(', ')}`); })()),
    types: stringList(p.types, ['entity', 'claim', 'source'], 'types'),
    temporal: p.temporal === undefined ? null : (isPlainObject(p.temporal) ? p.temporal : (() => { throw new KgApiError('KG_PARAMS_INVALID', 'temporal must be an object'); })()),
  }) },
  retrieveKnowledge: { keys: ['query', 'temporal'], parse: (p) => ({
    query: queryParam(p.query),
    temporal: p.temporal === undefined ? null : (isPlainObject(p.temporal) ? p.temporal : (() => { throw new KgApiError('KG_PARAMS_INVALID', 'temporal must be an object'); })()),
  }) },
  getEntity: { keys: ['entityId'], parse: (p) => ({ entityId: idParam(p.entityId, 'entityId') }) },
  getClaims: { keys: ['entityId', 'predicate', 'statuses', 'includeHistory', 'at'], parse: (p) => ({
    entityId: idParam(p.entityId, 'entityId'),
    predicate: p.predicate === undefined ? null : idParam(p.predicate, 'predicate'),
    statuses: stringList(p.statuses, KG_CLAIM_STATUSES.filter(s => s !== 'INVALIDATED'), 'statuses'),
    includeHistory: boolParam(p.includeHistory, 'includeHistory'),
    at: dateParam(p.at, 'at'),
  }) },
  getEvidence: { keys: ['claimId', 'includeInactive'], parse: (p) => ({ claimId: idParam(p.claimId, 'claimId'), includeInactive: boolParam(p.includeInactive, 'includeInactive') }) },
  getNeighborhood: { keys: ['entityId', 'relationTypes', 'predicates', 'offset'], parse: (p) => ({
    entityId: idParam(p.entityId, 'entityId'),
    relationTypes: stringList(p.relationTypes, KG_RELATIONSHIP_TYPES, 'relationTypes'),
    predicates: stringList(p.predicates, null, 'predicates'),
    offset: p.offset === undefined ? 0 : (Number.isInteger(p.offset) && p.offset >= 0 && p.offset <= 10000 ? p.offset : (() => { throw new KgApiError('KG_PARAMS_INVALID', 'offset must be an integer 0..10000'); })()),
  }) },
  getTimeline: { keys: ['entityId', 'from', 'to'], parse: (p) => {
    const out = { entityId: idParam(p.entityId, 'entityId'), from: dateParam(p.from, 'from'), to: dateParam(p.to, 'to') };
    if (out.from && out.to && !(out.from < out.to)) throw new KgApiError('KG_PARAMS_INVALID', 'from must be before to');
    return out;
  } },
  getContradictions: { keys: ['entityId'], parse: (p) => ({ entityId: idParam(p.entityId, 'entityId') }) },
};

function validateParams(operation, params) {
  if (params === undefined) params = {};
  if (!isPlainObject(params)) throw new KgApiError('KG_PARAMS_INVALID', 'params must be an object');
  const spec = PARAM_SPECS[operation];
  onlyKeys(params, spec.keys, 'KG_PARAMS_INVALID', 'params');
  return spec.parse(params);
}

// ── output mapping (no table, no column name ever leaves this module) ───────

const excerpt = (text) => (text === null || text === undefined ? null : String(text).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS));

function locatorOf(l) {
  if (!l) return { kind: 'SOURCE' };
  const out = { kind: l.kind ?? 'SOURCE' };
  for (const k of ['page', 'section', 'chunkId', 'messageId', 'charStart', 'charEnd']) if (l[k] !== null && l[k] !== undefined) out[k] = l[k];
  return out;
}

/** A citation of an original source, from a KG-5 claim citation. */
function citationFromRetrieval(c) {
  return {
    citationId: c.evidenceId ?? `source:${c.sourceId}`,
    evidenceId: c.evidenceId ?? null,
    stance: c.stance ?? null,
    source: { id: c.sourceId, label: c.sourceName, sourceType: c.sourceType, privacy: c.privacy, egress: c.egress },
    sourceRef: c.sourceRef ? { id: c.sourceRef.sourceRefId, adapter: c.sourceRef.adapter, ref: c.sourceRef.ref ?? null, version: c.sourceRef.versionRef ?? null } : null,
    locator: locatorOf(c.locator),
    excerpt: excerpt(c.snippet),
    excerptHash: c.excerptHash ?? null,
  };
}

/** A citation from a KG-6 claim-view evidence row. */
function citationFromEvidence(e) {
  return {
    citationId: e.evidenceId,
    evidenceId: e.evidenceId,
    stance: e.stance,
    source: { id: e.source.sourceId, label: e.source.name, sourceType: e.source.type, privacy: e.source.privacy, egress: null },
    sourceRef: e.sourceRef ? { id: e.sourceRef.sourceRefId, adapter: e.sourceRef.adapter, ref: e.sourceRef.sourceRef ?? null, version: null } : null,
    locator: locatorOf(e.locator),
    excerpt: excerpt(e.preview),
    excerptHash: e.excerptHash ?? null,
  };
}

function provenanceOf(citations, extraction = null) {
  const sources = [];
  for (const c of citations) if (!sources.some(s => s.id === c.source.id)) sources.push({ id: c.source.id, label: c.source.label, sourceType: c.source.sourceType });
  return { extraction, sources };
}

function privacyOf(citations) {
  const privacies = citations.map(c => c.source.privacy).filter(Boolean);
  const egresses = citations.map(c => c.source.egress).filter(Boolean);
  // no citation or an unknown egress → local_only (fail-safe: never presented as cloud-safe without proof)
  return {
    includesPrivate: privacies.includes('PRIVATE'),
    egress: citations.length > 0 && !privacies.includes('PRIVATE') && egresses.length === citations.length && egresses.every(e => e === 'cloud_allowed') ? 'cloud_allowed' : 'local_only',
  };
}

const temporalOf = (t) => (t ? { observedAt: t.observedAt ?? null, validFrom: t.validFrom ?? null, validTo: t.validTo ?? null, state: t.state ?? t.temporalState ?? null } : null);

function objectOf(o) {
  if (!o) return null;
  if (o.kind === 'entity') return { kind: 'entity', id: o.entityId, label: o.label };
  if (o.kind === 'value') return { kind: 'value', value: o.value };
  return { kind: 'statement', text: o.text ?? null };
}
const objectText = (o) => (!o ? '' : o.kind === 'entity' ? o.label : o.kind === 'value' ? `${o.value?.value ?? ''}${o.value?.unit ? ` ${o.value.unit}` : ''}` : (o.text ?? ''));

function claimItem({ id, subject, predicate, object, status, temporal, confidence, extraction, contradiction, supersededBy = null, citations, whyMatched, score }) {
  const obj = objectOf(object);
  const item = {
    id, type: 'claim',
    label: `${subject?.label ?? '?'} — ${predicate ?? 'statement'} — ${objectText(obj)}`,
    subject: { id: subject?.entityId ?? null, label: subject?.label ?? null },
    predicate: predicate ?? null,
    object: obj,
    status,
    temporal: temporalOf(temporal),
    confidence: confidence ?? null,
    contradiction: contradiction ?? { status: 'NONE', groupId: null, counterpartIds: [] },
    supersededBy,
    citations,
    provenance: provenanceOf(citations, extraction ?? null),
    privacy: privacyOf(citations),
  };
  if (whyMatched) { item.whyMatched = whyMatched; item.score = score; }
  return item;
}

function entityItem({ id, label, entityType, status, aliases = [], identifiers = [], ambiguity = null, citations = [], whyMatched, score, depth, hiddenEdges, claimCounts }) {
  const item = {
    id, type: 'entity', label, entityType, status,
    ambiguous: status === 'AMBIGUOUS',
    ambiguity: ambiguity ? { candidates: (ambiguity.candidates ?? []).map(c => ({ id: c.entityId, label: c.label })) } : null,
    aliases: aliases.slice(0, 20),
    identifiers: identifiers.slice(0, 20),
    temporal: null,
    confidence: null,
    citations,
    provenance: provenanceOf(citations),
    privacy: privacyOf(citations),
  };
  if (claimCounts) item.claimCounts = claimCounts;
  if (depth !== undefined) { item.graphDepth = depth; item.hiddenEdges = hiddenEdges ?? 0; }
  if (whyMatched) { item.whyMatched = whyMatched; item.score = score; }
  return item;
}

function sourceItem(r) {
  const citations = r.citations.map(citationFromRetrieval);
  return {
    id: r.id, type: 'source', label: r.label, sourceType: r.sourceType, status: 'ACTIVE', canonicalUrl: r.canonicalUrl ?? null,
    temporal: null, confidence: null, whyMatched: r.whyMatched, score: r.score,
    citations, provenance: provenanceOf(citations), privacy: privacyOf(citations),
  };
}

const confidenceOf = (c) => (c.sourceConfidence ?? c.modelConfidence ?? null);

// ── bounded assembly helpers ────────────────────────────────────────────────

/** Groups (contradictions) are kept whole: an item with a group goes in with every member present, or none. */
function takeUnits(items, maxItems, maxChars, groupOf) {
  const kept = [];
  const dropped = { count: 0, reasons: new Set() };
  const seen = new Set();
  let chars = 2;
  for (const item of items) {
    if (seen.has(item.id)) continue;
    const g = groupOf(item);
    const unit = g ? items.filter(x => groupOf(x) === g) : [item];
    unit.forEach(u => seen.add(u.id));
    const size = unit.reduce((s, u) => s + JSON.stringify(u).length + 1, 0);
    if (kept.length + unit.length > maxItems) { dropped.count += unit.length; dropped.reasons.add('maxResults'); continue; }
    if (chars + size > maxChars) { dropped.count += unit.length; dropped.reasons.add('maxChars'); continue; }
    kept.push(...unit);
    chars += size;
  }
  return { kept, truncated: dropped.count ? { items: dropped.count, reasons: [...dropped.reasons] } : null };
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * @param {import('./kg-store.js').KnowledgeGraphStore} store
 * @param {object} [options]
 * @param {object} [options.semantic]      optional local KG semantic index
 * @param {() => number} [options.clock]   ms clock (tests inject one to prove timeouts)
 * @param {() => string} [options.today]   ISO date used for temporal state
 * @param {string[]} [options.allowAllScope] consumers the server wiring explicitly allows to use scope { kind: 'all' }
 */
export function createKnowledgeGraphApi(store, { semantic = null, clock = () => Date.now(), today = () => new Date().toISOString().slice(0, 10), allowAllScope = [] } = {}) {
  if (!store) throw new KgApiError('KG_DISABLED', 'the knowledge graph is not open');
  const allowAll = new Set(allowAllScope.filter(id => Object.hasOwn(KG_CONSUMER_PROFILES, id)));

  async function request(consumerId, operation, req) {
    if (typeof consumerId !== 'string' || !Object.hasOwn(KG_CONSUMER_PROFILES, consumerId)) throw new KgApiError('KG_CONSUMER_UNKNOWN', `unknown consumer ${String(consumerId).slice(0, 60)}`);
    if (KG_FORBIDDEN_OPERATIONS.includes(operation)) throw new KgApiError('KG_OPERATION_FORBIDDEN', `${operation}: the knowledge graph consumer API is read-only`);
    if (!KG_API_OPERATIONS.includes(operation)) throw new KgApiError('KG_OPERATION_UNKNOWN', `unknown operation ${String(operation).slice(0, 60)}`);
    const profile = KG_CONSUMER_PROFILES[consumerId];
    if (!profile.operations.includes(operation)) throw new KgApiError('KG_OPERATION_NOT_ALLOWED', `${operation} is not part of the ${consumerId} contract`);
    if (!isPlainObject(req)) throw new KgApiError('KG_REQUEST_INVALID', 'request must be an object { apiVersion, context, bounds?, params }');
    onlyKeys(req, ['apiVersion', 'context', 'bounds', 'params'], 'KG_REQUEST_INVALID', 'request');
    if (req.apiVersion === undefined) throw new KgApiError('KG_API_VERSION_REQUIRED', `apiVersion is required (supported: ${SUPPORTED_API_VERSIONS.join(', ')})`);
    if (!SUPPORTED_API_VERSIONS.includes(req.apiVersion)) throw new KgApiError('KG_API_VERSION_UNSUPPORTED', `apiVersion ${String(req.apiVersion).slice(0, 20)} is not supported (supported: ${SUPPORTED_API_VERSIONS.join(', ')})`);
    const vis = validateContext(profile, consumerId, req.context, allowAll);
    const bounds = validateBounds(profile, consumerId, req.bounds);
    const params = validateParams(operation, req.params);

    const started = clock();
    const deadline = started + bounds.timeoutMs;
    const run = {
      bounds, vis, params, limitsHit: new Set(),
      remaining: () => Math.max(1, Math.round(deadline - clock())),
      expired() {
        if (clock() > deadline) { this.limitsHit.add('timeout'); return true; }
        return false;
      },
      viewOpts: (extra) => ({ includePrivate: vis.includePrivate, provider: vis.provider, scope: vis.scope, domain: vis.domain, now: today(), ...extra }),
    };
    let body;
    try {
      body = await OPERATIONS[operation](run);
    } catch (error) {
      if (error instanceof KgApiError) throw error;
      if (error instanceof RetrievalError || error?.code?.startsWith?.('KG_')) throw new KgApiError(error.code, error.message);
      throw error;
    }
    const { items = [], truncated = null, extra = {}, found = true } = body;
    const response = {
      apiVersion: KNOWLEDGE_GRAPH_API_VERSION,
      consumer: consumerId,
      operation,
      status: found ? 'OK' : 'NOT_FOUND',
      complete: run.limitsHit.size === 0 && !truncated,
      items,
      ...extra,
      truncated,
      limitsHit: [...run.limitsHit].sort(),
      bounds,
      visibility: { scope: vis.scopeKind, includePrivate: vis.includePrivate, provider: vis.provider, domain: vis.domain },
      // a KG fact is descriptive: it never authorizes, triggers or grants anything
      authority: 'NONE',
      stats: { elapsedMs: Math.max(0, Math.round(clock() - started)) },
    };
    const plain = JSON.parse(JSON.stringify(response));
    const chars = JSON.stringify(plain).length;
    plain.stats.responseChars = chars;
    plain.stats.approxTokens = Math.ceil(chars / 4);
    return plain;
  }

  // ── operations ──
  const OPERATIONS = {
    async searchKnowledge(run) {
      return retrieval(run, false);
    },
    async retrieveKnowledge(run) {
      return retrieval(run, true);
    },

    getEntity(run) {
      const v = viewEntity(store, run.viewOpts({ entityId: run.params.entityId, timeoutMs: run.remaining() }));
      if (!v) return { found: false };
      const citations = entityCitations(v.provenance, run.bounds.maxEvidence);
      return {
        items: [entityItem({
          id: v.entity.id, label: v.entity.label, entityType: v.entity.type, status: v.entity.status,
          aliases: v.aliases.map(a => a.alias), identifiers: v.identifiers.filter(i => i.status === 'ACTIVE').map(i => ({ scheme: i.scheme, value: i.value })),
          ambiguity: v.ambiguity, citations, claimCounts: { live: v.claims.live.length, history: v.claims.history.length },
        })],
      };
    },

    getClaims(run) {
      const { entityId, predicate, statuses, includeHistory, at } = run.params;
      const v = viewEntity(store, run.viewOpts({ entityId, timeoutMs: run.remaining() }));
      if (!v) return { found: false };
      let rows = includeHistory ? [...v.claims.live, ...v.claims.history] : v.claims.live;
      if (predicate) rows = rows.filter(c => c.predicate === predicate);
      if (statuses) rows = rows.filter(c => statuses.includes(c.status));
      if (at) rows = rows.filter(c => (!c.validFrom || c.validFrom <= at) && (!c.validTo || c.validTo > at));
      // disputed first, then the order of the view (predicate, validity)
      rows = [...rows].sort((a, b) => (b.contradiction ? 1 : 0) - (a.contradiction ? 1 : 0));
      const items = claimItemsFromCompact(run, rows, Math.min(run.bounds.maxClaims, rows.length));
      const { kept, truncated } = takeUnits(items, run.bounds.maxClaims, run.bounds.maxChars, i => i.contradiction.groupId);
      return { items: kept, truncated: mergeTruncated(truncated, rows.length - items.length, 'maxClaims') };
    },

    getEvidence(run) {
      const v = viewClaim(store, run.viewOpts({ claimId: run.params.claimId, timeoutMs: run.remaining() }));
      if (!v) return { found: false };
      const evidence = v.evidence.filter(e => run.params.includeInactive || (e.linkStatus === 'ACTIVE' && e.status === 'ACTIVE'));
      const items = [];
      for (const e of evidence.slice(0, run.bounds.maxEvidence)) {
        if (run.expired()) break;
        const c = citationFromEvidence(e);
        items.push({
          id: e.evidenceId, type: 'evidence', label: c.source.label, value: c.excerpt, status: e.status, linkStatus: e.linkStatus, stance: e.stance,
          temporal: { observedAt: e.sourceRef?.observedAt ?? null, validFrom: null, validTo: null, state: null }, confidence: e.confidence ?? null,
          citations: [c], provenance: provenanceOf([c]), privacy: privacyOf([c]),
        });
      }
      const { kept, truncated } = takeUnits(items, run.bounds.maxEvidence, run.bounds.maxChars, () => null);
      const claim = claimFromView(v.claim, [], v.contradictions);
      return {
        items: kept,
        truncated: mergeTruncated(truncated, evidence.length - items.length, 'maxEvidence'),
        extra: { claim, supportingEvidence: v.supportingEvidence, contradictingEvidence: v.contradictingEvidence },
      };
    },

    getNeighborhood(run) {
      const { entityId, relationTypes, predicates, offset } = run.params;
      const b = run.bounds;
      const v = viewNeighborhood(store, run.viewOpts({
        entityId, depth: b.maxDepth, maxNodes: b.maxNodes, maxEdges: b.maxEdges, fanout: Math.min(40, b.maxEdges), offset, filters: {}, timeoutMs: run.remaining(),
      }));
      if (!v) return { found: false };
      for (const l of v.limitsHit) if (l !== 'contradiction_completed') run.limitsHit.add(l === 'max_depth' ? 'maxDepth' : l === 'max_nodes' ? 'maxNodes' : l === 'max_edges' ? 'maxEdges' : l);
      let edges = v.edges;
      if (relationTypes) edges = edges.filter(e => e.kind !== 'relationship' || relationTypes.includes(e.label));
      if (predicates) edges = edges.filter(e => e.kind !== 'claim' || predicates.includes(e.label));
      if (relationTypes && !predicates) edges = edges.filter(e => e.kind === 'relationship');
      if (predicates && !relationTypes) edges = edges.filter(e => e.kind === 'claim');
      const ctx = createRetrievalContext(store, resolveVisibility(store, run.vis), resolveBudget({}));
      let evidenceLeft = b.maxEvidence;
      const edgeItems = [];
      for (const e of edges.slice(0, b.maxEdges)) {
        if (run.expired()) break;
        let citations = [];
        if (evidenceLeft > 0) {
          citations = e.kind === 'claim'
            ? claimCitations(store, e.claimId, { evidenceAllowed: (s, r) => ctx.evidenceAllowed(s, r), sourceLabel: (id) => ctx.sourceLabel(id), limit: Math.min(CITATIONS_PER_ITEM, evidenceLeft) }).map(citationFromRetrieval)
            : relationCitations(run, e.relationshipId, Math.min(CITATIONS_PER_ITEM, evidenceLeft));
          evidenceLeft -= citations.length;
        }
        edgeItems.push({
          id: e.id, type: 'relation', relationKind: e.kind === 'claim' ? 'claim' : 'relation',
          label: e.label, from: e.source, to: e.target, status: e.status,
          temporal: e.kind === 'claim' ? { observedAt: e.observedAt ?? null, validFrom: e.validFrom ?? null, validTo: e.validTo ?? null, state: null } : null,
          confidence: e.kind === 'relationship' ? (e.confidence ?? null) : null,
          contradiction: e.contradiction ? { status: 'OPEN_CONFLICT', groupId: null, counterpartIds: (e.contradiction.counterpartClaimIds ?? []).map(id => `clm:${id}`) } : { status: 'NONE', groupId: null, counterpartIds: [] },
          citations, provenance: provenanceOf(citations, e.extractionMethod ?? null), privacy: privacyOf(citations),
        });
      }
      const used = new Set([v.center, ...edgeItems.flatMap(e => [e.from, e.to])]);
      const nodeItems = v.nodes.filter(n => used.has(n.id)).slice(0, b.maxNodes).map(n => entityItem({
        id: n.id, label: n.label, entityType: n.type, status: n.status, depth: n.depth, hiddenEdges: n.hiddenEdges,
      }));
      if (evidenceLeft <= 0 && edges.length) run.limitsHit.add('maxEvidence');
      const all = [...nodeItems, ...edgeItems];
      // contradiction counterparts travel together
      const groupOf = (i) => (i.type === 'relation' && i.contradiction.status === 'OPEN_CONFLICT' ? [i.id, ...i.contradiction.counterpartIds].sort()[0] : null);
      const { kept, truncated } = takeUnits(all, b.maxNodes + b.maxEdges, b.maxChars, groupOf);
      return { items: kept, truncated, extra: { center: v.center, offset: offset } };
    },

    getTimeline(run) {
      const { entityId, from, to } = run.params;
      const v = viewTimeline(store, run.viewOpts({ entityId, filters: { ...(from ? { from } : {}), ...(to ? { to } : {}) }, timeoutMs: run.remaining() }));
      if (!v) return { found: false };
      const rows = v.items.slice(0, run.bounds.maxResults);
      const items = claimItemsFromCompact(run, rows, rows.length);
      const { kept, truncated } = takeUnits(items, run.bounds.maxResults, run.bounds.maxChars, () => null);
      return {
        items: kept,
        truncated: mergeTruncated(truncated, v.totalDated - items.length, 'maxResults'),
        extra: { timeline: { totalDated: v.totalDated, undatedCount: v.undatedCount, range: v.range, buckets: v.buckets } },
      };
    },

    getContradictions(run) {
      const v = viewEntity(store, run.viewOpts({ entityId: run.params.entityId, timeoutMs: run.remaining() }));
      if (!v) return { found: false };
      const disputed = v.claims.live.filter(c => c.contradiction);
      const ids = new Set(disputed.map(c => c.claimId));
      // groups = connected components of the visible OPEN conflicts
      const parent = new Map([...ids].map(id => [id, id]));
      const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
      for (const c of disputed) for (const o of c.contradiction.counterpartClaimIds) if (ids.has(o)) parent.set(find(c.claimId), find(o));
      const items = claimItemsFromCompact(run, disputed, disputed.length);
      const groupIds = new Map();
      for (const it of items) {
        const root = find(it.id);
        if (!groupIds.has(root)) groupIds.set(root, `contradiction:${root}`);
        it.contradiction = { ...it.contradiction, groupId: groupIds.get(root) };
      }
      const { kept, truncated } = takeUnits(items, run.bounds.maxClaims, run.bounds.maxChars, i => i.contradiction.groupId);
      const groups = [...new Set(kept.map(i => i.contradiction.groupId))].map(g => ({ groupId: g, claimIds: kept.filter(i => i.contradiction.groupId === g).map(i => i.id), predicate: kept.find(i => i.contradiction.groupId === g).predicate }));
      return { items: kept, truncated, extra: { groups } };
    },
  };

  /** KG-5 retrieval mapped to the consumer contract (search = items only; retrieve = items + cited context). */
  async function retrieval(run, withContext) {
    const b = run.bounds;
    const charsForItems = withContext ? Math.floor(b.maxChars / 2) : b.maxChars;
    const r = await kgRetrieve(store, {
      query: run.params.query, mode: run.params.mode ?? 'hybrid', temporal: run.params.temporal, ...run.vis, scope: run.vis.scope,
      budget: { maxEntities: b.maxResults, maxClaims: Math.min(b.maxClaims, b.maxResults), maxEvidences: b.maxEvidence, maxSnippets: b.maxEvidence, maxSources: b.maxResults,
        maxChars: withContext ? b.maxChars - charsForItems : b.maxChars, maxDepth: b.maxDepth, maxNodes: b.maxNodes, maxEdges: b.maxEdges, timeoutMs: run.remaining() },
      semantic, assembleContext: withContext, now: today(),
    });
    for (const l of r.stats?.limitsHit ?? []) run.limitsHit.add(l === 'max_depth' ? 'maxDepth' : l === 'max_nodes' ? 'maxNodes' : l === 'max_edges' ? 'maxEdges' : l);
    const types = run.params.types;
    const items = [];
    for (const res of r.results) {
      if (run.expired()) break;
      if (types && !types.includes(res.resultType)) continue;
      if (res.resultType === 'entity') {
        const citations = res.citations.map(citationFromRetrieval);
        items.push(entityItem({ id: res.id, label: res.label, entityType: res.entityType, status: res.status, aliases: res.aliases, ambiguity: res.ambiguity, citations, whyMatched: res.whyMatched, score: res.score }));
      } else if (res.resultType === 'claim') {
        const citations = res.citations.slice(0, CITATIONS_PER_ITEM).map(citationFromRetrieval);
        items.push(claimItem({
          id: res.id, subject: res.subject, predicate: res.predicate, object: res.object, status: res.status, temporal: res.temporal,
          confidence: confidenceOf(res), extraction: res.extractionMethod, contradiction: res.contradiction, citations, whyMatched: res.whyMatched, score: res.score,
        }));
      } else if (res.resultType === 'source') {
        items.push(sourceItem(res));
      }
    }
    const { kept, truncated } = takeUnits(items, b.maxResults, charsForItems, i => (i.type === 'claim' ? i.contradiction.groupId : null));
    const extra = {};
    if (withContext) {
      extra.context = {
        text: r.context.text,
        chars: r.context.chars,
        approxTokens: Math.ceil(r.context.chars / 4),
        citations: r.context.citations.map(c => ({ n: c.n, ...citationFromRetrieval(c) })),
        egress: r.context.egress,
        truncatedUnits: r.context.truncated.length,
      };
    }
    if (r.error) extra.notice = r.error;
    return { items: kept, truncated, extra };
  }

  /** Claim items (with citations) from KG-6 compact claims, under the evidence budget. */
  function claimItemsFromCompact(run, rows, limit) {
    const ctx = createRetrievalContext(store, resolveVisibility(store, run.vis), resolveBudget({}));
    let evidenceLeft = run.bounds.maxEvidence;
    const items = [];
    for (const c of rows.slice(0, limit)) {
      if (run.expired()) break;
      let citations = [];
      if (evidenceLeft > 0) {
        citations = claimCitations(store, c.claimId, { evidenceAllowed: (s, r) => ctx.evidenceAllowed(s, r), sourceLabel: (id) => ctx.sourceLabel(id), limit: Math.min(CITATIONS_PER_ITEM, evidenceLeft) })
          .map(citationFromRetrieval);
        evidenceLeft -= citations.length;
      } else run.limitsHit.add('maxEvidence');
      items.push(claimFromView(c, citations));
    }
    return items;
  }

  function claimFromView(c, citations, contradictions = null) {
    const counterpartIds = c.contradiction?.counterpartClaimIds ?? (contradictions ? contradictions.filter(k => k.status === 'OPEN').map(k => k.otherClaim.claimId) : []);
    return claimItem({
      id: c.claimId, subject: c.subject, predicate: c.predicate, object: c.object, status: c.status,
      temporal: { observedAt: c.observedAt, validFrom: c.validFrom, validTo: c.validTo, state: c.temporalState },
      confidence: confidenceOf(c), extraction: c.extractionMethod,
      contradiction: counterpartIds.length ? { status: 'OPEN_CONFLICT', groupId: null, counterpartIds } : { status: c.status === 'DISPUTED' ? 'CONTRADICTED_BY_EVIDENCE' : 'NONE', groupId: null, counterpartIds: [] },
      supersededBy: c.supersededBy ?? null, citations,
    });
  }

  /** Source-level citations of a relation: its provenances visible in this context. */
  function relationCitations(run, relationshipId, limit) {
    const r = viewRelation(store, run.viewOpts({ relationshipId, timeoutMs: run.remaining() }));
    if (!r) return [];
    const out = [];
    for (const p of r.provenances) {
      const refs = p.refs.length ? p.refs : [null];
      for (const ref of refs) {
        if (out.length >= limit) return out;
        out.push({
          citationId: `source:${p.sourceId}${ref ? `:${ref.ref}` : ''}`, evidenceId: null, stance: null,
          source: { id: p.sourceId, label: p.sourceName, sourceType: p.sourceType, privacy: p.privacy, egress: p.egress },
          sourceRef: ref ? { id: null, adapter: ref.adapter, ref: ref.ref, version: null } : null,
          locator: { kind: 'SOURCE' }, excerpt: null, excerptHash: null,
        });
      }
    }
    return out;
  }

  function entityCitations(provenance, limit) {
    return provenance.slice(0, Math.min(limit, CITATIONS_PER_ITEM)).map(p => ({
      citationId: `source:${p.sourceId}${p.ref ? `:${p.ref}` : ''}`, evidenceId: null, stance: null,
      source: { id: p.sourceId, label: p.sourceName, sourceType: p.sourceType, privacy: p.privacy, egress: p.egress },
      sourceRef: p.adapter ? { id: null, adapter: p.adapter, ref: p.ref ?? null, version: null } : null,
      locator: { kind: 'SOURCE' }, excerpt: null, excerptHash: null,
    }));
  }

  /** A client bound to ONE consumer (identity fixed by the server wiring, never self-declared per call). */
  function forConsumer(consumerId) {
    if (typeof consumerId !== 'string' || !Object.hasOwn(KG_CONSUMER_PROFILES, consumerId)) throw new KgApiError('KG_CONSUMER_UNKNOWN', `unknown consumer ${String(consumerId).slice(0, 60)}`);
    const client = { consumer: consumerId, apiVersion: KNOWLEDGE_GRAPH_API_VERSION, profile: KG_CONSUMER_PROFILES[consumerId] };
    for (const op of KG_CONSUMER_PROFILES[consumerId].operations) client[op] = (req) => request(consumerId, op, req);
    return Object.freeze(client);
  }

  return Object.freeze({ apiVersion: KNOWLEDGE_GRAPH_API_VERSION, request, forConsumer, describe: describeKnowledgeGraphApi });
}

function mergeTruncated(truncated, beyond, reason) {
  if (beyond <= 0) return truncated;
  const reasons = new Set(truncated?.reasons ?? []);
  reasons.add(reason);
  return { items: (truncated?.items ?? 0) + beyond, reasons: [...reasons] };
}

/** The contract as data (versioned): operations, item shapes, bounds, consumer profiles, guarantees. */
export function describeKnowledgeGraphApi() {
  return deepFreeze(JSON.parse(JSON.stringify({
    apiVersion: KNOWLEDGE_GRAPH_API_VERSION,
    supportedVersions: SUPPORTED_API_VERSIONS,
    operations: Object.fromEntries(KG_API_OPERATIONS.map(op => [op, { readOnly: true, params: PARAM_SPECS[op].keys }])),
    forbiddenOperations: KG_FORBIDDEN_OPERATIONS,
    request: { required: ['apiVersion', 'context', 'params'], optional: ['bounds'], context: { scope: KG_SCOPE_KINDS, includePrivate: 'boolean (explicit)', provider: PROVIDERS } },
    response: CONTRACT_SHAPES.response,
    items: CONTRACT_SHAPES.items,
    bounds: KG_API_BOUNDS,
    consumers: KG_CONSUMER_PROFILES,
    guarantees: [
      'read-only: no operation writes, merges, deletes or resets',
      'explicit visibility on every call; private sources need includePrivate + an explicit notebook / sources scope, never a cloud provider',
      'a Notebook scope only sees what was read through THAT notebook (evidence, aliases, relations: technical provenance)',
      'a sources scope names logical sources and never reaches a Notebook path: Notebook content needs its notebook scope (or an authorised all)',
      'bounded: results, depth, nodes, edges, claims, evidence, characters, time',
      'contradictions are returned whole; ambiguity is flagged, never resolved silently',
      'citations name the original sources; invalidated sources are not cited',
      'authority NONE: a KG fact never grants a permission, a tool, an action or a network call',
      'Code Intelligence is a separate domain: never mixed with personal knowledge',
    ],
  })));
}

/** Output shapes (keys) — the stable surface consumers may rely on. */
export const CONTRACT_SHAPES = deepFreeze({
  response: ['apiVersion', 'consumer', 'operation', 'status', 'complete', 'items', 'truncated', 'limitsHit', 'bounds', 'visibility', 'authority', 'stats'],
  responseExtra: {
    retrieveKnowledge: ['context'], getEvidence: ['claim', 'supportingEvidence', 'contradictingEvidence'], getNeighborhood: ['center', 'offset'],
    getTimeline: ['timeline'], getContradictions: ['groups'],
  },
  items: {
    common: ['id', 'type', 'label', 'status', 'temporal', 'confidence', 'citations', 'provenance', 'privacy'],
    entity: ['entityType', 'ambiguous', 'ambiguity', 'aliases', 'identifiers'],
    claim: ['subject', 'predicate', 'object', 'contradiction', 'supersededBy'],
    relation: ['relationKind', 'from', 'to', 'contradiction'],
    source: ['sourceType', 'canonicalUrl'],
    evidence: ['value', 'linkStatus', 'stance'],
    retrieval: ['whyMatched', 'score'],
  },
  citation: ['citationId', 'evidenceId', 'stance', 'source', 'sourceRef', 'locator', 'excerpt', 'excerptHash'],
});

export default { createKnowledgeGraphApi, describeKnowledgeGraphApi, KNOWLEDGE_GRAPH_API_VERSION, KG_CONSUMER_PROFILES, KG_API_OPERATIONS, KG_FORBIDDEN_OPERATIONS, KG_API_BOUNDS, KgApiError };
