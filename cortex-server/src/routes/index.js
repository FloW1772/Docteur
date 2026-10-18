import { Hono } from 'hono';
import { publicErrorBody, safeErrorLogFields } from '../lib/safe-error-contract.js'; // [SEC-REMED-4B]

// [SEC-REMED-4B] Error text from a runtime / provider / subprocess / store is untrusted: the client gets a stable
// code + this fixed text (a PublicError keeps its own Docteur-written message).
const INDEX_FAILED = { code: 'INDEX_OPERATION_FAILED', message: 'Opération d’indexation impossible.' };

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
    const captureId = typeof body.metadata?.captureId === 'string' ? body.metadata.captureId : undefined;
    if (captureId && logger) logger.info({ captureId, neuronId: body.id, elapsedMs: 0 }, 'CAPTURE_INDEX_START');
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
        if (captureId) {
          logger.info({
            captureId,
            neuronId: body.id,
            elapsedMs: total_ms,
            embeddingMs: result.embedding_ms,
            lanceDbMs: result.lancedb_ms,
          }, 'CAPTURE_INDEX_DONE');
        }
      }
      return c.json(result, 200);
    } catch (error) {
      const isOllama = services.isOllamaError(error);
      const status   = isOllama ? 503 : 500;

      if (logger) {
        logger.error({
          ...safeErrorLogFields(error, { operation: 'route.index' }),
          neuron_id:     body.id,
          neuron_title:  body.title,
          content_length: body.content?.length ?? 0,
          is_ollama_error: isOllama,
        }, 'INDEX_ERROR');
        if (captureId) {
          logger.error({
            captureId,
            neuronId: body.id,
            elapsedMs: Math.round(performance.now() - t0),
            ...safeErrorLogFields(error, { operation: 'route.index' }),
          }, 'INDEX_FAILED');
        }
      } else {
        console.error('[INDEX_ERROR]', {
          ...safeErrorLogFields(error, { operation: 'route.index' }),
          id:      body.id,
          title:   body.title,
        });
      }

      return c.json({ ...publicErrorBody(error, isOllama ? { code: 'MODEL_RUNTIME_UNAVAILABLE', message: 'Le moteur de modèle local est indisponible.' } : INDEX_FAILED), detail: 'Index operation failed' }, status);
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
      if (logger) logger.error({ ...safeErrorLogFields(error, { operation: 'route.index' }) }, 'LANCEDB_OPTIMIZE_ERROR');
      return c.json(publicErrorBody(error, INDEX_FAILED), 500);
    }
  });

  // GET /api/index/stats — fragment count and index status
  route.get('/index/stats', async (c) => {
    try {
      const stats = await services.getFragmentStats();
      return c.json(stats ?? { error: 'no table' }, 200);
    } catch (error) {
      return c.json(publicErrorBody(error, INDEX_FAILED), 500);
    }
  });

  return route;
}
