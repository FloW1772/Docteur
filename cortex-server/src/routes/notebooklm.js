// NotebookLM (Google) — FUTURE integration, NOT ACTIVE (Phase 5B, MASTER
// mission). This route ONLY stores/deletes an API key via the existing
// DPAPI secret store and reports whether one is configured. It NEVER makes
// a network call to any Google/NotebookLM endpoint — there is no fetch(),
// no health-check, no background call anywhere in this file or reachable
// from it. A key saved here is inert: "Clé enregistrée pour une future
// intégration. Aucun appel API NotebookLM n'est effectué actuellement."
//
// See lib/notebook-provider.js for the NotebookProvider abstraction that
// documents *why* — any future real integration must go through that
// abstraction's 'notebooklm_future' provider, which currently always
// reports available:false, reason:'API_NOT_SUPPORTED'.

import { Hono } from 'hono';
import { setSecret, deleteSecret, hasSecret } from '../lib/secret-store.js';
import { NOTEBOOK_PROVIDERS } from '../lib/notebook-provider.js';

export function createNotebookLmRoute({ logger } = {}) {
  const app = new Hono();

  app.get('/notebooklm/status', (c) => c.json({
    key_configured: hasSecret('notebooklm_key'),
    providers: NOTEBOOK_PROVIDERS,
    notice: 'Clé enregistrée pour une future intégration. Aucun appel API NotebookLM n\'est effectué actuellement.',
  }));

  app.post('/notebooklm/key', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = String(body?.key ?? '').trim();
    if (!key) return c.json({ error: 'key requis' }, 400);
    setSecret('notebooklm_key', key);
    logger?.info({}, 'NOTEBOOKLM_KEY_SAVED');
    return c.json({ ok: true, key_configured: true });
  });

  app.delete('/notebooklm/key', (c) => {
    deleteSecret('notebooklm_key');
    logger?.info({}, 'NOTEBOOKLM_KEY_DELETED');
    return c.json({ ok: true, key_configured: false });
  });

  return app;
}
