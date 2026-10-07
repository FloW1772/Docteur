// Media Studio V1 — SQLite persistence (tables created additively in sqlite.js).
import { getDatabase } from './sqlite.js';

function db() {
  const database = getDatabase();
  if (!database) throw Object.assign(new Error('media_studio_store_unavailable'), { code: 'media_studio_store_unavailable' });
  return database;
}
const jobRow = (r) => (r ? {
  id: r.id, projectId: r.project_id, status: r.status, progress: r.progress, durationMs: r.duration_ms ?? null,
  outputFile: r.output_file ?? null, outputSize: r.output_size ?? null, error: r.error ?? null,
  createdAt: r.created_at, startedAt: r.started_at ?? null, finishedAt: r.finished_at ?? null,
} : null);

export function createMediaStudioStore() {
  return {
    saveProject(p) {
      db().prepare(`INSERT INTO media_projects (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`)
        .run(p.id, p.name, JSON.stringify(p), p.createdAt, p.updatedAt);
    },
    getProject(id) {
      const r = db().prepare('SELECT data FROM media_projects WHERE id = ?').get(id);
      if (!r) return null;
      try { return JSON.parse(r.data); } catch { return null; }
    },
    listProjects() {
      return db().prepare('SELECT id, name, data, created_at, updated_at FROM media_projects ORDER BY updated_at DESC LIMIT 100').all().map(r => {
        let p = {};
        try { p = JSON.parse(r.data); } catch { /* listed with what is known */ }
        return { id: r.id, name: r.name, assetCount: p.assets?.length ?? 0, clipCount: p.clips?.length ?? 0, createdAt: r.created_at, updatedAt: r.updated_at };
      });
    },
    insertJob(j) {
      db().prepare('INSERT INTO media_export_jobs (id, project_id, status, created_at) VALUES (?, ?, ?, ?)').run(j.id, j.projectId, j.status, j.createdAt);
    },
    updateJob(id, patch) {
      const cols = { status: 'status', progress: 'progress', durationMs: 'duration_ms', outputFile: 'output_file', outputSize: 'output_size', error: 'error', startedAt: 'started_at', finishedAt: 'finished_at' };
      const sets = []; const values = [];
      for (const [k, c] of Object.entries(cols)) if (k in patch) { sets.push(`${c} = ?`); values.push(patch[k]); }
      if (sets.length) db().prepare(`UPDATE media_export_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    },
    getJob(id) { return jobRow(db().prepare('SELECT * FROM media_export_jobs WHERE id = ?').get(id)); },
    listJobs(projectId) { return db().prepare('SELECT * FROM media_export_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50').all(projectId).map(jobRow); },
    nextQueuedJob() { return jobRow(db().prepare("SELECT * FROM media_export_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1").get()); },
    listJobsByStatus(statuses) {
      return db().prepare(`SELECT * FROM media_export_jobs WHERE status IN (${statuses.map(() => '?').join(', ')})`).all(...statuses).map(jobRow);
    },
  };
}
