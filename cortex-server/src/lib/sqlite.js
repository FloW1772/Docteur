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

    -- Studio MetaGPT (MG-6) — mission = un job du pipeline sécurisé
    -- planning -> génération de code texte -> diff -> approbation -> apply.
    -- current_state suit la state machine explicite documentée dans
    -- metagpt-orchestrator.js ; metadata stocke le mode, target_scope,
    -- diff_sha256, approval, etc. en JSON (jamais de credentials/secrets).
    CREATE TABLE IF NOT EXISTS metagpt_missions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      requirement TEXT NOT NULL,
      mode TEXT NOT NULL,
      current_state TEXT NOT NULL DEFAULT 'CREATED',
      model_used TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      error_message TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0,
      diff_sha256 TEXT,
      approved INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    -- Une ligne par transition d'état — journal d'audit MG-6P, jamais de
    -- credentials/env/secrets dans detail (uniquement des faits structurels :
    -- hashes, compteurs, codes d'erreur de policy).
    CREATE TABLE IF NOT EXISTS metagpt_mission_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

    -- Investment Agent (analysis + research + PAPER TRADING ONLY — see
    -- reports/INVESTMENT_AGENT_2026-09.md). No table here ever represents a
    -- real broker connection, a real order, or real money. financial_periods
    -- rows are user-entered (V1 has no live market data feed); each
    -- research_sources row records exact provenance (URL, retrieval
    -- timestamp, whether the content is real-time/delayed/historical) for
    -- any web-derived fact.
    CREATE TABLE IF NOT EXISTS securities (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      asset_class TEXT NOT NULL DEFAULT 'equity',
      currency TEXT NOT NULL DEFAULT 'USD',
      exchange TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- User-entered fundamentals for one security over one reporting period.
    -- V1 has no live market data API (deliberate choice — see mission
    -- decision), so every number here traces back to a research_sources row
    -- or explicit manual entry, never an unattributed live feed.
    CREATE TABLE IF NOT EXISTS financial_periods (
      id TEXT PRIMARY KEY,
      security_id TEXT NOT NULL,
      period_label TEXT NOT NULL,
      period_type TEXT NOT NULL DEFAULT 'annual',
      fiscal_end_date TEXT,
      currency TEXT NOT NULL DEFAULT 'USD',
      data TEXT NOT NULL DEFAULT '{}',
      data_kind TEXT NOT NULL DEFAULT 'reported',
      source_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Provenance record for every externally-sourced fact used in an
    -- analysis. data_recency distinguishes real_time / delayed / last_close
    -- / historical / analyst_estimate — never presented as more current
    -- than it is (mission requirement 2).
    CREATE TABLE IF NOT EXISTS research_sources (
      id TEXT PRIMARY KEY,
      security_id TEXT,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'web',
      data_recency TEXT NOT NULL DEFAULT 'historical',
      financial_period_label TEXT,
      currency TEXT,
      limitations TEXT NOT NULL DEFAULT '',
      retrieved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      untrusted INTEGER NOT NULL DEFAULT 1,
      content_excerpt TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS investment_reports (
      id TEXT PRIMARY KEY,
      security_id TEXT,
      report_type TEXT NOT NULL DEFAULT 'fundamentals',
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '{}',
      source_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Paper (simulated) portfolios only. No broker_id, no credentials,
    -- no live-order fields exist on this table by design.
    CREATE TABLE IF NOT EXISTS paper_portfolios (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Portefeuille simulé',
      base_currency TEXT NOT NULL DEFAULT 'USD',
      starting_cash REAL NOT NULL DEFAULT 100000,
      cash REAL NOT NULL DEFAULT 100000,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS paper_positions (
      id TEXT PRIMARY KEY,
      portfolio_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      avg_cost_basis REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (portfolio_id, symbol)
    );

    -- action is always PAPER_BUY or PAPER_SELL (enforced in
    -- investment-policy.js, never REAL_BUY/REAL_SELL/LIVE_ORDER — see
    -- mission requirement 11). simulated_price is a user-supplied or
    -- research-derived price snapshot, never a live execution price.
    CREATE TABLE IF NOT EXISTS paper_transactions (
      id TEXT PRIMARY KEY,
      portfolio_id TEXT NOT NULL,
      action TEXT NOT NULL,
      symbol TEXT NOT NULL,
      quantity REAL NOT NULL,
      simulated_price REAL NOT NULL,
      cash_after REAL NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS investment_watchlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Watchlist',
      symbols TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- News/events timeline entries (mission MG-... Investment Agent V1
    -- finalization). Every row must reference a research_sources id —
    -- events are built exclusively from already-collected, sourced
    -- content, never invented. date_reliable=0 means the event is kept
    -- out of chronological ordering (see investment-timeline.js).
    CREATE TABLE IF NOT EXISTS investment_events (
      id TEXT PRIMARY KEY,
      security_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      event_date TEXT,
      date_reliable INTEGER NOT NULL DEFAULT 0,
      event_type TEXT NOT NULL DEFAULT 'other',
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      market_interpretation_statement TEXT,
      market_interpretation_basis TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  // ── Cyber Audit Agent (SENTINEL V1, CA-5) — authorized, external,
  // non-destructive web audit missions. Kept in its own exec() block
  // (separate from the dense block above) since it's a distinct feature
  // with its own six-table shape; no existing table/index touched.
  //
  // Security posture mirrored from metagpt_missions/metagpt_mission_events
  // (CA-1 audit): scope/config stored as JSON metadata, one row per
  // mission + a separate append-only event log. Evidence NEVER stores a
  // full response body — only a short, already-redacted excerpt (see
  // cyber-redact.js) plus a sha256 of the excerpt for integrity/dedup.
  // relevant_headers is the REDACTED header subset only (cyber-redact.js
  // runs before this table is ever written to — this schema does not
  // re-redact, it trusts the caller, exactly like metagpt_mission_events'
  // "jamais de credentials/secrets dans detail" comment documents for its
  // own caller contract).
  database.exec(`
    CREATE TABLE IF NOT EXISTS cyber_audit_missions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      client_name TEXT NOT NULL,
      authorization_confirmed INTEGER NOT NULL DEFAULT 0,
      authorization_reference TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'PASSIVE_AUDIT',
      status TEXT NOT NULL DEFAULT 'DRAFT',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    -- One row per mission (1:1) — the frozen, validated scope object
    -- (cyber-policy.js's validateScope() output) exactly as it was when
    -- the mission started. Kept separate from cyber_audit_missions so a
    -- scope can never be silently edited after a mission begins running
    -- (no UPDATE path is provided for this table — see cyber-evidence.js).
    CREATE TABLE IF NOT EXISTS cyber_audit_scopes (
      mission_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per outbound request the gateway actually made — an audit
    -- trail independent of findings, so "what did we actually touch" can
    -- always be answered even for requests that produced no finding.
    CREATE TABLE IF NOT EXISTS cyber_audit_requests (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL,
      status INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Evidence: NEVER a full response body. excerpt is capped and already
    -- redacted by the caller before this row is written. relevant_headers
    -- is a redacted headers JSON object, not the raw header set.
    CREATE TABLE IF NOT EXISTS cyber_audit_evidence (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      response_status INTEGER,
      relevant_headers TEXT NOT NULL DEFAULT '{}',
      excerpt TEXT NOT NULL DEFAULT '',
      sha256 TEXT NOT NULL
    );

    -- Findings. firstSeen/lastSeen support re-scan dedup (CA-6+): the same
    -- deterministic finding id observed again on a later request updates
    -- last_seen rather than creating a duplicate row.
    -- id is deterministic per detector check (e.g. "header-missing-hsts")
    -- and therefore legitimately recurs across DIFFERENT missions — the
    -- real uniqueness key is (id, mission_id), not id alone.
    CREATE TABLE IF NOT EXISTS cyber_audit_findings (
      id TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      confidence TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      asset TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      evidence_ids TEXT NOT NULL DEFAULT '[]',
      impact TEXT NOT NULL DEFAULT '',
      recommendation TEXT NOT NULL DEFAULT '',
      references_json TEXT NOT NULL DEFAULT '[]',
      first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id, mission_id)
    );

    -- Append-only mission event log — mirrors metagpt_mission_events:
    -- one row per state transition or notable lifecycle event, never
    -- credentials/secrets in detail (only structural facts).
    CREATE TABLE IF NOT EXISTS cyber_audit_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cyber_audit_missions_status
      ON cyber_audit_missions(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cyber_audit_requests_mission_id
      ON cyber_audit_requests(mission_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_cyber_audit_evidence_mission_id
      ON cyber_audit_evidence(mission_id, timestamp ASC);
    CREATE INDEX IF NOT EXISTS idx_cyber_audit_evidence_request_id
      ON cyber_audit_evidence(request_id);
    CREATE INDEX IF NOT EXISTS idx_cyber_audit_findings_mission_id
      ON cyber_audit_findings(mission_id, severity);
    CREATE INDEX IF NOT EXISTS idx_cyber_audit_events_mission_id
      ON cyber_audit_events(mission_id, created_at ASC);
  `);

  // ── Observateur passive monitoring (monitor-* modules) — local network
  // connection + process observation, metadata only. Kept in its own
  // exec() block, separate from cyber_audit_* (Web Audit): distinct
  // feature, distinct lifecycle, zero shared tables. Config lives under
  // meta key 'monitor_settings' via getMeta/setMeta (same convention as
  // inbox_settings) rather than a dedicated settings table — small,
  // low-write, no query need.
  //
  // Bounded-growth strategy: connections/processes are upserted per
  // HOURLY window_bucket (see monitor-aggregator.js) — one row per
  // distinct (process, destination, hour) tuple, updated repeatedly via
  // sample_count/last_seen, never one row per poll. This plus daily
  // retention purge (monitor-retention.js, mirrors
  // purgeRequestLogsOlderThan below) is what keeps these tables bounded
  // under continuous polling.
  //
  // Privacy: no column here ever holds packet payload, credentials,
  // cookies, tokens, or message/document content — enforced upstream by
  // monitor-privacy-guard.js, which every collector sample must pass
  // through before reaching the aggregator that writes these rows.
  database.exec(`
    CREATE TABLE IF NOT EXISTS monitor_connections (
      id TEXT PRIMARY KEY,
      process_name TEXT NOT NULL,
      pid INTEGER,
      remote_address TEXT NOT NULL,
      remote_port INTEGER,
      local_port INTEGER,
      protocol TEXT NOT NULL,
      state TEXT,
      first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sample_count INTEGER NOT NULL DEFAULT 1,
      approx_bytes INTEGER NOT NULL DEFAULT 0,
      window_bucket TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uidx_monitor_connections_bucket
      ON monitor_connections(process_name, remote_address, remote_port, window_bucket);

    CREATE TABLE IF NOT EXISTS monitor_processes (
      id TEXT PRIMARY KEY,
      process_name TEXT NOT NULL,
      pid INTEGER,
      first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      connection_count INTEGER NOT NULL DEFAULT 0,
      distinct_destinations INTEGER NOT NULL DEFAULT 0,
      window_bucket TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uidx_monitor_processes_bucket
      ON monitor_processes(process_name, window_bucket);

    -- Deterministic-rule anomaly rows (monitor-anomaly.js). severity is
    -- always one of OBSERVATION/SUSPICIOUS/REQUIRES_REVIEW — never an
    -- "attack"/"malware" verdict string. security_signal is a JSON blob
    -- ({source:'observateur', category, severity, confidence,
    -- evidenceRef}) stored for a future MAITRE module to consume; V1
    -- never emits it anywhere, it is only queryable/displayable.
    CREATE TABLE IF NOT EXISTS monitor_anomalies (
      id TEXT PRIMARY KEY,
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      rule_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      process_name TEXT,
      remote_address TEXT,
      description TEXT NOT NULL DEFAULT '',
      evidence_ref TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'OPEN',
      security_signal TEXT
    );

    CREATE TABLE IF NOT EXISTS monitor_reports (
      id TEXT PRIMARY KEY,
      report_type TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      mode TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      anomaly_count INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT NOT NULL DEFAULT '{}',
      llm_narrative TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Append-only lifecycle log — mirrors cyber_audit_events: start,
    -- pause, resume, mode-change, degraded, report-generated, purge-run.
    CREATE TABLE IF NOT EXISTS monitor_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_monitor_connections_window
      ON monitor_connections(window_bucket DESC, process_name);
    CREATE INDEX IF NOT EXISTS idx_monitor_connections_last_seen
      ON monitor_connections(last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_monitor_processes_window
      ON monitor_processes(window_bucket DESC);
    CREATE INDEX IF NOT EXISTS idx_monitor_anomalies_detected_at
      ON monitor_anomalies(detected_at DESC, severity);
    CREATE INDEX IF NOT EXISTS idx_monitor_reports_period
      ON monitor_reports(period_start DESC);
    CREATE INDEX IF NOT EXISTS idx_monitor_events_created_at
      ON monitor_events(created_at DESC);
  `);

  // ── MAÎTRE (defensive security — SecurityEvent/Incident/Evidence, MA-2) ──
  //
  // MAÎTRE is a strictly separate module from Observateur (monitor_*) and
  // Cyber Audit (cyber_audit_*) — own maitre_* table prefix, no shared
  // table, no foreign key into either of those schemas. MAÎTRE only ever
  // READS Observateur data (its security_signal column) through
  // monitor-*.js's own existing getters; it never writes to monitor_*.
  //
  // MA-2 scope is data model only: no Defender/Event Log/process/firewall
  // adapters exist yet, so every row created in this phase's tests is
  // synthetic. Severity is a closed enum (see MAITRE_SEVERITIES below,
  // enforced in maitre-models.js, NOT by a SQL CHECK constraint — this
  // matches the repo's existing convention of validating enums in JS
  // before the row is ever built, same as monitor-anomaly.js's severities
  // and monitor-config.js's report-mode/frequency enums). Deliberately no
  // "MALWARE"/"ATTACK"/"COMPROMISED" value is ever a valid severity —
  // those words may appear inside a free-text description sourced from a
  // detector, but never become a MAÎTRE verdict field.
  database.exec(`
    CREATE TABLE IF NOT EXISTS maitre_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'medium',
      subject TEXT NOT NULL DEFAULT '{}',
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      detector_id TEXT NOT NULL,
      incident_id TEXT
    );

    -- Immutable after creation (MA-2 exposes no update function for this
    -- table) except the one explicitly-allowed mutation: attaching a
    -- previously-unassigned event to an incident once correlation runs
    -- (a later phase) — modeled as a single allowed UPDATE of
    -- incident_id only, never a general-purpose row edit.
    CREATE INDEX IF NOT EXISTS idx_maitre_events_occurred_at
      ON maitre_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maitre_events_incident_id
      ON maitre_events(incident_id);
    CREATE INDEX IF NOT EXISTS idx_maitre_events_source
      ON maitre_events(source, occurred_at DESC);

    -- Incident is the only mutable MAÎTRE row — via controlled status
    -- transitions (validated in maitre-models.js, not here) rather than
    -- an arbitrary column-by-column update. timeline is an append-only
    -- JSON array of {at, type, detail} entries, bounded in size by the
    -- application layer (see MAITRE_LIMITS in maitre-models.js).
    CREATE TABLE IF NOT EXISTS maitre_incidents (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'OPEN',
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      event_refs TEXT NOT NULL DEFAULT '[]',
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      recommendations TEXT NOT NULL DEFAULT '[]',
      actions_proposed TEXT NOT NULL DEFAULT '[]',
      actions_executed TEXT NOT NULL DEFAULT '[]',
      timeline TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_maitre_incidents_status
      ON maitre_incidents(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maitre_incidents_severity
      ON maitre_incidents(severity, created_at DESC);

    -- Evidence is immutable after creation (no update function exposed).
    -- redacted is a boolean flag (0/1) recording whether
    -- deepRedactEvidence()/redactHeaders() from cyber-redact.js were
    -- applied to metadata before this row was written — MA-2 always sets
    -- it to 1, since createEvidence() unconditionally redacts. sha256 is
    -- the hash of the SUBJECT the evidence describes (e.g. a file's
    -- content) when known; integrity_hash is the hash of this evidence
    -- row's own serialized metadata, used only for dedup/tamper-evidence
    -- of the row itself — never presented as forensic chain-of-custody.
    CREATE TABLE IF NOT EXISTS maitre_evidence (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      incident_id TEXT,
      event_id TEXT,
      sha256 TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      redacted INTEGER NOT NULL DEFAULT 1,
      integrity_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_maitre_evidence_incident_id
      ON maitre_evidence(incident_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_maitre_evidence_event_id
      ON maitre_evidence(event_id);
    CREATE INDEX IF NOT EXISTS idx_maitre_evidence_sha256
      ON maitre_evidence(sha256);
  `);

  // ── MAÎTRE — action proposal / policy / approval binding (MA-7) ──────────
  //
  // Strictly the security boundary BEFORE any executor exists (MA-8+).
  // No column here ever triggers a system action by itself — these
  // tables only record proposals, policy decisions, and cryptographic
  // approval bindings. actionType is validated against a closed enum in
  // maitre-actions.js (never a SQL CHECK constraint, matching every
  // other MAÎTRE enum's JS-side validation convention). target/
  // parameters are redacted JSON, never a raw shell/command shape —
  // enforced by maitre-actions.js's schema-per-action-type validators,
  // not by this table.
  //
  // maitre_actions.status values: PROPOSED, AWAITING_APPROVAL, APPROVED,
  // REJECTED, EXPIRED, READY, CONSUMED. Never EXECUTED in MA-7 — that
  // value is reserved for MA-8's executor.
  database.exec(`
    CREATE TABLE IF NOT EXISTS maitre_actions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      incident_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      level INTEGER NOT NULL,
      target TEXT NOT NULL DEFAULT '{}',
      parameters TEXT NOT NULL DEFAULT '{}',
      reason TEXT NOT NULL DEFAULT '',
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'PROPOSED',
      proposal_hash TEXT NOT NULL,
      policy_result TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_maitre_actions_incident_id
      ON maitre_actions(incident_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maitre_actions_status
      ON maitre_actions(status, created_at DESC);

    -- One approval row per approval DECISION (a rejected-then-reproposed
    -- action gets a new proposal + a new approval row, never a reused
    -- one) — status transitions are PENDING -> APPROVED/REJECTED/EXPIRED,
    -- and APPROVED -> CONSUMED (one-time use, mission §21). target_hash/
    -- parameters_hash/proposal_hash are SHA-256 of the canonical
    -- serialization at approval-request time — ANY later mutation of the
    -- underlying action row makes re-validation fail (mission §18/§25).
    CREATE TABLE IF NOT EXISTS maitre_action_approvals (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      action_id TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      parameters_hash TEXT NOT NULL,
      proposal_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      approved_at TEXT,
      consumed_at TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_maitre_action_approvals_action_id
      ON maitre_action_approvals(action_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maitre_action_approvals_status
      ON maitre_action_approvals(status, expires_at ASC);
  `);

  // ── MAÎTRE — action execution audit (MA-8) ────────────────────────────────
  //
  // One row per EXECUTION ATTEMPT (not per action — a failed attempt
  // followed by a fresh proposal+approval+retry gets its own row,
  // preserving full history). result_metadata is bounded, redacted
  // JSON only — never raw shell output, never a secret. A UNIQUE index
  // on action_id where status IN ('RUNNING','SUCCEEDED') is deliberately
  // NOT expressed as a SQL constraint (SQLite partial-unique-on-status
  // is awkward and every other MAÎTRE invariant is enforced in JS) —
  // maitre-executor.js's own idempotency/concurrency check queries this
  // table before inserting a new RUNNING row.
  database.exec(`
    CREATE TABLE IF NOT EXISTS maitre_action_runs (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      proposal_hash TEXT NOT NULL,
      approval_id TEXT,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      result_metadata TEXT NOT NULL DEFAULT '{}',
      error_category TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_maitre_action_runs_action_id
      ON maitre_action_runs(action_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maitre_action_runs_incident_id
      ON maitre_action_runs(incident_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maitre_action_runs_status
      ON maitre_action_runs(status, started_at DESC);
  `);

  // ── MAÎTRE — host isolation rollback state (MA-10) ────────────────────────
  //
  // Persisted BEFORE the first firewall modification is ever attempted
  // (mission §7 — "rollback state FIRST"; if this insert fails,
  // HOST_ISOLATION is denied before touching the OS at all). One row per
  // isolation ATTEMPT (mirroring maitre_action_runs' one-row-per-attempt
  // convention), never overwritten — a retried isolation after a
  // PARTIAL_FAILURE gets a fresh proposal/approval/row, preserving full
  // history for manual forensic review if ever needed.
  //
  // rules_created is the authoritative record of which specific firewall
  // rules THIS attempt actually created — restore only ever removes rules
  // listed here (mission §15 ownership re-check), never a wildcard sweep.
  // status: PENDING (row inserted, no OS change yet) -> APPLYING ->
  // ACTIVE | PARTIAL_FAILURE | FAILED -> RESTORING -> RESTORED.
  database.exec(`
    CREATE TABLE IF NOT EXISTS maitre_isolation_state (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      strategy TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      rules_created TEXT NOT NULL DEFAULT '[]',
      verification_metadata TEXT NOT NULL DEFAULT '{}',
      restored_at TEXT,
      restore_action_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_maitre_isolation_state_action_id
      ON maitre_isolation_state(action_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maitre_isolation_state_incident_id
      ON maitre_isolation_state(incident_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maitre_isolation_state_status
      ON maitre_isolation_state(status, created_at DESC);
  `);

  // ── Business/Sales Agent V1 — RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN
  // REVIEW only. No table here ever represents a sent message or a real
  // CRM write — sales_drafts rows are local-only text, always carrying
  // sent = 0, and there is no code path anywhere that flips it.
  database.exec(`
    CREATE TABLE IF NOT EXISTS sales_leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales_research_sources (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      retrieved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      untrusted INTEGER NOT NULL DEFAULT 1,
      content_excerpt TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_sales_research_sources_lead_id
      ON sales_research_sources(lead_id, retrieved_at DESC);

    CREATE TABLE IF NOT EXISTS sales_drafts (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT — NOT SENT',
      sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sales_drafts_lead_id
      ON sales_drafts(lead_id, created_at DESC);
  `);

  // ── OMEGA V1 Phase 2 — device identity, pairing, sessions, audit. This
  // is a fully separate authorization domain from MAÎTRE (omega_* tables
  // only, never maitre_*/monitor_*/cyber_*). Private key material is
  // NEVER stored here — only public keys and non-reversible hashes of
  // pairing codes (see omega-identity.js / omega-pairing.js). No table
  // here ever holds a plaintext pairing code or a session secret.
  database.exec(`
    CREATE TABLE IF NOT EXISTS omega_devices (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      permission_level INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_omega_devices_fingerprint
      ON omega_devices(fingerprint);

    CREATE TABLE IF NOT EXISTS omega_pairings (
      id TEXT PRIMARY KEY,
      initiator_device_name TEXT NOT NULL,
      requested_permission INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      device_id TEXT,
      public_key_pem TEXT,
      fingerprint TEXT,
      consumed_at TEXT,
      decided_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_omega_pairings_status
      ON omega_pairings(status, expires_at);

    CREATE TABLE IF NOT EXISTS omega_sessions (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      permission_level INTEGER NOT NULL,
      nonce TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      ended_at TEXT,
      revoked_at TEXT,
      last_used_nonce TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_omega_sessions_device_id
      ON omega_sessions(device_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS omega_audit (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT NOT NULL,
      device_id TEXT,
      session_id TEXT,
      pairing_id TEXT,
      result TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_omega_audit_created_at
      ON omega_audit(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_omega_audit_device_id
      ON omega_audit(device_id, created_at DESC);
  `);

  // ── OMEGA V1 Phase 3 — VIEW ONLY screen-viewing session state. Purely
  // additive: one row per omega_sessions.id that has an active or
  // previously-active VIEW stream. Tracks the explicitly-selected
  // screenIndex (mission rule 10 — never "all screens" silently),
  // last-frame bookkeeping for FPS bounding/backpressure, and stop
  // state. Never stores frame bytes (screen pixels are never persisted
  // to SQLite — mission §15's "never stores... full screen frames"
  // carried forward from the Phase 1 audit-log rule, applied here to
  // the whole DB, not just the audit table).
  database.exec(`
    CREATE TABLE IF NOT EXISTS omega_view_sessions (
      session_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      screen_index INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      stopped_at TEXT,
      last_frame_at TEXT,
      last_frame_width INTEGER,
      last_frame_height INTEGER,
      frame_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_omega_view_sessions_device_id
      ON omega_view_sessions(device_id, started_at DESC);
  `);

  // ── OMEGA V1 Phase 4 — OMEGA_INTERACTIVE session state (mouse/keyboard
  // input injection). Purely additive: one row per omega_sessions.id
  // that has an active or previously-active INTERACTIVE control period.
  // Tracks event/batch bookkeeping for rate-limit enforcement and stop
  // state. Never stores actual input content (no keystroke text, no
  // coordinate history) — only counters, matching the audit-log
  // discipline of "never stores raw keyboard input" carried forward from
  // Phase 1/3 to the whole DB, not just the audit table.
  database.exec(`
    CREATE TABLE IF NOT EXISTS omega_interactive_sessions (
      session_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      stopped_at TEXT,
      last_event_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_omega_interactive_sessions_device_id
      ON omega_interactive_sessions(device_id, started_at DESC);
  `);

  // ── RASSILON V1 Phase 2 — local single-machine safe worker. Separate
  // module identity/tables per the Phase 1 architecture report
  // (reports/RASSILON_ARCHITECTURE_2026-09.md §3/§39): rassilon_* only,
  // never reads/writes omega_*/maitre_*/monitor_*/cyber_* tables, and no
  // other module reads/writes rassilon_* either.
  //
  // rassilon_settings: single-row consent/quota configuration. enabled
  // starts at 0 (mission §3 — DISABLED by default) and can only flip to 1
  // through the explicit /enable endpoint, never a migration default.
  //
  // rassilon_identity: PUBLIC key material only (mission §39 — "si
  // identity secret est déjà DPAPI secret-store : ne pas dupliquer secret
  // en DB"). The Ed25519 private key lives exclusively in secret-store.js
  // under the rassilon-device-key:<deviceId> namespace; this table never
  // sees it.
  //
  // rassilon_jobs: one row per submitted job, full lifecycle
  // (RECEIVED..INTERRUPTED, mission §30). processed_job_id is UNIQUE so a
  // replayed jobId is rejected by the anti-replay check before it can ever
  // collide here (mission §17).
  //
  // rassilon_audit: closed-enum event log (mission §38), bounded
  // result_summary only — never raw job payload/output/secret material.
  database.exec(`
    CREATE TABLE IF NOT EXISTS rassilon_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      max_cpu_percent INTEGER NOT NULL DEFAULT 25,
      max_ram_mb INTEGER NOT NULL DEFAULT 2048,
      max_concurrent_jobs INTEGER NOT NULL DEFAULT 1,
      max_job_duration_sec INTEGER NOT NULL DEFAULT 300,
      max_scratch_mb INTEGER NOT NULL DEFAULT 1024,
      pause_on_battery INTEGER NOT NULL DEFAULT 1,
      minimum_battery_percent INTEGER NOT NULL DEFAULT 30,
      pause_when_user_active INTEGER NOT NULL DEFAULT 1,
      accepted_job_types TEXT NOT NULL DEFAULT '[]',
      approval_mode TEXT NOT NULL DEFAULT 'ASK_EACH_JOB',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rassilon_identity (
      device_id TEXT PRIMARY KEY,
      public_key_pem TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS rassilon_jobs (
      job_id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      issuer_device_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'RECEIVED',
      resource_budget TEXT NOT NULL DEFAULT '{}',
      payload_summary TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error_reason TEXT,
      result_summary TEXT NOT NULL DEFAULT '{}',
      policy_version TEXT NOT NULL DEFAULT 'v1'
    );

    CREATE INDEX IF NOT EXISTS idx_rassilon_jobs_status
      ON rassilon_jobs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rassilon_jobs_created_at
      ON rassilon_jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS rassilon_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT NOT NULL,
      job_id TEXT,
      issuer_device_id TEXT,
      result_summary TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_rassilon_audit_created_at
      ON rassilon_audit(created_at DESC);

    -- RASSILON Phase 4 LAN state. Kept in dedicated rassilon_* tables so
    -- enabling LAN compute cannot inherit any OMEGA/MAITRE trust or session.
    CREATE TABLE IF NOT EXISTS rassilon_local_device (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rassilon_lan_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      bind_address TEXT,
      port INTEGER NOT NULL DEFAULT 3443,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rassilon_devices (
      device_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      role TEXT NOT NULL,
      permission_set TEXT NOT NULL DEFAULT '[]',
      endpoint_host TEXT,
      endpoint_port INTEGER,
      tls_certificate_pem TEXT,
      tls_certificate_fingerprint TEXT,
      capabilities TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'OFFLINE',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rassilon_devices_status
      ON rassilon_devices(status, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS rassilon_pairings (
      pairing_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      worker_nonce TEXT NOT NULL,
      controller_nonce TEXT,
      controller_device_id TEXT,
      controller_public_key_pem TEXT,
      controller_fingerprint TEXT,
      controller_display_name TEXT,
      requested_permissions TEXT NOT NULL DEFAULT '[]',
      approved_permissions TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TEXT,
      used_at TEXT,
      cancelled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rassilon_pairings_state_expiry
      ON rassilon_pairings(state, expires_at);

    CREATE TABLE IF NOT EXISTS rassilon_sessions (
      session_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_seen_at TEXT,
      FOREIGN KEY(device_id) REFERENCES rassilon_devices(device_id)
    );

    CREATE INDEX IF NOT EXISTS idx_rassilon_sessions_device
      ON rassilon_sessions(device_id, expires_at);

    CREATE INDEX IF NOT EXISTS idx_rassilon_sessions_expiry
      ON rassilon_sessions(expires_at, revoked_at);

    CREATE TABLE IF NOT EXISTS rassilon_outbound_sessions (
      worker_device_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS rassilon_request_nonces (
      session_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      PRIMARY KEY(session_id, nonce)
    );

    CREATE INDEX IF NOT EXISTS idx_rassilon_request_nonces_expiry
      ON rassilon_request_nonces(expires_at);

    CREATE TABLE IF NOT EXISTS rassilon_remote_jobs (
      job_id TEXT PRIMARY KEY,
      worker_device_id TEXT NOT NULL,
      controller_device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      result_envelope TEXT,
      error_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rassilon_remote_jobs_status
      ON rassilon_remote_jobs(status, updated_at DESC);
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

// ── Observateur passive monitoring — DB access ─────────────────────────────
//
// One batched better-sqlite3 transaction per collector cycle (upsertMonitor
// Connections/Processes), never one write per sample — this is the write
// side of the "bounded DB writes/min" performance requirement.

const MONITOR_PURGE_BATCH_SIZE = 500;
const MONITOR_PURGE_MAX_BATCHES = 20;

export function upsertMonitorConnections(rows) {
  if (!database || rows.length === 0) return;
  const upsert = database.prepare(`
    INSERT INTO monitor_connections
      (id, process_name, pid, remote_address, remote_port, local_port, protocol, state, first_seen, last_seen, sample_count, approx_bytes, window_bucket)
    VALUES (@id, @process_name, @pid, @remote_address, @remote_port, @local_port, @protocol, @state, @first_seen, @last_seen, 1, @approx_bytes, @window_bucket)
    ON CONFLICT(process_name, remote_address, remote_port, window_bucket) DO UPDATE SET
      last_seen = excluded.last_seen,
      sample_count = sample_count + 1,
      approx_bytes = approx_bytes + excluded.approx_bytes,
      state = excluded.state,
      pid = excluded.pid
  `);
  const runAll = database.transaction((batch) => { for (const row of batch) upsert.run(row); });
  runAll(rows);
}

export function upsertMonitorProcesses(rows) {
  if (!database || rows.length === 0) return;
  const upsert = database.prepare(`
    INSERT INTO monitor_processes
      (id, process_name, pid, first_seen, last_seen, connection_count, distinct_destinations, window_bucket)
    VALUES (@id, @process_name, @pid, @first_seen, @last_seen, @connection_count, @distinct_destinations, @window_bucket)
    ON CONFLICT(process_name, window_bucket) DO UPDATE SET
      last_seen = excluded.last_seen,
      connection_count = excluded.connection_count,
      distinct_destinations = excluded.distinct_destinations,
      pid = excluded.pid
  `);
  const runAll = database.transaction((batch) => { for (const row of batch) upsert.run(row); });
  runAll(rows);
}

export function getLiveMonitorConnections(sinceIso, limit = 500) {
  if (!database) return [];
  return database.prepare(
    'SELECT * FROM monitor_connections WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT ?'
  ).all(sinceIso, limit);
}

export function getMonitorProcesses(sinceIso, limit = 500) {
  if (!database) return [];
  return database.prepare(
    'SELECT * FROM monitor_processes WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT ?'
  ).all(sinceIso, limit);
}

export function getMonitorConnectionHistory(processName, sinceIso) {
  if (!database) return [];
  return database.prepare(
    'SELECT * FROM monitor_connections WHERE process_name = ? AND first_seen >= ? ORDER BY first_seen ASC'
  ).all(processName, sinceIso);
}

export function insertMonitorAnomaly(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO monitor_anomalies
      (id, detected_at, rule_id, severity, process_name, remote_address, description, evidence_ref, status, security_signal)
    VALUES (@id, @detected_at, @rule_id, @severity, @process_name, @remote_address, @description, @evidence_ref, @status, @security_signal)
  `).run(row);
}

export function getMonitorAnomalies(limit = 200) {
  if (!database) return [];
  return database.prepare('SELECT * FROM monitor_anomalies ORDER BY detected_at DESC LIMIT ?').all(limit);
}

export function insertMonitorReport(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO monitor_reports
      (id, report_type, period_start, period_end, mode, event_count, anomaly_count, summary_json, llm_narrative, created_at)
    VALUES (@id, @report_type, @period_start, @period_end, @mode, @event_count, @anomaly_count, @summary_json, @llm_narrative, @created_at)
  `).run(row);
}

export function getMonitorReports(limit = 100) {
  if (!database) return [];
  return database.prepare('SELECT * FROM monitor_reports ORDER BY period_start DESC LIMIT ?').all(limit);
}

export function getMonitorReportById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM monitor_reports WHERE id = ?').get(id) ?? null;
}

export function getLastMonitorReport(reportType = null) {
  if (!database) return null;
  if (reportType) {
    return database.prepare('SELECT * FROM monitor_reports WHERE report_type = ? ORDER BY period_end DESC LIMIT 1').get(reportType) ?? null;
  }
  return database.prepare('SELECT * FROM monitor_reports ORDER BY period_end DESC LIMIT 1').get() ?? null;
}

export function insertMonitorEvent(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO monitor_events (id, event_type, detail, created_at)
    VALUES (@id, @event_type, @detail, @created_at)
  `).run(row);
}

export function getMonitorEvents(limit = 200) {
  if (!database) return [];
  return database.prepare('SELECT * FROM monitor_events ORDER BY created_at DESC LIMIT ?').all(limit);
}

// Purges monitor_* tables older than `days`, in bounded batches — copies
// purgeRequestLogsOlderThan's shape exactly. Scoped ONLY to monitor_*
// tables: never touches cyber_audit_* or any other Docteur data.
export function purgeMonitorDataOlderThan(days, { batchSize = MONITOR_PURGE_BATCH_SIZE, maxBatches = MONITOR_PURGE_MAX_BATCHES } = {}) {
  if (!database) return 0;
  const numDays = Number(days);
  if (!Number.isFinite(numDays)) return 0;
  const cutoff = new Date(Date.now() - numDays * 86_400_000).toISOString();

  const purgeTable = (table, timeCol) => {
    const deleteBatch = database.prepare(
      `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${timeCol} < ? LIMIT ?)`
    );
    let deleted = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = deleteBatch.run(cutoff, batchSize);
      deleted += result.changes;
      if (result.changes < batchSize) break;
    }
    return deleted;
  };

  return (
    purgeTable('monitor_connections', 'last_seen') +
    purgeTable('monitor_processes', 'last_seen') +
    purgeTable('monitor_events', 'created_at') +
    purgeTable('monitor_reports', 'created_at')
  );
}

// ── MAÎTRE — DB access (MA-2: data model only, no adapters/actions yet) ───
//
// Rows are inserted as plain objects with a caller-generated
// crypto.randomUUID() id, matching monitor_*'s convention. All INSERTs use
// a plain (non-UPSERT) prepared statement — MAÎTRE rows are not
// aggregated/upserted like monitor_connections; a duplicate id is a
// genuine caller bug and must surface as a thrown SQLITE_CONSTRAINT
// error (better-sqlite3's default behavior for a PRIMARY KEY collision),
// never a silent overwrite.

const MAITRE_EVENTS_PURGE_BATCH_SIZE = 500;
const MAITRE_EVENTS_PURGE_MAX_BATCHES = 20;

export function insertMaitreEvent(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO maitre_events
      (id, created_at, occurred_at, source, category, severity, confidence, subject, evidence_refs, metadata, detector_id, incident_id)
    VALUES (@id, @created_at, @occurred_at, @source, @category, @severity, @confidence, @subject, @evidence_refs, @metadata, @detector_id, @incident_id)
  `).run(row);
}

export function getMaitreEventById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM maitre_events WHERE id = ?').get(id) ?? null;
}

export function listMaitreEvents({ limit = 100, offset = 0, incidentId = null } = {}) {
  if (!database) return [];
  if (incidentId) {
    return database.prepare(
      'SELECT * FROM maitre_events WHERE incident_id = ? ORDER BY occurred_at DESC LIMIT ? OFFSET ?'
    ).all(incidentId, limit, offset);
  }
  return database.prepare(
    'SELECT * FROM maitre_events ORDER BY occurred_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
}

// The one allowed post-creation mutation on an event: attaching it to an
// incident once correlation assigns it (a later phase). Never touches
// any other column.
export function attachMaitreEventToIncident(eventId, incidentId) {
  if (!database) return;
  database.prepare('UPDATE maitre_events SET incident_id = ? WHERE id = ?').run(incidentId, eventId);
}

export function purgeMaitreEventsOlderThan(days, { batchSize = MAITRE_EVENTS_PURGE_BATCH_SIZE, maxBatches = MAITRE_EVENTS_PURGE_MAX_BATCHES } = {}) {
  if (!database) return 0;
  const numDays = Number(days);
  if (!Number.isFinite(numDays)) return 0;
  const cutoff = new Date(Date.now() - numDays * 86_400_000).toISOString();
  const deleteBatch = database.prepare(
    'DELETE FROM maitre_events WHERE id IN (SELECT id FROM maitre_events WHERE occurred_at < ? LIMIT ?)'
  );
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = deleteBatch.run(cutoff, batchSize);
    deleted += result.changes;
    if (result.changes < batchSize) break;
  }
  return deleted;
}

export function insertMaitreIncident(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO maitre_incidents
      (id, created_at, updated_at, status, severity, title, summary, event_refs, evidence_refs, recommendations, actions_proposed, actions_executed, timeline)
    VALUES (@id, @created_at, @updated_at, @status, @severity, @title, @summary, @event_refs, @evidence_refs, @recommendations, @actions_proposed, @actions_executed, @timeline)
  `).run(row);
}

export function getMaitreIncidentById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM maitre_incidents WHERE id = ?').get(id) ?? null;
}

export function listMaitreIncidents({ limit = 100, offset = 0, status = null } = {}) {
  if (!database) return [];
  if (status) {
    return database.prepare(
      'SELECT * FROM maitre_incidents WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    ).all(status, limit, offset);
  }
  return database.prepare(
    'SELECT * FROM maitre_incidents ORDER BY updated_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
}

// Controlled update: only the fields a status transition or annotation is
// allowed to change. Never accepts an arbitrary column set — the caller
// (maitre-models.js) decides which of these are legal for the current
// transition; this function only executes the write.
export function updateMaitreIncident(id, fields) {
  if (!database) return null;
  const allowed = ['status', 'severity', 'summary', 'event_refs', 'evidence_refs', 'recommendations', 'actions_proposed', 'actions_executed', 'timeline'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (keys.length === 0) return getMaitreIncidentById(id);
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  database.prepare(`UPDATE maitre_incidents SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: new Date().toISOString() });
  return getMaitreIncidentById(id);
}

export function insertMaitreEvidence(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO maitre_evidence
      (id, created_at, type, source, incident_id, event_id, sha256, metadata, redacted, integrity_hash)
    VALUES (@id, @created_at, @type, @source, @incident_id, @event_id, @sha256, @metadata, @redacted, @integrity_hash)
  `).run(row);
}

export function getMaitreEvidenceById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM maitre_evidence WHERE id = ?').get(id) ?? null;
}

export function listMaitreEvidenceForIncident(incidentId, { limit = 200, offset = 0 } = {}) {
  if (!database) return [];
  return database.prepare(
    'SELECT * FROM maitre_evidence WHERE incident_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?'
  ).all(incidentId, limit, offset);
}

// ── MAÎTRE — action proposal / approval DB access (MA-7) ──────────────────

export function insertMaitreAction(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO maitre_actions
      (id, created_at, updated_at, incident_id, action_type, level, target, parameters, reason, evidence_refs, status, proposal_hash, policy_result, expires_at)
    VALUES (@id, @created_at, @updated_at, @incident_id, @action_type, @level, @target, @parameters, @reason, @evidence_refs, @status, @proposal_hash, @policy_result, @expires_at)
  `).run(row);
}

export function getMaitreActionById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM maitre_actions WHERE id = ?').get(id) ?? null;
}

export function listMaitreActionsForIncident(incidentId, { limit = 200, offset = 0 } = {}) {
  if (!database) return [];
  return database.prepare(
    'SELECT * FROM maitre_actions WHERE incident_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(incidentId, limit, offset);
}

export function listMaitreActions({ limit = 200, offset = 0, status = null } = {}) {
  if (!database) return [];
  if (status) {
    return database.prepare('SELECT * FROM maitre_actions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(status, limit, offset);
  }
  return database.prepare('SELECT * FROM maitre_actions ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// Controlled update — same allowlist-of-columns discipline as
// updateMaitreIncident: only status/updated_at/policy_result are ever
// mutable post-creation. target/parameters/action_type/incident_id/
// proposal_hash are permanently fixed at proposal time (mutating any of
// them would invalidate every approval bound to this action's hash —
// so this function structurally cannot be used to do that).
export function updateMaitreAction(id, fields) {
  if (!database) return null;
  const allowed = ['status', 'policy_result'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (keys.length === 0) return getMaitreActionById(id);
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  database.prepare(`UPDATE maitre_actions SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: new Date().toISOString() });
  return getMaitreActionById(id);
}

export function insertMaitreActionApproval(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO maitre_action_approvals
      (id, created_at, action_id, incident_id, action_type, target_hash, parameters_hash, proposal_hash, status, approved_at, consumed_at, expires_at)
    VALUES (@id, @created_at, @action_id, @incident_id, @action_type, @target_hash, @parameters_hash, @proposal_hash, @status, @approved_at, @consumed_at, @expires_at)
  `).run(row);
}

export function getMaitreActionApprovalById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM maitre_action_approvals WHERE id = ?').get(id) ?? null;
}

export function listMaitreActionApprovalsForAction(actionId, { limit = 50 } = {}) {
  if (!database) return [];
  return database.prepare('SELECT * FROM maitre_action_approvals WHERE action_id = ? ORDER BY created_at DESC LIMIT ?').all(actionId, limit);
}

// Only status/approved_at/consumed_at are ever mutable — target_hash/
// parameters_hash/proposal_hash/expires_at are fixed at request time,
// exactly what makes the binding cryptographically meaningful.
export function updateMaitreActionApproval(id, fields) {
  if (!database) return null;
  const allowed = ['status', 'approved_at', 'consumed_at'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (keys.length === 0) return getMaitreActionApprovalById(id);
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  database.prepare(`UPDATE maitre_action_approvals SET ${setClause} WHERE id = @id`)
    .run({ ...fields, id });
  return getMaitreActionApprovalById(id);
}

// ── MAÎTRE — action execution audit DB access (MA-8) ──────────────────────

export function insertMaitreActionRun(row) {
  if (!database) return;
  database.prepare(`
    INSERT INTO maitre_action_runs
      (id, action_id, incident_id, action_type, proposal_hash, approval_id, status, started_at, finished_at, result_metadata, error_category)
    VALUES (@id, @action_id, @incident_id, @action_type, @proposal_hash, @approval_id, @status, @started_at, @finished_at, @result_metadata, @error_category)
  `).run(row);
}

export function getMaitreActionRunById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM maitre_action_runs WHERE id = ?').get(id) ?? null;
}

// Used by the executor's own idempotency/concurrency guard — finds any
// run for this actionId that is currently RUNNING or already
// SUCCEEDED, so a second execute() call can be refused before it ever
// touches the OS.
export function findActiveOrSucceededRunForAction(actionId) {
  if (!database) return null;
  return database.prepare(
    "SELECT * FROM maitre_action_runs WHERE action_id = ? AND status IN ('RUNNING', 'SUCCEEDED') ORDER BY started_at DESC LIMIT 1"
  ).get(actionId) ?? null;
}

export function listMaitreActionRunsForIncident(incidentId, { limit = 200, offset = 0 } = {}) {
  if (!database) return [];
  return database.prepare(
    'SELECT * FROM maitre_action_runs WHERE incident_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
  ).all(incidentId, limit, offset);
}

// Only status/finished_at/result_metadata/error_category are ever
// mutable post-creation — action_id/incident_id/action_type/
// proposal_hash/approval_id/started_at are fixed at the moment the run
// begins, preserving an accurate audit trail even if execution fails.
export function updateMaitreActionRun(id, fields) {
  if (!database) return null;
  const allowed = ['status', 'finished_at', 'result_metadata', 'error_category'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (keys.length === 0) return getMaitreActionRunById(id);
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  database.prepare(`UPDATE maitre_action_runs SET ${setClause} WHERE id = @id`).run({ ...fields, id });
  return getMaitreActionRunById(id);
}

// ── MAÎTRE — host isolation rollback state DB access (MA-10) ──────────────
//
// insertMaitreIsolationState returns the inserted row's id on success, or
// null if the database is unavailable — the caller (maitre-executor.js)
// treats a null return as a hard DENY of the isolation attempt (mission
// §7: "si rollback state ne peut pas être persisté → DENY isolation"),
// never proceeding to touch the firewall without a persisted rollback
// record first.
export function insertMaitreIsolationState(row) {
  if (!database) return null;
  database.prepare(`
    INSERT INTO maitre_isolation_state
      (id, action_id, incident_id, created_at, updated_at, strategy, status, rules_created, verification_metadata, restored_at, restore_action_id)
    VALUES (@id, @action_id, @incident_id, @created_at, @updated_at, @strategy, @status, @rules_created, @verification_metadata, @restored_at, @restore_action_id)
  `).run(row);
  return row.id;
}

export function getMaitreIsolationStateById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM maitre_isolation_state WHERE id = ?').get(id) ?? null;
}

export function getMaitreIsolationStateByActionId(actionId) {
  if (!database) return null;
  return database.prepare(
    'SELECT * FROM maitre_isolation_state WHERE action_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(actionId) ?? null;
}

// Finds any isolation state currently ACTIVE or PARTIAL_FAILURE or
// APPLYING or PENDING (i.e. not yet cleanly RESTORED/FAILED) — used both
// by the concurrency guard (mission §27: only one HOST_ISOLATION may be
// RUNNING/ACTIVE at a time) and by crash-recovery detection at startup
// (mission §17).
export function findActiveMaitreIsolationState() {
  if (!database) return null;
  return database.prepare(
    "SELECT * FROM maitre_isolation_state WHERE status IN ('PENDING', 'APPLYING', 'ACTIVE', 'PARTIAL_FAILURE', 'RESTORING') ORDER BY created_at DESC LIMIT 1"
  ).get() ?? null;
}

export function listMaitreIsolationStatesForIncident(incidentId, { limit = 200, offset = 0 } = {}) {
  if (!database) return [];
  return database.prepare(
    'SELECT * FROM maitre_isolation_state WHERE incident_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(incidentId, limit, offset);
}

// Only status/rules_created/verification_metadata/restored_at/
// restore_action_id/updated_at are ever mutable post-creation —
// action_id/incident_id/strategy/created_at are fixed at insert time,
// preserving an accurate rollback record even under partial failure.
export function updateMaitreIsolationState(id, fields) {
  if (!database) return null;
  const allowed = ['status', 'rules_created', 'verification_metadata', 'restored_at', 'restore_action_id', 'updated_at'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (keys.length === 0) return getMaitreIsolationStateById(id);
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  database.prepare(`UPDATE maitre_isolation_state SET ${setClause} WHERE id = @id`).run({ ...fields, id });
  return getMaitreIsolationStateById(id);
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
    // Free AI Finder progressive disclosure (AI-5): when false (default),
    // Settings shows only a small recommended subset with a "View all"
    // expansion; when true, the full list renders on every open. Merge-onto-
    // defaults means pre-AI-5 installs get `false` with no migration step.
    always_show_all_free_apis: false,
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

// ---------------------------------------------------------------------
// Studio MetaGPT (MG-6) — missions + audit trail. metadata/detail are
// always JSON-serialized structural facts (state, hashes, counts, policy
// error codes) — never credentials, never raw env, never secrets.
// ---------------------------------------------------------------------

function parseMetaGptMission(row) {
  if (!row) return null;
  let metadata = {};
  try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
  return { ...row, cancelled: !!row.cancelled, approved: !!row.approved, metadata };
}

export function insertMetaGptMission({ id, title, requirement, mode }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO metagpt_missions (id, title, requirement, mode, current_state, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, 'CREATED', ?, ?, '{}')
  `).run(id, title, requirement, mode, now, now);
}

export function updateMetaGptMission(id, updates) {
  if (!database) return;
  const fields = [];
  const vals = [];
  if (updates.current_state !== undefined) { fields.push('current_state = ?'); vals.push(updates.current_state); }
  if (updates.model_used    !== undefined) { fields.push('model_used = ?');    vals.push(updates.model_used); }
  if (updates.finished_at   !== undefined) { fields.push('finished_at = ?');   vals.push(updates.finished_at); }
  if (updates.error_message !== undefined) { fields.push('error_message = ?'); vals.push(updates.error_message); }
  if (updates.cancelled     !== undefined) { fields.push('cancelled = ?');     vals.push(updates.cancelled ? 1 : 0); }
  if (updates.diff_sha256   !== undefined) { fields.push('diff_sha256 = ?');   vals.push(updates.diff_sha256); }
  if (updates.approved      !== undefined) { fields.push('approved = ?');      vals.push(updates.approved ? 1 : 0); }
  if (updates.metadata      !== undefined) { fields.push('metadata = ?');      vals.push(JSON.stringify(updates.metadata)); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE metagpt_missions SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function getMetaGptMissionById(id) {
  if (!database) return null;
  return parseMetaGptMission(database.prepare('SELECT * FROM metagpt_missions WHERE id = ?').get(id));
}

export function getAllMetaGptMissions() {
  if (!database) return [];
  return database.prepare('SELECT * FROM metagpt_missions ORDER BY updated_at DESC').all().map(parseMetaGptMission);
}

export function insertMetaGptMissionEvent({ id, mission_id, from_state, to_state, detail = {} }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO metagpt_mission_events (id, mission_id, from_state, to_state, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, mission_id, from_state ?? null, to_state, JSON.stringify(detail), new Date().toISOString());
}

export function getMetaGptMissionEvents(missionId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM metagpt_mission_events WHERE mission_id = ? ORDER BY created_at ASC')
    .all(missionId)
    .map(row => ({ ...row, detail: (() => { try { return JSON.parse(row.detail || '{}'); } catch { return {}; } })() }));
}

// ---------------------------------------------------------------------
// Investment Agent — analysis + research + PAPER TRADING ONLY.
// No table/function here ever touches a real broker or moves real money.
// ---------------------------------------------------------------------

export function upsertSecurity({ id, symbol, name = '', asset_class = 'equity', currency = 'USD', exchange = '' }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO securities (id, symbol, name, asset_class, currency, exchange, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, asset_class = excluded.asset_class,
      currency = excluded.currency, exchange = excluded.exchange, updated_at = excluded.updated_at
  `).run(id, symbol, name, asset_class, currency, exchange, now, now);
}

export function getSecurityById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM securities WHERE id = ?').get(id) ?? null;
}

export function findSecuritiesBySymbol(symbol) {
  if (!database) return [];
  return database.prepare('SELECT * FROM securities WHERE symbol = ? COLLATE NOCASE').all(symbol);
}

export function getAllSecurities() {
  if (!database) return [];
  return database.prepare('SELECT * FROM securities ORDER BY symbol ASC').all();
}

function parseFinancialPeriod(row) {
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  return { ...row, data };
}

export function insertFinancialPeriod({ id, security_id, period_label, period_type = 'annual', fiscal_end_date = null, currency = 'USD', data = {}, data_kind = 'reported', source_id = null }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO financial_periods (id, security_id, period_label, period_type, fiscal_end_date, currency, data, data_kind, source_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, security_id, period_label, period_type, fiscal_end_date, currency, JSON.stringify(data), data_kind, source_id, now, now);
}

export function getFinancialPeriodsForSecurity(securityId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM financial_periods WHERE security_id = ? ORDER BY fiscal_end_date ASC, period_label ASC')
    .all(securityId).map(parseFinancialPeriod);
}

export function insertResearchSource({ id, security_id = null, url, title = '', source_type = 'web', data_recency = 'historical', financial_period_label = null, currency = null, limitations = '', untrusted = true, content_excerpt = '' }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO research_sources (id, security_id, url, title, source_type, data_recency, financial_period_label, currency, limitations, retrieved_at, untrusted, content_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, security_id, url, title, source_type, data_recency, financial_period_label, currency, limitations, new Date().toISOString(), untrusted ? 1 : 0, content_excerpt);
}

export function getResearchSourcesForSecurity(securityId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM research_sources WHERE security_id = ? ORDER BY retrieved_at DESC')
    .all(securityId).map(row => ({ ...row, untrusted: !!row.untrusted }));
}

export function getResearchSourceById(id) {
  if (!database) return null;
  const row = database.prepare('SELECT * FROM research_sources WHERE id = ?').get(id);
  return row ? { ...row, untrusted: !!row.untrusted } : null;
}

export function insertInvestmentReport({ id, security_id = null, report_type = 'fundamentals', title = '', content = {}, source_ids = [] }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO investment_reports (id, security_id, report_type, title, content, source_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, security_id, report_type, title, JSON.stringify(content), JSON.stringify(source_ids), new Date().toISOString());
}

export function getInvestmentReportById(id) {
  if (!database) return null;
  const row = database.prepare('SELECT * FROM investment_reports WHERE id = ?').get(id);
  if (!row) return null;
  let content = {}, source_ids = [];
  try { content = JSON.parse(row.content || '{}'); } catch { content = {}; }
  try { source_ids = JSON.parse(row.source_ids || '[]'); } catch { source_ids = []; }
  return { ...row, content, source_ids };
}

export function getInvestmentReportsForSecurity(securityId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM investment_reports WHERE security_id = ? ORDER BY created_at DESC').all(securityId)
    .map(row => getInvestmentReportById(row.id));
}

// ── Paper portfolio (simulation only — never a real broker) ────────────

export function createPaperPortfolio({ id, name = 'Portefeuille simulé', base_currency = 'USD', starting_cash = 100000 }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO paper_portfolios (id, name, base_currency, starting_cash, cash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, base_currency, starting_cash, starting_cash, now, now);
}

export function getPaperPortfolioById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM paper_portfolios WHERE id = ?').get(id) ?? null;
}

export function getAllPaperPortfolios() {
  if (!database) return [];
  return database.prepare('SELECT * FROM paper_portfolios ORDER BY updated_at DESC').all();
}

export function getPaperPositions(portfolioId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM paper_positions WHERE portfolio_id = ? AND quantity != 0 ORDER BY symbol ASC').all(portfolioId);
}

export function getPaperPosition(portfolioId, symbol) {
  if (!database) return null;
  return database.prepare('SELECT * FROM paper_positions WHERE portfolio_id = ? AND symbol = ? COLLATE NOCASE').get(portfolioId, symbol) ?? null;
}

export function getPaperTransactions(portfolioId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM paper_transactions WHERE portfolio_id = ? ORDER BY created_at DESC').all(portfolioId);
}

/**
 * Applies one PAPER_BUY or PAPER_SELL transaction atomically: updates cash,
 * upserts the position (weighted-average cost basis on buy; reduces
 * quantity on sell), and records the transaction row. Caller
 * (investment-policy.js) is responsible for validating `action` is one of
 * PAPER_BUY/PAPER_SELL before calling this — this function trusts its
 * caller's action value but never accepts REAL_BUY/REAL_SELL/LIVE_ORDER
 * because no caller in this codebase is permitted to construct one (see
 * investment-policy.js's explicit rejection).
 */
export function applyPaperTransaction({ id, portfolio_id, action, symbol, quantity, simulated_price, note = '' }) {
  if (!database) return { ok: false, error: 'database_unavailable' };
  const portfolio = getPaperPortfolioById(portfolio_id);
  if (!portfolio) return { ok: false, error: 'portfolio_not_found' };

  const cost = quantity * simulated_price;
  const existing = getPaperPosition(portfolio_id, symbol);
  const now = new Date().toISOString();

  if (action === 'PAPER_BUY') {
    if (portfolio.cash < cost) return { ok: false, error: 'insufficient_cash' };
    const newQuantity = (existing?.quantity ?? 0) + quantity;
    const newCostBasis = existing
      ? ((existing.quantity * existing.avg_cost_basis) + cost) / newQuantity
      : simulated_price;
    const newCash = portfolio.cash - cost;

    const txn = database.transaction(() => {
      database.prepare(`
        INSERT INTO paper_positions (id, portfolio_id, symbol, quantity, avg_cost_basis, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(portfolio_id, symbol) DO UPDATE SET quantity = excluded.quantity, avg_cost_basis = excluded.avg_cost_basis, updated_at = excluded.updated_at
      `).run(existing?.id ?? id + '-pos', portfolio_id, symbol, newQuantity, newCostBasis, now);
      database.prepare('UPDATE paper_portfolios SET cash = ?, updated_at = ? WHERE id = ?').run(newCash, now, portfolio_id);
      database.prepare(`
        INSERT INTO paper_transactions (id, portfolio_id, action, symbol, quantity, simulated_price, cash_after, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, portfolio_id, action, symbol, quantity, simulated_price, newCash, note, now);
    });
    txn();
    return { ok: true, cash: newCash, quantity: newQuantity, avgCostBasis: newCostBasis };
  }

  if (action === 'PAPER_SELL') {
    if (!existing || existing.quantity < quantity) return { ok: false, error: 'position_insufficient' };
    const newQuantity = existing.quantity - quantity;
    const newCash = portfolio.cash + cost;

    const txn = database.transaction(() => {
      database.prepare('UPDATE paper_positions SET quantity = ?, updated_at = ? WHERE id = ?').run(newQuantity, now, existing.id);
      database.prepare('UPDATE paper_portfolios SET cash = ?, updated_at = ? WHERE id = ?').run(newCash, now, portfolio_id);
      database.prepare(`
        INSERT INTO paper_transactions (id, portfolio_id, action, symbol, quantity, simulated_price, cash_after, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, portfolio_id, action, symbol, quantity, simulated_price, newCash, note, now);
    });
    txn();
    return { ok: true, cash: newCash, quantity: newQuantity, avgCostBasis: existing.avg_cost_basis };
  }

  return { ok: false, error: 'action_denied' };
}

export function insertInvestmentWatchlist({ id, name = 'Watchlist', symbols = [] }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO investment_watchlists (id, name, symbols, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, JSON.stringify(symbols), now, now);
}

export function updateInvestmentWatchlist(id, { name, symbols }) {
  if (!database) return;
  const fields = [];
  const vals = [];
  if (name !== undefined) { fields.push('name = ?'); vals.push(name); }
  if (symbols !== undefined) { fields.push('symbols = ?'); vals.push(JSON.stringify(symbols)); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE investment_watchlists SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function getAllInvestmentWatchlists() {
  if (!database) return [];
  return database.prepare('SELECT * FROM investment_watchlists ORDER BY updated_at DESC').all()
    .map(row => ({ ...row, symbols: (() => { try { return JSON.parse(row.symbols || '[]'); } catch { return []; } })() }));
}

// ── Timeline events — built exclusively from already-sourced research ──

export function insertInvestmentEvent({ id, security_id, source_id, event_date = null, date_reliable = false, event_type = 'other', title, summary = '', market_interpretation_statement = null, market_interpretation_basis = null }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO investment_events (id, security_id, source_id, event_date, date_reliable, event_type, title, summary, market_interpretation_statement, market_interpretation_basis, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, security_id, source_id, event_date, date_reliable ? 1 : 0, event_type, title, summary, market_interpretation_statement, market_interpretation_basis, new Date().toISOString());
}

export function getInvestmentEventsForSecurity(securityId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM investment_events WHERE security_id = ? ORDER BY date_reliable DESC, event_date ASC')
    .all(securityId)
    .map(row => ({ ...row, date_reliable: !!row.date_reliable }));
}

// ---------------------------------------------------------------------
// Business/Sales Agent V1 — RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN
// REVIEW. sales_drafts.sent is always written 0 here; there is no
// exported function in this module that ever sets it to 1 — sending is
// not a capability this module provides.
// ---------------------------------------------------------------------

export function insertSalesLead({ id, name, company = '', notes = '' }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO sales_leads (id, name, company, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, company, notes, now, now);
}

export function getSalesLeadById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM sales_leads WHERE id = ?').get(id) ?? null;
}

export function getAllSalesLeads() {
  if (!database) return [];
  return database.prepare('SELECT * FROM sales_leads ORDER BY updated_at DESC').all();
}

export function insertSalesResearchSource({ id, lead_id, url, title = '', untrusted = true, content_excerpt = '' }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO sales_research_sources (id, lead_id, url, title, retrieved_at, untrusted, content_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, lead_id, url, title, new Date().toISOString(), untrusted ? 1 : 0, content_excerpt);
}

export function getSalesResearchSourcesForLead(leadId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM sales_research_sources WHERE lead_id = ? ORDER BY retrieved_at DESC')
    .all(leadId).map(row => ({ ...row, untrusted: !!row.untrusted }));
}

export function insertSalesDraft({ id, lead_id, kind, subject = '', body = '' }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO sales_drafts (id, lead_id, kind, subject, body, status, sent, created_at)
    VALUES (?, ?, ?, ?, ?, 'DRAFT — NOT SENT', 0, ?)
  `).run(id, lead_id, kind, subject, body, new Date().toISOString());
}

export function getSalesDraftsForLead(leadId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM sales_drafts WHERE lead_id = ? ORDER BY created_at DESC')
    .all(leadId).map(row => ({ ...row, sent: !!row.sent }));
}

// ---------------------------------------------------------------------
// Cyber Audit Agent (SENTINEL V1, CA-5) — mission/scope/request/evidence/
// finding/event persistence. Same partial-update ("only SET provided
// fields") and JSON-metadata idiom as metagpt_missions above. This module
// never redacts — callers (cyber-evidence.js) must redact before calling
// insertCyberAuditEvidence/insertCyberAuditFinding, exactly like
// metagpt_mission_events documents "never credentials/secrets in detail"
// as a caller contract rather than re-validating it here.
// ---------------------------------------------------------------------

function parseCyberAuditMission(row) {
  if (!row) return null;
  let metadata = {};
  try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
  return { ...row, authorization_confirmed: !!row.authorization_confirmed, metadata };
}

export function insertCyberAuditMission({ id, title, client_name, authorization_reference, mode = 'PASSIVE_AUDIT' }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO cyber_audit_missions (id, title, client_name, authorization_confirmed, authorization_reference, mode, status, created_at, updated_at, metadata)
    VALUES (?, ?, ?, 1, ?, ?, 'DRAFT', ?, ?, '{}')
  `).run(id, title, client_name, authorization_reference, mode, now, now);
}

export function updateCyberAuditMission(id, updates) {
  if (!database) return;
  const fields = [];
  const vals = [];
  if (updates.status         !== undefined) { fields.push('status = ?');         vals.push(updates.status); }
  if (updates.started_at     !== undefined) { fields.push('started_at = ?');     vals.push(updates.started_at); }
  if (updates.completed_at   !== undefined) { fields.push('completed_at = ?');   vals.push(updates.completed_at); }
  if (updates.error_message  !== undefined) { fields.push('error_message = ?');  vals.push(updates.error_message); }
  if (updates.metadata       !== undefined) { fields.push('metadata = ?');       vals.push(JSON.stringify(updates.metadata)); }
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  if (fields.length > 1) database.prepare(`UPDATE cyber_audit_missions SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function getCyberAuditMissionById(id) {
  if (!database) return null;
  return parseCyberAuditMission(database.prepare('SELECT * FROM cyber_audit_missions WHERE id = ?').get(id));
}

export function getAllCyberAuditMissions() {
  if (!database) return [];
  return database.prepare('SELECT * FROM cyber_audit_missions ORDER BY updated_at DESC').all().map(parseCyberAuditMission);
}

// Scope is write-once: no update function is provided by design (CA-2's
// mission model treats the scope as frozen once a mission is scoped —
// see cyber-policy.js's validateScope/Object.freeze). Re-scoping means
// creating a new mission.
export function insertCyberAuditScope({ mission_id, scope }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO cyber_audit_scopes (mission_id, scope, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(mission_id) DO NOTHING
  `).run(mission_id, JSON.stringify(scope), new Date().toISOString());
}

export function getCyberAuditScope(missionId) {
  if (!database) return null;
  const row = database.prepare('SELECT * FROM cyber_audit_scopes WHERE mission_id = ?').get(missionId);
  if (!row) return null;
  let scope = {};
  try { scope = JSON.parse(row.scope || '{}'); } catch { scope = {}; }
  return { ...row, scope };
}

export function insertCyberAuditRequest({ id, mission_id, url, method, status = null }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO cyber_audit_requests (id, mission_id, url, method, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, mission_id, url, method, status, new Date().toISOString());
}

export function getCyberAuditRequestsForMission(missionId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM cyber_audit_requests WHERE mission_id = ? ORDER BY created_at ASC').all(missionId);
}

export function insertCyberAuditEvidence({ id, mission_id, request_id, url, method, response_status = null, relevant_headers = {}, excerpt = '', sha256 }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO cyber_audit_evidence (id, mission_id, request_id, url, method, timestamp, response_status, relevant_headers, excerpt, sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, mission_id, request_id, url, method, new Date().toISOString(), response_status, JSON.stringify(relevant_headers), excerpt, sha256);
}

function parseCyberAuditEvidence(row) {
  if (!row) return null;
  let relevant_headers = {};
  try { relevant_headers = JSON.parse(row.relevant_headers || '{}'); } catch { relevant_headers = {}; }
  return { ...row, relevant_headers };
}

export function getCyberAuditEvidenceById(id) {
  if (!database) return null;
  return parseCyberAuditEvidence(database.prepare('SELECT * FROM cyber_audit_evidence WHERE id = ?').get(id));
}

export function getCyberAuditEvidenceForMission(missionId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM cyber_audit_evidence WHERE mission_id = ? ORDER BY timestamp ASC').all(missionId).map(parseCyberAuditEvidence);
}

function parseCyberAuditFinding(row) {
  if (!row) return null;
  let evidence_ids = [];
  let references = [];
  try { evidence_ids = JSON.parse(row.evidence_ids || '[]'); } catch { evidence_ids = []; }
  try { references = JSON.parse(row.references_json || '[]'); } catch { references = []; }
  return { ...row, evidence_ids, references };
}

/**
 * Insert-or-touch: if a finding with the same `id` already exists for this
 * mission, this UPDATEs last_seen (and merges evidence_ids) instead of
 * creating a duplicate row — findings are deterministic-id keyed
 * (category+asset+specific-check), so the same underlying observation
 * re-detected on a re-scan must never appear twice.
 */
export function upsertCyberAuditFinding({ id, mission_id, title, category, severity, confidence, asset, description = '', evidence_ids = [], impact = '', recommendation = '', references = [] }) {
  if (!database) return;
  const now = new Date().toISOString();
  const existing = database.prepare('SELECT * FROM cyber_audit_findings WHERE id = ? AND mission_id = ?').get(id, mission_id);
  if (existing) {
    let mergedEvidence = [];
    try { mergedEvidence = JSON.parse(existing.evidence_ids || '[]'); } catch { mergedEvidence = []; }
    const combined = Array.from(new Set([...mergedEvidence, ...evidence_ids]));
    database.prepare('UPDATE cyber_audit_findings SET last_seen = ?, evidence_ids = ? WHERE id = ? AND mission_id = ?')
      .run(now, JSON.stringify(combined), id, mission_id);
    return 'updated';
  }
  database.prepare(`
    INSERT INTO cyber_audit_findings (id, mission_id, title, category, severity, confidence, status, asset, description, evidence_ids, impact, recommendation, references_json, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, mission_id, title, category, severity, confidence, asset, description, JSON.stringify(evidence_ids), impact, recommendation, JSON.stringify(references), now, now);
  return 'created';
}

const CYBER_FINDING_STATUSES = new Set(['OPEN', 'CONFIRMED', 'FALSE_POSITIVE', 'ACCEPTED_RISK', 'RESOLVED']);

export function updateCyberAuditFindingStatus(id, missionId, status) {
  if (!database) return false;
  if (!CYBER_FINDING_STATUSES.has(status)) throw new Error(`invalid_finding_status:${status}`);
  const result = database.prepare('UPDATE cyber_audit_findings SET status = ? WHERE id = ? AND mission_id = ?').run(status, id, missionId);
  return result.changes > 0;
}

export function getCyberAuditFindingById(id, missionId) {
  if (!database) return null;
  return parseCyberAuditFinding(database.prepare('SELECT * FROM cyber_audit_findings WHERE id = ? AND mission_id = ?').get(id, missionId));
}

export function getCyberAuditFindingsForMission(missionId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM cyber_audit_findings WHERE mission_id = ? ORDER BY first_seen ASC').all(missionId).map(parseCyberAuditFinding);
}

export function insertCyberAuditEvent({ id, mission_id, from_status = null, to_status, detail = {} }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO cyber_audit_events (id, mission_id, from_status, to_status, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, mission_id, from_status, to_status, JSON.stringify(detail), new Date().toISOString());
}

export function getCyberAuditEventsForMission(missionId) {
  if (!database) return [];
  return database.prepare('SELECT * FROM cyber_audit_events WHERE mission_id = ? ORDER BY created_at ASC')
    .all(missionId)
    .map(row => ({ ...row, detail: (() => { try { return JSON.parse(row.detail || '{}'); } catch { return {}; } })() }));
}

// ---------------------------------------------------------------------
// OMEGA V1 Phase 2 — device identity, pairing, sessions, audit. Fully
// separate authorization domain from MAÎTRE (mission §43): omega_*
// tables only. Display names / audit detail strings are untrusted
// input (mission §29) — stored and returned verbatim as inert data,
// never interpreted/executed, never written into an HTML sink here.
// ---------------------------------------------------------------------

export function insertOmegaDevice({ id, display_name, public_key_pem, fingerprint, permission_level }) {
  if (!database) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO omega_devices (id, display_name, public_key_pem, fingerprint, permission_level, created_at, last_seen, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(id, display_name, public_key_pem, fingerprint, permission_level, now, now);
}

export function getOmegaDeviceById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM omega_devices WHERE id = ?').get(id) ?? null;
}

// Fingerprint is deliberately NOT a UNIQUE column: a revoked device
// that re-pairs with the SAME key must get a brand-new device row
// (mission §17/§18 — no "resurrecting" a revoked identity), which can
// leave multiple rows sharing one fingerprint (one revoked, one live).
// This lookup always prefers the live (non-revoked) row so
// omega-pairing.js's re-pairing logic reuses the CURRENT trusted
// device rather than an old revoked one; if none is live, falls back
// to the most recently created row (still useful for key-status
// lookups even though it grants no trust by itself).
export function getOmegaDeviceByFingerprint(fingerprint) {
  if (!database) return null;
  const live = database.prepare('SELECT * FROM omega_devices WHERE fingerprint = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').get(fingerprint);
  if (live) return live;
  return database.prepare('SELECT * FROM omega_devices WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1').get(fingerprint) ?? null;
}

export function getAllOmegaDevices() {
  if (!database) return [];
  return database.prepare('SELECT * FROM omega_devices ORDER BY created_at DESC').all();
}

export function touchOmegaDeviceLastSeen(id) {
  if (!database) return;
  database.prepare('UPDATE omega_devices SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function revokeOmegaDevice(id) {
  if (!database) return false;
  const now = new Date().toISOString();
  const result = database.prepare('UPDATE omega_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
  return result.changes > 0;
}

export function insertOmegaPairing({ id, initiator_device_name, requested_permission, code_hash, expires_at }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO omega_pairings (id, initiator_device_name, requested_permission, code_hash, created_at, expires_at, attempt_count, status)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'PENDING')
  `).run(id, initiator_device_name, requested_permission, code_hash, new Date().toISOString(), expires_at);
}

export function getOmegaPairingById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM omega_pairings WHERE id = ?').get(id) ?? null;
}

export function getAllOmegaPairings() {
  if (!database) return [];
  return database.prepare('SELECT * FROM omega_pairings ORDER BY created_at DESC').all();
}

export function incrementOmegaPairingAttempt(id) {
  if (!database) return;
  database.prepare('UPDATE omega_pairings SET attempt_count = attempt_count + 1 WHERE id = ?').run(id);
}

export function updateOmegaPairingStatus(id, { status, device_id = undefined, public_key_pem = undefined, fingerprint = undefined, consumed_at = undefined, decided_at = undefined }) {
  if (!database) return false;
  const current = getOmegaPairingById(id);
  if (!current) return false;
  const result = database.prepare(`
    UPDATE omega_pairings SET
      status = ?,
      device_id = ?,
      public_key_pem = ?,
      fingerprint = ?,
      consumed_at = ?,
      decided_at = ?
    WHERE id = ?
  `).run(
    status,
    device_id !== undefined ? device_id : current.device_id,
    public_key_pem !== undefined ? public_key_pem : current.public_key_pem,
    fingerprint !== undefined ? fingerprint : current.fingerprint,
    consumed_at !== undefined ? consumed_at : current.consumed_at,
    decided_at !== undefined ? decided_at : current.decided_at,
    id,
  );
  return result.changes > 0;
}

export function expireStaleOmegaPairings(nowIso) {
  if (!database) return 0;
  const result = database.prepare(`
    UPDATE omega_pairings SET status = 'EXPIRED'
    WHERE status = 'PENDING' AND expires_at < ?
  `).run(nowIso);
  return result.changes;
}

export function insertOmegaSession({ id, device_id, permission_level, nonce, expires_at }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO omega_sessions (id, device_id, permission_level, nonce, created_at, expires_at, ended_at, revoked_at, last_used_nonce)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `).run(id, device_id, permission_level, nonce, new Date().toISOString(), expires_at);
}

export function getOmegaSessionById(id) {
  if (!database) return null;
  return database.prepare('SELECT * FROM omega_sessions WHERE id = ?').get(id) ?? null;
}

export function getActiveOmegaSessionsForDevice(deviceId) {
  if (!database) return [];
  return database.prepare(`
    SELECT * FROM omega_sessions WHERE device_id = ? AND ended_at IS NULL AND revoked_at IS NULL
  `).all(deviceId);
}

export function endOmegaSession(id) {
  if (!database) return false;
  const result = database.prepare('UPDATE omega_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function revokeOmegaSessionsForDevice(deviceId) {
  if (!database) return 0;
  const now = new Date().toISOString();
  const result = database.prepare(`
    UPDATE omega_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL AND ended_at IS NULL
  `).run(now, deviceId);
  return result.changes;
}

export function updateOmegaSessionLastNonce(id, nonce) {
  if (!database) return;
  database.prepare('UPDATE omega_sessions SET last_used_nonce = ? WHERE id = ?').run(nonce, id);
}

export function insertOmegaAudit({ id, event_type, device_id = null, session_id = null, pairing_id = null, result = '', detail = {} }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO omega_audit (id, created_at, event_type, device_id, session_id, pairing_id, result, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, new Date().toISOString(), event_type, device_id, session_id, pairing_id, result, JSON.stringify(detail ?? {}));
}

export function listOmegaAudit({ limit = 200 } = {}) {
  if (!database) return [];
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  return database.prepare('SELECT * FROM omega_audit ORDER BY created_at DESC LIMIT ?').all(n)
    .map(row => ({ ...row, detail: (() => { try { return JSON.parse(row.detail || '{}'); } catch { return {}; } })() }));
}

// ---------------------------------------------------------------------
// OMEGA V1 Phase 3 — VIEW ONLY session state (screen selection, frame
// bookkeeping). See schema comment above for scope/rationale.
// ---------------------------------------------------------------------

export function insertOmegaViewSession({ session_id, device_id, screen_index }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO omega_view_sessions (session_id, device_id, screen_index, started_at, stopped_at, last_frame_at, frame_count)
    VALUES (?, ?, ?, ?, NULL, NULL, 0)
  `).run(session_id, device_id, screen_index, new Date().toISOString());
}

export function getOmegaViewSession(sessionId) {
  if (!database) return null;
  return database.prepare('SELECT * FROM omega_view_sessions WHERE session_id = ?').get(sessionId) ?? null;
}

export function recordOmegaViewFrame(sessionId, { width, height }) {
  if (!database) return;
  database.prepare(`
    UPDATE omega_view_sessions
    SET last_frame_at = ?, last_frame_width = ?, last_frame_height = ?, frame_count = frame_count + 1
    WHERE session_id = ?
  `).run(new Date().toISOString(), width, height, sessionId);
}

export function stopOmegaViewSession(sessionId) {
  if (!database) return false;
  const result = database.prepare(`
    UPDATE omega_view_sessions SET stopped_at = ? WHERE session_id = ? AND stopped_at IS NULL
  `).run(new Date().toISOString(), sessionId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------
// OMEGA V1 Phase 4 — OMEGA_INTERACTIVE session state (event bookkeeping
// only, never actual input content). See schema comment above for
// scope/rationale.
// ---------------------------------------------------------------------

export function insertOmegaInteractiveSession({ session_id, device_id }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO omega_interactive_sessions (session_id, device_id, started_at, stopped_at, last_event_at, event_count)
    VALUES (?, ?, ?, NULL, NULL, 0)
  `).run(session_id, device_id, new Date().toISOString());
}

export function getOmegaInteractiveSession(sessionId) {
  if (!database) return null;
  return database.prepare('SELECT * FROM omega_interactive_sessions WHERE session_id = ?').get(sessionId) ?? null;
}

export function recordOmegaInteractiveEvents(sessionId, count) {
  if (!database) return;
  database.prepare(`
    UPDATE omega_interactive_sessions
    SET last_event_at = ?, event_count = event_count + ?
    WHERE session_id = ?
  `).run(new Date().toISOString(), count, sessionId);
}

export function stopOmegaInteractiveSession(sessionId) {
  if (!database) return false;
  const result = database.prepare(`
    UPDATE omega_interactive_sessions SET stopped_at = ? WHERE session_id = ? AND stopped_at IS NULL
  `).run(new Date().toISOString(), sessionId);
  return result.changes > 0;
}

// ── RASSILON V1 Phase 2 — local single-machine safe worker DB access ──────
// rassilon_* only (see table comment above). Never touches omega_*/
// maitre_*/monitor_*/cyber_* tables or vice versa.

const RASSILON_SETTINGS_DEFAULTS = Object.freeze({
  id: 1,
  enabled: 0,
  max_cpu_percent: 25,
  max_ram_mb: 2048,
  max_concurrent_jobs: 1,
  max_job_duration_sec: 300,
  max_scratch_mb: 1024,
  pause_on_battery: 1,
  minimum_battery_percent: 30,
  pause_when_user_active: 1,
  accepted_job_types: '[]',
  approval_mode: 'ASK_EACH_JOB',
});

function parseRassilonSettingsRow(row) {
  if (!row) return null;
  return {
    enabled: !!row.enabled,
    maxCpuPercent: row.max_cpu_percent,
    maxRamMb: row.max_ram_mb,
    maxConcurrentJobs: row.max_concurrent_jobs,
    maxJobDurationSec: row.max_job_duration_sec,
    maxScratchMb: row.max_scratch_mb,
    pauseOnBattery: !!row.pause_on_battery,
    minimumBatteryPercent: row.minimum_battery_percent,
    pauseWhenUserActive: !!row.pause_when_user_active,
    acceptedJobTypes: (() => { try { return JSON.parse(row.accepted_job_types || '[]'); } catch { return []; } })(),
    approvalMode: row.approval_mode,
    updatedAt: row.updated_at,
  };
}

// Ensures the single settings row (id=1) exists with hard-coded
// conservative defaults (mission §5/§6) — never created with enabled=1.
export function getRassilonSettings() {
  if (!database) return parseRassilonSettingsRow(RASSILON_SETTINGS_DEFAULTS);
  let row = database.prepare('SELECT * FROM rassilon_settings WHERE id = 1').get();
  if (!row) {
    database.prepare(`
      INSERT INTO rassilon_settings (id, enabled, max_cpu_percent, max_ram_mb, max_concurrent_jobs, max_job_duration_sec, max_scratch_mb, pause_on_battery, minimum_battery_percent, pause_when_user_active, accepted_job_types, approval_mode)
      VALUES (1, 0, @max_cpu_percent, @max_ram_mb, @max_concurrent_jobs, @max_job_duration_sec, @max_scratch_mb, @pause_on_battery, @minimum_battery_percent, @pause_when_user_active, @accepted_job_types, @approval_mode)
    `).run(RASSILON_SETTINGS_DEFAULTS);
    row = database.prepare('SELECT * FROM rassilon_settings WHERE id = 1').get();
  }
  return parseRassilonSettingsRow(row);
}

// Only these fields are ever mutable — `enabled` is intentionally excluded
// here: it is flipped exclusively by setRassilonEnabled() below so every
// enable/disable transition goes through one single, auditable choke
// point rather than being a side effect of a generic settings PATCH
// (mission §3/§31 — "ENABLE : action utilisateur explicite").
const RASSILON_SETTINGS_MUTABLE_FIELDS = [
  'max_cpu_percent', 'max_ram_mb', 'max_concurrent_jobs', 'max_job_duration_sec',
  'max_scratch_mb', 'pause_on_battery', 'minimum_battery_percent', 'pause_when_user_active',
  'accepted_job_types', 'approval_mode',
];

export function updateRassilonSettings(fields) {
  if (!database) return null;
  getRassilonSettings(); // ensure row exists
  const keys = Object.keys(fields).filter(k => RASSILON_SETTINGS_MUTABLE_FIELDS.includes(k));
  if (keys.length === 0) return getRassilonSettings();
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  database.prepare(`UPDATE rassilon_settings SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run(fields);
  return getRassilonSettings();
}

export function setRassilonEnabled(enabled) {
  if (!database) return null;
  getRassilonSettings(); // ensure row exists
  database.prepare('UPDATE rassilon_settings SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(enabled ? 1 : 0);
  return getRassilonSettings();
}

export function upsertRassilonIdentity({ deviceId, publicKeyPem, fingerprint }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO rassilon_identity (device_id, public_key_pem, fingerprint, created_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id) DO UPDATE SET public_key_pem = excluded.public_key_pem, fingerprint = excluded.fingerprint
  `).run(deviceId, publicKeyPem, fingerprint);
}

export function getRassilonIdentity(deviceId) {
  if (!database) return null;
  return database.prepare('SELECT * FROM rassilon_identity WHERE device_id = ? AND revoked_at IS NULL').get(deviceId) ?? null;
}

export function listRassilonIdentities() {
  if (!database) return [];
  return database.prepare('SELECT * FROM rassilon_identity ORDER BY created_at ASC').all();
}

export function revokeRassilonIdentity(deviceId) {
  if (!database) return false;
  const result = database.prepare('UPDATE rassilon_identity SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), deviceId);
  return result.changes > 0;
}

function parseRassilonJobRow(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    jobType: row.job_type,
    issuerDeviceId: row.issuer_device_id,
    status: row.status,
    resourceBudget: (() => { try { return JSON.parse(row.resource_budget || '{}'); } catch { return {}; } })(),
    payloadSummary: (() => { try { return JSON.parse(row.payload_summary || '{}'); } catch { return {}; } })(),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorReason: row.error_reason,
    resultSummary: (() => { try { return JSON.parse(row.result_summary || '{}'); } catch { return {}; } })(),
    policyVersion: row.policy_version,
  };
}

// Inserted at RECEIVED with a UNIQUE PRIMARY KEY on job_id — a duplicate
// jobId throws (SQLITE_CONSTRAINT), which insertRassilonJob's caller (the
// anti-replay check in rassilon-worker.js) treats as "already processed,
// reject" rather than silently overwriting the prior row (mission §17).
export function insertRassilonJob(row) {
  if (!database) return null;
  database.prepare(`
    INSERT INTO rassilon_jobs (job_id, job_type, issuer_device_id, status, resource_budget, payload_summary, created_at, expires_at, policy_version)
    VALUES (@job_id, @job_type, @issuer_device_id, @status, @resource_budget, @payload_summary, CURRENT_TIMESTAMP, @expires_at, @policy_version)
  `).run(row);
  return getRassilonJobById(row.job_id);
}

export function getRassilonJobById(jobId) {
  if (!database) return null;
  return parseRassilonJobRow(database.prepare('SELECT * FROM rassilon_jobs WHERE job_id = ?').get(jobId));
}

export function listRassilonJobs({ limit = 50, offset = 0, status = null } = {}) {
  if (!database) return [];
  const rows = status
    ? database.prepare('SELECT * FROM rassilon_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(status, limit, offset)
    : database.prepare('SELECT * FROM rassilon_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  return rows.map(parseRassilonJobRow);
}

export function listRassilonJobsByStatuses(statuses) {
  if (!database || !Array.isArray(statuses) || statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(',');
  return database.prepare(`SELECT * FROM rassilon_jobs WHERE status IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...statuses).map(parseRassilonJobRow);
}

const RASSILON_JOB_MUTABLE_FIELDS = ['status', 'started_at', 'completed_at', 'error_reason', 'result_summary'];

export function updateRassilonJob(jobId, fields) {
  if (!database) return null;
  const keys = Object.keys(fields).filter(k => RASSILON_JOB_MUTABLE_FIELDS.includes(k));
  if (keys.length === 0) return getRassilonJobById(jobId);
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  database.prepare(`UPDATE rassilon_jobs SET ${setClause} WHERE job_id = @job_id`).run({ ...fields, job_id: jobId });
  return getRassilonJobById(jobId);
}

export function insertRassilonAudit({ eventType, jobId = null, issuerDeviceId = null, resultSummary = {} }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO rassilon_audit (created_at, event_type, job_id, issuer_device_id, result_summary)
    VALUES (CURRENT_TIMESTAMP, ?, ?, ?, ?)
  `).run(eventType, jobId, issuerDeviceId, JSON.stringify(resultSummary ?? {}));
}

export function listRassilonAudit({ limit = 200, offset = 0 } = {}) {
  if (!database) return [];
  return database.prepare('SELECT * FROM rassilon_audit ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// -- RASSILON Phase 4: LAN device trust, pairing, sessions and controller jobs.

export function getRassilonLocalDevice() {
  if (!database) return null;
  const row = database.prepare('SELECT * FROM rassilon_local_device WHERE id = 1').get();
  return row ? { deviceId: row.device_id, displayName: row.display_name, createdAt: row.created_at } : null;
}

export function setRassilonLocalDevice({ deviceId, displayName }) {
  if (!database) return null;
  database.prepare(`
    INSERT INTO rassilon_local_device (id, device_id, display_name)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name
  `).run(deviceId, displayName);
  return getRassilonLocalDevice();
}

export function getRassilonLanSettings() {
  if (!database) return { enabled: false, bindAddress: null, port: 3443, updatedAt: null };
  database.prepare('INSERT OR IGNORE INTO rassilon_lan_settings (id) VALUES (1)').run();
  const row = database.prepare('SELECT * FROM rassilon_lan_settings WHERE id = 1').get();
  return { enabled: !!row.enabled, bindAddress: row.bind_address, port: row.port, updatedAt: row.updated_at };
}

export function setRassilonLanSettings({ enabled, bindAddress = null, port = 3443 }) {
  if (!database) return null;
  database.prepare(`
    INSERT INTO rassilon_lan_settings (id, enabled, bind_address, port, updated_at)
    VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, bind_address = excluded.bind_address,
      port = excluded.port, updated_at = CURRENT_TIMESTAMP
  `).run(enabled ? 1 : 0, bindAddress, port);
  return getRassilonLanSettings();
}

function parseRassilonDeviceRow(row) {
  if (!row) return null;
  const parse = (value, fallback) => { try { return JSON.parse(value || ''); } catch { return fallback; } };
  return {
    deviceId: row.device_id,
    displayName: row.display_name,
    publicKeyPem: row.public_key_pem,
    fingerprint: row.fingerprint,
    role: row.role,
    permissionSet: parse(row.permission_set, []),
    endpointHost: row.endpoint_host,
    endpointPort: row.endpoint_port,
    tlsCertificatePem: row.tls_certificate_pem,
    tlsCertificateFingerprint: row.tls_certificate_fingerprint,
    capabilities: parse(row.capabilities, {}),
    status: row.revoked_at ? 'REVOKED' : row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export function upsertRassilonDevice(device) {
  if (!database) return null;
  database.prepare(`
    INSERT INTO rassilon_devices (
      device_id, display_name, public_key_pem, fingerprint, role, permission_set,
      endpoint_host, endpoint_port, tls_certificate_pem, tls_certificate_fingerprint,
      capabilities, status, created_at, last_seen_at, revoked_at
    ) VALUES (
      @deviceId, @displayName, @publicKeyPem, @fingerprint, @role, @permissionSet,
      @endpointHost, @endpointPort, @tlsCertificatePem, @tlsCertificateFingerprint,
      @capabilities, @status, CURRENT_TIMESTAMP, @lastSeenAt, NULL
    ) ON CONFLICT(device_id) DO UPDATE SET
      display_name = excluded.display_name,
      public_key_pem = excluded.public_key_pem,
      fingerprint = excluded.fingerprint,
      role = excluded.role,
      permission_set = excluded.permission_set,
      endpoint_host = excluded.endpoint_host,
      endpoint_port = excluded.endpoint_port,
      tls_certificate_pem = excluded.tls_certificate_pem,
      tls_certificate_fingerprint = excluded.tls_certificate_fingerprint,
      capabilities = excluded.capabilities,
      status = excluded.status,
      last_seen_at = excluded.last_seen_at,
      revoked_at = NULL
  `).run({
    ...device,
    permissionSet: JSON.stringify(device.permissionSet ?? []),
    capabilities: JSON.stringify(device.capabilities ?? {}),
    endpointHost: device.endpointHost ?? null,
    endpointPort: device.endpointPort ?? null,
    tlsCertificatePem: device.tlsCertificatePem ?? null,
    tlsCertificateFingerprint: device.tlsCertificateFingerprint ?? null,
    status: device.status ?? 'OFFLINE',
    lastSeenAt: device.lastSeenAt ?? null,
  });
  return getRassilonDevice(device.deviceId, { includeRevoked: true });
}

export function getRassilonDevice(deviceId, { includeRevoked = false } = {}) {
  if (!database) return null;
  const sql = `SELECT * FROM rassilon_devices WHERE device_id = ?${includeRevoked ? '' : ' AND revoked_at IS NULL'}`;
  return parseRassilonDeviceRow(database.prepare(sql).get(deviceId));
}

export function listRassilonDevices({ includeRevoked = true } = {}) {
  if (!database) return [];
  const sql = `SELECT * FROM rassilon_devices${includeRevoked ? '' : ' WHERE revoked_at IS NULL'} ORDER BY created_at ASC`;
  return database.prepare(sql).all().map(parseRassilonDeviceRow);
}

export function updateRassilonDevicePresence(deviceId, { status, capabilities, lastSeenAt = new Date().toISOString() }) {
  if (!database) return null;
  database.prepare(`UPDATE rassilon_devices SET status = ?, capabilities = ?, last_seen_at = ?
    WHERE device_id = ? AND revoked_at IS NULL`).run(status, JSON.stringify(capabilities ?? {}), lastSeenAt, deviceId);
  return getRassilonDevice(deviceId);
}

export function revokeRassilonDevice(deviceId) {
  if (!database) return false;
  const now = new Date().toISOString();
  const transaction = database.transaction(() => {
    const result = database.prepare(`UPDATE rassilon_devices SET revoked_at = ?, status = 'REVOKED'
      WHERE device_id = ? AND revoked_at IS NULL`).run(now, deviceId);
    database.prepare('UPDATE rassilon_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, deviceId);
    database.prepare('UPDATE rassilon_outbound_sessions SET revoked_at = ? WHERE worker_device_id = ? AND revoked_at IS NULL').run(now, deviceId);
    return result.changes > 0;
  });
  return transaction();
}

function parseRassilonPairingRow(row) {
  if (!row) return null;
  const parse = value => { try { return JSON.parse(value || '[]'); } catch { return []; } };
  return {
    pairingId: row.pairing_id, state: row.state, codeHash: row.code_hash,
    workerNonce: row.worker_nonce, controllerNonce: row.controller_nonce,
    controllerDeviceId: row.controller_device_id, controllerPublicKeyPem: row.controller_public_key_pem,
    controllerFingerprint: row.controller_fingerprint, controllerDisplayName: row.controller_display_name,
    requestedPermissions: parse(row.requested_permissions), approvedPermissions: parse(row.approved_permissions),
    expiresAt: row.expires_at, createdAt: row.created_at, confirmedAt: row.confirmed_at,
    usedAt: row.used_at, cancelledAt: row.cancelled_at,
  };
}

export function insertRassilonPairing(pairing) {
  if (!database) return null;
  database.prepare(`INSERT INTO rassilon_pairings (
    pairing_id, state, code_hash, worker_nonce, requested_permissions, approved_permissions, expires_at
  ) VALUES (?, 'STARTED', ?, ?, '[]', '[]', ?)`)
    .run(pairing.pairingId, pairing.codeHash, pairing.workerNonce, pairing.expiresAt);
  return getRassilonPairing(pairing.pairingId);
}

export function getRassilonPairing(pairingId) {
  if (!database) return null;
  return parseRassilonPairingRow(database.prepare('SELECT * FROM rassilon_pairings WHERE pairing_id = ?').get(pairingId));
}

const RASSILON_PAIRING_FIELDS = new Set([
  'state', 'controller_nonce', 'controller_device_id', 'controller_public_key_pem',
  'controller_fingerprint', 'controller_display_name', 'requested_permissions',
  'approved_permissions', 'confirmed_at', 'used_at', 'cancelled_at',
]);

export function updateRassilonPairing(pairingId, fields) {
  if (!database) return null;
  const keys = Object.keys(fields).filter(key => RASSILON_PAIRING_FIELDS.has(key));
  if (keys.length === 0) return getRassilonPairing(pairingId);
  database.prepare(`UPDATE rassilon_pairings SET ${keys.map(key => `${key} = @${key}`).join(', ')} WHERE pairing_id = @pairing_id`)
    .run({ ...fields, pairing_id: pairingId });
  return getRassilonPairing(pairingId);
}

export function createRassilonSession({ sessionId, deviceId, expiresAt }) {
  if (!database) return null;
  database.prepare(`INSERT INTO rassilon_sessions (session_id, device_id, expires_at) VALUES (?, ?, ?)`)
    .run(sessionId, deviceId, expiresAt);
  return getRassilonSession(sessionId);
}

export function getRassilonSession(sessionId) {
  if (!database) return null;
  const row = database.prepare('SELECT * FROM rassilon_sessions WHERE session_id = ?').get(sessionId);
  return row ? {
    sessionId: row.session_id, deviceId: row.device_id, createdAt: row.created_at,
    expiresAt: row.expires_at, revokedAt: row.revoked_at, lastSeenAt: row.last_seen_at,
  } : null;
}

/**
 * UI-safe session metadata for the local control plane. Session IDs are
 * deliberately omitted: the UI only needs age/expiry/last-seen state and
 * must never receive authentication material.
 */
export function getRassilonDeviceSessionView(deviceId) {
  if (!database) return null;
  const inbound = database.prepare(`SELECT created_at, expires_at, revoked_at, last_seen_at
    FROM rassilon_sessions WHERE device_id = ? ORDER BY created_at DESC LIMIT 1`).get(deviceId);
  const outbound = database.prepare(`SELECT created_at, expires_at, revoked_at, NULL AS last_seen_at
    FROM rassilon_outbound_sessions WHERE worker_device_id = ? ORDER BY created_at DESC LIMIT 1`).get(deviceId);
  const row = inbound ?? outbound;
  if (!row) return null;
  const now = Date.now();
  return {
    direction: inbound ? 'INBOUND' : 'OUTBOUND',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    active: !row.revoked_at && Date.parse(row.expires_at) > now,
    revokedAt: row.revoked_at,
  };
}

export function touchRassilonSession(sessionId, at = new Date().toISOString()) {
  if (!database) return;
  const transaction = database.transaction(() => {
    database.prepare('UPDATE rassilon_sessions SET last_seen_at = ? WHERE session_id = ? AND revoked_at IS NULL').run(at, sessionId);
    database.prepare(`UPDATE rassilon_devices SET last_seen_at = ?, status = 'ONLINE'
      WHERE device_id = (SELECT device_id FROM rassilon_sessions WHERE session_id = ?) AND revoked_at IS NULL`).run(at, sessionId);
  });
  transaction();
}

export function revokeRassilonSessionsForDevice(deviceId) {
  if (!database) return 0;
  return database.prepare('UPDATE rassilon_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), deviceId).changes;
}

export function revokeAllRassilonSessions() {
  if (!database) return 0;
  const now = new Date().toISOString();
  const transaction = database.transaction(() => {
    const inbound = database.prepare('UPDATE rassilon_sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(now).changes;
    const outbound = database.prepare('UPDATE rassilon_outbound_sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(now).changes;
    return inbound + outbound;
  });
  return transaction();
}

export function upsertRassilonOutboundSession({ workerDeviceId, sessionId, expiresAt }) {
  if (!database) return null;
  database.prepare(`INSERT INTO rassilon_outbound_sessions (worker_device_id, session_id, expires_at, revoked_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(worker_device_id) DO UPDATE SET session_id = excluded.session_id,
      created_at = CURRENT_TIMESTAMP, expires_at = excluded.expires_at, revoked_at = NULL`)
    .run(workerDeviceId, sessionId, expiresAt);
  return getRassilonOutboundSession(workerDeviceId);
}

export function getRassilonOutboundSession(workerDeviceId) {
  if (!database) return null;
  const row = database.prepare(`SELECT * FROM rassilon_outbound_sessions
    WHERE worker_device_id = ? AND revoked_at IS NULL`).get(workerDeviceId);
  return row ? { workerDeviceId: row.worker_device_id, sessionId: row.session_id, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at } : null;
}

export function revokeRassilonOutboundSession(workerDeviceId) {
  if (!database) return false;
  return database.prepare('UPDATE rassilon_outbound_sessions SET revoked_at = ? WHERE worker_device_id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), workerDeviceId).changes > 0;
}

export function consumeRassilonRequestNonce({ sessionId, nonce, expiresAt }) {
  if (!database) return false;
  const transaction = database.transaction(() => {
    database.prepare('DELETE FROM rassilon_request_nonces WHERE expires_at <= ?').run(new Date().toISOString());
    try {
      database.prepare('INSERT INTO rassilon_request_nonces (session_id, nonce, expires_at) VALUES (?, ?, ?)')
        .run(sessionId, nonce, expiresAt);
      return true;
    } catch { return false; }
  });
  return transaction();
}

export function upsertRassilonRemoteJob({ jobId, workerDeviceId, controllerDeviceId, status, resultEnvelope = null, errorReason = null }) {
  if (!database) return null;
  database.prepare(`INSERT INTO rassilon_remote_jobs (
    job_id, worker_device_id, controller_device_id, status, result_envelope, error_reason
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP,
    result_envelope = excluded.result_envelope, error_reason = excluded.error_reason`)
    .run(jobId, workerDeviceId, controllerDeviceId, status, resultEnvelope ? JSON.stringify(resultEnvelope) : null, errorReason);
  return getRassilonRemoteJob(jobId);
}

export function getRassilonRemoteJob(jobId) {
  if (!database) return null;
  const row = database.prepare('SELECT * FROM rassilon_remote_jobs WHERE job_id = ?').get(jobId);
  if (!row) return null;
  return {
    jobId: row.job_id, workerDeviceId: row.worker_device_id, controllerDeviceId: row.controller_device_id,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    resultEnvelope: (() => { try { return JSON.parse(row.result_envelope); } catch { return null; } })(),
    errorReason: row.error_reason,
  };
}
