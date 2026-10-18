// [SEC-REMED-4] Provider errors are UNTRUSTED DATA.
//
// An upstream model provider (local runtime or cloud API) chooses the text of its own errors: it can echo the
// credential it received (Authorization header, api_key=…), a private filesystem path, a stack trace, SQL
// diagnostics, or its whole response body. That text must never reach the client or a persistent log.
//
// What crosses the boundary instead:
//   • a stable error code (decided by Docteur — classification may READ the raw text, it never COPIES it);
//   • a fixed user message and hint written here, chosen from a closed table;
//   • metadata that is explicitly allowlisted and bounded (provider id, model tag, closed category, HTTP status).
// The logger's regex redaction (logger.js redactSecrets) stays as defense in depth; it is not the control.
import { ErrorCategory } from './provider-errors.js';

export const SAFE_PROVIDER_ERROR_MESSAGE = 'Le fournisseur de modèle a rencontré une erreur.';

const DEFAULT_HINT = 'Réessayez, ou choisissez un autre modèle. Le détail brut du fournisseur n’est jamais affiché.';

// Keyed by the closed ErrorCategory set by Docteur's own provider modules (err.category) — never by provider text.
const CATEGORY_HINTS = Object.freeze({
  [ErrorCategory.AUTH_FAILED]: 'Le fournisseur a refusé l’authentification : vérifiez la clé ou l’abonnement dans Réglages.',
  [ErrorCategory.QUOTA_EXCEEDED]: 'Quota du fournisseur épuisé : réessayez plus tard ou choisissez un autre modèle.',
  [ErrorCategory.RATE_LIMITED]: 'Trop de requêtes vers ce fournisseur : patientez puis réessayez.',
  [ErrorCategory.MODEL_UNAVAILABLE]: 'Ce modèle n’est pas disponible chez ce fournisseur : choisissez-en un autre.',
  [ErrorCategory.CONTEXT_TOO_LONG]: 'Message trop long pour ce modèle : raccourcissez-le ou choisissez un modèle à plus long contexte.',
  [ErrorCategory.CAPABILITY_UNSUPPORTED]: 'Ce modèle ne prend pas en charge cette demande : choisissez-en un autre.',
  [ErrorCategory.PROVIDER_UNAVAILABLE]: 'Le fournisseur est momentanément indisponible : réessayez plus tard.',
  [ErrorCategory.NETWORK_ERROR]: 'Le fournisseur est injoignable : vérifiez la connexion puis réessayez.',
});

const CATEGORIES = new Set(Object.values(ErrorCategory));
const MODEL_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const OPERATION_RE = /^[a-z][a-z0-9_.-]{0,59}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,59}$/;

/** Closed category set by a Docteur provider module, or null. */
export function safeErrorCategory(error) {
  const c = error?.category;
  return typeof c === 'string' && CATEGORIES.has(c) ? c : null;
}

/** A model tag as Ollama / the registry names it, or null when it does not look like one (never echoed as is). */
export function safeModelTag(value) {
  return typeof value === 'string' && MODEL_TAG_RE.test(value) ? value : null;
}

/** Fixed hint for a provider failure, chosen from the closed category table. */
export function providerErrorHint(error) {
  const category = safeErrorCategory(error);
  return (category && CATEGORY_HINTS[category]) ?? DEFAULT_HINT;
}

/** HTTP status reported with the failure, as a bounded integer (ollama-js ResponseError.status_code, fetch status). */
function safeHttpStatus(error) {
  const s = Number(error?.status_code ?? error?.statusCode ?? error?.status);
  return Number.isInteger(s) && s >= 100 && s <= 599 ? s : null;
}

/**
 * The ONLY fields to log about a provider failure. Field names avoid the logger's redacted paths (code, key, token…).
 * Never error.message / stack / cause / body.
 */
export function providerErrorLogFields(error, { errorCode = 'PROVIDER_ERROR', provider = null, model = null, operation = null } = {}) {
  return {
    errorCode: typeof errorCode === 'string' && ERROR_CODE_RE.test(errorCode) ? errorCode : 'PROVIDER_ERROR',
    provider: typeof provider === 'string' && PROVIDER_ID_RE.test(provider) ? provider : null,
    model: safeModelTag(model),
    operation: typeof operation === 'string' && OPERATION_RE.test(operation) ? operation : null,
    category: safeErrorCategory(error),
    httpStatus: safeHttpStatus(error),
  };
}
