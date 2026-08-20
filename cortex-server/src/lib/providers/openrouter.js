// OpenRouter — DERNIER RECOURS, modèle gratuit fixe uniquement.
// Le modèle est câblé en dur avec le suffixe :free.
// Tout échec → throw immédiat → le router bascule sur le local.
// Aucune sélection dynamique de modèle n'est possible.

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS      = 90_000;

// Modèle gratuit fixe : 120B paramètres, 262K contexte, ~72 t/s.
// Le suffixe :free est OBLIGATOIRE — OpenRouter refuse de facturer ces requêtes.
const FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

export const PROVIDER_ID = 'openrouter';

// Protection anti-facturation : bloque si le modèle ne termine pas par :free.
// Ce contrôle est effectué avant chaque requête réseau.
function assertFreeModel(model) {
  if (!model.endsWith(':free')) {
    throw new Error(
      `OpenRouter : modèle non gratuit bloqué (${model}). ` +
      'Seuls les modèles :free sont autorisés dans Docteur.',
    );
  }
}

async function orFetch(apiKey, body) {
  assertFreeModel(body.model);
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'http://localhost:5173',
        'X-Title':       'Docteur',
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

import { guardCloudCall } from '../privacy-guard.js';

// Pas de paramètre model — toujours FREE_MODEL, jamais d'override.
// En cas d'erreur (quota 429, 404, indispo) → throw immédiat sans retry OR.
export async function complete({ apiKey, messages }) {
  guardCloudCall({ messages, provider: 'openrouter', functionCalled: 'complete' });
  const res = await orFetch(apiKey, {
    model:      FREE_MODEL,
    messages,
    max_tokens: 4096,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 429) {
      const e = new Error(`OpenRouter : quota atteint (429) — ${FREE_MODEL}`);
      e.isQuota = true;
      throw e;
    }
    throw new Error(`OpenRouter ${res.status}: ${err?.error?.message ?? res.statusText}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('OpenRouter: réponse vide');

  return {
    text,
    model: `openrouter/${data.model ?? FREE_MODEL}`,
    usage: {
      input_tokens:  data.usage?.prompt_tokens  ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

export async function testKey(apiKey) {
  const res = await orFetch(apiKey, {
    model:      FREE_MODEL,
    messages:   [{ role: 'user', content: 'Réponds juste "ok".' }],
    max_tokens: 8,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
  }

  const data = await res.json();
  return { model: data.model ?? FREE_MODEL };
}
