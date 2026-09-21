import type { LocalAiRecommendationEntry, FitRating } from './cortex/client';

export const MAX_RECOMMENDED = 6;

// Categories the recommended view tries to cover, per mission AI-4 §7 —
// never forced if no verified model genuinely qualifies for a slot. The
// untagged "best overall" slot is resolved LAST (see buildRecommendedSubset)
// so it only picks up whatever the specific-capability slots didn't already
// claim, rather than greedily stealing the best candidate from all of them.
export const RECOMMENDATION_SLOTS: { tag: string | null; label: string }[] = [
  { tag: 'LOW_RESOURCE', label: 'Low-resource option' },
  { tag: 'CODING', label: 'Good fit for coding' },
  { tag: 'REASONING', label: 'Good fit for reasoning' },
  { tag: 'MULTIMODAL', label: 'Multimodal option' },
  { tag: 'POWERFUL', label: 'Powerful local option' },
  { tag: null, label: 'Best overall fit' },
];

const FIT_RANK: Record<FitRating, number> = { EXCELLENT: 4, GOOD: 3, TIGHT: 2, UNKNOWN: 1, NOT_RECOMMENDED: 0 };

/**
 * Deterministic, non-LLM selection of a small "Recommended for this PC"
 * subset (mission §6/§7/§8/§25): at most MAX_RECOMMENDED cards, never a
 * "best model in the world" ranking — each slot is labeled by what it's
 * good for. NOT_RECOMMENDED entries are never eligible. A slot is simply
 * skipped if nothing qualifies, rather than being forced.
 */
export function buildRecommendedSubset(
  results: LocalAiRecommendationEntry[],
): { entry: LocalAiRecommendationEntry; badge: string }[] {
  const eligible = results.filter(r => r.fit.rating !== 'NOT_RECOMMENDED');
  const picked = new Map<string, { entry: LocalAiRecommendationEntry; badge: string }>();

  for (const slot of RECOMMENDATION_SLOTS) {
    if (picked.size >= MAX_RECOMMENDED) break;
    const candidates = slot.tag ? eligible.filter(r => r.model.useCaseTags.includes(slot.tag as string)) : eligible;
    const best = candidates
      .filter(r => !picked.has(r.distribution.id))
      .sort((a, b) => FIT_RANK[b.fit.rating] - FIT_RANK[a.fit.rating])[0];
    if (best) picked.set(best.distribution.id, { entry: best, badge: slot.label });
  }

  return Array.from(picked.values()).slice(0, MAX_RECOMMENDED);
}
