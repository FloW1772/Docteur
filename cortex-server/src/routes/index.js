import { Hono } from 'hono';

export function createIndexRoute({ services, logger }) {
  const route = new Hono();

  route.post('/index', async (c) => {
    const body = await c.req.json().catch(() => null);

    // Require at minimum id, kind, title — content can be empty (e.g. new blank neuron)
    if (!body || !body.id || !body.kind || !body.title) {
      return c.json({ error: 'Payload invalide. Champs requis: id, kind, title.' }, 400);
    }

    // Normalise: empty content falls back to title so the embedding is never blank
    if (!body.content || body.content.trim() === '') {
      body.content = body.title;
    }

    c.set('requestPayload', body);
    c.set('modelUsed', services.embeddingModel);

    const t0 = performance.now();
    try {
      const result = await services.indexNeuron(body);
      const total_ms = Math.round(performance.now() - t0);
      if (logger) {
        logger.info({
          neuron_id:     body.id,
          content_length: body.content?.length ?? 0,
          embedding_ms:  result.embedding_ms,
          lancedb_ms:    result.lancedb_ms,
          total_ms,
        }, 'INDEX_OK');
      }
      return c.json(result, 200);
    } catch (error) {
      const isOllama = services.isOllamaError(error);
      const status   = isOllama ? 503 : 500;

      if (logger) {
        logger.error({
          error_message: error.message,
          error_stack:   error.stack,
          neuron_id:     body.id,
          neuron_title:  body.title,
          content_length: body.content?.length ?? 0,
          is_ollama_error: isOllama,
        }, 'INDEX_ERROR');
      } else {
        console.error('[INDEX_ERROR]', {
          message: error.message,
          stack:   error.stack,
          id:      body.id,
          title:   body.title,
        });
      }

      return c.json({ error: error.message, detail: 'Index operation failed' }, status);
    }
  });

  // POST /api/index/optimize — compact LanceDB fragments (may take minutes on large tables)
  route.post('/index/optimize', async (c) => {
    try {
      const result = await services.optimizeIndex();
      if (logger) {
        logger.info({
          before_fragments: result.before?.fragments,
          after_fragments:  result.after?.fragments,
          rows:             result.after?.rows,
        }, 'LANCEDB_OPTIMIZE_DONE');
      }
      return c.json({ ok: true, ...result }, 200);
    } catch (error) {
      if (logger) logger.error({ error_message: error.message }, 'LANCEDB_OPTIMIZE_ERROR');
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/index/stats — fragment count and index status
  route.get('/index/stats', async (c) => {
    try {
      const stats = await services.getFragmentStats();
      return c.json(stats ?? { error: 'no table' }, 200);
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  return route;
}
