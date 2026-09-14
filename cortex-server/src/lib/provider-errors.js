// Standardized error categories for all AI provider calls, shared by every
// provider module and consumed by router.js for fallback/cooldown decisions.
//
// Every provider throws a plain Error with a `.category` field set to one of
// these constants (plus optional `.retryAfterMs` for RATE_LIMITED). This
// replaces the previous inconsistent set of ad hoc flags (`isQuota`, `isAuth`,
// `isModelNotFound` existed only on some providers) with one contract every
// provider and the router agree on.

export const ErrorCategory = Object.freeze({
  MODEL_UNAVAILABLE:      'MODEL_UNAVAILABLE',
  QUOTA_EXCEEDED:         'QUOTA_EXCEEDED',
  RATE_LIMITED:           'RATE_LIMITED',
  AUTH_FAILED:            'AUTH_FAILED',
  PROVIDER_UNAVAILABLE:   'PROVIDER_UNAVAILABLE',
  CONTEXT_TOO_LONG:       'CONTEXT_TOO_LONG',
  CAPABILITY_UNSUPPORTED: 'CAPABILITY_UNSUPPORTED',
  TIMEOUT:                'TIMEOUT',
  NETWORK_ERROR:          'NETWORK_ERROR',
  UNKNOWN:                'UNKNOWN',
});

export function classifiedError(message, category, extra = {}) {
  const err = new Error(message);
  err.category = category;
  Object.assign(err, extra);
  return err;
}

// Maps a provider's raw HTTP status + parsed body into a standard category.
// `bodyText` is used for providers whose error signal is buried in a message
// string (e.g. "context_length_exceeded", "insufficient_quota").
export function classifyHttpError(status, body, bodyText = '') {
  const msg = `${body?.error?.message ?? body?.error?.type ?? body?.error?.code ?? bodyText ?? ''}`.toLowerCase();

  if (status === 401 || status === 403) return ErrorCategory.AUTH_FAILED;
  if (status === 404) return ErrorCategory.MODEL_UNAVAILABLE;
  if (status === 429) {
    // Some providers (OpenAI) return 429 for both rate limits AND exhausted
    // monthly quota/insufficient credits — distinguish via the message body.
    if (msg.includes('insufficient_quota') || msg.includes('insufficient credit') ||
        msg.includes('exceeded your current quota') || msg.includes('billing')) {
      return ErrorCategory.QUOTA_EXCEEDED;
    }
    return ErrorCategory.RATE_LIMITED;
  }
  if (status === 413 || msg.includes('context_length_exceeded') || msg.includes('too many tokens') ||
      msg.includes('maximum context length') || msg.includes('context window')) {
    return ErrorCategory.CONTEXT_TOO_LONG;
  }
  if (status >= 500 && status < 600) return ErrorCategory.PROVIDER_UNAVAILABLE;
  return ErrorCategory.UNKNOWN;
}

// Wraps network-level failures (fetch throwing before a response exists):
// DNS failure, connection refused, AbortSignal timeout, etc.
export function classifyNetworkError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return ErrorCategory.TIMEOUT;
  return ErrorCategory.NETWORK_ERROR;
}

// Parse Retry-After from HTTP header (seconds) or a provider-specific
// RetryInfo-style detail array (Gemini). Returns milliseconds or null.
export function parseRetryAfterMs(headers, body) {
  const h = headers?.get?.('retry-after') ?? headers?.get?.('Retry-After');
  if (h) {
    const secs = Number.parseInt(h, 10);
    if (!Number.isNaN(secs)) return secs * 1000;
  }
  for (const detail of body?.error?.details ?? []) {
    if (detail?.retryDelay) {
      const secs = Number.parseInt(detail.retryDelay, 10);
      if (!Number.isNaN(secs)) return secs * 1000;
    }
  }
  return null;
}
