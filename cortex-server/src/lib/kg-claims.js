// Knowledge Graph V1 — KG-4 claims, evidence, provenance, temporality, contradictions.
//
// assertClaim: subject —predicate→ (objectEntity | value), validity interval,
// observation date, extraction method, model and source confidence kept apart.
//   • a DERIVED claim (DETERMINISTIC, MODEL_PROPOSAL) needs ≥ 1 evidence;
//     only a USER claim may have none;
//   • one logical claim per claim_key (subject, predicate, object, interval):
//     the same claim from two sources is ONE claim with TWO evidences; the same
//     extraction repeated from the same source adds nothing;
//   • a model proposal is HYPOTHESIS and never becomes SUPPORTED on its own;
//   • contradictions are recorded (kg_claim_conflicts), both claims are kept
//     and marked DISPUTED; nothing is deleted, nothing decides "the truth";
//   • supersession is explicit (`supersedes`): the old claim becomes SUPERSEDED
//     and stays queryable as history.
// Nothing here calls a model, the network or the cloud.

import { KG_DEFAULT_LIMITS, KG_STANCES, KG_EXTRACTION_METHODS } from './kg-schema.js';
import {
  predicateDefinition, normalizeClaimValue, storedValue, valueKeyOf, normalizeInterval, normalizeKgDate,
  intervalsOverlap, temporalState, claimKey, strongerMethod, KgClaimError,
} from './kg-claim-model.js';
import { stableHash, entityTypesCompatible } from './kg-normalize.js';

const MAX_EXCERPT_INPUT = 100_000;
const MAX_EVIDENCE_PER_ASSERTION = 50;
const LIVE = "status NOT IN ('INVALIDATED', 'SUPERSEDED')";
const nowIso = () => new Date().toISOString();
const parseJson = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

function confidence(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new KgClaimError('KG_CONFIDENCE_INVALID', `${field} must be a number in [0, 1]`);
  return value;
}

function requireEntity(store, id, field) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new KgClaimError('KG_ENTITY_ID_INVALID', `${field} is not a valid entity id`);
  const entity = store.getEntity(id);
  if (!entity) throw new KgClaimError('KG_ENTITY_NOT_FOUND', `${field} ${id} not found`);
  return entity;
}

/** Validates every evidence of an assertion before anything is written. */
function validateEvidenceInputs(store, list) {
  if (!Array.isArray(list)) throw new KgClaimError('KG_EVIDENCE_INVALID', 'evidence must be an array');
  if (list.length > MAX_EVIDENCE_PER_ASSERTION) throw new KgClaimError('KG_EVIDENCE_INVALID', `at most ${MAX_EVIDENCE_PER_ASSERTION} evidences per assertion`);
  return list.map((e, i) => {
    if (!e || typeof e !== 'object') throw new KgClaimError('KG_EVIDENCE_INVALID', `evidence[${i}] must be an object`);
    if (typeof e.sourceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(e.sourceId)) throw new KgClaimError('KG_SOURCE_ID_INVALID', `evidence[${i}].sourceId is not a valid source id`);
    const source = store.getSource(e.sourceId);
    if (!source) throw new KgClaimError('KG_SOURCE_NOT_FOUND', `evidence[${i}]: source ${e.sourceId} not found`);
    if (source.status !== 'ACTIVE') throw new KgClaimError('KG_EVIDENCE_SOURCE_INACTIVE', `evidence[${i}]: source ${e.sourceId} is ${source.status}`);
    if (e.sourceRefId) {
      const ref = store.getSourceRef(e.sourceRefId);
      if (!ref || ref.source_id !== e.sourceId) throw new KgClaimError('KG_EVIDENCE_INVALID', `evidence[${i}]: source ref does not belong to the source`);
    }
    if (typeof e.excerpt !== 'string' || !e.excerpt.trim()) throw new KgClaimError('KG_EVIDENCE_INVALID', `evidence[${i}]: excerpt is required`);
    if (e.excerpt.length > MAX_EXCERPT_INPUT) throw new KgClaimError('KG_EVIDENCE_INVALID', `evidence[${i}]: excerpt too large`);
    const stance = e.stance ?? 'SUPPORTS';
    if (!KG_STANCES.includes(stance)) throw new KgClaimError('KG_EVIDENCE_INVALID', `evidence[${i}]: invalid stance`);
    return { ...e, stance, source };
  });
}

function objectLabel(store, objectEntityId, value) {
  if (objectEntityId) return store.getEntity(objectEntityId)?.name ?? objectEntityId;
  return value.unit ? `${value.value} ${value.unit}` : String(value.value);
}

/**
 * Asserts a claim with its evidence. Runs in one transaction: an invalid
 * evidence, entity, source or value rejects the whole assertion.
 */
export function assertClaim(store, input) {
  const def = predicateDefinition(input?.predicate);
  const method = input.extractionMethod;
  if (!KG_EXTRACTION_METHODS.includes(method)) throw new KgClaimError('KG_EXTRACTION_METHOD_INVALID', `extractionMethod must be one of ${KG_EXTRACTION_METHODS.join(', ')}`);
  const modelConfidence = confidence(input.modelConfidence, 'modelConfidence');
  const sourceConfidence = confidence(input.sourceConfidence, 'sourceConfidence');
  if (method !== 'MODEL_PROPOSAL' && modelConfidence !== null) throw new KgClaimError('KG_CONFIDENCE_INVALID', 'modelConfidence only applies to a model proposal');

  return store.transaction(() => {
    const subject = requireEntity(store, input.subjectEntityId, 'subjectEntityId');
    if (def.subjectTypes && !def.subjectTypes.includes(subject.entity_type)) {
      throw new KgClaimError('KG_PREDICATE_SUBJECT_TYPE', `${def.predicate} does not apply to a ${subject.entity_type}`);
    }
    const hasObject = input.objectEntityId !== undefined && input.objectEntityId !== null;
    const hasValue = input.value !== undefined && input.value !== null;
    if (hasObject === hasValue) throw new KgClaimError('KG_CLAIM_OBJECT_INVALID', 'exactly one of objectEntityId or value is required');
    let object = null;
    let value = null;
    if (hasObject) {
      if (def.object === 'value') throw new KgClaimError('KG_CLAIM_OBJECT_INVALID', `${def.predicate} takes a value, not an entity`);
      object = requireEntity(store, input.objectEntityId, 'objectEntityId');
      if (object.entity_id === subject.entity_id) throw new KgClaimError('KG_CLAIM_OBJECT_INVALID', 'subject and object are the same entity');
      if (def.objectTypes && !def.objectTypes.some(t => entityTypesCompatible(t, object.entity_type))) {
        throw new KgClaimError('KG_PREDICATE_OBJECT_TYPE', `${def.predicate} does not take a ${object.entity_type}`);
      }
    } else {
      if (def.object === 'entity') throw new KgClaimError('KG_CLAIM_OBJECT_INVALID', `${def.predicate} takes an entity, not a value`);
      value = normalizeClaimValue(input.value, def.valueType);
    }
    const { validFrom, validTo } = normalizeInterval(input);
    const observedAt = input.observedAt ? normalizeKgDate(input.observedAt) : nowIso();
    if (!observedAt) throw new KgClaimError('KG_DATE_INVALID', 'observedAt is not a valid date');
    const evidence = validateEvidenceInputs(store, input.evidence ?? []);
    if (method !== 'USER' && evidence.length === 0) throw new KgClaimError('KG_EVIDENCE_REQUIRED', 'a derived claim needs at least one evidence');

    const key = claimKey({ subjectEntityId: subject.entity_id, predicate: def.predicate, objectEntityId: object?.entity_id ?? null, valueKey: value?.key ?? null, validFrom, validTo });
    const existing = store.prepare('SELECT * FROM kg_claims WHERE claim_key = ?').get(key);
    let claimId;
    let created = false;
    if (existing) {
      claimId = existing.claim_id;
      // A stronger assertion upgrades the method; the confidences stay separate (max of each).
      const nextMethod = existing.extraction_method ? strongerMethod(existing.extraction_method, method) : method;
      const max = (a, b) => (a === null || a === undefined ? b : (b === null || b === undefined ? a : Math.max(a, b)));
      const metadata = { ...parseJson(existing.metadata, {}), last_observed_at: observedAt };
      store.prepare(`UPDATE kg_claims SET extraction_method = ?, model_confidence = ?, source_confidence = ?,
          observed_at = CASE WHEN observed_at IS NULL OR ? < observed_at THEN ? ELSE observed_at END, metadata = ?, updated_at = ?, version = version + 1
        WHERE claim_id = ?`)
        .run(nextMethod, max(existing.model_confidence, modelConfidence), max(existing.source_confidence, sourceConfidence), observedAt, observedAt, JSON.stringify(metadata), nowIso(), claimId);
    } else {
      claimId = `clm_${stableHash('claim-id', key).substring(0, 24)}`;
      const statement = `${subject.name} — ${def.predicate} — ${objectLabel(store, object?.entity_id, value)}`.slice(0, 500);
      store.upsertClaim({
        claim_id: claimId,
        entity_id: subject.entity_id,
        claim_type: object ? 'RELATIONSHIP' : 'OBSERVATION',
        statement,
        predicate: def.predicate,
        object_entity_id: object?.entity_id ?? null,
        value_json: value ? storedValue(value) : null,
        source_id: evidence[0]?.sourceId ?? null,
        extraction_method: method,
        model_confidence: modelConfidence,
        source_confidence: sourceConfidence,
        observed_at: observedAt,
        valid_from: validFrom,
        valid_to: validTo,
        metadata: { first_observed_at: observedAt },
      }, { pendingEvidence: true });
      store.prepare('UPDATE kg_claims SET claim_key = ? WHERE claim_id = ?').run(key, claimId);
      created = true;
    }

    const evidenceResults = [];
    for (const e of evidence) {
      const ev = store.upsertEvidence({
        source_id: e.sourceId,
        source_ref_id: e.sourceRefId ?? null,
        content: e.excerpt,
        evidence_type: e.evidenceType ?? (e.stance === 'CONTRADICTS' ? 'CONTRADICTING' : 'DIRECT'),
        locator_kind: e.locatorKind ?? 'SOURCE',
        locator_ref: e.locatorRef ?? null,
        chunk_id: e.chunkId ?? null,
        message_id: e.messageId ?? null,
        page: e.page ?? null,
        section: e.section ?? null,
        char_start: e.charStart ?? null,
        char_end: e.charEnd ?? null,
        // per-evidence confidence = confidence of THIS extraction; the source's own reliability stays on the claim / source
        confidence: e.confidence ?? (method === 'MODEL_PROPOSAL' ? (modelConfidence ?? 0) : 1),
        metadata: { extraction_method: method },
      });
      store.attachEvidence(claimId, ev.id, { stance: e.stance });
      evidenceResults.push({ evidenceId: ev.id, created: ev.isNew, stance: e.stance });
    }

    let superseded = null;
    if (input.supersedes) superseded = supersedeClaim(store, input.supersedes, claimId, { reason: input.supersedeReason ?? 'superseded by a newer claim', actor: method === 'USER' ? 'USER' : 'SYSTEM' });
    const conflictIds = detectConflicts(store, claimId);
    const status = store.recomputeClaimStatus(claimId);
    return { claimId, claimKey: key, created, status, evidence: evidenceResults, conflictIds, superseded };
  });
}

/**
 * Explicit supersession: `newClaimId` replaces `oldClaimId` (same subject and
 * predicate). The old claim is kept as SUPERSEDED history; conflicts between
 * the two are resolved as SUPERSEDED.
 */
export function supersedeClaim(store, oldClaimId, newClaimId, { reason = '', actor = 'USER' } = {}) {
  return store.transaction(() => {
    const oldClaim = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(oldClaimId);
    const newClaim = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(newClaimId);
    if (!oldClaim || !newClaim) throw new KgClaimError('KG_CLAIM_NOT_FOUND', 'both claims must exist');
    if (oldClaimId === newClaimId) throw new KgClaimError('KG_SUPERSEDE_INVALID', 'a claim cannot supersede itself');
    if (oldClaim.predicate !== newClaim.predicate || store.getLogicalRootId(oldClaim.entity_id) !== store.getLogicalRootId(newClaim.entity_id)) {
      throw new KgClaimError('KG_SUPERSEDE_INVALID', 'only a claim about the same subject and predicate can be superseded');
    }
    if (newClaim.superseded_by_id === oldClaimId) throw new KgClaimError('KG_SUPERSEDE_INVALID', 'cycle: the new claim is superseded by the old one');
    if (oldClaim.status === 'SUPERSEDED') {
      if (oldClaim.superseded_by_id === newClaimId) return { oldClaimId, newClaimId, changed: false };
      throw new KgClaimError('KG_SUPERSEDE_INVALID', `already superseded by ${oldClaim.superseded_by_id}`);
    }
    const now = nowIso();
    const metadata = { ...parseJson(oldClaim.metadata, {}), superseded: { at: now, by: newClaimId, previous_status: oldClaim.status, reason: String(reason).slice(0, 300), actor } };
    store.prepare("UPDATE kg_claims SET status = 'SUPERSEDED', is_active = 0, superseded_by_id = ?, metadata = ?, updated_at = ? WHERE claim_id = ?")
      .run(newClaimId, JSON.stringify(metadata), now, oldClaimId);
    const [a, b] = [oldClaimId, newClaimId].sort();
    store.prepare("UPDATE kg_claim_conflicts SET status = 'RESOLVED', resolved_at = ?, resolution = 'SUPERSEDED' WHERE claim_a_id = ? AND claim_b_id = ? AND status = 'OPEN'").run(now, a, b);
    store.recomputeConflictCounterparts(oldClaimId);
    store.recomputeClaimStatus(newClaimId);
    return { oldClaimId, newClaimId, changed: true };
  });
}

function objectOf(row) {
  return row.object_entity_id ? { kind: 'entity', key: null, entityId: row.object_entity_id } : { kind: 'value', key: valueKeyOf(row.value_json) };
}

function sameObject(store, a, b) {
  const oa = objectOf(a);
  const ob = objectOf(b);
  if (oa.kind !== ob.kind) return null; // incomparable: never a contradiction
  if (oa.kind === 'entity') return store.getLogicalRootId(oa.entityId) === store.getLogicalRootId(ob.entityId);
  if (!oa.key || !ob.key) return null;
  return oa.key === ob.key;
}

/**
 * Prudent contradiction detection. Only for a SINGLE-valued predicate, between
 * two LIVE claims about the same (logical) subject whose objects differ and
 * whose validity intervals overlap. Different objects at different periods,
 * multi-valued predicates, unknown predicates and incomparable objects are
 * never contradictions.
 */
export function detectConflicts(store, claimId) {
  const claim = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(claimId);
  if (!claim?.predicate) return [];
  const def = predicateDefinition(claim.predicate);
  if (def.cardinality !== 'single' || ['INVALIDATED', 'SUPERSEDED'].includes(claim.status)) return [];
  const members = store.getLogicalMemberIds(store.getLogicalRootId(claim.entity_id));
  const placeholders = members.map(() => '?').join(', ');
  const others = store.prepare(`SELECT * FROM kg_claims WHERE predicate = ? AND entity_id IN (${placeholders}) AND claim_id <> ? AND ${LIVE}
    LIMIT ${KG_DEFAULT_LIMITS.MAX_EDGES}`).all(claim.predicate, ...members, claimId);
  const ids = [];
  for (const other of others) {
    if (sameObject(store, claim, other) !== false) continue;
    const a = { validFrom: claim.valid_from, validTo: claim.valid_to };
    const b = { validFrom: other.valid_from, validTo: other.valid_to };
    if (!intervalsOverlap(a, b)) continue;
    const [first, second] = [claim, other].sort((x, y) => (x.claim_id < y.claim_id ? -1 : 1));
    const conflictId = `kcf_${stableHash('conflict', first.claim_id, second.claim_id, 'SINGLE_VALUE_CONFLICT').substring(0, 24)}`;
    store.prepare(`INSERT OR IGNORE INTO kg_claim_conflicts (conflict_id, claim_a_id, claim_b_id, kind, predicate, status, signals, detected_at)
      VALUES (?, ?, ?, 'SINGLE_VALUE_CONFLICT', ?, 'OPEN', ?, ?)`)
      .run(conflictId, first.claim_id, second.claim_id, claim.predicate, JSON.stringify({
        rule: 'single-valued predicate, different objects, overlapping validity [validFrom, validTo)',
        a: { validFrom: first.valid_from, validTo: first.valid_to },
        b: { validFrom: second.valid_from, validTo: second.valid_to },
        undated: !first.valid_from && !first.valid_to && !second.valid_from && !second.valid_to,
      }), nowIso());
    store.recomputeClaimStatus(other.claim_id, { propagate: false });
    ids.push(conflictId);
  }
  return ids;
}

/**
 * Re-evaluates the open conflicts of a claim (e.g. after an entity merge made
 * both objects the same entity): a conflict that no longer holds is RESOLVED.
 */
export function recheckConflicts(store, claimId) {
  return store.transaction(() => {
    const rows = store.prepare("SELECT * FROM kg_claim_conflicts WHERE (claim_a_id = ? OR claim_b_id = ?) AND status = 'OPEN'").all(claimId, claimId);
    let resolved = 0;
    for (const k of rows) {
      const a = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(k.claim_a_id);
      const b = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(k.claim_b_id);
      const stillConflicting = sameObject(store, a, b) === false && intervalsOverlap({ validFrom: a.valid_from, validTo: a.valid_to }, { validFrom: b.valid_from, validTo: b.valid_to });
      if (!stillConflicting) {
        store.prepare("UPDATE kg_claim_conflicts SET status = 'RESOLVED', resolved_at = ?, resolution = 'NO_LONGER_CONFLICTING' WHERE conflict_id = ?").run(nowIso(), k.conflict_id);
        resolved++;
      }
    }
    store.recomputeClaimStatus(claimId);
    store.recomputeConflictCounterparts(claimId);
    return { checked: rows.length, resolved };
  });
}

// ── privacy-aware reads ─────────────────────────────────────────────────────

/**
 * Visibility of a claim when private sources are filtered: a USER claim
 * without evidence is visible unless its origin source is private; a derived
 * claim is visible only through at least one evidence from a non-private source.
 */
const VISIBLE_CLAIM_SQL = `(
  EXISTS (SELECT 1 FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
          JOIN kg_sources s ON s.source_id = e.source_id
          WHERE ce.claim_id = c.claim_id AND s.privacy <> 'PRIVATE')
  OR (NOT EXISTS (SELECT 1 FROM kg_claim_evidence ce2 WHERE ce2.claim_id = c.claim_id)
      AND (c.source_id IS NULL OR EXISTS (SELECT 1 FROM kg_sources s2 WHERE s2.source_id = c.source_id AND s2.privacy <> 'PRIVATE')))
)`;

export function isClaimVisible(store, claimId, { includePrivate = false } = {}) {
  if (includePrivate) return Boolean(store.prepare('SELECT 1 FROM kg_claims WHERE claim_id = ?').get(claimId));
  return Boolean(store.prepare(`SELECT 1 FROM kg_claims c WHERE c.claim_id = ? AND ${VISIBLE_CLAIM_SQL}`).get(claimId));
}

function presentObject(store, row) {
  if (row.object_entity_id) {
    const e = store.getEntity(row.object_entity_id);
    return { kind: 'entity', entityId: row.object_entity_id, label: e?.name ?? null, type: e?.entity_type ?? null, logicalEntityId: store.getLogicalRootId(row.object_entity_id) };
  }
  const v = parseJson(row.value_json, null);
  return { kind: 'value', value: v };
}

function presentClaim(store, row, at) {
  const subject = store.getEntity(row.entity_id);
  return {
    claimId: row.claim_id,
    subject: { entityId: row.entity_id, label: subject?.name ?? null, type: subject?.entity_type ?? null, logicalEntityId: store.getLogicalRootId(row.entity_id) },
    predicate: row.predicate,
    object: presentObject(store, row),
    status: row.status,
    extractionMethod: row.extraction_method,
    modelConfidence: row.model_confidence,
    sourceConfidence: row.source_confidence,
    observedAt: row.observed_at,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    temporalState: temporalState({ validFrom: row.valid_from, validTo: row.valid_to }, at),
    supersededBy: row.superseded_by_id,
    originSourceId: row.source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Full provenance of a claim: where it comes from, which sources support or
 * contradict it (with their technical paths and exact locators), when it was
 * observed, which claims it conflicts with, what it superseded. Private
 * evidence is omitted unless `includePrivate`; a claim visible only through
 * private evidence is not returned at all.
 */
export function explainClaim(store, claimId, { includePrivate = false, at } = {}) {
  const row = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(claimId);
  if (!row || !isClaimVisible(store, claimId, { includePrivate })) return null;
  const evidence = store.prepare(`
    SELECT ce.stance, ce.status AS link_status, ce.attached_at, ce.detached_at, e.*,
           s.name AS source_name, s.source_type, s.privacy AS source_privacy, s.status AS source_status, s.trust_level AS source_trust,
           r.adapter AS ref_adapter, r.input_path AS ref_input_path, r.source_ref AS ref_source_ref, r.observed_at AS ref_observed_at, r.status AS ref_status
    FROM kg_claim_evidence ce
    JOIN kg_evidence e ON e.evidence_id = ce.evidence_id
    JOIN kg_sources s ON s.source_id = e.source_id
    LEFT JOIN kg_source_refs r ON r.source_ref_id = e.source_ref_id
    WHERE ce.claim_id = ? ${includePrivate ? '' : "AND s.privacy <> 'PRIVATE'"}
    ORDER BY ce.attached_at, e.evidence_id
    LIMIT ${KG_DEFAULT_LIMITS.DEFAULT_EDGE_LIMIT}
  `).all(claimId).map(e => ({
    evidenceId: e.evidence_id,
    stance: e.stance,
    linkStatus: e.link_status,
    status: e.status,
    excerptHash: e.excerpt_hash,
    preview: e.content,
    confidence: e.confidence,
    locator: { kind: e.locator_kind, ref: e.locator_ref, chunkId: e.chunk_id, messageId: e.message_id, page: e.page, section: e.section, charStart: e.char_start, charEnd: e.char_end },
    source: { sourceId: e.source_id, name: e.source_name, type: e.source_type, privacy: e.source_privacy, status: e.source_status, trustLevel: e.source_trust },
    sourceRef: e.source_ref_id ? { sourceRefId: e.source_ref_id, adapter: e.ref_adapter, inputPath: e.ref_input_path, sourceRef: e.ref_source_ref, observedAt: e.ref_observed_at, status: e.ref_status } : null,
    attachedAt: e.attached_at,
  }));
  const contradictions = store.prepare(`SELECT * FROM kg_claim_conflicts WHERE claim_a_id = ? OR claim_b_id = ? ORDER BY detected_at, conflict_id`).all(claimId, claimId)
    .map(k => {
      const otherId = k.claim_a_id === claimId ? k.claim_b_id : k.claim_a_id;
      if (!isClaimVisible(store, otherId, { includePrivate })) return null;
      const other = store.prepare('SELECT * FROM kg_claims WHERE claim_id = ?').get(otherId);
      return { conflictId: k.conflict_id, kind: k.kind, status: k.status, resolution: k.resolution, detectedAt: k.detected_at, signals: parseJson(k.signals, {}), otherClaim: presentClaim(store, other, at) };
    })
    .filter(Boolean);
  const supersedes = store.prepare('SELECT claim_id FROM kg_claims WHERE superseded_by_id = ? ORDER BY created_at').all(claimId)
    .map(r => r.claim_id).filter(id => isClaimVisible(store, id, { includePrivate }));
  return {
    claim: presentClaim(store, row, at),
    evidence,
    supportingEvidence: evidence.filter(e => e.stance === 'SUPPORTS' && e.linkStatus === 'ACTIVE' && e.status === 'ACTIVE').length,
    contradictingEvidence: evidence.filter(e => e.stance === 'CONTRADICTS' && e.linkStatus === 'ACTIVE' && e.status === 'ACTIVE').length,
    contradictions,
    supersedes,
    metadata: parseJson(row.metadata, {}),
  };
}

/**
 * Claims about an entity (all its logical members). `includeHistory` adds
 * SUPERSEDED / INVALIDATED claims. Private-only claims are filtered out
 * unless `includePrivate`.
 */
export function getClaimsForSubject(store, entityId, { predicate = null, includeHistory = false, includePrivate = false, at, limit = KG_DEFAULT_LIMITS.DEFAULT_EDGE_LIMIT } = {}) {
  const root = store.getLogicalRootId(entityId);
  if (!root) return [];
  const members = store.getLogicalMemberIds(root);
  const placeholders = members.map(() => '?').join(', ');
  const rows = store.prepare(`SELECT c.* FROM kg_claims c WHERE c.entity_id IN (${placeholders})
      ${predicate ? 'AND c.predicate = ?' : ''} ${includeHistory ? '' : `AND c.${LIVE}`} ${includePrivate ? '' : `AND ${VISIBLE_CLAIM_SQL}`}
      ORDER BY c.predicate, c.valid_from, c.created_at, c.claim_id LIMIT ?`)
    .all(...members, ...(predicate ? [predicate] : []), Math.min(limit, KG_DEFAULT_LIMITS.MAX_EDGES));
  return rows.map(r => presentClaim(store, r, at));
}

/** Live claims about an entity valid at a date (validFrom ≤ at < validTo; missing bounds unbounded). */
export function getClaimsValidAt(store, entityId, at, { predicate = null, includePrivate = false } = {}) {
  const t = normalizeKgDate(at);
  if (!t) throw new KgClaimError('KG_DATE_INVALID', 'at is not a valid date');
  const root = store.getLogicalRootId(entityId);
  if (!root) return [];
  const members = store.getLogicalMemberIds(root);
  const placeholders = members.map(() => '?').join(', ');
  return store.prepare(`SELECT c.* FROM kg_claims c WHERE c.entity_id IN (${placeholders}) AND c.${LIVE}
      ${predicate ? 'AND c.predicate = ?' : ''}
      AND (c.valid_from IS NULL OR c.valid_from <= ?) AND (c.valid_to IS NULL OR c.valid_to > ?)
      ${includePrivate ? '' : `AND ${VISIBLE_CLAIM_SQL}`}
      ORDER BY c.predicate, c.valid_from, c.claim_id LIMIT ?`)
    .all(...members, ...(predicate ? [predicate] : []), t, t, KG_DEFAULT_LIMITS.MAX_EDGES)
    .map(r => presentClaim(store, r, t));
}

/** Contradictions involving an entity's claims (both claims must be visible). */
export function getConflictsForSubject(store, entityId, { status = 'OPEN', includePrivate = false } = {}) {
  const root = store.getLogicalRootId(entityId);
  if (!root) return [];
  const members = store.getLogicalMemberIds(root);
  const placeholders = members.map(() => '?').join(', ');
  return store.prepare(`SELECT k.* FROM kg_claim_conflicts k
      JOIN kg_claims a ON a.claim_id = k.claim_a_id JOIN kg_claims b ON b.claim_id = k.claim_b_id
      WHERE (a.entity_id IN (${placeholders}) OR b.entity_id IN (${placeholders})) ${status ? 'AND k.status = ?' : ''}
      ORDER BY k.detected_at, k.conflict_id LIMIT ?`)
    .all(...members, ...members, ...(status ? [status] : []), KG_DEFAULT_LIMITS.DEFAULT_EDGE_LIMIT)
    .filter(k => isClaimVisible(store, k.claim_a_id, { includePrivate }) && isClaimVisible(store, k.claim_b_id, { includePrivate }))
    .map(k => ({ conflictId: k.conflict_id, kind: k.kind, predicate: k.predicate, status: k.status, resolution: k.resolution, claimAId: k.claim_a_id, claimBId: k.claim_b_id, signals: parseJson(k.signals, {}), detectedAt: k.detected_at }));
}

export function newOpaqueId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
}

export default { assertClaim, supersedeClaim, detectConflicts, recheckConflicts, explainClaim, getClaimsForSubject, getClaimsValidAt, getConflictsForSubject, isClaimVisible };
