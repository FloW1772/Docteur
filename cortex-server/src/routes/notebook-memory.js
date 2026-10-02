// Notebook NB-5 — DOCTEUR MEMORY routes (/api/docteur-memory/...). STRICT LOCAL.
// Memory only ever contains items a human approved; there is no bulk-approve, no auto-promotion and no route that
// gives memory any power over tools, devices or publication (this file imports no executor).

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getNotebook, getMeta, setMeta } from '../lib/sqlite.js';
import { getChatMemorySettings, setChatMemorySettings } from '../lib/chat-memory.js';
import { getMemoryService } from '../lib/notebook-documents-runtime.js';
import { MemoryError } from '../lib/notebook-memory.js';
import { createLocalRequestGuard } from '../lib/local-request-guard.js';

const HTTP = {
  MEMORY_NOT_FOUND: 404, INVALID_SCOPE: 400, APPROVAL_REQUIRED: 409, SECRET_DETECTED: 422, CONFLICT_REVIEW_REQUIRED: 409, INVALID_STATUS: 409, STALE_MEMORY_VERSION: 409,
  VECTOR_UNAVAILABLE: 503, CROSS_PROJECT_DENIED: 403, UNSUPPORTED_TYPE: 400, DUPLICATE_MEMORY: 409, MEMORY_TOO_LONG: 413, MEMORY_TOO_SHORT: 400, INVALID_OPTION: 400, PROVENANCE_MISSING: 422,
};

// Request guard: the central NB-7 helper (Host allow-list vs DNS rebinding, expected-frontend / same origin vs CSRF, JSON-only writes).
// Kept as a named export for the existing tests; the policy itself lives in lib/local-request-guard.js.
export const memoryRequestGuard = () => createLocalRequestGuard({ enforceJson: true });

export function createNotebookMemoryRoute({ ollamaClient, env, logger }) {
  const app = new Hono();
  const svc = getMemoryService({ ollamaClient, env, logger });
  app.use('/docteur-memory/*', memoryRequestGuard());
  app.use('/docteur-memory/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'Requête trop volumineuse', code: 'BODY_TOO_LARGE' }, 413) }));

  const fail = (c, err) => {
    if (err instanceof MemoryError) {
      const { code, message, name: _n, stack: _s, ...extra } = err; void _n; void _s;
      return c.json({ error: message, code, ...extra }, HTTP[code] ?? 400);
    }
    logger?.warn({ code: 'MEMORY_INTERNAL', error: err?.message }, 'NOTEBOOK_MEMORY_ROUTE_ERROR');
    return c.json({ error: 'Erreur interne', code: 'MEMORY_INTERNAL' }, 500);
  };
  const body = async (c) => { const b = await c.req.json().catch(() => ({})); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; };
  const int = (v, d, min, max) => { const n = Number.parseInt(v ?? '', 10); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d; };
  const wrap = (fn) => async (c) => { try { return await fn(c); } catch (e) { return fail(c, e); } };
  // Only these option keys are read from a request: nothing else can reach the service.
  const writeOpts = (b) => ({
    type: b.type, scope: b.scope, statement: b.statement, sensitivity: b.sensitivity, confidenceOverride: undefined, retention: b.retention, retentionDuration: b.retentionDuration,
    confirmGlobal: b.confirmGlobal === true, confirmSensitive: b.confirmSensitive === true, allowDuplicate: b.allowDuplicate === true, secretPolicy: b.secretPolicy === 'redact' ? 'redact' : 'block',
    expectedVersion: b.expectedVersion, effectiveFrom: typeof b.effectiveFrom === 'string' ? b.effectiveFrom : undefined, approvalSource: 'USER_UI',
  });

  app.get('/docteur-memory/status', (c) => c.json({ strict_local: true, projects: svc.listProjects(), counts: { approved: svc.countMemories('APPROVED'), superseded: svc.countMemories('SUPERSEDED'), revoked: svc.countMemories('REVOKED'), archived: svc.countMemories('ARCHIVED') },
    vector: svc.vectorStatus(), retrieval: svc.retrievalConfig, constants: svc.constants, embedFormat: svc.embedFormat.version }));

  // NB-7: global switch « Docteur Memory dans le chat principal » (default ON; the chat request can still turn it OFF per conversation)
  app.get('/docteur-memory/chat-settings', (c) => c.json({ strict_local: true, settings: getChatMemorySettings(getMeta) }));
  app.put('/docteur-memory/chat-settings', wrap(async (c) => { const b = await body(c); if (typeof b.enabled !== 'boolean' && !['off', 'fallback', 'hybrid'].includes(b.vectorMode)) throw new MemoryError('INVALID_OPTION', 'enabled (boolean) ou vectorMode (off|fallback|hybrid) requis'); return c.json({ strict_local: true, settings: setChatMemorySettings(setMeta, getMeta, { enabled: b.enabled, vectorMode: b.vectorMode }) }); }));

  // projects (explicit registry — a project is never guessed)
  app.get('/docteur-memory/projects', (c) => c.json({ projects: svc.listProjects() }));
  app.post('/docteur-memory/projects', wrap(async (c) => { const b = await body(c); return c.json({ project: svc.createProject({ projectId: b.projectId, name: b.name }) }, 201); }));
  app.put('/docteur-memory/notebooks/:id/project', wrap(async (c) => { const b = await body(c); return c.json(svc.setNotebookProject(c.req.param('id'), b.projectId ?? null)); }));
  app.get('/docteur-memory/notebooks/:id/project', (c) => c.json({ notebookId: c.req.param('id'), projectId: svc.projectOfNotebook(c.req.param('id')) }));

  // items
  app.get('/docteur-memory/items', wrap((c) => {
    const q = c.req.query(); const limit = int(q.limit, 50, 1, 200); const offset = int(q.offset, 0, 0, 1e6);
    const o = { status: q.status || null, scopeKind: q.scope || null, projectId: q.project || null, notebookId: q.notebook || null, type: q.type || null, q: q.q || null, needsReview: q.needs_review === '1' ? true : null, limit, offset };
    return c.json({ strict_local: true, items: svc.listMemories(o), total: svc.countMemories(o.status), limit, offset });
  }));
  app.get('/docteur-memory/items/:mid', wrap((c) => {
    const m = svc.getMemory(c.req.param('mid')); if (!m) throw new MemoryError('MEMORY_NOT_FOUND', 'Souvenir introuvable');
    return c.json({ memory: m, evidence: svc.listEvidence(m.memoryId), usageCount: svc.usageCount(m.memoryId) });
  }));
  app.get('/docteur-memory/items/:mid/revisions', wrap((c) => { if (!svc.getMemory(c.req.param('mid'))) throw new MemoryError('MEMORY_NOT_FOUND', 'Souvenir introuvable'); return c.json({ revisions: svc.listRevisions(c.req.param('mid')) }); }));

  // creation: always an explicit human action
  app.post('/docteur-memory/items', wrap(async (c) => { const b = await body(c); return c.json(await svc.createManual({ ...writeOpts(b), evidence: Array.isArray(b.evidence) ? b.evidence.slice(0, 5) : [] }), 201); }));
  app.post('/docteur-memory/notebooks/:id/candidates/:cid/approve', wrap(async (c) => {
    if (!getNotebook(c.req.param('id'))) throw new MemoryError('MEMORY_NOT_FOUND', 'Notebook introuvable');
    const b = await body(c); if (b.approve !== true) throw new MemoryError('APPROVAL_REQUIRED', 'Approbation humaine explicite requise (approve: true)', { field: 'approve' });
    return c.json(await svc.promoteCandidate({ ...writeOpts(b), notebookId: c.req.param('id'), candidateId: c.req.param('cid') }), 201);
  }));
  app.get('/docteur-memory/notebooks/:id/merge-proposals', wrap((c) => { if (!getNotebook(c.req.param('id'))) throw new MemoryError('MEMORY_NOT_FOUND', 'Notebook introuvable'); return c.json({ proposals: svc.proposeMerges(c.req.param('id')) }); }));
  app.post('/docteur-memory/notebooks/:id/merge', wrap(async (c) => {
    if (!getNotebook(c.req.param('id'))) throw new MemoryError('MEMORY_NOT_FOUND', 'Notebook introuvable');
    const b = await body(c); if (b.approve !== true) throw new MemoryError('APPROVAL_REQUIRED', 'Approbation humaine explicite requise (approve: true)', { field: 'approve' });
    return c.json(await svc.promoteMerged({ ...writeOpts(b), notebookId: c.req.param('id'), candidateIds: Array.isArray(b.candidateIds) ? b.candidateIds.slice(0, 10).map(String) : [] }), 201);
  }));

  // edit / lifecycle
  app.patch('/docteur-memory/items/:mid', wrap(async (c) => { const b = await body(c); return c.json(await svc.edit(c.req.param('mid'), writeOpts(b))); }));
  app.post('/docteur-memory/items/:mid/revoke', wrap(async (c) => { const b = await body(c); return c.json(await svc.revoke(c.req.param('mid'), { expectedVersion: b.expectedVersion, reason: typeof b.reason === 'string' ? b.reason.slice(0, 200) : null })); }));
  app.post('/docteur-memory/items/:mid/archive', wrap(async (c) => { const b = await body(c); return c.json(await svc.archive(c.req.param('mid'), { expectedVersion: b.expectedVersion })); }));
  app.post('/docteur-memory/items/:mid/restore', wrap(async (c) => { const b = await body(c); return c.json(await svc.restore(c.req.param('mid'), { expectedVersion: b.expectedVersion })); }));
  app.delete('/docteur-memory/items/:mid', wrap(async (c) => { const v = c.req.query('expected_version'); return c.json(await svc.deleteMemory(c.req.param('mid'), { expectedVersion: v != null ? Number(v) : undefined })); }));

  // supersession / conflicts (human decisions)
  app.get('/docteur-memory/suggestions', (c) => c.json({ suggestions: svc.listSuggestions({ status: c.req.query('status') || 'PENDING' }) }));
  app.post('/docteur-memory/supersede', wrap(async (c) => { const b = await body(c); return c.json(await svc.confirmSupersession(String(b.newId ?? ''), String(b.oldId ?? ''), { confirm: b.confirm === true, expectedOldVersion: b.expectedOldVersion })); }));
  app.post('/docteur-memory/supersede/dismiss', wrap(async (c) => { const b = await body(c); return c.json(svc.dismissSupersession(String(b.newId ?? ''), String(b.oldId ?? ''))); }));
  app.get('/docteur-memory/conflicts', (c) => c.json({ conflicts: svc.listConflicts({ status: c.req.query('status') || 'OPEN' }) }));
  app.post('/docteur-memory/conflicts/:cid/resolve', wrap(async (c) => { const b = await body(c); return c.json(await svc.resolveConflict(c.req.param('cid'), String(b.action ?? ''), { confirm: b.confirm === true })); }));

  // retrieval / answer / usage
  const retrieveOpts = (b) => ({
    activeProject: b.activeProject ?? null, activeNotebook: b.activeNotebook ?? null, includeHistorical: b.includeHistorical === true, asOf: typeof b.asOf === 'string' ? b.asOf : undefined,
    topK: int(b.topK, undefined, 1, 8), types: Array.isArray(b.types) ? b.types.map(String) : undefined, includeSensitive: b.includeSensitive === true, includeHighlySensitive: b.includeHighlySensitive === true,
    useVector: b.useVector !== false, strictConflicts: b.strictConflicts === true,
  });
  app.post('/docteur-memory/retrieve', wrap(async (c) => {
    const b = await body(c); const q = String(b.query ?? '').trim(); if (!q) throw new MemoryError('INVALID_OPTION', 'query requise');
    const r = await svc.retrieve(q, { ...retrieveOpts(b), trace: b.trace === true });
    return c.json({ strict_local: true, requestId: r.requestId, retrievalMode: r.retrievalMode, vectorStatus: r.vectorStatus, context: r.context, results: r.results, conflicts: r.pack.conflicts, notice: r.pack.notice, diagnostics: r.diagnostics });
  }));
  app.post('/docteur-memory/answer', wrap(async (c) => {
    const b = await body(c); const q = String(b.question ?? '').trim(); if (!q) throw new MemoryError('INVALID_OPTION', 'question requise');
    return c.json({ strict_local: true, ...(await svc.answer(q, { ...retrieveOpts(b), useNotebook: b.useNotebook === true })) });
  }));
  app.get('/docteur-memory/usage/:requestId', (c) => c.json({ usage: svc.listUsage(c.req.param('requestId')) }));
  app.post('/docteur-memory/reindex', wrap(async (c) => {
    const r = await svc.reindexMemories();
    return r.ok ? c.json(r) : c.json({ ...r, error: 'Vecteurs indisponibles : la recherche texte reste active', code: 'VECTOR_UNAVAILABLE' }, 503);
  }));

  return app;
}
