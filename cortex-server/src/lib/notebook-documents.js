// Notebook NB-2/NB-3 — document service: import pipeline, versioning, hybrid
// retrieval (SQLite FTS5 + LanceDB vectors), citations, contradictions,
// retention, reindex, deletion.
//
// STRICT LOCAL: the only network-capable dependencies are the injected
// `embedText` / `localComplete` (Ollama on loopback in production). This
// module imports no cloud provider, no executor (shell, Omega, Rassilon,
// Device Fabric, browser automation) and performs no fetch itself.
// Retrieval output is information + citations only.

import crypto from 'node:crypto';
import { addNotebookSource, removeNotebookSource, listNotebookSources } from './sqlite.js';
import { recomputeAndPersistNotebookPrivacy } from './notebook.js';
import { upsertChunkVectors, searchChunkVectors, deleteChunkVectors } from './lancedb.js';
import { chunkSections, sha256 } from './notebook-chunker.js';
import {
  NotebookImportError, parseDocument, validateFormat, resolveLimits, readFileFromAllowedRoot, guessLanguage, safeFilename,
} from './notebook-parsers.js';
import {
  scanSecrets, redactDocumentSecrets, detectInjection, buildCitationPack, buildDocumentMessages, assertionTypeFor,
} from './notebook-security.js';
import * as store from './notebook-docs-store.js';
import {
  resolveRetrievalConfig, RETRIEVAL_PROFILES, gateFtsHits, gateVectorHits, fuseRanked, selectDiverse, applyContextBudget, confidenceLevel,
} from './notebook-retrieval.js';
import { detectConflicts } from './notebook-conflicts.js';
import { RETENTION_POLICIES, parseRetentionDuration } from './notebook-retention.js';

export const IMPORT_STATUSES = Object.freeze(['QUEUED', 'SCANNING', 'PARSING', 'CHUNKING', 'INDEXING', 'READY', 'FAILED', 'SECURITY_BLOCKED']);
export const TRUST_LEVELS = store.TRUST_LEVELS;
export const TRUSTED_LEVELS = Object.freeze(['USER_AUTHORED', 'PRIMARY_SOURCE', 'VERIFIED_EXTERNAL']);
export const TRUST_FILTERS = Object.freeze(['all', 'trusted', 'user_authored']);

// Embedding text format. nomic-embed-text is trained with task prefixes; the
// chosen format is versioned and stored with every vector so a change can
// never silently mix incompatible vectors (calibration: NB-3 report §2).
export const EMBED_FORMATS = Object.freeze({
  'nomic-embed-text': { version: 'nomic-prefix-v1', docPrefix: 'search_document: ', queryPrefix: 'search_query: ' },
});
export const RAW_EMBED_FORMAT = Object.freeze({ version: 'raw-v0', docPrefix: '', queryPrefix: '' });

export function resolveEmbedFormat(model, override) {
  if (override) return { ...RAW_EMBED_FORMAT, ...override };
  const key = Object.keys(EMBED_FORMATS).find(k => String(model ?? '').startsWith(k));
  return key ? EMBED_FORMATS[key] : RAW_EMBED_FORMAT;
}

class Limiter {
  constructor(max, maxQueue) { this.max = max; this.maxQueue = maxQueue; this.active = 0; this.queue = []; }
  get size() { return this.queue.length; }
  run(fn) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxQueue) { reject(new NotebookImportError('QUEUE_FULL', 'File d\'import pleine, réessaie plus tard')); return; }
      this.queue.push({ fn, resolve, reject });
      this.#pump();
    });
  }
  #pump() {
    while (this.active < this.max && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { this.active--; this.#pump(); });
    }
  }
}

function defaultVectorStore(lancedbPath) {
  return {
    upsert: (rows) => upsertChunkVectors(lancedbPath, rows),
    search: (vector, opts) => searchChunkVectors(lancedbPath, vector, opts),
    delete: (scope) => deleteChunkVectors(lancedbPath, scope),
  };
}

// deps: { embedText(text) → number[], localComplete(messages), embeddingModel, embeddingProvider?, embedFormat?,
//         lancedbPath, vectorStore?, logger?, limits?, allowedRoots?, maxConcurrent?, maxQueue?,
//         retrieval? (config overrides), chunkConfig?, sessionId?, retentionSweepMs?, now? }
export function createNotebookDocumentService(deps) {
  const limits = resolveLimits(deps.limits);
  const provider = deps.embeddingProvider ?? 'ollama';
  const model = deps.embeddingModel;
  const embedFormat = resolveEmbedFormat(model, deps.embedFormat);
  const baseRetrieval = resolveRetrievalConfig(deps.retrieval);
  const vectorStore = deps.vectorStore ?? defaultVectorStore(deps.lancedbPath);
  const sessionId = deps.sessionId ?? crypto.randomUUID();
  const clock = deps.now ?? (() => Date.now());
  const limiter = new Limiter(deps.maxConcurrent ?? 2, deps.maxQueue ?? 50);
  const aborts = new Map(); // documentId → AbortController
  const log = (level, obj, msg) => { try { deps.logger?.[level]?.(obj, msg); } catch { /* ignore */ } };
  const nowIso = () => new Date(clock()).toISOString();
  const vis = () => ({ sessionId, nowIso: nowIso() });

  store.ensureNotebookDocsSchema();

  // vectorStatusCounts is an O(chunks) aggregate: cached briefly per notebook and invalidated by every
  // write that can change it (import commit, delete, reindex, retention purge). Searches never pay it on the hot path.
  const countsCache = new Map();
  const COUNTS_TTL_MS = 10_000;
  const invalidateCounts = (nb) => { if (nb) countsCache.delete(nb); else countsCache.clear(); };
  function cachedCounts(notebookId) {
    const hit = countsCache.get(notebookId);
    if (hit && Date.now() - hit.t < COUNTS_TTL_MS) return hit.value;
    const value = store.vectorStatusCounts(notebookId, { ...embedMeta(), ...vis() });
    countsCache.set(notebookId, { t: Date.now(), value });
    return value;
  }

  const embedDoc = (text) => deps.embedText(`${embedFormat.docPrefix}${text}`);
  const embedQuery = (text) => deps.embedText(`${embedFormat.queryPrefix}${text}`);
  const embedMeta = () => ({ provider, model, embedVersion: embedFormat.version });

  const stage = (doc, versionId, status, extra = {}) => {
    store.updateDocument(doc.documentId, { status, ...('errorCode' in extra ? { errorCode: extra.errorCode } : {}) });
    store.updateVersion(versionId, { status, ...('errorCode' in extra ? { errorCode: extra.errorCode } : {}) });
  };

  async function embedChunks(chunks, signal) {
    const vectors = [];
    for (const c of chunks) {
      signal?.throwIfAborted?.();
      const v = await embedDoc(c.text);
      if (!Array.isArray(v) || v.length === 0 || v.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('invalid embedding');
      if (vectors.length && v.length !== vectors[0].length) throw new Error('embedding dimension mismatch');
      vectors.push(v);
    }
    return vectors;
  }

  async function storeVectors(doc, version, chunks, vectors) {
    await vectorStore.upsert(chunks.map((c, i) => ({
      chunk_id: c.chunkId, notebook_id: doc.notebookId, source_id: doc.documentId, version_id: version.versionId, vector: vectors[i],
    })));
    if (!store.getDocument(doc.documentId)) { // deleted while the upsert was in flight: undo, record nothing
      await vectorStore.delete({ chunkIds: chunks.map(c => c.chunkId) });
      throw Object.assign(new Error('document supprimé pendant l\'indexation'), { code: 'SOURCE_DELETED' });
    }
    store.recordEmbeddings(chunks.map((c, i) => ({
      chunkId: c.chunkId, notebookId: doc.notebookId, ...embedMeta(), dimension: vectors[i].length, chunkHash: c.hash,
    })));
    invalidateCounts(doc.notebookId);
  }

  async function purgeVectors(chunkIds, fallbackScope) {
    try {
      if (chunkIds?.length) await vectorStore.delete({ chunkIds });
      else if (fallbackScope) await vectorStore.delete(fallbackScope);
    } catch (err) {
      log('warn', { code: 'INDEX_FAILED', error: err.message }, 'NOTEBOOK_DOC_VECTOR_PURGE_FAILED');
    }
  }

  async function pipeline({ doc, version, parsedInput, opts, signal }) {
    const t0 = Date.now();
    const done = (status, extra = {}) => {
      log('info', { sourceId: doc.documentId, stage: status, durationMs: Date.now() - t0, code: extra.errorCode ?? null, model }, 'NOTEBOOK_DOC_IMPORT_END');
    };
    try {
      signal.throwIfAborted();
      stage(doc, version.versionId, 'PARSING');
      const parsed = await parseDocument(parsedInput, limits);
      signal.throwIfAborted();

      stage(doc, version.versionId, 'SCANNING');
      let sections = parsed.sections;
      const fullText = sections.map(s => s.text).join('\n\n');
      const scan = scanSecrets(fullText);
      const meta = { ...version.sourceMeta, pageCount: parsed.pageCount, kind: parsed.kind };
      if (scan.hasSecrets) {
        meta.secretFindings = scan.findings.map(f => ({ kind: f.kind, severity: f.severity, count: f.count, lines: f.lines }));
        if (scan.mustBlock || opts.secretPolicy !== 'redact') {
          store.updateVersion(version.versionId, { sourceMeta: meta });
          const code = 'SECRET_DETECTED';
          store.updateVersion(version.versionId, { status: 'SECURITY_BLOCKED', errorCode: code });
          // A blocked re-import must not hide the still-current older version.
          store.updateDocument(doc.documentId, { status: store.getDocument(doc.documentId)?.currentVersionId ? 'READY' : 'SECURITY_BLOCKED', errorCode: code });
          done('SECURITY_BLOCKED', { errorCode: code });
          return { status: 'SECURITY_BLOCKED', errorCode: code, findings: meta.secretFindings, requiresConfirmation: !scan.mustBlock };
        }
        sections = sections.map(s => ({ ...s, text: redactDocumentSecrets(s.text) }));
        meta.redacted = true;
      }
      signal.throwIfAborted();

      stage(doc, version.versionId, 'CHUNKING');
      const rawChunks = chunkSections(sections, deps.chunkConfig);
      if (rawChunks.length === 0) throw new NotebookImportError('PARSER_FAILED', 'Aucun contenu à indexer');
      if (rawChunks.length > limits.maxChunks) throw new NotebookImportError('FILE_TOO_LARGE', `Trop de segments (${rawChunks.length} > ${limits.maxChunks})`);
      const versionNo = version.versionNo;
      const chunks = rawChunks.map(c => {
        const inj = detectInjection(c.text);
        return { ...c, chunkId: `${doc.documentId}:v${versionNo}:${c.ordinal}`, injectionFlags: inj.kinds };
      });
      if (chunks.some(c => c.injectionFlags.length)) meta.injectionWarning = [...new Set(chunks.flatMap(c => c.injectionFlags))];
      const textHash = sha256(sections.map(s => s.text).join('\n\n'));
      store.updateVersion(version.versionId, { sourceMeta: meta, textHash });
      signal.throwIfAborted();

      stage(doc, version.versionId, 'INDEXING');
      // Embeddings first (may fail → FTS-only), then one atomic SQLite swap, then vectors to the vector store.
      let vectors = null;
      let vectorFailed = false;
      try { vectors = await embedChunks(chunks, signal); } catch (err) { if (signal.aborted) throw err; vectorFailed = true; }
      signal.throwIfAborted();

      const language = guessLanguage(sections.map(s => s.text).join('\n\n'));
      // Synchronous from the abort check to the commit: a delete cannot interleave and no late chunk can be inserted.
      const { supersededChunkIds } = store.commitVersion({
        doc, version: { ...version }, chunks, trustLevel: store.getDocument(doc.documentId)?.trustLevel ?? doc.trustLevel, language,
      });
      invalidateCounts(doc.notebookId);
      if (supersededChunkIds.length) await purgeVectors(supersededChunkIds);

      let vectorStatus = 'VECTOR_UNAVAILABLE';
      if (vectors) {
        try { await storeVectors(doc, version, chunks, vectors); vectorStatus = 'READY'; } catch {
          store.deleteEmbeddingsForChunks(chunks.map(c => c.chunkId));
        }
      }
      store.updateVersion(version.versionId, { vectorStatus });
      if (vectorFailed || vectorStatus !== 'READY') log('warn', { sourceId: doc.documentId, stage: 'INDEXING', code: 'EMBEDDING_UNAVAILABLE', model }, 'NOTEBOOK_DOC_VECTOR_UNAVAILABLE');

      // Deleted while indexing → no vector may survive (rows are already gone if removeDocument ran first).
      if (signal.aborted || !store.getDocument(doc.documentId)) {
        await purgeVectors(chunks.map(c => c.chunkId));
        store.deleteEmbeddingsForChunks(chunks.map(c => c.chunkId));
        return { status: 'FAILED', errorCode: 'SOURCE_DELETED' };
      }
      done('READY');
      return { status: 'READY', chunkCount: chunks.length, vectorStatus };
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError' || err?.code === 'SOURCE_DELETED') {
        await removeDocument(doc.notebookId, doc.documentId, { fromPipeline: true });
        return { status: 'FAILED', errorCode: 'SOURCE_DELETED' };
      }
      const code = err instanceof NotebookImportError ? err.code : 'INDEX_FAILED';
      const status = err instanceof NotebookImportError && err.status === 'SECURITY_BLOCKED' ? 'SECURITY_BLOCKED' : 'FAILED';
      const existing = store.getDocument(doc.documentId);
      if (existing) {
        store.updateVersion(version.versionId, { status, errorCode: code });
        // A failed re-import must not hide the still-current older version.
        store.updateDocument(doc.documentId, { status: existing.currentVersionId ? 'READY' : status, errorCode: code });
      }
      done(status, { errorCode: code });
      return { status, errorCode: code, message: err?.message };
    } finally {
      aborts.delete(doc.documentId);
    }
  }

  // ── Import ────────────────────────────────────────────────────────────────
  // Returns immediately after validation with { documentId, versionId, duplicate, done }
  // (done resolves with the final result, never rejects on pipeline errors).
  function startImport(opts) {
    const {
      notebookId, filename, bytes, path: filePath, title, originKind = 'file', trustLevel, canonicalUri,
      secretPolicy = 'block', retention = 'KEEP', retentionDuration,
    } = opts;
    if (!RETENTION_POLICIES.includes(retention)) throw new NotebookImportError('INVALID_OPTION', `Rétention "${retention}" inconnue (${RETENTION_POLICIES.join(', ')})`);
    let expiresAt = null;
    if (retention === 'DELETE_AFTER') {
      const ms = parseRetentionDuration(retentionDuration);
      if (ms == null) throw new NotebookImportError('INVALID_OPTION', 'DELETE_AFTER exige une durée valide (ex. 1h, 24h, 7d ; entre 1m et 365d)');
      expiresAt = new Date(clock() + ms).toISOString();
    } else if (retentionDuration != null && retentionDuration !== '') {
      throw new NotebookImportError('INVALID_OPTION', 'Une durée n\'est acceptée qu\'avec DELETE_AFTER');
    }
    if (!['block', 'redact'].includes(secretPolicy)) throw new NotebookImportError('INVALID_OPTION', 'secretPolicy invalide');
    if (trustLevel != null && !TRUST_LEVELS.includes(trustLevel)) throw new NotebookImportError('INVALID_OPTION', `trustLevel invalide : ${trustLevel}`);

    let data = bytes; let name = filename;
    if (filePath != null) ({ bytes: data, filename: name } = readFileFromAllowedRoot(filePath, deps.allowedRoots, limits));
    const format = validateFormat(name);
    if (!(data instanceof Uint8Array) || data.length === 0) throw new NotebookImportError('PARSER_FAILED', 'Fichier vide');
    if (data.length > limits.maxFileBytes) throw new NotebookImportError('FILE_TOO_LARGE', `Fichier trop volumineux (${data.length} > ${limits.maxFileBytes} octets)`);

    const fileHash = sha256Bytes(data);
    const ts = nowIso();
    const visible = (d) => d && (!d.expiresAt || d.expiresAt > ts) && (d.retention !== 'SESSION_ONLY' || d.sessionId === sessionId);
    let dup = store.findDocumentByCurrentHash(notebookId, fileHash);
    if (dup && !visible(dup)) { void purgeDocumentNow(dup); dup = null; }
    if (dup) {
      return { documentId: dup.documentId, versionId: dup.currentVersionId, duplicate: true, done: Promise.resolve({ status: 'READY', duplicate: true }) };
    }

    const nameKey = format.filename.toLowerCase();
    let doc = store.findDocumentByName(notebookId, nameKey);
    if (doc && !visible(doc)) { void purgeDocumentNow(doc); doc = null; }
    const trust = TRUST_LEVELS.includes(trustLevel) ? trustLevel
      : originKind === 'past_ai_output' ? 'PAST_AI_OUTPUT' : 'UNKNOWN';
    if (!doc) {
      const documentId = store.newDocumentId();
      const rowId = crypto.randomUUID();
      // Documents are local-only by default (strict local).
      addNotebookSource({ id: rowId, notebookId, sourceType: 'document', sourceId: documentId, title: title || format.filename,
        provenance: `import:${originKind}`, privacy: true, egressPolicy: 'local_only' });
      store.insertDocument({
        documentId, notebookId, sourceRowId: rowId, nameKey, title: title || format.filename, mimeType: format.mime, hash: '', size: data.length,
        status: 'QUEUED', trustLevel: trust, retention, origin: originKind, canonicalUri,
        expiresAt, sessionId: retention === 'SESSION_ONLY' ? sessionId : null,
      });
      recomputeAndPersistNotebookPrivacy(notebookId);
      doc = store.getDocument(documentId);
    } else {
      const patch = {};
      if (originKind === 'past_ai_output' || trustLevel) patch.trustLevel = trust;
      if (opts.retention !== undefined && (retention !== doc.retention || retention === 'DELETE_AFTER')) {
        Object.assign(patch, { retention, expiresAt, sessionId: retention === 'SESSION_ONLY' ? sessionId : null });
      }
      if (Object.keys(patch).length) { store.updateDocument(doc.documentId, patch); doc = store.getDocument(doc.documentId); }
    }
    const versionId = store.newVersionId();
    const versionNo = store.nextVersionNo(doc.documentId);
    store.insertVersion({
      versionId, documentId: doc.documentId, notebookId, versionNo, fileHash, size: data.length,
      sourceMeta: { filename: format.filename, mimeType: format.mime, originKind, canonicalUri: canonicalUri ?? null },
    });
    const version = store.getVersion(versionId);
    store.updateDocument(doc.documentId, { status: 'QUEUED', size: doc.currentVersionId ? doc.size : data.length });

    const ctrl = new AbortController();
    aborts.set(doc.documentId, ctrl);
    const done = limiter.run(async () => {
      const t = Date.now();
      store.updateDocument(doc.documentId, { status: 'SCANNING' });
      store.updateVersion(versionId, { status: 'SCANNING' });
      log('info', { sourceId: doc.documentId, stage: 'SCANNING', durationMs: Date.now() - t }, 'NOTEBOOK_DOC_IMPORT_START');
      return pipeline({ doc: store.getDocument(doc.documentId) ?? doc, version, parsedInput: { bytes: data, filename: format.filename }, opts: { secretPolicy }, signal: ctrl.signal });
    }).catch(async err => {
      // Never lose an existing document because a NEW version could not be queued.
      if (store.getDocument(doc.documentId)?.currentVersionId) store.purgeVersionRows(doc.documentId, versionId);
      else await removeDocument(notebookId, doc.documentId, { fromPipeline: true });
      aborts.delete(doc.documentId);
      return { status: 'FAILED', errorCode: err?.code ?? 'INDEX_FAILED', message: err?.message };
    });
    return { documentId: doc.documentId, versionId, versionNo, duplicate: false, done };
  }

  async function importDocument(opts) {
    const h = startImport(opts);
    const result = await h.done;
    return { documentId: h.documentId, versionId: h.versionId, duplicate: h.duplicate, ...result };
  }

  // ── Deletion / purge ──────────────────────────────────────────────────────
  async function purgeDocumentNow(doc) {
    const ctrl = aborts.get(doc.documentId);
    if (ctrl) ctrl.abort();
    const { chunkIds } = store.purgeDocumentRows(doc.documentId);
    invalidateCounts(doc.notebookId);
    if (doc.sourceRowId) removeNotebookSource(doc.notebookId, doc.sourceRowId);
    recomputeAndPersistNotebookPrivacy(doc.notebookId);
    await purgeVectors(chunkIds, { notebookId: doc.notebookId, sourceId: doc.documentId });
    return chunkIds.length;
  }

  async function removeDocument(notebookId, documentId, { fromPipeline = false } = {}) {
    const doc = store.getDocument(documentId);
    if (!doc || doc.notebookId !== notebookId) return { ok: false, error: 'SOURCE_DELETED' };
    const ctrl = aborts.get(documentId);
    if (ctrl && !fromPipeline) ctrl.abort();
    const { chunkIds } = store.purgeDocumentRows(documentId);
    invalidateCounts(notebookId);
    await purgeVectors(chunkIds, { notebookId, sourceId: documentId });
    if (doc.sourceRowId) removeNotebookSource(notebookId, doc.sourceRowId);
    recomputeAndPersistNotebookPrivacy(notebookId);
    log('info', { sourceId: documentId, stage: 'DELETED', code: null }, 'NOTEBOOK_DOC_PURGED');
    return { ok: true, purgedChunks: chunkIds.length };
  }

  async function removeVersion(notebookId, documentId, versionId) {
    const doc = store.getDocument(documentId);
    if (!doc || doc.notebookId !== notebookId) return { ok: false, error: 'SOURCE_DELETED' };
    const r = store.purgeVersionRows(documentId, versionId);
    invalidateCounts(notebookId);
    await purgeVectors(r.chunkIds);
    if (r.documentDeleted) {
      if (doc.sourceRowId) removeNotebookSource(notebookId, doc.sourceRowId);
      recomputeAndPersistNotebookPrivacy(notebookId);
    } else if (r.promotedVersionId) {
      await reembedDocument(notebookId, documentId);
    }
    return { ok: true, documentDeleted: r.documentDeleted, promotedVersionId: r.promotedVersionId };
  }

  async function purgeNotebookDocuments(notebookId) {
    const ids = store.listDocumentIds(notebookId);
    invalidateCounts(notebookId);
    for (const id of ids) {
      const ctrl = aborts.get(id);
      if (ctrl) ctrl.abort();
      const { chunkIds } = store.purgeDocumentRows(id);
      await purgeVectors(chunkIds);
    }
    await purgeVectors(null, { notebookId });
    return { purged: ids.length };
  }

  // ── Retention ─────────────────────────────────────────────────────────────
  // Bounded local sweep (no cloud, no agent, no Device Fabric). Expired and
  // other-session documents are already invisible to every query; this frees them.
  async function sweepRetention({ limit = 50 } = {}) {
    const expired = store.listExpiredDocuments(nowIso(), limit);
    const stale = store.listStaleSessionDocuments(sessionId, limit);
    let purged = 0;
    for (const d of [...expired, ...stale]) { await purgeDocumentNow(d); purged++; }
    if (purged) log('info', { stage: 'RETENTION_SWEEP', expired: expired.length, staleSession: stale.length }, 'NOTEBOOK_RETENTION_SWEEP');
    return { expired: expired.length, staleSession: stale.length, purged };
  }

  let sweepTimer = null;
  function startRetentionJob(everyMs = deps.retentionSweepMs ?? 0) {
    if (sweepTimer || !everyMs) return;
    sweepTimer = setInterval(() => { void sweepRetention().catch(() => {}); }, Math.max(60_000, everyMs));
    sweepTimer.unref?.();
  }
  function stopRetentionJob() { if (sweepTimer) clearInterval(sweepTimer); sweepTimer = null; }

  // Boot sweep: SESSION_ONLY rows of a previous session + expired documents.
  const ready = sweepRetention({ limit: 500 }).catch(() => ({}));
  startRetentionJob();

  // ── Embeddings: embed missing / reindex explicitly ────────────────────────
  async function embedPending(doc, version, pending) {
    let vectors;
    try { vectors = await embedChunks(pending); } catch {
      store.updateVersion(version.versionId, { vectorStatus: 'VECTOR_UNAVAILABLE' });
      return 'VECTOR_UNAVAILABLE';
    }
    try { await storeVectors(doc, version, pending, vectors); } catch {
      store.deleteEmbeddingsForChunks(pending.map(c => c.chunkId));
      store.updateVersion(version.versionId, { vectorStatus: 'VECTOR_UNAVAILABLE' });
      return 'VECTOR_UNAVAILABLE';
    }
    store.updateVersion(version.versionId, { vectorStatus: 'READY' });
    return 'READY';
  }

  // Embeds current chunks that have no embedding yet (e.g. after VECTOR_UNAVAILABLE).
  async function reembedDocument(notebookId, documentId) {
    const doc = store.getDocument(documentId);
    if (!doc || doc.notebookId !== notebookId || !doc.currentVersionId) return { ok: false, error: 'SOURCE_DELETED' };
    const version = store.getVersion(doc.currentVersionId);
    const pending = store.getCurrentChunksWithoutEmbedding(documentId);
    if (pending.length === 0) return { ok: true, embedded: 0, vectorStatus: version.vectorStatus };
    const status = await embedPending(doc, version, pending);
    return { ok: status === 'READY', embedded: status === 'READY' ? pending.length : 0, vectorStatus: status };
  }

  // Explicit REINDEX of one source: re-embed EVERY current chunk with the active
  // model/format and replace old vectors. Old vectors stay untouched if embedding fails.
  async function reindexDocument(notebookId, documentId) {
    const doc = store.getDocument(documentId);
    if (!doc || doc.notebookId !== notebookId || !doc.currentVersionId) return { ok: false, error: 'SOURCE_DELETED' };
    const version = store.getVersion(doc.currentVersionId);
    const chunks = store.getCurrentChunkRows(documentId);
    if (!chunks.length) return { ok: true, reindexed: 0 };
    let vectors;
    try { vectors = await embedChunks(chunks); } catch {
      return { ok: false, error: 'EMBEDDING_UNAVAILABLE', reindexed: 0 };
    }
    await purgeVectors(chunks.map(c => c.chunkId));
    store.deleteEmbeddingsForChunks(chunks.map(c => c.chunkId));
    invalidateCounts(notebookId);
    await storeVectors(doc, version, chunks, vectors);
    store.updateVersion(version.versionId, { vectorStatus: 'READY' });
    log('info', { sourceId: documentId, stage: 'REINDEX', model }, 'NOTEBOOK_DOC_REINDEXED');
    return { ok: true, reindexed: chunks.length };
  }

  // Explicit REINDEX of a whole notebook: sequential, bounded, never automatic.
  async function reindexNotebook(notebookId, { maxDocuments = 500 } = {}) {
    const docs = store.listDocuments(notebookId, { limit: maxDocuments }).filter(d => d.status === 'READY');
    const results = [];
    for (const d of docs) results.push({ documentId: d.documentId, ...(await reindexDocument(notebookId, d.documentId)) });
    return { ok: results.every(r => r.ok), documents: results.length, reindexed: results.reduce((n, r) => n + (r.reindexed ?? 0), 0), failed: results.filter(r => !r.ok).length };
  }

  function vectorStatus(notebookId, { fresh = false } = {}) {
    if (fresh) invalidateCounts(notebookId);
    const counts = cachedCounts(notebookId);
    let status = 'READY';
    if (counts.total === 0) status = 'READY';
    else if (counts.compatible === 0) status = counts.incompatible > 0 ? 'VECTOR_STALE' : 'VECTOR_UNAVAILABLE';
    else if (counts.incompatible > 0 || counts.missing > 0) status = 'VECTOR_PARTIAL';
    return { status, ...counts, provider, model, embedVersion: embedFormat.version, needsReindex: counts.incompatible > 0 || counts.missing > 0 };
  }

  // ── Trust ─────────────────────────────────────────────────────────────────
  function setTrustLevel(notebookId, documentId, trustLevel) {
    if (!TRUST_LEVELS.includes(trustLevel)) throw new NotebookImportError('INVALID_OPTION', `trustLevel invalide : ${trustLevel}`);
    const doc = store.getDocument(documentId);
    if (!doc || doc.notebookId !== notebookId) return { ok: false, error: 'SOURCE_DELETED' };
    // An imported AI history can never be promoted (past AI ≠ verified fact): trust follows the message ROLE, fixed at import.
    if (doc.origin === 'ai_history') throw new NotebookImportError('INVALID_OPTION', 'Le niveau de confiance d\'un historique IA suit le rôle des messages et ne peut pas être promu');
    store.setTrustLevel(documentId, trustLevel); // metadata only — no permission changes anywhere
    return { ok: true, trustLevel };
  }

  function resolveScope(notebookId, { documentIds = null, trustFilter = 'all' } = {}) {
    if (!TRUST_FILTERS.includes(trustFilter)) throw new NotebookImportError('INVALID_OPTION', `trustFilter invalide : ${trustFilter}`);
    let ids = Array.isArray(documentIds) ? [...documentIds] : null;
    if (trustFilter !== 'all') {
      const allowed = new Set(store.listDocumentIdsByTrust(notebookId, trustFilter === 'user_authored' ? ['USER_AUTHORED'] : TRUSTED_LEVELS));
      ids = (ids ?? [...allowed]).filter(id => allowed.has(id));
    }
    return ids;
  }

  // ── Retrieval: FTS5 + vectors, gated, fused with RRF, diversified ─────────
  async function search(notebookId, query, opts = {}) {
    const q = String(query ?? '').trim();
    if (opts.profile && !RETRIEVAL_PROFILES[opts.profile]) throw new NotebookImportError('INVALID_OPTION', `profile invalide : ${opts.profile}`);
    const cfg = resolveRetrievalConfig(baseRetrieval, RETRIEVAL_PROFILES[opts.profile ?? 'precise'], opts.config, opts.topK ? { topK: opts.topK } : null);
    if (!q) return { mode: 'empty', retrievalMode: 'NONE', vectorStatus: 'NOT_USED', results: [], diagnostics: {}, config: cfg };
    await sweepRetention({ limit: 20 }); // expired/other-session documents are gone before any query
    const { includeHistorical = false, useVector = true } = opts;
    const filter = opts.filter ?? {}; // NB-4: scope ('documents' by default) + AI-history filters
    const scopeIds = resolveScope(notebookId, { ...opts, documentIds: opts.documentIds ?? filter.importIds ?? null });
    const filtered = !!(filter.providers || filter.provider || filter.roles || filter.from || filter.to || filter.conversationIds || filter.trustLevels);
    const pool = Math.max(cfg.topK * cfg.poolMultiplier, 20) * (filtered ? 4 : 1);
    const v = vis();
    const terms = store.queryTerms(q);

    const rawFts = terms.length && scopeIds?.length !== 0
      ? store.searchFts(notebookId, q, { limit: pool, documentIds: scopeIds, includeHistorical, sessionId, nowIso: v.nowIso, filter })
      : [];
    const ftsHits = gateFtsHits(rawFts, terms, cfg);

    let vectorHits = []; let vectorState = 'NOT_USED';
    let rawVectorCount = 0;
    if (useVector && scopeIds?.length !== 0) {
      try {
        const qv = await embedQuery(q);
        const raw = await vectorStore.search(qv, { notebookId, sourceIds: scopeIds, limit: pool });
        rawVectorCount = raw.length;
        const meta = store.getEmbeddingMeta(raw.map(r => r.chunk_id));
        // Never compare vectors across provider/model/dimension/format version.
        const compatible = raw.filter(r => {
          const m = meta.get(r.chunk_id);
          return m && m.provider === provider && m.model === model && m.embedVersion === embedFormat.version && m.dimension === qv.length;
        });
        const chunks = new Map(store.getCurrentChunks(notebookId, compatible.map(r => r.chunk_id), { sessionId, nowIso: v.nowIso, includeHistorical, filter }).map(c => [c.chunkId, c]));
        vectorHits = compatible.filter(r => chunks.has(r.chunk_id)).map(r => ({ ...chunks.get(r.chunk_id), vectorScore: r.score }))
          .sort((a, b) => b.vectorScore - a.vectorScore);
        // State derived from the hits themselves (no aggregate on the hot path):
        //  - hits exist but none is compatible ⇒ stale (other model / dimension / format version)
        //  - some incompatible ⇒ partial; no vector at all (empty result) ⇒ consult the cached counts
        if (raw.length > 0 && compatible.length === 0) vectorState = 'VECTOR_STALE';
        else if (raw.length === 0) {
          const c = cachedCounts(notebookId);
          if (c.total > 0 && c.compatible === 0) vectorState = c.incompatible > 0 ? 'VECTOR_STALE' : 'VECTOR_UNAVAILABLE';
          else vectorState = c.incompatible > 0 || c.missing > 0 ? 'VECTOR_PARTIAL' : 'READY';
        } else if (compatible.length < raw.length) vectorState = 'VECTOR_PARTIAL';
        else vectorState = 'READY';
      } catch (err) {
        vectorState = 'VECTOR_UNAVAILABLE';
        log('warn', { stage: 'SEARCH', code: 'EMBEDDING_UNAVAILABLE', model }, 'NOTEBOOK_DOC_SEARCH_FTS_ONLY');
      }
    }
    const gatedVector = gateVectorHits(vectorHits, cfg, new Set(ftsHits.map(h => h.chunkId)));

    const ranked = fuseRanked(ftsHits, gatedVector, cfg);
    const { picked, dupStats } = selectDiverse(ranked, cfg);
    const results = picked.map(e => ({ ...e.chunk, score: e.score, ftsRank: e.ftsRank, vectorRank: e.vectorRank }));

    const docs = new Map();
    const versionDates = new Map();
    for (const r of results) {
      if (!docs.has(r.documentId)) docs.set(r.documentId, store.getDocument(r.documentId));
      if (!versionDates.has(r.versionId)) versionDates.set(r.versionId, store.getVersionImportedAt(r.versionId));
    }
    for (const r of results) { r.sourceTitle = docs.get(r.documentId)?.title ?? ''; r.importedAt = versionDates.get(r.versionId); r.retention = docs.get(r.documentId)?.retention; }

    const vectorUsable = vectorState === 'READY' || vectorState === 'VECTOR_PARTIAL';
    const mode = gatedVector.length && ftsHits.length ? 'hybrid' : gatedVector.length ? 'vector_only' : 'fts_only';
    const mixed = includeHistorical
      ? [...new Set(results.filter(r => !r.isCurrent).map(r => r.documentId).filter(id => results.some(x => x.documentId === id && x.isCurrent)))]
      : [];
    return {
      mode,
      retrievalMode: vectorUsable ? 'HYBRID' : 'FTS_ONLY',
      vectorStatus: vectorState,
      results,
      diagnostics: {
        terms, ftsCandidates: rawFts.length, ftsAfterGate: ftsHits.length, vectorCandidates: rawVectorCount,
        vectorAfterGate: gatedVector.length, duplicatesSuppressed: dupStats, vector: countsCache.get(notebookId)?.value ?? null, mixedVersionDocuments: mixed,
        includeHistorical, trustFilter: opts.trustFilter ?? 'all',
      },
      config: cfg,
    };
  }

  // ── Ask: budget → conflicts → citation pack → local completion → validated contract ─
  async function ask(notebookId, question, opts = {}) {
    const { allowOutsideNotebook = false } = opts;
    const found = await search(notebookId, question, opts);
    const cfg = found.config;
    const budget = applyContextBudget(found.results, cfg);
    const base = {
      retrievalMode: found.retrievalMode, mode: found.mode, vectorStatus: found.vectorStatus,
      confidence: confidenceLevel(found.results), diagnostics: { ...found.diagnostics, contextTokens: budget.tokensUsed, contextBudget: budget.maxTokens },
    };

    if (budget.chunks.length === 0) {
      if (allowOutsideNotebook) {
        const answer = await deps.localComplete([
          { role: 'system', content: 'Aucune source du Notebook ne répond à cette question. Réponds brièvement avec tes connaissances générales, sans inventer de source, et commence par « Hors Notebook : ».' },
          { role: 'user', content: String(question) },
        ]);
        return { ...base, status: 'OUTSIDE_NOTEBOOK', outsideNotebook: true, answer: String(answer ?? ''), citations: [], uncertainties: [{ code: 'OUTSIDE_NOTEBOOK', message: 'Réponse hors Notebook : aucune source, aucune citation.' }], sourceConflicts: [], sourcesUsed: [], chunksUsed: 0, confidence: 'NONE' };
      }
      return { ...base, status: 'NO_RELEVANT_SOURCE', outsideNotebook: false, answer: 'Aucune source pertinente dans ce Notebook pour cette question.', citations: [], uncertainties: [{ code: 'NO_RELEVANT_SOURCE', message: 'Aucun extrait n\'a passé les seuils de pertinence ; le LLM n\'a pas été appelé.' }], sourceConflicts: [], sourcesUsed: [], chunksUsed: 0, confidence: 'NONE' };
    }

    const pack = buildCitationPack(question, budget.chunks);
    const sourceConflicts = detectConflicts(pack.chunks);
    const { messages } = buildDocumentMessages(pack, { conflicts: sourceConflicts });
    const answer = String(await deps.localComplete(messages) ?? '');
    const citations = validateCitations(notebookId, pack, answer);

    const uncertainties = [];
    if (citations.length === 0) uncertainties.push({ code: 'NO_CITATION_IN_ANSWER', message: 'La réponse ne cite aucune source : traiter comme inférence du modèle (MODEL_INFERENCE), non vérifiée.' });
    if (pack.chunks.every(c => c.assertionType === 'PAST_AI_ASSERTION')) uncertainties.push({ code: 'ONLY_PAST_AI_SOURCES', message: 'Toutes les sources sont d\'anciennes sorties d\'IA (PAST_AI_OUTPUT), non vérifiées.' });
    else if (pack.chunks.some(c => c.assertionType === 'PAST_AI_ASSERTION')) uncertainties.push({ code: 'PAST_AI_SOURCE_USED', message: 'Une des sources est une ancienne sortie d\'IA (non vérifiée).' });
    if (sourceConflicts.length) uncertainties.push({ code: 'SOURCE_CONFLICT', message: `${sourceConflicts.length} conflit(s) possible(s) entre sources (heuristique) : ne pas fusionner.` });
    if (found.retrievalMode === 'FTS_ONLY') uncertainties.push({ code: 'FTS_ONLY', message: 'Recherche texte locale uniquement (vecteurs indisponibles ou obsolètes).' });
    if (found.diagnostics.mixedVersionDocuments.length) uncertainties.push({ code: 'HISTORICAL_VERSION_MIXED', message: 'Anciennes et nouvelles versions d\'un même document sont mélangées.' });
    if (pack.chunks.some(c => c.injectionFlags.length)) uncertainties.push({ code: 'INJECTION_TEXT_IN_SOURCE', message: 'Un extrait contient du texte d\'instruction (traité comme donnée).' });
    if (base.confidence === 'LOW') uncertainties.push({ code: 'LOW_RETRIEVAL_CONFIDENCE', message: 'Pertinence de récupération faible.' });

    const cited = new Set(citations.map(c => c.chunkId));
    const bySource = new Map();
    for (const c of pack.chunks) {
      const s = bySource.get(c.sourceId) ?? { sourceId: c.sourceId, sourceTitle: c.sourceTitle, documentVersion: c.documentVersion, trustLevel: c.trustLevel, assertionType: c.assertionType, chunksUsed: 0, cited: false };
      s.chunksUsed++; if (cited.has(c.chunkId)) s.cited = true;
      bySource.set(c.sourceId, s);
    }
    return {
      ...base, status: 'ANSWERED', outsideNotebook: false, answer, citations, uncertainties, sourceConflicts,
      sourcesUsed: [...bySource.values()], chunksUsed: pack.chunks.length,
      pack: { chunkIds: pack.chunks.map(c => c.chunkId) },
    };
  }

  // ── Citations ─────────────────────────────────────────────────────────────
  function visibleDoc(documentId, notebookId) {
    const d = store.getDocument(documentId);
    const ts = nowIso();
    if (!d || d.notebookId !== notebookId) return null;
    if (d.expiresAt && d.expiresAt <= ts) return null;
    if (d.retention === 'SESSION_ONLY' && d.sessionId !== sessionId) return null;
    return d;
  }

  function resolveCitation(notebookId, chunkId) {
    const row = store.getChunkAnyVersion(notebookId, chunkId);
    if (!row) return null;
    return visibleDoc(row.documentId, notebookId) ? row : null;
  }

  // Strict check used before a citation is accepted: it must exist in THIS notebook,
  // its version and text hash must match what was retrieved.
  function verifyCitation(notebookId, { chunkId, versionId, hash }) {
    const row = resolveCitation(notebookId, chunkId);
    if (!row) return { valid: false, reason: 'NOT_FOUND' };
    if (versionId && row.versionId !== versionId) return { valid: false, reason: 'VERSION_MISMATCH' };
    if (hash && row.hash !== hash) return { valid: false, reason: 'HASH_MISMATCH' };
    return { valid: true, row };
  }

  function validateCitations(notebookId, pack, answerText) {
    const used = new Set();
    const re = /\[(\d+)\]/g;
    let m;
    while ((m = re.exec(answerText)) !== null) {
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < pack.chunks.length) used.add(idx);
    }
    const out = [];
    for (const i of [...used].sort((a, b) => a - b)) {
      const c = pack.chunks[i];
      const v = verifyCitation(notebookId, { chunkId: c.chunkId, versionId: c.versionId, hash: c.hash });
      if (!v.valid) continue;
      const row = v.row;
      out.push({
        ref: c.citationId, chunkId: row.chunkId, sourceId: row.sourceId, documentVersion: row.documentVersion, versionId: row.versionId,
        page: row.page, headingPath: row.headingPath, startOffset: row.startOffset, endOffset: row.endOffset,
        sourceTitle: c.sourceTitle, trustLevel: row.trustLevel, assertionType: assertionTypeFor(row.trustLevel),
        superseded: !row.isCurrent, hash: row.hash, passage: row.text.slice(0, 300),
      });
    }
    return out;
  }

  // Exact stored chunk (never a re-derived excerpt) for the UI preview.
  function previewCitation(notebookId, chunkId) {
    const row = resolveCitation(notebookId, chunkId);
    if (!row) return null;
    const doc = store.getDocument(row.documentId);
    return {
      chunkId: row.chunkId, sourceId: row.sourceId, sourceTitle: doc?.title ?? '', documentVersion: row.documentVersion, versionId: row.versionId,
      page: row.page, headingPath: row.headingPath, startOffset: row.startOffset, endOffset: row.endOffset, hash: row.hash,
      trustLevel: row.trustLevel, assertionType: assertionTypeFor(row.trustLevel), superseded: !row.isCurrent,
      importedAt: store.getVersionImportedAt(row.versionId), text: row.text,
    };
  }

  return {
    startImport, importDocument, removeDocument, removeVersion, purgeNotebookDocuments,
    reembedDocument, reindexDocument, reindexNotebook, vectorStatus,
    setTrustLevel, sweepRetention, startRetentionJob, stopRetentionJob, ready,
    search, ask, validateCitations, resolveCitation, verifyCitation, previewCitation,
    listDocuments: (nb, o) => store.listDocuments(nb, o),
    countDocuments: (nb) => store.countDocuments(nb),
    getDocument: (nb, id) => { const d = store.getDocument(id); return d && d.notebookId === nb ? { ...d, versions: store.listVersions(id) } : null; },
    limits, limiter, sessionId, embedFormat, retrievalConfig: baseRetrieval,
    listNotebookSources,
    // NB-4: the AI-history service is built on the same embedding / vector / retention / purge machinery.
    internals: {
      store, embedChunks, embedQuery, storeVectors, purgeVectors, vectorStore, embedMeta, provider, model, vis, nowIso, sessionId, aborts, limiter,
      purgeDocumentNow, invalidateCounts, cachedCounts, log, clock,
    },
  };
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export { NotebookImportError, safeFilename, sha256 };
