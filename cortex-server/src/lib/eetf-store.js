// EETF V1 — metadata store + job state machine (EETF-2).
//
// Owns its own SQLite connection (never the user database in EETF-2: the path
// is refused when it lies in the user data directory) and an EetfAssetStore for
// the bytes. Metadata only in the DB; files on disk, content-addressed.
//
// Jobs: QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED (QUEUED → CANCELLED
// too). Every transition is an UPDATE guarded by the expected current status,
// so a concurrent or stale caller is refused instead of overwriting a state.
// Retry never touches the old job: it creates a new one with `retryOf`.
// Cancellation of a RUNNING job returns `interruptRequired: true` — stopping
// the engine is the executor's duty (EETF-3/4); this module starts nothing.
//
// There is deliberately no reset / delete-all / truncate / drop API.

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  EetfError, JOB_STATUS, JOB_KIND, JOB_ERROR, TERMINAL_JOB_STATUSES, ASSET_ROLE, VARIANT_OPERATION, TEXTURE_ROLES, TEXTURE_ROLE,
  MAP_STATUS, MAP_STATUS_ALLOWED_V1, NORMAL_CONVENTION, SEAM_CHECK, SEAM_STATUS, ALPHA_CLASS, PROJECTION, assertEnvironmentType, assertJobTransition,
  validateJobParams, validateJobError, validateProgress, validateProviderAndModel, validateProvenance, materialBadge,
  assertUuid, assertSha256, assertNoSecrets, canonicalJson, sha256Hex, safeDisplayName, limit, newId, nowIso, freezeDeep,
  LINK_DIRECTION, LINK_VERIFICATION, BROWSER_NATIVE_FORMATS, validateLinkRef,
} from './eetf-contracts.js';
import { EetfAssetStore, isInUserData } from './eetf-asset-store.js';
import { runEetfMigrations, eetfSchemaVersion } from './eetf-schema.js';

const fail = (code, message, details) => { throw new EetfError(code, message, details); };

export class EetfStore {
  /**
   * @param {{ dbPath: string, assetRoot: string }} opts both outside the user data directory in EETF-2
   */
  static open({ dbPath, assetRoot }) {
    if (typeof dbPath !== 'string' || !dbPath) fail('EETF_INVALID_DB_PATH', 'dbPath required');
    if (dbPath !== ':memory:') {
      if (!path.isAbsolute(dbPath)) fail('EETF_INVALID_DB_PATH', 'dbPath must be absolute');
      if (isInUserData(dbPath)) fail('EETF_DB_IN_USER_DATA', 'EETF-2 never opens a database in the user data directory');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const files = new EetfAssetStore({ root: assetRoot });
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      runEetfMigrations(db);
    } catch (e) { db.close(); throw e; }
    return new EetfStore(db, files);
  }

  constructor(db, files) {
    this.db = db;
    this.files = files;
    Object.freeze(this);
  }

  close() { if (this.db.open) this.db.close(); }
  schemaVersion() { return eetfSchemaVersion(this.db); }

  // ── jobs ──────────────────────────────────────────────────────────────────

  #insertJob({ kind, params, provider, model, batchId = null, batchIndex = null, retryOf = null, attempt = 1 }) {
    const v = validateJobParams(kind, params);
    const pm = validateProviderAndModel({ provider, model });
    const id = newId(); const at = nowIso();
    this.db.prepare(`INSERT INTO eetf_jobs (job_id, kind, status, batch_id, batch_index, provider, model, params_json, params_hash, retry_of, attempt, created_at, updated_at)
      VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, kind, batchId, batchIndex, pm.provider, pm.model, v.paramsJson, v.paramsHash, retryOf, attempt, at, at);
    return id;
  }

  /** Creates a QUEUED job. Nothing runs: execution belongs to a later checkpoint. */
  createJob({ kind, params, provider = null, model = null }) {
    return this.getJob(this.#insertJob({ kind, params, provider, model }));
  }

  getJob(jobId) {
    assertUuid(jobId, 'job id');
    const r = this.db.prepare('SELECT * FROM eetf_jobs WHERE job_id = ?').get(jobId);
    if (!r) fail('EETF_JOB_NOT_FOUND', 'job not found');
    const outputs = this.db.prepare('SELECT asset_id FROM eetf_job_outputs WHERE job_id = ? ORDER BY ordinal').all(jobId).map(o => o.asset_id);
    return freezeDeep({
      id: r.job_id, kind: r.kind, status: r.status, batchId: r.batch_id, batchIndex: r.batch_index,
      provider: r.provider, model: r.model, params: JSON.parse(r.params_json), paramsHash: r.params_hash,
      progress: r.progress, error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
      retryOf: r.retry_of, attempt: r.attempt,
      createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at, failedAt: r.failed_at, cancelledAt: r.cancelled_at,
      updatedAt: r.updated_at, outputAssetIds: outputs,
    });
  }

  listJobs({ status = null, limit: max = 50 } = {}) {
    if (status !== null && !JOB_STATUS[status]) fail('EETF_UNKNOWN_JOB_STATUS', 'unknown status filter');
    const n = Math.min(Math.max(Number.isSafeInteger(max) ? max : 50, 1), 200);
    const rows = status
      ? this.db.prepare('SELECT job_id FROM eetf_jobs WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(status, n)
      : this.db.prepare('SELECT job_id FROM eetf_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(n);
    return rows.map(r => this.getJob(r.job_id));
  }

  /** Guarded transition: refuses when the job is not in `from` any more. */
  #transition(jobId, to, extra = {}) {
    const job = this.getJob(jobId);
    assertJobTransition(job.status, to);
    const cols = Object.keys(extra);
    const at = nowIso();
    const info = this.db.prepare(`UPDATE eetf_jobs SET status = ?, updated_at = ?${cols.map(c => `, ${c} = ?`).join('')}
      WHERE job_id = ? AND status = ?`).run(to, at, ...cols.map(c => (extra[c] === '@now' ? at : extra[c])), jobId, job.status);
    if (info.changes !== 1) fail('EETF_INVALID_TRANSITION', `job changed state concurrently (expected ${job.status})`, { from: job.status, to });
    return job;
  }

  startJob(jobId) {
    this.#transition(jobId, JOB_STATUS.RUNNING, { started_at: '@now', progress: 0 });
    return this.getJob(jobId);
  }

  updateProgress(jobId, progress) {
    const p = validateProgress(progress);
    const info = this.db.prepare("UPDATE eetf_jobs SET progress = ?, updated_at = ? WHERE job_id = ? AND status = 'RUNNING' AND progress <= ?")
      .run(p, nowIso(), assertUuid(jobId, 'job id'), p);
    if (info.changes !== 1) {
      const job = this.getJob(jobId);
      if (job.status !== 'RUNNING') fail('EETF_INVALID_TRANSITION', 'progress is only reported while RUNNING');
      fail('EETF_INVALID_PROGRESS', 'progress never goes backwards');
    }
    return this.getJob(jobId);
  }

  completeJob(jobId, { outputAssetIds = [] } = {}) {
    if (!Array.isArray(outputAssetIds) || outputAssetIds.length > 64) fail('EETF_INVALID_OUTPUTS', 'outputAssetIds must be a short array');
    const ids = [...new Set(outputAssetIds.map(id => assertUuid(id, 'output asset id')))];
    this.db.transaction(() => {
      for (const id of ids) this.getAsset(id);
      this.#transition(jobId, JOB_STATUS.COMPLETED, { completed_at: '@now', progress: 1 });
      const ins = this.db.prepare('INSERT INTO eetf_job_outputs (job_id, asset_id, ordinal) VALUES (?, ?, ?)');
      ids.forEach((id, i) => ins.run(jobId, id, i));
    })();
    return this.getJob(jobId);
  }

  failJob(jobId, error) {
    const e = validateJobError(error);
    this.#transition(jobId, JOB_STATUS.FAILED, { failed_at: '@now', error_code: e.code, error_message: e.message });
    return this.getJob(jobId);
  }

  /**
   * Cancellation contract. QUEUED → CANCELLED; RUNNING → CANCELLED with
   * `interruptRequired: true` (the executor must stop the engine / process).
   * COMPLETED, FAILED, CANCELLED → refused (EETF_JOB_NOT_CANCELLABLE).
   */
  cancelJob(jobId) {
    const job = this.getJob(jobId);
    if (TERMINAL_JOB_STATUSES.has(job.status)) fail('EETF_JOB_NOT_CANCELLABLE', `a ${job.status} job cannot be cancelled`, { status: job.status });
    this.#transition(jobId, JOB_STATUS.CANCELLED, { cancelled_at: '@now', error_code: JOB_ERROR.CANCELLED_BY_USER, error_message: null });
    return Object.freeze({ job: this.getJob(jobId), interruptRequired: job.status === JOB_STATUS.RUNNING });
  }

  /** Retry = a NEW job (same kind / params / provider / model) pointing at the old one. */
  retryJob(jobId) {
    const old = this.getJob(jobId);
    if (old.status !== JOB_STATUS.FAILED && old.status !== JOB_STATUS.CANCELLED) fail('EETF_JOB_NOT_RETRYABLE', `a ${old.status} job cannot be retried`);
    if (old.attempt >= limit('maxRetries') + 1) fail('EETF_RETRY_LIMIT', `at most ${limit('maxRetries')} retries`);
    const id = this.#insertJob({ kind: old.kind, params: old.params, provider: old.provider, model: old.model, retryOf: old.id, attempt: old.attempt + 1 });
    return this.getJob(id);
  }

  /**
   * Boot recovery: a RUNNING job cannot have survived the process → FAILED
   * (PROCESS_RESTARTED). QUEUED jobs stay QUEUED (no automatic resume in V1).
   * In-flight temporary files are purged.
   */
  recoverAfterRestart() {
    const at = nowIso();
    const interrupted = this.db.prepare(`UPDATE eetf_jobs SET status = 'FAILED', failed_at = ?, updated_at = ?, error_code = ?, error_message = ?
      WHERE status = 'RUNNING'`).run(at, at, JOB_ERROR.PROCESS_RESTARTED, 'the process stopped while this job was running; it was not resumed').changes;
    const queued = this.db.prepare("SELECT COUNT(*) AS n FROM eetf_jobs WHERE status = 'QUEUED'").get().n;
    const tmpPurged = this.files.purgeTmp();
    return Object.freeze({ interrupted, queuedLeft: queued, tmpPurged, resumed: 0 });
  }

  // ── batches ───────────────────────────────────────────────────────────────

  /** All items are validated before anything is written; then N QUEUED jobs. */
  createBatch({ kind, items, label = null }) {
    if (!JOB_KIND[kind]) fail('EETF_INVALID_JOB_KIND', 'unknown batch kind');
    if (!Array.isArray(items) || items.length === 0) fail('EETF_INVALID_BATCH', 'a batch needs items');
    if (items.length > limit('maxBatch')) fail('EETF_BATCH_TOO_LARGE', `at most ${limit('maxBatch')} items per batch`);
    items.forEach((it) => { validateJobParams(kind, it?.params); validateProviderAndModel(it ?? {}); });
    const name = label === null ? null : safeDisplayName(label, 'batch');
    if (name) assertNoSecrets(name, 'label');
    const batchId = newId();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO eetf_batches (batch_id, kind, total, label, created_at) VALUES (?, ?, ?, ?, ?)').run(batchId, kind, items.length, name, nowIso());
      items.forEach((it, i) => this.#insertJob({ kind, params: it.params, provider: it.provider ?? null, model: it.model ?? null, batchId, batchIndex: i }));
    })();
    return this.getBatch(batchId);
  }

  /** Per item, the LATEST attempt counts (a retried item is followed through its retry chain). */
  getBatch(batchId) {
    assertUuid(batchId, 'batch id');
    const b = this.db.prepare('SELECT * FROM eetf_batches WHERE batch_id = ?').get(batchId);
    if (!b) fail('EETF_BATCH_NOT_FOUND', 'batch not found');
    const roots = this.db.prepare('SELECT job_id FROM eetf_jobs WHERE batch_id = ? ORDER BY batch_index').all(batchId);
    const latest = (id) => {
      let cur = id;
      for (let hops = 0; hops <= limit('maxRetries') + 1; hops++) {
        const next = this.db.prepare('SELECT job_id FROM eetf_jobs WHERE retry_of = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(cur);
        if (!next) break;
        cur = next.job_id;
      }
      return this.getJob(cur);
    };
    const items = roots.map((r, index) => { const job = latest(r.job_id); return { index, rootJobId: r.job_id, jobId: job.id, status: job.status, attempt: job.attempt }; });
    const count = (s) => items.filter(i => i.status === s).length;
    const counts = { total: b.total, queued: count('QUEUED'), running: count('RUNNING'), completed: count('COMPLETED'), failed: count('FAILED'), cancelled: count('CANCELLED') };
    const outcome = counts.queued + counts.running > 0 ? 'IN_PROGRESS'
      : counts.completed === counts.total ? 'ALL_COMPLETED'
        : counts.completed > 0 ? 'PARTIAL' : 'NONE_COMPLETED';
    return freezeDeep({ id: b.batch_id, kind: b.kind, label: b.label, createdAt: b.created_at, items, ...counts, outcome });
  }

  // ── provenance ────────────────────────────────────────────────────────────

  createProvenance(input) {
    const p = validateProvenance(input);
    const id = newId();
    this.db.transaction(() => {
      for (const s of p.sources) this.getAsset(s.assetId);
      this.db.prepare(`INSERT INTO eetf_provenance (provenance_id, provider, model, prompt, negative_prompt, seed, width, height, parameters_json, engine_version, strict_local, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, p.provider, p.model, p.prompt, p.negativePrompt, p.seed, p.width, p.height, p.parametersJson, p.engineVersion,
          p.strictLocal === null ? null : Number(p.strictLocal), nowIso());
      const ins = this.db.prepare('INSERT INTO eetf_provenance_sources (provenance_id, source_asset_id, relation) VALUES (?, ?, ?)');
      for (const s of p.sources) ins.run(id, s.assetId, s.relation);
    })();
    return this.getProvenance(id);
  }

  getProvenance(provenanceId) {
    assertUuid(provenanceId, 'provenance id');
    const r = this.db.prepare('SELECT * FROM eetf_provenance WHERE provenance_id = ?').get(provenanceId);
    if (!r) fail('EETF_PROVENANCE_NOT_FOUND', 'provenance not found');
    const sources = this.db.prepare('SELECT source_asset_id AS assetId, relation FROM eetf_provenance_sources WHERE provenance_id = ? ORDER BY rowid').all(provenanceId);
    return freezeDeep({
      id: r.provenance_id, provider: r.provider, model: r.model, prompt: r.prompt, negativePrompt: r.negative_prompt,
      seed: r.seed, width: r.width, height: r.height, parameters: JSON.parse(r.parameters_json), engineVersion: r.engine_version,
      strictLocal: r.strict_local === null ? null : r.strict_local === 1, sources: sources.map(s => ({ ...s })),
      derivedFrom: sources.filter(s => s.relation === 'DERIVED_FROM').map(s => s.assetId), createdAt: r.created_at,
    });
  }

  // ── assets ────────────────────────────────────────────────────────────────

  /**
   * Stores bytes (content-addressed, immutable) and records the asset.
   * Same sha256 → the existing asset is returned (`existed: true`), unchanged.
   */
  registerAsset({ buffer, declaredMime, contentDynamicRange = undefined, role, displayName = null, sourceJobId = null, provenanceId = null }) {
    if (!ASSET_ROLE[role]) fail('EETF_INVALID_ROLE', 'role must be SOURCE, GENERATED or DERIVED');
    if ((role === 'GENERATED' || role === 'DERIVED') && !provenanceId) fail('EETF_PROVENANCE_REQUIRED', `a ${role} asset needs a provenance record`);
    if (role === 'DERIVED' && this.getProvenance(provenanceId).derivedFrom.length === 0) fail('EETF_PROVENANCE_REQUIRED', 'a DERIVED asset needs a DERIVED_FROM source');
    if (provenanceId) this.getProvenance(provenanceId);
    if (sourceJobId) {
      const job = this.getJob(sourceJobId);
      if (job.status !== 'RUNNING') fail('EETF_INVALID_TRANSITION', 'assets are produced by a RUNNING job');
    }
    const name = displayName === null ? null : safeDisplayName(displayName);
    if (name) assertNoSecrets(name, 'displayName');
    const stored = this.files.ingest(buffer, { declaredMime, contentDynamicRange });
    const existing = this.db.prepare('SELECT asset_id FROM eetf_assets WHERE sha256 = ?').get(stored.sha256);
    if (existing) return Object.freeze({ asset: this.getAsset(existing.asset_id), existed: true });
    const id = newId();
    this.db.prepare(`INSERT INTO eetf_assets (asset_id, sha256, mime, actual_format, declared_format, dynamic_range, width, height, has_alpha, size_bytes, storage_path, role, display_name, source_job_id, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, stored.sha256, stored.mime, stored.actualFormat, stored.declaredFormat, stored.dynamicRange, stored.width, stored.height,
        Number(stored.hasAlpha), stored.sizeBytes, stored.storagePath, role, name, sourceJobId, provenanceId, nowIso());
    return Object.freeze({ asset: this.getAsset(id), existed: false });
  }

  getAsset(assetId) {
    assertUuid(assetId, 'asset id');
    const r = this.db.prepare('SELECT * FROM eetf_assets WHERE asset_id = ?').get(assetId);
    if (!r) fail('EETF_ASSET_NOT_FOUND', 'asset not found');
    return rowToAsset(r);
  }

  /** EETF-7: newest assets first (UI picker). */
  listAssets({ limit: max = 50 } = {}) {
    const n = Math.min(Math.max(Number.isSafeInteger(max) ? max : 50, 1), 200);
    return this.db.prepare('SELECT * FROM eetf_assets ORDER BY created_at DESC, rowid DESC LIMIT ?').all(n).map(rowToAsset);
  }

  getAssetBySha(sha256) {
    assertSha256(sha256);
    const r = this.db.prepare('SELECT * FROM eetf_assets WHERE sha256 = ?').get(sha256);
    return r ? rowToAsset(r) : null;
  }

  /** True when the stored file still matches the recorded sha256. */
  verifyAsset(assetId) {
    const a = this.getAsset(assetId);
    return this.files.verifyAsset(a.storagePath, a.sha256);
  }

  // ── variants ──────────────────────────────────────────────────────────────

  createVariant({ sourceAssetId, variantAssetId, operation, params = {} }) {
    assertUuid(sourceAssetId, 'source asset id'); assertUuid(variantAssetId, 'variant asset id');
    if (sourceAssetId === variantAssetId) fail('EETF_INVALID_VARIANT', 'an asset is not a variant of itself');
    if (!VARIANT_OPERATION[operation]) fail('EETF_INVALID_VARIANT', 'unknown variant operation');
    if (!params || typeof params !== 'object' || Array.isArray(params)) fail('EETF_INVALID_PARAMS', 'variant params must be an object');
    assertNoSecrets(params, 'params');
    this.getAsset(sourceAssetId); this.getAsset(variantAssetId);
    const json = canonicalJson(params);
    if (Buffer.byteLength(json) > limit('maxParamsBytes')) fail('EETF_PARAMS_TOO_LARGE', 'variant params too large');
    const hash = sha256Hex(json);
    const existing = this.db.prepare('SELECT variant_id FROM eetf_asset_variants WHERE source_asset_id = ? AND variant_asset_id = ? AND operation = ? AND params_hash = ?')
      .get(sourceAssetId, variantAssetId, operation, hash);
    if (existing) return Object.freeze({ variant: this.getVariant(existing.variant_id), existed: true });
    const id = newId();
    this.db.prepare('INSERT INTO eetf_asset_variants (variant_id, source_asset_id, variant_asset_id, operation, params_json, params_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, sourceAssetId, variantAssetId, operation, json, hash, nowIso());
    return Object.freeze({ variant: this.getVariant(id), existed: false });
  }

  getVariant(variantId) {
    assertUuid(variantId, 'variant id');
    const r = this.db.prepare('SELECT * FROM eetf_asset_variants WHERE variant_id = ?').get(variantId);
    if (!r) fail('EETF_VARIANT_NOT_FOUND', 'variant not found');
    return freezeDeep({ id: r.variant_id, sourceAssetId: r.source_asset_id, variantAssetId: r.variant_asset_id, operation: r.operation, params: JSON.parse(r.params_json), paramsHash: r.params_hash, createdAt: r.created_at });
  }

  listVariants(sourceAssetId) {
    assertUuid(sourceAssetId, 'source asset id');
    return this.db.prepare('SELECT variant_id FROM eetf_asset_variants WHERE source_asset_id = ? ORDER BY created_at, rowid').all(sourceAssetId).map(r => this.getVariant(r.variant_id));
  }

  // ── texture sets ──────────────────────────────────────────────────────────

  /**
   * Every one of the 8 roles is recorded; a role not given is UNSUPPORTED with
   * no asset. A status the V1 engines cannot honestly produce is refused.
   */
  createTextureSet({ name, maps = [], normalConvention = null, tileable = null }) {
    const label = safeDisplayName(name, '');
    if (!label) fail('EETF_REQUIRED_FIELD', 'a texture set needs a name');
    assertNoSecrets(label, 'name');
    if (!Array.isArray(maps) || maps.length > TEXTURE_ROLES.length) fail('EETF_INVALID_TEXTURE_SET', 'maps must be an array of at most 8 entries');
    const byRole = new Map();
    for (const m of maps) {
      if (!m || typeof m !== 'object') fail('EETF_INVALID_TEXTURE_SET', 'map must be an object');
      for (const k of Object.keys(m)) if (!['role', 'status', 'assetId', 'constantValue'].includes(k)) fail('EETF_UNKNOWN_FIELD', `unknown map field: ${k.slice(0, 40)}`);
      if (!TEXTURE_ROLE[m.role]) fail('EETF_UNKNOWN_TEXTURE_ROLE', `unknown texture role: ${String(m.role).slice(0, 40)}`);
      if (byRole.has(m.role)) fail('EETF_INVALID_TEXTURE_SET', `duplicate role ${m.role}`);
      if (!MAP_STATUS[m.status]) fail('EETF_UNKNOWN_MAP_STATUS', `unknown map status: ${String(m.status).slice(0, 40)}`);
      if (!MAP_STATUS_ALLOWED_V1[m.role].includes(m.status)) fail('EETF_MAP_STATUS_NOT_SUPPORTED_V1', `${m.role} cannot honestly be ${m.status} in V1`);
      const needsAsset = ['GENERATED', 'DERIVED', 'ESTIMATED', 'FROM_SOURCE_ALPHA'].includes(m.status);
      if (needsAsset) {
        const asset = this.getAsset(assertUuid(m.assetId, 'map asset id'));
        if (m.status === 'FROM_SOURCE_ALPHA' && !asset.hasAlpha) fail('EETF_NO_SOURCE_ALPHA', 'FROM_SOURCE_ALPHA needs an asset with a real alpha channel');
        // EETF-5: the status must match what the asset really is (an imported image is not "GENERATED")
        if (m.status === 'GENERATED' && asset.role !== 'GENERATED') fail('EETF_MAP_ORIGIN_MISMATCH', `a GENERATED map needs a GENERATED asset (this one is ${asset.role})`);
        if (m.status === 'DERIVED' && asset.role !== 'DERIVED') fail('EETF_MAP_ORIGIN_MISMATCH', `a DERIVED map needs a DERIVED asset (this one is ${asset.role})`);
      } else if (m.assetId !== undefined && m.assetId !== null) {
        fail('EETF_UNSUPPORTED_MAP_HAS_ASSET', `${m.status} maps carry no asset`);
      }
      let constantJson = null;
      if (m.status === 'USER_CONSTANT') constantJson = JSON.stringify(validateConstant(m.role, m.constantValue));
      else if (m.constantValue !== undefined && m.constantValue !== null) fail('EETF_INVALID_TEXTURE_SET', 'only USER_CONSTANT maps carry a constant');
      byRole.set(m.role, { role: m.role, status: m.status, assetId: needsAsset ? m.assetId : null, constantJson });
    }
    const all = TEXTURE_ROLES.map(role => byRole.get(role) ?? { role, status: 'UNSUPPORTED', assetId: null, constantJson: null });
    const normal = all.find(m => m.role === 'NORMAL');
    let convention = null;
    if (normal.status !== 'UNSUPPORTED') {
      if (!NORMAL_CONVENTION[normalConvention]) fail('EETF_REQUIRED_FIELD', 'a NORMAL map needs normalConvention OPENGL or DIRECTX');
      convention = normalConvention;
    } else if (normalConvention !== null) fail('EETF_INVALID_TEXTURE_SET', 'normalConvention without a NORMAL map');
    let tileChecked = 0; let tileMetric = null;
    if (tileable !== null) {
      if (typeof tileable?.metric !== 'number' || !Number.isFinite(tileable.metric) || tileable.metric < 0) fail('EETF_INVALID_TEXTURE_SET', 'tileable.metric must be a measured number ≥ 0');
      tileChecked = 1; tileMetric = tileable.metric;
    }
    const badge = materialBadge(all);
    if (badge === 'PBR_COMPLETE') fail('EETF_PBR_NOT_SUPPORTED_V1', 'V1 cannot produce a complete PBR material'); // unreachable with the V1 table; defence in depth
    const id = newId();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO eetf_texture_sets (texture_set_id, name, normal_convention, tileable_checked, tileable_metric, badge, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, label, convention, tileChecked, tileMetric, badge, nowIso());
      const ins = this.db.prepare('INSERT INTO eetf_texture_maps (texture_set_id, role, status, asset_id, constant_json) VALUES (?, ?, ?, ?, ?)');
      for (const m of all) ins.run(id, m.role, m.status, m.assetId, m.constantJson);
    })();
    return this.getTextureSet(id);
  }

  getTextureSet(textureSetId) {
    assertUuid(textureSetId, 'texture set id');
    const s = this.db.prepare('SELECT * FROM eetf_texture_sets WHERE texture_set_id = ?').get(textureSetId);
    if (!s) fail('EETF_TEXTURE_SET_NOT_FOUND', 'texture set not found');
    const rows = this.db.prepare('SELECT * FROM eetf_texture_maps WHERE texture_set_id = ?').all(textureSetId);
    const maps = TEXTURE_ROLES.map((role) => {
      const r = rows.find(x => x.role === role);
      return { role, status: r.status, assetId: r.asset_id, constantValue: r.constant_json === null ? null : JSON.parse(r.constant_json), exists: r.status !== 'UNSUPPORTED' };
    });
    return freezeDeep({
      id: s.texture_set_id, name: s.name, normalConvention: s.normal_convention,
      tileable: s.tileable_checked ? { checked: true, metric: s.tileable_metric } : { checked: false, metric: null },
      badge: s.badge, maps, createdAt: s.created_at,
    });
  }

  // ── seam analyses (EETF-5) ────────────────────────────────────────────────

  /** Records a deterministic analysis; the same asset + method + version returns the existing record. */
  createSeamAnalysis({ assetId, method, version, horizontalScore, verticalScore, seamScore, measures, status, alphaClass, alpha }) {
    this.getAsset(assertUuid(assetId, 'asset id'));
    const existing = this.db.prepare('SELECT analysis_id FROM eetf_seam_analyses WHERE asset_id = ? AND method = ? AND version = ?').get(assetId, method, version);
    if (existing) return Object.freeze({ analysis: this.getSeamAnalysis(existing.analysis_id), existed: true });
    for (const v of [horizontalScore, verticalScore, seamScore]) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail('EETF_INVALID_ANALYSIS', 'scores must be finite numbers ≥ 0');
    if (!SEAM_STATUS[status] || !ALPHA_CLASS[alphaClass]) fail('EETF_INVALID_ANALYSIS', 'unknown seam status or alpha class');
    const id = newId();
    this.db.prepare(`INSERT INTO eetf_seam_analyses (analysis_id, asset_id, method, version, horizontal_score, vertical_score, seam_score, measures_json, status, alpha_class, alpha_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, assetId, method, version, horizontalScore, verticalScore, seamScore, canonicalJson(measures), status, alphaClass, canonicalJson(alpha), nowIso());
    return Object.freeze({ analysis: this.getSeamAnalysis(id), existed: false });
  }

  getSeamAnalysis(analysisId) {
    assertUuid(analysisId, 'analysis id');
    const r = this.db.prepare('SELECT * FROM eetf_seam_analyses WHERE analysis_id = ?').get(analysisId);
    if (!r) fail('EETF_ANALYSIS_NOT_FOUND', 'seam analysis not found');
    return freezeDeep({
      id: r.analysis_id, assetId: r.asset_id, method: r.method, version: r.version, horizontalScore: r.horizontal_score, verticalScore: r.vertical_score,
      seamScore: r.seam_score, measures: JSON.parse(r.measures_json), status: r.status, alphaClass: r.alpha_class, alpha: JSON.parse(r.alpha_json), createdAt: r.created_at,
    });
  }

  // ── materials (EETF-5) ────────────────────────────────────────────────────

  /**
   * One transaction: the texture set, the USER decisions behind every USER_CONSTANT map, and the
   * material row. A USER_CONSTANT without a recorded user decision is refused.
   */
  createMaterialRecord({ name, maps, decisions = [], seamAnalysisId = null, previewAssetId = null, colorSpace }) {
    const decided = new Map();
    for (const d of decisions) {
      if (!TEXTURE_ROLE[d?.role] || decided.has(d.role)) fail('EETF_INVALID_DECISION', 'one decision per known role');
      const reason = d.reason === undefined || d.reason === null ? null : safeDisplayName(String(d.reason), '');
      if (reason) assertNoSecrets(reason, 'decision.reason');
      decided.set(d.role, reason);
    }
    for (const m of maps) if (m.status === 'USER_CONSTANT' && !decided.has(m.role)) fail('EETF_DECISION_REQUIRED', `${m.role} USER_CONSTANT needs a recorded user decision`);
    for (const role of decided.keys()) if (!maps.some(m => m.role === role && m.status === 'USER_CONSTANT')) fail('EETF_INVALID_DECISION', `decision for ${role} without a USER_CONSTANT map`);
    if (seamAnalysisId !== null) this.getSeamAnalysis(seamAnalysisId);
    if (previewAssetId !== null) this.getAsset(assertUuid(previewAssetId, 'preview asset id'));
    const id = newId();
    this.db.transaction(() => {
      const set = this.createTextureSet({ name, maps });
      const at = nowIso();
      const ins = this.db.prepare("INSERT INTO eetf_map_decisions (texture_set_id, role, decided_by, reason, created_at) VALUES (?, ?, 'USER', ?, ?)");
      for (const [role, reason] of decided) ins.run(set.id, role, reason, at);
      this.db.prepare('INSERT INTO eetf_materials (material_id, texture_set_id, name, status, color_space, seam_analysis_id, preview_asset_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, set.id, set.name, set.badge, colorSpace, seamAnalysisId, previewAssetId, at);
    })();
    return this.getMaterialRecord(id);
  }

  getMaterialRecord(materialId) {
    assertUuid(materialId, 'material id');
    const r = this.db.prepare('SELECT * FROM eetf_materials WHERE material_id = ?').get(materialId);
    if (!r) fail('EETF_MATERIAL_NOT_FOUND', 'material not found');
    const decisions = this.db.prepare('SELECT role, decided_by AS decidedBy, reason, created_at AS createdAt FROM eetf_map_decisions WHERE texture_set_id = ? ORDER BY role').all(r.texture_set_id);
    return freezeDeep({
      id: r.material_id, textureSetId: r.texture_set_id, name: r.name, status: r.status, colorSpace: r.color_space,
      seamAnalysisId: r.seam_analysis_id, previewAssetId: r.preview_asset_id, createdAt: r.created_at, decisions: decisions.map(d => ({ ...d })),
    });
  }

  // ── environments ──────────────────────────────────────────────────────────

  createEnvironmentAsset({ assetId, type, seamCheck = 'NOT_CHECKED', seamMetric = null, basedOnEnvironmentId = null }) {
    const envType = assertEnvironmentType(type);
    const asset = this.getAsset(assertUuid(assetId, 'asset id'));
    if (!SEAM_CHECK[seamCheck]) fail('EETF_INVALID_ENVIRONMENT', 'seamCheck must be NOT_CHECKED, PASSED or FAILED');
    if (seamCheck === 'NOT_CHECKED' && seamMetric !== null) fail('EETF_INVALID_ENVIRONMENT', 'a seam metric needs a seam check');
    if (seamCheck !== 'NOT_CHECKED' && (typeof seamMetric !== 'number' || !Number.isFinite(seamMetric) || seamMetric < 0)) fail('EETF_INVALID_ENVIRONMENT', 'a seam check needs a measured metric ≥ 0');
    const panoramic = envType === 'PANORAMA_REFERENCE' || envType === 'SKYBOX_PREVIEW';
    // EETF-6: close to 2:1 (PROVISIONAL tolerance) and wide enough; a 2:1 image is still only a REFERENCE
    if (panoramic && Math.abs(asset.width / asset.height - 2) / 2 > limit('panoramaRatioTolerance')) fail('EETF_PANORAMA_ASPECT', `a panorama reference is 2:1 (±${limit('panoramaRatioTolerance') * 100} %)`);
    if (panoramic && asset.width < limit('panoramaMinWidth')) fail('EETF_PANORAMA_TOO_SMALL', `a panorama reference is at least ${limit('panoramaMinWidth')} px wide`);
    if (!panoramic && seamCheck !== 'NOT_CHECKED') fail('EETF_INVALID_ENVIRONMENT', 'seam checks only apply to panoramas');
    let basedOn = null;
    if (envType === 'SKYBOX_PREVIEW') {
      const parent = this.getEnvironmentAsset(assertUuid(basedOnEnvironmentId, 'based-on environment id'));
      if (parent.type !== 'PANORAMA_REFERENCE') fail('EETF_INVALID_ENVIRONMENT', 'a skybox preview is based on a panorama reference');
      basedOn = parent.id;
    } else if (basedOnEnvironmentId !== null) fail('EETF_INVALID_ENVIRONMENT', 'only a skybox preview is based on another environment');
    const id = newId();
    this.db.prepare(`INSERT INTO eetf_environment_assets (environment_id, asset_id, env_type, projection, seam_check, seam_metric, dynamic_range, based_on_environment_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, asset.id, envType, panoramic ? PROJECTION.PANORAMA_2_1_REFERENCE : PROJECTION.FLAT, seamCheck, seamMetric, asset.dynamicRange, basedOn, nowIso());
    return this.getEnvironmentAsset(id);
  }

  getEnvironmentAsset(environmentId) {
    assertUuid(environmentId, 'environment id');
    const r = this.db.prepare('SELECT * FROM eetf_environment_assets WHERE environment_id = ?').get(environmentId);
    if (!r) fail('EETF_ENVIRONMENT_NOT_FOUND', 'environment not found');
    const panoramic = r.projection === 'PANORAMA_2_1_REFERENCE';
    const asset = this.getAsset(r.asset_id);
    // EETF-6: a measured low seam is reported as a measurement, never as "verified" / seamless
    const seamLabel = { NOT_CHECKED: 'NOT_SEAM_VERIFIED', PASSED: 'LOW_HORIZONTAL_SEAM_MEASURED', FAILED: 'HORIZONTAL_SEAM_NOT_LOW' }[r.seam_check];
    const report = this.db.prepare('SELECT * FROM eetf_environment_reports WHERE environment_id = ?').get(environmentId);
    return freezeDeep({
      id: r.environment_id, assetId: r.asset_id, type: r.env_type, projection: r.projection,
      seamCheck: r.seam_check, seamMetric: r.seam_metric, dynamicRange: r.dynamic_range, basedOnEnvironmentId: r.based_on_environment_id,
      labels: [
        ...(panoramic ? [seamLabel, 'NOT_CERTIFIED_EQUIRECTANGULAR'] : []),
        ...(panoramic && asset.width !== asset.height * 2 ? ['NOT_EXACT_2_TO_1'] : []),
        ...(r.env_type === 'SKYBOX_PREVIEW' ? ['PREVIEW_ONLY'] : []),
        ...(r.dynamic_range === 'LDR_CONTENT_IN_HDR_CONTAINER' ? ['LDR_CONTENT_IN_HDR_CONTAINER'] : []),
      ],
      claims: { hdri: false, trueHdr: false, certifiedEquirectangular: false, cubemap: false, scene3d: false },
      report: report ? { seamAnalysisId: report.seam_analysis_id, previewAssetId: report.preview_asset_id, ...JSON.parse(report.report_json), createdAt: report.created_at } : null,
      createdAt: r.created_at,
    });
  }

  /** EETF-6: environment + its measured report in ONE transaction (both immutable). */
  createEnvironmentRecord({ environment, report, seamAnalysisId = null, previewAssetId = null }) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) fail('EETF_INVALID_REPORT', 'report must be an object');
    assertNoSecrets(report, 'report');
    const json = canonicalJson(report);
    if (Buffer.byteLength(json) > limit('maxParamsBytes')) fail('EETF_PARAMS_TOO_LARGE', 'environment report too large');
    if (seamAnalysisId !== null) this.getSeamAnalysis(seamAnalysisId);
    if (previewAssetId !== null) this.getAsset(assertUuid(previewAssetId, 'preview asset id'));
    let id;
    this.db.transaction(() => {
      id = this.createEnvironmentAsset(environment).id;
      this.db.prepare('INSERT INTO eetf_environment_reports (environment_id, seam_analysis_id, preview_asset_id, report_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, seamAnalysisId, previewAssetId, json, nowIso());
    })();
    return this.getEnvironmentAsset(id);
  }

  // ── integration links (EETF-8) ────────────────────────────────────────────

  /**
   * Records where an asset's bytes came from (IMPORT) or where a byte-identical copy went (EXPORT).
   * `contentSha256` must be the asset's own hash (a link never describes other bytes). Same link twice → the
   * existing row (`existed: true`), unchanged.
   */
  createAssetLink({ assetId, direction, system, ref, contentSha256, verification }) {
    const asset = this.getAsset(assetId);
    if (!LINK_DIRECTION[direction]) fail('EETF_INVALID_LINK', 'direction must be IMPORT or EXPORT');
    if (!LINK_VERIFICATION[verification]) fail('EETF_INVALID_LINK', 'unknown link verification');
    const { ref: cleanRef, key } = validateLinkRef(system, ref);
    assertSha256(contentSha256);
    if (contentSha256 !== asset.sha256) fail('EETF_LINK_CONTENT_MISMATCH', 'the linked content is not byte-identical to the asset');
    const existing = this.db.prepare('SELECT link_id FROM eetf_asset_links WHERE asset_id = ? AND direction = ? AND system = ? AND external_key = ?').get(asset.id, direction, system, key);
    if (existing) return Object.freeze({ link: this.#getLink(existing.link_id), existed: true });
    const id = newId();
    this.db.prepare(`INSERT INTO eetf_asset_links (link_id, asset_id, direction, system, external_key, external_ref_json, content_sha256, verification, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, asset.id, direction, system, key, canonicalJson(cleanRef), contentSha256, verification, nowIso());
    return Object.freeze({ link: this.#getLink(id), existed: false });
  }

  #getLink(linkId) { return linkRow(this.db.prepare('SELECT * FROM eetf_asset_links WHERE link_id = ?').get(linkId)); }

  listAssetLinks(assetId) {
    assertUuid(assetId, 'asset id');
    return this.db.prepare('SELECT * FROM eetf_asset_links WHERE asset_id = ? ORDER BY created_at, rowid').all(assetId).map(linkRow);
  }

  /** Reverse lookup: which assets are linked to this Media Studio asset / Neurone image. */
  findLinks(system, ref) {
    const { key } = validateLinkRef(system, ref);
    return this.db.prepare('SELECT * FROM eetf_asset_links WHERE system = ? AND external_key = ? ORDER BY created_at, rowid').all(system, key).map(linkRow);
  }

  /**
   * Where an asset is used inside EETF (read-only classification for the readers): directly, or through one of its
   * direct variants (a material keeps a normalised DERIVED copy of its base color) — `via` tells which.
   */
  listAssetUsages(assetId) {
    assertUuid(assetId, 'asset id');
    const via = "CASE WHEN asset_id = ? THEN 'SELF' ELSE 'DERIVED_COPY' END";
    const scope = 'asset_id = ? OR asset_id IN (SELECT variant_asset_id FROM eetf_asset_variants WHERE source_asset_id = ?)';
    const textureMaps = this.db.prepare(`SELECT texture_set_id AS textureSetId, role, status, ${via} AS via FROM eetf_texture_maps WHERE ${scope} ORDER BY rowid`).all(assetId, assetId, assetId).map(r => ({ ...r }));
    const environments = this.db.prepare(`SELECT environment_id AS environmentId, env_type AS type, projection, dynamic_range AS dynamicRange, ${via} AS via FROM eetf_environment_assets WHERE ${scope} ORDER BY created_at, rowid`).all(assetId, assetId, assetId).map(r => ({ ...r }));
    const derivedFrom = this.db.prepare('SELECT source_asset_id AS assetId, operation FROM eetf_asset_variants WHERE variant_asset_id = ? ORDER BY created_at, rowid').all(assetId).map(r => ({ ...r }));
    return freezeDeep({ textureMaps, environments, derivedFrom });
  }

  /**
   * A browser-displayable stand-in for an asset the browser cannot show (TIFF / EXR / HDR): an existing CONVERT
   * (preferred) or THUMBNAIL variant in PNG / JPEG / WebP. Nothing is created here (creation = a DERIVE job).
   */
  findPreviewVariant(assetId) {
    const a = this.getAsset(assetId);
    if (BROWSER_NATIVE_FORMATS.includes(a.actualFormat)) return null;
    const rows = this.db.prepare(`SELECT v.variant_asset_id AS assetId, v.operation FROM eetf_asset_variants v JOIN eetf_assets a ON a.asset_id = v.variant_asset_id
      WHERE v.source_asset_id = ? AND v.operation IN ('CONVERT','THUMBNAIL') AND a.actual_format IN ('PNG','JPEG','WEBP')
      ORDER BY CASE v.operation WHEN 'CONVERT' THEN 0 ELSE 1 END, v.created_at DESC, v.rowid DESC LIMIT 1`).get(a.id);
    return rows ? freezeDeep({ assetId: rows.assetId, operation: rows.operation }) : null;
  }
}

function linkRow(r) {
  return freezeDeep({
    id: r.link_id, assetId: r.asset_id, direction: r.direction, system: r.system, ref: JSON.parse(r.external_ref_json),
    contentSha256: r.content_sha256, verification: r.verification, createdAt: r.created_at,
  });
}

function rowToAsset(r) {
  return freezeDeep({
    id: r.asset_id, sha256: r.sha256, mime: r.mime, actualFormat: r.actual_format, declaredFormat: r.declared_format,
    dynamicRange: r.dynamic_range, width: r.width, height: r.height, hasAlpha: r.has_alpha === 1, sizeBytes: r.size_bytes,
    storagePath: r.storage_path, role: r.role, displayName: r.display_name, sourceJobId: r.source_job_id, provenanceId: r.provenance_id,
    createdAt: r.created_at,
  });
}

/** A USER_CONSTANT is a scalar in [0, 1] (roughness, metallic, opacity) or an RGB triple in [0, 1] (base color, emissive). */
function validateConstant(role, v) {
  const unit = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  if (role === 'BASE_COLOR' || role === 'EMISSIVE') {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(unit)) fail('EETF_INVALID_CONSTANT', `${role} constant is [r, g, b] in [0, 1]`);
    return v.map(Number);
  }
  if (!unit(v)) fail('EETF_INVALID_CONSTANT', `${role} constant is a number in [0, 1]`);
  return v;
}
