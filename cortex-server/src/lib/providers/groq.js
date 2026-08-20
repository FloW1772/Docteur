import { guardCloudCall } from '../privacy-guard.js';

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
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Groq : clé API invalide (401)');
    if (res.status === 404) throw new Error(`Groq : modèle ${resolvedModel} introuvable (404)`);
    if (res.status === 429) {
      const e = new Error('Groq : quota atteint (429)');
      e.isQuota = true;
      throw e;
    }
    throw new Error(`Groq HTTP ${res.status} : ${err?.error?.message ?? 'erreur inconnue'}`);
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
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
  }

  const data = await res.json();
  return { model: data.model ?? `groq/${resolvedModel}` };
}
