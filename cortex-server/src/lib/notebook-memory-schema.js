// Notebook NB-5 — DOCTEUR MEMORY schema (additive, idempotent, non-destructive).
// No imports on purpose: called from notebook-docs-store.ensureNotebookDocsSchema().
//
// This is the store of APPROVED memory only. It is deliberately separate from:
//   • the NB-4 memory CANDIDATES (nb_ai_candidates — proposals, never memory), and
//   • the Phase-3 Adaptive Memory (preference_facts / episodic_memories in memory.js — untouched).
//
//   dmem_projects / dmem_notebook_projects   explicit project registry + notebook→project mapping
//   dmem_items          MemoryItem (+ MemoryScope columns: scope_kind / project_id / notebook_id)
//   dmem_evidence       links to sources (never copies of them; ≤ 300-char quote snapshot)
//   dmem_revisions      MemoryRevision: every edit / status change with old + new value
//   dmem_conflicts      MemoryConflict: two active memories that contradict (never silently resolved)
//   dmem_suggestions    possible supersessions awaiting a human decision
//   dmem_usage          MemoryUsage: which memory was used by which request (no conversation content)
//   dmem_audit          content-free audit trail (ids + actions only; survives a hard delete)
//   dmem_embeddings     embedding metadata (provider/model/dimension/format/statement hash) — vectors live in LanceDB
//   dmem_items_fts      FTS5 index of statements

export function ensureMemorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dmem_projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dmem_notebook_projects (
      notebook_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dmem_items (
      memory_id TEXT PRIMARY KEY,
      statement TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'APPROVED',
      scope_kind TEXT NOT NULL,
      project_id TEXT,
      notebook_id TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      sensitivity TEXT NOT NULL DEFAULT 'NORMAL',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      effective_until TEXT,
      superseded_by TEXT,
      source_kind TEXT NOT NULL DEFAULT 'MANUAL',
      source_candidate_id TEXT,
      source_notebook_id TEXT,
      original_statement TEXT,
      edited_before_approval INTEGER NOT NULL DEFAULT 0,
      approval_source TEXT NOT NULL DEFAULT 'USER_UI',
      provenance TEXT NOT NULL DEFAULT '{}',
      injection_flags TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      retention TEXT NOT NULL DEFAULT 'KEEP',
      expires_at TEXT,
      session_id TEXT,
      norm_key TEXT NOT NULL DEFAULT '',
      statement_hash TEXT NOT NULL DEFAULT '',
      needs_review INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dmem_items_scope ON dmem_items(status, scope_kind, project_id, notebook_id);
    CREATE INDEX IF NOT EXISTS idx_dmem_items_candidate ON dmem_items(source_candidate_id) WHERE source_candidate_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dmem_items_norm ON dmem_items(norm_key);

    CREATE TABLE IF NOT EXISTS dmem_evidence (
      memory_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      source_id TEXT,
      conversation_id TEXT,
      provider TEXT,
      role TEXT,
      trust_level TEXT,
      quote TEXT NOT NULL DEFAULT '',
      ts TEXT,
      status TEXT NOT NULL DEFAULT 'OK',
      created_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, kind, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_dmem_evidence_source ON dmem_evidence(source_id);

    CREATE TABLE IF NOT EXISTS dmem_revisions (
      revision_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      action TEXT NOT NULL,
      old_statement TEXT,
      new_statement TEXT,
      old_status TEXT,
      new_status TEXT,
      reason TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dmem_rev_mem ON dmem_revisions(memory_id, version);

    CREATE TABLE IF NOT EXISTS dmem_conflicts (
      conflict_id TEXT PRIMARY KEY,
      memory_a TEXT NOT NULL,
      memory_b TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'OPEN',
      resolution TEXT,
      detected_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE (memory_a, memory_b)
    );

    CREATE TABLE IF NOT EXISTS dmem_suggestions (
      suggestion_id TEXT PRIMARY KEY,
      new_id TEXT NOT NULL,
      old_id TEXT NOT NULL,
      ambiguous INTEGER NOT NULL DEFAULT 1,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      decided_at TEXT,
      UNIQUE (new_id, old_id)
    );

    CREATE TABLE IF NOT EXISTS dmem_usage (
      usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      at TEXT NOT NULL,
      score REAL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dmem_usage_req ON dmem_usage(request_id);
    CREATE INDEX IF NOT EXISTS idx_dmem_usage_mem ON dmem_usage(memory_id);

    CREATE TABLE IF NOT EXISTS dmem_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      old_status TEXT,
      new_status TEXT,
      at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dmem_embeddings (
      memory_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embed_version TEXT NOT NULL,
      statement_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS dmem_items_fts USING fts5(
      statement, type, project, memory_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

// Called (inside the caller's transaction) when a source document / AI-history import is purged:
// the evidence links become SOURCE_MISSING and memories that lost ALL their evidence are flagged for review.
// Deterministic rule: the memory REMAINS active (a human approved it) but is never shown with a broken provenance.
export function markMemoryEvidenceMissing(db, sourceId) {
  const affected = db.prepare(`SELECT DISTINCT memory_id FROM dmem_evidence WHERE source_id = ? AND status = 'OK'`).all(sourceId).map(r => r.memory_id);
  if (!affected.length) return [];
  db.prepare(`UPDATE dmem_evidence SET status = 'SOURCE_MISSING' WHERE source_id = ?`).run(sourceId);
  const now = new Date().toISOString();
  for (const id of affected) {
    const ok = db.prepare(`SELECT COUNT(*) n FROM dmem_evidence WHERE memory_id = ? AND status = 'OK'`).get(id).n;
    if (ok === 0) db.prepare('UPDATE dmem_items SET needs_review = 1, updated_at = ? WHERE memory_id = ?').run(now, id);
    db.prepare(`INSERT INTO dmem_audit (memory_id, action, actor, at) VALUES (?, 'SOURCE_DELETED', 'system', ?)`).run(id, now);
  }
  return affected;
}
