// ComfyUI local provider — treated as a trusted local endpoint (same
// conceptual class as Ollama), NOT as arbitrary user-supplied URL subject to
// the SSRF guard in url-security.js. If the configured endpoint is not
// loopback, callers must surface that clearly as a user-configured network
// endpoint (see status()) rather than silently treating it as "local".
//
// Never spawn ComfyUI itself, never shell:true anything — this module only
// ever talks to an already-running server over HTTP/WebSocket.
//
// [EETF V1 — EETF-4] Every HTTP call of this module goes through ONE bounded
// request helper: redirects are refused (a local endpoint can never bounce a
// request elsewhere), every response body is size-capped while it is read, and
// timeouts / caller AbortSignals are honoured. `createComfyUiClient` adds the
// strict loopback-only client used by EETF (Root Policy AI_LOCAL_REQUEST before
// every request, validated output references, interrupt, bounded polling).
// The legacy getComfyUiStatus / generateWithComfyUi keep their contract.

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8188';

/** Response-size caps (bytes). Images are bounded by the EETF file budget. */
export const COMFYUI_LIMITS = Object.freeze({ maxJsonBytes: 4 * 1024 * 1024, maxImageBytes: 64 * 1024 * 1024 });

function isLoopbackEndpoint(endpoint) {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export class ComfyUiError extends Error {
  constructor(code, message, details = undefined) {
    super(message ?? code);
    this.name = 'ComfyUiError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * The single HTTP primitive of this module. Never follows a redirect, caps the
 * body while reading it, maps transport failures to stable codes.
 * @returns {Promise<{ status: number, json?: any, bytes?: Buffer, contentType: string }>}
 */
async function request(url, { method = 'GET', json, timeoutMs = 5000, signal, maxBytes = COMFYUI_LIMITS.maxJsonBytes, expect = 'json', okStatuses = null } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let res;
  try {
    res = await fetch(url, {
      method, redirect: 'error', signal: combined,
      headers: json === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  } catch (err) {
    if (signal?.aborted) throw new ComfyUiError('ABORTED', 'request aborted by the caller');
    if (timeout.aborted) throw new ComfyUiError('PROVIDER_TIMEOUT', `no answer within ${timeoutMs} ms`);
    if (/redirect/i.test(String(err?.cause?.message ?? err?.message))) throw new ComfyUiError('PROVIDER_REFUSED', 'the endpoint answered with a redirect (refused)');
    throw new ComfyUiError('PROVIDER_UNAVAILABLE', 'ComfyUI is not reachable on this endpoint', { cause: String(err?.cause?.code ?? err?.message ?? err) });
  }
  if (res.status >= 300 && res.status < 400) throw new ComfyUiError('PROVIDER_REFUSED', 'the endpoint answered with a redirect (refused)');
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new ComfyUiError('RESPONSE_TOO_LARGE', `response larger than ${maxBytes} bytes`);
  }
  const chunks = []; let total = 0;
  try {
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new ComfyUiError('RESPONSE_TOO_LARGE', `response larger than ${maxBytes} bytes`); }
        chunks.push(Buffer.from(value));
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new ComfyUiError('RESPONSE_TOO_LARGE', `response larger than ${maxBytes} bytes`);
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof ComfyUiError) throw err;
    if (signal?.aborted) throw new ComfyUiError('ABORTED', 'request aborted by the caller');
    if (timeout.aborted) throw new ComfyUiError('PROVIDER_TIMEOUT', `no answer within ${timeoutMs} ms`);
    throw new ComfyUiError('PROVIDER_UNAVAILABLE', 'the connection dropped while reading the response');
  }
  const body = Buffer.concat(chunks);
  const contentType = String(res.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ok = okStatuses ? okStatuses.includes(res.status) : res.ok;
  if (!ok) throw new ComfyUiError('HTTP_ERROR', `ComfyUI HTTP ${res.status}`, { status: res.status, body: body.toString('utf8', 0, Math.min(body.length, 2000)) });
  if (expect === 'bytes') return { status: res.status, bytes: body, contentType };
  if (expect === 'none') return { status: res.status, contentType };
  try { return { status: res.status, json: JSON.parse(body.toString('utf8')), contentType }; } catch {
    throw new ComfyUiError('INVALID_RESPONSE', 'ComfyUI returned invalid JSON');
  }
}

async function fetchJson(url, opts, timeoutMs = 5000) {
  return (await request(url, { method: opts?.method ?? 'GET', json: opts?.json, timeoutMs })).json;
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
    queued = await fetchJson(`${endpoint}/prompt`, { method: 'POST', json: { prompt: workflow, client_id: clientId } }, 10_000);
  } catch (err) {
    return { ok: false, errorCode: 'network_error' };
  }

  const promptId = queued.prompt_id;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return { ok: false, errorCode: 'cancelled' };

    let history;
    try {
      history = await fetchJson(`${endpoint}/history/${encodeURIComponent(promptId)}`, undefined, 8000);
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
          const { bytes: buf } = await request(viewUrl, { timeoutMs: 15_000, expect: 'bytes', maxBytes: COMFYUI_LIMITS.maxImageBytes });
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

// ── [EETF V1 — EETF-4] strict loopback client ────────────────────────────────

const LOOPBACK_HOSTS = new Map([['127.0.0.1', '127.0.0.1'], ['localhost', '127.0.0.1'], ['[::1]', '[::1]']]);

/**
 * Strict endpoint check for EETF: http only, loopback only (127.0.0.1, ::1,
 * localhost → 127.0.0.1 without any DNS lookup), no credentials, no path,
 * query or fragment. Returns the origin to use, or throws ComfyUiError with
 * MISCONFIGURED (not a usable URL) or PROVIDER_REFUSED (not loopback / not http).
 */
export function parseLoopbackEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 200) throw new ComfyUiError('MISCONFIGURED', 'endpoint must be a short URL string');
  let url;
  try { url = new URL(endpoint); } catch { throw new ComfyUiError('MISCONFIGURED', 'endpoint is not a valid URL'); }
  if (url.protocol !== 'http:') throw new ComfyUiError('PROVIDER_REFUSED', 'only http:// on the loopback interface is allowed');
  if (url.username || url.password) throw new ComfyUiError('PROVIDER_REFUSED', 'credentials in the endpoint are refused');
  const host = LOOPBACK_HOSTS.get(url.hostname);
  if (!host) throw new ComfyUiError('PROVIDER_REFUSED', `${url.hostname.slice(0, 80)} is not 127.0.0.1, ::1 or localhost`);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new ComfyUiError('MISCONFIGURED', 'endpoint must not carry a path, query or fragment');
  return `http://${host}${url.port ? `:${url.port}` : ''}`;
}

const OUTPUT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PROMPT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Node classes the EETF client may query in /object_info (never a caller-supplied name). */
export const COMFYUI_QUERYABLE_NODES = Object.freeze(['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage']);

/**
 * Validates an output reference returned by ComfyUI before it is used in a
 * /view request: a bare file name (no separator, no `..`), empty subfolder,
 * type `output`. Anything else is refused — the name never touches a disk path.
 */
export function validateOutputRef(ref) {
  if (!ref || typeof ref !== 'object') throw new ComfyUiError('OUTPUT_INVALID', 'output reference must be an object');
  const { filename, subfolder = '', type = 'output' } = ref;
  if (typeof filename !== 'string' || !OUTPUT_FILENAME_RE.test(filename) || filename.includes('..')) throw new ComfyUiError('OUTPUT_INVALID', 'unsafe output file name');
  if (subfolder !== '') throw new ComfyUiError('OUTPUT_INVALID', 'outputs in a subfolder are refused');
  if (type !== 'output') throw new ComfyUiError('OUTPUT_INVALID', 'only type "output" is accepted');
  return Object.freeze({ filename, subfolder: '', type: 'output' });
}

/**
 * Loopback-only ComfyUI client. Root Policy AI_LOCAL_REQUEST (module `ai`) is
 * enforced before EVERY request; a refusal means no request is sent.
 * @param {{ endpoint: string, enforce: (req: object) => unknown, requestTimeoutMs?: number }} opts
 */
export function createComfyUiClient({ endpoint, enforce, requestTimeoutMs = 10_000 }) {
  if (typeof enforce !== 'function') throw new ComfyUiError('MISCONFIGURED', 'a Root Policy enforce function is required');
  const origin = parseLoopbackEndpoint(endpoint);
  let requests = 0;
  const call = (path, opts = {}) => {
    try {
      enforce({ action: 'AI_LOCAL_REQUEST', module: 'ai', trustDomain: 'AI', context: { provider: 'comfyui', networkClass: 'loopback' } });
    } catch (e) {
      throw new ComfyUiError('PROVIDER_REFUSED', `Root Policy refused the local AI request (${e?.decisionCode ?? e?.code ?? 'DENY'})`);
    }
    requests++;
    return request(`${origin}${path}`, { timeoutMs: requestTimeoutMs, ...opts });
  };
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ComfyUiError('ABORTED', 'polling aborted'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new ComfyUiError('ABORTED', 'polling aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  return Object.freeze({
    origin,
    requestCount: () => requests,
    systemStats: ({ signal, timeoutMs } = {}) => call('/system_stats', { signal, ...(timeoutMs ? { timeoutMs } : {}) }).then(r => r.json),
    nodeInfo: (nodeClass, { signal, timeoutMs } = {}) => {
      if (!COMFYUI_QUERYABLE_NODES.includes(nodeClass)) throw new ComfyUiError('MISCONFIGURED', 'node class not queryable');
      return call(`/object_info/${nodeClass}`, { signal, ...(timeoutMs ? { timeoutMs } : {}) }).then(r => r.json?.[nodeClass] ?? null);
    },
    /** Non-mutating probe: an existing POST-only route answers 405 to GET; a missing one 404. */
    interruptSupported: async ({ signal, timeoutMs } = {}) => {
      try { return (await call('/interrupt', { signal, expect: 'none', okStatuses: [405], ...(timeoutMs ? { timeoutMs } : {}) })).status === 405; } catch { return false; }
    },
    submit: async (workflow, clientId, { signal } = {}) => {
      const r = await call('/prompt', { method: 'POST', json: { prompt: workflow, client_id: clientId }, signal });
      const id = r.json?.prompt_id;
      if (typeof id !== 'string' || !PROMPT_ID_RE.test(id)) throw new ComfyUiError('INVALID_RESPONSE', 'ComfyUI returned no valid prompt id');
      return id;
    },
    history: async (promptId, { signal } = {}) => {
      if (!PROMPT_ID_RE.test(String(promptId))) throw new ComfyUiError('MISCONFIGURED', 'invalid prompt id');
      return (await call(`/history/${promptId}`, { signal })).json?.[promptId] ?? null;
    },
    /** Bounded polling: fixed interval, bounded attempts, abortable. Resolves the finished history entry. */
    pollHistory: async (promptId, { intervalMs, maxAttempts, signal, isDone }) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const entry = await call(`/history/${promptId}`, { signal }).then(r => r.json?.[promptId] ?? null);
        if (entry && isDone(entry)) return entry;
        if (attempt < maxAttempts) await sleep(intervalMs, signal);
      }
      throw new ComfyUiError('PROVIDER_TIMEOUT', `no result after ${maxAttempts} polls`);
    },
    view: async (ref, { signal, maxBytes = COMFYUI_LIMITS.maxImageBytes } = {}) => {
      const r = validateOutputRef(ref);
      const q = `filename=${encodeURIComponent(r.filename)}&subfolder=&type=output`;
      return (await call(`/view?${q}`, { signal, expect: 'bytes', maxBytes, timeoutMs: 30_000 })).bytes;
    },
    /** Best effort: drop the prompt from the queue, then interrupt the running one. Never claims the GPU stopped. */
    interrupt: async (promptId) => {
      const out = { queueDeleteAccepted: false, interruptAccepted: false };
      try { if (PROMPT_ID_RE.test(String(promptId))) { await call('/queue', { method: 'POST', json: { delete: [promptId] }, expect: 'none', timeoutMs: 3000 }); out.queueDeleteAccepted = true; } } catch { /* reported as false */ }
      // prompt_id targets OUR prompt on engines that support it; older engines ignore it and interrupt the current execution
      try { await call('/interrupt', { method: 'POST', json: PROMPT_ID_RE.test(String(promptId)) ? { prompt_id: promptId } : {}, expect: 'none', timeoutMs: 3000 }); out.interruptAccepted = true; } catch { /* reported as false */ }
      return out;
    },
  });
}

export const COMFYUI_DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
export { isLoopbackEndpoint };
