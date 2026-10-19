// EETF V1 — generation engine over the provider registry (EETF-4).
//
// QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED, one generation at a time
// (single GPU slot). Before queueing and again before running, the request is
// negotiated against a FRESH provider snapshot (state, capabilities, model /
// sampler / scheduler lists reported by the engine, VRAM guard).
//
// Outputs are never trusted: references are validated by the client, bytes are
// size-capped, sniffed (must be the PNG the template saves), checked against
// the requested size and the pixel budget, stripped of metadata (ComfyUI writes
// the prompt + workflow into PNG text chunks), then stored content-addressed
// with a GenerationProvenance. The prompt goes only to the chosen provider, in
// a POST body — never in a URL, a file name, a path or a process argument.
//
// Cancellation / timeout: the HTTP polling is aborted and ComfyUI is asked to
// drop and interrupt OUR prompt. That request does NOT guarantee the GPU stops
// instantly — the job result says so (gpuStopGuaranteed: false).

import crypto from 'node:crypto';
import {
  EetfError, FORMAT_MIME, JOB_STATUS, validateJobParams, limit, freezeDeep, SAMPLERS, SCHEDULERS,
} from './eetf-contracts.js';
import { sniffImage, assertImageBudget } from './eetf-asset-store.js';
import { assertStructurallyIntact } from './eetf-integrity.js';
import { negotiate, GENERATION_ERROR } from './eetf-providers.js';
import { stripPngMetadata } from './eetf-image-meta.js';
import { WORKFLOW_TEMPLATE_ID } from './eetf-comfyui-provider.js';

const fail = (code, message, details) => { throw new EetfError(code, message, details); };
const GPU_NOTE = 'an HTTP interrupt does not guarantee the GPU stops instantly';

/** ComfyUI client codes → EETF-4 job error codes. */
function mapProviderError(e) {
  switch (e?.code) {
    case 'PROVIDER_UNAVAILABLE': case 'MISCONFIGURED': return GENERATION_ERROR.PROVIDER_UNAVAILABLE;
    case 'PROVIDER_REFUSED': return GENERATION_ERROR.PROVIDER_REFUSED;
    case 'PROVIDER_TIMEOUT': return GENERATION_ERROR.PROVIDER_TIMEOUT;
    case 'HTTP_ERROR': return e.details?.status === 400 ? GENERATION_ERROR.WORKFLOW_INVALID : GENERATION_ERROR.GENERATION_FAILED;
    case 'INVALID_RESPONSE': case 'GENERATION_FAILED': return GENERATION_ERROR.GENERATION_FAILED;
    case 'OUTPUT_MISSING': return GENERATION_ERROR.OUTPUT_MISSING;
    case 'OUTPUT_INVALID': case 'RESPONSE_TOO_LARGE': return GENERATION_ERROR.OUTPUT_INVALID;
    case 'EETF_WORKFLOW_INVALID': case 'EETF_INVALID_MODEL': return GENERATION_ERROR.WORKFLOW_INVALID;
    default: return GENERATION_ERROR.GENERATION_FAILED;
  }
}

/**
 * @param {{ store: import('./eetf-store.js').EetfStore, registry: ReturnType<import('./eetf-providers.js').createProviderRegistry>,
 *           providerId?: string, timeoutMs?: number, pollIntervalMs?: number, logger?: object }} deps
 */
export function createEetfGenerationEngine({ store, registry, providerId = 'comfyui', timeoutMs = limit('timeoutMs'), pollIntervalMs = limit('pollIntervalMs'), logger = null }) {
  if (!store || !registry) fail('EETF_ENGINE_CONFIG', 'store and registry are required');
  let running = null; // { jobId, controller, cancelled, timedOut, promptId }

  /** Fills defaults from what the engine reported (never a value the engine did not list). */
  function complete(params, snapshot) {
    const pick = (wanted, reported, allowed, fallback) => wanted ?? (reported.includes(fallback) ? fallback : reported.find(x => allowed.includes(x)));
    return {
      ...params,
      steps: params.steps ?? 20, cfg: params.cfg ?? 7, batchSize: params.batchSize ?? 1,
      sampler: pick(params.sampler, snapshot.samplers, SAMPLERS, 'euler'),
      scheduler: pick(params.scheduler, snapshot.schedulers, SCHEDULERS, 'normal'),
    };
  }

  /** Validates, negotiates and queues a GENERATE job. The seed is fixed now (recorded, reused by a retry). */
  async function submit(params, { signal } = {}) {
    const seeded = { ...params, seed: params?.seed ?? crypto.randomInt(0, 2 ** 47) };
    const v = validateJobParams('GENERATE', seeded);
    const snapshot = await registry.refresh(providerId, { signal });
    const n = negotiate(snapshot, v.params);
    if (!n.ok) fail(`EETF_${n.code}`, n.message);
    const full = complete({ ...v.params, model: n.model }, snapshot);
    return store.createJob({ kind: 'GENERATE', params: full, provider: providerId, model: n.model });
  }

  async function run(jobId) {
    if (running) fail('EETF_ENGINE_BUSY', 'a generation is already running (one GPU slot)');
    const job = store.getJob(jobId);
    if (job.kind !== 'GENERATE') fail('EETF_INVALID_JOB_KIND', 'this engine only runs GENERATE jobs');
    store.startJob(jobId);
    const controller = new AbortController();
    running = { jobId, controller, cancelled: false, timedOut: false, promptId: null };
    const r = running;
    const timer = setTimeout(() => { r.timedOut = true; controller.abort(); }, timeoutMs);
    const failWith = (code, message) => (r.cancelled ? store.getJob(jobId) : store.failJob(jobId, { code, message: message ? String(message).slice(0, 480) : null }));
    try {
      const adapter = registry.get(providerId);
      const snapshot = await registry.refresh(providerId, { signal: controller.signal });
      // [EETF-CERT] the job timer (or a cancel) firing during the readiness probe is a timeout / cancel, not "provider not ready"
      if (r.cancelled) return store.getJob(jobId);
      if (r.timedOut) return failWith(GENERATION_ERROR.PROVIDER_TIMEOUT, `no result within ${timeoutMs} ms (the readiness check did not finish; no prompt was sent); ${GPU_NOTE}`);
      const n = negotiate(snapshot, job.params);
      if (!n.ok) return failWith(n.code, n.message);
      store.updateProgress(jobId, 0.1);
      const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs) + 1);
      let result;
      try {
        result = await adapter.generate(job.params, { signal: controller.signal, intervalMs: pollIntervalMs, maxAttempts, onPromptId: (id) => { r.promptId = id; } });
      } catch (e) {
        if (r.cancelled) return store.getJob(jobId);
        if (r.timedOut || e?.code === 'PROVIDER_TIMEOUT') {
          const it = r.promptId ? await adapter.interrupt(r.promptId) : null;
          return failWith(GENERATION_ERROR.PROVIDER_TIMEOUT, `no result within ${timeoutMs} ms; interrupt ${it ? `requested (queue delete ${it.queueDeleteAccepted}, interrupt ${it.interruptAccepted})` : 'not sent (no prompt id)'}; ${GPU_NOTE}`);
        }
        return failWith(mapProviderError(e), e?.message);
      }
      if (r.cancelled) return store.getJob(jobId);
      store.updateProgress(jobId, 0.8);

      // ── validate every output before storing any ──
      const prepared = [];
      for (const [index, raw] of result.images.entries()) {
        if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > limit('maxFileSize')) return failWith(GENERATION_ERROR.OUTPUT_INVALID, `output ${index} is empty or too large`);
        let info;
        try { info = sniffImage(raw); } catch { return failWith(GENERATION_ERROR.OUTPUT_INVALID, `output ${index} is not a readable image`); }
        if (info.format !== 'PNG') return failWith(GENERATION_ERROR.OUTPUT_INVALID, `output ${index} is ${info.format}, the template saves PNG`);
        try { assertImageBudget(info); } catch (e) { return failWith(GENERATION_ERROR.OUTPUT_INVALID, `output ${index}: ${e.message}`); }
        if (info.width !== job.params.width || info.height !== job.params.height) return failWith(GENERATION_ERROR.OUTPUT_INVALID, `output ${index} is ${info.width}×${info.height}, requested ${job.params.width}×${job.params.height}`);
        let stripped;
        try { stripped = stripPngMetadata(raw); } catch (e) { return failWith(GENERATION_ERROR.OUTPUT_INVALID, `output ${index}: ${e.message}`); }
        // [EETF-CERT] a truncated / damaged provider PNG is refused before any provenance is written
        try { assertStructurallyIntact(stripped.buffer, info); } catch (e) { return failWith(GENERATION_ERROR.OUTPUT_INVALID, `output ${index}: ${e.message}`); }
        prepared.push({ index, buffer: stripped.buffer, removed: stripped.removed });
      }
      if (r.cancelled) return store.getJob(jobId);
      store.updateProgress(jobId, 0.9);

      // ── content-addressed assets + provenance ──
      const ids = [];
      for (const p of prepared) {
        const sha = crypto.createHash('sha256').update(p.buffer).digest('hex');
        let asset = store.getAssetBySha(sha);
        if (!asset) {
          const prov = store.createProvenance({
            provider: providerId, model: job.params.model, prompt: job.params.prompt, negativePrompt: job.params.negativePrompt ?? null,
            seed: job.params.seed, width: job.params.width, height: job.params.height, engineVersion: snapshot.health.engineVersion, strictLocal: true,
            parameters: {
              template: WORKFLOW_TEMPLATE_ID, steps: job.params.steps, cfg: job.params.cfg, sampler: job.params.sampler, scheduler: job.params.scheduler,
              batchSize: job.params.batchSize, batchIndex: p.index, target: job.params.target, ...(job.params.environmentType ? { environmentType: job.params.environmentType } : {}),
              ...(job.params.textureRole ? { textureRole: job.params.textureRole } : {}), metadataRemoved: p.removed, vram: { status: n.vram.status, estimateMb: n.vram.estimateMb, provisional: true },
            },
          });
          asset = store.registerAsset({ buffer: p.buffer, declaredMime: FORMAT_MIME.PNG, role: 'GENERATED', provenanceId: prov.id, sourceJobId: jobId, displayName: `generated-${jobId.slice(0, 8)}-${p.index}` }).asset;
        }
        ids.push(asset.id);
      }
      if (r.cancelled) return store.getJob(jobId);
      const done = store.completeJob(jobId, { outputAssetIds: ids });
      logger?.info?.({ jobId, outputs: ids.length }, 'EETF generation completed');
      return done;
    } catch (e) {
      if (r.cancelled) return store.getJob(jobId);
      logger?.warn?.({ jobId, err: e.message }, 'EETF generation error');
      return failWith(mapProviderError(e), e?.message);
    } finally {
      clearTimeout(timer);
      running = null;
    }
  }

  /**
   * QUEUED → CANCELLED. RUNNING → CANCELLED: the polling is aborted and ComfyUI is
   * asked to drop / interrupt OUR prompt (only when its id is known).
   */
  async function cancel(jobId) {
    const res = store.cancelJob(jobId);
    let interrupt = null;
    if (res.interruptRequired && running?.jobId === jobId) {
      running.cancelled = true;
      const promptId = running.promptId;
      running.controller.abort();
      if (promptId) interrupt = await registry.get(providerId).interrupt(promptId);
    }
    return freezeDeep({ job: res.job, interruptRequired: res.interruptRequired, interrupt, gpuStopGuaranteed: false, note: res.interruptRequired ? GPU_NOTE : null });
  }

  async function runNext() {
    if (running) return null;
    const next = store.listJobs({ status: JOB_STATUS.QUEUED, limit: 200 }).filter(j => j.kind === 'GENERATE').at(-1);
    return next ? run(next.id) : null;
  }

  return Object.freeze({ submit, run, runNext, cancel, isRunning: () => running?.jobId ?? null });
}
