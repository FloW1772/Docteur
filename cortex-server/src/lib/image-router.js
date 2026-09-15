// Image generation router — mirrors the strict-local/free-only discipline of
// lib/router.js's runAiTask, specialized for image generation providers.
//
// Modes: 'local_only' | 'free_cloud' | 'auto' | provider id (manual).
// Strict Local ON forces 'local_only' unconditionally, regardless of the
// requested mode — enforced here (not just in the UI) so any future caller
// of generateImage() gets the same guarantee.

import { isStrictLocalMode } from './strict-local.js';
import { getImageGenSettings } from './sqlite.js';
import { generateWithComfyUi, getComfyUiStatus } from './providers/comfyui.js';
import { isCloudflareConfigured, cloudflareCapabilities, generateWithCloudflare } from './providers/cloudflare-image.js';
import { isHuggingFaceConfigured, huggingfaceCapabilities, generateWithHuggingFace } from './providers/huggingface-image.js';
import { isPollinationsConfigured, pollinationsCapabilities, generateWithPollinations } from './providers/pollinations-image.js';

// Providers confirmed free/free-tier/credit — never a payant-only provider.
// Anything not explicitly listed here is refused under free-only mode rather
// than assumed safe (mission §24: "En cas d'incertitude: REFUSER").
const FREE_CONFIRMED_PROVIDERS = new Set(['comfyui', 'cloudflare', 'huggingface', 'pollinations']);

export function assertImageCloudAllowed() {
  if (isStrictLocalMode()) {
    return { allowed: false, code: 'strict_local' };
  }
  return { allowed: true };
}

export function assertImageProviderFreeAllowed(providerId, { freeOnly }) {
  if (!freeOnly) return { allowed: true };
  if (!FREE_CONFIRMED_PROVIDERS.has(providerId)) {
    return { allowed: false, code: 'IMAGE_PROVIDER_NOT_CONFIRMED_FREE' };
  }
  return { allowed: true };
}

export async function getProvidersStatus() {
  const settings = getImageGenSettings();
  const comfyui = await getComfyUiStatus(settings.comfyui_endpoint);
  return {
    comfyui: { ...comfyui, classification: 'local' },
    cloudflare: { configured: isCloudflareConfigured(), ...cloudflareCapabilities() },
    huggingface: { configured: isHuggingFaceConfigured(), ...huggingfaceCapabilities() },
    pollinations: { configured: isPollinationsConfigured(), ...pollinationsCapabilities() },
  };
}

// Builds the ordered candidate list for AUTO mode, honoring `priority`.
function autoOrder(priority) {
  const local = ['comfyui'];
  const cloud = ['cloudflare', 'huggingface', 'pollinations'];
  return priority === 'cloud' ? [...cloud, ...local] : [...local, ...cloud];
}

async function callProvider(providerId, params, settings) {
  switch (providerId) {
    case 'comfyui':
      return generateWithComfyUi({ endpoint: settings.comfyui_endpoint, ...params });
    case 'cloudflare':
      if (!isCloudflareConfigured()) return { ok: false, errorCode: 'provider_unavailable' };
      return generateWithCloudflare(params);
    case 'huggingface':
      if (!isHuggingFaceConfigured()) return { ok: false, errorCode: 'provider_unavailable' };
      return generateWithHuggingFace(params);
    case 'pollinations':
      if (!isPollinationsConfigured()) return { ok: false, errorCode: 'provider_unavailable' };
      return generateWithPollinations(params);
    default:
      return { ok: false, errorCode: 'unknown' };
  }
}

// Main entry point. Never throws provider internals to the caller — only
// controlled error codes (see mission §15).
export async function routeImageGeneration({ prompt, negativePrompt, provider, width, height, steps, seed, signal }) {
  const settings = getImageGenSettings();
  const strict = isStrictLocalMode();
  const requestedMode = strict ? 'local_only' : (provider ?? 'auto');

  const params = { prompt, negativePrompt, width, height, steps, seed, signal };

  // LOCAL ONLY (explicit, or forced by Strict Local)
  if (requestedMode === 'local_only' || strict) {
    const result = await callProvider('comfyui', params, settings);
    return finalize('comfyui', 'comfyui', result, false, strict ? 'strict_local' : null);
  }

  // FREE CLOUD (only providers confirmed free/free-tier/credit)
  if (requestedMode === 'free_cloud') {
    for (const id of ['cloudflare', 'huggingface', 'pollinations']) {
      const gate = assertImageProviderFreeAllowed(id, { freeOnly: true });
      if (!gate.allowed) continue;
      const result = await callProvider(id, params, settings);
      if (result.ok) return finalize(id, id, result, false, null);
    }
    return finalize('free_cloud', null, { ok: false, errorCode: 'provider_unavailable' }, false, 'provider_unavailable');
  }

  // Manual provider selection
  if (['comfyui', 'cloudflare', 'huggingface', 'pollinations'].includes(requestedMode)) {
    if (requestedMode !== 'comfyui') {
      const cloudGate = assertImageCloudAllowed();
      if (!cloudGate.allowed) return finalize(requestedMode, null, { ok: false, errorCode: 'strict_local' }, false, 'strict_local');
      const freeGate = assertImageProviderFreeAllowed(requestedMode, { freeOnly: settings.free_cloud_only });
      if (!freeGate.allowed) return finalize(requestedMode, null, { ok: false, errorCode: freeGate.code }, false, freeGate.code);
    }
    const result = await callProvider(requestedMode, params, settings);
    return finalize(requestedMode, requestedMode, result, false, result.ok ? null : result.errorCode);
  }

  // AUTO: try candidates in priority order, cloud candidates gated by free-only
  const order = autoOrder(settings.priority);
  let lastErrorCode = 'provider_unavailable';
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (id !== 'comfyui') {
      const cloudGate = assertImageCloudAllowed();
      if (!cloudGate.allowed) { lastErrorCode = 'strict_local'; continue; }
      const freeGate = assertImageProviderFreeAllowed(id, { freeOnly: settings.free_cloud_only });
      if (!freeGate.allowed) { lastErrorCode = freeGate.code; continue; }
    }
    const result = await callProvider(id, params, settings);
    if (result.ok) {
      return finalize('auto', id, result, id !== order[0], id !== order[0] ? (lastErrorCode) : null);
    }
    lastErrorCode = result.errorCode ?? 'unknown';
  }

  return finalize('auto', null, { ok: false, errorCode: lastErrorCode }, false, lastErrorCode);
}

function finalize(providerRequested, providerUsed, result, fallback, fallbackReasonCode) {
  if (!result.ok) {
    return {
      ok: false,
      providerRequested,
      providerUsed: null,
      errorCode: result.errorCode ?? 'unknown',
      message: result.message ?? null,
    };
  }
  return {
    ok: true,
    providerRequested,
    providerUsed,
    modelUsed: result.model ?? null,
    local: providerUsed === 'comfyui',
    fallback,
    fallbackReasonCode: fallback ? fallbackReasonCode : null,
    buffer: result.buffer,
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
    seed: result.seed,
    generationMs: result.generationMs,
  };
}
