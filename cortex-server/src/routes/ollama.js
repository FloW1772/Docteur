import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function buildBaseUrl(baseUrl) {
  return String(baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
}

function isValidModelName(name) {
  return MODEL_NAME_PATTERN.test(String(name ?? '').trim());
}

function normalizeComparableName(name) {
  return String(name ?? '').trim().split('@')[0];
}

function sameModelGroup(a, b) {
  const left = normalizeComparableName(a);
  const right = normalizeComparableName(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const [leftBase, leftTag = ''] = left.split(':');
  const [rightBase, rightTag = ''] = right.split(':');
  if (leftBase !== rightBase) return false;
  if (!leftTag || !rightTag) return true;
  return leftTag === rightTag;
}

function getModelStorePath() {
  const configured = process.env.OLLAMA_MODELS?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), '.ollama', 'models');
}

function getFreeBytes() {
  const modelPath = getModelStorePath();
  const probePath = fs.existsSync(modelPath) ? modelPath : path.dirname(modelPath);
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stats = fs.statfsSync(probePath);
    const freeBlocks = Number(stats.bavail ?? stats.bfree ?? 0);
    const blockSize = Number(stats.bsize ?? stats.frsize ?? 0);
    if (!freeBlocks || !blockSize) return null;
    return freeBlocks * blockSize;
  } catch {
    return null;
  }
}

async function readJsonResponse(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function fetchOllamaJson(baseUrl, endpoint, init = {}) {
  const response = await fetch(`${buildBaseUrl(baseUrl)}${endpoint}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const payload = await readJsonResponse(response);
  return { response, payload };
}

function buildGuardedModels(services) {
  const guarded = services.getProtectedModels?.() ?? [];
  return Array.from(new Set(guarded.filter(Boolean)));
}

export function createOllamaRoute({ services }) {
  const route = new Hono();

  // GET /api/ollama/models
  route.get('/ollama/models', async (c) => {
    const guardedModels = buildGuardedModels(services);
    try {
      const { response, payload } = await fetchOllamaJson(services.ollamaUrl, '/api/tags', { method: 'GET' });
      if (!response.ok) {
        return c.json({
          connected: false,
          models: [],
          total_size: 0,
          free_bytes: getFreeBytes(),
          guarded_models: guardedModels,
          error: payload?.error ?? response.statusText ?? 'Ollama indisponible',
        });
      }

      const models = Array.isArray(payload?.models) ? payload.models : [];
      const normalized = models.map((model) => ({
        name: String(model?.name ?? model?.model ?? '').trim(),
        model: String(model?.model ?? model?.name ?? '').trim(),
        modified_at: model?.modified_at ?? null,
        size: Number(model?.size ?? 0),
        digest: model?.digest ?? undefined,
        details: model?.details ?? undefined,
      })).filter((model) => model.name);

      return c.json({
        connected: true,
        models: normalized,
        total_size: normalized.reduce((sum, model) => sum + (Number.isFinite(model.size) ? model.size : 0), 0),
        free_bytes: getFreeBytes(),
        guarded_models: guardedModels,
      });
    } catch (error) {
      return c.json({
        connected: false,
        models: [],
        total_size: 0,
        free_bytes: getFreeBytes(),
        guarded_models: guardedModels,
        error: error?.message ?? 'Ollama est indisponible',
      });
    }
  });

  // POST /api/ollama/pull
  route.post('/ollama/pull', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const model = String(body?.model ?? '').trim();
    if (!isValidModelName(model)) {
      return c.json({ error: 'Nom de modèle invalide' }, 400);
    }

    const controller = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true });

    let upstream;
    try {
      upstream = await fetch(`${buildBaseUrl(services.ollamaUrl)}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal: controller.signal,
      });
    } catch (error) {
      return c.json({ error: error?.message ?? 'Ollama est indisponible' }, 503);
    }

    if (!upstream.ok || !upstream.body) {
      const payload = await readJsonResponse(upstream).catch(() => ({}));
      return c.json({ error: payload?.error ?? upstream.statusText ?? 'Pull Ollama impossible' }, upstream.status || 500);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const event = JSON.parse(trimmed);
                if (event?.error) {
                  throw new Error(event.error);
                }
                if (event?.done || event?.status === 'success') {
                  finished = true;
                }
              } catch (error) {
                if (error instanceof SyntaxError) continue;
                throw error;
              }
            }
          }
          if (buffer.trim()) {
            try {
              const event = JSON.parse(buffer.trim());
              if (event?.error) throw new Error(event.error);
              if (event?.done || event?.status === 'success') finished = true;
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
            }
          }
          if (finished) services.invalidateInstalledModelCache?.();
          controller.close();
        } catch (error) {
          controller.error(error);
          reader.cancel().catch(() => {});
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    });

    return new Response(stream, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  });

  // DELETE /api/ollama/delete
  route.delete('/ollama/delete', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const model = String(body?.model ?? '').trim();
    if (!isValidModelName(model)) {
      return c.json({ error: 'Nom de modèle invalide' }, 400);
    }

    const guardedModels = buildGuardedModels(services);
    if (guardedModels.some((guarded) => sameModelGroup(guarded, model))) {
      return c.json({ error: 'Suppression refusée : ce modèle est utilisé par la configuration actuelle.' }, 409);
    }

    let response;
    try {
      response = await fetch(`${buildBaseUrl(services.ollamaUrl)}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: c.req.raw.signal,
      });
    } catch (error) {
      return c.json({ error: error?.message ?? 'Ollama est indisponible' }, 503);
    }

    if (!response.ok) {
      const payload = await readJsonResponse(response).catch(() => ({}));
      return c.json({ error: payload?.error ?? response.statusText ?? 'Suppression Ollama impossible' }, response.status || 500);
    }

    services.invalidateInstalledModelCache?.();
    return c.json({ ok: true, model });
  });

  return route;
}