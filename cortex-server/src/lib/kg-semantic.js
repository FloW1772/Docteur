// Knowledge Graph V1 — KG-5 semantic layer (derived, optional, local only).
//
// Reuses Docteur's existing vector engine (LanceDB, @lancedb/lancedb) in a
// dedicated, DERIVED table `kg_semantic` (entity and claim texts). It is not a
// second engine and never touches the Notebook / neuron tables: lancedb.js keeps
// one module-wide connection, so this layer opens its own connection to the path
// it is given. The table can be dropped and rebuilt from the KG at any time.
//
// Embeddings come from an injected embedder that MUST declare provider 'local'
// (Strict Local). No embedder, a failing embedder, a non-local provider or a
// missing index never breaks retrieval: the layer reports UNAVAILABLE /
// DEGRADED and the caller continues with exact + FTS + graph signals. There is
// no cloud fallback anywhere in this module.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { connect } from '@lancedb/lancedb';

export const KG_SEMANTIC_TABLE = 'kg_semantic';
export const SEMANTIC_STATES = ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE'];
const MAX_ITEMS = 50_000;
const BATCH = 32;
const MAX_TEXT = 2000;

const textHash = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 32);
const unit = (v) => {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
};

/**
 * Wraps a local embedding function. `embedOne(text) → number[]`.
 * The provider is declared by the caller; only 'local' is ever accepted.
 */
export function createLocalEmbedder({ embedOne, model, provider = 'local' }) {
  return {
    model: String(model ?? 'unknown'),
    provider,
    async embed(texts) {
      const vectors = [];
      for (const t of texts) vectors.push(await embedOne(t));
      return { vectors, provider, model: String(model ?? 'unknown') };
    },
  };
}

/** Docteur's own Ollama embedding call (ollama.js embedText), declared local. Not wired at boot. */
export function createOllamaEmbedder({ client, model, embedText }) {
  return createLocalEmbedder({ embedOne: (t) => embedText(client, model, t), model, provider: 'local' });
}

/** Text of an entity / claim for the semantic index (bounded, deterministic). */
export function semanticItems(store, { limit = MAX_ITEMS } = {}) {
  const items = [];
  const aliasRows = store.db.prepare("SELECT entity_id, alias FROM kg_aliases WHERE status IN ('CONFIRMED', 'PROPOSED') ORDER BY entity_id, alias");
  const aliases = new Map();
  for (const r of aliasRows.iterate()) {
    const list = aliases.get(r.entity_id) ?? [];
    if (list.length < 20 && !list.includes(r.alias)) list.push(r.alias);
    aliases.set(r.entity_id, list);
  }
  for (const e of store.db.prepare("SELECT entity_id, entity_type, name, description FROM kg_entities WHERE status IN ('ACTIVE', 'AMBIGUOUS') ORDER BY entity_id").iterate()) {
    if (items.length >= limit) break;
    const text = [e.name, ...(aliases.get(e.entity_id) ?? []).filter(a => a !== e.name), e.description || ''].filter(Boolean).join(' · ').slice(0, MAX_TEXT);
    items.push({ id: e.entity_id, item_type: 'entity', text });
  }
  for (const c of store.db.prepare("SELECT claim_id, statement FROM kg_claims WHERE status NOT IN ('INVALIDATED', 'SUPERSEDED') ORDER BY claim_id").iterate()) {
    if (items.length >= limit) break;
    items.push({ id: c.claim_id, item_type: 'claim', text: String(c.statement).slice(0, MAX_TEXT) });
  }
  return items;
}

export class KgSemanticIndex {
  constructor({ lancedbPath = null, embedder = null } = {}) {
    this.lancedbPath = lancedbPath;
    this.embedder = embedder;
    this.db = null;
    this.probe = null;
    this.lastError = null;
  }

  /** AVAILABLE | DEGRADED | UNAVAILABLE with a reason; never throws. */
  async status() {
    if (!this.embedder) return { state: 'UNAVAILABLE', reason: 'NO_LOCAL_EMBEDDER' };
    if (this.embedder.provider !== 'local') return { state: 'UNAVAILABLE', reason: 'STRICT_LOCAL_PROVIDER_REFUSED' };
    if (!this.lancedbPath) return { state: 'UNAVAILABLE', reason: 'NO_VECTOR_STORE' };
    if (!this.probe) {
      this.probe = (async () => {
        try {
          const r = await this.embedder.embed(['kg semantic probe']);
          if (r?.provider !== 'local') return { state: 'UNAVAILABLE', reason: 'STRICT_LOCAL_PROVIDER_REFUSED' };
          const v = r?.vectors?.[0];
          if (!Array.isArray(v) || v.length === 0 || !v.every(Number.isFinite)) return { state: 'UNAVAILABLE', reason: 'EMBEDDER_INVALID_OUTPUT' };
          return { state: 'AVAILABLE', dim: v.length };
        } catch (error) {
          this.lastError = error.message;
          return { state: 'UNAVAILABLE', reason: 'EMBEDDER_FAILED' };
        }
      })();
    }
    const probe = await this.probe;
    if (probe.state !== 'AVAILABLE') return probe;
    const table = await this.openTable();
    if (!table) return { state: 'DEGRADED', reason: 'INDEX_MISSING', dim: probe.dim };
    return { state: 'AVAILABLE', dim: probe.dim, model: this.embedder.model };
  }

  async connection() {
    if (!this.db) {
      fs.mkdirSync(path.dirname(path.resolve(this.lancedbPath)), { recursive: true });
      this.db = await connect(path.resolve(this.lancedbPath));
    }
    return this.db;
  }

  async openTable() {
    try {
      const db = await this.connection();
      const names = await db.tableNames();
      return names.includes(KG_SEMANTIC_TABLE) ? await db.openTable(KG_SEMANTIC_TABLE) : null;
    } catch (error) {
      this.lastError = error.message;
      return null;
    }
  }

  async embedChecked(texts) {
    const r = await this.embedder.embed(texts);
    if (r?.provider !== 'local') throw Object.assign(new Error('non-local embedding provider refused'), { code: 'STRICT_LOCAL_PROVIDER_REFUSED' });
    if (!Array.isArray(r.vectors) || r.vectors.length !== texts.length) throw Object.assign(new Error('embedder returned a wrong number of vectors'), { code: 'EMBEDDER_INVALID_OUTPUT' });
    return r.vectors.map(unit);
  }

  /** Rebuilds the derived table from the KG (drop + create). */
  async rebuild(store, { limit = MAX_ITEMS } = {}) {
    const status = await this.status();
    if (status.state === 'UNAVAILABLE') return { ok: false, ...status, indexed: 0 };
    const items = semanticItems(store, { limit });
    const rows = [];
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      const vectors = await this.embedChecked(batch.map(b => b.text));
      batch.forEach((b, k) => rows.push({ id: b.id, item_type: b.item_type, text_hash: textHash(b.text), model: this.embedder.model, vector: vectors[k] }));
    }
    const db = await this.connection();
    if ((await db.tableNames()).includes(KG_SEMANTIC_TABLE)) await db.dropTable(KG_SEMANTIC_TABLE);
    if (rows.length > 0) await db.createTable(KG_SEMANTIC_TABLE, rows);
    return { ok: true, state: rows.length > 0 ? 'AVAILABLE' : 'DEGRADED', indexed: rows.length, model: this.embedder.model };
  }

  /**
   * Nearest entities / claims. Returns { state, reason?, results: [{ id, itemType, similarity }] };
   * never throws (runtime failure → UNAVAILABLE, missing index → DEGRADED).
   */
  async search(query, { limit = 20 } = {}) {
    const status = await this.status();
    if (status.state !== 'AVAILABLE') return { ...status, results: [] };
    try {
      const [vector] = await this.embedChecked([String(query).slice(0, MAX_TEXT)]);
      const table = await this.openTable();
      if (!table) return { state: 'DEGRADED', reason: 'INDEX_MISSING', results: [] };
      const rows = await table.search(vector).distanceType('cosine').limit(Math.min(limit, 200)).toArray();
      return {
        state: 'AVAILABLE',
        results: rows.map(r => ({ id: r.id, itemType: r.item_type, similarity: Number.isFinite(r._distance) ? Math.max(0, Math.min(1, 1 - r._distance)) : 0 })),
      };
    } catch (error) {
      this.lastError = error.message;
      return { state: 'UNAVAILABLE', reason: error.code ?? 'SEMANTIC_RUNTIME_FAILED', results: [] };
    }
  }

  async close() {
    try { this.db?.close?.(); } catch { /* already closed */ }
    this.db = null;
  }
}
