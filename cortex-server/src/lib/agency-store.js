// Agency V1 — SQLite persistence (tables created additively in sqlite.js).
// Plain synchronous reads/writes; the orchestration logic lives in agency.js.
import { getDatabase } from './sqlite.js';

const json = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

function db() {
  const database = getDatabase();
  if (!database) throw Object.assign(new Error('agency_store_unavailable'), { code: 'agency_store_unavailable' });
  return database;
}

function runRow(r) {
  return r ? {
    id: r.id, objective: r.objective, status: r.status, strictLocal: r.strict_local === 1, maxConcurrency: r.max_concurrency,
    saveResult: r.save_result === 1, plan: json(r.plan, {}), synthesis: r.synthesis ?? null, error: r.error ?? null,
    stopReason: r.stop_reason ?? null, createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at ?? null,
  } : null;
}

function taskRow(t) {
  return {
    id: t.id, runId: t.run_id, key: t.task_key, ord: t.ord, title: t.title, instructions: t.instructions, agent: t.agent,
    tools: json(t.tools, []), dependsOn: json(t.depends_on, []), status: t.status, attempt: t.attempt, maxAttempts: t.max_attempts,
    result: t.result ?? null, error: t.error ?? null, startedAt: t.started_at ?? null, finishedAt: t.finished_at ?? null,
  };
}

function artifactRow(a) {
  return { id: a.id, runId: a.run_id, taskId: a.task_id ?? null, kind: a.kind, title: a.title, content: a.content, sha256: a.sha256, outputId: a.output_id ?? null, createdAt: a.created_at };
}

function approvalRow(a) {
  return a ? {
    id: a.id, runId: a.run_id, taskId: a.task_id, action: a.action, digest: a.digest, summary: json(a.summary, {}), status: a.status,
    createdAt: a.created_at, expiresAt: a.expires_at, decidedAt: a.decided_at ?? null, consumedAt: a.consumed_at ?? null,
  } : null;
}

export function createAgencyStore() {
  return {
    insertRun(run) {
      db().prepare(`INSERT INTO agency_runs (id, objective, status, strict_local, max_concurrency, save_result, plan, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(run.id, run.objective, run.status, run.strictLocal ? 1 : 0, run.maxConcurrency, run.saveResult ? 1 : 0, JSON.stringify(run.plan ?? {}), run.createdAt, run.createdAt);
    },
    updateRun(id, patch) {
      const cols = { status: 'status', plan: 'plan', synthesis: 'synthesis', error: 'error', stopReason: 'stop_reason', finishedAt: 'finished_at' };
      const sets = []; const values = [];
      for (const [key, col] of Object.entries(cols)) {
        if (!(key in patch)) continue;
        sets.push(`${col} = ?`);
        values.push(key === 'plan' ? JSON.stringify(patch.plan ?? {}) : patch[key]);
      }
      sets.push('updated_at = ?');
      values.push(patch.updatedAt ?? new Date().toISOString());
      db().prepare(`UPDATE agency_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    },
    getRun(id) { return runRow(db().prepare('SELECT * FROM agency_runs WHERE id = ?').get(id)); },
    listRuns(limit = 50) { return db().prepare('SELECT * FROM agency_runs ORDER BY created_at DESC LIMIT ?').all(limit).map(runRow); },
    listRunsByStatus(statuses) {
      const marks = statuses.map(() => '?').join(', ');
      return db().prepare(`SELECT * FROM agency_runs WHERE status IN (${marks}) ORDER BY created_at ASC`).all(...statuses).map(runRow);
    },

    insertTasks(tasks) {
      const stmt = db().prepare(`INSERT INTO agency_tasks (id, run_id, task_key, ord, title, instructions, agent, tools, depends_on, status, max_attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      db().transaction(() => {
        for (const t of tasks) stmt.run(t.id, t.runId, t.key, t.ord, t.title, t.instructions, t.agent, JSON.stringify(t.tools), JSON.stringify(t.dependsOn), t.status, t.maxAttempts);
      })();
    },
    updateTask(id, patch) {
      const cols = { status: 'status', attempt: 'attempt', result: 'result', error: 'error', startedAt: 'started_at', finishedAt: 'finished_at' };
      const sets = []; const values = [];
      for (const [key, col] of Object.entries(cols)) {
        if (!(key in patch)) continue;
        sets.push(`${col} = ?`);
        values.push(patch[key]);
      }
      if (sets.length) db().prepare(`UPDATE agency_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    },
    listTasks(runId) { return db().prepare('SELECT * FROM agency_tasks WHERE run_id = ? ORDER BY ord ASC').all(runId).map(taskRow); },
    getTask(id) { const t = db().prepare('SELECT * FROM agency_tasks WHERE id = ?').get(id); return t ? taskRow(t) : null; },

    insertArtifact(a) {
      db().prepare(`INSERT INTO agency_artifacts (id, run_id, task_id, kind, title, content, sha256, output_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.runId, a.taskId ?? null, a.kind, a.title, a.content, a.sha256, a.outputId ?? null, a.createdAt);
    },
    listArtifacts(runId) { return db().prepare('SELECT * FROM agency_artifacts WHERE run_id = ? ORDER BY created_at ASC').all(runId).map(artifactRow); },

    insertApproval(a) {
      db().prepare(`INSERT INTO agency_approvals (id, run_id, task_id, action, digest, summary, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.runId, a.taskId, a.action, a.digest, JSON.stringify(a.summary ?? {}), a.status, a.createdAt, a.expiresAt);
    },
    /** Compare-and-set on status: returns true only for the caller that made the transition. */
    transitionApproval(id, fromStatus, toStatus, at) {
      const col = toStatus === 'CONSUMED' ? 'consumed_at' : 'decided_at';
      return db().prepare(`UPDATE agency_approvals SET status = ?, ${col} = ? WHERE id = ? AND status = ?`).run(toStatus, at, id, fromStatus).changes === 1;
    },
    getApproval(id) { return approvalRow(db().prepare('SELECT * FROM agency_approvals WHERE id = ?').get(id)); },
    listApprovals(runId) { return db().prepare('SELECT * FROM agency_approvals WHERE run_id = ? ORDER BY created_at ASC').all(runId).map(approvalRow); },

    addEvent(runId, taskId, type, detail = {}) {
      db().prepare('INSERT INTO agency_events (run_id, task_id, type, detail, at) VALUES (?, ?, ?, ?, ?)')
        .run(runId, taskId ?? null, type, JSON.stringify(detail), new Date().toISOString());
    },
    listEvents(runId, limit = 200) {
      return db().prepare('SELECT * FROM agency_events WHERE run_id = ? ORDER BY id DESC LIMIT ?').all(runId, limit)
        .map(e => ({ id: e.id, taskId: e.task_id ?? null, type: e.type, detail: json(e.detail, {}), at: e.at })).reverse();
    },
  };
}
