// Knowledge Graph V1 — SQLite schema (KG-2, realigned on the KG-1 contract in KG-3).
//
// Single source of truth for the KG table definitions: fresh installs
// (migration 001) and upgrades of an early KG-2 database (migration 005,
// table rebuild) both create the tables from the DDL below.
//
// Contract (reports/DOCTEUR_KNOWLEDGE_GRAPH_V1_2026-10.md):
//   kg_entities            entity; `name` is the canonical label (original form)
//   kg_entity_identifiers  stable identifiers, separate from aliases
//   kg_aliases             alternative labels with provenance / confidence / status
//   kg_sources             LOGICAL documentary source (e.g. one canonical article)
//   kg_source_refs         technical ingestion paths of a logical source
//   kg_claims              subject / predicate / object|value, status, temporality
//   kg_evidence            localisable proof inside a source (no full-text copy)
//   kg_claim_evidence      claims ↔ evidence, N:N, SUPPORTS | CONTRADICTS
//   kg_entity_resolutions  audited, reversible resolution ledger
//   kg_claim_conflicts     contradictions between claims (KG-4); both claims are kept
//   kg_relationships       entity ↔ entity edges (KG-2)
//   kg_relationship_provenance  where a relation was seen: logical source AND
//                          technical ref (KG-8); a relation is visible only
//                          through one of its provenances
//
// Non-destructive by construction: every foreign key is ON DELETE RESTRICT.
// A source is INVALIDATED, never deleted with its claims/evidence; a merge is
// a ledger row + logical redirect, never a DELETE. All tables are prefixed
// kg_ and never touch Notebook (nb_*, notebook_*) tables.

export const KG_SCHEMA_VERSION = '2.3.0';

export const KG_ENTITY_TYPES = [
  'PERSON', 'ORGANIZATION', 'LOCATION', 'CONCEPT', 'EVENT',
  'DOCUMENT', 'PROJECT', 'DEVICE', 'SOFTWARE', 'PROTOCOL',
  'THREAT', 'VULNERABILITY', 'TECHNIQUE', 'TOOL', 'FRAMEWORK',
  'STANDARD', 'LAW', 'REGULATION', 'COUNTRY', 'INDUSTRY',
  'TECHNOLOGY', 'PROCESS', 'METHODOLOGY', 'ARTEFACT',
  // KG-1 controlled set (KG-3)
  'PRODUCT', 'PLACE',
];

export const KG_SOURCE_TYPES = [
  'HUMAN', 'DOCUMENT', 'WEB', 'API', 'DATABASE', 'FEED',
  'REPORT', 'ARTICLE', 'BOOK', 'PAPER', 'PRESENTATION',
  'VIDEO', 'AUDIO', 'IMAGE', 'SOCIAL_MEDIA', 'EMAIL',
  'CHAT', 'INTERVIEW', 'SENSOR', 'LOG', 'ALERT',
  'INTELLIGENCE', 'LEGAL', 'FINANCIAL', 'TECHNICAL',
  'ACADEMIC', 'GOVERNMENT', 'INTERNAL', 'EXTERNAL',
];

export const KG_EVIDENCE_TYPES = [
  'DIRECT', 'INDIRECT', 'CIRCUMSTANTIAL', 'ANECDOTAL',
  'VERIFIED', 'UNVERIFIED', 'DISPUTED', 'REFUTED',
  'SUPPORTING', 'CONTRADICTING', 'CORROBORATING',
  'UNRELIABLE', 'HEARSAY',
];

export const KG_CLAIM_TYPES = [
  'FACT', 'HYPOTHESIS', 'THEORY', 'ALLEGATION', 'DENIAL',
  'CONFIRMATION', 'CLASSIFICATION', 'RELATIONSHIP', 'ATTRIBUTION',
  'CAUSATION', 'CORRELATION', 'PREDICTION', 'OBSERVATION',
  'ANALYSIS', 'INTERPRETATION', 'RECOMMENDATION', 'WARNING',
  'VULNERABILITY', 'EXPLOIT', 'IMPACT', 'MITIGATION', 'COUNTERMEASURE',
];

export const KG_RELATIONSHIP_TYPES = [
  'PART_OF', 'HAS_PART', 'CONTAINS', 'CONTAINED_IN',
  'OWNED_BY', 'OWNS', 'CONTROLS', 'CONTROLLED_BY',
  'CREATED_BY', 'CREATED', 'AUTHORED_BY', 'AUTHOR',
  'PUBLISHED_BY', 'PUBLISHER', 'DISTRIBUTED_BY', 'DISTRIBUTOR',
  'USES', 'USED_BY', 'IMPLEMENTS', 'IMPLEMENTED_BY',
  'DEPENDS_ON', 'DEPENDENCY', 'REQUIRES', 'REQUIRED_BY',
  'CONNECTED_TO', 'CONNECTION', 'COMMUNICATES_WITH', 'COMMUNICATION',
  'ASSOCIATED_WITH', 'ASSOCIATION', 'LINKED_TO', 'LINK',
  'RELATED_TO', 'RELATION', 'INFLUENCES', 'INFLUENCED_BY',
  'CAUSES', 'CAUSED_BY', 'RESULTS_IN', 'RESULT_OF',
  'PRECEDES', 'FOLLOWS', 'BEFORE', 'AFTER',
  'SIMILAR_TO', 'SIMILARITY', 'DIFFERENT_FROM', 'DIFFERENCE',
  'SUBTYPE_OF', 'SUpertYPE_OF', 'INSTANCE_OF', 'INSTANTIATES',
  'MEMBER_OF', 'MEMBERSHIP', 'AFFILIATED_WITH', 'AFFILIATION',
  'LOCATED_AT', 'LOCATION', 'OPERATES_IN', 'OPERATION',
  'TARGETS', 'TARGETED_BY', 'AFFECTS', 'AFFECTED_BY',
  'VULNERABLE_TO', 'EXPLOITS', 'MITIGATES', 'PREVENTS',
  'DETECTS', 'RESPONDS_TO', 'COMPLIES_WITH', 'VIOLATES',
];

export const KG_TRUST_LEVELS = [
  'UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE',
];

// ── KG-3 controlled vocabularies ─────────────────────────────────────────────
export const KG_ENTITY_STATUSES = ['ACTIVE', 'AMBIGUOUS', 'MERGED', 'INVALIDATED'];
export const KG_SOURCE_STATUSES = ['ACTIVE', 'DELETED', 'INVALIDATED', 'SUPERSEDED'];
export const KG_SOURCE_REF_STATUSES = ['ACTIVE', 'INVALIDATED', 'DELETED'];
/** Increasing restriction: a logical source takes the most restrictive level of its refs. */
export const KG_PRIVACY_LEVELS = ['PUBLIC', 'STANDARD', 'UNKNOWN', 'PRIVATE'];
export const KG_EGRESS_POLICIES = ['cloud_allowed', 'local_only'];
export const KG_SOURCE_ADAPTERS = ['article_capture', 'neuron', 'notebook_document', 'notebook_ai_message', 'manual', 'kg_import'];
export const KG_IDENTIFIER_STATUSES = ['ACTIVE', 'CONFLICT', 'REJECTED', 'INVALIDATED'];
export const KG_ALIAS_STATUSES = ['PROPOSED', 'CONFIRMED', 'REJECTED', 'INVALIDATED'];
export const KG_CLAIM_STATUSES = ['ASSERTED', 'SUPPORTED', 'DISPUTED', 'SUPERSEDED', 'INVALIDATED', 'HYPOTHESIS'];
export const KG_EXTRACTION_METHODS = ['USER', 'DETERMINISTIC', 'MODEL_PROPOSAL'];
export const KG_EVIDENCE_STATUSES = ['ACTIVE', 'SOURCE_MISSING', 'INVALIDATED'];
export const KG_LOCATOR_KINDS = ['SOURCE', 'CHUNK', 'PAGE', 'SECTION', 'MESSAGE', 'PARAGRAPH'];
export const KG_STANCES = ['SUPPORTS', 'CONTRADICTS'];
export const KG_CLAIM_EVIDENCE_STATUSES = ['ACTIVE', 'DETACHED'];
// KG-8 relation provenance (one row per logical source + technical ref that asserted the relation)
export const KG_RELATIONSHIP_PROVENANCE_STATUSES = ['ACTIVE', 'INVALIDATED'];
export const KG_RESOLUTION_DECISIONS = ['PROPOSED', 'CONFIRMED', 'REJECTED', 'REVERSED'];
// KG-4 contradictions between claims (the claims themselves are never modified or deleted)
export const KG_CONFLICT_KINDS = ['SINGLE_VALUE_CONFLICT'];
export const KG_CONFLICT_STATUSES = ['OPEN', 'RESOLVED'];
export const KG_RESOLUTION_METHODS = [
  'STABLE_IDENTIFIER', 'CANONICAL_URL', 'ALIAS_CORROBORATED', 'LABEL_CONTEXT',
  'SAME_LABEL_UNCORROBORATED', 'SIMILARITY_CANDIDATE', 'LLM_CANDIDATE', 'USER',
];

export const KG_CONFIDENCE_SCALE = {
  MIN: 0.0,
  MAX: 1.0,
  LOW: 0.3,
  MEDIUM: 0.6,
  HIGH: 0.8,
  VERY_HIGH: 0.95,
};

export const KG_DEFAULT_LIMITS = {
  MAX_DEPTH: 5,
  MAX_NODES: 1000,
  MAX_EDGES: 5000,
  MAX_RESULT_SIZE: 10000,
  MAX_EXECUTION_TIME_MS: 10000,
  DEFAULT_DEPTH: 2,
  DEFAULT_NODE_LIMIT: 100,
  DEFAULT_EDGE_LIMIT: 500,
  DEFAULT_SEARCH_LIMIT: 50,
  DEFAULT_EVIDENCE_LIMIT: 20,
  // KG-3
  MAX_PROVENANCE_BYTES: 4096,
  MAX_EVIDENCE_PREVIEW_CHARS: 500,
  MAX_RESOLUTION_CANDIDATES: 20,
  MAX_MERGE_CHAIN: 32,
};

const list = (values) => values.map(v => `'${v}'`).join(', ');
const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/**
 * Table definitions. `name` lets migration 005 create the realigned table
 * under a temporary name before swapping it in.
 */
const TABLE_DDL = {
  kg_entities: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      entity_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      normalized_name TEXT NOT NULL,
      label_key TEXT NOT NULL DEFAULT '',
      token_key TEXT NOT NULL DEFAULT '',
      canonical_id TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      merged_into_id TEXT REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      provenance_source_id TEXT,
      provenance_created_at TEXT,
      CHECK (entity_type IN (${list(KG_ENTITY_TYPES)})),
      CHECK (status IN (${list(KG_ENTITY_STATUSES)})),
      CHECK (trust_level IN (${list(KG_TRUST_LEVELS)})),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (merged_into_id IS NULL OR merged_into_id <> entity_id)
    )`,

  kg_sources: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      source_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      name TEXT NOT NULL,
      uri TEXT,
      author TEXT,
      publisher TEXT,
      published_at TEXT,
      retrieved_at TEXT,
      last_accessed TEXT,
      language TEXT NOT NULL DEFAULT 'unknown',
      logical_key TEXT,
      canonical_url TEXT,
      content_hash TEXT,
      privacy TEXT NOT NULL DEFAULT 'UNKNOWN',
      egress_policy TEXT NOT NULL DEFAULT 'local_only',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      invalidated_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      CHECK (source_type IN (${list(KG_SOURCE_TYPES)})),
      CHECK (privacy IN (${list(KG_PRIVACY_LEVELS)})),
      CHECK (egress_policy IN (${list(KG_EGRESS_POLICIES)})),
      CHECK (status IN (${list(KG_SOURCE_STATUSES)})),
      CHECK (trust_level IN (${list(KG_TRUST_LEVELS)})),
      CHECK (confidence >= 0.0 AND confidence <= 1.0)
    )`,

  kg_source_refs: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      source_ref_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      adapter TEXT NOT NULL,
      input_path TEXT,
      source_ref TEXT NOT NULL,
      version_ref TEXT,
      original_url TEXT,
      capture_id TEXT,
      content_hash TEXT,
      provenance TEXT NOT NULL DEFAULT '{}',
      privacy TEXT NOT NULL DEFAULT 'UNKNOWN',
      egress_policy TEXT NOT NULL DEFAULT 'local_only',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      observed_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      invalidated_at TEXT,
      CHECK (adapter IN (${list(KG_SOURCE_ADAPTERS)})),
      CHECK (privacy IN (${list(KG_PRIVACY_LEVELS)})),
      CHECK (egress_policy IN (${list(KG_EGRESS_POLICIES)})),
      CHECK (status IN (${list(KG_SOURCE_REF_STATUSES)})),
      CHECK (json_valid(provenance) AND length(provenance) <= ${KG_DEFAULT_LIMITS.MAX_PROVENANCE_BYTES})
    )`,

  kg_entity_identifiers: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      identifier_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      scheme TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      original_value TEXT NOT NULL,
      source_id TEXT REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      source_ref_id TEXT REFERENCES kg_source_refs(source_ref_id) ON DELETE RESTRICT,
      confidence REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      CHECK (status IN (${list(KG_IDENTIFIER_STATUSES)})),
      CHECK (confidence >= 0.0 AND confidence <= 1.0)
    )`,

  kg_aliases: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      alias_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      alias TEXT NOT NULL,
      alias_type TEXT NOT NULL DEFAULT 'NAME',
      normalized_alias TEXT NOT NULL,
      alias_key TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0,
      source_id TEXT REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      source_ref_id TEXT REFERENCES kg_source_refs(source_ref_id) ON DELETE RESTRICT,
      confidence REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      CHECK (status IN (${list(KG_ALIAS_STATUSES)})),
      CHECK (confidence >= 0.0 AND confidence <= 1.0)
    )`,

  kg_claims: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      claim_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      claim_type TEXT NOT NULL,
      statement TEXT NOT NULL,
      normalized_statement TEXT NOT NULL,
      predicate TEXT,
      object_entity_id TEXT REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      value_json TEXT,
      source_id TEXT REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      author_entity_id TEXT REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'ASSERTED',
      extraction_method TEXT,
      model_confidence REAL,
      source_confidence REAL,
      observed_at TEXT,
      valid_from TEXT,
      valid_to TEXT,
      superseded_by_id TEXT REFERENCES kg_claims(claim_id) ON DELETE RESTRICT,
      claim_key TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      polarity TEXT NOT NULL DEFAULT 'NEUTRAL',
      metadata TEXT NOT NULL DEFAULT '{}',
      provenance_history TEXT DEFAULT '[]',
      CHECK (claim_type IN (${list(KG_CLAIM_TYPES)})),
      CHECK (status IN (${list(KG_CLAIM_STATUSES)})),
      CHECK (extraction_method IS NULL OR extraction_method IN (${list(KG_EXTRACTION_METHODS)})),
      CHECK (trust_level IN (${list(KG_TRUST_LEVELS)})),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (model_confidence IS NULL OR (model_confidence >= 0.0 AND model_confidence <= 1.0)),
      CHECK (source_confidence IS NULL OR (source_confidence >= 0.0 AND source_confidence <= 1.0)),
      CHECK (polarity IN ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'UNKNOWN')),
      CHECK (object_entity_id IS NULL OR value_json IS NULL),
      CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to)
    )`,

  kg_evidence: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      evidence_id TEXT PRIMARY KEY,
      claim_id TEXT REFERENCES kg_claims(claim_id) ON DELETE RESTRICT,
      evidence_type TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_content TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      source_ref_id TEXT REFERENCES kg_source_refs(source_ref_id) ON DELETE RESTRICT,
      locator_kind TEXT NOT NULL DEFAULT 'SOURCE',
      locator_ref TEXT,
      chunk_id TEXT,
      message_id TEXT,
      page INTEGER,
      section TEXT,
      char_start INTEGER,
      char_end INTEGER,
      excerpt_hash TEXT,
      extracted_from TEXT,
      relevance_score REAL NOT NULL DEFAULT 0.0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      CHECK (evidence_type IN (${list(KG_EVIDENCE_TYPES)})),
      CHECK (locator_kind IN (${list(KG_LOCATOR_KINDS)})),
      CHECK (status IN (${list(KG_EVIDENCE_STATUSES)})),
      CHECK (trust_level IN (${list(KG_TRUST_LEVELS)})),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (relevance_score >= 0.0 AND relevance_score <= 1.0),
      CHECK (page IS NULL OR page >= 1),
      CHECK (char_start IS NULL OR (char_start >= 0 AND (char_end IS NULL OR char_end >= char_start)))
    )`,

  kg_claim_evidence: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      claim_id TEXT NOT NULL REFERENCES kg_claims(claim_id) ON DELETE RESTRICT,
      evidence_id TEXT NOT NULL REFERENCES kg_evidence(evidence_id) ON DELETE RESTRICT,
      stance TEXT NOT NULL DEFAULT 'SUPPORTS',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      attached_at TEXT NOT NULL DEFAULT ${NOW},
      detached_at TEXT,
      PRIMARY KEY (claim_id, evidence_id),
      CHECK (stance IN (${list(KG_STANCES)})),
      CHECK (status IN (${list(KG_CLAIM_EVIDENCE_STATUSES)}))
    )`,

  kg_relationships: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      relationship_id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      target_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      relationship_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      source_id TEXT REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      metadata TEXT NOT NULL DEFAULT '{}',
      CHECK (relationship_type IN (${list(KG_RELATIONSHIP_TYPES)})),
      CHECK (trust_level IN (${list(KG_TRUST_LEVELS)})),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      UNIQUE (source_entity_id, target_entity_id, relationship_type)
    )`,

  kg_relationship_provenance: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      provenance_id TEXT PRIMARY KEY,
      relationship_id TEXT NOT NULL REFERENCES kg_relationships(relationship_id) ON DELETE RESTRICT,
      source_id TEXT NOT NULL REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      source_ref_id TEXT REFERENCES kg_source_refs(source_ref_id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      invalidated_at TEXT,
      CHECK (status IN (${list(KG_RELATIONSHIP_PROVENANCE_STATUSES)}))
    )`,

  kg_entity_resolutions: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      resolution_id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      target_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      decision TEXT NOT NULL,
      method TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      confidence REAL,
      signals TEXT NOT NULL DEFAULT '{}',
      source_id TEXT REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      source_ref_id TEXT REFERENCES kg_source_refs(source_ref_id) ON DELETE RESTRICT,
      actor TEXT NOT NULL DEFAULT 'SYSTEM',
      previous_status TEXT,
      previous_merged_into_id TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      decided_at TEXT,
      reversed_at TEXT,
      reversal_reason TEXT,
      CHECK (source_entity_id <> target_entity_id),
      CHECK (decision IN (${list(KG_RESOLUTION_DECISIONS)})),
      CHECK (method IN (${list(KG_RESOLUTION_METHODS)})),
      CHECK (actor IN ('SYSTEM', 'USER')),
      CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
      CHECK (json_valid(signals))
    )`,

  kg_claim_conflicts: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      conflict_id TEXT PRIMARY KEY,
      claim_a_id TEXT NOT NULL REFERENCES kg_claims(claim_id) ON DELETE RESTRICT,
      claim_b_id TEXT NOT NULL REFERENCES kg_claims(claim_id) ON DELETE RESTRICT,
      kind TEXT NOT NULL,
      predicate TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      signals TEXT NOT NULL DEFAULT '{}',
      detected_at TEXT NOT NULL DEFAULT ${NOW},
      resolved_at TEXT,
      resolution TEXT,
      CHECK (claim_a_id < claim_b_id),
      CHECK (kind IN (${list(KG_CONFLICT_KINDS)})),
      CHECK (status IN (${list(KG_CONFLICT_STATUSES)})),
      CHECK (json_valid(signals)),
      UNIQUE (claim_a_id, claim_b_id, kind)
    )`,

  kg_metadata: (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    )`,
};

/** Creation order (a referenced table is always created first). */
export const KG_TABLES = [
  'kg_metadata', 'kg_entities', 'kg_sources', 'kg_source_refs', 'kg_entity_identifiers',
  'kg_aliases', 'kg_claims', 'kg_evidence', 'kg_claim_evidence', 'kg_relationships', 'kg_relationship_provenance', 'kg_entity_resolutions',
  'kg_claim_conflicts',
];


export function tableDdl(table, name = table) {
  const ddl = TABLE_DDL[table];
  if (!ddl) throw new Error(`Unknown KG table: ${table}`);
  return ddl(name);
}

export const KG_INDEXES = {
  kg_entities: [
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(entity_type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(normalized_name)',
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_normalized ON kg_entities(normalized_name, entity_type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_type_name ON kg_entities(entity_type, normalized_name)',
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_type_tokens ON kg_entities(entity_type, token_key)',
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_active ON kg_entities(is_active) WHERE is_active = 1',
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_status ON kg_entities(status)',
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_merged_into ON kg_entities(merged_into_id) WHERE merged_into_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_created ON kg_entities(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_kg_entities_trust ON kg_entities(trust_level)',
  ],
  kg_sources: [
    'CREATE INDEX IF NOT EXISTS idx_kg_sources_type ON kg_sources(source_type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_sources_name ON kg_sources(name)',
    'CREATE INDEX IF NOT EXISTS idx_kg_sources_uri ON kg_sources(uri)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_sources_logical_key ON kg_sources(logical_key) WHERE logical_key IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_sources_canonical_url ON kg_sources(canonical_url) WHERE canonical_url IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_sources_content_hash ON kg_sources(content_hash) WHERE content_hash IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_sources_status ON kg_sources(status)',
    'CREATE INDEX IF NOT EXISTS idx_kg_sources_active ON kg_sources(is_active) WHERE is_active = 1',
    'CREATE INDEX IF NOT EXISTS idx_kg_sources_trust ON kg_sources(trust_level)',
    'CREATE INDEX IF NOT EXISTS idx_kg_sources_published ON kg_sources(published_at)',
  ],
  kg_source_refs: [
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_source_refs_adapter_ref ON kg_source_refs(adapter, source_ref)',
    'CREATE INDEX IF NOT EXISTS idx_kg_source_refs_source ON kg_source_refs(source_id, status)',
  ],
  kg_entity_identifiers: [
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_identifiers_entity_value ON kg_entity_identifiers(entity_id, scheme, normalized_value)',
    'CREATE INDEX IF NOT EXISTS idx_kg_identifiers_value ON kg_entity_identifiers(scheme, normalized_value, status)',
  ],
  kg_aliases: [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_aliases_provenance ON kg_aliases(entity_id, normalized_alias, COALESCE(source_ref_id, ''))",
    'CREATE INDEX IF NOT EXISTS idx_kg_aliases_entity ON kg_aliases(entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_kg_aliases_normalized ON kg_aliases(normalized_alias)',
    'CREATE INDEX IF NOT EXISTS idx_kg_aliases_ref ON kg_aliases(source_ref_id, normalized_alias) WHERE source_ref_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_aliases_alias ON kg_aliases(alias)',
    'CREATE INDEX IF NOT EXISTS idx_kg_aliases_primary ON kg_aliases(entity_id, is_primary) WHERE is_primary = 1',
  ],
  kg_claims: [
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_entity ON kg_claims(entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_source ON kg_claims(source_id)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_type ON kg_claims(claim_type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_entity_type ON kg_claims(entity_id, claim_type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_object ON kg_claims(object_entity_id) WHERE object_entity_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_predicate ON kg_claims(predicate) WHERE predicate IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_status ON kg_claims(status)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_valid ON kg_claims(valid_from, valid_to)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_normalized ON kg_claims(normalized_statement)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_active ON kg_claims(is_active) WHERE is_active = 1',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_trust ON kg_claims(trust_level)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_author ON kg_claims(author_entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_created ON kg_claims(created_at)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_claims_key ON kg_claims(claim_key) WHERE claim_key IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_subject_predicate ON kg_claims(entity_id, predicate, status)',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_predicate_object ON kg_claims(predicate, object_entity_id) WHERE object_entity_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_claims_superseded_by ON kg_claims(superseded_by_id) WHERE superseded_by_id IS NOT NULL',
  ],
  kg_evidence: [
    'CREATE INDEX IF NOT EXISTS idx_kg_evidence_claim ON kg_evidence(claim_id)',
    'CREATE INDEX IF NOT EXISTS idx_kg_evidence_source ON kg_evidence(source_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_kg_evidence_ref ON kg_evidence(source_ref_id) WHERE source_ref_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_kg_evidence_locator ON kg_evidence(source_id, locator_kind, locator_ref)',
    'CREATE INDEX IF NOT EXISTS idx_kg_evidence_type ON kg_evidence(evidence_type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_evidence_active ON kg_evidence(is_active) WHERE is_active = 1',
    'CREATE INDEX IF NOT EXISTS idx_kg_evidence_trust ON kg_evidence(trust_level)',
    'CREATE INDEX IF NOT EXISTS idx_kg_evidence_relevance ON kg_evidence(relevance_score DESC)',
    'CREATE INDEX IF NOT EXISTS idx_kg_evidence_created ON kg_evidence(created_at)',
  ],
  kg_claim_evidence: [
    'CREATE INDEX IF NOT EXISTS idx_kg_claim_evidence_evidence ON kg_claim_evidence(evidence_id, status)',
  ],
  kg_relationships: [
    'CREATE INDEX IF NOT EXISTS idx_kg_relationships_source ON kg_relationships(source_entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_kg_relationships_target ON kg_relationships(target_entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_kg_relationships_type ON kg_relationships(relationship_type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_relationships_active ON kg_relationships(is_active) WHERE is_active = 1',
    'CREATE INDEX IF NOT EXISTS idx_kg_relationships_pair ON kg_relationships(source_entity_id, target_entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_kg_relationships_type_active ON kg_relationships(relationship_type, is_active) WHERE is_active = 1',
  ],
  kg_relationship_provenance: [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_relprov_unique ON kg_relationship_provenance(relationship_id, source_id, COALESCE(source_ref_id, ''))",
    'CREATE INDEX IF NOT EXISTS idx_kg_relprov_relationship ON kg_relationship_provenance(relationship_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_kg_relprov_source ON kg_relationship_provenance(source_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_kg_relprov_ref ON kg_relationship_provenance(source_ref_id) WHERE source_ref_id IS NOT NULL',
  ],
  kg_entity_resolutions: [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_resolutions_one_confirmed ON kg_entity_resolutions(source_entity_id) WHERE decision = 'CONFIRMED'",
    'CREATE INDEX IF NOT EXISTS idx_kg_resolutions_source ON kg_entity_resolutions(source_entity_id, decision)',
    'CREATE INDEX IF NOT EXISTS idx_kg_resolutions_target ON kg_entity_resolutions(target_entity_id, decision)',
  ],
  kg_claim_conflicts: [
    'CREATE INDEX IF NOT EXISTS idx_kg_conflicts_a ON kg_claim_conflicts(claim_a_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_kg_conflicts_b ON kg_claim_conflicts(claim_b_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_kg_conflicts_predicate ON kg_claim_conflicts(predicate, status)',
  ],
  kg_metadata: [],
};

// Indexes of the early KG-2 schema that the realigned schema replaces.
export const KG_OBSOLETE_INDEXES = [
  'idx_kg_evidence_normalized', 'idx_kg_evidence_claim_type', 'idx_kg_relationships_source_target',
];

// ── FTS5 ─────────────────────────────────────────────────────────────────────
// The KG-2 triggers used `INSERT OR REPLACE` (FTS5 has no unique key: every
// update added a duplicate row) and `json_extract(metadata, '$.*')` (not a
// valid path: always NULL). Updates delete then insert, and metadata text is
// the concatenation of the metadata's top-level string values. Since KG-5 the
// FTS row shares the base row's rowid: deleting it is an index lookup (the
// KG-3 triggers matched on an UNINDEXED column, i.e. a full FTS scan per update).
const META_TEXT = (col) => `(SELECT group_concat(value, ' ') FROM json_each(${col}) WHERE type = 'text')`;

const FTS = {
  kg_entities_fts: {
    table: 'kg_entities', key: 'entity_id',
    create: `CREATE VIRTUAL TABLE IF NOT EXISTS kg_entities_fts USING fts5(
      entity_id UNINDEXED, entity_type UNINDEXED, name, description, normalized_name UNINDEXED, metadata_text,
      tokenize = "unicode61 remove_diacritics 2")`,
    columns: 'entity_id, entity_type, name, description, normalized_name, metadata_text',
    values: (r) => `${r}.entity_id, ${r}.entity_type, ${r}.name, ${r}.description, ${r}.normalized_name, ${META_TEXT(r + '.metadata')}`,
  },
  kg_claims_fts: {
    table: 'kg_claims', key: 'claim_id',
    create: `CREATE VIRTUAL TABLE IF NOT EXISTS kg_claims_fts USING fts5(
      claim_id UNINDEXED, entity_id UNINDEXED, claim_type UNINDEXED, statement, normalized_statement UNINDEXED, metadata_text,
      tokenize = "unicode61 remove_diacritics 2")`,
    columns: 'claim_id, entity_id, claim_type, statement, normalized_statement, metadata_text',
    values: (r) => `${r}.claim_id, ${r}.entity_id, ${r}.claim_type, ${r}.statement, ${r}.normalized_statement, ${META_TEXT(r + '.metadata')}`,
  },
  // KG-5: evidence previews (≤ 500 chars) — lets a phrase or wording reach the claims it supports;
  // visibility (privacy / scope / status) is applied at query time, never by the index
  kg_evidence_fts: {
    table: 'kg_evidence', key: 'evidence_id',
    create: `CREATE VIRTUAL TABLE IF NOT EXISTS kg_evidence_fts USING fts5(
      evidence_id UNINDEXED, source_id UNINDEXED, content,
      tokenize = "unicode61 remove_diacritics 2")`,
    columns: 'evidence_id, source_id, content',
    values: (r) => `${r}.evidence_id, ${r}.source_id, ${r}.content`,
  },
  kg_sources_fts: {
    table: 'kg_sources', key: 'source_id',
    create: `CREATE VIRTUAL TABLE IF NOT EXISTS kg_sources_fts USING fts5(
      source_id UNINDEXED, source_type UNINDEXED, name, uri UNINDEXED, author, publisher, metadata_text,
      tokenize = "unicode61 remove_diacritics 2")`,
    columns: 'source_id, source_type, name, uri, author, publisher, metadata_text',
    values: (r) => `${r}.source_id, ${r}.source_type, ${r}.name, ${r}.uri, ${r}.author, ${r}.publisher, ${META_TEXT(r + '.metadata')}`,
  },
};

export const KG_FTS_TABLES = Object.keys(FTS);

function ftsTriggerDdl(fts) {
  const f = FTS[fts];
  const base = fts.replace(/_fts$/, '');
  return [
    `CREATE TRIGGER IF NOT EXISTS ${base}_fts_ai AFTER INSERT ON ${f.table} BEGIN
      INSERT INTO ${fts}(rowid, ${f.columns}) VALUES (new.rowid, ${f.values('new')});
    END`,
    `CREATE TRIGGER IF NOT EXISTS ${base}_fts_au AFTER UPDATE ON ${f.table} BEGIN
      DELETE FROM ${fts} WHERE rowid = old.rowid;
      INSERT INTO ${fts}(rowid, ${f.columns}) VALUES (new.rowid, ${f.values('new')});
    END`,
    `CREATE TRIGGER IF NOT EXISTS ${base}_fts_ad AFTER DELETE ON ${f.table} BEGIN
      DELETE FROM ${fts} WHERE rowid = old.rowid;
    END`,
  ];
}

/** (Re)creates the FTS tables + triggers and rebuilds their content from the base tables. */
export function rebuildFts(db) {
  for (const fts of KG_FTS_TABLES) {
    const base = fts.replace(/_fts$/, '');
    for (const suffix of ['ai', 'au', 'ad']) db.exec(`DROP TRIGGER IF EXISTS ${base}_fts_${suffix}`);
    db.exec(FTS[fts].create);
    db.exec(`DELETE FROM ${fts}`);
    db.exec(`INSERT INTO ${fts}(rowid, ${FTS[fts].columns}) SELECT t.rowid, ${FTS[fts].values('t')} FROM ${FTS[fts].table} t`);
    for (const ddl of ftsTriggerDdl(fts)) db.exec(ddl);
  }
}

export function createIndexes(db) {
  for (const name of KG_OBSOLETE_INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`);
  for (const table of KG_TABLES) for (const ddl of KG_INDEXES[table]) db.exec(ddl);
}

/**
 * Creates every missing KG table, index, FTS table and trigger with the
 * realigned definitions (fresh install). Existing tables are left as they are:
 * reshaping an early KG-2 table is migration 005's job.
 * Contains no PRAGMA, so it can run inside a transaction.
 */
export function ensureKnowledgeGraphSchema(db) {
  for (const table of KG_TABLES) db.exec(tableDdl(table));
  createIndexes(db);
  for (const fts of KG_FTS_TABLES) {
    db.exec(FTS[fts].create);
    for (const ddl of ftsTriggerDdl(fts)) db.exec(ddl);
  }
}

export function getSchemaVersion(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kg_metadata'").get();
  if (!exists) return '0.0.0';
  const result = db.prepare('SELECT value FROM kg_metadata WHERE key = ?').get('schema_version');
  return result ? result.value : '0.0.0';
}

export function setSchemaVersion(db, version) {
  db.prepare(`INSERT INTO kg_metadata (key, value, updated_at) VALUES ('schema_version', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(version, new Date().toISOString());
}

/** Kept for KG-2 callers: full idempotent creation of the current schema. */
export function initializeKnowledgeGraphSchema(db) {
  ensureKnowledgeGraphSchema(db);
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO kg_metadata (key, value, updated_at) VALUES ('created_at', ?, ?)").run(now, now);
}

export default {
  ensureKnowledgeGraphSchema,
  initializeKnowledgeGraphSchema,
  getSchemaVersion,
  setSchemaVersion,
  tableDdl,
  rebuildFts,
  createIndexes,
  KG_SCHEMA_VERSION,
  KG_TABLES,
  KG_ENTITY_TYPES,
  KG_SOURCE_TYPES,
  KG_EVIDENCE_TYPES,
  KG_CLAIM_TYPES,
  KG_RELATIONSHIP_TYPES,
  KG_TRUST_LEVELS,
  KG_CONFIDENCE_SCALE,
  KG_DEFAULT_LIMITS,
};
