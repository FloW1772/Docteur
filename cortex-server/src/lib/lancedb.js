import fs from 'node:fs';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';

const TABLE_NAME = 'neurons';

let databasePromise;
const tablePromises = new Map();
let optimizationPromise;
export const AUTO_COMPACT_FRAGMENTS = 1000;

export function needsCompaction(stats) {
  return !!stats && (stats.numFragments >= AUTO_COMPACT_FRAGMENTS ||
    stats.diskBytes >= Math.max(256 * 1024 * 1024, stats.totalBytes * 3));
}

async function diskBytes(directory) {
  let bytes = 0;
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) bytes += await diskBytes(filename);
      else if (entry.isFile()) bytes += (await fs.promises.stat(filename)).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return bytes;
}

function ensureParentDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function getDataDirectory(lancedbPath) {
  const resolvedPath = path.resolve(lancedbPath);
  return path.dirname(resolvedPath);
}

async function ensureDatabase(lancedbPath) {
  if (!databasePromise) {
    ensureParentDir(getDataDirectory(lancedbPath));
    databasePromise = connect(path.resolve(lancedbPath)).catch(error => { databasePromise = undefined; throw error; });
  }
  return databasePromise;
}

function getVectorTable(lancedbPath, name) {
  let pending = tablePromises.get(name);
  if (!pending) {
    pending = ensureDatabase(lancedbPath).then(db => db.openTable(name)).catch(error => {
      if (error.message?.startsWith(`Table '${name}' was not found`)) return null;
      if (tablePromises.get(name) === pending) tablePromises.delete(name);
      throw error;
    });
    tablePromises.set(name, pending);
  }
  return pending;
}

function getTable(lancedbPath) { return getVectorTable(lancedbPath, TABLE_NAME); }

async function getOrCreateVectorTable(lancedbPath, name, rows) {
  const opened = getVectorTable(lancedbPath, name);
  const table = await opened;
  if (table) return { table, created: false };
  // Publish creation before yielding. Other cold writers await this table and
  // then merge their own rows instead of racing to create the same table.
  if (tablePromises.get(name) !== opened) {
    return { table: await tablePromises.get(name), created: false };
  }
  const creation = ensureDatabase(lancedbPath).then(db => db.createTable(name, rows));
  tablePromises.set(name, creation);
  try { return { table: await creation, created: true }; }
  catch (error) {
    if (tablePromises.get(name) === creation) tablePromises.delete(name);
    throw error;
  }
}

function validateVector(vector) {
  if (!(Array.isArray(vector) || (ArrayBuffer.isView(vector) && !(vector instanceof DataView))) ||
      !vector.length || Array.from(vector).some(value => typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) {
    throw new Error('LanceDB vector must be a non-empty array of finite numbers representable as float32');
  }
}

async function validateDimensions(table, rows) {
  const schema = await table.schema();
  const dimensions = schema.fields.find(field => field.name === 'vector')?.type?.listSize;
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || rows.some(row => row.vector.length !== dimensions)) {
    throw new Error(`LanceDB vector dimension mismatch: expected ${dimensions ?? 'a vector schema'}, received ${rows.map(row => row.vector.length).join(', ')}; previous row preserved`);
  }
}

export function createPreview(content, maxLength = 180) {
  const collapsed = String(content).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function buildTableRow({ id, kind, title, content, metadata, vector }) {
  const now = new Date().toISOString();
  return {
    id:              String(id),
    kind:            kind ?? 'note',
    title:           title ?? '',
    content:         content ?? '',
    content_preview: createPreview(content ?? ''),
    // Serialize metadata as JSON string — avoids Apache Arrow schema issues
    // with empty arrays (e.g. tags: []) that cause type-inference failures
    metadata:        JSON.stringify(metadata ?? {}),
    vector,
    created_at:      now,
    updated_at:      now,
  };
}

export async function upsertNeuron(lancedbPath, neuron) {
  const row = buildTableRow(neuron);
  validateVector(row.vector);

  let table;
  try {
    const result = await getOrCreateVectorTable(lancedbPath, TABLE_NAME, [row]);
    if (result.created) return row;
    table = result.table;
  } catch (err) {
    throw new Error(`LanceDB getTable failed: ${err.message}`);
  }

  // Arrow's conversion can silently coerce an array to the fixed-size vector
  // field. Refuse model/dimension changes before that conversion can occur.
  await validateDimensions(table, [row]);

  // Update in one atomic merge without a destructive delete+add fallback.
  try {
    await table.mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([row]);
    return row;
  } catch (err) {
    // mergeInsert is atomic. A delete+add fallback would destroy the old row
    // if the replacement also failed (e.g. a different embedding dimension).
    throw new Error(`LanceDB upsert failed; previous row preserved: ${err.message}`, { cause: err });
  }
}

// Compact all fragments into a single file and clean up old versions.
// Run at startup or via Settings button when the table is highly fragmented.
export async function optimizeTable(lancedbPath) {
  if (optimizationPromise) return optimizationPromise;
  optimizationPromise = runOptimization(lancedbPath).finally(() => { optimizationPromise = null; });
  return optimizationPromise;
}

async function runOptimization(lancedbPath) {
  const table = await getTable(lancedbPath);
  if (!table) return { skipped: true };
  const started = Date.now();
  const before = await getFragmentStats(lancedbPath);
  // Remove obsolete versions, retaining the current version and unverified
  // transaction files (the SDK's default protection for concurrent writers).
  await table.optimize({ cleanupOlderThan: new Date() });
  const after = await getFragmentStats(lancedbPath);
  return {
    before: { fragments: before.numFragments, rows: before.numRows, bytes: before.diskBytes },
    after:  { fragments: after.numFragments, rows: after.numRows, bytes: after.diskBytes },
    durationMs: Date.now() - started,
  };
}

// Table fragmentation stats — used by /api/health and Settings.
export async function getFragmentStats(lancedbPath) {
  const table = await getTable(lancedbPath);
  if (!table) return null;
  const s = await table.stats();
  return {
    numFragments:      s.fragmentStats.numFragments,
    numSmallFragments: s.fragmentStats.numSmallFragments,
    numRows:           s.numRows,
    numIndices:        s.numIndices,
    totalBytes:        s.totalBytes,
    diskBytes:         await diskBytes(path.resolve(lancedbPath)),
    autoCompactThreshold: AUTO_COMPACT_FRAGMENTS,
  };
}

export async function deleteNeuron(lancedbPath, id) {
  const table = await getTable(lancedbPath);
  if (!table) return false;

  const before = await countNeurons(lancedbPath);
  await table.delete(`id = '${escapeSqlString(id)}'`);
  const after = await countNeurons(lancedbPath);
  return after < before;
}

export async function countNeurons(lancedbPath) {
  const table = await getTable(lancedbPath);
  if (!table) return 0;

  if (typeof table.countRows === 'function') return table.countRows();

  const rows = await table.search().limit(100000).toArray();
  return rows.length;
}

export async function searchNeurons(lancedbPath, vector, { limit = 5, threshold = 0.5, filterByKinds = [] } = {}) {
  const table = await getTable(lancedbPath);
  if (!table) return [];

  const rawResults = await table.search(vector).limit(limit).toArray();

  return rawResults
    .map((row) => {
      const distance = typeof row._distance === 'number' ? row._distance : (typeof row.distance === 'number' ? row.distance : 1);
      const score    = Number.isFinite(distance) ? Math.max(0, Math.min(1, 1 - distance)) : 0;
      return {
        id:              row.id,
        title:           row.title ?? '',
        kind:            row.kind ?? 'note',
        content:         row.content ?? '',
        content_preview: row.content_preview ?? createPreview(row.content ?? ''),
        metadata:        (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })(),
        score,
      };
    })
    .filter((row) => row.score >= threshold)
    .filter((row) => filterByKinds.length === 0 || filterByKinds.includes(row.kind))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Vector search scoped to a specific set of neuron ids — used by the local
// Notebook RAG (Phase 5, MASTER mission) so retrieval only ever considers a
// notebook's own sources, never the entire neuron store. Uses LanceDB's
// native .where() predicate pushdown (id IN (...)) rather than fetching a
// large candidate pool and post-filtering in JS, which would not scale to
// notebooks with many sources or a large overall neuron count.
export async function searchNeuronsByIds(lancedbPath, vector, ids, { limit = 8, threshold = 0.0 } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const table = await getTable(lancedbPath);
  if (!table) return [];

  const idList = ids.map(id => `'${escapeSqlString(id)}'`).join(',');
  const rawResults = await table.search(vector).where(`id IN (${idList})`).limit(limit).toArray();

  return rawResults
    .map((row) => {
      const distance = typeof row._distance === 'number' ? row._distance : (typeof row.distance === 'number' ? row.distance : 1);
      const score    = Number.isFinite(distance) ? Math.max(0, Math.min(1, 1 - distance)) : 0;
      return {
        id:              row.id,
        title:           row.title ?? '',
        kind:            row.kind ?? 'note',
        content:         row.content ?? '',
        content_preview: row.content_preview ?? createPreview(row.content ?? ''),
        metadata:        (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })(),
        score,
      };
    })
    .filter((row) => row.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Fetches full neuron rows (content included) for a specific set of ids —
// used when the notebook needs the actual text of its sources (e.g.
// building a hierarchical summary from all sources, not just top-k RAG
// hits). Uses the same id-list where() pushdown as searchNeuronsByIds.
export async function getNeuronsByIds(lancedbPath, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const table = await getTable(lancedbPath);
  if (!table) return [];

  const idList = ids.map(id => `'${escapeSqlString(id)}'`).join(',');
  const rows = typeof table.query === 'function'
    ? await table.query().where(`id IN (${idList})`).toArray()
    : (await table.search().limit(100000).toArray()).filter(row => ids.includes(row.id));

  return rows.map(row => ({
    id:              String(row.id ?? ''),
    title:           String(row.title ?? ''),
    kind:            String(row.kind ?? 'note'),
    content:         String(row.content ?? ''),
    content_preview: String(row.content_preview ?? ''),
    metadata:        (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })(),
  }));
}

export async function getAllNeurons(lancedbPath) {
  const table = await getTable(lancedbPath);
  if (!table) return [];
  try {
    const rows = typeof table.query === 'function'
      ? await table.query().toArray()
      : await table.search().limit(100000).toArray();
    return rows.map(row => ({
      id:              String(row.id ?? ''),
      title:           String(row.title ?? ''),
      kind:            String(row.kind ?? 'note'),
      content:         String(row.content ?? ''),
      content_preview: String(row.content_preview ?? ''),
      metadata:        (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })(),
    }));
  } catch {
    return [];
  }
}

export async function getTableStatus(lancedbPath) {
  try {
    const table = await getTable(lancedbPath);
    if (!table) return { connected: true, hasTable: false, neuronsCount: 0 };
    const neuronsCount = await countNeurons(lancedbPath);
    return { connected: true, hasTable: true, neuronsCount };
  } catch (error) {
    return { connected: false, hasTable: false, neuronsCount: 0, error: 'Index vectoriel inaccessible.' }; // [SEC-REMED-4B] store text (paths) untrusted
  }
}

export async function getAllNeuronsForBackup(lancedbPath) {
  const table = await getTable(lancedbPath);
  if (!table) return [];
  const rows = typeof table.query === 'function'
    ? await table.query().toArray()
    : await table.search().limit(100000).toArray();
  return rows.map(row => ({
    id:       String(row.id ?? ''),
    kind:     String(row.kind ?? 'note'),
    title:    String(row.title ?? ''),
    content:  String(row.content ?? ''),
    metadata: (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })(),
  }));
}

export async function getNeuronById(lancedbPath, id) {
  const table = await getTable(lancedbPath);
  if (!table) return null;
  const rows = await table.search().limit(100000).toArray();
  return rows.find((row) => row.id === id) ?? null;
}

// ── Notebook document chunk vectors (NB-2) ──────────────────────────────────
// Same LanceDB database as `neurons`, separate table `notebook_chunks`. Rows
// carry ids only (no text) — chunk text/metadata live in SQLite (nb_chunks),
// which is the single source of truth. Every search is pushed down with a
// notebook_id predicate so retrieval can never cross notebooks.
const CHUNK_TABLE_NAME = 'notebook_chunks';
async function getChunkTable(lancedbPath) {
  return getVectorTable(lancedbPath, CHUNK_TABLE_NAME);
}

export async function upsertChunkVectors(lancedbPath, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const clean = rows.map(r => ({
    chunk_id: String(r.chunk_id),
    notebook_id: String(r.notebook_id),
    source_id: String(r.source_id),
    version_id: String(r.version_id),
    vector: r.vector,
  }));
  for (const row of clean) validateVector(row.vector);
  const dimensions = clean[0].vector.length;
  if (clean.some(row => row.vector.length !== dimensions)) throw new Error('LanceDB vector dimension mismatch within batch');
  const { table, created } = await getOrCreateVectorTable(lancedbPath, CHUNK_TABLE_NAME, clean);
  if (created) return clean.length;
  await validateDimensions(table, clean);
  await table.mergeInsert('chunk_id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(clean);
  return clean.length;
}

export async function searchChunkVectors(lancedbPath, vector, { notebookId, sourceIds = null, limit = 20 } = {}) {
  if (!notebookId) return [];
  const table = await getChunkTable(lancedbPath);
  if (!table) return [];
  let where = `notebook_id = '${escapeSqlString(notebookId)}'`;
  if (Array.isArray(sourceIds)) {
    if (sourceIds.length === 0) return [];
    where += ` AND source_id IN (${sourceIds.map(id => `'${escapeSqlString(id)}'`).join(',')})`;
  }
  // Cosine distance: score = 1 - distance = cosine similarity (embeddings are unit-normalised).
  const rows = await table.search(vector).distanceType('cosine').where(where).limit(limit).toArray();
  return rows.map(row => {
    const distance = typeof row._distance === 'number' ? row._distance : 1;
    return {
      chunk_id: row.chunk_id,
      notebook_id: row.notebook_id,
      source_id: row.source_id,
      version_id: row.version_id,
      // Same convention as searchNeurons/searchNeuronsByIds: score = clamp(1 - distance).
      score: Number.isFinite(distance) ? Math.max(0, Math.min(1, 1 - distance)) : 0,
    };
  });
}

// Delete by exact chunk ids, or by (notebookId[, sourceId[, versionId]]).
export async function deleteChunkVectors(lancedbPath, { chunkIds, notebookId, sourceId, versionId } = {}) {
  const table = await getChunkTable(lancedbPath);
  if (!table) return;
  const q = v => `'${escapeSqlString(v)}'`;
  if (Array.isArray(chunkIds)) {
    for (let i = 0; i < chunkIds.length; i += 200) {
      await table.delete(`chunk_id IN (${chunkIds.slice(i, i + 200).map(q).join(',')})`);
    }
    return;
  }
  const parts = [];
  if (notebookId) parts.push(`notebook_id = ${q(notebookId)}`);
  if (sourceId) parts.push(`source_id = ${q(sourceId)}`);
  if (versionId) parts.push(`version_id = ${q(versionId)}`);
  if (parts.length === 0) return; // never delete everything by accident
  await table.delete(parts.join(' AND '));
}

// ── NB-5 Docteur Memory vectors ─────────────────────────────────────────────
// Same LanceDB database, table `docteur_memory` (ids + scope columns only; the statement lives in SQLite).
// Scope predicates are pushed down so a query can never even see another project's / notebook's vectors.
const MEMORY_TABLE_NAME = 'docteur_memory';
async function getMemoryTable(lancedbPath) {
  return getVectorTable(lancedbPath, MEMORY_TABLE_NAME);
}
export async function upsertMemoryVectors(lancedbPath, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const clean = rows.map(r => ({ memory_id: String(r.memory_id), scope_kind: String(r.scope_kind), project_id: String(r.project_id ?? ''), notebook_id: String(r.notebook_id ?? ''), vector: r.vector }));
  for (const row of clean) validateVector(row.vector);
  const dimensions = clean[0].vector.length;
  if (clean.some(row => row.vector.length !== dimensions)) throw new Error('LanceDB vector dimension mismatch within batch');
  const { table, created } = await getOrCreateVectorTable(lancedbPath, MEMORY_TABLE_NAME, clean);
  if (created) return clean.length;
  await validateDimensions(table, clean);
  await table.mergeInsert('memory_id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(clean);
  return clean.length;
}
// scopes: { projectId?, notebookId? } — GLOBAL always visible; PROJECT only for that project; NOTEBOOK only for that notebook.
export async function searchMemoryVectors(lancedbPath, vector, { scopes = {}, limit = 20 } = {}) {
  const table = await getMemoryTable(lancedbPath);
  if (!table) return [];
  const q = (v) => `'${escapeSqlString(v)}'`;
  const parts = [`scope_kind = 'GLOBAL'`];
  if (scopes.projectId) parts.push(`(scope_kind = 'PROJECT' AND project_id = ${q(scopes.projectId)})`);
  if (scopes.notebookId) parts.push(`(scope_kind = 'NOTEBOOK' AND notebook_id = ${q(scopes.notebookId)})`);
  const rows = await table.search(vector).distanceType('cosine').where(parts.join(' OR ')).limit(limit).toArray();
  return rows.map(r => ({ memory_id: r.memory_id, scope_kind: r.scope_kind, project_id: r.project_id, notebook_id: r.notebook_id, score: Number.isFinite(r._distance) ? Math.max(0, Math.min(1, 1 - r._distance)) : 0 }));
}
export async function deleteMemoryVectors(lancedbPath, memoryIds) {
  const table = await getMemoryTable(lancedbPath);
  if (!table || !Array.isArray(memoryIds) || memoryIds.length === 0) return;
  for (let i = 0; i < memoryIds.length; i += 200) await table.delete(`memory_id IN (${memoryIds.slice(i, i + 200).map(id => `'${escapeSqlString(id)}'`).join(',')})`);
}
