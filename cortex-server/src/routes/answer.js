import { Hono } from 'hono';

export function createAnswerRoute({ services }) {
  const route = new Hono();

  route.post('/answer', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.question) {
      return c.json({ error: 'Payload invalide. Champ requis: question.' }, 400);
    }

    c.set('requestPayload', body);
    c.set('modelUsed', services.answerModel);

    try {
      const result = await services.answerQuestion(body);
      return c.json(result, 200);
    } catch (error) {
      const status = services.isOllamaError(error) ? 503 : 500;
      return c.json({ error: error.message }, status);
    }
  });

  return route;
}
