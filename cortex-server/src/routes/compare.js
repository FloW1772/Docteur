import { Hono } from 'hono';
import { stream } from 'hono/streaming';

export function createCompareRoute({ services }) {
  const route = new Hono();

  // POST /api/compare — SSE: run one question against multiple models simultaneously
  route.post('/compare', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.question) return c.json({ error: 'question requise' }, 400);

    const models = Array.isArray(body.models) ? body.models.slice(0, 5) : [];
    if (models.length === 0) return c.json({ error: 'models requis' }, 400);

    return stream(c, async (s) => {
      const send = (data) => s.write(`data: ${JSON.stringify(data)}\n\n`);
      try {
        await services.compareModels({
          question:    String(body.question),
          models,
          max_context: Number(body.max_context ?? 5),
          onEvent:     send,
        });
      } catch (err) {
        await send({ type: 'error', model_id: null, error: err.message });
        await send({ type: 'done' });
      }
    });
  });

  return route;
}
