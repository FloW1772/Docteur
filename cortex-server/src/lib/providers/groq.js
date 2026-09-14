import { guardCloudCall } from '../privacy-guard.js';
import { ErrorCategory, classifiedError, classifyHttpError, classifyNetworkError, parseRetryAfterMs } from '../provider-errors.js';

const GROQ_BASE       = 'https://api.groq.com/openai/v1';
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const TIMEOUT_MS      = 60_000;

async function groqFetch(apiKey, body) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res;
  } catch (networkErr) {
    throw classifiedError(`Groq: ${networkErr.message}`, classifyNetworkError(networkErr));
  } finally {
    clearTimeout(timer);
  }
}

export async function complete({ apiKey, messages, model }) {
  const resolvedModel = model || DEFAULT_MODEL;
  guardCloudCall({ messages, provider: 'groq', functionCalled: 'complete' });
  const res = await groqFetch(apiKey, {
    model:       resolvedModel,
    messages,
    temperature: 0.3,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const category = classifyHttpError(res.status, body);
    const err = classifiedError(
      `Groq ${res.status}: ${body?.error?.message ?? res.statusText}`,
      category,
    );
    err.isQuota = category === ErrorCategory.QUOTA_EXCEEDED || category === ErrorCategory.RATE_LIMITED;
    if (category === ErrorCategory.RATE_LIMITED) err.retryAfterMs = parseRetryAfterMs(res.headers, body);
    throw err;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text, model: `groq/${data.model ?? resolvedModel}` };
}

export async function testKey(apiKey, model) {
  const resolvedModel = model || DEFAULT_MODEL;
  const res = await groqFetch(apiKey, {
    model:      resolvedModel,
    messages:   [{ role: 'user', content: 'Réponds juste "OK".' }],
    max_tokens: 5,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const category = classifyHttpError(res.status, body);
    throw classifiedError(body?.error?.message ?? `HTTP ${res.status}`, category);
  }

  const data = await res.json();
  return { model: data.model ?? `groq/${resolvedModel}` };
}
