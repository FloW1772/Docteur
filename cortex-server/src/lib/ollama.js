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

export async function chatCompletion(client, modelName, messages) {
  const response = await client.chat({
    model:      modelName,
    messages,
    stream:     false,
    keep_alive: '15m',  // keep model in VRAM between requests — avoids 10-13s reload
    options: {
      temperature: 0.2,
    },
  });

  return response?.message?.content ?? response?.response ?? '';
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
