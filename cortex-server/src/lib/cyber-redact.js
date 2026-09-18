/**
 * Evidence-layer redaction for the Cyber Audit Agent (SENTINEL V1).
 *
 * This is stricter than logger.js's redactSecrets/deepRedact (which exist
 * to scrub Docteur's OWN provider API keys from its own logs): evidence
 * captured from an AUDITED TARGET must never persist a raw
 * Authorization/Cookie/Set-Cookie VALUE, API key, token, or password —
 * even though the target's cookie is not Docteur's own secret, storing it
 * verbatim would still be storing a live credential belonging to whoever
 * is logged in on the auditor's machine/session, if the scan ever ran
 * against an authenticated context (out of scope for V1's unauthenticated
 * GET/HEAD/OPTIONS-only checks, but redaction is applied unconditionally
 * as defense in depth, per mission requirement: "redacter TOUTE donnée
 * sensible dans les preuves").
 *
 * Cookie handling is intentionally more surgical than logger.js's
 * field-level redaction: we want to KEEP the cookie's name and attributes
 * (Path, Domain, Secure, HttpOnly, SameSite, Expires/Max-Age) visible in
 * the report — that's the actual finding — while redacting only the
 * VALUE. logger.js's `cookie` path rule redacts the whole field, which is
 * correct for its own purpose (never log a session cookie at all) but too
 * coarse for a report whose entire point is describing cookie attributes.
 */

import { redactSecrets } from './logger.js';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-session-token',
]);

// JWT shape: header.payload.signature, each base64url. Not caught by any
// pattern in logger.js's SECRET_PATTERNS.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;

function redactText(text) {
  if (typeof text !== 'string') return text;
  return redactSecrets(text).replace(JWT_PATTERN, '[REDACTED_JWT]');
}

/**
 * Redacts a single Set-Cookie header VALUE while preserving every
 * attribute name — e.g. "session_id=abc123; Path=/; Secure; HttpOnly"
 * becomes "session_id=[REDACTED]; Path=/; Secure; HttpOnly". The cookie
 * NAME itself is kept (it's not a secret, and hiding it would make the
 * finding illegible), only the value after "=" on the first (name=value)
 * segment is redacted.
 */
export function redactCookieHeaderValue(setCookieValue) {
  if (typeof setCookieValue !== 'string') return setCookieValue;
  const [nameValue, ...attributes] = setCookieValue.split(';');
  const eq = nameValue.indexOf('=');
  if (eq === -1) return redactText(setCookieValue); // malformed — fall back to generic scrub
  const name = nameValue.slice(0, eq);
  return [`${name}=[REDACTED]`, ...attributes].join(';');
}

/**
 * Redacts an HTTP headers object (as returned by Node's http/https —
 * lowercase keys, string or string[] values) for safe storage as
 * evidence. Sensitive header VALUES are replaced; Set-Cookie is redacted
 * per-cookie via redactCookieHeaderValue so attributes stay legible.
 */
export function redactHeaders(headers) {
  if (typeof headers !== 'object' || headers === null) return {};
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie') {
      result[key] = Array.isArray(value) ? value.map(redactCookieHeaderValue) : redactCookieHeaderValue(value);
      continue;
    }
    if (SENSITIVE_HEADER_NAMES.has(lower)) {
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = Array.isArray(value) ? value.map(redactText) : redactText(String(value));
  }
  return result;
}

/**
 * Redacts a response body excerpt (never the full body — evidence storage
 * only ever keeps a short excerpt, see cyber-evidence.js maxExcerptLength)
 * for embedded secrets (API keys, JWTs, bearer tokens) that a target page
 * might leak in its own HTML/JSON.
 */
export function redactBodyExcerpt(excerpt) {
  return redactText(excerpt);
}

/**
 * Recursively redacts every string value in an arbitrary evidence object
 * (depth-bounded, mirrors logger.js's deepRedact bound) — the last-resort
 * catch-all for any evidence shape not covered by the more surgical
 * helpers above.
 */
export function deepRedactEvidence(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(v => deepRedactEvidence(v, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = key.toLowerCase() === 'headers' ? redactHeaders(val) : deepRedactEvidence(val, depth + 1);
    }
    return result;
  }
  return value;
}
