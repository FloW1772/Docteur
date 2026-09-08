import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafeUrl } from './url-security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');

export const IMAGE_DIR = path.join(ROOT, 'data', 'images');

export const ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const MAX_SIZE     = 5 * 1024 * 1024; // 5 MB

// Strict id: uuid + allowed extension, no path components
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$/i;

export function ensureImageDir() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

export function validateImageId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function getImagePath(id) {
  if (!validateImageId(id)) throw new Error('Invalid image id');
  return path.join(IMAGE_DIR, id);
}

export function deleteImageFile(id, logger) {
  try {
    const p = getImagePath(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (err) {
    logger?.warn?.({ id, error: err.message }, 'IMAGE_DELETE_FAILED');
  }
}

function extForMime(mime) {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png')  return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif')  return '.gif';
  return null;
}

// Save a Buffer to disk, returns image id (filename)
export function saveImageBuffer(buf, mimeType) {
  const ext = extForMime(mimeType);
  if (!ext) throw new Error(`Type MIME non supporté: ${mimeType}`);
  if (buf.length > MAX_SIZE) throw new Error('Image trop grande (max 5 Mo)');
  ensureImageDir();
  const id   = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(IMAGE_DIR, id), buf);
  return id;
}

// Download an image from a URL, returns image id
export async function downloadImageFromUrl(rawUrl, { signal } = {}) {
  assertSafeUrl(rawUrl);
  const res = await fetch(rawUrl, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Fetch image HTTP ${res.status}`);

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIME.includes(contentType)) {
    throw new Error(`Type MIME non supporté: ${contentType}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return saveImageBuffer(buf, contentType);
}
