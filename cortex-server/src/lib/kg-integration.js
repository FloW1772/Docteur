// Knowledge Graph V1 — KG-7 integration: Notebook documents and Neurone
// articles → KG. Derived, idempotent, read-only towards its sources.
//
// The KG only READS the frozen Notebook (public store reads: getNotebook,
// listDocuments, getDocument, getCurrentChunkRows, getChunkAnyVersion) and the
// Neurone page store (getAllPagesMetaFromStore, getPageFromStore). Nothing is
// ever written back (no backflow): the readers below expose read functions
// only, and tests inject the same shape.
//
// Notebook: one kg_source_ref per Notebook document (document id + current
// version id), one logical source per canonical URI / content hash (KG-3
// adapter). A notebook keeps its privacy (local_only → PRIVATE). Re-syncing is
// idempotent: refs, claims (claim_key) and evidence (source + locator +
// excerpt) are upserts. A new document version → the evidence located in
// chunks that are no longer current is INVALIDATED (kept, still reopenable as
// "superseded"); a deleted document → its ref is invalidated, its located
// evidence becomes SOURCE_MISSING and the claims are recomputed from their
// other evidence. Nothing is deleted; there is no cascade on entities.
//
// Claims from Notebook text come only from an injected LOCAL completion
// (kg-extraction.js enforces Strict Local and verbatim quotes); a chunk that
// already has evidence from this document is not sent to the model again.
//
// Neurone: articles carrying Article Canonical metadata go through the KG-3 /
// KG-4 path (ingestArticleNeuron + deterministic metadata claims): MSN paste
// and "info <lien>" of the same article converge on ONE logical source with
// two technical refs; a divergence is recorded on the ref, never hidden.

import { getNotebook, getAllPagesMetaFromStore, getPageFromStore } from './sqlite.js';
import { getDocument, listDocuments, getCurrentChunkRows, getChunkAnyVersion } from './notebook-docs-store.js';
import { ingestNotebookDocument } from './kg-adapters.js';
import { extractArticleMetadataClaims, extractClaimsWithLocalModel, MAX_MODEL_INPUT_CHARS } from './kg-extraction.js';
import { viewCitation } from './kg-view.js';

export const SYNC_LIMITS = Object.freeze({ maxDocumentsPerNotebook: 2000, maxChunksPerDocument: 500, maxPages: 20_000 });

/** Read-only view of the frozen Notebook store (the default for the server). */
export function createNotebookReader(fns = {}) {
  const f = { getNotebook, listDocuments, getDocument, getCurrentChunkRows, getChunkAnyVersion, ...fns };
  return Object.freeze({
    getNotebook: (id) => f.getNotebook(id),
    listDocuments(notebookId) {
      const out = [];
      for (let offset = 0; out.length < SYNC_LIMITS.maxDocumentsPerNotebook; offset += 200) {
        const page = f.listDocuments(notebookId, { limit: 200, offset, includeAiHistory: true });
        out.push(...page);
        if (page.length < 200) break;
      }
      return out.slice(0, SYNC_LIMITS.maxDocumentsPerNotebook);
    },
    getDocument: (id) => f.getDocument(id),
    getCurrentChunks: (documentId) => f.getCurrentChunkRows(documentId).slice(0, SYNC_LIMITS.maxChunksPerDocument),
    resolveChunk: (notebookId, chunkId) => f.getChunkAnyVersion(notebookId, chunkId),
  });
}

/** Read-only view of the Neurone page store. */
export function createNeuronReader(fns = {}) {
  const f = { getAllPagesMetaFromStore, getPageFromStore, ...fns };
  return Object.freeze({
    listArticlePages: () => f.getAllPagesMetaFromStore().filter(p => p?.metadata?.canonical_article).slice(0, SYNC_LIMITS.maxPages),
    getPage: (id) => f.getPageFromStore(id),
  });
}

const activeRefs = (store, adapter, notebookId = null) => store.prepare(`SELECT source_ref_id, source_ref FROM kg_source_refs WHERE adapter = ? AND status = 'ACTIVE'
  ${notebookId ? "AND json_extract(provenance, '$.notebookId') = ?" : ''}`).all(...(notebookId ? [adapter, notebookId] : [adapter]));

// ── Notebook ────────────────────────────────────────────────────────────────

/** The Notebook document is gone: its technical ref follows (non-destructive). */
export function invalidateNotebookDocument(store, documentId, { reason = 'notebook document deleted' } = {}) {
  const ref = store.findSourceRef('notebook_document', documentId);
  if (!ref) return { documentId, action: 'absent' };
  if (ref.status !== 'ACTIVE') return { documentId, action: 'already_invalidated' };
  return { documentId, action: 'invalidated', ...store.invalidateSourceRef(ref.source_ref_id, { reason }) };
}

/**
 * Syncs one Notebook document. `extract` (optional) is a LOCAL completion
 * `(messages) => ({ text, provider: 'local' })` used on chunks not yet extracted.
 */
export async function syncNotebookDocument(store, reader, documentId, { extract = null, extractorId = 'local' } = {}) {
  const doc = reader.getDocument(documentId);
  const ref = store.findSourceRef('notebook_document', documentId);
  if (!doc) return ref ? invalidateNotebookDocument(store, documentId) : { documentId, action: 'absent' };
  if (ref && ref.status !== 'ACTIVE') return { documentId, action: 'skipped', reason: 'KG_REF_INVALIDATED' };
  if (doc.status !== 'READY') return { documentId, action: 'skipped', reason: `NOT_READY:${doc.status}` };
  const notebook = reader.getNotebook(doc.notebookId);
  const ingest = ingestNotebookDocument(store, { document: doc, notebook });
  const chunks = reader.getCurrentChunks(documentId);
  const current = new Set(chunks.map(c => c.chunkId));
  const located = store.prepare("SELECT evidence_id, chunk_id FROM kg_evidence WHERE source_ref_id = ? AND status = 'ACTIVE' AND chunk_id IS NOT NULL").all(ingest.sourceRefId);
  const stale = located.filter(e => !current.has(e.chunk_id)).map(e => e.evidence_id);
  const outdated = store.invalidateEvidence(stale, { status: 'INVALIDATED', reason: 'superseded notebook document version' });
  const report = { documentId, notebookId: doc.notebookId, action: 'synced', ...ingest, versionRef: doc.currentVersionId, chunks: chunks.length,
    evidenceOutdated: outdated.evidenceInvalidated, claimsStored: 0, claimsRejected: 0, chunksExtracted: 0, chunksSkipped: 0 };
  const marker = store.getSourceRef(ingest.sourceRefId).provenance?.kgExtraction;
  if (typeof extract === 'function' && marker?.versionRef === doc.currentVersionId && marker?.extractorId === extractorId) {
    report.chunksSkipped = chunks.length; // this version was already read by this extractor
  } else if (typeof extract === 'function') {
    const done = new Set(located.filter(e => current.has(e.chunk_id)).map(e => e.chunk_id));
    for (const chunk of chunks) {
      if (done.has(chunk.chunkId) || !chunk.text?.trim()) { report.chunksSkipped++; continue; }
      const r = await extractClaimsWithLocalModel(store, {
        text: chunk.text.slice(0, MAX_MODEL_INPUT_CHARS), sourceId: ingest.sourceId, sourceRefId: ingest.sourceRefId, complete: extract,
        locator: { kind: 'CHUNK', chunkId: chunk.chunkId },
      });
      report.chunksExtracted++;
      report.claimsStored += r.stored.length;
      report.claimsRejected += r.rejected.length;
    }
    const ref = store.getSourceRef(ingest.sourceRefId);
    store.prepare('UPDATE kg_source_refs SET provenance = ?, updated_at = ? WHERE source_ref_id = ?').run(JSON.stringify({ ...ref.provenance,
      kgExtraction: { versionRef: doc.currentVersionId, extractorId: String(extractorId).slice(0, 64), chunks: chunks.length, at: new Date().toISOString() } }), new Date().toISOString(), ingest.sourceRefId);
  }
  return report;
}

/** Syncs every document of a notebook; refs of documents no longer there are invalidated. */
export async function syncNotebook(store, reader, notebookId, opts = {}) {
  const docs = reader.listDocuments(notebookId);
  const seen = new Set(docs.map(d => d.documentId));
  const results = [];
  for (const d of docs) results.push(await syncNotebookDocument(store, reader, d.documentId, opts));
  for (const r of activeRefs(store, 'notebook_document', notebookId)) {
    if (!seen.has(r.source_ref)) {
      const still = reader.getDocument(r.source_ref);
      results.push(still && still.notebookId !== notebookId
        ? await syncNotebookDocument(store, reader, r.source_ref, opts)
        : invalidateNotebookDocument(store, r.source_ref));
    }
  }
  const count = (a) => results.filter(r => r.action === a).length;
  return { notebookId, documents: docs.length, synced: count('synced'), invalidated: count('invalidated'), skipped: count('skipped'), results };
}

// ── Neurone ─────────────────────────────────────────────────────────────────

/** One captured article neuron (Article Canonical identity, deterministic claims). */
export function syncArticleNeuron(store, page) {
  if (!page?.id || !page.metadata?.canonical_article) return { pageId: page?.id ?? null, action: 'skipped', reason: 'NOT_A_CANONICAL_ARTICLE' };
  const ref = store.findSourceRef('article_capture', page.id);
  if (ref && ref.status !== 'ACTIVE') return { pageId: page.id, action: 'skipped', reason: 'KG_REF_INVALIDATED' };
  const r = extractArticleMetadataClaims(store, page);
  return { pageId: page.id, action: 'synced', sourceId: r.sourceId, sourceRefId: r.sourceRefId, logicalSourceCreated: r.logicalSourceCreated, refCreated: r.refCreated,
    matchedBy: r.matchedBy, divergences: r.divergences, claims: r.claims.length };
}

export function invalidateArticleNeuron(store, pageId, { reason = 'neuron deleted' } = {}) {
  const ref = store.findSourceRef('article_capture', pageId);
  if (!ref) return { pageId, action: 'absent' };
  if (ref.status !== 'ACTIVE') return { pageId, action: 'already_invalidated' };
  return { pageId, action: 'invalidated', ...store.invalidateSourceRef(ref.source_ref_id, { reason }) };
}

/** Syncs every article neuron; refs of neurons no longer there are invalidated. */
export function syncNeurons(store, reader) {
  const pages = reader.listArticlePages();
  const seen = new Set(pages.map(p => p.id));
  const results = pages.map(p => {
    try { return syncArticleNeuron(store, p); } catch (error) { return { pageId: p.id, action: 'error', error: error.code ?? error.message }; }
  });
  for (const r of activeRefs(store, 'article_capture')) {
    if (!seen.has(r.source_ref) && !reader.getPage(r.source_ref)?.metadata?.canonical_article) results.push(invalidateArticleNeuron(store, r.source_ref));
  }
  const count = (a) => results.filter(r => r.action === a).length;
  return { pages: pages.length, synced: count('synced'), invalidated: count('invalidated'), skipped: count('skipped'), errors: count('error'), results };
}

// ── citation reopen ─────────────────────────────────────────────────────────

/**
 * Checks that a citation's open target still resolves through Docteur's
 * existing mechanisms: a Notebook chunk in THAT notebook (any version), a
 * neuron that still exists. Read-only.
 */
export function verifyOpenTarget(readers, open) {
  if (!open) return null;
  if (open.kind === 'notebook_document' && readers?.notebook) {
    const doc = readers.notebook.getDocument(open.documentId);
    const docOk = Boolean(doc) && doc.notebookId === open.notebookId;
    const chunk = docOk && open.chunkId ? readers.notebook.resolveChunk(open.notebookId, open.chunkId) : null;
    const chunkOk = !open.chunkId || (Boolean(chunk) && chunk.documentId === open.documentId);
    return { ...open, available: docOk && chunkOk, superseded: chunk ? !chunk.isCurrent : false, ...(chunk ? { chunkVersionId: chunk.versionId } : {}) };
  }
  if (open.kind === 'neuron' && readers?.neuron) return { ...open, available: Boolean(readers.neuron.getPage(open.pageId)) };
  return { ...open, available: null };
}

/** viewCitation + reopen verification (same visibility rules: not visible = null). */
export function reopenCitation(store, readers, opts) {
  const v = viewCitation(store, opts);
  return v ? { ...v, open: verifyOpenTarget(readers, v.open) } : null;
}

export default { createNotebookReader, createNeuronReader, syncNotebookDocument, syncNotebook, invalidateNotebookDocument, syncArticleNeuron, syncNeurons, invalidateArticleNeuron, verifyOpenTarget, reopenCitation, SYNC_LIMITS };
