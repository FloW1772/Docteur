// Model Router V1 — one registry of providers and models, deterministic routing
// (manual / AUTO), capability routing, Strict Local, low-VRAM facts and clear
// failures. Built on what exists:
//   • router.js       — cloud provider configuration (cloudCandidates), the
//                        provider capability table (TASK_CAPABILITIES), Strict Local;
//   • ollama.js        — the local runtime (chatCompletion);
//   • local-ai-catalog — official facts for catalogued models;
//   • local-model-fit  — deterministic hardware fit for catalogued distributions;
//   • local-hardware-profile — detected GPU/RAM.
//
// Every fact carries its source. Nothing is invented: a value the runtime does
// not report and the catalogue does not state is null ("unknown"), never a guess.
// AUTO never sends to the cloud because a local call failed: the route is
// decided up front and executed once; a failure is reported, not re-routed.
import { TASK_CAPABILITIES, CLOUD_PROVIDER_IDS, cloudCandidates } from './router.js';
import { chatCompletion } from './ollama.js';
import { MODEL_CATALOG, MODEL_DISTRIBUTIONS } from './local-ai-catalog.js';
import { evaluateModelFit } from './local-model-fit.js';
import { getTotalVramBytes } from './local-hardware-profile.js';

export const CAPABILITIES = Object.freeze(['TEXT', 'VISION', 'AUDIO', 'EMBEDDING', 'TOOL_USE', 'STRUCTURED_OUTPUT', 'IMAGE_GENERATION', 'LONG_CONTEXT']);
/** Context length from which a model is tagged LONG_CONTEXT (tokens). */
export const LONG_CONTEXT_TOKENS = 32_768;
/** Identity of these targets has not been provided: never claimed as integrated. */
export const PENDING_IDENTITY_TARGETS = Object.freeze([
  { target: 'Qwen (optimisé faible VRAM)', status: 'MODEL_IDENTITY_REQUIRED' },
  { target: 'Kolibri', status: 'MODEL_IDENTITY_REQUIRED' },
]);
const LIMITS = Object.freeze({ numCtxMin: 256, numCtxMax: 1_048_576, numGpuMax: 1_000, timeoutMinMs: 1_000, timeoutMaxMs: 600_000, defaultTimeoutMs: 120_000 });

const PROVIDER_LABELS = Object.freeze({
  ollama: 'Ollama (local)', pair: 'PAIR (machine du réseau local)', gemini: 'Google Gemini', groq: 'Groq', openrouter: 'OpenRouter',
  anthropic: 'Anthropic (API)', openai: 'OpenAI (API)', freellmapi: 'FreeLLMAPI', 'claude-oauth': 'Claude (abonnement)', codex: 'OpenAI Codex (abonnement)',
  comfyui: 'ComfyUI (local)', 'cloudflare-image': 'Cloudflare Images', 'huggingface-image': 'Hugging Face Images', 'pollinations-image': 'Pollinations',
});
const PAID_API = new Set(['anthropic', 'openai']);
const IMAGE_PROVIDERS = Object.freeze([
  { id: 'comfyui', location: 'LOCAL', runtime: 'COMFYUI' },
  { id: 'cloudflare-image', location: 'CLOUD', runtime: 'API' },
  { id: 'huggingface-image', location: 'CLOUD', runtime: 'API' },
  { id: 'pollinations-image', location: 'CLOUD', runtime: 'API' },
]);

export class ModelRouteError extends Error {
  constructor(code, message, { hint = null, status = 422, detail = null } = {}) {
    super(message);
    this.code = code; this.hint = hint; this.status = status; this.detail = detail;
  }
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export function normalizeCapabilities(list) {
  const out = [];
  for (const raw of Array.isArray(list) && list.length ? list : ['TEXT']) {
    const cap = String(raw).trim().toUpperCase();
    if (!CAPABILITIES.includes(cap)) throw new ModelRouteError('UNKNOWN_CAPABILITY', `Capacité inconnue : ${raw}`, { status: 400 });
    if (!out.includes(cap)) out.push(cap);
  }
  return out;
}

/** Ollama /api/show "capabilities" (completion, vision, tools, embedding, audio, thinking, insert). */
export function capabilitiesFromRuntime(list) {
  if (!Array.isArray(list)) return null;
  const caps = new Set();
  for (const c of list.map(String)) {
    if (c === 'completion') { caps.add('TEXT'); caps.add('STRUCTURED_OUTPUT'); } // Ollama enforces a JSON schema via `format` for completion models
    if (c === 'vision') caps.add('VISION');
    if (c === 'tools') caps.add('TOOL_USE');
    if (c === 'embedding') caps.add('EMBEDDING');
    if (c === 'audio') caps.add('AUDIO');
  }
  return [...caps];
}

export function capabilitiesFromCatalog(entry) {
  if (!entry) return null;
  const caps = new Set();
  if (entry.modalities?.includes('text')) caps.add('TEXT');
  if (entry.capabilities?.vision) caps.add('VISION');
  if (entry.capabilities?.toolCalling) caps.add('TOOL_USE');
  if (entry.capabilities?.audio) caps.add('AUDIO');
  if ((entry.contextLength?.native ?? 0) >= LONG_CONTEXT_TOKENS) caps.add('LONG_CONTEXT');
  return [...caps];
}

export function capabilitiesFromTaskTable(providerId) {
  const set = TASK_CAPABILITIES[providerId];
  if (!set) return null;
  const caps = new Set();
  if (set.has('text')) caps.add('TEXT');
  if (set.has('json') || set.has('structured_output')) caps.add('STRUCTURED_OUTPUT');
  if (set.has('vision')) caps.add('VISION');
  if (set.has('tools')) caps.add('TOOL_USE');
  if (set.has('long_context')) caps.add('LONG_CONTEXT');
  return [...caps];
}

// ── Registry ─────────────────────────────────────────────────────────────────

const fact = (value, source) => ({ value: value ?? null, source: value === null || value === undefined ? 'unknown' : source });

function contextLengthFromShow(show) {
  const info = show?.model_info ?? show?.modelinfo ?? null;
  if (!info || typeof info !== 'object') return null;
  const key = Object.keys(info).find(k => k.endsWith('.context_length'));
  const value = key ? Number(info[key]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** num_gpu is only known when the model's own parameters set it. */
function numGpuFromShow(show) {
  const m = String(show?.parameters ?? '').match(/^\s*num_gpu\s+(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

export function isCloudTag(name, details = null) {
  return /-cloud(?:$|[:@])|:cloud$/i.test(String(name)) || Boolean(details?.remote_host);
}

function catalogMatch(name) {
  const dist = MODEL_DISTRIBUTIONS.find(d => d.ollamaPullName && d.ollamaPullName === name) ?? null;
  const entry = dist ? MODEL_CATALOG.find(m => m.canonicalId === dist.canonicalId) ?? null : null;
  return { dist, entry };
}

/**
 * @param {object} input
 * @param {{reachable:boolean, error?:string, installed:Array, shows:Record<string, any>, loaded:Array}} input.runtime
 * @param {object|null} input.hardware  local-hardware-profile result (or null)
 * @param {object} input.settings       router settings
 * @param {Array<{providerId:string, paid?:boolean}>|null} input.cloud  configured cloud providers (null = not probed)
 */
export function buildRegistry({ runtime, hardware = null, settings = {}, cloud = null, pair = { configured: false } }) {
  const strictLocal = settings.strict_local_mode === true;
  const cloudEnabled = settings.cloud_enabled === true;
  const cloudAllowed = !strictLocal && cloudEnabled;
  const providers = [];
  const models = [];

  // Local runtime (Ollama).
  providers.push({
    id: 'ollama', label: PROVIDER_LABELS.ollama, location: 'LOCAL', runtime: 'OLLAMA', kind: 'llm', paid: false,
    configured: true, available: runtime.reachable === true,
    status: runtime.reachable ? 'AVAILABLE' : 'RUNTIME_UNAVAILABLE',
    reason: runtime.reachable ? null : `Ollama ne répond pas${runtime.error ? ` (${runtime.error})` : ''}.`,
  });
  const loadedByName = new Map((runtime.loaded ?? []).map(m => [m.name ?? m.model, m]));
  for (const m of runtime.installed ?? []) {
    const name = m.name ?? m.model;
    if (!name) continue;
    const details = m.details ?? {};
    const show = runtime.shows?.[name] ?? null;
    const { dist, entry } = catalogMatch(name);
    const cloudTag = isCloudTag(name, details) || dist?.executionLocation === 'CLOUD';
    const runtimeCaps = capabilitiesFromRuntime(show?.capabilities);
    const catalogCaps = capabilitiesFromCatalog(entry);
    let capabilities = runtimeCaps ?? catalogCaps;
    const capabilitiesSource = runtimeCaps ? 'runtime' : (catalogCaps ? 'catalog' : 'unknown');
    const contextLength = contextLengthFromShow(show) ?? entry?.contextLength?.native ?? null;
    const contextSource = contextLengthFromShow(show) ? 'runtime' : (entry?.contextLength?.native ? 'catalog' : 'unknown');
    if (capabilities && contextLength >= LONG_CONTEXT_TOKENS && !capabilities.includes('LONG_CONTEXT') && capabilities.includes('TEXT')) capabilities = [...capabilities, 'LONG_CONTEXT'];
    const loaded = loadedByName.get(name);
    const sizeBytes = Number.isFinite(m.size) ? m.size : null;
    const fit = entry && dist && hardware ? evaluateModelFit(entry, dist, hardware) : null;
    models.push({
      id: `ollama:${name}`, provider: 'ollama', name, location: cloudTag ? 'CLOUD' : 'LOCAL', runtime: 'OLLAMA',
      installed: true, available: runtime.reachable === true && !(cloudTag && !cloudAllowed),
      capabilities: capabilities ?? [], capabilitiesKnown: capabilities !== null, capabilitiesSource,
      contextLength: fact(contextLength, contextSource),
      family: fact(details.family, 'runtime'),
      parameterSize: fact(details.parameter_size, 'runtime'),
      lowVram: {
        quantization: details.quantization_level ? fact(details.quantization_level, 'runtime') : fact(dist?.quantization ?? null, 'catalog'),
        sizeBytes: fact(sizeBytes, 'runtime'),
        gpuLayers: fact(numGpuFromShow(show), 'runtime'),
        loaded: loaded ? {
          sizeBytes: Number.isFinite(loaded.size) ? loaded.size : null,
          vramBytes: Number.isFinite(loaded.size_vram) ? loaded.size_vram : null,
          // Real offload: part of the loaded model lives in system RAM.
          ramOffloadBytes: Number.isFinite(loaded.size) && Number.isFinite(loaded.size_vram) ? Math.max(0, loaded.size - loaded.size_vram) : null,
        } : null,
        fit: fit ? { rating: fit.rating, estimates: fit.estimates, confidence: fit.confidence, source: 'local-model-fit' } : null,
      },
      catalog: entry ? { canonicalId: entry.canonicalId, license: entry.license ?? null, trustLevel: entry.trustLevel } : null,
    });
  }

  // LAN peer (PAIR): local network, never treated as Strict Local (same as router.js).
  providers.push({
    id: 'pair', label: PROVIDER_LABELS.pair, location: 'LAN', runtime: 'PAIR', kind: 'llm', paid: false,
    configured: pair.configured === true, available: pair.configured === true && !strictLocal,
    status: !pair.configured ? 'NOT_CONFIGURED' : (strictLocal ? 'DISABLED_BY_STRICT_LOCAL' : 'AVAILABLE'),
    reason: strictLocal && pair.configured ? 'Strict Local : seul le runtime de cette machine est utilisé.' : null,
  });

  // Cloud providers: configuration comes from router.js cloudCandidates (probed only when cloud is allowed).
  const configured = new Map((cloud ?? []).map(c => [c.providerId, c]));
  for (const id of CLOUD_PROVIDER_IDS) {
    let status = 'AVAILABLE';
    let reason = null;
    if (strictLocal) { status = 'DISABLED_BY_STRICT_LOCAL'; reason = 'Strict Local actif : aucun appel cloud.'; }
    else if (!cloudEnabled) { status = 'CLOUD_DISABLED'; reason = 'Cloud désactivé dans les réglages (opt-in requis).'; }
    else if (!configured.has(id)) { status = 'NOT_CONFIGURED'; reason = 'Non configuré (clé, abonnement ou option payante absente).'; }
    const caps = capabilitiesFromTaskTable(id) ?? [];
    providers.push({ id, label: PROVIDER_LABELS[id] ?? id, location: 'CLOUD', runtime: 'API', kind: 'llm', paid: configured.get(id)?.paid ?? PAID_API.has(id), configured: configured.has(id), available: status === 'AVAILABLE', status, reason });
    models.push({
      id: `${id}:default`, provider: id, name: `${PROVIDER_LABELS[id] ?? id} — modèle par défaut du provider`, location: 'CLOUD', runtime: 'API',
      installed: null, available: status === 'AVAILABLE', capabilities: caps, capabilitiesKnown: caps.length > 0, capabilitiesSource: 'router_table',
      contextLength: fact(null, 'unknown'), family: fact(null, 'unknown'), parameterSize: fact(null, 'unknown'),
      lowVram: null, catalog: null,
    });
  }

  // Image generation providers: listed for capability routing; their own module checks availability.
  for (const p of IMAGE_PROVIDERS) {
    const blocked = p.location === 'CLOUD' && !cloudAllowed;
    providers.push({
      id: p.id, label: PROVIDER_LABELS[p.id], location: p.location, runtime: p.runtime, kind: 'image', paid: false,
      configured: null, available: null,
      status: blocked ? (strictLocal ? 'DISABLED_BY_STRICT_LOCAL' : 'CLOUD_DISABLED') : 'CHECKED_BY_IMAGE_MODULE',
      reason: blocked ? 'Génération d’images cloud bloquée par les réglages.' : 'Disponibilité vérifiée par le Générateur d’images.',
    });
  }

  return {
    strictLocal, cloudEnabled, cloudAllowed,
    hardware: hardware ? { gpus: (hardware.gpus ?? []).map(g => ({ name: g.name ?? null, vramBytes: g.vramBytes ?? null })), totalVramBytes: getTotalVramBytes(hardware) || null, ramBytes: hardware.totalRamBytes ?? hardware.ramBytes ?? null } : null,
    providers, models,
    pendingIdentity: PENDING_IDENTITY_TARGETS,
  };
}

// ── Routing ──────────────────────────────────────────────────────────────────

const FIT_ORDER = { EXCELLENT: 0, GOOD: 1, TIGHT: 2, UNKNOWN: 3, NOT_RECOMMENDED: 4 };

/** Configured preference order for local text models (settings), most preferred first. */
function preferenceIndex(name, settings) {
  const order = [settings.chat_model, settings.powerful_model, settings.fallback_model].filter(Boolean);
  const i = order.indexOf(name);
  return i === -1 ? order.length : i;
}

function missingCaps(model, required) {
  return required.filter(c => !model.capabilities.includes(c));
}

/**
 * Deterministic route decision (no I/O). Same registry + request → same answer.
 * @returns {{ok:true, mode, decision, rejected, warnings}|{ok:false, mode, error:{code,message,hint}, rejected}}
 */
export function selectRoute(registry, { capabilities, mode = 'auto', provider = null, model = null, allowCloud = true, settings = {} } = {}) {
  const required = normalizeCapabilities(capabilities);
  const rejected = [];
  const fail = (code, message, hint = null) => ({ ok: false, mode, required, error: { code, message, hint }, rejected });

  if (mode === 'manual') {
    if (!provider || !model) return fail('MANUAL_SELECTION_INCOMPLETE', 'Sélection manuelle : choisissez un provider et un modèle.');
    const prov = registry.providers.find(p => p.id === provider);
    if (!prov) return fail('PROVIDER_NOT_FOUND', `Provider inconnu : ${provider}.`);
    if (prov.location !== 'LOCAL' && registry.strictLocal) return fail('STRICT_LOCAL_BLOCKS_CLOUD', `Strict Local actif : ${prov.label} n’est pas autorisé.`, 'Désactivez Strict Local dans Réglages → Confidentialité si vous voulez utiliser ce provider.');
    if (prov.location === 'CLOUD' && (!registry.cloudEnabled || allowCloud === false)) return fail('CLOUD_DISABLED', `Cloud désactivé : ${prov.label} n’est pas autorisé.`, 'Activez explicitement le cloud dans Réglages → Modèles.');
    // Provider first: with a stopped runtime, "installed or not" cannot be known.
    if (!prov.available) return fail(prov.status === 'RUNTIME_UNAVAILABLE' ? 'RUNTIME_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE', prov.reason ?? `${prov.label} indisponible.`, prov.id === 'ollama' ? 'Démarrez Ollama puis réessayez.' : null);
    const found = registry.models.find(m => m.provider === provider && (m.name === model || m.id === model));
    if (!found) {
      return prov.id === 'ollama'
        ? fail('MODEL_NOT_INSTALLED', `Le modèle « ${model} » n’est pas installé dans Ollama.`, 'Docteur ne télécharge jamais un modèle automatiquement : installez-le vous-même puis réessayez.')
        : fail('MODEL_NOT_FOUND', `Modèle inconnu pour ${prov.label} : ${model}.`);
    }
    if (found.location === 'CLOUD' && registry.strictLocal) return fail('STRICT_LOCAL_BLOCKS_CLOUD', `« ${found.name} » s’exécute dans le cloud (Strict Local actif).`);
    if (found.location === 'CLOUD' && (!registry.cloudEnabled || allowCloud === false)) return fail('CLOUD_DISABLED', `« ${found.name} » s’exécute dans le cloud et le cloud est désactivé.`);
    const warnings = [];
    if (!found.capabilitiesKnown) warnings.push('Capacités non vérifiées pour ce modèle : choix manuel respecté.');
    else {
      const missing = missingCaps(found, required);
      if (missing.length) return fail('CAPABILITY_UNSUPPORTED', `« ${found.name} » ne déclare pas : ${missing.join(', ')}.`, 'Choisissez un modèle qui a ces capacités, ou le mode AUTO.');
    }
    // Manual means exactly this model: no substitution, no fallback.
    return { ok: true, mode, required, decision: { provider, model: found.name, modelId: found.id, location: found.location, reason: 'sélection manuelle' }, rejected, warnings };
  }

  // AUTO — deterministic, decided up front.
  // Local runtime stopped: its models cannot even be listed, so AUTO cannot know
  // whether a local model would do — it never stands in with the cloud. The user
  // can still pick a cloud provider explicitly (manual mode, opt-in).
  const ollama = registry.providers.find(p => p.id === 'ollama');
  if (ollama?.status === 'RUNTIME_UNAVAILABLE') {
    return fail('RUNTIME_UNAVAILABLE', 'Le runtime local (Ollama) est arrêté : AUTO ne choisit rien à sa place.',
      registry.cloudAllowed ? 'Démarrez Ollama, ou choisissez explicitement un provider cloud en sélection manuelle.' : 'Démarrez Ollama puis réessayez. AUTO n’envoie jamais au cloud parce que le local a échoué.');
  }
  const cloudAllowed = registry.cloudAllowed && allowCloud !== false;
  const eligible = [];
  for (const m of registry.models) {
    const prov = registry.providers.find(p => p.id === m.provider);
    let reason = null;
    if (!prov?.available) reason = prov?.status ?? 'PROVIDER_UNAVAILABLE';
    else if (!m.available) reason = m.location === 'CLOUD' ? (registry.strictLocal ? 'DISABLED_BY_STRICT_LOCAL' : 'CLOUD_DISABLED') : 'MODEL_UNAVAILABLE';
    else if (m.location === 'CLOUD' && !cloudAllowed) reason = registry.strictLocal ? 'DISABLED_BY_STRICT_LOCAL' : 'CLOUD_DISABLED';
    else if (!m.capabilitiesKnown) reason = 'CAPABILITIES_UNKNOWN';
    else if (missingCaps(m, required).length) reason = `MISSING:${missingCaps(m, required).join('+')}`;
    else if (m.lowVram?.fit?.rating === 'NOT_RECOMMENDED') reason = 'NOT_RECOMMENDED_FOR_HARDWARE';
    if (reason) rejected.push({ id: m.id, reason });
    else eligible.push(m);
  }
  const rank = (m) => [
    m.location === 'LOCAL' ? 0 : 1,
    preferenceIndex(m.name, settings),
    FIT_ORDER[m.lowVram?.fit?.rating ?? 'UNKNOWN'],
    m.id,
  ];
  const cmp = (a, b) => {
    const ra = rank(a); const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
    return 0;
  };
  eligible.sort(cmp);
  // A local model able to do the task exists (even if its runtime is stopped):
  // AUTO stays local and reports the problem — the cloud is never a stand-in for
  // a failing local runtime. The cloud is only for capabilities no local model has.
  const localCapable = registry.models.some(m => m.location === 'LOCAL' && m.capabilitiesKnown && missingCaps(m, required).length === 0);
  const best = localCapable ? eligible.find(m => m.location === 'LOCAL') : eligible[0];
  if (!best) {
    if (localCapable) return fail('RUNTIME_UNAVAILABLE', 'Un modèle local adapté existe, mais le runtime local est indisponible.', 'Démarrez Ollama puis réessayez. AUTO n’envoie jamais au cloud parce que le local a échoué.');
    return fail('NO_MODEL_FOR_CAPABILITIES', `Aucun modèle disponible pour : ${required.join(', ')}.`, registry.strictLocal ? 'Strict Local : seuls les modèles installés localement sont utilisés.' : 'Installez un modèle local adapté, ou activez explicitement le cloud.');
  }
  const reason = best.location === 'LOCAL'
    ? 'AUTO : modèle local adapté (préférence locale)'
    : 'AUTO : aucun modèle local n’a ces capacités — cloud autorisé par opt-in';
  return { ok: true, mode: 'auto', required, decision: { provider: best.provider, model: best.name, modelId: best.id, location: best.location, reason }, rejected, warnings: [] };
}

// ── Failures ─────────────────────────────────────────────────────────────────

export function classifyModelError(error, { model = null } = {}) {
  if (error instanceof ModelRouteError) return { code: error.code, message: error.message, hint: error.hint };
  const text = `${error?.name ?? ''} ${error?.code ?? ''} ${error?.message ?? error ?? ''}`;
  const subject = model ? `« ${model} »` : 'le modèle';
  if (/out of memory|cudaMalloc|requires more system memory|insufficient memory|not enough memory|\bOOM\b|memory allocation/i.test(text)) {
    return { code: 'OUT_OF_MEMORY', message: `Mémoire insuffisante pour ${subject}.`, hint: 'Essayez un modèle plus petit ou plus quantifié, réduisez le contexte (num_ctx) ou le nombre de couches GPU (num_gpu), ou fermez d’autres applications.' };
  }
  if (/model ['"]?[^'"]*['"]? not found|try pulling it|pull model|no such model|status code: 404/i.test(text)) {
    return { code: 'MODEL_NOT_FOUND', message: `${subject} n’est pas installé dans le runtime local.`, hint: 'Docteur ne télécharge jamais un modèle automatiquement : installez-le vous-même puis réessayez.' };
  }
  if (/TimeoutError|ETIMEDOUT|timed? ?out|\bTIMEOUT\b/i.test(text)) {
    return { code: 'TIMEOUT', message: `${subject} n’a pas répondu à temps.`, hint: 'Le premier chargement d’un gros modèle peut être long ; réessayez, ou choisissez un modèle plus léger.' };
  }
  if (/ECONNREFUSED|ECONNRESET|fetch failed|ENOTFOUND|EHOSTUNREACH|socket hang up|connect/i.test(text)) {
    return { code: 'RUNTIME_UNAVAILABLE', message: 'Le runtime local (Ollama) ne répond pas.', hint: 'Démarrez Ollama puis réessayez.' };
  }
  if (error?.code === 'INVALID_RESPONSE') return { code: 'INVALID_RESPONSE', message: error.message, hint: 'Réessayez, ou choisissez un modèle qui gère mieux ce format.' };
  return { code: 'PROVIDER_ERROR', message: `Erreur du fournisseur : ${String(error?.message ?? error).slice(0, 300)}`, hint: null };
}

// ── Execution (exactly the decided route, once) ──────────────────────────────

export function validateRuntimeOptions(options, { contextLength = null } = {}) {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object') throw new ModelRouteError('INVALID_RUNTIME_OPTIONS', 'Options du runtime invalides.', { status: 400 });
  const out = {};
  for (const key of Object.keys(options)) if (!['num_ctx', 'num_gpu'].includes(key)) throw new ModelRouteError('INVALID_RUNTIME_OPTIONS', `Option non prise en charge : ${key}.`, { status: 400 });
  if (options.num_ctx !== undefined) {
    const v = Number(options.num_ctx);
    const max = contextLength ?? LIMITS.numCtxMax;
    if (!Number.isInteger(v) || v < LIMITS.numCtxMin || v > max) throw new ModelRouteError('INVALID_RUNTIME_OPTIONS', `num_ctx doit être un entier entre ${LIMITS.numCtxMin} et ${max}.`, { status: 400 });
    out.num_ctx = v;
  }
  if (options.num_gpu !== undefined) {
    const v = Number(options.num_gpu);
    if (!Number.isInteger(v) || v < 0 || v > LIMITS.numGpuMax) throw new ModelRouteError('INVALID_RUNTIME_OPTIONS', `num_gpu doit être un entier entre 0 et ${LIMITS.numGpuMax}.`, { status: 400 });
    out.num_gpu = v;
  }
  return out;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`timeout after ${ms} ms`), { name: 'TimeoutError' })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Runs the decided route ONCE. No other provider is ever tried on failure.
 * @param {object} route  selectRoute(...) result (ok:true)
 * @param {object} req    { messages, responseFormat: 'text'|'json', runtimeOptions, timeoutMs }
 * @param {object} deps   { client (ollama), cloudCall(providerId, messages) → {text, model} }
 */
export async function executeRoute(route, { messages, responseFormat = 'text', runtimeOptions, timeoutMs = LIMITS.defaultTimeoutMs, registry = null } = {}, { client, cloudCall } = {}) {
  if (!route?.ok) throw new ModelRouteError(route?.error?.code ?? 'NO_ROUTE', route?.error?.message ?? 'Aucune route.', { hint: route?.error?.hint ?? null });
  const { decision } = route;
  const timeout = Math.min(Math.max(Number(timeoutMs) || LIMITS.defaultTimeoutMs, LIMITS.timeoutMinMs), LIMITS.timeoutMaxMs);
  const started = Date.now();
  let text;
  try {
    if (decision.provider === 'ollama') {
      const entry = registry?.models.find(m => m.id === decision.modelId) ?? null;
      const options = validateRuntimeOptions(runtimeOptions, { contextLength: entry?.contextLength?.value ?? null });
      text = await withTimeout(chatCompletion(client, decision.model, messages, { options, format: responseFormat === 'json' ? 'json' : undefined }), timeout);
    } else {
      if (runtimeOptions && Object.keys(runtimeOptions).length) throw new ModelRouteError('INVALID_RUNTIME_OPTIONS', 'Les options num_ctx / num_gpu ne concernent que le runtime local.', { status: 400 });
      if (typeof cloudCall !== 'function') throw new ModelRouteError('PROVIDER_UNAVAILABLE', 'Provider cloud non disponible.');
      const result = await withTimeout(cloudCall(decision.provider, messages), timeout);
      text = typeof result === 'string' ? result : result?.text;
    }
  } catch (error) {
    const classified = classifyModelError(error, { model: decision.model });
    throw new ModelRouteError(classified.code, classified.message, { hint: classified.hint, status: classified.code === 'INVALID_RUNTIME_OPTIONS' ? 400 : 502, detail: { provider: decision.provider, model: decision.model } });
  }
  const output = String(text ?? '').trim();
  if (!output) throw new ModelRouteError('INVALID_RESPONSE', `« ${decision.model} » a renvoyé une réponse vide.`, { hint: 'Réessayez, ou choisissez un autre modèle.', status: 502 });
  let json = null;
  if (responseFormat === 'json') {
    try { json = JSON.parse(output); } catch { throw new ModelRouteError('INVALID_RESPONSE', `« ${decision.model} » n’a pas renvoyé un JSON valide.`, { hint: 'Réessayez, ou choisissez un modèle qui déclare STRUCTURED_OUTPUT.', status: 502 }); }
  }
  return { text: output, json, provider: decision.provider, model: decision.model, location: decision.location, durationMs: Date.now() - started };
}

// ── Runtime inventory (I/O, injected client) ─────────────────────────────────

export async function collectOllamaInventory(client, { timeoutMs = 5_000 } = {}) {
  try {
    const list = await withTimeout(client.list(), timeoutMs);
    const installed = list?.models ?? [];
    const shows = {};
    for (const m of installed) {
      const name = m.name ?? m.model;
      try { shows[name] = await withTimeout(client.show({ model: name }), timeoutMs); } catch { shows[name] = null; }
    }
    let loaded = [];
    try { loaded = (await withTimeout(client.ps(), timeoutMs))?.models ?? []; } catch { loaded = []; }
    return { reachable: true, installed, shows, loaded };
  } catch (error) {
    return { reachable: false, error: classifyModelError(error).message, installed: [], shows: {}, loaded: [] };
  }
}

/** Configured cloud providers via router.js — probed only when cloud is allowed (no probe under Strict Local). */
export async function collectCloudProviders({ keys, settings, logger = null }) {
  if (settings?.strict_local_mode === true || settings?.cloud_enabled !== true) return null;
  const candidates = await cloudCandidates(keys, settings, logger);
  return candidates.map(c => ({ providerId: c.providerId, paid: c.paid === true, call: c.call }));
}
