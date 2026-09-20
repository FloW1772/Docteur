// Voice-output safety policy for VOICE-4.1 — decides whether a Docteur
// response is safe to speak automatically. This is a SMALL, deliberately
// narrow gate, not a general DLP system: it mirrors the shapes already
// caught server-side by cortex-server/src/lib/logger.js's SECRET_PATTERNS
// and cortex-server/src/lib/cyber-redact.js's JWT/header rules. Those
// files are Node-only (server bundle) and cannot be imported into the
// Vite client build, so the same intent is duplicated here as regex
// patterns over the response text — never re-implemented as a different,
// weaker heuristic.
//
// This module NEVER redacts/modifies text for display — it only answers
// "is this safe to read aloud automatically". Manual "Read Aloud" (an
// explicit user action) still goes through the same gate: sensitive
// content is never spoken automatically OR on manual click, since a
// secret spoken aloud is a secret leaked regardless of whether a human
// or an automatic trigger caused it.

// Mirrors logger.js's SECRET_PATTERNS (API key shapes + Bearer + x-api-key
// + ?key=...) plus cyber-redact.js's JWT pattern and a generic
// password-like-field pattern that neither server file catches by name.
const SENSITIVE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_.-]{10,}/,                              // OpenAI/Anthropic/OpenRouter
  /gsk_[A-Za-z0-9_.-]{10,}/,                              // Groq
  /AIza[A-Za-z0-9_-]{10,}/,                               // Gemini
  /Bearer\s+[A-Za-z0-9._-]{10,}/i,                        // Authorization: Bearer ...
  /x-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9_.-]{10,}/i,    // x-api-key header shape
  /[?&]key=[^&\s"']+/i,                                   // ?key=... query param
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/, // JWT (header.payload.signature)
  /\bauthorization\s*[:=]\s*["']?\S+/i,                   // Authorization: <value> in free text
  /\bcookie\s*[:=]\s*["']?\S+/i,                          // Cookie: <value> in free text
  /\bset-cookie\s*[:=]\s*["']?\S+/i,
  /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?\S{4,}/i,
];

export function containsSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(text));
}

// ── Code / large-structured-output heuristic ────────────────────────────
// Reading a large code block, JSON dump, or log/stack trace aloud is not
// useful and is explicitly out of scope for auto-read (manual read of a
// SUMMARY may come in a later phase — not this one). The rule stays
// simple and explainable rather than trying to detect "code" precisely:
// - 2 or more fenced code blocks (```...```), or
// - a single fenced block whose content is long, or
// - the text overall is very long (likely a large structured dump), or
// - the text is dominated by JSON/stack-trace-shaped lines.
const MAX_AUTO_SPEAK_LENGTH = 1200;
const MAX_FENCED_BLOCK_LENGTH = 400;

function fencedCodeBlocks(text: string): string[] {
  const matches = text.match(/```[\s\S]*?```/g);
  return matches ?? [];
}

function looksLikeStackTraceOrJson(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 4) return false;
  const structuredLines = lines.filter(line =>
    /^\s*at\s+\S+\s*\(/.test(line) // "at functionName (...)" stack frame
    || /^\s*["'][\w-]+["']\s*:/.test(line) // JSON-ish "key": value line
    || /^\s*[{}[\]]\s*,?\s*$/.test(line), // a lone brace/bracket line
  );
  return structuredLines.length / lines.length > 0.4;
}

export function isTooLongOrStructuredForAutoSpeak(text: string): boolean {
  if (text.length > MAX_AUTO_SPEAK_LENGTH) return true;
  const blocks = fencedCodeBlocks(text);
  if (blocks.length >= 2) return true;
  if (blocks.some(block => block.length > MAX_FENCED_BLOCK_LENGTH)) return true;
  if (looksLikeStackTraceOrJson(text)) return true;
  return false;
}

/**
 * The single gate every auto-read call site must pass through. Manual
 * "Read Aloud" also calls this — sensitive content is never spoken
 * regardless of trigger, but the length/structure heuristic ONLY applies
 * to AUTOMATIC reading (a user who explicitly clicks "Read Aloud" on a
 * long response has made an informed choice; auto-read has not).
 */
export function canAutoSpeak(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (containsSensitiveContent(trimmed)) return false;
  if (isTooLongOrStructuredForAutoSpeak(trimmed)) return false;
  return true;
}

/**
 * Manual "Read Aloud" — still refuses sensitive content (a secret must
 * never be spoken, full stop), but allows long/code-shaped text since the
 * user explicitly asked for it.
 */
export function canManuallySpeak(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !containsSensitiveContent(trimmed);
}
