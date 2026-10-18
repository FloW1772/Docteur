// Knowledge Graph V1 — boot gate (KG-3).
//
// Until KG-CERT passes, a normal Docteur start NEVER initialises the KG
// schema: no kg_* table is created in the user database by accident.
//
// Development / certification only: DOCTEUR_KG_DEV_DB=<path> opens (and
// migrates) the KG in that SEPARATE database file. The path is refused when it
// designates the user database (SQLITE_PATH) or any file next to it in the
// user data directory. There is no user-facing setting; enabling the KG on the
// user database after KG-CERT is a separate decision that changes this file.

import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeGraphStore } from './kg-store.js';

export const KG_CERTIFIED = false;
export const KG_DEV_DB_ENV = 'DOCTEUR_KG_DEV_DB';

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
  if (!store || env[KG_DEV_SYNC_ENV] !== '1') return null;
  return (async () => {
    const started = Date.now();
    const neurons = sync.syncNeurons(store, readers.neuron);
    let documents = 0;
    for (const nb of listNotebooks()) documents += (await sync.syncNotebook(store, readers.notebook, nb.id)).documents;
    logger?.warn?.({ neurons: neurons.synced, documents, ms: Date.now() - started }, 'knowledge graph dev sync done (uncertified)');
  })().catch((error) => logger?.error?.({ err: error.message }, 'knowledge graph dev sync failed'));
}
