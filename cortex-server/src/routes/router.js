import { Hono } from 'hono';
import { getModelStatuses } from '../lib/router.js';
import {
  getRouterSettings, getRouterStats, setRouterSettings,
  getCloudKeys, setCloudKey, getCloudKeysMasked, getCloudStatsThisMonth,
  getSiteShortcuts, setSiteShortcut, deleteSiteShortcut,
} from '../lib/sqlite.js';
import { getPersonaSettings, updatePersonaSettings } from '../lib/persona.js';
import { testKey as testGemini }     from '../lib/providers/gemini.js';
import { testKey as testGroq }       from '../lib/providers/groq.js';
import { testKey as testOpenRouter } from '../lib/providers/openrouter.js';
import { testKey as testAnthropic }  from '../lib/providers/anthropic.js';
import { testKey as testOpenAI }     from '../lib/providers/openai.js';

const TESTERS = {
  gemini:     testGemini,
  groq:       testGroq,
  openrouter: testOpenRouter,
  anthropic:  testAnthropic,
  openai:     testOpenAI,
};

export function createRouterRoute({ services }) {
  const route = new Hono();

  // GET /api/router/status
  route.get('/router/status', async (c) => {
    try {
      const ollama = await services.ollamaHealth();
      const installedNames = ollama.models.map(m => m.name);
      const statuses = getModelStatuses(installedNames);
      const settings = getRouterSettings();
      return c.json({
        statuses,
        settings,
        ollama_connected: ollama.connected,
        cloud_keys: getCloudKeysMasked(),
      });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/router/settings
  route.get('/router/settings', (c) => c.json(getRouterSettings()));

  // POST /api/router/settings
  route.post('/router/settings', async (c) => {
    try {
      const body = await c.req.json();
      setRouterSettings(body);
      return c.json({ ok: true, settings: getRouterSettings() });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/router/cloud-keys — returns masked keys only
  route.get('/router/cloud-keys', (c) => {
    return c.json(getCloudKeysMasked());
  });

  // POST /api/router/cloud-keys — save a key for one provider
  // Body: { provider: 'gemini' | 'openrouter' | 'anthropic' | 'openai', key: string }
  route.post('/router/cloud-keys', async (c) => {
    try {
      const { provider, key } = await c.req.json();
      if (!['gemini', 'groq', 'openrouter', 'anthropic', 'openai'].includes(provider)) {
        return c.json({ error: 'provider invalide' }, 400);
      }
      setCloudKey(provider, key ?? '');
      return c.json({ ok: true, masked: getCloudKeysMasked() });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/router/test/:provider — validates a key with a real mini-call
  route.post('/router/test/:provider', async (c) => {
    const provider = c.req.param('provider');
    const tester = TESTERS[provider];
    if (!tester) return c.json({ error: 'provider inconnu' }, 400);

    try {
      const { key } = await c.req.json();
      const apiKey = key || getCloudKeys()[`${provider}_key`];
      if (!apiKey) return c.json({ ok: false, error: 'Aucune clé configurée' }, 400);

      const groqModel = provider === 'groq' ? getRouterSettings().groq_model : undefined;
      const result = await tester(apiKey, groqModel);
      return c.json({ ok: true, model: result.model });
    } catch (error) {
      // Never expose the key in the error message
      const safe = error.message.replace(/key=[A-Za-z0-9_-]+/gi, 'key=***');
      return c.json({ ok: false, error: safe });
    }
  });

  // GET /api/router/gemini-rpm
  route.get('/router/gemini-rpm', (c) => {
    const settings = getRouterSettings();
    return c.json({ rpm: settings.gemini_rpm ?? 10 });
  });

  // POST /api/router/gemini-rpm — body: { rpm: number }
  route.post('/router/gemini-rpm', async (c) => {
    try {
      const { rpm } = await c.req.json();
      const n = Math.max(1, Math.min(60, Number(rpm)));
      if (Number.isNaN(n)) return c.json({ error: 'rpm invalide' }, 400);
      setRouterSettings({ gemini_rpm: n });
      return c.json({ ok: true, rpm: n });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/router/stats
  route.get('/router/stats', (c) => {
    try {
      const stats      = getRouterStats();
      const cloudMonth = getCloudStatsThisMonth();
      return c.json({ stats, cloud_month: cloudMonth });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // ── Site shortcuts ──────────────────────────────────────────────────────────

  route.get('/shortcuts', (c) => {
    return c.json(getSiteShortcuts());
  });

  route.post('/shortcuts', async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = String(body?.name ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const url  = String(body?.url  ?? '').trim();

    if (!name || /\s/.test(name)) return c.json({ error: 'Nom invalide (pas d\'espace, non vide)' }, 400);

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: 'URL invalide' }, 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.json({ error: 'URL invalide — uniquement http/https' }, 400);
    }

    setSiteShortcut(name, url);
    return c.json({ ok: true, shortcuts: getSiteShortcuts() });
  });

  route.delete('/shortcuts/:name', (c) => {
    const name = decodeURIComponent(c.req.param('name')).toLowerCase();
    deleteSiteShortcut(name);
    return c.json({ ok: true, shortcuts: getSiteShortcuts() });
  });

  // ── Persona settings ────────────────────────────────────────────────────────

  route.get('/persona/settings', (c) => {
    return c.json(getPersonaSettings());
  });

  route.post('/persona/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const updates = {};
    if (typeof body.vouvoiement === 'boolean') updates.vouvoiement = body.vouvoiement;
    const updated = updatePersonaSettings(updates);
    return c.json(updated);
  });

  return route;
}
