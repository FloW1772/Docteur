// Knowledge Graph V1 — KG-3 normalisation (comparison keys only).
//
// Every function here derives a COMPARISON form. The original value is never
// rewritten: callers store the original label / alias / identifier next to the
// keys computed here. Nothing in this module calls a model or the network.
//
// Keys:
//   labelKey(s)  strict: NFKC, invisible characters removed, apostrophes and
//                dashes unified, whitespace collapsed, full case folding.
//                Accents are KEPT ("Éric" ≠ "Eric").
//   looseKey(s)  labelKey + Latin/Greek/Cyrillic combining diacritics removed
//                ("Éric" = "Eric"). Marks of other scripts (Devanagari vowel
//                signs, Japanese dakuten…) are part of the letter and kept.
//   tokenKey(s)  looseKey tokens sorted ("Martin, Jean" ~ "Jean Martin") —
//                a candidate signal only, never a merge signal on its own.
//
// Identifiers are normalised per scheme; a value that does not validate for
// its scheme is rejected (null), never guessed or invented.

import crypto from 'node:crypto';
import { canonicalizeUrl } from './canonical-article.js';

// Zero-width space/joiners, word joiner, BOM, soft hyphen, variation selectors 15/16.
const INVISIBLE_RE = /[​-‍⁠﻿­︎️]/g;
// Typographic apostrophes / primes / grave & acute used as apostrophes.
const APOSTROPHE_RE = /[‘’‛′ʼʻ`´]/g;
// Hyphen, non-breaking hyphen, figure dash, en/em dash, horizontal bar, minus sign, small/fullwidth hyphen-minus.
const DASH_RE = /[‐‑‒–—―−﹣－]/g;
// Combining diacritical marks block only (Latin, Greek, Cyrillic accents).
const LATIN_DIACRITICS_RE = /[̀-ͯ]/g;

function baseForm(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .replace(APOSTROPHE_RE, "'")
    .replace(DASH_RE, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}

// Full case folding approximation: upper then lower maps "ß" → "ss" and the
// long s "ſ" → "s", which a plain toLowerCase() does not.
function caseFold(value) {
  return value.toUpperCase().toLowerCase();
}

/** Strict comparison key (accents kept). */
export function labelKey(value) {
  return caseFold(baseForm(value)).normalize('NFC');
}

/** Accent-insensitive comparison key. */
export function looseKey(value) {
  return labelKey(value).normalize('NFD').replace(LATIN_DIACRITICS_RE, '').normalize('NFC');
}

/** Order-insensitive token key (candidate generation only). */
export function tokenKey(value) {
  return looseKey(value)
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** All comparison keys of a label; `original` is returned untouched. */
export function labelKeys(value) {
  return { original: value === null || value === undefined ? '' : String(value), label: labelKey(value), loose: looseKey(value), tokens: tokenKey(value) };
}

/** Damerau-free Levenshtein distance with an early exit above `max`. */
export function editDistanceAtMost(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ── Identifiers ──────────────────────────────────────────────────────────────

function isbn10To13(digits) {
  const core = `978${digits.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return core + String((10 - (sum % 10)) % 10);
}

function validIsbn10(d) {
  if (!/^\d{9}[\dX]$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (d[i] === 'X' ? 10 : Number(d[i])) * (10 - i);
  return sum % 11 === 0;
}

function validIsbn13(d) {
  if (!/^\d{13}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

function validOrcid(id) {
  const digits = id.replace(/-/g, '');
  if (!/^\d{15}[\dX]$/.test(digits)) return false;
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + Number(digits[i])) * 2;
  const check = (12 - (total % 11)) % 11;
  return digits[15] === (check === 10 ? 'X' : String(check));
}

function hostFrom(value) {
  const raw = baseForm(value);
  if (!raw) return null;
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  // a registrable-looking host: at least one dot, no IP literal, no credentials
  if (!host.includes('.') || /^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) return null;
  return host;
}

/**
 * Identifier schemes known to KG V1, with the entity types for which an exact
 * match is a STRONG resolution signal. `null` = any type.
 */
export const IDENTIFIER_SCHEMES = Object.freeze({
  wikidata: { strongFor: null },
  doi: { strongFor: ['DOCUMENT'] },
  isbn: { strongFor: ['DOCUMENT'] },
  orcid: { strongFor: ['PERSON'] },
  domain: { strongFor: ['ORGANIZATION', 'PROJECT', 'PRODUCT', 'SOFTWARE', 'TOOL', 'FRAMEWORK', 'STANDARD'] },
  url: { strongFor: ['DOCUMENT', 'PROJECT', 'PRODUCT', 'SOFTWARE'] },
  email_sha256: { strongFor: ['PERSON', 'ORGANIZATION'] },
  product_id: { strongFor: ['PRODUCT', 'SOFTWARE', 'TOOL', 'DEVICE'] },
  registry_id: { strongFor: ['ORGANIZATION'] },
  external: { strongFor: null },
});

/**
 * Normalises an identifier for its scheme. Returns
 * `{ scheme, value, original }` or null when the value is not valid for the
 * scheme (it is then NOT stored as an identifier — nothing is guessed).
 */
export function normalizeIdentifier(scheme, rawValue) {
  const s = String(scheme ?? '').trim().toLowerCase();
  if (!(s in IDENTIFIER_SCHEMES)) return null;
  const original = rawValue === null || rawValue === undefined ? '' : String(rawValue);
  const v = baseForm(original);
  if (!v || v.length > 512) return null;
  let value = null;
  switch (s) {
    case 'wikidata': {
      const m = v.match(/^(?:https?:\/\/(?:www\.)?wikidata\.org\/(?:wiki|entity)\/)?(Q[1-9]\d*)$/i);
      value = m ? m[1].toUpperCase() : null;
      break;
    }
    case 'doi': {
      const d = v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
      value = /^10\.\d{4,9}\/\S+$/.test(d) ? d : null;
      break;
    }
    case 'isbn': {
      const d = v.toUpperCase().replace(/^ISBN(?:-1[03])?:?\s*/, '').replace(/[\s-]/g, '');
      if (validIsbn13(d)) value = d;
      else if (validIsbn10(d)) value = isbn10To13(d);
      break;
    }
    case 'orcid': {
      const d = v.replace(/^https?:\/\/orcid\.org\//i, '').toUpperCase();
      value = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(d) && validOrcid(d) ? d : null;
      break;
    }
    case 'domain':
      value = hostFrom(v);
      break;
    case 'url':
      value = canonicalizeUrl(v);
      break;
    case 'email_sha256': {
      // Only a hash is ever stored: a raw e-mail is hashed here and the raw
      // address is not kept as the "original" value either.
      if (/^[a-f0-9]{64}$/i.test(v)) value = v.toLowerCase();
      else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) value = crypto.createHash('sha256').update(v.toLowerCase()).digest('hex');
      return value ? { scheme: s, value, original: value } : null;
    }
    case 'product_id':
    case 'registry_id':
      value = /^[\p{L}\p{N}][\p{L}\p{N}._:/-]{0,127}$/u.test(v) ? v.toUpperCase() : null;
      break;
    case 'external': {
      // provider-qualified opaque id: "<provider>:<id>"; the provider prefix is mandatory
      const m = v.match(/^([a-z][a-z0-9_-]{1,31}):(\S{1,256})$/i);
      value = m ? `${m[1].toLowerCase()}:${m[2]}` : null;
      break;
    }
    default:
      value = null;
  }
  return value ? { scheme: s, value, original } : null;
}

/** Whether an exact identifier match is a strong signal for this entity type. */
export function identifierIsStrongFor(scheme, entityType) {
  const def = IDENTIFIER_SCHEMES[scheme];
  if (!def) return false;
  return def.strongFor === null || def.strongFor.includes(entityType);
}

// ── Entity types ─────────────────────────────────────────────────────────────

// Types that denote the same kind of thing (KG-2 used LOCATION, the KG-1
// contract names PLACE). Everything else is compatible only with itself.
const TYPE_CLASSES = [['LOCATION', 'PLACE']];

export function entityTypesCompatible(a, b) {
  if (a === b) return true;
  return TYPE_CLASSES.some(cls => cls.includes(a) && cls.includes(b));
}

export function compatibleTypes(type) {
  const cls = TYPE_CLASSES.find(c => c.includes(type));
  return cls ? [...cls] : [type];
}

// ── Hashes ───────────────────────────────────────────────────────────────────

/** Hash of an evidence excerpt: same text modulo case/accents/spacing → same hash. */
export function excerptHash(text) {
  const key = looseKey(text);
  return key ? crypto.createHash('sha256').update(key).digest('hex') : null;
}

export function stableHash(...parts) {
  return crypto.createHash('sha256').update(parts.map(p => String(p ?? '')).join('\u001F')).digest('hex');
}
