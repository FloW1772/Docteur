// Knowledge Graph V1 — KG-3 entity resolution.
//
// A mention { label, type, identifiers, aliases, provenance, context } is
// attached to an existing entity only on sufficient evidence, in this order:
//   1. stable identifier, exact, valid for the entity type (STABLE_IDENTIFIER);
//   2. same provenance re-imported (same source ref + same label) — idempotent;
//   3. same label / alias + at least one corroborating signal and no
//      contradicting one, for exactly one candidate (ALIAS_CORROBORATED /
//      LABEL_CONTEXT).
// Otherwise a NEW entity is created; when same-label candidates exist without
// corroboration it is AMBIGUOUS and every candidate is kept as a PROPOSED
// resolution. Similar labels and model (LLM) suggestions are only ever
// PROPOSED. The type is part of identity: incompatible types never resolve.
//
// Merges are explicit (user / confirmed proposal), written to the ledger
// (kg_entity_resolutions) and implemented as a logical redirect
// (merged_into_id): no entity, alias, identifier, claim or evidence is deleted
// or rewritten, and reverseResolution restores the previous view.
// Nothing here calls a model, the network, or the cloud.

import crypto from 'node:crypto';
import { KG_DEFAULT_LIMITS, KG_ENTITY_TYPES } from './kg-schema.js';
import {
  labelKeys, normalizeIdentifier, identifierIsStrongFor, entityTypesCompatible, compatibleTypes,
  editDistanceAtMost, stableHash, looseKey,
} from './kg-normalize.js';
import { KgError } from './kg-store.js';

// Schemes for which an entity has at most one value (two different values = two entities).
const SINGLE_VALUED_SCHEMES = new Set(['wikidata', 'orcid', 'registry_id', 'isbn', 'doi']);
// Methods the system may never confirm on its own.
const PROPOSAL_ONLY_METHODS = new Set(['SIMILARITY_CANDIDATE', 'LLM_CANDIDATE', 'SAME_LABEL_UNCORROBORATED']);

const nowIso = () => new Date().toISOString();

function attributesOf(entity) {
  const attrs = entity?.metadata?.attributes;
  return attrs && typeof attrs === 'object' ? attrs : {};
}

/** Agreement / contradiction between two attribute maps (comparison keys). */
function compareAttributes(a, b) {
  const agree = [];
  const conflict = [];
  for (const [key, value] of Object.entries(a ?? {})) {
    if (!(key in (b ?? {}))) continue;
    const va = looseKey(value);
    const vb = looseKey(b[key]);
    if (!va || !vb) continue;
    (va === vb ? agree : conflict).push(key);
  }
  return { agree, conflict };
}

function relatedRootIds(store, rootId) {
  const members = store.getLogicalMemberIds(rootId);
  const placeholders = members.map(() => '?').join(', ');
  const rows = store.prepare(`
    SELECT target_entity_id AS id FROM kg_relationships WHERE source_entity_id IN (${placeholders}) AND is_active = 1
    UNION SELECT source_entity_id FROM kg_relationships WHERE target_entity_id IN (${placeholders}) AND is_active = 1
    UNION SELECT object_entity_id FROM kg_claims WHERE entity_id IN (${placeholders}) AND object_entity_id IS NOT NULL
    UNION SELECT entity_id FROM kg_claims WHERE object_entity_id IN (${placeholders})
    LIMIT 500
  `).all(...members, ...members, ...members, ...members);
  return new Set(rows.map(r => store.getLogicalRootId(r.id)).filter(Boolean));
}

function identifiersOfLogical(store, rootId) {
  const members = store.getLogicalMemberIds(rootId);
  const placeholders = members.map(() => '?').join(', ');
  return store.prepare(`SELECT scheme, normalized_value FROM kg_entity_identifiers WHERE entity_id IN (${placeholders}) AND status IN ('ACTIVE', 'CONFLICT')`).all(...members);
}

function sourcesOfLogical(store, rootId) {
  const members = store.getLogicalMemberIds(rootId);
  const placeholders = members.map(() => '?').join(', ');
  return new Set(store.prepare(`SELECT DISTINCT source_id FROM kg_aliases WHERE entity_id IN (${placeholders}) AND source_id IS NOT NULL`).all(...members).map(r => r.source_id));
}

/** Logical roots of every entity of a compatible type carrying this comparison key as label or alias. */
function sameLabelRoots(store, looseLabel, types) {
  const typeList = types.map(() => '?').join(', ');
  const rows = store.prepare(`
    SELECT entity_id, 'label' AS via FROM kg_entities
      WHERE normalized_name = ? AND entity_type IN (${typeList}) AND status <> 'INVALIDATED'
    UNION
    SELECT a.entity_id, 'alias' AS via FROM kg_aliases a JOIN kg_entities e ON e.entity_id = a.entity_id
      WHERE a.normalized_alias = ? AND a.status IN ('CONFIRMED', 'PROPOSED') AND e.entity_type IN (${typeList}) AND e.status <> 'INVALIDATED'
    LIMIT ${KG_DEFAULT_LIMITS.MAX_RESOLUTION_CANDIDATES * 4}
  `).all(looseLabel, ...types, looseLabel, ...types);
  const roots = new Map();
  for (const row of rows) {
    const root = store.getLogicalRootId(row.entity_id);
    if (!root) continue;
    const prev = roots.get(root);
    roots.set(root, prev === 'label' ? 'label' : row.via);
  }
  return roots;
}

/** Candidate-only: same tokens in another order, or one edit away (labels ≥ 5 chars). */
function similarRoots(store, keys, types, exclude) {
  const typeList = types.map(() => '?').join(', ');
  const found = new Set();
  if (keys.tokens) {
    for (const row of store.prepare(`SELECT entity_id FROM kg_entities WHERE token_key = ? AND entity_type IN (${typeList}) AND status NOT IN ('INVALIDATED', 'MERGED') LIMIT 50`).all(keys.tokens, ...types)) {
      found.add(row.entity_id);
    }
  }
  if (keys.loose.length >= 5) {
    // Blocking: an index range on (entity_type, normalized_name) over the first half of the key.
    // One edit in the second half is found; an edit in the first half is not (candidates only —
    // a missed candidate never causes a merge, it only leaves two entities unlinked).
    const prefix = keys.loose.slice(0, Math.max(2, Math.floor(keys.loose.length / 2)));
    const rows = store.prepare(`SELECT entity_id, normalized_name FROM kg_entities
      WHERE entity_type IN (${typeList}) AND normalized_name >= ? AND normalized_name < ? AND length(normalized_name) BETWEEN ? AND ? AND status NOT IN ('INVALIDATED', 'MERGED') LIMIT 500`)
      .all(...types, prefix, `${prefix}\u{10FFFF}`, keys.loose.length - 1, keys.loose.length + 1);
    for (const row of rows) if (editDistanceAtMost(row.normalized_name, keys.loose, 1) <= 1) found.add(row.entity_id);
  }
  const roots = new Set();
  for (const id of found) {
    const root = store.getLogicalRootId(id);
    if (root && !exclude.has(root)) roots.add(root);
  }
  return [...roots].slice(0, KG_DEFAULT_LIMITS.MAX_RESOLUTION_CANDIDATES);
}

function newEntityId(type, keys, validIds, provenance) {
  const typeClass = compatibleTypes(type).sort().join('|');
  if (validIds.length > 0) return `ent_${stableHash('ids', typeClass, ...validIds.map(i => `${i.scheme}:${i.value}`).sort()).substring(0, 24)}`;
  if (provenance) return `ent_${stableHash('prov', typeClass, keys.label, provenance).substring(0, 24)}`;
  return `ent_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
}

/**
 * Resolves one mention. Runs in a single transaction.
 *
 * @param {import('./kg-store.js').KnowledgeGraphStore} store
 * @param {object} mention
 * @param {string} mention.label                original label (kept as is)
 * @param {string} mention.type                 entity type (part of identity)
 * @param {{scheme:string,value:string}[]} [mention.identifiers]
 * @param {string[]} [mention.aliases]          other labels for the same thing in this source
 * @param {string} [mention.description]
 * @param {string} [mention.sourceId]           logical source of the mention
 * @param {string} [mention.sourceRefId]        technical path of the mention
 * @param {{relatedEntityIds?:string[], attributes?:object}} [mention.context]
 * @param {{entityId:string, reason?:string}} [mention.llmSuggestion]  recorded as a proposal only
 */
export function resolveEntityMention(store, mention) {
  const label = mention?.label === null || mention?.label === undefined ? '' : String(mention.label);
  const keys = labelKeys(label);
  if (!keys.loose) throw new KgError('KG_MENTION_LABEL_REQUIRED', 'a mention needs a non-empty label');
  if (!KG_ENTITY_TYPES.includes(mention.type)) throw new KgError('KG_MENTION_TYPE_INVALID', `unknown entity type ${mention.type}`);
  if (mention.sourceRefId) {
    const ref = store.getSourceRef(mention.sourceRefId);
    if (!ref) throw new Error(`Source ref ${mention.sourceRefId} not found`);
    if (mention.sourceId && ref.source_id !== mention.sourceId) throw new Error('sourceRefId does not belong to sourceId');
    mention = { ...mention, sourceId: ref.source_id };
  }
  const types = compatibleTypes(mention.type);
  const context = mention.context ?? {};

  return store.transaction(() => {
    const report = {
      outcome: null, entityId: null, logicalEntityId: null, method: null,
      candidates: [], proposedResolutionIds: [], rejectedIdentifiers: [], identifierConflicts: [],
    };

    // ── identifiers ──
    const validIds = [];
    for (const raw of mention.identifiers ?? []) {
      const n = normalizeIdentifier(raw?.scheme, raw?.value);
      if (n) validIds.push(n);
      else report.rejectedIdentifiers.push({ scheme: raw?.scheme ?? null, reason: 'invalid for scheme' });
    }
    const strongRoots = new Map();
    const weakIdentifierRoots = new Set();
    for (const id of validIds) {
      for (const holder of store.findEntitiesByIdentifier(id.scheme, id.value)) {
        const root = holder.logical_root_id;
        const rootEntity = store.getEntity(root);
        if (!entityTypesCompatible(rootEntity.entity_type, mention.type)) {
          report.identifierConflicts.push({ scheme: id.scheme, heldBy: root, heldByType: rootEntity.entity_type, reason: 'incompatible entity type' });
          continue;
        }
        if (identifierIsStrongFor(id.scheme, mention.type)) strongRoots.set(root, [...(strongRoots.get(root) ?? []), id.scheme]);
        else weakIdentifierRoots.add(root);
      }
    }

    let target = null;
    let method = null;
    let status = 'ACTIVE';
    const proposals = [];

    if (strongRoots.size === 1) {
      const [root, schemes] = [...strongRoots.entries()][0];
      target = root;
      method = 'STABLE_IDENTIFIER';
      report.candidates.push({ entityId: root, signals: { stableIdentifiers: schemes } });
    } else if (strongRoots.size > 1) {
      // Stable identifiers point at different entities: never pick one.
      status = 'AMBIGUOUS';
      for (const [root, schemes] of strongRoots) {
        report.candidates.push({ entityId: root, signals: { stableIdentifiers: schemes } });
        proposals.push({ target: root, method: 'STABLE_IDENTIFIER', reason: 'stable identifiers of this mention belong to several entities', signals: { stableIdentifiers: schemes } });
      }
    }

    // ── same provenance re-imported ──
    if (!target && status !== 'AMBIGUOUS' && mention.sourceRefId) {
      const typeList = types.map(() => '?').join(', ');
      const replay = store.prepare(`SELECT a.entity_id FROM kg_aliases a JOIN kg_entities e ON e.entity_id = a.entity_id
        WHERE a.source_ref_id = ? AND a.normalized_alias = ? AND a.alias_key = ? AND e.entity_type IN (${typeList}) ORDER BY a.created_at LIMIT 1`)
        .get(mention.sourceRefId, keys.loose, keys.label, ...types);
      if (replay) {
        const root = store.getLogicalRootId(replay.entity_id);
        const { conflict } = compareAttributes(context.attributes, attributesOf(store.getEntity(root)));
        // KG-5 fix: a mention whose strong identifier differs from every identifier the entity holds
        // for that scheme is another thing with the same label in the same source — no replay.
        const held = identifiersOfLogical(store, root);
        const identifierClash = validIds.some(id => identifierIsStrongFor(id.scheme, mention.type)
          && held.some(h => h.scheme === id.scheme) && !held.some(h => h.scheme === id.scheme && h.normalized_value === id.value));
        if (conflict.length === 0 && !identifierClash) {
          target = root;
          method = 'REIMPORT';
        }
      }
    }

    // ── same label / alias ──
    if (!target && status !== 'AMBIGUOUS') {
      const labelRoots = sameLabelRoots(store, keys.loose, types);
      for (const extra of mention.aliases ?? []) {
        const k = looseKey(extra);
        if (k) for (const [root, via] of sameLabelRoots(store, k, types)) if (!labelRoots.has(root)) labelRoots.set(root, via === 'label' ? 'alias' : via);
      }
      for (const root of weakIdentifierRoots) if (!labelRoots.has(root)) labelRoots.set(root, 'identifier');
      const relatedMention = new Set((context.relatedEntityIds ?? []).map(id => store.getLogicalRootId(id)).filter(Boolean));
      const evaluated = [];
      for (const [root, via] of [...labelRoots.entries()].slice(0, KG_DEFAULT_LIMITS.MAX_RESOLUTION_CANDIDATES)) {
        const entity = store.getEntity(root);
        const signals = { via, exactLabel: entity.label_key === keys.label, accentInsensitiveOnly: entity.label_key !== keys.label && entity.normalized_name === keys.loose };
        const corroborations = [];
        const contradictions = [];
        if (weakIdentifierRoots.has(root)) corroborations.push('shared_identifier');
        const related = relatedRootIds(store, root);
        const sharedRelated = [...relatedMention].filter(id => related.has(id));
        if (sharedRelated.length) corroborations.push(`shared_related_entities:${sharedRelated.length}`);
        const attrs = compareAttributes(context.attributes, attributesOf(entity));
        if (attrs.agree.length) corroborations.push(`attributes_agree:${attrs.agree.join(',')}`);
        if (attrs.conflict.length) contradictions.push(`attributes_conflict:${attrs.conflict.join(',')}`);
        const theirIds = identifiersOfLogical(store, root);
        for (const id of validIds) {
          if (!SINGLE_VALUED_SCHEMES.has(id.scheme)) continue;
          if (theirIds.some(t => t.scheme === id.scheme && t.normalized_value !== id.value)) contradictions.push(`identifier_differs:${id.scheme}`);
        }
        if (mention.sourceId && sourcesOfLogical(store, root).has(mention.sourceId)) corroborations.push('same_source');
        // KG-5 fix: the mention carries a strong identifier and the candidate holds that scheme with other values only:
        // never an automatic match (it may still be proposed — e.g. an organisation with several domains)
        const identifierMismatch = validIds.filter(id => identifierIsStrongFor(id.scheme, mention.type)
          && theirIds.some(t => t.scheme === id.scheme) && !theirIds.some(t => t.scheme === id.scheme && t.normalized_value === id.value)).map(id => id.scheme);
        evaluated.push({ entityId: root, signals: { ...signals, corroborations, contradictions, ...(identifierMismatch.length ? { identifierMismatch } : {}) } });
      }
      report.candidates.push(...evaluated);
      const viable = evaluated.filter(c => c.signals.contradictions.length === 0);
      const corroborated = viable.filter(c => c.signals.corroborations.length > 0 && !c.signals.identifierMismatch);
      if (corroborated.length === 1 && viable.length >= 1) {
        // exactly one candidate has positive evidence; the others (if any) have none
        target = corroborated[0].entityId;
        method = corroborated[0].signals.via === 'alias' ? 'ALIAS_CORROBORATED' : 'LABEL_CONTEXT';
        for (const other of viable.filter(c => c.entityId !== target)) {
          proposals.push({ target: other.entityId, method: 'SAME_LABEL_UNCORROBORATED', reason: 'same label, another entity was corroborated', signals: other.signals });
        }
      } else if (viable.length > 0) {
        status = 'AMBIGUOUS';
        for (const c of viable) {
          proposals.push({
            target: c.entityId,
            method: c.signals.corroborations.length > 0 ? (c.signals.via === 'alias' ? 'ALIAS_CORROBORATED' : 'LABEL_CONTEXT') : 'SAME_LABEL_UNCORROBORATED',
            reason: corroborated.length > 1 ? 'several entities are corroborated' : 'same label without corroborating evidence',
            signals: c.signals,
          });
        }
      }
      // candidates with contradictions are homonyms with evidence of difference: listed, never proposed
    }

    // ── create when nothing was matched ──
    let created = false;
    if (!target) {
      const provenance = mention.sourceRefId ?? mention.sourceId ?? null;
      let entityId = newEntityId(mention.type, keys, validIds, provenance);
      if (store.getEntity(entityId)) entityId = `ent_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
      store.upsertEntity({
        entity_id: entityId,
        entity_type: mention.type,
        name: label.trim(),
        description: mention.description ?? '',
        status,
        provenance_source_id: mention.sourceId ?? null,
        metadata: {
          original_label: label,
          ...(context.attributes ? { attributes: context.attributes } : {}),
          created_by: 'kg-resolution',
        },
      });
      target = entityId;
      created = true;
      // similarity: candidates only — never one already evaluated (a contradicted homonym stays out)
      const exclude = new Set([entityId, ...proposals.map(p => p.target), ...report.candidates.map(c => c.entityId)]);
      for (const root of similarRoots(store, keys, types, exclude)) {
        proposals.push({ target: root, method: 'SIMILARITY_CANDIDATE', reason: 'similar label (candidate only)', signals: { similar: true } });
        report.candidates.push({ entityId: root, signals: { similar: true } });
      }
    }

    // LLM suggestion: recorded, never applied
    if (mention.llmSuggestion?.entityId) {
      const suggested = store.getLogicalRootId(mention.llmSuggestion.entityId);
      const suggestedEntity = suggested ? store.getEntity(suggested) : null;
      if (suggestedEntity && suggested !== target && entityTypesCompatible(suggestedEntity.entity_type, mention.type)) {
        proposals.push({ target: suggested, method: 'LLM_CANDIDATE', reason: String(mention.llmSuggestion.reason ?? 'model suggestion').slice(0, 300), signals: { model: true } });
      }
    }

    // ── provenance on the resolved entity ──
    const aliasStatus = 'CONFIRMED';
    const aliasMeta = { resolution_method: created ? 'CREATED' : method };
    store.upsertAlias({ entity_id: target, alias: label.trim(), source_id: mention.sourceId ?? null, source_ref_id: mention.sourceRefId ?? null, status: aliasStatus, metadata: aliasMeta });
    for (const extra of mention.aliases ?? []) {
      if (looseKey(extra)) store.upsertAlias({ entity_id: target, alias: String(extra).trim(), source_id: mention.sourceId ?? null, source_ref_id: mention.sourceRefId ?? null, status: aliasStatus, metadata: aliasMeta });
    }
    for (const id of validIds) {
      const added = store.addIdentifier({ entity_id: target, scheme: id.scheme, value: id.original, source_id: mention.sourceId ?? null, source_ref_id: mention.sourceRefId ?? null });
      if (added.status === 'CONFLICT') report.identifierConflicts.push({ scheme: id.scheme, heldBy: added.conflictsWith, reason: 'identifier held by another entity' });
    }

    // ── proposals (ledger, PROPOSED only) ──
    for (const p of proposals) {
      if (p.target === target) continue;
      const already = store.prepare("SELECT resolution_id FROM kg_entity_resolutions WHERE source_entity_id = ? AND target_entity_id = ? AND decision = 'PROPOSED' AND method = ?")
        .get(target, p.target, p.method);
      if (already) { report.proposedResolutionIds.push(already.resolution_id); continue; }
      report.proposedResolutionIds.push(store.insertResolution({
        source_entity_id: target, target_entity_id: p.target, decision: 'PROPOSED', method: p.method,
        reason: p.reason, signals: p.signals, source_id: mention.sourceId ?? null, source_ref_id: mention.sourceRefId ?? null, actor: 'SYSTEM',
      }));
    }

    report.entityId = target;
    report.logicalEntityId = store.getLogicalRootId(target);
    report.method = created ? null : method;
    report.outcome = created ? (status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'CREATED') : (method === 'REIMPORT' ? 'REIMPORTED' : 'MATCHED_EXISTING');
    return report;
  });
}

/**
 * Explicit merge: `sourceEntityId` becomes a logical alias of `targetEntityId`.
 * Writes a CONFIRMED ledger row; deletes and rewrites nothing.
 */
export function mergeEntities(store, sourceEntityId, targetEntityId, { actor = 'USER', method = 'USER', reason = '', confidence = null, signals = {}, sourceId = null, sourceRefId = null, resolutionId = null } = {}) {
  if (actor === 'SYSTEM' && PROPOSAL_ONLY_METHODS.has(method)) {
    throw new KgError('KG_AUTO_MERGE_FORBIDDEN', `${method} can only be confirmed by the user`);
  }
  return store.transaction(() => {
    const source = store.getEntity(sourceEntityId);
    const targetRequested = store.getEntity(targetEntityId);
    if (!source || !targetRequested) throw new Error('both entities must exist');
    if (source.status === 'MERGED') throw new KgError('KG_ALREADY_MERGED', `${sourceEntityId} is already merged into ${source.merged_into_id}`);
    const targetRoot = store.getLogicalRootId(targetEntityId);
    if (targetRoot === sourceEntityId) throw new KgError('KG_MERGE_CYCLE', 'the target is already merged into the source');
    const target = store.getEntity(targetRoot);
    if (!entityTypesCompatible(source.entity_type, target.entity_type)) {
      throw new KgError('KG_INCOMPATIBLE_TYPES', `${source.entity_type} cannot be merged into ${target.entity_type}`);
    }
    const now = nowIso();
    let id = resolutionId;
    if (id) {
      store.prepare(`UPDATE kg_entity_resolutions SET decision = 'CONFIRMED', actor = ?, target_entity_id = ?, decided_at = ?,
          previous_status = ?, previous_merged_into_id = ?, reason = CASE WHEN ? <> '' THEN ? ELSE reason END
        WHERE resolution_id = ?`)
        .run(actor, targetRoot, now, source.status, source.merged_into_id ?? null, String(reason), String(reason).slice(0, 1000), id);
    } else {
      id = store.insertResolution({
        source_entity_id: sourceEntityId, target_entity_id: targetRoot, decision: 'CONFIRMED', method, reason, confidence, signals,
        source_id: sourceId, source_ref_id: sourceRefId, actor, previous_status: source.status, previous_merged_into_id: source.merged_into_id ?? null,
      });
    }
    store.prepare("UPDATE kg_entities SET status = 'MERGED', merged_into_id = ?, updated_at = ? WHERE entity_id = ?").run(targetRoot, now, sourceEntityId);
    return { resolutionId: id, sourceEntityId, targetEntityId: targetRoot };
  });
}

/** Confirms a PROPOSED resolution (user decision). */
export function confirmResolution(store, resolutionId, { actor = 'USER', reason = '' } = {}) {
  const r = store.getResolution(resolutionId);
  if (!r) throw new Error(`Resolution ${resolutionId} not found`);
  if (r.decision !== 'PROPOSED') throw new KgError('KG_RESOLUTION_NOT_PROPOSED', `resolution is ${r.decision}`);
  return mergeEntities(store, r.source_entity_id, r.target_entity_id, { actor, method: r.method, reason, resolutionId });
}

/** Rejects a PROPOSED resolution: the two entities are distinct. */
export function rejectResolution(store, resolutionId, { actor = 'USER', reason = '' } = {}) {
  return store.transaction(() => {
    const r = store.getResolution(resolutionId);
    if (!r) throw new Error(`Resolution ${resolutionId} not found`);
    if (r.decision !== 'PROPOSED') throw new KgError('KG_RESOLUTION_NOT_PROPOSED', `resolution is ${r.decision}`);
    store.prepare("UPDATE kg_entity_resolutions SET decision = 'REJECTED', actor = ?, decided_at = ?, reason = CASE WHEN ? <> '' THEN ? ELSE reason END WHERE resolution_id = ?")
      .run(actor, nowIso(), String(reason), String(reason).slice(0, 1000), resolutionId);
    // an AMBIGUOUS entity whose every candidate has been rejected is a distinct entity
    const source = store.getEntity(r.source_entity_id);
    const open = store.prepare("SELECT COUNT(*) AS n FROM kg_entity_resolutions WHERE source_entity_id = ? AND decision = 'PROPOSED' AND method NOT IN ('SIMILARITY_CANDIDATE', 'LLM_CANDIDATE')").get(r.source_entity_id).n;
    if (source.status === 'AMBIGUOUS' && open === 0) {
      store.prepare("UPDATE kg_entities SET status = 'ACTIVE', updated_at = ? WHERE entity_id = ?").run(nowIso(), r.source_entity_id);
    }
    return { resolutionId, decision: 'REJECTED' };
  });
}

/** Reverses a CONFIRMED resolution: the source entity gets its previous status and redirect back. */
export function reverseResolution(store, resolutionId, { actor = 'USER', reason = '' } = {}) {
  return store.transaction(() => {
    const r = store.getResolution(resolutionId);
    if (!r) throw new Error(`Resolution ${resolutionId} not found`);
    if (r.decision !== 'CONFIRMED') throw new KgError('KG_RESOLUTION_NOT_CONFIRMED', `resolution is ${r.decision}`);
    const source = store.getEntity(r.source_entity_id);
    if (source.merged_into_id !== r.target_entity_id) {
      throw new KgError('KG_RESOLUTION_STALE', 'the entity no longer points at this resolution target');
    }
    const now = nowIso();
    store.prepare('UPDATE kg_entities SET status = ?, merged_into_id = ?, updated_at = ? WHERE entity_id = ?')
      .run(r.previous_status && r.previous_status !== 'MERGED' ? r.previous_status : 'ACTIVE', r.previous_merged_into_id ?? null, now, r.source_entity_id);
    store.prepare("UPDATE kg_entity_resolutions SET decision = 'REVERSED', reversed_at = ?, reversal_reason = ?, actor = ? WHERE resolution_id = ?")
      .run(now, String(reason).slice(0, 1000), actor, resolutionId);
    return { resolutionId, decision: 'REVERSED', restoredEntityId: r.source_entity_id };
  });
}

export default { resolveEntityMention, mergeEntities, confirmResolution, rejectResolution, reverseResolution };
