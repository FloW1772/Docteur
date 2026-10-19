// EETF V1 — textures + materials pipeline (EETF-5).
//
// Builds an honest Material V1 around the EETF-2 TextureSet:
//   BASE_COLOR  GENERATED (a provider output, as is) or DERIVED (a local image normalised by the
//               FFmpeg engine: metadata / profile stripped, sRGB assumed) — an imported image is
//               never labelled GENERATED;
//   ROUGHNESS / METALLIC  USER_CONSTANT only, value in [0, 1], with the user decision recorded;
//   OPACITY     FROM_SOURCE_ALPHA only when the base colour's MEASURED alpha really varies;
//   NORMAL / HEIGHT / AMBIENT_OCCLUSION / EMISSIVE  UNSUPPORTED (no validated algorithm here).
// A complete PBR material is unreachable in V1.
//
// Seam analysis (method EETF-SEAM, version 1, deterministic integer sums on decoded RGBA8):
//   horizontal = mean |RGB(x = w-1) − RGB(x = 0)| over rows   (the left / right wrap edge)
//                ÷ max(mean |RGB(x) − RGB(x+1)| over the image, 0.5)
//   vertical   = the same for the top / bottom wrap edge
//   seamScore  = max(horizontal, vertical)
// A ratio near 1 means the wrap edge looks like any neighbouring pixel pair of the image. Status:
// LOW_SEAM ≤ seamLowMax, HIGH_SEAM ≥ seamHighMin, MEASURED between (thresholds PROVISIONAL). The word
// "seamless" is never produced: a score is a measurement, not a guarantee. No "make seamless".

import {
  EetfError, COLOR_SPACE_ASSUMPTION, SEAM_STATUS, ALPHA_CLASS, TEXTURE_ROLES, assertUuid, limit, freezeDeep,
} from './eetf-contracts.js';

const fail = (code, message) => { throw new EetfError(code, message); };
export const SEAM_METHOD = 'EETF-SEAM';
export const SEAM_METHOD_VERSION = 1;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Pure: seam measures of an RGBA8 buffer. Deterministic (integer sums, fixed rounding). */
export function analyzeSeams(rgba, width, height) {
  if (!Buffer.isBuffer(rgba) || rgba.length !== width * height * 4 || width < 2 || height < 2) fail('EETF_INVALID_ANALYSIS', 'RGBA buffer does not match the dimensions (≥ 2×2 required)');
  const d = (a, b) => Math.abs(rgba[a] - rgba[b]) + Math.abs(rgba[a + 1] - rgba[b + 1]) + Math.abs(rgba[a + 2] - rgba[b + 2]);
  const at = (x, y) => (y * width + x) * 4;
  let edgeH = 0; let interiorH = 0; let edgeV = 0; let interiorV = 0;
  for (let y = 0; y < height; y++) {
    edgeH += d(at(width - 1, y), at(0, y));
    for (let x = 0; x < width - 1; x++) interiorH += d(at(x, y), at(x + 1, y));
  }
  for (let x = 0; x < width; x++) {
    edgeV += d(at(x, height - 1), at(x, 0));
    for (let y = 0; y < height - 1; y++) interiorV += d(at(x, y), at(x, y + 1));
  }
  // means per pixel pair, in 0..255 per channel units (sum of 3 channels / 3)
  const eH = edgeH / (3 * height); const iH = interiorH / (3 * height * (width - 1));
  const eV = edgeV / (3 * width); const iV = interiorV / (3 * width * (height - 1));
  const horizontalScore = round6(eH / Math.max(iH, 0.5));
  const verticalScore = round6(eV / Math.max(iV, 0.5));
  const seamScore = Math.max(horizontalScore, verticalScore);
  const status = seamScore <= limit('seamLowMax') ? SEAM_STATUS.LOW_SEAM : seamScore >= limit('seamHighMin') ? SEAM_STATUS.HIGH_SEAM : SEAM_STATUS.MEASURED;
  return freezeDeep({
    method: SEAM_METHOD, version: SEAM_METHOD_VERSION, horizontalScore, verticalScore, seamScore, status,
    measures: { edgeHorizontal: round6(eH), interiorHorizontal: round6(iH), edgeVertical: round6(eV), interiorVertical: round6(iV), thresholds: { lowMax: limit('seamLowMax'), highMin: limit('seamHighMin') }, floor: 0.5 },
  });
}

/** Pure: what the alpha channel REALLY contains (an alpha channel full of 255 is not transparency). */
export function analyzeAlpha(rgba, hasAlphaChannel) {
  const px = rgba.length / 4;
  if (!hasAlphaChannel) return freezeDeep({ alphaClass: ALPHA_CLASS.NO_ALPHA_CHANNEL, min: 255, max: 255, transparentPixels: 0, partialPixels: 0, pixels: px });
  let min = 255; let max = 0; let zero = 0; let partial = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i];
    if (a < min) min = a;
    if (a > max) max = a;
    if (a === 0) zero++; else if (a < 255) partial++;
  }
  const alphaClass = min === 255 ? ALPHA_CLASS.OPAQUE : max === 0 ? ALPHA_CLASS.FULLY_TRANSPARENT : partial === 0 ? ALPHA_CLASS.BINARY_CUTOUT : ALPHA_CLASS.SEMI_TRANSPARENT;
  return freezeDeep({ alphaClass, min, max, transparentPixels: zero, partialPixels: partial, pixels: px });
}

/**
 * @param {{ store: import('./eetf-store.js').EetfStore, derive: ReturnType<import('./eetf-derive.js').createEetfDerivationEngine> }} deps
 */
export function createEetfMaterialPipeline({ store, derive }) {
  if (!store || !derive) fail('EETF_ENGINE_CONFIG', 'store and derive engine are required');

  const runDerive = async (req) => {
    const job = await derive.run(derive.submit(req).id);
    if (job.status !== 'COMPLETED') fail(`EETF_${job.error?.code ?? 'TRANSCODE_FAILED'}`, `${req.operation} failed: ${job.error?.message ?? job.status}`);
    return store.getAsset(job.outputAssetIds[0]);
  };

  /** GENERATED stays as is; any other image is normalised to a DERIVED PNG (metadata + profile stripped, sRGB assumed). */
  async function prepareBaseColor(assetId) {
    const asset = store.getAsset(assertUuid(assetId, 'base colour asset id'));
    if (asset.role === 'GENERATED') return { asset, status: 'GENERATED' };
    const normalised = await runDerive({ sourceAssetId: asset.id, operation: 'CONVERT', format: 'PNG' });
    // [EETF-CERT] content addressing returns the source itself when normalising changes no byte: a SOURCE can never back a
    // DERIVED map (V1 rule kept), so this rare case is refused with a clear code instead of an internal mismatch.
    if (normalised.id === asset.id && asset.role !== 'DERIVED') fail('EETF_NORMALISATION_IDENTICAL', 'this image is already byte-identical to its normalised form; import it through a derivation first');
    return { asset: normalised, status: 'DERIVED' };
  }

  /** Seam + alpha analysis of an asset, stored once per asset / method / version. */
  async function analyze(assetId) {
    const existing = store.db.prepare('SELECT analysis_id FROM eetf_seam_analyses WHERE asset_id = ? AND method = ? AND version = ?').get(assertUuid(assetId, 'asset id'), SEAM_METHOD, SEAM_METHOD_VERSION);
    if (existing) return store.getSeamAnalysis(existing.analysis_id);
    const px = await derive.decodeRgba(assetId);
    const seams = analyzeSeams(px.rgba, px.width, px.height);
    const alpha = analyzeAlpha(px.rgba, px.hasAlphaChannel);
    return store.createSeamAnalysis({ assetId, ...seams, alphaClass: alpha.alphaClass, alpha: { ...alpha, decoder: px.engineVersion } }).analysis;
  }

  /** n × n repetition of the asset for visual inspection. A new DERIVED asset; the source is untouched. */
  const tilingPreview = (assetId, { grid = 2, maxSide = limit('maxThumbnailSide') } = {}) => runDerive({ sourceAssetId: assertUuid(assetId, 'asset id'), operation: 'TILE_PREVIEW', grid, maxSide, format: 'PNG' });

  /**
   * Creates a Material V1. Options:
   *   roughness / metallic: { value: number in [0, 1], reason?: string } — explicit USER decisions;
   *   opacity: 'FROM_SOURCE_ALPHA' | 'NONE' (default NONE);
   *   preview: false | { grid: 2 | 3, maxSide }.
   */
  async function createMaterial({ name, baseColorAssetId, roughness = null, metallic = null, opacity = 'NONE', preview = { grid: 2 } }) {
    for (const k of ['normal', 'height', 'ambientOcclusion', 'emissive']) if (arguments[0]?.[k] !== undefined) fail('EETF_MAP_STATUS_NOT_SUPPORTED_V1', `${k} is UNSUPPORTED in V1`);
    if (!['FROM_SOURCE_ALPHA', 'NONE'].includes(opacity)) fail('EETF_INVALID_PARAMS', "opacity is 'FROM_SOURCE_ALPHA' or 'NONE'");
    const constant = (role, c) => {
      if (c === null) return null;
      if (!c || typeof c !== 'object' || Array.isArray(c)) fail('EETF_INVALID_CONSTANT', `${role} is { value, reason? }`);
      if (typeof c.value !== 'number' || !Number.isFinite(c.value) || c.value < 0 || c.value > 1) fail('EETF_INVALID_CONSTANT', `${role} value must be a finite number in [0, 1]`);
      return { role, value: c.value, reason: c.reason ?? null };
    };
    const consts = [constant('ROUGHNESS', roughness), constant('METALLIC', metallic)].filter(Boolean);
    const base = await prepareBaseColor(baseColorAssetId);
    const analysis = await analyze(base.asset.id);
    if (opacity === 'FROM_SOURCE_ALPHA' && !['BINARY_CUTOUT', 'SEMI_TRANSPARENT', 'FULLY_TRANSPARENT'].includes(analysis.alphaClass)) {
      fail('EETF_NO_SOURCE_ALPHA', `the base colour has no real transparency (${analysis.alphaClass}); OPACITY stays UNSUPPORTED`);
    }
    const previewAsset = preview ? await tilingPreview(base.asset.id, preview) : null;
    const maps = [
      { role: 'BASE_COLOR', status: base.status, assetId: base.asset.id },
      ...consts.map(c => ({ role: c.role, status: 'USER_CONSTANT', constantValue: c.value })),
      ...(opacity === 'FROM_SOURCE_ALPHA' ? [{ role: 'OPACITY', status: 'FROM_SOURCE_ALPHA', assetId: base.asset.id }] : []),
    ];
    const record = store.createMaterialRecord({
      name, maps, decisions: consts.map(c => ({ role: c.role, reason: c.reason })), seamAnalysisId: analysis.id, previewAssetId: previewAsset?.id ?? null, colorSpace: COLOR_SPACE_ASSUMPTION,
    });
    return getMaterial(record.id);
  }

  /** Where a map comes from: asset, job, provider / engine, operation, parameters, status, timestamps. */
  function explainAsset(assetId) {
    const a = store.getAsset(assetId);
    const prov = a.provenanceId ? store.getProvenance(a.provenanceId) : null;
    const job = a.sourceJobId ? store.getJob(a.sourceJobId) : null;
    return {
      assetId: a.id, sha256: a.sha256, role: a.role, format: a.actualFormat, width: a.width, height: a.height, hasAlpha: a.hasAlpha, createdAt: a.createdAt,
      sourceJobId: a.sourceJobId, jobKind: job?.kind ?? null, operation: job?.params?.operation ?? null,
      provider: prov?.provider ?? null, model: prov?.model ?? null, engineVersion: prov?.engineVersion ?? null,
      derivedFrom: prov?.derivedFrom ?? [], parameters: prov?.parameters ?? null,
    };
  }

  function getMaterial(materialId) {
    const m = store.getMaterialRecord(materialId);
    const set = store.getTextureSet(m.textureSetId);
    const analysis = m.seamAnalysisId ? store.getSeamAnalysis(m.seamAnalysisId) : null;
    const decisions = Object.fromEntries(m.decisions.map(d => [d.role, d]));
    const key = { BASE_COLOR: 'baseColor', NORMAL: 'normal', ROUGHNESS: 'roughness', METALLIC: 'metallic', HEIGHT: 'height', AMBIENT_OCCLUSION: 'ao', OPACITY: 'opacity', EMISSIVE: 'emissive' };
    const out = { materialId: m.id, textureSetId: m.textureSetId, name: m.name, status: m.status, createdAt: m.createdAt };
    for (const role of TEXTURE_ROLES) {
      const map = set.maps.find(x => x.role === role);
      const entry = { role, status: map.status, exists: map.exists };
      if (map.assetId) entry.source = explainAsset(map.assetId);
      if (map.status === 'USER_CONSTANT') Object.assign(entry, { value: map.constantValue, decidedBy: decisions[role]?.decidedBy ?? null, reason: decisions[role]?.reason ?? null, decidedAt: decisions[role]?.createdAt ?? null });
      if (role === 'BASE_COLOR' && map.assetId) {
        Object.assign(entry, {
          colorSpace: m.colorSpace,
          tile: analysis ? { method: analysis.method, version: analysis.version, horizontalScore: analysis.horizontalScore, verticalScore: analysis.verticalScore, seamScore: analysis.seamScore, status: analysis.status, measures: analysis.measures } : { status: 'UNKNOWN' },
          alpha: analysis ? { alphaClass: analysis.alphaClass, ...analysis.alpha } : null,
          variants: store.listVariants(map.assetId).map(v => ({ variantId: v.id, assetId: v.variantAssetId, operation: v.operation, params: v.params })),
        });
      }
      if (role === 'OPACITY' && map.status === 'FROM_SOURCE_ALPHA') entry.channel = 'ALPHA_OF_BASE_COLOR';
      out[key[role]] = entry;
    }
    out.preview = m.previewAssetId ? { assetId: m.previewAssetId, purpose: 'VISUAL_INSPECTION_ONLY', source: explainAsset(m.previewAssetId) } : null;
    out.claims = { pbrComplete: false, seamless: false, seamlessTextureCapability: false };
    out.provenance = { baseColor: out.baseColor.source ?? null, decisions: m.decisions, colorSpace: m.colorSpace };
    return freezeDeep(out);
  }

  return Object.freeze({ prepareBaseColor, analyze, tilingPreview, createMaterial, getMaterial, explainAsset });
}
