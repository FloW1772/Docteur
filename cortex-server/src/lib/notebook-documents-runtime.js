// Notebook NB-2/NB-4 — shared runtime wiring (one instance per server process, used by
// routes/notebook.js, routes/notebook-documents.js and routes/notebook-ai-history.js so all
// imports share one concurrency limiter and one retention session).
import { createNotebookDocumentService } from './notebook-documents.js';
import { createAiHistoryService } from './notebook-ai-history.js';
import { createMemoryService } from './notebook-memory.js';
import { createChatMemory, getChatMemorySettings } from './chat-memory.js';
import { createUnifiedService } from './notebook-unified.js';
import { getMeta, getNotebook } from './sqlite.js';
import { buildCitationPack, buildDocumentMessages } from './notebook-security.js';
import { detectConflicts } from './notebook-conflicts.js';
import { applyContextBudget } from './notebook-retrieval.js';
import { embedText, chatCompletion } from './ollama.js';

let instance = null;
let aiInstance = null;
let memInstance = null;
let chatMemInstance = null;
let unifiedInstance = null;

export function getNotebookDocumentService({ ollamaClient, env, logger }) {
  if (instance) return instance;
  const roots = String(process.env.NOTEBOOK_IMPORT_ROOTS ?? '').split(';').map(s => s.trim()).filter(Boolean);
  instance = createNotebookDocumentService({
    embedText: (text) => embedText(ollamaClient, env.EMBEDDING_MODEL, text),
    localComplete: async (messages) => {
      const result = await chatCompletion(ollamaClient, env.ANSWER_MODEL, messages);
      return typeof result === 'string' ? result : (result?.message?.content ?? '');
    },
    embeddingModel: env.EMBEDDING_MODEL,
    lancedbPath: env.LANCEDB_PATH,
    logger,
    allowedRoots: roots,
    retentionSweepMs: 5 * 60_000, // bounded local retention sweep (50 docs / 5 min), no scheduler dependency
  });
  return instance;
}

// NB-4 — local model availability is only CHECKED (never pulled / installed / downloaded).
export function getAiHistoryService({ ollamaClient, env, logger }) {
  if (aiInstance) return aiInstance;
  const docService = getNotebookDocumentService({ ollamaClient, env, logger });
  aiInstance = createAiHistoryService(docService, {
    logger,
    localComplete: async (messages) => {
      const result = await chatCompletion(ollamaClient, env.ANSWER_MODEL, messages);
      return typeof result === 'string' ? result : (result?.message?.content ?? '');
    },
    localModelAvailable: async () => {
      const r = await ollamaClient.list();
      const want = String(env.ANSWER_MODEL ?? '');
      return (r?.models ?? []).some(m => m.name === want || m.name.startsWith(`${want}:`) || want.startsWith(`${m.name}`));
    },
  });
  return aiInstance;
}

// NB-5 — approved-memory service. Same local embedder / local LLM / retention session as the document service.
// Notebook sources are an OPTIONAL, distinct retrieval channel (never merged with memory retrieval).
export function getMemoryService({ ollamaClient, env, logger }) {
  if (memInstance) return memInstance;
  const docService = getNotebookDocumentService({ ollamaClient, env, logger });
  memInstance = createMemoryService({
    embedText: (text) => embedText(ollamaClient, env.EMBEDDING_MODEL, text),
    embeddingModel: env.EMBEDDING_MODEL,
    lancedbPath: env.LANCEDB_PATH,
    sessionId: docService.sessionId,
    logger,
    retentionSweepMs: 5 * 60_000,
    localComplete: async (messages) => {
      const result = await chatCompletion(ollamaClient, env.ANSWER_MODEL, messages);
      return typeof result === 'string' ? result : (result?.message?.content ?? '');
    },
    notebookSearch: async (notebookId, question, { topK }) => {
      const found = await docService.search(notebookId, question, { topK });
      const budget = applyContextBudget(found.results, found.config);
      if (!budget.chunks.length) return { results: [] };
      const pack = buildCitationPack(question, budget.chunks);
      const { messages } = buildDocumentMessages(pack, { conflicts: detectConflicts(pack.chunks) });
      return {
        results: pack.chunks.map(c => ({ chunkId: c.chunkId, sourceTitle: c.sourceTitle, documentVersion: c.documentVersion })),
        sourcesBlock: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
      };
    },
  });
  return memInstance;
}

// NB-7 — Docteur Memory in the main chat. Notebook sources (documents + AI history of ONE explicitly selected Notebook) come from the
// NB-4 unified service WITHOUT the legacy neuron channel (the main chat already searches neurons itself).
export function getChatMemory({ ollamaClient, env, logger }) {
  if (chatMemInstance) return chatMemInstance;
  chatMemInstance = createChatMemory({
    getMemoryService: () => getMemoryService({ ollamaClient, env, logger }),
    getUnified: () => {
      if (!unifiedInstance) unifiedInstance = createUnifiedService({ docService: getNotebookDocumentService({ ollamaClient, env, logger }), aiService: getAiHistoryService({ ollamaClient, env, logger }), neuronSearch: null, localComplete: null });
      return unifiedInstance;
    },
    getNotebook,
    getSettings: () => getChatMemorySettings(getMeta),
    logger,
  });
  return chatMemInstance;
}

export function resetNotebookDocumentServiceForTests() { try { memInstance?.stopRetentionJob?.(); } catch { /* ignore */ } instance = null; aiInstance = null; memInstance = null; chatMemInstance = null; unifiedInstance = null; }
