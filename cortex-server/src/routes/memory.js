// Adaptive local memory settings & inspection — Phase 3 (MASTER mission).
// Loopback-only, same guard as chat.js (conversations/preference facts):
// this data is personal and must never be reachable over the LAN even when
// LOCAL_NETWORK=true opens the rest of the API for mobile access.

import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  getMemorySettings, setMemorySettings, getBudgetLimits, selectMemoriesForBudget, resetAdaptiveMemory,
} from '../lib/memory.js';
import {
  listPreferenceFacts, deletePreferenceFact,
  listEpisodicMemories, countEpisodicMemories, deleteEpisodicMemory,
} from '../lib/sqlite.js';
import { parseIntParam } from '../lib/http-params.js';

async function loopbackOnly(c, next) {
  let remoteAddr = '';
  try { remoteAddr = getConnInfo(c)?.remote?.address ?? ''; } catch { /* ignore */ }
  const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1' || remoteAddr === '';
  if (!isLoopback) {
    return c.json({ error: 'Mémoire adaptative — accessible uniquement en local, jamais sur le réseau.' }, 403);
  }
  await next();
}

export function createMemoryRoute({ logger } = {}) {
  const app = new Hono();
  app.use('*', loopbackOnly);

  // ── Settings ─────────────────────────────────────────────────────────────

  app.get('/memory/settings', (c) => c.json(getMemorySettings()));

  app.put('/memory/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const allowed = ['enabled', 'learn_from_searches', 'learn_from_neurons', 'learn_from_corrections', 'budget'];
    const updates = {};
    for (const key of allowed) if (body?.[key] !== undefined) updates[key] = body[key];
    const settings = setMemorySettings(updates);
    return c.json(settings);
  });

  // ── View memory (both tiers, paginated) ─────────────────────────────────

  app.get('/memory/items', (c) => {
    const limit = Math.min(parseIntParam(c.req.query('limit'), 100), 500);
    const offset = Math.max(parseIntParam(c.req.query('offset'), 0), 0);
    const longTerm = listPreferenceFacts().map(f => ({
      id: f.id, text: f.fact, tier: 'long_term', category: 'preference',
      source: f.source, privacy: !!f.privacy, egress_policy: f.egress_policy,
      importance: f.importance, confidence: f.confidence, usage_count: f.usage_count,
      last_used_at: f.last_used_at, created_at: f.created_at,
    }));
    const episodic = listEpisodicMemories({ limit, offset }).map(m => ({
      id: m.id, text: m.text, tier: 'episodic', category: m.category,
      source: m.source, privacy: !!m.privacy, egress_policy: m.egress_policy,
      importance: m.importance, confidence: m.confidence, usage_count: m.usage_count,
      last_used_at: m.last_used_at, created_at: m.created_at,
    }));
    return c.json({
      long_term: longTerm,
      episodic,
      episodic_total: countEpisodicMemories(),
      budget: getBudgetLimits(),
    });
  });

  // GET /api/memory/preview?query=... — shows exactly what would be
  // selected/injected for a given question, without running any AI call.
  // This is what the settings UI's "Voir la mémoire" / budget preview uses.
  app.get('/memory/preview', (c) => {
    const query = c.req.query('query') || null;
    const selected = selectMemoriesForBudget({ query });
    return c.json({ selected, budget: getBudgetLimits() });
  });

  // ── Delete one item (either tier) ───────────────────────────────────────

  app.delete('/memory/items/:tier/:id', (c) => {
    const tier = c.req.param('tier');
    const id = c.req.param('id');
    if (tier === 'long_term') deletePreferenceFact(id);
    else if (tier === 'episodic') deleteEpisodicMemory(id);
    else return c.json({ error: 'tier invalide (long_term|episodic)' }, 400);
    return c.json({ ok: true });
  });

  // ── Reset adaptive memory (episodic tier only — long-term manual facts
  // are the user's own explicit entries and are NOT touched by this reset;
  // clearing them remains available via the existing DELETE /chat/preferences) ─

  app.post('/memory/reset', (c) => {
    resetAdaptiveMemory();
    logger?.info({}, 'ADAPTIVE_MEMORY_RESET');
    return c.json({ ok: true });
  });

  return app;
}
