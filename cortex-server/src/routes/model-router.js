// Model Router V1 — HTTP layer. Registry (read), dry-run route decision, and a
// single user-initiated run on the decided route (no other provider tried).
import { Hono } from 'hono';
import {
  ModelRouteError, buildRegistry, selectRoute, executeRoute, collectOllamaInventory, collectCloudProviders,
} from '../lib/model-router.js';

const MAX_PROMPT_CHARS = 4_000;

/**
 * deps: { client, getSettings(), getKeys(), getHardware() → Promise<profile|null>,
 *         isPairConfigured() → Promise<boolean>, logger }
 */
export function createModelRouterRoute({ client, getSettings, getKeys, getHardware = async () => null, isPairConfigured = async () => false, logger = null }) {
  const route = new Hono();

  async function snapshot() {
    const settings = getSettings();
    const [runtime, hardware, pairConfigured, cloud] = await Promise.all([
      collectOllamaInventory(client),
      getHardware().catch(() => null),
      isPairConfigured().catch(() => false),
      collectCloudProviders({ keys: getKeys(), settings, logger }).catch(() => []),
    ]);
    return { settings, cloud, registry: buildRegistry({ runtime, hardware, settings, cloud, pair: { configured: pairConfigured } }) };
  }

  const fail = (c, err) => {
    if (err instanceof ModelRouteError) return c.json({ ok: false, error: { code: err.code, message: err.message, hint: err.hint ?? null } }, err.status);
    logger?.error?.({ err: err?.message }, 'model-router route error');
    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne du routeur de modèles.' } }, 500);
  };
  const body = async (c) => { try { return await c.req.json(); } catch { return {}; } };
  const request = (b) => ({ capabilities: b.capabilities, mode: b.mode === 'manual' ? 'manual' : 'auto', provider: b.provider ?? null, model: b.model ?? null, allowCloud: b.allowCloud !== false });

  route.get('/model-router/registry', async (c) => {
    try { return c.json({ ok: true, ...(await snapshot()).registry }); } catch (err) { return fail(c, err); }
  });

  route.post('/model-router/route', async (c) => {
    try {
      const { registry, settings } = await snapshot();
      const decision = selectRoute(registry, { ...request(await body(c)), settings });
      return c.json(decision, decision.ok ? 200 : 422);
    } catch (err) { return fail(c, err); }
  });

  route.post('/model-router/run', async (c) => {
    try {
      const b = await body(c);
      const prompt = String(b.prompt ?? '').trim();
      if (!prompt) throw new ModelRouteError('PROMPT_REQUIRED', 'Saisissez un message à envoyer au modèle.', { status: 400 });
      if (prompt.length > MAX_PROMPT_CHARS) throw new ModelRouteError('PROMPT_TOO_LONG', `Message limité à ${MAX_PROMPT_CHARS} caractères.`, { status: 400 });
      const { registry, settings, cloud } = await snapshot();
      const decision = selectRoute(registry, { ...request(b), settings });
      if (!decision.ok) return c.json(decision, 422);
      const responseFormat = b.responseFormat === 'json' ? 'json' : 'text';
      const result = await executeRoute(decision, {
        messages: [{ role: 'user', content: prompt }], responseFormat, runtimeOptions: b.runtimeOptions, timeoutMs: b.timeoutMs, registry,
      }, {
        client,
        cloudCall: async (providerId, messages) => {
          const candidate = (cloud ?? []).find(x => x.providerId === providerId);
          if (!candidate) throw new ModelRouteError('PROVIDER_UNAVAILABLE', 'Provider cloud non disponible.');
          return candidate.call(messages);
        },
      });
      return c.json({ ok: true, decision: decision.decision, warnings: decision.warnings, result });
    } catch (err) { return fail(c, err); }
  });

  return route;
}
