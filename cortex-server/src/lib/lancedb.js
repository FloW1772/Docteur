import fs from 'node:fs';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';

const TABLE_NAME = 'neurons';

let database;
let tablePromise;

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
  const table = await getTable(lancedbPath);
  if (!table) return { skipped: true };
  const before = await table.stats();
  await table.optimize({ cleanupOlderThan: new Date(0) });
  const after = await table.stats();
  return {
    before: { fragments: before.fragmentStats.numFragments, rows: before.numRows },
    after:  { fragments: after.fragmentStats.numFragments,  rows: after.numRows },
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
