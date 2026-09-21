import type { FreeAiProvider } from './cortex/client';

export const MAX_RECOMMENDED_FREE_APIS = 6;

// Derived provider status, computed entirely from the existing catalog
// dataset (category/verified/verificationFreshness) — no new field is
// invented and nothing is fetched to compute this (mission AI-5 §7).
// The dataset has no explicit "deprecated"/"retired" flag, so a provider
// that is unverified AND long stale is the closest honest signal this
// catalog can give for "probably dead" without guessing.
export type FreeProviderStatus = 'AVAILABLE' | 'UNKNOWN' | 'STALE' | 'DEPRECATED' | 'UNAVAILABLE';

export function deriveProviderStatus(p: FreeAiProvider): FreeProviderStatus {
  if (p.verificationFreshness === 'recheck' && !p.verified) return 'DEPRECATED';
  if (p.verificationFreshness === 'recheck') return 'STALE';
  if (p.verificationFreshness === 'unknown' || p.category === null) return 'UNKNOWN';
  if (p.verificationFreshness === 'aging') return 'STALE';
  return 'AVAILABLE';
}

// 100% deterministic, no LLM (mission §5). Lower is better — an explicit,
// inspectable rule list rather than an opaque single score.
function rank(p: FreeAiProvider): number {
  const status = deriveProviderStatus(p);
  let r = 0;
  if (status === 'DEPRECATED' || status === 'UNAVAILABLE') return Number.POSITIVE_INFINITY; // never recommended
  if (p.docteurState === 'configured') r -= 1000; // already configured and working for this user
  if (p.nativeDocteurProvider) r -= 100; // native Docteur provider
  if (status === 'AVAILABLE') r -= 50;
  if (p.verified) r -= 20;
  if (p.freeType === 'perpetual' || p.freeType === 'renewing-quota') r -= 15; // real, documented, non-trial free tier
  if (p.docsUrl) r -= 5; // reliable documentation/source
  if (p.modelsFree && p.modelsFree.length > 0) r -= 5; // useful models actually listed
  if (p.cardRequired === false) r -= 3; // simple to configure
  if (status === 'STALE') r += 10;
  if (status === 'UNKNOWN') r += 5;
  return r;
}

/**
 * Deterministic sort used by both the recommended subset and "View all"
 * (mission §17): configured first, then available/verified, alphabetical
 * fallback for stability — never a random or session-varying order.
 */
export function sortFreeProviders(providers: FreeAiProvider[]): FreeAiProvider[] {
  return [...providers].sort((a, b) => {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Selects up to MAX_RECOMMENDED_FREE_APIS providers. DEPRECATED/UNAVAILABLE
 * providers are never eligible (mission §7). Pure and deterministic —
 * same input always produces the same output.
 */
export function selectRecommendedFreeProviders(providers: FreeAiProvider[]): FreeAiProvider[] {
  const eligible = providers.filter(p => {
    const status = deriveProviderStatus(p);
    return status !== 'DEPRECATED' && status !== 'UNAVAILABLE';
  });
  return sortFreeProviders(eligible).slice(0, MAX_RECOMMENDED_FREE_APIS);
}

export interface FreeProviderFilters {
  search?: string;
  configured?: boolean;
  nativeOnly?: boolean;
  modality?: string;
  cardFree?: boolean;
}

/** Local-only filtering — never triggers a network call per keystroke (mission §15). */
export function filterFreeProviders(providers: FreeAiProvider[], filters: FreeProviderFilters): FreeAiProvider[] {
  const q = filters.search?.trim().toLowerCase() ?? '';
  return providers.filter(p => {
    if (q) {
      const haystack = [p.name, p.id, p.bestFor ?? '', ...(p.modelsFree ?? []), ...p.modalities].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filters.configured != null && p.configuredInDocteur !== filters.configured) return false;
    if (filters.nativeOnly && !p.nativeDocteurProvider) return false;
    if (filters.modality && !p.modalities.includes(filters.modality)) return false;
    if (filters.cardFree && p.cardRequired !== false) return false;
    return true;
  });
}
