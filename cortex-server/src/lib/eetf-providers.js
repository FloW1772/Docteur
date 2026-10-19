// EETF V1 — provider contract, registry and capability negotiation (EETF-4).
//
// A provider snapshot is built from what the engine REALLY reported during its
// last probe; a capability is listed only when it was verified. A provider that
// is absent is UNAVAILABLE — a normal state, not an EETF error.
//
// No network here: adapters (eetf-comfyui-provider.js) talk to their engine
// through their own hardened client.

import { EetfError, limit, freezeDeep } from './eetf-contracts.js';

const fail = (code, message, details) => { throw new EetfError(code, message, details); };
const enumOf = (...values) => Object.freeze(Object.fromEntries(values.map(v => [v, v])));

export const PROVIDER_STATE = enumOf('UNAVAILABLE', 'AVAILABLE', 'DEGRADED', 'MISCONFIGURED', 'REFUSED');
export const PROVIDER_CAPABILITY = enumOf('TXT2IMG', 'IMAGE_TO_IMAGE', 'SEAMLESS_TEXTURE', 'PANORAMA_REFERENCE', 'CANCELLATION', 'SEED', 'NEGATIVE_PROMPT');
export const PROVIDER_LOCALITY = enumOf('LOOPBACK', 'IN_PROCESS');
export const GENERATION_MODE = enumOf('TXT2IMG');

/** Errors a generation job can end with (EETF-4 error model). */
export const GENERATION_ERROR = enumOf(
  'PROVIDER_UNAVAILABLE', 'PROVIDER_REFUSED', 'PROVIDER_TIMEOUT', 'MODEL_NOT_FOUND', 'WORKFLOW_INVALID', 'VRAM_GUARD',
  'GENERATION_FAILED', 'OUTPUT_MISSING', 'OUTPUT_INVALID', 'CAPABILITY_UNSUPPORTED', 'PROVIDER_NOT_READY',
);

/**
 * Normalises a provider snapshot. `capabilities` must be a subset of the known
 * names; `models` / `samplers` / `schedulers` are the lists the engine returned.
 */
export function makeProviderSnapshot(s) {
  if (!s || typeof s !== 'object') fail('EETF_INVALID_PROVIDER', 'snapshot must be an object');
  if (typeof s.providerId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s.providerId)) fail('EETF_INVALID_PROVIDER', 'invalid providerId');
  if (!PROVIDER_STATE[s.status]) fail('EETF_INVALID_PROVIDER', 'invalid status');
  if (!PROVIDER_LOCALITY[s.locality]) fail('EETF_INVALID_PROVIDER', 'invalid locality');
  const caps = [...new Set(s.capabilities ?? [])];
  for (const c of caps) if (!PROVIDER_CAPABILITY[c]) fail('EETF_INVALID_PROVIDER', `unknown capability ${String(c).slice(0, 40)}`);
  if (s.status !== 'AVAILABLE' && caps.includes('TXT2IMG')) fail('EETF_INVALID_PROVIDER', 'only an AVAILABLE provider can offer TXT2IMG');
  const strings = (xs) => [...new Set((xs ?? []).filter(x => typeof x === 'string'))];
  return freezeDeep({
    providerId: s.providerId,
    displayName: String(s.displayName ?? s.providerId).slice(0, 80),
    kind: 'LOCAL',
    locality: s.locality,
    status: s.status,
    reason: s.reason ?? null,
    capabilities: caps.sort(),
    generationModes: caps.includes('TXT2IMG') ? [GENERATION_MODE.TXT2IMG] : [],
    models: strings(s.models),
    samplers: strings(s.samplers),
    schedulers: strings(s.schedulers),
    limits: {
      maxGenerationSide: limit('maxGenerationSide'), maxGenerationPixels: limit('maxGenerationPixels'), maxBatch: limit('maxBatch'),
      vramTotalMb: Number.isFinite(s.vramTotalMb) ? s.vramTotalMb : null,
    },
    health: { engineVersion: s.engineVersion ?? null, devices: s.devices ?? [], checkedAt: s.checkedAt ?? new Date().toISOString(), latencyMs: s.latencyMs ?? null },
  });
}

/**
 * VRAM guard (PROVISIONAL). Estimate = model baseline + per-image activations
 * scaled by pixel count and batch size:
 *   estimateMb = vramModelBaselineMb + batchSize × ceil(width × height / 512²) × vramPer512ImageMb
 * Both constants are PROVISIONAL / TO_MEASURE. The guard only refuses what is
 * MANIFESTLY too heavy: an estimate above the TOTAL VRAM the engine reports
 * (not the momentary free VRAM). With no VRAM figure the request is not
 * refused and the result says so (status VRAM_UNKNOWN).
 */
export function vramCheck({ width, height, batchSize = 1 }, vramTotalMb) {
  const units = Math.ceil((width * height) / (512 * 512));
  const estimateMb = limit('vramModelBaselineMb') + batchSize * units * limit('vramPer512ImageMb');
  const formula = `${limit('vramModelBaselineMb')} + ${batchSize} × ${units} × ${limit('vramPer512ImageMb')} = ${estimateMb} MiB`;
  if (!Number.isFinite(vramTotalMb)) return freezeDeep({ status: 'VRAM_UNKNOWN', estimateMb, vramTotalMb: null, formula, provisional: true });
  return freezeDeep({ status: estimateMb > vramTotalMb ? 'REFUSED' : 'OK', estimateMb, vramTotalMb, formula, provisional: true });
}

/**
 * Capability negotiation: which capabilities a validated GENERATE request
 * needs, and whether the provider snapshot offers them (plus model / sampler /
 * scheduler membership in the lists the engine reported).
 * @returns {{ ok: true, model: string, vram: object } | { ok: false, code: string, message: string }}
 */
export function negotiate(snapshot, params) {
  const no = (code, message) => freezeDeep({ ok: false, code, message });
  if (snapshot.status === 'REFUSED') return no(GENERATION_ERROR.PROVIDER_REFUSED, snapshot.reason ?? 'provider refused');
  if (snapshot.status === 'UNAVAILABLE') return no(GENERATION_ERROR.PROVIDER_UNAVAILABLE, snapshot.reason ?? 'provider unavailable');
  if (snapshot.status !== 'AVAILABLE') return no(GENERATION_ERROR.PROVIDER_NOT_READY, `provider is ${snapshot.status}${snapshot.reason ? `: ${snapshot.reason}` : ''}`);
  const needs = ['TXT2IMG'];
  if (params.negativePrompt) needs.push('NEGATIVE_PROMPT');
  if (params.seed !== undefined) needs.push('SEED');
  const missing = needs.filter(c => !snapshot.capabilities.includes(c));
  if (missing.length) return no(GENERATION_ERROR.CAPABILITY_UNSUPPORTED, `missing capability: ${missing.join(', ')}`);
  if (params.environmentType === 'PANORAMA_REFERENCE' && params.width !== 2 * params.height) {
    return no(GENERATION_ERROR.WORKFLOW_INVALID, 'a PANORAMA_REFERENCE is generated at exactly 2:1 (and stays NOT_SEAM_VERIFIED)');
  }
  if (params.width % 8 !== 0 || params.height % 8 !== 0) return no(GENERATION_ERROR.WORKFLOW_INVALID, 'width and height must be multiples of 8 (latent grid)');
  let model = params.model;
  if (model === undefined) {
    if (snapshot.models.length !== 1) return no(GENERATION_ERROR.MODEL_NOT_FOUND, snapshot.models.length ? 'several models are installed: choose one explicitly' : 'no model reported by the engine');
    model = snapshot.models[0];
  } else if (!snapshot.models.includes(model)) {
    return no(GENERATION_ERROR.MODEL_NOT_FOUND, 'model is not in the list reported by the engine');
  }
  if (params.sampler !== undefined && !snapshot.samplers.includes(params.sampler)) return no(GENERATION_ERROR.WORKFLOW_INVALID, 'sampler not reported by the engine');
  if (params.scheduler !== undefined && !snapshot.schedulers.includes(params.scheduler)) return no(GENERATION_ERROR.WORKFLOW_INVALID, 'scheduler not reported by the engine');
  const vram = vramCheck({ width: params.width, height: params.height, batchSize: params.batchSize ?? 1 }, snapshot.limits.vramTotalMb);
  if (vram.status === 'REFUSED') return no(GENERATION_ERROR.VRAM_GUARD, `estimated ${vram.estimateMb} MiB > ${vram.vramTotalMb} MiB total VRAM (${vram.formula}, PROVISIONAL)`);
  return freezeDeep({ ok: true, model, vram });
}

/** Registry of provider adapters. V1 registers ComfyUI (loopback) only. */
export function createProviderRegistry() {
  const adapters = new Map();
  const snapshots = new Map();
  return Object.freeze({
    register(adapter) {
      if (!adapter || typeof adapter.probe !== 'function' || typeof adapter.generate !== 'function') fail('EETF_INVALID_PROVIDER', 'an adapter needs probe() and generate()');
      if (adapters.has(adapter.providerId)) fail('EETF_INVALID_PROVIDER', `provider ${adapter.providerId} already registered`);
      if (adapter.locality !== 'LOOPBACK' && adapter.locality !== 'IN_PROCESS') fail('EETF_INVALID_PROVIDER', 'V1 only registers local providers');
      adapters.set(adapter.providerId, adapter);
    },
    get(providerId) {
      const a = adapters.get(providerId);
      if (!a) fail('EETF_PROVIDER_NOT_FOUND', `unknown provider ${String(providerId).slice(0, 40)}`);
      return a;
    },
    list: () => [...adapters.keys()],
    /** Probes one provider (bounded by the adapter) and stores the snapshot. Never throws for an absent engine. */
    async refresh(providerId, { signal } = {}) {
      const snap = makeProviderSnapshot(await this.get(providerId).probe({ signal }));
      snapshots.set(providerId, snap);
      return snap;
    },
    snapshot: (providerId) => snapshots.get(providerId) ?? null,
    async refreshAll({ signal } = {}) {
      const out = {};
      for (const id of adapters.keys()) out[id] = await this.refresh(id, { signal });
      return out;
    },
  });
}
