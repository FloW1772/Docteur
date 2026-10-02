// Notebook NB-2 — SQLite persistence for raw documents (same database as the
// rest of Docteur; additive, non-destructive migration: CREATE ... IF NOT
// EXISTS only, no existing table is altered or dropped).
//
// Tables:
//   nb_documents          Document (currentVersionId, status, trust, retention …)
//   nb_document_versions  DocumentVersion (file hash, import time, source meta)
//   nb_chunks             Chunk (text, page, headingPath, offsets, hash, version)
//   nb_chunks_fts         SQLite FTS5 index — ONLY current-version chunks
//   nb_chunk_embeddings   embedding metadata (provider/model/dimension/hash);
//                         the vectors themselves live in LanceDB `notebook_chunks`
//
// Chunk text is the single source of truth here. Superseded versions keep their
// nb_chunks rows (so an old citation still resolves and is shown as
// superseded) but lose their FTS rows and vectors, so they are never retrieved.

import crypto from 'node:crypto';
import { getDatabase } from './sqlite.js';
import { ensureAiHistorySchema, purgeAiImportRows } from './notebook-ai-schema.js';
import { ensureMemorySchema, markMemoryEvidenceMissing } from './notebook-memory-schema.js';

export function ensureNotebookDocsSchema(db = getDatabase()) {
  if (!db) throw new Error('SQLite non initialisé');
  db.exec(`
    CREATE TABLE IF NOT EXISTS nb_documents (
      document_id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      source_row_id TEXT,
      name_key TEXT NOT NULL,
      title TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      hash TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      language TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      current_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      retention TEXT NOT NULL DEFAULT 'KEEP',
      origin TEXT NOT NULL DEFAULT 'file',
      canonical_uri TEXT,
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_nb_documents_notebook ON nb_documents(notebook_id);
    CREATE INDEX IF NOT EXISTS idx_nb_documents_hash ON nb_documents(notebook_id, hash);

    CREATE TABLE IF NOT EXISTS nb_document_versions (
      version_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      notebook_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      file_hash TEXT NOT NULL,
      text_hash TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL,
      source_meta TEXT NOT NULL DEFAULT '{}',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      error_code TEXT,
      is_current INTEGER NOT NULL DEFAULT 0,
      vector_status TEXT NOT NULL DEFAULT 'NONE'
    );
    CREATE INDEX IF NOT EXISTS idx_nb_versions_document ON nb_document_versions(document_id);

    CREATE TABLE IF NOT EXISTS nb_chunks (
      chunk_id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      heading_path TEXT NOT NULL DEFAULT '[]',
      page INTEGER,
      start_offset INTEGER,
      end_offset INTEGER,
      hash TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      injection_flags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nb_chunks_notebook ON nb_chunks(notebook_id, is_current);
    CREATE INDEX IF NOT EXISTS idx_nb_chunks_document ON nb_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_nb_chunks_version ON nb_chunks(version_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS nb_chunks_fts USING fts5(
      text, title, heading, source_name,
      chunk_id UNINDEXED, notebook_id UNINDEXED, document_id UNINDEXED, version_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS nb_chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nb_embeddings_notebook ON nb_chunk_embeddings(notebook_id);
  `);
  // NB-3 additive columns (guarded: never altered twice, never destructive).
  ensureAiHistorySchema(db); // NB-4 (additive)
  ensureMemorySchema(db); // NB-5 (additive)
  addColumnIfMissing(db, 'nb_documents', 'expires_at', 'TEXT');
  addColumnIfMissing(db, 'nb_documents', 'session_id', 'TEXT');
  addColumnIfMissing(db, 'nb_chunk_embeddings', 'embed_version', "TEXT NOT NULL DEFAULT 'raw-v0'");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nb_documents_expiry ON nb_documents(expires_at) WHERE expires_at IS NOT NULL;
           CREATE INDEX IF NOT EXISTS idx_nb_documents_retention ON nb_documents(retention);`);
}

function addColumnIfMissing(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export const TRUST_LEVELS = Object.freeze(['USER_AUTHORED', 'PRIMARY_SOURCE', 'VERIFIED_EXTERNAL', 'SECONDARY_SOURCE', 'PAST_AI_OUTPUT', 'UNVERIFIED_WEB', 'TOOL_RESULT', 'UNKNOWN']);
export const RETENTION_POLICIES = Object.freeze(['KEEP', 'MANUAL', 'DELETE_AFTER', 'SESSION_ONLY']);

const now = () => new Date().toISOString();
export const newDocumentId = () => `ndoc-${crypto.randomUUID()}`;
export const newVersionId = () => `nver-${crypto.randomUUID()}`;

const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

function docRow(r) {
  if (!r) return null;
  return {
    documentId: r.document_id, notebookId: r.notebook_id, sourceRowId: r.source_row_id, sourceId: r.document_id,
    title: r.title, mimeType: r.mime_type, hash: r.hash, size: r.size, language: r.language,
    createdAt: r.created_at, updatedAt: r.updated_at, currentVersionId: r.current_version_id,
    status: r.status, trustLevel: r.trust_level, retention: r.retention, origin: r.origin,
    canonicalUri: r.canonical_uri, errorCode: r.error_code, nameKey: r.name_key,
    expiresAt: r.expires_at ?? null, sessionId: r.session_id ?? null,
  };
}

function versionRow(r) {
  if (!r) return null;
  return {
    versionId: r.version_id, documentId: r.document_id, notebookId: r.notebook_id, versionNo: r.version_no,
    fileHash: r.file_hash, textHash: r.text_hash, size: r.size, importedAt: r.imported_at,
    sourceMeta: parseJson(r.source_meta, {}), chunkCount: r.chunk_count, status: r.status,
    errorCode: r.error_code, isCurrent: r.is_current === 1, vectorStatus: r.vector_status,
  };
}

function chunkRow(r) {
  if (!r) return null;
  return {
    chunkId: r.chunk_id, notebookId: r.notebook_id, documentId: r.document_id, sourceId: r.document_id,
    versionId: r.version_id, documentVersion: r.version_no, ordinal: r.ordinal, text: r.text,
    headingPath: parseJson(r.heading_path, []), page: r.page, startOffset: r.start_offset, endOffset: r.end_offset,
    hash: r.hash, isCurrent: r.is_current === 1, trustLevel: r.trust_level,
    injectionFlags: parseJson(r.injection_flags, []),
    aiConversationId: r.ai_conversation_id ?? null, aiProvider: r.ai_provider ?? null, aiRole: r.ai_role ?? null,
    aiMessageIds: r.ai_message_ids ? parseJson(r.ai_message_ids, []) : null, aiTs: r.ai_ts ?? null, aiBranch: r.ai_branch === 1, aiLangs: r.ai_langs ? parseJson(r.ai_langs, []) : null,
  };
}

// ── Documents / versions ────────────────────────────────────────────────────
export function insertDocument(d) {
  const db = getDatabase();
  const t = now();
  db.prepare(`INSERT INTO nb_documents (document_id, notebook_id, source_row_id, name_key, title, mime_type, hash, size, language,
      created_at, updated_at, current_version_id, status, trust_level, retention, origin, canonical_uri, error_code, expires_at, session_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(d.documentId, d.notebookId, d.sourceRowId ?? null, d.nameKey, d.title, d.mimeType ?? '', d.hash ?? '', d.size ?? 0, d.language ?? null,
      t, t, null, d.status ?? 'QUEUED', d.trustLevel ?? 'UNKNOWN', d.retention ?? 'KEEP', d.origin ?? 'file', d.canonicalUri ?? null, null,
      d.expiresAt ?? null, d.sessionId ?? null);
}

export function updateDocument(documentId, fields) {
  const map = { status: 'status', errorCode: 'error_code', title: 'title', language: 'language', hash: 'hash', size: 'size',
    currentVersionId: 'current_version_id', mimeType: 'mime_type', trustLevel: 'trust_level', sourceRowId: 'source_row_id',
    retention: 'retention', expiresAt: 'expires_at', sessionId: 'session_id' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  if (!sets.length) return;
  sets.push('updated_at = ?'); vals.push(now());
  getDatabase().prepare(`UPDATE nb_documents SET ${sets.join(', ')} WHERE document_id = ?`).run(...vals, documentId);
}

export function getDocument(documentId) {
  return docRow(getDatabase().prepare('SELECT * FROM nb_documents WHERE document_id = ?').get(documentId));
}

// origin 'ai_history' rows are imports of AI histories: they are NOT ordinary documents and never show in the Documents list.
export function listDocuments(notebookId, { limit = 200, offset = 0, includeAiHistory = false } = {}) {
  return getDatabase().prepare(`SELECT * FROM nb_documents WHERE notebook_id = ? AND (? OR origin != 'ai_history') ORDER BY updated_at DESC, document_id LIMIT ? OFFSET ?`)
    .all(notebookId, includeAiHistory ? 1 : 0, limit, offset).map(docRow);
}

// Trust level is METADATA (labelling + optional retrieval filter). It never
// grants or removes any permission; document and chunk copies stay in sync.
export function setTrustLevel(documentId, trustLevel) {
  if (!TRUST_LEVELS.includes(trustLevel)) throw new Error(`trust level invalide: ${trustLevel}`);
  const db = getDatabase();
  db.transaction(() => {
    db.prepare('UPDATE nb_documents SET trust_level = ?, updated_at = ? WHERE document_id = ?').run(trustLevel, now(), documentId);
    db.prepare('UPDATE nb_chunks SET trust_level = ? WHERE document_id = ?').run(trustLevel, documentId);
  })();
}

// Retention sweeps: bounded, indexed lookups.
export function listExpiredDocuments(nowIso, limit = 50) {
  return getDatabase().prepare(`SELECT * FROM nb_documents WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`)
    .all(nowIso, limit).map(docRow);
}
export function listStaleSessionDocuments(currentSessionId, limit = 200) {
  return getDatabase().prepare(`SELECT * FROM nb_documents WHERE retention = 'SESSION_ONLY' AND (session_id IS NULL OR session_id != ?) LIMIT ?`)
    .all(currentSessionId, limit).map(docRow);
}

// Documents (ids) of a notebook matching a trust filter — used as a retrieval pushdown.
export function listDocumentIdsByTrust(notebookId, trustLevels) {
  const db = getDatabase();
  return db.prepare(`SELECT document_id FROM nb_documents WHERE notebook_id = ? AND trust_level IN (${trustLevels.map(() => '?').join(',')})`)
    .all(notebookId, ...trustLevels).map(r => r.document_id);
}

export function countDocuments(notebookId) {
  return getDatabase().prepare("SELECT COUNT(*) n FROM nb_documents WHERE notebook_id = ? AND origin != 'ai_history'").get(notebookId).n;
}

export function findDocumentByCurrentHash(notebookId, fileHash) {
  return docRow(getDatabase().prepare(`SELECT d.* FROM nb_documents d JOIN nb_document_versions v ON v.version_id = d.current_version_id
    WHERE d.notebook_id = ? AND v.file_hash = ? AND v.is_current = 1 AND v.status = 'READY' LIMIT 1`).get(notebookId, fileHash));
}

export function findDocumentByName(notebookId, nameKey) {
  return docRow(getDatabase().prepare('SELECT * FROM nb_documents WHERE notebook_id = ? AND name_key = ? LIMIT 1').get(notebookId, nameKey));
}

export function nextVersionNo(documentId) {
  return (getDatabase().prepare('SELECT COALESCE(MAX(version_no),0)+1 n FROM nb_document_versions WHERE document_id = ?').get(documentId).n);
}

export function insertVersion(v) {
  getDatabase().prepare(`INSERT INTO nb_document_versions (version_id, document_id, notebook_id, version_no, file_hash, text_hash, size,
      imported_at, source_meta, chunk_count, status, error_code, is_current, vector_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,'NONE')`)
    .run(v.versionId, v.documentId, v.notebookId, v.versionNo, v.fileHash, v.textHash ?? '', v.size ?? 0, now(),
      JSON.stringify(v.sourceMeta ?? {}), 0, v.status ?? 'QUEUED', null);
}

export function updateVersion(versionId, fields) {
  const map = { status: 'status', errorCode: 'error_code', textHash: 'text_hash', chunkCount: 'chunk_count', vectorStatus: 'vector_status' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  if ('sourceMeta' in fields) { sets.push('source_meta = ?'); vals.push(JSON.stringify(fields.sourceMeta ?? {})); }
  if (!sets.length) return;
  getDatabase().prepare(`UPDATE nb_document_versions SET ${sets.join(', ')} WHERE version_id = ?`).run(...vals, versionId);
}

export function getVersion(versionId) {
  return versionRow(getDatabase().prepare('SELECT * FROM nb_document_versions WHERE version_id = ?').get(versionId));
}

export function listVersions(documentId) {
  return getDatabase().prepare('SELECT * FROM nb_document_versions WHERE document_id = ? ORDER BY version_no DESC').all(documentId).map(versionRow);
}

// ── Chunks + FTS ────────────────────────────────────────────────────────────
function insertChunkRows(db, { doc, version, chunks, trustLevel }) {
  const ins = db.prepare(`INSERT INTO nb_chunks (chunk_id, notebook_id, document_id, version_id, version_no, ordinal, text, heading_path, page,
      start_offset, end_offset, hash, is_current, trust_level, injection_flags, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`);
  const fts = db.prepare(`INSERT INTO nb_chunks_fts (text, title, heading, source_name, chunk_id, notebook_id, document_id, version_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  const t = now();
  for (const c of chunks) {
    ins.run(c.chunkId, doc.notebookId, doc.documentId, version.versionId, version.versionNo, c.ordinal, c.text,
      JSON.stringify(c.headingPath ?? []), c.page ?? null, c.startOffset ?? null, c.endOffset ?? null, c.hash, trustLevel,
      JSON.stringify(c.injectionFlags ?? []), t);
    fts.run(c.text, doc.title, (c.headingPath ?? []).join(' > '), doc.title, c.chunkId, doc.notebookId, doc.documentId, version.versionId);
  }
}

// Atomically makes `version` the current one: flips the previous current
// version (and its chunks) to superseded, removes the superseded FTS rows and
// embedding metadata, inserts the new chunks + FTS rows. Returns the chunk
// ids of superseded versions so the caller can delete their vectors.
export function commitVersion({ doc, version, chunks, trustLevel, language }) {
  const db = getDatabase();
  let supersededChunkIds = [];
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM nb_documents WHERE document_id = ?').get(doc.documentId)) {
      const e = new Error('document supprimé pendant l\'import'); e.code = 'SOURCE_DELETED'; throw e; // no late chunk insertion
    }
    const prev = db.prepare('SELECT version_id FROM nb_document_versions WHERE document_id = ? AND is_current = 1').all(doc.documentId);
    for (const p of prev) {
      supersededChunkIds.push(...db.prepare('SELECT chunk_id FROM nb_chunks WHERE version_id = ?').all(p.version_id).map(r => r.chunk_id));
      // FTS rows of the superseded version are KEPT (explicit historical retrieval); default queries filter is_current = 1.
      db.prepare('UPDATE nb_chunks SET is_current = 0 WHERE version_id = ?').run(p.version_id);
      db.prepare('UPDATE nb_document_versions SET is_current = 0 WHERE version_id = ?').run(p.version_id);
    }
    if (supersededChunkIds.length) {
      for (let i = 0; i < supersededChunkIds.length; i += 500) {
        const part = supersededChunkIds.slice(i, i + 500);
        db.prepare(`DELETE FROM nb_chunk_embeddings WHERE chunk_id IN (${part.map(() => '?').join(',')})`).run(...part);
      }
    }
    insertChunkRows(db, { doc, version, chunks, trustLevel });
    db.prepare('UPDATE nb_document_versions SET is_current = 1, chunk_count = ?, status = ? WHERE version_id = ?')
      .run(chunks.length, 'READY', version.versionId);
    db.prepare('UPDATE nb_documents SET current_version_id = ?, hash = ?, size = ?, status = ?, error_code = NULL, language = COALESCE(?, language), updated_at = ? WHERE document_id = ?')
      .run(version.versionId, version.fileHash, version.size, 'READY', language ?? null, now(), doc.documentId);
  })();
  return { supersededChunkIds };
}

export function recordEmbeddings(rows) {
  const db = getDatabase();
  const ins = db.prepare(`INSERT OR REPLACE INTO nb_chunk_embeddings (chunk_id, notebook_id, provider, model, dimension, chunk_hash, created_at, embed_version)
    VALUES (?,?,?,?,?,?,?,?)`);
  db.transaction(() => { for (const r of rows) ins.run(r.chunkId, r.notebookId, r.provider, r.model, r.dimension, r.chunkHash, now(), r.embedVersion ?? 'raw-v0'); })();
}

export function deleteEmbeddingsForChunks(chunkIds) {
  const db = getDatabase();
  for (let i = 0; i < chunkIds.length; i += 500) {
    const part = chunkIds.slice(i, i + 500);
    db.prepare(`DELETE FROM nb_chunk_embeddings WHERE chunk_id IN (${part.map(() => '?').join(',')})`).run(...part);
  }
}

export function getEmbeddingMeta(chunkIds) {
  const db = getDatabase();
  const out = new Map();
  for (let i = 0; i < chunkIds.length; i += 500) {
    const part = chunkIds.slice(i, i + 500);
    for (const r of db.prepare(`SELECT * FROM nb_chunk_embeddings WHERE chunk_id IN (${part.map(() => '?').join(',')})`).all(...part)) {
      out.set(r.chunk_id, { provider: r.provider, model: r.model, dimension: r.dimension, chunkHash: r.chunk_hash, createdAt: r.created_at, embedVersion: r.embed_version });
    }
  }
  return out;
}

export function getCurrentChunksWithoutEmbedding(documentId) {
  return getDatabase().prepare(`SELECT c.* FROM nb_chunks c LEFT JOIN nb_chunk_embeddings e ON e.chunk_id = c.chunk_id
    WHERE c.document_id = ? AND c.is_current = 1 AND e.chunk_id IS NULL ORDER BY c.ordinal`).all(documentId).map(chunkRow);
}

// Builds an FTS5 MATCH expression from free text: tokens are quoted, so user
// input can never inject FTS operators/column filters.
export const STOPWORDS = new Set(('le la les l un une des du de d et ou en au aux ce ces cet cette son sa ses leur leurs mon ma mes ton ta tes ne pas par pour sur sous dans avec sans que qui quoi quel quelle quels quelles ' +
  'est sont etre ete etait ont avoir fait faire il elle ils elles on nous vous je tu y a se si mais donc or ni car comme plus moins tres aussi ' +
  'the a an and or of to in on at by for with without from is are was were be been being it its this that these those as if but not no do does did has have had can will would should ' +
  'what which who whom whose when where why how there their they them he she we you i my our your his her ' +
  'selon source sources concernant according regarding about avais avait avons avez') .split(/\s+/));

export function normalizeToken(t) {
  return String(t).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

// Content-bearing query terms (stopwords removed, accents stripped). Identifiers
// like "ERR-4021" become the terms err + 4021.
export function queryTerms(query) {
  const tokens = (normalizeToken(query).match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
  return [...new Set(tokens.filter(t => !STOPWORDS.has(t)))].slice(0, 24);
}

export function buildFtsQuery(query) {
  return queryTerms(query).map(t => `"${t}"`).join(' OR ');
}

// An AI-history import is searchable only once fully READY (never a partially imported history).
const visibilitySql = `(d.expires_at IS NULL OR d.expires_at > ?) AND (d.retention != 'SESSION_ONLY' OR d.session_id = ?) AND (d.origin != 'ai_history' OR d.status = 'READY')`;

// Scope + AI-history filters (SQL pushdown). Default scope 'documents' keeps every NB-2/NB-3 query
// byte-for-byte equivalent: AI-history chunks are never returned unless explicitly requested.
export function filterSql(filter = {}) {
  const scope = filter.scope ?? 'documents';
  const parts = []; const params = [];
  if (scope === 'documents') parts.push("d.origin != 'ai_history'");
  else if (scope === 'ai_history') parts.push("d.origin = 'ai_history'");
  const inList = (col, arr) => { if (Array.isArray(arr) && arr.length) { parts.push(`${col} IN (${arr.map(() => '?').join(',')})`); params.push(...arr); } };
  inList('c.ai_provider', filter.providers ?? (filter.provider ? [filter.provider] : null));
  inList('c.ai_role', filter.roles);
  inList('c.ai_conversation_id', filter.conversationIds);
  inList('c.document_id', filter.importIds);
  inList('c.trust_level', filter.trustLevels);
  if (filter.from) { parts.push('c.ai_ts >= ?'); params.push(filter.from); }
  if (filter.to) { parts.push('c.ai_ts <= ?'); params.push(filter.to); }
  if (filter.mainPathOnly) parts.push('c.ai_branch = 0');
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}
export function searchFts(notebookId, query, { limit = 30, documentIds = null, includeHistorical = false, sessionId = null, nowIso = now(), filter = {} } = {}) {
  const match = buildFtsQuery(query);
  if (!match) return [];
  const db = getDatabase();
  let sql = `SELECT c.*, d.title AS doc_title, bm25(nb_chunks_fts, 1.0, 2.0, 1.5, 0.5) AS bm25
      FROM nb_chunks_fts f
      JOIN nb_chunks c ON c.chunk_id = f.chunk_id
      JOIN nb_documents d ON d.document_id = c.document_id
      WHERE nb_chunks_fts MATCH ? AND f.notebook_id = ? AND c.notebook_id = ? AND d.notebook_id = ?
        AND (c.is_current = 1 OR ?) AND d.status != 'DELETED' AND ${visibilitySql}`;
  const params = [match, notebookId, notebookId, notebookId, includeHistorical ? 1 : 0, nowIso, sessionId];
  const fs_ = filterSql(filter); sql += fs_.sql; params.push(...fs_.params);
  if (Array.isArray(documentIds)) {
    if (documentIds.length === 0) return [];
    sql += ` AND c.document_id IN (${documentIds.map(() => '?').join(',')})`;
    params.push(...documentIds);
  }
  sql += ' ORDER BY bm25 LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(r => ({ ...chunkRow(r), bm25: r.bm25, title: r.doc_title }));
}

// Current, non-deleted chunk rows by id, restricted to the notebook.
export function getCurrentChunks(notebookId, chunkIds, { includeHistorical = false, sessionId = null, nowIso = now(), filter = {} } = {}) {
  const db = getDatabase();
  const out = [];
  const fsql = filterSql(filter);
  for (let i = 0; i < chunkIds.length; i += 500) {
    const part = chunkIds.slice(i, i + 500);
    out.push(...db.prepare(`SELECT c.*, d.title AS doc_title FROM nb_chunks c JOIN nb_documents d ON d.document_id = c.document_id
      WHERE c.notebook_id = ? AND d.notebook_id = ? AND (c.is_current = 1 OR ?) AND d.status != 'DELETED' AND ${visibilitySql}${fsql.sql}
        AND c.chunk_id IN (${part.map(() => '?').join(',')})`).all(notebookId, notebookId, includeHistorical ? 1 : 0, nowIso, sessionId, ...fsql.params, ...part).map(r => ({ ...chunkRow(r), title: r.doc_title })));
  }
  return out;
}

// Any version (current or superseded) — for citation resolution only.
export function getChunkAnyVersion(notebookId, chunkId) {
  return chunkRow(getDatabase().prepare('SELECT * FROM nb_chunks WHERE notebook_id = ? AND chunk_id = ?').get(notebookId, chunkId));
}

// ── Purge ───────────────────────────────────────────────────────────────────
// Removes every trace of a document from SQLite. Returns { chunkIds } so the
// caller can delete vectors from LanceDB.
export function purgeDocumentRows(documentId) {
  const db = getDatabase();
  let chunkIds = [];
  db.transaction(() => {
    chunkIds = db.prepare('SELECT chunk_id FROM nb_chunks WHERE document_id = ?').all(documentId).map(r => r.chunk_id);
    db.prepare('DELETE FROM nb_chunks_fts WHERE document_id = ?').run(documentId);
    deleteEmbeddingsForChunks(chunkIds);
    db.prepare('DELETE FROM nb_chunks WHERE document_id = ?').run(documentId);
    db.prepare('DELETE FROM nb_document_versions WHERE document_id = ?').run(documentId);
    markMemoryEvidenceMissing(db, documentId); // NB-5: approved memories keep living, their evidence link becomes SOURCE_MISSING
    purgeAiImportRows(db, documentId); // NB-4: conversations, messages, attachments, candidate evidence (no-op for ordinary documents)
    db.prepare('DELETE FROM nb_documents WHERE document_id = ?').run(documentId);
  })();
  return { chunkIds };
}

// Removes ONE version. If it was current, the newest remaining READY version
// becomes current again (its chunks are re-indexed in FTS); returns
// { chunkIds, promotedVersionId, documentDeleted }.
export function purgeVersionRows(documentId, versionId) {
  const db = getDatabase();
  let result = { chunkIds: [], promotedVersionId: null, documentDeleted: false };
  db.transaction(() => {
    const v = db.prepare('SELECT * FROM nb_document_versions WHERE version_id = ? AND document_id = ?').get(versionId, documentId);
    if (!v) return;
    result.chunkIds = db.prepare('SELECT chunk_id FROM nb_chunks WHERE version_id = ?').all(versionId).map(r => r.chunk_id);
    db.prepare('DELETE FROM nb_chunks_fts WHERE version_id = ?').run(versionId);
    deleteEmbeddingsForChunks(result.chunkIds);
    db.prepare('DELETE FROM nb_chunks WHERE version_id = ?').run(versionId);
    db.prepare('DELETE FROM nb_document_versions WHERE version_id = ?').run(versionId);
    if (v.is_current !== 1) return;
    const next = db.prepare(`SELECT * FROM nb_document_versions WHERE document_id = ? AND status = 'READY' ORDER BY version_no DESC LIMIT 1`).get(documentId);
    if (!next) {
      db.prepare('DELETE FROM nb_documents WHERE document_id = ?').run(documentId);
      db.prepare('DELETE FROM nb_document_versions WHERE document_id = ?').run(documentId);
      result.documentDeleted = true;
      return;
    }
    const doc = db.prepare('SELECT * FROM nb_documents WHERE document_id = ?').get(documentId);
    db.prepare('UPDATE nb_document_versions SET is_current = 1 WHERE version_id = ?').run(next.version_id);
    db.prepare('UPDATE nb_chunks SET is_current = 1 WHERE version_id = ?').run(next.version_id);
    db.prepare('DELETE FROM nb_chunks_fts WHERE version_id = ?').run(next.version_id); // rebuild (rows may pre-exist)
    const fts = db.prepare(`INSERT INTO nb_chunks_fts (text, title, heading, source_name, chunk_id, notebook_id, document_id, version_id) VALUES (?,?,?,?,?,?,?,?)`);
    for (const c of db.prepare('SELECT * FROM nb_chunks WHERE version_id = ?').all(next.version_id)) {
      fts.run(c.text, doc.title, parseJson(c.heading_path, []).join(' > '), doc.title, c.chunk_id, c.notebook_id, c.document_id, c.version_id);
    }
    db.prepare('UPDATE nb_documents SET current_version_id = ?, hash = ?, size = ?, updated_at = ? WHERE document_id = ?')
      .run(next.version_id, next.file_hash, next.size, now(), documentId);
    result.promotedVersionId = next.version_id;
  })();
  return result;
}

export function listDocumentIds(notebookId) {
  return getDatabase().prepare('SELECT document_id FROM nb_documents WHERE notebook_id = ?').all(notebookId).map(r => r.document_id);
}

// Compatibility report of current chunks vs the active embedding configuration.
// compatible = embedded with the same provider + model + dimension + embed version;
// incompatible = embedded with something else (never compared, needs explicit reindex);
// missing = no embedding at all (FTS-only until embedded).
export function vectorStatusCounts(notebookId, { provider, model, embedVersion, dimension = null, sessionId = null, nowIso = now() }) {
  const db = getDatabase();
  const row = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN e.chunk_id IS NULL THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN e.chunk_id IS NOT NULL AND e.provider = ? AND e.model = ? AND e.embed_version = ? AND (? IS NULL OR e.dimension = ?) THEN 1 ELSE 0 END) AS compatible
    FROM nb_chunks c JOIN nb_documents d ON d.document_id = c.document_id
    LEFT JOIN nb_chunk_embeddings e ON e.chunk_id = c.chunk_id
    WHERE c.notebook_id = ? AND c.is_current = 1 AND ${visibilitySql}`).get(provider, model, embedVersion, dimension, dimension, notebookId, nowIso, sessionId);
  const total = row.total ?? 0; const missing = row.missing ?? 0; const compatible = row.compatible ?? 0;
  return { total, missing, compatible, incompatible: total - missing - compatible };
}

export function getCurrentChunkRows(documentId) {
  return getDatabase().prepare('SELECT * FROM nb_chunks WHERE document_id = ? AND is_current = 1 ORDER BY ordinal').all(documentId).map(chunkRow);
}

export function getVersionImportedAt(versionId) {
  return getDatabase().prepare('SELECT imported_at FROM nb_document_versions WHERE version_id = ?').get(versionId)?.imported_at ?? null;
}
