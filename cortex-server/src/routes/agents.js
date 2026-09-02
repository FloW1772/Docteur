import { Hono }        from 'hono';
import crypto           from 'node:crypto';
import { AGENT_TYPES, executeAgent } from '../lib/agent-runner.js';
import {
  getAllAgents, getAgentById, insertAgent, updateAgent, deleteAgent,
  getRunsByAgent, getPendingOutputs, markOutputConsumed,
} from '../lib/sqlite.js';

const MAX_AGENTS = 10;

export function createAgentsRoute({ logger, ollamaClient, services } = {}) {
  const route = new Hono();

  // GET /api/agents/types — list available agent types (for UI)
  route.get('/agents/types', (c) => {
    const types = Object.entries(AGENT_TYPES).map(([key, def]) => ({
      key,
      label:        def.label,
      description:  def.description,
      paramsSchema: def.paramsSchema,
    }));
    return c.json(types);
  });

  // GET /api/agents — list all agents with last run info
  route.get('/agents', (c) => {
    const agents = getAllAgents();
    return c.json(agents);
  });

  // POST /api/agents — create agent
  route.post('/agents', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { name, description = '', type, params = {}, trigger_type = 'manual', schedule = null, active = true } = body;

    if (!name?.trim())                  return c.json({ error: 'Nom manquant' }, 400);
    if (!AGENT_TYPES[type])             return c.json({ error: `Type inconnu : ${type}` }, 400);
    if (trigger_type === 'scheduled' && !schedule?.frequency)
                                        return c.json({ error: 'Fréquence manquante pour un agent planifié' }, 400);

    const existing = getAllAgents();
    if (existing.length >= MAX_AGENTS)  return c.json({ error: `Limite de ${MAX_AGENTS} agents atteinte.` }, 429);

    const now   = new Date().toISOString();
    const agent = { id: crypto.randomUUID(), name: name.trim(), description, type, params, trigger_type, schedule, active, created_at: now, updated_at: now };
    insertAgent(agent);
    logger?.info({ agentId: agent.id, type, name: agent.name }, 'agent created');
    return c.json(agent, 201);
  });

  // PUT /api/agents/:id — update agent
  route.put('/agents/:id', async (c) => {
    const id   = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    if (!getAgentById(id)) return c.json({ error: 'Agent introuvable' }, 404);

    const allowed = ['name', 'description', 'params', 'trigger_type', 'schedule', 'active'];
    const updates = {};
    for (const k of allowed) if (body[k] !== undefined) updates[k] = body[k];
    if (updates.name) updates.name = updates.name.trim();

    updateAgent(id, updates);
    return c.json(getAgentById(id));
  });

  // DELETE /api/agents/:id
  route.delete('/agents/:id', (c) => {
    const id = c.req.param('id');
    if (!getAgentById(id)) return c.json({ error: 'Agent introuvable' }, 404);
    deleteAgent(id);
    logger?.info({ agentId: id }, 'agent deleted');
    return c.json({ ok: true });
  });

  // POST /api/agents/:id/run — execute now (manual)
  route.post('/agents/:id/run', async (c) => {
    const id    = c.req.param('id');
    const agent = getAgentById(id);
    if (!agent)        return c.json({ error: 'Agent introuvable' }, 404);
    if (!agent.active) return c.json({ error: 'Agent désactivé' }, 400);

    try {
      const { runId, output, skipped, similarityNote } = await executeAgent(agent, { triggeredBy: 'manual', logger, ollamaClient, services });
      return c.json({
        ok: true, run_id: runId, title: output.title, content: output.content, kind: output.kind,
        skipped, similarity_note: similarityNote,
      });
    } catch (err) {
      const status = err.strict_local ? 503 : err.no_key ? 503 : 500;
      return c.json({ error: err.message, strict_local: !!err.strict_local, no_key: !!err.no_key }, status);
    }
  });

  // GET /api/agents/:id/runs — execution history
  route.get('/agents/:id/runs', (c) => {
    const id = c.req.param('id');
    if (!getAgentById(id)) return c.json({ error: 'Agent introuvable' }, 404);
    return c.json(getRunsByAgent(id, 50));
  });

  // GET /api/agents/pending-outputs — outputs from scheduled runs not yet consumed
  route.get('/agents/pending-outputs', (c) => {
    return c.json(getPendingOutputs());
  });

  // POST /api/agents/pending-outputs/:id/consume
  route.post('/agents/pending-outputs/:id/consume', async (c) => {
    const id   = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    markOutputConsumed(id, body.neuron_id ?? null);
    return c.json({ ok: true });
  });

  return route;
}
