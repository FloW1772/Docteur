// Knowledge Graph V1 — KG-4 claim model (pure: no DB, no network, no model).
//
// A claim is   subject —predicate→ object   where the object is EITHER an
// entity (objectEntityId) OR a typed value — never both, never neither.
//
// Predicate registry: the cardinality decides what a contradiction is.
//   single  at most one object at a time (ceo, price, status, published_on…):
//           two live claims with different objects whose validity intervals
//           overlap are a SINGLE_VALUE_CONFLICT (both kept, both DISPUTED).
//   multi   several objects are legitimate (author, employer, founder…):
//           different objects never conflict.
// A predicate absent from the registry is accepted (strict syntax) but treated
// as multi-valued: no contradiction is ever inferred from an unknown predicate.
//
// Time: validity intervals are half-open [validFrom, validTo) — validTo is
// exclusive, so "Alice until 2015-07-01" and "Bob from 2015-07-01" do not
// overlap. A missing bound is unbounded. Partial dates are expanded to the first
// day of the period ("2015" → "2015-01-01", "2015-07" → "2015-07-01").

import { looseKey, stableHash } from './kg-normalize.js';
import { canonicalizeUrl } from './canonical-article.js';

export const PREDICATE_RE = /^[a-z][a-z0-9_]{1,63}$/;
export const MAX_VALUE_STRING = 1000;
export const MAX_UNIT_LENGTH = 16;
export const VALUE_TYPES = ['string', 'number', 'boolean', 'date', 'url'];

const ORGS = ['ORGANIZATION'];
const PEOPLE = ['PERSON'];
const PLACES = ['LOCATION', 'PLACE', 'COUNTRY'];
const ARTEFACTS = ['PRODUCT', 'SOFTWARE', 'TOOL', 'DEVICE', 'TECHNOLOGY', 'FRAMEWORK'];

/**
 * Known predicates. `object`: 'entity' | 'value'; `valueType` for values;
 * `subjectTypes` / `objectTypes`: allowed entity types (absent = any).
 */
export const KG_PREDICATES = Object.freeze({
  ceo: { cardinality: 'single', object: 'entity', subjectTypes: ORGS, objectTypes: PEOPLE, description: 'chief executive' },
  headquarters: { cardinality: 'single', object: 'entity', subjectTypes: ORGS, objectTypes: PLACES, description: 'registered head office' },
  parent_organization: { cardinality: 'single', object: 'entity', subjectTypes: ORGS, objectTypes: ORGS, description: 'controlling organisation' },
  located_in: { cardinality: 'single', object: 'entity', objectTypes: PLACES, description: 'location' },
  publisher: { cardinality: 'single', object: 'entity', subjectTypes: ['DOCUMENT'], objectTypes: ORGS, description: 'publisher of a document' },
  published_on: { cardinality: 'single', object: 'value', valueType: 'date', subjectTypes: ['DOCUMENT'], description: 'publication date' },
  date_of_birth: { cardinality: 'single', object: 'value', valueType: 'date', subjectTypes: PEOPLE, description: 'date of birth' },
  founded_on: { cardinality: 'single', object: 'value', valueType: 'date', subjectTypes: [...ORGS, 'PROJECT'], description: 'foundation date' },
  price: { cardinality: 'single', object: 'value', valueType: 'number', subjectTypes: ARTEFACTS, description: 'price (unit = currency)' },
  status: { cardinality: 'single', object: 'value', valueType: 'string', subjectTypes: ['PROJECT', ...ARTEFACTS], description: 'lifecycle status' },
  population: { cardinality: 'single', object: 'value', valueType: 'number', subjectTypes: PLACES, description: 'population' },
  author: { cardinality: 'multi', object: 'entity', subjectTypes: ['DOCUMENT'], objectTypes: PEOPLE, description: 'author of a document' },
  founder: { cardinality: 'multi', object: 'entity', objectTypes: PEOPLE, description: 'founder' },
  employer: { cardinality: 'multi', object: 'entity', subjectTypes: PEOPLE, objectTypes: ORGS, description: 'employer (several at once is legitimate)' },
  member_of: { cardinality: 'multi', object: 'entity', description: 'membership' },
  website: { cardinality: 'multi', object: 'value', valueType: 'url', description: 'official website' },
  version: { cardinality: 'multi', object: 'value', valueType: 'string', subjectTypes: ARTEFACTS, description: 'released version' },
  related_to: { cardinality: 'multi', object: 'entity', description: 'generic relation' },
});

export class KgClaimError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'KgClaimError';
    this.code = code;
  }
}

/** Validated predicate + its definition (unknown predicates: multi-valued, any object). */
export function predicateDefinition(predicate) {
  const p = typeof predicate === 'string' ? predicate.trim() : '';
  if (!PREDICATE_RE.test(p)) throw new KgClaimError('KG_PREDICATE_INVALID', 'predicate must match ^[a-z][a-z0-9_]{1,63}$');
  const def = KG_PREDICATES[p];
  return { predicate: p, known: Boolean(def), cardinality: def?.cardinality ?? 'multi', object: def?.object ?? 'any', valueType: def?.valueType ?? null, subjectTypes: def?.subjectTypes ?? null, objectTypes: def?.objectTypes ?? null };
}

// ── dates ────────────────────────────────────────────────────────────────────

/** Normalises a date to "YYYY-MM-DD" or a full ISO UTC timestamp; null when invalid. */
export function normalizeKgDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})$/);
  if (m) return `${m[1]}-01-01`;
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}-01`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function requireDate(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const d = normalizeKgDate(value);
  if (!d) throw new KgClaimError('KG_DATE_INVALID', `${field} is not a valid date`);
  return d;
}

/** Validity interval; validTo exclusive. */
export function normalizeInterval({ validFrom, validTo } = {}) {
  const from = requireDate(validFrom, 'validFrom');
  const to = requireDate(validTo, 'validTo');
  if (from && to && !(from < to)) throw new KgClaimError('KG_INTERVAL_INVALID', 'validFrom must be before validTo (validTo is exclusive)');
  return { validFrom: from, validTo: to };
}

/** Half-open overlap; null bounds are unbounded. */
export function intervalsOverlap(a, b) {
  const aFrom = a.validFrom ?? null;
  const aTo = a.validTo ?? null;
  const bFrom = b.validFrom ?? null;
  const bTo = b.validTo ?? null;
  const aStartsBeforeBEnds = bTo === null || aFrom === null || aFrom < bTo;
  const bStartsBeforeAEnds = aTo === null || bFrom === null || bFrom < aTo;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/** PAST | CURRENT | FUTURE relative to `at` (ISO date or timestamp). */
export function temporalState({ validFrom, validTo }, at) {
  const t = normalizeKgDate(at) ?? new Date().toISOString();
  if (validFrom && t < validFrom) return 'FUTURE';
  if (validTo && t >= validTo) return 'PAST';
  return 'CURRENT';
}

// ── values ───────────────────────────────────────────────────────────────────

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Typed value → { type, value, unit?, key } (key = comparison form). Values are
 * data: an HTML/script string is stored verbatim as text and never interpreted;
 * a `url` must be http(s) (javascript:, data:… are refused).
 */
export function normalizeClaimValue(input, expectedType = null) {
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    throw new KgClaimError('KG_VALUE_INVALID', 'value must be { type, value[, unit] }');
  }
  const type = input.type;
  if (!VALUE_TYPES.includes(type)) throw new KgClaimError('KG_VALUE_INVALID', `value type must be one of ${VALUE_TYPES.join(', ')}`);
  if (expectedType && type !== expectedType) throw new KgClaimError('KG_VALUE_TYPE_MISMATCH', `this predicate expects a ${expectedType} value`);
  let unit = null;
  if (input.unit !== undefined && input.unit !== null) {
    unit = String(input.unit).trim();
    if (!/^[\p{L}\p{N}%$€£¥._/-]{1,16}$/u.test(unit)) throw new KgClaimError('KG_VALUE_INVALID', 'invalid unit');
    if (type !== 'number') throw new KgClaimError('KG_VALUE_INVALID', 'only numbers carry a unit');
  }
  const raw = input.value;
  switch (type) {
    case 'string': {
      if (typeof raw !== 'string') throw new KgClaimError('KG_VALUE_INVALID', 'string value expected');
      const v = raw.normalize('NFC').trim();
      if (!v) throw new KgClaimError('KG_VALUE_INVALID', 'empty string value');
      if (v.length > MAX_VALUE_STRING) throw new KgClaimError('KG_VALUE_TOO_LARGE', `string values are limited to ${MAX_VALUE_STRING} characters`);
      if (CONTROL_RE.test(v)) throw new KgClaimError('KG_VALUE_INVALID', 'control characters are not allowed');
      return { type, value: v, key: `s:${looseKey(v)}` };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN);
      if (!Number.isFinite(n)) throw new KgClaimError('KG_VALUE_INVALID', 'finite number expected');
      return { type, value: n, ...(unit ? { unit } : {}), key: `n:${n}:${unit ? unit.toUpperCase() : ''}` };
    }
    case 'boolean':
      if (typeof raw !== 'boolean') throw new KgClaimError('KG_VALUE_INVALID', 'boolean expected');
      return { type, value: raw, key: `b:${raw}` };
    case 'date': {
      const d = normalizeKgDate(raw);
      if (!d) throw new KgClaimError('KG_VALUE_INVALID', 'invalid date value');
      return { type, value: d, key: `d:${d}` };
    }
    case 'url': {
      const u = typeof raw === 'string' && raw.length <= 2048 ? canonicalizeUrl(raw) : null;
      if (!u) throw new KgClaimError('KG_VALUE_INVALID', 'url values must be http(s) URLs');
      return { type, value: u, key: `u:${u}` };
    }
    default:
      throw new KgClaimError('KG_VALUE_INVALID', 'unsupported value type');
  }
}

/** Stored JSON form of a value (without the comparison key). */
export function storedValue(v) {
  return JSON.stringify(v.unit ? { type: v.type, value: v.value, unit: v.unit } : { type: v.type, value: v.value });
}

/** Comparison key of a stored value_json (null when it is not a typed value). */
export function valueKeyOf(valueJson) {
  if (!valueJson) return null;
  try {
    return normalizeClaimValue(JSON.parse(valueJson)).key;
  } catch {
    return null;
  }
}

/**
 * Logical identity of a claim — independent of the source that asserts it:
 * the same claim from two sources is one claim with two evidences.
 */
export function claimKey({ subjectEntityId, predicate, objectEntityId = null, valueKey = null, validFrom = null, validTo = null }) {
  const object = objectEntityId ? `e:${objectEntityId}` : `v:${valueKey}`;
  return `ck_${stableHash('claim', subjectEntityId, predicate, object, validFrom ?? '', validTo ?? '').substring(0, 32)}`;
}

/** Extraction methods by strength: a stronger assertion upgrades a claim, a weaker one never downgrades it. */
export const EXTRACTION_RANK = { MODEL_PROPOSAL: 1, DETERMINISTIC: 2, USER: 3 };

export function strongerMethod(a, b) {
  return (EXTRACTION_RANK[b] ?? 0) > (EXTRACTION_RANK[a] ?? 0) ? b : a;
}
