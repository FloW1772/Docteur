// Notebook NB-3 — pure retrieval logic: relevance gating, RRF fusion, source
// diversity, duplicate suppression, context budget, confidence.
// No I/O, no network. Every parameter is explicit and overridable per call so
// the calibration harness (scripts/nb3-calibrate.mjs) evaluates exactly the
// code that runs in production.

import { normalizeToken, STOPWORDS } from './notebook-docs-store.js';

// Defaults are the CALIBRATED values (see reports/DOCTEUR_NOTEBOOK_NB3_ROBUST_LOCAL_RAG_2026-09.md §2).
export const DEFAULT_RETRIEVAL_CONFIG = Object.freeze({
  topK: 6,
  poolMultiplier: 4,          // candidates fetched per list = max(topK * 4, 20)
  rrfK: 60,
  ftsWeight: 1,
  vectorWeight: 0.5,          // FTS carries more weight: measured stronger than nomic vectors on this corpus
  vectorThreshold: 0.7,       // cosine similarity floor (vectors are unit-normalised)
  vectorMargin: null,         // optional: drop vector hits below (top1 - margin)
  vectorAgreementFloor: null, // optional lower cosine floor for vector hits that are ALSO lexically relevant (vector as a re-ranker of FTS candidates)
  minLexicalCoverage: 0.34,   // fraction of content-bearing query terms present in the chunk
  rerank: 'none',             // 'none' | 'coverage'
  rerankBoost: 0.5,
  maxPerSource: 3,
  diversityBy: 'document',    // 'document' | 'conversation' (AI history: one conversation = one source)
  diversity: 'round_robin',   // 'round_robin' | 'score'
  nearDuplicateJaccard: 0.85,
  maxContextTokens: 3000,
});

// Named sensitivity profiles (measured, see calibration report). 'precise' is the default:
// no answer is preferred to a wrong one. 'broad' trades precision for paraphrase recall.
export const RETRIEVAL_PROFILES = Object.freeze({
  precise: Object.freeze({}),
  broad: Object.freeze({ vectorThreshold: 0.6, minLexicalCoverage: 0.34 }),
});

export function resolveRetrievalConfig(...overrides) {
  const cfg = { ...DEFAULT_RETRIEVAL_CONFIG };
  for (const o of overrides) if (o) for (const [k, v] of Object.entries(o)) if (v !== undefined) cfg[k] = v;
  return cfg;
}

// ── Lexical coverage ────────────────────────────────────────────────────────
const stem = (t) => (t.length > 4 ? t.replace(/(?:s|x)$/, '') : t);

export function tokenSet(text) {
  const out = new Set();
  for (const raw of normalizeToken(text).match(/[\p{L}\p{N}_]{2,}/gu) ?? []) { out.add(raw); out.add(stem(raw)); }
  return out;
}

// Share of content-bearing query terms found in the chunk (title/heading included).
export function lexicalCoverage(terms, chunkText, extra = '') {
  if (!terms.length) return 0;
  const tokens = tokenSet(`${chunkText} ${extra}`);
  let hit = 0;
  for (const t of terms) if (tokens.has(t) || tokens.has(stem(t))) hit++;
  return hit / terms.length;
}

// ── Duplicate handling ──────────────────────────────────────────────────────
export function normalizedTextKey(text) {
  return normalizeToken(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Sets are precomputed once per candidate inside selectDiverse (O(n) shingle builds instead of O(n²)).
function shingles(text, n = 3) {
  const words = normalizedTextKey(text).split(' ').filter(Boolean);
  const set = new Set();
  if (words.length <= n) { set.add(words.join(' ')); return set; }
  for (let i = 0; i <= words.length - n; i++) set.add(words.slice(i, i + n).join(' '));
  return set;
}

export function shingleJaccard(a, b) {
  return jaccardSets(typeof a === 'string' ? shingles(a) : a, typeof b === 'string' ? shingles(b) : b);
}

function jaccardSets(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ── Fusion ──────────────────────────────────────────────────────────────────
// score(chunk) = Σ_lists weight / (rrfK + rank)   (rank starts at 1).
// Lists are gated BEFORE fusion, so a chunk enters the union only if it is
// lexically relevant (coverage) or semantically relevant (cosine floor).
export function gateFtsHits(hits, terms, cfg) {
  return hits
    .map(h => ({ ...h, coverage: lexicalCoverage(terms, h.text, h.title ?? '') }))
    .filter(h => h.coverage >= cfg.minLexicalCoverage);
}

export function gateVectorHits(hits, cfg, lexicalIds = new Set()) {
  let out = hits.filter(h => h.vectorScore >= cfg.vectorThreshold
    || (cfg.vectorAgreementFloor != null && lexicalIds.has(h.chunkId) && h.vectorScore >= cfg.vectorAgreementFloor));
  if (cfg.vectorMargin != null && out.length) {
    const top = Math.max(...out.map(h => h.vectorScore));
    out = out.filter(h => h.vectorScore >= top - cfg.vectorMargin);
  }
  return out;
}

export function fuseRanked(ftsHits, vectorHits, cfg) {
  const fused = new Map();
  const add = (list, key, weight) => list.forEach((c, i) => {
    const rank = i + 1;
    const e = fused.get(c.chunkId) ?? { chunk: c, score: 0, ftsRank: null, vectorRank: null };
    e.score += weight / (cfg.rrfK + rank);
    e[key] = rank;
    e.chunk = { ...e.chunk, ...(key === 'vectorRank' ? { vectorScore: c.vectorScore } : { bm25: c.bm25, coverage: c.coverage }) };
    fused.set(c.chunkId, e);
  });
  add(ftsHits, 'ftsRank', cfg.ftsWeight);
  add(vectorHits, 'vectorRank', cfg.vectorWeight);
  let ranked = [...fused.values()];
  if (cfg.rerank === 'coverage') {
    for (const e of ranked) e.score *= 1 + cfg.rerankBoost * (e.chunk.coverage ?? 0);
  }
  ranked.sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId));
  return ranked;
}

// ── Diversity + duplicate suppression ───────────────────────────────────────
// 'round_robin': pass 1 takes the best chunk of every source (ordered by their
// best score), pass 2 the second best of each, … up to maxPerSource, so a
// single long document cannot crowd out the other sources. 'score': plain rank
// order with only the per-source cap.
const srcKey = (c, cfg) => (cfg.diversityBy === 'conversation' ? (c.aiConversationId ?? c.documentId) : c.documentId);

export function selectDiverse(ranked, cfg) {
  const kept = [];
  const seenExact = new Set(); const seenNorm = new Set();
  const prep = new Map(); // chunkId → { norm, sh }
  const info = (c) => { let x = prep.get(c.chunkId); if (!x) { x = { norm: normalizedTextKey(c.text), sh: shingles(c.text) }; prep.set(c.chunkId, x); } return x; };
  const isDup = (c) => {
    if (seenExact.has(c.hash)) return 'exact';
    const me = info(c);
    if (seenNorm.has(me.norm)) return 'normalized';
    for (const k of kept) if (jaccardSets(info(k.chunk).sh, me.sh) >= cfg.nearDuplicateJaccard) return 'near';
    return null;
  };
  const dupStats = { exact: 0, normalized: 0, near: 0 };
  const unique = [];
  for (const e of ranked) {
    const d = isDup(e.chunk);
    if (d) { dupStats[d]++; continue; }
    seenExact.add(e.chunk.hash); seenNorm.add(info(e.chunk).norm);
    kept.push(e); unique.push(e);
  }
  const bySource = new Map();
  for (const e of unique) { const k = srcKey(e.chunk, cfg); const l = bySource.get(k) ?? []; l.push(e); bySource.set(k, l); }
  const picked = [];
  if (cfg.diversity === 'score') {
    const count = new Map();
    for (const e of unique) {
      if (picked.length >= cfg.topK) break;
      const k = srcKey(e.chunk, cfg); const n = count.get(k) ?? 0;
      if (n >= cfg.maxPerSource) continue;
      count.set(k, n + 1); picked.push(e);
    }
  } else {
    const order = [...bySource.values()].sort((a, b) => b[0].score - a[0].score);
    for (let pass = 0; pass < cfg.maxPerSource && picked.length < cfg.topK; pass++) {
      const round = order.map(l => l[pass]).filter(Boolean).sort((a, b) => b.score - a.score);
      for (const e of round) { if (picked.length >= cfg.topK) break; picked.push(e); }
    }
    // Final presentation order: by fused score (round-robin only decides who gets in).
    picked.sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId));
  }
  return { picked, dupStats };
}

// ── Context budget ──────────────────────────────────────────────────────────
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 3.5);

export function applyContextBudget(results, { maxContextTokens, topK, maxPerSource, diversityBy = 'document' }) {
  const out = []; const perSource = new Map(); let used = 0;
  for (const r of results) {
    if (out.length >= topK) break;
    const sk = srcKey(r, { diversityBy });
    const n = perSource.get(sk) ?? 0;
    if (n >= maxPerSource) continue;
    const t = estimateTokens(r.text);
    if (used + t > maxContextTokens) {
      if (out.length === 0) { // always keep one chunk, truncated to the budget — never inject a whole document
        out.push({ ...r, text: `${r.text.slice(0, Math.floor(maxContextTokens * 3.5))}…`, truncated: true });
        used = maxContextTokens;
      }
      break;
    }
    out.push(r); used += t; perSource.set(sk, n + 1);
  }
  return { chunks: out, tokensUsed: used, maxTokens: maxContextTokens, dropped: results.length - out.length };
}

// ── Confidence (deterministic, heuristic — documented as such) ──────────────
export function confidenceLevel(results) {
  if (!results.length) return 'NONE';
  const top = results[0];
  const strongVector = (top.vectorScore ?? 0) >= 0.75;
  const strongLexical = (top.coverage ?? 0) >= 0.99 && top.ftsRank != null;
  const both = top.ftsRank != null && top.vectorRank != null;
  if (both && (strongVector || strongLexical)) return 'HIGH';
  if (strongVector || strongLexical || both) return 'MEDIUM';
  return 'LOW';
}

export { STOPWORDS };
