// External Environment & Texture Generation Fabric V1 (EETF) — contracts (EETF-2).
//
// Pure module: enums, state machine, resource limits and validators shared by
// the EETF stores. No I/O, no process, no network. Every validator either
// returns a normalised, frozen value or throws an EetfError with a stable code.
//
// Honesty rules encoded here (EETF-1 report §3–§4):
//   - a texture map always carries a status; a map the engine cannot produce is
//     UNSUPPORTED and has no asset;
//   - HDRI / certified equirectangular / cubemap / 3D scene are KNOWN but NOT
//     supported environment types;
//   - EXR / HDR files made from LDR content are LDR_CONTENT_IN_HDR_CONTAINER.

import crypto from 'node:crypto';
import { scanSecrets } from './notebook-security.js';

export const EETF_CONTRACT_VERSION = 1;

export class EetfError extends Error {
  constructor(code, message, details = undefined) {
    super(message ?? code);
    this.name = 'EetfError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => { throw new EetfError(code, message, details); };
const freezeDeep = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) freezeDeep(v[k]);
  }
  return v;
};
const enumOf = (...values) => Object.freeze(Object.fromEntries(values.map(v => [v, v])));

// ── Jobs ────────────────────────────────────────────────────────────────────

export const JOB_STATUS = enumOf('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
export const TERMINAL_JOB_STATUSES = Object.freeze(new Set([JOB_STATUS.COMPLETED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED]));

/** Explicit transitions; anything else is refused. */
export const JOB_TRANSITIONS = freezeDeep({
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
});

export function assertJobTransition(from, to) {
  if (!JOB_TRANSITIONS[from]) fail('EETF_UNKNOWN_JOB_STATUS', `unknown job status: ${String(from)}`);
  if (!JOB_TRANSITIONS[to]) fail('EETF_UNKNOWN_JOB_STATUS', `unknown job status: ${String(to)}`);
  if (!JOB_TRANSITIONS[from].includes(to)) fail('EETF_INVALID_TRANSITION', `job transition ${from} → ${to} is not allowed`, { from, to });
}

export const JOB_KIND = enumOf('GENERATE', 'DERIVE', 'EXPORT');

/** Error codes written by the stores themselves. */
export const JOB_ERROR = enumOf('PROCESS_RESTARTED', 'CANCELLED_BY_USER');

// ── Assets and formats ──────────────────────────────────────────────────────

export const IMAGE_FORMAT = enumOf('PNG', 'JPEG', 'WEBP', 'TIFF', 'EXR', 'HDR');
export const FORMAT_MIME = freezeDeep({
  PNG: 'image/png', JPEG: 'image/jpeg', WEBP: 'image/webp', TIFF: 'image/tiff', EXR: 'image/x-exr', HDR: 'image/vnd.radiance',
});
export const FORMAT_EXT = freezeDeep({ PNG: 'png', JPEG: 'jpg', WEBP: 'webp', TIFF: 'tiff', EXR: 'exr', HDR: 'hdr' });
export const HDR_CONTAINER_FORMATS = Object.freeze(new Set([IMAGE_FORMAT.EXR, IMAGE_FORMAT.HDR]));
const MIME_FORMAT = Object.freeze(Object.fromEntries(Object.entries(FORMAT_MIME).map(([f, m]) => [m, f])));

export function formatFromMime(mime) {
  const f = MIME_FORMAT[String(mime ?? '').toLowerCase()];
  if (!f) fail('EETF_UNSUPPORTED_MIME', `unsupported MIME type: ${String(mime).slice(0, 80)}`);
  return f;
}

/**
 * Dynamic range of the stored CONTENT (not of the container).
 * V1 has no source of genuine HDR content, so `HDR` is never accepted.
 */
export const DYNAMIC_RANGE = enumOf('LDR', 'LDR_CONTENT_IN_HDR_CONTAINER');

export function resolveDynamicRange(actualFormat, contentDynamicRange) {
  const content = contentDynamicRange ?? null;
  if (HDR_CONTAINER_FORMATS.has(actualFormat)) {
    if (content === 'HDR') fail('EETF_HDR_CONTENT_NOT_SUPPORTED_V1', 'V1 cannot produce or verify genuine HDR content');
    if (content !== 'LDR') fail('EETF_DYNAMIC_RANGE_REQUIRED', `${actualFormat} requires an explicit contentDynamicRange ('LDR' in V1)`);
    return DYNAMIC_RANGE.LDR_CONTENT_IN_HDR_CONTAINER;
  }
  if (content !== null && content !== 'LDR') fail('EETF_HDR_CONTENT_NOT_SUPPORTED_V1', `${actualFormat} content is LDR`);
  return DYNAMIC_RANGE.LDR;
}

export const ASSET_ROLE = enumOf('SOURCE', 'GENERATED', 'DERIVED');

export const VARIANT_OPERATION = enumOf('RESIZE', 'CONVERT', 'THUMBNAIL', 'CROP', 'DERIVE_MAP', 'TILE_PREVIEW');

// ── Textures ────────────────────────────────────────────────────────────────

export const TEXTURE_ROLE = enumOf('BASE_COLOR', 'NORMAL', 'ROUGHNESS', 'METALLIC', 'HEIGHT', 'AMBIENT_OCCLUSION', 'OPACITY', 'EMISSIVE');
export const TEXTURE_ROLES = Object.freeze(Object.keys(TEXTURE_ROLE));
export const MAP_STATUS = enumOf('GENERATED', 'DERIVED', 'ESTIMATED', 'USER_CONSTANT', 'FROM_SOURCE_ALPHA', 'UNSUPPORTED');
const STATUS_NEEDS_ASSET = new Set(['GENERATED', 'DERIVED', 'ESTIMATED', 'FROM_SOURCE_ALPHA']);

/**
 * What each map may honestly be in V1 (EETF-1 §4). A status outside this list
 * is refused even when an asset is supplied: e.g. a "GENERATED" normal map
 * would claim an engine capability that does not exist here.
 */
// EETF-5 tightened this table: no algorithm producing normal / height / AO maps is validated in the
// repository, and emissive / opacity constants are not part of V1 — those maps are UNSUPPORTED.
export const MAP_STATUS_ALLOWED_V1 = freezeDeep({
  BASE_COLOR: ['GENERATED', 'DERIVED', 'USER_CONSTANT', 'UNSUPPORTED'],
  NORMAL: ['UNSUPPORTED'],
  ROUGHNESS: ['USER_CONSTANT', 'UNSUPPORTED'],
  METALLIC: ['USER_CONSTANT', 'UNSUPPORTED'],
  HEIGHT: ['UNSUPPORTED'],
  AMBIENT_OCCLUSION: ['UNSUPPORTED'],
  OPACITY: ['FROM_SOURCE_ALPHA', 'UNSUPPORTED'],
  EMISSIVE: ['UNSUPPORTED'],
});

/** EETF-5 seam analysis vocabulary. "SEAMLESS" is deliberately absent: a score is never a guarantee. */
export const SEAM_STATUS = enumOf('UNKNOWN', 'MEASURED', 'LOW_SEAM', 'HIGH_SEAM');
/** Alpha content of an image, measured on its decoded pixels. */
export const ALPHA_CLASS = enumOf('NO_ALPHA_CHANNEL', 'OPAQUE', 'BINARY_CUTOUT', 'SEMI_TRANSPARENT', 'FULLY_TRANSPARENT');
/** Colour-space assumption recorded on colour maps (profiles are stripped; no ICC conversion is performed). */
export const COLOR_SPACE_ASSUMPTION = 'SRGB_ASSUMED_PROFILE_STRIPPED';
export const NORMAL_CONVENTION = enumOf('OPENGL', 'DIRECTX');

/** Material badge: a "PBR" claim needs every core map backed by real data. */
export const MATERIAL_BADGE = enumOf('PBR_COMPLETE', 'PARTIAL_MATERIAL', 'BASE_COLOR_ONLY', 'EMPTY');

export function materialBadge(maps) {
  const by = Object.fromEntries(maps.map(m => [m.role, m.status]));
  const real = (s) => s === 'GENERATED' || s === 'DERIVED' || s === 'FROM_SOURCE_ALPHA';
  if (['BASE_COLOR', 'NORMAL', 'ROUGHNESS', 'METALLIC'].every(r => real(by[r]))) return MATERIAL_BADGE.PBR_COMPLETE;
  const present = maps.filter(m => m.status !== 'UNSUPPORTED');
  if (present.length === 0) return MATERIAL_BADGE.EMPTY;
  if (present.length === 1 && present[0].role === 'BASE_COLOR') return MATERIAL_BADGE.BASE_COLOR_ONLY;
  return MATERIAL_BADGE.PARTIAL_MATERIAL;
}

// ── Environments ────────────────────────────────────────────────────────────

export const ENVIRONMENT_TYPE = enumOf('BACKGROUND', 'SCENE_REFERENCE', 'PANORAMA_REFERENCE', 'SKYBOX_PREVIEW');
/** Known, deliberately NOT supported in V1 (no engine can honestly produce them). */
export const ENVIRONMENT_TYPE_UNSUPPORTED_V1 = Object.freeze(['HDRI', 'CERTIFIED_EQUIRECTANGULAR', 'CUBEMAP', '3D_SCENE']);
export const SEAM_CHECK = enumOf('NOT_CHECKED', 'PASSED', 'FAILED');
export const PROJECTION = enumOf('FLAT', 'PANORAMA_2_1_REFERENCE');

export function assertEnvironmentType(type) {
  if (ENVIRONMENT_TYPE[type]) return type;
  if (ENVIRONMENT_TYPE_UNSUPPORTED_V1.includes(type)) fail('EETF_ENVIRONMENT_TYPE_UNSUPPORTED', `${type} is not supported in V1`);
  fail('EETF_UNKNOWN_ENVIRONMENT_TYPE', `unknown environment type: ${String(type).slice(0, 40)}`);
}

// ── Providers ───────────────────────────────────────────────────────────────

export const PROVIDER_KIND = enumOf('LOCAL', 'CLOUD');
export const PROVIDER_TRANSPORT = enumOf('LOOPBACK_HTTP', 'LOCAL_PROCESS', 'IN_PROCESS', 'HTTPS');
export const PROVIDER_STATUS = enumOf('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN');
const PROVIDER_CAPABILITY_FLAGS = Object.freeze(['txt2img', 'img2img', 'tiling', 'negativePrompt', 'seed']);

// ── Resource limits (EETF-1 §10). Values are PROVISIONAL until calibrated on a
// real engine; TO_MEASURE entries have no value on purpose (none is invented).

export const RESOURCE_LIMITS = freezeDeep({
  maxGenerationSide: { value: 2048, unit: 'px', status: 'PROVISIONAL', basis: 'existing MAX_DIMENSION of /api/image-generation' },
  maxGenerationPixels: { value: 2048 * 2048, unit: 'px', status: 'PROVISIONAL', basis: '2048², SD 1.5 native 512 on an 8 GB GPU' },
  maxImportSide: { value: 4096, unit: 'px', status: 'PROVISIONAL', basis: '4K is the usual texture size' },
  maxPixels: { value: 4096 * 4096, unit: 'px', status: 'PROVISIONAL', basis: '4096² for stored / derived images' },
  maxFileSize: { value: 64 * 1024 * 1024, unit: 'bytes', status: 'PROVISIONAL', basis: 'raw 4096² RGBA 8-bit = 64 MiB; EXR 2048² RGB float32 = 48 MiB' },
  maxBatch: { value: 4, unit: 'items', status: 'PROVISIONAL', basis: 'one GPU, items run sequentially' },
  timeoutMs: { value: 120_000, unit: 'ms', status: 'PROVISIONAL', basis: 'existing ComfyUI provider timeout' },
  concurrency: { value: { generation: 1, derivation: 1 }, unit: 'jobs', status: 'PROVISIONAL', basis: 'Media Studio single-slot queue' },
  tempQuota: { value: 2 * 64 * 1024 * 1024, unit: 'bytes', status: 'PROVISIONAL', basis: 'EETF-3: one in-flight FFmpeg output + its ingest copy, each ≤ maxFileSize, concurrency 1' },
  minFreeDiskBytes: { value: 64 * 1024 * 1024, unit: 'bytes', status: 'PROVISIONAL', basis: 'after a derivation at least one more maxFileSize asset still fits' },
  derivationTimeoutMs: { value: 60_000, unit: 'ms', status: 'PROVISIONAL', basis: 'one image through FFmpeg; Media Studio probes use 30 s' },
  maxThumbnailSide: { value: 1024, unit: 'px', status: 'PROVISIONAL', basis: 'UI previews; larger outputs are RESIZE' },
  vramRequirement: { value: null, unit: 'MiB', status: 'TO_MEASURE', basis: 'needs the real engine + checkpoint (EETF-4)' },
  maxRetries: { value: 3, unit: 'attempts', status: 'PROVISIONAL', basis: 'bounds retry chains; a 4th attempt needs a new request' },
  maxPromptChars: { value: 4000, unit: 'chars', status: 'PROVISIONAL', basis: 'storage / abuse bound, not a model limit' },
  maxParamsBytes: { value: 16 * 1024, unit: 'bytes', status: 'PROVISIONAL', basis: 'metadata bound (params are small typed values)' },
  maxDisplayNameChars: { value: 120, unit: 'chars', status: 'PROVISIONAL', basis: 'same as Media Studio safeDisplayName' },
  maxSourceAssets: { value: 8, unit: 'assets', status: 'PROVISIONAL', basis: 'a derivation reads a few inputs' },
  providerProbeTimeoutMs: { value: 3_000, unit: 'ms', status: 'PROVISIONAL', basis: 'EETF-4: a local service answers its health route quickly; a missing engine is reported fast' },
  providerRequestTimeoutMs: { value: 10_000, unit: 'ms', status: 'PROVISIONAL', basis: 'existing ComfyUI /prompt timeout' },
  pollIntervalMs: { value: 1_000, unit: 'ms', status: 'PROVISIONAL', basis: 'existing provider polls every 1.5 s; bounded attempts = timeoutMs / interval' },
  vramModelBaselineMb: { value: 2_200, unit: 'MiB', status: 'PROVISIONAL', basis: 'weights of the only vetted checkpoint (SD 1.5 fp16, 2.13 GB on disk) — TO_MEASURE on the real engine' },
  vramPer512ImageMb: { value: 1_024, unit: 'MiB', status: 'PROVISIONAL', basis: 'order of magnitude for SD 1.5 fp16 sampling + VAE decode of one 512² image — TO_MEASURE on the real engine' },
  seamLowMax: { value: 2, unit: 'ratio', status: 'PROVISIONAL', basis: 'EETF-5: wrap edge at most 2× the image\'s own neighbour difference; to calibrate on real textures' },
  seamHighMin: { value: 4, unit: 'ratio', status: 'PROVISIONAL', basis: 'EETF-5: wrap edge at least 4× the neighbour difference is an obvious seam; to calibrate' },
  panoramaRatioTolerance: { value: 0.01, unit: 'relative', status: 'PROVISIONAL', basis: 'EETF-6: |w/h − 2| / 2 ≤ 1 % absorbs encoder sizes such as 2048×1023 without accepting other shapes' },
  panoramaMinWidth: { value: 512, unit: 'px', status: 'PROVISIONAL', basis: 'EETF-6: 512 px over 360° ≈ 1.4 px per degree; below that a sphere preview is only blur' },
  poleRowDeviationMax: { value: 12, unit: '0..255 level', status: 'PROVISIONAL', basis: 'EETF-6: in an equirectangular image the top / bottom rows map to one point each, so they should be nearly uniform; a hint, never a certificate' },
  previewFovMinDeg: { value: 30, unit: 'deg', status: 'PROVISIONAL', basis: 'EETF-6: narrower views magnify a 512–4096 px panorama into pixel blocks' },
  previewFovMaxDeg: { value: 120, unit: 'deg', status: 'PROVISIONAL', basis: 'EETF-6: a rectilinear view wider than 120° is dominated by edge stretching' },
});
export const limit = (name) => RESOURCE_LIMITS[name].value;

// ── Generic validators ──────────────────────────────────────────────────────

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const SECRET_KEY_RE = /(secret|token|password|passwd|api[_-]?key|apikey|authorization|bearer|cookie|credential|private[_-]?key)/i;

export const newId = () => crypto.randomUUID();
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export const isSha256 = (v) => typeof v === 'string' && SHA256_RE.test(v);
export const nowIso = () => new Date().toISOString();

export function assertUuid(v, what = 'id') {
  if (!isUuid(v)) fail('EETF_INVALID_ID', `invalid ${what}`);
  return v;
}

export function assertSha256(v) {
  if (!isSha256(v)) fail('EETF_INVALID_HASH', 'invalid sha256 (64 lowercase hex characters expected)');
  return v;
}

function assertInt(v, min, max, what) {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail('EETF_INVALID_NUMBER', `${what} must be an integer in [${min}, ${max}]`);
  return v;
}

/** No secret may ever reach EETF metadata: neither a secret-looking key nor a secret-looking value. */
export function assertNoSecrets(value, path = '$') {
  if (typeof value === 'string') {
    if (scanSecrets(value).hasSecrets) fail('EETF_SECRET_FIELD_REFUSED', `secret-looking value refused at ${path}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) fail('EETF_SECRET_FIELD_REFUSED', `secret-looking field refused: ${path}.${k.slice(0, 40)}`);
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

function cleanText(v, max, what, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) fail('EETF_REQUIRED_FIELD', `${what} is required`);
    return null;
  }
  if (typeof v !== 'string') fail('EETF_INVALID_TEXT', `${what} must be a string`);
  if (v.includes('\u0000')) fail('EETF_INVALID_TEXT', `${what} contains NUL`);
  const s = v.normalize('NFC');
  if (s.length > max) fail('EETF_TEXT_TOO_LONG', `${what} exceeds ${max} characters`);
  if (required && !s.trim()) fail('EETF_REQUIRED_FIELD', `${what} is required`);
  return s;
}

/** Plain JSON only (no functions, no prototypes other than Object/Array), bounded size. */
function plainJson(v, what) {
  const seen = new Set();
  const walk = (x, depth) => {
    if (depth > 8) fail('EETF_INVALID_PARAMS', `${what} is nested too deeply`);
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return;
    if (typeof x === 'number') { if (!Number.isFinite(x)) fail('EETF_INVALID_PARAMS', `${what} contains a non-finite number`); return; }
    if (typeof x !== 'object') fail('EETF_INVALID_PARAMS', `${what} contains a ${typeof x}`);
    if (seen.has(x)) fail('EETF_INVALID_PARAMS', `${what} is cyclic`);
    seen.add(x);
    const proto = Object.getPrototypeOf(x);
    if (!Array.isArray(x) && proto !== Object.prototype && proto !== null) fail('EETF_INVALID_PARAMS', `${what} must be plain JSON`);
    for (const k of Object.keys(x)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') fail('EETF_INVALID_PARAMS', `${what} contains a forbidden key`);
      walk(x[k], depth + 1);
    }
    seen.delete(x);
  };
  walk(v, 0);
  const json = canonicalJson(v);
  if (Buffer.byteLength(json, 'utf8') > limit('maxParamsBytes')) fail('EETF_PARAMS_TOO_LARGE', `${what} exceeds ${limit('maxParamsBytes')} bytes`);
  return json;
}

/** Deterministic JSON (sorted keys) — the basis of paramsHash. */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

// ── Job params (typed per kind; unknown keys refused, nothing executable) ───

const GENERATE_TARGET = enumOf('TEXTURE', 'ENVIRONMENT', 'IMAGE');
/** EETF-4: sampler / scheduler names allowed in the server-side workflow template (the engine must ALSO report them). */
export const SAMPLERS = Object.freeze(['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpmpp_2m', 'dpmpp_sde', 'dpmpp_2m_sde', 'ddim', 'uni_pc']);
export const SCHEDULERS = Object.freeze(['normal', 'karras', 'exponential', 'simple', 'sgm_uniform', 'ddim_uniform']);
/** EETF-3 resize modes: STRETCH = exact size, CONTAIN = fit inside keeping the ratio, PAD = CONTAIN then pad to the exact size. */
export const DERIVE_FIT = enumOf('STRETCH', 'CONTAIN', 'PAD');
const PARAM_SCHEMAS = {
  GENERATE: {
    prompt: (v) => cleanText(v, limit('maxPromptChars'), 'prompt', { required: true }),
    negativePrompt: (v) => cleanText(v, limit('maxPromptChars'), 'negativePrompt'),
    width: (v) => assertInt(v, 64, limit('maxGenerationSide'), 'width'),
    height: (v) => assertInt(v, 64, limit('maxGenerationSide'), 'height'),
    steps: (v) => assertInt(v, 1, 150, 'steps'),
    seed: (v) => assertInt(v, 0, Number.MAX_SAFE_INTEGER, 'seed'),
    sampler: (v) => { if (!SAMPLERS.includes(v)) fail('EETF_INVALID_PARAMS', 'sampler is not in the allow-list'); return v; },
    scheduler: (v) => { if (!SCHEDULERS.includes(v)) fail('EETF_INVALID_PARAMS', 'scheduler is not in the allow-list'); return v; },
    batchSize: (v) => assertInt(v, 1, limit('maxBatch'), 'batchSize'),
    model: (v) => { const { model } = validateProviderAndModel({ model: v }); if (!model) fail('EETF_INVALID_MODEL', 'model must be a non-empty name'); return model; },
    cfg: (v) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 30) fail('EETF_INVALID_NUMBER', 'cfg must be a number in [0, 30]'); return v; },
    target: (v) => { if (!GENERATE_TARGET[v]) fail('EETF_INVALID_PARAMS', 'target must be TEXTURE, ENVIRONMENT or IMAGE'); return v; },
    environmentType: (v) => assertEnvironmentType(v),
    textureRole: (v) => { if (!TEXTURE_ROLE[v]) fail('EETF_UNKNOWN_TEXTURE_ROLE', `unknown texture role: ${String(v).slice(0, 40)}`); return v; },
  },
  DERIVE: {
    operation: (v) => { if (!VARIANT_OPERATION[v]) fail('EETF_INVALID_PARAMS', `unknown derive operation: ${String(v).slice(0, 40)}`); return v; },
    sourceAssetIds: (v) => {
      if (!Array.isArray(v) || v.length === 0 || v.length > limit('maxSourceAssets')) fail('EETF_INVALID_PARAMS', `sourceAssetIds must list 1..${limit('maxSourceAssets')} assets`);
      return v.map(id => assertUuid(id, 'source asset id'));
    },
    width: (v) => assertInt(v, 1, limit('maxImportSide'), 'width'),
    height: (v) => assertInt(v, 1, limit('maxImportSide'), 'height'),
    x: (v) => assertInt(v, 0, limit('maxImportSide') - 1, 'x'),
    y: (v) => assertInt(v, 0, limit('maxImportSide') - 1, 'y'),
    fit: (v) => { if (!DERIVE_FIT[v]) fail('EETF_INVALID_PARAMS', 'fit must be STRETCH, CONTAIN or PAD'); return v; },
    background: (v) => { if (v !== 'TRANSPARENT' && !(typeof v === 'string' && /^[0-9A-F]{6}$/.test(v))) fail('EETF_INVALID_PARAMS', "background is 'TRANSPARENT' or RRGGBB (uppercase hex)"); return v; },
    maxSide: (v) => assertInt(v, 1, limit('maxThumbnailSide'), 'maxSide'),
    grid: (v) => assertInt(v, 2, 3, 'grid'),
    format: (v) => { if (!IMAGE_FORMAT[v]) fail('EETF_INVALID_PARAMS', 'unknown format'); return v; },
    textureRole: (v) => { if (!TEXTURE_ROLE[v]) fail('EETF_UNKNOWN_TEXTURE_ROLE', `unknown texture role: ${String(v).slice(0, 40)}`); return v; },
    normalConvention: (v) => { if (!NORMAL_CONVENTION[v]) fail('EETF_INVALID_PARAMS', 'normalConvention must be OPENGL or DIRECTX'); return v; },
  },
  EXPORT: {
    assetId: (v) => assertUuid(v, 'asset id'),
    format: (v) => { if (!IMAGE_FORMAT[v]) fail('EETF_INVALID_PARAMS', 'unknown format'); return v; },
  },
};
const REQUIRED_PARAMS = { GENERATE: ['prompt', 'width', 'height', 'target'], DERIVE: ['operation', 'sourceAssetIds'], EXPORT: ['assetId', 'format'] };

/** Validates job params for a kind; returns { params, paramsJson, paramsHash }. */
export function validateJobParams(kind, params) {
  if (!JOB_KIND[kind]) fail('EETF_INVALID_JOB_KIND', `unknown job kind: ${String(kind).slice(0, 40)}`);
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('EETF_INVALID_PARAMS', 'params must be an object');
  assertNoSecrets(params, 'params');
  const schema = PARAM_SCHEMAS[kind];
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (!Object.hasOwn(schema, k)) fail('EETF_UNKNOWN_PARAM', `unknown ${kind} parameter: ${k.slice(0, 40)}`);
    if (v === undefined) continue;
    const value = schema[k](v);
    if (value !== null) out[k] = value;
  }
  for (const k of REQUIRED_PARAMS[kind]) if (!Object.hasOwn(out, k)) fail('EETF_REQUIRED_FIELD', `${kind} requires ${k}`);
  if (kind === 'GENERATE') {
    if (out.width * out.height > limit('maxGenerationPixels')) fail('EETF_TOO_MANY_PIXELS', 'width × height exceeds maxGenerationPixels');
    if (out.target === 'ENVIRONMENT' && !out.environmentType) fail('EETF_REQUIRED_FIELD', 'an ENVIRONMENT generation needs environmentType');
    if (out.target !== 'ENVIRONMENT' && out.environmentType) fail('EETF_INVALID_PARAMS', 'environmentType only applies to target ENVIRONMENT');
    if (out.target !== 'TEXTURE' && out.textureRole) fail('EETF_INVALID_PARAMS', 'textureRole only applies to target TEXTURE');
  }
  const paramsJson = plainJson(out, 'params');
  return { params: freezeDeep(out), paramsJson, paramsHash: sha256Hex(paramsJson) };
}

export function validateJobError(error) {
  if (!error || typeof error !== 'object') fail('EETF_INVALID_ERROR', 'error must be { code, message? }');
  if (typeof error.code !== 'string' || !ERROR_CODE_RE.test(error.code)) fail('EETF_INVALID_ERROR', 'error.code must match [A-Z0-9_]{1,64}');
  const message = cleanText(error.message ?? null, 500, 'error.message');
  if (message) assertNoSecrets(message, 'error.message');
  return { code: error.code, message };
}

export function validateProgress(p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) fail('EETF_INVALID_PROGRESS', 'progress must be a number in [0, 1]');
  return p;
}

export function validateProviderAndModel({ provider, model }) {
  const p = cleanText(provider ?? null, 64, 'provider');
  if (p !== null && !SLUG_RE.test(p)) fail('EETF_INVALID_PROVIDER', 'provider must be a short lowercase id');
  const m = cleanText(model ?? null, 200, 'model');
  if (m !== null) {
    // A model is a name REPORTED by the engine (it may carry a relative subfolder, e.g. "sd15/x.safetensors"),
    // never a filesystem path: no drive, no absolute / UNC start, no ".." segment, no empty segment.
    if (/^[a-z]:|^[\\/]|(^|[\\/])\.\.([\\/]|$)|[\\/]{2}|[\\/]$/i.test(m)) fail('EETF_INVALID_MODEL', 'model is a name reported by the engine, never a path');
    assertNoSecrets(m, 'model');
  }
  return { provider: p, model: m };
}

// ── Provenance ──────────────────────────────────────────────────────────────

export const PROVENANCE_RELATION = enumOf('INPUT', 'DERIVED_FROM');

export function validateProvenance(input) {
  if (!input || typeof input !== 'object') fail('EETF_INVALID_PROVENANCE', 'provenance must be an object');
  const allowed = new Set(['provider', 'model', 'prompt', 'negativePrompt', 'seed', 'width', 'height', 'parameters', 'sources', 'engineVersion', 'strictLocal']);
  for (const k of Object.keys(input)) if (!allowed.has(k)) fail('EETF_UNKNOWN_FIELD', `unknown provenance field: ${k.slice(0, 40)}`);
  assertNoSecrets(input, 'provenance');
  const { provider, model } = validateProviderAndModel(input);
  if (!provider) fail('EETF_REQUIRED_FIELD', 'provenance.provider is required');
  const out = {
    provider, model,
    prompt: cleanText(input.prompt ?? null, limit('maxPromptChars'), 'prompt'),
    negativePrompt: cleanText(input.negativePrompt ?? null, limit('maxPromptChars'), 'negativePrompt'),
    seed: input.seed === undefined || input.seed === null ? null : assertInt(input.seed, 0, Number.MAX_SAFE_INTEGER, 'seed'),
    width: input.width === undefined || input.width === null ? null : assertInt(input.width, 1, limit('maxImportSide'), 'width'),
    height: input.height === undefined || input.height === null ? null : assertInt(input.height, 1, limit('maxImportSide'), 'height'),
    engineVersion: cleanText(input.engineVersion ?? null, 80, 'engineVersion'),
    strictLocal: input.strictLocal === undefined ? null : !!input.strictLocal,
  };
  const parameters = input.parameters ?? {};
  if (typeof parameters !== 'object' || Array.isArray(parameters) || parameters === null) fail('EETF_INVALID_PARAMS', 'provenance.parameters must be an object');
  out.parametersJson = plainJson(parameters, 'provenance.parameters');
  const sources = input.sources ?? [];
  if (!Array.isArray(sources) || sources.length > limit('maxSourceAssets')) fail('EETF_INVALID_PROVENANCE', `sources must list at most ${limit('maxSourceAssets')} assets`);
  const seen = new Set();
  out.sources = sources.map((s) => {
    const assetId = assertUuid(s?.assetId, 'source asset id');
    const relation = s?.relation ?? 'INPUT';
    if (!PROVENANCE_RELATION[relation]) fail('EETF_INVALID_PROVENANCE', 'relation must be INPUT or DERIVED_FROM');
    if (seen.has(assetId)) fail('EETF_INVALID_PROVENANCE', 'duplicate source asset');
    seen.add(assetId);
    return { assetId, relation };
  });
  return out;
}

// ── Provider descriptor ─────────────────────────────────────────────────────

/** Normalises a provider descriptor (filled from REAL detection, never assumed). */
export function validateProviderDescriptor(d) {
  if (!d || typeof d !== 'object') fail('EETF_INVALID_PROVIDER', 'descriptor must be an object');
  const allowed = new Set(['id', 'kind', 'transport', 'status', 'endpoint', 'capabilities', 'models', 'engineVersion', 'detectedAt']);
  for (const k of Object.keys(d)) if (!allowed.has(k)) fail('EETF_UNKNOWN_FIELD', `unknown descriptor field: ${k.slice(0, 40)}`);
  assertNoSecrets(d, 'descriptor');
  if (typeof d.id !== 'string' || !SLUG_RE.test(d.id)) fail('EETF_INVALID_PROVIDER', 'descriptor.id must be a short lowercase id');
  if (!PROVIDER_KIND[d.kind]) fail('EETF_INVALID_PROVIDER', 'descriptor.kind must be LOCAL or CLOUD');
  if (!PROVIDER_TRANSPORT[d.transport]) fail('EETF_INVALID_PROVIDER', 'unknown descriptor.transport');
  if (d.kind === 'LOCAL' && d.transport === 'HTTPS') fail('EETF_INVALID_PROVIDER', 'a LOCAL provider cannot use HTTPS transport');
  if (d.kind === 'CLOUD' && d.transport !== 'HTTPS') fail('EETF_INVALID_PROVIDER', 'a CLOUD provider uses HTTPS');
  const status = d.status ?? 'UNKNOWN';
  if (!PROVIDER_STATUS[status]) fail('EETF_INVALID_PROVIDER', 'unknown descriptor.status');
  let endpoint = null;
  if (d.endpoint !== undefined && d.endpoint !== null) {
    let url;
    try { url = new URL(d.endpoint); } catch { fail('EETF_INVALID_PROVIDER', 'descriptor.endpoint is not a URL'); }
    if (url.username || url.password) fail('EETF_SECRET_FIELD_REFUSED', 'credentials in an endpoint are refused');
    if (url.search || url.hash) fail('EETF_INVALID_PROVIDER', 'descriptor.endpoint must not carry a query or fragment');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (d.transport === 'LOOPBACK_HTTP' && (url.protocol !== 'http:' || !loopback)) fail('EETF_PROVIDER_NOT_LOOPBACK', 'LOOPBACK_HTTP requires http://127.0.0.1, localhost or [::1]');
    endpoint = `${url.protocol}//${url.host}`;
  } else if (d.transport === 'LOOPBACK_HTTP') {
    fail('EETF_INVALID_PROVIDER', 'LOOPBACK_HTTP requires an endpoint');
  }
  const caps = d.capabilities ?? {};
  const capabilities = {};
  for (const k of Object.keys(caps)) if (!PROVIDER_CAPABILITY_FLAGS.includes(k) && k !== 'maxPixels') fail('EETF_UNKNOWN_FIELD', `unknown capability: ${k.slice(0, 40)}`);
  for (const flag of PROVIDER_CAPABILITY_FLAGS) capabilities[flag] = caps[flag] === true;
  capabilities.maxPixels = caps.maxPixels === undefined || caps.maxPixels === null ? null : assertInt(caps.maxPixels, 1, limit('maxPixels'), 'capabilities.maxPixels');
  const models = (d.models ?? []).map((m) => {
    const { model } = validateProviderAndModel({ model: m?.name });
    if (!model) fail('EETF_INVALID_PROVIDER', 'a model needs a name');
    return { name: model, sha256: m?.sha256 === undefined || m?.sha256 === null ? null : assertSha256(m.sha256) };
  });
  if (models.length > 200) fail('EETF_INVALID_PROVIDER', 'too many models');
  return freezeDeep({
    id: d.id, kind: d.kind, transport: d.transport, status, endpoint, capabilities, models,
    engineVersion: cleanText(d.engineVersion ?? null, 80, 'engineVersion'),
    detectedAt: cleanText(d.detectedAt ?? null, 40, 'detectedAt'),
  });
}

// ── Display names ───────────────────────────────────────────────────────────

/** Same rules as Media Studio's safeDisplayName: a label, never a path. */
export function safeDisplayName(name, fallback = 'asset') {
  // length capped BEFORE the trim regex (a long run of dots / spaces would make it backtrack quadratically)
  const base = (String(name ?? '').slice(0, 4 * limit('maxDisplayNameChars')).normalize('NFC').split(/[\\/]/).pop() ?? '');
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, limit('maxDisplayNameChars'));
  return clean && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean) ? clean : fallback;
}

// ── Integration links (EETF-8) ──────────────────────────────────────────────
// An asset keeps ONE content-addressed copy in EETF; a link records where the same bytes came from (IMPORT) or
// where a byte-identical copy was handed (EXPORT). Links are provenance only: they never grant an action.

export const LINK_DIRECTION = enumOf('IMPORT', 'EXPORT');
/** Docteur surfaces EETF exchanges assets with. Media Reader only reads (no link), Notebook / KG are out of scope. */
export const LINK_SYSTEM = enumOf('MEDIA_STUDIO', 'NEURON_IMAGE');
/** SERVER_RESOLVED: the server read the other side itself. CONTENT_SHA256_MATCH: the declared counterpart hash equals the bytes. */
export const LINK_VERIFICATION = enumOf('SERVER_RESOLVED', 'CONTENT_SHA256_MATCH');
/** Same id rule as the Neurone image store (lib/image.js): uuid + allowed extension, no path component. */
export const NEURON_IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$/i;
/** Extension of a Neurone image id → the MIME EETF declares before sniffing (GIF has no EETF format → refused). */
export const NEURON_IMAGE_MIME = freezeDeep({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
/** Formats the browser displays natively (Media Reader / Media Studio / Neurone accept them as images). */
export const BROWSER_NATIVE_FORMATS = Object.freeze(['PNG', 'JPEG', 'WEBP']);

/** Validates the reference to the other side of a link → { ref, key } (key = deterministic unique string). */
export function validateLinkRef(system, ref) {
  if (!LINK_SYSTEM[system]) fail('EETF_INVALID_LINK', 'system must be MEDIA_STUDIO or NEURON_IMAGE');
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('EETF_INVALID_LINK', 'link reference must be an object');
  const allowed = system === 'MEDIA_STUDIO' ? ['projectId', 'mediaAssetId'] : ['imageId'];
  for (const k of Object.keys(ref)) if (!allowed.includes(k)) fail('EETF_UNKNOWN_FIELD', `unknown link field: ${String(k).slice(0, 40)}`);
  if (system === 'MEDIA_STUDIO') {
    const projectId = assertUuid(ref.projectId, 'Media Studio project id');
    const mediaAssetId = assertUuid(ref.mediaAssetId, 'Media Studio asset id');
    return freezeDeep({ ref: { projectId, mediaAssetId }, key: `${projectId}/${mediaAssetId}` });
  }
  if (typeof ref.imageId !== 'string' || !NEURON_IMAGE_ID_RE.test(ref.imageId)) fail('EETF_INVALID_ID', 'invalid Neurone image id');
  const imageId = ref.imageId.toLowerCase();
  return freezeDeep({ ref: { imageId }, key: imageId });
}

export { freezeDeep };
