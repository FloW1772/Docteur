// Companion V1 — COMP-2 contracts (pure: no DB, no fs, no network, no process, no model).
//
// DOCTEUR OWNS THE MEMORY. Durable user memory has ONE owner: Docteur Memory (NB-5, dmem_*). The Companion keeps only
// what NB-5 does not have: session context (process memory), memory proposals (a review queue), per-memory Companion
// metadata (privacy scope, category, provenance, presentation), preferences and its own audit. It never stores a second
// copy of a durable memory and never writes NB-5 tables: durable writes go through the public NB-5 service.
//
// Categories:
//   USER_PREFERENCE   durable (NB-5) only after a user action
//   USER_FACT         durable (NB-5) only after a user confirmation
//   DERIVED_CONTEXT   session or proposal only — an inference never becomes a fact by itself
//   TASK_CONTEXT      bound to a task (session store, taskId required), never personal memory
//   SOURCE_REFERENCE  a reference (kind + id + short label), never a copy of the source content
//   SESSION_CONTEXT   the conversation turns of a session (process memory only)
// Provenance (origin): USER_EXPLICIT, USER_CONFIRMED may reach NB-5; DERIVED must become a proposal; IMPORTED is a
// proposal with needsReview = true. The legacy adaptive memory (preference_facts / episodic_memories) is never a source.

import crypto from 'node:crypto';

export class CompanionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CompanionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export const fail = (code, message, details) => { throw new CompanionError(code, message, details); };

const enumOf = (...values) => Object.freeze(Object.fromEntries(values.map(v => [v, v])));
export const freezeDeep = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) freezeDeep(v); return Object.freeze(o); };

export const CATEGORY = enumOf('USER_PREFERENCE', 'USER_FACT', 'DERIVED_CONTEXT', 'TASK_CONTEXT', 'SOURCE_REFERENCE', 'SESSION_CONTEXT');
/** The only categories that may ever become durable (NB-5) memory. */
export const DURABLE_CATEGORIES = Object.freeze(['USER_PREFERENCE', 'USER_FACT']);
/** The categories the session store holds. */
export const SESSION_CATEGORIES = Object.freeze(['SESSION_CONTEXT', 'DERIVED_CONTEXT', 'TASK_CONTEXT', 'SOURCE_REFERENCE']);
export const ORIGIN = enumOf('USER_EXPLICIT', 'USER_CONFIRMED', 'DERIVED', 'IMPORTED');
export const DIRECTLY_PERSISTABLE_ORIGINS = Object.freeze(['USER_EXPLICIT', 'USER_CONFIRMED']);
/** Where a statement came from. LEGACY_ADAPTIVE exists only to be refused explicitly. */
export const SOURCE_TYPE = enumOf('USER_INPUT', 'SESSION', 'MODEL', 'RULE', 'NOTEBOOK_SOURCE', 'DOCTEUR_MEMORY', 'EXTERNAL_DOCUMENT', 'WEB', 'IMPORT_FILE', 'LEGACY_ADAPTIVE');
/** Sources that can never author a durable memory directly (only a proposal). */
export const EXTERNAL_SOURCE_TYPES = Object.freeze(['MODEL', 'RULE', 'NOTEBOOK_SOURCE', 'EXTERNAL_DOCUMENT', 'WEB', 'IMPORT_FILE', 'SESSION']);
export const PRIVACY_SCOPE = enumOf('PRIVATE_LOCAL', 'LOCAL_SHARED_CONTEXT', 'CLOUD_ALLOWED', 'NEVER_CLOUD');
export const DEFAULT_PRIVACY_SCOPE = 'PRIVATE_LOCAL';
export const PROPOSAL_STATUS = enumOf('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'INVALIDATED');
/** Companion view of a durable memory; NB-5 stays the source of truth (derived on read, never stored here). */
export const MEMORY_STATE = enumOf('ACTIVE', 'DISPUTED', 'SUPERSEDED', 'INVALIDATED', 'ARCHIVED', 'MISSING');
export const EVIDENCE_KIND = enumOf('NOTEBOOK_CHUNK', 'NOTEBOOK_SOURCE', 'NB5_MEMORY', 'CONVERSATION', 'SESSION_ITEM', 'IMPORT_RECORD');
export const PRODUCER = enumOf('MODEL', 'RULE');
export const AUDIT_ACTION = enumOf(
  'MEMORY_ADDED', 'MEMORY_PROPOSED', 'MEMORY_ACCEPTED', 'MEMORY_REJECTED', 'MEMORY_PROPOSAL_SUPERSEDED', 'MEMORY_PROPOSAL_INVALIDATED',
  'MEMORY_REFUSED_SECRET', 'MEMORY_REFUSED_SOURCE', 'MEMORY_METADATA_CHANGED', 'MEMORY_CONTEXT_USED', 'MEMORY_DISABLED', 'MEMORY_ENABLED',
  'PRIVACY_SCOPE_CHANGED', 'PREFERENCES_CHANGED', 'FORGET_REQUESTED', 'FORGET_COMPLETED', 'FORGET_INCOMPLETE',
);
export const AUDIT_OBJECT = enumOf('MEMORY', 'PROPOSAL', 'PREFERENCES', 'SESSION');

/** Category → NB-5 memory types the Companion may write (NB-5 validates again). */
export const NB5_TYPES_FOR = freezeDeep({
  USER_PREFERENCE: ['PREFERENCE', 'WORKFLOW', 'CONSTRAINT'],
  USER_FACT: ['PERSONAL_NOTE', 'PROJECT_FACT'],
});
export const NB5_APPROVAL_SOURCE = freezeDeep({ USER_EXPLICIT: 'COMPANION_USER_EXPLICIT', USER_CONFIRMED: 'COMPANION_USER_CONFIRMED' });

/** Bounds. All PROVISIONAL (no measured Companion usage yet); each has its basis. */
export const LIMITS = freezeDeep({
  proposalValueChars: { value: 400, status: 'PROVISIONAL', basis: 'NB-5 MAX_STATEMENT_CHARS: a memory is a short statement' },
  evidenceRefs: { value: 10, status: 'PROVISIONAL', basis: 'references, not a bibliography' },
  refChars: { value: 200, status: 'PROVISIONAL', basis: 'an id / locator, never content' },
  labelChars: { value: 200, status: 'PROVISIONAL', basis: 'a SOURCE_REFERENCE label' },
  metadataJsonBytes: { value: 2048, status: 'PROVISIONAL', basis: 'ids and small structured provenance' },
  auditDetailsBytes: { value: 2048, status: 'PROVISIONAL', basis: 'ids, types, counts, hashes — never content' },
  decisionNoteChars: { value: 500, status: 'PROVISIONAL', basis: 'why a proposal was accepted / rejected' },
  pendingProposals: { value: 200, status: 'PROVISIONAL', basis: 'a review queue a person can actually read' },
  sessionItems: { value: 50, status: 'PROVISIONAL', basis: 'last turns + a few derived / task / reference items' },
  sessionBytes: { value: 32 * 1024, status: 'PROVISIONAL', basis: 'about 8k tokens of session context' },
  sessionItemChars: { value: 4000, status: 'PROVISIONAL', basis: 'one conversation turn' },
  sessionIdleMs: { value: 30 * 60_000, status: 'PROVISIONAL', basis: 'a conversation pause' },
  sessionLifetimeMs: { value: 8 * 3600_000, status: 'PROVISIONAL', basis: 'one working day' },
  sessions: { value: 32, status: 'PROVISIONAL', basis: 'single-user install: a few open conversations' },
  reviewAfterDaysMax: { value: 3650, status: 'PROVISIONAL', basis: 'ten years (a reminder only, never a deletion)' },
  jsonDepth: { value: 8, status: 'PROVISIONAL', basis: 'small provenance objects' },
});
export const limit = (name) => LIMITS[name].value;

// ── generic validators ──

export const newId = () => crypto.randomUUID();
export const nowIso = (t = Date.now()) => new Date(t).toISOString();
export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export function assertId(v, what = 'id') { if (!isUuid(v)) fail('COMP_INVALID_ID', `invalid ${what}`); return v; }

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export function cleanText(v, max, what, { required = false, multiline = true } = {}) {
  if (v === undefined || v === null || v === '') { if (required) fail('COMP_REQUIRED_FIELD', `${what} is required`); return null; }
  if (typeof v !== 'string') fail('COMP_INVALID_FIELD', `${what} must be text`);
  const s = v.normalize('NFC');
  if (s.length > max) fail('COMP_TOO_LONG', `${what} exceeds ${max} characters`, { field: what, max });
  if (CONTROL.test(s) || (!multiline && /[\r\n\t]/.test(s))) fail('COMP_INVALID_FIELD', `${what} contains control characters`);
  if (required && !s.trim()) fail('COMP_REQUIRED_FIELD', `${what} is required`);
  return s;
}
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
export function strictKeys(obj, allowed, required, what) {
  if (!isPlain(obj)) fail('COMP_INVALID_FIELD', `${what} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail('COMP_UNKNOWN_FIELD', `unknown ${what} field: ${String(k).slice(0, 40)}`);
  for (const k of required) if (obj[k] === undefined || obj[k] === null) fail('COMP_REQUIRED_FIELD', `${what}.${k} is required`);
  return obj;
}
/** Plain bounded JSON (finite numbers, no prototype keys, bounded depth / size); returns canonical text. */
export function boundedJson(value, maxBytes, what) {
  const walk = (v, depth) => {
    if (depth > limit('jsonDepth')) fail('COMP_INVALID_FIELD', `${what} is too deep`);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('COMP_INVALID_FIELD', `${what} holds a non-finite number`); return v; }
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
    if (isPlain(v)) {
      const o = {};
      for (const k of Object.keys(v).sort()) { if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('COMP_INVALID_FIELD', `${what} has a forbidden key`); o[k] = walk(v[k], depth + 1); }
      return o;
    }
    return fail('COMP_INVALID_FIELD', `${what} holds a non-JSON value`);
  };
  const text = JSON.stringify(walk(value ?? {}, 0));
  if (Buffer.byteLength(text) > maxBytes) fail('COMP_TOO_LONG', `${what} exceeds ${maxBytes} bytes`);
  return text;
}

/**
 * [COMP-REMED-2] Strict JSON text → value: the JSON.parse grammar (RFC 8259: same whitespace, escapes, numbers; no
 * trailing garbage) plus a refusal of duplicate keys in the same object, compared on their DECODED value
 * ("actionId" ≡ "actionId"). JSON.parse keeps the last duplicate silently — an ambiguous model output must be
 * refused, never resolved (last-wins / first-wins / merge). The value returned is the one validated (one parse, no
 * second interpretation). Keys become own data properties exactly as with JSON.parse ("__proto__" included, the
 * prototype is never set), so the callers' existing key checks are unchanged. Bounded: callers bound the size; the
 * recursion is bounded by maxDepth. Errors: CompanionError('STRICT_JSON_INVALID', { reason: NOT_JSON | DUPLICATE_KEY |
 * TOO_DEEP, offset }) — never the input text. A syntax error anywhere wins over a duplicate (a non-JSON text stays
 * NOT_JSON for callers that treat it as plain text).
 */
export const STRICT_JSON_MAX_DEPTH = 64;
export function parseStrictJson(text, { maxDepth = STRICT_JSON_MAX_DEPTH } = {}) {
  if (typeof text !== 'string') fail('STRICT_JSON_INVALID', 'JSON text expected', { reason: 'NOT_JSON', offset: 0 });
  const s = text; const n = s.length; let i = 0; let duplicateAt = -1;
  const bad = (reason, at = i) => fail('STRICT_JSON_INVALID', `invalid JSON: ${reason} at offset ${at}`, { reason, offset: at });
  const ws = () => { while (i < n) { const c = s.charCodeAt(i); if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++; else break; } };
  const isDigit = (c) => c >= 0x30 && c <= 0x39;
  const HEX = /^[0-9a-fA-F]{4}$/;
  const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  const str = () => { // s[i] === '"'
    i++; let out = ''; let from = i;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 0x22) { out += s.slice(from, i); i++; return out; }
      if (c < 0x20) bad('NOT_JSON');
      if (c === 0x5c) {
        out += s.slice(from, i);
        const e = s[i + 1];
        if (e === 'u') { const h = s.slice(i + 2, i + 6); if (!HEX.test(h)) bad('NOT_JSON'); out += String.fromCharCode(parseInt(h, 16)); i += 6; }
        else if (e !== undefined && Object.hasOwn(ESC, e)) { out += ESC[e]; i += 2; }
        else bad('NOT_JSON');
        from = i;
      } else i++;
    }
    return bad('NOT_JSON');
  };
  const num = () => {
    const start = i;
    if (s[i] === '-') i++;
    if (s[i] === '0') i++; else if (isDigit(s.charCodeAt(i))) { while (isDigit(s.charCodeAt(i))) i++; } else bad('NOT_JSON');
    if (s[i] === '.') { i++; if (!isDigit(s.charCodeAt(i))) bad('NOT_JSON'); while (isDigit(s.charCodeAt(i))) i++; }
    if (s[i] === 'e' || s[i] === 'E') { i++; if (s[i] === '+' || s[i] === '-') i++; if (!isDigit(s.charCodeAt(i))) bad('NOT_JSON'); while (isDigit(s.charCodeAt(i))) i++; }
    return Number(s.slice(start, i));
  };
  const word = (w, v) => { if (s.startsWith(w, i)) { i += w.length; return v; } return bad('NOT_JSON'); };
  const value = (depth) => {
    ws();
    const c = s[i];
    if (c === '{' || c === '[') {
      if (depth >= maxDepth) bad('TOO_DEEP');
      i++; ws();
      if (c === '[') {
        const arr = [];
        if (s[i] === ']') { i++; return arr; }
        for (;;) { arr.push(value(depth + 1)); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return arr; } bad('NOT_JSON'); }
      }
      const obj = {}; const seen = new Set();
      if (s[i] === '}') { i++; return obj; }
      for (;;) {
        ws(); if (s[i] !== '"') bad('NOT_JSON');
        const keyAt = i; const key = str();
        ws(); if (s[i] !== ':') bad('NOT_JSON'); i++;
        const v = value(depth + 1);
        if (seen.has(key)) { if (duplicateAt < 0) duplicateAt = keyAt; }
        else { seen.add(key); Object.defineProperty(obj, key, { value: v, writable: true, enumerable: true, configurable: true }); }
        ws(); if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return obj; } bad('NOT_JSON');
      }
    }
    if (c === '"') return str();
    if (c === '-' || isDigit(s.charCodeAt(i))) return num();
    if (c === 't') return word('true', true);
    if (c === 'f') return word('false', false);
    if (c === 'n') return word('null', null);
    return bad('NOT_JSON');
  };
  const out = value(0);
  ws(); if (i !== n) bad('NOT_JSON');
  if (duplicateAt >= 0) bad('DUPLICATE_KEY', duplicateAt);
  return out;
}

// ── provenance ──

/** evidenceRefs: [{ kind, ref }] — references only (ids / locators), never content. */
export function cleanEvidenceRefs(refs) {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs) || refs.length > limit('evidenceRefs')) fail('COMP_INVALID_FIELD', `evidenceRefs is a list of at most ${limit('evidenceRefs')}`);
  const out = [];
  for (const r of refs) {
    strictKeys(r, ['kind', 'ref'], ['kind', 'ref'], 'evidenceRef');
    if (!EVIDENCE_KIND[r.kind]) fail('COMP_INVALID_FIELD', 'unknown evidence kind');
    const ref = cleanText(r.ref, limit('refChars'), 'evidenceRef.ref', { required: true, multiline: false });
    if (!out.some(x => x.kind === r.kind && x.ref === ref)) out.push({ kind: r.kind, ref });
  }
  return out;
}
export function cleanSourceReference(s) {
  if (s === undefined || s === null) return null;
  strictKeys(s, ['kind', 'ref', 'label'], ['kind', 'ref'], 'sourceReference');
  if (!EVIDENCE_KIND[s.kind]) fail('COMP_INVALID_FIELD', 'unknown source reference kind');
  return { kind: s.kind, ref: cleanText(s.ref, limit('refChars'), 'sourceReference.ref', { required: true, multiline: false }),
    label: cleanText(s.label, limit('labelChars'), 'sourceReference.label', { multiline: false }) };
}
export function cleanDerivedBy(d) {
  if (d === undefined || d === null) return null;
  strictKeys(d, ['producer', 'modelId', 'ruleId', 'producerVersion'], ['producer'], 'derivedBy');
  if (!PRODUCER[d.producer]) fail('COMP_INVALID_FIELD', 'derivedBy.producer must be MODEL or RULE');
  const out = { producer: d.producer, modelId: cleanText(d.modelId, 120, 'derivedBy.modelId', { multiline: false }),
    ruleId: cleanText(d.ruleId, 120, 'derivedBy.ruleId', { multiline: false }), producerVersion: cleanText(d.producerVersion, 64, 'derivedBy.producerVersion', { multiline: false }) };
  if (d.producer === 'MODEL' && !out.modelId) fail('COMP_PROVENANCE_REQUIRED', 'a MODEL derivation names its model');
  if (d.producer === 'RULE' && !out.ruleId) fail('COMP_PROVENANCE_REQUIRED', 'a RULE derivation names its rule');
  return out;
}

/**
 * Validates a provenance record and the path it allows. Returns the canonical provenance.
 *   LEGACY_ADAPTIVE source                                  → COMP_LEGACY_ADAPTIVE_UNSUPPORTED (always)
 *   USER_EXPLICIT   needs sourceType USER_INPUT             (an external source never writes a user fact directly)
 *   USER_CONFIRMED  only produced by accepting a proposal   (never given by a caller)
 *   DERIVED         needs derivedBy                         (proposal only)
 *   IMPORTED        needs a sourceReference                 (proposal with needsReview)
 */
export function cleanProvenance(p, { allowConfirmed = false } = {}) {
  strictKeys(p, ['origin', 'sourceType', 'sessionId', 'evidenceRefs', 'sourceReference', 'derivedBy'], ['origin', 'sourceType'], 'provenance');
  if (p.sourceType === 'LEGACY_ADAPTIVE') fail('COMP_LEGACY_ADAPTIVE_UNSUPPORTED', 'the legacy adaptive memory is never a Companion source');
  if (!ORIGIN[p.origin]) fail('COMP_UNKNOWN_PROVENANCE', 'unknown origin');
  if (!SOURCE_TYPE[p.sourceType]) fail('COMP_UNKNOWN_PROVENANCE', 'unknown sourceType');
  if (p.origin === 'USER_CONFIRMED' && !allowConfirmed) fail('COMP_UNKNOWN_PROVENANCE', 'USER_CONFIRMED is only produced by a user accepting a proposal');
  if (p.origin === 'USER_EXPLICIT' && p.sourceType !== 'USER_INPUT') fail('COMP_DIRECT_DURABLE_REFUSED', `a ${p.sourceType} source cannot write a durable memory directly: propose it`);
  const out = {
    origin: p.origin, sourceType: p.sourceType,
    sessionId: p.sessionId === undefined || p.sessionId === null ? null : cleanText(p.sessionId, 64, 'sessionId', { multiline: false }),
    evidenceRefs: cleanEvidenceRefs(p.evidenceRefs), sourceReference: cleanSourceReference(p.sourceReference), derivedBy: cleanDerivedBy(p.derivedBy),
  };
  if (p.origin === 'DERIVED' && !out.derivedBy) fail('COMP_PROVENANCE_REQUIRED', 'a DERIVED proposal says what derived it');
  if (p.origin === 'IMPORTED' && !out.sourceReference) fail('COMP_PROVENANCE_REQUIRED', 'an IMPORTED proposal references its import');
  if (out.derivedBy && p.origin !== 'DERIVED') fail('COMP_INVALID_FIELD', 'derivedBy only describes a DERIVED proposal');
  return out;
}

// ── privacy and the cloud gate contract ──

/**
 * Privacy-scope transition. NEVER_CLOUD is irreversible implicitly (leaving it needs explicit + releaseNeverCloud);
 * CLOUD_ALLOWED needs an explicit user decision and a NORMAL-sensitivity memory.
 */
export function checkPrivacyTransition(from, to, { explicit = false, releaseNeverCloud = false, sensitivity = 'NORMAL' } = {}) {
  if (!PRIVACY_SCOPE[to]) fail('COMP_INVALID_SCOPE', 'unknown privacy scope');
  if (from === to) return to;
  if (from === 'NEVER_CLOUD' && !(explicit === true && releaseNeverCloud === true)) fail('COMP_NEVER_CLOUD_LOCKED', 'NEVER_CLOUD is only released by an explicit, confirmed user decision');
  if (to === 'CLOUD_ALLOWED') {
    if (explicit !== true) fail('COMP_CLOUD_SCOPE_NEEDS_DECISION', 'CLOUD_ALLOWED is an explicit user decision');
    if (sensitivity !== 'NORMAL') fail('COMP_CLOUD_SCOPE_REFUSED', 'a SENSITIVE / HIGHLY_SENSITIVE memory is never cloud-eligible');
  }
  return to;
}
/** The scope a memory gets from its NB-5 sensitivity when none was chosen. */
export const defaultScopeFor = (sensitivity) => (sensitivity === 'HIGHLY_SENSITIVE' ? 'NEVER_CLOUD' : DEFAULT_PRIVACY_SCOPE);

/**
 * Cloud gate CONTRACT (D3: cloud opt-in is `cloud_enabled === true`, never `!== false`). COMP-2 has no caller that
 * sends anything: this only decides. Every condition must hold, otherwise DENY with the first failing reason.
 */
export function evaluateCloudEligibility({ privacyScope, cloudAllowed, settings, preferences } = {}) {
  const deny = (reason) => Object.freeze({ decision: 'DENY', reason });
  if (!PRIVACY_SCOPE[privacyScope]) return deny('UNKNOWN_SCOPE');
  if (privacyScope === 'NEVER_CLOUD') return deny('NEVER_CLOUD');
  if (privacyScope !== 'CLOUD_ALLOWED') return deny('SCOPE_NOT_CLOUD_ALLOWED');
  if (cloudAllowed !== true) return deny('NO_EXPLICIT_CLOUD_DECISION');
  if (!settings || settings.strict_local_mode === true) return deny('STRICT_LOCAL');
  if (settings.cloud_enabled !== true) return deny('CLOUD_NOT_ENABLED');
  if (!preferences || preferences.cloudContextEnabled !== true) return deny('CLOUD_CONTEXT_DISABLED');
  return Object.freeze({ decision: 'ALLOW', reason: 'ALL_CONDITIONS_MET' });
}
