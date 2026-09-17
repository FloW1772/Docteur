// Sherlock OSINT route (Phase 7, MASTER mission). Every action here (install/
// uninstall/test/search) is triggered only by an explicit user action from
// the frontend — nothing in this file runs on a timer or at server startup.

import { Hono } from 'hono';
import crypto from 'node:crypto';
import {
  getInstallState, testInstall, startInstall, startUninstall,
  startSearch, cancelSearch,
} from '../lib/sherlock.js';
import { getJob } from './jobs.js';
import { savePageToStore } from '../lib/sqlite.js';

export function createSherlockRoute({ services, logger } = {}) {
  const app = new Hono();

  app.get('/sherlock/status', (c) => c.json(getInstallState()));

  app.post('/sherlock/test', async (c) => {
    try {
      const result = await testInstall();
      return c.json(result);
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 500);
    }
  });

  app.post('/sherlock/install', (c) => {
    try {
      const { jobId } = startInstall();
      return c.json({ jobId }, 202);
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/sherlock/uninstall', (c) => {
    try {
      const { jobId } = startUninstall();
      return c.json({ jobId }, 202);
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/sherlock/search', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const { jobId, username } = startSearch(body?.username, { timeoutSeconds: body?.timeoutSeconds });
      logger?.info({ jobId, usernameLength: username.length }, 'SHERLOCK_SEARCH_STARTED');
      return c.json({ jobId, username }, 202);
    } catch (error) {
      return c.json({ error: error.message }, 400);
    }
  });

  app.post('/sherlock/search/:jobId/cancel', (c) => {
    const result = cancelSearch(c.req.param('jobId'));
    return c.json(result);
  });

  app.get('/sherlock/search/:jobId', (c) => {
    const job = getJob(c.req.param('jobId'));
    if (!job) return c.json({ error: 'Job introuvable' }, 404);
    return c.json(job);
  });

  // Creates a neuron from one chosen OSINT hit. OSINT-derived neurons are
  // private/local_only by default (mission requirement) — never silently
  // cloud-eligible just because the source site itself is public.
  app.post('/sherlock/save-as-neuron', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { username, site, url } = body ?? {};
    if (!username || !site || !url) return c.json({ error: 'username, site et url requis' }, 400);

    const id = crypto.randomUUID();
    const title = `OSINT: ${username} sur ${site}`;
    const content = `Résultat de recherche OSINT (Sherlock) pour le nom d'utilisateur "${username}".\nSite: ${site}\nURL: ${url}`;
    const now = Date.now();
    const metadata = { source: 'osint_sherlock', egress_policy: 'local_only', site, url, username };

    try {
      await services.indexNeuron({ id, kind: 'note', title, content, metadata });
      savePageToStore({
        id, title, kind: 'note', blocks: [{ id: crypto.randomUUID(), type: 'paragraph', content }],
        private: true, createdAt: now, updatedAt: now, metadata,
      });
      logger?.info({ id, site }, 'SHERLOCK_NEURON_CREATED');
      return c.json({ id }, 201);
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  return app;
}
