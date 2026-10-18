-- KG-2 legacy schema (pre KG-3 realignment), captured 2026-10-07 from the original untracked KG-2 code
-- by running KnowledgeGraphStore.initialize() on an empty temporary database. Test fixture only: lets the
-- KG-3 upgrade path be tested against the exact schema an early KG-2 database may contain.
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
      canonical_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      metadata TEXT NOT NULL DEFAULT '{}', provenance_source_id TEXT, provenance_created_at TEXT,
      CHECK (entity_type IN ('PERSON', 'ORGANIZATION', 'LOCATION', 'CONCEPT', 'EVENT', 'DOCUMENT', 'PROJECT', 'DEVICE', 'SOFTWARE', 'PROTOCOL', 'THREAT', 'VULNERABILITY', 'TECHNIQUE', 'TOOL', 'FRAMEWORK', 'STANDARD', 'LAW', 'REGULATION', 'COUNTRY', 'INDUSTRY', 'TECHNOLOGY', 'PROCESS', 'METHODOLOGY', 'ARTEFACT')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0)
    );
CREATE INDEX idx_kg_entities_type ON kg_entities(entity_type);
CREATE INDEX idx_kg_entities_name ON kg_entities(normalized_name);
CREATE INDEX idx_kg_entities_normalized ON kg_entities(normalized_name, entity_type);
CREATE INDEX idx_kg_entities_active ON kg_entities(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_entities_created ON kg_entities(created_at);
CREATE INDEX idx_kg_entities_trust ON kg_entities(trust_level);
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      CHECK (source_type IN ('HUMAN', 'DOCUMENT', 'WEB', 'API', 'DATABASE', 'FEED', 'REPORT', 'ARTICLE', 'BOOK', 'PAPER', 'PRESENTATION', 'VIDEO', 'AUDIO', 'IMAGE', 'SOCIAL_MEDIA', 'EMAIL', 'CHAT', 'INTERVIEW', 'SENSOR', 'LOG', 'ALERT', 'INTELLIGENCE', 'LEGAL', 'FINANCIAL', 'TECHNICAL', 'ACADEMIC', 'GOVERNMENT', 'INTERNAL', 'EXTERNAL')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0)
    );
CREATE INDEX idx_kg_sources_type ON kg_sources(source_type);
CREATE INDEX idx_kg_sources_name ON kg_sources(name);
CREATE INDEX idx_kg_sources_uri ON kg_sources(uri);
CREATE INDEX idx_kg_sources_active ON kg_sources(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_sources_trust ON kg_sources(trust_level);
CREATE INDEX idx_kg_sources_published ON kg_sources(published_at);
CREATE TABLE kg_aliases (
      alias_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      alias_type TEXT NOT NULL DEFAULT 'NAME',
      normalized_alias TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      source_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (entity_id) REFERENCES kg_entities(entity_id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES kg_sources(source_id) ON DELETE SET NULL,
      UNIQUE(entity_id, normalized_alias)
    );
CREATE INDEX idx_kg_aliases_entity ON kg_aliases(entity_id);
CREATE INDEX idx_kg_aliases_normalized ON kg_aliases(normalized_alias);
CREATE INDEX idx_kg_aliases_alias ON kg_aliases(alias);
CREATE INDEX idx_kg_aliases_primary ON kg_aliases(entity_id, is_primary) WHERE is_primary = 1;
CREATE TABLE kg_claims (
      claim_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      claim_type TEXT NOT NULL,
      statement TEXT NOT NULL,
      normalized_statement TEXT NOT NULL,
      source_id TEXT NOT NULL,
      author_entity_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      polarity TEXT NOT NULL DEFAULT 'NEUTRAL',
      metadata TEXT NOT NULL DEFAULT '{}', provenance_history TEXT DEFAULT '[]',
      FOREIGN KEY (entity_id) REFERENCES kg_entities(entity_id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES kg_sources(source_id) ON DELETE CASCADE,
      FOREIGN KEY (author_entity_id) REFERENCES kg_entities(entity_id) ON DELETE SET NULL,
      CHECK (claim_type IN ('FACT', 'HYPOTHESIS', 'THEORY', 'ALLEGATION', 'DENIAL', 'CONFIRMATION', 'CLASSIFICATION', 'RELATIONSHIP', 'ATTRIBUTION', 'CAUSATION', 'CORRELATION', 'PREDICTION', 'OBSERVATION', 'ANALYSIS', 'INTERPRETATION', 'RECOMMENDATION', 'WARNING', 'VULNERABILITY', 'EXPLOIT', 'IMPACT', 'MITIGATION', 'COUNTERMEASURE')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (polarity IN ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'UNKNOWN'))
    );
CREATE INDEX idx_kg_claims_entity ON kg_claims(entity_id);
CREATE INDEX idx_kg_claims_source ON kg_claims(source_id);
CREATE INDEX idx_kg_claims_type ON kg_claims(claim_type);
CREATE INDEX idx_kg_claims_normalized ON kg_claims(normalized_statement);
CREATE INDEX idx_kg_claims_active ON kg_claims(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_claims_trust ON kg_claims(trust_level);
CREATE INDEX idx_kg_claims_author ON kg_claims(author_entity_id);
CREATE INDEX idx_kg_claims_created ON kg_claims(created_at);
CREATE TABLE kg_evidence (
      evidence_id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_content TEXT NOT NULL,
      source_id TEXT NOT NULL,
      extracted_from TEXT,
      relevance_score REAL NOT NULL DEFAULT 0.0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (claim_id) REFERENCES kg_claims(claim_id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES kg_sources(source_id) ON DELETE CASCADE,
      CHECK (evidence_type IN ('DIRECT', 'INDIRECT', 'CIRCUMSTANTIAL', 'ANECDOTAL', 'VERIFIED', 'UNVERIFIED', 'DISPUTED', 'REFUTED', 'SUPPORTING', 'CONTRADICTING', 'CORROBORATING', 'UNRELIABLE', 'HEARSAY')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (relevance_score >= 0.0 AND relevance_score <= 1.0)
    );
CREATE INDEX idx_kg_evidence_claim ON kg_evidence(claim_id);
CREATE INDEX idx_kg_evidence_source ON kg_evidence(source_id);
CREATE INDEX idx_kg_evidence_type ON kg_evidence(evidence_type);
CREATE INDEX idx_kg_evidence_normalized ON kg_evidence(normalized_content);
CREATE INDEX idx_kg_evidence_active ON kg_evidence(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_evidence_trust ON kg_evidence(trust_level);
CREATE INDEX idx_kg_evidence_relevance ON kg_evidence(relevance_score DESC);
CREATE INDEX idx_kg_evidence_created ON kg_evidence(created_at);
CREATE TABLE kg_relationships (
      relationship_id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
      confidence REAL NOT NULL DEFAULT 0.0,
      source_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (source_entity_id) REFERENCES kg_entities(entity_id) ON DELETE CASCADE,
      FOREIGN KEY (target_entity_id) REFERENCES kg_entities(entity_id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES kg_sources(source_id) ON DELETE SET NULL,
      CHECK (relationship_type IN ('PART_OF', 'HAS_PART', 'CONTAINS', 'CONTAINED_IN', 'OWNED_BY', 'OWNS', 'CONTROLS', 'CONTROLLED_BY', 'CREATED_BY', 'CREATED', 'AUTHORED_BY', 'AUTHOR', 'PUBLISHED_BY', 'PUBLISHER', 'DISTRIBUTED_BY', 'DISTRIBUTOR', 'USES', 'USED_BY', 'IMPLEMENTS', 'IMPLEMENTED_BY', 'DEPENDS_ON', 'DEPENDENCY', 'REQUIRES', 'REQUIRED_BY', 'CONNECTED_TO', 'CONNECTION', 'COMMUNICATES_WITH', 'COMMUNICATION', 'ASSOCIATED_WITH', 'ASSOCIATION', 'LINKED_TO', 'LINK', 'RELATED_TO', 'RELATION', 'INFLUENCES', 'INFLUENCED_BY', 'CAUSES', 'CAUSED_BY', 'RESULTS_IN', 'RESULT_OF', 'PRECEDES', 'FOLLOWS', 'BEFORE', 'AFTER', 'SIMILAR_TO', 'SIMILARITY', 'DIFFERENT_FROM', 'DIFFERENCE', 'SUBTYPE_OF', 'SUpertYPE_OF', 'INSTANCE_OF', 'INSTANTIATES', 'MEMBER_OF', 'MEMBERSHIP', 'AFFILIATED_WITH', 'AFFILIATION', 'LOCATED_AT', 'LOCATION', 'OPERATES_IN', 'OPERATION', 'TARGETS', 'TARGETED_BY', 'AFFECTS', 'AFFECTED_BY', 'VULNERABLE_TO', 'EXPLOITS', 'MITIGATES', 'PREVENTS', 'DETECTS', 'RESPONDS_TO', 'COMPLIES_WITH', 'VIOLATES')),
      CHECK (trust_level IN ('UNKNOWN', 'UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED', 'TRUSTED', 'AUTHORITATIVE')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      UNIQUE(source_entity_id, target_entity_id, relationship_type)
    );
CREATE INDEX idx_kg_relationships_source ON kg_relationships(source_entity_id);
CREATE INDEX idx_kg_relationships_target ON kg_relationships(target_entity_id);
CREATE INDEX idx_kg_relationships_type ON kg_relationships(relationship_type);
CREATE INDEX idx_kg_relationships_active ON kg_relationships(is_active) WHERE is_active = 1;
CREATE INDEX idx_kg_relationships_pair ON kg_relationships(source_entity_id, target_entity_id);
CREATE VIRTUAL TABLE kg_entities_fts USING fts5(
      entity_id UNINDEXED,
      entity_type UNINDEXED,
      name,
      description,
      normalized_name UNINDEXED,
      metadata_text,
      tokenize = "unicode61 remove_diacritics 2"
    );
CREATE VIRTUAL TABLE kg_claims_fts USING fts5(
      claim_id UNINDEXED,
      entity_id UNINDEXED,
      claim_type UNINDEXED,
      statement,
      normalized_statement UNINDEXED,
      metadata_text,
      tokenize = "unicode61 remove_diacritics 2"
    );
CREATE VIRTUAL TABLE kg_sources_fts USING fts5(
      source_id UNINDEXED,
      source_type UNINDEXED,
      name,
      uri UNINDEXED,
      author,
      publisher,
      metadata_text,
      tokenize = "unicode61 remove_diacritics 2"
    );
CREATE INDEX idx_kg_entities_type_name ON kg_entities(entity_type, normalized_name);
CREATE INDEX idx_kg_claims_entity_type ON kg_claims(entity_id, claim_type);
CREATE INDEX idx_kg_evidence_claim_type ON kg_evidence(claim_id, evidence_type);
CREATE INDEX idx_kg_relationships_source_target ON kg_relationships(source_entity_id, target_entity_id);
CREATE INDEX idx_kg_relationships_type_active ON kg_relationships(relationship_type, is_active) WHERE is_active = 1;
CREATE TRIGGER kg_entities_fts_ai AFTER INSERT ON kg_entities BEGIN
      INSERT INTO kg_entities_fts(entity_id, entity_type, name, description, normalized_name, metadata_text)
      VALUES (new.entity_id, new.entity_type, new.name, new.description, new.normalized_name, json_extract(new.metadata, '$.*'));
    END;
CREATE TRIGGER kg_entities_fts_au AFTER UPDATE ON kg_entities BEGIN
      INSERT OR REPLACE INTO kg_entities_fts(entity_id, entity_type, name, description, normalized_name, metadata_text)
      VALUES (new.entity_id, new.entity_type, new.name, new.description, new.normalized_name, json_extract(new.metadata, '$.*'));
    END;
CREATE TRIGGER kg_entities_fts_ad AFTER DELETE ON kg_entities BEGIN
      DELETE FROM kg_entities_fts WHERE entity_id = old.entity_id;
    END;
CREATE TRIGGER kg_claims_fts_ai AFTER INSERT ON kg_claims BEGIN
      INSERT INTO kg_claims_fts(claim_id, entity_id, claim_type, statement, normalized_statement, metadata_text)
      VALUES (new.claim_id, new.entity_id, new.claim_type, new.statement, new.normalized_statement, json_extract(new.metadata, '$.*'));
    END;
CREATE TRIGGER kg_claims_fts_au AFTER UPDATE ON kg_claims BEGIN
      INSERT OR REPLACE INTO kg_claims_fts(claim_id, entity_id, claim_type, statement, normalized_statement, metadata_text)
      VALUES (new.claim_id, new.entity_id, new.claim_type, new.statement, new.normalized_statement, json_extract(new.metadata, '$.*'));
    END;
CREATE TRIGGER kg_claims_fts_ad AFTER DELETE ON kg_claims BEGIN
      DELETE FROM kg_claims_fts WHERE claim_id = old.claim_id;
    END;
CREATE TRIGGER kg_sources_fts_ai AFTER INSERT ON kg_sources BEGIN
      INSERT INTO kg_sources_fts(source_id, source_type, name, uri, author, publisher, metadata_text)
      VALUES (new.source_id, new.source_type, new.name, new.uri, new.author, new.publisher, json_extract(new.metadata, '$.*'));
    END;
CREATE TRIGGER kg_sources_fts_au AFTER UPDATE ON kg_sources BEGIN
      INSERT OR REPLACE INTO kg_sources_fts(source_id, source_type, name, uri, author, publisher, metadata_text)
      VALUES (new.source_id, new.source_type, new.name, new.uri, new.author, new.publisher, json_extract(new.metadata, '$.*'));
    END;
CREATE TRIGGER kg_sources_fts_ad AFTER DELETE ON kg_sources BEGIN
      DELETE FROM kg_sources_fts WHERE source_id = old.source_id;
    END;
INSERT INTO kg_metadata (key, value, updated_at) VALUES ('schema_version', '1.3.0', '2026-10-07T00:00:00.000Z');
