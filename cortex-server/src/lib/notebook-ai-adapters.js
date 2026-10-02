// Notebook NB-4 — AI-history adapters and the normalised model.
//
// COVERAGE HONESTY: no real ChatGPT / Gemini / Claude export was available while this
// was written. The three provider adapters follow the structures as documented/observed
// publicly and are exercised ONLY with clearly synthetic fixtures (SYNTHETIC_ONLY). They
// never invent fields: anything absent stays null/absent, and an unrecognised structure is
// reported instead of guessed. A provider is attributed ONLY when the structure itself is
// recognised (providerVerified); generic formats stay provider UNKNOWN unless the user
// declares one (then providerVerified stays false).
//
// Adapter contract: detect(source) → {confidence, reason} · conversations(source) → async
// iterable of raw items · normalize(raw, ctx) → NormalizedConversation · validate(conv) →
// {ok, errors[]}. Every conversation/message carries provenance (provider, adapter, entry,
// original ids, timestamps). No network, no fs, no child_process.

import crypto from 'node:crypto';
import { streamJsonArray } from './notebook-ai-zip.js';
import { checkEntryName } from './notebook-ai-zip.js';

export const ROLES = Object.freeze(['USER', 'ASSISTANT', 'SYSTEM', 'TOOL', 'UNKNOWN']);
export const PROVIDERS = Object.freeze(['CHATGPT', 'GEMINI', 'CLAUDE', 'UNKNOWN']);
export const PROVIDER_LABEL = Object.freeze({ CHATGPT: 'ChatGPT', GEMINI: 'Gemini', CLAUDE: 'Claude', UNKNOWN: 'IA (provider non vérifié)' });

const ROLE_ALIASES = {
  user: 'USER', human: 'USER', me: 'USER', utilisateur: 'USER', moi: 'USER', vous: 'USER', you: 'USER', prompt: 'USER', question: 'USER',
  assistant: 'ASSISTANT', ai: 'ASSISTANT', bot: 'ASSISTANT', model: 'ASSISTANT', chatgpt: 'ASSISTANT', claude: 'ASSISTANT', gemini: 'ASSISTANT', gpt: 'ASSISTANT', reponse: 'ASSISTANT', réponse: 'ASSISTANT', answer: 'ASSISTANT',
  system: 'SYSTEM', developer: 'SYSTEM', instructions: 'SYSTEM',
  tool: 'TOOL', function: 'TOOL', tool_result: 'TOOL', tool_use: 'TOOL', browser: 'TOOL', python: 'TOOL', code_interpreter: 'TOOL',
};
export function normalizeRole(r) {
  return ROLE_ALIASES[String(r ?? '').trim().toLowerCase()] ?? 'UNKNOWN';
}

// Trust mapping. An imported history is NEVER a source of verified fact or primary source.
export function trustForRole(role) {
  if (role === 'USER') return 'USER_AUTHORED';
  if (role === 'ASSISTANT') return 'PAST_AI_OUTPUT';
  if (role === 'TOOL') return 'TOOL_RESULT';
  return 'UNKNOWN';
}

export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function toIso(v) {
  if (v == null || v === '') return null;
  let d;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v); d = new Date(n < 1e12 ? n * 1000 : n); // seconds or milliseconds
  } else d = new Date(String(v));
  return Number.isNaN(d.getTime()) || d.getFullYear() < 1990 || d.getFullYear() > 2100 ? null : d.toISOString();
}

export function codeLangs(text) {
  const langs = new Set();
  for (const m of String(text).matchAll(/^```([A-Za-z0-9_+#.-]*)/gm)) if (m[1]) langs.add(m[1].toLowerCase());
  return [...langs];
}

// Text-only HTML → text (no DOM, nothing executed, tags and comments dropped).
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<pre[^>]*>\s*<code[^>]*?(?:class="[^"]*language-([\w+#-]+)[^"]*")?[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, lang, code) => `\n\`\`\`${lang ?? ''}\n${code}\n\`\`\`\n`)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const asText = (v) => (typeof v === 'string' ? v : '');

// ── shared message builder ──────────────────────────────────────────────────
function msg(over) {
  return {
    originalId: over.originalId ?? null, parentOriginalId: over.parentOriginalId ?? null,
    role: over.role ?? 'UNKNOWN', content: String(over.content ?? ''), contentType: over.contentType ?? 'text',
    createdAt: toIso(over.createdAt), attachments: over.attachments ?? [], onMainPath: over.onMainPath !== false, metadata: over.metadata ?? {},
  };
}

// ── ChatGPT export (conversations*.json, tree "mapping") ────────────────────
const chatgptAdapter = {
  id: 'CHATGPT_EXPORT', provider: 'CHATGPT',
  entryPattern: /(^|\/)conversations(-\d+)?\.json$/i,
  async detect(source) {
    for (const name of source.names.filter(n => this.entryPattern.test(n))) {
      const head = await source.head(name);
      if (/"mapping"\s*:/.test(head) && (/"current_node"\s*:/.test(head) || /"author"\s*:/.test(head))) return { confidence: 0.95, reason: 'mapping + author/current_node' };
    }
    return { confidence: 0, reason: 'no ChatGPT structure' };
  },
  async *conversations(source, { signal }) {
    for (const name of source.names.filter(n => this.entryPattern.test(n))) {
      for await (const raw of streamJsonArray(source.stream(name, signal), { signal })) yield { raw, entry: name };
    }
  },
  normalize(raw, { entry }) {
    const mapping = raw?.mapping && typeof raw.mapping === 'object' ? raw.mapping : {};
    const nodes = new Map(Object.entries(mapping));
    // nearest ancestor that carries a message (root pointers have none)
    const parentOf = (id) => { let p = nodes.get(id)?.parent; while (p && !nodes.get(p)?.message) p = nodes.get(p)?.parent; return p ?? null; };
    const mainPath = new Set(); let cur = raw.current_node;
    while (cur && nodes.has(cur) && !mainPath.has(cur)) { mainPath.add(cur); cur = nodes.get(cur).parent; }
    const roots = [...nodes.entries()].filter(([, n]) => !n.parent || !nodes.has(n.parent)).map(([id]) => id);
    const order = []; const visited = new Set();
    const walk = (id) => { // iterative DFS in child order (branches preserved)
      const stack = [id];
      while (stack.length) {
        const x = stack.pop(); if (visited.has(x) || !nodes.has(x)) continue;
        visited.add(x); order.push(x);
        const kids = (nodes.get(x).children ?? []).filter(k => nodes.has(k));
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    };
    roots.forEach(walk); [...nodes.keys()].forEach(walk);
    const messages = [];
    for (const id of order) {
      const m = nodes.get(id)?.message; if (!m) continue;
      const c = m.content ?? {}; const attachments = [];
      let text = '';
      if (c.content_type === 'code') text = `\`\`\`${asText(c.language) === 'unknown' ? '' : asText(c.language)}\n${asText(c.text)}\n\`\`\``;
      else if (Array.isArray(c.parts)) {
        text = c.parts.map(p => {
          if (typeof p === 'string') return p;
          if (p && typeof p === 'object') { if (p.asset_pointer || p.content_type?.includes?.('image')) attachments.push({ name: asText(p.metadata?.name) || asText(p.asset_pointer), ref: asText(p.asset_pointer), mime: asText(p.content_type), size: Number(p.size_bytes) || null }); return typeof p.text === 'string' ? p.text : ''; }
          return '';
        }).filter(Boolean).join('\n\n');
      } else if (typeof c.text === 'string') text = c.text;
      for (const a of Array.isArray(m.metadata?.attachments) ? m.metadata.attachments : []) attachments.push({ name: asText(a.name), ref: asText(a.id), mime: asText(a.mime_type ?? a.mimeType), size: Number(a.size) || null });
      if (!text.trim() && !attachments.length) continue;
      const role = normalizeRole(m.author?.role);
      const isTool = role === 'TOOL' || ['execution_output', 'tether_browsing_display', 'tether_quote', 'system_error'].includes(c.content_type);
      messages.push(msg({
        originalId: m.id ?? id, parentOriginalId: parentOf(id), role: isTool ? 'TOOL' : role, content: text, createdAt: m.create_time,
        contentType: c.content_type ?? 'text', attachments, onMainPath: mainPath.size === 0 || mainPath.has(id),
        metadata: { model: m.metadata?.model_slug ?? null, hidden: !!m.metadata?.is_visually_hidden_from_conversation, name: m.author?.name ?? null },
      }));
    }
    return { externalId: raw.conversation_id ?? raw.id ?? null, title: asText(raw.title), createdAt: toIso(raw.create_time), updatedAt: toIso(raw.update_time), messages, entry, currentNode: raw.current_node ?? null, metadata: { gizmo: raw.gizmo_id ?? null } };
  },
};

// ── Claude export (conversations.json, linear chat_messages) ────────────────
const claudeAdapter = {
  id: 'CLAUDE_EXPORT', provider: 'CLAUDE',
  entryPattern: /(^|\/)conversations\.json$/i,
  async detect(source) {
    for (const name of source.names.filter(n => this.entryPattern.test(n))) {
      const head = await source.head(name);
      if (/"chat_messages"\s*:/.test(head) && (/"sender"\s*:/.test(head) || /"uuid"\s*:/.test(head))) return { confidence: 0.95, reason: 'chat_messages + sender/uuid' };
    }
    return { confidence: 0, reason: 'no Claude structure' };
  },
  async *conversations(source, { signal }) {
    for (const name of source.names.filter(n => this.entryPattern.test(n))) for await (const raw of streamJsonArray(source.stream(name, signal), { signal })) yield { raw, entry: name };
  },
  normalize(raw, { entry }) {
    const messages = []; let prev = null;
    for (const m of Array.isArray(raw?.chat_messages) ? raw.chat_messages : []) {
      const role = normalizeRole(m.sender);
      let text = '';
      const extra = [];
      if (Array.isArray(m.content) && m.content.length) {
        for (const b of m.content) {
          if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n\n' : '') + b.text;
          else if (b?.type === 'tool_result' || b?.type === 'tool_use') extra.push(typeof b.text === 'string' ? b.text : JSON.stringify(b.content ?? b.input ?? b).slice(0, 4000));
        }
      } else text = asText(m.text);
      const attachments = [...(Array.isArray(m.attachments) ? m.attachments : []), ...(Array.isArray(m.files) ? m.files : [])]
        .map(a => ({ name: asText(a.file_name ?? a.name), ref: asText(a.file_uuid ?? a.uuid), mime: asText(a.file_type), size: Number(a.file_size) || null }));
      if (text.trim() || attachments.length) {
        messages.push(msg({ originalId: m.uuid ?? null, parentOriginalId: prev, role, content: text, createdAt: m.created_at, attachments }));
        prev = m.uuid ?? prev;
      }
      for (const e of extra) if (e.trim()) messages.push(msg({ originalId: m.uuid ? `${m.uuid}#tool` : null, parentOriginalId: m.uuid ?? prev, role: 'TOOL', content: e, contentType: 'tool' }));
    }
    return { externalId: raw.uuid ?? null, title: asText(raw.name), createdAt: toIso(raw.created_at), updatedAt: toIso(raw.updated_at), messages, entry, currentNode: null, metadata: { account: raw.account?.uuid ?? null } };
  },
};

// ── Gemini export (Google Takeout "My Activity", one activity = one exchange) ─
const GEMINI_PREFIX = /^(Prompted|Asked|Demandé|Invite|Prompt)\s+/i;
const geminiAdapter = {
  id: 'GEMINI_EXPORT', provider: 'GEMINI',
  entryPattern: /(^|\/)MyActivity\.json$/i,
  async detect(source) {
    for (const name of source.names.filter(n => this.entryPattern.test(n))) {
      const head = await source.head(name);
      if (/"header"\s*:\s*"Gemini Apps"/.test(head) || /"products"\s*:\s*\[\s*"Gemini Apps"/.test(head)) return { confidence: 0.9, reason: 'Takeout activity with Gemini header' };
    }
    return { confidence: 0, reason: 'no Gemini activity structure' };
  },
  async *conversations(source, { signal }) {
    for (const name of source.names.filter(n => this.entryPattern.test(n))) for await (const raw of streamJsonArray(source.stream(name, signal), { signal })) yield { raw, entry: name };
  },
  normalize(raw, { entry }) {
    const title = asText(raw.title).replace(GEMINI_PREFIX, '').trim();
    const time = toIso(raw.time);
    const html = Array.isArray(raw.safeHtmlItem) ? raw.safeHtmlItem.map(i => htmlToText(i?.html)).filter(Boolean).join('\n\n') : '';
    const messages = [];
    if (title) messages.push(msg({ originalId: null, role: 'USER', content: title, createdAt: time }));
    if (html) messages.push(msg({ originalId: null, parentOriginalId: null, role: 'ASSISTANT', content: html, createdAt: time }));
    const attachments = (Array.isArray(raw.attachedFiles) ? raw.attachedFiles : []).map(f => ({ name: asText(typeof f === 'string' ? f : f?.name), ref: '', mime: '', size: null }));
    if (messages[0] && attachments.length) messages[0].attachments = attachments;
    // Activity items have no conversation id: a deterministic synthetic one (time + prompt), flagged.
    return { externalId: `gemini-activity:${sha(`${raw.time}|${title}`).slice(0, 24)}`, externalIdSynthetic: true, title: title.slice(0, 120), createdAt: time, updatedAt: time, messages, entry, currentNode: null, metadata: { header: raw.header ?? null, products: raw.products ?? null } };
  },
};

// ── generic JSON ────────────────────────────────────────────────────────────
const pick = (o, keys) => { for (const k of keys) if (o?.[k] != null) return o[k]; return undefined; };
function contentOf(m) {
  const c = pick(m, ['content', 'text', 'message', 'body', 'parts', 'value']);
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : asText(p?.text ?? p?.content))).filter(Boolean).join('\n\n');
  if (c && typeof c === 'object') return asText(c.text ?? c.content);
  return '';
}
function genericMessages(list) {
  const out = []; let prev = null;
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const text = contentOf(m); if (!text.trim()) continue;
    const id = pick(m, ['id', 'uuid', 'message_id']) ?? null;
    out.push(msg({ originalId: id, parentOriginalId: pick(m, ['parent_id', 'parent']) ?? prev, role: normalizeRole(pick(m, ['role', 'sender', 'author', 'from', 'speaker'])), content: text, createdAt: pick(m, ['timestamp', 'created_at', 'time', 'date', 'create_time']) }));
    prev = id ?? prev;
  }
  return out;
}
function genericConversation(o, entry) {
  const list = pick(o, ['messages', 'chat_messages', 'conversation', 'turns', 'history']) ?? [];
  return { externalId: pick(o, ['id', 'uuid', 'conversation_id']) ?? null, title: asText(pick(o, ['title', 'name'])), createdAt: toIso(pick(o, ['created_at', 'create_time', 'timestamp'])), updatedAt: toIso(pick(o, ['updated_at', 'update_time'])), messages: genericMessages(Array.isArray(list) ? list : []), entry, currentNode: null, metadata: {} };
}
const genericJsonAdapter = {
  id: 'GENERIC_JSON', provider: 'UNKNOWN',
  async detect(source) { return source.names.some(n => /\.json$/i.test(n)) ? { confidence: 0.4, reason: 'json file' } : { confidence: 0, reason: 'not json' }; },
  async *conversations(source, { signal }) {
    const name = source.names.find(n => /\.json$/i.test(n));
    const text = await source.readText(name, source.limits.maxGenericBytes);
    const data = JSON.parse(text);
    const first = Array.isArray(data) ? data[0] : null;
    if (Array.isArray(data) && first && typeof first === 'object' && ('role' in first || 'sender' in first || 'content' in first || 'text' in first) && !('messages' in first)) yield { raw: { messages: data, title: source.baseName }, entry: name, single: true };
    else if (Array.isArray(data)) for (const c of data) { signal?.throwIfAborted?.(); yield { raw: c, entry: name }; }
    else if (data && Array.isArray(data.conversations)) for (const c of data.conversations) yield { raw: c, entry: name };
    else if (data && typeof data === 'object') yield { raw: data, entry: name };
  },
  normalize(raw, { entry }) { return genericConversation(raw, entry); },
};

// ── generic Markdown / Text / HTML (role markers) ───────────────────────────
const MARK = /^(?:#{1,4}\s*)?(?:\*\*|__)?\s*(user|you|human|me|utilisateur|moi|vous|assistant|ai|bot|chatgpt|claude|gemini|model|system|tool|réponse|reponse)\s*(?:said|a dit|:|：)?\s*(?:\*\*|__)?\s*[:：]?\s*(?:\*\*|__)?\s*(.*)$/i;
export function parseRoleMarkedText(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const messages = []; let cur = null; let inFence = false; let labelHints = new Set();
  const flush = () => { if (cur && cur.buf.join('\n').trim()) messages.push(msg({ role: cur.role, content: cur.buf.join('\n').trim() })); cur = null; };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && MARK.exec(line.trim());
    // a marker line is short: "User:" / "## Assistant" / "**You said:**" (or "User: text" inline)
    if (m && (line.trim().length <= 24 || /[:：]/.test(line.slice(0, 30)) || /^#{1,4}\s/.test(line))) {
      flush(); cur = { role: normalizeRole(m[1]), buf: [] }; labelHints.add(m[1].toLowerCase());
      if (m[2] && m[2].trim()) cur.buf.push(m[2]);
      continue;
    }
    if (!cur) cur = { role: 'UNKNOWN', buf: [] };
    cur.buf.push(line);
  }
  flush();
  // a lone leading title ("# Session") before the first role marker is a title, not a message
  if (messages.length > 1 && messages[0].role === 'UNKNOWN' && /^#{1,3}\s+[^\n]{0,120}$/.test(messages[0].content)) messages.shift();
  return { messages, labelHints: [...labelHints] };
}
const genericTextAdapter = (id, ext) => ({
  id, provider: 'UNKNOWN',
  async detect(source) { return source.names.some(n => ext.test(n)) ? { confidence: 0.4, reason: 'text file' } : { confidence: 0, reason: 'not text' }; },
  async *conversations(source) {
    const name = source.names.find(n => ext.test(n));
    let text = await source.readText(name, source.limits.maxGenericBytes);
    if (/\.html?$/i.test(name)) {
      // saved chat pages: prefer explicit role attributes, otherwise plain text + markers
      const blocks = [...text.matchAll(/<([a-z0-9]+)[^>]*data-message-author-role="(user|assistant|system|tool)"[^>]*>([\s\S]*?)<\/\1>/gi)];
      if (blocks.length) { yield { raw: { messages: blocks.map(b => ({ role: b[2], content: htmlToText(b[3]) })), title: source.baseName }, entry: name, structured: true }; return; }
      text = htmlToText(text);
    }
    yield { raw: { text, title: source.baseName }, entry: name };
  },
  normalize(raw, { entry }) {
    if (raw.messages) return { ...genericConversation({ messages: raw.messages, title: raw.title }, entry), metadata: { structured: true } };
    const parsed = parseRoleMarkedText(raw.text);
    return { externalId: null, title: asText(raw.title), createdAt: null, updatedAt: null, messages: parsed.messages, entry, currentNode: null, metadata: { labelHints: parsed.labelHints } };
  },
});

export const ADAPTERS = Object.freeze([
  chatgptAdapter, claudeAdapter, geminiAdapter, genericJsonAdapter,
  genericTextAdapter('GENERIC_HTML', /\.html?$/i), genericTextAdapter('GENERIC_MARKDOWN', /\.(md|markdown)$/i), genericTextAdapter('GENERIC_TEXT', /\.txt$/i),
]);
export const ADAPTER_BY_ID = Object.freeze(Object.fromEntries(ADAPTERS.map(a => [a.id, a])));

// Picks the adapter with the highest confidence; provider providers are verified only from structure.
export async function detectAdapter(source, { forceAdapter } = {}) {
  if (forceAdapter) { const a = ADAPTER_BY_ID[forceAdapter]; if (!a) throw new Error(`adapter inconnu : ${forceAdapter}`); return { adapter: a, confidence: 1, reason: 'forced by user', providerVerified: false }; }
  let best = null;
  for (const a of ADAPTERS) {
    const d = await a.detect(source);
    if (d.confidence > 0 && (!best || d.confidence > best.confidence)) best = { adapter: a, ...d };
  }
  if (!best) return null;
  return { ...best, providerVerified: best.adapter.provider !== 'UNKNOWN' && best.confidence >= 0.8 };
}

// ── validation ──────────────────────────────────────────────────────────────
export function validateConversation(conv, { maxMessageChars = 2_000_000, maxMessages = 1_000_000 } = {}) {
  const errors = [];
  if (!Array.isArray(conv.messages)) errors.push('messages absent');
  else {
    if (conv.messages.length > maxMessages) errors.push('trop de messages');
    for (const m of conv.messages) {
      if (!ROLES.includes(m.role)) errors.push(`rôle invalide : ${m.role}`);
      if (typeof m.content !== 'string') errors.push('contenu non textuel');
      else if (m.content.length > maxMessageChars) errors.push('message trop volumineux');
    }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)].slice(0, 5) };
}

// Attachment reference status. NEVER resolves a filesystem path: a reference is only ever matched
// against entry NAMES that are physically inside the chosen import, and unsafe names are blocked.
export function resolveAttachment(att, source) {
  const name = String(att.name ?? att.ref ?? '');
  if (!name) return { status: 'MISSING', reason: 'no reference' };
  const rawRef = [att.name, att.ref].filter(Boolean);
  for (const r of rawRef) {
    const c = checkEntryName(r); const looksPath = /[\\/:]/.test(r);
    if (!c.safe && (looksPath || /^file:/i.test(r))) return { status: 'SECURITY_BLOCKED', reason: c.reason };
  }
  const base = name.replace(/\\/g, '/').split('/').pop();
  const hit = source.names.find(n => n.split('/').pop() === base || (att.ref && n.includes(att.ref)));
  if (!hit) return { status: 'MISSING', reason: 'file not present in this import' };
  const entry = source.entryInfo?.(hit);
  if (entry?.blocked) return { status: 'SECURITY_BLOCKED', reason: entry.blocked };
  return { status: /\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|bin|mp3|mp4|wav|zip)$/i.test(hit) ? 'UNSUPPORTED' : 'AVAILABLE', reason: 'present in the import (content is not indexed in NB-4)' };
}
