// Notebook NB-2 — deterministic structured chunker.
//
// Input: ordered sections from notebook-parsers ({ text, page?, headingPath }).
// Output: chunks with stable ordinal, page, headingPath, start/end offsets in
// the concatenated normalized text, and a sha256 hash. Same input → same output.
//
// Rules: chunks never cross a page boundary (page-exact citations); target
// TARGET_CHARS, hard max MAX_CHARS; an oversized block is split at the last
// sentence/whitespace boundary with OVERLAP_CHARS of overlap; a trailing
// fragment smaller than MIN_CHARS is merged into the previous chunk of the
// same page/section when it fits.

import crypto from 'node:crypto';

export const CHUNK_CONFIG = Object.freeze({ TARGET_CHARS: 1000, MAX_CHARS: 1400, MIN_CHARS: 200, OVERLAP_CHARS: 150 });

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function splitOversize(text, { MAX_CHARS, TARGET_CHARS, OVERLAP_CHARS }) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + TARGET_CHARS, text.length);
    if (end < text.length) {
      const window = text.slice(start, Math.min(start + MAX_CHARS, text.length));
      const minCut = Math.floor(TARGET_CHARS * 0.5);
      let cut = -1;
      for (const re of [/[.!?]["')\]]?\s/g, /\n/g, /\s/g]) {
        let m; let last = -1;
        re.lastIndex = 0;
        while ((m = re.exec(window)) !== null) {
          if (m.index + m[0].length >= minCut && m.index + m[0].length <= MAX_CHARS) last = m.index + m[0].length;
          if (m.index > MAX_CHARS) break;
        }
        if (last > 0) { cut = last; break; }
      }
      end = start + (cut > 0 ? cut : Math.min(MAX_CHARS, text.length - start));
    }
    pieces.push({ start, end });
    if (end >= text.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }
  return pieces;
}

export function chunkSections(sections, config = {}) {
  const cfg = { ...CHUNK_CONFIG, ...config };
  const chunks = [];
  let offset = 0; // running offset in concatenated text (sections joined by "\n\n")
  let cur = null;

  const flush = () => {
    if (cur && cur.text.trim()) chunks.push(cur);
    cur = null;
  };

  for (const section of sections) {
    const base = offset;
    offset += section.text.length + 2;
    const page = section.page ?? null;
    const headingPath = section.headingPath ?? [];
    // A chunk never spans two headings or two pages: the heading/page of a citation must be the one of the cited text.
    if (cur && (cur.page !== page || cur.headingKey !== headingPath.join('\u0001'))) flush();

    const paragraphs = [];
    let pos = 0;
    for (const part of section.text.split(/\n\n+/)) {
      const idx = section.text.indexOf(part, pos);
      pos = idx + part.length;
      if (part.trim()) paragraphs.push({ text: part, start: base + idx, end: base + idx + part.length });
    }

    for (const para of paragraphs) {
      const pieces = para.text.length > cfg.MAX_CHARS
        ? splitOversize(para.text, cfg).map(p => ({ text: para.text.slice(p.start, p.end), start: para.start + p.start, end: para.start + p.end, split: true }))
        : [{ text: para.text, start: para.start, end: para.end, split: false }];
      for (const piece of pieces) {
        if (piece.split) {
          flush();
          chunks.push({ text: piece.text, startOffset: piece.start, endOffset: piece.end, page, headingPath, headingKey: headingPath.join('\u0001') });
          continue;
        }
        if (cur && cur.text.length + piece.text.length + 2 > cfg.TARGET_CHARS) flush();
        if (cur) {
          cur.text = `${cur.text}\n\n${piece.text}`;
          cur.endOffset = piece.end;
        } else {
          cur = { text: piece.text, startOffset: piece.start, endOffset: piece.end, page, headingPath, headingKey: headingPath.join('\u0001') };
        }
      }
    }
  }
  flush();

  // Merge tiny tail chunks into the previous chunk (same page + heading) when it fits.
  const merged = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && c.text.length < cfg.MIN_CHARS && prev.page === c.page && prev.headingKey === c.headingKey && prev.text.length + c.text.length + 2 <= cfg.MAX_CHARS) {
      prev.text = `${prev.text}\n\n${c.text}`;
      prev.endOffset = c.endOffset;
    } else merged.push({ ...c });
  }

  return merged.map((c, ordinal) => ({
    ordinal,
    text: c.text,
    page: c.page,
    headingPath: c.headingPath,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    hash: sha256(c.text),
  }));
}
