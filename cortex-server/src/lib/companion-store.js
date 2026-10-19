// Companion V1 — COMP-2 local store: preferences, per-memory metadata, memory proposals, audit.
//
// Persistence only; the rules live in companion-memory.js. Opened on a SEPARATE database: development/tests stay
// outside product data, while narrow production operations may open only the dedicated Companion target below
// cortex-server/data. It is never the canonical Docteur database. Every row belongs to the single local installation
// (companion_installation): Docteur is single-user, no multi-user system is invented, but no row is ever "nobody's".
// The audit is append-only (database triggers) and hash-chained; its details are bounded JSON of ids, types, counts and
// hashes — a detail that looks like a secret is refused, so a secret can never reach the audit through a bug.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { fail, limit, newId, nowIso, sha256Hex, boundedJson, freezeDeep, AUDIT_ACTION, AUDIT_OBJECT } from './companion-contracts.js';
import { detectSecretInValue } from './companion-secrets.js';
import { COMPANION_MIGRATIONS, COMPANION_SCHEMA_VERSION, runCompanionMigrations, companionSchemaVersion } from './companion-schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const USER_DATA_DIR = path.resolve(HERE, '..', '..', 'data');
export function isInUserData(p) {
  const rel = path.relative(USER_DATA_DIR.toLowerCase(), path.resolve(String(p)).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export const PREFERENCE_DEFAULTS = freezeDeep({ memoryEnabled: true, sessionMemoryEnabled: true, proposalEnabled: true, cloudContextEnabled: false });
export const MODEL_AUDIT_ACTIONS = Object.freeze(['MODEL_REQUESTED', 'MODEL_SELECTED', 'MODEL_COMPLETED', 'MODEL_CANCELLED', 'MODEL_TIMEOUT', 'MODEL_FAILED']);
const PREF_COLUMNS = { memoryEnabled: 'memory_enabled', sessionMemoryEnabled: 'session_memory_enabled', proposalEnabled: 'proposal_enabled', cloudContextEnabled: 'cloud_context_enabled' };

function assertCompatibleSchemaMetadata(db) {
  const schemaObject = db.prepare("SELECT type FROM sqlite_master WHERE name = 'companion_schema_migrations'").get();
  if (!schemaObject) return; // Fresh/unversioned stores retain the existing additive migration behavior.
  if (schemaObject.type !== 'table') fail('COMP_SCHEMA_METADATA_INVALID', 'invalid Companion schema metadata');
  let rows;
  try {
    rows = db.prepare('SELECT version, name FROM companion_schema_migrations ORDER BY version').all();
  } catch {
    fail('COMP_SCHEMA_METADATA_INVALID', 'invalid Companion schema metadata');
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Number.isSafeInteger(row.version)) fail('COMP_SCHEMA_METADATA_INVALID', 'invalid Companion schema metadata');
    if (row.version > COMPANION_SCHEMA_VERSION) fail('COMP_UNSUPPORTED_SCHEMA_VERSION', 'unsupported Companion schema version');
    const expected = COMPANION_MIGRATIONS[i];
    if (!expected || row.version !== expected.version || row.name !== expected.name) {
      fail('COMP_SCHEMA_METADATA_INVALID', 'invalid Companion schema metadata');
    }
  }
}

export class CompanionStore {
  /** @param {{ dbPath: string, allowProductionStore?: boolean }} opts absolute path outside user data, ':memory:', or the resolver-authorised production path */
  static open({ dbPath, now = Date.now, allowProductionStore = false } = {}) {
    if (typeof dbPath !== 'string' || !dbPath) fail('COMP_INVALID_DB_PATH', 'dbPath required');
    if (dbPath !== ':memory:') {
      if (!path.isAbsolute(dbPath)) fail('COMP_INVALID_DB_PATH', 'dbPath must be absolute');
      if (isInUserData(dbPath) && !allowProductionStore) fail('COMP_DB_IN_USER_DATA', 'the Companion development store never opens a database in the user data directory');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      db.pragma('recursive_triggers = ON'); // INSERT OR REPLACE = delete + insert: the audit delete guard must fire too
      assertCompatibleSchemaMetadata(db);
      runCompanionMigrations(db);
      if (companionSchemaVersion(db) !== COMPANION_SCHEMA_VERSION) fail('COMP_UNSUPPORTED_SCHEMA_VERSION', 'unsupported Companion schema version');
      if (!db.prepare('SELECT 1 FROM companion_installation').get()) {
        db.prepare("INSERT INTO companion_installation (singleton, installation_id, profile, created_at) VALUES (1, ?, 'LOCAL_SINGLE_USER', ?)").run(newId(), nowIso(now()));
      }
      db.prepare("INSERT OR IGNORE INTO companion_activation (singleton, state, updated_at) VALUES (1, 'DISABLED_PENDING_HUMAN_ACTIVATION', ?)").run(nowIso(now()));
    } catch (e) { db.close(); throw e; }
    return new CompanionStore(db, now);
  }

  #now;
  constructor(db, now) {
    this.db = db;
    this.#now = now;
    this.ownerId = db.prepare('SELECT installation_id FROM companion_installation WHERE singleton = 1').get().installation_id;
    Object.freeze(this);
  }
  close() { if (this.db.open) this.db.close(); }
  schemaVersion() { return companionSchemaVersion(this.db); }
  at() { return nowIso(this.#now()); }
  transaction(fn) { return this.db.transaction(fn)(); }

  getActivationState() {
    return this.db.prepare('SELECT state, updated_at AS updatedAt FROM companion_activation WHERE singleton = 1').get() ?? null;
  }

  setActivationState(state) {
    if (!['DISABLED_PENDING_HUMAN_ACTIVATION', 'ACTIVE'].includes(state)) fail('COMP_INVALID_ACTIVATION_STATE', 'invalid Companion activation state');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM companion_activation WHERE singleton = 1').run();
      this.db.prepare('INSERT INTO companion_activation (singleton, state, updated_at) VALUES (1, ?, ?)').run(state, this.at());
    })();
    return this.getActivationState();
  }

  // ── preferences ──────────────────────────────────────────────────────────
  getPreferences() {
    const r = this.db.prepare('SELECT * FROM companion_preferences WHERE owner_id = ?').get(this.ownerId);
    if (!r) return PREFERENCE_DEFAULTS;
    return freezeDeep(Object.fromEntries(Object.entries(PREF_COLUMNS).map(([k, col]) => [k, r[col] === 1])));
  }
  setPreferences(patch) {
    const next = { ...this.getPreferences() };
    for (const [k, v] of Object.entries(patch)) {
      if (!Object.hasOwn(PREF_COLUMNS, k)) fail('COMP_UNKNOWN_FIELD', `unknown preference: ${String(k).slice(0, 40)}`);
      if (typeof v !== 'boolean') fail('COMP_INVALID_FIELD', `${k} is a boolean`);
      next[k] = v;
    }
    this.db.prepare(`INSERT INTO companion_preferences (owner_id, memory_enabled, session_memory_enabled, proposal_enabled, cloud_context_enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET memory_enabled = excluded.memory_enabled, session_memory_enabled = excluded.session_memory_enabled,
      proposal_enabled = excluded.proposal_enabled, cloud_context_enabled = excluded.cloud_context_enabled, updated_at = excluded.updated_at`)
      .run(this.ownerId, +next.memoryEnabled, +next.sessionMemoryEnabled, +next.proposalEnabled, +next.cloudContextEnabled, this.at());
    return this.getPreferences();
  }

  // ── audit (append-only, hash-chained) ────────────────────────────────────
  audit(action, objectType, objectId, { actor = 'USER', details = {} } = {}) {
    if (!AUDIT_ACTION[action] || !AUDIT_OBJECT[objectType] || !['USER', 'SYSTEM'].includes(actor)) fail('COMP_INTERNAL', 'invalid audit entry');
    if (detectSecretInValue({ objectId, details }).refused) fail('COMP_INTERNAL', 'audit details must never carry a secret');
    const detailsJson = boundedJson(details, limit('auditDetailsBytes'), 'audit details');
    const prev = this.db.prepare('SELECT entry_hash FROM companion_audit WHERE owner_id = ? ORDER BY seq DESC LIMIT 1').get(this.ownerId)?.entry_hash ?? null;
    const id = newId(); const at = this.at();
    const hash = sha256Hex(JSON.stringify([id, this.ownerId, action, objectType, String(objectId), at, actor, detailsJson, prev]));
    this.db.prepare(`INSERT INTO companion_audit (audit_id, owner_id, action, object_type, object_id, at, actor, details_json, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, this.ownerId, action, objectType, String(objectId), at, actor, detailsJson, prev, hash);
  }
  listAudit() {
    return this.db.prepare('SELECT * FROM companion_audit WHERE owner_id = ? ORDER BY seq').all(this.ownerId).map(r => freezeDeep({
      id: r.audit_id, action: r.action, objectType: r.object_type, objectId: r.object_id, at: r.at, actor: r.actor, details: JSON.parse(r.details_json), prevHash: r.prev_hash, entryHash: r.entry_hash,
    }));
  }
  verifyAudit() {
    let prev = null; let n = 0;
    for (const r of this.db.prepare('SELECT * FROM companion_audit WHERE owner_id = ? ORDER BY seq').all(this.ownerId)) {
      const expected = sha256Hex(JSON.stringify([r.audit_id, r.owner_id, r.action, r.object_type, r.object_id, r.at, r.actor, r.details_json, prev]));
      if (r.prev_hash !== prev || r.entry_hash !== expected) return { ok: false, brokenAt: r.audit_id, entries: n };
      prev = r.entry_hash; n++;
    }
    return { ok: true, entries: n, head: prev };
  }

  // ── model-run audit (schema v2, COMP-4): ids, names, codes, durations, token counts — never prompt / answer ──
  modelAudit(action, requestId, details = {}) {
    if (!MODEL_AUDIT_ACTIONS.includes(action)) fail('COMP_INTERNAL', 'invalid model audit entry');
    const req = String(requestId ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(req)) fail('COMP_INTERNAL', 'invalid model audit request id');
    if (detectSecretInValue(details).refused) fail('COMP_INTERNAL', 'model audit details must never carry a secret');
    const detailsJson = boundedJson(details, limit('auditDetailsBytes'), 'model audit details');
    const prev = this.db.prepare('SELECT entry_hash FROM companion_model_audit WHERE owner_id = ? ORDER BY seq DESC LIMIT 1').get(this.ownerId)?.entry_hash ?? null;
    const id = newId(); const at = this.at();
    const hash = sha256Hex(JSON.stringify([id, this.ownerId, action, req, at, detailsJson, prev]));
    this.db.prepare('INSERT INTO companion_model_audit (audit_id, owner_id, action, request_id, at, details_json, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, this.ownerId, action, req, at, detailsJson, prev, hash);
  }
  listModelAudit({ requestId = null } = {}) {
    return this.db.prepare('SELECT * FROM companion_model_audit WHERE owner_id = ? ORDER BY seq').all(this.ownerId).filter(r => requestId === null || r.request_id === requestId)
      .map(r => freezeDeep({ id: r.audit_id, action: r.action, requestId: r.request_id, at: r.at, details: JSON.parse(r.details_json), prevHash: r.prev_hash, entryHash: r.entry_hash }));
  }
  verifyModelAudit() {
    let prev = null; let n = 0;
    for (const r of this.db.prepare('SELECT * FROM companion_model_audit WHERE owner_id = ? ORDER BY seq').all(this.ownerId)) {
      const expected = sha256Hex(JSON.stringify([r.audit_id, r.owner_id, r.action, r.request_id, r.at, r.details_json, prev]));
      if (r.prev_hash !== prev || r.entry_hash !== expected) return { ok: false, brokenAt: r.audit_id, entries: n };
      prev = r.entry_hash; n++;
    }
    return { ok: true, entries: n, head: prev };
  }

  // ── metadata (never the memory text: NB-5 owns it) ───────────────────────
  insertMetadata(m) {
    this.db.prepare(`INSERT INTO companion_memory_metadata (memory_id, owner_id, category, privacy_scope, companion_enabled, origin, source_type, proposal_id, session_id,
      evidence_refs_json, source_reference_json, derived_by_json, created_at, updated_at, confirmed_at, review_after) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.memoryId, this.ownerId, m.category, m.privacyScope, m.origin, m.sourceType, m.proposalId ?? null, m.sessionId ?? null,
        boundedJson(m.evidenceRefs ?? [], limit('metadataJsonBytes'), 'evidenceRefs'), m.sourceReference ? boundedJson(m.sourceReference, limit('metadataJsonBytes'), 'sourceReference') : null,
        m.derivedBy ? boundedJson(m.derivedBy, limit('metadataJsonBytes'), 'derivedBy') : null, m.at, m.at, m.at, m.reviewAfter ?? null);
  }
  getMetadata(memoryId) {
    const r = this.db.prepare('SELECT * FROM companion_memory_metadata WHERE owner_id = ? AND memory_id = ?').get(this.ownerId, String(memoryId));
    return r ? metadataRow(r) : null;
  }
  listMetadata() { return this.db.prepare('SELECT * FROM companion_memory_metadata WHERE owner_id = ? ORDER BY created_at, rowid').all(this.ownerId).map(metadataRow); }
  updateMetadata(memoryId, cols) {
    const allowed = ['privacy_scope', 'companion_enabled', 'last_presented_at', 'review_after'];
    const keys = Object.keys(cols);
    for (const k of keys) if (!allowed.includes(k)) fail('COMP_INTERNAL', `metadata column not editable: ${k}`);
    this.db.prepare(`UPDATE companion_memory_metadata SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE owner_id = ? AND memory_id = ?`)
      .run(...keys.map(k => cols[k]), this.at(), this.ownerId, String(memoryId));
  }
  deleteMetadata(memoryId) { return this.db.prepare('DELETE FROM companion_memory_metadata WHERE owner_id = ? AND memory_id = ?').run(this.ownerId, String(memoryId)).changes; }

  // ── proposals ────────────────────────────────────────────────────────────
  insertProposal(p) {
    const id = newId();
    this.db.prepare(`INSERT INTO companion_memory_proposals (proposal_id, owner_id, kind, value, value_sha256, nb5_type, nb5_scope_json, privacy_scope, origin, source_type, session_id,
      evidence_refs_json, source_reference_json, derived_by_json, needs_review, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
      .run(id, this.ownerId, p.kind, p.value, sha256Hex(p.value), p.nb5Type, JSON.stringify(p.nb5Scope), p.privacyScope, p.origin, p.sourceType, p.sessionId ?? null,
        boundedJson(p.evidenceRefs ?? [], limit('metadataJsonBytes'), 'evidenceRefs'), p.sourceReference ? boundedJson(p.sourceReference, limit('metadataJsonBytes'), 'sourceReference') : null,
        p.derivedBy ? boundedJson(p.derivedBy, limit('metadataJsonBytes'), 'derivedBy') : null, p.needsReview ? 1 : 0, this.at());
    return id;
  }
  getProposal(proposalId) {
    const r = this.db.prepare('SELECT * FROM companion_memory_proposals WHERE owner_id = ? AND proposal_id = ?').get(this.ownerId, String(proposalId));
    return r ? proposalRow(r) : null;
  }
  listProposals({ status = null } = {}) {
    return this.db.prepare('SELECT * FROM companion_memory_proposals WHERE owner_id = ? ORDER BY created_at, rowid').all(this.ownerId).filter(r => status === null || r.status === status).map(proposalRow);
  }
  countPending() { return this.db.prepare("SELECT COUNT(*) AS n FROM companion_memory_proposals WHERE owner_id = ? AND status = 'PENDING'").get(this.ownerId).n; }
  findPendingByHash(kind, valueSha) { return this.db.prepare("SELECT proposal_id FROM companion_memory_proposals WHERE owner_id = ? AND status = 'PENDING' AND kind = ? AND value_sha256 = ?").get(this.ownerId, kind, valueSha)?.proposal_id ?? null; }
  /** Decides a PENDING proposal: the candidate text is cleared (NB-5 owns an accepted memory; a rejected one does not linger). */
  decideProposal(proposalId, status, { memoryId = null, note = null, supersededBy = null } = {}) {
    const r = this.db.prepare(`UPDATE companion_memory_proposals SET status = ?, value = NULL, decided_at = ?, decision_note = ?, memory_id = ?, superseded_by = ?
      WHERE owner_id = ? AND proposal_id = ? AND status = 'PENDING'`).run(status, this.at(), note, memoryId, supersededBy, this.ownerId, String(proposalId));
    if (r.changes !== 1) fail('COMP_PROPOSAL_DECIDED', 'this proposal is already decided');
  }
  deleteProposalsForMemory(memoryId) { return this.db.prepare('DELETE FROM companion_memory_proposals WHERE owner_id = ? AND memory_id = ?').run(this.ownerId, String(memoryId)).changes; }
  countProposalsForMemory(memoryId) { return this.db.prepare('SELECT COUNT(*) AS n FROM companion_memory_proposals WHERE owner_id = ? AND memory_id = ?').get(this.ownerId, String(memoryId)).n; }
}

const parse = (s) => (s === null ? null : JSON.parse(s));
const metadataRow = (r) => freezeDeep({
  memoryId: r.memory_id, ownerId: r.owner_id, category: r.category, privacyScope: r.privacy_scope, companionEnabled: r.companion_enabled === 1,
  provenance: { origin: r.origin, sourceType: r.source_type, proposalId: r.proposal_id, sessionId: r.session_id, evidenceRefs: parse(r.evidence_refs_json), sourceReference: parse(r.source_reference_json), derivedBy: parse(r.derived_by_json) },
  createdAt: r.created_at, updatedAt: r.updated_at, confirmedAt: r.confirmed_at, lastPresentedAt: r.last_presented_at, reviewAfter: r.review_after,
});
const proposalRow = (r) => freezeDeep({
  id: r.proposal_id, ownerId: r.owner_id, kind: r.kind, value: r.value, valueSha256: r.value_sha256, nb5Type: r.nb5_type, nb5Scope: JSON.parse(r.nb5_scope_json), privacyScope: r.privacy_scope,
  provenance: { origin: r.origin, sourceType: r.source_type, sessionId: r.session_id, evidenceRefs: parse(r.evidence_refs_json), sourceReference: parse(r.source_reference_json), derivedBy: parse(r.derived_by_json) },
  needsReview: r.needs_review === 1, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note, memoryId: r.memory_id, supersededBy: r.superseded_by,
});

export { companionSchemaVersion };
