// Knowledge Graph V1 — SQLite store (KG-2, realigned in KG-3).
//
// Idempotent upserts and bounded reads over the kg_* tables. KG-3 rules:
//   • an entity ID is never derived from its name: two homonyms are two
//     entities until a resolution (kg-resolution.js) says otherwise;
//   • a logical source (kg_sources) is distinct from its technical ingestion
//     paths (kg_source_refs);
//   • claims ↔ evidence is N:N (kg_claim_evidence, SUPPORTS | CONTRADICTS);
//   • nothing is physically deleted: a source is INVALIDATED (its evidence
//     becomes SOURCE_MISSING and the claims are recomputed), a merge is a
//     ledger row + logical redirect (merged_into_id);
//   • there is no "reset": importData only adds/updates.
// Never touches Notebook (nb_*, notebook_*) tables or Root Policy.

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {
  KG_ENTITY_TYPES,
  KG_SOURCE_TYPES,
  KG_EVIDENCE_TYPES,
  KG_CLAIM_TYPES,
  KG_RELATIONSHIP_TYPES,
  KG_DEFAULT_LIMITS,
  KG_ENTITY_STATUSES,
  KG_SOURCE_STATUSES,
  KG_SOURCE_ADAPTERS,
  KG_PRIVACY_LEVELS,
  KG_EGRESS_POLICIES,
  KG_ALIAS_STATUSES,
  KG_CLAIM_STATUSES,
  KG_EXTRACTION_METHODS,
  KG_LOCATOR_KINDS,
  KG_STANCES,
  KG_RESOLUTION_DECISIONS,
  KG_RESOLUTION_METHODS,
  getSchemaVersion,
} from './kg-schema.js';
import { runMigrations, getMigrationStatus, relationshipProvenanceId } from './kg-migrations.js';
import { labelKey, looseKey, tokenKey, normalizeIdentifier, excerptHash, stableHash, entityTypesCompatible } from './kg-normalize.js';

/**
 * Comparison form used for search (KG-2 contract: case, accents and spacing
 * folded). Delegates to the KG-3 loose key. Never stored in place of the original.
 */
export function normalizeString(str) {
  return looseKey(str);
}

/** Deterministic ID from a string (KG-2 helper). */
export function generateId(prefix, str) {
  const normalized = normalizeString(str);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 24);
  return `${prefix}_${hash}`;
}

const hashId = (prefix, ...parts) => `${prefix}_${stableHash(...parts).substring(0, 24)}`;
const nowIso = () => new Date().toISOString();
const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const withMetadata = (row) => (row ? { ...row, metadata: parseJson(row.metadata, {}) } : null);

export class KgError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'KgError';
    this.code = code;
  }
}

/** Most restrictive of two privacy levels. */
function stricterPrivacy(a, b) {
  return KG_PRIVACY_LEVELS.indexOf(a) >= KG_PRIVACY_LEVELS.indexOf(b) ? a : b;
}

function boundedProvenance(provenance) {
  const json = JSON.stringify(provenance && typeof provenance === 'object' ? provenance : {});
  if (Buffer.byteLength(json, 'utf8') > KG_DEFAULT_LIMITS.MAX_PROVENANCE_BYTES) {
    throw new KgError('KG_PROVENANCE_TOO_LARGE', `technical provenance is limited to ${KG_DEFAULT_LIMITS.MAX_PROVENANCE_BYTES} bytes`);
  }
  return json;
}

export class KnowledgeGraphStore {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.options = {
      readOnly: options.readOnly || false,
      timeout: options.timeout || KG_DEFAULT_LIMITS.MAX_EXECUTION_TIME_MS,
      ...options,
    };
    this.db = null;
    this.initialized = false;
    this.limits = {
      maxDepth: options.maxDepth || KG_DEFAULT_LIMITS.MAX_DEPTH,
      maxNodes: options.maxNodes || KG_DEFAULT_LIMITS.MAX_NODES,
      maxEdges: options.maxEdges || KG_DEFAULT_LIMITS.MAX_EDGES,
      maxResultSize: options.maxResultSize || KG_DEFAULT_LIMITS.MAX_RESULT_SIZE,
      maxExecutionTime: this.options.timeout,
    };
  }

  open() {
    if (this.db) return this;
    this.db = new Database(this.dbPath, { readonly: this.options.readOnly, timeout: this.options.timeout });
    if (this.dbPath !== ':memory:' && !this.options.readOnly) this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    return this;
  }

  close() {
    this.statements?.clear();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
    return this;
  }

  /**
   * Prepared-statement cache (better-sqlite3 compiles on every db.prepare):
   * the same SQL text is compiled once per connection. Bounded.
   */
  prepare(sql) {
    if (!this.statements) this.statements = new Map();
    let stmt = this.statements.get(sql);
    if (!stmt) {
      if (this.statements.size >= 1000) this.statements.clear();
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  async initialize() {
    if (this.initialized) return this;
    this.open();
    try {
      const result = runMigrations(this.db, {
        maxExecutionTime: this.limits.maxExecutionTime,
        verbose: this.options.verbose || false,
        onStep: this.options.onMigrationStep,
      });
      if (!result.success) throw new Error(`Migration failed: ${result.errors.map(e => e.message).join(', ')}`);
      this.initialized = true;
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** In-memory store (tests). */
  static async createTempStore(options = {}) {
    const store = new KnowledgeGraphStore(':memory:', { ...options, readOnly: false });
    await store.initialize();
    return store;
  }

  /**
   * File-based store at an explicit path (tests / harness on a TEMPORARY
   * database). The application boot never calls this: it goes through
   * kg-boot.js, which keeps the KG off the user database until KG-CERT.
   */
  static async createTestStore(dbPath, options = {}) {
    const store = new KnowledgeGraphStore(dbPath, { ...options, readOnly: false });
    await store.initialize();
    return store;
  }

  transaction(fn) {
    return this.db.transaction(fn)();
  }

  // ════════════════════════════════════════════════════════════════════════
  // ENTITIES
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Upsert an entity by ID. Without `entity_id` a NEW entity is created with an
   * opaque ID (a name never identifies an entity — use resolveEntityMention to
   * attach a mention to an existing one). The type of an existing entity is
   * immutable; its resolution state (status / merged_into_id) is owned by the
   * resolution ledger and is not changed here.
   */
  upsertEntity(entity) {
    const now = nowIso();
    if (!entity?.name || !String(entity.name).trim()) throw new Error('Entity name is required');
    if (!entity.entity_type || !KG_ENTITY_TYPES.includes(entity.entity_type)) {
      throw new Error(`Invalid entity type: ${entity.entity_type}. Must be one of: ${KG_ENTITY_TYPES.join(', ')}`);
    }
    if (entity.status !== undefined && !KG_ENTITY_STATUSES.includes(entity.status)) throw new Error(`Invalid entity status: ${entity.status}`);
    const entityId = entity.entity_id || `ent_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
    const existing = this.prepare('SELECT entity_type FROM kg_entities WHERE entity_id = ?').get(entityId);
    if (existing && existing.entity_type !== entity.entity_type) {
      throw new KgError('KG_ENTITY_TYPE_IMMUTABLE', `entity ${entityId} is ${existing.entity_type}, not ${entity.entity_type}`);
    }
    const name = String(entity.name);
    const normalizedName = looseKey(name);
    const metadata = { ...(entity.metadata && typeof entity.metadata === 'object' ? entity.metadata : {}) };
    const status = entity.status ?? 'ACTIVE';
    this.prepare(`
      INSERT INTO kg_entities (
        entity_id, entity_type, name, description, normalized_name, label_key, token_key,
        canonical_id, status, created_at, updated_at, version, is_active,
        is_verified, trust_level, confidence, metadata, provenance_source_id, provenance_created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        normalized_name = excluded.normalized_name,
        label_key = excluded.label_key,
        token_key = excluded.token_key,
        canonical_id = excluded.canonical_id,
        updated_at = excluded.updated_at,
        version = version + 1,
        is_active = excluded.is_active,
        is_verified = excluded.is_verified,
        trust_level = excluded.trust_level,
        confidence = excluded.confidence,
        metadata = excluded.metadata
    `).run(
      entityId, entity.entity_type, name, entity.description || '', normalizedName, labelKey(name), tokenKey(name),
      entity.canonical_id || entityId, status, now, now,
      entity.is_active !== undefined ? entity.is_active : (status === 'INVALIDATED' ? 0 : 1),
      entity.is_verified !== undefined ? entity.is_verified : 0,
      entity.trust_level || 'UNKNOWN',
      entity.confidence !== undefined ? entity.confidence : 0.0,
      JSON.stringify(metadata),
      entity.provenance_source_id ?? null,
      entity.provenance_source_id ? now : null,
    );
    return { id: entityId, normalizedName, isNew: !existing };
  }

  getEntity(entityId) {
    return withMetadata(this.prepare('SELECT * FROM kg_entities WHERE entity_id = ?').get(entityId));
  }

  getEntitiesByIds(entityIds, options = {}) {
    const limit = options.limit || KG_DEFAULT_LIMITS.DEFAULT_NODE_LIMIT;
    if (entityIds.length > limit) throw new Error(`Too many entity IDs requested: ${entityIds.length} > ${limit}`);
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(', ');
    return this.prepare(`SELECT * FROM kg_entities WHERE entity_id IN (${placeholders})`).all(...entityIds).map(withMetadata);
  }

  /** Search; merged entities are hidden by default (their logical root is listed instead). */
  searchEntities(query, options = {}) {
    const {
      entityType,
      limit = KG_DEFAULT_LIMITS.DEFAULT_SEARCH_LIMIT,
      offset = 0,
      minConfidence,
      trustLevel,
      isActive = true,
      isVerified,
      includeMerged = false,
    } = options;
    if (limit > KG_DEFAULT_LIMITS.MAX_NODES) throw new Error(`Limit too high: ${limit} > ${KG_DEFAULT_LIMITS.MAX_NODES}`);
    const conditions = [];
    const params = [];
    if (query) {
      conditions.push("(normalized_name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const escaped = (s) => String(s).replace(/[\\%_]/g, m => `\\${m}`);
      params.push(`%${escaped(normalizeString(query))}%`, `%${escaped(query)}%`, `%${escaped(query)}%`);
    }
    if (entityType) { conditions.push('entity_type = ?'); params.push(entityType); }
    if (minConfidence !== undefined) { conditions.push('confidence >= ?'); params.push(minConfidence); }
    if (trustLevel) { conditions.push('trust_level = ?'); params.push(trustLevel); }
    if (isActive !== undefined) { conditions.push('is_active = ?'); params.push(isActive ? 1 : 0); }
    if (isVerified !== undefined) { conditions.push('is_verified = ?'); params.push(isVerified ? 1 : 0); }
    if (!includeMerged) conditions.push("status <> 'MERGED'");
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.prepare(`SELECT * FROM kg_entities ${whereClause} ORDER BY name ASC, entity_id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { entities: rows.map(withMetadata), count: rows.length, limit, offset };
  }

  /** FTS search; the query is quoted term by term (no FTS syntax injection). */
  searchEntitiesFTS(query, options = {}) {
    const { entityType, limit = KG_DEFAULT_LIMITS.DEFAULT_SEARCH_LIMIT, offset = 0 } = options;
    if (limit > KG_DEFAULT_LIMITS.MAX_NODES) throw new Error(`Limit too high: ${limit} > ${KG_DEFAULT_LIMITS.MAX_NODES}`);
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return { entities: [], count: 0, limit, offset };
    const params = [ftsQuery];
    if (entityType) params.push(entityType);
    const rows = this.prepare(`
      SELECT e.* FROM kg_entities_fts fts
      JOIN kg_entities e ON fts.entity_id = e.entity_id
      WHERE kg_entities_fts MATCH ?
      ${entityType ? 'AND e.entity_type = ?' : ''}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return { entities: rows.map(withMetadata), count: rows.length, limit, offset };
  }

  /** Logical root of an entity: follows merged_into_id (bounded, cycle-safe). */
  getLogicalRootId(entityId) {
    let current = entityId;
    const seen = new Set();
    for (let i = 0; i <= KG_DEFAULT_LIMITS.MAX_MERGE_CHAIN; i++) {
      if (seen.has(current)) throw new KgError('KG_MERGE_CYCLE', `merge cycle at ${current}`);
      seen.add(current);
      const row = this.prepare('SELECT merged_into_id FROM kg_entities WHERE entity_id = ?').get(current);
      if (!row) return null;
      if (!row.merged_into_id) return current;
      current = row.merged_into_id;
    }
    throw new KgError('KG_MERGE_CHAIN_TOO_LONG', `merge chain longer than ${KG_DEFAULT_LIMITS.MAX_MERGE_CHAIN}`);
  }

  /** All entity IDs whose logical root is `rootId` (root included). */
  getLogicalMemberIds(rootId) {
    return this.prepare(`
      WITH RECURSIVE members(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT e.entity_id, m.depth + 1 FROM kg_entities e JOIN members m ON e.merged_into_id = m.id
        WHERE m.depth < ${KG_DEFAULT_LIMITS.MAX_MERGE_CHAIN}
      )
      SELECT id FROM members ORDER BY depth, id
    `).all(rootId).map(r => r.id);
  }

  /**
   * Logical view of an entity: its root (canonical label never rewritten) plus
   * every original entity merged into it, with all their aliases, identifiers
   * and claims — nothing is lost by a merge, everything stays attributable.
   */
  getLogicalEntity(entityId) {
    const rootId = this.getLogicalRootId(entityId);
    if (!rootId) return null;
    const memberIds = this.getLogicalMemberIds(rootId);
    const placeholders = memberIds.map(() => '?').join(', ');
    return {
      entity: this.getEntity(rootId),
      requestedId: entityId,
      memberIds,
      members: this.prepare(`SELECT * FROM kg_entities WHERE entity_id IN (${placeholders}) ORDER BY created_at, entity_id`).all(...memberIds).map(withMetadata),
      aliases: this.prepare(`SELECT * FROM kg_aliases WHERE entity_id IN (${placeholders}) ORDER BY entity_id, alias`).all(...memberIds).map(withMetadata),
      identifiers: this.prepare(`SELECT * FROM kg_entity_identifiers WHERE entity_id IN (${placeholders}) ORDER BY scheme, normalized_value`).all(...memberIds),
      claimIds: this.prepare(`SELECT claim_id FROM kg_claims WHERE entity_id IN (${placeholders}) OR object_entity_id IN (${placeholders}) ORDER BY claim_id`)
        .all(...memberIds, ...memberIds).map(r => r.claim_id),
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // SOURCES (logical) and SOURCE REFS (technical paths)
  // ════════════════════════════════════════════════════════════════════════

  upsertSource(source) {
    const now = nowIso();
    if (!source?.name) throw new Error('Source name is required');
    if (!source.source_type || !KG_SOURCE_TYPES.includes(source.source_type)) {
      throw new Error(`Invalid source type: ${source.source_type}. Must be one of: ${KG_SOURCE_TYPES.join(', ')}`);
    }
    const privacy = source.privacy ?? 'UNKNOWN';
    const egress = source.egress_policy ?? 'local_only';
    if (!KG_PRIVACY_LEVELS.includes(privacy)) throw new Error(`Invalid privacy: ${privacy}`);
    if (!KG_EGRESS_POLICIES.includes(egress)) throw new Error(`Invalid egress policy: ${egress}`);
    const status = source.status ?? (source.is_active === 0 ? 'INVALIDATED' : 'ACTIVE');
    if (!KG_SOURCE_STATUSES.includes(status)) throw new Error(`Invalid source status: ${status}`);
    const sourceId = source.source_id
      || (source.logical_key ? hashId('src', 'logical', source.logical_key) : generateId('src', `${source.source_type}:${source.name}:${source.uri || ''}`));
    const existing = this.prepare('SELECT source_id FROM kg_sources WHERE source_id = ?').get(sourceId);
    const metadata = { ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}) };
    this.prepare(`
      INSERT INTO kg_sources (
        source_id, source_type, name, uri, author, publisher,
        published_at, retrieved_at, last_accessed, language,
        logical_key, canonical_url, content_hash, privacy, egress_policy, status, invalidated_at,
        created_at, updated_at, version, is_active,
        trust_level, confidence, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        source_type = excluded.source_type,
        name = excluded.name,
        uri = COALESCE(excluded.uri, kg_sources.uri),
        author = COALESCE(excluded.author, kg_sources.author),
        publisher = COALESCE(excluded.publisher, kg_sources.publisher),
        published_at = COALESCE(excluded.published_at, kg_sources.published_at),
        retrieved_at = COALESCE(excluded.retrieved_at, kg_sources.retrieved_at),
        last_accessed = COALESCE(excluded.last_accessed, kg_sources.last_accessed),
        language = excluded.language,
        logical_key = COALESCE(kg_sources.logical_key, excluded.logical_key),
        canonical_url = COALESCE(kg_sources.canonical_url, excluded.canonical_url),
        content_hash = COALESCE(kg_sources.content_hash, excluded.content_hash),
        updated_at = excluded.updated_at,
        version = version + 1,
        trust_level = excluded.trust_level,
        confidence = excluded.confidence,
        metadata = excluded.metadata
    `).run(
      sourceId, source.source_type, source.name, source.uri || null, source.author || null, source.publisher || null,
      source.published_at || null, source.retrieved_at || null, source.last_accessed || null, source.language || 'unknown',
      source.logical_key ?? null, source.canonical_url ?? null, source.content_hash ?? null, privacy, egress, status,
      status === 'ACTIVE' ? null : now,
      now, now, status === 'ACTIVE' ? 1 : 0,
      source.trust_level || 'UNKNOWN', source.confidence !== undefined ? source.confidence : 0.0, JSON.stringify(metadata),
    );
    // Privacy only ever tightens on an existing logical source.
    if (existing) this.tightenSourcePrivacy(sourceId, privacy, egress);
    return { id: sourceId, normalizedName: normalizeString(source.name), isNew: !existing };
  }

  tightenSourcePrivacy(sourceId, privacy, egress) {
    const row = this.prepare('SELECT privacy, egress_policy FROM kg_sources WHERE source_id = ?').get(sourceId);
    if (!row) return;
    const nextPrivacy = stricterPrivacy(row.privacy, privacy);
    const nextEgress = row.egress_policy === 'local_only' || egress === 'local_only' ? 'local_only' : 'cloud_allowed';
    if (nextPrivacy !== row.privacy || nextEgress !== row.egress_policy) {
      this.prepare('UPDATE kg_sources SET privacy = ?, egress_policy = ?, updated_at = ? WHERE source_id = ?').run(nextPrivacy, nextEgress, nowIso(), sourceId);
    }
  }

  getSource(sourceId) {
    return withMetadata(this.prepare('SELECT * FROM kg_sources WHERE source_id = ?').get(sourceId));
  }

  getSourcesByIds(sourceIds, options = {}) {
    const limit = options.limit || KG_DEFAULT_LIMITS.DEFAULT_NODE_LIMIT;
    if (sourceIds.length > limit) throw new Error(`Too many source IDs requested: ${sourceIds.length} > ${limit}`);
    if (sourceIds.length === 0) return [];
    const placeholders = sourceIds.map(() => '?').join(', ');
    return this.prepare(`SELECT * FROM kg_sources WHERE source_id IN (${placeholders})`).all(...sourceIds).map(withMetadata);
  }

  findSourceByLogicalKey(logicalKey) {
    return withMetadata(this.prepare('SELECT * FROM kg_sources WHERE logical_key = ?').get(logicalKey));
  }

  findSourcesByCanonicalUrl(canonicalUrl) {
    return this.prepare('SELECT * FROM kg_sources WHERE canonical_url = ? ORDER BY created_at, source_id').all(canonicalUrl).map(withMetadata);
  }

  findSourcesByContentHash(contentHash) {
    return this.prepare('SELECT * FROM kg_sources WHERE content_hash = ? ORDER BY created_at, source_id').all(contentHash).map(withMetadata);
  }

  /**
   * Upsert a technical provenance of a logical source. (adapter, source_ref)
   * identifies the path: re-importing it is idempotent. A path can never be
   * moved silently to another logical source.
   */
  upsertSourceRef(ref) {
    if (!ref?.source_id) throw new Error('source_id is required for a source ref');
    if (!KG_SOURCE_ADAPTERS.includes(ref.adapter)) throw new Error(`Invalid source adapter: ${ref.adapter}`);
    if (!ref.source_ref || !String(ref.source_ref).trim()) throw new Error('source_ref is required');
    if (!this.getSource(ref.source_id)) throw new Error(`Source ${ref.source_id} not found`);
    const privacy = ref.privacy ?? 'UNKNOWN';
    const egress = ref.egress_policy ?? 'local_only';
    if (!KG_PRIVACY_LEVELS.includes(privacy)) throw new Error(`Invalid privacy: ${privacy}`);
    if (!KG_EGRESS_POLICIES.includes(egress)) throw new Error(`Invalid egress policy: ${egress}`);
    const sourceRef = String(ref.source_ref);
    const existing = this.prepare('SELECT source_ref_id, source_id FROM kg_source_refs WHERE adapter = ? AND source_ref = ?').get(ref.adapter, sourceRef);
    if (existing && existing.source_id !== ref.source_id) {
      throw new KgError('KG_SOURCE_REF_CONFLICT', `${ref.adapter}:${sourceRef} already belongs to logical source ${existing.source_id}`);
    }
    const refId = existing?.source_ref_id ?? hashId('sref', ref.adapter, sourceRef);
    const now = nowIso();
    this.prepare(`
      INSERT INTO kg_source_refs (
        source_ref_id, source_id, adapter, input_path, source_ref, version_ref, original_url, capture_id,
        content_hash, provenance, privacy, egress_policy, status, observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
      ON CONFLICT(source_ref_id) DO UPDATE SET
        input_path = excluded.input_path,
        version_ref = excluded.version_ref,
        original_url = excluded.original_url,
        capture_id = excluded.capture_id,
        content_hash = excluded.content_hash,
        provenance = excluded.provenance,
        privacy = excluded.privacy,
        egress_policy = excluded.egress_policy,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `).run(
      refId, ref.source_id, ref.adapter, ref.input_path ?? null, sourceRef, ref.version_ref ?? null,
      ref.original_url ?? null, ref.capture_id ?? null, ref.content_hash ?? null, boundedProvenance(ref.provenance),
      privacy, egress, ref.observed_at ?? now, now, now,
    );
    this.tightenSourcePrivacy(ref.source_id, privacy, egress);
    return { id: refId, isNew: !existing };
  }

  getSourceRef(sourceRefId) {
    const row = this.prepare('SELECT * FROM kg_source_refs WHERE source_ref_id = ?').get(sourceRefId);
    return row ? { ...row, provenance: parseJson(row.provenance, {}) } : null;
  }

  findSourceRef(adapter, sourceRef) {
    const row = this.prepare('SELECT * FROM kg_source_refs WHERE adapter = ? AND source_ref = ?').get(adapter, String(sourceRef));
    return row ? { ...row, provenance: parseJson(row.provenance, {}) } : null;
  }

  getSourceRefs(sourceId, { includeInactive = true } = {}) {
    return this.prepare(`SELECT * FROM kg_source_refs WHERE source_id = ? ${includeInactive ? '' : "AND status = 'ACTIVE'"} ORDER BY created_at, rowid`)
      .all(sourceId).map(row => ({ ...row, provenance: parseJson(row.provenance, {}) }));
  }

  /**
   * A logical source disappears (deleted / invalid): its refs are invalidated,
   * its evidence becomes SOURCE_MISSING (kept, not deleted), and every claim
   * linked to that evidence is recomputed from its OTHER evidence. Entities
   * are untouched.
   */
  invalidateSource(sourceId, { status = 'INVALIDATED', reason = '' } = {}) {
    if (!['INVALIDATED', 'DELETED', 'SUPERSEDED'].includes(status)) throw new Error(`Invalid invalidation status: ${status}`);
    return this.transaction(() => {
      const source = this.getSource(sourceId);
      if (!source) throw new Error(`Source ${sourceId} not found`);
      const now = nowIso();
      const metadata = { ...source.metadata, ...(reason ? { invalidation_reason: String(reason).slice(0, 500) } : {}) };
      this.prepare('UPDATE kg_sources SET status = ?, is_active = 0, invalidated_at = ?, updated_at = ?, metadata = ? WHERE source_id = ?')
        .run(status, now, now, JSON.stringify(metadata), sourceId);
      const refs = this.prepare("UPDATE kg_source_refs SET status = 'INVALIDATED', invalidated_at = ?, updated_at = ? WHERE source_id = ? AND status = 'ACTIVE'")
        .run(now, now, sourceId).changes;
      const evidenceIds = this.prepare('SELECT evidence_id FROM kg_evidence WHERE source_id = ?').all(sourceId).map(r => r.evidence_id);
      this.prepare("UPDATE kg_evidence SET status = 'SOURCE_MISSING', is_active = 0, updated_at = ? WHERE source_id = ? AND status = 'ACTIVE'").run(now, sourceId);
      const relationProvenance = this.prepare("UPDATE kg_relationship_provenance SET status = 'INVALIDATED', invalidated_at = ?, updated_at = ? WHERE source_id = ? AND status = 'ACTIVE'")
        .run(now, now, sourceId).changes;
      const claims = this.recomputeClaimsForEvidence(evidenceIds);
      return { sourceId, status, refsInvalidated: refs, evidenceMarked: evidenceIds.length, relationProvenanceInvalidated: relationProvenance, ...claims };
    });
  }

  /**
   * One technical path disappears (e.g. one of two captures deleted). The
   * logical source stays ACTIVE while another active path exists; when the last
   * path goes, the source itself is invalidated as DELETED.
   * KG-7: the evidence seen through THAT path follows it. Evidence located in
   * the path itself (a chunk, a message) becomes SOURCE_MISSING and its claims
   * are recomputed; source-level evidence (same excerpt, same section — e.g. an
   * article's canonical metadata seen by two captures) moves to a remaining
   * path. Nothing is deleted.
   */
  invalidateSourceRef(sourceRefId, { reason = '' } = {}) {
    return this.transaction(() => {
      const ref = this.getSourceRef(sourceRefId);
      if (!ref) throw new Error(`Source ref ${sourceRefId} not found`);
      const now = nowIso();
      this.prepare("UPDATE kg_source_refs SET status = 'INVALIDATED', invalidated_at = ?, updated_at = ?, provenance = ? WHERE source_ref_id = ?")
        .run(now, now, boundedProvenance({ ...ref.provenance, ...(reason ? { invalidation_reason: String(reason).slice(0, 300) } : {}) }), sourceRefId);
      const survivor = this.prepare("SELECT source_ref_id FROM kg_source_refs WHERE source_id = ? AND status = 'ACTIVE' ORDER BY observed_at DESC, source_ref_id LIMIT 1").get(ref.source_id);
      const remaining = this.prepare("SELECT COUNT(*) AS n FROM kg_source_refs WHERE source_id = ? AND status = 'ACTIVE'").get(ref.source_id).n;
      if (remaining > 0) {
        const own = this.prepare("SELECT evidence_id, chunk_id, message_id FROM kg_evidence WHERE source_ref_id = ? AND status = 'ACTIVE'").all(sourceRefId);
        const located = own.filter(e => e.chunk_id || e.message_id).map(e => e.evidence_id);
        const sourceLevel = own.filter(e => !e.chunk_id && !e.message_id).map(e => e.evidence_id);
        for (const id of sourceLevel) this.prepare('UPDATE kg_evidence SET source_ref_id = ?, updated_at = ? WHERE evidence_id = ?').run(survivor.source_ref_id, now, id);
        const marked = this.invalidateEvidence(located, { status: 'SOURCE_MISSING', reason: reason || 'technical provenance removed' });
        // KG-8: a relation seen through THAT path loses that provenance (it is not moved: it was read in that document)
        const relationProvenance = this.prepare("UPDATE kg_relationship_provenance SET status = 'INVALIDATED', invalidated_at = ?, updated_at = ? WHERE source_ref_id = ? AND status = 'ACTIVE'")
          .run(now, now, sourceRefId).changes;
        return { sourceRefId, sourceId: ref.source_id, sourceStillActive: true, remainingRefs: remaining, evidenceMoved: sourceLevel.length, evidenceMarked: located.length, relationProvenanceInvalidated: relationProvenance, ...marked };
      }
      const result = this.invalidateSource(ref.source_id, { status: 'DELETED', reason: reason || 'last technical provenance removed' });
      return { sourceRefId, sourceId: ref.source_id, sourceStillActive: false, remainingRefs: 0, source: result };
    });
  }

  /**
   * Marks evidence as no longer usable (kept, never deleted) and recomputes the
   * claims it was supporting — e.g. chunks of a superseded document version.
   */
  invalidateEvidence(evidenceIds, { status = 'INVALIDATED', reason = '' } = {}) {
    if (!['INVALIDATED', 'SOURCE_MISSING'].includes(status)) throw new Error(`Invalid evidence status: ${status}`);
    const ids = [...new Set((evidenceIds ?? []).filter(id => typeof id === 'string'))];
    if (ids.length === 0) return { evidenceInvalidated: 0, claimsRecomputed: 0, claimsInvalidated: 0, claimStatuses: {} };
    return this.transaction(() => {
      const now = nowIso();
      let changed = 0;
      for (const id of ids) {
        const row = this.prepare('SELECT metadata FROM kg_evidence WHERE evidence_id = ? AND status = ?').get(id, 'ACTIVE');
        if (!row) continue;
        const metadata = { ...parseJson(row.metadata, {}), ...(reason ? { invalidation_reason: String(reason).slice(0, 300) } : {}) };
        changed += this.prepare('UPDATE kg_evidence SET status = ?, is_active = 0, updated_at = ?, metadata = ? WHERE evidence_id = ?').run(status, now, JSON.stringify(metadata), id).changes;
      }
      return { evidenceInvalidated: changed, ...this.recomputeClaimsForEvidence(ids) };
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // IDENTIFIERS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Adds a stable identifier to an entity. Invalid values are refused (never
   * guessed). If the same identifier is already ACTIVE on another logical
   * entity, the new row is stored as CONFLICT — never merged here.
   */
  addIdentifier({ entity_id: entityId, scheme, value, source_id: sourceId = null, source_ref_id: sourceRefId = null, confidence = 1.0 }) {
    const entity = this.getEntity(entityId);
    if (!entity) throw new Error(`Entity ${entityId} not found`);
    const normalized = normalizeIdentifier(scheme, value);
    if (!normalized) throw new KgError('KG_IDENTIFIER_INVALID', `${scheme} identifier is not valid`);
    const id = hashId('kid', entityId, normalized.scheme, normalized.value);
    const existing = this.prepare('SELECT * FROM kg_entity_identifiers WHERE identifier_id = ?').get(id);
    if (existing) return { id, isNew: false, status: existing.status, scheme: normalized.scheme, value: normalized.value };
    const root = this.getLogicalRootId(entityId);
    const holders = this.findEntitiesByIdentifier(normalized.scheme, normalized.value).filter(h => h.logical_root_id !== root);
    const status = holders.length > 0 ? 'CONFLICT' : 'ACTIVE';
    const now = nowIso();
    this.prepare(`INSERT INTO kg_entity_identifiers
      (identifier_id, entity_id, scheme, normalized_value, original_value, source_id, source_ref_id, confidence, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, entityId, normalized.scheme, normalized.value, normalized.original, sourceId, sourceRefId, confidence, status, now, now);
    return { id, isNew: true, status, scheme: normalized.scheme, value: normalized.value, conflictsWith: holders.map(h => h.logical_root_id) };
  }

  /** Entities holding an ACTIVE identifier, with their logical root. */
  findEntitiesByIdentifier(scheme, value) {
    const normalized = normalizeIdentifier(scheme, value);
    if (!normalized) return [];
    return this.prepare(`
      SELECT e.*, i.identifier_id, i.status AS identifier_status FROM kg_entity_identifiers i
      JOIN kg_entities e ON e.entity_id = i.entity_id
      WHERE i.scheme = ? AND i.normalized_value = ? AND i.status = 'ACTIVE'
      ORDER BY e.created_at, e.entity_id
    `).all(normalized.scheme, normalized.value).map(row => ({ ...withMetadata(row), logical_root_id: this.getLogicalRootId(row.entity_id) }));
  }

  getIdentifiersForEntity(entityId) {
    return this.prepare('SELECT * FROM kg_entity_identifiers WHERE entity_id = ? ORDER BY scheme, normalized_value').all(entityId);
  }

  // ════════════════════════════════════════════════════════════════════════
  // ALIASES
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Upsert an alias. The same alias seen through two provenances is two rows
   * (each keeps its source). An alias never changes the canonical label.
   */
  upsertAlias(alias) {
    if (!alias?.alias || !String(alias.alias).trim()) throw new Error('Alias text is required');
    if (!alias.entity_id) throw new Error('Entity ID is required for alias');
    const status = alias.status ?? 'CONFIRMED';
    if (!KG_ALIAS_STATUSES.includes(status)) throw new Error(`Invalid alias status: ${status}`);
    if (!this.getEntity(alias.entity_id)) throw new Error(`Entity ${alias.entity_id} not found`);
    const original = String(alias.alias);
    const normalizedAlias = looseKey(original);
    const aliasId = alias.alias_id || hashId('als', alias.entity_id, normalizedAlias, alias.source_ref_id ?? '');
    const existing = this.prepare('SELECT alias_id FROM kg_aliases WHERE alias_id = ?').get(aliasId);
    const now = nowIso();
    this.prepare(`
      INSERT INTO kg_aliases (
        alias_id, entity_id, alias, alias_type, normalized_alias, alias_key,
        is_primary, source_id, source_ref_id, confidence, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias_id) DO UPDATE SET
        alias_type = excluded.alias_type,
        is_primary = excluded.is_primary,
        confidence = MAX(kg_aliases.confidence, excluded.confidence),
        status = CASE WHEN kg_aliases.status IN ('REJECTED', 'INVALIDATED') THEN kg_aliases.status ELSE excluded.status END,
        updated_at = excluded.updated_at
    `).run(
      aliasId, alias.entity_id, original, alias.alias_type || 'NAME', normalizedAlias, labelKey(original),
      alias.is_primary || 0, alias.source_id || null, alias.source_ref_id || null,
      alias.confidence !== undefined ? alias.confidence : 1.0, status,
      JSON.stringify(alias.metadata && typeof alias.metadata === 'object' ? alias.metadata : {}), now, now,
    );
    return { id: aliasId, normalizedAlias, isNew: !existing };
  }

  getAliasesForEntity(entityId, options = {}) {
    const limit = options.limit || 100;
    return this.prepare('SELECT * FROM kg_aliases WHERE entity_id = ? ORDER BY is_primary DESC, alias ASC LIMIT ?').all(entityId, limit).map(withMetadata);
  }

  /**
   * Entity by alias. An alias is not an identity: when several distinct
   * logical entities share it, `ambiguous` is true and all of them are listed.
   */
  findEntityByAlias(alias) {
    const normalizedAlias = normalizeString(alias);
    const rows = this.prepare(`
      SELECT a.alias_id, a.entity_id AS alias_entity_id, a.alias, a.alias_type, a.normalized_alias, a.is_primary,
             a.source_id AS alias_source_id, a.created_at AS alias_created_at, a.status AS alias_status, e.*
      FROM kg_aliases a JOIN kg_entities e ON a.entity_id = e.entity_id
      WHERE a.normalized_alias = ? AND a.status IN ('CONFIRMED', 'PROPOSED')
      ORDER BY a.is_primary DESC, e.created_at, e.entity_id
      LIMIT ?
    `).all(normalizedAlias, KG_DEFAULT_LIMITS.MAX_RESOLUTION_CANDIDATES);
    if (rows.length === 0) return null;
    const roots = [...new Set(rows.map(r => this.getLogicalRootId(r.entity_id)))];
    const row = rows[0];
    return {
      alias: {
        alias_id: row.alias_id,
        entity_id: row.alias_entity_id,
        alias: row.alias,
        alias_type: row.alias_type,
        normalized_alias: row.normalized_alias,
        is_primary: Boolean(row.is_primary),
        source_id: row.alias_source_id,
        status: row.alias_status,
        created_at: row.alias_created_at,
      },
      entity: this.getEntity(row.entity_id),
      ambiguous: roots.length > 1,
      candidateEntityIds: roots,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // CLAIMS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Low-level claim upsert (KG-2 API). A DERIVED claim (DETERMINISTIC or
   * MODEL_PROPOSAL) must come with evidence: it is only accepted here from
   * assertClaim (kg-claims.js), which attaches the evidence in the same
   * transaction (`pendingEvidence`).
   */
  upsertClaim(claim, { pendingEvidence = false } = {}) {
    const now = nowIso();
    if (!claim?.statement) throw new Error('Claim statement is required');
    if (!claim.entity_id) throw new Error('Entity ID is required for claim');
    if (!claim.claim_type || !KG_CLAIM_TYPES.includes(claim.claim_type)) {
      throw new Error(`Invalid claim type: ${claim.claim_type}. Must be one of: ${KG_CLAIM_TYPES.join(', ')}`);
    }
    const extractionMethod = claim.extraction_method ?? null;
    if (extractionMethod !== null && !KG_EXTRACTION_METHODS.includes(extractionMethod)) throw new Error(`Invalid extraction method: ${extractionMethod}`);
    if ((extractionMethod === 'DETERMINISTIC' || extractionMethod === 'MODEL_PROPOSAL') && !pendingEvidence) {
      throw new KgError('KG_EVIDENCE_REQUIRED', 'a derived claim needs evidence: use assertClaim');
    }
    // Only a claim the user wrote may exist without a source.
    if (!claim.source_id && extractionMethod !== 'USER') throw new Error('Source ID is required for claim');
    if (!this.getEntity(claim.entity_id)) throw new Error(`Entity ${claim.entity_id} not found`);
    if (claim.source_id && !this.getSource(claim.source_id)) throw new Error(`Source ${claim.source_id} not found`);
    if (claim.object_entity_id && !this.getEntity(claim.object_entity_id)) throw new Error(`Entity ${claim.object_entity_id} not found`);
    // A model output is a hypothesis until evidence says otherwise.
    const status = claim.status ?? (extractionMethod === 'MODEL_PROPOSAL' ? 'HYPOTHESIS' : 'ASSERTED');
    if (!KG_CLAIM_STATUSES.includes(status)) throw new Error(`Invalid claim status: ${status}`);
    const claimId = claim.claim_id || generateId('clm', `${claim.entity_id}:${claim.source_id ?? 'user'}:${claim.statement}`);
    const existing = this.prepare('SELECT claim_id FROM kg_claims WHERE claim_id = ?').get(claimId);
    const metadata = { ...(claim.metadata && typeof claim.metadata === 'object' ? claim.metadata : {}) };
    this.prepare(`
      INSERT INTO kg_claims (
        claim_id, entity_id, claim_type, statement, normalized_statement, predicate, object_entity_id, value_json,
        source_id, author_entity_id, status, extraction_method, model_confidence, source_confidence,
        observed_at, valid_from, valid_to, created_at, updated_at,
        version, is_active, is_verified, trust_level, confidence, polarity, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(claim_id) DO UPDATE SET
        claim_type = excluded.claim_type,
        statement = excluded.statement,
        normalized_statement = excluded.normalized_statement,
        predicate = excluded.predicate,
        object_entity_id = excluded.object_entity_id,
        value_json = excluded.value_json,
        author_entity_id = excluded.author_entity_id,
        model_confidence = excluded.model_confidence,
        source_confidence = excluded.source_confidence,
        observed_at = COALESCE(kg_claims.observed_at, excluded.observed_at),
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        updated_at = excluded.updated_at,
        version = version + 1,
        is_verified = excluded.is_verified,
        trust_level = excluded.trust_level,
        confidence = excluded.confidence,
        polarity = excluded.polarity,
        metadata = excluded.metadata
    `).run(
      claimId, claim.entity_id, claim.claim_type, claim.statement, normalizeString(claim.statement),
      claim.predicate ?? null, claim.object_entity_id ?? null,
      claim.value !== undefined ? JSON.stringify(claim.value) : (claim.value_json ?? null),
      claim.source_id ?? null, claim.author_entity_id || null, status, extractionMethod,
      claim.model_confidence ?? null, claim.source_confidence ?? null,
      claim.observed_at ?? now, claim.valid_from ?? null, claim.valid_to ?? null, now, now,
      claim.is_active !== undefined ? claim.is_active : (status === 'INVALIDATED' ? 0 : 1),
      claim.is_verified !== undefined ? claim.is_verified : 0,
      claim.trust_level || 'UNKNOWN', claim.confidence !== undefined ? claim.confidence : 0.0,
      claim.polarity || 'NEUTRAL', JSON.stringify(metadata),
    );
    return { id: claimId, normalizedStatement: normalizeString(claim.statement), isNew: !existing };
  }

  getClaim(claimId) {
    return withMetadata(this.prepare(`
      SELECT c.*,
             e.entity_type, e.name as entity_name, e.normalized_name as entity_normalized_name,
             s.source_type, s.name as source_name, s.uri as source_uri
      FROM kg_claims c
      LEFT JOIN kg_entities e ON c.entity_id = e.entity_id
      LEFT JOIN kg_sources s ON c.source_id = s.source_id
      WHERE c.claim_id = ?
    `).get(claimId));
  }

  getClaimsForEntity(entityId, options = {}) {
    const { limit = KG_DEFAULT_LIMITS.DEFAULT_EDGE_LIMIT, offset = 0, claimType, sourceId, isActive = true, isVerified } = options;
    if (limit > KG_DEFAULT_LIMITS.MAX_EDGES) throw new Error(`Limit too high: ${limit} > ${KG_DEFAULT_LIMITS.MAX_EDGES}`);
    const conditions = ['c.entity_id = ?'];
    const params = [entityId];
    if (claimType) { conditions.push('c.claim_type = ?'); params.push(claimType); }
    if (sourceId) { conditions.push('c.source_id = ?'); params.push(sourceId); }
    if (isActive !== undefined) { conditions.push('c.is_active = ?'); params.push(isActive ? 1 : 0); }
    if (isVerified !== undefined) { conditions.push('c.is_verified = ?'); params.push(isVerified ? 1 : 0); }
    return this.prepare(`
      SELECT c.*,
             e.entity_type, e.name as entity_name, e.normalized_name as entity_normalized_name,
             s.source_type, s.name as source_name, s.uri as source_uri, s.trust_level as source_trust_level
      FROM kg_claims c
      LEFT JOIN kg_entities e ON c.entity_id = e.entity_id
      LEFT JOIN kg_sources s ON c.source_id = s.source_id
      WHERE ${conditions.join(' AND ')} ORDER BY c.created_at DESC, c.claim_id LIMIT ? OFFSET ?
    `).all(...params, limit, offset).map(withMetadata);
  }

  getClaimsBySource(sourceId, options = {}) {
    const { limit = KG_DEFAULT_LIMITS.DEFAULT_EDGE_LIMIT, offset = 0, entityId, claimType, isActive = true } = options;
    if (limit > KG_DEFAULT_LIMITS.MAX_EDGES) throw new Error(`Limit too high: ${limit} > ${KG_DEFAULT_LIMITS.MAX_EDGES}`);
    const conditions = ['c.source_id = ?'];
    const params = [sourceId];
    if (entityId) { conditions.push('c.entity_id = ?'); params.push(entityId); }
    if (claimType) { conditions.push('c.claim_type = ?'); params.push(claimType); }
    if (isActive !== undefined) { conditions.push('c.is_active = ?'); params.push(isActive ? 1 : 0); }
    return this.prepare(`
      SELECT c.*,
             e.entity_type, e.name as entity_name, e.normalized_name as entity_normalized_name,
             s.source_type, s.name as source_name
      FROM kg_claims c
      LEFT JOIN kg_entities e ON c.entity_id = e.entity_id
      LEFT JOIN kg_sources s ON c.source_id = s.source_id
      WHERE ${conditions.join(' AND ')} ORDER BY c.created_at DESC, c.claim_id LIMIT ? OFFSET ?
    `).all(...params, limit, offset).map(withMetadata);
  }

  searchClaims(query, options = {}) {
    const { entityId, sourceId, claimType, limit = KG_DEFAULT_LIMITS.DEFAULT_SEARCH_LIMIT, offset = 0 } = options;
    if (limit > KG_DEFAULT_LIMITS.MAX_EDGES) throw new Error(`Limit too high: ${limit} > ${KG_DEFAULT_LIMITS.MAX_EDGES}`);
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return { claims: [], count: 0, limit, offset };
    const conditions = [];
    const params = [];
    if (entityId) { conditions.push('c.entity_id = ?'); params.push(entityId); }
    if (sourceId) { conditions.push('c.source_id = ?'); params.push(sourceId); }
    if (claimType) { conditions.push('c.claim_type = ?'); params.push(claimType); }
    const rows = this.prepare(`
      SELECT c.*, e.entity_type, e.name as entity_name, s.source_type, s.name as source_name
      FROM kg_claims_fts fts
      JOIN kg_claims c ON fts.claim_id = c.claim_id
      LEFT JOIN kg_entities e ON c.entity_id = e.entity_id
      LEFT JOIN kg_sources s ON c.source_id = s.source_id
      WHERE kg_claims_fts MATCH ? ${conditions.length ? `AND ${conditions.join(' AND ')}` : ''}
      ORDER BY rank LIMIT ? OFFSET ?
    `).all(ftsQuery, ...params, limit, offset);
    return { claims: rows.map(withMetadata), count: rows.length, limit, offset };
  }

  /**
   * Claim status from its ACTIVE evidence links. A claim that never had
   * evidence (e.g. written by the user) keeps its status. Model proposals
   * stay HYPOTHESIS even when supported.
   */
  /**
   * Claim status, derived — never chosen:
   *   SUPERSEDED  explicit, kept as history (never recomputed away);
   *   evidence    supports & contradicts → DISPUTED; supports → SUPPORTED
   *               (HYPOTHESIS for a model proposal); contradicts only → DISPUTED;
   *               every evidence lost → INVALIDATED;
   *   no evidence (user-written claim) → ASSERTED (HYPOTHESIS for a model proposal);
   *   conflicts   an ASSERTED/SUPPORTED claim with an OPEN conflict against a live
   *               claim (not INVALIDATED/SUPERSEDED) is DISPUTED. A model
   *               HYPOTHESIS stays HYPOTHESIS (the conflict is still recorded).
   * When the claim becomes (or stops being) live, the claims it conflicts with
   * are recomputed once.
   */
  recomputeClaimStatus(claimId, { propagate = true } = {}) {
    const claim = this.prepare('SELECT claim_id, status, extraction_method FROM kg_claims WHERE claim_id = ?').get(claimId);
    if (!claim) return null;
    if (claim.status === 'SUPERSEDED') return claim.status;
    const links = this.prepare(`
      SELECT ce.stance, ce.status AS link_status, ev.status AS evidence_status
      FROM kg_claim_evidence ce JOIN kg_evidence ev ON ev.evidence_id = ce.evidence_id
      WHERE ce.claim_id = ?
    `).all(claimId);
    const hypothesis = claim.extraction_method === 'MODEL_PROPOSAL';
    let next;
    if (links.length === 0) {
      // a KG-2 claim that was already inactive stays INVALIDATED
      next = claim.status === 'INVALIDATED' ? 'INVALIDATED' : (hypothesis ? 'HYPOTHESIS' : 'ASSERTED');
    } else {
      const active = links.filter(l => l.link_status === 'ACTIVE' && l.evidence_status === 'ACTIVE');
      const supports = active.filter(l => l.stance === 'SUPPORTS').length;
      const contradicts = active.filter(l => l.stance === 'CONTRADICTS').length;
      if (supports > 0 && contradicts > 0) next = 'DISPUTED';
      else if (supports > 0) next = hypothesis ? 'HYPOTHESIS' : 'SUPPORTED';
      else if (contradicts > 0) next = 'DISPUTED';
      else next = 'INVALIDATED';
    }
    if (next === 'ASSERTED' || next === 'SUPPORTED') {
      const openConflict = this.prepare(`
        SELECT 1 FROM kg_claim_conflicts k
        JOIN kg_claims other ON other.claim_id = CASE WHEN k.claim_a_id = ? THEN k.claim_b_id ELSE k.claim_a_id END
        WHERE (k.claim_a_id = ? OR k.claim_b_id = ?) AND k.status = 'OPEN' AND other.status NOT IN ('INVALIDATED', 'SUPERSEDED')
        LIMIT 1
      `).get(claimId, claimId, claimId);
      if (openConflict) next = 'DISPUTED';
    }
    if (next !== claim.status) {
      this.prepare('UPDATE kg_claims SET status = ?, is_active = ?, updated_at = ? WHERE claim_id = ?')
        .run(next, next === 'INVALIDATED' ? 0 : 1, nowIso(), claimId);
      const wasLive = !['INVALIDATED', 'SUPERSEDED'].includes(claim.status);
      const isLive = next !== 'INVALIDATED';
      if (propagate && wasLive !== isLive) this.recomputeConflictCounterparts(claimId);
    }
    return next;
  }

  /** Recomputes (once, no further propagation) the claims in conflict with `claimId`. */
  recomputeConflictCounterparts(claimId) {
    const others = this.prepare(`SELECT CASE WHEN claim_a_id = ? THEN claim_b_id ELSE claim_a_id END AS id
      FROM kg_claim_conflicts WHERE claim_a_id = ? OR claim_b_id = ?`).all(claimId, claimId, claimId);
    for (const o of others) this.recomputeClaimStatus(o.id, { propagate: false });
    return others.length;
  }

  recomputeClaimsForEvidence(evidenceIds) {
    if (evidenceIds.length === 0) return { claimsRecomputed: 0, claimsInvalidated: 0, claimStatuses: {} };
    const claimIds = new Set();
    const select = this.prepare('SELECT claim_id FROM kg_claim_evidence WHERE evidence_id = ?');
    for (const id of evidenceIds) for (const r of select.all(id)) claimIds.add(r.claim_id);
    const claimStatuses = {};
    for (const id of claimIds) claimStatuses[id] = this.recomputeClaimStatus(id);
    return {
      claimsRecomputed: claimIds.size,
      claimsInvalidated: Object.values(claimStatuses).filter(s => s === 'INVALIDATED').length,
      claimStatuses,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // EVIDENCE (claims ↔ evidence is N:N)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Upsert a localisable proof. Its identity is (source, locator, excerpt) —
   * independent of any claim — so the same excerpt supporting two claims is
   * ONE evidence with two links. Only a bounded preview is stored (the full
   * text stays in the original store); `claim_id`, when given, is attached
   * through kg_claim_evidence.
   */
  upsertEvidence(evidence) {
    if (!evidence?.content) throw new Error('Evidence content is required');
    if (!evidence.source_id) throw new Error('Source ID is required for evidence');
    if (!evidence.evidence_type || !KG_EVIDENCE_TYPES.includes(evidence.evidence_type)) {
      throw new Error(`Invalid evidence type: ${evidence.evidence_type}. Must be one of: ${KG_EVIDENCE_TYPES.join(', ')}`);
    }
    const locatorKind = evidence.locator_kind ?? 'SOURCE';
    if (!KG_LOCATOR_KINDS.includes(locatorKind)) throw new Error(`Invalid locator kind: ${locatorKind}`);
    const source = this.getSource(evidence.source_id);
    if (!source) throw new Error(`Source ${evidence.source_id} not found`);
    if (evidence.claim_id && !this.getClaim(evidence.claim_id)) throw new Error(`Claim ${evidence.claim_id} not found`);
    if (evidence.source_ref_id) {
      const ref = this.getSourceRef(evidence.source_ref_id);
      if (!ref || ref.source_id !== evidence.source_id) throw new Error(`Source ref ${evidence.source_ref_id} does not belong to source ${evidence.source_id}`);
    }
    const content = String(evidence.content);
    if (!content.trim()) throw new KgError('KG_EVIDENCE_INVALID', 'evidence excerpt is empty');
    const locator = validateLocator(locatorKind, evidence);
    const hash = excerptHash(content);
    const preview = content.length > KG_DEFAULT_LIMITS.MAX_EVIDENCE_PREVIEW_CHARS
      ? `${content.slice(0, KG_DEFAULT_LIMITS.MAX_EVIDENCE_PREVIEW_CHARS)}…` : content;
    const locatorRef = evidence.locator_ref ?? evidence.chunk_id ?? evidence.message_id ?? (evidence.page != null ? `page:${evidence.page}` : null);
    const evidenceId = evidence.evidence_id || hashId('evd', evidence.source_id, locatorKind, locatorRef ?? '', locator.page ?? '', evidence.section ?? '',
      locator.charStart ?? '', locator.charEnd ?? '', hash);
    const existing = this.prepare('SELECT evidence_id FROM kg_evidence WHERE evidence_id = ?').get(evidenceId);
    const now = nowIso();
    const metadata = { ...(evidence.metadata && typeof evidence.metadata === 'object' ? evidence.metadata : {}), ...(preview !== content ? { preview_truncated: true } : {}) };
    this.transaction(() => {
      this.prepare(`
        INSERT INTO kg_evidence (
          evidence_id, claim_id, evidence_type, content, normalized_content, source_id, source_ref_id,
          locator_kind, locator_ref, chunk_id, message_id, page, section, char_start, char_end, excerpt_hash,
          extracted_from, relevance_score, status, created_at, updated_at,
          version, is_active, trust_level, confidence, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(evidence_id) DO UPDATE SET
          claim_id = COALESCE(kg_evidence.claim_id, excluded.claim_id),
          evidence_type = excluded.evidence_type,
          source_ref_id = COALESCE(excluded.source_ref_id, kg_evidence.source_ref_id),
          extracted_from = excluded.extracted_from,
          relevance_score = excluded.relevance_score,
          updated_at = excluded.updated_at,
          version = version + 1,
          trust_level = excluded.trust_level,
          confidence = excluded.confidence,
          metadata = excluded.metadata
      `).run(
        evidenceId, evidence.claim_id ?? null, evidence.evidence_type, preview, normalizeString(preview), evidence.source_id,
        evidence.source_ref_id ?? null, locatorKind, locatorRef, evidence.chunk_id ?? null, evidence.message_id ?? null,
        locator.page, evidence.section ?? null, locator.charStart, locator.charEnd, hash, evidence.extracted_from || null,
        evidence.relevance_score !== undefined ? evidence.relevance_score : 0.0,
        source.status === 'ACTIVE' ? 'ACTIVE' : 'SOURCE_MISSING', now, now,
        source.status === 'ACTIVE' ? 1 : 0,
        evidence.trust_level || 'UNKNOWN', evidence.confidence !== undefined ? evidence.confidence : 0.0, JSON.stringify(metadata),
      );
      if (evidence.claim_id) this.attachEvidence(evidence.claim_id, evidenceId, { stance: evidence.stance ?? stanceFromEvidenceType(evidence.evidence_type) });
    });
    return { id: evidenceId, normalizedContent: normalizeString(preview), excerptHash: hash, isNew: !existing };
  }

  /** Links a claim and an evidence (idempotent); re-attaching a DETACHED link reactivates it. */
  attachEvidence(claimId, evidenceId, { stance = 'SUPPORTS' } = {}) {
    if (!KG_STANCES.includes(stance)) throw new Error(`Invalid stance: ${stance}`);
    if (!this.prepare('SELECT 1 FROM kg_claims WHERE claim_id = ?').get(claimId)) throw new Error(`Claim ${claimId} not found`);
    if (!this.prepare('SELECT 1 FROM kg_evidence WHERE evidence_id = ?').get(evidenceId)) throw new Error(`Evidence ${evidenceId} not found`);
    this.prepare(`INSERT INTO kg_claim_evidence (claim_id, evidence_id, stance, status, attached_at) VALUES (?, ?, ?, 'ACTIVE', ?)
      ON CONFLICT(claim_id, evidence_id) DO UPDATE SET stance = excluded.stance, status = 'ACTIVE', detached_at = NULL`)
      .run(claimId, evidenceId, stance, nowIso());
    const status = this.recomputeClaimStatus(claimId);
    return { claimId, evidenceId, stance, claimStatus: status };
  }

  /** Detaches (never deletes) a claim ↔ evidence link and recomputes the claim. */
  detachEvidence(claimId, evidenceId) {
    const changes = this.prepare("UPDATE kg_claim_evidence SET status = 'DETACHED', detached_at = ? WHERE claim_id = ? AND evidence_id = ? AND status = 'ACTIVE'")
      .run(nowIso(), claimId, evidenceId).changes;
    return { detached: changes > 0, claimStatus: this.recomputeClaimStatus(claimId) };
  }

  getEvidence(evidenceId) {
    return withMetadata(this.prepare(`
      SELECT e.*, s.source_type, s.name as source_name, s.uri as source_uri, s.status as source_status
      FROM kg_evidence e
      LEFT JOIN kg_sources s ON e.source_id = s.source_id
      WHERE e.evidence_id = ?
    `).get(evidenceId));
  }

  /** Evidence linked to a claim through kg_claim_evidence (with stance). */
  getEvidenceForClaim(claimId, options = {}) {
    const { limit = KG_DEFAULT_LIMITS.DEFAULT_EVIDENCE_LIMIT, offset = 0, evidenceType, sourceId, isActive = true, minRelevance, includeDetached = false } = options;
    if (limit > KG_DEFAULT_LIMITS.MAX_EDGES) throw new Error(`Limit too high: ${limit} > ${KG_DEFAULT_LIMITS.MAX_EDGES}`);
    const conditions = ['ce.claim_id = ?'];
    const params = [claimId];
    if (!includeDetached) conditions.push("ce.status = 'ACTIVE'");
    if (evidenceType) { conditions.push('e.evidence_type = ?'); params.push(evidenceType); }
    if (sourceId) { conditions.push('e.source_id = ?'); params.push(sourceId); }
    if (isActive !== undefined) { conditions.push('e.is_active = ?'); params.push(isActive ? 1 : 0); }
    if (minRelevance !== undefined) { conditions.push('e.relevance_score >= ?'); params.push(minRelevance); }
    return this.prepare(`
      SELECT e.*, ce.claim_id AS linked_claim_id, ce.stance, ce.status AS link_status, ce.attached_at,
             c.statement as claim_statement, c.claim_type, c.entity_id as claim_entity_id,
             s.source_type, s.name as source_name, s.uri as source_uri
      FROM kg_claim_evidence ce
      JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
      JOIN kg_claims c ON c.claim_id = ce.claim_id
      LEFT JOIN kg_sources s ON e.source_id = s.source_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.relevance_score DESC, e.created_at DESC, e.evidence_id
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset).map(withMetadata);
  }

  getClaimsForEvidence(evidenceId) {
    return this.prepare(`
      SELECT c.*, ce.stance, ce.status AS link_status FROM kg_claim_evidence ce JOIN kg_claims c ON c.claim_id = ce.claim_id
      WHERE ce.evidence_id = ? ORDER BY c.claim_id
    `).all(evidenceId).map(withMetadata);
  }

  // ════════════════════════════════════════════════════════════════════════
  // RESOLUTION LEDGER (decisions live in kg-resolution.js)
  // ════════════════════════════════════════════════════════════════════════

  insertResolution(r) {
    if (!KG_RESOLUTION_DECISIONS.includes(r.decision)) throw new Error(`Invalid resolution decision: ${r.decision}`);
    if (!KG_RESOLUTION_METHODS.includes(r.method)) throw new Error(`Invalid resolution method: ${r.method}`);
    const id = r.resolution_id ?? `res_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
    const now = nowIso();
    this.prepare(`INSERT INTO kg_entity_resolutions (
        resolution_id, source_entity_id, target_entity_id, decision, method, reason, confidence, signals,
        source_id, source_ref_id, actor, previous_status, previous_merged_into_id, created_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, r.source_entity_id, r.target_entity_id, r.decision, r.method, String(r.reason ?? '').slice(0, 1000),
        r.confidence ?? null, JSON.stringify(r.signals ?? {}), r.source_id ?? null, r.source_ref_id ?? null,
        r.actor ?? 'SYSTEM', r.previous_status ?? null, r.previous_merged_into_id ?? null, now,
        r.decision === 'PROPOSED' ? null : now);
    return id;
  }

  getResolution(resolutionId) {
    const row = this.prepare('SELECT * FROM kg_entity_resolutions WHERE resolution_id = ?').get(resolutionId);
    return row ? { ...row, signals: parseJson(row.signals, {}) } : null;
  }

  listResolutions(entityId, { decision } = {}) {
    return this.prepare(`
      SELECT * FROM kg_entity_resolutions
      WHERE (source_entity_id = ? OR target_entity_id = ?) ${decision ? 'AND decision = ?' : ''}
      ORDER BY created_at, resolution_id LIMIT ?
    `).all(...[entityId, entityId, ...(decision ? [decision] : []), KG_DEFAULT_LIMITS.DEFAULT_NODE_LIMIT])
      .map(row => ({ ...row, signals: parseJson(row.signals, {}) }));
  }

  // ════════════════════════════════════════════════════════════════════════
  // RELATIONSHIPS / TRAVERSAL (KG-2, unchanged semantics)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * KG-8: a relation records WHERE it was seen. `source_ref_id` (technical
   * path, e.g. one Notebook document) is the provenance that scopes it; the
   * logical `source_id` alone is coarser (a document shared by two notebooks is
   * ONE logical source). Each (source, ref) asserting the relation adds a
   * kg_relationship_provenance row; visibility is decided per provenance.
   */
  upsertRelationship(relationship, { recordProvenance = true } = {}) {
    const now = nowIso();
    if (!relationship?.source_entity_id) throw new Error('Source entity ID is required');
    if (!relationship.target_entity_id) throw new Error('Target entity ID is required');
    if (!relationship.relationship_type || !KG_RELATIONSHIP_TYPES.includes(relationship.relationship_type)) {
      throw new Error(`Invalid relationship type: ${relationship.relationship_type}. Must be one of: ${KG_RELATIONSHIP_TYPES.join(', ')}`);
    }
    if (!this.getEntity(relationship.source_entity_id)) throw new Error(`Source entity ${relationship.source_entity_id} not found`);
    if (!this.getEntity(relationship.target_entity_id)) throw new Error(`Target entity ${relationship.target_entity_id} not found`);
    let sourceId = relationship.source_id || null;
    const sourceRefId = relationship.source_ref_id || null;
    if (sourceRefId) {
      const ref = this.getSourceRef(sourceRefId);
      if (!ref) throw new Error(`Source ref ${sourceRefId} not found`);
      if (sourceId && ref.source_id !== sourceId) throw new KgError('KG_SOURCE_REF_MISMATCH', `source ref ${sourceRefId} does not belong to source ${sourceId}`);
      sourceId = ref.source_id;
    }
    if (sourceId && !this.getSource(sourceId)) throw new Error(`Source ${sourceId} not found`);
    const relationshipId = relationship.relationship_id
      || generateId('rel', `${relationship.source_entity_id}:${relationship.relationship_type}:${relationship.target_entity_id}`);
    const existing = this.prepare('SELECT relationship_id FROM kg_relationships WHERE relationship_id = ?').get(relationshipId);
    this.prepare(`
      INSERT INTO kg_relationships (
        relationship_id, source_entity_id, target_entity_id, relationship_type,
        created_at, updated_at, version, is_active, is_verified,
        trust_level, confidence, source_id, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relationship_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        version = version + 1,
        is_active = excluded.is_active,
        is_verified = excluded.is_verified,
        trust_level = excluded.trust_level,
        confidence = excluded.confidence,
        source_id = COALESCE(excluded.source_id, kg_relationships.source_id),
        metadata = excluded.metadata
    `).run(
      relationshipId, relationship.source_entity_id, relationship.target_entity_id, relationship.relationship_type,
      now, now,
      relationship.is_active !== undefined ? relationship.is_active : 1,
      relationship.is_verified !== undefined ? relationship.is_verified : 0,
      relationship.trust_level || 'UNKNOWN',
      relationship.confidence !== undefined ? relationship.confidence : 0.0,
      sourceId,
      relationship.metadata ? JSON.stringify(relationship.metadata) : '{}',
    );
    const provenanceId = sourceId && recordProvenance ? this.addRelationshipProvenance(relationshipId, sourceId, sourceRefId, now) : null;
    return { id: relationshipId, isNew: !existing, provenanceId };
  }

  /** One provenance of a relation (idempotent; asserting it again re-activates it). */
  addRelationshipProvenance(relationshipId, sourceId, sourceRefId = null, now = nowIso()) {
    const provenanceId = relationshipProvenanceId(relationshipId, sourceId, sourceRefId);
    this.prepare(`INSERT INTO kg_relationship_provenance (provenance_id, relationship_id, source_id, source_ref_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
      ON CONFLICT(provenance_id) DO UPDATE SET status = 'ACTIVE', invalidated_at = NULL, updated_at = excluded.updated_at`)
      .run(provenanceId, relationshipId, sourceId, sourceRefId, now, now);
    return provenanceId;
  }

  getRelationshipProvenance(relationshipId) {
    return this.prepare('SELECT * FROM kg_relationship_provenance WHERE relationship_id = ? ORDER BY created_at, provenance_id').all(relationshipId);
  }

  getNeighbors(entityId, options = {}) {
    const { relationshipType, direction = 'both', limit = KG_DEFAULT_LIMITS.DEFAULT_NODE_LIMIT, offset = 0, isActive = true } = options;
    if (limit > KG_DEFAULT_LIMITS.MAX_NODES) throw new Error(`Limit too high: ${limit} > ${KG_DEFAULT_LIMITS.MAX_NODES}`);
    const conditions = [];
    const params = [];
    if (relationshipType) { conditions.push('r.relationship_type = ?'); params.push(relationshipType); }
    if (isActive !== undefined) { conditions.push('r.is_active = ?'); params.push(isActive ? 1 : 0); }
    const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    const select = `
      e.entity_id, e.entity_type, e.name, e.normalized_name, e.description,
      e.is_active, e.is_verified, e.trust_level, e.confidence, e.status,
      r.relationship_id, r.relationship_type, r.is_verified as relationship_verified,
      r.trust_level as relationship_trust, r.confidence as relationship_confidence`;
    let query;
    if (direction === 'outgoing') {
      query = `SELECT ${select}, 'outgoing' as direction FROM kg_relationships r JOIN kg_entities e ON r.target_entity_id = e.entity_id
        WHERE r.source_entity_id = ? ${whereClause} ORDER BY e.name ASC, e.entity_id LIMIT ? OFFSET ?`;
      params.unshift(entityId);
    } else if (direction === 'incoming') {
      query = `SELECT ${select}, 'incoming' as direction FROM kg_relationships r JOIN kg_entities e ON r.source_entity_id = e.entity_id
        WHERE r.target_entity_id = ? ${whereClause} ORDER BY e.name ASC, e.entity_id LIMIT ? OFFSET ?`;
      params.unshift(entityId);
    } else {
      query = `SELECT ${select}, CASE WHEN r.source_entity_id = ? THEN 'outgoing' ELSE 'incoming' END as direction
        FROM kg_relationships r
        JOIN kg_entities e ON (r.target_entity_id = e.entity_id AND r.source_entity_id = ?) OR (r.source_entity_id = e.entity_id AND r.target_entity_id = ?)
        WHERE 1 = 1 ${whereClause} ORDER BY e.name ASC, e.entity_id LIMIT ? OFFSET ?`;
      params.unshift(entityId, entityId, entityId);
    }
    const rows = this.prepare(query).all(...params, limit, offset);
    return { neighbors: rows, count: rows.length, limit, offset };
  }

  getRelationships(entityId, options = {}) {
    const { direction = 'both', limit = KG_DEFAULT_LIMITS.DEFAULT_EDGE_LIMIT, offset = 0, isActive = true } = options;
    if (limit > KG_DEFAULT_LIMITS.MAX_EDGES) throw new Error(`Limit too high: ${limit} > ${KG_DEFAULT_LIMITS.MAX_EDGES}`);
    const activeClause = isActive !== undefined ? 'AND r.is_active = ?' : '';
    const activeParams = isActive !== undefined ? [isActive ? 1 : 0] : [];
    let where;
    let params;
    if (direction === 'outgoing') { where = 'r.source_entity_id = ?'; params = [entityId]; }
    else if (direction === 'incoming') { where = 'r.target_entity_id = ?'; params = [entityId]; }
    else { where = '(r.source_entity_id = ? OR r.target_entity_id = ?)'; params = [entityId, entityId]; }
    const rows = this.prepare(`
      SELECT r.*,
             e_source.name as source_name, e_source.entity_type as source_type,
             e_target.name as target_name, e_target.entity_type as target_type
      FROM kg_relationships r
      JOIN kg_entities e_source ON r.source_entity_id = e_source.entity_id
      JOIN kg_entities e_target ON r.target_entity_id = e_target.entity_id
      WHERE ${where} ${activeClause}
      ORDER BY r.created_at DESC, r.relationship_id LIMIT ? OFFSET ?
    `).all(...params, ...activeParams, limit, offset);
    return { relationships: rows.map(withMetadata), count: rows.length, limit, offset };
  }

  getSubgraph(entityId, options = {}) {
    const {
      depth = KG_DEFAULT_LIMITS.DEFAULT_DEPTH,
      maxNodes = KG_DEFAULT_LIMITS.MAX_NODES,
      maxEdges = KG_DEFAULT_LIMITS.MAX_EDGES,
      relationshipTypes = null,
      isActive = true,
    } = options;
    if (depth > KG_DEFAULT_LIMITS.MAX_DEPTH) throw new Error(`Depth too high: ${depth} > ${KG_DEFAULT_LIMITS.MAX_DEPTH}`);
    if (maxNodes > KG_DEFAULT_LIMITS.MAX_NODES) throw new Error(`Max nodes too high: ${maxNodes} > ${KG_DEFAULT_LIMITS.MAX_NODES}`);
    if (maxEdges > KG_DEFAULT_LIMITS.MAX_EDGES) throw new Error(`Max edges too high: ${maxEdges} > ${KG_DEFAULT_LIMITS.MAX_EDGES}`);
    const startTime = Date.now();
    const visited = new Set([entityId]);
    const queue = [{ id: entityId, distance: 0 }];
    const nodes = [];
    const edges = [];
    const seenEdges = new Set();
    while (queue.length > 0 && nodes.length < maxNodes && edges.length < maxEdges) {
      const current = queue.shift();
      if (Date.now() - startTime > KG_DEFAULT_LIMITS.MAX_EXECUTION_TIME_MS) throw new Error('Subgraph traversal timeout');
      const node = this.getEntity(current.id);
      if (node) nodes.push({ id: node.entity_id, type: node.entity_type, name: node.name, status: node.status, distance: current.distance });
      if (current.distance >= depth) continue;
      const relationships = this.getRelationships(current.id, { isActive, limit: Math.max(1, maxEdges - edges.length) });
      for (const rel of relationships.relationships) {
        if (edges.length >= maxEdges) break;
        if (relationshipTypes && !relationshipTypes.includes(rel.relationship_type)) continue;
        if (seenEdges.has(rel.relationship_id)) continue;
        seenEdges.add(rel.relationship_id);
        edges.push({ id: rel.relationship_id, source: rel.source_entity_id, target: rel.target_entity_id, type: rel.relationship_type, confidence: rel.confidence, trust_level: rel.trust_level });
        for (const next of [rel.target_entity_id, rel.source_entity_id]) {
          if (!visited.has(next) && visited.size < maxNodes) {
            visited.add(next);
            queue.push({ id: next, distance: current.distance + 1 });
          }
        }
      }
    }
    return {
      nodes,
      edges,
      stats: { nodeCount: nodes.length, edgeCount: edges.length, depthReached: nodes.length ? Math.min(depth, Math.max(...nodes.map(n => n.distance))) : 0 },
      limits: { depth, maxNodes, maxEdges },
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // BATCH / STATS / INTEGRITY / EXPORT
  // ════════════════════════════════════════════════════════════════════════

  upsertEntitiesBatch(entities) {
    return this.transaction(() => entities.map(entity => this.upsertEntity(entity)));
  }

  upsertSourcesBatch(sources) {
    return this.transaction(() => sources.map(source => this.upsertSource(source)));
  }

  getStatistics() {
    const count = (table) => this.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
    const byColumn = (table, column) => Object.fromEntries(
      this.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`).all().map(r => [r.k, r.n]));
    return {
      entities: { total: count('kg_entities'), byType: byColumn('kg_entities', 'entity_type'), byStatus: byColumn('kg_entities', 'status') },
      sources: { total: count('kg_sources'), byType: byColumn('kg_sources', 'source_type'), byStatus: byColumn('kg_sources', 'status') },
      sourceRefs: { total: count('kg_source_refs'), byAdapter: byColumn('kg_source_refs', 'adapter') },
      identifiers: { total: count('kg_entity_identifiers'), byScheme: byColumn('kg_entity_identifiers', 'scheme') },
      claims: { total: count('kg_claims'), byType: byColumn('kg_claims', 'claim_type'), byStatus: byColumn('kg_claims', 'status') },
      evidence: { total: count('kg_evidence'), byType: byColumn('kg_evidence', 'evidence_type'), byStatus: byColumn('kg_evidence', 'status') },
      claimEvidence: { total: count('kg_claim_evidence'), byStance: byColumn('kg_claim_evidence', 'stance') },
      resolutions: { total: count('kg_entity_resolutions'), byDecision: byColumn('kg_entity_resolutions', 'decision') },
      conflicts: { total: count('kg_claim_conflicts'), byStatus: byColumn('kg_claim_conflicts', 'status') },
      relationships: { total: count('kg_relationships'), byType: byColumn('kg_relationships', 'relationship_type') },
      aliases: { total: count('kg_aliases') },
      schemaVersion: getSchemaVersion(this.db),
    };
  }

  getMigrationStatus() {
    return getMigrationStatus(this.db);
  }

  verifyIntegrity() {
    const errors = [];
    const warnings = [];
    const fk = this.db.pragma('foreign_key_check');
    if (fk.length > 0) errors.push(`Found ${fk.length} foreign key violation(s)`);
    const evidenceWithoutSource = this.prepare(`SELECT COUNT(*) AS n FROM kg_evidence e LEFT JOIN kg_sources s ON e.source_id = s.source_id WHERE s.source_id IS NULL`).get().n;
    if (evidenceWithoutSource > 0) errors.push(`Found ${evidenceWithoutSource} evidence item(s) without source`);
    const activeEvidenceOnDeadSource = this.prepare(`SELECT COUNT(*) AS n FROM kg_evidence e JOIN kg_sources s ON e.source_id = s.source_id WHERE s.status <> 'ACTIVE' AND e.status = 'ACTIVE'`).get().n;
    if (activeEvidenceOnDeadSource > 0) errors.push(`Found ${activeEvidenceOnDeadSource} ACTIVE evidence item(s) on an inactive source`);
    const mergedWithoutTarget = this.prepare(`SELECT COUNT(*) AS n FROM kg_entities WHERE status = 'MERGED' AND merged_into_id IS NULL`).get().n;
    if (mergedWithoutTarget > 0) errors.push(`Found ${mergedWithoutTarget} MERGED entit(y/ies) without redirect`);
    const mergedWithoutLedger = this.prepare(`SELECT COUNT(*) AS n FROM kg_entities e WHERE e.merged_into_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM kg_entity_resolutions r WHERE r.source_entity_id = e.entity_id AND r.target_entity_id = e.merged_into_id AND r.decision = 'CONFIRMED')`).get().n;
    if (mergedWithoutLedger > 0) errors.push(`Found ${mergedWithoutLedger} merge redirect(s) without a CONFIRMED ledger row`);
    for (const row of this.prepare("SELECT entity_id FROM kg_entities WHERE merged_into_id IS NOT NULL").all()) {
      try { this.getLogicalRootId(row.entity_id); } catch (error) { errors.push(`${row.entity_id}: ${error.message}`); }
    }
    // KG-4: a derived claim (deterministic or model) always has evidence; only a user-written claim may have none
    const derivedWithoutEvidence = this.prepare(`SELECT COUNT(*) AS n FROM kg_claims c WHERE c.extraction_method IN ('DETERMINISTIC', 'MODEL_PROPOSAL')
      AND NOT EXISTS (SELECT 1 FROM kg_claim_evidence ce WHERE ce.claim_id = c.claim_id)`).get().n;
    if (derivedWithoutEvidence > 0) errors.push(`Found ${derivedWithoutEvidence} derived claim(s) without evidence`);
    const modelPromoted = this.prepare("SELECT COUNT(*) AS n FROM kg_claims WHERE extraction_method = 'MODEL_PROPOSAL' AND status IN ('SUPPORTED', 'ASSERTED')").get().n;
    if (modelPromoted > 0) errors.push(`Found ${modelPromoted} model-proposed claim(s) promoted without stronger evidence`);
    const supersededWithoutTarget = this.prepare("SELECT COUNT(*) AS n FROM kg_claims WHERE status = 'SUPERSEDED' AND superseded_by_id IS NULL").get().n;
    if (supersededWithoutTarget > 0) errors.push(`Found ${supersededWithoutTarget} SUPERSEDED claim(s) without successor`);
    const supportedWithoutLiveEvidence = this.prepare(`SELECT COUNT(*) AS n FROM kg_claims c WHERE c.status = 'SUPPORTED'
      AND NOT EXISTS (SELECT 1 FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
                      WHERE ce.claim_id = c.claim_id AND ce.status = 'ACTIVE' AND ce.stance = 'SUPPORTS' AND e.status = 'ACTIVE')`).get().n;
    if (supportedWithoutLiveEvidence > 0) errors.push(`Found ${supportedWithoutLiveEvidence} SUPPORTED claim(s) without active supporting evidence`);
    const openClaimConflicts = this.prepare("SELECT COUNT(*) AS n FROM kg_claim_conflicts WHERE status = 'OPEN'").get().n;
    if (openClaimConflicts > 0) warnings.push(`${openClaimConflicts} open claim contradiction(s)`);
    const conflicts = this.prepare("SELECT COUNT(*) AS n FROM kg_entity_identifiers WHERE status = 'CONFLICT'").get().n;
    if (conflicts > 0) warnings.push(`${conflicts} identifier conflict(s) awaiting review`);
    const ambiguous = this.prepare("SELECT COUNT(*) AS n FROM kg_entities WHERE status = 'AMBIGUOUS'").get().n;
    if (ambiguous > 0) warnings.push(`${ambiguous} ambiguous entit(y/ies) awaiting resolution`);
    return { valid: errors.length === 0, errors, warnings, checkedAt: nowIso() };
  }

  exportData(options = {}) {
    const all = (table) => this.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const data = {};
    if (options.includeEntities !== false) data.entities = all('kg_entities').map(withMetadata);
    if (options.includeSources !== false) {
      data.sources = all('kg_sources').map(withMetadata);
      data.sourceRefs = all('kg_source_refs').map(r => ({ ...r, provenance: parseJson(r.provenance, {}) }));
    }
    if (options.includeIdentifiers !== false) data.identifiers = all('kg_entity_identifiers');
    if (options.includeClaims !== false) data.claims = all('kg_claims').map(withMetadata);
    if (options.includeEvidence !== false) {
      data.evidence = all('kg_evidence').map(withMetadata);
      data.claimEvidence = all('kg_claim_evidence');
    }
    if (options.includeRelationships !== false) {
      data.relationships = all('kg_relationships').map(withMetadata);
      data.relationshipProvenance = all('kg_relationship_provenance');
    }
    if (options.includeAliases !== false) data.aliases = all('kg_aliases').map(withMetadata);
    if (options.includeResolutions !== false) data.resolutions = all('kg_entity_resolutions').map(r => ({ ...r, signals: parseJson(r.signals, {}) }));
    if (options.includeClaims !== false) data.claimConflicts = all('kg_claim_conflicts').map(r => ({ ...r, signals: parseJson(r.signals, {}) }));
    data.metadata = { exportedAt: nowIso(), schemaVersion: getSchemaVersion(this.db), statistics: this.getStatistics() };
    return data;
  }

  /**
   * Additive, idempotent import of exported KG data. There is no "reset": a
   * graph is never emptied by an import (it is rebuilt from its sources).
   */
  importData(data, options = {}) {
    const { verbose = false } = options;
    if (options.reset) throw new KgError('KG_RESET_NOT_SUPPORTED', 'importData never clears the graph; it only adds or updates rows');
    const results = {};
    const run = (key, rows, fn) => {
      results[key] = { imported: 0, skipped: 0, failed: 0 };
      for (const row of rows ?? []) {
        try {
          const r = fn(row);
          if (r?.isNew) results[key].imported++;
          else results[key].skipped++;
        } catch (error) {
          results[key].failed++;
          if (verbose) console.warn(`KG import ${key}: ${error.message}`);
        }
      }
    };
    return this.transaction(() => {
      run('sources', data.sources, s => this.upsertSource(s));
      run('sourceRefs', data.sourceRefs, r => this.upsertSourceRef(r));
      run('entities', data.entities, e => this.upsertEntity({ ...e, status: e.status === 'MERGED' ? 'ACTIVE' : e.status }));
      run('identifiers', data.identifiers, i => {
        const exists = this.prepare('SELECT 1 FROM kg_entity_identifiers WHERE identifier_id = ?').get(i.identifier_id);
        if (exists) return { isNew: false };
        this.prepare(`INSERT INTO kg_entity_identifiers (identifier_id, entity_id, scheme, normalized_value, original_value, source_id, source_ref_id, confidence, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(i.identifier_id, i.entity_id, i.scheme, i.normalized_value, i.original_value, i.source_id, i.source_ref_id, i.confidence, i.status, i.created_at, i.updated_at);
        return { isNew: true };
      });
      run('aliases', data.aliases, a => this.upsertAlias(a));
      // evidence links of derived claims are attached below, in this same transaction
      run('claims', data.claims, c => this.upsertClaim(c, { pendingEvidence: true }));
      run('evidence', data.evidence, e => this.upsertEvidence({ ...e, claim_id: undefined }));
      run('claimEvidence', data.claimEvidence, l => {
        const exists = this.prepare('SELECT status FROM kg_claim_evidence WHERE claim_id = ? AND evidence_id = ?').get(l.claim_id, l.evidence_id);
        if (exists) return { isNew: false };
        this.attachEvidence(l.claim_id, l.evidence_id, { stance: l.stance });
        if (l.status === 'DETACHED') this.detachEvidence(l.claim_id, l.evidence_id);
        return { isNew: true };
      });
      // relation rows only (their provenance rows are imported exactly below)
      run('relationships', data.relationships, r => this.upsertRelationship({ ...r, source_ref_id: null }, { recordProvenance: !data.relationshipProvenance }));
      run('relationshipProvenance', data.relationshipProvenance, p => {
        if (this.prepare('SELECT 1 FROM kg_relationship_provenance WHERE provenance_id = ?').get(p.provenance_id)) return { isNew: false };
        this.prepare(`INSERT INTO kg_relationship_provenance (provenance_id, relationship_id, source_id, source_ref_id, status, created_at, updated_at, invalidated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.provenance_id, p.relationship_id, p.source_id, p.source_ref_id, p.status, p.created_at, p.updated_at, p.invalidated_at);
        return { isNew: true };
      });
      run('resolutions', data.resolutions, r => {
        if (this.getResolution(r.resolution_id)) return { isNew: false };
        this.prepare(`INSERT INTO kg_entity_resolutions (resolution_id, source_entity_id, target_entity_id, decision, method, reason, confidence, signals, source_id, source_ref_id, actor, previous_status, previous_merged_into_id, created_at, decided_at, reversed_at, reversal_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.resolution_id, r.source_entity_id, r.target_entity_id, r.decision, r.method, r.reason, r.confidence,
          JSON.stringify(r.signals ?? {}), r.source_id, r.source_ref_id, r.actor, r.previous_status, r.previous_merged_into_id, r.created_at, r.decided_at, r.reversed_at, r.reversal_reason);
        return { isNew: true };
      });
      run('claimConflicts', data.claimConflicts, k => {
        if (this.prepare('SELECT 1 FROM kg_claim_conflicts WHERE conflict_id = ?').get(k.conflict_id)) return { isNew: false };
        this.prepare(`INSERT INTO kg_claim_conflicts (conflict_id, claim_a_id, claim_b_id, kind, predicate, status, signals, detected_at, resolved_at, resolution)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(k.conflict_id, k.claim_a_id, k.claim_b_id, k.kind, k.predicate, k.status, JSON.stringify(k.signals ?? {}), k.detected_at, k.resolved_at, k.resolution);
        return { isNew: true };
      });
      // KG-4 claim identity, supersession and status exactly as exported
      for (const c of data.claims ?? []) {
        if (!this.prepare('SELECT 1 FROM kg_claims WHERE claim_id = ?').get(c.claim_id)) continue;
        this.prepare('UPDATE kg_claims SET claim_key = COALESCE(claim_key, ?), superseded_by_id = ?, status = ?, is_active = ? WHERE claim_id = ?')
          .run(c.claim_key ?? null, c.superseded_by_id ?? null, c.status, c.is_active, c.claim_id);
      }
      // Logical redirects are restored only where the ledger confirms them.
      for (const e of data.entities ?? []) {
        if (e.status !== 'MERGED' || !e.merged_into_id) continue;
        const confirmed = this.prepare("SELECT 1 FROM kg_entity_resolutions WHERE source_entity_id = ? AND target_entity_id = ? AND decision = 'CONFIRMED'").get(e.entity_id, e.merged_into_id);
        if (confirmed) this.prepare("UPDATE kg_entities SET status = 'MERGED', merged_into_id = ? WHERE entity_id = ?").run(e.merged_into_id, e.entity_id);
      }
      return results;
    });
  }
}

/** Exact location of an evidence inside its source; refuses an incomplete locator. */
function validateLocator(kind, e) {
  const int = (v, name, min) => {
    if (v === null || v === undefined) return null;
    if (!Number.isInteger(v) || v < min) throw new KgError('KG_EVIDENCE_INVALID', `${name} must be an integer >= ${min}`);
    return v;
  };
  const page = int(e.page ?? null, 'page', 1);
  const charStart = int(e.char_start ?? null, 'char_start', 0);
  const charEnd = int(e.char_end ?? null, 'char_end', 0);
  if (charEnd !== null && (charStart === null || charEnd < charStart)) throw new KgError('KG_EVIDENCE_INVALID', 'char_end needs char_start <= char_end');
  const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';
  const required = {
    PAGE: page !== null,
    CHUNK: has(e.chunk_id) || has(e.locator_ref),
    MESSAGE: has(e.message_id) || has(e.locator_ref),
    SECTION: has(e.section) || has(e.locator_ref),
    PARAGRAPH: has(e.locator_ref) || charStart !== null,
    SOURCE: true,
  };
  if (!required[kind]) throw new KgError('KG_EVIDENCE_INVALID', `a ${kind} locator needs its reference`);
  for (const [name, v] of [['locator_ref', e.locator_ref], ['chunk_id', e.chunk_id], ['message_id', e.message_id], ['section', e.section]]) {
    if (has(v) && String(v).length > 256) throw new KgError('KG_EVIDENCE_INVALID', `${name} is too long`);
  }
  return { page, charStart, charEnd };
}

function stanceFromEvidenceType(type) {
  return ['CONTRADICTING', 'REFUTED', 'DISPUTED'].includes(type) ? 'CONTRADICTS' : 'SUPPORTS';
}

/** User text → FTS5 query: every term quoted, no operator or column filter can be injected. */
export function toFtsQuery(query) {
  const terms = String(query ?? '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.slice(0, 16).map(t => `"${t}"`).join(' ');
}

export { entityTypesCompatible };
export default KnowledgeGraphStore;
