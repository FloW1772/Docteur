import { Ollama } from 'ollama';

export function createOllamaClient(baseUrl) {
  return new Ollama({ host: baseUrl });
}

export async function getInstalledModels(client) {
  const response = await client.list();
  const models = response?.models ?? [];
  return models.map((model) => ({
    name: model.name ?? model.model ?? '',
    size: model.size,
    modified_at: model.modified_at
  })).filter((model) => model.name);
}

export async function verifyModelAvailability(client, modelName) {
  const models = await getInstalledModels(client);
  return models.some((model) => model.name === modelName || model.name.startsWith(`${modelName}:`) || model.name.startsWith(`${modelName}@`));
}

// keep_alive: keep nomic-embed-text resident in VRAM between calls.
// At ~270 MB it coexists with qwen2.5:7b (~4.4 GB) on an 8 GB card — no eviction.
export async function embedText(client, modelName, text, keepAlive = '30m') {
  const response = await client.embed({
    model:      modelName,
    input:      text,
    keep_alive: keepAlive,
  });

  const vector = response?.embeddings?.[0] ?? null;
  if (!Array.isArray(vector)) {
    throw new Error('Ollama embeddings response missing vector');
  }

  return vector;
}

// `extra` (Model Router V1, optional): real Ollama runtime options validated by
// the caller (num_ctx, num_gpu) and `format` for structured output. Callers
// that pass nothing keep the exact previous request.
export async function chatCompletion(client, modelName, messages, extra = {}) {
  const response = await client.chat({
    model:      modelName,
    messages,
    stream:     false,
    keep_alive: '15m',  // keep model in VRAM between requests — avoids 10-13s reload
    options: {
      temperature: 0.2,
      ...(extra.options ?? {}),
    },
    ...(extra.format ? { format: extra.format } : {}),
  });

  return response?.message?.content ?? response?.response ?? '';
}

// [Companion COMP-4 / D2] Additive. Same request as chatCompletion (same body, same defaults), plus:
//   • `extra.signal` (optional AbortSignal) really aborts the HTTP request. ollama-js 0.5.x only aborts STREAMED requests
//     (client.abort()); a non-streamed request is bound to the signal through a request-scoped client that shares the
//     host / headers / fetch of the given one and carries the signal on its fetch. Injected test doubles may expose
//     `withSignal(signal)`. When neither is possible, `abortPropagated` is false (the caller still reports CANCELLED).
//   • the response metadata the runtime returns: the model that actually answered and token counts (null when absent).
// chatCompletion itself is unchanged; callers that do not use this function see no difference.
export function bindRequestSignal(client, signal) {
  if (!signal) return { target: client, abortPropagated: null };
  if (typeof client?.withSignal === 'function') return { target: client.withSignal(signal), abortPropagated: true };
  if (client instanceof Ollama) {
    const base = client.fetch ?? fetch;
    const scoped = new Ollama({
      host: client.config.host, headers: client.config.headers,
      fetch: (url, init = {}) => base(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal }),
    });
    return { target: scoped, abortPropagated: true };
  }
  return { target: client, abortPropagated: false };
}

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
export async function chatCompletionDetailed(client, modelName, messages, extra = {}) {
  const { target, abortPropagated } = bindRequestSignal(client, extra.signal ?? null);
  const response = await target.chat({
    model:      modelName,
    messages,
    stream:     false,
    keep_alive: '15m',
    options: {
      temperature: 0.2,
      ...(extra.options ?? {}),
    },
    ...(extra.format ? { format: extra.format } : {}),
  });
  const inputTokens = count(response?.prompt_eval_count);
  const outputTokens = count(response?.eval_count);
  // a non-text content (malformed payload) is an empty answer → INVALID_RESPONSE upstream, never "[object Object]"
  const content = typeof response?.message?.content === 'string' ? response.message.content : (typeof response?.response === 'string' ? response.response : '');
  return {
    text: content,
    model: typeof response?.model === 'string' && response.model ? response.model : null,
    doneReason: typeof response?.done_reason === 'string' ? response.done_reason : null,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null },
    abortPropagated,
  };
}

// Unload a model from VRAM. Used before loading 14b to free VRAM on 8 GB cards.
export async function unloadModel(client, modelName) {
  try {
    await client.chat({
      model:      modelName,
      messages:   [{ role: 'user', content: '' }],
      stream:     false,
      keep_alive: 0,
    });
  } catch { /* model may not be loaded — ignore */ }
}

// Like chatCompletion but releases VRAM immediately after inference (keep_alive=0).
// Used for qwen2.5:14b so it doesn't stay resident and block the 7b model.
export async function chatCompletionPowerful(client, modelName, messages) {
  const response = await client.chat({
    model:      modelName,
    messages,
    stream:     false,
    keep_alive: 0,
    options: {
      temperature: 0.2,
    },
  });

  return response?.message?.content ?? response?.response ?? '';
}
