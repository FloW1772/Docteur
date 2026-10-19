// Companion V1 — COMP-2 secret-memory protection (pure).
//
// Nothing that looks like a credential is ever remembered by the Companion: not in a durable memory, not in a
// proposal, not in session context, not in metadata, not in the audit. A detection answers REFUSE_MEMORY with the
// KINDS found — never the value. There is no fallback to the Secret Store in V1 (it only holds provider API keys).
//
// Detection = the existing detectors, reused read-only (Notebook NB-2 scanSecrets and the Root Policy secret shapes,
// both unchanged) + Companion detectors for what they do not see: credentials stated in natural language (FR / EN),
// access / refresh tokens, Authorization headers, session cookies, otpauth URIs, TOTP seeds, recovery / backup codes,
// seed phrases. Deliberately conservative: a false positive refuses a memory (the user rephrases); a false negative
// would store a secret.

import { scanSecrets } from './notebook-security.js';
import { containsSecretShape } from './root-policy/engine.js';

const V = String.raw`["'«“]?\s*[^\s"'»”]{4,}`; // a value: 4+ non-space characters
const DETECTORS = Object.freeze([
  // natural-language credentials
  { kind: 'PASSWORD_STATEMENT', re: new RegExp(String.raw`\b(?:mot\s+de\s+passe|mdp|passphrase|code\s+(?:pin|secret|d['’]acc[eè]s|wifi|wi-fi|de\s+d[ée]verrouillage))\b[^.\n]{0,40}?(?:\best\b|\bc['’]est\b|\bvaut\b|:|=)\s*${V}`, 'i') },
  { kind: 'PASSWORD_STATEMENT', re: new RegExp(String.raw`\b(?:password|passcode|passphrase|pin(?:\s+code)?|pwd|login\s+code)\b[^.\n]{0,40}?(?:\bis\b|:|=)\s*${V}`, 'i') },
  // keys and tokens
  { kind: 'API_KEY', re: /\b(?:api[\s_-]?key|cl[ée]\s+(?:d['’]\s*)?api|secret[\s_-]?key|client[\s_-]?secret)\b[^.\n]{0,30}?(?:\best\b|\bis\b|:|=)?\s*["']?[A-Za-z0-9_\-.]{16,}/i },
  { kind: 'API_KEY', re: /\b(?:AIza[0-9A-Za-z_-]{30,}|gsk_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/ },
  { kind: 'ACCESS_TOKEN', re: /\b(?:access|refresh|id|auth|bearer|session|oauth)[\s_-]?token\b[^.\n]{0,30}?(?:\best\b|\bis\b|:|=)?\s*["']?[A-Za-z0-9._~+/=-]{16,}/i },
  { kind: 'AUTHORIZATION_HEADER', re: /\bAuthorization\s*:\s*\S{6,}/i },
  { kind: 'BEARER_TOKEN', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/ },
  // cookies
  { kind: 'SESSION_COOKIE', re: /\b(?:session[_-]?id|sessionid|sid|phpsessid|jsessionid|connect\.sid|asp\.net_sessionid|__secure-[\w-]+|__host-[\w-]+|cookie(?:\s+de\s+session)?|session\s+cookie)\s*[:=]\s*["']?[A-Za-z0-9%._~+/=-]{12,}/i },
  { kind: 'SESSION_COOKIE', re: /^\s*(?:Set-)?Cookie:\s*\S+/im },
  // private keys
  { kind: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d|AGE-SECRET-KEY-1[0-9A-Z]{20,}/ },
  // 2FA
  { kind: 'OTPAUTH_URI', re: /\botpauth(?:-migration)?:\/\/\S+/i },
  { kind: 'TOTP_SEED', re: /\b(?:totp|2fa|mfa|otp|authenticator|authentificat\w*|setup\s+key|cl[ée]\s+(?:de\s+)?(?:configuration|2fa|secr[eè]te)|seed|secret)\b[^\n]{0,40}?\b(?:[A-Z2-7]{4}[\s-]?){4,}[A-Z2-7]*=*(?![A-Za-z0-9])/i },
  { kind: 'TOTP_SEED', re: /\b(?:[A-Z2-7]{4} ){5,}[A-Z2-7]{4}\b/ },
  // recovery material
  { kind: 'RECOVERY_CODE', re: /\b(?:recovery|backup|scratch|emergency)\s+codes?\b|\bcodes?\s+de\s+(?:r[ée]cup[ée]ration|secours|sauvegarde)\b|\bcode\s+de\s+r[ée]cup[ée]ration\b/i, needsValue: /\b(?=[A-Za-z-]*\d)[A-Za-z0-9-]{6,}\b/ }, // a code-like token (6+ chars with a digit)
  { kind: 'RECOVERY_CODE', re: /(?:\b[a-z0-9]{4,5}-[a-z0-9]{4,5}\b[\s,;]+){2,}\b[a-z0-9]{4,5}-[a-z0-9]{4,5}\b/i },
  { kind: 'SEED_PHRASE', re: /\b(?:seed\s+phrase|recovery\s+phrase|mnemonic|phrase\s+(?:de\s+)?(?:r[ée]cup[ée]ration|secr[eè]te)|12\s+mots|24\s+mots)\b/i, needsValue: /(?:\b[a-z]{3,8}\b[\s,]+){11,}/i },
]);

/**
 * @returns {{ refused: boolean, kinds: string[] }} kinds only — the matched value is never returned.
 */
export const MAX_SCAN_CHARS = 64 * 1024; // callers bound their inputs far below; larger text is refused unscanned (no regex on it)
export function detectSecretMemory(text) {
  const s = typeof text === 'string' ? text : '';
  if (s.length > MAX_SCAN_CHARS) return Object.freeze({ refused: true, kinds: Object.freeze(['UNSCANNABLE_SIZE']) });
  const kinds = new Set();
  for (const d of DETECTORS) {
    if (!d.re.test(s)) continue;
    if (d.needsValue && !d.needsValue.test(s)) continue;
    kinds.add(d.kind);
  }
  for (const f of scanSecrets(s).findings) kinds.add(f.kind);
  if (containsSecretShape(s)) kinds.add('SECRET_SHAPE');
  return Object.freeze({ refused: kinds.size > 0, kinds: Object.freeze([...kinds].sort()) });
}

/** Scans every string inside a plain JSON-like value (metadata, provenance, audit details). */
export function detectSecretInValue(value) {
  const kinds = new Set();
  const walk = (v, depth) => {
    if (depth > 12) return;
    if (typeof v === 'string') { for (const k of detectSecretMemory(v).kinds) kinds.add(k); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k, depth + 1); walk(x, depth + 1); }
  };
  walk(value, 0);
  return Object.freeze({ refused: kinds.size > 0, kinds: Object.freeze([...kinds].sort()) });
}
