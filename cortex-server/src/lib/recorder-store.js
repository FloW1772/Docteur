// Native Recorder — RECORDER-1 catalogue + confined file layout.
//
// <root>/recorder.sqlite   metadata only (never a video blob)
// <root>/partial/<id>.partial   bytes being captured (never READY)
// <root>/files/<id>.<ext>       finalized ORIGINAL recordings
// Storage keys are generated here from the recordingId and the sniffed container; they are server-only (never in a
// public view). Every key is resolved by resolveKey(): strict key grammar, lexical containment under the canonical
// (realpath) root, and the realpath of its parent directory must be the expected Recorder directory — a junction /
// symlinked directory is refused, not followed. server.js opens it under the canonical Docteur data directory.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fail, RECORDING_STATUS, RECORDING_TYPES, isRecordingId } from './recorder-contracts.js';

export const RECORDER_SCHEMA_VERSION = 1;
const MIGRATION_1 = `
  CREATE TABLE IF NOT EXISTS recorder_recordings (
    recording_id    TEXT PRIMARY KEY CHECK (recording_id GLOB 'rec_[0-9a-f]*' AND length(recording_id) = 36),
    type            TEXT NOT NULL CHECK (type IN (${RECORDING_TYPES.map(t => `'${t}'`).join(',')})),
    status          TEXT NOT NULL CHECK (status IN (${Object.keys(RECORDING_STATUS).map(t => `'${t}'`).join(',')})),
    title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    declared_mime   TEXT NOT NULL CHECK (length(declared_mime) <= 120),
    mime_type       TEXT CHECK (mime_type IS NULL OR length(mime_type) <= 120),
    ext             TEXT CHECK (ext IS NULL OR ext IN ('webm','mp4')),
    created_at      TEXT NOT NULL,
    started_at      TEXT,
    stopped_at      TEXT,
    updated_at      TEXT NOT NULL,
    duration_ms     INTEGER,
    size_bytes      INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    chunk_count     INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    width           INTEGER,
    height          INTEGER,
    has_audio       INTEGER NOT NULL CHECK (has_audio IN (0,1)),
    metadata_source TEXT NOT NULL DEFAULT 'CLIENT_REPORTED' CHECK (metadata_source IN ('CLIENT_REPORTED')),
    storage_key     TEXT CHECK (storage_key IS NULL OR storage_key GLOB 'files/rec_*'),
    partial_key     TEXT CHECK (partial_key IS NULL OR partial_key GLOB 'partial/rec_*'),
    checksum_sha256 TEXT CHECK (checksum_sha256 IS NULL OR length(checksum_sha256) = 64),
    error_code      TEXT CHECK (error_code IS NULL OR length(error_code) <= 64),
    recoverable     INTEGER NOT NULL DEFAULT 0 CHECK (recoverable IN (0,1)),
    CHECK (status <> 'READY' OR (storage_key IS NOT NULL AND checksum_sha256 IS NOT NULL AND size_bytes > 0 AND mime_type IS NOT NULL AND ext IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS recorder_recordings_order ON recorder_recordings(created_at DESC, recording_id DESC);
  CREATE INDEX IF NOT EXISTS recorder_recordings_status ON recorder_recordings(status);
  CREATE TABLE IF NOT EXISTS recorder_audit (
    seq          INTEGER PRIMARY KEY,
    at           TEXT NOT NULL,
    event        TEXT NOT NULL CHECK (event IN ('RECORDING_CREATED','RECORDING_STARTED','RECORDING_FINALIZED','RECORDING_FAILED','RECORDING_CANCELLED',
                   'RECORDING_DELETED','RECORDING_DELETE_INCOMPLETE','RECORDING_MARKED_MISSING','RECORDING_RECOVERY_FLAGGED','RECORDING_RECOVERED')),
    recording_id TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (length(details_json) <= 1024)
  );
  CREATE TRIGGER IF NOT EXISTS recorder_audit_no_update BEFORE UPDATE ON recorder_audit BEGIN SELECT RAISE(ABORT, 'REC_IMMUTABLE: the recorder audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS recorder_audit_no_delete BEFORE DELETE ON recorder_audit BEGIN SELECT RAISE(ABORT, 'REC_IMMUTABLE: the recorder audit is append-only'); END;
`;

const KEY_RE = /^(files|partial)\/(rec_[0-9a-f]{32})\.(webm|mp4|partial)$/;
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const real = (p) => fs.realpathSync.native(p);

export class RecorderStore {
  /** @param {{ root: string, now?: () => number }} opts root: absolute Recorder directory (tests: a temp dir) */
  static open({ root, now = Date.now } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('INVALID_ROOT', 'Recorder root must be an absolute path.', 500);
    fs.mkdirSync(root, { recursive: true });
    const realRoot = real(root);
    for (const d of ['files', 'partial']) {
      const p = path.join(realRoot, d);
      fs.mkdirSync(p, { recursive: true });
      if (fs.lstatSync(p).isSymbolicLink() || !samePath(real(p), p)) fail('ROOT_ESCAPE', 'A Recorder directory resolves outside the Recorder root.', 500);
    }
    const db = new Database(path.join(realRoot, 'recorder.sqlite'));
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('recursive_triggers = ON');
      db.exec('CREATE TABLE IF NOT EXISTS recorder_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      const v = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM recorder_schema_migrations').get().v;
      if (v < 1) db.transaction(() => { db.exec(MIGRATION_1); db.prepare('INSERT INTO recorder_schema_migrations (version, applied_at) VALUES (1, ?)').run(new Date(now()).toISOString()); })();
    } catch (e) { db.close(); throw e; }
    return new RecorderStore(db, realRoot, now);
  }

  #now;
  constructor(db, realRoot, now) { this.db = db; this.root = realRoot; this.#now = now; Object.freeze(this); }
  close() { if (this.db.open) this.db.close(); }
  at() { return new Date(this.#now()).toISOString(); }
  nowMs() { return this.#now(); }
  schemaVersion() { return this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM recorder_schema_migrations').get().v; }

  // ── keys and confinement ──
  static keyFor(kind, recordingId, ext) {
    if (!isRecordingId(recordingId)) fail('INVALID_RECORDING_ID', 'Identifiant d’enregistrement invalide.');
    if (kind === 'partial') return `partial/${recordingId}.partial`;
    if (kind === 'files' && (ext === 'webm' || ext === 'mp4')) return `files/${recordingId}.${ext}`;
    return fail('INVALID_KEY', 'Clé de stockage invalide.', 500);
  }
  /** Server key → absolute path inside the Recorder root, or ROOT_ESCAPE. Never accepts a client string as a key. */
  resolveKey(key) {
    const m = typeof key === 'string' ? KEY_RE.exec(key) : null;
    if (!m) fail('INVALID_KEY', 'Clé de stockage invalide.', 500);
    const dir = path.join(this.root, m[1]);
    const abs = path.join(dir, `${m[2]}.${m[3]}`);
    const rel = path.relative(this.root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('ROOT_ESCAPE', 'Chemin hors de la racine Recorder.', 500);
    let dirReal;
    try { dirReal = real(dir); } catch { fail('ROOT_ESCAPE', 'Dossier Recorder introuvable.', 500); }
    if (!samePath(dirReal, dir) || fs.lstatSync(dir).isSymbolicLink()) fail('ROOT_ESCAPE', 'Le dossier Recorder a été redirigé (lien / jonction) : refusé.', 500);
    return abs;
  }

  // ── rows ──
  insert(r) {
    this.db.prepare(`INSERT INTO recorder_recordings (recording_id, type, status, title, declared_mime, created_at, updated_at, has_audio, partial_key)
      VALUES (@recordingId, @type, 'PREPARING', @title, @declaredMime, @at, @at, @hasAudio, @partialKey)`).run({ ...r, hasAudio: r.hasAudio ? 1 : 0 });
  }
  row(recordingId) { return isRecordingId(recordingId) ? this.db.prepare('SELECT * FROM recorder_recordings WHERE recording_id = ?').get(recordingId) ?? null : null; }
  /** Moves status only from one of `from`; returns false if another writer moved it first. */
  transition(recordingId, from, to, cols = {}) {
    const sets = Object.keys(cols).map(k => `${k} = @${k}`);
    const r = this.db.prepare(`UPDATE recorder_recordings SET status = @to, updated_at = @at${sets.length ? `, ${sets.join(', ')}` : ''}
      WHERE recording_id = @id AND status IN (${from.map((_, i) => `@f${i}`).join(', ')})`)
      .run({ ...cols, to, at: this.at(), id: recordingId, ...Object.fromEntries(from.map((f, i) => [`f${i}`, f])) });
    return r.changes === 1;
  }
  update(recordingId, cols) {
    const sets = Object.keys(cols).map(k => `${k} = @${k}`);
    this.db.prepare(`UPDATE recorder_recordings SET ${sets.join(', ')}, updated_at = @at WHERE recording_id = @id`).run({ ...cols, at: this.at(), id: recordingId });
  }
  remove(recordingId) { return this.db.prepare('DELETE FROM recorder_recordings WHERE recording_id = ?').run(recordingId).changes; }
  list({ limit, offset = 0, status = null }) {
    const where = status ? 'WHERE status = @status' : '';
    const rows = this.db.prepare(`SELECT * FROM recorder_recordings ${where} ORDER BY created_at DESC, recording_id DESC LIMIT @limit OFFSET @offset`).all({ status, limit, offset });
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM recorder_recordings ${where}`).get({ status }).n;
    return { rows, total };
  }
  byStatus(statuses) { return this.db.prepare(`SELECT * FROM recorder_recordings WHERE status IN (${statuses.map(() => '?').join(',')})`).all(...statuses); }
  countActive(statuses) { return this.db.prepare(`SELECT COUNT(*) AS n FROM recorder_recordings WHERE status IN (${statuses.map(() => '?').join(',')})`).get(...statuses).n; }

  // ── audit (append-only; ids, codes, sizes — never content or a path) ──
  audit(event, recordingId, details = {}) {
    const json = JSON.stringify(details);
    if (json.length > 1024 || /[A-Za-z]:\\|\\\\|\/(Users|home|tmp)\//.test(json)) fail('INTERNAL', 'recorder audit details must stay small and path-free', 500);
    this.db.prepare('INSERT INTO recorder_audit (at, event, recording_id, details_json) VALUES (?, ?, ?, ?)').run(this.at(), event, recordingId, json);
  }
  listAudit(recordingId = null) {
    return this.db.prepare('SELECT * FROM recorder_audit ORDER BY seq').all().filter(r => recordingId === null || r.recording_id === recordingId)
      .map(r => ({ seq: r.seq, at: r.at, event: r.event, recordingId: r.recording_id, details: JSON.parse(r.details_json) }));
  }
}
