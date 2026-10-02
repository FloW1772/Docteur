// Notebook NB-2 — raw document parsing (TXT / Markdown / PDF / HTML / JSON).
//
// Every imported file is DATA. Nothing here executes content: HTML is parsed
// by jsdom WITHOUT runScripts and WITHOUT resource loading, then reduced to
// text; JSON is JSON.parse'd (never eval'd) with size + depth caps; PDF goes
// through the existing pdf-parse pipeline in-memory (no temp files).
// DOCX is NOT implemented: no DOCX/zip library is a dependency and none was
// audited (license, maintenance, Windows, security surface) — see NB-2 report.
//
// No network, no child_process, no executor imports.

import path from 'node:path';
import fs from 'node:fs';

export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxExtractedChars: 2_000_000,
  maxChunks: 5000,
  maxJsonDepth: 32,
});

export function resolveLimits(overrides = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    maxFileBytes: num(overrides.maxFileBytes ?? process.env.NOTEBOOK_MAX_FILE_BYTES, DEFAULT_LIMITS.maxFileBytes),
    maxExtractedChars: num(overrides.maxExtractedChars ?? process.env.NOTEBOOK_MAX_EXTRACTED_CHARS, DEFAULT_LIMITS.maxExtractedChars),
    maxChunks: num(overrides.maxChunks ?? process.env.NOTEBOOK_MAX_CHUNKS, DEFAULT_LIMITS.maxChunks),
    maxJsonDepth: num(overrides.maxJsonDepth, DEFAULT_LIMITS.maxJsonDepth),
  };
}

export const SUPPORTED_FORMATS = Object.freeze({
  '.txt': { kind: 'text', mime: 'text/plain' },
  '.md': { kind: 'markdown', mime: 'text/markdown' },
  '.markdown': { kind: 'markdown', mime: 'text/markdown' },
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
  '.html': { kind: 'html', mime: 'text/html' },
  '.htm': { kind: 'html', mime: 'text/html' },
  '.json': { kind: 'json', mime: 'application/json' },
});

export class NotebookImportError extends Error {
  constructor(code, message, { status = 'FAILED' } = {}) {
    super(message);
    this.name = 'NotebookImportError';
    this.code = code;
    this.status = status;
  }
}

// ── File / path validation ──────────────────────────────────────────────────
export function safeFilename(name) {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001F<>:"|?*]/g, '_').trim().slice(0, 200);
}

export function validateFormat(filename) {
  const clean = safeFilename(filename);
  const ext = path.extname(clean).toLowerCase();
  if (ext === '.docx') {
    throw new NotebookImportError('UNSUPPORTED_FORMAT', 'DOCX non supporté dans NB-2 (aucune bibliothèque DOCX auditée). Exporte le document en PDF, Markdown ou TXT.');
  }
  const format = SUPPORTED_FORMATS[ext];
  if (!format) {
    throw new NotebookImportError('UNSUPPORTED_FORMAT', `Format non supporté : "${ext || '(sans extension)'}". Formats acceptés : ${Object.keys(SUPPORTED_FORMATS).join(', ')}`);
  }
  return { filename: clean, ext, ...format };
}

// Reads a file ONLY from inside one of the explicitly allowed roots. Rejects
// traversal, directories, symlink escapes and oversized files before reading.
export function readFileFromAllowedRoot(requestedPath, allowedRoots, limits = resolveLimits()) {
  const raw = String(requestedPath ?? '');
  if (!raw || raw.includes('\0')) throw new NotebookImportError('SECURITY_BLOCKED', 'Chemin invalide', { status: 'SECURITY_BLOCKED' });
  if (raw.split(/[\\/]+/).includes('..')) throw new NotebookImportError('SECURITY_BLOCKED', 'Traversée de chemin refusée', { status: 'SECURITY_BLOCKED' });
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new NotebookImportError('SECURITY_BLOCKED', 'Import par chemin désactivé : aucun dossier autorisé', { status: 'SECURITY_BLOCKED' });
  }
  let real;
  try { real = fs.realpathSync(path.resolve(raw)); } catch { throw new NotebookImportError('PARSER_FAILED', 'Fichier introuvable'); }
  const inside = allowedRoots.some(root => {
    let r;
    try { r = fs.realpathSync(path.resolve(root)); } catch { return false; }
    const rel = path.relative(r, real);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!inside) throw new NotebookImportError('SECURITY_BLOCKED', 'Chemin hors des dossiers autorisés', { status: 'SECURITY_BLOCKED' });
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new NotebookImportError('SECURITY_BLOCKED', 'Un fichier est attendu (pas un dossier)', { status: 'SECURITY_BLOCKED' });
  if (stat.size > limits.maxFileBytes) throw new NotebookImportError('FILE_TOO_LARGE', `Fichier trop volumineux (${stat.size} > ${limits.maxFileBytes} octets)`);
  return { bytes: fs.readFileSync(real), filename: path.basename(real) };
}

function decodeText(bytes) {
  if (bytes.includes(0)) throw new NotebookImportError('PARSER_FAILED', 'Contenu binaire détecté dans un fichier texte');
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A section = { text, page?: number, headingPath: string[] }. Parsers return
// ordered sections; the chunker preserves page + heading on every chunk.
function markdownSections(text) {
  const sections = [];
  const stack = []; // [{level, title}]
  let buf = [];
  let inFence = false;
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ text: body, headingPath: stack.map(h => h.title) });
    buf = [];
  };
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
      buf.push(line);
    } else buf.push(line);
  }
  flush();
  return sections;
}

async function parseHtml(bytes) {
  const html = decodeText(bytes);
  const { JSDOM } = await import('jsdom');
  // Default JSDOM options: runScripts undefined (scripts NOT executed),
  // resources undefined (nothing fetched). Remote content is never loaded.
  const dom = new JSDOM(html);
  try {
    const { document } = dom.window;
    for (const el of document.querySelectorAll('script,style,noscript,iframe,frame,object,embed,template,link,meta,svg,canvas,audio,video,form,input,button,select,textarea')) el.remove();
    const title = (document.title || '').trim();
    const sections = [];
    const stack = [];
    let buf = [];
    const flush = () => {
      const body = normalizeText(buf.join('\n'));
      if (body) sections.push({ text: body, headingPath: stack.map(h => h.title) });
      buf = [];
    };
    const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'BR', 'MAIN', 'HEADER', 'FOOTER', 'DL', 'DT', 'DD']);
    const walk = (node) => {
      if (node.nodeType === 3) { buf.push(node.nodeValue.replace(/\s+/g, ' ')); return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      const hm = /^H([1-6])$/.exec(tag);
      if (hm) {
        flush();
        const level = Number(hm[1]);
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        if (t) { stack.push({ level, title: t }); buf.push(t, '\n'); }
        return;
      }
      if (tag === 'TR') { // tables become row text: "cell | cell"
        const cells = [...node.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH').map(c => c.textContent.replace(/\s+/g, ' ').trim());
        if (cells.length) buf.push(cells.join(' | '));
        return;
      }
      for (const child of node.childNodes) walk(child);
      if (BLOCK.has(tag)) buf.push('\n');
    };
    walk(document.body ?? document.documentElement);
    flush();
    return { title, sections };
  } finally {
    dom.window.close();
  }
}

function jsonToText(value, limits) {
  const lines = [];
  const walk = (v, prefix, depth) => {
    if (depth > limits.maxJsonDepth) throw new NotebookImportError('PARSER_FAILED', 'JSON trop profond');
    if (lines.length > 200_000) throw new NotebookImportError('PARSER_FAILED', 'JSON trop volumineux');
    if (v === null || typeof v !== 'object') { lines.push(prefix ? `${prefix}: ${String(v)}` : String(v)); return; }
    if (Array.isArray(v)) { v.forEach((item, i) => walk(item, `${prefix}[${i}]`, depth + 1)); return; }
    for (const [k, val] of Object.entries(v)) walk(val, prefix ? `${prefix}.${k}` : k, depth + 1);
  };
  walk(value, '', 0);
  return lines.join('\n');
}

async function parsePdf(bytes) {
  if (Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== '%PDF') {
    throw new NotebookImportError('PARSER_FAILED', 'Le fichier ne semble pas être un PDF valide');
  }
  const { PDFParse } = await import('pdf-parse');
  let result;
  let parser;
  try {
    parser = new PDFParse({ data: new Uint8Array(bytes) });
    await parser.load();
    result = await parser.getText();
  } catch (err) {
    const msg = String(err?.message ?? '').toLowerCase();
    if (msg.includes('password') || msg.includes('encrypted')) throw new NotebookImportError('PARSER_FAILED', 'PDF protégé par mot de passe');
    throw new NotebookImportError('PARSER_FAILED', `Impossible de lire ce PDF : ${err?.message ?? 'erreur inconnue'}`);
  } finally {
    try { await parser?.destroy(); } catch { /* ignore */ }
  }
  const pages = Array.isArray(result?.pages) ? result.pages : [];
  const sections = [];
  pages.forEach((p, i) => {
    const text = normalizeText(p?.text ?? '')
      .replace(/^-- \d+ of \d+ --$/gm, '') // pdf-parse v2 page separator
      .trim();
    if (text) sections.push({ text, page: Number(p?.num ?? i + 1), headingPath: [] });
  });
  const total = Number(result?.total ?? pages.length ?? 1) || 1;
  const chars = sections.reduce((n, s) => n + s.text.length, 0);
  if (chars < 40 * total * 0.25 && chars < 40) {
    throw new NotebookImportError('PARSER_FAILED', 'PDF sans texte extractible (scanné ?) — OCR non disponible dans NB-2');
  }
  return { title: '', sections, pageCount: total };
}

// Main entry: bytes + filename → { title, mimeType, kind, sections, text }
export async function parseDocument({ bytes, filename }, limitsOverride = {}) {
  const limits = resolveLimits(limitsOverride);
  const format = validateFormat(filename);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new NotebookImportError('PARSER_FAILED', 'Fichier vide');
  if (bytes.length > limits.maxFileBytes) throw new NotebookImportError('FILE_TOO_LARGE', `Fichier trop volumineux (${bytes.length} > ${limits.maxFileBytes} octets)`);

  let title = '';
  let sections;
  let pageCount = null;
  try {
    if (format.kind === 'pdf') {
      const r = await parsePdf(bytes);
      sections = r.sections; pageCount = r.pageCount;
    } else if (format.kind === 'html') {
      const r = await parseHtml(bytes);
      sections = r.sections; title = r.title;
    } else if (format.kind === 'json') {
      const text = decodeText(bytes);
      let parsed;
      try { parsed = JSON.parse(text); } catch (err) { throw new NotebookImportError('PARSER_FAILED', `JSON invalide : ${err.message}`); }
      sections = [{ text: normalizeText(jsonToText(parsed, limits)), headingPath: [] }];
    } else if (format.kind === 'markdown') {
      sections = markdownSections(normalizeText(decodeText(bytes)));
      const h1 = sections.find(s => s.headingPath.length > 0);
      if (h1) title = h1.headingPath[0];
    } else {
      sections = [{ text: normalizeText(decodeText(bytes)), headingPath: [] }];
    }
  } catch (err) {
    if (err instanceof NotebookImportError) throw err;
    throw new NotebookImportError('PARSER_FAILED', `Échec de lecture : ${err?.message ?? 'erreur inconnue'}`);
  }

  sections = sections.filter(s => s.text && s.text.trim());
  const totalChars = sections.reduce((n, s) => n + s.text.length, 0);
  if (totalChars === 0) throw new NotebookImportError('PARSER_FAILED', 'Aucun texte extractible (document vide)');
  if (totalChars > limits.maxExtractedChars) {
    throw new NotebookImportError('FILE_TOO_LARGE', `Texte extrait trop volumineux (${totalChars} > ${limits.maxExtractedChars} caractères)`);
  }
  return {
    title: title || path.basename(format.filename, path.extname(format.filename)),
    filename: format.filename,
    mimeType: format.mime,
    kind: format.kind,
    sections,
    pageCount,
    totalChars,
  };
}

// Tiny language guess (fr / en) — best effort, null when unsure.
export function guessLanguage(text) {
  const s = ` ${String(text ?? '').slice(0, 5000).toLowerCase()} `;
  const count = (words) => words.reduce((n, w) => n + (s.split(` ${w} `).length - 1), 0);
  const fr = count(['le', 'la', 'les', 'des', 'est', 'une', 'et', 'que', 'pour', 'dans']);
  const en = count(['the', 'and', 'is', 'of', 'to', 'that', 'for', 'with', 'are', 'this']);
  if (fr + en < 4) return null;
  return fr > en * 1.2 ? 'fr' : en > fr * 1.2 ? 'en' : null;
}
