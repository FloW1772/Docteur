# Docteur — Knowledge Graph V1

Date: 2026-10-07 (KG-1) → 2026-10-12 (KG-CERT)  
Current phase: KG-CERT — final certification (see the last section)  
Phase status: KG-1 → KG-8 PASS; KG-CERT verdict `KNOWLEDGE_GRAPH_V1_CERTIFICATION_PASS_WITH_LIMITATIONS`  
Activation status: `DISABLED_PENDING_HUMAN_ACTIVATION` (not FINAL, not FROZEN, nothing staged or committed).

> Note historique : ce rapport décrit l'état du projet au 12 octobre 2026. Depuis cette date, le Knowledge Graph a été intégré au dépôt et activé. Les anciens verdicts doivent être interprétés dans leur contexte.

The sections below are kept in phase order; each phase section describes the state at
the end of that phase. Where a later phase changed a rule, the later section wins (for
example the KG-8 "sources scope sees every provenance" limitation was closed in KG-CERT).

## Architectural decision

Knowledge Graph V1 will be a local, derived, reconstructible, source-first layer.
It will not replace Notebook, Neurone, Article Canonical, Docteur Memory, or any
existing retrieval engine. A graph row never grants a capability or permission.

Recommended physical store: explicit, indexed SQLite tables in the existing local
database, implemented by a new Knowledge Graph schema/store module outside Frozen
Notebook. Tests and migrations must use temporary databases. Neo4j or another
external graph database is not required for V1.

SQLite FTS5 is appropriate for initial entity/claim text search. LanceDB may later
hold optional derived embeddings in a dedicated table, using the existing local
embedding conventions; KG-2 does not require vectors.

## Existing data and contracts

### Neurone

- Durable object: `pages(id, data, updated_at)` in SQLite; `data` is the complete
  page JSON object.
- Semantic index: LanceDB table `neurons`, keyed by the same page/neuron `id`.
- Vector row: id, kind, title, content, content preview, serialized metadata,
  vector, created/updated timestamps.
- Public operations include metadata lists, object lookup, bounded vector search,
  ID-scoped retrieval, upsert, and delete.
- Delete removes both the page-store record and its LanceDB row. Notebook source
  references do not own or delete the underlying Neurone.
- Privacy is derived from page kind and metadata by existing Notebook/Memory
  adapters; private content is not handed to Agency or Professor consumers.

### Notebook

- `notebooks` owns workspace metadata and derived privacy/egress policy.
- `notebook_sources` references existing Neurones or derived Notebook imports;
  it stores source type/ref, title, provenance, privacy, and egress policy.
- Imported documents use `nb_documents`, `nb_document_versions`, `nb_chunks`,
  `nb_chunks_fts`, and `nb_chunk_embeddings`; vectors use LanceDB
  `notebook_chunks`.
- Document identity/versioning includes document ID, content/file hash,
  canonical URI, current version, retention, trust, and origin.
- Historical AI imports use typed conversations/messages with provider,
  original IDs, parent IDs, role, timestamps, hashes, branch/main-path state,
  attachments, and import provenance.
- Approved Notebook memory uses separate `dmem_*` tables with evidence,
  revisions, conflicts, suggestions, usage audit, FTS, and embedding metadata.
- Frozen public read contracts are sufficient for a separate KG adapter. No
  Notebook file needs modification.

### Sources, chunks, citations, and deletion

- Document citations resolve an exact stored chunk and verify Notebook scope,
  visibility/retention, version ID, and text hash.
- AI-history citations are typed `AI_HISTORY_MESSAGE` and verify the stored
  chunk/hash plus conversation/message provenance.
- Unified retrieval names citation types `NEURON`, `DOCUMENT_CHUNK`, and
  `AI_HISTORY_MESSAGE`; results remain namespaced.
- PDF chunks retain page numbers; other document chunks retain heading paths and
  character offsets.
- Deleting a document transactionally purges FTS, embedding metadata, chunks,
  versions, AI-history rows where applicable, and then vectors; approved memories
  keep an audit-safe `SOURCE_MISSING` evidence state and are flagged for review.
- Superseded document versions remain citable until explicitly deleted.

### Article Canonical and capture paths

- `canonical-article.js` is the single article normalization and deduplication
  pipeline for URL extraction and pasted/MSN-style input.
- Its canonical representation supplies normalized content, canonical URL,
  content hash, source, author, publication timestamp, media metadata, and
  technical provenance.
- Captured articles are persisted as Neurones with
  `metadata.canonical_article`; duplicate detection uses canonical URL first and
  content hash as a second identity signal, without deleting the existing item.
- The KG source adapter must consume this metadata. It must not recanonicalize
  article bodies or build a second MSN/URL deduplication path.
- Multiple technical captures may attach to one logical `kg_source`, while each
  capture provenance remains represented by a `kg_source_ref`.

### Other inputs

- Notebook parsers already handle TXT, Markdown, PDF, HTML, and JSON locally.
  PDF page provenance and sanitized HTML text remain available through chunks.
- Web captures and connector material ultimately use Neurone/page identity and
  metadata; the graph should adapt those records rather than fetch them again.
- Historical AI imports already expose normalized conversations/messages and
  typed provenance. Real ChatGPT/Claude/Gemini export validation remains
  incomplete because no real exports were supplied; KG must not infer missing
  provider data.
- Code Intelligence is a separate, bounded, loopback-only, read-only gateway over
  repository search and Git inspection. If integrated later, it should remain a
  separate read-only subgraph/trust domain.

### Current consumers

- Agency uses a bounded read-only `knowledge.search` adapter over public Neurone
  search; save remains approval-gated.
- Professor performs bounded Neurone retrieval, excludes private Neurones, and
  returns explicit source IDs/titles.
- Neither consumer currently depends on graph tables. KG-8 can expose a typed
  consumer API without modifying those modules in KG-1.

## Proposed logical schema

Names are proposed for KG-2 and may be refined only if implementation constraints
are demonstrated. Entity types are extensible strings with an initial controlled
set: `PERSON`, `ORGANIZATION`, `PROJECT`, `PRODUCT`, `CONCEPT`, `PLACE`, `EVENT`,
and `DOCUMENT`.

### `kg_entities`

- `entity_id` — opaque KG ID
- `entity_type`
- `canonical_label` — original display form, never comparison-folded in place
- `normalized_label` — comparison/search form
- `status` — `ACTIVE`, `AMBIGUOUS`, `MERGED`, `INVALIDATED`
- `merged_into_id` — nullable and reversible through resolution audit
- `created_at`, `updated_at`

Stable identifiers should use a separate bounded table so identifiers are typed
and unique only in the correct namespace:

### `kg_entity_identifiers`

- `identifier_id`, `entity_id`
- `scheme`, `normalized_value`, `original_value`
- `source_id`, `confidence`, `status`
- `created_at`

### `kg_aliases`

- `alias_id`, `entity_id`
- `normalized_alias`, `original_alias`
- `source_id` and/or `evidence_id`
- `confidence`
- `status` — `PROPOSED`, `CONFIRMED`, `REJECTED`, `INVALIDATED`
- `created_at`, `updated_at`

An alias never changes `canonical_label` implicitly and one generic label is not
sufficient evidence for a merge.

### `kg_sources`

- `source_id` — logical documentary source
- `source_type`
- `logical_key` — deterministic key from an existing stable ID, canonical URL,
  or content hash according to source adapter
- `canonical_url`, `content_hash`
- `privacy`, `egress_policy`
- `status` — `ACTIVE`, `DELETED`, `INVALIDATED`, `SUPERSEDED`
- `created_at`, `updated_at`, `invalidated_at`

### `kg_source_refs`

Preserves multiple technical provenances for one logical source:

- `source_ref_id`, `source_id`
- `adapter` — e.g. Neurone, Notebook document, AI-history message, article capture
- `source_ref`, `version_ref`
- `provenance` — bounded JSON metadata, not source content
- `observed_at`, `created_at`, `deleted_at`

This is the mechanism by which an MSN capture and URL capture of the same
Canonical Article converge while retaining both origins.

### `kg_evidence`

- `evidence_id`, `source_id`, `source_ref_id`
- `locator_kind` — chunk, page, section, message, paragraph, source-level
- `locator_ref`
- optional `chunk_id`, `message_id`, `page`, `section`
- `excerpt_hash` — no duplicated large text
- optional bounded preview only if already permitted by source privacy
- `status` — `ACTIVE`, `SOURCE_MISSING`, `INVALIDATED`
- `created_at`, `updated_at`

Evidence always resolves back to the original store. It does not become a second
document repository.

### `kg_claims`

- `claim_id`
- `subject_entity_id`, `predicate`
- exactly one of `object_entity_id` or typed `value_json`
- `status` — `ASSERTED`, `SUPPORTED`, `DISPUTED`, `SUPERSEDED`, `INVALIDATED`,
  `HYPOTHESIS`
- `extraction_method` — `USER`, `DETERMINISTIC`, or `MODEL_PROPOSAL`
- `model_confidence` and `source_confidence` — separate nullable fields
- `observed_at`, `valid_from`, `valid_to`
- `created_at`, `updated_at`, `superseded_by_id`

Non-user claims require evidence. Model output starts as `HYPOTHESIS` and never
becomes truth or authority merely because confidence is high.

### `kg_claim_evidence`

- `claim_id`, `evidence_id`
- `stance` — `SUPPORTS` or `DISPUTES`
- `attached_at`
- composite uniqueness to make attachment idempotent

This permits multiple evidence rows per claim and the same evidence to support or
dispute multiple explicit claims.

### `kg_claim_conflicts`

- `conflict_id`, `claim_a_id`, `claim_b_id`
- `kind`, `status`, `detected_at`, `resolved_at`, `resolution`

Conflicts preserve both claims, evidence sets, dates, and confidence dimensions.
Resolution is explicit; insertion never overwrites a competing claim.

### `kg_entity_resolutions`

- `resolution_id`, `source_entity_id`, `target_entity_id`
- `decision` — `PROPOSED`, `CONFIRMED`, `REJECTED`, `REVERSED`
- `reason`, `evidence_json`, `created_at`, `decided_at`, `reversed_at`

Original entity IDs remain addressable. A reversal restores them without rewriting
source evidence.

## Index and identity plan

- Unique source adapter/ref and source logical key constraints.
- Entity index by type/status and normalized label; FTS5 over canonical labels and
  aliases.
- Identifier uniqueness scoped by scheme, with ambiguity represented instead of
  destructive merge.
- Claim indexes on subject, object, predicate, status, temporal fields.
- Evidence indexes on source and locator.
- Claim/evidence and conflict pair composite uniqueness.
- Deterministic hashes for natural upsert keys; opaque IDs remain implementation
  IDs rather than permissions.

## Temporal and invalidation model

- `observed_at`: when a source or extraction observed the assertion.
- `valid_from` / `valid_to`: interval the assertion claims to describe.
- `created_at` / `updated_at`: graph bookkeeping only.
- Later information does not delete older information. It may explicitly
  supersede it while preserving the historical claim and evidence.
- Source deletion marks its refs/evidence unavailable and recalculates dependent
  claim status. A claim remains supported if another active evidence row supports
  it; otherwise it becomes invalidated or disputed according to remaining stance.
- The entire derived graph can be rebuilt from active source adapters.

## Threat model and required controls

| Threat | Required V1 control |
|---|---|
| Prompt injection in source | Treat all source text and labels as data; no tools; structured boundaries; injection flags propagated |
| Entity/claim poisoning | Evidence required, source and model confidence separated, per-source extraction limits, provenance and audit |
| Alias collision/homonyms | Never merge on one normalized label; require stable ID or corroborating context; preserve ambiguity |
| Destructive resolution | Resolution ledger, tombstones/redirects, explicit confirmation, reversible merge |
| Massive expansion / DoS | Per-source entity/claim quotas, bounded batches, input-size limits, transactional writes |
| Traversal amplification | Hard depth/node/edge/claim/byte limits, cyclic-visit set, timeout, no whole-graph endpoint |
| Privacy leakage | Propagate most restrictive source privacy/egress; filter before traversal/ranking; no cross-scope fallback |
| Cloud leakage | Strict Local default; existing router only; no silent local-to-cloud fallback; model extraction remains proposal |
| Source deletion | Explicit source/evidence states and deterministic claim recomputation; no orphan citation |
| Trust inheritance | Graph fields are descriptive only; no authorization or executor consumes edges as permissions |
| Malicious URLs | Consume Article Canonical URLs; allowlisted display/open protocols; never fetch during graph rendering |
| XSS labels/evidence | Render as text, never raw HTML; sanitize link protocols; CSP remains applicable |
| SQL/FTS injection | Prepared statements, quoted FTS terms, bounded predicates/filters, opaque validated IDs |
| Cycles and huge fan-out | Stable visited set, deterministic pagination, per-hop fan-out cap |
| Cross-domain confusion | Preserve source kind/trust domain; keep Code Intelligence and operational-device relations separately scoped |

## Baseline

Repository state before KG-1:

- Branch: `main`
- HEAD: `111d2bbd1e9b12702adc1ba9bca01f556ab4b40d`
- Git index: empty
- Existing untracked local validation report preserved (not published).
- Notebook freeze: 71 files, drift 0

Targeted backend baseline:

```text
node --test --test-concurrency=1 \
  test-article-canonical.mjs \
  test-phase5-notebook.mjs \
  test-nb2-notebook-documents.mjs \
  test-nb3-notebook-rag.mjs

105 tests; 104 pass; 0 fail; 0 cancelled; 1 skipped
```

The skipped test is the optional real local `nomic-embed-text` calibration because
the local model was unavailable. Deterministic FTS/vector fixtures passed.

- Typecheck: PASS (`npx tsc --noEmit`)
- Production build: PASS (`npm run build`)
- Build note: Vite reported non-fatal existing large-chunk warnings.
- Article Canonical MSN/URL convergence: PASS
- Notebook/Neurone isolation and privacy: PASS
- Retrieval and exact citation verification: PASS
- Delete/invalidation baseline: PASS

## KG-1 limitations and next gate

No Knowledge Graph schema, migration, store, API, extraction, retrieval, or UI has
been implemented in KG-1. Performance figures for graph operations do not exist yet.

KG-2 may begin only after explicit human authorization. Its minimal scope should be
the additive SQLite schema, idempotent transactional store primitives, and bounded
read-only APIs, all tested against temporary databases.

---

## KG-3 — Schema realignment + normalisation + entity resolution

Date: 2026-10-07 · HEAD at start: `111d2bb` · Git index: empty (no Git mutation).
Human decision: option (a) — the KG-1 contract is authoritative; KG-2 deviations
are treated as design bugs and corrected before entity resolution.

### KG-3A — audit of KG-2 and realignment

**Boot (`server.js`).** KG-2 called `KnowledgeGraphStore.createTestStore(env.SQLITE_PATH)`
at every start. Audit: that helper opens the *user* database read-write
(`readOnly: false`), switches it to WAL, enables foreign keys and runs every KG
migration — a normal `npm run dev` would have created all `kg_*` tables in
`data/cortex.sqlite`. Its own comment says it is meant for tests. Before KG-3 the
real database contained no `kg_*` table (verified), so nothing had to be repaired.
Fix: `src/lib/kg-boot.js`. Until KG-CERT the KG is **off** on a normal boot
(`/api/kg/*` → `503 KG_DISABLED`, reason `KG_UNCERTIFIED_DISABLED`). Only the
internal development/certification variable `DOCTEUR_KG_DEV_DB=<absolute path>`
opens it, and only on a *separate* file: the user database path (case-insensitive,
realpath) and any file in the user data directory are refused. No user setting.

**Cascade audit (KG-2 foreign keys).** None was a safe structural cascade: each one
silently destroyed or detached knowledge. All are now `ON DELETE RESTRICT`
(constraint kept, action changed); deletion is replaced by invalidation.

| KG-2 foreign key | Action | Classification |
|---|---|---|
| `kg_aliases.entity_id → kg_entities` | CASCADE | semantically destructive (aliases + provenance lost) |
| `kg_aliases.source_id → kg_sources` | SET NULL | semantically destructive (provenance erased) |
| `kg_claims.entity_id → kg_entities` | CASCADE | semantically destructive |
| `kg_claims.source_id → kg_sources` | CASCADE | semantically destructive (source delete wipes claims without history) |
| `kg_claims.author_entity_id → kg_entities` | SET NULL | semantically destructive (attribution erased) |
| `kg_evidence.claim_id → kg_claims` | CASCADE | semantically destructive |
| `kg_evidence.source_id → kg_sources` | CASCADE | semantically destructive |
| `kg_relationships.source/target_entity_id → kg_entities` | CASCADE | semantically destructive |
| `kg_relationships.source_id → kg_sources` | SET NULL | semantically destructive |

FTS rows are maintained by triggers (derived index), not by foreign keys.

**`importData({ reset })`.** KG-2 could empty six tables in one call. No route
exposed it, but nothing prevented a future caller. Decision: removed — `reset` now
throws `KG_RESET_NOT_SUPPORTED`; import is additive and idempotent. Rebuilding the
graph from its sources will be a separate, explicit workflow.

**Other KG-2 defects found and fixed** (all on temporary databases):
- entity IDs derived from the name only: `"apple"` PERSON overwrote `"Apple"`
  ORGANIZATION (same row, type changed) — a forced, destructive merge. IDs are now
  opaque or provenance-based; an entity's type is immutable;
- FTS triggers used `INSERT OR REPLACE` on FTS5 (no unique key): one duplicate FTS
  row per update; `json_extract(metadata, '$.*')` is not a valid path, so metadata
  was never indexed. Triggers now delete then insert and index top-level metadata
  strings; the migration rebuilds the FTS content;
- `searchEntitiesFTS` / `searchClaims` passed user text straight to `MATCH`: terms
  are now quoted (no FTS operator injection); `LIKE` wildcards are escaped;
- `GET /api/kg/config/source-types` returned the entity types.

**Schema 2.0.0** (`kg-schema.js` is the single DDL source; migration `005`):

- new `kg_entity_identifiers`, `kg_source_refs`, `kg_claim_evidence`
  (N:N, `SUPPORTS|CONTRADICTS`, `ACTIVE|DETACHED`), `kg_entity_resolutions`
  (decision, method, reason, confidence, signals, provenance, actor, previous
  status/redirect, decided/reversed dates; at most one `CONFIRMED` per source entity);
- `kg_entities`: `status` (`ACTIVE|AMBIGUOUS|MERGED|INVALIDATED`), `merged_into_id`
  (logical redirect), `label_key`, `token_key`; types `PRODUCT` and `PLACE` added
  (`PLACE` ≡ KG-2 `LOCATION`);
- `kg_sources`: `logical_key` (unique), `canonical_url`, `content_hash`,
  `privacy`, `egress_policy`, `status`, `invalidated_at`;
- `kg_claims`: `predicate`, `object_entity_id | value_json`, `status`,
  `extraction_method`, separate `model_confidence` / `source_confidence`,
  `observed_at`, `valid_from`, `valid_to`, `superseded_by_id` (their logic is KG-4);
- `kg_evidence`: locator (`kind`, `ref`, chunk/message/page/section),
  `excerpt_hash`, `source_ref_id`, `status`; identity = source + locator + excerpt
  (independent of any claim); only a 500-character preview is stored.

Migration mechanics: each migration runs in one transaction with its version bump,
foreign keys suspended, and must pass `PRAGMA foreign_key_check` before commit.
A fresh install (001) creates the realigned schema directly; an early KG-2 database
is upgraded by 005 (structural detection, SQLite table rebuild, data kept, 1:N
evidence links turned into `kg_claim_evidence` rows, statuses derived from
`is_active`, FTS rebuilt). Fresh and upgraded databases are structurally identical
(tested). The exact KG-2 schema is kept as a test fixture
(`fixtures/kg2-legacy-schema.sql`).

**Invalidation.** `invalidateSource` → source `INVALIDATED|DELETED`, refs
invalidated, evidence `SOURCE_MISSING` (kept), every linked claim recomputed from
its *other* evidence (`SUPPORTED`, `DISPUTED`, or `INVALIDATED` when none remains);
entities untouched. `invalidateSourceRef` keeps the logical source active while
another technical path exists (e.g. MSN capture deleted, URL capture kept).

### KG-3B — normalisation (`kg-normalize.js`)

Comparison keys only; originals are always stored as given.
`labelKey`: NFKC, invisible characters (zero-width, BOM, soft hyphen, VS15/16)
removed, typographic apostrophes → `'`, hyphens/dashes → `-`, whitespace, tabs and
newlines collapsed, full case folding (`ß` → `ss`). Accents kept. `looseKey`:
`labelKey` minus the combining diacritics U+0300–U+036F only (Latin, Greek,
Cyrillic); marks of other scripts (Devanagari, kana…) are letters and are kept.
`tokenKey`: sorted tokens (candidate generation only). Identifiers are validated per
scheme (Wikidata, DOI, ISBN-10/13 with checksum, ORCID with checksum, domain incl.
IDN → punycode, URL via Article Canonical `canonicalizeUrl`, e-mail stored only as
SHA-256, product / registry ids, provider-qualified external ids); an invalid value
is refused, never guessed.

### KG-3C — entity resolution (`kg-resolution.js`)

Order: (1) exact stable identifier valid for the type → match; several entities →
`AMBIGUOUS`; (2) same provenance re-imported → same entity (idempotent); (3) same
label/alias + at least one corroborating signal (shared related entity, agreeing
attribute, shared non-strong identifier, same logical source) and no contradicting
one (different attribute, different single-valued identifier), for exactly one
candidate. Otherwise a new entity is created: `AMBIGUOUS`, with every candidate kept
as a `PROPOSED` resolution, when same-label candidates exist; contradicted homonyms
are listed but not proposed. Similar labels (one edit, token reorder) and model
(LLM) suggestions are `PROPOSED` only; the system cannot confirm them
(`KG_AUTO_MERGE_FORBIDDEN`). Incompatible types never resolve and cannot be merged.
Merge = ledger row + `merged_into_id` redirect to the logical root; no entity,
alias, identifier, claim or evidence is deleted or rewritten; `reverseResolution`
restores the previous status and redirect; chains and cycles are guarded.

**Article Canonical.** `ingestArticleNeuron` reads `metadata.canonical_article` and
applies Article Canonical's own identity order (canonical URL, then content hash —
same as `findDuplicateArticle`); it never re-canonicalises a body. One logical
`kg_source` per article, one `kg_source_ref` per capture (MSN paste / URL extraction
/ paste without URL) with input path, original URL, capture id, content hash and
extractor. Divergences (same URL / different hash, same hash / other URL) are
attached the way Article Canonical decides and recorded on the ref, never hidden.

**Notebook.** `ingestNotebookDocument` consumes the frozen public reads
(`getDocument`, `listDocuments`, `getNotebook`) as plain objects; logical identity =
canonical URI or file hash; each Notebook document stays its own ref (document id +
current version id). Privacy follows the existing `isLocalOnlySource` contract; a
logical source takes the most restrictive privacy of its refs and never loosens.

### KG-3 tests and measurements

- `test-kg-schema-realignment.mjs` — 18/18 (fresh, double, upgrade from KG-2,
  interruption + rollback, FK actions, FTS, homonym IDs, N:N, refs, invalidation,
  ledger + reverse, read-only API with zero writes, no reset, disabled API, boot gate).
- `test-kg-entity-resolution.mjs` — 20/20 (normalisation, identifiers, aliases,
  homonyms, cross-type, ambiguity, LLM/similarity proposals, reimport, reversible
  merge with claims/evidence, restart, MSN + URL through the real Article Canonical
  pipeline and HTML extractor, article privacy, Notebook preservation, volume 1 000).
- KG-2 suite (`scripts/test-kg.js --all`) — 62 pass / 0 fail / 1 skipped (one test
  adapted: it wrapped `runMigrations` in a transaction, which is now refused).
- Targeted regression (KG + Root Policy static audit + Article Canonical + Notebook
  phase5/NB-2/NB-3) — 156 tests, 155 pass, 0 fail, 1 skipped (optional real
  `nomic-embed-text` calibration, as in the KG-1 baseline).
- `kg3-resolution-benchmark.mjs` (synthetic, homonym-heavy on purpose, temporary
  file database): per mention — create 1.3 / 2.6 / 5.4 ms, resolve 0.8 / 1.9 /
  4.1 ms at 100 / 1 000 / 10 000; 0 system-confirmed merges; every lookup is an
  index search (identifier, label, alias, replay, tokens, similarity range).

### KG-3 known limitations

- Proposal fan-out: a bare mention of a very common name records up to 20
  `PROPOSED` rows; the homonym-heavy 10 000 benchmark produced 180 032 proposals
  (≈ 100 MB database). Grouping / pruning proposals belongs with the review UI (KG-6).
- Similarity candidates use a first-half prefix block: one edit in the second half
  of a label is found, one in the first half is not (candidate recall only — never
  a merge).
- Same-provenance replay assumes one sense per label per source: two different
  people with the same name in the same document resolve together unless their
  attributes or identifiers contradict.
- Claim status recomputation is minimal (evidence-driven); contradictions,
  supersession and temporal reasoning are KG-4.
- Nothing feeds the KG yet (no extraction, no automatic ingestion of neurons or
  Notebook documents): the adapters exist and are tested; wiring is KG-7.
- The KG stays off on a normal boot until KG-CERT.

---

## KG-4 — Claims, evidence, provenance, temporality, contradictions

Date: 2026-10-07 · HEAD: `111d2bb` · Git index: empty (no Git mutation) · schema 2.1.0.

### Model

`kg-claim-model.js` (pure), `kg-claims.js`, `kg-extraction.js`; migration `006`
(`claim_key`, evidence `char_start`/`char_end`, `kg_claim_conflicts`). Migrations 005
and 006 share one "realign to the current DDL" routine whose data fix-ups depend on
the columns a table lacked, so an early KG-2 database, a KG-3 (2.0.0) database and a
fresh install end structurally identical (tested with both fixtures).

- **Claim** = `subject —predicate→ objectEntityId | typed value` (exactly one),
  `status`, `extraction_method` (`USER | DETERMINISTIC | MODEL_PROPOSAL`),
  `model_confidence`, `source_confidence` (separate columns, never combined),
  `observed_at`, `valid_from`, `valid_to`, `created_at`, `updated_at`,
  `superseded_by_id`. Values: `string` (≤ 1 000 chars, no control characters,
  stored verbatim as data), `number` (+ unit), `boolean`, `date`, `url` (http(s)
  only, Article Canonical `canonicalizeUrl`).
- **Identity**: `claim_key` = hash(subject, predicate, object, interval) — independent
  of the source. Same claim from two sources = 1 claim + 2 evidences; the same
  extraction repeated from the same source adds nothing. A stronger assertion
  upgrades the method (`MODEL_PROPOSAL < DETERMINISTIC < USER`); confidences are
  merged per column (max), never across columns.
- **Evidence required**: a derived claim (`DETERMINISTIC`, `MODEL_PROPOSAL`) is
  rejected without ≥ 1 evidence (also enforced in the low-level `upsertClaim` and in
  `verifyIntegrity`). Evidence = source (must be ACTIVE) + optional technical ref +
  exact locator (`SOURCE | CHUNK | PAGE | SECTION | MESSAGE | PARAGRAPH`, chunk id,
  page ≥ 1, section, message id, character offsets) + `excerpt_hash`; only a
  500-character preview is stored. Any invalid evidence rejects the whole assertion
  (one transaction).
- **Statuses** (no new ones): `ASSERTED` (user claim without evidence), `SUPPORTED`,
  `HYPOTHESIS` (every model proposal, whatever its confidence or evidence count),
  `DISPUTED`, `SUPERSEDED`, `INVALIDATED`. Status is derived from the ACTIVE evidence
  links (supports/contradicts) plus open contradictions; it is never chosen.

### Contradictions (rules)

`kg_claim_conflicts` records a `SINGLE_VALUE_CONFLICT` only when ALL hold:
1. the predicate is **single-valued** in the registry (`ceo`, `headquarters`,
   `parent_organization`, `located_in`, `publisher`, `published_on`, `date_of_birth`,
   `founded_on`, `price`, `status`, `population`);
2. both claims are live (not `INVALIDATED` / `SUPERSEDED`) and about the same logical
   subject;
3. their objects differ (different logical entities, or different normalised values;
   an entity vs a value is incomparable → no conflict);
4. their validity intervals overlap — half-open `[validFrom, validTo)`, a missing
   bound is unbounded, so two undated claims overlap.

Never a contradiction: multi-valued predicates (`author`, `founder`, `employer`,
`member_of`, `website`, `version`, `related_to`), unknown predicates (accepted with a
strict syntax, treated as multi-valued), successive periods (same-day handover
included). Both claims are kept and marked `DISPUTED` (a model `HYPOTHESIS` stays
`HYPOTHESIS`; the conflict is still recorded). Evidence with stance `CONTRADICTS`
also makes a claim `DISPUTED`. KG-4 never picks a winner.

**Supersession** is explicit (`supersedes` on assertion, or `supersedeClaim`): same
subject + predicate only; the old claim becomes `SUPERSEDED` with its evidence and
remains queryable as history; a conflict between the two is `RESOLVED`
(`SUPERSEDED`). `recheckConflicts` resolves (`NO_LONGER_CONFLICTING`) a conflict
that an entity merge made moot. No conflict or claim row is ever deleted.

**Invalidation**: a source invalidation marks its evidence `SOURCE_MISSING`; each
claim is recomputed from its other evidence (`SUPPORTED` stays only with an active
supporting evidence, else `INVALIDATED`); a claim that becomes (or stops being) live
recomputes the claims it conflicts with.

### Provenance and privacy

`explainClaim` returns subject/object (labels, logical ids), value, status, method,
both confidences, observed/valid dates, temporal state (`PAST | CURRENT | FUTURE`),
every evidence (stance, link status, locator, excerpt hash, preview, source, technical
ref and its observation date), contradictions with the counterpart claim, supersession
history. Private sources are filtered by default (also on the HTTP API, unless
`?includePrivate=1`): private evidence is never returned; a claim known only through a
private source is invisible; a contradiction is shown only when both claims are
visible. Read-only routes added: `GET /claims/:id/explain`,
`GET /entities/:id/claims/valid-at?date=`, `GET /entities/:id/conflicts`.

### Extraction

- **Deterministic first**: `extractArticleMetadataClaims` turns Article Canonical
  metadata into `author`, `publisher`, `published_on` claims (`DETERMINISTIC`,
  locator `SECTION metadata.canonical_article.<field>`).
- **Model (optional, injected)**: `extractClaimsWithLocalModel` — Strict Local (the
  completion must report `provider: 'local'`, otherwise nothing is stored and no
  other provider is tried), source text inside explicit delimiters as untrusted data,
  JSON validated field by field (registered predicates only, no extra fields, bounded
  strings, typed values, confidence ∈ [0, 1], ≤ 50 claims), every quote must be found
  verbatim in the text (its offsets become the locator). Valid claims are stored as
  `MODEL_PROPOSAL` → `HYPOTHESIS`; invalid ones are rejected with a reason; predicates
  already covered deterministically are skipped. No model is wired into Docteur yet
  (tests use a scripted local function).

### KG-4 tests and measurements

- `test-kg-claims.mjs` — 19/19: simple / entity→entity / entity→value claims,
  evidence required, missing and invalid evidence (nothing written), multi-evidence,
  same claim from 2 sources, duplicate from the same source, SUPPORTS / CONTRADICTS
  N:N, model vs source confidence, no auto-promotion, contradictions (undated and
  overlapping), multi-valued and unknown predicates, temporal change without
  conflict, past / current / future / interval / undated, supersession, source
  invalidation with and without remaining evidence, reload + restart in a separate
  process (identical rows), upgrade from 2.0.0, deterministic article claims, model
  extraction (Strict Local, invalid JSON, hallucinated quote, injected predicate,
  extra fields), security (malicious predicate, oversized value, HTML/script, `javascript:`
  / `data:` / `file:` URLs, invalid ids), privacy (no private evidence, no leak via
  conflicts or HTTP), merge + recheck, read-only API, volume, registry.
- Regression: KG-2 suite 62 / 0 fail / 1 skipped; KG-3 suites 38/38; Root Policy
  static audit, Article Canonical and Notebook phase5/NB-2/NB-3 — together with KG-4:
  175 tests, 174 pass, 0 fail, 1 skipped (optional real `nomic-embed-text`
  calibration). Notebook freeze: 71 files, drift 0.
- Volume (synthetic, temporary file DB): 1 050 claims, 2 100 evidences, 150
  contradictions — insert ≈ 3.7–4.1 ms/claim; claim lookup ≈ 0.46 ms, evidence lookup
  ≈ 0.5 ms, contradiction query ≈ 0.4–0.5 ms, temporal query ≈ 0.3–0.5 ms (per
  query); claim lookups use `idx_kg_claims_subject_predicate`.

### KG-4 known limitations

- Contradiction detection is evaluated when a claim is asserted (and on
  `recheckConflicts`); an entity merge does not automatically re-scan every claim.
- Supersession is never inferred (e.g. from a later `observedAt`): it must be explicit.
- The predicate registry is small and hand-curated; unknown predicates never produce
  contradictions (by design, no false positives).
- `sourceConfidence` is supplied by the caller; it is not yet derived from source
  trust levels.
- Privacy is per source (`PRIVATE`); entity labels themselves carry no privacy flag —
  an entity first seen in a private source keeps its label in entity endpoints.
- No producer is wired yet (neurons / Notebook / local model → KG is KG-7).

---

## KG-5 — Hybrid retrieval

Date: 2026-10-07 · HEAD: `111d2bb` · Git index: empty (no Git mutation) · schema 2.2.0.
New: `kg-retrieval.js`, `kg-semantic.js`, routes `POST /api/kg/search` and
`POST /api/kg/retrieve` (structured READ queries, nothing written). Migration `007`:
FTS rows keyed by the base `rowid`, new `kg_evidence_fts`.

### Audit of existing infrastructure

- Notebook retrieval (FTS5 + LanceDB `notebook_chunks` + RRF fusion,
  `notebook-retrieval.js` / `notebook-documents.js`) is FROZEN: used only through its
  public `search()` for the baseline; nothing in Notebook was modified.
- `lancedb.js` (not frozen) holds ONE module-wide connection, so a KG table cannot
  safely share it. The KG semantic layer opens its own connection to the SAME engine
  (`@lancedb/lancedb`) for a separate, derived, rebuildable table `kg_semantic`
  (entity + claim texts). No second vector engine, no Notebook / neuron table touched.
- Embeddings: injected embedder that must report `provider: 'local'` (checked at
  probe and at every call). Without a local embedder, with a failing runtime (e.g.
  `nomic-embed-text` not installed), with a non-local provider or a missing index,
  the layer reports `UNAVAILABLE` / `DEGRADED` and retrieval continues with exact,
  FTS and graph signals. There is no cloud path. `createOllamaEmbedder` (Docteur's
  own `embedText`) exists but is not wired: the KG is off at boot until KG-CERT.

### Pipeline

query normalisation (NFKC, control / bidi characters removed, ≤ 2 000 chars, ≤ 16
terms, stopwords dropped, explicit temporal intent parsed — never invented) →
exact (whole label / alias, identifiers written in the query, label / alias n-grams)
→ FTS5 (entities, claims, sources, evidence; only quoted terms, quoted phrases and
an explicit `term*` prefix; user text is never an FTS expression) → optional semantic
→ entity match (logical roots, ambiguity kept) → bounded graph neighbourhood (seeds ≤
5, depth ≤ 2, nodes, edges, per-node fan-out, timeout, visited set) → claims of the
best entities (bounded candidate set) → temporal filter → visibility filter →
ranking → contradiction groups → context budget → citations.

**Visibility.** `includePrivate` (default false: `PRIVATE` sources invisible),
`provider` (`local` default; `cloud` also drops every `local_only` source) and
`scope` (`{ notebookId }` | `{ sourceIds }`). A claim is visible through at least one
allowed evidence source; an entity through an allowed alias provenance or a visible
claim; citations only ever name allowed sources; relations are followed only when
their provenance is allowed. Every result and the assembled context carry an
`egress` (`local_only` if any cited source is local-only). Notebook documents are
local-only by the Notebook contract, so they are private for the KG: a Notebook-side
query uses `includePrivate` + its notebook `scope` (exactly the Notebook's own
visibility) and never reaches another notebook's documents.

**Ranking** = Σ named signals (`SIGNAL_WEIGHTS`, each result lists
`{ signal, value, weight, contribution }` and `whyMatched`): exact entity /
identifier / title match, entity mention, FTS (bm25 normalised), semantic similarity
(≥ 0.55), 1- / 2-hop graph, claim about a matched entity, predicate named in the
question (small documented FR/EN lexicon), share of query terms in the claim's
visible evidence; claim status, evidence count, source / model confidence,
user-asserted and temporal match are QUALITY signals scaled by the claim's relevance
(they order relevant claims, they never make an irrelevant one relevant); an
`AMBIGUOUS` entity gets a negative signal and is returned with its candidates.
Results below 15 % of the best score are dropped.

**Contradictions.** If a claim of an OPEN conflict is selected, its visible live
counterpart is pulled in; the group is ranked and budgeted as ONE unit (both sides
with their citations and dates, or neither, reported in `context.truncated`). The
context marks them "CONTRADICTED by another claim in this context". No side is
chosen.

**Temporal.** `current`, `past` (ended periods + superseded history), `at`,
`during` (a year / month in the question), `before`, `after`; `validTo` exclusive.
Undated claims are kept for current / at / during with `basis: 'undated'` and no
temporal credit, and excluded from past / before / after.

**Context budget** (defaults → hard caps): entities 10 → 50, claims 20 → 100,
evidences 30 → 150, snippets 20 → 100, sources 10 → 50, chars 6 000 → 20 000,
depth 1 → 2, nodes 200 → 1 000, edges 500 → 5 000, fan-out 100 → 500,
timeout 2 s → 10 s. Deterministic truncation; numbered `[S n]` citations with
source, technical ref (e.g. Notebook document id), locator (chunk / page / message /
offsets), excerpt hash.

### Defects found and fixed during KG-5

- KG-3 FTS triggers deleted the old FTS row by an UNINDEXED column → a full FTS scan
  on every update (quadratic ingestion). Rows are now keyed by the base `rowid`.
- KG-3 resolution: a same-source re-import replay, then a `same_source`
  corroboration, merged two same-label organisations with DIFFERENT domains (forced
  merge). A strong identifier of the same scheme with other values now blocks the
  automatic match; the candidate is still proposed (`AMBIGUOUS`).
- No statement cache: every call recompiled its SQL. The store now caches prepared
  statements (bounded). A/B on identical work: entity creation 1.7 vs 6.5–7.2 ms per
  mention, resolution 5.9 vs 9.7–10.0 ms (KG-4 code vs KG-5 code).

### Notebook baseline comparison (synthetic ground truth, k = 5)

`fixtures/kg5-retrieval-world.mjs`: 16 public documents (10 factual, 6 noise) + 1
private document in another notebook, imported through the Notebook public service;
the same facts in the KG with evidence citing the Notebook chunks; 12 labelled
questions (exact, alias absent from the text, graph, temporal, contradiction,
semantic, private). The ground truth is synthetic and deliberately includes the
cases where a graph should help: it shows the mechanism, not a production accuracy.

| Method | P@5 | R@5 |
|---|---|---|
| A — Notebook retrieval | 0.515 | 0.727 |
| KG exact only | 0.621 | 0.636 |
| KG FTS only | 0.745 | 1.000 |
| KG semantic only | 0.167 | 0.273 |
| KG graph only | 0.258 | 0.364 |
| KG hybrid | 0.617 | 1.000 |
| B — Notebook + KG (RRF) | 0.564 | 1.000 |

Recall per kind, A → B: alias 0 → 1, graph 0.25 → 1, contradiction 0.5 → 1, exact
1 → 1, temporal 1 → 1, semantic 1 → 1. Citations: 182/182 resolve to the original
Notebook document, chunk and offsets. Private leaks: 0. Context: median 725 chars,
max 1 503.

### Measurements (synthetic, temporary files; machine under external load, so absolute numbers are indicative)

| Dataset | FTS | semantic | graph depth 2 | hybrid | context assembly |
|---|---|---|---|---|---|
| 1 000 entities / 5 200 claims (test) | 80 ms | 32 ms | 70 ms | 130 ms | < 10 ms |
| 1 000 entities / 1 680 claims (benchmark) | 61 ms | 34 ms | 32 ms | 103 ms | 6 ms |
| 10 000 entities / 16 800 claims / 33 600 evidences (benchmark) | 184 ms | 37 ms | 44 ms | 216 ms | 63 ms |

The context stayed at ≈ 4 100–4 700 chars (20 claims, 30 evidences) at every size.

### KG-5 tests

`test-kg-retrieval.mjs` — 16/16 (FTS, exact, semantic incl. unavailable / refused /
failing / missing index, graph limits, ranking, temporal, contradictions, ambiguity,
invalidation, privacy / provider / scope, citations, budget, failure modes, API,
baseline, volume). Regression: KG-2 62 / 0 fail / 1 skipped; KG-3, KG-4, KG-5, Root
Policy static audit, Article Canonical, Notebook phase5 / NB-2 / NB-3 — 191 tests,
190 pass, 0 fail, 1 skipped (optional real `nomic-embed-text`). Notebook freeze:
71 files, drift 0. Typecheck and build: PASS.

### KG-5 known limitations

- No real embedding model was used (deterministic local embedder in tests);
  `nomic-embed-text` availability is never assumed and its quality on this layer is
  not measured.
- The semantic index is rebuilt in full (no incremental update) and is not aware of
  claims added after the rebuild.
- FTS latency grows with very frequent terms (bm25 over every match): ≈ 180 ms when a
  term appears in tens of thousands of rows.
- The predicate lexicon is small and hand-written (FR/EN).
- Entity results cite where an entity is mentioned (alias provenance), which is
  weaker than claim evidence; document-level fusion ranks claim evidence first.
- Not wired into Notebook / Agency / Professor yet (KG-7 / KG-8); the KG stays off at
  boot until KG-CERT.

---

## KG-6 — Interactive graph view

Date: 2026-10-08 · HEAD: `111d2bb` · Git index: empty (no Git mutation) · schema unchanged (2.2.0).

### Backend (read-only, bounded, visibility-filtered)

`kg-view.js` + routes `POST /api/kg/view/{neighborhood, entity, claim, relation, timeline}`.
Same visibility rules as KG-5 (`includePrivate`, `provider`, `scope`); "not visible"
and "absent" both answer `404 KG_NOT_FOUND`.

- Neighbourhood: depth 1 by default (max 2), ≤ 60 nodes (max 150), ≤ 120 edges (max
  300), per-node fan-out 40 (max 100), timeout. Each node reports `shownEdges` /
  `hiddenEdges`; `offset` pages through a high fan-out node (next slice). Claim edges
  take precedence over plain relations (disputed first). A claim edge in an OPEN
  conflict always brings its visible counterpart (beyond the limits, reserve 20).
  The response lists the visible sources behind the shown edges (source filter).
- Filters (server-side): entity types, claim statuses (live statuses by default),
  source ids, validity window `[from, to)` with or without undated claims.
- Entity details: aliases / identifiers / provenance through allowed sources only,
  ambiguity candidates, resolution ledger, live claims and superseded history.
- Claim details: KG-4 explanation filtered by the visibility (evidence, locators,
  technical refs), both sides of a contradiction with the other side's evidence.
- Relation details: provenance; "a relation never grants a permission".
- Timeline: dated claims (live + superseded) in order; undated ones counted apart;
  > 60 dated items → per-year buckets; items capped at 200.

### Frontend

`KnowledgeGraphModal.tsx` (FeatureKey `knowledge-graph`, lazy chunk 39 kB),
`components/knowledge-graph/{GraphCanvas,KgDetails,KgTimeline}.tsx`, pure model
`src/lib/kg/graph-model.ts`, client block `[Knowledge Graph V1]` in `client.ts`, CSS
block in `globals.css`.

- Nothing is loaded before a search; the first view is the depth-1 neighbourhood;
  expansion is manual, node by node ("Développer" / `E`), next slice for a
  high fan-out node; render cap 250 nodes / 500 edges — an expansion that would exceed
  it is refused whole with an explicit message.
- Deterministic radial layout, incremental on expansion (placed nodes never move);
  no physics loop. Zoom / pan: wheel, drag, buttons, keyboard; fit; recentre.
- Selection of nodes and edges; details and timeline panels; list / table view as
  accessible alternative; private sources only after the explicit "Inclure les
  sources privées (affichage local uniquement)" opt-in; disabled state when the KG is
  off (`KG_DISABLED`, the normal boot until KG-CERT).
- Keyboard: roving tabindex on nodes, arrows move by direction, Enter / Space
  details, E expand, C recentre, + / − zoom, 0 fit, Shift + arrows pan, Escape closes.
  Focus ring visible. ARIA: dialog, search landmark, toolbar, tabs, `role=application`
  graph with instructions, nodes / edges as labelled buttons (ambiguity, hidden edges,
  status, dates, contradiction in the accessible name), polite live region.
- Reduced motion: the viewport transition is removed under
  `prefers-reduced-motion`. Responsive: side panel stacked under 900 px, compact
  under 600 px, no horizontal overflow.
- The user's latest action wins: a neighbourhood that finishes loading does not
  replace details the user opened meanwhile.

### Tests and measurements (synthetic graph: 2 017 entities, 3 206 relations, 158 claims)

- `test-kg-view.mjs` — 10/10 (bounds and caps, high fan-out + paging, cycles,
  contradictions with `maxEdges = 1`, ambiguity, privacy / provider / 404, filters,
  details, dense timeline, read-only API). Neighbourhood API: median 0.6 ms.
- `scripts/test-kg-graph-unit.mjs` — 8/8 (layout, cycles, incremental expansion,
  paging offsets, render caps, recentre, direction navigation, zoom / fit, ARIA
  texts, timeline lanes).
- `scripts/test-knowledge-graph-browser.mjs` — 115 assertions, 3/3 stable runs: real
  modal + real route in-process on a temporary database, Chromium, viewports 1 400 /
  768 / 390, reduced motion, keyboard, pointer, privacy, contradictions, ambiguity,
  1 200-node network (26 progressive expansions 5 → 67 nodes), 800-edge hub paged
  41 → 81 → … → 241 then refused at the render cap, cycle, dense timeline (151
  dated claims), filters incl. source, disabled state, zero writes, zero external
  requests.
- UI measurements (machine under external load): initial display median ≈ 150–450 ms,
  expansion median ≈ 150–530 ms, max rendered 241 nodes / 240 edges; long tasks: none
  in the last 3 runs, at most 105 ms in earlier runs near the render cap; none ≥ 200 ms.
- Regression: KG-2 62 / 0 fail / 1 skipped; KG-3 → KG-6 + Root Policy static audit +
  Article Canonical + Notebook phase5 / NB-2 / NB-3: 201 tests, 200 pass, 0 fail,
  1 skipped. Notebook freeze drift 0. Typecheck and build PASS.

### KG-6 known limitations

- **The low-level KG-2 / KG-3 GET endpoints** (`/entities/:id`, `/entities/:id/logical`,
  `/aliases/…`, `/sources/…`, `/claims/:id`, `/evidence/…`, neighbours, relationships,
  subgraph, identifiers, refs, resolutions) **are not visibility-filtered**: they return
  raw rows, including private aliases / evidence. The KG-6 UI never calls them (only
  `/search` and `/view/*`), and the KG is off at boot, but they must be filtered or
  removed before KG-CERT (natural place: KG-8 consumer API).
- Radial layout: labels can overlap in dense views (zoom / list view help); no
  force-directed layout by design (determinism, no freeze).
- Edges are reachable by keyboard through the details and the list view, not by
  arrow keys on the canvas.
- Timeline list shows 60 items (histogram + axis cover the rest).
- Paging a high fan-out node follows the server order (disputed claims, then
  supported, then relations by id); no per-node search inside a hub.

---

## KG-7 — Privacy pre-gate + Notebook / Neurone integration

Date: 2026-10-08 · HEAD: `111d2bb` · Git index: empty (no Git mutation) · schema unchanged (2.2.0, no migration).

### Pre-gate: one read stack (option B)

The KG-2 / KG-3 / KG-4 raw GET routes returned unfiltered rows (private aliases,
evidence, claims, refs). They are **removed**, not filtered: 28 paths
(`/entities/:id`, `/entities/:id/logical`, `/aliases/*`, `/sources/*`, `/claims/*`,
`/evidence/*`, `/identifiers/*`, neighbours, relationships, subgraph, resolutions,
statistics, verify, explain, valid-at, conflicts) answer `410 KG_ROUTE_REMOVED` with
the safe replacement, for any method and any id (no existence signal). Store methods
remain for tests / tooling only. The only data routes left are `POST /search`,
`POST /retrieve` and `POST /view/{neighborhood, entity, claim, relation, timeline,
source, citation}`, all through the KG-5 visibility context. `GET /health` returns
the schema version only (no counts).

Visibility rules tightened:

- `includePrivate` requires an explicit scope (`{ notebookId }`, `{ sourceIds }` or
  `{ all: true }`) → otherwise `400 KG_SCOPE_REQUIRED`; never for a cloud provider
  (`400 KG_PRIVATE_NOT_FOR_CLOUD`). The UI sends `{ all: true }` when the user ticks
  "Inclure les sources privées" in the global view.
- A Notebook scope is a set of **technical refs** of that notebook, not of logical
  sources: a document shared by two notebooks (same content → one logical source)
  never shows the other notebook's evidence, aliases, identifiers, refs or title
  (the source label is the title known by the scoped notebook).
- Evidence, aliases, identifiers and provenance seen only through an **invalidated**
  ref (deleted Notebook document, deleted capture) are no longer shown.
- Search oracles closed: a name / alias / identifier / full-text / semantic match only
  counts through a provenance the context may see; a claim statement only matches
  when its subject and object names are visible; an entity first named by a private
  source is displayed under an allowed alias.

`test-kg-privacy-gate.mjs` (7/7): world with a public source, a private source, two
notebooks sharing one logical document, a private-first-named entity, claims supported
only by private / other-notebook evidence. Every entity, claim, relation, source and
evidence id is swept through every view, plus 37 searches and 37 retrievals, in 8
contexts (default, cloud, notebook scope without opt-in, nb A, nb B, wrong notebook,
public `sourceIds`, `{ all: true }`) — 104 requests each:

| Leak counter | Result |
| --- | --- |
| private alias | 0 |
| private evidence | 0 |
| private claim | 0 |
| cross-notebook (markers + ids, both directions) | 0 |
| removed routes: 28 paths × 3 methods × (existing / absent id) | 168 × 410, identical bodies |
| enumeration: hidden vs absent (6 views × 2 contexts) + private-alias search vs nonsense | 17 checks, 0 difference |

The `{ all: true }` context sees 18 / 18 private markers (the gate filters; it does
not just hide everything).

### Integration (`kg-integration.js`)

Read-only readers over the frozen Notebook store (`getNotebook`, `listDocuments` incl.
AI histories, `getDocument`, `getCurrentChunkRows`, `getChunkAnyVersion`) and the
neuron store (`getAllPagesMetaFromStore`, `getPageFromStore`). No Notebook / neuron
function that writes is imported.

- **Notebook**: one ref per document (`notebookId`, `documentId`, `versionId`,
  origin), privacy inherited (Notebook's contract makes every imported document
  local_only → PRIVATE; the KG never loosens it). Claims from document text only
  through an injected **local** completion (Strict Local enforced; verbatim quote →
  chunk + character locator; stored as MODEL_PROPOSAL / HYPOTHESIS). An extraction
  marker (version + extractor) on the ref avoids re-sending a version to the model.
- **Reindex**: re-embedding keeps chunk ids → no KG change. A new document version →
  evidence in non-current chunks becomes INVALIDATED (still reopenable, flagged
  "superseded"), claims recomputed, new claims extracted.
- **Delete**: document gone → ref INVALIDATED; located evidence SOURCE_MISSING; claims
  recomputed from their other evidence; the logical source stays ACTIVE while another
  ref exists, otherwise DELETED. Nothing is deleted (row counts unchanged).
  `invalidateSourceRef` now handles the evidence of that ref (source-level evidence,
  e.g. an article's canonical metadata seen by two captures, moves to a remaining
  capture). New store primitive `invalidateEvidence`.
- **Neurone / Article Canonical**: `extractArticleMetadataClaims` per article neuron;
  MSN paste and "info <lien>" of the same article → 1 logical source, 2 refs (`paste`,
  `url`), one claim per metadata predicate. Same URL with different content →
  `divergences: ['content_hash_differs']` on the ref, shown by `/view/source`.
- **Citation reopen**: `/view/citation` returns the open target (`notebook_document`:
  notebook, document, version, origin, chunk, page, characters; `neuron`: page id) and,
  when the server passes its readers, whether it still resolves (`available`,
  `superseded`). UI: "Ouvrir la source" per evidence → Notebook's own exact-chunk
  citation preview (document or AI history, existing endpoints, quote highlighted),
  neuron selection, or the Media Reader for a URL. Notebook cannot be deep-linked
  without changing it (frozen), so the KG shows Notebook's preview instead.
- **Boot**: unchanged gate. With `DOCTEUR_KG_DEV_DB` **and** `DOCTEUR_KG_DEV_SYNC=1`
  only, a deterministic background sync (no model) reads Notebook + neurons into the
  dev KG database.

`test-kg-integration.mjs` (11/11), real Notebook service + neuron store on a temporary
database: public / local-only notebooks, cross-notebook isolation through a shared
logical document, Neurone ingestion, Article Canonical convergence and divergence,
idempotent re-import (two extra full syncs: identical counts in 10 KG tables, 0 model
calls), reindex + new version, delete / invalidation without cascade and with no
orphan citation (every ACTIVE Notebook evidence reopens), neuron deletion, citation
reopen through the API (Notebook's `verifyCitation` accepts the target; other notebook
= 404), Strict Local refusal, scoped entity view. Every sync is wrapped in a
fingerprint of all non-KG tables: **no backflow** into Notebook / neurons. AI history:
NB-4 fixture export only (no real export available — not a validation of real
histories).

### Regression and gates

- KG-3 → KG-7 + Root Policy static audit + Article Canonical + Notebook phase5 / NB-2 /
  NB-3: 219 tests, 218 pass, 0 fail, 1 skipped (NB-3, pre-existing). KG-2 runner 63:
  62 / 0 fail / 1 skipped. Graph model unit 8 / 8. KG browser suite 117 assertions
  (115 KG-6 + "Ouvrir la source" fallback, no foreign request). Earlier KG tests were
  migrated off the removed routes and off `includePrivate` without a scope.
- Typecheck and production build PASS.
- Notebook frozen drift: 0 Notebook files modified (git read-only). Root Policy: not
  touched. No cloud call.
- Real DB: SHA-256 of `cortex.sqlite` / `-wal` / `-shm` identical to the session
  baseline; 0 `kg_*` object on a copy. All tests on temporary databases.

### KG-7 known limitations

- Notebook cannot be opened on a given document / chunk without modifying it
  (frozen): the KG shows Notebook's own exact-chunk preview instead of navigating.
- Relations (`kg_relationships`) carry a logical source, not a technical ref: in a
  Notebook scope, a relation coming from a document shared by two notebooks is
  visible from both.
- Without a local model, Notebook documents bring sources / refs only (no claims);
  the dev boot sync is deterministic only. Model extraction quality is not measured
  here (fixture extractor).
- An entity's semantic match is only used when every provenance of the entity is
  visible in the context (the semantic text mixes all aliases); such entities stay
  reachable through their visible names.
- AI histories validated with NB-4 fixtures only (no real export available).
- `invalidateSourceRef` with a remaining path moves source-level evidence (no chunk /
  message locator) to the newest remaining path; chunk-located evidence is marked
  SOURCE_MISSING.

---

## KG-8 — Consumer API

Date: 2026-10-12 · HEAD: `111d2bb` · Git index: empty (no Git mutation) · schema 2.2.0 → **2.3.0** (migration 008, temporary databases only).

### Pre-gate: relationship privacy

KG-7 limitation fixed: `kg_relationships` only carried a logical source, so in a Notebook
scope a relation read in a document shared by two notebooks was visible from both.

- New table `kg_relationship_provenance` (relation, logical source, technical ref, status).
  Every `upsertRelationship` with a source records one provenance row per (source, ref);
  `source_ref_id` must belong to the source (`KG_SOURCE_REF_MISMATCH`).
- Visibility (`ctx.relationVisible`, used by KG-5 graph traversal, KG-6 neighbourhood,
  `/view/relation` and the consumer API): a relation is visible only through an ACTIVE
  provenance of an ACTIVE source that the context may see — same rule as evidence, so a
  Notebook scope needs a ref of THAT notebook. A provenance known only at the logical
  level (no ref) is invisible in a Notebook scope (fail closed). Unsourced relations:
  unscoped personal-knowledge contexts only.
- `invalidateSourceRef` invalidates that ref's relation provenances (not moved: the relation
  was read in that document); `invalidateSource` invalidates all of them. Nothing is deleted.
- Migration 008: existing relations get their logical source as provenance with an unknown
  ref (never guessed). Export / import carry the provenance rows exactly.
- `/view/relation` now lists only the visible provenances (`provenances[]`, `provenance` =
  first) and only the refs the relation came through.
- KG-5 fixture: its relations now declare the Notebook ref they were read in.

### Consumer contract (`kg-consumer-api.js`, `knowledgeGraphApiVersion: 1`)

Server-side, in-process API (no new HTTP route): `createKnowledgeGraphApi(store).forConsumer(id)`
returns a frozen client bound to ONE consumer (identity fixed by the server wiring, never
self-declared per call). Operations, all read-only: `searchKnowledge`, `retrieveKnowledge`,
`getEntity`, `getClaims`, `getEvidence`, `getNeighborhood`, `getTimeline`, `getContradictions`.
`createEntity`, `mergeEntity`, `assertClaim`, `deleteSource`, `resetGraph`,
`executeActionFromGraph`, `authorizeFromGraph` (and similar) → `KG_OPERATION_FORBIDDEN`.

- Request: `{ apiVersion, context: { scope, includePrivate, provider }, bounds?, params }`,
  unknown fields refused at every level. Scope kinds: `public`, `notebook`, `sources`,
  `all` (only for consumers listed in the server option `allowAllScope`; none by default).
  `includePrivate` and `provider` must be stated explicitly. Private data: the consumer
  profile must allow it, an explicit notebook / sources scope, never `cloud`.
- Bounds: `maxResults, maxDepth, maxNodes, maxEdges, maxClaims, maxEvidence, maxChars,
  timeoutMs` — defaults, global ceilings (50 / 2 / 150 / 300 / 100 / 100 / 40 000 / 5 000 ms)
  and stricter per-consumer caps; a value above a cap → `KG_BOUND_EXCEEDED` (never widened).
  Contradiction groups are kept or dropped whole; `truncated`, `limitsHit` and `complete` say
  what was cut. Timeout: the deadline is checked between steps (`timeout` in `limitsHit`).
- Response: `apiVersion, consumer, operation, status (OK | NOT_FOUND), complete, items,
  truncated, limitsHit, bounds, visibility, authority: 'NONE', stats` (+ `context` for
  retrieve, `claim` for evidence, `timeline`, `groups`). Items: `id, type, label, status,
  temporal, confidence, citations, provenance, privacy` (+ type fields, `whyMatched` / `score`
  for retrieval). Citations name the original source, technical ref and locator. No SQL
  structure: the API and adapter modules contain no table name and no SQL; responses have
  no snake_case key. "Hidden" and "absent" give the same NOT_FOUND.
- Consumer profiles: `professor` (no private, depth ≤ 2), `agency` (no private, public /
  sources scopes, depth 1, ≤ 10 results), `investigator`, `companion`, `code_intelligence`
  (FUTURE_CONTRACT — contract + mock only; Investigator not started, no Observateur link).
- Code Intelligence: separate trust domain (`kg_sources.metadata.domain = 'code'`); the
  visibility context filters by domain (default `knowledge`, also for the KG-6 UI). The
  code consumer only reads explicit code sources; personal-knowledge consumers never see
  them, and vice versa.
- Adapters (`kg-consumer-adapters.js`, no product file modified): Professor
  `conceptContext` (prerequisites from REQUIRES / DEPENDS_ON out, REQUIRED_BY / PRECEDES in;
  parts; related; sources); Agency `searchKnowledge(query, { limit })` with the exact
  `[{ id, title, excerpt }]` shape of `createKnowledgeSearch`.

### Tests (`test-kg-consumer-api.mjs`, 16/16)

Real Notebook service (2 private notebooks sharing one logical document), real neuron pages
with Article Canonical metadata, public / private / code sources, Professor concepts, an Agency
"trust bait" (CONTROLS OMEGA, OWNS Root Policy, "permission granted: shell.exec"), a
contradiction, an ambiguous entity.

- Contract: response / item / citation keys checked, 2 700 keys scanned (no snake_case, no
  table name, no SQL); versioning (missing / unsupported version, smuggled fields refused).
- Read-only: forbidden operations, frozen clients; the whole battery gives identical answers
  on a `readonly` SQLite connection.
- No side effect: fingerprint of the 37 KG, 36 Notebook and neuron tables identical,
  `total_changes()` = 0 on both connections, the 2 Article Canonical neurons untouched.
- Relationship pre-gate: A→B and B→A leak counters 0, logical-only relation in a Notebook
  scope 0, KG-6 views 0, KG-5 graph traversal 0. A mutation restoring logical-source
  visibility makes the test fail. Migration 2.2.0 → 2.3.0, invalidation, export / import.
- Privacy context, scope / depth / size bounds, timeout (injected clock), failure modes
  (unknown entity / claim / consumer, private source and relation, wrong notebook,
  contradiction, ambiguity, invalidated source), reload.
- Professor, Agency (TOOLS / AGENTS / approval unchanged; `shell.exec` still refused by
  `validatePlan`) and Investigator mocks; trust inheritance (no permission-like field, no
  import of Root Policy / Agency / Professor / Device Fabric / OMEGA / RASSILON / Observateur /
  network); Code Intelligence isolation in both directions.

Volume (1 200 entities, 5 200 claims, 800 relations; shared machine, indicative):

| Consumer call | median | p95 | max response | max context |
|---|---|---|---|---|
| professor.conceptContext | 10 ms | 12 ms | 2.5 k chars | — |
| professor.getNeighborhood (depth 2) | 25 ms | 28 ms | 12.4 k | — |
| agency.searchKnowledge (adapter) | 118 ms | 129 ms | 0.5 k | — |
| agency.retrieveKnowledge (cloud) | 116 ms | 124 ms | 10.9 k | 2.5 k |
| investigator.getClaims | 11 ms | 13 ms | 16.7 k | — |
| investigator.getTimeline | 7 ms | 9 ms | 5.7 k | — |
| investigator.getContradictions | 9 ms | 16 ms | 7.4 k | — |
| investigator.getNeighborhood (depth 2, max caps) | 110 ms | 119 ms | 40.6 k | — |

### Regression and gates

- KG-2 runner 62 / 0 fail / 1 skipped. KG-3 → KG-8 + Root Policy static audit + Article
  Canonical + Notebook phase5 / NB-2 / NB-3: 235 tests, 234 pass, 0 fail, 1 skipped (NB-3,
  pre-existing). Graph model unit 8 / 8. KG browser suite 117 assertions PASS.
- Typecheck PASS, production build PASS.
- Real DB: SHA-256 of `cortex.sqlite` / `-wal` / `-shm` identical to the session baseline;
  0 `kg_*` object on a copy. 320 Notebook / Professor / Agency / Root Policy / Device Fabric /
  OMEGA / RASSILON / Code Intelligence files: hashes identical. No cloud call. Git: HEAD and
  index unchanged; only new untracked KG files.

### KG-8 known limitations

- In-process API only (no HTTP consumer route): consumer identity comes from the server
  wiring; nothing is wired into Professor / Agency yet (adapters + mocks only).
- Relations created before 2.3.0 keep an unknown technical ref: invisible in Notebook scopes
  until re-asserted through a ref (fail closed, by design).
- A `sources` scope naming a shared logical document sees every provenance of that source
  (it names the logical source, not a notebook).
- The Code Intelligence domain is a reserved marker (`metadata.domain = 'code'`); no code
  adapter feeds the KG yet.
- The timeout is checked between steps and inside traversal; a single long SQLite statement
  is not interrupted.
- `maxChars` bounds the item payload and (for retrieve) the context text separately (half
  each); the envelope is not counted.

---

## KG-CERT — Final certification

Date: 2026-10-12 · HEAD: `111d2bb` · Git index: empty (no Git mutation) · schema **2.3.0** ·
activation status: **DISABLED_PENDING_HUMAN_ACTIVATION** (`KG_CERTIFIED = false` in
`kg-boot.js`; a normal start never opens the KG; activation on the user database is a separate
human decision). Nothing was declared FINAL or FROZEN.

### Phases KG-1 → KG-8 (summary)

| Phase | Scope | Status | Main evidence |
|---|---|---|---|
| KG-1 | audit, logical schema, threat model, baseline | PASS | this report, first sections |
| KG-2 | first store + read API (other agent) | PASS | `CHECKPOINT_KG-2.md`, `KG-2_SUMMARY.md`, `scripts/test-kg.js` 62 / 0 fail / 1 skipped; its defects were fixed in KG-3 |
| KG-3 | schema realignment (2.0.0), normalisation, entity resolution | PASS | `test-kg-schema-realignment.mjs` 18, `test-kg-entity-resolution.mjs` 20 |
| KG-4 | claims / evidence / temporality / contradictions (2.1.0) | PASS | `test-kg-claims.mjs` 19 |
| KG-5 | hybrid retrieval (2.2.0) | PASS | `test-kg-retrieval.mjs` 16 |
| KG-6 | interactive graph view | PASS | `test-kg-view.mjs` 10, graph unit 8, browser suite |
| KG-7 | single read stack + privacy pre-gate, Notebook / Neurone integration | PASS | `test-kg-privacy-gate.mjs` 7, `test-kg-integration.mjs` 11 |
| KG-8 | relationship provenance (2.3.0), consumer API | PASS | `test-kg-consumer-api.mjs` 16 |
| KG-CERT | cross-cutting certification | see verdict | `test-kg-cert.mjs` 8, benchmarks, browser 127 |

### Final architecture

```
SOURCE (Notebook documents / AI histories, Article Canonical neurons, manual)
  → EXTRACTION (deterministic metadata first; local model only, MODEL_PROPOSAL = HYPOTHESIS)
  → NORMALISATION (kg-normalize: label / loose / token keys, typed identifiers)
  → ENTITY RESOLUTION (kg-resolution: identifiers > corroborated aliases; ambiguity kept; ledger, reversible)
  → CLAIMS / EVIDENCE (kg-claims: N:N, SUPPORTS / CONTRADICTS, temporality, conflicts, supersession)
  → GRAPH (relations + kg_relationship_provenance: logical source + technical ref)
  → RETRIEVAL (kg-retrieval: exact / FTS / semantic / graph / hybrid, one visibility context)
  → UI (kg-view + KnowledgeGraphModal) / CONSUMER API (kg-consumer-api, apiVersion 1)
```

- Derived and reconstructible (CERT-1, tested): the same Notebook documents and article neuron
  ingested twice into two empty KGs give the same sources, refs, entities, claims and evidence
  locators. Every non-user claim has evidence; every evidence row names its source. No KG table
  is an autonomous source of truth (user claims are the only KG-native facts, and are marked USER).
- The read paths (`kg-retrieval`, `kg-view`, `kg-consumer-api`, adapters, `routes/kg.js`) import
  only KG modules (+ the Notebook STOPWORDS list); `kg-integration.js` imports exactly seven
  READ functions from the frozen Notebook / neuron stores.
- A relation or claim is descriptive: no field, operation or consumer profile turns it into a
  permission, a tool, an action or a network call (`authority: 'NONE'`). Trust inheritance 0,
  graph-derived authorization 0 (KG-8 test 39, re-run green).

### Defects found and fixed during KG-CERT (privacy)

1. **`scope: { sourceIds }` could widen a Notebook context (privacy, demonstrated).** A document
   shared by notebooks A and B is ONE logical source. A consumer working in notebook A sees that
   logical source id in its own citations; asking `scope: sources[that id]` + `includePrivate`
   returned notebook B's evidence, aliases and title (demonstration before the fix: 304 notebook-B
   markers through the consumer API, 648 through HTTP). Fix (`kg-retrieval.js`, `kg-view.js`): a
   sources scope names LOGICAL sources and never sees through a Notebook ref
   (`notebook_document`, `notebook_ai_message`): such evidence / aliases / identifiers / relation
   provenances and logical-only rows of a Notebook-bound source are invisible there; the source
   itself is only reachable through another (non-Notebook) active path, under that path's label.
   Notebook content needs its own notebook scope, or an explicit `{ all: true }` (local UI opt-in;
   consumer API: only consumers authorised by the server wiring, none by default). After the fix:
   0 marker of either notebook in every sources scope (HTTP, consumer API, semantic). This closes
   the KG-8 limitation "a sources scope naming a shared logical document sees every provenance".
2. **Ambiguous scope objects were accepted** (`{ notebookId, all: true }`, extra keys): resolved to
   the narrowest scope (no leak) but echoed back ambiguously. Now refused (`KG_SCOPE_INVALID`):
   one kind per scope.

The KG-8 test assertions that encoded the old "sources scope sees every provenance" semantic were
updated to the hardened rule (an authorised `all` scope is used where the test needs everything).
No KG source file changed after the last fix (`kg-retrieval.js`); every result below was
obtained on that code.

### Schema 2.3.0 and migrations (CERT-2)

Six generations, each seeded with data in its own dialect, all converge to the SAME schema
(table shapes, FKs, every index, FTS virtual tables, triggers) as a fresh install, with
`foreign_key_check` empty and `integrity_check = ok`:

| Generation | Source of the schema | Migration (ms) |
|---|---|---|
| A fresh | current DDL | 25 |
| B KG-2 (1.3.0) | `fixtures/kg2-legacy-schema.sql` (captured) | 30 |
| C KG-3 (2.0.0) | `fixtures/kg3-schema-2.0.0.sql` (captured) | 18 |
| D KG-4 (2.1.0) | `fixtures/kgcert-schema-2.1.0.sql` (**reconstructed**: 2.2.0 tables + the 2.0.0 FTS objects; the KG-4 code was not kept) | 9 |
| E KG-5/6/7 (2.2.0) | `fixtures/kgcert-schema-2.2.0.sql` (exact: current minus the 008 table) | 6 |
| F current (2.3.0) | current | 2 |

Data kept (entities, sources, claims, evidence, claim↔evidence, relations), FTS rebuilt once per
row (incl. evidence FTS) and triggers live after the upgrade, pre-2.3 relations backfilled with
their logical source and **no technical ref (guessed provenance 0)**. Re-opening is a no-op
(identical content). Interruption: a crash inside 008 leaves 2.2.0 intact (table and data rolled
back); a crash in 007 on a KG-2 chain leaves a consistent 2.1.0; the next start converges.
Export / import: every row of the 12 data tables identical after a round trip; `reset` refused.
On 10 000 entities / 13 997 relations, migration 008 takes ≈ 3.0 s.

### Entity resolution, claims / evidence, contradictions, temporality (CERT-3 / CERT-4)

KG-3 / KG-4 suites re-run green, plus invariants measured on a world mixing the KG-6 graph, the
shared-document world, merges, conflicts, supersession and local-model extraction:

| Invariant | Value |
|---|---|
| system-confirmed merges by label / similarity / LLM (forced ambiguous merges) | 0 |
| merged entity without a CONFIRMED ledger row | 0 |
| destructive merges (row lost after merge / reversal) | 0 |
| non-user claim without evidence | 0 |
| MODEL_PROPOSAL claim in SUPPORTED / ASSERTED (corroborated by two sources) | 0 |
| evidence without source / evidence ref of another source | 0 / 0 |
| relation provenance ref of another source | 0 |
| active evidence or relation provenance of a deleted source | 0 / 0 |

Same-name organisations with different domains stay two entities; cross-type homonyms are never
merged (a CONCEPT → PRODUCT merge is refused); merge then reversal restores every row (nothing
deleted). Contradictions coexist (both DISPUTED, nothing deleted), supersession keeps history,
half-open validity intervals answer "valid at" queries; undated claims are never given an
invented date. Cloud extraction is refused (`KG_STRICT_LOCAL_REQUIRED`). Source invalidation
deletes no row. KG-3 benchmark: 0 system-confirmed merges at 100 / 1 000 / 10 000 mentions.

### Privacy red team (CERT-5) and relationship provenance (CERT-6)

Shared-document world (one logical document in notebooks A and B, aliases / claims / evidence /
relations through each notebook's own ref, a logical-only relation, public and private sources).
Every entity, claim, relation, source and evidence id through every view, and 21 queries × 4 modes
× (search, retrieve) — 200 requests per context — plus the consumer API (57 calls per context)
and the semantic layer (local deterministic embedder):

| Context | notebook-A markers | notebook-B markers | private markers | relations seen |
|---|---|---|---|---|
| default / cloud | 0 | 0 | 0 | public |
| notebook A | 460 | **0** | 0 | — |
| notebook B | **0** | 503 | 0 | — |
| notebook A without opt-in / wrong notebook | 0 | 0 | 0 | — |
| sources[shared] (with / without opt-in) | **0** | **0** | 0 | — |
| sources[shared + public] | **0** | **0** | 0 | public |
| sources[private] | 0 | 0 | 203 | — |
| all (explicit) | 513 | 1 074 | 278 | logical, A, B, public |
| consumer: companion in notebook A | 225 | **0** | 0 | — |
| consumer: companion sources[shared] | **0** | **0** | 0 | — |
| semantic, every restricted context | 0 cross-notebook | | 0 | |

Cross-notebook leakage 0, cross-scope leakage 0, private evidence leakage 0. The 28 removed raw
routes answer `410 KG_ROUTE_REMOVED` for GET / POST / PUT / PATCH / DELETE (140 checks);
"hidden" and "absent" give identical bodies in notebook, sources and default contexts. Relations
are visible only through an ACTIVE provenance of an ACTIVE source that the context may see; pre-2.3
relations without a ref are never visible in a Notebook or sources scope of a Notebook-bound source.

### Retrieval and citations (CERT-7)

KG-5 suite green (exact, FTS, semantic incl. unavailable / refused / failing / missing index,
graph limits, ranking, temporal, contradictions, ambiguity, invalidation, privacy, citations,
budget). Original-source citations: every hit carries its source, ref and locator; a Notebook
citation reopens the right notebook / document / version / chunk and returns 404 from another
notebook (KG-7 integration test 72). No cloud fallback exists. The real local embedding model
(`nomic-embed-text` via Ollama) was **not available** on this machine: the semantic layer was
exercised with the deterministic local embedder; the absence is reported as
`SEMANTIC_UNAVAILABLE` / `NOT_RUN`, never simulated as a real-model result.

### Notebook / Neurone integration (CERT-9)

KG-7 integration suite green: Notebook public + local-only documents, cross-notebook isolation on
a shared logical document, Article Canonical convergence (MSN paste + URL capture → one logical
source, two technical refs) and recorded divergence, idempotent re-import (no second model call),
reindex, delete → invalidation (nothing deleted, no orphan citation), Strict Local. Fingerprint
of every non-KG table is identical before and after sync (no backflow into Notebook / neurons).

### UI (CERT-8)

`scripts/test-knowledge-graph-browser.mjs` — **127 assertions, 127 pass, 0 fail** (final run,
this session): real modal and route on a temporary DB, Chromium, 1 400 / 768 / 390 px, search,
filters, progressive expansion, nodes, edges, evidence and locators, "Ouvrir la source" preview,
timeline, contradictions, ambiguity, private items hidden by default, explicit `includePrivate`
opt-in, keyboard, ARIA, reduced motion, 1 200-node network, 800-edge hub (high fan-out, paged
41 → 241), disabled state. KG-CERT additions: hostile labels / evidence (`<img onerror>`,
`<script>`, `<svg onload>`) render as text (escaped in the DOM, no element / handler injected, no
script executed); a `javascript:` source URL is handed to the Media Reader classifier, which
blocks it (`dangerous_scheme`); no navigation. Final run: initial display median 569 ms (max
764), expansion median 604 ms (max 675), long tasks ≤ 104 ms, render cap 241 nodes / 240 edges
(machine under external load). Graph model unit 8 / 8.

Coverage note: the product mounts the modal only from the global view (`App.tsx`, no scope; the
private opt-in uses `{ all: true }`). Notebook cannot host it (frozen), so **Notebook scopes and
Notebook citation reopening are certified at the API level** (privacy gate, integration, CERT-5,
consumer API), not through a browser path that does not exist in the product.

### Consumer API (CERT-9)

`kg-consumer-api.js` (`knowledgeGraphApiVersion: 1`, in-process only): typed, versioned,
table-free output; frozen read-only clients; strict request validation; bounds refused above caps;
explicit, never implicit, never privileged privacy context; Professor / Agency / Investigator mock
consumers read-only; Code Intelligence a separate domain never mixed with personal knowledge;
identity spoofing refused. 16 / 16, re-run green with the hardened sources scope.

### Security red team (CERT-10)

`test-kg-cert.mjs`: SQL injection through every id field and the query (48 requests → 404 / 200,
no effect); FTS operator injection (`NEAR`, `AND NOT`, column filters, unterminated quotes, `*`,
`^`, parentheses — 36 requests, all quoted); oversized query (25 000 chars → truncated); malformed
bodies, ids (numbers, objects, arrays, 100 000-char strings, NUL) and scopes → 400 / 404; a
non-boolean `includePrivate` is not an opt-in; traversal requests of depth 99 / 99 999 nodes are
clamped (depth ≤ 2, nodes ≤ 150, edges ≤ 300, fan-out ≤ 100; retrieval budget ≤ hard limits);
cycles terminate; consumer identity spoofing (`consumer` field, `__proto__` in the context, case
variants, `constructor`) refused; 58 mutation / import / reset attempts → 404; zero row changed.
Enumeration timing (in-process, 25 samples): hidden 0.47 ms vs absent 0.38 ms median — bodies are
identical; a sub-millisecond difference remains measurable locally (documented, local-only API).

### Performance (CERT-11) — synthetic, temporary files, machine under external CPU load

`kgcert-benchmark.mjs` (dense relations with provenance, 2 000-relation hub, contradictions,
2 evidences per claim):

| | 1 001 entities / 1 600 claims / 1 797 relations | 10 001 entities / 16 000 claims / 13 997 relations |
|---|---|---|
| build | 3.9 s | 105 s |
| semantic index | 2 601 items, 0.8 s | 26 001 items, 6.1 s |
| DB size | 9.0 MB | 81.9 MB |
| FTS / semantic / graph d2 / hybrid (median) | 87 / 39 / 65 / 142 ms | 219 / 54 / 128 / 325 ms |
| hub graph (median) | 158 ms | 328 ms |
| professor.getNeighborhood d2 | 64 ms | 145 ms |
| agency.retrieveKnowledge (cloud) | 127 ms | 326 ms |
| investigator.getClaims / getContradictions | 3 / 4 ms | 4 / 4 ms |
| investigator.getNeighborhood (hub, max caps) | 260 ms (40 k chars) | 602 ms (40 k chars) |
| migration 008 | 0.23 s | 3.0 s (guessed refs 0) |

KG-5 benchmark re-run (10 000 entities): FTS 235, semantic 54, graph 55, hybrid 318 ms vs 184 /
37 / 44 / 216 ms in the KG-5 report. An A/B on the same machine and moment (KG-8 provenance
visibility vs the KG-7 logical-source rule, 3 alternating runs at 1 000 entities) shows no
measurable difference (hybrid 126–134 vs 127–139 ms): the gap is the machine load, not KG-8 /
KG-CERT. Context size stays ≈ 4 100–4 400 chars at both sizes. KG-3 resolution at 10 000
mentions: 15 ms per mention (KG-3 report: same order).

### Restart / persistence (CERT-12)

A world populating every table (entities, identifiers, aliases, source refs, claims with
validity, evidence, claim↔evidence, resolutions incl. a merge, relation provenance, conflicts)
is closed, reopened by a **new Node process**: same rows in all 17 KG tables (855 rows, byte-identical
content hash), same indexes / FTS / triggers, version 2.3.0, 0 FK violation.

### Tests, typecheck, build (CERT-13)

| Run | Result |
|---|---|
| KG-3 → KG-8 + `test-kg-cert.mjs` (9 files, final re-run on the current code) | 125 / 125 pass, 0 fail (KG-CERT 8 / 8) |
| KG-2 runner `cortex-server/scripts/test-kg.js` | 63 — 62 pass, 0 fail, 1 skipped |
| Graph model unit `scripts/test-kg-graph-unit.mjs` | 8 / 8 |
| Root Policy static audit, Article Canonical, Notebook phase5 / NB-2 → NB-7, Agency, Professor (PROF-7, registers, sport) | 307 — 304 pass, 0 fail, 3 skipped (real Ollama models unavailable, NOT_RUN) |
| Browser `scripts/test-knowledge-graph-browser.mjs` | 127 assertions, 127 pass, 0 fail |
| Typecheck `npm run typecheck` (`tsc --noEmit`) | PASS (exit 0, no error) |
| Production build `npm run build` (`tsc && vite build`) | PASS (exit 0; built in 45.7 s; PWA precache 46 entries / 2 561 KiB; `KnowledgeGraphModal` lazy chunk 42.1 kB / 12.7 kB gzip). Non-blocking warning kept as is: some chunks > 500 kB (pre-existing) |

### Official backend suite and the YouTube flake

`cortex-server/test-manifest.mjs --run --test-concurrency=1`, run after the last KG code change:

| Total | Pass | Fail | Cancelled | Skipped | Duration |
|---|---|---|---|---|---|
| 3 628 | 3 614 | **0** | **5** | 9 | 680 607 ms (≈ 11 min 21 s) |

Suite exit code: **1**, caused only by the 5 cancelled tests. They are **not** counted as PASS.

The 5 cancelled tests are all in `test-youtube-smart-discovery.mjs`. Classification:
**PRE-EXISTING INTERMITTENT FLAKE — NO KG REGRESSION.**

- targeted reproduction outside the full suite: run 1 → 24 pass / 5 cancelled; run 2 → 29 pass /
  0 cancelled (29 / 29);
- no hang, no orphan process;
- the test file and its imports are identical to HEAD; no reference to the Knowledge Graph;
- historical flake confirmed by the KG-CERT diagnosis (intermittent, reproduced outside the full suite).

The full suite was not re-run in the finalisation pass (no new need demonstrated: no KG source
changed after it).

### Real user database, frozen products, Root Policy, cloud, Git (final checks)

- **Real user DB**: SHA-256 of `cortex-server/data/cortex.sqlite`, `-wal`, `-shm` identical to the
  KG-CERT baseline (and to the KG-8 baseline), checked at the start and the end of the
  finalisation pass. On a **copy**: 0 `kg_*` object (`quick_check = ok`). Real user DB
  modified: 0.
- **Frozen**: 320 hashed files (Notebook 54, Agency 8, Professor / Teacher / Sport 37, Root
  Policy 23, Device Fabric 23, OMEGA 102, RASSILON 47, Code Intelligence 13; families overlap) —
  0 drift against the baseline taken before KG-8. Notebook frozen drift 0; unexpected frozen
  files modified 0.
- **Root Policy**: 0 file in `git status`, 0 hash drift. Root Policy V2: out of scope.
- **Cloud / Strict Local**: no KG module performs a network call (only URL normalisation and
  fixtures contain URLs); model extraction requires `provider === 'local'`, a non-local
  completion stores nothing; the semantic layer refuses a non-local embedder
  (`SEMANTIC_UNAVAILABLE`); `provider: 'cloud'` visibility only narrows results. Cloud calls 0;
  silent cloud fallback 0.
- **Git**: HEAD `111d2bb`; `git diff --cached` empty; no add / commit / push / stash / checkout;
  `git status` identical before and after the finalisation pass and to the KG-CERT snapshot.

#### Files (diff audit since `111d2bb`)

Knowledge Graph files, all **untracked** (never committed):

- backend: `cortex-server/src/lib/kg-*.js` (17: adapters, boot, claim-model, claims,
  consumer-adapters, consumer-api, extraction, integration, migrations, normalize, resolution,
  retrieval, schema, semantic, store, test, view), `cortex-server/src/routes/kg.js`;
- tests: `cortex-server/test-kg-*.mjs` (9), `cortex-server/scripts/test-kg.js`,
  `scripts/test-kg-graph-unit.mjs`, `scripts/test-knowledge-graph-browser.mjs`,
  `scripts/knowledge-graph-harness.jsx`;
- fixtures: `kg2-legacy-schema.sql`, `kg3-schema-2.0.0.sql`, `kg5-retrieval-world.mjs`,
  `kg6-graph-world.mjs`, `kgcert-make-schema-fixtures.mjs`, `kgcert-schema-2.1.0.sql`,
  `kgcert-schema-2.2.0.sql`, `kgcert-shared-world.mjs`, `kgcert-sweep.mjs`;
- benchmarks: `kg3-resolution-benchmark.mjs`, `kg5-retrieval-benchmark.mjs`, `kgcert-benchmark.mjs`;
- UI: `src/components/modals/KnowledgeGraphModal.tsx`,
  `src/components/knowledge-graph/{GraphCanvas,KgDetails,KgTimeline}.tsx`, `src/lib/kg/graph-model.ts`;
- docs: this report, `CHECKPOINT_KG-2.md`, `KG-2_SUMMARY.md`.

Tracked files with KG hunks: `cortex-server/src/server.js` (boot gate + route, 4 markers
`[Knowledge Graph V1]`), `src/App.tsx` (lazy modal, 3 markers), `src/lib/cortex/client.ts`
(4 markers), `src/styles/globals.css` (1 marker), `src/content/capabilities.ts` (feature key
`knowledge-graph` + catalogue entry, unmarked), `package.json` (`test:audit` gains
`scripts/test-kg-graph-unit.mjs`; JSON has no marker).

Not KG, pre-existing in the working tree before KG-8 started (earlier audit and review missions,
unchanged by KG work): other tracked modifications and untracked local tests and reports, which
are not published. Unexpected files: 0. Secrets: 0. These must be separated from KG files at
staging time.

### Known limitations (final)

- KG not activated: `KG_CERTIFIED = false`; the UI shows the disabled state. Activation on the
  user database (migration → 2.3.0 on `cortex.sqlite`) is a separate human decision.
- Real `nomic-embed-text` / local LLM not available here: semantic quality on real embeddings and
  model-extraction quality are not measured (deterministic local fixtures only; NOT_RUN, not
  simulated).
- AI histories validated with NB-4 fixtures only (no real ChatGPT / Claude / Gemini export).
- The 2.1.0 schema fixture is reconstructed (KG-4 code not preserved); 1.3.0, 2.0.0 and 2.2.0 are
  exact.
- Relations created before 2.3.0 keep an unknown technical ref: invisible in Notebook scopes until
  re-asserted through a ref (fail closed).
- No code adapter feeds the Code Intelligence domain yet (reserved marker `metadata.domain = 'code'`).
- Consumer API is in-process only; nothing is wired into Professor / Agency yet.
- Timeouts are checked between steps and inside traversal; one long SQLite statement is not
  interrupted. A sub-millisecond hidden/absent timing difference is measurable in-process.
- Notebook cannot be deep-linked or host the graph (frozen): the KG shows Notebook's exact-chunk
  preview instead; Notebook scopes are certified at the API level, not in a browser path.
- FTS latency grows with very frequent terms (bm25 over every match); semantic index rebuilt in full.
- Performance figures were measured on a machine under external load (indicative; A/B used for
  comparisons).
- Official backend suite exit code 1 because of 5 cancelled tests in the pre-existing YouTube
  smart-discovery flake (not a KG regression, not a PASS).

### Final checkpoint

```
DOCTEUR KNOWLEDGE GRAPH V1 FINAL CERTIFICATION

KG-1 : PASS
KG-2 : PASS
KG-3 : PASS
KG-4 : PASS
KG-5 : PASS
KG-6 : PASS
KG-7 : PASS
KG-8 : PASS

Schema version : 2.3.0
Migration convergence : PASS
Migration rollback : PASS
Entity resolution : PASS
Forced ambiguous merges : 0
Destructive merges : 0
Claims/evidence : PASS
Model claims auto-promoted : 0
Contradictions : PASS
Temporal model : PASS
Relationship provenance : PASS
Privacy : PASS
Cross-notebook leakage : 0
Cross-scope leakage : 0
Private evidence leakage : 0
Security red team : PASS
Hybrid retrieval : PASS
Original-source citations : PASS
Graph UI : PASS
Consumer API : PASS
Trust inheritance : 0
Graph-derived authorization : 0
Strict Local : PASS
Cloud calls : 0
Restart/persistence : PASS

Official backend suite : 3628 total / 3614 pass / 0 fail / 5 cancelled / 9 skipped (exit 1)
Backend cancelled classification : PRE-EXISTING_YOUTUBE_SMART_DISCOVERY_FLAKE
KG regression from backend suite : NO

Browser suite : 127 assertions / 127 pass / 0 fail
Typecheck : PASS
Build : PASS

Notebook frozen drift : 0
Unexpected frozen files modified : 0
Root Policy modified : 0
Real user DB modified : 0
Real user DB kg tables : 0
Git mutations : 0

Activation status : DISABLED_PENDING_HUMAN_ACTIVATION

FINAL VERDICT : KNOWLEDGE_GRAPH_V1_CERTIFICATION_PASS_WITH_LIMITATIONS
```

Next human decisions (separate): staging / commit → activation → FINAL / FREEZE.
