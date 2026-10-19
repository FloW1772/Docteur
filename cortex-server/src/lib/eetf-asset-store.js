// EETF V1 — content-addressed local asset store (EETF-2).
//
// Layout under a server-chosen root:
//   assets/<sha256[0:2]>/<sha256>.<ext>   immutable (read-only attribute), never overwritten
//   thumbs/                               derived previews (EETF-3+)
//   tmp/<uuid>.part                       in-flight writes, purged at recovery
//
// The caller never supplies a path: every path is built here from a validated
// sha256 + a format enum, then resolved and checked to stay under the root
// (no `..`, absolute, drive, UNC, reserved Windows name, NUL, ADS) with no
// symbolic link / junction anywhere between the root and the target.
//
// Image headers are parsed WITHOUT decoding (format, dimensions, alpha), so an
// oversized image is refused before any decoder ever sees it. No process, no
// network, no FFmpeg here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EetfError, FORMAT_EXT, FORMAT_MIME, formatFromMime, isSha256, limit, resolveDynamicRange, assertSha256,
} from './eetf-contracts.js';
import { assertStructurallyIntact } from './eetf-integrity.js'; // [EETF-CERT] every ingest, every path

const fail = (code, message, details) => { throw new EetfError(code, message, details); };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The user data directory: EETF-2 never stores anything there (boot gate, certification later). */
export const USER_DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

const RESERVED_WIN_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const FORBIDDEN_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;
const TMP_OUTPUT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.out\.(png|jpg|webp|tiff|exr|hdr)$/;
const TMP_CHECK_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.check\.(png|jpg|webp|tiff|exr|hdr)$/; // [EETF-CERT]
const STORAGE_PATH_RE =/^assets\/([0-9a-f]{2})\/([0-9a-f]{64})\.(png|jpg|webp|tiff|exr|hdr)$/;

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

export function isInsideDir(child, dir) {
  const rel = path.relative(dir, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOrResolved(p) {
  const resolved = path.resolve(p);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

/** True when `p` is (or would be) inside the user data directory, links resolved. */
export function isInUserData(p) {
  return isInsideDir(norm(realOrResolved(p)), norm(realOrResolved(USER_DATA_DIR)));
}

/**
 * Validates a RELATIVE path built by the server. Refuses anything a client could
 * use to escape: traversal, absolute / drive / UNC / device paths, reserved
 * Windows names, trailing dots or spaces, alternate data streams, NUL.
 */
export function assertSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 400) fail('EETF_UNSAFE_PATH', 'path must be a non-empty string');
  if (rel.includes('\u0000')) fail('EETF_UNSAFE_PATH', 'NUL in path');
  if (/^[\\/]{2}/.test(rel)) fail('EETF_UNSAFE_PATH', 'UNC / device paths are refused');
  if (/^[a-zA-Z]:/.test(rel) || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) fail('EETF_UNSAFE_PATH', 'absolute paths are refused');
  const segments = rel.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') fail('EETF_UNSAFE_PATH', 'empty, "." or ".." segment refused');
    if (FORBIDDEN_SEGMENT_CHARS.test(seg)) fail('EETF_UNSAFE_PATH', 'forbidden character in path');
    if (/[.\s]$/.test(seg)) fail('EETF_UNSAFE_PATH', 'trailing dot or space refused');
    if (RESERVED_WIN_NAMES.test(seg.split('.')[0])) fail('EETF_UNSAFE_PATH', 'reserved Windows device name refused');
  }
  return segments;
}

export class EetfAssetStore {
  /**
   * @param {{ root: string }} opts root chosen by the server (absolute, outside the user data directory in EETF-2)
   */
  constructor({ root }) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('EETF_UNSAFE_ROOT', 'asset root must be an absolute path');
    if (/^[\\/]{2}/.test(root)) fail('EETF_UNSAFE_ROOT', 'UNC asset root refused');
    if (isInUserData(root)) fail('EETF_ROOT_IN_USER_DATA', 'EETF-2 never stores assets in the user data directory');
    fs.mkdirSync(root, { recursive: true });
    const st = fs.lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) fail('EETF_UNSAFE_ROOT', 'asset root must be a real directory');
    this.root = fs.realpathSync.native(root);
    if (isInUserData(this.root)) fail('EETF_ROOT_IN_USER_DATA', 'EETF-2 never stores assets in the user data directory');
    for (const d of ['assets', 'thumbs', 'tmp']) this.#ensureDir(d);
  }

  /** Resolves a server-built relative path under the root; refuses any link on the way. */
  resolveInside(rel) {
    const segments = assertSafeRelativePath(rel);
    const abs = path.resolve(this.root, ...segments);
    if (!isInsideDir(norm(abs), norm(this.root)) || norm(abs) === norm(this.root)) fail('EETF_PATH_ESCAPE', 'path resolves outside the EETF root');
    let cur = this.root;
    for (const seg of segments) {
      cur = path.join(cur, seg);
      let st;
      try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
      if (st.isSymbolicLink()) fail('EETF_SYMLINK_REFUSED', 'a symbolic link or junction is on the path');
    }
    return abs;
  }

  #ensureDir(rel) {
    const abs = this.resolveInside(rel);
    fs.mkdirSync(abs, { recursive: true });
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isDirectory()) fail('EETF_SYMLINK_REFUSED', `${rel} is not a real directory`);
    return abs;
  }

  static storagePathFor(sha256, format) {
    assertSha256(sha256);
    const ext = FORMAT_EXT[format];
    if (!ext) fail('EETF_INVALID_FORMAT', 'unknown format');
    return `assets/${sha256.slice(0, 2)}/${sha256}.${ext}`;
  }

  /** Absolute path of a stored asset after re-validating its internal storage path. */
  resolveAssetPath(storagePath) {
    const m = STORAGE_PATH_RE.exec(String(storagePath ?? ''));
    if (!m || m[1] !== m[2].slice(0, 2)) fail('EETF_UNSAFE_PATH', 'not an EETF storage path');
    return this.resolveInside(storagePath);
  }

  /**
   * Stores bytes immutably. Same bytes → same file, returned as `existed: true`
   * (never rewritten). Throws before writing when the bytes are not an accepted
   * image, the declared MIME lies, or the image exceeds the size / pixel budget.
   */
  ingest(buffer, { declaredMime, contentDynamicRange = undefined } = {}) {
    if (!Buffer.isBuffer(buffer)) fail('EETF_INVALID_INPUT', 'buffer expected');
    if (buffer.length === 0) fail('EETF_EMPTY_FILE', 'empty file');
    if (buffer.length > limit('maxFileSize')) fail('EETF_FILE_TOO_LARGE', `file exceeds ${limit('maxFileSize')} bytes`);
    const declaredFormat = formatFromMime(declaredMime);
    const info = sniffImage(buffer);
    if (info.format !== declaredFormat) fail('EETF_MIME_MISMATCH', `declared ${declaredFormat} but the content is ${info.format}`, { declaredFormat, actualFormat: info.format });
    assertImageBudget(info);
    assertStructurallyIntact(buffer, info); // [EETF-CERT] truncated / damaged files never get an identity
    const dynamicRange = resolveDynamicRange(info.format, contentDynamicRange);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const storagePath = EetfAssetStore.storagePathFor(sha256, info.format);
    this.#ensureDir(`assets/${sha256.slice(0, 2)}`);
    const target = this.resolveInside(storagePath);

    let existed = false;
    if (fs.existsSync(target)) {
      this.#verifyFile(target, sha256, buffer.length);
      existed = true;
    } else {
      const tmp = this.resolveInside(`tmp/${crypto.randomUUID()}.part`);
      const fd = fs.openSync(tmp, 'wx');
      try { fs.writeSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try {
        // No-clobber publish: link() fails with EEXIST instead of replacing a file (rename() would replace on Windows).
        try { fs.linkSync(tmp, target); } catch (e) {
          if (e.code === 'EEXIST') { this.#verifyFile(target, sha256, buffer.length); existed = true; }
          else if (e.code === 'EPERM' || e.code === 'EXDEV' || e.code === 'ENOTSUP') fs.copyFileSync(tmp, target, fs.constants.COPYFILE_EXCL);
          else throw e;
        }
      } finally { fs.rmSync(tmp, { force: true }); }
      if (!existed) fs.chmodSync(target, 0o444);
    }
    return Object.freeze({
      sha256, storagePath, existed, sizeBytes: buffer.length,
      actualFormat: info.format, declaredFormat, mime: FORMAT_MIME[info.format],
      width: info.width, height: info.height, hasAlpha: info.hasAlpha, dynamicRange,
    });
  }

  #verifyFile(abs, sha256, size) {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) fail('EETF_SYMLINK_REFUSED', 'stored asset is not a regular file');
    if (st.size !== size || hashFile(abs) !== sha256) fail('EETF_STORE_CORRUPTED', 'a stored file does not match its hash; it is never overwritten');
  }

  /** EETF-7: bytes of a stored asset (storage path re-validated, no link followed). */
  readAsset(storagePath) {
    const abs = this.resolveAssetPath(storagePath);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) fail('EETF_SYMLINK_REFUSED', 'stored asset is not a regular file');
    if (st.size > limit('maxFileSize')) fail('EETF_FILE_TOO_LARGE', 'stored asset larger than the file budget');
    return fs.readFileSync(abs);
  }

  /** Re-hashes a stored asset: true when the file still matches its sha256. */
  verifyAsset(storagePath, sha256) {
    assertSha256(sha256);
    const abs = this.resolveAssetPath(storagePath);
    if (!fs.existsSync(abs)) return false;
    const st = fs.lstatSync(abs);
    return !st.isSymbolicLink() && st.isFile() && hashFile(abs) === sha256;
  }

  /** [EETF-CERT] Writes an ingress file to tmp/ for a bounded decode check (never under assets/). Returns its absolute path. */
  writeCheckFile(buffer, format) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > limit('maxFileSize')) fail('EETF_FILE_TOO_LARGE', 'file too large');
    const ext = FORMAT_EXT[format];
    if (!ext) fail('EETF_INVALID_FORMAT', 'unknown format');
    this.#ensureDir('tmp');
    const abs = this.resolveInside(`tmp/${crypto.randomUUID()}.check.${ext}`);
    const fd = fs.openSync(abs, 'wx');
    try { fs.writeSync(fd, buffer); } finally { fs.closeSync(fd); }
    return abs;
  }

  /** [EETF-CERT] Removes a check file written by writeCheckFile (name re-validated, tmp/ only). */
  removeCheckFile(abs) {
    if (!TMP_CHECK_RE.test(path.basename(String(abs))) || !isInsideDir(norm(path.resolve(abs)), norm(path.join(this.root, 'tmp')))) fail('EETF_UNSAFE_PATH', 'not a check file');
    fs.rmSync(abs, { force: true });
  }

  /** Removes in-flight files left by an interrupted process. Never follows links. */
  purgeTmp() {
    const dir = this.#ensureDir('tmp');
    let purged = 0;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      // `.part` = ingest in flight; `<jobId>.out.<ext>` = an FFmpeg output (EETF-3) not yet validated
      // `<uuid>.check.<ext>` = an ingress file being decode-checked (EETF-CERT)
      if (st.isFile() && (name.endsWith('.part') || TMP_OUTPUT_RE.test(name) || TMP_CHECK_RE.test(name))) { fs.rmSync(abs, { force: true }); purged++; }
    }
    return purged;
  }
}

export function hashFile(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// ── Header-only image sniffing (no decoding) ────────────────────────────────

export function assertImageBudget({ width, height }) {
  if (!(width >= 1 && height >= 1)) fail('EETF_MALFORMED_IMAGE', 'image has no valid dimensions');
  if (width > limit('maxImportSide') || height > limit('maxImportSide')) fail('EETF_IMAGE_TOO_LARGE', `a side exceeds ${limit('maxImportSide')} px`);
  if (width * height > limit('maxPixels')) fail('EETF_IMAGE_TOO_LARGE', `image exceeds ${limit('maxPixels')} pixels`);
}

const bad = (what) => fail('EETF_MALFORMED_IMAGE', `malformed ${what} header`);

/** Returns { format, width, height, hasAlpha } from the header bytes, or throws. */
export function sniffImage(b) {
  if (b.length >= 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' && b.readUInt32BE(4) === 0x0d0a1a0a) return sniffPng(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return sniffJpeg(b);
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return sniffWebp(b);
  if (b.length >= 8 && (b.toString('latin1', 0, 4) === 'II*\u0000' || b.toString('latin1', 0, 4) === 'MM\u0000*')) return sniffTiff(b);
  if (b.length >= 8 && b.readUInt32LE(0) === 20000630) return sniffExr(b);
  if (b.length >= 10 && (b.toString('latin1', 0, 10) === '#?RADIANCE' || b.toString('latin1', 0, 6) === '#?RGBE')) return sniffHdr(b);
  if (b.length >= 5 && /^\s*<(\?xml|svg)/i.test(b.toString('latin1', 0, Math.min(b.length, 256)))) fail('EETF_UNSUPPORTED_FORMAT', 'SVG / XML is never accepted');
  fail('EETF_UNSUPPORTED_FORMAT', 'not a PNG, JPEG, WebP, TIFF, EXR or Radiance HDR file');
}

function sniffPng(b) {
  if (b.toString('latin1', 12, 16) !== 'IHDR') bad('PNG');
  const colorType = b[25];
  return { format: 'PNG', width: b.readUInt32BE(16), height: b.readUInt32BE(20), hasAlpha: colorType === 4 || colorType === 6 };
}

function sniffJpeg(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) bad('JPEG');
    while (i < b.length && b[i] === 0xff) i++;
    const marker = b[i++];
    if (marker === undefined) break;
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS before any frame header
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (i + 2 > b.length) break;
    const len = b.readUInt16BE(i);
    if (len < 2) bad('JPEG');
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 7 > b.length) bad('JPEG');
      return { format: 'JPEG', height: b.readUInt16BE(i + 3), width: b.readUInt16BE(i + 5), hasAlpha: false };
    }
    i += len;
  }
  bad('JPEG');
}

function sniffWebp(b) {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) bad('WebP');
    return { format: 'WEBP', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, hasAlpha: false };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) bad('WebP');
    const bits = b.readUInt32LE(21);
    return { format: 'WEBP', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, hasAlpha: ((bits >>> 28) & 1) === 1 };
  }
  if (chunk === 'VP8X') {
    return { format: 'WEBP', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1, hasAlpha: (b[20] & 0x10) !== 0 };
  }
  bad('WebP');
}

function sniffTiff(b) {
  const le = b[0] === 0x49;
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(2) !== 42) bad('TIFF'); // BigTIFF (43) is not accepted
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > b.length) bad('TIFF');
  const count = u16(ifd);
  if (count > 4096 || ifd + 2 + count * 12 > b.length) bad('TIFF');
  let width = 0; let height = 0; let extraSamples = false;
  for (let e = 0; e < count; e++) {
    const o = ifd + 2 + e * 12;
    const tag = u16(o); const type = u16(o + 2);
    const value = type === 3 ? u16(o + 8) : u32(o + 8);
    if (tag === 256) width = value;
    else if (tag === 257) height = value;
    else if (tag === 338) extraSamples = true;
  }
  if (!width || !height) bad('TIFF');
  return { format: 'TIFF', width, height, hasAlpha: extraSamples };
}

function sniffExr(b) {
  const version = b.readUInt32LE(4);
  if ((version & 0xff) !== 2) bad('EXR');
  if (version & 0x1000) fail('EETF_UNSUPPORTED_FORMAT', 'multi-part EXR is not accepted in V1');
  let i = 8; let attrs = 0;
  let width = 0; let height = 0; let hasAlpha = false;
  const cstr = () => {
    const end = b.indexOf(0, i);
    if (end < 0 || end - i > 255) bad('EXR');
    const s = b.toString('latin1', i, end); i = end + 1; return s;
  };
  while (i < b.length) {
    if (b[i] === 0) return width && height ? { format: 'EXR', width, height, hasAlpha } : bad('EXR');
    if (++attrs > 256) bad('EXR');
    const name = cstr(); const type = cstr();
    if (i + 4 > b.length) bad('EXR');
    const size = b.readInt32LE(i); i += 4;
    if (size < 0 || i + size > b.length) bad('EXR');
    if (name === 'dataWindow' && type === 'box2i' && size === 16) {
      const xMin = b.readInt32LE(i); const yMin = b.readInt32LE(i + 4); const xMax = b.readInt32LE(i + 8); const yMax = b.readInt32LE(i + 12);
      width = xMax - xMin + 1; height = yMax - yMin + 1;
    }
    if (name === 'channels' && type === 'chlist') hasAlpha = b.subarray(i, i + size).includes(Buffer.from('A\u0000', 'latin1'));
    i += size;
  }
  bad('EXR');
}

function sniffHdr(b) {
  const head = b.toString('latin1', 0, Math.min(b.length, 4096));
  const blank = head.indexOf('\n\n');
  if (blank < 0) bad('Radiance HDR');
  const lineEnd = head.indexOf('\n', blank + 2);
  const line = head.slice(blank + 2, lineEnd < 0 ? undefined : lineEnd).trim();
  const m = /^([+-])([XY]) (\d{1,6}) ([+-])([XY]) (\d{1,6})$/.exec(line);
  if (!m || m[2] === m[5]) bad('Radiance HDR');
  const first = Number(m[3]); const second = Number(m[6]);
  return m[2] === 'Y'
    ? { format: 'HDR', height: first, width: second, hasAlpha: false }
    : { format: 'HDR', width: first, height: second, hasAlpha: false };
}

export { isSha256 };
