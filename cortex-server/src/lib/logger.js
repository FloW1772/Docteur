import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

// Redacts common secret shapes wherever they appear in logged objects —
// API keys, Authorization headers, OAuth/session tokens — regardless of which
// feature logged them. Pino redacts by path before serialization, and the
// wildcards below cover the field names actually used across provider
// modules and routes (apiKey, api_key, key, Authorization, token, cookie).
const REDACT_PATHS = [
  'apiKey', '*.apiKey', '*.*.apiKey',
  'api_key', '*.api_key', '*.*.api_key',
  'key', '*.key', '*.*.key',
  'headers.authorization', '*.headers.authorization',
  'headers["x-api-key"]', '*.headers["x-api-key"]',
  'token', '*.token', '*.*.token',
  'access_token', '*.access_token',
  'refresh_token', '*.refresh_token',
  'setup_token', '*.setup_token',
  'cookie', '*.cookie', 'headers.cookie', '*.headers.cookie',
  // OMEGA V1 Phase 2 — device identity/pairing/session secrets. Never
  // logged in full even at debug level: pairing codes, session tokens,
  // and private key material must never appear in any log output
  // (mission §28/§56/T15/T16). This is the one shared redaction
  // choke point for every module, OMEGA included — no separate
  // redaction mechanism.
  'pairingCode', '*.pairingCode', '*.*.pairingCode',
  'code', '*.code', '*.*.code',
  'sessionToken', '*.sessionToken', '*.*.sessionToken',
  'privateKey', '*.privateKey', '*.*.privateKey',
  'privateKeyPem', '*.privateKeyPem', '*.*.privateKeyPem',
  'deviceKeyPem', '*.deviceKeyPem', '*.*.deviceKeyPem',
  'nonce', '*.nonce', '*.*.nonce',
];

// Best-effort scrub for secrets embedded inside free-text log messages
// (e.g. an error message that echoed back "Bearer sk-..." or a logged URL
// with "?key=..."), which Pino's path-based `redact` cannot catch since it
// only redacts object fields. One pattern per provider key shape actually
// used in this codebase (see providers/*.js and secret-store.js prefixes):
// OpenAI/Anthropic/OpenRouter (sk-…, sk-ant-…, sk-or-…), Groq (gsk_…), and
// Gemini (AIza…, which is not a "sk-" shape and was previously unmatched).
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_.-]{10,}/g, 'sk-[REDACTED]'],
  [/gsk_[A-Za-z0-9_.-]{10,}/g, 'gsk_[REDACTED]'],
  [/AIza[A-Za-z0-9_-]{10,}/g, 'AIza[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [REDACTED]'],
  [/x-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9_.-]{10,}/gi, 'x-api-key: [REDACTED]'],
  // Gemini and similar REST APIs pass the key as a query-string parameter
  // (?key=...) rather than a header — redact that shape specifically so a
  // logged request URL never carries the key in clear.
  [/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]'],
];

export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// Recursively scrubs every string value in a log object — not just the
// top-level msg/error fields — so shapes like { err: { message, stack } }
// (Node's standard error-logging convention) or a nested { url } are caught
// too. Pino's path-based `redact` above only strips fields matched by exact
// name; this catches a secret embedded anywhere inside free text regardless
// of which field it's under. Depth-bounded (6 levels) to keep cost bounded
// on deeply nested or huge objects.
function deepRedact(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(v => deepRedact(v, depth + 1));
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      value[k] = deepRedact(value[k], depth + 1);
    }
    return value;
  }
  return value;
}

export function createLogger({ level = 'info', logFile }) {
  const streams = [{ stream: process.stdout }];

  if (logFile) {
    ensureParentDir(logFile);
    streams.push({ stream: fs.createWriteStream(logFile, { flags: 'a' }) });
  }

  return pino(
    {
      level,
      base: null,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      formatters: {
        log(obj) {
          // Catch secrets that slipped into free text anywhere in the log
          // object — msg, error, nested err.message/err.stack, a logged
          // url, etc. — rather than only the two top-level fields most
          // call sites happen to use (regex-based, best-effort only).
          return deepRedact(obj);
        },
      },
    },
    pino.multistream(streams),
  );
}
