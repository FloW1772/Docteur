import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { saveImageBuffer } from '../lib/image.js';
import { routeImageGeneration, getProvidersStatus } from '../lib/image-router.js';
import { isStrictLocalMode } from '../lib/strict-local.js';
import {
  getImageGenSettings, setImageGenSettings,
  getImageCloudKeyStatuses, setImageCloudKey,
  insertImageGeneration, updateImageGeneration, getImageGeneration, listImageGenerations,
} from '../lib/sqlite.js';
import { registerJob, updateJob, finishJob } from './jobs.js';
import { isLoopbackEndpoint } from '../lib/providers/comfyui.js';
import {
  getInstallState, startManagedInstall, useExistingInstall, detachExternalInstall,
  startComfyUi, stopComfyUi, uninstallManaged, DEFAULT_MANAGED_PATH, COMFYUI_RELEASE,
  cancelInstall, waitForComfyUiReady,
} from '../lib/comfyui-install-manager.js';
import { getModelCatalog, startModelDownload, deleteModel, cancelModelDownload } from '../lib/comfyui-model-manager.js';

const MAX_DIMENSION = 2048;
const MIN_DIMENSION = 64;

function sanitizeDimension(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(n)));
}

export function createImageGenerationRoute({ logger } = {}) {
  const route = new Hono();

  // GET /api/image-generation/providers/status — real provider/detection status
  route.get('/image-generation/providers/status', async (c) => {
    try {
      const status = await getProvidersStatus();
      return c.json({ ok: true, strictLocal: isStrictLocalMode(), providers: status });
    } catch (err) {
      logger?.warn?.({ error: err.message }, 'IMAGE_GEN_STATUS_ERROR');
      return c.json({ error: 'Impossible de vérifier les providers' }, 500);
    }
  });

  // Kept as a coherent, more specific alias for ComfyUI-only detection (mission §4)
  route.get('/image-generation/providers/comfyui/status', async (c) => {
    try {
      const status = await getProvidersStatus();
      return c.json({ ok: true, ...status.comfyui });
    } catch (err) {
      return c.json({ error: 'Impossible de vérifier ComfyUI' }, 500);
    }
  });

  // GET /api/image-generation/settings
  route.get('/image-generation/settings', (c) => {
    const settings = getImageGenSettings();
    const keyStatuses = getImageCloudKeyStatuses();
    return c.json({
      ok: true,
      settings: {
        ...settings,
        comfyuiIsLoopback: isLoopbackEndpoint(settings.comfyui_endpoint),
      },
      // Never the actual secrets — status only (mission §21/§23)
      keys: {
        cloudflare_account_id: { configured: keyStatuses.cloudflare_account_id !== 'absent', status: keyStatuses.cloudflare_account_id },
        cloudflare_api_token:  { configured: keyStatuses.cloudflare_api_token  !== 'absent', status: keyStatuses.cloudflare_api_token },
        huggingface_token:     { configured: keyStatuses.huggingface_token    !== 'absent', status: keyStatuses.huggingface_token },
        pollinations_key:      { configured: keyStatuses.pollinations_key     !== 'absent', status: keyStatuses.pollinations_key },
      },
    });
  });

  // POST /api/image-generation/settings — update non-secret settings
  route.post('/image-generation/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const updates = {};
    if (typeof body.comfyui_endpoint === 'string') updates.comfyui_endpoint = body.comfyui_endpoint.trim();
    if (body.priority === 'local' || body.priority === 'cloud') updates.priority = body.priority;
    if (typeof body.free_cloud_only === 'boolean') updates.free_cloud_only = body.free_cloud_only;
    setImageGenSettings(updates);
    return c.json({ ok: true, settings: getImageGenSettings() });
  });

  // POST /api/image-generation/keys/:id — save/clear one secret key
  route.post('/image-generation/keys/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    try {
      setImageCloudKey(id, typeof body.value === 'string' ? body.value : null);
      return c.json({ ok: true, configured: !!body.value });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // POST /api/image-generation/generate
  route.post('/image-generation/generate', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return c.json({ error: 'Le prompt est requis' }, 400);

    const negativePrompt = typeof body.negativePrompt === 'string' ? body.negativePrompt : undefined;
    const width = sanitizeDimension(body.width, 512);
    const height = sanitizeDimension(body.height, 512);
    const steps = Number.isFinite(Number(body.steps)) ? Math.min(150, Math.max(1, Math.round(Number(body.steps)))) : undefined;
    const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : undefined;
    const provider = typeof body.provider === 'string' ? body.provider : undefined;

    const genId = randomUUID();
    const jobId = randomUUID();
    registerJob(jobId, 'Génération d\'image', 1);
    insertImageGeneration({ id: genId, prompt, negativePrompt, providerRequested: provider ?? 'auto', width, height, seed, status: 'generating', jobId });
    updateJob(jobId, { currentLabel: 'Génération en cours…' });

    try {
      const result = await routeImageGeneration({
        prompt, negativePrompt, provider, width, height, steps, seed,
        signal: AbortSignal.timeout(150_000),
      });

      if (!result.ok) {
        updateImageGeneration(genId, { status: 'failed', errorCode: result.errorCode, providerUsed: result.providerUsed ?? null });
        finishJob(jobId, 'failed', { errorCode: result.errorCode });
        logger?.info?.({ genId, providerRequested: result.providerRequested, errorCode: result.errorCode }, 'IMAGE_GENERATION_FAILED');
        return c.json({
          error: humanErrorMessage(result.errorCode, result.message),
          error_code: result.errorCode,
          image_id: null,
          provider_requested: result.providerRequested,
          provider_used: null,
        }, errorStatus(result.errorCode));
      }

      const imageId = saveImageBuffer(result.buffer, result.mimeType);
      updateImageGeneration(genId, {
        imageId, providerUsed: result.providerUsed, modelUsed: result.modelUsed,
        local: result.local, fallback: result.fallback, fallbackReasonCode: result.fallbackReasonCode,
        status: 'completed', generationMs: result.generationMs, width: result.width, height: result.height, seed: result.seed,
      });
      finishJob(jobId, 'done', { imageId });
      logger?.info?.({ genId, imageId, provider: result.providerUsed, local: result.local }, 'IMAGE_GENERATION_DONE');

      return c.json({
        image_id: imageId,
        provider_requested: result.providerRequested,
        provider_used: result.providerUsed,
        model_used: result.modelUsed,
        local: result.local,
        fallback: result.fallback,
        fallback_reason_code: result.fallbackReasonCode,
        width: result.width,
        height: result.height,
        seed: result.seed,
        generation_ms: result.generationMs,
        job_id: jobId,
        generation_id: genId,
      });
    } catch (err) {
      updateImageGeneration(genId, { status: 'failed', errorCode: 'unknown' });
      finishJob(jobId, 'failed', { errorCode: 'unknown' });
      logger?.warn?.({ genId, error: err.message }, 'IMAGE_GENERATION_EXCEPTION');
      return c.json({ error: 'Erreur inattendue lors de la génération', error_code: 'unknown' }, 500);
    }
  });

  // GET /api/image-generation/history
  route.get('/image-generation/history', (c) => {
    const rows = listImageGenerations(50);
    return c.json({ ok: true, generations: rows });
  });

  // GET /api/image-generation/:id
  route.get('/image-generation/:id', (c) => {
    const row = getImageGeneration(c.req.param('id'));
    if (!row) return c.json({ error: 'Introuvable' }, 404);
    return c.json({ ok: true, generation: row });
  });

  // ── ComfyUI install/lifecycle management ──────────────────────────────────

  route.get('/image-generation/comfyui/install', (c) => {
    return c.json({ ok: true, install: getInstallState(), defaultManagedPath: DEFAULT_MANAGED_PATH, release: COMFYUI_RELEASE });
  });

  // POST /api/image-generation/comfyui/install — start a real managed install
  // (download + extract). Only ever invoked from an explicit user click +
  // confirmation in Settings — never automatically.
  route.post('/image-generation/comfyui/install', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = startManagedInstall({ destination: typeof body.destination === 'string' ? body.destination : undefined });
      logger?.info?.({ jobId: result.jobId }, 'COMFYUI_INSTALL_STARTED');
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // POST /api/image-generation/comfyui/install/:jobId/cancel
  route.post('/image-generation/comfyui/install/:jobId/cancel', (c) => {
    try {
      const result = cancelInstall(c.req.param('jobId'));
      logger?.info?.({ jobId: c.req.param('jobId') }, 'COMFYUI_INSTALL_CANCELLED');
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // POST /api/image-generation/comfyui/use-existing — register an external install
  route.post('/image-generation/comfyui/use-existing', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const installPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!installPath) return c.json({ error: 'Chemin requis' }, 400);
    try {
      const result = useExistingInstall({ installPath });
      if (!result.ok) return c.json({ error: result.error }, 404);
      return c.json({ ok: true, install: getInstallState() });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // POST /api/image-generation/comfyui/detach — dissociate an external install (never deletes it)
  route.post('/image-generation/comfyui/detach', (c) => {
    try {
      const install = detachExternalInstall();
      return c.json({ ok: true, install });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // Starts the process and returns immediately with status 'starting'; the
  // frontend polls GET /comfyui/install to observe the transition to
  // 'running' (or 'error') once waitForComfyUiReady resolves in the background.
  route.post('/image-generation/comfyui/start', async (c) => {
    try {
      const install = startComfyUi();
      logger?.info?.({ pid: install.pid }, 'COMFYUI_START');
      void waitForComfyUiReady().then((result) => {
        logger?.info?.({ ready: result.ready, errorCode: result.errorCode }, 'COMFYUI_READY_CHECK');
      });
      return c.json({ ok: true, install });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post('/image-generation/comfyui/stop', (c) => {
    try {
      const install = stopComfyUi();
      logger?.info?.({}, 'COMFYUI_STOP');
      return c.json({ ok: true, install });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // POST /api/image-generation/comfyui/uninstall — managed install only, conservative defaults
  route.post('/image-generation/comfyui/uninstall', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const deleteModels = body.deleteModels === true; // default false — most conservative
    try {
      const result = uninstallManaged({ deleteModels });
      logger?.info?.({ deleteModels }, 'COMFYUI_UNINSTALL');
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ── Local model catalog / download / delete ───────────────────────────────

  route.get('/image-generation/models/catalog', (c) => {
    return c.json({ ok: true, catalog: getModelCatalog() });
  });

  route.post('/image-generation/models/download', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    try {
      const result = startModelDownload(modelId);
      logger?.info?.({ modelId, jobId: result.jobId }, 'MODEL_DOWNLOAD_STARTED');
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete('/image-generation/models/:filename', (c) => {
    const filename = c.req.param('filename');
    try {
      const result = deleteModel(filename);
      logger?.info?.({ filename }, 'MODEL_DELETED');
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post('/image-generation/models/download/:jobId/cancel', (c) => {
    try {
      const result = cancelModelDownload(c.req.param('jobId'));
      logger?.info?.({ jobId: c.req.param('jobId') }, 'MODEL_DOWNLOAD_CANCELLED');
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
}

function humanErrorMessage(code, message) {
  const map = {
    strict_local: 'Mode strictement local activé — génération cloud désactivée.',
    provider_unavailable: 'Provider indisponible.',
    model_unavailable: message ?? 'ComfyUI fonctionne mais aucun modèle compatible n’a été détecté.',
    timeout: 'Délai de génération dépassé.',
    network_error: 'Erreur réseau pendant la génération.',
    quota_exhausted: 'Quota gratuit épuisé — passage au local.',
    gpu_memory: 'Mémoire GPU insuffisante pour ce workflow.',
    IMAGE_PROVIDER_NOT_CONFIRMED_FREE: 'Ce provider n’est pas confirmé gratuit — refusé en mode "cloud gratuit uniquement".',
    cancelled: 'Génération annulée.',
    unknown: 'Erreur inconnue pendant la génération.',
  };
  return map[code] ?? map.unknown;
}

function errorStatus(code) {
  if (code === 'strict_local' || code === 'IMAGE_PROVIDER_NOT_CONFIRMED_FREE') return 503;
  if (code === 'model_unavailable' || code === 'provider_unavailable') return 503;
  if (code === 'timeout') return 504;
  return 502;
}
