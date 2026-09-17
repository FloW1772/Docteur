import crypto from 'node:crypto';
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { searchNeurons } from '../lib/lancedb.js';
import { verifyModelAvailability, chatCompletion, embedText, unloadModel } from '../lib/ollama.js';
import { buildConversationPrompt, getPersonaSettings } from '../lib/persona.js';
import { hasActiveJobs } from './jobs.js';
import { isLocalOnlySource } from '../lib/source-privacy.js';
import {
  createConversation, listConversations, getConversationById, touchConversation, deleteConversation,
  addConversationMessage, getConversationMessages,
  listPreferenceFacts, addPreferenceFact, updatePreferenceFact, deletePreferenceFact, clearPreferenceFacts,
  getRouterSettings, getPageFromStore, insertActivityLog,
} from '../lib/sqlite.js';
import { getMemorySettings, selectMemoriesForBudget, isWorthRemembering, addEpisodicMemoryDeduped, privacyFromSource } from '../lib/memory.js';

// mistral-nemo:12b-instruct-2407-q4_K_M (~7.5 Go) — tuned for natural
// conversation rather than structured Q&A, and quantized to fit an 8 Go card
// alongside normal system overhead. Configurable in Settings.
const DEFAULT_CHAT_MODEL = 'mistral-nemo:12b-instruct-2407-q4_K_M';

const HISTORY_MESSAGES = 20; // last N messages (≈10 exchanges) kept as context
const MEMORY_TAG_RE = /\n?\[\[MEMOIRE:\s*(.+?)\s*\]\]\s*$/i;

function getChatModel() {
  return getRouterSettings()?.chat_model ?? DEFAULT_CHAT_MODEL;
}

// Strips the model's optional [[MEMOIRE: ...]] suggestion tag from the
// visible answer and returns it separately so the frontend can ask for
// explicit confirmation before anything is actually remembered.
function extractMemorySuggestion(text) {
  const match = String(text ?? '').match(MEMORY_TAG_RE);
  if (!match) return { cleanText: text, suggestedFact: null };
  return { cleanText: text.replace(MEMORY_TAG_RE, '').trim(), suggestedFact: match[1].trim() };
}

// Hard server-side guard, independent of CORS (which only stops browsers,
// not a direct request over the LAN): conversations and preference facts
// must never be reachable except from this machine, even when
// LOCAL_NETWORK=true opens the rest of the API to the LAN for mobile access.
async function loopbackOnly(c, next) {
  let remoteAddr = '';
  try { remoteAddr = getConnInfo(c)?.remote?.address ?? ''; } catch { /* ignore */ }
  const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1' || remoteAddr === '';
  if (!isLoopback) {
    return c.json({ error: 'Conversations et préférences — accessible uniquement en local, jamais sur le réseau.' }, 403);
  }
  await next();
}

export function createChatRoute({ ollamaClient, env, logger }) {
  const app = new Hono();
  app.use('*', loopbackOnly);

  // ── Conversations ────────────────────────────────────────────────────────

  app.get('/chat/conversations', (c) => c.json(listConversations()));

  app.post('/chat/conversations', async (c) => {
    const id = crypto.randomUUID();
    createConversation(id, '');
    return c.json({ id }, 201);
  });

  app.get('/chat/conversations/:id/messages', (c) => {
    const id = c.req.param('id');
    if (!getConversationById(id)) return c.json({ error: 'Conversation introuvable' }, 404);
    return c.json(getConversationMessages(id, 200));
  });

  app.delete('/chat/conversations/:id', (c) => {
    deleteConversation(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Chat model status (installed? GPU busy?) ────────────────────────────

  app.get('/chat/status', async (c) => {
    const model     = getChatModel();
    const installed = await verifyModelAvailability(ollamaClient, model).catch(() => false);
    return c.json({ model, installed, gpu_busy: hasActiveJobs() });
  });

  // ── Send a message ───────────────────────────────────────────────────────

  app.post('/chat/message', async (c) => {
    const body           = await c.req.json().catch(() => null);
    const conversationId = body?.conversationId;
    const message         = String(body?.message ?? '').trim();

    if (!conversationId || !getConversationById(conversationId)) {
      return c.json({ ok: false, error: 'Conversation introuvable' }, 400);
    }
    if (!message) return c.json({ ok: false, error: 'Message vide' }, 400);
    if (message.length > 4000) return c.json({ ok: false, error: 'Message trop long (max 4000 caractères)' }, 400);

    const model = getChatModel();
    const installed = await verifyModelAvailability(ollamaClient, model).catch(() => false);
    if (!installed) {
      return c.json({
        ok: false, model_installed: false,
        error: `Modèle de conversation "${model}" non installé. Installez-le depuis Réglages → Modèles Ollama (~7,5 Go, 100% local).`,
      });
    }
    if (hasActiveJobs()) {
      return c.json({
        ok: false, gpu_busy: true,
        error: 'Un autre traitement GPU est en cours (lot, transcription…). Réessaie une fois ce traitement terminé.',
      });
    }

    const started = Date.now();
    try {
      // Optional RAG: search silently, use what's found, but conversation
      // must work fine with zero results — never a "rien trouvé" refusal.
      let sources = [];
      try {
        const vector = await embedText(ollamaClient, env.EMBEDDING_MODEL, message);
        const hits   = await searchNeurons(env.LANCEDB_PATH, vector, { limit: 3, threshold: 0.4 });
        sources = hits.map(hit => {
          const isPriv = isLocalOnlySource(hit) ||
            (() => { try { return isLocalOnlySource(getPageFromStore(hit.id)); } catch { return false; } })();
          return { ...hit, private: isPriv };
        });
      } catch { /* embedding/search failure must never block the conversation */ }

      const history = getConversationMessages(conversationId, HISTORY_MESSAGES)
        .map(m => ({ role: m.role, content: m.content }));

      // Budget-aware selection (Phase 3 adaptive memory) — never injects the
      // whole preference_facts/episodic_memories store, only the top-N
      // relevant to THIS message. Falls back to the pre-Phase-3 behavior
      // (all long-term facts, memory disabled) when the master switch is off.
      const memorySettings = getMemorySettings();
      const facts = memorySettings.enabled
        ? selectMemoriesForBudget({ query: message, budget: memorySettings.budget }).map(m => m.text)
        : listPreferenceFacts().map(f => f.fact);
      const systemPrompt = buildConversationPrompt(getPersonaSettings(), facts);

      const messages = [{ role: 'system', content: systemPrompt }];
      if (sources.length > 0) {
        const contextBlock = sources
          .map((s, i) => `Neurone ${i + 1}${s.private ? ' (privé)' : ''} — "${s.title}" :\n${String(s.content_preview ?? s.content ?? '').slice(0, 600)}`)
          .join('\n\n');
        messages.push({ role: 'system', content: `Extraits de neurones potentiellement utiles (utilise-les seulement s'ils sont vraiment pertinents à la conversation, ignore-les sinon) :\n\n${contextBlock}` });
      }
      messages.push(...history);
      messages.push({ role: 'user', content: message });

      // Frees qwen2.5:7b's VRAM before loading the (larger) chat model — same
      // "mode puissant" mutex-free pattern, kept warm for a few minutes so
      // consecutive messages in the same conversation don't reload cold.
      await unloadModel(ollamaClient, env.ANSWER_MODEL);

      const rawReply = await ollamaClient.chat({
        model, messages, stream: false,
        keep_alive: '10m',
        options: { temperature: 0.6 },
      }).then(r => r?.message?.content ?? '');

      const { cleanText, suggestedFact } = extractMemorySuggestion(rawReply);

      addConversationMessage(conversationId, 'user', message);
      addConversationMessage(conversationId, 'assistant', cleanText);

      // Local, rule-based correction learning (Phase 3) — deterministic
      // pattern match only, no AI call, never cloud. Deduplicated against
      // existing episodic memories so a repeated correction doesn't grow
      // the table unbounded.
      if (memorySettings.enabled && memorySettings.learn_from_corrections && isWorthRemembering(message, { kind: 'correction' })) {
        try {
          addEpisodicMemoryDeduped({
            text: message.slice(0, 300), category: 'correction', source: 'chat_correction', sourceRef: conversationId,
            ...privacyFromSource({}), importance: 0.6, confidence: 0.5,
          });
        } catch { /* best-effort — must never break the chat response */ }
      }
      const conv = getConversationById(conversationId);
      if (!conv.title) touchConversation(conversationId, message.slice(0, 60));
      else touchConversation(conversationId);

      // Chat model stays warm (keep_alive above) — only the embedding model
      // needs re-warming, same fire-and-forget pattern used after "mode
      // puissant" and after vision analysis.
      embedText(ollamaClient, env.EMBEDDING_MODEL, 'warmup').catch(() => {});

      // Metadata only — never the message content — same as every other
      // activity-log entry in this codebase.
      insertActivityLog({
        opType: 'chat_message', item: `conversation ${conversationId.slice(0, 8)}`,
        result: 'success', durationMs: Date.now() - started, modelUsed: model,
      });

      return c.json({
        ok: true,
        answer: cleanText,
        suggested_fact: suggestedFact,
        model_used: model,
        sources: sources.map(s => ({ id: s.id, title: s.title, kind: s.kind, private: s.private })),
        latency_ms: Date.now() - started,
      });
    } catch (err) {
      logger?.error({ err: err.message }, 'chat message failed');
      insertActivityLog({
        opType: 'chat_message', item: `conversation ${conversationId.slice(0, 8)}`,
        result: 'failure', reason: err.message, durationMs: Date.now() - started,
      });
      // Local failure only — never a cloud fallback.
      return c.json({ ok: false, error: `Réponse locale impossible : ${err.message}` });
    }
  });

  // ── Preference facts ─────────────────────────────────────────────────────

  app.get('/chat/preferences', (c) => c.json(listPreferenceFacts()));

  app.post('/chat/preferences', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const fact = String(body?.fact ?? '').trim();
    if (!fact) return c.json({ error: 'Fait vide' }, 400);
    if (fact.length > 300) return c.json({ error: 'Fait trop long (max 300 caractères)' }, 400);
    try {
      const id = addPreferenceFact(fact);
      return c.json({ id, fact }, 201);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.put('/chat/preferences/:id', async (c) => {
    const id   = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const fact = String(body?.fact ?? '').trim();
    if (!fact) return c.json({ error: 'Fait vide' }, 400);
    updatePreferenceFact(id, fact);
    return c.json({ ok: true });
  });

  app.delete('/chat/preferences/:id', (c) => {
    deletePreferenceFact(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.delete('/chat/preferences', (c) => {
    clearPreferenceFacts();
    return c.json({ ok: true });
  });

  return app;
}
