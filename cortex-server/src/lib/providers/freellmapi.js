// FreeLLMAPI provider: configurable OpenAI-compatible gateway.
// Capabilities are accepted only when the gateway advertises them in /v1/models.

import { ErrorCategory, classifiedError, classifyHttpError, classifyNetworkError, parseRetryAfterMs } from '../provider-errors.js';

export const PROVIDER_ID = 'freellmapi';
export const DEFAULT_MODEL = 'auto';
const DEFAULT_TIMEOUT_MS = 90_000;
const MODELS_TTL_MS = 300_000;

let modelsCache = null;
let modelsCacheKey = '';
let modelsCacheAt = 0;

function endpoint(config) {
  return String(config?.baseUrl ?? '').trim().replace(/\/$/, '').replace(/\/v1$/, '');
}

function safeErrorMessage(status, body, statusText, apiKey) {
  const message = body?.error?.message ?? body?.message ?? body?.error;
  const safe = typeof message === 'string' ? message : statusText || 'request failed';
  return `FreeLLMAPI ${status}: ${apiKey ? safe.split(apiKey).join('***') : safe}`;
}

function requestConfig(config, timeout = DEFAULT_TIMEOUT_MS) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (config?.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return { headers, signal: AbortSignal.timeout(Number(config?.timeout) > 0 ? Number(config.timeout) : timeout) };
}

async function request(config, path, init = {}) {
  const baseUrl = endpoint(config);
  if (!baseUrl) throw classifiedError('FreeLLMAPI: endpoint non configuré', ErrorCategory.PROVIDER_UNAVAILABLE);
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...requestConfig(config),
      ...init,
      headers: { ...requestConfig(config).headers, ...(init.headers ?? {}) },
    });
  } catch (error) {
    const category = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? ErrorCategory.TIMEOUT
      : classifyNetworkError(error);
    throw classifiedError(`FreeLLMAPI: ${category === ErrorCategory.TIMEOUT ? 'timeout' : 'indisponible'}`, category);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const category = classifyHttpError(response.status, body);
    const error = classifiedError(safeErrorMessage(response.status, body, response.statusText, config?.apiKey), category);
    if (category === ErrorCategory.RATE_LIMITED) error.retryAfterMs = parseRetryAfterMs(response.headers, body);
    throw error;
  }
  return body;
}

function normalizeCapabilities(model) {
  const raw = model?.capabilities;
  if (Array.isArray(raw)) return raw.filter(value => typeof value === 'string');
  if (raw && typeof raw === 'object') return Object.entries(raw).filter(([, value]) => value === true).map(([key]) => key);
  return [];
}

export function normalizeModel(model) {
  const capabilities = normalizeCapabilities(model);
  const modality = model?.modality ?? model?.type ?? undefined;
  return {
    id: model?.id ?? model?.name,
    displayName: model?.name ?? model?.id,
    capabilities,
    ...((model?.provider ?? model?.backend) ? { provider: model.provider ?? model.backend } : {}),
    ...(modality ? { modality } : {}),
    ...(typeof model?.free === 'boolean' ? { free: model.free } : {}),
    ...(Number.isFinite(model?.context_length) ? { contextLength: model.context_length } : {}),
    ...(Number.isFinite(model?.contextLength) ? { contextLength: model.contextLength } : {}),
  };
}

export async function listModels(config, { force = false } = {}) {
  const cacheKey = `${endpoint(config)}|${config?.apiKey ? 'configured' : 'anonymous'}`;
  if (!force && modelsCacheKey === cacheKey && modelsCache && Date.now() - modelsCacheAt < MODELS_TTL_MS) return modelsCache;
  const data = await request(config, '/v1/models', { method: 'GET' });
  const models = Array.isArray(data?.data) ? data.data.map(normalizeModel).filter(model => model.id) : [];
  modelsCache = models;
  modelsCacheKey = cacheKey;
  modelsCacheAt = Date.now();
  return models;
}

export async function testConnection(config) {
  const startedAt = Date.now();
  try {
    const models = await listModels(config, { force: true });
    return { ok: true, status: 'ready', latencyMs: Date.now() - startedAt, model: models[0]?.id ?? null, models: models.length };
  } catch (error) {
    return { ok: false, status: statusFromError(error), latencyMs: Date.now() - startedAt, error: error.message };
  }
}

export async function getHealth(config) {
  if (!endpoint(config)) return { ok: false, status: 'unavailable', configured: false, error: 'FreeLLMAPI: endpoint non configuré' };
  if (!config?.apiKey) return { ok: false, status: 'auth_required', configured: false, error: 'FreeLLMAPI: clé non configurée' };
  const result = await testConnection(config);
  return { ...result, configured: !!endpoint(config) && !!config?.apiKey };
}

function statusFromError(error) {
  if (error?.category === ErrorCategory.AUTH_FAILED) return 'auth_required';
  if (error?.category === ErrorCategory.RATE_LIMITED) return 'rate_limited';
  if (error?.category === ErrorCategory.TIMEOUT) return 'timeout';
  if (error?.category === ErrorCategory.PROVIDER_UNAVAILABLE) return 'degraded';
  return 'unavailable';
}

export async function complete({ config, model = DEFAULT_MODEL, messages, maxTokens = 4096, temperature, responseFormat }) {
  if (config?.allowText === false) throw classifiedError('FreeLLMAPI: texte désactivé', ErrorCategory.MODEL_UNAVAILABLE);
  const body = { messages, ...(model && model !== 'auto' ? { model } : {}), max_tokens: maxTokens };
  if (temperature !== undefined) body.temperature = temperature;
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };
  const data = await request(config, '/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  if (!text) throw classifiedError('FreeLLMAPI: réponse vide', ErrorCategory.UNKNOWN);
  return { text, model: data?.model ?? model, backend: data?.backend, usage: data?.usage };
}

export function clearModelsCache() {
  modelsCache = null;
  modelsCacheKey = '';
  modelsCacheAt = 0;
}

export const capabilities = new Set(['text', 'json', 'structured_output']);
