// Knowledge Graph V1 — KG_PROD_POPULATION_MECH_1: trusted internal production population orchestrator.
//
// planKgPopulation  — read-only: counts of what a run would create / reuse / update / supersede / retire.
// runKgPopulation   — explicit, internal (no HTTP route): writes the structural seed through certified store primitives.
// undoKgPopulationRun — reverses exactly the provenance a run created (certified invalidation cascade), nothing else.
// listKgPopulationRuns — the bounded run ledger.
//
// Target: the canonical DB resolved exactly like activation (resolveKgProductionTarget: SQLITE_PATH rules only; no
// caller path). A run requires KG ACTIVE on schema 2.3.0. Source neurons are read through a read-only connection.
//
// No schema change. Run ledger = kg_metadata rows `population_run:<runId>` (ids + counts only) + the run id in each
// technical ref's bounded provenance (createdByRun). Writes only through KnowledgeGraphStore primitives:
// upsertSource / upsertSourceRef / invalidateSourceRef / upsertEntity / addIdentifier / upsertAlias / upsertRelationship.
// Entity identity is resolved by exact stable identifier only (findEntitiesByIdentifier) — never by label, so no fuzzy
// merge and no AMBIGUOUS homonym bookkeeping is ever written by population.
//
// Retirement follows the certified KG-7/KG-8 semantics: nothing is deleted; an invalidated technical ref takes its
// aliases' and relations' provenance with it, so an entity left with no ACTIVE provenance is no longer visible.
// Because the certified primitives never re-activate an invalidated ref or source, a rebuild after undo / deletion uses
// a new generation of the provenance keys (`<key>#g<n>`); entity identity (YouTube / playlist / neuron id) is unchanged,
// so no entity is ever duplicated.

import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { KnowledgeGraphStore } from './kg-store.js';
import { KG_SCHEMA_VERSION } from './kg-schema.js';
import { resolveKgProductionTarget, inspectKgTarget, KG_ACTIVE } from './kg-boot.js';
import { buildYoutubeLibraryPlan, YOUTUBE_ADAPTER_ID, YOUTUBE_ADAPTER_VERSION } from './kg-population-youtube.js';

export const KG_POPULATION_MECHANISM = 'kg-population';
export const KG_POPULATION_SOURCES = Object.freeze([YOUTUBE_ADAPTER_ID]);
/** Certified sources the orchestrator can plan but does not run in V1 (their sync refs carry no run attribution). */
export const KG_POPULATION_PLAN_ONLY_SOURCES = Object.freeze(['notebook_documents', 'article_neurons']);
const ADAPTER = 'neuron';
const LEDGER_PREFIX = 'population_run:';
const MAX_GENERATIONS = 1000;
const RUN_STATUSES = Object.freeze(['STARTED', 'COMPLETED', 'FAILED', 'UNDONE']);

class KgPopulationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new KgPopulationError(code); };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const entityIdFor = (identity) => `ent_${sha(`kg-population|${identity}`).slice(0, 24)}`;
const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

function onlyKeys(rest, allowed) {
  for (const k of Object.keys(rest)) if (!allowed.includes(k)) fail('KG_POPULATION_OPTION_NOT_ACCEPTED');
}

function resolveTarget(env, { requireActive }) {
  let target;
  try { target = resolveKgProductionTarget({ env }); } catch (error) { fail(error.code ?? 'KG_TARGET_INVALID'); }
  const state = inspectKgTarget(target);
  if (!state.ok) fail(state.reason);
  if (requireActive && state.activation !== KG_ACTIVE) fail('KG_NOT_ACTIVE');
  if (requireActive && state.schemaVersion !== KG_SCHEMA_VERSION) fail('KG_SCHEMA_MISMATCH');
  return { target, state };
}

/** Neurone pages through a READ-ONLY connection (never sqlite.js / initSqlite). */
function readPages(target) {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pages'").get()) fail('KG_POPULATION_SOURCE_MISSING');
    const out = [];
    for (const r of db.prepare('SELECT id, data FROM pages').iterate()) {
      try { out.push({ id: r.id, data: JSON.parse(r.data) }); } catch { /* unreadable page: skipped */ }
    }
    return out;
  } finally { db.close(); }
}

// ── provenance keys (generations) ──────────────────────────────────────────

/** The current logical source of `baseKey`: the first ACTIVE generation, else the first free key. */
function currentSourceKey(store, baseKey) {
  for (let g = 1; g <= MAX_GENERATIONS; g++) {
    const key = g === 1 ? baseKey : `${baseKey}#g${g}`;
    const s = store.findSourceByLogicalKey(key);
    if (!s) return { key, existing: null, generation: g };
    if (s.status === 'ACTIVE') return { key, existing: s, generation: g };
  }
  return fail('KG_POPULATION_GENERATION_LIMIT');
}

/** The ACTIVE ref of a neuron (if any) and the next free ref key. */
function neuronRefs(store, pageId) {
  let active = null;
  for (let g = 1; g <= MAX_GENERATIONS; g++) {
    const key = g === 1 ? pageId : `${pageId}#g${g}`;
    const r = store.findSourceRef(ADAPTER, key);
    if (!r) return { active, freeKey: key, freeGeneration: g };
    if (r.status === 'ACTIVE') {
      if (r.provenance?.mechanism !== KG_POPULATION_MECHANISM) fail('KG_POPULATION_FOREIGN_REF');
      active = r;
    }
  }
  return fail('KG_POPULATION_GENERATION_LIMIT');
}

// ── run ledger (kg_metadata; ids + counts only) ─────────────────────────────

function ledgerWrite(db, run) {
  const value = JSON.stringify(run);
  if (Buffer.byteLength(value) > 4096) fail('KG_POPULATION_LEDGER_TOO_LARGE');
  db.prepare(`INSERT INTO kg_metadata (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(LEDGER_PREFIX + run.runId, value, new Date().toISOString());
}
function ledgerRead(db, runId) {
  const row = db.prepare('SELECT value FROM kg_metadata WHERE key = ?').get(LEDGER_PREFIX + runId);
  return row ? JSON.parse(row.value) : null;
}
function ledgerAll(db) {
  return db.prepare("SELECT value FROM kg_metadata WHERE key LIKE 'population\\_run:%' ESCAPE '\\' ORDER BY key").all().map(r => JSON.parse(r.value));
}
const newRunId = () => `kgpop_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;

// ── write helpers (certified primitives only) ───────────────────────────────

function ensureSource(store, { baseKey, sourceType, name, uri, kind, counts }) {
  const cur = currentSourceKey(store, baseKey);
  if (cur.existing && cur.existing.name === name) return cur.existing.source_id;
  const r = store.upsertSource({
    source_type: sourceType, name, uri: uri ?? null, canonical_url: uri ?? null, logical_key: cur.key,
    privacy: 'STANDARD', egress_policy: 'local_only', trust_level: 'UNKNOWN', confidence: 0,
    metadata: { mechanism: KG_POPULATION_MECHANISM, adapter: YOUTUBE_ADAPTER_ID, kind, generation: cur.generation },
  });
  if (r.isNew) counts.sourcesCreated++; else counts.sourcesUpdated++;
  return r.id;
}

/** The ref of one neuron: reuse when the structure is unchanged, else a new generation (old one superseded). */
function ensureRef(store, { sourceId, pageId, kind, fp, observedAt, versionRef, runId, counts }) {
  const { active, freeKey, freeGeneration } = neuronRefs(store, pageId);
  if (active && active.source_id === sourceId && active.content_hash === fp) {
    if (active.version_ref !== (versionRef ?? null)) {
      store.upsertSourceRef({ source_id: sourceId, adapter: ADAPTER, source_ref: active.source_ref, version_ref: versionRef ?? null, content_hash: fp,
        provenance: { ...active.provenance, lastRun: runId }, privacy: active.privacy, egress_policy: active.egress_policy, observed_at: active.observed_at });
      counts.refsUpdated++;
    } else counts.refsReused++;
    return active.source_ref_id;
  }
  const created = store.upsertSourceRef({
    source_id: sourceId, adapter: ADAPTER, source_ref: freeKey, version_ref: versionRef ?? null, content_hash: fp,
    provenance: { mechanism: KG_POPULATION_MECHANISM, adapter: YOUTUBE_ADAPTER_ID, adapterVersion: YOUTUBE_ADAPTER_VERSION, kind, pageId, generation: freeGeneration, createdByRun: runId, derivation: 'SYSTEM_METADATA', module: 'neurone.pages' },
    privacy: 'STANDARD', egress_policy: 'local_only', observed_at: observedAt ?? undefined,
  });
  counts.refsCreated++;
  if (active) { store.invalidateSourceRef(active.source_ref_id, { reason: `superseded by population run ${runId}` }); counts.refsSuperseded++; }
  return created.id;
}

/** Entity by exact stable identifier only; created with a deterministic id; renamed to the current label (old label stays an alias). */
function ensureEntity(store, { identity, type, label, sourceId, sourceRefId, kind, counts }) {
  const roots = [...new Set(store.findEntitiesByIdentifier('external', identity).map(h => h.logical_root_id))];
  if (roots.length > 1) fail('KG_POPULATION_IDENTITY_AMBIGUOUS');
  const entityId = roots[0] ?? entityIdFor(identity);
  const existing = store.getEntity(entityId);
  if (existing && existing.entity_type !== type) fail('KG_POPULATION_TYPE_CONFLICT');
  if (!existing) {
    store.upsertEntity({ entity_id: entityId, entity_type: type, name: label, status: 'ACTIVE', provenance_source_id: sourceId, trust_level: 'UNKNOWN', confidence: 0,
      metadata: { created_by: KG_POPULATION_MECHANISM, adapter: YOUTUBE_ADAPTER_ID, kind } });
    counts.entitiesCreated++;
  } else if (existing.name !== label) {
    store.upsertEntity({ entity_id: entityId, entity_type: type, name: label, description: existing.description, canonical_id: existing.canonical_id,
      is_active: existing.is_active, is_verified: existing.is_verified, trust_level: existing.trust_level, confidence: existing.confidence, metadata: existing.metadata });
    counts.entitiesRenamed++;
  }
  if (store.addIdentifier({ entity_id: entityId, scheme: 'external', value: identity, source_id: sourceId, source_ref_id: sourceRefId }).isNew) counts.identifiersCreated++;
  return entityId;
}

function ensureAlias(store, { entityId, label, sourceId, sourceRefId, counts }) {
  // already asserted through this ref: zero write (upsertAlias would otherwise rewrite updated_at)
  if (store.prepare("SELECT 1 FROM kg_aliases WHERE entity_id = ? AND source_ref_id = ? AND alias = ? AND status IN ('CONFIRMED', 'PROPOSED')").get(entityId, sourceRefId, label)) return;
  if (store.upsertAlias({ entity_id: entityId, alias: label, source_id: sourceId, source_ref_id: sourceRefId, status: 'CONFIRMED', metadata: { mechanism: KG_POPULATION_MECHANISM } }).isNew) counts.aliasesCreated++;
}

/** video MEMBER_OF target, provenance = the video neuron's ref. Zero write when already asserted through that ref. */
function ensureMembership(store, { videoEntityId, targetEntityId, sourceRefId, basis, counts }) {
  const relId = store.prepare("SELECT relationship_id FROM kg_relationships WHERE source_entity_id = ? AND target_entity_id = ? AND relationship_type = 'MEMBER_OF'").get(videoEntityId, targetEntityId)?.relationship_id;
  if (relId) {
    const p = store.prepare('SELECT status FROM kg_relationship_provenance WHERE relationship_id = ? AND source_ref_id = ?').get(relId, sourceRefId);
    if (p?.status === 'ACTIVE') { counts.membershipProvenanceReused++; return; }
  }
  const r = store.upsertRelationship({ source_entity_id: videoEntityId, target_entity_id: targetEntityId, relationship_type: 'MEMBER_OF', source_ref_id: sourceRefId,
    trust_level: 'UNKNOWN', confidence: 0, metadata: { mechanism: KG_POPULATION_MECHANISM, basis } });
  if (r.isNew) counts.relationshipsCreated++;
  counts.membershipProvenanceAsserted++;
}

// ── plan (read-only) ────────────────────────────────────────────────────────

/** Read-only dry run. Counts only — no label, title or page content is returned. */
export function planKgPopulation({ env = process.env, source = YOUTUBE_ADAPTER_ID, ...rest } = {}) {
  onlyKeys(rest, []);
  const { target, state } = resolveTarget(env, { requireActive: false });
  const pages = readPages(target);
  if (KG_POPULATION_PLAN_ONLY_SOURCES.includes(source)) return planCertifiedSource(target, pages, source, state);
  if (source !== YOUTUBE_ADAPTER_ID) fail('KG_POPULATION_SOURCE_UNSUPPORTED');
  const plan = buildYoutubeLibraryPlan(pages);
  const planned = { inserts: { entities: 0, sources: 0, refs: 0, aliases: 0, relationships: 0 }, updates: { entityRenames: 0, refVersions: 0 }, supersessions: 0, retirements: 0, reusedRefs: 0 };
  if (state.schemaVersion === KG_SCHEMA_VERSION) {
    const store = new KnowledgeGraphStore(target, { readOnly: true }).open();
    try { diffAgainstKg(store, plan, planned); } finally { store.close(); }
  } else {
    planned.inserts.entities = plan.videos.size + plan.collections.size + plan.playlists.size;
    planned.inserts.sources = planned.inserts.entities;
    planned.inserts.refs = plan.sourceNeurons.length + plan.collections.size + plan.counts.playlistNeurons;
    planned.inserts.aliases = planned.inserts.refs;
    planned.inserts.relationships = plan.counts.collectionMemberships + plan.counts.playlistMemberships;
  }
  return { ok: true, source, kgActivation: state.activation, kgSchema: state.schemaVersion, counts: plan.counts, skipped: plan.skipped, planned,
    provenanceRows: plan.sourceNeurons.length + plan.collections.size + plan.counts.playlistNeurons, factualClaims: 0 };
}

function diffAgainstKg(store, plan, planned) {
  const refState = (pageId, fp, sourceKey, label = null) => {
    const { active } = neuronRefs(store, pageId);
    if (!active) return 'create';
    const cur = currentSourceKey(store, sourceKey);
    if (!cur.existing || active.source_id !== cur.existing.source_id || active.content_hash !== fp) return 'supersede';
    if (label !== null && !store.prepare('SELECT 1 FROM kg_aliases WHERE source_ref_id = ? AND alias = ?').get(active.source_ref_id, label)) planned.inserts.aliases++;
    return 'reuse';
  };
  const entityExists = (identity) => store.findEntitiesByIdentifier('external', identity).length > 0;
  const count = (state) => { if (state === 'create') planned.inserts.refs++; else if (state === 'supersede') { planned.inserts.refs++; planned.supersessions++; } else planned.reusedRefs++; };
  for (const c of plan.collections.values()) {
    const id = `docteur:neuron:${c.pageId}`;
    if (!entityExists(id)) planned.inserts.entities++;
    if (!currentSourceKey(store, id).existing) planned.inserts.sources++;
    const s = refState(c.pageId, collectionFp(c.pageId), id, c.label);
    count(s);
    if (s !== 'reuse') planned.inserts.aliases++;
  }
  for (const p of plan.playlists.values()) {
    const id = `youtube:playlist:${p.playlistId}`;
    if (!entityExists(id)) planned.inserts.entities++;
    if (!currentSourceKey(store, id).existing) planned.inserts.sources++;
    for (const n of p.neurons) {
      const s = refState(n.pageId, playlistFp(p.playlistId, n.pageId), id, n.label);
      count(s);
      if (s !== 'reuse') planned.inserts.aliases++;
    }
  }
  for (const v of plan.videos.values()) {
    const id = `youtube:video:${v.videoId}`;
    const holders = store.findEntitiesByIdentifier('external', id);
    if (!holders.length) planned.inserts.entities++;
    else if (holders[0].name !== v.label) planned.updates.entityRenames++;
    if (!currentSourceKey(store, id).existing) planned.inserts.sources++;
    for (const n of v.neurons) {
      const s = refState(n.pageId, n.fp, id, n.label);
      count(s);
      if (s !== 'reuse') planned.inserts.aliases++;
      else if (neuronRefs(store, n.pageId).active?.version_ref !== (n.versionRef ?? null)) planned.updates.refVersions++;
    }
  }
  const eligible = eligiblePageIds(plan);
  planned.retirements = store.prepare(`SELECT json_extract(provenance, '$.pageId') AS pageId FROM kg_source_refs WHERE adapter = ? AND status = 'ACTIVE' AND json_extract(provenance, '$.mechanism') = ?`)
    .all(ADAPTER, KG_POPULATION_MECHANISM).filter(r => !eligible.has(r.pageId)).length;
  const rels = new Set([...plan.sourceNeurons].flatMap(n => [n.collectionPageId ? `c|${n.videoId}|${n.collectionPageId}` : null, n.playlistId ? `p|${n.videoId}|${n.playlistId}` : null]).filter(Boolean));
  for (const k of rels) {
    const [t, vid, target] = k.split('|');
    const vE = store.findEntitiesByIdentifier('external', `youtube:video:${vid}`)[0]?.logical_root_id;
    const tE = store.findEntitiesByIdentifier('external', t === 'c' ? `docteur:neuron:${target}` : `youtube:playlist:${target}`)[0]?.logical_root_id;
    if (!vE || !tE || !store.prepare("SELECT 1 FROM kg_relationships WHERE source_entity_id = ? AND target_entity_id = ? AND relationship_type = 'MEMBER_OF'").get(vE, tE)) planned.inserts.relationships++;
  }
}

function planCertifiedSource(target, pages, source, state) {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try {
    const has = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    const eligible = source === 'notebook_documents'
      ? (has('nb_documents') ? db.prepare("SELECT COUNT(*) AS n FROM nb_documents WHERE status = 'READY'").get().n : 0)
      : pages.filter(p => p.data?.metadata?.canonical_article).length;
    return { ok: true, source, kgActivation: state.activation, kgSchema: state.schemaVersion, runnable: false, reason: 'KG_POPULATION_SOURCE_NOT_ENABLED_V1', eligibleRecords: eligible };
  } finally { db.close(); }
}

const collectionFp = (pageId) => sha(JSON.stringify(['collection', YOUTUBE_ADAPTER_VERSION, pageId])).slice(0, 32);
const playlistFp = (playlistId, pageId) => sha(JSON.stringify(['playlist', YOUTUBE_ADAPTER_VERSION, playlistId, pageId])).slice(0, 32);
const eligiblePageIds = (plan) => new Set([
  ...plan.sourceNeurons.map(n => n.pageId), ...plan.collections.keys(), ...[...plan.playlists.values()].flatMap(p => p.neurons.map(n => n.pageId)),
]);

// ── run ─────────────────────────────────────────────────────────────────────

const emptyCounts = () => ({
  sourcesCreated: 0, sourcesUpdated: 0, refsCreated: 0, refsReused: 0, refsUpdated: 0, refsSuperseded: 0, refsRetired: 0,
  entitiesCreated: 0, entitiesRenamed: 0, identifiersCreated: 0, aliasesCreated: 0,
  relationshipsCreated: 0, membershipProvenanceAsserted: 0, membershipProvenanceReused: 0, itemsProcessed: 0, itemsSkipped: 0,
});

/**
 * Explicit, trusted, internal production population (no route). `onItem` (tests only) is called before each item's
 * transaction with { phase, index } and never receives the store; throwing simulates a mid-run failure.
 */
export async function runKgPopulation({ env = process.env, source = YOUTUBE_ADAPTER_ID, onItem = undefined, ...rest } = {}) {
  onlyKeys(rest, []);
  if (onItem !== undefined && typeof onItem !== 'function') fail('KG_POPULATION_OPTION_NOT_ACCEPTED');
  if (KG_POPULATION_PLAN_ONLY_SOURCES.includes(source)) fail('KG_POPULATION_SOURCE_NOT_ENABLED_V1');
  if (source !== YOUTUBE_ADAPTER_ID) fail('KG_POPULATION_SOURCE_UNSUPPORTED');
  const { target } = resolveTarget(env, { requireActive: true });
  const plan = buildYoutubeLibraryPlan(readPages(target));
  const store = new KnowledgeGraphStore(target, { production: true });
  await store.initialize(); // schema 2.3.0 already current: nothing migrates
  const runId = newRunId();
  const counts = emptyCounts();
  const run = { runId, adapter: YOUTUBE_ADAPTER_ID, adapterVersion: YOUTUBE_ADAPTER_VERSION, mechanism: KG_POPULATION_MECHANISM, status: 'STARTED',
    startedAt: new Date().toISOString(), scope: { kinds: ['video', 'channel', 'playlist'], plannedVideos: plan.videos.size, plannedNeurons: plan.sourceNeurons.length } };
  try {
    if (ledgerAll(store.db).some(r => r.status === 'STARTED')) fail('KG_POPULATION_RUN_IN_PROGRESS');
    ledgerWrite(store.db, run);
    const step = (phase, index) => { if (onItem) onItem({ phase, index }); };
    const collectionEntity = new Map();
    let i = 0;
    for (const c of plan.collections.values()) {
      step('collection', i++);
      store.transaction(() => {
        const identity = `docteur:neuron:${c.pageId}`;
        const sourceId = ensureSource(store, { baseKey: identity, sourceType: 'INTERNAL', name: c.label, kind: 'collection', counts });
        const refId = ensureRef(store, { sourceId, pageId: c.pageId, kind: 'collection', fp: collectionFp(c.pageId), observedAt: c.observedAt, versionRef: c.versionRef, runId, counts });
        const entityId = ensureEntity(store, { identity, type: 'ARTEFACT', label: c.label, sourceId, sourceRefId: refId, kind: 'collection', counts });
        ensureAlias(store, { entityId, label: c.label, sourceId, sourceRefId: refId, counts });
        collectionEntity.set(c.pageId, entityId);
      });
      counts.itemsProcessed++;
    }
    const playlistEntity = new Map();
    i = 0;
    for (const p of plan.playlists.values()) {
      step('playlist', i++);
      store.transaction(() => {
        const identity = `youtube:playlist:${p.playlistId}`;
        const label = p.neurons[0].label;
        const sourceId = ensureSource(store, { baseKey: identity, sourceType: 'INTERNAL', name: label, kind: 'playlist', counts });
        let entityId = null;
        for (const n of p.neurons) {
          const refId = ensureRef(store, { sourceId, pageId: n.pageId, kind: 'playlist', fp: playlistFp(p.playlistId, n.pageId), observedAt: n.observedAt, versionRef: n.versionRef, runId, counts });
          entityId ??= ensureEntity(store, { identity, type: 'ARTEFACT', label, sourceId, sourceRefId: refId, kind: 'playlist', counts });
          ensureAlias(store, { entityId, label: n.label, sourceId, sourceRefId: refId, counts });
        }
        playlistEntity.set(p.playlistId, entityId);
      });
      counts.itemsProcessed++;
    }
    i = 0;
    for (const v of plan.videos.values()) {
      step('video', i++);
      store.transaction(() => {
        const identity = `youtube:video:${v.videoId}`;
        const sourceId = ensureSource(store, { baseKey: identity, sourceType: 'VIDEO', name: v.label, uri: watchUrl(v.videoId), kind: 'video', counts });
        const refs = v.neurons.map(n => ({ n, refId: ensureRef(store, { sourceId, pageId: n.pageId, kind: 'video', fp: n.fp, observedAt: n.observedAt, versionRef: n.versionRef, runId, counts }) }));
        const entityId = ensureEntity(store, { identity, type: 'DOCUMENT', label: v.label, sourceId, sourceRefId: refs[0].refId, kind: 'video', counts });
        for (const { n, refId } of refs) {
          ensureAlias(store, { entityId, label: n.label, sourceId, sourceRefId: refId, counts });
          // channelId → LOCAL COLLECTION MEMBERSHIP only (never publisher / creator / uploader)
          if (n.collectionPageId && collectionEntity.has(n.collectionPageId)) ensureMembership(store, { videoEntityId: entityId, targetEntityId: collectionEntity.get(n.collectionPageId), sourceRefId: refId, basis: 'docteur_collection_membership', counts });
          if (n.playlistId && playlistEntity.has(n.playlistId)) ensureMembership(store, { videoEntityId: entityId, targetEntityId: playlistEntity.get(n.playlistId), sourceRefId: refId, basis: 'youtube_playlist_membership', counts });
        }
      });
      counts.itemsProcessed++;
    }
    // neurons gone from the library (deleted, made private, no longer referenced): their provenance is retired
    step('retire', 0);
    const eligible = eligiblePageIds(plan);
    for (const r of store.prepare(`SELECT source_ref_id, json_extract(provenance, '$.pageId') AS pageId FROM kg_source_refs WHERE adapter = ? AND status = 'ACTIVE' AND json_extract(provenance, '$.mechanism') = ?`).all(ADAPTER, KG_POPULATION_MECHANISM)) {
      if (eligible.has(r.pageId)) continue;
      store.invalidateSourceRef(r.source_ref_id, { reason: `source neuron no longer in the library (run ${runId})` });
      counts.refsRetired++;
    }
    Object.assign(run, { status: 'COMPLETED', completedAt: new Date().toISOString(), counts, skipped: plan.skipped });
    ledgerWrite(store.db, run);
    return { ok: true, runId, status: run.status, counts, skipped: plan.skipped };
  } catch (error) {
    const code = error instanceof KgPopulationError ? error.code : 'KG_POPULATION_FAILED';
    if (run.status === 'STARTED' && code !== 'KG_POPULATION_RUN_IN_PROGRESS') {
      Object.assign(run, { status: 'FAILED', failedAt: new Date().toISOString(), error: code, counts, skipped: plan.skipped });
      try { ledgerWrite(store.db, run); } catch { /* the ledger write is best effort after a failure */ }
    }
    return { ok: false, runId: code === 'KG_POPULATION_RUN_IN_PROGRESS' ? null : runId, status: code === 'KG_POPULATION_RUN_IN_PROGRESS' ? null : 'FAILED', reason: code, counts };
  } finally {
    store.close();
  }
}

// ── undo ────────────────────────────────────────────────────────────────────

/**
 * Reverses exactly the technical provenance created by `runId` through the certified invalidation cascade
 * (aliases / relation provenance / evidence of those refs). Provenance created by other runs is untouched; shared
 * entities stay visible through it. Nothing is deleted; the whole DB is never restored.
 */
export async function undoKgPopulationRun({ env = process.env, runId, ...rest } = {}) {
  onlyKeys(rest, []);
  if (typeof runId !== 'string' || !/^kgpop_\d{14}_[0-9a-f]{8}$/.test(runId)) fail('KG_POPULATION_RUN_ID_INVALID');
  const { target } = resolveTarget(env, { requireActive: true });
  const store = new KnowledgeGraphStore(target, { production: true });
  await store.initialize();
  try {
    const run = ledgerRead(store.db, runId);
    if (!run) fail('KG_POPULATION_RUN_UNKNOWN');
    if (run.status === 'UNDONE') return { ok: true, runId, status: 'UNDONE', refsInvalidated: 0, alreadyUndone: true };
    const refs = store.prepare(`SELECT source_ref_id FROM kg_source_refs WHERE adapter = ? AND status = 'ACTIVE' AND json_extract(provenance, '$.mechanism') = ? AND json_extract(provenance, '$.createdByRun') = ?`)
      .all(ADAPTER, KG_POPULATION_MECHANISM, runId);
    for (const r of refs) store.invalidateSourceRef(r.source_ref_id, { reason: `population run ${runId} undone` });
    Object.assign(run, { status: 'UNDONE', undoneAt: new Date().toISOString(), previousStatus: run.status, refsInvalidated: refs.length });
    ledgerWrite(store.db, run);
    return { ok: true, runId, status: 'UNDONE', refsInvalidated: refs.length };
  } finally {
    store.close();
  }
}

/** The bounded run ledger (ids, statuses, counts). Read-only. */
export function listKgPopulationRuns({ env = process.env, ...rest } = {}) {
  onlyKeys(rest, []);
  const { target } = resolveTarget(env, { requireActive: false });
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'kg_metadata'").get()) return [];
    return ledgerAll(db).filter(r => RUN_STATUSES.includes(r.status));
  } finally { db.close(); }
}

export default { planKgPopulation, runKgPopulation, undoKgPopulationRun, listKgPopulationRuns, KG_POPULATION_SOURCES, KG_POPULATION_PLAN_ONLY_SOURCES, KG_POPULATION_MECHANISM };
