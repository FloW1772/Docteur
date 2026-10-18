import { Hono } from 'hono';
import { toSafePublicError, SAFE_RUNTIME_UNAVAILABLE_MESSAGE } from '../lib/safe-error-contract.js'; // [SEC-REMED-4B]

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
      // [SEC-REMED-4B] answerQuestion throws a PublicError (stable code + Docteur text) for the failures it knows;
      // anything else is untrusted runtime / store text: a fixed message, 503 when the model runtime is unreachable.
      const safe = services.isOllamaError(error)
        ? toSafePublicError(error, { code: 'MODEL_RUNTIME_UNAVAILABLE', message: SAFE_RUNTIME_UNAVAILABLE_MESSAGE, status: 503 })
        : toSafePublicError(error, { code: 'ANSWER_FAILED', message: 'La réponse n’a pas pu être générée.', status: 500 });
      return c.json(safe.hint ? { error: safe.message, code: safe.code, hint: safe.hint } : { error: safe.message, code: safe.code }, safe.status);
    }
  });

  return route;
}
