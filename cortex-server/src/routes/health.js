import { Hono } from 'hono';

export function createHealthRoute({ services }) {
  const route = new Hono();

  route.get('/ping', (c) => c.json({ ok: true }));

  route.get('/health', async (c) => {
    const result = await services.healthSnapshot();
    c.set('modelUsed', 'health-check');
    const statusCode = result.ollama_connected ? 200 : 503;
    return c.json(result, statusCode);
  });

  return route;
}
