// Notebook NB-4 — conversation segmentation for indexing.
//
// Not "one message = one chunk" and not "one conversation = one giant chunk":
//  • role-homogeneous segments (a segment never mixes USER and ASSISTANT voices, so a role filter
//    and an attribution such as « vous aviez écrit » / « ChatGPT avait répondu » are exact),
//  • consecutive short messages of the same role (and branch) are merged up to the size budget,
//  • long messages are split at block boundaries, fenced code blocks are atomic (never cut in the
//    middle of a snippet unless one block alone exceeds the hard cap — then it is split by LINES,
//    keeping the fence and the language tag on every part),
//  • a long silence between two messages (> GAP_MS) starts a new segment (cheap topic-transition proxy),
//  • each segment records the ids of every message it covers (citation provenance).
// The role is written into the indexed text ([USER] / [PAST_AI_OUTPUT] / …), the metadata is kept apart.

import { sha256 } from './notebook-chunker.js';
import { codeLangs } from './notebook-ai-adapters.js';

export const SEGMENT_CONFIG = Object.freeze({ TARGET_CHARS: 1000, MAX_CHARS: 1400, GAP_MS: 6 * 3600 * 1000 });

export const ROLE_TAG = Object.freeze({ USER: '[USER]', ASSISTANT: '[PAST_AI_OUTPUT]', TOOL: '[TOOL_RESULT]', SYSTEM: '[HISTORICAL_SYSTEM_MESSAGE]', UNKNOWN: '[UNKNOWN]' });

// Splits text into blocks; a fenced code block is one block.
export function toBlocks(text) {
  const blocks = []; let cur = []; let fence = null;
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (fence) { cur.push(line); if (f && f[1] === fence) { blocks.push({ text: cur.join('\n'), code: true }); cur = []; fence = null; } continue; }
    if (f) { if (cur.join('').trim()) blocks.push({ text: cur.join('\n').trim(), code: false }); cur = [line]; fence = f[1]; continue; }
    if (line.trim() === '') { if (cur.join('').trim()) blocks.push({ text: cur.join('\n').trim(), code: false }); cur = []; } else cur.push(line);
  }
  if (cur.join('').trim()) blocks.push({ text: cur.join('\n').trim(), code: !!fence });
  if (fence && blocks.length) blocks[blocks.length - 1].code = true; // unterminated fence: still code
  return blocks;
}

function splitBlock(block, cfg) {
  if (block.text.length <= cfg.MAX_CHARS) return [block];
  const out = [];
  if (block.code) { // by lines, re-fenced with the same language tag
    const lines = block.text.split('\n'); const open = /^\s*(```|~~~)([^\n]*)/.exec(lines[0]);
    const fenceOpen = open ? `${open[1]}${open[2]}` : '```'; const fenceMark = open ? open[1] : '```';
    const body = open ? lines.slice(1, /^\s*(```|~~~)\s*$/.test(lines.at(-1) ?? '') ? -1 : undefined) : lines;
    let part = [];
    const push = () => { if (part.length) out.push({ text: `${fenceOpen}\n${part.join('\n')}\n${fenceMark}`, code: true }); part = []; };
    for (const l of body) {
      const cand = part.join('\n').length + l.length + fenceOpen.length + 8;
      if (cand > cfg.TARGET_CHARS && part.length) push();
      if (l.length > cfg.MAX_CHARS) { for (let i = 0; i < l.length; i += cfg.TARGET_CHARS) { part.push(l.slice(i, i + cfg.TARGET_CHARS)); push(); } } else part.push(l);
    }
    push(); return out;
  }
  let rest = block.text;
  while (rest.length > cfg.MAX_CHARS) {
    let cut = Math.max(rest.lastIndexOf('. ', cfg.TARGET_CHARS), rest.lastIndexOf('\n', cfg.TARGET_CHARS), rest.lastIndexOf(' ', cfg.TARGET_CHARS));
    if (cut < cfg.TARGET_CHARS * 0.4) cut = cfg.TARGET_CHARS;
    out.push({ text: rest.slice(0, cut + 1).trim(), code: false }); rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push({ text: rest, code: false });
  return out;
}

// messages: [{ messageId, role, content, createdAt, onMainPath }] in conversation order.
export function segmentConversation(title, messages, config = {}) {
  const cfg = { ...SEGMENT_CONFIG, ...config };
  const segments = [];
  let cur = null;
  const header = (role) => `${ROLE_TAG[role] ?? ROLE_TAG.UNKNOWN}`;
  const flush = () => {
    if (cur && cur.parts.length) {
      const body = cur.parts.join('\n\n');
      const text = `Conversation : ${title || '(sans titre)'}\n${header(cur.role)}\n${body}`;
      segments.push({ text, role: cur.role, messageIds: [...cur.ids], ts: cur.ts, branch: cur.branch, langs: codeLangs(body), hash: sha256(text) });
    }
    cur = null;
  };
  let lastTs = null;
  for (const m of messages) {
    if (!String(m.content ?? '').trim()) continue;
    const t = m.createdAt ? Date.parse(m.createdAt) : null;
    const branch = m.onMainPath === false;
    const gap = t != null && lastTs != null && t - lastTs > cfg.GAP_MS;
    if (cur && (cur.role !== m.role || cur.branch !== branch || gap)) flush();
    if (t != null) lastTs = t;
    for (const block of toBlocks(m.content).flatMap(b => splitBlock(b, cfg))) {
      const size = cur ? cur.parts.join('\n\n').length : 0;
      if (cur && size + block.text.length + 2 > cfg.TARGET_CHARS) { const keep = { role: cur.role, branch: cur.branch }; flush(); cur = { ...keep, parts: [], ids: new Set(), ts: m.createdAt ?? null }; }
      if (!cur) cur = { role: m.role, branch, parts: [], ids: new Set(), ts: m.createdAt ?? null };
      cur.parts.push(block.text); cur.ids.add(m.messageId);
    }
  }
  flush();
  return segments;
}
