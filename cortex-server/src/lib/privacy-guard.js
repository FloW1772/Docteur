// Privacy Guard — exit-point lock preventing private neuron content from
// reaching any cloud provider. Deterministic sentinel scan; no AI involved.
//
// HOW IT WORKS:
//   1. buildContextMessages marks private source content with PRIVATE_SENTINEL.
//   2. Every cloud provider's complete() calls guardCloudCall() before the
//      HTTP request. If the sentinel is found → block + log + throw.
//   3. If the routing guard in answerQuestion works correctly, the sentinel
//      never appears in cloud payloads. This is a belt-and-suspenders check.

import { insertPrivacyViolation, getPrivacyViolations as dbGetViolations, getRouterSettings } from './sqlite.js';
import { enforceCloudAi } from './root-policy/index.js';

// Plain-text sentinel — deliberately NOT a raw control character. A raw
// null byte here would be escaped by JSON.stringify() into the literal
// 6-character text '\u0000', which can never match a raw-byte .includes()
// check against that escaped output — that exact bug previously made this
// scan always return false (containsPrivateContent always false, guardCloudCall
// never threw, for both private AND neutral content). Using ordinary Unicode
// word-joiner-wrapped text means it round-trips through JSON.stringify()
// unchanged, while still being vanishingly unlikely to occur naturally.
export const PRIVATE_SENTINEL = '⁣DOCTEUR_PRIVATE_CONTENT_MARKER⁣';

// Prepend sentinel to private neuron content before injecting into messages.
export function markPrivate(text) {
  return PRIVATE_SENTINEL + (text ?? '');
}

// Deterministic scan: stringify the full messages array and check for sentinel.
// Fast enough to call on every cloud request without measurable overhead.
export function containsPrivateContent(messages) {
  try {
    return JSON.stringify(messages).includes(PRIVATE_SENTINEL);
  } catch {
    return false;
  }
}

export class PrivacyViolationError extends Error {
  constructor(provider, functionCalled) {
    super(`Appel cloud bloqué : contenu privé détecté (${provider} / ${functionCalled})`);
    this.name = 'PrivacyViolationError';
    this.isPrivacyViolation = true;
    this.provider = provider;
  }
}

// Call at the top of every cloud provider complete() before any HTTP request.
// Throws PrivacyViolationError and logs the incident (without content) if
// private content is detected.
//
// `simulate: true` is for the synthetic self-test only (routes/privacy.js):
// it still runs the exact same detection logic and throws the same error,
// but never writes to the incident log — a deterministic self-test with
// synthetic payloads is not a real runtime leak attempt and must not be
// recorded as one (the incident log is reserved for genuine blocked calls).
export function guardCloudCall({ messages, provider, functionCalled, simulate = false }) {
  if (containsPrivateContent(messages)) {
    if (!simulate) {
      try { insertPrivacyViolation({ functionCalled, providerTargeted: provider }); } catch { /* db might not be ready */ }
    }
    throw new PrivacyViolationError(provider, functionCalled);
  }
  // ROOT POLICY (rules 1, 2, 9): AI_CLOUD_REQUEST — strict local, explicit cloud opt-in, no secret in the payload, fail closed on an
  // untrusted policy. The synthetic self-test (simulate) never reaches a provider and is not a real request.
  if (!simulate) {
    let settings = null;
    try { settings = getRouterSettings(); } catch { /* db not ready: defaults below */ }
    enforceCloudAi({ provider, messages, strictLocal: settings?.strict_local_mode === true, cloudEnabled: settings?.cloud_enabled !== false });
  }
}

export function getViolations(limit = 100) {
  return dbGetViolations(limit);
}
