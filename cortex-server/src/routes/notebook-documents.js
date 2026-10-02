// Notebook NB-2 — raw document import + hybrid (FTS5 + vector) search/ask.
// STRICT LOCAL: no cloud provider is imported here. The route only calls the
// document service (local SQLite/LanceDB + local Ollama on loopback).
// Retrieval produces information + citations only — nothing here can reach a
// shell, Omega, Rassilon, Device Fabric or any publication surface.

import { Hono } from 'hono';
import { getNotebook } from '../lib/sqlite.js';
import { getNotebookDocumentService } from '../lib/notebook-documents-runtime.js';
import { NotebookImportError, SUPPORTED_FORMATS, safeFilename } from '../lib/notebook-parsers.js';
import { RETENTION_POLICIES } from '../lib/notebook-retention.js';
import { TRUST_LEVELS } from '../lib/notebook-documents.js';

const HTTP_BY_CODE = {
  UNSUPPORTED_FORMAT: 415, FILE_TOO_LARGE: 413, SECURITY_BLOCKED: 403, SECRET_DETECTED: 422,
  PARSER_FAILED: 422, INVALID_OPTION: 400, QUEUE_FULL: 429, SOURCE_DELETED: 404,
};

export function createNotebookDocumentsRoute({ ollamaClient, env, logger }) {
  const app = new Hono();
  const service = getNotebookDocumentService({ ollamaClient, env, logger });

  const failure = (c, err) => {
    if (err instanceof NotebookImportError) {
      return c.json({ error: err.message, code: err.code, status: err.status }, HTTP_BY_CODE[err.code] ?? 400);
    }
    logger?.warn({ code: 'INDEX_FAILED', error: err?.message }, 'NOTEBOOK_DOC_ROUTE_ERROR');
    return c.json({ error: 'Erreur interne d\'import', code: 'INDEX_FAILED' }, 500);
  };

  const requireNotebook = (c) => getNotebook(c.req.param('id')) ?? null;

  const intParam = (v, d, min, max) => { const n = Number.parseInt(v ?? '', 10); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d; };

  app.get('/notebooks/:id/documents', (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const limit = intParam(c.req.query('limit'), 50, 1, 200);
    const offset = intParam(c.req.query('offset'), 0, 0, 1_000_000);
    return c.json({
      strict_local: true,
      documents: service.listDocuments(nb.id, { limit, offset }),
      total: service.countDocuments(nb.id),
      limit, offset,
      limits: service.limits,
      formats: Object.keys(SUPPORTED_FORMATS),
      vector: service.vectorStatus(nb.id),
      retentionPolicies: RETENTION_POLICIES,
      trustLevels: TRUST_LEVELS,
    });
  });

  app.get('/notebooks/:id/vector-status', (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    return c.json({ strict_local: true, ...service.vectorStatus(nb.id) });
  });

  app.get('/notebooks/:id/documents/:docId', (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const doc = service.getDocument(nb.id, c.req.param('docId'));
    if (!doc) return c.json({ error: 'Document introuvable', code: 'SOURCE_DELETED' }, 404);
    return c.json({ document: doc });
  });

  app.post('/notebooks/:id/documents/import', async (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    try {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > service.limits.maxFileBytes + 64 * 1024) throw new NotebookImportError('FILE_TOO_LARGE', 'Fichier trop volumineux');

      const contentType = c.req.header('content-type') ?? '';
      let opts;
      if (contentType.includes('multipart/form-data')) {
        const form = await c.req.parseBody();
        const file = form.file;
        if (!file || typeof file === 'string') throw new NotebookImportError('INVALID_OPTION', 'Champ "file" requis');
        opts = {
          notebookId: nb.id, filename: safeFilename(file.name), bytes: new Uint8Array(await file.arrayBuffer()),
          title: typeof form.title === 'string' && form.title.trim() ? form.title.trim() : undefined,
          originKind: form.origin_kind === 'past_ai_output' ? 'past_ai_output' : 'file',
          secretPolicy: form.secret_policy === 'redact' ? 'redact' : 'block',
          ...(typeof form.retention === 'string' && form.retention ? { retention: form.retention } : {}),
          ...(typeof form.retention_duration === 'string' && form.retention_duration ? { retentionDuration: form.retention_duration } : {}),
          ...(typeof form.trust_level === 'string' && form.trust_level ? { trustLevel: form.trust_level } : {}),
        };
      } else {
        const body = await c.req.json().catch(() => ({}));
        if (typeof body?.text !== 'string') throw new NotebookImportError('INVALID_OPTION', 'Envoie un fichier (multipart) ou { text, title }');
        const title = String(body.title ?? 'Texte collé').trim() || 'Texte collé';
        opts = {
          notebookId: nb.id, filename: `${safeFilename(title) || 'texte'}.txt`, bytes: new TextEncoder().encode(body.text), title,
          originKind: body.origin_kind === 'past_ai_output' ? 'past_ai_output' : 'manual_text',
          secretPolicy: body.secret_policy === 'redact' ? 'redact' : 'block',
          ...(typeof body.retention === 'string' && body.retention ? { retention: body.retention } : {}),
          ...(typeof body.retention_duration === 'string' && body.retention_duration ? { retentionDuration: body.retention_duration } : {}),
          ...(typeof body.trust_level === 'string' && body.trust_level ? { trustLevel: body.trust_level } : {}),
        };
      }
      const handle = service.startImport(opts);
      if (c.req.query('wait') === '1') {
        const result = await handle.done;
        return c.json({ documentId: handle.documentId, versionId: handle.versionId, duplicate: handle.duplicate, ...result });
      }
      void handle.done;
      return c.json({ documentId: handle.documentId, versionId: handle.versionId, duplicate: handle.duplicate, status: handle.duplicate ? 'READY' : 'QUEUED' }, handle.duplicate ? 200 : 202);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.delete('/notebooks/:id/documents/:docId', async (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const r = await service.removeDocument(nb.id, c.req.param('docId'));
    if (!r.ok) return c.json({ error: 'Document introuvable', code: 'SOURCE_DELETED' }, 404);
    return c.json(r);
  });

  app.delete('/notebooks/:id/documents/:docId/versions/:versionId', async (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const r = await service.removeVersion(nb.id, c.req.param('docId'), c.req.param('versionId'));
    if (!r.ok) return c.json({ error: 'Document introuvable', code: 'SOURCE_DELETED' }, 404);
    return c.json(r);
  });

  app.post('/notebooks/:id/documents/:docId/reembed', async (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const r = await service.reembedDocument(nb.id, c.req.param('docId'));
    return c.json(r, r.ok ? 200 : 409);
  });

  // Explicit user actions only — never triggered automatically.
  app.post('/notebooks/:id/documents/:docId/reindex', async (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const r = await service.reindexDocument(nb.id, c.req.param('docId'));
    return c.json(r, r.ok ? 200 : (r.error === 'SOURCE_DELETED' ? 404 : 503));
  });

  app.post('/notebooks/:id/reindex', async (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const r = await service.reindexNotebook(nb.id);
    return c.json(r, r.ok ? 200 : 503);
  });

  // Trust level is METADATA (label + optional retrieval filter), never a permission.
  app.put('/notebooks/:id/documents/:docId/trust', async (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const body = await c.req.json().catch(() => ({}));
    try {
      const r = service.setTrustLevel(nb.id, c.req.param('docId'), String(body?.trust_level ?? ''));
      return c.json(r, r.ok ? 200 : 404);
    } catch (err) { return failure(c, err); }
  });

  // Shared retrieval options parser (validated; bounded).
  const retrievalOptions = (body) => {
    const opts = {};
    if (body?.profile !== undefined) opts.profile = String(body.profile);
    if (body?.trust_filter !== undefined) opts.trustFilter = String(body.trust_filter);
    if (body?.include_historical === true) opts.includeHistorical = true;
    if (Array.isArray(body?.document_ids)) opts.documentIds = body.document_ids.slice(0, 100).map(String);
    return opts;
  };

  app.post('/notebooks/:id/doc-search', async (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const query = String(body?.query ?? '').trim();
    if (!query) return c.json({ error: 'query requise' }, 400);
    const limit = intParam(body?.limit ?? body?.top_k, 6, 1, 20);
    const offset = intParam(body?.offset, 0, 0, 40);
    try {
      const found = await service.search(nb.id, query, { ...retrievalOptions(body), topK: Math.min(limit + offset, 60) });
      const page = found.results.slice(offset, offset + limit);
      return c.json({
        strict_local: true, mode: found.mode, retrieval_mode: found.retrievalMode, vector_status: found.vectorStatus,
        limit, offset, total_available: found.results.length,
        diagnostics: found.diagnostics,
        results: page.map(r => ({
          chunkId: r.chunkId, sourceId: r.sourceId, sourceTitle: r.sourceTitle, documentVersion: r.documentVersion, versionId: r.versionId,
          page: r.page, headingPath: r.headingPath, startOffset: r.startOffset, endOffset: r.endOffset, trustLevel: r.trustLevel,
          isCurrent: r.isCurrent, importedAt: r.importedAt, score: r.score, ftsRank: r.ftsRank, vectorRank: r.vectorRank,
          injectionFlags: r.injectionFlags, text: r.text.slice(0, 600),
        })),
      });
    } catch (err) { return failure(c, err); }
  });

  app.post('/notebooks/:id/doc-ask', async (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const question = String(body?.question ?? '').trim();
    if (!question) return c.json({ error: 'question requise' }, 400);
    try {
      const r = await service.ask(nb.id, question, {
        ...retrievalOptions(body), topK: intParam(body?.top_k, 6, 1, 20), allowOutsideNotebook: body?.allow_outside_notebook === true,
      });
      return c.json({
        strict_local: true, status: r.status, outside_notebook: r.outsideNotebook, answer: r.answer,
        citations: r.citations.slice(0, 20), uncertainties: r.uncertainties, source_conflicts: r.sourceConflicts.slice(0, 10),
        sources_used: r.sourcesUsed.slice(0, 20), retrieval_mode: r.retrievalMode, mode: r.mode, vector_status: r.vectorStatus,
        confidence: r.confidence, chunks_used: r.chunksUsed, diagnostics: r.diagnostics,
      });
    } catch (err) {
      if (err instanceof NotebookImportError) return failure(c, err);
      logger?.warn({ code: 'INDEX_FAILED', error: err?.message }, 'NOTEBOOK_DOC_ASK_FAILED');
      return c.json({ error: err.message }, 500);
    }
  });

  // Exact stored chunk for the citation preview (never a re-derived excerpt).
  app.get('/notebooks/:id/citations/:chunkId', (c) => {
    const nb = requireNotebook(c);
    if (!nb) return c.json({ error: 'Notebook introuvable' }, 404);
    const p = service.previewCitation(nb.id, c.req.param('chunkId'));
    if (!p) return c.json({ error: 'Citation introuvable (source supprimée, expirée ou autre Notebook)', code: 'SOURCE_DELETED' }, 404);
    return c.json({ citation: p });
  });

  return app;
}
