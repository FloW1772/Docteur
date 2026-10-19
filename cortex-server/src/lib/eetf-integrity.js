// EETF V1 — EETF-CERT structural integrity of an image file (pure, bounded, no decoder, no process).
//
// Applied by the asset store to EVERY ingest (uploads, Media Studio / Neurone imports, FFmpeg derivations, provider
// outputs): a truncated or structurally damaged file is refused before it gets an identity. It complements the header
// sniff (format / dimensions / budget, already checked) and, on external ingress, the bounded FFmpeg decode check
// (eetf-derive.js validateDecodable) — which catches what a structure walk cannot (e.g. damaged JPEG entropy data).
//
//   PNG   chunk walk bounded by the file, every CRC, IHDR first, ≥ 1 IDAT, IEND last; the image data inflates within a
//         bound computed from IHDR (no allocation beyond it) and is not shorter than the scanlines it must hold.
//   JPEG  SOI … SOF … SOS … EOI (trailing zero padding tolerated).
//   WebP  RIFF size = file size − 8, first chunk inside the file.
//   TIFF  first IFD inside the file; every strip / tile (offset, byte count) inside the file.
//   EXR   single-part scanline or one-level tiled: offset table present, every chunk header + payload inside the file.
//   HDR   header + resolution line, then every scanline (flat or new-style RLE) complete.

import zlib from 'node:zlib';
import { EetfError, limit } from './eetf-contracts.js';

const damaged = (what) => { throw new EetfError('EETF_MALFORMED_IMAGE', `damaged or truncated ${what} file`); };
const unsupported = (what) => { throw new EetfError('EETF_UNSUPPORTED_FORMAT', what); };

/** @param {Buffer} b  @param {{ format: string, width: number, height: number }} info (from sniffImage, budget already checked) */
export function assertStructurallyIntact(b, info) {
  switch (info.format) {
    case 'PNG': return checkPng(b, info);
    case 'JPEG': return checkJpeg(b);
    case 'WEBP': return checkWebp(b);
    case 'TIFF': return checkTiff(b);
    case 'EXR': return checkExr(b, info);
    case 'HDR': return checkHdr(b, info);
    default: return unsupported('unknown image format');
  }
}

// ── PNG ──
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function checkPng(b, { width, height }) {
  let at = 8; let first = true; let ended = false; const idat = []; let ihdr = null;
  while (at + 12 <= b.length) {
    const len = b.readUInt32BE(at);
    if (len > b.length - at - 12) damaged('PNG');
    const type = b.toString('latin1', at + 4, at + 8);
    if ((zlib.crc32(b.subarray(at + 4, at + 8 + len)) >>> 0) !== b.readUInt32BE(at + 8 + len)) damaged('PNG');
    if (first && type !== 'IHDR') damaged('PNG');
    first = false;
    const data = b.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { if (len !== 13) damaged('PNG'); ihdr = data; }
    else if (type === 'IDAT') idat.push(data);
    at += 12 + len;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !ihdr || idat.length === 0) damaged('PNG');
  const depth = ihdr[8]; const channels = PNG_CHANNELS[ihdr[9]]; const interlaced = ihdr[12] === 1;
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) damaged('PNG');
  const rowBytes = (w) => Math.ceil((w * channels * depth) / 8);
  let expected = 0;
  if (!interlaced) expected = (rowBytes(width) + 1) * height;
  else {
    for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
      const w = Math.ceil((width - x0) / dx); const h = Math.ceil((height - y0) / dy);
      if (w > 0 && h > 0) expected += (rowBytes(w) + 1) * h;
    }
  }
  let inflated;
  try { inflated = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }); } catch { damaged('PNG'); }
  if (inflated.length < expected) damaged('PNG');
}

// ── JPEG ──
function checkJpeg(b) {
  let end = b.length;
  while (end > 2 && b[end - 1] === 0x00) end -= 1;
  if (!(end >= 4 && b[end - 2] === 0xff && b[end - 1] === 0xd9)) damaged('JPEG');
  let i = 2; let sof = false; let sos = false;
  while (i + 4 <= end && !sos) {
    if (b[i] !== 0xff) damaged('JPEG');
    while (i < end && b[i] === 0xff) i++;
    const marker = b[i++];
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > end) damaged('JPEG');
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) sof = true;
    if (marker === 0xda) sos = true;
    i += len;
  }
  if (!sof || !sos || i >= end - 2) damaged('JPEG');
}

// ── WebP ──
function checkWebp(b) {
  if (b.readUInt32LE(4) + 8 !== b.length) damaged('WebP');
  let at = 12; let image = false;
  while (at + 8 <= b.length) { // every chunk (size padded to even) inside the RIFF; one VP8 / VP8L image chunk required
    const type = b.toString('latin1', at, at + 4); const size = b.readUInt32LE(at + 4);
    if (at + 8 + size > b.length) damaged('WebP');
    if (type === 'VP8 ') {
      if (size < 10) damaged('WebP');
      const tag = b.readUIntLE(at + 8, 3);
      if ((tag & 1) !== 0 || 10 + ((tag >>> 5) & 0x7ffff) > size) damaged('WebP'); // key frame + first partition inside the chunk
      image = true;
    } else if (type === 'VP8L') {
      if (size < 6 || b[at + 8] !== 0x2f) damaged('WebP');
      image = true;
    }
    at += 8 + size + (size & 1);
  }
  if (at !== b.length || !image) damaged('WebP');
}

// ── TIFF ──
function checkTiff(b) {
  const le = b[0] === 0x49;
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = u32(4);
  const count = u16(ifd);
  const values = (o) => {
    const type = u16(o + 2); const n = u32(o + 4); const size = type === 3 ? 2 : type === 4 ? 4 : 0;
    if (!size || n === 0 || n > 1_000_000) damaged('TIFF');
    const base = n * size <= 4 ? o + 8 : u32(o + 8);
    if (base + n * size > b.length) damaged('TIFF');
    return Array.from({ length: n }, (_, k) => (size === 2 ? u16(base + k * 2) : u32(base + k * 4)));
  };
  const tags = {};
  for (let e = 0; e < count; e++) {
    const o = ifd + 2 + e * 12;
    const tag = u16(o);
    if ([273, 279, 324, 325].includes(tag)) tags[tag] = values(o);
  }
  const [offsets, counts] = tags[273] ? [tags[273], tags[279]] : [tags[324], tags[325]];
  if (!offsets || !counts || offsets.length !== counts.length) damaged('TIFF');
  for (let k = 0; k < offsets.length; k++) if (counts[k] === 0 || offsets[k] + counts[k] > b.length) damaged('TIFF');
}

// ── OpenEXR ──
const EXR_LINES = { 0: 1, 1: 1, 2: 1, 3: 16, 4: 32, 5: 16, 6: 32, 7: 32, 8: 32, 9: 256 };
function checkExr(b, { height, width }) {
  let i = 8; const attrs = {};
  const cstr = () => { const e = b.indexOf(0, i); if (e < 0 || e - i > 255) damaged('EXR'); const s = b.toString('latin1', i, e); i = e + 1; return s; };
  while (i < b.length && b[i] !== 0) {
    const name = cstr(); const type = cstr();
    if (i + 4 > b.length) damaged('EXR');
    const size = b.readInt32LE(i); i += 4;
    if (size < 0 || i + size > b.length) damaged('EXR');
    attrs[name] = { type, data: b.subarray(i, i + size) };
    i += size;
  }
  if (i >= b.length) damaged('EXR');
  i += 1; // end of header
  const compression = attrs.compression?.data[0] ?? 0;
  let chunks; let headerBytes;
  if (attrs.tiles) {
    const d = attrs.tiles.data;
    if (d.length < 9) damaged('EXR');
    const xs = d.readUInt32LE(0); const ys = d.readUInt32LE(4); const mode = d[8] & 0x0f;
    if (mode !== 0) unsupported('mip-mapped / rip-mapped EXR is not accepted in V1');
    if (!xs || !ys) damaged('EXR');
    chunks = Math.ceil(width / xs) * Math.ceil(height / ys); headerBytes = 20;
  } else {
    const lines = EXR_LINES[compression];
    if (!lines) unsupported('unknown EXR compression');
    chunks = Math.ceil(height / lines); headerBytes = 8;
  }
  if (chunks > limit('maxPixels') || i + chunks * 8 > b.length) damaged('EXR');
  const tableEnd = i + chunks * 8;
  for (let k = 0; k < chunks; k++) {
    const off = Number(b.readBigUInt64LE(i + k * 8));
    if (off < tableEnd || off + headerBytes > b.length) damaged('EXR');
    const size = b.readInt32LE(off + headerBytes - 4);
    if (size < 0 || off + headerBytes + size > b.length) damaged('EXR');
  }
}

// ── Radiance HDR ──
function checkHdr(b, { width, height }) {
  const blank = b.indexOf('\n\n', 0, 'latin1');
  const lineEnd = blank < 0 ? -1 : b.indexOf('\n', blank + 2, 'latin1');
  if (lineEnd < 0) damaged('Radiance HDR');
  let i = lineEnd + 1;
  for (let y = 0; y < height; y++) {
    if (i + 4 > b.length) damaged('Radiance HDR');
    const rle = width >= 8 && width < 0x8000 && b[i] === 2 && b[i + 1] === 2 && !(b[i + 2] & 0x80);
    if (!rle) { // flat scanline (or old-style RLE, never written by FFmpeg): 4 bytes per pixel
      i += width * 4;
      if (i > b.length) damaged('Radiance HDR');
      continue;
    }
    if (((b[i + 2] << 8) | b[i + 3]) !== width) damaged('Radiance HDR');
    i += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        if (i >= b.length) damaged('Radiance HDR');
        let n = b[i++];
        if (n > 128) { n -= 128; if (n === 0 || x + n > width || i >= b.length) damaged('Radiance HDR'); i += 1; }
        else { if (n === 0 || x + n > width || i + n > b.length) damaged('Radiance HDR'); i += n; }
        x += n;
      }
    }
  }
}
