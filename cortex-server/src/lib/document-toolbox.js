// Document Toolbox PDF V1 — local PDF workshop.
//
// Reuses what exists: pdf-parse (pdfjs-dist + @napi-rs/canvas) for reading,
// text, metadata and page rendering; pdf-lib 1.17.1 (pinned, audited) for every
// write. 100% local: no network, no AI, no shell, no file-system path from the
// user. Inputs live in a bounded in-memory workspace; every operation produces a
// NEW document — a source is never modified or overwritten.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

export const LIMITS = Object.freeze({
  maxFileBytes: 50 * 1024 * 1024,
  maxImageBytes: 25 * 1024 * 1024,
  maxPages: 1_000,
  maxOutputPages: 2_000,
  maxMergeInputs: 20,
  maxImagesPerPdf: 200,
  maxImageSide: 10_000,
  maxPageSidePt: 14_400, // 200 inches: beyond is a hostile / bomb page
  maxRenderPixels: 16_000_000,
  maxRenderScale: 3,
  maxDocs: 40,
  maxStoreBytes: 400 * 1024 * 1024,
  ttlMs: 60 * 60_000,
  maxTextChars: 2_000_000,
  maxWatermarkChars: 120,
});

export class ToolboxError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// ── Validation ───────────────────────────────────────────────────────────────

export function isPdfSignature(bytes) {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

export function sniffImage(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(Buffer.from(b.subarray(0, 6)).toString('latin1'))) return 'gif';
  return null;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** Safe display/download name: no path, no control or reserved characters, bounded. */
export function sanitizeFileName(name, ext) {
  let base = String(name ?? '').normalize('NFC').split(/[\\/]/).pop() ?? '';
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '');
  base = base.replace(/\.(pdf|png|jpe?g|webp|gif)$/i, '').trim();
  if (!base || WINDOWS_RESERVED.test(base)) base = 'document';
  base = base.slice(0, 100);
  return ext ? `${base}.${ext}` : base;
}

export const isDocId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

async function loadPdf(bytes) {
  if (!isPdfSignature(bytes)) throw new ToolboxError('NOT_A_PDF', 'Ce fichier n’est pas un PDF (signature %PDF absente).');
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(err?.name ?? '') || /encrypt/i.test(err?.message ?? '')) throw new ToolboxError('ENCRYPTED_PDF', 'PDF chiffré : Docteur ne le déverrouille pas. Ouvrez-le avec son mot de passe dans un lecteur PDF et enregistrez une copie non protégée.');
    throw new ToolboxError('CORRUPT_PDF', 'PDF illisible ou corrompu.');
  }
  // pdf-lib is lenient on load: a damaged file can "load" and only fail when its
  // page tree is read. Any failure here is reported as a corrupt PDF.
  let count;
  let sizes;
  try {
    count = doc.getPageCount();
    sizes = count > 0 && count <= LIMITS.maxPages ? doc.getPages().map(p => p.getSize()) : [];
  } catch {
    throw new ToolboxError('CORRUPT_PDF', 'PDF illisible ou corrompu (arborescence des pages invalide).');
  }
  if (count === 0) throw new ToolboxError('CORRUPT_PDF', 'PDF sans page.');
  if (count > LIMITS.maxPages) throw new ToolboxError('TOO_MANY_PAGES', `PDF trop long : ${count} pages (maximum ${LIMITS.maxPages}).`, 413);
  for (const { width, height } of sizes) {
    if (!(width > 0 && height > 0) || width > LIMITS.maxPageSidePt || height > LIMITS.maxPageSidePt) throw new ToolboxError('PAGE_TOO_LARGE', 'Une page a des dimensions anormales (fichier refusé par sécurité).', 413);
  }
  return doc;
}

function pagesArg(list, count, { allowEmpty = false } = {}) {
  if (!Array.isArray(list) || (!allowEmpty && list.length === 0)) throw new ToolboxError('PAGES_REQUIRED', 'Sélectionnez au moins une page.');
  const out = [];
  for (const p of list) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > count) throw new ToolboxError('PAGE_OUT_OF_RANGE', `Page invalide : ${p} (le document a ${count} pages).`);
    out.push(n);
  }
  return out;
}

/** "1-3, 5, 8-10" → [[1,2,3],[5],[8,9,10]] (1-based, validated). */
export function parseRanges(text, count) {
  const groups = [];
  for (const part of String(text ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new ToolboxError('INVALID_RANGES', `Plage invalide : « ${part} ». Exemple : 1-3, 5, 8-10.`);
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > count || a > b) throw new ToolboxError('INVALID_RANGES', `Plage hors document : « ${part} » (1-${count}).`);
    groups.push(Array.from({ length: b - a + 1 }, (_, i) => a + i));
  }
  if (!groups.length) throw new ToolboxError('INVALID_RANGES', 'Indiquez au moins une plage de pages.');
  return groups;
}

async function copyPagesTo(target, source, pageNumbers) {
  const copied = await target.copyPages(source, pageNumbers.map(n => n - 1));
  for (const p of copied) target.addPage(p);
}

async function finish(doc, { title } = {}) {
  if (doc.getPageCount() > LIMITS.maxOutputPages) throw new ToolboxError('TOO_MANY_PAGES', `Résultat trop long (maximum ${LIMITS.maxOutputPages} pages).`, 413);
  if (title) doc.setTitle(title);
  doc.setProducer('Docteur Document Toolbox (pdf-lib)');
  doc.setModificationDate(new Date());
  return Buffer.from(await doc.save());
}

// ── Reading (pdf-parse / pdfjs) ──────────────────────────────────────────────

// No JS evaluation, no XFA, no font loading from the system.
const pdfjsParams = (bytes) => ({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: false });

export async function inspectPdf(bytes) {
  const doc = await loadPdf(bytes);
  const pages = doc.getPages().map((page, i) => {
    const { width, height } = page.getSize();
    return { page: i + 1, width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100, rotation: page.getRotation().angle % 360 };
  });
  const date = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);
  return {
    pageCount: pages.length,
    pages,
    metadata: {
      title: doc.getTitle() ?? null, author: doc.getAuthor() ?? null, subject: doc.getSubject() ?? null,
      keywords: doc.getKeywords() ?? null, creator: doc.getCreator() ?? null, producer: doc.getProducer() ?? null,
      creationDate: date(doc.getCreationDate()), modificationDate: date(doc.getModificationDate()),
    },
  };
}

export async function extractText(bytes, { pages = null } = {}) {
  const info = await loadPdf(bytes);
  const count = info.getPageCount();
  const wanted = pages ? pagesArg(pages, count) : null;
  const parser = new PDFParse(pdfjsParams(bytes));
  try {
    const result = await parser.getText(wanted ? { partial: wanted } : {});
    let total = 0;
    const out = (result.pages ?? []).map(p => {
      const text = String(p.text ?? '');
      total += text.length;
      return { page: p.num ?? p.pageNumber, text };
    });
    if (total > LIMITS.maxTextChars) throw new ToolboxError('TEXT_TOO_LARGE', 'Texte trop volumineux pour être affiché.', 413);
    return { pages: out, empty: total === 0 };
  } catch (err) {
    if (err instanceof ToolboxError) throw err;
    throw new ToolboxError('CORRUPT_PDF', 'Extraction du texte impossible (PDF illisible).');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** One page rendered to PNG, scale bounded so the bitmap stays under maxRenderPixels. */
export async function renderPage(bytes, pageNumber, { scale = 1 } = {}) {
  const doc = await loadPdf(bytes);
  const [n] = pagesArg([pageNumber], doc.getPageCount());
  const { width, height } = doc.getPage(n - 1).getSize();
  const requested = Math.min(Math.max(Number(scale) || 1, 0.05), LIMITS.maxRenderScale);
  const safe = Math.min(requested, Math.sqrt(LIMITS.maxRenderPixels / (width * height)));
  const parser = new PDFParse(pdfjsParams(bytes));
  try {
    const shot = await parser.getScreenshot({ partial: [n], scale: safe, imageDataUrl: false, imageBuffer: true });
    const page = shot.pages?.[0];
    if (!page?.data?.length) throw new ToolboxError('RENDER_FAILED', 'Rendu de la page impossible.', 422);
    return { png: Buffer.from(page.data), width: page.width, height: page.height, scale: safe };
  } catch (err) {
    if (err instanceof ToolboxError) throw err;
    throw new ToolboxError('RENDER_FAILED', 'Rendu de la page impossible (PDF illisible).', 422);
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// ── Writing (pdf-lib) — always a new document ────────────────────────────────

export async function merge(sources) {
  if (!Array.isArray(sources) || sources.length < 2) throw new ToolboxError('MERGE_NEEDS_TWO', 'Sélectionnez au moins deux PDF à fusionner.');
  if (sources.length > LIMITS.maxMergeInputs) throw new ToolboxError('TOO_MANY_INPUTS', `Au maximum ${LIMITS.maxMergeInputs} PDF à la fois.`);
  const out = await PDFDocument.create();
  for (const src of sources) {
    const doc = await loadPdf(src.bytes);
    await copyPagesTo(out, doc, doc.getPageIndices().map(i => i + 1));
  }
  return finish(out);
}

export async function extractPages(bytes, pages) {
  const src = await loadPdf(bytes);
  const out = await PDFDocument.create();
  await copyPagesTo(out, src, pagesArg(pages, src.getPageCount()));
  return finish(out);
}

export async function split(bytes, { ranges = null, every = null } = {}) {
  const src = await loadPdf(bytes);
  const count = src.getPageCount();
  let groups;
  if (every !== null && every !== undefined) {
    const k = Number(every);
    if (!Number.isInteger(k) || k < 1 || k > count) throw new ToolboxError('INVALID_RANGES', `« Toutes les N pages » : N entre 1 et ${count}.`);
    groups = [];
    for (let i = 1; i <= count; i += k) groups.push(Array.from({ length: Math.min(k, count - i + 1) }, (_, j) => i + j));
  } else {
    groups = parseRanges(ranges, count);
  }
  if (groups.length > 200) throw new ToolboxError('TOO_MANY_OUTPUTS', 'Trop de documents en sortie (maximum 200).');
  const outputs = [];
  for (const group of groups) {
    const out = await PDFDocument.create();
    await copyPagesTo(out, src, group);
    outputs.push({ pages: group, bytes: await finish(out) });
  }
  return outputs;
}

export async function reorder(bytes, order) {
  const src = await loadPdf(bytes);
  const count = src.getPageCount();
  const pages = pagesArg(order, count);
  if (pages.length !== count || new Set(pages).size !== count) throw new ToolboxError('INVALID_ORDER', 'Le nouvel ordre doit contenir chaque page une seule fois.');
  const out = await PDFDocument.create();
  await copyPagesTo(out, src, pages);
  return finish(out);
}

export async function rotate(bytes, pages, angle) {
  const a = Number(angle);
  if (![90, 180, 270, -90].includes(a)) throw new ToolboxError('INVALID_ANGLE', 'Rotation : 90, 180 ou 270 degrés.');
  const doc = await loadPdf(bytes);
  for (const n of pagesArg(pages, doc.getPageCount())) {
    const page = doc.getPage(n - 1);
    page.setRotation(degrees((((page.getRotation().angle + a) % 360) + 360) % 360));
  }
  return finish(doc);
}

export async function deletePages(bytes, pages) {
  const src = await loadPdf(bytes);
  const count = src.getPageCount();
  const remove = new Set(pagesArg(pages, count));
  if (remove.size >= count) throw new ToolboxError('CANNOT_DELETE_ALL', 'Impossible de supprimer toutes les pages.');
  const keep = Array.from({ length: count }, (_, i) => i + 1).filter(n => !remove.has(n));
  const out = await PDFDocument.create();
  await copyPagesTo(out, src, keep);
  return finish(out);
}

export async function duplicatePages(bytes, pages) {
  const src = await loadPdf(bytes);
  const count = src.getPageCount();
  const dup = new Set(pagesArg(pages, count));
  const order = [];
  for (let n = 1; n <= count; n += 1) { order.push(n); if (dup.has(n)) order.push(n); }
  const out = await PDFDocument.create();
  await copyPagesTo(out, src, order);
  return finish(out);
}

export async function writeMetadata(bytes, meta) {
  const doc = await loadPdf(bytes);
  const field = (v, max = 500) => (v === undefined ? undefined : String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max));
  const title = field(meta?.title); const author = field(meta?.author); const subject = field(meta?.subject);
  const keywords = meta?.keywords === undefined ? undefined : (Array.isArray(meta.keywords) ? meta.keywords : String(meta.keywords).split(',')).map(k => field(k, 100)).filter(Boolean).slice(0, 50);
  if (title !== undefined) doc.setTitle(title);
  if (author !== undefined) doc.setAuthor(author);
  if (subject !== undefined) doc.setSubject(subject);
  if (keywords !== undefined) doc.setKeywords(keywords);
  return finish(doc);
}

export async function watermark(bytes, { text, pages = null, opacity = 0.2, size = 48, angle = 45 } = {}) {
  const label = String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
  if (!label) throw new ToolboxError('WATERMARK_TEXT_REQUIRED', 'Saisissez le texte du filigrane.');
  if (label.length > LIMITS.maxWatermarkChars) throw new ToolboxError('WATERMARK_TEXT_TOO_LONG', `Filigrane limité à ${LIMITS.maxWatermarkChars} caractères.`);
  const doc = await loadPdf(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  try { font.encodeText(label); } catch { throw new ToolboxError('WATERMARK_UNSUPPORTED_CHARACTERS', 'Le filigrane contient des caractères non pris en charge par la police standard (lettres latines accentuées acceptées).'); }
  const o = Math.min(Math.max(Number(opacity) || 0.2, 0.05), 1);
  const s = Math.min(Math.max(Number(size) || 48, 6), 200);
  const a = Math.min(Math.max(Number(angle) || 0, -90), 90);
  const targets = pages ? pagesArg(pages, doc.getPageCount()) : doc.getPageIndices().map(i => i + 1);
  for (const n of targets) {
    const page = doc.getPage(n - 1);
    const { width, height } = page.getSize();
    const rad = (a * Math.PI) / 180;
    // Shrink to fit: the whole label stays inside the page at its angle (never clipped).
    const cos = Math.abs(Math.cos(rad)); const sin = Math.abs(Math.sin(rad));
    const maxLength = Math.min(cos > 1e-6 ? (0.9 * width) / cos : Infinity, sin > 1e-6 ? (0.9 * height) / sin : Infinity);
    const fitted = Math.min(s, maxLength / font.widthOfTextAtSize(label, 1));
    const w = font.widthOfTextAtSize(label, fitted);
    page.drawText(label, {
      x: width / 2 - (w / 2) * Math.cos(rad), y: height / 2 - (w / 2) * Math.sin(rad),
      size: fitted, font, color: rgb(0.5, 0.5, 0.5), opacity: o, rotate: degrees(a),
    });
  }
  return finish(doc);
}

/** Images → PDF. PNG/JPEG embedded as is; WebP/GIF decoded locally (@napi-rs/canvas) to PNG first. */
export async function imagesToPdf(images, { fit = 'image' } = {}) {
  if (!Array.isArray(images) || images.length === 0) throw new ToolboxError('IMAGES_REQUIRED', 'Ajoutez au moins une image.');
  if (images.length > LIMITS.maxImagesPerPdf) throw new ToolboxError('TOO_MANY_INPUTS', `Au maximum ${LIMITS.maxImagesPerPdf} images.`);
  const out = await PDFDocument.create();
  for (const img of images) {
    const kind = sniffImage(img.bytes);
    let embedded;
    try {
      if (kind === 'png') embedded = await out.embedPng(img.bytes);
      else if (kind === 'jpeg') embedded = await out.embedJpg(img.bytes);
      else if (kind === 'webp' || kind === 'gif') {
        const { loadImage, createCanvas } = require('@napi-rs/canvas');
        const decoded = await loadImage(Buffer.from(img.bytes));
        if (decoded.width > LIMITS.maxImageSide || decoded.height > LIMITS.maxImageSide) throw new ToolboxError('IMAGE_TOO_LARGE', 'Image trop grande.', 413);
        const canvas = createCanvas(decoded.width, decoded.height);
        canvas.getContext('2d').drawImage(decoded, 0, 0);
        embedded = await out.embedPng(canvas.toBuffer('image/png'));
      } else throw new ToolboxError('UNSUPPORTED_IMAGE', 'Image non prise en charge (PNG, JPEG, WebP, GIF).');
    } catch (err) {
      if (err instanceof ToolboxError) throw err;
      throw new ToolboxError('CORRUPT_IMAGE', `Image illisible : ${sanitizeFileName(img.name)}.`);
    }
    if (embedded.width > LIMITS.maxImageSide || embedded.height > LIMITS.maxImageSide) throw new ToolboxError('IMAGE_TOO_LARGE', 'Image trop grande.', 413);
    if (fit === 'a4') {
      const A4 = [595.28, 841.89];
      const page = out.addPage(A4);
      const k = Math.min((A4[0] - 40) / embedded.width, (A4[1] - 40) / embedded.height, 1);
      const w = embedded.width * k; const h = embedded.height * k;
      page.drawImage(embedded, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
    } else {
      // 1 px = 0.75 pt (96 dpi), bounded to a sane page size.
      const k = Math.min(0.75, LIMITS.maxPageSidePt / Math.max(embedded.width, embedded.height));
      const page = out.addPage([embedded.width * k, embedded.height * k]);
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width * k, height: embedded.height * k });
    }
  }
  return finish(out);
}

/**
 * COMPRESSION_LIMITED: pdf-lib only rewrites the structure (object streams).
 * It does not recompress images or fonts, so a real size reduction is not guaranteed.
 */
export async function compress(bytes) {
  const doc = await loadPdf(bytes);
  doc.setProducer('Docteur Document Toolbox (pdf-lib)');
  const out = Buffer.from(await doc.save({ useObjectStreams: true }));
  return { bytes: out, before: bytes.length, after: out.length, status: 'COMPRESSION_LIMITED', smaller: out.length < bytes.length };
}

// ── Workspace (in memory, bounded, never touches the user's files) ───────────

export function createDocumentStore({ now = () => Date.now() } = {}) {
  const docs = new Map();
  const total = () => [...docs.values()].reduce((n, d) => n + d.bytes.length, 0);
  const sweep = () => {
    for (const [id, d] of docs) if (now() - d.lastAccess > LIMITS.ttlMs) docs.delete(id);
  };
  const summary = (d) => ({ id: d.id, name: d.name, kind: d.kind, size: d.bytes.length, pageCount: d.pageCount ?? null, origin: d.origin, createdAt: new Date(d.createdAt).toISOString() });
  return {
    put({ name, kind, bytes, pageCount = null, origin = null }) {
      sweep();
      if (bytes.length > LIMITS.maxStoreBytes) throw new ToolboxError('FILE_TOO_LARGE', 'Fichier trop volumineux.', 413);
      // Evict the least recently used documents to stay within the bounds.
      while ((docs.size >= LIMITS.maxDocs || total() + bytes.length > LIMITS.maxStoreBytes) && docs.size) {
        const oldest = [...docs.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0];
        docs.delete(oldest.id);
      }
      const id = crypto.randomUUID();
      const t = now();
      const ext = kind === 'pdf' ? 'pdf' : kind;
      docs.set(id, { id, name: sanitizeFileName(name, ext), kind, bytes, pageCount, origin, createdAt: t, lastAccess: t });
      return summary(docs.get(id));
    },
    get(id) {
      sweep();
      if (!isDocId(id)) throw new ToolboxError('INVALID_ID', 'Identifiant de document invalide.');
      const d = docs.get(id);
      if (!d) throw new ToolboxError('DOC_NOT_FOUND', 'Document introuvable (expiré ou supprimé de l’atelier).', 404);
      d.lastAccess = now();
      return d;
    },
    summary,
    list() { sweep(); return [...docs.values()].sort((a, b) => a.createdAt - b.createdAt).map(summary); },
    remove(id) { if (!isDocId(id)) throw new ToolboxError('INVALID_ID', 'Identifiant de document invalide.'); return docs.delete(id); },
    get size() { return docs.size; },
  };
}
