// Knowledge Graph V1 — migrations (additive, idempotent, transactional).
//
// Every migration runs in ONE transaction together with its schema_version
// bump: an interrupted migration rolls back completely and is simply run
// again next time. Foreign keys are suspended for the duration of a migration
// (SQLite table rebuild procedure) and `PRAGMA foreign_key_check` must be
// clean before the transaction commits.
//
// History:
//   001 1.0.0  create the KG tables (fresh install: directly the realigned schema)
//   002 1.1.0  KG-2 FTS5 tables       ┐ folded into 001 (fresh) and 005 (upgrade)
//   003 1.2.0  KG-2 extra indexes     │ since KG-3; kept so that the version
//   004 1.3.0  KG-2 provenance columns┘ sequence of early databases stays valid
//   005 2.0.0  KG-3 realignment on the KG-1 contract: new tables
//              (identifiers, source refs, claim↔evidence, resolution ledger),
//              non-destructive foreign keys, statuses/temporality, FTS fix.
//   006 2.1.0  KG-4 claims: claim_key (logical claim identity), evidence
//              character offsets, kg_claim_conflicts. 005 and 006 share the
//              same "realign to the current DDL" routine.
//   007 2.2.0  KG-5: FTS rows keyed by the base rowid (triggers + content rebuilt),
//              evidence FTS (kg_evidence_fts).
//   008 2.3.0  KG-8: kg_relationship_provenance (logical source + technical ref
//              per relation). Existing relations keep their logical source as a
//              provenance WITHOUT ref: never guessed, so a Notebook scope (which
//              needs a ref of that notebook) does not see them — fail closed.
//
// Never touches Notebook (nb_*, notebook_*) tables or Root Policy.

import Database from 'better-sqlite3';
import {
  KG_DEFAULT_LIMITS, KG_TABLES, KG_SCHEMA_VERSION,
  ensureKnowledgeGraphSchema, getSchemaVersion, setSchemaVersion, tableDdl, createIndexes, rebuildFts,
} from './kg-schema.js';
import { labelKey, looseKey, tokenKey, excerptHash, stableHash } from './kg-normalize.js';
import { claimKey, valueKeyOf } from './kg-claim-model.js';

export class MigrationContext {
  constructor(options = {}) {
    this.maxExecutionTime = options.maxExecutionTime || KG_DEFAULT_LIMITS.MAX_EXECUTION_TIME_MS;
    this.verbose = options.verbose || false;
    // Optional observer called between the steps of a migration (tests use it
    // to prove that an interruption rolls everything back).
    this.onStep = typeof options.onStep === 'function' ? options.onStep : null;
  }

  log(message) {
    if (this.verbose) console.log(`[KG-MIGRATION] ${message}`);
  }

  step(migrationId, name) {
    if (this.onStep) this.onStep(migrationId, name);
  }

  checkTimeout(startTime) {
    const elapsed = Date.now() - startTime;
    if (elapsed > this.maxExecutionTime) {
      throw new Error(`Migration timeout exceeded: ${elapsed}ms > ${this.maxExecutionTime}ms`);
    }
  }
}

export class MigrationResult {
  constructor() {
    this.success = true;
    this.errors = [];
    this.warnings = [];
    this.changes = [];
    this.schemaVersion = '0.0.0';
  }

  addError(error) {
    this.success = false;
    this.errors.push({ message: error.message, stack: error.stack });
  }

  toJSON() {
    return { success: this.success, errors: this.errors, warnings: this.warnings, changes: this.changes, schemaVersion: this.schemaVersion };
  }
}

export function compareVersions(v1, v2) {
  const parts1 = String(v1).split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = String(v2).split('.').map(p => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

// ── 001 ──────────────────────────────────────────────────────────────────────
function migration001(db, ctx) {
  if (tableExists(db, 'kg_entities')) {
    // An early KG-2 database: its tables are reshaped by 005, not here.
    return ['KG tables already present (reshaped by migration 005)'];
  }
  ctx.step('001', 'create');
  ensureKnowledgeGraphSchema(db);
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO kg_metadata (key, value, updated_at) VALUES ('created_at', ?, ?)").run(now, now);
  return ['Created all KG tables, indexes and FTS5 tables (realigned schema)'];
}

// 002-004 were KG-2 steps on the early schema. Their effects are part of the
// realigned definitions (001) and of the realignment (005).
const folded = (what) => () => [`${what}: folded into 001/005 since KG-3`];

// ── 005 ──────────────────────────────────────────────────────────────────────

let referenceShapes = null;

/** Structure of each table as the current DDL defines it (built once, in memory). */
function referenceShape(table) {
  if (!referenceShapes) {
    const ref = new Database(':memory:');
    try {
      for (const t of KG_TABLES) ref.exec(tableDdl(t));
      referenceShapes = Object.fromEntries(KG_TABLES.map(t => [t, tableShape(ref, t)]));
    } finally {
      ref.close();
    }
  }
  return referenceShapes[table];
}

/** Columns, foreign keys and constraint body of a table (name-independent). */
export function tableShape(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row) return null;
  const body = row.sql.slice(row.sql.indexOf('(')).replace(/\s+/g, ' ').trim();
  return {
    columns: db.prepare(`PRAGMA table_info(${table})`).all().map(c => `${c.name}|${c.type}|${c.notnull}|${c.dflt_value}|${c.pk}`),
    foreignKeys: db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(f => `${f.from}->${f.table}.${f.to}|${f.on_update}|${f.on_delete}`).sort(),
    body,
  };
}

function isRealigned(db, table) {
  const current = tableShape(db, table);
  const expected = referenceShape(table);
  return JSON.stringify(current) === JSON.stringify(expected);
}

function rebuildTable(db, table) {
  const temp = `${table}__kgrebuild`;
  const oldColumns = columnsOf(db, table);
  db.exec(`DROP TABLE IF EXISTS ${temp}`);
  db.exec(tableDdl(table, temp));
  const shared = columnsOf(db, temp).filter(c => oldColumns.includes(c));
  db.exec(`INSERT INTO ${temp} (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${temp} RENAME TO ${table}`);
  return { table, copiedColumns: shared.length, droppedColumns: oldColumns.filter(c => !shared.includes(c)) };
}

/**
 * Data fix-ups after a table rebuild, driven by the columns the previous table
 * did NOT have — so an early KG-2 table (no status, no keys) and a KG-3 table
 * (statuses already meaningful) are each completed without overwriting data.
 */
function backfillAfterRebuild(db, table, previousColumns, warnings) {
  const lacked = (col) => !previousColumns.includes(col);
  switch (table) {
    case 'kg_entities': {
      if (lacked('status')) db.exec("UPDATE kg_entities SET status = CASE WHEN is_active = 1 THEN 'ACTIVE' ELSE 'INVALIDATED' END");
      if (lacked('label_key')) {
        const update = db.prepare('UPDATE kg_entities SET normalized_name = ?, label_key = ?, token_key = ? WHERE entity_id = ?');
        for (const r of db.prepare('SELECT entity_id, name FROM kg_entities').all()) update.run(looseKey(r.name), labelKey(r.name), tokenKey(r.name), r.entity_id);
      }
      break;
    }
    case 'kg_sources':
      if (lacked('status')) db.exec("UPDATE kg_sources SET status = CASE WHEN is_active = 1 THEN 'ACTIVE' ELSE 'INVALIDATED' END");
      break;
    case 'kg_aliases': {
      if (lacked('alias_key')) {
        const update = db.prepare('UPDATE kg_aliases SET normalized_alias = ?, alias_key = ?, updated_at = created_at WHERE alias_id = ?');
        for (const r of db.prepare('SELECT alias_id, alias FROM kg_aliases').all()) update.run(looseKey(r.alias), labelKey(r.alias), r.alias_id);
      }
      break;
    }
    case 'kg_claims': {
      if (lacked('status')) db.exec("UPDATE kg_claims SET status = CASE WHEN is_active = 1 THEN 'ASSERTED' ELSE 'INVALIDATED' END");
      if (lacked('claim_key')) {
        // Structured claims get their logical identity. Two earlier rows with the
        // same identity both stay (nothing is deleted); only the first gets the key.
        const update = db.prepare('UPDATE kg_claims SET claim_key = ? WHERE claim_id = ?');
        const seen = new Set();
        for (const r of db.prepare('SELECT claim_id, entity_id, predicate, object_entity_id, value_json, valid_from, valid_to FROM kg_claims WHERE predicate IS NOT NULL ORDER BY created_at, rowid').all()) {
          const valueKey = r.object_entity_id ? null : valueKeyOf(r.value_json);
          if (!r.object_entity_id && !valueKey) continue;
          const key = claimKey({ subjectEntityId: r.entity_id, predicate: r.predicate, objectEntityId: r.object_entity_id, valueKey, validFrom: r.valid_from, validTo: r.valid_to });
          if (seen.has(key)) { warnings.push(`claim ${r.claim_id} duplicates the identity of an earlier claim (kept, without claim_key)`); continue; }
          seen.add(key);
          update.run(key, r.claim_id);
        }
      }
      break;
    }
    case 'kg_evidence': {
      if (lacked('status')) db.exec("UPDATE kg_evidence SET status = CASE WHEN is_active = 1 THEN 'ACTIVE' ELSE 'INVALIDATED' END");
      if (lacked('excerpt_hash')) {
        const update = db.prepare('UPDATE kg_evidence SET excerpt_hash = ? WHERE evidence_id = ?');
        for (const r of db.prepare('SELECT evidence_id, content FROM kg_evidence').all()) update.run(excerptHash(r.content), r.evidence_id);
      }
      break;
    }
    default:
      break;
  }
}

// Order: a table is (re)built after the tables it references; kg_claim_evidence
// exists before the KG-2 evidence links are converted.
const REALIGN_ORDER = ['kg_metadata', 'kg_entities', 'kg_sources', 'kg_source_refs', 'kg_entity_identifiers', 'kg_aliases',
  'kg_claims', 'kg_claim_evidence', 'kg_evidence', 'kg_relationships', 'kg_relationship_provenance', 'kg_entity_resolutions', 'kg_claim_conflicts'];

/**
 * Brings every KG table to the current definitions: missing tables are created,
 * tables whose structure differs are rebuilt (data kept), indexes and FTS are
 * recreated. Used by 005 (KG-2 → realigned) and 006 (KG-3 → KG-4 claims).
 */
function realignToCurrentSchema(migrationId) {
  return (db, ctx) => {
    const changes = [];
    const warnings = [];
    for (const base of ['kg_entities', 'kg_claims', 'kg_sources', 'kg_evidence']) {
      for (const suffix of ['ai', 'au', 'ad']) db.exec(`DROP TRIGGER IF EXISTS ${base}_fts_${suffix}`);
    }
    let createdClaimEvidence = false;
    for (const table of REALIGN_ORDER) {
      if (!tableExists(db, table)) {
        db.exec(tableDdl(table));
        if (table === 'kg_claim_evidence') createdClaimEvidence = true;
        changes.push(`created ${table}`);
        ctx.step(migrationId, `create:${table}`);
        continue;
      }
      if (isRealigned(db, table)) continue;
      const previousColumns = columnsOf(db, table);
      const rebuilt = rebuildTable(db, table);
      backfillAfterRebuild(db, table, previousColumns, warnings);
      // KG-2 evidence belonged to exactly one claim: that link becomes a
      // claim↔evidence row (N:N), stance taken from the evidence type.
      if (table === 'kg_evidence' && createdClaimEvidence && previousColumns.includes('claim_id')) {
        db.exec(`INSERT OR IGNORE INTO kg_claim_evidence (claim_id, evidence_id, stance, status, attached_at)
          SELECT claim_id, evidence_id,
                 CASE WHEN evidence_type IN ('CONTRADICTING', 'REFUTED', 'DISPUTED') THEN 'CONTRADICTS' ELSE 'SUPPORTS' END,
                 CASE WHEN is_active = 1 THEN 'ACTIVE' ELSE 'DETACHED' END,
                 created_at
          FROM kg_evidence WHERE claim_id IS NOT NULL`);
      }
      changes.push(`rebuilt ${table} (${rebuilt.copiedColumns} columns kept${rebuilt.droppedColumns.length ? `, dropped: ${rebuilt.droppedColumns.join(', ')}` : ''})`);
      ctx.step(migrationId, `rebuild:${table}`);
    }
    createIndexes(db);
    ctx.step(migrationId, 'indexes');
    rebuildFts(db);
    ctx.step(migrationId, 'fts');
    return [...changes, ...warnings.map(w => `warning: ${w}`)];
  };
}

/** Opaque id of a relation provenance row (same formula as the store). */
export const relationshipProvenanceId = (relationshipId, sourceId, sourceRefId) => `rprov_${stableHash(relationshipId, sourceId, sourceRefId ?? '').substring(0, 24)}`;

// ── 008 ──────────────────────────────────────────────────────────────────────
function migration008(db, ctx) {
  const changes = realignToCurrentSchema('008')(db, ctx);
  // the logical source recorded on a relation becomes its first provenance (no technical ref: unknown, not inferred)
  const insert = db.prepare(`INSERT OR IGNORE INTO kg_relationship_provenance (provenance_id, relationship_id, source_id, source_ref_id, status, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'ACTIVE', ?, ?)`);
  let n = 0;
  for (const r of db.prepare('SELECT relationship_id, source_id, created_at FROM kg_relationships WHERE source_id IS NOT NULL ORDER BY rowid').all()) {
    n += insert.run(relationshipProvenanceId(r.relationship_id, r.source_id, null), r.relationship_id, r.source_id, r.created_at, r.created_at).changes;
  }
  ctx.step('008', 'relationship-provenance');
  return [...changes, `relationship provenance backfilled from the logical source: ${n} row(s), technical ref unknown`];
}

const MIGRATIONS = [
  { id: '001', version: '1.0.0', description: 'Create KG tables (current schema on a fresh database)', func: migration001 },
  { id: '002', version: '1.1.0', description: 'KG-2 FTS5 tables (folded into 001/005)', func: folded('FTS5 tables') },
  { id: '003', version: '1.2.0', description: 'KG-2 performance indexes (folded into 001/005)', func: folded('performance indexes') },
  { id: '004', version: '1.3.0', description: 'KG-2 provenance columns (folded into 001/005)', func: folded('provenance columns') },
  { id: '005', version: '2.0.0', description: 'KG-3 realignment on the KG-1 contract (identifiers, source refs, claim↔evidence, resolution ledger, non-destructive FKs)', func: realignToCurrentSchema('005') },
  { id: '006', version: '2.1.0', description: 'KG-4 claims: logical claim identity (claim_key), evidence offsets, claim conflicts', func: realignToCurrentSchema('006') },
  { id: '007', version: '2.2.0', description: 'KG-5 FTS rows keyed by rowid (indexed delete on update), evidence FTS', func: realignToCurrentSchema('007') },
  { id: '008', version: KG_SCHEMA_VERSION, description: 'KG-8 relation provenance (logical source + technical ref per relation)', func: migration008 },
];

function foreignKeysEnabled(db) {
  return db.pragma('foreign_keys', { simple: true }) === 1;
}

/**
 * Runs every pending migration, each in its own transaction with foreign keys
 * suspended and a clean foreign_key_check required before commit. Must not be
 * called inside an open transaction.
 */
export function runMigrations(db, options = {}) {
  const context = new MigrationContext(options);
  const overall = new MigrationResult();
  const startTime = Date.now();
  if (db.inTransaction) throw new Error('runMigrations must not run inside a transaction');

  const fkWasOn = foreignKeysEnabled(db);
  try {
    db.exec(tableDdl('kg_metadata'));
    let current = getSchemaVersion(db);
    overall.schemaVersion = current;
    const pending = MIGRATIONS.filter(m => compareVersions(current, m.version) < 0);
    if (pending.length === 0) return overall;

    db.pragma('foreign_keys = OFF');
    for (const migration of pending) {
      context.log(`Running migration ${migration.id}`);
      try {
        const changes = db.transaction(() => {
          const result = migration.func(db, context);
          const violations = db.pragma('foreign_key_check');
          if (violations.length > 0) {
            throw new Error(`Migration ${migration.id}: foreign key check failed (${violations.length} violation(s), first: ${JSON.stringify(violations[0])})`);
          }
          setSchemaVersion(db, migration.version);
          return result;
        })();
        overall.changes.push(...changes.map(c => `${migration.id}: ${c}`));
        overall.schemaVersion = migration.version;
        current = migration.version;
        context.checkTimeout(startTime);
      } catch (error) {
        overall.addError(error);
        context.log(`Migration ${migration.id} failed and was rolled back: ${error.message}`);
        break;
      }
    }
  } catch (error) {
    overall.addError(error);
  } finally {
    db.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
  }
  overall.changes.push(`Total execution time: ${Date.now() - startTime}ms`);
  return overall;
}

export function getMigrationList() {
  return MIGRATIONS.map(m => ({ id: m.id, version: m.version, description: m.description }));
}

export function getMigrationStatus(db) {
  const currentVersion = getSchemaVersion(db);
  const migrations = getMigrationList();
  return {
    currentVersion,
    targetVersion: KG_SCHEMA_VERSION,
    totalMigrations: migrations.length,
    appliedMigrations: migrations.filter(m => compareVersions(currentVersion, m.version) >= 0).length,
    pendingMigrations: migrations.filter(m => compareVersions(currentVersion, m.version) < 0).length,
    migrations: migrations.map(m => ({ ...m, status: compareVersions(currentVersion, m.version) >= 0 ? 'applied' : 'pending' })),
  };
}

export default {
  MigrationContext,
  MigrationResult,
  runMigrations,
  getMigrationList,
  getMigrationStatus,
  compareVersions,
  tableShape,
};
