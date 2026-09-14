// OpenAI API provider (paying)
// Docs: https://platform.openai.com/docs/api-reference/chat

import { guardCloudCall } from '../privacy-guard.js';
import { ErrorCategory, classifiedError, classifyHttpError, classifyNetworkError, parseRetryAfterMs } from '../provider-errors.js';

const OPENAI_BASE = 'https://api.openai.com/v1';

export const PROVIDER_ID = 'openai';
export const DEFAULT_MODEL = 'gpt-4o-mini';
export const MODELS = ['gpt-4o-mini', 'gpt-4o'];

export async function complete({ apiKey, model = DEFAULT_MODEL, messages, maxTokens = 4096 }) {
  guardCloudCall({ messages, provider: 'openai', functionCalled: 'complete' });

  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body:   JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (networkErr) {
    throw classifiedError(`OpenAI: ${networkErr.message}`, classifyNetworkError(networkErr));
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const category = classifyHttpError(res.status, body);
    const err = classifiedError(`OpenAI ${res.status}: ${body?.error?.message ?? res.statusText}`, category);
    err.isQuota = category === ErrorCategory.QUOTA_EXCEEDED || category === ErrorCategory.RATE_LIMITED;
    if (category === ErrorCategory.RATE_LIMITED) err.retryAfterMs = parseRetryAfterMs(res.headers, body);
    throw err;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw classifiedError('OpenAI: réponse vide', ErrorCategory.UNKNOWN);

  return {
    text,
    model,
    usage: {
      input_tokens:  data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

export async function testKey(apiKey) {
  const res = await complete({
    apiKey,
    model: DEFAULT_MODEL,
    messages: [{ role: 'user', content: 'Réponds juste "ok".' }],
    maxTokens: 8,
  });
  return { ok: true, model: res.model };
}
