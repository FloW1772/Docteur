// ComfyUI local provider — treated as a trusted local endpoint (same
// conceptual class as Ollama), NOT as arbitrary user-supplied URL subject to
// the SSRF guard in url-security.js. If the configured endpoint is not
// loopback, callers must surface that clearly as a user-configured network
// endpoint (see status()) rather than silently treating it as "local".
//
// Never spawn ComfyUI itself, never shell:true anything — this module only
// ever talks to an already-running server over HTTP/WebSocket.

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8188';

function isLoopbackEndpoint(endpoint) {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function fetchJson(url, opts, timeoutMs = 5000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`ComfyUI HTTP ${res.status}`);
  return res.json();
}

// Checks server availability + reports real installed checkpoints — never
// assumes a model exists just because it's publicly known to exist.
export async function getComfyUiStatus(endpoint = DEFAULT_ENDPOINT) {
  const isLocal = isLoopbackEndpoint(endpoint);
  try {
    const stats = await fetchJson(`${endpoint}/system_stats`, undefined, 4000);
    const objectInfo = await fetchJson(`${endpoint}/object_info/CheckpointLoaderSimple`, undefined, 4000).catch(() => null);

    const checkpoints = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];

    return {
      available: true,
      endpoint,
      isLocal,
      version: stats?.system?.comfyui_version ?? null,
      gpu: (stats?.devices ?? []).map((d) => ({
        name: d.name ?? null,
        vramTotalMb: d.vram_total != null ? Math.round(d.vram_total / 1024 / 1024) : null,
        vramFreeMb: d.vram_free != null ? Math.round(d.vram_free / 1024 / 1024) : null,
      })),
      checkpoints,
      hasCompatibleModel: checkpoints.length > 0,
    };
  } catch (err) {
    return {
      available: false,
      endpoint,
      isLocal,
      error: 'provider_unavailable',
      message: 'ComfyUI ne répond pas sur cet endpoint.',
    };
  }
}

// Minimal text-to-image workflow using standard ComfyUI nodes
// (CheckpointLoaderSimple, CLIPTextEncode x2, EmptyLatentImage, KSampler, VAEDecode, SaveImage).
function buildTxt2ImgWorkflow({ prompt, negativePrompt, checkpoint, width, height, steps, seed }) {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: seed ?? Math.floor(Math.random() * 1_000_000_000),
        steps: steps ?? 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: width ?? 512, height: height ?? 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt ?? '', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'docteur', images: ['8', 0] } },
  };
}

// Queues a workflow, waits for completion via polling /history (WebSocket
// progress is a future enhancement; polling is enough for a correct
// first implementation and needs no extra connection lifecycle to manage).
export async function generateWithComfyUi({
  endpoint = DEFAULT_ENDPOINT, prompt, negativePrompt, width, height, steps, seed,
  timeoutMs = 120_000, signal,
}) {
  const status = await getComfyUiStatus(endpoint);
  if (!status.available) {
    return { ok: false, errorCode: 'provider_unavailable' };
  }
  if (!status.hasCompatibleModel) {
    return { ok: false, errorCode: 'model_unavailable', message: 'ComfyUI fonctionne mais aucun modèle compatible n’a été détecté.' };
  }

  const checkpoint = status.checkpoints[0];
  const workflow = buildTxt2ImgWorkflow({ prompt, negativePrompt, checkpoint, width, height, steps, seed });
  const clientId = crypto.randomUUID();

  let queued;
  try {
    queued = await fetchJson(`${endpoint}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    }, 10_000);
  } catch (err) {
    return { ok: false, errorCode: 'network_error' };
  }

  const promptId = queued.prompt_id;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return { ok: false, errorCode: 'cancelled' };

    let history;
    try {
      history = await fetchJson(`${endpoint}/history/${promptId}`, undefined, 8000);
    } catch {
      history = null;
    }

    const entry = history?.[promptId];
    if (entry) {
      const outputs = entry.outputs ?? {};
      const saveNode = outputs['9'];
      const imgInfo = saveNode?.images?.[0];
      if (imgInfo) {
        try {
          const viewUrl = `${endpoint}/view?filename=${encodeURIComponent(imgInfo.filename)}&subfolder=${encodeURIComponent(imgInfo.subfolder ?? '')}&type=${encodeURIComponent(imgInfo.type ?? 'output')}`;
          const res = await fetch(viewUrl, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) return { ok: false, errorCode: 'network_error' };
          const buf = Buffer.from(await res.arrayBuffer());
          return {
            ok: true,
            buffer: buf,
            mimeType: 'image/png',
            model: checkpoint,
            seed: workflow['3'].inputs.seed,
            width: width ?? 512,
            height: height ?? 512,
            generationMs: Date.now() - started,
          };
        } catch {
          return { ok: false, errorCode: 'network_error' };
        }
      }
      const errStatus = entry.status;
      if (errStatus?.status_str === 'error' || errStatus?.completed === false) {
        const messages = JSON.stringify(errStatus.messages ?? []);
        if (/CUDA out of memory|VRAM|out of memory/i.test(messages)) {
          return { ok: false, errorCode: 'gpu_memory', message: 'Mémoire GPU insuffisante pour ce workflow.' };
        }
        return { ok: false, errorCode: 'unknown' };
      }
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  return { ok: false, errorCode: 'timeout' };
}

export const COMFYUI_DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
export { isLoopbackEndpoint };
