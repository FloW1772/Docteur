import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as secretStore from './secret-store.js';
import { RADIO_STATIONS } from './radio-catalog.js';

let database;
let statements;

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function initSqlite(sqlitePath) {
  if (database) {
    return database;
  }

  ensureParentDir(sqlitePath);
  database = new Database(sqlitePath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      model_used TEXT,
      payload_size INTEGER NOT NULL,
      status_code INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS router_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action_type TEXT NOT NULL,
      chosen_level INTEGER NOT NULL,
      chosen_model TEXT NOT NULL,
      input_length INTEGER NOT NULL,
      response_length INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      success INTEGER NOT NULL,
      error_message TEXT,
      provider TEXT,
      quota_hit INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      schedule TEXT DEFAULT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      output_neuron_id TEXT DEFAULT NULL,
      output_title TEXT DEFAULT NULL,
      error_message TEXT DEFAULT NULL,
      triggered_by TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE TABLE IF NOT EXISTS agent_outputs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'recherche',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consumed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS privacy_violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      function_called TEXT NOT NULL,
      provider_targeted TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox_pending (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consumed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS file_originals (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      extension TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL,
      checksum TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      treatments_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS file_results (
      id TEXT PRIMARY KEY,
      original_id TEXT NOT NULL,
      competence TEXT NOT NULL,
      result_kind TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      extension TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      checksum TEXT NOT NULL,
      path TEXT NOT NULL,
      cloud_allowed INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instruction TEXT NOT NULL DEFAULT '',
      input_type TEXT NOT NULL DEFAULT 'text',
      output_type TEXT NOT NULL DEFAULT 'display',
      output_kind TEXT NOT NULL DEFAULT 'note',
      model TEXT NOT NULL DEFAULT 'local',
      private INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1,
      instruction_history TEXT NOT NULL DEFAULT '[]',
      run_count INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS skill_runs (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      input_preview TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      model_used TEXT DEFAULT NULL,
      latency_ms INTEGER DEFAULT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      error_message TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS whisper_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      provider TEXT NOT NULL,
      duration_s REAL,
      fallback INTEGER NOT NULL DEFAULT 0,
      fallback_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS corpus_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      article_count INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      keywords TEXT NOT NULL DEFAULT '',
      min_size INTEGER,
      max_size INTEGER,
      status TEXT NOT NULL DEFAULT 'importing',
      error_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      op_type TEXT NOT NULL,
      item TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT 'success',
      reason TEXT,
      duration_ms INTEGER,
      model_used TEXT
    );

    CREATE TABLE IF NOT EXISTS todo_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'capture',
      url TEXT,
      title TEXT,
      note TEXT,
      detected_kind TEXT,
      video_count INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      result_page_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      done_at TEXT
    );

    -- Conversation mode (chat) — always private, never indexed for RAG/search,
    -- never sent to a cloud provider. See routes/chat.js.
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Preference facts — a short flat list, not a conversation history.
    CREATE TABLE IF NOT EXISTS preference_facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Résumé de vidéo longue — pipeline résumable en plusieurs étapes.
    CREATE TABLE IF NOT EXISTS video_jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_whisper TEXT NOT NULL DEFAULT 'auto',
      provider_synthesis TEXT NOT NULL DEFAULT 'local',
      resume_type TEXT NOT NULL DEFAULT 'auto',
      duration_s REAL,
      current_step TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      error_message TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0,
      private INTEGER NOT NULL DEFAULT 0,
      neuron_id TEXT,
      disk_bytes INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    -- Générateur de prompts — complètement séparé des neurones : jamais indexé,
    -- jamais dans pages, jamais dans la vue 3D, jamais dans les filtres de kind.
    CREATE TABLE IF NOT EXISTS generated_prompts (
      id TEXT PRIMARY KEY,
      request TEXT NOT NULL,
      draft_model TEXT NOT NULL,
      draft_provider TEXT NOT NULL,
      draft_text TEXT NOT NULL DEFAULT '',
      review_model TEXT NOT NULL,
      review_provider TEXT NOT NULL,
      reviewed_text TEXT NOT NULL DEFAULT '',
      changes_explained TEXT NOT NULL DEFAULT '',
      unchanged INTEGER NOT NULL DEFAULT 0,
      kept_version TEXT DEFAULT NULL,
      outcome TEXT NOT NULL DEFAULT 'untested',
      is_template INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prompt_send_events (
      id TEXT PRIMARY KEY,
      generated_prompt_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      destination_name TEXT NOT NULL,
      prefill_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS video_job_segments (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      start_s REAL,
      end_s REAL,
      audio_path TEXT,
      transcript TEXT,
      transcript_status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT,
      summary_status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Module Professeur — apprentissage pas-à-pas + révision espacée.
    -- Stockage entièrement séparé des neurones (pas un neurone par étape).
    CREATE TABLE IF NOT EXISTS learning_paths (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      register TEXT NOT NULL DEFAULT 'standard',
      teacher_model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planning',
      plan TEXT NOT NULL DEFAULT '[]',
      current_step_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      recap_neuron_id TEXT
    );

    CREATE TABLE IF NOT EXISTS learning_path_steps (
      id TEXT PRIMARY KEY,
      path_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      comprehension_check TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS review_items (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer_hint TEXT NOT NULL DEFAULT '',
      ease_factor REAL NOT NULL DEFAULT 2.5,
      interval_days INTEGER NOT NULL DEFAULT 1,
      next_review_at TEXT NOT NULL,
      last_reviewed_at TEXT,
      review_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS review_attempts (
      id TEXT PRIMARY KEY,
      review_item_id TEXT NOT NULL,
      answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      was_correct INTEGER NOT NULL,
      user_answer TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS teacher_model_usage (
      date TEXT NOT NULL,
      model TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, model)
    );

    -- Bibliothèque de prompts CV sauvegardés — table dédiée, jamais un neurone.
    CREATE TABLE IF NOT EXISTS candidature_saved_prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Bibliothèque de modèles de prompts généraux (Prompt Generator) — même
    -- principe que candidature_saved_prompts : les modèles fournis par
    -- Docteur sont insérés ici comme lignes normales au premier chargement à
    -- vide (seedDefaultPromptTemplatesIfEmpty), puis deviennent des lignes
    -- utilisateur ordinaires, éditables/supprimables sans distinction —
    -- jamais un neurone, jamais indexé.
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Autres',
      description TEXT NOT NULL DEFAULT '',
      prompt_text TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Génération d'images — métadonnées uniquement ; les octets vivent dans
    -- data/images via lib/image.js (même stockage que les uploads/neurones).
    -- Jamais de clé/token ici : provider_used/provider_requested sont des ids
    -- courts ('comfyui','cloudflare',...), rien de plus.
    CREATE TABLE IF NOT EXISTS image_generations (
      id TEXT PRIMARY KEY,
      image_id TEXT,
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      provider_requested TEXT NOT NULL,
      provider_used TEXT,
      model_used TEXT,
      local INTEGER NOT NULL DEFAULT 0,
      fallback INTEGER NOT NULL DEFAULT 0,
      fallback_reason_code TEXT,
      width INTEGER,
      height INTEGER,
      seed INTEGER,
      status TEXT NOT NULL DEFAULT 'queued',
      error_code TEXT,
      generation_ms INTEGER,
      job_id TEXT,
      neuron_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- OAuth connectors (YouTube Data API, Microsoft Graph/OneDrive) — connection
    -- STATE only. Never stores an access/refresh token: those live exclusively
    -- in secret-store.js (DPAPI-encrypted), keyed as
    -- 'oauth:<provider>:access_token' / 'oauth:<provider>:refresh_token'.
    -- The frontend reads only this table's non-secret columns (connected,
    -- account_label, scopes, last_sync_at) — see routes/connectors.js.
    CREATE TABLE IF NOT EXISTS oauth_connections (
      provider TEXT PRIMARY KEY,
      connected INTEGER NOT NULL DEFAULT 0,
      account_label TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      auto_sync INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT,
      last_sync_status TEXT,
      last_sync_error TEXT,
      connected_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Dedup ledger for connector sync (YouTube video id / OneDrive item id →
    -- the Docteur page id it became). Prevents re-importing the same item on
    -- every manual sync. delta_token supports incremental sync when the
    -- remote API offers one (Microsoft Graph delta query); NULL otherwise.
    CREATE TABLE IF NOT EXISTS connector_sync_items (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      content_hash TEXT,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, external_id)
    );

    CREATE TABLE IF NOT EXISTS connector_sync_state (
      provider TEXT PRIMARY KEY,
      delta_token TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Adaptive local memory — episodic tier (mid-term: things learned from
    -- searches/neurons/corrections, expected to fade if unused). The
    -- long-term tier reuses the existing preference_facts table (additive
    -- columns below); session tier reuses existing conversations/
    -- conversation_messages. See lib/memory.js for extraction/retrieval.
    -- egress_policy propagates from source: a memory extracted from
    -- local_only content (OneDrive/YouTube private, private neuron, OSINT)
    -- is itself local_only and can never be included in a cloud-bound prompt.
    CREATE TABLE IF NOT EXISTS episodic_memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      source TEXT NOT NULL DEFAULT 'manual',
      source_ref TEXT,
      privacy INTEGER NOT NULL DEFAULT 0,
      egress_policy TEXT NOT NULL DEFAULT 'cloud_allowed',
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.5,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Local Notebook (documentary/RAG workspace) — Phase 5 (MASTER mission).
    -- A Notebook groups references to EXISTING content (neurons, connector
    -- syncs, manual text saved as a neuron); it never copies or re-embeds
    -- content already indexed in the neurons LanceDB table. privacy/
    -- egress_policy here are DERIVED (recomputed) from notebook_sources —
    -- see lib/notebook.js computeNotebookPrivacy() — never set directly by
    -- a client, so a client can never claim a notebook is less restrictive
    -- than its actual sources.
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      privacy INTEGER NOT NULL DEFAULT 0,
      egress_policy TEXT NOT NULL DEFAULT 'cloud_allowed',
      settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- source_id references a neuron id in the LanceDB 'neurons' table (the
    -- neuron itself is untouched — this is a reference row only). Removing
    -- a NotebookSource never deletes the underlying neuron; deleting a
    -- Notebook never deletes its sources' neurons (mission requirement).
    CREATE TABLE IF NOT EXISTS notebook_sources (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'neuron',
      source_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      provenance TEXT NOT NULL DEFAULT '',
      privacy INTEGER NOT NULL DEFAULT 0,
      egress_policy TEXT NOT NULL DEFAULT 'cloud_allowed',
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Cached hierarchical summaries per notebook (level 1 = global, level 2
    -- = per-theme, level 3 = on-demand detail — see lib/notebook.js).
    -- Invalidated (row deleted) whenever the notebook's source set changes,
    -- recomputed lazily on next request rather than eagerly on every edit.
    CREATE TABLE IF NOT EXISTS notebook_summaries (
      notebook_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      theme_key TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      sources_hash TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (notebook_id, level, theme_key)
    );
  `);

  // Idempotent migrations — ignore if column/index already exists
  for (const col of [
    'ALTER TABLE router_logs ADD COLUMN provider TEXT',
    'ALTER TABLE router_logs ADD COLUMN quota_hit INTEGER DEFAULT 0',
    'ALTER TABLE file_originals ADD COLUMN metadata TEXT NOT NULL DEFAULT "{}"',
    'ALTER TABLE file_originals ADD COLUMN treatments_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE file_results ADD COLUMN metadata TEXT NOT NULL DEFAULT "{}"',
    'ALTER TABLE file_results ADD COLUMN cloud_allowed INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE agent_runs ADD COLUMN similarity_note TEXT DEFAULT NULL',
    'ALTER TABLE agents ADD COLUMN last_output_content TEXT DEFAULT NULL',
    // Adaptive memory metadata — additive to the existing manual-entry
    // preference_facts table. Existing rows (added via /chat/preferences
    // before this phase) default to source='manual', egress_policy=
    // 'cloud_allowed' (their historical, already-cloud-safe behavior is
    // unchanged), importance/confidence at neutral 0.5.
    'ALTER TABLE preference_facts ADD COLUMN source TEXT NOT NULL DEFAULT "manual"',
    'ALTER TABLE preference_facts ADD COLUMN source_ref TEXT',
    'ALTER TABLE preference_facts ADD COLUMN privacy INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE preference_facts ADD COLUMN egress_policy TEXT NOT NULL DEFAULT "cloud_allowed"',
    'ALTER TABLE preference_facts ADD COLUMN importance REAL NOT NULL DEFAULT 0.5',
    'ALTER TABLE preference_facts ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5',
    'ALTER TABLE preference_facts ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE preference_facts ADD COLUMN last_used_at TEXT',
    'ALTER TABLE preference_facts ADD COLUMN updated_at TEXT',
  ]) {
    try { database.exec(col); } catch { /* already exists */ }
  }

  // Performance indexes — CREATE INDEX IF NOT EXISTS is safe to run repeatedly
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_router_logs_timestamp
      ON router_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_whisper_logs_timestamp
      ON whisper_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_whisper_logs_fallback_reason
      ON whisper_logs(fallback_reason);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id
      ON agent_runs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_status
      ON agent_runs(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_outputs_consumed
      ON agent_outputs(consumed);
    CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent_id
      ON agent_outputs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_pending_consumed
      ON inbox_pending(consumed);
    CREATE INDEX IF NOT EXISTS idx_skill_runs_skill_id
      ON skill_runs(skill_id);
    CREATE INDEX IF NOT EXISTS idx_episodic_memories_updated_at
      ON episodic_memories(updated_at);
    CREATE INDEX IF NOT EXISTS idx_episodic_memories_category
      ON episodic_memories(category);
    CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook_id
      ON notebook_sources(notebook_id);
    CREATE INDEX IF NOT EXISTS idx_notebook_sources_source_id
      ON notebook_sources(source_id);
    CREATE INDEX IF NOT EXISTS idx_file_results_original_id
      ON file_results(original_id);
    CREATE INDEX IF NOT EXISTS idx_file_results_path
      ON file_results(path);
    CREATE INDEX IF NOT EXISTS idx_todo_items_status
      ON todo_items(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_corpus_sources_created_at
      ON corpus_sources(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp
      ON activity_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_log_op_type
      ON activity_log(op_type);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id
      ON conversation_messages(conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_video_jobs_status
      ON video_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_video_jobs_created_at
      ON video_jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_video_job_segments_job_id
      ON video_job_segments(job_id, idx ASC);
    CREATE INDEX IF NOT EXISTS idx_generated_prompts_created_at
      ON generated_prompts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generated_prompts_is_template
      ON generated_prompts(is_template DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generated_prompts_outcome
      ON generated_prompts(outcome);
    CREATE INDEX IF NOT EXISTS idx_prompt_send_events_generated_prompt_id
      ON prompt_send_events(generated_prompt_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_paths_status
      ON learning_paths(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_path_steps_path_id
      ON learning_path_steps(path_id, step_index ASC);
    CREATE INDEX IF NOT EXISTS idx_review_items_next_review_at
      ON review_items(next_review_at ASC);
    CREATE INDEX IF NOT EXISTS idx_review_items_source
      ON review_items(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_review_attempts_review_item_id
      ON review_attempts(review_item_id, answered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_candidature_saved_prompts_order
      ON candidature_saved_prompts(order_index ASC);
    CREATE INDEX IF NOT EXISTS idx_prompt_templates_order
      ON prompt_templates(order_index ASC);
    CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp
      ON request_logs(timestamp);
  `);

  statements = {
    upsertPage: database.prepare(`
      INSERT INTO pages (id, data, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
    `),
    deletePage:   database.prepare('DELETE FROM pages WHERE id = ?'),
    getAllPages:   database.prepare('SELECT data FROM pages ORDER BY updated_at DESC'),
    getPageById:  database.prepare('SELECT data FROM pages WHERE id = ?'),
    insertLog: database.prepare(`
      INSERT INTO request_logs (
        timestamp,
        endpoint,
        latency_ms,
        model_used,
        payload_size,
        status_code,
        ok,
        message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    upsertMeta: database.prepare(`
      INSERT INTO metadata (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `),
    getMeta: database.prepare('SELECT value FROM metadata WHERE key = ?'),
    insertRouterLog: database.prepare(`
      INSERT INTO router_logs
        (timestamp, action_type, chosen_level, chosen_model, input_length, response_length, latency_ms, success, error_message, provider, quota_hit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    routerStats: database.prepare(`
      SELECT chosen_model, chosen_level, provider,
             COUNT(*) as call_count,
             CAST(AVG(latency_ms) AS INTEGER) as avg_latency_ms,
             SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_count,
             SUM(COALESCE(quota_hit, 0)) as quota_count
      FROM router_logs
      GROUP BY chosen_model, chosen_level, provider
      ORDER BY call_count DESC
    `),
    routerStatsMonthCloud: database.prepare(`
      SELECT provider, chosen_model,
             COUNT(*) as call_count,
             SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_count,
             SUM(COALESCE(quota_hit, 0)) as quota_count
      FROM router_logs
      WHERE provider IS NOT NULL
        AND timestamp >= strftime('%Y-%m-01', 'now')
      GROUP BY provider, chosen_model
      ORDER BY provider, call_count DESC
    `),
    insertInboxPending: database.prepare(`
      INSERT INTO inbox_pending (id, title, content, tags, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getInboxPending:    database.prepare('SELECT * FROM inbox_pending WHERE consumed = 0 ORDER BY created_at ASC'),
    markInboxConsumed:  database.prepare('UPDATE inbox_pending SET consumed = 1 WHERE id = ?'),
    getFileOriginals: database.prepare(`
      SELECT o.*, COUNT(r.id) AS result_count, MAX(r.created_at) AS last_result_at
      FROM file_originals o
      LEFT JOIN file_results r ON r.original_id = o.id
      GROUP BY o.id
      ORDER BY o.uploaded_at DESC
    `),
    getFileOriginalById: database.prepare('SELECT * FROM file_originals WHERE id = ?'),
    upsertFileOriginal: database.prepare(`
      INSERT INTO file_originals (
        id, original_name, stored_name, extension, mime_type, size_bytes,
        uploaded_at, checksum, metadata, treatments_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        original_name = excluded.original_name,
        stored_name = excluded.stored_name,
        extension = excluded.extension,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        uploaded_at = excluded.uploaded_at,
        checksum = excluded.checksum,
        metadata = excluded.metadata,
        treatments_count = excluded.treatments_count
    `),
    updateFileOriginalTreatments: database.prepare('UPDATE file_originals SET treatments_count = ? WHERE id = ?'),
    deleteFileOriginal: database.prepare('DELETE FROM file_originals WHERE id = ?'),
    getFileResultsByOriginal: database.prepare('SELECT * FROM file_results WHERE original_id = ? ORDER BY created_at DESC'),
    getFileResultById: database.prepare('SELECT * FROM file_results WHERE id = ?'),
    getFileResultByPath: database.prepare('SELECT * FROM file_results WHERE path = ?'),
    getFileResults: database.prepare('SELECT * FROM file_results ORDER BY created_at DESC'),
    upsertFileResult: database.prepare(`
      INSERT INTO file_results (
        id, original_id, competence, result_kind, original_name, stored_name,
        extension, mime_type, size_bytes, created_at, checksum, path,
        cloud_allowed, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        original_id = excluded.original_id,
        competence = excluded.competence,
        result_kind = excluded.result_kind,
        original_name = excluded.original_name,
        stored_name = excluded.stored_name,
        extension = excluded.extension,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        created_at = excluded.created_at,
        checksum = excluded.checksum,
        path = excluded.path,
        cloud_allowed = excluded.cloud_allowed,
        metadata = excluded.metadata
    `),
    deleteFileResult: database.prepare('DELETE FROM file_results WHERE id = ?'),
  };

  return database;
}

export function logRequest({ endpoint, latencyMs, modelUsed = null, payloadSize = 0, statusCode = 200, ok = true, message = null }) {
  if (!database) {
    return;
  }

  statements.insertLog.run(
    new Date().toISOString(),
    endpoint,
    Math.round(latencyMs),
    modelUsed,
    payloadSize,
    statusCode,
    ok ? 1 : 0,
    message
  );
}

export function getRequestLogRetentionDays() {
  return getMeta('request_log_retention_days', 30);
}

export function setRequestLogRetentionDays(days) {
  const clamped = Math.max(1, Math.min(365, Number(days) || 30));
  setMeta('request_log_retention_days', clamped);
  return clamped;
}

export function getRequestLogStats() {
  if (!database) return { count: 0, sizeBytes: 0, retentionDays: 30 };
  const count = database.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n;
  let sizeBytes = 0;
  try {
    const row = database.prepare("SELECT SUM(pgsize) AS n FROM dbstat WHERE name = 'request_logs'").get();
    sizeBytes = row?.n ?? 0;
  } catch {
    // dbstat virtual table not compiled in this better-sqlite3 build — rough estimate instead
    sizeBytes = count * 150;
  }
  return { count, sizeBytes, retentionDays: getRequestLogRetentionDays() };
}

// Deletes request_logs rows older than `days`, in bounded batches rather than
// one unbounded DELETE — request_logs is written on every single HTTP request
// (unlike activity_log's coarser, user-facing events) so it can grow far
// larger, and a single multi-hundred-thousand-row DELETE would hold the SQLite
// write lock for an unacceptably long, unbounded time. Runs at most
// `maxBatches` batches per call so a huge backlog (e.g. first purge ever, or a
// long-idle install) is trimmed gradually across restarts instead of stalling
// boot.
const REQUEST_LOG_PURGE_BATCH_SIZE = 500;
const REQUEST_LOG_PURGE_MAX_BATCHES = 20;

export function purgeRequestLogsOlderThan(days, { batchSize = REQUEST_LOG_PURGE_BATCH_SIZE, maxBatches = REQUEST_LOG_PURGE_MAX_BATCHES } = {}) {
  if (!database) return 0;
  const numDays = Number(days);
  if (!Number.isFinite(numDays)) return 0; // invalid input — no-op rather than risk a bad cutoff
  const cutoff = new Date(Date.now() - numDays * 86_400_000).toISOString();
  const deleteBatch = database.prepare(
    'DELETE FROM request_logs WHERE id IN (SELECT id FROM request_logs WHERE timestamp < ? LIMIT ?)'
  );

  let totalDeleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = deleteBatch.run(cutoff, batchSize);
    totalDeleted += result.changes;
    if (result.changes < batchSize) break; // fewer rows than the batch size means we've caught up
  }
  return totalDeleted;
}

export function setMeta(key, value) {
  if (!database) {
    return;
  }

  statements.upsertMeta.run(key, JSON.stringify(value));
}

export function getMeta(key, fallback = null) {
  if (!database) {
    return fallback;
  }

  const row = statements.getMeta.get(key);
  if (!row) {
    return fallback;
  }

  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function logRouterCall({
  actionType, chosenLevel, chosenModel, inputLength, responseLength,
  latencyMs, success, errorMessage = null, provider = null, quotaHit = false,
}) {
  if (!database) return;
  statements.insertRouterLog.run(
    new Date().toISOString(),
    actionType,
    chosenLevel,
    chosenModel ?? 'unknown',
    inputLength,
    responseLength,
    Math.round(latencyMs),
    success ? 1 : 0,
    errorMessage,
    provider,
    quotaHit ? 1 : 0,
  );

  // Surface cloud calls in the activity journal — sensitive operation, no content logged.
  if (provider && provider !== 'local') {
    insertActivityLog({
      opType: 'cloud_call',
      item: actionType,
      result: success ? 'success' : 'failure',
      reason: success ? null : (errorMessage ?? 'échec appel cloud'),
      durationMs: Math.round(latencyMs),
      modelUsed: chosenModel ?? provider,
    });
  }
}

export function getRouterStats() {
  if (!database) return [];
  return statements.routerStats.all();
}

export function getCloudStatsThisMonth() {
  if (!database) return [];
  return statements.routerStatsMonthCloud.all();
}

// ── Whisper transcription logs ────────────────────────────────────────────────

export function logWhisperCall({ provider, durationS = null, fallback = false, fallbackReason = null }) {
  if (!database) return;
  database.prepare(
    'INSERT INTO whisper_logs (timestamp, provider, duration_s, fallback, fallback_reason) VALUES (?, ?, ?, ?, ?)',
  ).run(new Date().toISOString(), provider, durationS, fallback ? 1 : 0, fallbackReason);
}

export function getWhisperStats() {
  if (!database) return { today: { groq: 0, local: 0, groq_minutes: 0, local_minutes: 0 }, month: { groq: 0, local: 0 }, last_quota_at: null };
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  const todayRows = database.prepare(
    `SELECT provider, COUNT(*) as calls, COALESCE(SUM(duration_s), 0) as total_s
     FROM whisper_logs WHERE timestamp >= ? GROUP BY provider`,
  ).all(`${today}T00:00:00`);

  const monthRows = database.prepare(
    `SELECT provider, COUNT(*) as calls FROM whisper_logs WHERE timestamp >= ? GROUP BY provider`,
  ).all(`${month}-01T00:00:00`);

  const lastQuota = database.prepare(
    `SELECT timestamp FROM whisper_logs WHERE fallback_reason = 'quota' ORDER BY timestamp DESC LIMIT 1`,
  ).get();

  const todayMap = Object.fromEntries(todayRows.map(r => [r.provider, r]));
  const monthMap = Object.fromEntries(monthRows.map(r => [r.provider, r]));

  return {
    today: {
      groq:         todayMap['whisper_groq']?.calls  ?? 0,
      local:        todayMap['whisper_local']?.calls ?? 0,
      groq_minutes: Math.round((todayMap['whisper_groq']?.total_s ?? 0) / 60),
      local_minutes: Math.round((todayMap['whisper_local']?.total_s ?? 0) / 60),
    },
    month: {
      groq:  monthMap['whisper_groq']?.calls  ?? 0,
      local: monthMap['whisper_local']?.calls ?? 0,
    },
    last_quota_at: lastQuota?.timestamp ?? null,
  };
}

const ROUTER_SETTINGS_DEFAULTS = {
    router_enabled:      true,
    fallback_model:      'llama3.2:3b',
    cloud_enabled:       true,
    paying_apis_enabled: false,
    gemini_rpm:          10,
    cloud_preference:    'local',   // 'local' | 'balanced' | 'quality'
    strict_local_mode:   false,     // when true: NO cloud call ever, regardless of router config
    groq_model:          'openai/gpt-oss-120b',
    // Claude/OpenAI each have two mutually-exclusive backends: a subscription
    // mode (Claude Code CLI / Codex CLI — no per-token API cost to Docteur)
    // and an API-key mode (ANTHROPIC_API_KEY / OPENAI_API_KEY — billed).
    // Only the selected mode's provider is ever added to the router's
    // candidates — never both, no ambiguity, no silent API fallback.
    claude_mode:         'subscription', // 'subscription' (claude-oauth/CLI) | 'api' (anthropic key)
    openai_mode:         'subscription', // 'subscription' (codex/CLI)        | 'api' (openai key)
    freellmapi: {
      enabled: false,
      baseUrl: '',
      timeout: 90000,
      mode: 'auto',
      allowText: true,
      allowImage: false,
      allowVideo: false,
      allowAudio: false,
      allowFallback: true,
      freeOnly: false,
      textModel: 'auto',
      imageModel: 'auto',
      videoModel: 'auto',
      audioModel: 'auto',
    },
    // "Mode puissant" model — quantized q3_K_M by default (~7.3 Go) so it
    // actually fits an 8 Go card; the unquantized qwen2.5:14b (~9 Go) stays
    // selectable in Settings but overflows VRAM and reloads cold each time.
    powerful_model:      'qwen2.5:14b-instruct-q3_K_M',
    // "Mode conversation" model — quantized for the same 8 Go VRAM budget as
    // powerful_model above.
    chat_model:          'mistral-nemo:12b-instruct-2407-q4_K_M',
};

export function getRouterSettings() {
  // Merge onto defaults (not just "use defaults if the whole key is absent")
  // so a settings row saved before a new field existed (e.g. claude_mode/
  // openai_mode, added later) still reports that field's real default
  // instead of undefined.
  const stored = getMeta('router_settings', {});
  return {
    ...ROUTER_SETTINGS_DEFAULTS,
    ...stored,
    freellmapi: { ...ROUTER_SETTINGS_DEFAULTS.freellmapi, ...(stored.freellmapi ?? {}) },
  };
}

export function setRouterSettings(updates) {
  const current = getRouterSettings();
  setMeta('router_settings', { ...current, ...updates });
}

// ── Cloud API keys — encrypted at rest via DPAPI, never logged in clear ───────
// Actual ciphertext lives under `secret_dpapi:<provider>` (see secret-store.js).
// getCloudKeys() decrypts on read so existing call sites keep working unchanged.

const CLOUD_PROVIDERS = ['gemini', 'groq', 'openrouter', 'anthropic', 'openai', 'freellmapi'];

export function getCloudKeys() {
  const result = {};
  for (const provider of CLOUD_PROVIDERS) {
    result[`${provider}_key`] = secretStore.getSecret(provider);
  }
  return result;
}

// 'absent' | 'valid' | 'invalid' per provider — 'invalid' means a blob is
// stored but cannot be decrypted (corrupted, or written under a different
// Windows user/machine), distinct from never having configured a key.
export function getCloudKeyStatuses() {
  const result = {};
  for (const provider of CLOUD_PROVIDERS) {
    result[provider] = secretStore.getSecretStatus(provider);
  }
  return result;
}

export function setCloudKey(provider, key) {
  secretStore.setSecret(provider, key || null);
}

// ── Site shortcuts ────────────────────────────────────────────────────────────

const SHORTCUTS_META = 'site_shortcuts';

export function getSiteShortcuts() {
  return getMeta(SHORTCUTS_META, {});
}

export function setSiteShortcut(name, url) {
  const current = getSiteShortcuts();
  setMeta(SHORTCUTS_META, { ...current, [name]: url });
}

export function deleteSiteShortcut(name) {
  const current = getSiteShortcuts();
  const next = { ...current };
  delete next[name];
  setMeta(SHORTCUTS_META, next);
}

// ── Image generation settings ─────────────────────────────────────────────────

const IMAGE_GEN_SETTINGS_DEFAULTS = {
  comfyui_endpoint:    'http://127.0.0.1:8188',
  priority:            'local',  // 'local' | 'cloud' — which side the AUTO router tries first
  free_cloud_only:     true,     // when true: never route to a provider not confirmed free/free-tier
};

export function getImageGenSettings() {
  const stored = getMeta('image_gen_settings', {});
  return { ...IMAGE_GEN_SETTINGS_DEFAULTS, ...stored };
}

export function setImageGenSettings(updates) {
  const current = getImageGenSettings();
  setMeta('image_gen_settings', { ...current, ...updates });
}

// Image-provider API keys — same DPAPI-backed secret store as CLOUD_PROVIDERS
// above, kept in a separate id list since these are gated by free-only/strict
// local logic specific to image generation (see image-router.js).
const IMAGE_CLOUD_PROVIDERS = ['cloudflare_account_id', 'cloudflare_api_token', 'huggingface_token', 'pollinations_key'];

export function getImageCloudKeyStatuses() {
  const result = {};
  for (const id of IMAGE_CLOUD_PROVIDERS) {
    result[id] = secretStore.getSecretStatus(id);
  }
  return result;
}

export function setImageCloudKey(id, value) {
  if (!IMAGE_CLOUD_PROVIDERS.includes(id)) throw new Error(`Clé image inconnue: ${id}`);
  secretStore.setSecret(id, value || null);
}

export function getImageCloudKey(id) {
  if (!IMAGE_CLOUD_PROVIDERS.includes(id)) return null;
  return secretStore.getSecret(id);
}

// ── Image generation jobs (metadata) ──────────────────────────────────────────

export function insertImageGeneration(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO image_generations (
      id, prompt, negative_prompt, provider_requested, width, height, seed, status, job_id
    ) VALUES (@id, @prompt, @negative_prompt, @provider_requested, @width, @height, @seed, @status, @job_id)
  `).run({
    id: row.id,
    prompt: row.prompt,
    negative_prompt: row.negativePrompt ?? null,
    provider_requested: row.providerRequested,
    width: row.width ?? null,
    height: row.height ?? null,
    seed: row.seed ?? null,
    status: row.status ?? 'queued',
    job_id: row.jobId ?? null,
  });
}

export function updateImageGeneration(id, updates) {
  if (!database) return;
  const fields = [];
  const values = {};
  const map = {
    imageId: 'image_id', providerUsed: 'provider_used', modelUsed: 'model_used',
    local: 'local', fallback: 'fallback', fallbackReasonCode: 'fallback_reason_code',
    status: 'status', errorCode: 'error_code', generationMs: 'generation_ms',
    neuronId: 'neuron_id', width: 'width', height: 'height', seed: 'seed',
  };
  for (const [key, col] of Object.entries(map)) {
    if (updates[key] === undefined) continue;
    fields.push(`${col} = @${col}`);
    values[col] = typeof updates[key] === 'boolean' ? (updates[key] ? 1 : 0) : updates[key];
  }
  if (!fields.length) return;
  values.id = id;
  database.prepare(`UPDATE image_generations SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run(values);
}

export function getImageGeneration(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM image_generations WHERE id = ?').get(id) ?? null;
}

export function listImageGenerations(limit = 50) {
  if (!database) return [];
  return database.prepare('SELECT * FROM image_generations ORDER BY created_at DESC LIMIT ?').all(limit);
}

// Returns masked version for display — never expose real keys to frontend
export function getCloudKeysMasked() {
  const keys = getCloudKeys();
  const mask = (k) => k ? `${k.slice(0, 4)}${'•'.repeat(Math.min(k.length - 8, 20))}${k.slice(-4)}` : null;
  return {
    gemini_key:     mask(keys.gemini_key),
    groq_key:       mask(keys.groq_key),
    openrouter_key: mask(keys.openrouter_key),
    anthropic_key:  mask(keys.anthropic_key),
    openai_key:     mask(keys.openai_key),
    freellmapi_key: mask(keys.freellmapi_key),
    gemini_active:     !!keys.gemini_key,
    groq_active:       !!keys.groq_key,
    openrouter_active: !!keys.openrouter_key,
    anthropic_active:  !!keys.anthropic_key,
    openai_active:     !!keys.openai_key,
    freellmapi_active: !!keys.freellmapi_key,
  };
}

export function getDatabase() {
  return database;
}

// ── Todo items ────────────────────────────────────────────────────────────────

export function getTodoItems() {
  if (!database) return [];
  return database.prepare('SELECT * FROM todo_items ORDER BY priority DESC, created_at ASC').all();
}

export function addTodoItem({ id, type, url, title, note, detected_kind, video_count, priority = 0 }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO todo_items (id, type, url, title, note, detected_kind, video_count, priority, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(id, type ?? 'capture', url ?? null, title ?? null, note ?? null, detected_kind ?? null, video_count ?? null, priority);
}

export function updateTodoItem(id, updates) {
  if (!database) return;
  const allowed = ['status', 'title', 'note', 'result_page_id', 'error', 'done_at', 'priority'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return;
  const set = fields.map(f => `${f} = ?`).join(', ');
  const vals = fields.map(f => updates[f]);
  database.prepare(`UPDATE todo_items SET ${set} WHERE id = ?`).run(...vals, id);
}

export function deleteTodoItem(id) {
  if (!database) return;
  database.prepare('DELETE FROM todo_items WHERE id = ?').run(id);
}

// ── Agents store ──────────────────────────────────────────────────────────────

export function getAllAgents() {
  if (!database) return [];
  return database.prepare('SELECT * FROM agents ORDER BY created_at ASC').all().map(parseAgent);
}

export function getAgentById(id) {
  if (!database) return null;
  const row = database.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  return row ? parseAgent(row) : null;
}

export function insertAgent(agent) {
  if (!database) return;
  database.prepare(`
    INSERT INTO agents (id, name, description, type, params, trigger_type, schedule, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id, agent.name, agent.description ?? '',
    agent.type, JSON.stringify(agent.params ?? {}),
    agent.trigger_type ?? 'manual',
    agent.schedule ? JSON.stringify(agent.schedule) : null,
    agent.active ? 1 : 0,
    agent.created_at, agent.updated_at,
  );
}

export function updateAgent(id, updates) {
  if (!database) return;
  const now = new Date().toISOString();
  const fields = [];
  const vals   = [];
  if (updates.name        !== undefined) { fields.push('name = ?');        vals.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); vals.push(updates.description); }
  if (updates.params      !== undefined) { fields.push('params = ?');      vals.push(JSON.stringify(updates.params)); }
  if (updates.trigger_type !== undefined){ fields.push('trigger_type = ?');vals.push(updates.trigger_type); }
  if (updates.schedule    !== undefined) { fields.push('schedule = ?');    vals.push(updates.schedule ? JSON.stringify(updates.schedule) : null); }
  if (updates.active      !== undefined) { fields.push('active = ?');      vals.push(updates.active ? 1 : 0); }
  fields.push('updated_at = ?');
  vals.push(now);
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteAgent(id) {
  if (!database) return;
  database.prepare('DELETE FROM agents WHERE id = ?').run(id);
  database.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(id);
  database.prepare('DELETE FROM agent_outputs WHERE agent_id = ?').run(id);
}

// Remembers the content of the last run that actually produced a neuron, so
// the next run can be compared against it to detect a near-duplicate result.
export function updateAgentLastOutput(id, content) {
  if (!database) return;
  database.prepare('UPDATE agents SET last_output_content = ? WHERE id = ?').run(content, id);
}

function parseAgent(row) {
  return {
    ...row,
    params:   safeJson(row.params, {}),
    schedule: safeJson(row.schedule, null),
    active:   row.active === 1,
  };
}

// ── Agent runs ────────────────────────────────────────────────────────────────

export function insertAgentRun(run) {
  if (!database) return;
  database.prepare(`
    INSERT INTO agent_runs (id, agent_id, started_at, status, triggered_by)
    VALUES (?, ?, ?, 'running', ?)
  `).run(run.id, run.agent_id, run.started_at, run.triggered_by ?? 'manual');
}

export function updateAgentRun(id, updates) {
  if (!database) return;
  const fields = [];
  const vals   = [];
  if (updates.finished_at     !== undefined) { fields.push('finished_at = ?');     vals.push(updates.finished_at); }
  if (updates.status          !== undefined) { fields.push('status = ?');           vals.push(updates.status); }
  if (updates.output_neuron_id!== undefined) { fields.push('output_neuron_id = ?');vals.push(updates.output_neuron_id); }
  if (updates.output_title    !== undefined) { fields.push('output_title = ?');     vals.push(updates.output_title); }
  if (updates.error_message   !== undefined) { fields.push('error_message = ?');    vals.push(updates.error_message); }
  if (updates.similarity_note !== undefined) { fields.push('similarity_note = ?');  vals.push(updates.similarity_note); }
  if (fields.length > 0) {
    vals.push(id);
    database.prepare(`UPDATE agent_runs SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }

  if (updates.status === 'success' || updates.status === 'error') {
    const run   = database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id);
    const agent = run ? database.prepare('SELECT name FROM agents WHERE id = ?').get(run.agent_id) : null;
    const durationMs = run?.started_at && updates.finished_at
      ? Date.parse(updates.finished_at) - Date.parse(run.started_at) : null;
    insertActivityLog({
      opType: 'agent_run',
      item:   agent?.name ?? run?.agent_id ?? 'agent',
      result: updates.status === 'success' ? 'success' : 'failure',
      reason: updates.error_message ?? null,
      durationMs,
    });
  }
}

export function getRunsByAgent(agentId, limit = 20) {
  if (!database) return [];
  return database.prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?').all(agentId, limit);
}

export function getLastSuccessfulRun(agentId) {
  if (!database) return null;
  return database.prepare(`
    SELECT * FROM agent_runs WHERE agent_id = ? AND status = 'success' ORDER BY started_at DESC LIMIT 1
  `).get(agentId) ?? null;
}

// ── Agent outputs (scheduled run results pending client pickup) ────────────────

export function insertAgentOutput(output) {
  if (!database) return;
  database.prepare(`
    INSERT INTO agent_outputs (id, agent_id, run_id, title, content, kind, created_at, consumed)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(output.id, output.agent_id, output.run_id, output.title, output.content, output.kind ?? 'recherche', output.created_at);
}

export function getPendingOutputs() {
  if (!database) return [];
  return database.prepare('SELECT * FROM agent_outputs WHERE consumed = 0 ORDER BY created_at ASC').all();
}

export function markOutputConsumed(id, neuronId) {
  if (!database) return;
  database.prepare('UPDATE agent_outputs SET consumed = 1 WHERE id = ?').run(id);
  if (neuronId) database.prepare('UPDATE agent_runs SET output_neuron_id = ? WHERE id = (SELECT run_id FROM agent_outputs WHERE id = ?)').run(neuronId, id);
}

function safeJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Skills store ──────────────────────────────────────────────────────────────

function parseSkill(row) {
  return {
    ...row,
    private:              row.private === 1,
    active:               row.active  === 1,
    instruction_history:  safeJson(row.instruction_history, []),
  };
}

export function getAllSkills() {
  if (!database) return [];
  return database.prepare('SELECT * FROM skills ORDER BY name ASC').all().map(parseSkill);
}

export function getSkillById(id) {
  if (!database) return null;
  const row = database.prepare('SELECT * FROM skills WHERE id = ?').get(id);
  return row ? parseSkill(row) : null;
}

export function countSkills() {
  if (!database) return 0;
  return database.prepare('SELECT COUNT(*) as n FROM skills').get().n;
}

export function insertSkill({ id, name, description, instruction, input_type, output_type, output_kind, model, private: priv }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO skills (id, name, description, instruction, input_type, output_type, output_kind, model, private, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, description ?? '', instruction ?? '', input_type ?? 'text', output_type ?? 'display', output_kind ?? 'note', model ?? 'local', priv ? 1 : 0, now, now);
}

export function updateSkill(id, updates) {
  if (!database) return;
  const now = new Date().toISOString();
  const existing = getSkillById(id);
  if (!existing) return;

  const fields = [];
  const vals   = [];

  // If instruction changes, archive previous version
  if (updates.instruction !== undefined && updates.instruction !== existing.instruction) {
    const hist = [
      { instruction: existing.instruction, version: existing.version, saved_at: now },
      ...existing.instruction_history,
    ].slice(0, 10);
    fields.push('instruction_history = ?', 'version = version + 1');
    vals.push(JSON.stringify(hist));
  }

  if (updates.name        !== undefined) { fields.push('name = ?');        vals.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); vals.push(updates.description); }
  if (updates.instruction !== undefined) { fields.push('instruction = ?'); vals.push(updates.instruction); }
  if (updates.input_type  !== undefined) { fields.push('input_type = ?');  vals.push(updates.input_type); }
  if (updates.output_type !== undefined) { fields.push('output_type = ?'); vals.push(updates.output_type); }
  if (updates.output_kind !== undefined) { fields.push('output_kind = ?'); vals.push(updates.output_kind); }
  if (updates.model       !== undefined) { fields.push('model = ?');       vals.push(updates.model); }
  if (updates.private     !== undefined) { fields.push('private = ?');     vals.push(updates.private ? 1 : 0); }
  if (updates.active      !== undefined) { fields.push('active = ?');      vals.push(updates.active ? 1 : 0); }
  fields.push('updated_at = ?');
  vals.push(now, id);

  if (fields.length > 1) {
    database.prepare(`UPDATE skills SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
}

export function deleteSkill(id) {
  if (!database) return;
  database.prepare('DELETE FROM skill_runs WHERE skill_id = ?').run(id);
  database.prepare('DELETE FROM skills WHERE id = ?').run(id);
}

export function bumpSkillRunCount(skillId) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare('UPDATE skills SET run_count = run_count + 1, last_run_at = ?, updated_at = ? WHERE id = ?').run(now, now, skillId);
}

// ── Skill runs ────────────────────────────────────────────────────────────────

export function insertSkillRun({ id, skill_id, input_preview, started_at }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO skill_runs (id, skill_id, input_preview, started_at, status)
    VALUES (?, ?, ?, ?, 'running')
  `).run(id, skill_id, (input_preview ?? '').slice(0, 300), started_at);
}

export function updateSkillRun(id, { output, model_used, latency_ms, finished_at, status, error_message }) {
  if (!database) return;
  const fields = [];
  const vals   = [];
  if (output        !== undefined) { fields.push('output = ?');        vals.push(output); }
  if (model_used    !== undefined) { fields.push('model_used = ?');    vals.push(model_used); }
  if (latency_ms    !== undefined) { fields.push('latency_ms = ?');    vals.push(latency_ms); }
  if (finished_at   !== undefined) { fields.push('finished_at = ?');   vals.push(finished_at); }
  if (status        !== undefined) { fields.push('status = ?');        vals.push(status); }
  if (error_message !== undefined) { fields.push('error_message = ?'); vals.push(error_message); }
  if (fields.length) {
    vals.push(id);
    database.prepare(`UPDATE skill_runs SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }

  if (status === 'success' || status === 'error') {
    const run   = database.prepare('SELECT * FROM skill_runs WHERE id = ?').get(id);
    const skill = run ? database.prepare('SELECT name FROM skills WHERE id = ?').get(run.skill_id) : null;
    insertActivityLog({
      opType: 'skill_run',
      item:   skill?.name ?? run?.skill_id ?? 'compétence',
      result: status === 'success' ? 'success' : 'failure',
      reason: error_message ?? null,
      durationMs: latency_ms ?? null,
      modelUsed: model_used ?? null,
    });
  }
}

export function getSkillRuns(skillId, limit = 30) {
  if (!database) return [];
  return database.prepare('SELECT * FROM skill_runs WHERE skill_id = ? ORDER BY started_at DESC LIMIT ?').all(skillId, limit);
}

// ── Pages store — full page objects for remote access ────────────────────────

export function savePageToStore(page) {
  if (!database) return;
  statements.upsertPage.run(page.id, JSON.stringify(page));
}

export function savePageToStoreIfNewer(page) {
  if (!database) return false;
  const existing = getPageFromStore(page.id);
  if (existing?.updatedAt && page.updatedAt && page.updatedAt < existing.updatedAt) {
    return false; // stale — don't overwrite
  }
  statements.upsertPage.run(page.id, JSON.stringify(page));
  return true;
}

export function repairLinksFromMetadata() {
  if (!database) return { channelLinksRepaired: 0, playlistLinksRepaired: 0 };

  const allPages = statements.getAllPages.all()
    .map(r => { try { return JSON.parse(r.data); } catch { return null; } })
    .filter(Boolean);
  const pageMap = new Map(allPages.map(p => [p.id, p]));

  // Group channel videos by channelId
  const channelToVideos = new Map();
  // Group playlist videos by YouTube playlistId
  const ytPlaylistToVideos = new Map();

  for (const page of allPages) {
    if (page.kind !== 'video') continue;
    const meta = page.metadata ?? {};
    if (meta.channelId) {
      if (!channelToVideos.has(meta.channelId)) channelToVideos.set(meta.channelId, []);
      channelToVideos.get(meta.channelId).push(page.id);
    }
    // Playlist videos have playlistId (YouTube ID string) but no channelId
    if (meta.playlistId && typeof meta.playlistId === 'string' && !meta.channelId) {
      if (!ytPlaylistToVideos.has(meta.playlistId)) ytPlaylistToVideos.set(meta.playlistId, []);
      ytPlaylistToVideos.get(meta.playlistId).push(page.id);
    }
  }

  // Map YouTube playlistId → playlist neuron ID
  const ytPlaylistToPage = new Map();
  for (const page of allPages) {
    if ((page.kind === 'playlist' || page.kind === 'channel') && page.metadata?.playlistId) {
      ytPlaylistToPage.set(page.metadata.playlistId, page.id);
    }
  }

  const now = Date.now();
  let channelLinksRepaired = 0;
  let playlistLinksRepaired = 0;

  const doRepair = database.transaction(() => {
    // Repair channel ↔ video links
    for (const [channelId, videoIds] of channelToVideos) {
      const channelPage = pageMap.get(channelId);
      if (!channelPage) continue;
      const chLinks = new Set(channelPage.links ?? []);
      const before = chLinks.size;
      for (const vId of videoIds) chLinks.add(vId);
      if (chLinks.size > before) {
        statements.upsertPage.run(channelId, JSON.stringify({ ...channelPage, links: [...chLinks], updatedAt: now }));
        channelLinksRepaired += chLinks.size - before;
      }
      for (const vId of videoIds) {
        const vPage = pageMap.get(vId);
        if (!vPage) continue;
        const vLinks = new Set(vPage.links ?? []);
        if (!vLinks.has(channelId)) {
          vLinks.add(channelId);
          statements.upsertPage.run(vId, JSON.stringify({ ...vPage, links: [...vLinks], updatedAt: now }));
          channelLinksRepaired++;
        }
      }
    }

    // Repair playlist ↔ video links
    for (const [ytPlaylistId, videoIds] of ytPlaylistToVideos) {
      const playlistPageId = ytPlaylistToPage.get(ytPlaylistId);
      if (!playlistPageId) continue;
      const playlistPage = pageMap.get(playlistPageId);
      if (!playlistPage) continue;
      const plLinks = new Set(playlistPage.links ?? []);
      const before = plLinks.size;
      for (const vId of videoIds) plLinks.add(vId);
      if (plLinks.size > before) {
        statements.upsertPage.run(playlistPageId, JSON.stringify({ ...playlistPage, links: [...plLinks], updatedAt: now }));
        playlistLinksRepaired += plLinks.size - before;
      }
      for (const vId of videoIds) {
        const vPage = pageMap.get(vId);
        if (!vPage) continue;
        const vLinks = new Set(vPage.links ?? []);
        if (!vLinks.has(playlistPageId)) {
          vLinks.add(playlistPageId);
          statements.upsertPage.run(vId, JSON.stringify({ ...vPage, links: [...vLinks], updatedAt: now }));
          playlistLinksRepaired++;
        }
      }
    }
  });

  doRepair();
  return { channelLinksRepaired, playlistLinksRepaired };
}

export function deletePageFromStore(id) {
  if (!database) return;
  statements.deletePage.run(id);
}

export function getAllPagesFromStore() {
  if (!database) return [];
  return statements.getAllPages.all().map(row => {
    try { return JSON.parse(row.data); } catch { return null; }
  }).filter(Boolean);
}

export function getPageFromStore(id) {
  if (!database) return null;
  const row = statements.getPageById.get(id);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

// ── Lightweight metadata queries (no blocks payload) ─────────────────────────
// Use json_extract to avoid deserialising the full data blob into JS.

const META_SELECT = `
  SELECT
    json_extract(data, '$.id')        AS id,
    json_extract(data, '$.kind')      AS kind,
    json_extract(data, '$.title')     AS title,
    json_extract(data, '$.links')     AS links,
    json_extract(data, '$.tags')      AS tags,
    json_extract(data, '$.color')     AS color,
    json_extract(data, '$.private')   AS priv,
    json_extract(data, '$.createdAt') AS createdAt,
    json_extract(data, '$.updatedAt') AS updatedAt,
    json_extract(data, '$.metadata')  AS metadata
  FROM pages
`;

function rowToMeta(r) {
  return {
    id:        r.id,
    kind:      r.kind ?? 'note',
    title:     r.title ?? '',
    links:     r.links     ? JSON.parse(r.links)     : [],
    tags:      r.tags      ? JSON.parse(r.tags)      : undefined,
    color:     r.color     || undefined,
    private:   r.priv === 1 || r.priv === true || r.priv === 'true',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    metadata:  r.metadata  ? JSON.parse(r.metadata)  : undefined,
  };
}

export function getRecentPagesFromStore(limit = 50) {
  if (!database) return [];
  return database.prepare(`${META_SELECT} ORDER BY updated_at DESC LIMIT ?`).all(limit).map(rowToMeta);
}

export function getAllPagesMetaFromStore() {
  if (!database) return [];
  return database.prepare(`${META_SELECT} ORDER BY updated_at DESC`).all().map(rowToMeta);
}

export function getPageCountsFromStore() {
  if (!database) return { total: 0, byKind: {} };
  const total  = database.prepare('SELECT COUNT(*) AS n FROM pages').get()?.n ?? 0;
  const rows   = database.prepare(
    "SELECT json_extract(data, '$.kind') AS kind, COUNT(*) AS n FROM pages GROUP BY json_extract(data, '$.kind')",
  ).all();
  const byKind = {};
  for (const r of rows) { if (r.kind) byKind[r.kind] = r.n; }
  return { total, byKind };
}

// ── Privacy violations log ────────────────────────────────────────────────────
// Logs blocked cloud calls (no content ever stored here).

export function insertPrivacyViolation({ functionCalled, providerTargeted }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO privacy_violations (occurred_at, function_called, provider_targeted)
    VALUES (CURRENT_TIMESTAMP, ?, ?)
  `).run(functionCalled, providerTargeted);

  insertActivityLog({
    opType: 'privacy_block',
    item:   functionCalled,
    result: 'failure',
    reason: `verrou de sortie — cloud "${providerTargeted}" bloqué`,
  });
}

export function getPrivacyViolations(limit = 100) {
  if (!database) return [];
  return database.prepare(
    'SELECT id, occurred_at, function_called, provider_targeted FROM privacy_violations ORDER BY occurred_at DESC LIMIT ?'
  ).all(limit);
}

export function insertInboxPending({ id, title, content, tags, meta, created_at }) {
  if (!database) return;
  statements.insertInboxPending.run(id, title, content, tags, meta, created_at);
}

export function getInboxPending() {
  if (!database) return [];
  return statements.getInboxPending.all().map(row => ({
    id:         row.id,
    title:      row.title,
    content:    row.content,
    tags:       JSON.parse(row.tags  ?? '[]'),
    metadata:   JSON.parse(row.metadata ?? '{}'),
    created_at: row.created_at,
  }));
}

export function markInboxConsumed(id) {
  if (!database) return;
  statements.markInboxConsumed.run(id);
}

// ── Lecteur audio (lo-fi ambiant) ─────────────────────────────────────────────

const AUDIO_PLAYER_META = 'audio_player_settings';

export function getAudioPlayerSettings() {
  return getMeta(AUDIO_PLAYER_META, {
    localFolder:      null,
    customStreams:    [],
    source:           'radio',
    selectedRadioId:  RADIO_STATIONS[0].id,
  });
}

export function setAudioPlayerSettings(updates) {
  const current = getAudioPlayerSettings();
  setMeta(AUDIO_PLAYER_META, { ...current, ...updates });
}

export function getAudioPlayerPresets() {
  return RADIO_STATIONS;
}

// ── Fichiers déposés ────────────────────────────────────────────────────────

export function getFileOriginals() {
  if (!database) return [];
  return statements.getFileOriginals.all().map(row => ({
    ...row,
    metadata: safeJson(row.metadata, {}),
    size_bytes: Number(row.size_bytes ?? 0),
    treatments_count: Number(row.result_count ?? row.treatments_count ?? 0),
    result_count: Number(row.result_count ?? 0),
  }));
}

export function getFileOriginalById(id) {
  if (!database) return null;
  const row = statements.getFileOriginalById.get(id);
  if (!row) return null;
  return {
    ...row,
    metadata: safeJson(row.metadata, {}),
    size_bytes: Number(row.size_bytes ?? 0),
    treatments_count: Number(row.treatments_count ?? 0),
  };
}

export function upsertFileOriginal(file) {
  if (!database) return;
  statements.upsertFileOriginal.run(
    file.id,
    file.original_name,
    file.stored_name,
    file.extension,
    file.mime_type,
    file.size_bytes,
    file.uploaded_at,
    file.checksum,
    JSON.stringify(file.metadata ?? {}),
    file.treatments_count ?? 0,
  );
}

export function updateFileOriginalTreatments(id, treatmentsCount) {
  if (!database) return;
  statements.updateFileOriginalTreatments.run(treatmentsCount, id);
}

export function deleteFileOriginal(id) {
  if (!database) return;
  statements.deleteFileOriginal.run(id);
}

export function getFileResultsByOriginal(originalId) {
  if (!database) return [];
  return statements.getFileResultsByOriginal.all(originalId).map(row => ({
    ...row,
    metadata: safeJson(row.metadata, {}),
    cloud_allowed: row.cloud_allowed === 1,
    size_bytes: Number(row.size_bytes ?? 0),
  }));
}

export function getFileResultById(id) {
  if (!database) return null;
  const row = statements.getFileResultById.get(id);
  if (!row) return null;
  return {
    ...row,
    metadata: safeJson(row.metadata, {}),
    cloud_allowed: row.cloud_allowed === 1,
    size_bytes: Number(row.size_bytes ?? 0),
  };
}

export function getFileResults() {
  if (!database) return [];
  return statements.getFileResults.all().map(row => ({
    ...row,
    metadata: safeJson(row.metadata, {}),
    cloud_allowed: row.cloud_allowed === 1,
    size_bytes: Number(row.size_bytes ?? 0),
  }));
}

export function getFileResultByPath(filePath) {
  if (!database) return null;
  const row = statements.getFileResultByPath.get(filePath);
  if (!row) return null;
  return {
    ...row,
    metadata: safeJson(row.metadata, {}),
    cloud_allowed: row.cloud_allowed === 1,
    size_bytes: Number(row.size_bytes ?? 0),
  };
}

export function upsertFileResult(file) {
  if (!database) return;
  statements.upsertFileResult.run(
    file.id,
    file.original_id,
    file.competence,
    file.result_kind,
    file.original_name,
    file.stored_name,
    file.extension,
    file.mime_type,
    file.size_bytes,
    file.created_at,
    file.checksum,
    file.path,
    file.cloud_allowed ? 1 : 0,
    JSON.stringify(file.metadata ?? {}),
  );
}

export function deleteFileResult(id) {
  if (!database) return;
  statements.deleteFileResult.run(id);
}

// ── Journal d'activité ─────────────────────────────────────────────────────
// Jamais de contenu de neurone, jamais de clé API, jamais d'audio/image —
// uniquement : quoi, quand, résultat, raison d'échec, durée, modèle.

export function insertActivityLog({ opType, item = '', result = 'success', reason = null, durationMs = null, modelUsed = null }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO activity_log (timestamp, op_type, item, result, reason, duration_ms, model_used)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    opType,
    String(item ?? '').slice(0, 300),
    result,
    reason ? String(reason).slice(0, 500) : null,
    durationMs !== null && durationMs !== undefined ? Math.round(durationMs) : null,
    modelUsed,
  );
}

export function getActivityLog({ opType, result, from, to, q, limit = 50, offset = 0 } = {}) {
  if (!database) return { rows: [], total: 0 };
  const clauses = [];
  const params  = [];
  if (opType) { clauses.push('op_type = ?'); params.push(opType); }
  if (result) { clauses.push('result = ?'); params.push(result); }
  if (from)   { clauses.push('timestamp >= ?'); params.push(from); }
  if (to)     { clauses.push('timestamp <= ?'); params.push(to); }
  if (q)      { clauses.push('(item LIKE ? OR reason LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = database.prepare(`SELECT COUNT(*) AS n FROM activity_log ${where}`).get(...params).n;
  const rows  = database.prepare(
    `SELECT * FROM activity_log ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0));

  return { rows, total };
}

// Unpaginated — export only. Journal entries never leave the machine on their
// own (see routes/activity.js localhost guard); this just avoids the 200-row
// page-size clamp on getActivityLog when the user explicitly asks to export.
export function getAllActivityLogForExport() {
  if (!database) return [];
  return database.prepare('SELECT * FROM activity_log ORDER BY timestamp DESC, id DESC').all();
}

export function getActivityLogOpTypes() {
  if (!database) return [];
  return database.prepare('SELECT DISTINCT op_type FROM activity_log ORDER BY op_type ASC').all().map(r => r.op_type);
}

export function clearActivityLog() {
  if (!database) return 0;
  const result = database.prepare('DELETE FROM activity_log').run();
  return result.changes;
}

export function purgeActivityLogOlderThan(days) {
  if (!database) return 0;
  const cutoff = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
  const result = database.prepare('DELETE FROM activity_log WHERE timestamp < ?').run(cutoff);
  return result.changes;
}

export function getActivityLogStats() {
  if (!database) return { count: 0, sizeBytes: 0, retentionDays: 90 };
  const count = database.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
  let sizeBytes = 0;
  try {
    const row = database.prepare("SELECT SUM(pgsize) AS n FROM dbstat WHERE name = 'activity_log'").get();
    sizeBytes = row?.n ?? 0;
  } catch {
    // dbstat virtual table not compiled in this better-sqlite3 build — rough estimate instead
    sizeBytes = count * 180;
  }
  return { count, sizeBytes, retentionDays: getActivityLogRetentionDays() };
}

export function getActivityLogRetentionDays() {
  return getMeta('activity_log_retention_days', 90);
}

export function setActivityLogRetentionDays(days) {
  const clamped = Math.max(1, Math.min(365, Number(days) || 90));
  setMeta('activity_log_retention_days', clamped);
  return clamped;
}

// ── Corpus de référence (import de connaissances externes) ───────────────────

export function insertCorpusSource({ id, name, keywords = '', min_size = null, max_size = null }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO corpus_sources (id, name, keywords, min_size, max_size, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'importing', CURRENT_TIMESTAMP)
  `).run(id, name, keywords, min_size, max_size);
}

export function updateCorpusSource(id, updates) {
  if (!database) return;
  const fields = [];
  const vals   = [];
  if (updates.article_count !== undefined) { fields.push('article_count = ?'); vals.push(updates.article_count); }
  if (updates.size_bytes    !== undefined) { fields.push('size_bytes = ?');    vals.push(updates.size_bytes); }
  if (updates.status        !== undefined) { fields.push('status = ?');        vals.push(updates.status); }
  if (updates.error_count   !== undefined) { fields.push('error_count = ?');   vals.push(updates.error_count); }
  if (fields.length === 0) return;
  vals.push(id);
  database.prepare(`UPDATE corpus_sources SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function getCorpusSources() {
  if (!database) return [];
  return database.prepare('SELECT * FROM corpus_sources ORDER BY created_at DESC').all();
}

export function getCorpusSourceById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM corpus_sources WHERE id = ?').get(id) ?? null;
}

export function deleteCorpusSource(id) {
  if (!database) return;
  database.prepare('DELETE FROM corpus_sources WHERE id = ?').run(id);
}

// ── OAuth connectors (YouTube / OneDrive) — connection state only, never a
// token (tokens live in secret-store.js). See routes/connectors.js. ────────

export function getConnectorState(provider) {
  if (!database) return null;
  const row = database.prepare('SELECT * FROM oauth_connections WHERE provider = ?').get(provider);
  if (!row) return null;
  return { ...row, connected: !!row.connected, auto_sync: !!row.auto_sync, scopes: JSON.parse(row.scopes || '[]') };
}

export function getAllConnectorStates() {
  if (!database) return [];
  return database.prepare('SELECT * FROM oauth_connections').all()
    .map(row => ({ ...row, connected: !!row.connected, auto_sync: !!row.auto_sync, scopes: JSON.parse(row.scopes || '[]') }));
}

export function upsertConnectorState(provider, { connected, account_label, scopes, auto_sync, connected_at } = {}) {
  if (!database) return;
  const existing = getConnectorState(provider);
  database.prepare(`
    INSERT INTO oauth_connections (provider, connected, account_label, scopes, auto_sync, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider) DO UPDATE SET
      connected = excluded.connected,
      account_label = excluded.account_label,
      scopes = excluded.scopes,
      auto_sync = excluded.auto_sync,
      connected_at = COALESCE(excluded.connected_at, oauth_connections.connected_at),
      updated_at = CURRENT_TIMESTAMP
  `).run(
    provider,
    connected !== undefined ? (connected ? 1 : 0) : (existing?.connected ? 1 : 0),
    account_label !== undefined ? account_label : (existing?.account_label ?? null),
    JSON.stringify(scopes !== undefined ? scopes : (existing?.scopes ?? [])),
    auto_sync !== undefined ? (auto_sync ? 1 : 0) : (existing?.auto_sync ? 1 : 0),
    connected_at !== undefined ? connected_at : (existing?.connected_at ?? null),
  );
}

export function recordConnectorSyncResult(provider, { status, error = null } = {}) {
  if (!database) return;
  database.prepare(`
    UPDATE oauth_connections SET last_sync_at = CURRENT_TIMESTAMP, last_sync_status = ?, last_sync_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE provider = ?
  `).run(status, error, provider);
}

export function disconnectConnector(provider) {
  if (!database) return;
  database.prepare(`
    UPDATE oauth_connections SET connected = 0, connected_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE provider = ?
  `).run(provider);
}

// ── Connector sync dedup ledger ──────────────────────────────────────────────

export function getConnectorSyncItem(provider, externalId) {
  if (!database) return null;
  return database.prepare('SELECT * FROM connector_sync_items WHERE provider = ? AND external_id = ?').get(provider, externalId) ?? null;
}

export function upsertConnectorSyncItem(provider, externalId, { pageId, contentHash = null } = {}) {
  if (!database) return;
  database.prepare(`
    INSERT INTO connector_sync_items (provider, external_id, page_id, content_hash, synced_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, external_id) DO UPDATE SET
      page_id = excluded.page_id, content_hash = excluded.content_hash, synced_at = CURRENT_TIMESTAMP
  `).run(provider, externalId, pageId, contentHash);
}

export function getConnectorSyncItemsCount(provider) {
  if (!database) return 0;
  return database.prepare('SELECT COUNT(*) AS n FROM connector_sync_items WHERE provider = ?').get(provider)?.n ?? 0;
}

export function deleteConnectorSyncItems(provider) {
  if (!database) return [];
  const rows = database.prepare('SELECT page_id FROM connector_sync_items WHERE provider = ?').all(provider);
  database.prepare('DELETE FROM connector_sync_items WHERE provider = ?').run(provider);
  return rows.map(r => r.page_id);
}

export function getConnectorDeltaToken(provider) {
  if (!database) return null;
  return database.prepare('SELECT delta_token FROM connector_sync_state WHERE provider = ?').get(provider)?.delta_token ?? null;
}

export function setConnectorDeltaToken(provider, deltaToken) {
  if (!database) return;
  database.prepare(`
    INSERT INTO connector_sync_state (provider, delta_token, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider) DO UPDATE SET delta_token = excluded.delta_token, updated_at = CURRENT_TIMESTAMP
  `).run(provider, deltaToken);
}

// ── Conversation mode (chat) — always private, own tables, never indexed ─────

export function createConversation(id, title = '') {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
  `).run(id, title, now, now);
}

export function listConversations(limit = 50) {
  if (!database) return [];
  return database.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit);
}

export function getConversationById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM conversations WHERE id = ?').get(id) ?? null;
}

export function touchConversation(id, title) {
  if (!database) return;
  const now = new Date().toISOString();
  if (title !== undefined) {
    database.prepare('UPDATE conversations SET updated_at = ?, title = ? WHERE id = ?').run(now, title, id);
  } else {
    database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);
  }
}

export function deleteConversation(id) {
  if (!database) return;
  database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  database.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id);
}

export function addConversationMessage(conversationId, role, content) {
  if (!database) return;
  database.prepare(`
    INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), conversationId, role, content, new Date().toISOString());
}

// limit is applied to the MOST RECENT messages (the "last N exchanges" context
// window) — ORDER BY DESC then reversed, not a plain ORDER BY ASC LIMIT which
// would return the OLDEST messages instead.
export function getConversationMessages(conversationId, limit = 20) {
  if (!database) return [];
  const rows = database.prepare(
    'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(conversationId, limit);
  return rows.reverse();
}

export function getAllConversationsForBackup() {
  if (!database) return [];
  const conversations = database.prepare('SELECT * FROM conversations ORDER BY created_at ASC').all();
  return conversations.map(conv => ({
    ...conv,
    messages: database.prepare(
      'SELECT role, content, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC',
    ).all(conv.id),
  }));
}

// ── Preference facts — flat list, not a conversation history ─────────────────

const MAX_PREFERENCE_FACTS = 50;

export function listPreferenceFacts() {
  if (!database) return [];
  // Batch C (audit finding F4): the table is already capped at write time by
  // MAX_PREFERENCE_FACTS below, so this LIMIT changes no real behavior today
  // — it just makes the read side explicitly consistent with the paginated
  // pattern used elsewhere instead of relying solely on the write-side gate.
  return database.prepare('SELECT * FROM preference_facts ORDER BY created_at ASC LIMIT ?').all(MAX_PREFERENCE_FACTS);
}

export function countPreferenceFacts() {
  if (!database) return 0;
  return database.prepare('SELECT COUNT(*) AS n FROM preference_facts').get().n;
}

// `meta` is optional and additive — existing callers (manual /chat/preferences
// entry) keep working unchanged with source='manual', egress_policy=
// 'cloud_allowed' (their historical behavior). The adaptive-memory extractor
// (lib/memory.js) passes source/privacy/egress_policy/importance/confidence
// explicitly, propagating the privacy level of whatever it learned from.
export function addPreferenceFact(fact, meta = {}) {
  if (!database) return null;
  if (countPreferenceFacts() >= MAX_PREFERENCE_FACTS) {
    throw new Error(`Limite de ${MAX_PREFERENCE_FACTS} faits retenus atteinte — supprimez-en un avant d'en ajouter un nouveau.`);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO preference_facts (id, fact, created_at, updated_at, source, source_ref, privacy, egress_policy, importance, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, fact, now, now,
    meta.source ?? 'manual', meta.sourceRef ?? null,
    meta.privacy ? 1 : 0, meta.egressPolicy ?? (meta.privacy ? 'local_only' : 'cloud_allowed'),
    meta.importance ?? 0.5, meta.confidence ?? 0.5,
  );
  return id;
}

export function updatePreferenceFact(id, fact) {
  if (!database) return;
  database.prepare('UPDATE preference_facts SET fact = ?, updated_at = ? WHERE id = ?').run(fact, new Date().toISOString(), id);
}

export function deletePreferenceFact(id) {
  if (!database) return;
  database.prepare('DELETE FROM preference_facts WHERE id = ?').run(id);
}

export function clearPreferenceFacts() {
  if (!database) return;
  database.prepare('DELETE FROM preference_facts').run();
}

export function touchPreferenceFact(id) {
  if (!database) return;
  database.prepare('UPDATE preference_facts SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

// ── Episodic memory — mid-term tier, extracted from searches/neurons/corrections ─

const MAX_EPISODIC_MEMORIES = 2000; // scale ceiling; dedup keeps real growth well below this

export function listEpisodicMemories({ limit = 500, offset = 0 } = {}) {
  if (!database) return [];
  return database.prepare('SELECT * FROM episodic_memories ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

export function countEpisodicMemories() {
  if (!database) return 0;
  return database.prepare('SELECT COUNT(*) AS n FROM episodic_memories').get().n;
}

export function getEpisodicMemory(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM episodic_memories WHERE id = ?').get(id) ?? null;
}

export function addEpisodicMemory({ text, category = 'general', source = 'manual', sourceRef = null, privacy = false, egressPolicy = null, importance = 0.5, confidence = 0.5 }) {
  if (!database) return null;
  if (countEpisodicMemories() >= MAX_EPISODIC_MEMORIES) {
    // Evict the least-valuable memory (lowest importance, then oldest last_used)
    // rather than throwing — episodic memory is meant to self-manage, unlike
    // the hard-capped manual preference_facts list.
    const victim = database.prepare(`
      SELECT id FROM episodic_memories ORDER BY importance ASC, COALESCE(last_used_at, created_at) ASC LIMIT 1
    `).get();
    if (victim) database.prepare('DELETE FROM episodic_memories WHERE id = ?').run(victim.id);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO episodic_memories (id, text, category, source, source_ref, privacy, egress_policy, importance, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, text, category, source, sourceRef, privacy ? 1 : 0, egressPolicy ?? (privacy ? 'local_only' : 'cloud_allowed'), importance, confidence, now, now);
  return id;
}

export function touchEpisodicMemory(id) {
  if (!database) return;
  database.prepare('UPDATE episodic_memories SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function deleteEpisodicMemory(id) {
  if (!database) return;
  database.prepare('DELETE FROM episodic_memories WHERE id = ?').run(id);
}

export function clearEpisodicMemories() {
  if (!database) return;
  database.prepare('DELETE FROM episodic_memories').run();
}

// ── Local Notebook (Phase 5) ────────────────────────────────────────────────

function parseNotebook(row) {
  if (!row) return null;
  return { ...row, privacy: !!row.privacy, settings: JSON.parse(row.settings || '{}') };
}

export function createNotebook({ id, title, description = '' }) {
  if (!database) return null;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO notebooks (id, title, description, privacy, egress_policy, settings, created_at, updated_at)
    VALUES (?, ?, ?, 0, 'cloud_allowed', '{}', ?, ?)
  `).run(id, title, description, now, now);
  return id;
}

export function listNotebooks() {
  if (!database) return [];
  return database.prepare(`
    SELECT n.*, COUNT(s.id) AS source_count
    FROM notebooks n LEFT JOIN notebook_sources s ON s.notebook_id = n.id
    GROUP BY n.id ORDER BY n.updated_at DESC
  `).all().map(row => ({ ...parseNotebook(row), source_count: row.source_count }));
}

export function getNotebook(id) {
  if (!database) return null;
  return parseNotebook(database.prepare('SELECT * FROM notebooks WHERE id = ?').get(id));
}

export function updateNotebook(id, { title, description } = {}) {
  if (!database) return;
  const fields = []; const vals = [];
  if (title !== undefined) { fields.push('title = ?'); vals.push(title); }
  if (description !== undefined) { fields.push('description = ?'); vals.push(description); }
  if (fields.length === 0) return;
  fields.push('updated_at = ?'); vals.push(new Date().toISOString());
  vals.push(id);
  database.prepare(`UPDATE notebooks SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

// Only callable by the derived-privacy recomputation (lib/notebook.js) —
// never directly from a route handler with client-supplied values.
export function setNotebookPrivacy(id, { privacy, egressPolicy }) {
  if (!database) return;
  database.prepare('UPDATE notebooks SET privacy = ?, egress_policy = ?, updated_at = updated_at WHERE id = ?')
    .run(privacy ? 1 : 0, egressPolicy, id);
}

export function deleteNotebook(id) {
  if (!database) return;
  database.prepare('DELETE FROM notebook_sources WHERE notebook_id = ?').run(id);
  database.prepare('DELETE FROM notebook_summaries WHERE notebook_id = ?').run(id);
  database.prepare('DELETE FROM notebooks WHERE id = ?').run(id);
}

export function addNotebookSource({ id, notebookId, sourceType = 'neuron', sourceId, title, provenance = '', privacy = false, egressPolicy = 'cloud_allowed' }) {
  if (!database) return null;
  database.prepare(`
    INSERT INTO notebook_sources (id, notebook_id, source_type, source_id, title, provenance, privacy, egress_policy, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, notebookId, sourceType, sourceId, title, provenance, privacy ? 1 : 0, egressPolicy, new Date().toISOString());
  database.prepare('UPDATE notebooks SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), notebookId);
  invalidateNotebookSummaries(notebookId);
  return id;
}

export function listNotebookSources(notebookId, { limit = 500, offset = 0 } = {}) {
  if (!database) return [];
  return database.prepare('SELECT * FROM notebook_sources WHERE notebook_id = ? ORDER BY added_at DESC LIMIT ? OFFSET ?')
    .all(notebookId, limit, offset)
    .map(row => ({ ...row, privacy: !!row.privacy }));
}

export function countNotebookSources(notebookId) {
  if (!database) return 0;
  return database.prepare('SELECT COUNT(*) AS n FROM notebook_sources WHERE notebook_id = ?').get(notebookId)?.n ?? 0;
}

export function removeNotebookSource(notebookId, sourceRowId) {
  if (!database) return;
  database.prepare('DELETE FROM notebook_sources WHERE id = ? AND notebook_id = ?').run(sourceRowId, notebookId);
  database.prepare('UPDATE notebooks SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), notebookId);
  invalidateNotebookSummaries(notebookId);
}

// Re-indexing a single modified source never touches the rest of the
// notebook — mission requirement ("réindexer uniquement cette source").
export function touchNotebookSource(notebookId, sourceRowId, { title } = {}) {
  if (!database) return;
  if (title !== undefined) database.prepare('UPDATE notebook_sources SET title = ? WHERE id = ? AND notebook_id = ?').run(title, sourceRowId, notebookId);
  invalidateNotebookSummaries(notebookId);
}

export function getNotebookSummary(notebookId, level, themeKey = '') {
  if (!database) return null;
  return database.prepare('SELECT * FROM notebook_summaries WHERE notebook_id = ? AND level = ? AND theme_key = ?').get(notebookId, level, themeKey) ?? null;
}

export function setNotebookSummary(notebookId, level, themeKey, content, sourcesHash) {
  if (!database) return;
  database.prepare(`
    INSERT INTO notebook_summaries (notebook_id, level, theme_key, content, sources_hash, generated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(notebook_id, level, theme_key) DO UPDATE SET
      content = excluded.content, sources_hash = excluded.sources_hash, generated_at = excluded.generated_at
  `).run(notebookId, level, themeKey, content, sourcesHash, new Date().toISOString());
}

export function invalidateNotebookSummaries(notebookId) {
  if (!database) return;
  database.prepare('DELETE FROM notebook_summaries WHERE notebook_id = ?').run(notebookId);
}

// ── Résumé de vidéo longue — jobs durables et segments résumables ────────────

function parseVideoJob(row) {
  if (!row) return null;
  return {
    ...row,
    cancelled: row.cancelled === 1,
    private:   row.private === 1,
    metadata:  safeJson(row.metadata, {}),
  };
}

export function insertVideoJob({ id, url, title = null, status = 'pending', provider_whisper = 'auto', provider_synthesis = 'local', resume_type = 'auto', duration_s = null, private: priv = false, metadata = {} }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO video_jobs (id, url, title, status, provider_whisper, provider_synthesis, resume_type, duration_s, current_step, created_at, updated_at, cancelled, private, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?)
  `).run(id, url, title, status, provider_whisper, provider_synthesis, resume_type, duration_s, now, now, priv ? 1 : 0, JSON.stringify(metadata ?? {}));
}

export function updateVideoJob(id, updates) {
  if (!database) return;
  const fields = [];
  const vals   = [];
  if (updates.title              !== undefined) { fields.push('title = ?');              vals.push(updates.title); }
  if (updates.status             !== undefined) { fields.push('status = ?');             vals.push(updates.status); }
  if (updates.provider_whisper   !== undefined) { fields.push('provider_whisper = ?');   vals.push(updates.provider_whisper); }
  if (updates.provider_synthesis !== undefined) { fields.push('provider_synthesis = ?'); vals.push(updates.provider_synthesis); }
  if (updates.resume_type        !== undefined) { fields.push('resume_type = ?');        vals.push(updates.resume_type); }
  if (updates.duration_s         !== undefined) { fields.push('duration_s = ?');         vals.push(updates.duration_s); }
  if (updates.current_step       !== undefined) { fields.push('current_step = ?');       vals.push(updates.current_step); }
  if (updates.error_message      !== undefined) { fields.push('error_message = ?');      vals.push(updates.error_message); }
  if (updates.cancelled          !== undefined) { fields.push('cancelled = ?');          vals.push(updates.cancelled ? 1 : 0); }
  if (updates.neuron_id          !== undefined) { fields.push('neuron_id = ?');          vals.push(updates.neuron_id); }
  if (updates.disk_bytes         !== undefined) { fields.push('disk_bytes = ?');         vals.push(updates.disk_bytes); }
  if (updates.metadata           !== undefined) { fields.push('metadata = ?');           vals.push(JSON.stringify(updates.metadata ?? {})); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE video_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function getVideoJobById(id) {
  if (!database) return null;
  return parseVideoJob(database.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id));
}

export function getAllVideoJobs() {
  if (!database) return [];
  return database.prepare('SELECT * FROM video_jobs ORDER BY created_at DESC').all().map(parseVideoJob);
}

export function getActiveVideoJob() {
  if (!database) return null;
  const row = database.prepare(`
    SELECT * FROM video_jobs
    WHERE cancelled = 0 AND status NOT IN ('done', 'error', 'cancelled')
    ORDER BY created_at DESC LIMIT 1
  `).get();
  return parseVideoJob(row);
}

export function deleteVideoJob(id) {
  if (!database) return;
  database.prepare('DELETE FROM video_job_segments WHERE job_id = ?').run(id);
  database.prepare('DELETE FROM video_jobs WHERE id = ?').run(id);
}

export function insertVideoJobSegment({ id, job_id, idx, start_s = null, end_s = null, audio_path = null }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO video_job_segments (id, job_id, idx, start_s, end_s, audio_path, transcript_status, summary_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)
  `).run(id, job_id, idx, start_s, end_s, audio_path, now, now);
}

export function updateVideoJobSegment(id, updates) {
  if (!database) return;
  const fields = [];
  const vals   = [];
  if (updates.audio_path        !== undefined) { fields.push('audio_path = ?');        vals.push(updates.audio_path); }
  if (updates.transcript        !== undefined) { fields.push('transcript = ?');        vals.push(updates.transcript); }
  if (updates.transcript_status !== undefined) { fields.push('transcript_status = ?'); vals.push(updates.transcript_status); }
  if (updates.summary           !== undefined) { fields.push('summary = ?');           vals.push(updates.summary); }
  if (updates.summary_status    !== undefined) { fields.push('summary_status = ?');    vals.push(updates.summary_status); }
  if (updates.error_message     !== undefined) { fields.push('error_message = ?');     vals.push(updates.error_message); }
  if (updates.start_s           !== undefined) { fields.push('start_s = ?');           vals.push(updates.start_s); }
  if (updates.end_s             !== undefined) { fields.push('end_s = ?');             vals.push(updates.end_s); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE video_job_segments SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function getSegmentsByJobId(jobId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM video_job_segments WHERE job_id = ? ORDER BY idx ASC').all(jobId);
}

export function deleteSegmentsByJobId(jobId) {
  if (!database) return;
  database.prepare('DELETE FROM video_job_segments WHERE job_id = ?').run(jobId);
}

// ── Générateur de prompts — table dédiée, complètement isolée des neurones ────

function parseGeneratedPrompt(row) {
  if (!row) return null;
  return {
    ...row,
    unchanged:   row.unchanged === 1,
    is_template: row.is_template === 1,
  };
}

export function getAllGeneratedPrompts({ from, to, model, outcome, is_template } = {}) {
  if (!database) return [];
  const clauses = [];
  const vals    = [];
  if (from)        { clauses.push('created_at >= ?'); vals.push(from); }
  if (to)           { clauses.push('created_at <= ?'); vals.push(to); }
  if (model)        { clauses.push('(draft_model = ? OR review_model = ?)'); vals.push(model, model); }
  if (outcome)       { clauses.push('outcome = ?'); vals.push(outcome); }
  if (is_template !== undefined) { clauses.push('is_template = ?'); vals.push(is_template ? 1 : 0); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return database.prepare(`
    SELECT * FROM generated_prompts ${where}
    ORDER BY is_template DESC, created_at DESC
  `).all(...vals).map(parseGeneratedPrompt);
}

export function getGeneratedPromptById(id) {
  if (!database) return null;
  return parseGeneratedPrompt(database.prepare('SELECT * FROM generated_prompts WHERE id = ?').get(id));
}

export function countGeneratedPrompts() {
  if (!database) return 0;
  return database.prepare('SELECT COUNT(*) as n FROM generated_prompts').get().n;
}

export function insertGeneratedPrompt({
  id, request, draft_model, draft_provider, draft_text,
  review_model, review_provider, reviewed_text, changes_explained,
  unchanged = false, kept_version = null, outcome = 'untested', is_template = false,
}) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO generated_prompts (
      id, request, draft_model, draft_provider, draft_text,
      review_model, review_provider, reviewed_text, changes_explained,
      unchanged, kept_version, outcome, is_template, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, request, draft_model, draft_provider, draft_text ?? '',
    review_model, review_provider, reviewed_text ?? '', changes_explained ?? '',
    unchanged ? 1 : 0, kept_version, outcome, is_template ? 1 : 0, now, now,
  );
}

export function updateGeneratedPrompt(id, updates) {
  if (!database) return;
  const fields = [];
  const vals   = [];
  if (updates.draft_text         !== undefined) { fields.push('draft_text = ?');         vals.push(updates.draft_text); }
  if (updates.reviewed_text      !== undefined) { fields.push('reviewed_text = ?');      vals.push(updates.reviewed_text); }
  if (updates.changes_explained  !== undefined) { fields.push('changes_explained = ?');  vals.push(updates.changes_explained); }
  if (updates.unchanged          !== undefined) { fields.push('unchanged = ?');          vals.push(updates.unchanged ? 1 : 0); }
  if (updates.kept_version       !== undefined) { fields.push('kept_version = ?');       vals.push(updates.kept_version); }
  if (updates.outcome            !== undefined) { fields.push('outcome = ?');            vals.push(updates.outcome); }
  if (updates.is_template        !== undefined) { fields.push('is_template = ?');        vals.push(updates.is_template ? 1 : 0); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE generated_prompts SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteGeneratedPrompt(id) {
  if (!database) return;
  database.prepare('DELETE FROM generated_prompts WHERE id = ?').run(id);
}

export function searchGeneratedPrompts(query) {
  if (!database) return [];
  const like = `%${query}%`;
  return database.prepare(`
    SELECT * FROM generated_prompts
    WHERE request LIKE ? OR draft_text LIKE ? OR reviewed_text LIKE ?
    ORDER BY is_template DESC, created_at DESC
  `).all(like, like, like).map(parseGeneratedPrompt);
}

// ── Générateur de prompts — réglages (meta key, pas de nouvelles colonnes) ────

export function getPromptGeneratorSettings() {
  return getMeta('prompt_generator_settings', {
    default_draft_model:    null,
    default_draft_provider:  null,
    default_review_model:    null,
    default_review_provider: null,
  });
}

export function setPromptGeneratorSettings(updates) {
  const current = getPromptGeneratorSettings();
  setMeta('prompt_generator_settings', { ...current, ...updates });
}

// ── Générateur de prompts — destinations d'envoi (KV, liste ordonnée) ────────

const PROMPT_DESTINATIONS_META = 'prompt_destinations';

function defaultPromptDestinations() {
  const mk = (name, url, category, order) => ({
    id: crypto.randomUUID(), name, url, category, urlTemplate: '', favorite: false, order,
  });
  let order = 0;
  return [
    mk('Replit',  'https://replit.com',          'DÉVELOPPEMENT / GÉNÉRATION D\'APPLICATIONS', order++),
    mk('Lovable', 'https://lovable.dev',          'DÉVELOPPEMENT / GÉNÉRATION D\'APPLICATIONS', order++),
    mk('Bolt',    'https://bolt.new',             'DÉVELOPPEMENT / GÉNÉRATION D\'APPLICATIONS', order++),
    mk('v0',      'https://v0.dev',               'DÉVELOPPEMENT / GÉNÉRATION D\'APPLICATIONS', order++),
    mk('GitHub',  'https://github.com',           'DÉVELOPPEMENT / GÉNÉRATION D\'APPLICATIONS', order++),
    mk('Claude',   'https://claude.ai',           'ASSISTANTS IA (web)', order++),
    mk('ChatGPT',  'https://chatgpt.com',         'ASSISTANTS IA (web)', order++),
    mk('Gemini',   'https://gemini.google.com',   'ASSISTANTS IA (web)', order++),
    mk('Mistral (Le Chat)', 'https://chat.mistral.ai', 'ASSISTANTS IA (web)', order++),
    mk('Perplexity', 'https://www.perplexity.ai', 'ASSISTANTS IA (web)', order++),
    mk('Groq',      'https://console.groq.com',   'ASSISTANTS IA (web)', order++),
    mk('OpenRouter', 'https://openrouter.ai',     'ASSISTANTS IA (web)', order++),
    mk('Claude Code',   '', 'OUTILS LOCAUX', order++),
    mk('Aider',         '', 'OUTILS LOCAUX', order++),
    mk('Cline / VS Codium', '', 'OUTILS LOCAUX', order++),
  ];
}

export function getPromptDestinations() {
  const stored = getMeta(PROMPT_DESTINATIONS_META, null);
  if (stored && Array.isArray(stored) && stored.length > 0) return stored;
  const seeded = defaultPromptDestinations();
  setMeta(PROMPT_DESTINATIONS_META, seeded);
  return seeded;
}

export function setPromptDestinations(list) {
  setMeta(PROMPT_DESTINATIONS_META, list);
  return list;
}

// ── Générateur de prompts — événements d'envoi (SQL, historique multiple) ────

export function recordPromptSendEvent({ generatedPromptId, destinationId, destinationName, prefillUsed }) {
  if (!database) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO prompt_send_events (id, generated_prompt_id, destination_id, destination_name, prefill_used, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, generatedPromptId, destinationId, destinationName, prefillUsed ? 1 : 0, now);
  return { id, generated_prompt_id: generatedPromptId, destination_id: destinationId, destination_name: destinationName, prefill_used: !!prefillUsed, created_at: now };
}

export function getPromptSendEventsForGeneration(generatedPromptId) {
  if (!database) return [];
  return database.prepare(`
    SELECT * FROM prompt_send_events WHERE generated_prompt_id = ? ORDER BY created_at DESC
  `).all(generatedPromptId).map(row => ({ ...row, prefill_used: row.prefill_used === 1 }));
}

// ── Exemples de style — réglage global (utiliser mes exemples de style) ──────

export function getStyleExampleSettings() {
  return getMeta('style_example_settings', { enabled: false });
}

export function setStyleExampleSettings(updates) {
  const current = getStyleExampleSettings();
  const next = { ...current, ...updates };
  setMeta('style_example_settings', next);
  return next;
}

// ── Candidature — bibliothèque de prompts sauvegardés (table dédiée) ─────────

const DEFAULT_CANDIDATURE_PROMPTS = [
  {
    name: 'Bilan de compétences',
    prompt_text: `Agis comme un coach de carrière spécialisé en bilan de compétences. Réalise une analyse transversale pour m'aider à comprendre ma valeur sur le marché :
- Identifie les compétences qui ne sont pas liées à un métier précis mais qui sont exportables partout.
- Au regard des tendances actuelles du marché du travail, quels sont les domaines où mon parcours présente des lacunes ?
- Propose-moi 3 secteurs différents auxquels je n'aurais pas forcément pensé, où mes compétences actuelles seraient un avantage.`,
  },
  {
    name: 'Valeurs fondamentales',
    prompt_text: `À partir de mon parcours, déduis 5 valeurs fondamentales qui semblent guider mes décisions et mon épanouissement. Explique pourquoi tu les as choisies en te basant sur des éléments précis de mon parcours.
Liste ensuite ce dont j'ai absolument besoin dans mon prochain poste pour rester motivé sur le long terme.`,
  },
  {
    name: 'Objectif SMART',
    prompt_text: `Agis comme un coach de carrière expert. Transforme mon intention de trouver un nouveau travail en un objectif SMART concret et réalisable : spécifique, mesurable, atteignable, réaliste et temporellement défini. Détaille chaque critère.`,
  },
  {
    name: 'Métiers et opportunités',
    prompt_text: `Quels métiers ou opportunités pourraient correspondre à mon profil ? Pour chacun, explique en quoi mon parcours colle, et ce qui me manquerait éventuellement.`,
  },
  {
    name: "Ikigai — raison d'être professionnelle",
    prompt_text: `Agis comme un coach spécialisé dans la méthode Ikigai (concept japonais signifiant 'raison d'être'). Cette méthode repose sur l'intersection de quatre piliers :
1. CE QUE J'AIME — mes passions, ce qui me procure du plaisir
2. CE DANS QUOI JE SUIS DOUÉ — mes compétences, talents et forces
3. CE DONT LE MONDE A BESOIN — les causes qui me touchent, les besoins du marché et de la société
4. CE POUR QUOI JE PEUX ÊTRE PAYÉ — mon potentiel économique, les opportunités viables

À partir de mon parcours, analyse chacun des quatre piliers séparément, en citant des éléments PRÉCIS de mon CV pour chaque affirmation.
Identifie ensuite les zones de CHEVAUCHEMENT entre ces piliers, et propose des pistes professionnelles situées au carrefour des quatre.

IMPORTANT : mon CV te renseigne surtout sur les piliers 2 et 4. Pour les piliers 1 (ce que j'aime) et 3 (ce dont le monde a besoin), tu ne peux qu'émettre des HYPOTHÈSES à partir d'indices — signale-les clairement comme telles, et pose-moi les questions qui te permettraient de les affiner.`,
  },
];

function parseCandidaturePrompt(row) {
  if (!row) return null;
  return { ...row };
}

function seedDefaultCandidaturePromptsIfEmpty() {
  if (!database) return;
  const { n } = database.prepare('SELECT COUNT(*) as n FROM candidature_saved_prompts').get();
  if (n > 0) return;
  const now = new Date().toISOString();
  const insert = database.prepare(`
    INSERT INTO candidature_saved_prompts (id, name, prompt_text, order_index, last_used_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `);
  DEFAULT_CANDIDATURE_PROMPTS.forEach((p, index) => {
    insert.run(crypto.randomUUID(), p.name, p.prompt_text, index, now, now);
  });
}

export function getAllCandidatePrompts() {
  if (!database) return [];
  seedDefaultCandidaturePromptsIfEmpty();
  return database.prepare(`
    SELECT * FROM candidature_saved_prompts ORDER BY order_index ASC, created_at ASC
  `).all().map(parseCandidaturePrompt);
}

export function getCandidatePromptById(id) {
  if (!database) return null;
  return parseCandidaturePrompt(database.prepare('SELECT * FROM candidature_saved_prompts WHERE id = ?').get(id));
}

export function insertCandidatePrompt({ name, prompt_text, order_index }) {
  if (!database) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let orderIndex = order_index;
  if (orderIndex === undefined || orderIndex === null) {
    const { maxOrder } = database.prepare('SELECT MAX(order_index) as maxOrder FROM candidature_saved_prompts').get();
    orderIndex = (maxOrder ?? -1) + 1;
  }
  database.prepare(`
    INSERT INTO candidature_saved_prompts (id, name, prompt_text, order_index, last_used_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `).run(id, name, prompt_text, orderIndex, now, now);
  return getCandidatePromptById(id);
}

export function updateCandidatePrompt(id, updates) {
  if (!database) return null;
  const fields = [];
  const vals   = [];
  if (updates.name         !== undefined) { fields.push('name = ?');         vals.push(updates.name); }
  if (updates.prompt_text  !== undefined) { fields.push('prompt_text = ?');  vals.push(updates.prompt_text); }
  if (updates.order_index  !== undefined) { fields.push('order_index = ?');  vals.push(updates.order_index); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE candidature_saved_prompts SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getCandidatePromptById(id);
}

export function deleteCandidatePrompt(id) {
  if (!database) return;
  database.prepare('DELETE FROM candidature_saved_prompts WHERE id = ?').run(id);
}

export function reorderCandidatePrompts(orderedIds) {
  if (!database) return [];
  const update = database.prepare('UPDATE candidature_saved_prompts SET order_index = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  const txn = database.transaction((ids) => {
    ids.forEach((id, index) => update.run(index, now, id));
  });
  txn(orderedIds);
  return getAllCandidatePrompts();
}

export function touchCandidatePromptLastUsed(id) {
  if (!database) return null;
  database.prepare('UPDATE candidature_saved_prompts SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return getCandidatePromptById(id);
}

// ── Prompt Generator — bibliothèque de modèles ("Modèles") ───────────────────
// Même principe que candidature_saved_prompts ci-dessus : les 5 modèles
// fournis par Docteur sont insérés comme lignes normales au premier
// chargement à vide, puis deviennent des lignes utilisateur ordinaires —
// éditables et supprimables sans distinction avec un futur modèle ajouté par
// l'utilisateur. Aucun flag is_system : le principe déjà validé ailleurs
// dans ce fichier (candidature_saved_prompts) est de ne pas en avoir besoin.

const DEFAULT_PROMPT_TEMPLATES = [
  {
    name: 'Présentation d’offre — Consultant / Entrepreneur',
    category: 'Business',
    description: 'Créer une présentation commerciale claire et accrocheuse à partir des caractéristiques d’une offre.',
    prompt_text: `Tu es un expert en business model, positionnement commercial et pitch de vente.
Tu accompagnes des entrepreneurs et consultants depuis 20 ans.

Je souhaite présenter mon offre de manière claire, crédible et attractive.

Mon activité :
[ACTIVITÉ]

Mon offre :
[OFFRE]

Client cible :
[CLIENT_CIBLE]

Problème principal résolu :
[PROBLÈME]

Bénéfices principaux :
[BÉNÉFICES]

Éléments différenciants :
[DIFFÉRENCIATION]

Contraintes ou informations complémentaires :
[CONTEXTE]

Rédige une présentation accrocheuse de mon offre.

La longueur doit être adaptée à un usage professionnel classique.

Le texte doit :
- présenter clairement la valeur de l'offre ;
- mettre en avant les bénéfices pour le client ;
- éviter les promesses exagérées ;
- utiliser un langage naturel, professionnel et convaincant ;
- aboutir à une proposition de valeur facilement compréhensible.

S'il manque une information réellement nécessaire, pose-moi quelques questions ciblées avant de rédiger.

Prépare-toi ensuite à prendre en compte mes corrections et objections pour améliorer progressivement le pitch.`,
  },
  {
    name: 'Prompting inversé — Reproduire un style de contenu',
    category: 'Prompting',
    description: 'Analyser un exemple de contenu et reconstruire un prompt permettant d’obtenir un résultat du même type.',
    prompt_text: `Je vais te fournir un exemple de contenu dont j'apprécie particulièrement la rédaction.

Effectue un travail de prompting inversé afin de construire un prompt capable de générer un nouveau contenu du même type, sans simplement recopier le texte original.

Analyse notamment :

- la structure globale ;
- l'ordre des différentes parties ;
- les enchaînements logiques ;
- la manière d'introduire le sujet ;
- la construction de l'argumentation ;
- la longueur et le rythme des paragraphes ;
- la posture rédactionnelle ;
- le ton ;
- le registre de langue ;
- le niveau de technicité ;
- l'utilisation éventuelle de storytelling ;
- les appels à l'action ;
- les techniques de persuasion employées.

Exemple à analyser :

[CONTENU_EXEMPLE]

Ta réponse doit contenir :

1. une analyse synthétique de la structure et du style ;
2. les principes rédactionnels importants à reproduire ;
3. un prompt final prêt à être utilisé avec un autre sujet.

Le prompt final doit reproduire les caractéristiques générales du contenu sans demander de copier des formulations spécifiques du texte original.`,
  },
  {
    name: 'Transformer une photo en portrait professionnel',
    category: 'Image',
    description: 'Transformer une photo fournie par l’utilisateur en portrait professionnel soigné. Nécessite une image fournie manuellement — Docteur ne sélectionne jamais de photo personnelle automatiquement.',
    prompt_text: `Je suis la personne présente sur l'image fournie.

Transforme cette photo en portrait professionnel propre, naturel et soigné.

Conserve mon identité et mes principaux traits du visage.

Applique le style suivant :

- tenue professionnelle avec chemise bleue ;
- cheveux proprement coiffés ;
- apparence naturelle ;
- éclairage de studio doux et équilibré ;
- cadrage professionnel ;
- fond de bureau élégant légèrement flouté ;
- profondeur de champ réaliste ;
- rendu photographique crédible ;
- couleurs naturelles ;
- retouches discrètes.

Évite :
- de modifier fortement mon visage ;
- l'effet peau plastique ;
- les proportions irréalistes ;
- les retouches excessives ;
- le rendu artificiel typique d'une image générée.

Le résultat doit pouvoir être utilisé pour :
LinkedIn, CV, profil professionnel ou site d'entreprise.`,
  },
  {
    name: 'Résumé court et accrocheur',
    category: 'Rédaction',
    description: 'Condense un texte en deux phrases maximum tout en améliorant son impact.',
    prompt_text: `Résume le texte suivant en deux phrases maximum.

Rends le résultat plus clair, fluide et accrocheur tout en conservant fidèlement les informations essentielles.

Évite :
- les informations inventées ;
- les répétitions ;
- le jargon inutile ;
- les formulations exagérées.

Texte :

[TEXTE]`,
  },
  {
    name: 'CV optimisé ATS',
    category: 'Emploi',
    description: 'Créer ou améliorer un CV ciblé pour une offre d’emploi et les systèmes ATS.',
    prompt_text: `Tu es expert en recrutement, rédaction de CV et systèmes ATS.

Je souhaite candidater au poste suivant :

[POSTE]

Voici l'offre d'emploi si elle est disponible :

[OFFRE_EMPLOI]

Voici mes informations :

Nom :
[NOM]

Titre professionnel :
[TITRE]

Expériences :
[EXPÉRIENCES]

Compétences :
[COMPÉTENCES]

Formation :
[FORMATION]

Certifications :
[CERTIFICATIONS]

Langues :
[LANGUES]

Autres informations pertinentes :
[INFORMATIONS]

Crée un CV professionnel optimisé pour les ATS.

Consignes :

- identifier les compétences et mots-clés pertinents présents dans l'offre ;
- intégrer naturellement les mots-clés réellement compatibles avec mon expérience ;
- ne jamais inventer une compétence ou une expérience ;
- reformuler mes missions avec des verbes d'action ;
- privilégier des réalisations concrètes lorsque les informations disponibles le permettent ;
- utiliser des titres de sections standards facilement compris par les ATS ;
- éviter les éléments décoratifs susceptibles de gêner l'analyse automatique ;
- adopter un ton professionnel, moderne et factuel ;
- rendre le document facile à lire pour un recruteur humain.

Si des informations importantes manquent, indique précisément lesquelles au lieu de les inventer.`,
  },
];

function parsePromptTemplate(row) {
  if (!row) return null;
  return { ...row };
}

function seedDefaultPromptTemplatesIfEmpty() {
  if (!database) return;
  const { n } = database.prepare('SELECT COUNT(*) as n FROM prompt_templates').get();
  if (n > 0) return;
  const now = new Date().toISOString();
  const insert = database.prepare(`
    INSERT INTO prompt_templates (id, name, category, description, prompt_text, order_index, last_used_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  DEFAULT_PROMPT_TEMPLATES.forEach((p, index) => {
    insert.run(crypto.randomUUID(), p.name, p.category, p.description, p.prompt_text, index, now, now);
  });
}

export function getAllPromptTemplates() {
  if (!database) return [];
  seedDefaultPromptTemplatesIfEmpty();
  return database.prepare(`
    SELECT * FROM prompt_templates ORDER BY order_index ASC, created_at ASC
  `).all().map(parsePromptTemplate);
}

export function getPromptTemplateById(id) {
  if (!database) return null;
  return parsePromptTemplate(database.prepare('SELECT * FROM prompt_templates WHERE id = ?').get(id));
}

export function insertPromptTemplate({ name, category, description, prompt_text, order_index }) {
  if (!database) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let orderIndex = order_index;
  if (orderIndex === undefined || orderIndex === null) {
    const { maxOrder } = database.prepare('SELECT MAX(order_index) as maxOrder FROM prompt_templates').get();
    orderIndex = (maxOrder ?? -1) + 1;
  }
  database.prepare(`
    INSERT INTO prompt_templates (id, name, category, description, prompt_text, order_index, last_used_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(id, name, category ?? 'Autres', description ?? '', prompt_text, orderIndex, now, now);
  return getPromptTemplateById(id);
}

export function updatePromptTemplate(id, updates) {
  if (!database) return null;
  const fields = [];
  const vals   = [];
  if (updates.name        !== undefined) { fields.push('name = ?');        vals.push(updates.name); }
  if (updates.category    !== undefined) { fields.push('category = ?');    vals.push(updates.category); }
  if (updates.description !== undefined) { fields.push('description = ?'); vals.push(updates.description); }
  if (updates.prompt_text !== undefined) { fields.push('prompt_text = ?'); vals.push(updates.prompt_text); }
  if (updates.order_index !== undefined) { fields.push('order_index = ?'); vals.push(updates.order_index); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE prompt_templates SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getPromptTemplateById(id);
}

export function deletePromptTemplate(id) {
  if (!database) return;
  database.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id);
}

export function reorderPromptTemplates(orderedIds) {
  if (!database) return [];
  const update = database.prepare('UPDATE prompt_templates SET order_index = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  const txn = database.transaction((ids) => {
    ids.forEach((id, index) => update.run(index, now, id));
  });
  txn(orderedIds);
  return getAllPromptTemplates();
}

export function touchPromptTemplateLastUsed(id) {
  if (!database) return null;
  database.prepare('UPDATE prompt_templates SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return getPromptTemplateById(id);
}

// ── Veille — réglages (niveau de détail mémorisé) ─────────────────────────────

export function getVeilleSettings() {
  return getMeta('veille_settings', { detailLevel: 'synthese' });
}

export function setVeilleSettings(updates) {
  const current = getVeilleSettings();
  setMeta('veille_settings', { ...current, ...updates });
}

// ── Kiwix — réglages (chemin binaire, dossier archives, port) ────────────────

export function getKiwixSettings() {
  return getMeta('kiwix_settings', {
    kiwixServePath: null,
    archivesFolder: null,
    port: 8090,
    autoDetect: true,
  });
}

export function setKiwixSettings(updates) {
  const current = getKiwixSettings();
  setMeta('kiwix_settings', { ...current, ...updates });
}

export function getKiwixSearchScope() {
  return getMeta('kiwix_search_scope', 'neurones');
}

export function setKiwixSearchScope(scope) {
  setMeta('kiwix_search_scope', scope);
}

// ── Module Professeur — réglages dédiés (modèle indépendant du router général) ─

export function getTeacherSettings() {
  return getMeta('teacher_settings', {
    model: 'local',            // 'local' | 'groq:<model-id>'
    defaultRegister: 'standard',
  });
}

export function setTeacherSettings(updates) {
  const current = getTeacherSettings();
  setMeta('teacher_settings', { ...current, ...updates });
}

// ── Module Professeur — compteur d'appels quotidien par modèle (quota Groq) ───
// Table dédiée plutôt que getMeta : on incrémente à chaque appel, une ligne
// par (date, modèle) — évite de relire/réécrire tout un blob JSON à chaque appel.

export function incrementTeacherModelUsage(model) {
  if (!database) return;
  const today = new Date().toISOString().slice(0, 10);
  database.prepare(`
    INSERT INTO teacher_model_usage (date, model, calls)
    VALUES (?, ?, 1)
    ON CONFLICT(date, model) DO UPDATE SET calls = calls + 1
  `).run(today, model);
}

export function getTeacherModelUsageToday(model) {
  if (!database) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const row = database.prepare('SELECT calls FROM teacher_model_usage WHERE date = ? AND model = ?').get(today, model);
  return row?.calls ?? 0;
}

// ── Module Professeur — parcours d'apprentissage ──────────────────────────────

function parseLearningPath(row) {
  if (!row) return null;
  let plan = [];
  try { plan = JSON.parse(row.plan); } catch { plan = []; }
  return { ...row, plan };
}

export function insertLearningPath({ id, subject, register, teacher_model, status = 'planning', plan = [] }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO learning_paths (id, subject, register, teacher_model, status, plan, current_step_index, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, subject, register, teacher_model, status, JSON.stringify(plan), now, now);
}

export function updateLearningPath(id, updates) {
  if (!database) return;
  const fields = [];
  const vals = [];
  if (updates.subject             !== undefined) { fields.push('subject = ?');             vals.push(updates.subject); }
  if (updates.register            !== undefined) { fields.push('register = ?');            vals.push(updates.register); }
  if (updates.teacher_model       !== undefined) { fields.push('teacher_model = ?');       vals.push(updates.teacher_model); }
  if (updates.status              !== undefined) { fields.push('status = ?');              vals.push(updates.status); }
  if (updates.plan                !== undefined) { fields.push('plan = ?');                vals.push(JSON.stringify(updates.plan)); }
  if (updates.current_step_index  !== undefined) { fields.push('current_step_index = ?');  vals.push(updates.current_step_index); }
  if (updates.completed_at        !== undefined) { fields.push('completed_at = ?');        vals.push(updates.completed_at); }
  if (updates.recap_neuron_id     !== undefined) { fields.push('recap_neuron_id = ?');     vals.push(updates.recap_neuron_id); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE learning_paths SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function getLearningPathById(id) {
  if (!database) return null;
  return parseLearningPath(database.prepare('SELECT * FROM learning_paths WHERE id = ?').get(id));
}

export function getAllLearningPaths({ status } = {}) {
  if (!database) return [];
  if (status) {
    return database.prepare('SELECT * FROM learning_paths WHERE status = ? ORDER BY updated_at DESC').all(status).map(parseLearningPath);
  }
  return database.prepare('SELECT * FROM learning_paths ORDER BY updated_at DESC').all().map(parseLearningPath);
}

export function deleteLearningPath(id) {
  if (!database) return;
  database.prepare('DELETE FROM learning_path_steps WHERE path_id = ?').run(id);
  database.prepare('DELETE FROM learning_paths WHERE id = ?').run(id);
}

// ── Module Professeur — étapes d'un parcours ──────────────────────────────────

function parseLearningPathStep(row) {
  if (!row) return null;
  let comprehension_check = [];
  try { comprehension_check = JSON.parse(row.comprehension_check); } catch { comprehension_check = []; }
  return { ...row, comprehension_check };
}

export function insertLearningPathStep({ id, path_id, step_index, title, content = '', status = 'pending', comprehension_check = [] }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO learning_path_steps (id, path_id, step_index, title, content, status, comprehension_check, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, path_id, step_index, title, content, status, JSON.stringify(comprehension_check), now, now);
}

export function updateLearningPathStep(id, updates) {
  if (!database) return;
  const fields = [];
  const vals = [];
  if (updates.title                !== undefined) { fields.push('title = ?');                vals.push(updates.title); }
  if (updates.content              !== undefined) { fields.push('content = ?');              vals.push(updates.content); }
  if (updates.status               !== undefined) { fields.push('status = ?');               vals.push(updates.status); }
  if (updates.comprehension_check  !== undefined) { fields.push('comprehension_check = ?');  vals.push(JSON.stringify(updates.comprehension_check)); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE learning_path_steps SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function getStepsByPathId(pathId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM learning_path_steps WHERE path_id = ? ORDER BY step_index ASC').all(pathId).map(parseLearningPathStep);
}

export function getLearningPathStepById(id) {
  if (!database) return null;
  return parseLearningPathStep(database.prepare('SELECT * FROM learning_path_steps WHERE id = ?').get(id));
}

// ── Module Professeur — révision espacée ──────────────────────────────────────

export function insertReviewItem({ id, source_type, source_id, question, answer_hint = '', next_review_at }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO review_items (id, source_type, source_id, question, answer_hint, ease_factor, interval_days, next_review_at, review_count, success_count, created_at)
    VALUES (?, ?, ?, ?, ?, 2.5, 1, ?, 0, 0, ?)
  `).run(id, source_type, source_id, question, answer_hint, next_review_at ?? now, now);
}

export function updateReviewItem(id, updates) {
  if (!database) return;
  const fields = [];
  const vals = [];
  if (updates.ease_factor       !== undefined) { fields.push('ease_factor = ?');       vals.push(updates.ease_factor); }
  if (updates.interval_days     !== undefined) { fields.push('interval_days = ?');     vals.push(updates.interval_days); }
  if (updates.next_review_at    !== undefined) { fields.push('next_review_at = ?');    vals.push(updates.next_review_at); }
  if (updates.last_reviewed_at  !== undefined) { fields.push('last_reviewed_at = ?');  vals.push(updates.last_reviewed_at); }
  if (updates.review_count      !== undefined) { fields.push('review_count = ?');      vals.push(updates.review_count); }
  if (updates.success_count     !== undefined) { fields.push('success_count = ?');     vals.push(updates.success_count); }
  if (fields.length === 0) return;
  vals.push(id);
  database.prepare(`UPDATE review_items SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function getReviewItemById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM review_items WHERE id = ?').get(id) ?? null;
}

// Éléments dus (next_review_at <= maintenant), les plus en retard d'abord,
// plafonnés à `limit` (séance quotidienne — pas de liste illimitée).
export function getDueReviewItems(limit = 8) {
  if (!database) return [];
  const now = new Date().toISOString();
  return database.prepare(`
    SELECT * FROM review_items
    WHERE next_review_at <= ?
    ORDER BY next_review_at ASC
    LIMIT ?
  `).all(now, limit);
}

export function countDueReviewItems() {
  if (!database) return 0;
  const now = new Date().toISOString();
  return database.prepare('SELECT COUNT(*) as n FROM review_items WHERE next_review_at <= ?').get(now).n;
}

export function deleteReviewItem(id) {
  if (!database) return;
  database.prepare('DELETE FROM review_attempts WHERE review_item_id = ?').run(id);
  database.prepare('DELETE FROM review_items WHERE id = ?').run(id);
}

export function insertReviewAttempt({ id, review_item_id, was_correct, user_answer = '' }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO review_attempts (id, review_item_id, answered_at, was_correct, user_answer)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, review_item_id, now, was_correct ? 1 : 0, user_answer);
}

export function getReviewStats() {
  if (!database) return { total_items: 0, due_now: 0, total_attempts: 0, success_rate: 0, subjects_studied: 0 };
  const totalItems = database.prepare('SELECT COUNT(*) as n FROM review_items').get().n;
  const dueNow = countDueReviewItems();
  const attemptsRow = database.prepare(`
    SELECT COUNT(*) as total, SUM(was_correct) as correct FROM review_attempts
  `).get();
  const totalAttempts = attemptsRow.total ?? 0;
  const correct = attemptsRow.correct ?? 0;
  const subjectsStudied = database.prepare(`
    SELECT COUNT(DISTINCT subject) as n FROM learning_paths WHERE status = 'completed'
  `).get().n;
  return {
    total_items: totalItems,
    due_now: dueNow,
    total_attempts: totalAttempts,
    success_rate: totalAttempts > 0 ? Number((correct / totalAttempts).toFixed(3)) : 0,
    subjects_studied: subjectsStudied,
  };
}
