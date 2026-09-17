// Adaptive local memory — Phase 3 (MASTER mission).
//
// Three tiers:
//   SESSION  — existing conversations/conversation_messages (chat.js), unchanged.
//   EPISODIC — episodic_memories table (this file): mid-term, extracted from
//              searches/neurons/corrections, expected to fade if unused.
//   LONG-TERM PROFILE — existing preference_facts table, now carrying the
//              same metadata columns (source/privacy/egress_policy/importance/
//              confidence/usage_count/last_used_at) via additive migration.
//
// Extraction is 100% local: deterministic rules first, and only escalates to
// a local Ollama call when explicitly asked for (extractWithOllama) — NEVER
// a cloud provider. There is no code path in this file that touches fetch()
// or any cloud SDK.
//
// egress_policy propagation: a memory extracted from privacy=true content
// (private neuron, OneDrive/YouTube *_private source, OSINT result) is
// itself stored with privacy=true, egress_policy='local_only' — see
// extractFromSource(). Once local_only, a memory can never be selected into
// a cloud-bound prompt (selectMemoriesForBudget() is called by callers
// before markPrivate() tagging exactly like private neurons already are).

import {
  listPreferenceFacts, touchPreferenceFact,
  listEpisodicMemories, addEpisodicMemory, touchEpisodicMemory, clearEpisodicMemories,
  getMeta, setMeta,
} from './sqlite.js';
import { isLocalOnlySource } from './source-privacy.js';

const MEMORY_SETTINGS_DEFAULTS = {
  enabled: true,           // "Apprentissage contextuel local" master switch
  learn_from_searches: true,
  learn_from_neurons: true,
  learn_from_corrections: true,
  budget: 'normal',        // 'low' | 'normal' | 'extended'
};

const BUDGET_LEVELS = {
  low:      { maxMemories: 3, maxChunks: 3 },
  normal:   { maxMemories: 5, maxChunks: 5 },
  extended: { maxMemories: 8, maxChunks: 8 },
};

export function getMemorySettings() {
  const stored = getMeta('memory_settings', {});
  return { ...MEMORY_SETTINGS_DEFAULTS, ...stored };
}

export function setMemorySettings(updates) {
  const current = getMemorySettings();
  const next = { ...current, ...updates };
  if (next.budget && !BUDGET_LEVELS[next.budget]) next.budget = 'normal';
  setMeta('memory_settings', next);
  return next;
}

export function getBudgetLimits(budget = getMemorySettings().budget) {
  return BUDGET_LEVELS[budget] ?? BUDGET_LEVELS.normal;
}

// ── Local, rule-based "is this worth remembering?" decision ────────────────
// No AI call — fast, deterministic, runs on every candidate without cost.
// Deliberately conservative: false negatives (missed memory) are cheap,
// false positives (noise remembered forever) are not, since preference_facts
// has a hard cap and episodic_memories should stay small via dedup.

const PREFERENCE_PATTERNS = [
  // "je préfère...", "j'aime...", "je n'aime pas...", "j'utilise...", etc. —
  // French elides "je" to "j'" before a vowel, so both forms are matched.
  /\bj(?:e\s+|['’])(?:préfère|aime|n['’]aime pas|déteste|utilise|travaille (?:avec|sur|en))\b/i,
  /\b(?:toujours|jamais)\s+(?:utiliser|faire|répondre|écrire)\b/i,
  /\bmon\s+(?:projet|équipe|poste|rôle|framework|stack|langage)\b/i,
  /\bappelle-moi\b/i,
  /\bréponds?\s+(?:toujours\s+)?en\s+\w+\b/i,
];

const CORRECTION_PATTERNS = [
  /\bnon,?\s+(?:c['’]est|en fait|plutôt)\b/i,
  /\b(?:corrige|erreur|faux|incorrect)\b/i,
  /\bje\s+(?:voulais dire|ai dit)\b/i,
];

const MIN_TEXT_LENGTH = 8;
const MAX_TEXT_LENGTH = 300;

export function isWorthRemembering(text, { kind = 'general' } = {}) {
  const t = String(text ?? '').trim();
  if (t.length < MIN_TEXT_LENGTH || t.length > MAX_TEXT_LENGTH) return false;
  if (kind === 'correction') return CORRECTION_PATTERNS.some(re => re.test(t));
  return PREFERENCE_PATTERNS.some(re => re.test(t));
}

// Optional local-LLM-assisted extraction — Ollama ONLY, never cloud. Callers
// pass their own local `chatCompletion`-style function so this module has
// zero direct Ollama/router coupling and stays trivially unit-testable.
// Returns null (not "false") on any failure — extraction is best-effort and
// must never break the calling feature.
export async function extractWithOllama(localComplete, text) {
  if (typeof localComplete !== 'function') return null;
  try {
    const prompt = `Extrait UNE SEULE information durable (préférence, fait personnel, correction) de ce message, sous forme d'une phrase courte (max 200 caractères) à la première personne. Si rien ne mérite d'être retenu, réponds exactement "RIEN".\n\nMessage: "${String(text).slice(0, 1000)}"\n\nInformation à retenir:`;
    const result = await localComplete(prompt);
    const cleaned = String(result ?? '').trim();
    if (!cleaned || /^rien\.?$/i.test(cleaned) || cleaned.length > MAX_TEXT_LENGTH) return null;
    return cleaned;
  } catch {
    return null; // local extraction must never throw into the caller's request path
  }
}

// ── Source → privacy propagation ────────────────────────────────────────────
// Mirrors the exact rule server.js already applies to neurons: cv/candidature
// kinds and any private:true page are private. Connector-sourced content
// (Phase 2) is always private (source '*_private', see routes/connectors.js).
export function privacyFromSource({ kind, isPrivatePage, connectorSource, metadata, egressPolicy } = {}) {
  const isPrivate = isLocalOnlySource({ kind, private: isPrivatePage, egressPolicy, metadata: { ...metadata, ...(connectorSource ? { source: connectorSource } : {}) } });
  return { privacy: isPrivate, egressPolicy: isPrivate ? 'local_only' : 'cloud_allowed' };
}

// ── Dedup — merge near-identical memories to avoid unbounded growth ────────
// Simple normalized-text similarity (Jaccard over word sets) — no embedding
// call, so it's free to run on every write. Good enough for short factual
// sentences; a future phase could add semantic (embedding) dedup if this
// proves insufficient at scale (see MASTER_PHASE_3 report, scale test section).
function normalizeForDedup(text) {
  return String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s]/g, ' ').trim();
}

function wordSet(text) {
  return new Set(normalizeForDedup(text).split(/\s+/).filter(w => w.length >= 3));
}

export function jaccardSimilarity(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const DEDUP_THRESHOLD = 0.72;

export function findDuplicate(text, existingMemories) {
  return existingMemories.find(m => jaccardSimilarity(text, m.text ?? m.fact) >= DEDUP_THRESHOLD) ?? null;
}

// Adds an episodic memory unless a near-duplicate already exists — in that
// case, bumps the existing one's usage instead of growing the table.
export function addEpisodicMemoryDeduped({ text, category, source, sourceRef, privacy, egressPolicy, importance, confidence }) {
  const existing = listEpisodicMemories({ limit: 500 });
  // Do not merge across privacy boundaries: a private source must never
  // be represented by an older, public memory with similar wording.
  const localOnly = privacy === true || egressPolicy === 'local_only';
  const duplicate = findDuplicate(text, existing.filter(m => isLocalOnlySource(m) === localOnly));
  if (duplicate) {
    touchEpisodicMemory(duplicate.id);
    return { id: duplicate.id, deduped: true };
  }
  const id = addEpisodicMemory({ text, category, source, sourceRef, privacy, egressPolicy, importance, confidence });
  return { id, deduped: false };
}

// ── Context-budget-aware selection ──────────────────────────────────────────
// Never injects the whole memory store — picks a bounded, relevant subset.
// Scoring: keyword relevance to the current question (if any) + recency +
// frequency + importance. No embedding call — cheap enough to run per request.
function recencyScore(isoDate) {
  if (!isoDate) return 0;
  const ageMs = Date.now() - new Date(isoDate).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - ageDays / 90); // linear decay to 0 over ~90 days
}

function keywordRelevance(text, query) {
  if (!query) return 0.5; // neutral relevance when there's no specific question (e.g. chat system prompt)
  const q = normalizeForDedup(query);
  const t = normalizeForDedup(text);
  if (!q) return 0.5;
  if (t.includes(q)) return 1;
  const qWords = q.split(/\s+/).filter(w => w.length >= 3);
  if (qWords.length === 0) return 0.3;
  const hits = qWords.filter(w => t.includes(w)).length;
  return hits / qWords.length;
}

function scoreMemory(memory, query) {
  const text = memory.text ?? memory.fact;
  const relevance = keywordRelevance(text, query);
  const recency = recencyScore(memory.last_used_at ?? memory.updated_at ?? memory.created_at);
  const frequency = Math.min(1, (memory.usage_count ?? 0) / 10);
  const importance = memory.importance ?? 0.5;
  return relevance * 0.4 + importance * 0.3 + recency * 0.2 + frequency * 0.1;
}

// Returns up to budget.maxMemories items, each { id, text, tier, privacy,
// egressPolicy }, drawn from BOTH long-term (preference_facts) and episodic
// tiers, scored together and merged so the more relevant tier wins slots —
// never "N from each" regardless of relevance.
export function selectMemoriesForBudget({ query = null, budget = getMemorySettings().budget, includeLongTerm = true, includeEpisodic = true } = {}) {
  const limits = getBudgetLimits(budget);
  const candidates = [];
  if (includeLongTerm) {
    for (const f of listPreferenceFacts()) {
      candidates.push({ id: f.id, text: f.fact, tier: 'long_term', privacy: !!f.privacy, egressPolicy: f.egress_policy ?? 'cloud_allowed', raw: f });
    }
  }
  if (includeEpisodic) {
    for (const m of listEpisodicMemories({ limit: 500 })) {
      candidates.push({ id: m.id, text: m.text, tier: 'episodic', privacy: !!m.privacy, egressPolicy: m.egress_policy ?? 'cloud_allowed', raw: m });
    }
  }
  const scored = candidates
    .map(c => ({ ...c, score: scoreMemory(c.raw, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limits.maxMemories);

  for (const item of scored) {
    if (item.tier === 'long_term') touchPreferenceFact(item.id);
    else touchEpisodicMemory(item.id);
  }

  return scored.map(({ id, text, tier, privacy, egressPolicy }) => ({ id, text, tier, privacy, egressPolicy }));
}

export function resetAdaptiveMemory() {
  clearEpisodicMemories();
}
