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

// C3c: credential shapes the Root Policy SECRET_SHAPES list (signed module, unchanged) does not cover. High precision
// only — a fixed vendor prefix plus a long token body — so ordinary text, code and public keys are never blocked.
const CLOUD_SECRET_SHAPES = Object.freeze([
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/,         // OpenAI project / service-account / admin keys
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/,                 // Stripe secret / restricted keys
  /\bhf_[A-Za-z0-9]{30,}/,                                  // Hugging Face
  /\bglpat-[A-Za-z0-9_-]{20,}/,                             // GitLab personal access token
  /\bgh[osur]_[A-Za-z0-9]{36,}/,                            // GitHub OAuth / server / user / refresh tokens
  /\bASIA[0-9A-Z]{16}\b/,                                   // AWS temporary access key id
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,       // any PEM / PGP private key block
  /\bAGE-SECRET-KEY-1[0-9A-Z]{20,}/,                        // age secret key
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/,                            // Google OAuth client secret
  /\bnpm_[A-Za-z0-9]{36}\b/,                                // npm access token
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/,                       // Telegram bot token
]);

export function containsCloudSecretShape(messages) {
  let text;
  try { text = JSON.stringify(messages) ?? ''; } catch { return false; }
  return CLOUD_SECRET_SHAPES.some((re) => re.test(text));
}

export class SecretExposureError extends PrivacyViolationError {
  constructor(provider, functionCalled) {
    super(provider, functionCalled);
    this.message = `Appel cloud bloqué : secret ou identifiant détecté (${provider} / ${functionCalled})`;
    this.name = 'SecretExposureError';
    this.reason = 'SECRET_SHAPE';
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
    try { settings = getRouterSettings(); } catch { /* unreadable settings: cloud stays closed below */ }
    // C1a: cloud only on an explicit boolean opt-in — absent, null, non-boolean or unreadable never enables it.
    enforceCloudAi({ provider, messages, strictLocal: settings?.strict_local_mode === true, cloudEnabled: settings?.cloud_enabled === true });
    // C3c: after the policy (Strict Local / opt-in refusals keep their order), the complementary credential shapes.
    if (containsCloudSecretShape(messages)) {
      try { insertPrivacyViolation({ functionCalled, providerTargeted: provider }); } catch { /* db might not be ready */ }
      throw new SecretExposureError(provider, functionCalled);
    }
  }
}

export function getViolations(limit = 100) {
  return dbGetViolations(limit);
}
