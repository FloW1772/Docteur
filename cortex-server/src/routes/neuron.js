import { Hono } from 'hono';
import {
  savePageToStoreIfNewer, deletePageFromStore, getAllPagesFromStore, getPageFromStore, repairLinksFromMetadata,
  getDatabase,
} from '../lib/sqlite.js';

export function createNeuronRoute({ services }) {
  const route = new Hono();

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
    try {
      const body = await c.req.json();
      if (!body?.page?.id || body.page.id !== id) {
        return c.json({ error: 'payload invalide' }, 400);
      }
      const saved = savePageToStoreIfNewer(body.page);
      return c.json({ ok: true, skipped: !saved });
    } catch (error) {
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
