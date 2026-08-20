// Anthropic Claude API provider (paying)
// Docs: https://docs.anthropic.com/en/api/messages

import { guardCloudCall } from '../privacy-guard.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

export const PROVIDER_ID = 'anthropic';
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];

// Converts Ollama-style messages to Anthropic format.
// Anthropic uses a separate `system` string — system role messages are merged.
function toAnthropicMessages(messages) {
  const systemParts = [];
  const userMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
    } else {
      userMessages.push({ role: msg.role, content: msg.content });
    }
  }
  return { system: systemParts.join('\n\n') || undefined, messages: userMessages };
}

export async function complete({ apiKey, model = DEFAULT_MODEL, messages, maxTokens = 4096 }) {
  guardCloudCall({ messages, provider: 'anthropic', functionCalled: 'complete' });
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

  const body = { model, messages: anthropicMessages, max_tokens: maxTokens };
  if (system) body.system = system;

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Anthropic ${res.status}: ${err?.error?.message ?? res.statusText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? '';
  if (!text) throw new Error('Anthropic: réponse vide');

  return {
    text,
    model,
    usage: {
      input_tokens:  data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
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
