// Google Gemini REST API provider — free tier with model cascade
// Docs: https://ai.google.dev/api/generate-content

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const PROVIDER_ID = 'gemini';
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

// Ordered cascade by free-tier generosity (RPM / RPD as of 2026-07).
// Models with quota=0 (gemini-2.0-*) are excluded.
// 404 NotFound → model name changed or unavailable → skip and cascade.
// 429 / RESOURCE_EXHAUSTED → cascade to next model.
// Auth / key error → fail fast.
export const GEMINI_CASCADE = [
  'gemini-3.1-flash-lite', // 15 RPM, 500 RPD
  'gemini-2.5-flash-lite', // 10 RPM,  20 RPD
  'gemini-2.5-flash',      //  5 RPM,  20 RPD
];

// ── Rate limiter — sliding window, per-process singleton ──────────────────────
// Each Gemini model has its own free-tier RPM quota. We share one limiter
// across all models: if we're already near 10 req/min total, we slow down
// rather than hammering all models at once.
const _callLog = []; // timestamps (ms) of calls in the last 60s
let   _rpm     = 10; // max requests per minute — settable via setGeminiRpm()

export function setGeminiRpm(n) { _rpm = Math.max(1, Math.min(60, n)); }
export function getGeminiRpm()  { return _rpm; }

async function _waitForRateSlot() {
  const now    = Date.now();
  const cutoff = now - 60_000;
  while (_callLog.length && _callLog[0] < cutoff) _callLog.shift();
  if (_callLog.length >= _rpm) {
    // Wait until the oldest slot expires
    const delay = _callLog[0] + 60_000 - Date.now() + 100;
    await new Promise(r => setTimeout(r, Math.max(0, delay)));
    // Purge again after waiting
    const after = Date.now() - 60_000;
    while (_callLog.length && _callLog[0] < after) _callLog.shift();
  }
  _callLog.push(Date.now());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Converts Ollama-style messages [{role,content}] to Gemini contents format.
// Gemini requires alternating user/model turns — system messages become a
// leading user+model exchange; consecutive same-role messages are merged.
function toGeminiContents(messages) {
  const contents = [];
  let systemText = '';

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + msg.content;
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }

  if (systemText) {
    contents.unshift(
      { role: 'user',  parts: [{ text: systemText }] },
      { role: 'model', parts: [{ text: 'Compris.' }] },
    );
  }

  // Merge consecutive same-role parts (Gemini enforces strict alternation)
  const merged = [];
  for (const turn of contents) {
    const last = merged.at(-1);
    if (last?.role === turn.role) {
      last.parts[0].text += '\n\n' + turn.parts[0].text;
    } else {
      merged.push({ role: turn.role, parts: [{ text: turn.parts[0].text }] });
    }
  }

  return merged;
}

function isQuotaError(status, body) {
  if (status === 429) return true;
  const msg = String(body?.error?.message ?? body?.error?.status ?? '').toLowerCase();
  return msg.includes('resource_exhausted') || msg.includes('quota') || msg.includes('rate limit');
}

function isAuthError(status) {
  // 401/403 = key invalid or access denied — no point cascading
  // 404 is NOT auth: the model name is unknown/unavailable → cascade to next
  return status === 401 || status === 403;
}

// 404 always means the model name is unrecognised — skip and cascade
function isModelNotFound(status) {
  return status === 404;
}

// Parse Retry-After from HTTP header or Gemini RetryInfo in body.
// Returns milliseconds, or null if not found.
function parseRetryAfterMs(headers, body) {
  const h = headers.get('retry-after') ?? headers.get('Retry-After');
  if (h) {
    const secs = Number.parseInt(h, 10);
    if (!Number.isNaN(secs)) return secs * 1000;
  }
  for (const detail of body?.error?.details ?? []) {
    if (detail?.retryDelay) {
      const secs = Number.parseInt(detail.retryDelay, 10);
      if (!Number.isNaN(secs)) return secs * 1000;
    }
  }
  return null;
}

// ── Single-model call ─────────────────────────────────────────────────────────
// Respects the rate limiter. Throws on any error; sets err.isQuota,
// err.isAuth, err.isModelNotFound, and err.retryAfterMs on HTTP errors.
import { guardCloudCall } from '../privacy-guard.js';

export async function complete({ apiKey, model, messages, maxTokens = 4096 }) {
  guardCloudCall({ messages, provider: 'gemini', functionCalled: 'complete' });
  await _waitForRateSlot();

  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents:         toGeminiContents(messages),
      generationConfig: { maxOutputTokens: maxTokens },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`Gemini/${model} ${res.status}: ${body?.error?.message ?? res.statusText}`);
    err.isQuota        = isQuotaError(res.status, body);
    err.isAuth         = isAuthError(res.status);
    err.isModelNotFound = isModelNotFound(res.status);
    err.retryAfterMs   = err.isQuota ? parseRetryAfterMs(res.headers, body) : null;
    throw err;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error(`Gemini/${model}: réponse vide`);

  return {
    text,
    model,
    usage: {
      input_tokens:  data.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

// ── Cascade call ──────────────────────────────────────────────────────────────
const MAX_INLINE_RETRY_MS = 12_000;

// Attempt a single model call with one optional inline retry on 429.
// Returns { result, skip, failFast } where:
//   result   = successful completion (or null)
//   skip     = true → model is 404/quota'd, move to next in cascade
//   failFast = true → auth/network error, abort entire cascade
async function _tryModel({ apiKey, model, messages, maxTokens, logger, quotaModels }) {
  let firstErr;
  try {
    const result = await complete({ apiKey, model, messages, maxTokens });
    return { result, skip: false, failFast: false };
  } catch (e) {
    firstErr = e;
  }

  if (firstErr.isAuth)          return { result: null, skip: false, failFast: true, err: firstErr };
  if (firstErr.isModelNotFound) {
    logger?.info({ model }, 'Gemini cascade: modèle introuvable (404), essai suivant');
    return { result: null, skip: true, failFast: false };
  }
  if (!firstErr.isQuota)        return { result: null, skip: false, failFast: true, err: firstErr };

  // 429 — try a short inline retry if retry-after is within budget
  const retryMs = firstErr.retryAfterMs;
  if (retryMs && retryMs <= MAX_INLINE_RETRY_MS) {
    logger?.info({ model, retryMs }, `Gemini 429: attente ${(retryMs / 1000).toFixed(1)}s puis réessai`);
    await new Promise(r => setTimeout(r, retryMs + 500));
    try {
      const result = await complete({ apiKey, model, messages, maxTokens });
      logger?.info({ skipped: quotaModels, used: model, retried: true }, 'Gemini cascade: succès après retry');
      return { result, skip: false, failFast: false };
    } catch (retryErr) {
      if (retryErr.isAuth)          return { result: null, skip: false, failFast: true, err: retryErr };
      if (retryErr.isModelNotFound) {
        logger?.info({ model }, 'Gemini cascade: modèle introuvable après retry, essai suivant');
        return { result: null, skip: true, failFast: false };
      }
    }
  }

  // Quota persists → cascade to next model
  quotaModels.push(model);
  logger?.info({ model, retryMs }, 'Gemini cascade: 429, essai modèle suivant');
  return { result: null, skip: true, failFast: false };
}

// Tries each model in GEMINI_CASCADE in order.
// Returns { text, model, usage, quotaModels }.
export async function completeWithCascade({ apiKey, messages, maxTokens = 4096, logger }) {
  const quotaModels = [];

  for (const model of GEMINI_CASCADE) {
    const { result, skip, failFast, err } = await _tryModel({
      apiKey, model, messages, maxTokens, logger, quotaModels,
    });

    if (failFast) throw err;
    if (skip)     continue;

    if (quotaModels.length > 0) {
      logger?.warn({ skipped: quotaModels, used: model }, 'Gemini cascade: quota sur modèles précédents');
    }
    return { ...result, quotaModels };
  }

  const detail = quotaModels.join(', ') || 'aucun modèle disponible';
  const err = new Error(`Gemini: quota épuisé sur tous les modèles (${detail}) — bascule vers le modèle local`);
  err.isQuota     = true;
  err.quotaModels = quotaModels;
  throw err;
}

// ── Grounding call — Google Search tool ──────────────────────────────────────
// Available on gemini-2.5-flash / gemini-2.5-flash-lite in the free tier.
// Returns { text, model, sources: Array<{title, url}> }.
// Throws with err.isQuota / err.isAuth / err.isModelNotFound on HTTP errors.
export async function completeWithGrounding({ apiKey, model, prompt }) {
  await _waitForRateSlot();

  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents:         [{ role: 'user', parts: [{ text: prompt }] }],
      tools:            [{ googleSearch: {} }],
      generationConfig: { maxOutputTokens: 8192 },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`Gemini/${model} ${res.status}: ${body?.error?.message ?? res.statusText}`);
    err.isQuota         = isQuotaError(res.status, body);
    err.isAuth          = isAuthError(res.status);
    err.isModelNotFound = isModelNotFound(res.status);
    err.retryAfterMs    = err.isQuota ? parseRetryAfterMs(res.headers, body) : null;
    throw err;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error(`Gemini/${model}: réponse vide`);

  const chunks  = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .filter(c => c.web?.uri)
    .map(c => ({ title: c.web.title ?? c.web.uri, url: c.web.uri }));

  return { text, model, sources };
}

// Minimal test — checks key validity
export async function testKey(apiKey) {
  const res = await complete({
    apiKey,
    model: DEFAULT_MODEL,
    messages: [{ role: 'user', content: 'Réponds juste "ok".' }],
    maxTokens: 8,
  });
  return { ok: true, model: res.model };
}
