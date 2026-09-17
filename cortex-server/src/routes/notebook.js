// Local Notebook route (Phase 5, MASTER mission) — documentary/RAG
// workspace over existing neurons. Q&A is ALWAYS local (Ollama, env.ANSWER_MODEL)
// — this route never imports router.js's cloud fallback chain, so there is
// no code path here that can reach a cloud provider, regardless of settings.
// This is stricter than strict_local_mode: it's true by construction.

import { Hono } from 'hono';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createNotebook, listNotebooks, getNotebook, updateNotebook, deleteNotebook,
  addNotebookSource, listNotebookSources, countNotebookSources, removeNotebookSource, touchNotebookSource,
  getPageFromStore,
} from '../lib/sqlite.js';
import {
  recomputeAndPersistNotebookPrivacy, retrieveForQuestion, buildNotebookMessages, extractCitations,
  getOrBuildGlobalSummary,
} from '../lib/notebook.js';
import { parseIntParam } from '../lib/http-params.js';
import { isLocalOnlySource } from '../lib/source-privacy.js';

const MAX_SOURCES_PER_NOTEBOOK = 5000; // mission scale ceiling ("5000 si raisonnable")

function isPrivateNeuron(neuronId, kind) {
  const AUTO_PRIVATE_KINDS = new Set(['cv', 'candidature']);
  if (AUTO_PRIVATE_KINDS.has(kind)) return true;
  try { return isLocalOnlySource(getPageFromStore(neuronId)); } catch { return false; }
}

export function createNotebookRoute({ ollamaClient, env, logger }) {
  const app = new Hono();

  // Export directory sits next to the other data/ subfolders (data/images,
  // data/external-agents, etc.) — same convention as the rest of server.js.
  const exportDir = path.resolve(path.dirname(env.LANCEDB_PATH), 'notebook-exports');

  const deps = {
    embedText: async (text) => (await import('../lib/ollama.js')).embedText(ollamaClient, env.EMBEDDING_MODEL, text),
    searchNeuronsByIds: async (vector, ids, opts) => (await import('../lib/lancedb.js')).searchNeuronsByIds(env.LANCEDB_PATH, vector, ids, opts),
    getNeuronsByIds: async (ids) => (await import('../lib/lancedb.js')).getNeuronsByIds(env.LANCEDB_PATH, ids),
    localComplete: async (messages) => {
      const { chatCompletion } = await import('../lib/ollama.js');
      const model = env.ANSWER_MODEL;
      const result = await chatCompletion(ollamaClient, model, messages);
      return typeof result === 'string' ? result : (result?.message?.content ?? '');
    },
  };

  // ── Notebooks CRUD ─────────────────────────────────────────────────────────

  app.get('/notebooks', (c) => c.json({ notebooks: listNotebooks() }));

  app.post('/notebooks', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const title = String(body?.title ?? '').trim();
    if (!title) return c.json({ error: 'title requis' }, 400);
    const id = crypto.randomUUID();
    createNotebook({ id, title, description: String(body?.description ?? '') });
    return c.json({ id }, 201);
  });

  app.get('/notebooks/:id', (c) => {
    const notebook = getNotebook(c.req.param('id'));
    if (!notebook) return c.json({ error: 'Notebook introuvable' }, 404);
    return c.json({ notebook, source_count: countNotebookSources(notebook.id) });
  });

  app.put('/notebooks/:id', async (c) => {
    const id = c.req.param('id');
    if (!getNotebook(id)) return c.json({ error: 'Notebook introuvable' }, 404);
    const body = await c.req.json().catch(() => ({}));
    updateNotebook(id, { title: body?.title, description: body?.description });
    return c.json({ ok: true });
  });

  // Deleting a Notebook never deletes its sources' underlying neurons —
  // mission requirement. Only notebook_sources reference rows + cached
  // summaries are removed (see sqlite.js deleteNotebook).
  app.delete('/notebooks/:id', (c) => {
    const id = c.req.param('id');
    if (!getNotebook(id)) return c.json({ error: 'Notebook introuvable' }, 404);
    deleteNotebook(id);
    return c.json({ ok: true });
  });

  // ── Sources ──────────────────────────────────────────────────────────────
  // Pagination required — mission requirement ("pas de milliers de sources
  // chargées dans React", "pagination / virtualisation si nécessaire").

  app.get('/notebooks/:id/sources', (c) => {
    const notebookId = c.req.param('id');
    if (!getNotebook(notebookId)) return c.json({ error: 'Notebook introuvable' }, 404);
    const limit = Math.min(parseIntParam(c.req.query('limit'), 100), 500);
    const offset = Math.max(parseIntParam(c.req.query('offset'), 0), 0);
    return c.json({
      sources: listNotebookSources(notebookId, { limit, offset }),
      total: countNotebookSources(notebookId),
    });
  });

  // Adds a reference to an EXISTING neuron (by id) — never copies content,
  // never re-embeds. Privacy/egress are derived from the neuron itself
  // (private flag on its page, or auto-private kind), never from client input.
  app.post('/notebooks/:id/sources', async (c) => {
    const notebookId = c.req.param('id');
    if (!getNotebook(notebookId)) return c.json({ error: 'Notebook introuvable' }, 404);
    if (countNotebookSources(notebookId) >= MAX_SOURCES_PER_NOTEBOOK) {
      return c.json({ error: `Limite de ${MAX_SOURCES_PER_NOTEBOOK} sources par Notebook atteinte.` }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const sourceId = String(body?.source_id ?? '').trim();
    const title = String(body?.title ?? '').trim();
    const sourceType = String(body?.source_type ?? 'neuron');
    if (!sourceId || !title) return c.json({ error: 'source_id et title requis' }, 400);

    const kind = body?.kind ?? null;
    const privacy = isPrivateNeuron(sourceId, kind);
    const id = crypto.randomUUID();
    addNotebookSource({
      id, notebookId, sourceType, sourceId, title,
      provenance: String(body?.provenance ?? ''),
      privacy, egressPolicy: privacy ? 'local_only' : 'cloud_allowed',
    });
    const derived = recomputeAndPersistNotebookPrivacy(notebookId);
    logger?.info({ notebookId, sourceType, privacy }, 'NOTEBOOK_SOURCE_ADDED');
    return c.json({ id, notebook_privacy: derived }, 201);
  });

  // Removing a source never deletes the underlying neuron — mission requirement.
  app.delete('/notebooks/:id/sources/:sourceRowId', (c) => {
    const notebookId = c.req.param('id');
    if (!getNotebook(notebookId)) return c.json({ error: 'Notebook introuvable' }, 404);
    removeNotebookSource(notebookId, c.req.param('sourceRowId'));
    const derived = recomputeAndPersistNotebookPrivacy(notebookId);
    return c.json({ ok: true, notebook_privacy: derived });
  });

  // Re-index (metadata refresh) of ONE source only — never rebuilds the
  // whole notebook. The underlying neuron's own content/embedding is
  // managed by the normal /api/index path; this only refreshes the
  // notebook_sources reference row (e.g. a renamed title) and invalidates
  // cached summaries so they regenerate lazily.
  app.put('/notebooks/:id/sources/:sourceRowId', async (c) => {
    const notebookId = c.req.param('id');
    if (!getNotebook(notebookId)) return c.json({ error: 'Notebook introuvable' }, 404);
    const body = await c.req.json().catch(() => ({}));
    touchNotebookSource(notebookId, c.req.param('sourceRowId'), { title: body?.title });
    return c.json({ ok: true });
  });

  // ── RAG Q&A with structured citations ───────────────────────────────────
  // Always local (see deps.localComplete above) — belt-and-suspenders
  // guardCloudCall check included even though this route never imports a
  // cloud provider, for defense in depth consistent with Phase 1.

  app.post('/notebooks/:id/ask', async (c) => {
    const notebookId = c.req.param('id');
    const notebook = getNotebook(notebookId);
    if (!notebook) return c.json({ error: 'Notebook introuvable' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const question = String(body?.question ?? '').trim();
    if (!question) return c.json({ error: 'question requise' }, 400);

    try {
      const { chunks } = await retrieveForQuestion(deps, notebookId, question, { topK: Number(body?.top_k) || undefined });
      if (chunks.length === 0) {
        return c.json({ answer: 'Ce Notebook ne contient encore aucune source, ou aucun extrait pertinent n\'a été trouvé pour cette question.', citations: [], chunks_used: 0 });
      }

      // No guardCloudCall() here by design: this route never imports a cloud
      // provider module (see deps.localComplete above, backed only by
      // lib/ollama.js chatCompletion) — there is no cloud call site to guard.
      // guardCloudCall() exists specifically for the moment right before a
      // cloud HTTP request; calling it here would be a no-op at best (this
      // message array is never markPrivate()-tagged) and misleading at
      // worst (implying a cloud path exists when none does).
      const messages = buildNotebookMessages(question, chunks);
      const answer = await deps.localComplete(messages);
      const citations = extractCitations(answer, chunks);

      logger?.info({ notebookId, chunksUsed: chunks.length, citationsCount: citations.length }, 'NOTEBOOK_ASK_OK');
      return c.json({ answer, citations, chunks_used: chunks.length });
    } catch (error) {
      logger?.warn({ notebookId, error: error.message }, 'NOTEBOOK_ASK_FAILED');
      return c.json({ error: error.message }, 500);
    }
  });

  // ── Summary (level 1 global) ────────────────────────────────────────────

  app.get('/notebooks/:id/summary', async (c) => {
    const notebookId = c.req.param('id');
    if (!getNotebook(notebookId)) return c.json({ error: 'Notebook introuvable' }, 404);
    try {
      const result = await getOrBuildGlobalSummary(deps, notebookId);
      return c.json(result);
    } catch (error) {
      logger?.warn({ notebookId, error: error.message }, 'NOTEBOOK_SUMMARY_FAILED');
      return c.json({ error: error.message }, 500);
    }
  });

  // ── Manual export "Préparer pour NotebookLM" (Phase 5B) ─────────────────
  // Writes a plain .md file to LOCAL DISK ONLY — never contacts Google or
  // any NotebookLM endpoint. For a local_only notebook, requires an explicit
  // confirm=true (mission: "bloqué par défaut ou confirmation forte
  // explicite"). The exported file itself becomes a plain local artifact —
  // it is the user's own responsibility once they choose to upload it
  // anywhere; this endpoint only ever writes it to their own disk.
  app.post('/notebooks/:id/export-for-notebooklm', async (c) => {
    const notebookId = c.req.param('id');
    const notebook = getNotebook(notebookId);
    if (!notebook) return c.json({ error: 'Notebook introuvable' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const confirmed = body?.confirm === true;
    if (notebook.privacy && !confirmed) {
      return c.json({
        error: 'Ce Notebook contient des sources locales/privées (local_only). Confirmation explicite requise avant export.',
        requires_confirmation: true,
      }, 409);
    }

    try {
      const sources = listNotebookSources(notebookId, { limit: 10_000 });
      const neuronIds = sources.map(s => s.source_id);
      const neurons = await deps.getNeuronsByIds(neuronIds);
      const neuronById = new Map(neurons.map(n => [n.id, n]));

      const parts = [`# ${notebook.title}`, notebook.description ? `\n${notebook.description}\n` : ''];
      for (const source of sources) {
        const neuron = neuronById.get(source.source_id);
        parts.push(`\n## ${source.title}\n\n${neuron?.content ?? '(contenu indisponible)'}`);
      }
      const markdown = parts.join('\n');

      fs.mkdirSync(exportDir, { recursive: true });
      const filename = `${notebookId}-${Date.now()}.md`;
      const filePath = path.join(exportDir, filename);
      fs.writeFileSync(filePath, markdown, 'utf8');

      logger?.info({ notebookId, sourceCount: sources.length, filename }, 'NOTEBOOK_EXPORTED_FOR_NOTEBOOKLM');
      return c.json({
        ok: true,
        filename,
        source_count: sources.length,
        notice: 'Fichier Markdown créé localement. Aucun appel à Google/NotebookLM n\'a été effectué — c\'est un export manuel que tu peux ensuite importer toi-même où tu le souhaites.',
      });
    } catch (error) {
      logger?.warn({ notebookId, error: error.message }, 'NOTEBOOK_EXPORT_FAILED');
      return c.json({ error: error.message }, 500);
    }
  });

  return app;
}
