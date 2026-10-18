// Knowledge Graph V1 — boot gate (KG-3) + production activation (KG-ACT-MECH-1).
//
// KG V1 is certified (KG-CERT); certified does NOT mean active. A normal
// Docteur start never migrates anything: it opens the KG on the user database
// only when that database already carries KG schema 2.3.0 AND the persisted
// activation state kg_metadata.activation_state = 'ACTIVE'. Otherwise the KG
// stays disabled and no kg_* table is created.
//
// The only way to reach ACTIVE is the explicit, trusted, internal operation
// activateKg() (no HTTP route): it validates the canonical database resolved
// exactly as server.js does (SQLITE_PATH), migrates it to 2.3.0 with the
// certified migrations, verifies an open, and only then persists ACTIVE.
// deactivateKg() persists INACTIVE and keeps the schema (capability OFF, not a
// destructive rollback). Both take effect at the next boot.
//
// Development / certification only: DOCTEUR_KG_DEV_DB=<path> opens (and
// migrates) the KG in that SEPARATE database file. The path is refused when it
// designates the user database (SQLITE_PATH) or any file next to it in the
// user data directory. It is never a production activation flag.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { KnowledgeGraphStore } from './kg-store.js';
import { KG_SCHEMA_VERSION, getSchemaVersion } from './kg-schema.js';
import { getMigrationList, compareVersions } from './kg-migrations.js';

export const KG_CERTIFIED = true;
export const KG_ACTIVE = 'ACTIVE';
export const KG_INACTIVE = 'INACTIVE';
export const KG_DEV_DB_ENV = 'DOCTEUR_KG_DEV_DB';
const KG_ACTIVATION_KEY = 'activation_state';
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KNOWN_KG_VERSIONS = new Set(getMigrationList().map(m => m.version));

function samePath(a, b) {
  const norm = (p) => {
    let resolved = path.resolve(p);
    try { resolved = fs.realpathSync.native(resolved); } catch { /* not created yet */ }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function isInside(child, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Decides whether (and where) the KG may be opened at boot. Pure: no file is
 * opened here.
 * @returns {{ enabled: boolean, reason: string, dbPath?: string }}
 */
export function resolveKnowledgeGraphBoot({ env = process.env, userDbPath }) {
  const requested = typeof env[KG_DEV_DB_ENV] === 'string' ? env[KG_DEV_DB_ENV].trim() : '';
  if (!requested) {
    return { enabled: false, reason: KG_CERTIFIED ? 'KG_NOT_REQUESTED' : 'KG_UNCERTIFIED_DISABLED' };
  }
  if (requested === ':memory:') return { enabled: true, reason: 'KG_DEV_IN_MEMORY', dbPath: ':memory:' };
  if (!path.isAbsolute(requested)) return { enabled: false, reason: 'KG_DEV_DB_PATH_NOT_ABSOLUTE' };
  if (userDbPath && samePath(requested, userDbPath)) return { enabled: false, reason: 'KG_DEV_DB_IS_USER_DB' };
  if (userDbPath && isInside(requested, path.dirname(userDbPath))) return { enabled: false, reason: 'KG_DEV_DB_IN_USER_DATA_DIR' };
  return { enabled: true, reason: 'KG_DEV_SEPARATE_DB', dbPath: requested };
}

/**
 * Opens the KG store when the gate allows it, otherwise returns null.
 * Never throws into the server boot: a failure leaves the KG disabled.
 */
export async function openKnowledgeGraphAtBoot({ env = process.env, userDbPath, logger = null }) {
  const decision = resolveKnowledgeGraphBoot({ env, userDbPath });
  if (!decision.enabled && decision.reason === 'KG_NOT_REQUESTED') return openProductionKnowledgeGraphAtBoot({ userDbPath, logger });
  if (!decision.enabled) {
    logger?.info?.({ reason: decision.reason }, 'knowledge graph disabled');
    return { store: null, decision };
  }
  try {
    if (decision.dbPath !== ':memory:') fs.mkdirSync(path.dirname(decision.dbPath), { recursive: true });
    const store = new KnowledgeGraphStore(decision.dbPath);
    await store.initialize();
    logger?.warn?.({ reason: decision.reason, dbPath: decision.dbPath }, 'knowledge graph enabled on a separate development database (uncertified)');
    return { store, decision };
  } catch (error) {
    logger?.error?.({ err: error.message }, 'knowledge graph failed to open; disabled');
    return { store: null, decision: { enabled: false, reason: 'KG_OPEN_FAILED' } };
  }
}

export const KG_DEV_SYNC_ENV = 'DOCTEUR_KG_DEV_SYNC';

/**
 * KG-7 (development only): with the KG open on its separate dev database AND
 * DOCTEUR_KG_DEV_SYNC=1, derive the KG from the Notebook documents and the
 * article neurons once, in the background. Deterministic only (sources, refs,
 * Article Canonical metadata claims) — no model is called. Reads only.
 */
export function startKnowledgeGraphDevSync({ store, env = process.env, readers, listNotebooks, sync, logger = null }) {
  // Never on the production KG: activation alone must not ingest user content.
  if (!store || store.options?.production === true || env[KG_DEV_SYNC_ENV] !== '1') return null;
  return (async () => {
    const started = Date.now();
    const neurons = sync.syncNeurons(store, readers.neuron);
    let documents = 0;
    for (const nb of listNotebooks()) documents += (await sync.syncNotebook(store, readers.notebook, nb.id)).documents;
    logger?.warn?.({ neurons: neurons.synced, documents, ms: Date.now() - started }, 'knowledge graph dev sync done (uncertified)');
  })().catch((error) => logger?.error?.({ err: error.message }, 'knowledge graph dev sync failed'));
}

// ── Production activation (KG-ACT-MECH-1) ────────────────────────────────────

/** The canonical Docteur database, resolved exactly as server.js resolves SQLITE_PATH. Never taken from caller input. */
export function resolveKgProductionTarget({ env = process.env } = {}) {
  const target = path.resolve(SERVER_ROOT, env.SQLITE_PATH ?? './data/cortex.sqlite');
  const dev = typeof env[KG_DEV_DB_ENV] === 'string' ? env[KG_DEV_DB_ENV].trim() : '';
  if (dev && dev !== ':memory:' && samePath(dev, target)) throw Object.assign(new Error('KG_TARGET_IS_DEV_DB'), { code: 'KG_TARGET_IS_DEV_DB' });
  return target;
}

/**
 * Read-only inspection of the canonical database: never creates, migrates or writes it.
 * @returns {{ ok: true, schemaVersion: string|null, activation: string } | { ok: false, reason: string }}
 */
export function inspectKgTarget(dbPath) {
  if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath)) return { ok: false, reason: 'KG_TARGET_INVALID' };
  let stat;
  try { stat = fs.statSync(dbPath); } catch { return { ok: false, reason: 'KG_TARGET_MISSING' }; }
  if (!stat.isFile()) return { ok: false, reason: 'KG_TARGET_INVALID' };
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const objects = db.prepare('SELECT type, name FROM sqlite_master').all();
    if (!objects.some(o => o.type === 'table' && o.name === 'metadata')) return { ok: false, reason: 'KG_TARGET_NOT_CANONICAL' };
    const kgObjects = objects.filter(o => o.name.startsWith('kg_') && o.name !== 'kg_metadata');
    const meta = objects.find(o => o.name === 'kg_metadata');
    if (!meta) return kgObjects.length ? { ok: false, reason: 'KG_SCHEMA_METADATA_INVALID' } : { ok: true, schemaVersion: null, activation: KG_INACTIVE };
    if (meta.type !== 'table') return { ok: false, reason: 'KG_SCHEMA_METADATA_INVALID' };
    const rows = db.prepare('SELECT key, value FROM kg_metadata WHERE key IN (?, ?)').all('schema_version', KG_ACTIVATION_KEY);
    const schemaVersion = rows.find(r => r.key === 'schema_version')?.value ?? null;
    const activation = rows.find(r => r.key === KG_ACTIVATION_KEY)?.value ?? KG_INACTIVE;
    if (schemaVersion === null) {
      // An interrupted first migration leaves only an empty kg_metadata: still a fresh target.
      if (kgObjects.length || activation !== KG_INACTIVE) return { ok: false, reason: 'KG_SCHEMA_METADATA_INVALID' };
    } else if (!KNOWN_KG_VERSIONS.has(schemaVersion)) {
      const future = /^\d+\.\d+\.\d+$/.test(schemaVersion) && compareVersions(schemaVersion, KG_SCHEMA_VERSION) > 0;
      return { ok: false, reason: future ? 'KG_SCHEMA_UNSUPPORTED' : 'KG_SCHEMA_METADATA_INVALID' };
    }
    if (![KG_ACTIVE, KG_INACTIVE].includes(activation)) return { ok: false, reason: 'KG_ACTIVATION_STATE_INVALID' };
    return { ok: true, schemaVersion, activation };
  } catch {
    return { ok: false, reason: 'KG_TARGET_UNREADABLE' };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

/** Normal boot without DOCTEUR_KG_DEV_DB: opens the KG only when it is persisted ACTIVE on schema 2.3.0. Never migrates. */
async function openProductionKnowledgeGraphAtBoot({ userDbPath, logger }) {
  const disabled = (reason, detail = null) => {
    logger?.info?.({ reason, ...(detail ? { detail } : {}) }, 'knowledge graph disabled');
    return { store: null, decision: { enabled: false, reason, ...(detail ? { detail } : {}) } };
  };
  const state = inspectKgTarget(userDbPath);
  if (!state.ok) return disabled('KG_PRODUCTION_STATE_INVALID', state.reason);
  if (state.activation !== KG_ACTIVE) return disabled('KG_NOT_ACTIVATED');
  if (state.schemaVersion !== KG_SCHEMA_VERSION) return disabled('KG_SCHEMA_MISMATCH', state.schemaVersion);
  let store;
  try {
    store = new KnowledgeGraphStore(userDbPath, { production: true });
    await store.initialize(); // schema already current: runMigrations has nothing pending
    if (getSchemaVersion(store.db) !== KG_SCHEMA_VERSION) throw new Error('KG_SCHEMA_MISMATCH');
    logger?.info?.({ reason: 'KG_PRODUCTION_ACTIVE', schemaVersion: KG_SCHEMA_VERSION }, 'knowledge graph active');
    return { store, decision: { enabled: true, reason: 'KG_PRODUCTION_ACTIVE', dbPath: userDbPath } };
  } catch (error) {
    try { store?.close(); } catch { /* best effort */ }
    logger?.error?.({ err: error.message }, 'knowledge graph failed to open; disabled');
    return { store: null, decision: { enabled: false, reason: 'KG_OPEN_FAILED' } };
  }
}

function writeActivationState(db, state) {
  db.prepare(`INSERT INTO kg_metadata (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KG_ACTIVATION_KEY, state, new Date().toISOString());
}

/** A refused operation reports the state actually persisted (null when unreadable), never the requested one. */
function refused(reason, target = null) {
  const persisted = target ? inspectKgTarget(target) : null;
  return { ok: false, reason, state: persisted?.ok ? persisted.activation : null, ...(target ? { target } : {}) };
}

/**
 * Validates the canonical database and migrates it to KG schema 2.3.0 with the certified migrations
 * (one transaction per step). Does not change the activation state.
 */
export async function prepareKgActivation({ env = process.env, onMigrationStep = undefined, ...rest } = {}) {
  if (Object.keys(rest).length) return refused('KG_TARGET_NOT_ACCEPTED');
  if (!KG_CERTIFIED) return refused('KG_UNCERTIFIED_DISABLED');
  let target;
  try { target = resolveKgProductionTarget({ env }); } catch (error) { return refused(error.code ?? 'KG_TARGET_INVALID'); }
  const before = inspectKgTarget(target);
  if (!before.ok) return { ...refused(before.reason), target };
  let store;
  try {
    store = new KnowledgeGraphStore(target, { production: true, onMigrationStep });
    await store.initialize();
    if (getSchemaVersion(store.db) !== KG_SCHEMA_VERSION) throw new Error('KG_SCHEMA_MISMATCH');
  } catch {
    return refused('KG_MIGRATION_FAILED', target);
  } finally {
    try { store?.close(); } catch { /* best effort */ }
  }
  const after = inspectKgTarget(target);
  if (!after.ok) return refused(after.reason, target);
  return { ok: true, reason: 'KG_SCHEMA_READY', state: after.activation, target, schemaVersion: after.schemaVersion, migratedFrom: before.schemaVersion };
}

/** Explicit human-authorized activation: prepare, verify the KG opens and answers, then persist ACTIVE. Effective at next boot. */
export async function activateKg({ env = process.env, onMigrationStep = undefined, ...rest } = {}) {
  const prepared = await prepareKgActivation({ env, onMigrationStep, ...rest });
  if (!prepared.ok) return prepared;
  let store;
  try {
    store = new KnowledgeGraphStore(prepared.target, { production: true });
    await store.initialize();
    if (getSchemaVersion(store.db) !== KG_SCHEMA_VERSION) throw new Error('KG_SCHEMA_MISMATCH');
    store.db.prepare('SELECT COUNT(*) AS n FROM kg_entities').get(); // the KG must answer a read before ACTIVE is persisted
    writeActivationState(store.db, KG_ACTIVE);
  } catch {
    return refused('KG_OPEN_FAILED', prepared.target);
  } finally {
    try { store?.close(); } catch { /* best effort */ }
  }
  const after = inspectKgTarget(prepared.target);
  if (!after.ok || after.activation !== KG_ACTIVE) return refused(after.ok ? 'KG_ACTIVATION_NOT_PERSISTED' : after.reason, prepared.target);
  return { ok: true, reason: 'KG_ACTIVATED_EXPLICITLY', state: KG_ACTIVE, target: prepared.target, schemaVersion: after.schemaVersion };
}

/** Persists INACTIVE (capability OFF). Keeps the KG schema and content; never creates KG objects. Effective at next boot. */
export function deactivateKg({ env = process.env, ...rest } = {}) {
  if (Object.keys(rest).length) return refused('KG_TARGET_NOT_ACCEPTED');
  let target;
  try { target = resolveKgProductionTarget({ env }); } catch (error) { return refused(error.code ?? 'KG_TARGET_INVALID'); }
  if (!fs.existsSync(target)) return refused('KG_TARGET_MISSING');
  let db;
  try {
    db = new Database(target, { fileMustExist: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kg_metadata'").get()) {
      return { ok: true, reason: 'KG_ALREADY_INACTIVE', state: KG_INACTIVE, target };
    }
    writeActivationState(db, KG_INACTIVE);
  } catch {
    return refused('KG_DEACTIVATION_FAILED', target);
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
  return { ok: true, reason: 'KG_DEACTIVATED_EXPLICITLY', state: KG_INACTIVE, target };
}
