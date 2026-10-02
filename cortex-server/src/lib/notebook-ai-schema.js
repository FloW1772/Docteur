// Notebook NB-4 — SQLite schema for imported AI histories (additive, idempotent,
// non-destructive: CREATE ... IF NOT EXISTS and guarded ADD COLUMN only).
// No imports on purpose: called from notebook-docs-store.ensureNotebookDocsSchema().
//
//   nb_ai_imports         one row per import (its id == its nb_documents.document_id,
//                         so retention / visibility / purge reuse the NB-3 machinery)
//   nb_ai_conversations   normalised conversations (deterministic ids ⇒ natural dedup)
//   nb_ai_messages        normalised messages, roles preserved, parent links kept (branches)
//   nb_ai_attachments     attachment REFERENCES (never file contents, never a filesystem path)
//   nb_ai_candidates      distilled memory CANDIDATES (Notebook-scoped, never global memory)
//   nb_ai_candidate_evidence / nb_ai_candidate_links   evidence links + possible supersessions
//   nb_chunks.ai_*        provenance columns for conversation segments

function addColumnIfMissing(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function ensureAiHistorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nb_ai_imports (
      import_id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'UNKNOWN',
      adapter TEXT NOT NULL DEFAULT '',
      provider_verified INTEGER NOT NULL DEFAULT 0,
      source_name TEXT NOT NULL DEFAULT '',
      file_hash TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      distill_status TEXT NOT NULL DEFAULT 'NONE',
      error_code TEXT,
      secret_policy TEXT NOT NULL DEFAULT 'block',
      counts TEXT NOT NULL DEFAULT '{}',
      findings TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nb_ai_imports_nb ON nb_ai_imports(notebook_id);
    CREATE INDEX IF NOT EXISTS idx_nb_ai_imports_hash ON nb_ai_imports(notebook_id, file_hash);

    CREATE TABLE IF NOT EXISTS nb_ai_conversations (
      conversation_id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      import_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'UNKNOWN',
      provider_verified INTEGER NOT NULL DEFAULT 0,
      external_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      updated_at TEXT,
      source_hash TEXT NOT NULL DEFAULT '',
      language TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      message_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      current_node TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_nb_ai_conv_nb ON nb_ai_conversations(notebook_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_nb_ai_conv_import ON nb_ai_conversations(import_id);

    CREATE TABLE IF NOT EXISTS nb_ai_messages (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      notebook_id TEXT NOT NULL,
      import_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT,
      provider TEXT NOT NULL DEFAULT 'UNKNOWN',
      original_id TEXT,
      parent_id TEXT,
      original_parent_id TEXT,
      content_type TEXT NOT NULL DEFAULT 'text',
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      source_hash TEXT NOT NULL DEFAULT '',
      ordinal INTEGER NOT NULL DEFAULT 0,
      on_main_path INTEGER NOT NULL DEFAULT 1,
      is_current INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT,
      code_langs TEXT NOT NULL DEFAULT '[]',
      flags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_nb_ai_msg_conv ON nb_ai_messages(conversation_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_nb_ai_msg_import ON nb_ai_messages(import_id);
    CREATE INDEX IF NOT EXISTS idx_nb_ai_msg_nb ON nb_ai_messages(notebook_id);

    CREATE TABLE IF NOT EXISTS nb_ai_attachments (
      attachment_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      notebook_id TEXT NOT NULL,
      import_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL DEFAULT '',
      size INTEGER,
      status TEXT NOT NULL DEFAULT 'MISSING',
      reason TEXT,
      indexed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_nb_ai_att_msg ON nb_ai_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_nb_ai_att_import ON nb_ai_attachments(import_id);

    CREATE TABLE IF NOT EXISTS nb_ai_candidates (
      candidate_id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      type TEXT NOT NULL,
      statement TEXT NOT NULL,
      norm_key TEXT NOT NULL,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      assertion_type TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'CANDIDATE',
      method TEXT NOT NULL DEFAULT 'rule',
      stated_at TEXT,
      last_evidence_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      edited INTEGER NOT NULL DEFAULT 0,
      orphaned INTEGER NOT NULL DEFAULT 0,
      promotion TEXT NOT NULL DEFAULT 'NONE'
    );
    CREATE INDEX IF NOT EXISTS idx_nb_ai_cand_nb ON nb_ai_candidates(notebook_id, status);
    CREATE INDEX IF NOT EXISTS idx_nb_ai_cand_key ON nb_ai_candidates(notebook_id, type, norm_key);

    CREATE TABLE IF NOT EXISTS nb_ai_candidate_evidence (
      candidate_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      import_id TEXT NOT NULL,
      role TEXT NOT NULL,
      quote TEXT NOT NULL DEFAULT '',
      ts TEXT,
      PRIMARY KEY (candidate_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_nb_ai_ev_import ON nb_ai_candidate_evidence(import_id);
    CREATE INDEX IF NOT EXISTS idx_nb_ai_ev_msg ON nb_ai_candidate_evidence(message_id);

    CREATE TABLE IF NOT EXISTS nb_ai_candidate_links (
      candidate_id TEXT NOT NULL,
      related_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ambiguous INTEGER NOT NULL DEFAULT 1,
      detail TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (candidate_id, related_id, kind)
    );
  `);
  // provenance columns on the existing chunk table (NULL for ordinary document chunks)
  addColumnIfMissing(db, 'nb_chunks', 'ai_conversation_id', 'TEXT');
  addColumnIfMissing(db, 'nb_chunks', 'ai_provider', 'TEXT');
  addColumnIfMissing(db, 'nb_chunks', 'ai_role', 'TEXT');
  addColumnIfMissing(db, 'nb_chunks', 'ai_message_ids', 'TEXT');
  addColumnIfMissing(db, 'nb_chunks', 'ai_ts', 'TEXT');
  addColumnIfMissing(db, 'nb_chunks', 'ai_branch', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'nb_chunks', 'ai_langs', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nb_chunks_ai_conv ON nb_chunks(ai_conversation_id) WHERE ai_conversation_id IS NOT NULL;
           CREATE INDEX IF NOT EXISTS idx_nb_chunks_ai_ts ON nb_chunks(ai_ts) WHERE ai_ts IS NOT NULL;`);
}

// Cascade used by purgeDocumentRows (import id == document id). Runs inside the caller's transaction.
export function purgeAiImportRows(db, importId, { keepImportRow = false } = {}) {
  const touched = db.prepare('SELECT DISTINCT conversation_id FROM nb_ai_messages WHERE import_id = ?').all(importId).map(r => r.conversation_id);
  db.prepare('DELETE FROM nb_ai_candidate_evidence WHERE import_id = ?').run(importId);
  db.prepare('DELETE FROM nb_ai_attachments WHERE import_id = ?').run(importId);
  db.prepare('DELETE FROM nb_ai_messages WHERE import_id = ?').run(importId);
  // conversations first created by this import but extended by later imports keep living: re-home them
  db.prepare(`UPDATE nb_ai_conversations SET import_id = (SELECT m.import_id FROM nb_ai_messages m WHERE m.conversation_id = nb_ai_conversations.conversation_id LIMIT 1)
              WHERE import_id = ? AND EXISTS (SELECT 1 FROM nb_ai_messages m WHERE m.conversation_id = nb_ai_conversations.conversation_id)`).run(importId);
  db.prepare('DELETE FROM nb_ai_conversations WHERE import_id = ?').run(importId);
  // conversations extended by this import keep an exact message_count
  const recount = db.prepare('UPDATE nb_ai_conversations SET message_count = (SELECT COUNT(*) FROM nb_ai_messages m WHERE m.conversation_id = nb_ai_conversations.conversation_id) WHERE conversation_id = ?');
  for (const id of touched) recount.run(id);
  if (!keepImportRow) db.prepare('DELETE FROM nb_ai_imports WHERE import_id = ?').run(importId);
  // orphan handling (explicit): unreviewed candidates without evidence vanish; user-reviewed ones stay, flagged
  db.prepare(`UPDATE nb_ai_candidates SET orphaned = 1, updated_at = ? WHERE status IN ('APPROVED','SUPERSEDED') AND orphaned = 0
              AND NOT EXISTS (SELECT 1 FROM nb_ai_candidate_evidence e WHERE e.candidate_id = nb_ai_candidates.candidate_id)`).run(new Date().toISOString());
  db.prepare(`DELETE FROM nb_ai_candidates WHERE status IN ('CANDIDATE','REJECTED')
              AND NOT EXISTS (SELECT 1 FROM nb_ai_candidate_evidence e WHERE e.candidate_id = nb_ai_candidates.candidate_id)`).run();
  db.prepare(`DELETE FROM nb_ai_candidate_links WHERE candidate_id NOT IN (SELECT candidate_id FROM nb_ai_candidates)
              OR related_id NOT IN (SELECT candidate_id FROM nb_ai_candidates)`).run();
}
