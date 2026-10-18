// Knowledge Graph V1 — KG-3 source adapters (read existing contracts, never write them).
//
// Article neurons: Article Canonical stays authoritative. The adapter reads the
// `metadata.canonical_article` written by canonical-article.js and applies the
// SAME identity order as findDuplicateArticle: canonical URL first, then
// content hash. It never re-canonicalises a body and never builds a second
// MSN/URL deduplication path. One logical kg_source per canonical article,
// one kg_source_ref per technical capture (MSN paste, URL extraction, …).
// A divergence between the two signals (same URL, different content hash; or
// same content under another URL) is attached as Article Canonical would, and
// REPORTED on the ref — never hidden.
//
// Notebook documents: consumed as the plain objects returned by the frozen
// Notebook public reads (getDocument / listDocuments, getNotebook). Nothing in
// Notebook is modified; the KG only keeps references (document id, version id).
//
// Privacy: the existing isLocalOnlySource contract decides; a logical source
// takes the most restrictive privacy of all its refs.

import { isLocalOnlySource } from './source-privacy.js';
import { canonicalizeUrl } from './canonical-article.js';
import { KgError } from './kg-store.js';

const MAX_REF_FIELD = 512;
const clip = (value, max = MAX_REF_FIELD) => (value === null || value === undefined ? null : String(value).slice(0, max));

function privacyOf(record) {
  return isLocalOnlySource(record) ? { privacy: 'PRIVATE', egress_policy: 'local_only' } : { privacy: 'STANDARD', egress_policy: 'cloud_allowed' };
}

/**
 * Logical source for an article, Article Canonical identity order.
 * @returns {{ source: object|null, matchedBy: 'canonical_url'|'content_hash'|null, divergences: string[] }}
 */
export function findArticleSource(store, { canonicalUrl, contentHash }) {
  const divergences = [];
  if (canonicalUrl) {
    const byUrl = store.findSourcesByCanonicalUrl(canonicalUrl);
    if (byUrl.length > 0) {
      const source = byUrl[0];
      if (contentHash && source.content_hash && source.content_hash !== contentHash) divergences.push('content_hash_differs');
      if (byUrl.length > 1) divergences.push('several_sources_share_canonical_url');
      return { source, matchedBy: 'canonical_url', divergences };
    }
  }
  if (contentHash) {
    const byHash = store.findSourcesByContentHash(contentHash);
    if (byHash.length > 0) {
      const source = byHash[0];
      if (canonicalUrl && source.canonical_url && source.canonical_url !== canonicalUrl) divergences.push('canonical_url_differs');
      if (byHash.length > 1) divergences.push('several_sources_share_content_hash');
      return { source, matchedBy: 'content_hash', divergences };
    }
  }
  return { source: null, matchedBy: null, divergences };
}

/**
 * Ingests a captured article neuron (page object: id, title, kind, metadata,
 * created/updated dates). Idempotent: re-ingesting the same neuron updates its
 * ref, it never creates a second logical source or ref.
 */
export function ingestArticleNeuron(store, page) {
  const metadata = page?.metadata ?? {};
  const canonical = metadata.canonical_article;
  if (!page?.id) throw new Error('page id is required');
  if (!canonical || typeof canonical !== 'object') throw new KgError('KG_NOT_A_CANONICAL_ARTICLE', 'page has no metadata.canonical_article');
  const canonicalUrl = canonical.canonicalUrl ?? null;
  const contentHash = canonical.contentHash ?? null;
  if (!canonicalUrl && !contentHash) throw new KgError('KG_ARTICLE_WITHOUT_IDENTITY', 'canonical article has neither canonicalUrl nor contentHash');
  const provenance = canonical.provenance ?? {};
  const privacy = privacyOf({ ...page, metadata });

  return store.transaction(() => {
    const existingRef = store.findSourceRef('article_capture', page.id);
    let found;
    if (existingRef) {
      found = { source: store.getSource(existingRef.source_id), matchedBy: 'source_ref', divergences: [] };
      if (canonicalUrl && found.source.canonical_url && found.source.canonical_url !== canonicalUrl) found.divergences.push('canonical_url_differs');
      if (contentHash && found.source.content_hash && found.source.content_hash !== contentHash) found.divergences.push('content_hash_differs');
    } else {
      found = findArticleSource(store, { canonicalUrl, contentHash });
    }
    let sourceId = found.source?.source_id ?? null;
    let logicalSourceCreated = false;
    if (!sourceId) {
      const logicalKey = canonicalUrl ? `article:url:${canonicalUrl}` : `article:hash:${contentHash}`;
      sourceId = store.upsertSource({
        source_type: 'ARTICLE',
        name: canonical.title || page.title || canonicalUrl || 'Article',
        uri: canonicalUrl,
        author: canonical.author ?? null,
        publisher: canonical.source ?? null,
        published_at: canonical.publishedAt ?? null,
        logical_key: logicalKey,
        canonical_url: canonicalUrl,
        content_hash: contentHash,
        ...privacy,
        metadata: { canonical_article_version: canonical.version ?? null },
      }).id;
      logicalSourceCreated = true;
    } else if (!found.source.canonical_url && canonicalUrl && found.divergences.length === 0) {
      // enrich (never overwrite): a paste-only source learns its canonical URL
      store.db.prepare('UPDATE kg_sources SET canonical_url = ?, uri = COALESCE(uri, ?), updated_at = ? WHERE source_id = ? AND canonical_url IS NULL')
        .run(canonicalUrl, canonicalUrl, new Date().toISOString(), sourceId);
    }
    const ref = store.upsertSourceRef({
      source_id: sourceId,
      adapter: 'article_capture',
      input_path: provenance.path === 'paste' ? 'paste' : 'url',
      source_ref: page.id,
      original_url: clip(metadata.url ?? null),
      capture_id: clip(metadata.captureId ?? null, 128),
      content_hash: contentHash,
      ...privacy,
      observed_at: page.updatedAt ?? page.updated_at ?? page.createdAt ?? page.created_at ?? undefined,
      provenance: {
        neuronTitle: clip(page.title, 200),
        canonicalVersion: canonical.version ?? null,
        canonicalUrl: clip(canonicalUrl),
        sourceStrategy: clip(provenance.sourceStrategy, 64),
        titleStrategy: clip(provenance.titleStrategy, 64),
        extractor: clip(provenance.extractor, 64),
        declaredCanonical: clip(provenance.declaredCanonical),
        matchedBy: found.matchedBy,
        ...(found.divergences.length ? { divergences: found.divergences } : {}),
      },
    });
    return { sourceId, sourceRefId: ref.id, logicalSourceCreated, refCreated: ref.isNew, matchedBy: found.matchedBy, divergences: found.divergences };
  });
}

/**
 * Ingests a Notebook document (frozen public read shape: getDocument()) of a
 * notebook (getNotebook()). Logical identity: canonical URI when present,
 * otherwise the document's content hash; each Notebook document stays its own
 * ref (document id + current version id).
 */
export function ingestNotebookDocument(store, { document, notebook = null }) {
  if (!document?.documentId) throw new Error('document.documentId is required');
  const canonicalUrl = document.canonicalUri ? canonicalizeUrl(document.canonicalUri) : null;
  const contentHash = document.hash || null;
  if (!canonicalUrl && !contentHash) throw new KgError('KG_DOCUMENT_WITHOUT_IDENTITY', 'Notebook document has neither canonical URI nor hash');
  const privacy = privacyOf({
    privacy: notebook?.privacy === true || notebook?.privacy === 1,
    egress_policy: notebook?.egress_policy ?? notebook?.egressPolicy,
  });
  return store.transaction(() => {
    const existingRef = store.findSourceRef('notebook_document', document.documentId);
    let sourceId = existingRef?.source_id ?? null;
    let logicalSourceCreated = false;
    const logicalKey = canonicalUrl ? `document:url:${canonicalUrl}` : `document:hash:${contentHash}`;
    if (!sourceId) sourceId = store.findSourceByLogicalKey(logicalKey)?.source_id ?? null;
    if (!sourceId) {
      sourceId = store.upsertSource({
        source_type: 'DOCUMENT',
        name: document.title || document.documentId,
        uri: canonicalUrl,
        language: document.language || 'unknown',
        logical_key: logicalKey,
        canonical_url: canonicalUrl,
        content_hash: contentHash,
        ...privacy,
        metadata: { mime_type: clip(document.mimeType, 128) },
      }).id;
      logicalSourceCreated = true;
    }
    const ref = store.upsertSourceRef({
      source_id: sourceId,
      adapter: 'notebook_document',
      input_path: clip(document.origin, 64),
      source_ref: document.documentId,
      version_ref: document.currentVersionId ?? null,
      original_url: clip(document.canonicalUri ?? null),
      content_hash: contentHash,
      ...privacy,
      observed_at: document.updatedAt ?? undefined,
      provenance: {
        notebookId: clip(document.notebookId, 128),
        title: clip(document.title, 200),
        trustLevel: clip(document.trustLevel, 64),
        retention: clip(document.retention, 64),
        status: clip(document.status, 32),
        // KG-7: the KG's own extraction marker survives a re-ingest (never a Notebook field)
        ...(existingRef?.provenance?.kgExtraction ? { kgExtraction: existingRef.provenance.kgExtraction } : {}),
      },
    });
    return { sourceId, sourceRefId: ref.id, logicalSourceCreated, refCreated: ref.isNew };
  });
}

export default { ingestArticleNeuron, ingestNotebookDocument, findArticleSource };
