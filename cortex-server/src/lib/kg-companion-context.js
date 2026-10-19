// COMP-7 — fixed, local, read-only Knowledge Graph context adapter for Companion.
//
// This is deliberately not a generic KG tool. It binds the certified Companion
// consumer identity, derives one query from the current request, and returns a
// small normalized data pack. retrieveKnowledge is primary; getNeighborhood is
// used only for MEMBER_OF because retrieval results do not contain graph edges.

import { createKnowledgeGraphApi, KNOWLEDGE_GRAPH_API_VERSION } from './kg-consumer-api.js';

export const COMPANION_KG_CAPABILITY = Object.freeze({ id: 'COMP-7', state: 'ACTIVE', mode: 'LOCAL_READ_ONLY' });
export const COMPANION_KG_LIMITS = Object.freeze({
  maxQueryChars: 512,
  maxResults: 4,
  maxTextPerResult: 800,
  maxContextChars: 3_200,
  maxProvenanceItems: 8,
  maxNeighborhoodSeeds: 2,
  maxNeighborhoodNodes: 8,
  maxNeighborhoodEdges: 8,
  timeoutMs: 1_500,
});

const VISIBILITY = Object.freeze({ scope: Object.freeze({ kind: 'public' }), includePrivate: false, provider: 'local' });
const RETRIEVE_BOUNDS = Object.freeze({
  maxResults: COMPANION_KG_LIMITS.maxResults,
  maxDepth: 1,
  maxNodes: 12,
  maxEdges: 12,
  maxClaims: 4,
  maxEvidence: COMPANION_KG_LIMITS.maxProvenanceItems,
  maxChars: 4_000,
  timeoutMs: COMPANION_KG_LIMITS.timeoutMs,
});
const NEIGHBORHOOD_BOUNDS = Object.freeze({
  maxResults: COMPANION_KG_LIMITS.maxResults,
  maxDepth: 1,
  maxNodes: COMPANION_KG_LIMITS.maxNeighborhoodNodes,
  maxEdges: COMPANION_KG_LIMITS.maxNeighborhoodEdges,
  maxClaims: 1,
  maxEvidence: COMPANION_KG_LIMITS.maxProvenanceItems,
  // [COMP-7 PRODUCT WIRING] input budget of the KG API call only (was 2,400): at 2,400 the three endpoint entities
  // exhausted it and a video in both a collection and a playlist lost its second MEMBER_OF. Same as RETRIEVE_BOUNDS,
  // half the companion profile cap (8,000). Every bound on what reaches the model is unchanged (COMPANION_KG_LIMITS).
  maxChars: 4_000,
  timeoutMs: COMPANION_KG_LIMITS.timeoutMs,
});

const safeArray = (v) => (Array.isArray(v) ? v : []);
const clean = (v, max = 200) => String(v ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const boundedQuery = (v) => clean(v, COMPANION_KG_LIMITS.maxQueryChars);
const score = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

function provenance(citations, budget) {
  const out = [];
  for (const c of safeArray(citations)) {
    if (out.length >= budget) break;
    const ref = clean(c?.sourceRef?.ref ?? c?.source?.id, 200);
    if (!ref) continue;
    const row = { kind: clean(c?.sourceRef?.adapter ?? c?.source?.sourceType ?? 'KG_SOURCE', 40) || 'KG_SOURCE', ref };
    if (!out.some(x => x.kind === row.kind && x.ref === row.ref)) out.push(row);
  }
  return out;
}

function sourceSummary(citations, budget) {
  const out = [];
  for (const c of safeArray(citations)) {
    if (out.length >= budget) break;
    const label = clean(c?.source?.label, 120);
    const sourceType = clean(c?.source?.sourceType, 40);
    if (!label && !sourceType) continue;
    const row = { sourceType: sourceType || 'UNKNOWN', label: label || null };
    if (!out.some(x => x.sourceType === row.sourceType && x.label === row.label)) out.push(row);
  }
  return out;
}

function boundedJson(value) {
  const text = JSON.stringify(value);
  return text.length <= COMPANION_KG_LIMITS.maxTextPerResult ? text : `${text.slice(0, COMPANION_KG_LIMITS.maxTextPerResult - 1)}…`;
}

function normalizeItem(item, provenanceLeft) {
  const citations = safeArray(item?.citations);
  const refs = provenance(citations, provenanceLeft);
  const common = {
    classification: 'UNTRUSTED_KG_DATA',
    authority: 'NONE',
    factStatus: item?.type === 'claim' ? 'SUPPORTED_KG_CLAIM' : 'NO_SUPPORTED_KG_FACT',
    type: clean(item?.type, 20) || 'unknown',
    label: clean(item?.label, 240),
    sources: sourceSummary(citations, provenanceLeft),
  };
  if (item?.type === 'entity') Object.assign(common, { entityType: clean(item.entityType, 40), structuralOnly: true });
  if (item?.type === 'claim') Object.assign(common, {
    predicate: clean(item.predicate, 100),
    subject: clean(item.subject?.label, 160),
    object: clean(item.object?.label ?? item.object?.value?.value ?? item.object?.text, 200),
    status: clean(item.status, 40),
  });
  return {
    id: clean(item?.id, 160) || `kg:${clean(item?.type, 20) || 'unknown'}:${clean(item?.label, 120) || 'unlabelled'}`,
    type: item?.type === 'claim' ? 'CLAIM' : 'ENTITY',
    text: boundedJson(common),
    score: score(item?.score),
    provenance: refs,
    flags: ['AUTHORITY_NONE', 'UNTRUSTED_KG_DATA', item?.type === 'claim' ? 'SUPPORTED_KG_CLAIM' : 'NO_SUPPORTED_KG_FACT'],
  };
}

function membershipItems(response, provenanceLeft) {
  if (response?.authority !== 'NONE') return [];
  const items = safeArray(response.items);
  const labels = new Map(items.filter(x => x?.type === 'entity').map(x => [x.id, clean(x.label, 240)]));
  return items.filter(x => x?.type === 'relation' && x?.relationKind === 'relation' && x?.label === 'MEMBER_OF').map(x => {
    const citations = safeArray(x.citations);
    return {
      id: clean(x.id, 160),
      type: 'MEMBERSHIP',
      text: boundedJson({
        classification: 'UNTRUSTED_KG_DATA', authority: 'NONE', factStatus: 'NO_SUPPORTED_KG_FACT',
        type: 'structural_membership', relation: 'MEMBER_OF', structuralOnly: true,
        member: labels.get(x.from) ?? null, collection: labels.get(x.to) ?? null,
        sources: sourceSummary(citations, provenanceLeft),
      }),
      score: 1,
      provenance: provenance(citations, provenanceLeft),
      flags: ['AUTHORITY_NONE', 'NO_SUPPORTED_KG_FACT', 'STRUCTURAL_MEMBERSHIP', 'UNTRUSTED_KG_DATA'],
    };
  });
}

function inactivePort(status) {
  return Object.freeze({
    capability: Object.freeze({ ...COMPANION_KG_CAPABILITY, state: status === 'COMP_7_INACTIVE' ? 'INACTIVE' : 'UNAVAILABLE' }),
    retrieve: async () => Object.freeze({ status, authority: 'NONE', factStatus: 'NO_SUPPORTED_KG_FACT', items: [], limits: COMPANION_KG_LIMITS }),
  });
}

function deadline(promise, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { code: 'COMP_7_CANCELLED' }));
  let timer; let onAbort;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'COMP_7_TIMEOUT' })), timeoutMs);
    if (signal) {
      onAbort = () => reject(Object.assign(new Error('cancelled'), { code: 'COMP_7_CANCELLED' }));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return Promise.race([promise, stop]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

/**
 * Explicit COMP-7 gate. Merely having Companion and KG ACTIVE does nothing:
 * callers must set enabled=true and inject this returned read port into the
 * Companion context engine.
 */
export function createCompanionKgReadPort({ store = null, consumer = null, enabled = false } = {}) {
  if (!enabled) return inactivePort('COMP_7_INACTIVE');
  let client = consumer;
  if (!client && store) client = createKnowledgeGraphApi(store).forConsumer('companion');
  if (!client || client.consumer !== 'companion' || typeof client.retrieveKnowledge !== 'function' || typeof client.getNeighborhood !== 'function') return inactivePort('KG_UNAVAILABLE');

  return Object.freeze({
    capability: COMPANION_KG_CAPABILITY,
    async retrieve(rawQuery, { signal = null } = {}) {
      const query = boundedQuery(rawQuery);
      if (!query) return Object.freeze({ status: 'EMPTY', authority: 'NONE', factStatus: 'NO_SUPPORTED_KG_FACT', items: [], limits: COMPANION_KG_LIMITS });
      try {
        const expiresAt = Date.now() + COMPANION_KG_LIMITS.timeoutMs;
        const boundedCall = (call) => deadline(Promise.resolve().then(call), signal, Math.max(1, expiresAt - Date.now()));
        const result = await boundedCall(() => client.retrieveKnowledge({
          apiVersion: KNOWLEDGE_GRAPH_API_VERSION, context: VISIBILITY, bounds: RETRIEVE_BOUNDS, params: { query },
        }));
        if (result?.authority !== 'NONE' || result?.consumer !== 'companion' || result?.operation !== 'retrieveKnowledge') throw Object.assign(new Error('invalid KG response'), { code: 'COMP_7_CONTRACT_INVALID' });

        let provenanceLeft = COMPANION_KG_LIMITS.maxProvenanceItems;
        const normalized = [];
        // Reserve two of the four context slots for the current structural
        // MEMBER_OF use case; the certified retrieval itself is still capped
        // at four and remains the sole source of neighbourhood seed ids.
        const primaryLimit = Math.max(1, COMPANION_KG_LIMITS.maxResults - COMPANION_KG_LIMITS.maxNeighborhoodSeeds);
        for (const item of safeArray(result.items).slice(0, primaryLimit)) {
          const row = normalizeItem(item, provenanceLeft);
          provenanceLeft -= row.provenance.length;
          normalized.push(row);
        }
        const seeds = safeArray(result.items).filter(x => x?.type === 'entity').slice(0, COMPANION_KG_LIMITS.maxNeighborhoodSeeds);
        for (const seed of seeds) {
          if (signal?.aborted) break;
          const hood = await boundedCall(() => client.getNeighborhood({
            apiVersion: KNOWLEDGE_GRAPH_API_VERSION, context: VISIBILITY, bounds: NEIGHBORHOOD_BOUNDS, params: { entityId: seed.id, relationTypes: ['MEMBER_OF'], offset: 0 },
          }));
          if (hood?.authority !== 'NONE' || hood?.consumer !== 'companion' || hood?.operation !== 'getNeighborhood') throw Object.assign(new Error('invalid KG neighbourhood response'), { code: 'COMP_7_CONTRACT_INVALID' });
          for (const row of membershipItems(hood, provenanceLeft)) {
            if (normalized.length >= COMPANION_KG_LIMITS.maxResults) break;
            if (normalized.some(x => x.id === row.id)) continue;
            provenanceLeft -= row.provenance.length;
            normalized.push(row);
          }
        }
        let chars = 0;
        const items = [];
        for (const row of normalized) {
          if (chars + row.text.length > COMPANION_KG_LIMITS.maxContextChars) break;
          chars += row.text.length;
          items.push(row);
        }
        const factStatus = items.some(x => x.type === 'CLAIM') ? 'SUPPORTED_KG_CLAIM' : 'NO_SUPPORTED_KG_FACT';
        return Object.freeze({ status: items.length ? 'OK' : 'EMPTY', authority: 'NONE', factStatus, items, limits: COMPANION_KG_LIMITS, truncated: items.length < normalized.length || Boolean(result.truncated) });
      } catch (error) {
        const status = error?.code === 'COMP_7_CANCELLED' ? 'CANCELLED' : error?.code === 'COMP_7_TIMEOUT' ? 'TIMEOUT' : 'KG_UNAVAILABLE';
        const reason = typeof error?.code === 'string' && /^(?:COMP_7|KG_)[A-Z0-9_]{1,60}$/.test(error.code) ? error.code : 'KG_READ_FAILED';
        return Object.freeze({ status, reason, authority: 'NONE', factStatus: 'NO_SUPPORTED_KG_FACT', items: [], limits: COMPANION_KG_LIMITS });
      }
    },
  });
}

export default { createCompanionKgReadPort, COMPANION_KG_CAPABILITY, COMPANION_KG_LIMITS };
