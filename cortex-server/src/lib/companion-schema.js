// Companion V1 — COMP-2 schema (separate from sqlite.js and from NB-5's dmem_* tables on purpose).
//
// Additive only (CREATE … IF NOT EXISTS companion_*), one transaction per migration with its ledger row. There is NO
// memory-content table: a durable memory lives in NB-5 (dmem_items). companion_memory_metadata holds what NB-5 does
// not have (privacy scope, Companion category, provenance, presentation, review reminder) keyed by the NB-5 memory id,
// and never the statement. A proposal holds its candidate text only while PENDING: once decided, the text is cleared
// (only its SHA-256 stays), so an accepted memory is never stored twice and a rejected one does not linger.
// Every row belongs to the single local installation (companion_installation, one row).

export const COMPANION_SCHEMA_VERSION = 4;

const MIGRATION_1 = `
  CREATE TABLE IF NOT EXISTS companion_installation (
    singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
    installation_id TEXT NOT NULL UNIQUE,
    profile         TEXT NOT NULL CHECK (profile = 'LOCAL_SINGLE_USER'),
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS companion_preferences (
    owner_id               TEXT PRIMARY KEY REFERENCES companion_installation(installation_id),
    memory_enabled         INTEGER NOT NULL CHECK (memory_enabled IN (0, 1)),
    session_memory_enabled INTEGER NOT NULL CHECK (session_memory_enabled IN (0, 1)),
    proposal_enabled       INTEGER NOT NULL CHECK (proposal_enabled IN (0, 1)),
    cloud_context_enabled  INTEGER NOT NULL CHECK (cloud_context_enabled IN (0, 1)),
    updated_at             TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS companion_memory_metadata (
    memory_id             TEXT PRIMARY KEY CHECK (length(memory_id) BETWEEN 1 AND 64),
    owner_id              TEXT NOT NULL REFERENCES companion_installation(installation_id),
    category              TEXT NOT NULL CHECK (category IN ('USER_PREFERENCE','USER_FACT')),
    privacy_scope         TEXT NOT NULL CHECK (privacy_scope IN ('PRIVATE_LOCAL','LOCAL_SHARED_CONTEXT','CLOUD_ALLOWED','NEVER_CLOUD')),
    companion_enabled     INTEGER NOT NULL CHECK (companion_enabled IN (0, 1)),
    origin                TEXT NOT NULL CHECK (origin IN ('USER_EXPLICIT','USER_CONFIRMED')),
    source_type           TEXT NOT NULL CHECK (source_type IN ('USER_INPUT','SESSION','MODEL','RULE','NOTEBOOK_SOURCE','DOCTEUR_MEMORY','EXTERNAL_DOCUMENT','WEB','IMPORT_FILE')),
    proposal_id           TEXT,
    session_id            TEXT CHECK (session_id IS NULL OR length(session_id) <= 64),
    evidence_refs_json    TEXT NOT NULL CHECK (length(evidence_refs_json) <= 2048),
    source_reference_json TEXT CHECK (source_reference_json IS NULL OR length(source_reference_json) <= 2048),
    derived_by_json       TEXT CHECK (derived_by_json IS NULL OR length(derived_by_json) <= 2048),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    confirmed_at          TEXT NOT NULL,
    last_presented_at     TEXT,
    review_after          TEXT,
    CHECK ((origin = 'USER_CONFIRMED') = (proposal_id IS NOT NULL))
  );
  CREATE TRIGGER IF NOT EXISTS companion_memory_metadata_provenance BEFORE UPDATE ON companion_memory_metadata
  WHEN NEW.memory_id IS NOT OLD.memory_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.category IS NOT OLD.category OR NEW.origin IS NOT OLD.origin
    OR NEW.source_type IS NOT OLD.source_type OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.session_id IS NOT OLD.session_id
    OR NEW.evidence_refs_json IS NOT OLD.evidence_refs_json OR NEW.source_reference_json IS NOT OLD.source_reference_json
    OR NEW.derived_by_json IS NOT OLD.derived_by_json OR NEW.created_at IS NOT OLD.created_at OR NEW.confirmed_at IS NOT OLD.confirmed_at
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: memory provenance never changes'); END;

  CREATE TABLE IF NOT EXISTS companion_memory_proposals (
    proposal_id           TEXT PRIMARY KEY,
    owner_id              TEXT NOT NULL REFERENCES companion_installation(installation_id),
    kind                  TEXT NOT NULL CHECK (kind IN ('USER_PREFERENCE','USER_FACT')),
    value                 TEXT CHECK (value IS NULL OR length(value) BETWEEN 1 AND 400),
    value_sha256          TEXT NOT NULL CHECK (length(value_sha256) = 64),
    nb5_type              TEXT NOT NULL CHECK (nb5_type IN ('PREFERENCE','WORKFLOW','CONSTRAINT','PERSONAL_NOTE','PROJECT_FACT')),
    nb5_scope_json        TEXT NOT NULL CHECK (length(nb5_scope_json) <= 512),
    privacy_scope         TEXT NOT NULL CHECK (privacy_scope IN ('PRIVATE_LOCAL','LOCAL_SHARED_CONTEXT','CLOUD_ALLOWED','NEVER_CLOUD')),
    origin                TEXT NOT NULL CHECK (origin IN ('DERIVED','IMPORTED')),
    source_type           TEXT NOT NULL CHECK (source_type IN ('USER_INPUT','SESSION','MODEL','RULE','NOTEBOOK_SOURCE','DOCTEUR_MEMORY','EXTERNAL_DOCUMENT','WEB','IMPORT_FILE')),
    session_id            TEXT CHECK (session_id IS NULL OR length(session_id) <= 64),
    evidence_refs_json    TEXT NOT NULL CHECK (length(evidence_refs_json) <= 2048),
    source_reference_json TEXT CHECK (source_reference_json IS NULL OR length(source_reference_json) <= 2048),
    derived_by_json       TEXT CHECK (derived_by_json IS NULL OR length(derived_by_json) <= 2048),
    needs_review          INTEGER NOT NULL CHECK (needs_review IN (0, 1)),
    status                TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','REJECTED','SUPERSEDED','INVALIDATED')),
    created_at            TEXT NOT NULL,
    decided_at            TEXT,
    decision_note         TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 500),
    memory_id             TEXT,
    superseded_by         TEXT REFERENCES companion_memory_proposals(proposal_id),
    CHECK ((origin = 'IMPORTED') <= (needs_review = 1)),
    CHECK ((origin = 'DERIVED') <= (derived_by_json IS NOT NULL)),
    CHECK ((status = 'PENDING') = (decided_at IS NULL)),
    CHECK (status <> 'PENDING' OR value IS NOT NULL),
    CHECK (status = 'PENDING' OR value IS NULL),
    CHECK ((status = 'ACCEPTED') = (memory_id IS NOT NULL)),
    CHECK ((status = 'SUPERSEDED') = (superseded_by IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS companion_memory_proposals_status ON companion_memory_proposals(owner_id, status, created_at);
  CREATE INDEX IF NOT EXISTS companion_memory_proposals_memory ON companion_memory_proposals(memory_id);
  CREATE TRIGGER IF NOT EXISTS companion_memory_proposals_guard BEFORE UPDATE ON companion_memory_proposals
  WHEN OLD.status <> 'PENDING' OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.kind IS NOT OLD.kind
    OR NEW.value_sha256 IS NOT OLD.value_sha256 OR NEW.nb5_type IS NOT OLD.nb5_type OR NEW.nb5_scope_json IS NOT OLD.nb5_scope_json
    OR NEW.privacy_scope IS NOT OLD.privacy_scope OR NEW.origin IS NOT OLD.origin OR NEW.source_type IS NOT OLD.source_type
    OR NEW.session_id IS NOT OLD.session_id OR NEW.evidence_refs_json IS NOT OLD.evidence_refs_json OR NEW.source_reference_json IS NOT OLD.source_reference_json
    OR NEW.derived_by_json IS NOT OLD.derived_by_json OR NEW.needs_review IS NOT OLD.needs_review OR NEW.created_at IS NOT OLD.created_at
    OR (NEW.value IS NOT OLD.value AND NEW.value IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: a proposal keeps its content and is decided once'); END;

  CREATE TABLE IF NOT EXISTS companion_audit (
    seq          INTEGER PRIMARY KEY,
    audit_id     TEXT NOT NULL UNIQUE,
    owner_id     TEXT NOT NULL REFERENCES companion_installation(installation_id),
    action       TEXT NOT NULL CHECK (action IN ('MEMORY_ADDED','MEMORY_PROPOSED','MEMORY_ACCEPTED','MEMORY_REJECTED','MEMORY_PROPOSAL_SUPERSEDED','MEMORY_PROPOSAL_INVALIDATED',
                   'MEMORY_REFUSED_SECRET','MEMORY_REFUSED_SOURCE','MEMORY_METADATA_CHANGED','MEMORY_CONTEXT_USED','MEMORY_DISABLED','MEMORY_ENABLED',
                   'PRIVACY_SCOPE_CHANGED','PREFERENCES_CHANGED','FORGET_REQUESTED','FORGET_COMPLETED','FORGET_INCOMPLETE')),
    object_type  TEXT NOT NULL CHECK (object_type IN ('MEMORY','PROPOSAL','PREFERENCES','SESSION')),
    object_id    TEXT NOT NULL,
    at           TEXT NOT NULL,
    actor        TEXT NOT NULL CHECK (actor IN ('USER','SYSTEM')),
    details_json TEXT NOT NULL CHECK (length(details_json) <= 2048),
    prev_hash    TEXT CHECK (prev_hash IS NULL OR length(prev_hash) = 64),
    entry_hash   TEXT NOT NULL CHECK (length(entry_hash) = 64)
  );
  CREATE TRIGGER IF NOT EXISTS companion_audit_no_update BEFORE UPDATE ON companion_audit
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: the audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS companion_audit_no_delete BEFORE DELETE ON companion_audit
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: the audit is append-only'); END;
`;

// ── v2 (COMP-4): model-run audit ──
// The v1 companion_audit CHECK list cannot be widened without rewriting the table (forbidden: additive only), and the
// memory audit validated in COMP-2 must not move. Model executions therefore get their own append-only, hash-chained,
// owner-scoped log. It holds request ids, provider / model names, status codes, durations and token COUNTS — never a
// prompt, an answer, a memory or a secret.
const MIGRATION_2 = `
  CREATE TABLE IF NOT EXISTS companion_model_audit (
    seq          INTEGER PRIMARY KEY,
    audit_id     TEXT NOT NULL UNIQUE,
    owner_id     TEXT NOT NULL REFERENCES companion_installation(installation_id),
    action       TEXT NOT NULL CHECK (action IN ('MODEL_REQUESTED','MODEL_SELECTED','MODEL_COMPLETED','MODEL_CANCELLED','MODEL_TIMEOUT','MODEL_FAILED')),
    request_id   TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 64),
    at           TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (length(details_json) <= 2048),
    prev_hash    TEXT CHECK (prev_hash IS NULL OR length(prev_hash) = 64),
    entry_hash   TEXT NOT NULL CHECK (length(entry_hash) = 64)
  );
  CREATE INDEX IF NOT EXISTS companion_model_audit_request ON companion_model_audit(owner_id, request_id);
  CREATE TRIGGER IF NOT EXISTS companion_model_audit_no_update BEFORE UPDATE ON companion_model_audit
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: the model audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS companion_model_audit_no_delete BEFORE DELETE ON companion_model_audit
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: the model audit is append-only'); END;
`;

// ── v3 (COMP-5): typed local actions — proposals, single-use approvals, action audit ──
// The v1 / v2 audit CHECK lists cannot be widened without rewriting their tables, so actions get their own tables.
// A proposal stores the canonical parameters (ids, enums, booleans — the action schemas accept no free text), the
// canonical digest and the SHA-256 of its preview (never the preview itself: it may quote a memory). Its status moves
// forward only (trigger); a LOCAL_MUTATION reaches EXECUTED only with a consumed approval of the same digest. An
// approval is USER-only, single-use, expires within 300 s of its creation, and its only possible change is the one-time
// consumption (consumed_at NULL → value). The action audit is append-only and hash-chained like the other two.
const MIGRATION_3 = `
  CREATE TABLE IF NOT EXISTS companion_action_proposals (
    proposal_id     TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL REFERENCES companion_installation(installation_id),
    action_id       TEXT NOT NULL CHECK (length(action_id) BETWEEN 3 AND 64),
    action_version  INTEGER NOT NULL CHECK (action_version >= 1),
    risk_class      TEXT NOT NULL CHECK (risk_class IN ('READ_ONLY','LOCAL_MUTATION')),
    target_json     TEXT NOT NULL CHECK (length(target_json) <= 512),
    parameters_json TEXT NOT NULL CHECK (length(parameters_json) <= 2048),
    action_digest   TEXT NOT NULL CHECK (length(action_digest) = 64),
    preview_sha256  TEXT NOT NULL CHECK (length(preview_sha256) = 64),
    proposed_by     TEXT NOT NULL CHECK (proposed_by IN ('USER','MODEL')),
    status          TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','EXECUTED','FAILED','CANCELLED','SUPERSEDED')),
    result_code     TEXT CHECK (result_code IS NULL OR length(result_code) <= 64),
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    decided_at      TEXT,
    superseded_by   TEXT REFERENCES companion_action_proposals(proposal_id),
    CHECK ((status = 'SUPERSEDED') = (superseded_by IS NOT NULL)),
    CHECK ((status = 'PENDING') = (decided_at IS NULL))
  );
  CREATE INDEX IF NOT EXISTS companion_action_proposals_status ON companion_action_proposals(owner_id, status, created_at);
  CREATE INDEX IF NOT EXISTS companion_action_proposals_target ON companion_action_proposals(owner_id, action_id, target_json);

  CREATE TABLE IF NOT EXISTS companion_action_approvals (
    approval_id   TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES companion_installation(installation_id),
    proposal_id   TEXT NOT NULL UNIQUE REFERENCES companion_action_proposals(proposal_id),
    action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
    approved_by   TEXT NOT NULL CHECK (approved_by = 'USER'),
    approved_at   TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    single_use    INTEGER NOT NULL CHECK (single_use = 1),
    consumed_at   TEXT,
    CHECK (julianday(expires_at) > julianday(approved_at)),
    CHECK ((julianday(expires_at) - julianday(approved_at)) * 86400.0 <= 300.5)
  );
  CREATE TRIGGER IF NOT EXISTS companion_action_approvals_guard BEFORE UPDATE ON companion_action_approvals
  WHEN NEW.approval_id IS NOT OLD.approval_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.proposal_id IS NOT OLD.proposal_id
    OR NEW.action_digest IS NOT OLD.action_digest OR NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at
    OR NEW.expires_at IS NOT OLD.expires_at OR NEW.single_use IS NOT OLD.single_use OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: an approval is consumed once and never changes otherwise'); END;
  CREATE TRIGGER IF NOT EXISTS companion_action_approvals_no_delete BEFORE DELETE ON companion_action_approvals
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: approvals are kept'); END;

  CREATE TRIGGER IF NOT EXISTS companion_action_proposals_guard BEFORE UPDATE ON companion_action_proposals
  WHEN NEW.proposal_id IS NOT OLD.proposal_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.action_id IS NOT OLD.action_id
    OR NEW.action_version IS NOT OLD.action_version OR NEW.risk_class IS NOT OLD.risk_class OR NEW.target_json IS NOT OLD.target_json
    OR NEW.parameters_json IS NOT OLD.parameters_json OR NEW.action_digest IS NOT OLD.action_digest OR NEW.preview_sha256 IS NOT OLD.preview_sha256
    OR NEW.proposed_by IS NOT OLD.proposed_by OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NOT ((OLD.status = 'PENDING' AND NEW.status IN ('APPROVED','REJECTED','EXPIRED','SUPERSEDED','CANCELLED','EXECUTED','FAILED'))
         OR (OLD.status = 'APPROVED' AND NEW.status IN ('EXECUTED','FAILED','CANCELLED','EXPIRED','REJECTED','SUPERSEDED')))
    OR (OLD.status = 'PENDING' AND NEW.status IN ('EXECUTED','FAILED') AND OLD.risk_class = 'LOCAL_MUTATION')
    OR (NEW.status = 'APPROVED' AND OLD.risk_class <> 'LOCAL_MUTATION')
    OR (NEW.status = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM companion_action_approvals a WHERE a.proposal_id = OLD.proposal_id AND a.action_digest = OLD.action_digest AND a.consumed_at IS NULL))
    OR (NEW.status IN ('EXECUTED','FAILED') AND OLD.risk_class = 'LOCAL_MUTATION'
        AND NOT EXISTS (SELECT 1 FROM companion_action_approvals a WHERE a.proposal_id = OLD.proposal_id AND a.action_digest = OLD.action_digest AND a.consumed_at IS NOT NULL))
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: an action proposal keeps its content and only moves forward'); END;
  CREATE TRIGGER IF NOT EXISTS companion_action_proposals_no_delete BEFORE DELETE ON companion_action_proposals
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: action proposals are kept'); END;

  CREATE TABLE IF NOT EXISTS companion_action_audit (
    seq           INTEGER PRIMARY KEY,
    audit_id      TEXT NOT NULL UNIQUE,
    owner_id      TEXT NOT NULL REFERENCES companion_installation(installation_id),
    event         TEXT NOT NULL CHECK (event IN ('ACTION_PROPOSED','ACTION_APPROVED','ACTION_REJECTED','ACTION_EXPIRED','ACTION_EXECUTION_STARTED',
                    'ACTION_EXECUTED','ACTION_FAILED','ACTION_CANCELLED','APPROVAL_CONSUMED','ACTION_DENIED','ACTION_SUPERSEDED')),
    action_id     TEXT CHECK (action_id IS NULL OR length(action_id) <= 64),
    proposal_id   TEXT CHECK (proposal_id IS NULL OR length(proposal_id) <= 64),
    approval_id   TEXT CHECK (approval_id IS NULL OR length(approval_id) <= 64),
    action_digest TEXT CHECK (action_digest IS NULL OR length(action_digest) = 64),
    risk_class    TEXT CHECK (risk_class IS NULL OR risk_class IN ('READ_ONLY','LOCAL_MUTATION','EXTERNAL_ACTION','HIGH_IMPACT_ACTION')),
    result_code   TEXT CHECK (result_code IS NULL OR length(result_code) <= 64),
    at            TEXT NOT NULL,
    details_json  TEXT NOT NULL CHECK (length(details_json) <= 2048),
    prev_hash     TEXT CHECK (prev_hash IS NULL OR length(prev_hash) = 64),
    entry_hash    TEXT NOT NULL CHECK (length(entry_hash) = 64)
  );
  CREATE INDEX IF NOT EXISTS companion_action_audit_proposal ON companion_action_audit(owner_id, proposal_id);
  CREATE TRIGGER IF NOT EXISTS companion_action_audit_no_update BEFORE UPDATE ON companion_action_audit
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: the action audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS companion_action_audit_no_delete BEFORE DELETE ON companion_action_audit
  BEGIN SELECT RAISE(ABORT, 'COMP_IMMUTABLE: the action audit is append-only'); END;
`;

const MIGRATION_4 = `
  CREATE TABLE IF NOT EXISTS companion_activation (
    singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
    state       TEXT NOT NULL CHECK (state IN ('DISABLED_PENDING_HUMAN_ACTIVATION', 'ACTIVE')),
    updated_at  TEXT NOT NULL
  );
`;

export const COMPANION_MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: 'companion-layer', sql: MIGRATION_1 }),
  Object.freeze({ version: 2, name: 'companion-model-audit', sql: MIGRATION_2 }),
  Object.freeze({ version: 3, name: 'companion-actions', sql: MIGRATION_3 }),
  Object.freeze({ version: 4, name: 'companion-activation', sql: MIGRATION_4 }),
]);

/** Additive DDL only, on companion_* objects only (checked by the tests and before every run). */
export function assertAdditiveSql(sql) {
  const stripped = sql.replace(/'[^']*'/g, "''");
  const m = /\b(DROP|ALTER|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT|REPLACE|TRUNCATE|VACUUM|ATTACH|DETACH|PRAGMA)\b/i.exec(stripped.replace(/BEFORE\s+(UPDATE|DELETE|INSERT)\s+ON/gi, 'BEFORE_EVENT ON'));
  if (m) throw new Error(`Companion migration is not additive: ${m[0]}`);
  const statements = stripped.replace(/BEGIN SELECT RAISE\(ABORT, ''\); END/gi, 'BEGIN_RAISE_END').split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    if (!/^CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+companion_/i.test(stmt)) throw new Error(`Companion migration statement is not an additive companion_ create: ${stmt.slice(0, 60)}`);
  }
}

/** upTo (tests only): stop at an older version, to build a fixture of a previous schema. */
export function runCompanionMigrations(db, { upTo = COMPANION_SCHEMA_VERSION } = {}) {
  for (const m of COMPANION_MIGRATIONS) assertAdditiveSql(m.sql);
  db.exec('CREATE TABLE IF NOT EXISTS companion_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM companion_schema_migrations').get().v;
  const applied = [];
  for (const m of COMPANION_MIGRATIONS) {
    if (m.version <= current || m.version > upTo) continue;
    db.transaction(() => {
      db.exec(m.sql);
      if (db.pragma('foreign_key_check').length) throw new Error(`Companion migration ${m.version} left foreign key violations`);
      db.prepare('INSERT INTO companion_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    })();
    applied.push(m.version);
  }
  return { from: current, to: Math.max(current, ...applied), applied };
}

export function companionSchemaVersion(db) {
  try { return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM companion_schema_migrations').get().v; } catch { return 0; }
}
