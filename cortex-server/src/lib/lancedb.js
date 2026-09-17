import fs from 'node:fs';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';

const TABLE_NAME = 'neurons';

let database;
let tablePromise;
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
  if (!database) {
    ensureParentDir(getDataDirectory(lancedbPath));
    database = await connect(path.resolve(lancedbPath));
  }
  return database;
}

async function getTable(lancedbPath) {
  const db = await ensureDatabase(lancedbPath);

  if (!tablePromise) {
    tablePromise = db.openTable(TABLE_NAME).catch(async () => null);
  }

  const existingTable = await tablePromise;
  if (existingTable) return existingTable;
  return null;
}

async function createTable(lancedbPath, row) {
  const db    = await ensureDatabase(lancedbPath);
  const table = await db.createTable(TABLE_NAME, [row]);
  tablePromise = Promise.resolve(table);
  return table;
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

  let table;
  try {
    table = await getTable(lancedbPath);
  } catch (err) {
    throw new Error(`LanceDB getTable failed: ${err.message}`);
  }

  if (!table) {
    // First-ever insert — creates the table schema from this row
    try {
      await createTable(lancedbPath, row);
      return row;
    } catch (err) {
      throw new Error(`LanceDB createTable failed: ${err.message}\nRow keys: ${Object.keys(row).join(', ')}\nVector dim: ${row.vector?.length ?? 'none'}`);
    }
  }

  // mergeInsert is ~48× faster than delete+add (no full-scan delete, single write).
  try {
    await table.mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([row]);
    tablePromise = Promise.resolve(table);
    return row;
  } catch (err) {
    // Schema mismatch or mergeInsert not supported — fall back to delete+add
    console.warn(`[LanceDB] mergeInsert failed (${err.message}), falling back to delete+add`);
    try { await table.delete(`id = '${escapeSqlString(row.id)}'`); } catch { /* row may not exist */ }
    try {
      await table.add([row]);
      tablePromise = Promise.resolve(table);
      return row;
    } catch (addErr) {
      throw new Error(
        `LanceDB table.add failed — possible schema mismatch.\n` +
        `Error: ${addErr.message}\n` +
        `Hint: delete data/cortex.lance and restart the server to reset the schema.`
      );
    }
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
    return { connected: false, hasTable: false, neuronsCount: 0, error: error.message };
  }
}

export async function getAllNeuronsForBackup(lancedbPath) {
  const table = await getTable(lancedbPath);
  if (!table) return [];
  try {
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
  } catch {
    return [];
  }
}

export async function getNeuronById(lancedbPath, id) {
  const table = await getTable(lancedbPath);
  if (!table) return null;
  const rows = await table.search().limit(100000).toArray();
  return rows.find((row) => row.id === id) ?? null;
}
