// Browser selection route (Phase 6, MASTER mission).

import { Hono } from 'hono';
import {
  detectInstalledBrowsers, getBrowserSettings, setBrowserSettings,
  validateCustomBrowserPath, openUrlInSelectedBrowser,
} from '../lib/browser.js';

export function createBrowserRoute({ logger } = {}) {
  const app = new Hono();

  app.get('/browser/installed', (c) => c.json({ browsers: detectInstalledBrowsers() }));

  app.get('/browser/settings', (c) => c.json(getBrowserSettings()));

  app.put('/browser/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const selected = String(body?.selected ?? '').trim();
    if (!selected) return c.json({ error: 'selected requis' }, 400);

    if (selected === 'custom') {
      try {
        const verifiedPath = validateCustomBrowserPath(body?.customPath);
        const settings = setBrowserSettings({ selected: 'custom', customPath: verifiedPath });
        return c.json(settings);
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
    }

    const installed = detectInstalledBrowsers();
    if (selected !== 'system' && !installed.some(b => b.id === selected)) {
      return c.json({ error: `Navigateur '${selected}' non détecté sur cette machine.` }, 400);
    }
    const settings = setBrowserSettings({ selected, customPath: null });
    return c.json(settings);
  });

  // Opens a URL in the currently selected browser. Strict validation
  // (http/https only) happens inside openUrlInSelectedBrowser() — this
  // route never spawns anything on its own.
  app.post('/browser/open', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = openUrlInSelectedBrowser(body?.url);
      logger?.info({ url: result.url }, 'BROWSER_OPEN_OK');
      return c.json(result);
    } catch (error) {
      logger?.warn({ error: error.message }, 'BROWSER_OPEN_FAILED');
      return c.json({ error: error.message }, 400);
    }
  });

  return app;
}
