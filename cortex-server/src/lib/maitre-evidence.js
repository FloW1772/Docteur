/**
 * MAÎTRE — evidence redaction + integrity hashing. Thin wrapper around
 * the EXISTING redaction engine (cyber-redact.js) — not a second,
 * competing redaction implementation. deepRedactEvidence() already
 * recursively redacts any `headers`-shaped key and is depth-bounded;
 * redactHeaders() covers the standard sensitive header names
 * (authorization/cookie/set-cookie/proxy-authorization/x-api-key/
 * x-auth-token/x-csrf-token/x-session-token) plus JWT-shaped strings.
 *
 * MAÎTRE evidence metadata additionally passes through a small
 * MAÎTRE-specific key-name denylist (password/token/secret/credential/
 * apikey/sessionid — case-insensitive, nested), because evidence
 * subjects here (process metadata, file metadata, persistence entries)
 * are shaped differently from Cyber Audit's HTTP evidence and can
 * legitimately contain a key literally named "password" or
 * "sessionToken" that cyber-redact.js's header-oriented rules don't
 * target by key name alone.
 */
import crypto from 'node:crypto';
import { deepRedactEvidence, redactHeaders } from './cyber-redact.js';

const SENSITIVE_KEY_PATTERN = /password|token|secret|credential|api[-_]?key|session[-_]?id|cookie|authorization/i;

// MA-4 addition: cyber-redact.js's redactText only catches specific
// KNOWN credential shapes (sk-…, gsk_…, AIza…, Bearer …, x-api-key: …,
// ?key=…) — a command line, registry value, or scheduled-task action
// like "app.exe --password=hunter2" or "--token=plainvalue" matches
// none of those and would otherwise survive redaction verbatim. This
// pattern catches the generic `--flag=value` / `flag: value` /
// `flag=value` shape for a sensitive flag NAME, redacting only the
// value half — found and fixed during MA-4 while testing persistence/
// process command-line redaction (mission §26/§27 explicitly requires
// --token=/--password=/api_key coverage).
const CLI_FLAG_SECRET_PATTERN = /((?:--?)?[\w-]*?(?:password|token|secret|credential|api[-_]?key|session[-_]?id)[\w-]*\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

function redactCliFlagSecrets(text) {
  if (typeof text !== 'string') return text;
  return text.replace(CLI_FLAG_SECRET_PATTERN, '$1[REDACTED]');
}

function redactSensitiveKeys(value, depth = 0) {
  if (depth > 6) return '[REDACTED_DEPTH_LIMIT]';
  if (typeof value === 'string') return redactCliFlagSecrets(value);
  if (Array.isArray(value)) return value.map(v => redactSensitiveKeys(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
      } else if (key === 'headers' && val && typeof val === 'object') {
        out[key] = redactHeaders(val);
      } else {
        out[key] = redactSensitiveKeys(val, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Redacts an evidence metadata object before it is ever persisted.
 * Applies cyber-redact.js's existing deepRedactEvidence() first (covers
 * headers/JWTs/cookie values), then MAÎTRE's own key-name denylist pass
 * on top (covers plain password/token/secret-named fields that aren't
 * shaped like HTTP headers). Always returns a plain object safe to
 * JSON.stringify.
 */
export function redactMaitreEvidenceMetadata(metadata) {
  if (metadata === null || metadata === undefined) return {};
  const afterCyberRedact = deepRedactEvidence(metadata);
  return redactSensitiveKeys(afterCyberRedact);
}

/**
 * SHA-256 of the evidence row's own serialized (already-redacted)
 * metadata — used only for tamper-evidence/dedup of this evidence
 * record, never presented as a forensic chain-of-custody guarantee.
 */
export function computeEvidenceIntegrityHash(redactedMetadata) {
  const serialized = JSON.stringify(redactedMetadata ?? {});
  return crypto.createHash('sha256').update(serialized).digest('hex');
}
