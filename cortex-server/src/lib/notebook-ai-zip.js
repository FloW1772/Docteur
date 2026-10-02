// Notebook NB-4 — hardened, dependency-free ZIP reader + streaming JSON-array splitter
// for AI-history exports.
//
// Nothing is ever extracted to disk: entries are inflated in memory, as bounded
// streams, only for the few entry names an adapter asks for. Every other entry is
// listed (name + declared size) and never opened. Protections:
//   zip-slip / "../" / absolute / drive / UNC / NUL / backslash tricks, symlink entries,
//   encrypted entries, zip64 / multi-disk (unsupported), nested archives (never opened),
//   duplicate names, entry-count cap, archive-size cap, declared AND actual size caps,
//   total-extracted cap, compression-ratio cap (measured on the real output), CRC-32 check.
// No network, no child_process, no executor imports.

import fs from 'node:fs';
import zlib from 'node:zlib';

export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 500 * 1024 * 1024,
  maxEntries: 5000,
  maxEntryBytes: 1024 * 1024 * 1024,
  maxTotalExtractedBytes: 2 * 1024 * 1024 * 1024,
  maxRatio: 300, // uncompressed / compressed, only enforced above MIN_RATIO_BYTES
});
const MIN_RATIO_BYTES = 1024 * 1024;
const NESTED_ARCHIVE_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|jar|war|apk|cab|iso)$/i;

export class ZipSecurityError extends Error {
  constructor(code, message) { super(message); this.name = 'ZipSecurityError'; this.code = code; }
}

export function resolveZipLimits(o = {}) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    maxArchiveBytes: n(o.maxArchiveBytes ?? process.env.NOTEBOOK_AI_MAX_ARCHIVE_BYTES, DEFAULT_ZIP_LIMITS.maxArchiveBytes),
    maxEntries: n(o.maxEntries, DEFAULT_ZIP_LIMITS.maxEntries),
    maxEntryBytes: n(o.maxEntryBytes ?? process.env.NOTEBOOK_AI_MAX_ENTRY_BYTES, DEFAULT_ZIP_LIMITS.maxEntryBytes),
    maxTotalExtractedBytes: n(o.maxTotalExtractedBytes, DEFAULT_ZIP_LIMITS.maxTotalExtractedBytes),
    maxRatio: n(o.maxRatio, DEFAULT_ZIP_LIMITS.maxRatio),
  };
}

// Returns { safe, reason } — pure name validation (also used for attachment references).
export function checkEntryName(rawName) {
  const name = String(rawName ?? '');
  if (!name) return { safe: false, reason: 'EMPTY_NAME' };
  if (name.includes('\0')) return { safe: false, reason: 'NUL_BYTE' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name) || /^file:/i.test(name)) return { safe: false, reason: 'URL_SCHEME' };
  if (/^[a-zA-Z]:/.test(name)) return { safe: false, reason: 'DRIVE_LETTER' };
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/') || unified.startsWith('//')) return { safe: false, reason: 'ABSOLUTE_OR_UNC' };
  if (unified.split('/').some(seg => seg === '..')) return { safe: false, reason: 'PATH_TRAVERSAL' };
  if (/%2e%2e|%2f|%5c/i.test(unified)) return { safe: false, reason: 'ENCODED_TRAVERSAL' };
  return { safe: true, reason: null };
}

// ── random-access readers ───────────────────────────────────────────────────
export function bufferReader(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return { size: u8.length, read: async (off, len) => Buffer.from(u8.subarray(off, Math.min(off + len, u8.length))), close: async () => {} };
}

export async function fileReader(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  const { size } = await fh.stat();
  return {
    size,
    read: async (off, len) => { const b = Buffer.alloc(Math.min(len, Math.max(0, size - off))); if (b.length) await fh.read(b, 0, b.length, off); return b; },
    close: async () => { await fh.close(); },
  };
}

export const looksLikeZip = (head) => head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05);

// ── central directory ───────────────────────────────────────────────────────
export async function openZip(reader, limitsIn = {}) {
  const limits = resolveZipLimits(limitsIn);
  if (reader.size > limits.maxArchiveBytes) throw new ZipSecurityError('ARCHIVE_TOO_LARGE', `Archive trop volumineuse (${reader.size} > ${limits.maxArchiveBytes})`);
  if (reader.size < 22) throw new ZipSecurityError('NOT_A_ZIP', 'Archive invalide');
  const tailLen = Math.min(reader.size, 22 + 65535);
  const tail = await reader.read(reader.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipSecurityError('NOT_A_ZIP', 'Fin de répertoire central introuvable');
  const disk = tail.readUInt16LE(eocd + 4); const cdDisk = tail.readUInt16LE(eocd + 6);
  const total = tail.readUInt16LE(eocd + 10); const cdSize = tail.readUInt32LE(eocd + 12); const cdOffset = tail.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new ZipSecurityError('UNSUPPORTED', 'Archive multi-disques non supportée');
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipSecurityError('UNSUPPORTED', 'ZIP64 non supporté');
  if (total > limits.maxEntries) throw new ZipSecurityError('TOO_MANY_ENTRIES', `Trop d'entrées (${total} > ${limits.maxEntries})`);
  if (cdOffset + cdSize > reader.size || cdSize > 64 * 1024 * 1024) throw new ZipSecurityError('NOT_A_ZIP', 'Répertoire central invalide');
  const cd = await reader.read(cdOffset, cdSize);
  const entries = []; const seen = new Set(); let pos = 0; let declaredTotal = 0;
  for (let i = 0; i < total; i++) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) throw new ZipSecurityError('NOT_A_ZIP', 'Entrée de répertoire corrompue');
    const flags = cd.readUInt16LE(pos + 8); const method = cd.readUInt16LE(pos + 10);
    const crc = cd.readUInt32LE(pos + 16); const csize = cd.readUInt32LE(pos + 20); const usize = cd.readUInt32LE(pos + 24);
    const nlen = cd.readUInt16LE(pos + 28); const xlen = cd.readUInt16LE(pos + 30); const clen = cd.readUInt16LE(pos + 32);
    const extAttr = cd.readUInt32LE(pos + 38); const lho = cd.readUInt32LE(pos + 42);
    const name = cd.subarray(pos + 46, pos + 46 + nlen).toString((flags & 0x800) ? 'utf8' : 'latin1');
    pos += 46 + nlen + xlen + clen;
    const unixMode = (extAttr >>> 16) & 0xffff;
    const isDir = name.endsWith('/');
    const nameCheck = checkEntryName(name);
    let blocked = null;
    if (!nameCheck.safe) blocked = nameCheck.reason;
    else if ((unixMode & 0xf000) === 0xa000) blocked = 'SYMLINK';
    else if (flags & 1) blocked = 'ENCRYPTED';
    else if (NESTED_ARCHIVE_RE.test(name)) blocked = 'NESTED_ARCHIVE';
    else if (method !== 0 && method !== 8) blocked = 'UNSUPPORTED_METHOD';
    else if (csize === 0xffffffff || usize === 0xffffffff) blocked = 'ZIP64_ENTRY';
    else if (usize > limits.maxEntryBytes) blocked = 'ENTRY_TOO_LARGE';
    const key = name.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key) && !isDir) blocked = blocked ?? 'DUPLICATE_NAME';
    seen.add(key);
    declaredTotal += usize;
    entries.push({ name: name.replace(/\\/g, '/'), rawName: name, isDir, method, crc, csize, usize, lho, flags, blocked });
  }
  if (declaredTotal > limits.maxTotalExtractedBytes) throw new ZipSecurityError('ARCHIVE_TOO_LARGE_UNCOMPRESSED', `Taille décompressée déclarée excessive (${declaredTotal})`);
  let extractedSoFar = 0;

  // Bounded stream of ONE entry. Aborts the moment the REAL output breaks a cap.
  async function* openEntry(entry, signal) {
    if (entry.blocked) throw new ZipSecurityError('ENTRY_BLOCKED', `Entrée refusée (${entry.blocked}) : ${entry.name}`);
    const lh = await reader.read(entry.lho, 30);
    if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new ZipSecurityError('NOT_A_ZIP', 'En-tête local invalide');
    const dataStart = entry.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    if (dataStart + entry.csize > reader.size) throw new ZipSecurityError('NOT_A_ZIP', 'Données hors archive');
    let produced = 0; let crc = 0;
    const check = (chunk) => {
      produced += chunk.length; extractedSoFar += chunk.length;
      if (produced > entry.usize + 1024 || produced > limits.maxEntryBytes) throw new ZipSecurityError('ENTRY_TOO_LARGE', 'Taille réelle supérieure à la taille déclarée');
      if (extractedSoFar > limits.maxTotalExtractedBytes) throw new ZipSecurityError('ARCHIVE_TOO_LARGE_UNCOMPRESSED', 'Volume total décompressé excessif');
      if (produced > MIN_RATIO_BYTES && entry.csize > 0 && produced / entry.csize > limits.maxRatio) throw new ZipSecurityError('COMPRESSION_RATIO', 'Ratio de compression abusif (bombe potentielle)');
      crc = zlib.crc32(chunk, crc);
    };
    const SLICE = 64 * 1024;
    if (entry.method === 0) {
      for (let off = 0; off < entry.csize; off += SLICE) {
        signal?.throwIfAborted?.();
        const chunk = await reader.read(dataStart + off, Math.min(SLICE, entry.csize - off));
        check(chunk); yield chunk;
      }
    } else {
      const inflater = zlib.createInflateRaw();
      let failure = null;
      inflater.on('error', e => { failure = e; });
      const feed = (async () => {
        for (let off = 0; off < entry.csize; off += SLICE) {
          signal?.throwIfAborted?.();
          const chunk = await reader.read(dataStart + off, Math.min(SLICE, entry.csize - off));
          if (!inflater.write(chunk)) await new Promise(r => inflater.once('drain', r));
          if (failure) return;
        }
        inflater.end();
      })();
      try {
        for await (const out of inflater) { check(out); yield out; }
        await feed;
        if (failure) throw new ZipSecurityError('CORRUPT_ENTRY', `Entrée corrompue : ${failure.message}`);
      } finally { inflater.destroy(); }
    }
    if (produced !== entry.usize) throw new ZipSecurityError('CORRUPT_ENTRY', 'Taille inattendue après décompression');
    if ((crc >>> 0) !== entry.crc) throw new ZipSecurityError('CORRUPT_ENTRY', 'CRC-32 invalide');
  }

  return { entries, limits, openEntry, close: () => reader.close() };
}

// ── streaming splitter for a top-level JSON array ───────────────────────────
// Consumes an async iterable of Buffers/strings and yields each top-level array
// element as a JSON.parse'd value without ever holding the whole document.
// Also accepts a top-level object holding the array under `key` (handled by caller
// through `findArrayKey`). Malformed JSON ⇒ throws; a single element bigger than
// maxElementBytes ⇒ throws (protects RAM).
export async function* streamJsonArray(chunks, { maxElementBytes = 64 * 1024 * 1024, signal } = {}) {
  let depth = 0; let inStr = false; let esc = false; let started = false; let ended = false;
  let elem = []; let elemBytes = 0; let elemStartDepth = 1; let sawValue = false;
  const flushElem = function* () {
    if (!sawValue) return;
    const text = elem.join('').trim();
    elem = []; elemBytes = 0; sawValue = false;
    if (text.length > maxElementBytes) throw new RangeError('Élément JSON trop volumineux');
    if (text) yield JSON.parse(text);
  };
  const decoder = new TextDecoder('utf-8');
  for await (const raw of chunks) {
    signal?.throwIfAborted?.();
    const s = typeof raw === 'string' ? raw : decoder.decode(raw, { stream: true });
    let segStart = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (!started) {
        if (ch === 0xfeff || ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09) { segStart = i + 1; continue; }
        if (ch !== 0x5b) throw new SyntaxError('Tableau JSON attendu à la racine');
        started = true; depth = 1; segStart = i + 1; continue;
      }
      if (ended) { if (ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09) continue; throw new SyntaxError('Contenu inattendu après le tableau'); }
      if (inStr) {
        if (esc) esc = false; else if (ch === 0x5c) esc = true; else if (ch === 0x22) inStr = false;
        continue;
      }
      if (ch === 0x22) { inStr = true; sawValue = true; continue; }
      if (ch === 0x5b || ch === 0x7b) { depth++; sawValue = true; continue; }
      if (ch === 0x5d || ch === 0x7d) {
        depth--;
        if (depth === 0) { // closing bracket of the top-level array
          elem.push(s.slice(segStart, i)); yield* flushElem(); ended = true; segStart = i + 1;
        }
        continue;
      }
      if (ch === 0x2c && depth === elemStartDepth) {
        elem.push(s.slice(segStart, i)); elemBytes += i - segStart; yield* flushElem(); segStart = i + 1; continue;
      }
      if (ch > 0x20) sawValue = true;
    }
    if (started && !ended) {
      elem.push(s.slice(segStart)); elemBytes += s.length - segStart;
      if (elemBytes > maxElementBytes) throw new RangeError('Élément JSON trop volumineux');
    }
  }
  if (!started) throw new SyntaxError('JSON vide');
  if (!ended) throw new SyntaxError('JSON tronqué');
}

// Async iterable over an in-memory Buffer / file path (bounded slices).
export async function* bufferChunks(buf, size = 256 * 1024) {
  for (let off = 0; off < buf.length; off += size) yield buf.subarray(off, off + size);
}
export async function* fileChunks(filePath, signal) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  try { for await (const c of stream) { signal?.throwIfAborted?.(); yield c; } } finally { stream.destroy(); }
}
