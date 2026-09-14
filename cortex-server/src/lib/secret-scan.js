// Local, read-only audit for API-key-shaped substrings accidentally captured
// inside user content (neurons/pages) — distinct from the secret-store,
// which only ever holds the user's own configured cloud API keys. This scans
// what the USER pasted/captured into their notes, which could plausibly
// include a real leaked key (e.g. a screenshot of a .env file) or, far more
// commonly, example/documentation text that merely looks like one.
//
// HARD RULE: this module must never return, log, or expose the matched
// substring, the field's full value, or enough surrounding context to
// reconstruct it. Every result is metadata only — id, field path, match
// length, approximate position, a one-way hash, and a heuristic score.
// Nothing here ever makes a network call.

import crypto from 'node:crypto';
import { getAllPagesFromStore } from './sqlite.js';

// One pattern per prefix requested for the audit. `sk-ant-`/`sk-or-` are
// checked before the more general `sk-` so a match is attributed to the
// most specific prefix it actually has (a `sk-ant-...` key is reported as
// `sk-ant-`, not double-counted under the generic `sk-` too).
const PATTERNS = [
  { type: 'sk-ant-',   regex: /sk-ant-[A-Za-z0-9_.-]{10,}/g },
  { type: 'sk-or-',    regex: /sk-or-[A-Za-z0-9_.-]{10,}/g },
  { type: 'gsk_',      regex: /gsk_[A-Za-z0-9_.-]{10,}/g },
  { type: 'AIza',      regex: /AIza[A-Za-z0-9_-]{10,}/g },
  { type: 'sk-',       regex: /sk-(?!ant-|or-)[A-Za-z0-9_.-]{10,}/g },
  { type: 'Bearer',    regex: /Bearer\s+[A-Za-z0-9._-]{10,}/g },
  { type: 'api_key=',  regex: /api_key=[^&\s"'<>]{6,}/gi },
  { type: 'token=',    regex: /(?<![\w-])token=[^&\s"'<>]{6,}/gi },
];

// Words that, near a match, strongly suggest example/documentation/code
// rather than a real accidentally-pasted credential.
const EXAMPLE_HINT_WORDS = [
  'example', 'exemple', 'sample', 'placeholder', 'your-api-key', 'your_api_key',
  'xxxx', 'yyyy', '1234567890abcdef', 'fake', 'dummy', 'test', 'документ',
  '<your', 'insert your', 'replace with', 'documentation', 'readme', '```',
];

// A run that never varies (all zeros/x's/same repeated char) or is
// suspiciously short/round is very unlikely to be a real generated key.
function looksLikePlaceholderRun(run) {
  if (/^(.)\1{9,}$/.test(run)) return true; // e.g. "xxxxxxxxxx"
  if (/^0123456789|^abcdefghij|^12345/i.test(run)) return true;
  return false;
}

// Score in [0,1]: higher = more likely a real secret, lower = more likely
// example/documentation text. Heuristic only — never a certainty, which is
// exactly why this tool surfaces candidates for manual review rather than
// taking any automatic action.
function scoreMatch({ matchText, prefix, contextBefore, contextAfter }) {
  let score = 0.5;

  const run = matchText.slice(prefix.length);
  if (looksLikePlaceholderRun(run)) score -= 0.4;

  // A long, high-entropy-looking unbroken run right after the prefix reads
  // more like a real generated token than a hand-typed example.
  const uniqueChars = new Set(run.split('')).size;
  if (run.length >= 20 && uniqueChars >= 12) score += 0.25;
  if (run.length < 15) score -= 0.15;

  const nearbyText = `${contextBefore} ${contextAfter}`.toLowerCase();
  if (EXAMPLE_HINT_WORDS.some(w => nearbyText.includes(w))) score -= 0.35;

  // Code fences / inline-code markers around the match suggest a pasted
  // code snippet (often illustrative) rather than a real personal key.
  if (/```|`[^`]*`/.test(nearbyText)) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

function classify(score) {
  if (score >= 0.65) return 'plausible_real_secret';
  if (score <= 0.35) return 'likely_example_text';
  return 'ambiguous';
}

// Walks a page's JSON fields that can contain free text (title, block
// content, metadata.summary) and scans each string value. Returns metadata
// findings only — see module header.
function scanTextField(pageId, fieldPath, text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const findings = [];

  for (const { type, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const matchText = m[0];
      const start = m.index;
      const contextBefore = text.slice(Math.max(0, start - 40), start);
      const contextAfter = text.slice(start + matchText.length, start + matchText.length + 40);
      const score = scoreMatch({ matchText, prefix: type, contextBefore, contextAfter });

      findings.push({
        page_id: pageId,
        field: fieldPath,
        match_type: type,
        match_length: matchText.length,
        // Approximate position only (percentage through the field), never
        // the exact offset combined with enough context to locate/extract it.
        approx_position_pct: Math.round((start / text.length) * 100),
        field_length: text.length,
        // One-way fingerprint — lets the same match be recognised as
        // "seen before" across scans without ever revealing its content.
        fingerprint: crypto.createHash('sha256').update(matchText).digest('hex').slice(0, 16),
        probability_score: Math.round(score * 100) / 100,
        classification: classify(score),
      });

      // Avoid overlapping infinite loop on zero-width edge cases
      if (regex.lastIndex === m.index) regex.lastIndex++;
    }
  }

  return findings;
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .map((b, i) => ({ path: `blocks[${i}].content`, text: b?.content }))
    .filter(b => typeof b.text === 'string');
}

// Scans every page currently in the store. Read-only, local, synchronous
// over already-loaded data — no network call is made anywhere in this path.
export function scanPagesForSecrets() {
  return scanPagesForSecretsFromPages(getAllPagesFromStore());
}

// Same scan, but over an already-loaded array of parsed page objects rather
// than reading through the shared read-write DB singleton — lets a caller
// supply pages from an independent (e.g. read-only) connection without
// requiring initSqlite() to have opened the DB read-write first.
export function scanPagesForSecretsFromPages(pages) {
  const findings = [];

  for (const page of pages) {
    const id = page?.id ?? 'unknown';
    if (typeof page?.title === 'string') {
      findings.push(...scanTextField(id, 'title', page.title));
    }
    if (typeof page?.metadata?.summary === 'string') {
      findings.push(...scanTextField(id, 'metadata.summary', page.metadata.summary));
    }
    for (const { path, text } of textFromBlocks(page?.blocks)) {
      findings.push(...scanTextField(id, path, text));
    }
  }

  const plausible = findings.filter(f => f.classification === 'plausible_real_secret');
  const example = findings.filter(f => f.classification === 'likely_example_text');
  const ambiguous = findings.filter(f => f.classification === 'ambiguous');

  return {
    total_matches: findings.length,
    plausible_real_secret: plausible.length,
    likely_example_text: example.length,
    ambiguous: ambiguous.length,
    // Only ids + non-sensitive metadata for entries worth a human look —
    // never the matched text itself. Deduplicated by page id so one page
    // with several matches appears once with a summary count.
    pages_to_review: Object.values(
      [...plausible, ...ambiguous].reduce((acc, f) => {
        const entry = acc[f.page_id] ?? { page_id: f.page_id, match_count: 0, fields: new Set(), highest_score: 0 };
        entry.match_count += 1;
        entry.fields.add(f.field);
        entry.highest_score = Math.max(entry.highest_score, f.probability_score);
        acc[f.page_id] = entry;
        return acc;
      }, {}),
    ).map(e => ({ ...e, fields: [...e.fields] })),
  };
}
