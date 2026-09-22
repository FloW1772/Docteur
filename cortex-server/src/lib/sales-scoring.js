/**
 * Business/Sales Agent — transparent, deterministic lead scoring.
 *
 * PURE functions only (no LLM call, no randomness), mirroring
 * investment-scoring.js's discipline exactly: every factor exposes its
 * exact rule and the evidence that produced it — never an opaque number.
 * This module NEVER outputs a "contact this lead" recommendation; it only
 * structures relevance against a user-supplied, visible criteria set
 * (mission requirement: ANALYZE/SCORE must stay deterministic and
 * auditable, never an LLM-invented number).
 *
 * Scoring rule: for each user-supplied criterion (keyword + weight), count
 * keyword occurrences across the lead's research text. A criterion with
 * zero source text is "insufficient_data", not silently scored 0 — the
 * same "missing data is never invented" discipline as investment-scoring.
 * The final score is a weighted percentage of matched criteria out of all
 * evaluable ones (0-100), plus full per-criterion detail for audit.
 */

function matchCriterion(criterion, corpusLower) {
  if (!corpusLower) {
    return { ...criterion, matched: false, occurrences: 0, status: 'insufficient_data' };
  }
  const occurrences = corpusLower.split(criterion.keyword).length - 1;
  return { ...criterion, matched: occurrences > 0, occurrences, status: occurrences > 0 ? 'matched' : 'not_matched' };
}

/**
 * @param {Array<{id,keyword,weight,label}>} criteria - user-defined, validated via validateCriteria()
 * @param {Array<{content}>} sources - research source texts (already untrusted-wrapped upstream; only
 *        the plain content string is read here for keyword counting, never executed/interpreted)
 */
export function scoreLead({ criteria, sources }) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { score: null, dataCompleteness: 0, matched: [], unmatched: [], missingData: [], criteria: [] };
  }

  const corpusLower = (Array.isArray(sources) ? sources : [])
    .map((s) => (typeof s?.content === 'string' ? s.content : ''))
    .join('\n')
    .toLowerCase();

  const evaluated = criteria.map((c) => matchCriterion(c, corpusLower));
  const available = evaluated.filter((c) => c.status !== 'insufficient_data');
  const missing = evaluated.filter((c) => c.status === 'insufficient_data').map((c) => c.id);

  const totalWeight = available.reduce((acc, c) => acc + c.weight, 0);
  const matchedWeight = available.filter((c) => c.matched).reduce((acc, c) => acc + c.weight, 0);
  const score = available.length === 0 ? null : Math.round((matchedWeight / totalWeight) * 100);

  return {
    score, // 0-100 or null if nothing was evaluable (no source text at all)
    dataCompleteness: criteria.length === 0 ? 0 : available.length / criteria.length,
    matched: evaluated.filter((c) => c.status === 'matched').map((c) => ({ id: c.id, label: c.label, occurrences: c.occurrences })),
    unmatched: evaluated.filter((c) => c.status === 'not_matched').map((c) => ({ id: c.id, label: c.label })),
    missingData: missing,
    criteria: evaluated, // full per-criterion detail for audit — never a black box
  };
}
