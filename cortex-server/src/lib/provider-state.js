// Per-provider health state + cooldown tracking, shared by router.js and any
// route that calls a cloud provider directly. In-memory only (per-process) —
// state resets on server restart, which is desired: a fresh boot should
// re-probe every provider rather than remember yesterday's outage.

import { ErrorCategory } from './provider-errors.js';

export const ProviderState = Object.freeze({
  READY:              'ready',
  RATE_LIMITED:       'rate_limited',
  QUOTA_EXHAUSTED:    'quota_exhausted',
  AUTH_REQUIRED:      'auth_required',
  OFFLINE:            'offline',
  MODEL_UNAVAILABLE:  'model_unavailable',
  ERROR:              'error',
  // Distinct from AUTH_REQUIRED (no key set) and READY (key set and
  // readable): a credential blob exists in storage but cannot be decrypted
  // (corrupted, or written under a different Windows user/machine). Detected
  // by secret-store.js's getSecretStatus(); never auto-cleared by cooldown
  // expiry — only replacing the key (setSecret) or deleting it clears this.
  CREDENTIAL_INVALID: 'credential_invalid',
});

// Cooldown durations per category — how long we skip a provider before
// retrying automatically. AUTH_FAILED gets the longest cooldown since
// retrying it wastes calls until the user fixes the key; a manual "Retester
// maintenant" (see routes/router.js POST /router/test/:provider) always
// bypasses cooldown immediately.
const COOLDOWN_MS = {
  [ErrorCategory.RATE_LIMITED]:           60 * 1000,        // 1 min, unless Retry-After says more
  [ErrorCategory.QUOTA_EXCEEDED]:         30 * 60 * 1000,    // 30 min
  [ErrorCategory.AUTH_FAILED]:            15 * 60 * 1000,    // 15 min — needs human fix, don't hammer
  [ErrorCategory.PROVIDER_UNAVAILABLE]:   2 * 60 * 1000,     // 2 min
  [ErrorCategory.NETWORK_ERROR]:          2 * 60 * 1000,
  [ErrorCategory.TIMEOUT]:                1 * 60 * 1000,
  [ErrorCategory.MODEL_UNAVAILABLE]:      10 * 60 * 1000,    // model likely renamed/retired — recheck occasionally
  [ErrorCategory.CONTEXT_TOO_LONG]:       0,                 // not a provider health issue — never cooldown for this
  [ErrorCategory.CAPABILITY_UNSUPPORTED]: 0,                 // static fact about the provider, not transient
};

function categoryToState(category) {
  switch (category) {
    case ErrorCategory.RATE_LIMITED:         return ProviderState.RATE_LIMITED;
    case ErrorCategory.QUOTA_EXCEEDED:       return ProviderState.QUOTA_EXHAUSTED;
    case ErrorCategory.AUTH_FAILED:          return ProviderState.AUTH_REQUIRED;
    case ErrorCategory.PROVIDER_UNAVAILABLE:
    case ErrorCategory.NETWORK_ERROR:
    case ErrorCategory.TIMEOUT:              return ProviderState.OFFLINE;
    case ErrorCategory.MODEL_UNAVAILABLE:    return ProviderState.MODEL_UNAVAILABLE;
    default:                                 return ProviderState.ERROR;
  }
}

// providerId -> { state, until (epoch ms, 0 = no cooldown), reason, category, lastError, lastCheckedAt }
const _state = new Map();

function getEntry(providerId) {
  return _state.get(providerId) ?? { state: ProviderState.READY, until: 0, reason: null, category: null, lastError: null, lastCheckedAt: 0 };
}

// Records a failure and puts the provider in cooldown for the category's
// configured duration (or the provider's own Retry-After if longer/shorter
// and more specific, e.g. Gemini/OpenAI 429 responses).
export function recordFailure(providerId, err) {
  const category = err?.category ?? ErrorCategory.UNKNOWN;
  const baseCooldown = COOLDOWN_MS[category] ?? 60 * 1000;
  const retryAfterMs = typeof err?.retryAfterMs === 'number' ? err.retryAfterMs : null;
  const cooldownMs = retryAfterMs ?? baseCooldown;

  const entry = {
    state: categoryToState(category),
    until: cooldownMs > 0 ? Date.now() + cooldownMs : 0,
    reason: err?.message ?? category,
    category,
    lastError: err?.message ?? null,
    lastCheckedAt: Date.now(),
  };
  _state.set(providerId, entry);
  return entry;
}

export function recordSuccess(providerId) {
  _state.set(providerId, { state: ProviderState.READY, until: 0, reason: null, category: null, lastError: null, lastCheckedAt: Date.now() });
}

// Manual "Retester maintenant" — clears cooldown immediately so the very
// next call actually re-probes the provider instead of skipping it.
export function clearCooldown(providerId) {
  const entry = getEntry(providerId);
  _state.set(providerId, { ...entry, until: 0 });
}

export function isInCooldown(providerId) {
  const entry = getEntry(providerId);
  return entry.until > Date.now();
}

export function getProviderStatus(providerId) {
  const entry = getEntry(providerId);
  const inCooldown = entry.until > Date.now();
  return {
    provider: providerId,
    state: inCooldown ? entry.state : (entry.state === ProviderState.READY ? ProviderState.READY : entry.state),
    in_cooldown: inCooldown,
    cooldown_until: inCooldown ? entry.until : null,
    cooldown_remaining_ms: inCooldown ? entry.until - Date.now() : 0,
    reason: entry.reason,
    last_checked_at: entry.lastCheckedAt || null,
  };
}

export function getAllProviderStatuses(providerIds) {
  return Object.fromEntries(providerIds.map(id => [id, getProviderStatus(id)]));
}

// Test-only: reset all in-memory provider state between test cases.
export function _resetAllForTests() {
  _state.clear();
}
