-- KG-3 schema 2.0.0 (before KG-4), captured 2026-10-07 from the KG-3 code by running KnowledgeGraphStore.initialize()
-- on an empty temporary database. Test fixture only: lets the KG-4 upgrade path (migration 006) be tested.
CREATE TABLE kg_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
CREATE TABLE kg_entities (
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      provenance_source_id TEXT,
      provenance_created_at TEXT,
      CHECK (entity_type IN ('PERSON', 'ORGANIZATION', 'LOCATION', 'CONCEPT', 'EVENT', 'DOCUMENT', 'PROJECT', 'DEVICE', 'SOFTWARE', 'PROTOCOL', 'THREAT', 'VULNERABILITY', 'TECHNIQUE', 'TOOL', 'FRAMEWORK', 'STANDARD', 'LAW', 'REGULATION', 'COUNTRY', 'INDUSTRY', 'TECHNOLOGY', 'PROCESS', 'METHODOLOGY', 'ARTEFACT', 'PRODUCT', 'PLACE')),
      CHECK (status IN ('ACTIVE', 'AMBIGUOUS', 'MERGED', 'INVALIDATED')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (merged_into_id IS NULL OR merged_into_id <> entity_id)
    );
CREATE TABLE kg_sources (
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      CHECK (source_type IN ('HUMAN', 'DOCUMENT', 'WEB', 'API', 'DATABASE', 'FEED', 'REPORT', 'ARTICLE', 'BOOK', 'PAPER', 'PRESENTATION', 'VIDEO', 'AUDIO', 'IMAGE', 'SOCIAL_MEDIA', 'EMAIL', 'CHAT', 'INTERVIEW', 'SENSOR', 'LOG', 'ALERT', 'INTELLIGENCE', 'LEGAL', 'FINANCIAL', 'TECHNICAL', 'ACADEMIC', 'GOVERNMENT', 'INTERNAL', 'EXTERNAL')),
      CHECK (privacy IN ('PUBLIC', 'STANDARD', 'UNKNOWN', 'PRIVATE')),
      CHECK (egress_policy IN ('cloud_allowed', 'local_only')),
      CHECK (status IN ('ACTIVE', 'DELETED', 'INVALIDATED', 'SUPERSEDED')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0)
    );
CREATE TABLE kg_source_refs (
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      invalidated_at TEXT,
      CHECK (adapter IN ('article_capture', 'neuron', 'notebook_document', 'notebook_ai_message', 'manual', 'kg_import')),
      CHECK (privacy IN ('PUBLIC', 'STANDARD', 'UNKNOWN', 'PRIVATE')),
      CHECK (egress_policy IN ('cloud_allowed', 'local_only')),
      CHECK (status IN ('ACTIVE', 'INVALIDATED', 'DELETED')),
      CHECK (json_valid(provenance) AND length(provenance) <= 4096)
    );
CREATE TABLE kg_entity_identifiers (
      identifier_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      scheme TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      original_value TEXT NOT NULL,
      source_id TEXT REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      source_ref_id TEXT REFERENCES kg_source_refs(source_ref_id) ON DELETE RESTRICT,
      confidence REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (status IN ('ACTIVE', 'CONFLICT', 'REJECTED', 'INVALIDATED')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0)
    );
CREATE TABLE kg_aliases (
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (status IN ('PROPOSED', 'CONFIRMED', 'REJECTED', 'INVALIDATED')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0)
    );
CREATE TABLE kg_claims (
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      polarity TEXT NOT NULL DEFAULT 'NEUTRAL',
      metadata TEXT NOT NULL DEFAULT '{}',
      provenance_history TEXT DEFAULT '[]',
      CHECK (claim_type IN ('FACT', 'HYPOTHESIS', 'THEORY', 'ALLEGATION', 'DENIAL', 'CONFIRMATION', 'CLASSIFICATION', 'RELATIONSHIP', 'ATTRIBUTION', 'CAUSATION', 'CORRELATION', 'PREDICTION', 'OBSERVATION', 'ANALYSIS', 'INTERPRETATION', 'RECOMMENDATION', 'WARNING', 'VULNERABILITY', 'EXPLOIT', 'IMPACT', 'MITIGATION', 'COUNTERMEASURE')),
      CHECK (status IN ('ASSERTED', 'SUPPORTED', 'DISPUTED', 'SUPERSEDED', 'INVALIDATED', 'HYPOTHESIS')),
      CHECK (extraction_method IS NULL OR extraction_method IN ('USER', 'DETERMINISTIC', 'MODEL_PROPOSAL')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (model_confidence IS NULL OR (model_confidence >= 0.0 AND model_confidence <= 1.0)),
      CHECK (source_confidence IS NULL OR (source_confidence >= 0.0 AND source_confidence <= 1.0)),
      CHECK (polarity IN ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'UNKNOWN')),
      CHECK (object_entity_id IS NULL OR value_json IS NULL),
      CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to)
    );
CREATE TABLE kg_evidence (
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
      excerpt_hash TEXT,
      extracted_from TEXT,
      relevance_score REAL NOT NULL DEFAULT 0.0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      CHECK (evidence_type IN ('DIRECT', 'INDIRECT', 'CIRCUMSTANTIAL', 'ANECDOTAL', 'VERIFIED', 'UNVERIFIED', 'DISPUTED', 'REFUTED', 'SUPPORTING', 'CONTRADICTING', 'CORROBORATING', 'UNRELIABLE', 'HEARSAY')),
      CHECK (locator_kind IN ('SOURCE', 'CHUNK', 'PAGE', 'SECTION', 'MESSAGE', 'PARAGRAPH')),
      CHECK (status IN ('ACTIVE', 'SOURCE_MISSING', 'INVALIDATED')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (relevance_score >= 0.0 AND relevance_score <= 1.0)
    );
CREATE TABLE kg_claim_evidence (
      claim_id TEXT NOT NULL REFERENCES kg_claims(claim_id) ON DELETE RESTRICT,
      evidence_id TEXT NOT NULL REFERENCES kg_evidence(evidence_id) ON DELETE RESTRICT,
      stance TEXT NOT NULL DEFAULT 'SUPPORTS',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      attached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      detached_at TEXT,
      PRIMARY KEY (claim_id, evidence_id),
      CHECK (stance IN ('SUPPORTS', 'CONTRADICTS')),
      CHECK (status IN ('ACTIVE', 'DETACHED'))
    );
CREATE TABLE kg_relationships (
      relationship_id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      target_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE RESTRICT,
      relationship_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      source_id TEXT REFERENCES kg_sources(source_id) ON DELETE RESTRICT,
      metadata TEXT NOT NULL DEFAULT '{}',
      CHECK (relationship_type IN ('PART_OF', 'HAS_PART', 'CONTAINS', 'CONTAINED_IN', 'OWNED_BY', 'OWNS', 'CONTROLS', 'CONTROLLED_BY', 'CREATED_BY', 'CREATED', 'AUTHORED_BY', 'AUTHOR', 'PUBLISHED_BY', 'PUBLISHER', 'DISTRIBUTED_BY', 'DISTRIBUTOR', 'USES', 'USED_BY', 'IMPLEMENTS', 'IMPLEMENTED_BY', 'DEPENDS_ON', 'DEPENDENCY', 'REQUIRES', 'REQUIRED_BY', 'CONNECTED_TO', 'CONNECTION', 'COMMUNICATES_WITH', 'COMMUNICATION', 'ASSOCIATED_WITH', 'ASSOCIATION', 'LINKED_TO', 'LINK', 'RELATED_TO', 'RELATION', 'INFLUENCES', 'INFLUENCED_BY', 'CAUSES', 'CAUSED_BY', 'RESULTS_IN', 'RESULT_OF', 'PRECEDES', 'FOLLOWS', 'BEFORE', 'AFTER', 'SIMILAR_TO', 'SIMILARITY', 'DIFFERENT_FROM', 'DIFFERENCE', 'SUBTYPE_OF', 'SUpertYPE_OF', 'INSTANCE_OF', 'INSTANTIATES', 'MEMBER_OF', 'MEMBERSHIP', 'AFFILIATED_WITH', 'AFFILIATION', 'LOCATED_AT', 'LOCATION', 'OPERATES_IN', 'OPERATION', 'TARGETS', 'TARGETED_BY', 'AFFECTS', 'AFFECTED_BY', 'VULNERABLE_TO', 'EXPLOITS', 'MITIGATES', 'PREVENTS', 'DETECTS', 'RESPONDS_TO', 'COMPLIES_WITH', 'VIOLATES')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      UNIQUE (source_entity_id, target_entity_id, relationship_type)
    );
CREATE TABLE kg_entity_resolutions (
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      decided_at TEXT,
      reversed_at TEXT,
      reversal_reason TEXT,
      CHECK (source_entity_id <> target_entity_id),
      CHECK (decision IN ('PROPOSED', 'CONFIRMED', 'REJECTED', 'REVERSED')),
      CHECK (method IN ('STABLE_IDENTIFIER', 'CANONICAL_URL', 'ALIAS_CORROBORATED', 'LABEL_CONTEXT', 'SAME_LABEL_UNCORROBORATED', 'SIMILARITY_CANDIDATE', 'LLM_CANDIDATE', 'USER')),
      CHECK (actor IN ('SYSTEM', 'USER')),
      CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
      CHECK (json_valid(signals))
    );
CREATE INDEX idx_kg_entities_type ON kg_entities(entity_type);
CREATE INDEX idx_kg_entities_name ON kg_entities(normalized_name);
CREATE INDEX idx_kg_entities_normalized ON kg_entities(normalized_name, entity_type);
CREATE INDEX idx_kg_entities_type_name ON kg_entities(entity_type, normalized_name);
CREATE INDEX idx_kg_entities_type_tokens ON kg_entities(entity_type, token_key);
CREATE INDEX idx_kg_entities_active ON kg_entities(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_entities_status ON kg_entities(status);
CREATE INDEX idx_kg_entities_merged_into ON kg_entities(merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX idx_kg_entities_created ON kg_entities(created_at);
CREATE INDEX idx_kg_entities_trust ON kg_entities(trust_level);
CREATE INDEX idx_kg_sources_type ON kg_sources(source_type);
CREATE INDEX idx_kg_sources_name ON kg_sources(name);
CREATE INDEX idx_kg_sources_uri ON kg_sources(uri);
CREATE UNIQUE INDEX idx_kg_sources_logical_key ON kg_sources(logical_key) WHERE logical_key IS NOT NULL;
CREATE INDEX idx_kg_sources_canonical_url ON kg_sources(canonical_url) WHERE canonical_url IS NOT NULL;
CREATE INDEX idx_kg_sources_content_hash ON kg_sources(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX idx_kg_sources_status ON kg_sources(status);
CREATE INDEX idx_kg_sources_active ON kg_sources(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_sources_trust ON kg_sources(trust_level);
CREATE INDEX idx_kg_sources_published ON kg_sources(published_at);
CREATE UNIQUE INDEX idx_kg_source_refs_adapter_ref ON kg_source_refs(adapter, source_ref);
CREATE INDEX idx_kg_source_refs_source ON kg_source_refs(source_id, status);
CREATE UNIQUE INDEX idx_kg_identifiers_entity_value ON kg_entity_identifiers(entity_id, scheme, normalized_value);
CREATE INDEX idx_kg_identifiers_value ON kg_entity_identifiers(scheme, normalized_value, status);
CREATE UNIQUE INDEX idx_kg_aliases_provenance ON kg_aliases(entity_id, normalized_alias, COALESCE(source_ref_id, ''));
CREATE INDEX idx_kg_aliases_entity ON kg_aliases(entity_id);
CREATE INDEX idx_kg_aliases_normalized ON kg_aliases(normalized_alias);
CREATE INDEX idx_kg_aliases_ref ON kg_aliases(source_ref_id, normalized_alias) WHERE source_ref_id IS NOT NULL;
CREATE INDEX idx_kg_aliases_alias ON kg_aliases(alias);
CREATE INDEX idx_kg_aliases_primary ON kg_aliases(entity_id, is_primary) WHERE is_primary = 1;
CREATE INDEX idx_kg_claims_entity ON kg_claims(entity_id);
CREATE INDEX idx_kg_claims_source ON kg_claims(source_id);
CREATE INDEX idx_kg_claims_type ON kg_claims(claim_type);
CREATE INDEX idx_kg_claims_entity_type ON kg_claims(entity_id, claim_type);
CREATE INDEX idx_kg_claims_object ON kg_claims(object_entity_id) WHERE object_entity_id IS NOT NULL;
CREATE INDEX idx_kg_claims_predicate ON kg_claims(predicate) WHERE predicate IS NOT NULL;
CREATE INDEX idx_kg_claims_status ON kg_claims(status);
CREATE INDEX idx_kg_claims_valid ON kg_claims(valid_from, valid_to);
CREATE INDEX idx_kg_claims_normalized ON kg_claims(normalized_statement);
CREATE INDEX idx_kg_claims_active ON kg_claims(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_claims_trust ON kg_claims(trust_level);
CREATE INDEX idx_kg_claims_author ON kg_claims(author_entity_id);
CREATE INDEX idx_kg_claims_created ON kg_claims(created_at);
CREATE INDEX idx_kg_evidence_claim ON kg_evidence(claim_id);
CREATE INDEX idx_kg_evidence_source ON kg_evidence(source_id, status);
CREATE INDEX idx_kg_evidence_ref ON kg_evidence(source_ref_id) WHERE source_ref_id IS NOT NULL;
CREATE INDEX idx_kg_evidence_locator ON kg_evidence(source_id, locator_kind, locator_ref);
CREATE INDEX idx_kg_evidence_type ON kg_evidence(evidence_type);
CREATE INDEX idx_kg_evidence_active ON kg_evidence(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_evidence_trust ON kg_evidence(trust_level);
CREATE INDEX idx_kg_evidence_relevance ON kg_evidence(relevance_score DESC);
CREATE INDEX idx_kg_evidence_created ON kg_evidence(created_at);
CREATE INDEX idx_kg_claim_evidence_evidence ON kg_claim_evidence(evidence_id, status);
CREATE INDEX idx_kg_relationships_source ON kg_relationships(source_entity_id);
CREATE INDEX idx_kg_relationships_target ON kg_relationships(target_entity_id);
CREATE INDEX idx_kg_relationships_type ON kg_relationships(relationship_type);
CREATE INDEX idx_kg_relationships_active ON kg_relationships(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_relationships_pair ON kg_relationships(source_entity_id, target_entity_id);
CREATE INDEX idx_kg_relationships_type_active ON kg_relationships(relationship_type, is_active) WHERE is_active = 1;
CREATE UNIQUE INDEX idx_kg_resolutions_one_confirmed ON kg_entity_resolutions(source_entity_id) WHERE decision = 'CONFIRMED';
CREATE INDEX idx_kg_resolutions_source ON kg_entity_resolutions(source_entity_id, decision);
CREATE INDEX idx_kg_resolutions_target ON kg_entity_resolutions(target_entity_id, decision);
CREATE VIRTUAL TABLE kg_entities_fts USING fts5(
      entity_id UNINDEXED, entity_type UNINDEXED, name, description, normalized_name UNINDEXED, metadata_text,
      tokenize = "unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE kg_claims_fts USING fts5(
      claim_id UNINDEXED, entity_id UNINDEXED, claim_type UNINDEXED, statement, normalized_statement UNINDEXED, metadata_text,
      tokenize = "unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE kg_sources_fts USING fts5(
      source_id UNINDEXED, source_type UNINDEXED, name, uri UNINDEXED, author, publisher, metadata_text,
      tokenize = "unicode61 remove_diacritics 2");
CREATE TRIGGER kg_entities_fts_ai AFTER INSERT ON kg_entities BEGIN
      INSERT INTO kg_entities_fts(entity_id, entity_type, name, description, normalized_name, metadata_text) VALUES (new.entity_id, new.entity_type, new.name, new.description, new.normalized_name, (SELECT group_concat(value, ' ') FROM json_each(new.metadata) WHERE type = 'text'));
    END;
CREATE TRIGGER kg_entities_fts_au AFTER UPDATE ON kg_entities BEGIN
      DELETE FROM kg_entities_fts WHERE entity_id = old.entity_id;
      INSERT INTO kg_entities_fts(entity_id, entity_type, name, description, normalized_name, metadata_text) VALUES (new.entity_id, new.entity_type, new.name, new.description, new.normalized_name, (SELECT group_concat(value, ' ') FROM json_each(new.metadata) WHERE type = 'text'));
    END;
CREATE TRIGGER kg_entities_fts_ad AFTER DELETE ON kg_entities BEGIN
      DELETE FROM kg_entities_fts WHERE entity_id = old.entity_id;
    END;
CREATE TRIGGER kg_claims_fts_ai AFTER INSERT ON kg_claims BEGIN
      INSERT INTO kg_claims_fts(claim_id, entity_id, claim_type, statement, normalized_statement, metadata_text) VALUES (new.claim_id, new.entity_id, new.claim_type, new.statement, new.normalized_statement, (SELECT group_concat(value, ' ') FROM json_each(new.metadata) WHERE type = 'text'));
    END;
CREATE TRIGGER kg_claims_fts_au AFTER UPDATE ON kg_claims BEGIN
      DELETE FROM kg_claims_fts WHERE claim_id = old.claim_id;
      INSERT INTO kg_claims_fts(claim_id, entity_id, claim_type, statement, normalized_statement, metadata_text) VALUES (new.claim_id, new.entity_id, new.claim_type, new.statement, new.normalized_statement, (SELECT group_concat(value, ' ') FROM json_each(new.metadata) WHERE type = 'text'));
    END;
CREATE TRIGGER kg_claims_fts_ad AFTER DELETE ON kg_claims BEGIN
      DELETE FROM kg_claims_fts WHERE claim_id = old.claim_id;
    END;
CREATE TRIGGER kg_sources_fts_ai AFTER INSERT ON kg_sources BEGIN
      INSERT INTO kg_sources_fts(source_id, source_type, name, uri, author, publisher, metadata_text) VALUES (new.source_id, new.source_type, new.name, new.uri, new.author, new.publisher, (SELECT group_concat(value, ' ') FROM json_each(new.metadata) WHERE type = 'text'));
    END;
CREATE TRIGGER kg_sources_fts_au AFTER UPDATE ON kg_sources BEGIN
      DELETE FROM kg_sources_fts WHERE source_id = old.source_id;
      INSERT INTO kg_sources_fts(source_id, source_type, name, uri, author, publisher, metadata_text) VALUES (new.source_id, new.source_type, new.name, new.uri, new.author, new.publisher, (SELECT group_concat(value, ' ') FROM json_each(new.metadata) WHERE type = 'text'));
    END;
CREATE TRIGGER kg_sources_fts_ad AFTER DELETE ON kg_sources BEGIN
      DELETE FROM kg_sources_fts WHERE source_id = old.source_id;
    END;
INSERT INTO kg_metadata (key, value, updated_at) VALUES ('schema_version', '2.0.0', '2026-10-07T00:00:00.000Z');
