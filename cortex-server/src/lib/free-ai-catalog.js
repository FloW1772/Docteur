// Free AI Finder catalog: discovery-only layer over the public
// free-llm-api-hub dataset (https://github.com/pacocartones/free-llm-api-hub).
//
// This module NEVER reads browser cookies/sessions, never automates account
// creation, never scrapes a private dashboard, and never stores an API key.
// It fetches one fixed, allowlisted public JSON URL, validates its shape,
// normalizes it into a stable internal model, and caches the result — the
// same module-level TTL cache idiom used by providers/freellmapi.js
// (cache/cacheKey/cacheAt + exported clearXCache()).
//
// Field names below mirror the dataset's real schema.json exactly (slug,
// name, category, free_type, free_tier, docs_url, phone_required,
// card_required, commercial_ok, openai_compatible, openai_base_url,
// modalities, verified, last_verified, models_free). Nothing is invented:
// the dataset has no signup_url/pricing_url field, so we only ever expose
// docs_url as the "get a key" destination.

import { ErrorCategory, classifiedError, classifyNetworkError } from './provider-errors.js';

// Fixed, allowlisted source — never derived from user/query input, so this
// can never become an SSRF vector via a caller-supplied URL.
const CATALOG_URL = 'https://raw.githubusercontent.com/pacocartones/free-llm-api-hub/main/data/providers.json';
const CATALOG_SOURCE_LABEL = 'free-llm-api-hub';
const CATALOG_REPO_URL = 'https://github.com/pacocartones/free-llm-api-hub';

const FETCH_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // a few MB, generous for a JSON dataset
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const VALID_CATEGORIES = new Set(['ongoing', 'trial']);
const VALID_FREE_TYPES = new Set(['perpetual', 'renewing-quota', 'recurring-credit', 'trial-credit']);
const VALID_MODALITIES = new Set(['text', 'vision', 'image', 'audio', 'embeddings', 'rerank', 'ocr']);

let cache = null;       // { providers, generated, version, source, fetchedAt }
let cacheAt = 0;
let cacheEtag = null;

// Maps a catalog slug to a Docteur-native provider id — only when the
// mapping is unambiguous and verified against the provider's own module,
// never inferred from name similarity alone.
export const NATIVE_PROVIDER_MAP = Object.freeze({
  groq: 'groq',
  'google-gemini': 'gemini',
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  openai: 'openai',
});

function tristate(value) {
  return value === true || value === false ? value : null;
}

// Never invent a value absent from the dataset — pass through null/'inconnu'.
export function normalizeFreeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const slug = typeof raw.slug === 'string' ? raw.slug : null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!slug || !name) return null; // required by schema.json — skip malformed entries rather than guess

  const category = VALID_CATEGORIES.has(raw.category) ? raw.category : null;
  const freeType = VALID_FREE_TYPES.has(raw.free_type) ? raw.free_type : null;
  const modalities = Array.isArray(raw.modalities)
    ? raw.modalities.filter(m => VALID_MODALITIES.has(m))
    : [];

  const nativeProviderId = NATIVE_PROVIDER_MAP[slug] ?? null;

  return {
    id: slug,
    name,
    category,               // 'ongoing' | 'trial' | null
    freeType,                // 'perpetual' | 'renewing-quota' | 'recurring-credit' | 'trial-credit' | null
    freeTier: typeof raw.free_tier === 'string' ? raw.free_tier : null,
    rateLimits: typeof raw.rate_limits === 'string' ? raw.rate_limits : null,
    notes: typeof raw.notes === 'string' ? raw.notes : null,
    bestFor: typeof raw.best_for === 'string' ? raw.best_for : null,
    modalities,
    modelsFree: Array.isArray(raw.models_free) ? raw.models_free.filter(m => typeof m === 'string') : null,
    expires: typeof raw.expires === 'string' ? raw.expires : null,

    cardRequired: tristate(raw.card_required),
    phoneRequired: tristate(raw.phone_required),
    commercialUse: tristate(raw.commercial_ok),
    openAICompatible: tristate(raw.openai_compatible),
    openAIBaseUrl: typeof raw.openai_base_url === 'string' ? raw.openai_base_url : null,

    docsUrl: typeof raw.docs_url === 'string' ? raw.docs_url : null,

    verified: raw.verified === true,
    lastVerified: typeof raw.last_verified === 'string' ? raw.last_verified : null,
    added: typeof raw.added === 'string' ? raw.added : null,

    nativeDocteurProvider: nativeProviderId,
    // configuredInDocteur / availableViaFreeLLMAPI are filled in by the
    // route layer (they need live secret-store / FreeLLMAPI state, which
    // this pure catalog module has no access to and should not depend on).
  };
}

function validateDataset(json) {
  if (!json || typeof json !== 'object') throw new Error('dataset JSON invalide (racine non-objet)');
  if (!Array.isArray(json.providers)) throw new Error('dataset JSON invalide (providers manquant)');
  if (json.providers.length === 0) throw new Error('dataset JSON invalide (providers vide)');
  return json;
}

async function fetchCatalog() {
  let response;
  try {
    response = await fetch(CATALOG_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'Docteur-FreeAIFinder' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const category = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? ErrorCategory.TIMEOUT
      : classifyNetworkError(error);
    throw classifiedError('Free AI Finder: catalogue en ligne indisponible', category);
  }

  if (!response.ok) {
    throw classifiedError(`Free AI Finder: catalogue en ligne indisponible (${response.status})`, ErrorCategory.PROVIDER_UNAVAILABLE);
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw classifiedError('Free AI Finder: réponse du catalogue anormalement volumineuse', ErrorCategory.UNKNOWN);
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw classifiedError('Free AI Finder: réponse du catalogue anormalement volumineuse', ErrorCategory.UNKNOWN);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw classifiedError('Free AI Finder: catalogue JSON invalide', ErrorCategory.UNKNOWN);
  }

  validateDataset(json);

  const providers = json.providers
    .map(normalizeFreeProvider)
    .filter(Boolean);

  return {
    providers,
    generated: typeof json.generated === 'string' ? json.generated : null,
    version: typeof json.version === 'string' ? json.version : null,
    source: CATALOG_SOURCE_LABEL,
    sourceRepo: CATALOG_REPO_URL,
    fetchedAt: new Date().toISOString(),
    etag: response.headers.get('etag') ?? null,
  };
}

// Returns { result, stale, fromCache, error }.
// - force=true always attempts a fresh fetch (used by the manual "Actualiser").
// - On fetch failure, falls back to the last good cache if one exists.
// - Never throws when a cache exists; only throws when there is no cache at
//   all and the fetch also failed (route layer turns that into a clean
//   empty-state response, never a 500).
export async function getCatalog({ force = false } = {}) {
  const isFresh = cache && (Date.now() - cacheAt) < CACHE_TTL_MS;
  if (!force && isFresh) {
    return { result: cache, stale: false, fromCache: true, error: null };
  }

  try {
    const result = await fetchCatalog();
    cache = result;
    cacheAt = Date.now();
    cacheEtag = result.etag;
    return { result, stale: false, fromCache: false, error: null };
  } catch (error) {
    if (cache) {
      return { result: cache, stale: true, fromCache: true, error: error.message };
    }
    throw error;
  }
}

// Strict-Local-safe read: returns whatever is cached (possibly nothing) and
// NEVER calls fetch(), regardless of TTL. Used by the route layer so that
// under Strict Local, an empty cache means an empty result — never an
// implicit first-time network fetch.
export function getCachedCatalogOnly() {
  if (!cache) {
    return { result: { providers: [], generated: null, version: null, source: CATALOG_SOURCE_LABEL, sourceRepo: CATALOG_REPO_URL, fetchedAt: null }, stale: false, fromCache: false, error: null };
  }
  return { result: cache, stale: (Date.now() - cacheAt) >= CACHE_TTL_MS, fromCache: true, error: null };
}

export function clearCatalogCache() {
  cache = null;
  cacheAt = 0;
  cacheEtag = null;
}

export function getCacheInfo() {
  return {
    cached: !!cache,
    cachedAt: cache ? new Date(cacheAt).toISOString() : null,
    ageMs: cache ? Date.now() - cacheAt : null,
    stale: cache ? (Date.now() - cacheAt) >= CACHE_TTL_MS : null,
  };
}

export const CATALOG_META = Object.freeze({
  url: CATALOG_URL,
  source: CATALOG_SOURCE_LABEL,
  repo: CATALOG_REPO_URL,
  ttlMs: CACHE_TTL_MS,
});
