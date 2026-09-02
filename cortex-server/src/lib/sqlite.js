import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

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

export function getRouterSettings() {
  return getMeta('router_settings', {
    router_enabled:      true,
    fallback_model:      'llama3.2:3b',
    cloud_enabled:       true,
    paying_apis_enabled: false,
    gemini_rpm:          10,
    cloud_preference:    'local',   // 'local' | 'balanced' | 'quality'
    strict_local_mode:   false,     // when true: NO cloud call ever, regardless of router config
    groq_model:          'openai/gpt-oss-120b',
    // "Mode puissant" model — quantized q3_K_M by default (~7.3 Go) so it
    // actually fits an 8 Go card; the unquantized qwen2.5:14b (~9 Go) stays
    // selectable in Settings but overflows VRAM and reloads cold each time.
    powerful_model:      'qwen2.5:14b-instruct-q3_K_M',
    // "Mode conversation" model — quantized for the same 8 Go VRAM budget as
    // powerful_model above.
    chat_model:          'mistral-nemo:12b-instruct-2407-q4_K_M',
  });
}

export function setRouterSettings(updates) {
  const current = getRouterSettings();
  setMeta('router_settings', { ...current, ...updates });
}

// ── Cloud API keys — stored in metadata, never logged in clear ────────────────

const CLOUD_KEYS_META = 'cloud_api_keys';

export function getCloudKeys() {
  return getMeta(CLOUD_KEYS_META, {
    gemini_key:     null,
    groq_key:       null,
    openrouter_key: null,
    anthropic_key:  null,
    openai_key:     null,
  });
}

export function setCloudKey(provider, key) {
  const current = getCloudKeys();
  setMeta(CLOUD_KEYS_META, { ...current, [`${provider}_key`]: key || null });
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
    gemini_active:     !!keys.gemini_key,
    groq_active:       !!keys.groq_key,
    openrouter_active: !!keys.openrouter_key,
    anthropic_active:  !!keys.anthropic_key,
    openai_active:     !!keys.openai_key,
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
  return database.prepare('SELECT * FROM preference_facts ORDER BY created_at ASC').all();
}

export function countPreferenceFacts() {
  if (!database) return 0;
  return database.prepare('SELECT COUNT(*) AS n FROM preference_facts').get().n;
}

export function addPreferenceFact(fact) {
  if (!database) return null;
  if (countPreferenceFacts() >= MAX_PREFERENCE_FACTS) {
    throw new Error(`Limite de ${MAX_PREFERENCE_FACTS} faits retenus atteinte — supprimez-en un avant d'en ajouter un nouveau.`);
  }
  const id = crypto.randomUUID();
  database.prepare('INSERT INTO preference_facts (id, fact, created_at) VALUES (?, ?, ?)')
    .run(id, fact, new Date().toISOString());
  return id;
}

export function updatePreferenceFact(id, fact) {
  if (!database) return;
  database.prepare('UPDATE preference_facts SET fact = ? WHERE id = ?').run(fact, id);
}

export function deletePreferenceFact(id) {
  if (!database) return;
  database.prepare('DELETE FROM preference_facts WHERE id = ?').run(id);
}

export function clearPreferenceFacts() {
  if (!database) return;
  database.prepare('DELETE FROM preference_facts').run();
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
