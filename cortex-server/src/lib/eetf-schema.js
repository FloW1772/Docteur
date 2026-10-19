// EETF V1 — schema + migrations (EETF-2).
//
// Separate from sqlite.js on purpose: every table is prefixed `eetf_`, created
// additively (CREATE ... IF NOT EXISTS only — no DROP, no ALTER of a foreign
// table, no data rewrite). Each migration runs in ONE transaction together
// with its row in eetf_schema_migrations, so a crash leaves the previous
// version intact and the next open converges. Re-running is a no-op.
//
// Immutability is enforced by the database itself: an asset, a variant, a
// provenance record (and its sources) and a texture set / environment record
// cannot be updated or deleted once written (triggers raise).

export const EETF_SCHEMA_VERSION = 4;

const IMMUTABLE_TABLES = [
  'eetf_assets', 'eetf_asset_variants', 'eetf_provenance', 'eetf_provenance_sources',
  'eetf_texture_sets', 'eetf_texture_maps', 'eetf_environment_assets', 'eetf_job_outputs',
];

const immutableTriggers = (table) => `
  CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
  BEGIN SELECT RAISE(ABORT, 'EETF_IMMUTABLE: ${table} rows cannot be updated'); END;
  CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
  BEGIN SELECT RAISE(ABORT, 'EETF_IMMUTABLE: ${table} rows cannot be deleted'); END;`;

const MIGRATION_1 = `
  CREATE TABLE IF NOT EXISTS eetf_provenance (
    provenance_id   TEXT PRIMARY KEY,
    provider        TEXT NOT NULL,
    model           TEXT,
    prompt          TEXT,
    negative_prompt TEXT,
    seed            INTEGER,
    width           INTEGER,
    height          INTEGER,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    engine_version  TEXT,
    strict_local    INTEGER,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eetf_batches (
    batch_id   TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('GENERATE','DERIVE','EXPORT')),
    total      INTEGER NOT NULL CHECK (total >= 1),
    label      TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eetf_jobs (
    job_id        TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('GENERATE','DERIVE','EXPORT')),
    status        TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
    batch_id      TEXT REFERENCES eetf_batches(batch_id) ON DELETE RESTRICT,
    batch_index   INTEGER,
    provider      TEXT,
    model         TEXT,
    params_json   TEXT NOT NULL,
    params_hash   TEXT NOT NULL CHECK (length(params_hash) = 64),
    progress      REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    error_code    TEXT,
    error_message TEXT,
    retry_of      TEXT REFERENCES eetf_jobs(job_id) ON DELETE RESTRICT,
    attempt       INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    completed_at  TEXT,
    failed_at     TEXT,
    cancelled_at  TEXT,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS eetf_jobs_status ON eetf_jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS eetf_jobs_batch ON eetf_jobs(batch_id, batch_index);
  CREATE INDEX IF NOT EXISTS eetf_jobs_retry_of ON eetf_jobs(retry_of);

  CREATE TABLE IF NOT EXISTS eetf_assets (
    asset_id        TEXT PRIMARY KEY,
    sha256          TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
    mime            TEXT NOT NULL,
    actual_format   TEXT NOT NULL CHECK (actual_format IN ('PNG','JPEG','WEBP','TIFF','EXR','HDR')),
    declared_format TEXT NOT NULL CHECK (declared_format IN ('PNG','JPEG','WEBP','TIFF','EXR','HDR')),
    dynamic_range   TEXT NOT NULL CHECK (dynamic_range IN ('LDR','LDR_CONTENT_IN_HDR_CONTAINER')),
    width           INTEGER NOT NULL CHECK (width >= 1),
    height          INTEGER NOT NULL CHECK (height >= 1),
    has_alpha       INTEGER NOT NULL DEFAULT 0,
    size_bytes      INTEGER NOT NULL CHECK (size_bytes >= 1),
    storage_path    TEXT NOT NULL UNIQUE,
    role            TEXT NOT NULL CHECK (role IN ('SOURCE','GENERATED','DERIVED')),
    display_name    TEXT,
    source_job_id   TEXT REFERENCES eetf_jobs(job_id) ON DELETE RESTRICT,
    provenance_id   TEXT REFERENCES eetf_provenance(provenance_id) ON DELETE RESTRICT,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eetf_job_outputs (
    job_id   TEXT NOT NULL REFERENCES eetf_jobs(job_id) ON DELETE RESTRICT,
    asset_id TEXT NOT NULL REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    ordinal  INTEGER NOT NULL,
    PRIMARY KEY (job_id, asset_id)
  );

  CREATE TABLE IF NOT EXISTS eetf_provenance_sources (
    provenance_id   TEXT NOT NULL REFERENCES eetf_provenance(provenance_id) ON DELETE RESTRICT,
    source_asset_id TEXT NOT NULL REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    relation        TEXT NOT NULL CHECK (relation IN ('INPUT','DERIVED_FROM')),
    PRIMARY KEY (provenance_id, source_asset_id)
  );

  CREATE TABLE IF NOT EXISTS eetf_asset_variants (
    variant_id       TEXT PRIMARY KEY,
    source_asset_id  TEXT NOT NULL REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    variant_asset_id TEXT NOT NULL REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    operation        TEXT NOT NULL CHECK (operation IN ('RESIZE','CONVERT','THUMBNAIL','CROP','DERIVE_MAP','TILE_PREVIEW')),
    params_json      TEXT NOT NULL,
    params_hash      TEXT NOT NULL CHECK (length(params_hash) = 64),
    created_at       TEXT NOT NULL,
    CHECK (source_asset_id <> variant_asset_id),
    UNIQUE (source_asset_id, variant_asset_id, operation, params_hash)
  );

  CREATE TABLE IF NOT EXISTS eetf_texture_sets (
    texture_set_id    TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    normal_convention TEXT CHECK (normal_convention IN ('OPENGL','DIRECTX')),
    tileable_checked  INTEGER NOT NULL DEFAULT 0,
    tileable_metric   REAL,
    badge             TEXT NOT NULL,
    created_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eetf_texture_maps (
    texture_set_id TEXT NOT NULL REFERENCES eetf_texture_sets(texture_set_id) ON DELETE RESTRICT,
    role           TEXT NOT NULL CHECK (role IN ('BASE_COLOR','NORMAL','ROUGHNESS','METALLIC','HEIGHT','AMBIENT_OCCLUSION','OPACITY','EMISSIVE')),
    status         TEXT NOT NULL CHECK (status IN ('GENERATED','DERIVED','ESTIMATED','USER_CONSTANT','FROM_SOURCE_ALPHA','UNSUPPORTED')),
    asset_id       TEXT REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    constant_json  TEXT,
    PRIMARY KEY (texture_set_id, role),
    CHECK ((status IN ('GENERATED','DERIVED','ESTIMATED','FROM_SOURCE_ALPHA')) = (asset_id IS NOT NULL)),
    CHECK ((status = 'USER_CONSTANT') = (constant_json IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS eetf_environment_assets (
    environment_id TEXT PRIMARY KEY,
    asset_id       TEXT NOT NULL REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    env_type       TEXT NOT NULL CHECK (env_type IN ('BACKGROUND','SCENE_REFERENCE','PANORAMA_REFERENCE','SKYBOX_PREVIEW')),
    projection     TEXT NOT NULL CHECK (projection IN ('FLAT','PANORAMA_2_1_REFERENCE')),
    seam_check     TEXT NOT NULL CHECK (seam_check IN ('NOT_CHECKED','PASSED','FAILED')),
    seam_metric    REAL,
    dynamic_range  TEXT NOT NULL CHECK (dynamic_range IN ('LDR','LDR_CONTENT_IN_HDR_CONTAINER')),
    based_on_environment_id TEXT REFERENCES eetf_environment_assets(environment_id) ON DELETE RESTRICT,
    created_at     TEXT NOT NULL
  );

  ${IMMUTABLE_TABLES.map(immutableTriggers).join('\n')}
`;

// EETF-5 — textures + materials. Additive: three new immutable tables, nothing else touched.
const MIGRATION_2 = `
  CREATE TABLE IF NOT EXISTS eetf_seam_analyses (
    analysis_id       TEXT PRIMARY KEY,
    asset_id          TEXT NOT NULL REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    method            TEXT NOT NULL,
    version           INTEGER NOT NULL,
    horizontal_score  REAL NOT NULL CHECK (horizontal_score >= 0),
    vertical_score    REAL NOT NULL CHECK (vertical_score >= 0),
    seam_score        REAL NOT NULL CHECK (seam_score >= 0),
    measures_json     TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('UNKNOWN','MEASURED','LOW_SEAM','HIGH_SEAM')),
    alpha_class       TEXT NOT NULL CHECK (alpha_class IN ('NO_ALPHA_CHANNEL','OPAQUE','BINARY_CUTOUT','SEMI_TRANSPARENT','FULLY_TRANSPARENT')),
    alpha_json        TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    UNIQUE (asset_id, method, version)
  );

  CREATE TABLE IF NOT EXISTS eetf_map_decisions (
    texture_set_id TEXT NOT NULL REFERENCES eetf_texture_sets(texture_set_id) ON DELETE RESTRICT,
    role           TEXT NOT NULL,
    decided_by     TEXT NOT NULL CHECK (decided_by = 'USER'),
    reason         TEXT,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (texture_set_id, role)
  );

  CREATE TABLE IF NOT EXISTS eetf_materials (
    material_id       TEXT PRIMARY KEY,
    texture_set_id    TEXT NOT NULL UNIQUE REFERENCES eetf_texture_sets(texture_set_id) ON DELETE RESTRICT,
    name              TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('PARTIAL_MATERIAL','BASE_COLOR_ONLY','EMPTY')),
    color_space       TEXT NOT NULL,
    seam_analysis_id  TEXT REFERENCES eetf_seam_analyses(analysis_id) ON DELETE RESTRICT,
    preview_asset_id  TEXT REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    created_at        TEXT NOT NULL
  );

  ${['eetf_seam_analyses', 'eetf_map_decisions', 'eetf_materials'].map(immutableTriggers).join('\n')}
`;

// EETF-6 — environments. Additive: the measured report (and preview parameters) of each environment.
const MIGRATION_3 = `
  CREATE TABLE IF NOT EXISTS eetf_environment_reports (
    environment_id    TEXT PRIMARY KEY REFERENCES eetf_environment_assets(environment_id) ON DELETE RESTRICT,
    seam_analysis_id  TEXT REFERENCES eetf_seam_analyses(analysis_id) ON DELETE RESTRICT,
    preview_asset_id  TEXT REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    report_json       TEXT NOT NULL,
    created_at        TEXT NOT NULL
  );

  ${['eetf_environment_reports'].map(immutableTriggers).join('\n')}
`;

// EETF-8 — integration links (Media Studio, Neurone images). Additive: one immutable table. A link never owns bytes:
// the asset stays the single content-addressed copy; content_sha256 is always the asset's own hash.
const MIGRATION_4 = `
  CREATE TABLE IF NOT EXISTS eetf_asset_links (
    link_id           TEXT PRIMARY KEY,
    asset_id          TEXT NOT NULL REFERENCES eetf_assets(asset_id) ON DELETE RESTRICT,
    direction         TEXT NOT NULL CHECK (direction IN ('IMPORT','EXPORT')),
    system            TEXT NOT NULL CHECK (system IN ('MEDIA_STUDIO','NEURON_IMAGE')),
    external_key      TEXT NOT NULL CHECK (length(external_key) BETWEEN 1 AND 200),
    external_ref_json TEXT NOT NULL,
    content_sha256    TEXT NOT NULL CHECK (length(content_sha256) = 64),
    verification      TEXT NOT NULL CHECK (verification IN ('SERVER_RESOLVED','CONTENT_SHA256_MATCH')),
    created_at        TEXT NOT NULL,
    UNIQUE (asset_id, direction, system, external_key)
  );
  CREATE INDEX IF NOT EXISTS eetf_asset_links_external ON eetf_asset_links(system, external_key);

  ${['eetf_asset_links'].map(immutableTriggers).join('\n')}
`;

/** Ordered migrations. Additive-only: CREATE TABLE / INDEX / TRIGGER IF NOT EXISTS. */
export const EETF_MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: 'eetf-core-contracts', sql: MIGRATION_1 }),
  Object.freeze({ version: 2, name: 'eetf-textures-materials', sql: MIGRATION_2 }),
  Object.freeze({ version: 3, name: 'eetf-environments', sql: MIGRATION_3 }),
  Object.freeze({ version: 4, name: 'eetf-integration-links', sql: MIGRATION_4 }),
]);

/** The DDL must stay additive: checked by the tests and before every run. */
export function assertAdditiveSql(sql) {
  const stripped = sql.replace(/'[^']*'/g, "''");
  const forbidden = /\b(DROP|ALTER|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT|REPLACE|TRUNCATE|VACUUM|ATTACH|DETACH|PRAGMA)\b/i;
  const m = forbidden.exec(stripped.replace(/BEFORE\s+(UPDATE|DELETE)\s+ON/gi, 'BEFORE_EVENT ON'));
  if (m) throw new Error(`EETF migration is not additive: ${m[0]}`);
  for (const stmt of stripped.split(';').map(s => s.trim()).filter(Boolean)) {
    if (/^BEGIN\b|^SELECT\s+RAISE|^END$/i.test(stmt)) continue;
    if (!/^CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+eetf_/i.test(stmt)) throw new Error(`EETF migration statement is not an additive eetf_ create: ${stmt.slice(0, 60)}`);
  }
}

/**
 * Applies pending migrations to a better-sqlite3 database. Idempotent.
 * @returns {{ from: number, to: number, applied: number[] }}
 */
export function runEetfMigrations(db) {
  if (db.inTransaction) throw new Error('runEetfMigrations must not run inside a transaction');
  db.exec(`CREATE TABLE IF NOT EXISTS eetf_schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM eetf_schema_migrations').get().v;
  const applied = [];
  for (const m of EETF_MIGRATIONS) {
    if (m.version <= current) continue;
    assertAdditiveSql(m.sql);
    db.transaction(() => {
      db.exec(m.sql);
      const violations = db.pragma('foreign_key_check');
      if (violations.length) throw new Error(`EETF migration ${m.version} left foreign key violations`);
      db.prepare('INSERT INTO eetf_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    })();
    applied.push(m.version);
  }
  return { from: current, to: Math.max(current, ...EETF_MIGRATIONS.map(m => m.version)), applied };
}

export function eetfSchemaVersion(db) {
  try { return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM eetf_schema_migrations').get().v; } catch { return 0; }
}
