// Notebook NB-4 — AI-history import / search / ask / review routes, plus the explicit
// unified-search / unified-ask surface. STRICT LOCAL: no cloud provider is imported; the archive is
// processed in memory and never stored; candidates never leave the Notebook (no global memory here).

import { Hono } from 'hono';
import { getNotebook } from '../lib/sqlite.js';
import { getNotebookDocumentService, getAiHistoryService } from '../lib/notebook-documents-runtime.js';
import { NotebookImportError, safeFilename } from '../lib/notebook-parsers.js';
import { ZipSecurityError } from '../lib/notebook-ai-zip.js';
import { createUnifiedService } from '../lib/notebook-unified.js';
import { retrieveForQuestion } from '../lib/notebook.js';
import { CANDIDATE_TYPES, CANDIDATE_STATUSES } from '../lib/notebook-ai-distill.js';
import { embedText, chatCompletion } from '../lib/ollama.js';
import { searchNeuronsByIds } from '../lib/lancedb.js';

const HTTP = { UNSUPPORTED_FORMAT: 415, FILE_TOO_LARGE: 413, SECURITY_BLOCKED: 403, PARSER_FAILED: 422, INVALID_OPTION: 400, QUEUE_FULL: 429, SOURCE_DELETED: 404 };

export function createNotebookAiHistoryRoute({ ollamaClient, env, logger }) {
  const app = new Hono();
  const svc = getAiHistoryService({ ollamaClient, env, logger });
  const docService = getNotebookDocumentService({ ollamaClient, env, logger });
  const unified = createUnifiedService({
    docService, aiService: svc,
    localComplete: async (m) => { const r = await chatCompletion(ollamaClient, env.ANSWER_MODEL, m); return typeof r === 'string' ? r : (r?.message?.content ?? ''); },
    neuronSearch: async (nb, q, topK) => {
      const deps = { embedText: (t) => embedText(ollamaClient, env.EMBEDDING_MODEL, t), searchNeuronsByIds: (v, ids, o) => searchNeuronsByIds(env.LANCEDB_PATH, v, ids, o) };
      return (await retrieveForQuestion(deps, nb, q, { topK })).chunks;
    },
  });

  const fail = (c, err) => {
    if (err instanceof NotebookImportError) return c.json({ error: err.message, code: err.code }, HTTP[err.code] ?? 400);
    if (err instanceof ZipSecurityError) return c.json({ error: err.message, code: 'SECURITY_BLOCKED', reason: err.code }, 403);
    logger?.warn({ code: 'INDEX_FAILED', error: err?.message }, 'NOTEBOOK_AI_ROUTE_ERROR');
    return c.json({ error: 'Erreur interne', code: 'INDEX_FAILED' }, 500);
  };
  const nbOf = (c) => getNotebook(c.req.param('id')) ?? null;
  const int = (v, d, min, max) => { const n = Number.parseInt(v ?? '', 10); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d; };
  const guard = (c) => { const n = nbOf(c); return n ? null : c.json({ error: 'Notebook introuvable' }, 404); };

  async function readImportInput(c) {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > svc.zipLimits.maxArchiveBytes + 64 * 1024) throw new NotebookImportError('FILE_TOO_LARGE', 'Fichier trop volumineux');
    const ct = c.req.header('content-type') ?? '';
    const strOpt = (o, k) => (typeof o?.[k] === 'string' && o[k] ? o[k] : undefined);
    if (ct.includes('multipart/form-data')) {
      const f = await c.req.parseBody();
      const o = {
        adapter: strOpt(f, 'adapter'), declaredProvider: strOpt(f, 'declared_provider'), secretPolicy: strOpt(f, 'secret_policy'), retention: strOpt(f, 'retention'), retentionDuration: strOpt(f, 'retention_duration'),
        distill: f.distill === 'true', distillLlm: f.distill_llm === 'true', previewId: strOpt(f, 'preview_id'),
      };
      if (f.file && typeof f.file !== 'string') { o.bytes = new Uint8Array(await f.file.arrayBuffer()); o.filename = safeFilename(f.file.name); }
      return o;
    }
    const b = await c.req.json().catch(() => ({}));
    return { adapter: strOpt(b, 'adapter'), declaredProvider: strOpt(b, 'declared_provider'), secretPolicy: strOpt(b, 'secret_policy'), retention: strOpt(b, 'retention'), retentionDuration: strOpt(b, 'retention_duration'), distill: b.distill === true, distillLlm: b.distill_llm === true, previewId: strOpt(b, 'preview_id') };
  }

  app.post('/notebooks/:id/ai-history/preview', async (c) => {
    const bad = guard(c); if (bad) return bad;
    try { const o = await readImportInput(c); return c.json({ strict_local: true, preview: await svc.preview({ ...o, notebookId: c.req.param('id') }) }); } catch (e) { return fail(c, e); }
  });

  app.post('/notebooks/:id/ai-history/imports', async (c) => {
    const bad = guard(c); if (bad) return bad;
    try {
      const o = await readImportInput(c); const h = svc.startImport({ ...o, notebookId: c.req.param('id') });
      if (c.req.query('wait') === '1') return c.json({ strict_local: true, ...(await h.done), importId: h.importId });
      void h.done; return c.json({ strict_local: true, importId: h.importId, status: 'QUEUED' }, 202);
    } catch (e) { return fail(c, e); }
  });

  app.get('/notebooks/:id/ai-history/imports', (c) => {
    const bad = guard(c); if (bad) return bad;
    const limit = int(c.req.query('limit'), 50, 1, 200); const offset = int(c.req.query('offset'), 0, 0, 1e6);
    return c.json({ strict_local: true, imports: svc.listImports(c.req.param('id'), { limit, offset }), total: svc.countImports(c.req.param('id')), limit, offset, adapters: svc.adapters, limits: { maxArchiveBytes: svc.zipLimits.maxArchiveBytes, maxEntries: svc.zipLimits.maxEntries, maxEntryBytes: svc.zipLimits.maxEntryBytes } });
  });
  app.get('/notebooks/:id/ai-history/imports/:importId', (c) => {
    const bad = guard(c); if (bad) return bad;
    const i = svc.getImport(c.req.param('id'), c.req.param('importId')); return i ? c.json({ import: i }) : c.json({ error: 'Import introuvable', code: 'SOURCE_DELETED' }, 404);
  });
  app.delete('/notebooks/:id/ai-history/imports/:importId', async (c) => {
    const bad = guard(c); if (bad) return bad;
    const r = await svc.deleteImport(c.req.param('id'), c.req.param('importId')); return r.ok ? c.json(r) : c.json({ error: 'Import introuvable', code: 'SOURCE_DELETED' }, 404);
  });
  app.post('/notebooks/:id/ai-history/imports/:importId/cancel', (c) => {
    const bad = guard(c); if (bad) return bad;
    const r = svc.cancelImport(c.req.param('id'), c.req.param('importId')); return c.json(r, r.ok ? 200 : 409);
  });
  app.post('/notebooks/:id/ai-history/imports/:importId/distill', async (c) => {
    const bad = guard(c); if (bad) return bad;
    const b = await c.req.json().catch(() => ({}));
    try { return c.json({ strict_local: true, ...(await svc.distill(c.req.param('id'), c.req.param('importId'), { useLlm: b?.use_llm === true })) }); } catch (e) { return fail(c, e); }
  });
  app.post('/notebooks/:id/ai-history/imports/:importId/reindex', async (c) => {
    const bad = guard(c); if (bad) return bad;
    const r = await svc.reindexImport(c.req.param('id'), c.req.param('importId')); return c.json(r, r.ok ? 200 : (r.error === 'SOURCE_DELETED' ? 404 : 503));
  });

  app.get('/notebooks/:id/ai-history/conversations', (c) => {
    const bad = guard(c); if (bad) return bad;
    const nb = c.req.param('id'); const limit = int(c.req.query('limit'), 50, 1, 200); const offset = int(c.req.query('offset'), 0, 0, 1e6);
    const o = { importId: c.req.query('import_id') || null, provider: c.req.query('provider') || null, q: c.req.query('q') || null, from: c.req.query('from') || null, to: c.req.query('to') || null, limit, offset };
    return c.json({ strict_local: true, conversations: svc.listConversations(nb, o), total: svc.countConversations(nb, { importId: o.importId }), limit, offset });
  });
  app.get('/notebooks/:id/ai-history/conversations/:cid/messages', (c) => {
    const bad = guard(c); if (bad) return bad;
    const nb = c.req.param('id'); const cid = c.req.param('cid'); const limit = int(c.req.query('limit'), 100, 1, 300); const offset = int(c.req.query('offset'), 0, 0, 1e6);
    const conv = svc.getConversation(nb, cid); if (!conv) return c.json({ error: 'Conversation introuvable' }, 404);
    const messages = svc.listMessages(nb, cid, { limit, offset }); const att = svc.listAttachments(nb, messages.map(m => m.messageId));
    return c.json({ strict_local: true, conversation: conv, messages: messages.map(m => ({ ...m, attachments: att.filter(a => a.messageId === m.messageId) })), total: svc.countMessages(nb, cid), limit, offset });
  });

  const filtersOf = (b) => ({
    providers: Array.isArray(b?.providers) ? b.providers.map(String) : (b?.provider ? [String(b.provider)] : undefined),
    roles: Array.isArray(b?.roles) ? b.roles.map(String) : (b?.role ? [String(b.role)] : (b?.user_only ? ['USER'] : (b?.ai_only ? ['ASSISTANT'] : undefined))),
    from: b?.from, to: b?.to, conversationIds: Array.isArray(b?.conversation_ids) ? b.conversation_ids.slice(0, 100).map(String) : undefined,
    importIds: Array.isArray(b?.import_ids) ? b.import_ids.slice(0, 100).map(String) : undefined, trustLevels: Array.isArray(b?.trust_levels) ? b.trust_levels.map(String) : undefined, mainPathOnly: b?.main_path_only === true,
  });

  app.post('/notebooks/:id/ai-history/search', async (c) => {
    const bad = guard(c); if (bad) return bad;
    const b = await c.req.json().catch(() => ({})); const q = String(b?.query ?? '').trim(); if (!q) return c.json({ error: 'query requise' }, 400);
    const limit = int(b?.limit, 6, 1, 20); const offset = int(b?.offset, 0, 0, 40);
    try {
      const f = await svc.search(c.req.param('id'), q, { topK: Math.min(limit + offset, 60), profile: b?.profile, filters: filtersOf(b) });
      return c.json({
        strict_local: true, retrieval_mode: f.retrievalMode, vector_status: f.vectorStatus, mode: f.mode, limit, offset, total_available: f.results.length,
        results: f.results.slice(offset, offset + limit).map(r => ({ chunkId: r.chunkId, type: r.type, importId: r.importId, conversationId: r.conversationId, conversationTitle: r.conversationTitle, provider: r.provider, providerLabel: r.providerLabel, providerVerified: r.providerVerified, role: r.role, trustLevel: r.trustLevel, assertionType: r.assertionType, speaker: r.speaker, date: r.date, messageIds: r.messageIds, branch: r.branch, injectionFlags: r.injectionFlags, score: r.score, text: r.text.slice(0, 700) })),
      });
    } catch (e) { return fail(c, e); }
  });
  app.post('/notebooks/:id/ai-history/ask', async (c) => {
    const bad = guard(c); if (bad) return bad;
    const b = await c.req.json().catch(() => ({})); const q = String(b?.question ?? '').trim(); if (!q) return c.json({ error: 'question requise' }, 400);
    try { const r = await svc.ask(c.req.param('id'), q, { topK: int(b?.top_k, 6, 1, 20), profile: b?.profile, filters: filtersOf(b) }); return c.json({ strict_local: true, ...r, citations: r.citations.slice(0, 20), sourceConflicts: r.sourceConflicts.slice(0, 10) }); } catch (e) { return fail(c, e); }
  });
  app.get('/notebooks/:id/ai-history/citations/:chunkId', (c) => {
    const bad = guard(c); if (bad) return bad;
    const p = svc.previewCitation(c.req.param('id'), c.req.param('chunkId')); return p ? c.json({ citation: p }) : c.json({ error: 'Citation introuvable (import supprimé, expiré ou autre Notebook)', code: 'SOURCE_DELETED' }, 404);
  });

  app.get('/notebooks/:id/ai-history/candidates', (c) => {
    const bad = guard(c); if (bad) return bad;
    const nb = c.req.param('id'); const status = c.req.query('status') || null; const type = c.req.query('type') || null;
    if ((status && !CANDIDATE_STATUSES.includes(status)) || (type && !CANDIDATE_TYPES.includes(type))) return c.json({ error: 'filtre invalide' }, 400);
    const limit = int(c.req.query('limit'), 50, 1, 200); const offset = int(c.req.query('offset'), 0, 0, 1e6);
    return c.json({ strict_local: true, global_memory: false, candidates: svc.listCandidates(nb, { status, type, importId: c.req.query('import_id') || null, limit, offset }), total: svc.countCandidates(nb, status), limit, offset, types: CANDIDATE_TYPES });
  });
  app.get('/notebooks/:id/ai-history/candidates/:cid', (c) => {
    const bad = guard(c); if (bad) return bad;
    const d = svc.getCandidateDetail(c.req.param('id'), c.req.param('cid')); return d ? c.json({ candidate: d }) : c.json({ error: 'Candidat introuvable' }, 404);
  });
  app.post('/notebooks/:id/ai-history/candidates/:cid/review', async (c) => {
    const bad = guard(c); if (bad) return bad;
    const b = await c.req.json().catch(() => ({}));
    try { const r = svc.reviewCandidate(c.req.param('id'), c.req.param('cid'), String(b?.action ?? ''), { statement: b?.statement, supersededBy: b?.superseded_by }); return c.json(r, r.ok ? 200 : 404); } catch (e) { return fail(c, e); }
  });

  // explicit unified surface (legacy /ask, /summary, NotebookLM export are NOT changed)
  const uopts = (b) => ({ scope: String(b?.scope ?? 'all'), topK: int(b?.top_k, 6, 1, 20), filters: filtersOf(b) });
  app.post('/notebooks/:id/unified-search', async (c) => {
    const bad = guard(c); if (bad) return bad;
    const b = await c.req.json().catch(() => ({})); const q = String(b?.query ?? '').trim(); if (!q) return c.json({ error: 'query requise' }, 400);
    try { const r = await unified.search(c.req.param('id'), q, uopts(b)); return c.json({ strict_local: true, ...r, results: r.results.map(x => ({ type: x.type, chunkId: x.chunkId, sourceId: x.sourceId, sourceTitle: x.sourceTitle, trustLevel: x.trustLevel, text: String(x.text).slice(0, 600) })) }); } catch (e) { return fail(c, e); }
  });
  app.post('/notebooks/:id/unified-ask', async (c) => {
    const bad = guard(c); if (bad) return bad;
    const b = await c.req.json().catch(() => ({})); const q = String(b?.question ?? '').trim(); if (!q) return c.json({ error: 'question requise' }, 400);
    try { return c.json({ strict_local: true, ...(await unified.ask(c.req.param('id'), q, uopts(b))) }); } catch (e) { return fail(c, e); }
  });

  return app;
}
