import { Hono } from 'hono';
import {
  savePageToStoreIfNewer, deletePageFromStore, getAllPagesFromStore, getPageFromStore, repairLinksFromMetadata,
  getDatabase, getRecentPagesFromStore, getAllPagesMetaFromStore, getPageCountsFromStore,
} from '../lib/sqlite.js';

export function createNeuronRoute({ services, logger }) {
  const route = new Hono();

  // GET /api/neurons/recent?limit=N — metadata only (no blocks), for fast startup
  route.get('/neurons/recent', (c) => {
    const raw   = c.req.query('limit');
    const limit = Math.min(raw ? (parseInt(raw, 10) || 50) : 50, 500);
    try {
      const pages = getRecentPagesFromStore(limit);
      return c.json({ ok: true, pages, limit });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/neurons/counts — total + per-kind counts (for home screen without loading all pages)
  route.get('/neurons/counts', (c) => {
    try {
      const counts = getPageCountsFromStore();
      return c.json({ ok: true, ...counts });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/neurons/all-meta — all pages metadata, no blocks (for "Tous les neurones" lazy load)
  // Unpaginated by design (see audit note): the frontend needs the complete
  // set in one call to compute accurate per-kind counts and populate the
  // full browsing list, and no real-world slowness has been measured yet —
  // this timing log exists so a future decision to paginate is based on
  // actual numbers from this user's data, not a guess. Purely local
  // (server log file), never sent anywhere external.
  route.get('/neurons/all-meta', (c) => {
    try {
      const dbStart = Date.now();
      const pages = getAllPagesMetaFromStore();
      const dbMs = Date.now() - dbStart;
      const serializeStart = Date.now();
      const response = c.json({ ok: true, pages });
      const serializeMs = Date.now() - serializeStart;
      if (logger && (dbMs > 200 || pages.length > 2000)) {
        logger.info({ route: '/neurons/all-meta', count: pages.length, db_ms: dbMs, serialize_ms: serializeMs }, 'neurons/all-meta timing');
      }
      return response;
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/neurons — list all pages (for remote clients)
  route.get('/neurons', (c) => {
    try {
      const pages = getAllPagesFromStore();
      return c.json({ ok: true, pages });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/neuron/:id — single page
  route.get('/neuron/:id', (c) => {
    const id = c.req.param('id');
    try {
      const page = getPageFromStore(id);
      if (!page) return c.json({ error: 'not found' }, 404);
      return c.json({ ok: true, page });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/neurons/sync — bulk upsert (migration IndexedDB → server)
  // Body: { pages: Page[] }
  route.post('/neurons/sync', async (c) => {
    try {
      const body = await c.req.json();
      const pages = Array.isArray(body?.pages) ? body.pages : [];
      let saved = 0;
      const db = getDatabase();
      const bulkSync = db.transaction(() => {
        for (const page of pages) {
          if (page?.id) { savePageToStoreIfNewer(page); saved++; }
        }
      });
      bulkSync();
      return c.json({ ok: true, saved });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // PUT /api/neuron/:id — save/update full page (sync from frontend)
  route.put('/neuron/:id', async (c) => {
    const id = c.req.param('id');
    let captureId;
    const started = performance.now();
    try {
      const body = await c.req.json();
      if (!body?.page?.id || body.page.id !== id) {
        return c.json({ error: 'payload invalide' }, 400);
      }
      captureId = typeof body.page.metadata?.captureId === 'string' ? body.page.metadata.captureId : undefined;
      const captureStatus = body.page.metadata?.captureStatus;
      const previousStatus = captureId ? getPageFromStore(id)?.metadata?.captureStatus : undefined;
      const captureTransition = !!captureId && captureStatus !== previousStatus;
      if (captureTransition && logger) logger.info({ captureId, neuronId: id, elapsedMs: 0 }, 'CAPTURE_SAVE_START');
      const saved = savePageToStoreIfNewer(body.page);
      if (captureTransition && logger) {
        const elapsedMs = Math.round(performance.now() - started);
        logger.info({ captureId, neuronId: id, elapsedMs, skipped: !saved }, 'CAPTURE_SAVE_DONE');
        if (captureStatus === 'READY') {
          logger.info({ captureId, neuronId: id, elapsedMs }, 'CAPTURE_READY');
        }
      }
      return c.json({ ok: true, skipped: !saved });
    } catch (error) {
      if (captureId && logger) {
        logger.error({ captureId, neuronId: id, elapsedMs: Math.round(performance.now() - started), error: error.message }, 'SAVE_FAILED');
      }
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/neurons/repair-links — rebuild channel/playlist↔video links from metadata
  route.post('/neurons/repair-links', (c) => {
    try {
      const result = repairLinksFromMetadata();
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // DELETE /api/neuron/:id — remove from LanceDB and pages store
  route.delete('/neuron/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const deleted = await services.deleteNeuron(id);
      deletePageFromStore(id);
      return c.json({ ok: true, deleted }, 200);
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  return route;
}
