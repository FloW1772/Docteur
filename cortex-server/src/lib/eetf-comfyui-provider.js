// EETF V1 — ComfyUI provider adapter (EETF-4).
//
// Talks to an ALREADY RUNNING, loopback-only ComfyUI through the hardened client
// of providers/comfyui.js (single ComfyUI client of Docteur; Root Policy
// AI_LOCAL_REQUEST, module `ai`, before every request). EETF never installs,
// downloads or starts ComfyUI.
//
// Workflows are never accepted from a caller: they are built here from ONE
// fixed template (`eetf-txt2img-v1`) with whitelisted, validated values, and
// the result is re-validated against the template before it is sent.
// Capabilities are reported only when the engine proved them in the probe.

import crypto from 'node:crypto';
import { createComfyUiClient, ComfyUiError, COMFYUI_DEFAULT_ENDPOINT, COMFYUI_QUERYABLE_NODES, validateOutputRef } from './providers/comfyui.js';
import { EetfError, SAMPLERS, SCHEDULERS, limit, validateProviderAndModel, freezeDeep } from './eetf-contracts.js';
import { PROVIDER_STATE } from './eetf-providers.js';

const fail = (code, message) => { throw new EetfError(code, message); };

export const WORKFLOW_TEMPLATE_ID = 'eetf-txt2img-v1';
export const SAVE_NODE_ID = '9';
const TXT2IMG_NODES = ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'];

/** The only workflow EETF ever sends. Values come from validated params; filename_prefix is a constant (never the prompt). */
export function buildWorkflow(p) {
  return {
    '3': { class_type: 'KSampler', inputs: { seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.model } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: p.batchSize } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negativePrompt ?? '', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    [SAVE_NODE_ID]: { class_type: 'SaveImage', inputs: { filename_prefix: 'eetf', images: ['8', 0] } },
  };
}

const TEMPLATE_SHAPE = freezeDeep({
  '3': { class_type: 'KSampler', inputs: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', 'model', 'positive', 'negative', 'latent_image'] },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: ['ckpt_name'] },
  '5': { class_type: 'EmptyLatentImage', inputs: ['width', 'height', 'batch_size'] },
  '6': { class_type: 'CLIPTextEncode', inputs: ['text', 'clip'] },
  '7': { class_type: 'CLIPTextEncode', inputs: ['text', 'clip'] },
  '8': { class_type: 'VAEDecode', inputs: ['samples', 'vae'] },
  '9': { class_type: 'SaveImage', inputs: ['filename_prefix', 'images'] },
});
const LINKS = freezeDeep({ '3.model': ['4', 0], '3.positive': ['6', 0], '3.negative': ['7', 0], '3.latent_image': ['5', 0], '6.clip': ['4', 1], '7.clip': ['4', 1], '8.samples': ['3', 0], '8.vae': ['4', 2], '9.images': ['8', 0] });

/** Defence in depth: the workflow must be EXACTLY the template (nodes, classes, inputs, links, value types). */
export function validateWorkflow(wf) {
  const bad = (m) => fail('EETF_WORKFLOW_INVALID', m);
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) bad('workflow must be an object');
  const ids = Object.keys(wf).sort();
  if (ids.join(',') !== Object.keys(TEMPLATE_SHAPE).sort().join(',')) bad('unexpected node set');
  for (const id of ids) {
    const node = wf[id]; const shape = TEMPLATE_SHAPE[id];
    if (!node || Object.keys(node).sort().join(',') !== 'class_type,inputs') bad(`node ${id} has unexpected fields`);
    if (node.class_type !== shape.class_type) bad(`node ${id} is not ${shape.class_type}`);
    if (Object.keys(node.inputs ?? {}).sort().join(',') !== [...shape.inputs].sort().join(',')) bad(`node ${id} has unexpected inputs`);
    for (const [k, v] of Object.entries(node.inputs)) {
      const link = LINKS[`${id}.${k}`];
      if (link) { if (!Array.isArray(v) || v.length !== 2 || v[0] !== link[0] || v[1] !== link[1]) bad(`link ${id}.${k} altered`); continue; }
      if (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'string') bad(`${id}.${k} must be a finite number or a string`);
    }
  }
  const s = wf['3'].inputs; const l = wf['5'].inputs;
  if (!SAMPLERS.includes(s.sampler_name) || !SCHEDULERS.includes(s.scheduler) || s.denoise !== 1) bad('sampler / scheduler / denoise outside the template');
  if (!Number.isSafeInteger(s.seed) || s.seed < 0 || !Number.isSafeInteger(s.steps) || s.steps < 1 || s.steps > 150 || s.cfg < 0 || s.cfg > 30) bad('sampler values out of range');
  if (!Number.isSafeInteger(l.width) || !Number.isSafeInteger(l.height) || l.width % 8 || l.height % 8 || l.width < 64 || l.height < 64
    || l.width > limit('maxGenerationSide') || l.height > limit('maxGenerationSide') || l.width * l.height > limit('maxGenerationPixels')) bad('latent size outside the limits');
  if (!Number.isSafeInteger(l.batch_size) || l.batch_size < 1 || l.batch_size > limit('maxBatch')) bad('batch size outside the limits');
  if (wf['9'].inputs.filename_prefix !== 'eetf') bad('filename prefix altered');
  for (const t of [wf['6'].inputs.text, wf['7'].inputs.text]) if (t.length > limit('maxPromptChars')) bad('prompt too long');
  validateProviderAndModel({ model: wf['4'].inputs.ckpt_name });
  return wf;
}

const historyDone = (e) => e?.status?.completed === true || e?.status?.status_str === 'error' || e?.status?.status_str === 'success';

/**
 * @param {{ endpoint?: string, enforce: Function, probeTimeoutMs?: number, requestTimeoutMs?: number }} opts
 */
export function createComfyUiProvider({ endpoint = COMFYUI_DEFAULT_ENDPOINT, enforce, probeTimeoutMs = limit('providerProbeTimeoutMs'), requestTimeoutMs = limit('providerRequestTimeoutMs') }) {
  let client = null; let configError = null;
  try { client = createComfyUiClient({ endpoint, enforce, requestTimeoutMs }); } catch (e) { configError = e; }
  const base = { providerId: 'comfyui', displayName: 'ComfyUI (local)', locality: 'LOOPBACK' };

  async function probe({ signal } = {}) {
    if (configError) return { ...base, status: configError.code === 'PROVIDER_REFUSED' ? PROVIDER_STATE.REFUSED : PROVIDER_STATE.MISCONFIGURED, reason: configError.message };
    const t0 = Date.now();
    let stats;
    try {
      stats = await client.systemStats({ signal, timeoutMs: probeTimeoutMs });
    } catch (e) {
      const status = e.code === 'PROVIDER_REFUSED' ? PROVIDER_STATE.REFUSED
        : ['HTTP_ERROR', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(e.code) ? PROVIDER_STATE.DEGRADED : PROVIDER_STATE.UNAVAILABLE;
      return { ...base, status, reason: `${e.code}: ${e.message}`.slice(0, 200) };
    }
    const devices = (Array.isArray(stats?.devices) ? stats.devices : []).slice(0, 8).map(d => ({
      name: typeof d?.name === 'string' ? d.name.slice(0, 80) : null,
      vramTotalMb: Number.isFinite(d?.vram_total) ? Math.round(d.vram_total / 1048576) : null,
    }));
    const engineVersion = typeof stats?.system?.comfyui_version === 'string' ? stats.system.comfyui_version.slice(0, 40) : null;
    const nodes = {};
    for (const n of TXT2IMG_NODES) {
      if (!COMFYUI_QUERYABLE_NODES.includes(n)) continue;
      try { nodes[n] = await client.nodeInfo(n, { signal, timeoutMs: probeTimeoutMs }); } catch { nodes[n] = null; }
    }
    const list = (v) => (Array.isArray(v) ? v : []);
    const models = []; let skippedModels = 0;
    for (const m of list(nodes.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]).slice(0, 500)) {
      try { if (typeof m !== 'string') throw new Error('not text'); validateProviderAndModel({ model: m }); models.push(m); } catch { skippedModels++; }
    }
    const samplers = list(nodes.KSampler?.input?.required?.sampler_name?.[0]).filter(x => SAMPLERS.includes(x));
    const schedulers = list(nodes.KSampler?.input?.required?.scheduler?.[0]).filter(x => SCHEDULERS.includes(x));
    const missingNodes = TXT2IMG_NODES.filter(n => !nodes[n]);
    const capabilities = [];
    let status = PROVIDER_STATE.DEGRADED; let reason = null;
    if (missingNodes.length) reason = `missing nodes: ${missingNodes.join(', ')}`;
    else if (!models.length) reason = 'no checkpoint installed';
    else if (!samplers.length || !schedulers.length) reason = 'no allowed sampler / scheduler reported';
    else {
      status = PROVIDER_STATE.AVAILABLE;
      capabilities.push('TXT2IMG', 'SEED', 'NEGATIVE_PROMPT'); // all three are inputs of the verified template nodes
      if (await client.interruptSupported({ signal, timeoutMs: probeTimeoutMs })) capabilities.push('CANCELLATION');
    }
    if (skippedModels) reason = `${reason ? `${reason}; ` : ''}${skippedModels} model name(s) refused (path-like)`;
    return {
      ...base, status, reason, capabilities, models, samplers, schedulers, devices, engineVersion,
      vramTotalMb: devices.find(d => Number.isFinite(d.vramTotalMb))?.vramTotalMb ?? null, latencyMs: Date.now() - t0,
    };
  }

  /**
   * Runs one validated request. Resolves { images: Buffer[], promptId }; throws ComfyUiError / EetfError.
   * Output references are ALL validated before the first /view request.
   */
  async function generate(req, { signal, intervalMs, maxAttempts, onPromptId } = {}) {
    if (!client) throw configError;
    const wf = validateWorkflow(buildWorkflow(req));
    const promptId = await client.submit(wf, crypto.randomUUID(), { signal });
    onPromptId?.(promptId);
    const entry = await client.pollHistory(promptId, { intervalMs, maxAttempts, signal, isDone: historyDone });
    if (entry?.status?.status_str === 'error') {
      const oom = /out of memory|CUDA|VRAM/i.test(JSON.stringify(entry.status.messages ?? []).slice(0, 20_000));
      throw new ComfyUiError('GENERATION_FAILED', oom ? 'the engine ran out of GPU memory' : 'the engine reported an execution error');
    }
    const refs = entry?.outputs?.[SAVE_NODE_ID]?.images;
    if (!Array.isArray(refs) || refs.length === 0) throw new ComfyUiError('OUTPUT_MISSING', 'the engine reported no output image');
    if (refs.length !== req.batchSize) throw new ComfyUiError('OUTPUT_INVALID', `expected ${req.batchSize} image(s), the engine listed ${refs.length}`);
    const valid = refs.map(validateOutputRef);
    const images = [];
    for (const r of valid) images.push(await client.view(r, { signal, maxBytes: limit('maxFileSize') }));
    return { images, promptId };
  }

  return Object.freeze({
    ...base, probe, generate,
    interrupt: (promptId) => (client ? client.interrupt(promptId) : Promise.resolve({ queueDeleteAccepted: false, interruptAccepted: false })),
    requestCount: () => client?.requestCount() ?? 0,
  });
}
