import { Hono } from 'hono';
import fs from 'node:fs';
import { getInboxSettings, updateInboxSettings, runInboxCheck } from '../lib/inbox-watcher.js';
import { getInboxPending, markInboxConsumed, insertActivityLog } from '../lib/sqlite.js';

export function createInboxRoute({ defaultDir, logger } = {}) {
  const route = new Hono();

  // GET /api/inbox/settings
  route.get('/inbox/settings', (c) => {
    return c.json(getInboxSettings(defaultDir));
  });

  // POST /api/inbox/settings
  route.post('/inbox/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const allowed = ['enabled', 'inbox_dir', 'frequency'];
    const updates = {};
    for (const k of allowed) if (body[k] !== undefined) updates[k] = body[k];
    const updated = updateInboxSettings(updates, defaultDir);
    // Ensure inbox dir exists when enabling
    if (updated.enabled) {
      try { fs.mkdirSync(updated.inbox_dir || defaultDir, { recursive: true }); } catch { /* non-fatal */ }
    }
    return c.json(updated);
  });

  // POST /api/inbox/check — manual trigger from Settings "Vérifier maintenant"
  route.post('/inbox/check', async (c) => {
    const settings = getInboxSettings(defaultDir);
    if (!settings.enabled) return c.json({ error: 'Dossier surveillé désactivé.' }, 400);
    const dir = settings.inbox_dir || defaultDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const result = await runInboxCheck({ inboxDir: dir, logger });
      if (result.processed > 0 || result.errors > 0) {
        insertActivityLog({
          opType: 'inbox_import', item: `${result.processed} fichier(s)`,
          result: result.errors === 0 ? 'success' : 'failure',
          reason: result.errors > 0 ? `${result.errors} fichier(s) en échec` : null,
        });
      }
      return c.json(result);
    } catch (err) {
      insertActivityLog({ opType: 'inbox_import', item: dir, result: 'failure', reason: err.message ?? 'Erreur' });
      return c.json({ error: err.message ?? 'Erreur' }, 500);
    }
  });

  // GET /api/inbox/pending — pending outputs waiting for frontend to create pages
  route.get('/inbox/pending', (c) => {
    return c.json(getInboxPending());
  });

  // POST /api/inbox/pending/:id/consume — frontend marks item consumed after page creation
  route.post('/inbox/pending/:id/consume', (c) => {
    const id = c.req.param('id');
    markInboxConsumed(id);
    return c.json({ ok: true });
  });

  return route;
}
