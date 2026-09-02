import { Hono } from 'hono';
import {
  getActivityLog, getActivityLogOpTypes, getActivityLogStats, getAllActivityLogForExport,
  clearActivityLog, setActivityLogRetentionDays, purgeActivityLogOlderThan,
} from '../lib/sqlite.js';

// The activity journal never leaves this machine — reject anything that
// didn't arrive via localhost, even when LOCAL_NETWORK=true exposes the rest
// of the API to the LAN for mobile access.
function isLocalhostRequest(c) {
  const host = (c.req.header('host') ?? '').split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function createActivityRoute({ logger }) {
  const route = new Hono();

  route.use('/activity/*', async (c, next) => {
    if (!isLocalhostRequest(c)) {
      logger?.warn({ host: c.req.header('host') }, 'activity log: non-localhost request rejected');
      return c.json({ error: 'Journal accessible uniquement en local' }, 403);
    }
    await next();
  });

  // GET /api/activity/log — liste paginée + filtres
  route.get('/activity/log', (c) => {
    const query = c.req.query();
    const { rows, total } = getActivityLog({
      opType: query.opType || undefined,
      result: query.result || undefined,
      from:   query.from   || undefined,
      to:     query.to     || undefined,
      q:      query.q      || undefined,
      limit:  query.limit  ? Number(query.limit)  : 50,
      offset: query.offset ? Number(query.offset) : 0,
    });
    return c.json({ rows, total });
  });

  // GET /api/activity/op-types — valeurs distinctes pour le filtre "type"
  route.get('/activity/op-types', (c) => {
    return c.json({ opTypes: getActivityLogOpTypes() });
  });

  // GET /api/activity/stats — taille occupée + rétention actuelle
  route.get('/activity/stats', (c) => {
    return c.json(getActivityLogStats());
  });

  // PUT /api/activity/retention — change la durée de rétention (jours), purge immédiatement
  route.put('/activity/retention', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const days = setActivityLogRetentionDays(body?.days);
    const purged = purgeActivityLogOlderThan(days);
    return c.json({ ok: true, retentionDays: days, purged });
  });

  // DELETE /api/activity/log — vide le journal (confirmation requise côté client)
  route.delete('/activity/log', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body?.confirm !== true) {
      return c.json({ error: 'Confirmation requise (confirm: true)' }, 400);
    }
    const deleted = clearActivityLog();
    return c.json({ ok: true, deleted });
  });

  // GET /api/activity/export — export JSON complet, pour diagnostic local uniquement
  route.get('/activity/export', (c) => {
    const entries = getAllActivityLogForExport();
    return c.json({
      exported_at: new Date().toISOString(),
      count: entries.length,
      warning: 'Ce fichier peut contenir des titres de vos neurones. Ne le partagez pas sans le relire.',
      entries,
    });
  });

  return route;
}
