import fs from 'node:fs';
import path from 'node:path';
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
  `);

  // Idempotent migrations — ignore if column/index already exists
  for (const col of [
    'ALTER TABLE router_logs ADD COLUMN provider TEXT',
    'ALTER TABLE router_logs ADD COLUMN quota_hit INTEGER DEFAULT 0',
    'ALTER TABLE file_originals ADD COLUMN metadata TEXT NOT NULL DEFAULT "{}"',
    'ALTER TABLE file_originals ADD COLUMN treatments_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE file_results ADD COLUMN metadata TEXT NOT NULL DEFAULT "{}"',
    'ALTER TABLE file_results ADD COLUMN cloud_allowed INTEGER NOT NULL DEFAULT 0',
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
  if (fields.length > 0) {
    vals.push(id);
    database.prepare(`UPDATE agent_runs SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
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

// ── Privacy violations log ────────────────────────────────────────────────────
// Logs blocked cloud calls (no content ever stored here).

export function insertPrivacyViolation({ functionCalled, providerTargeted }) {
  if (!database) return;
  database.prepare(`
    INSERT INTO privacy_violations (occurred_at, function_called, provider_targeted)
    VALUES (CURRENT_TIMESTAMP, ?, ?)
  `).run(functionCalled, providerTargeted);
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
