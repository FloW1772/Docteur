// EETF V1 — PNG metadata stripping without decoding (EETF-4).
//
// ComfyUI's SaveImage embeds the prompt and the whole workflow in PNG text
// chunks. Before a generated PNG enters the content-addressed store, every
// ancillary chunk that is not needed to display the pixels is dropped: text
// (tEXt / zTXt / iTXt), EXIF (eXIf), time (tIME), ICC (iCCP, EETF works in
// sRGB), and any private / unknown chunk. Pixel data (IDAT) is copied byte for
// byte. Every chunk CRC is verified; a malformed PNG is refused, never "fixed".

import zlib from 'node:zlib';
import { EetfError } from './eetf-contracts.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks kept: critical ones + colour / transparency information needed to show the pixels as encoded. */
const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'pHYs', 'bKGD']);
const MAX_CHUNKS = 100_000;

const bad = (message) => { throw new EetfError('EETF_MALFORMED_IMAGE', message); };

/** @returns {{ buffer: Buffer, removed: string[] }} */
export function stripPngMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 + 12 || !buf.subarray(0, 8).equals(SIGNATURE)) bad('not a PNG');
  const kept = [SIGNATURE]; const removed = [];
  let i = 8; let count = 0; let sawEnd = false; let first = true;
  while (i < buf.length) {
    if (++count > MAX_CHUNKS) bad('too many PNG chunks');
    if (i + 12 > buf.length) bad('truncated PNG chunk');
    const len = buf.readUInt32BE(i);
    if (len > 0x7fffffff || i + 12 + len > buf.length) bad('PNG chunk length out of range');
    const type = buf.toString('latin1', i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) bad('invalid PNG chunk type');
    if (first && type !== 'IHDR') bad('PNG does not start with IHDR');
    first = false;
    const crc = buf.readUInt32BE(i + 8 + len);
    if ((zlib.crc32(buf.subarray(i + 4, i + 8 + len)) >>> 0) !== crc) bad(`bad CRC in ${type}`);
    const chunk = buf.subarray(i, i + 12 + len);
    if (KEEP.has(type)) kept.push(chunk); else removed.push(type);
    i += 12 + len;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd) bad('PNG has no IEND');
  return { buffer: Buffer.concat(kept), removed };
}

/** Lists the chunk types of a PNG (tests / diagnostics). */
export function pngChunkTypes(buf) {
  const out = []; let i = 8;
  while (i + 8 <= buf.length) { const len = buf.readUInt32BE(i); out.push(buf.toString('latin1', i + 4, i + 8)); i += 12 + len; }
  return out;
}
