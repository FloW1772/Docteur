// EETF V1 — environments pipeline (EETF-6).
//
// ENVIRONMENT IMAGES, not 3D environments:
//   BACKGROUND / SCENE_REFERENCE  a flat image (no camera, no geometry, no implied 3D object);
//   PANORAMA_REFERENCE            a close-to-2:1 image, analysed and labelled — never CERTIFIED_EQUIRECTANGULAR;
//   SKYBOX_PREVIEW                preview parameters (yaw / pitch / fov) + an optional rendered view image,
//                                 PREVIEW_ONLY — the parameters are not a scene camera.
// HDRI / certified equirectangular / cubemap / 3D scene stay refused (EETF-2 contract); EXR / HDR files
// made from LDR content stay LDR_CONTENT_IN_HDR_CONTAINER. No cubemap faces are produced.
//
// Analysis reuses EETF-SEAM v1 (eetf-materials.js): for a panorama only the HORIZONTAL wrap counts
// (top and bottom are poles, not neighbours). A pole hint is added: in an equirectangular image the top
// and bottom rows each map to one point, so their colour should be nearly uniform. Measurements only.
//
// The rendered view is pure JS (no WebGL, no process): rectilinear projection of the panorama treated AS
// IF equirectangular, nearest-neighbour sampling, PNG encoded with fixed zlib settings → same bytes on
// the same toolchain. It is a DERIVED asset (PREVIEW_ONLY) with a DERIVED_FROM provenance.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  EetfError, ENVIRONMENT_TYPE, assertEnvironmentType, assertUuid, limit, freezeDeep, FORMAT_MIME,
} from './eetf-contracts.js';

const fail = (code, message) => { throw new EetfError(code, message); };
export const SKYBOX_RENDERER = 'eetf-skybox-view-1';
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** Preview parameters (degrees). Bounds are PROVISIONAL limits; NaN / Infinity / out of range refused. */
export function validatePreviewParams({ yaw = 0, pitch = 0, fov = 90, width = 512, height = 288 } = {}) {
  const num = (v, min, max, what) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail('EETF_INVALID_PREVIEW', `${what} must be a finite number in [${min}, ${max}]`); return v; };
  const int = (v, what) => { if (!Number.isSafeInteger(v) || v < 16 || v > limit('maxThumbnailSide')) fail('EETF_INVALID_PREVIEW', `${what} must be an integer in [16, ${limit('maxThumbnailSide')}]`); return v; };
  return freezeDeep({
    yaw: num(yaw, -180, 180, 'yaw'), pitch: num(pitch, -90, 90, 'pitch'), fov: num(fov, limit('previewFovMinDeg'), limit('previewFovMaxDeg'), 'fov'),
    width: int(width, 'width'), height: int(height, 'height'),
  });
}

/** Pure: rectilinear view of an RGBA8 panorama treated as equirectangular (nearest sampling, deterministic). */
export function renderSkyboxView(rgba, w, h, params) {
  const p = validatePreviewParams(params);
  if (!Buffer.isBuffer(rgba) || rgba.length !== w * h * 4) fail('EETF_INVALID_PREVIEW', 'RGBA buffer does not match the panorama size');
  const out = Buffer.alloc(p.width * p.height * 4);
  const d2r = Math.PI / 180;
  const tanH = Math.tan((p.fov * d2r) / 2); const tanV = tanH * (p.height / p.width);
  const cy = Math.cos(p.yaw * d2r); const sy = Math.sin(p.yaw * d2r); const cp = Math.cos(p.pitch * d2r); const sp = Math.sin(p.pitch * d2r);
  for (let j = 0; j < p.height; j++) {
    const v = (1 - (2 * (j + 0.5)) / p.height) * tanV;
    for (let i = 0; i < p.width; i++) {
      const u = ((2 * (i + 0.5)) / p.width - 1) * tanH;
      const y1 = v * cp + sp; const z1 = -v * sp + cp;           // pitch around X
      const x2 = u * cy + z1 * sy; const z2 = -u * sy + z1 * cy;  // yaw around Y
      const lon = Math.atan2(x2, z2); const lat = Math.atan2(y1, Math.hypot(x2, z2));
      let sx = Math.floor((lon / (2 * Math.PI) + 0.5) * w); sx = ((sx % w) + w) % w;
      const syy = Math.min(h - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * h)));
      rgba.copy(out, (j * p.width + i) * 4, (syy * w + sx) * 4, (syy * w + sx) * 4 + 4);
    }
  }
  return { rgba: out, width: p.width, height: p.height, params: p };
}

function crcChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** Pure: deterministic PNG (8-bit RGB or RGBA, filter 0, zlib level 9, no ancillary chunk). */
export function encodePng(rgba, w, h, { alpha }) {
  const ch = alpha ? 4 : 3; const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4; const d = y * (w * ch + 1) + 1 + x * ch;
    raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2]; if (alpha) raw[d + 3] = rgba[s + 3];
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crcChunk('IHDR', ihdr), crcChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), crcChunk('IEND', Buffer.alloc(0))]);
}

/** Pure: mean absolute deviation (0..255) of the top and bottom rows from their own mean colour. */
export function poleRowDeviation(rgba, w, h) {
  const row = (y) => {
    const mean = [0, 0, 0];
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) mean[c] += rgba[(y * w + x) * 4 + c];
    for (let c = 0; c < 3; c++) mean[c] /= w;
    let dev = 0;
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) dev += Math.abs(rgba[(y * w + x) * 4 + c] - mean[c]);
    return round4(dev / (3 * w));
  };
  return { top: row(0), bottom: row(h - 1) };
}

/**
 * @param {{ store, derive, materials }} deps  materials = the EETF-5 pipeline (its `analyze` = EETF-SEAM v1)
 */
export function createEetfEnvironmentPipeline({ store, derive, materials }) {
  if (!store || !derive || !materials) fail('EETF_ENGINE_CONFIG', 'store, derive engine and materials pipeline are required');

  const runDerive = async (req) => {
    const job = await derive.run(derive.submit(req).id);
    if (job.status !== 'COMPLETED') fail(`EETF_${job.error?.code ?? 'TRANSCODE_FAILED'}`, `${req.operation} failed: ${job.error?.message ?? job.status}`);
    return store.getAsset(job.outputAssetIds[0]);
  };

  /** A provider output (GENERATED) or an already DERIVED asset is used as is; an imported SOURCE is normalised (DERIVED PNG). */
  async function prepare(assetId) {
    const a = store.getAsset(assertUuid(assetId, 'asset id'));
    if (a.role === 'SOURCE') { const n = await runDerive({ sourceAssetId: a.id, operation: 'CONVERT', format: 'PNG' }); return { asset: n, normalisedFrom: n.id === a.id ? null : a.id }; } // [EETF-CERT] exact report
    return { asset: a, normalisedFrom: null };
  }

  const baseReport = (asset, analysis) => ({
    kind: 'ENVIRONMENT_IMAGE', notA3dEnvironment: true, width: asset.width, height: asset.height, format: asset.actualFormat,
    dynamicRange: asset.dynamicRange, alphaClass: analysis.alphaClass, metadata: asset.role === 'SOURCE' ? 'AS_IMPORTED' : 'STRIPPED',
    assetRole: asset.role, colorSpace: 'SRGB_ASSUMED_PROFILE_STRIPPED',
  });

  async function createFlat(type, assetId) {
    const { asset, normalisedFrom } = await prepare(assetId);
    const analysis = await materials.analyze(asset.id);
    const warnings = [];
    if (['SEMI_TRANSPARENT', 'BINARY_CUTOUT', 'FULLY_TRANSPARENT'].includes(analysis.alphaClass)) warnings.push('HAS_TRANSPARENCY');
    if (asset.dynamicRange === 'LDR_CONTENT_IN_HDR_CONTAINER') warnings.push('LDR_CONTENT_IN_HDR_CONTAINER');
    const report = { ...baseReport(asset, analysis), environmentType: type, classification: type, normalisedFrom, warnings, camera: null, geometry: null };
    return store.createEnvironmentRecord({ environment: { assetId: asset.id, type }, report, seamAnalysisId: analysis.id });
  }

  /** PANORAMA_REFERENCE: close to 2:1, wide enough, measured — never certified. */
  async function createPanorama(assetId) {
    const { asset, normalisedFrom } = await prepare(assetId);
    const aspectRatio = round4(asset.width / asset.height);
    const deviation = round4(Math.abs(asset.width / asset.height - 2) / 2);
    if (deviation > limit('panoramaRatioTolerance')) fail('EETF_PANORAMA_ASPECT', `aspect ratio ${aspectRatio} is not close to 2:1 (deviation ${deviation})`);
    if (asset.width < limit('panoramaMinWidth')) fail('EETF_PANORAMA_TOO_SMALL', `${asset.width} px is below ${limit('panoramaMinWidth')} px`);
    const analysis = await materials.analyze(asset.id);
    const px = await derive.decodeRgba(asset.id);
    const poles = poleRowDeviation(px.rgba, px.width, px.height);
    const h = analysis.horizontalScore;
    const horizontalStatus = h <= limit('seamLowMax') ? 'LOW_SEAM' : h >= limit('seamHighMin') ? 'HIGH_SEAM' : 'MEASURED';
    const warnings = ['NOT_CERTIFIED_EQUIRECTANGULAR'];
    if (asset.width !== asset.height * 2) warnings.push('NOT_EXACT_2_TO_1');
    if (horizontalStatus !== 'LOW_SEAM') warnings.push(horizontalStatus === 'HIGH_SEAM' ? 'HIGH_HORIZONTAL_SEAM' : 'HORIZONTAL_SEAM_NOT_LOW');
    if (Math.max(poles.top, poles.bottom) > limit('poleRowDeviationMax')) warnings.push('POLE_ROWS_NOT_UNIFORM');
    if (['SEMI_TRANSPARENT', 'BINARY_CUTOUT', 'FULLY_TRANSPARENT'].includes(analysis.alphaClass)) warnings.push('HAS_TRANSPARENCY');
    if (asset.dynamicRange === 'LDR_CONTENT_IN_HDR_CONTAINER') warnings.push('LDR_CONTENT_IN_HDR_CONTAINER');
    const report = {
      ...baseReport(asset, analysis), environmentType: 'PANORAMA_REFERENCE', normalisedFrom,
      aspectRatio, ratio2to1Deviation: deviation, horizontalSeamScore: h, horizontalSeamStatus: horizontalStatus,
      seamMethod: `${analysis.method} v${analysis.version}`, poleRowDeviation: poles,
      classification: 'PANORAMA_REFERENCE', warnings,
    };
    return store.createEnvironmentRecord({
      environment: { assetId: asset.id, type: 'PANORAMA_REFERENCE', seamCheck: horizontalStatus === 'LOW_SEAM' ? 'PASSED' : 'FAILED', seamMetric: h },
      report, seamAnalysisId: analysis.id,
    });
  }

  /**
   * SKYBOX_PREVIEW of a PANORAMA_REFERENCE: preview parameters + (optionally) a rendered PREVIEW_ONLY view
   * image. Parameters are a viewer setting, not a scene camera. No cubemap is produced.
   */
  async function createSkyboxPreview(panoramaEnvironmentId, params = {}, { renderView = true } = {}) {
    const pano = store.getEnvironmentAsset(assertUuid(panoramaEnvironmentId, 'panorama environment id'));
    if (pano.type !== ENVIRONMENT_TYPE.PANORAMA_REFERENCE) fail('EETF_INVALID_ENVIRONMENT', 'a skybox preview is based on a PANORAMA_REFERENCE');
    const p = validatePreviewParams(params);
    let view = null;
    if (renderView) {
      const px = await derive.decodeRgba(pano.assetId);
      const r = renderSkyboxView(px.rgba, px.width, px.height, p);
      const alpha = px.hasAlphaChannel;
      const buffer = encodePng(r.rgba, r.width, r.height, { alpha });
      const sha = crypto.createHash('sha256').update(buffer).digest('hex');
      view = store.getAssetBySha(sha);
      if (!view) {
        const prov = store.createProvenance({
          provider: 'eetf-local', model: null, engineVersion: SKYBOX_RENDERER, width: r.width, height: r.height, strictLocal: true,
          sources: [{ assetId: pano.assetId, relation: 'DERIVED_FROM' }],
          parameters: { operation: 'SKYBOX_VIEW', previewOnly: true, yaw: p.yaw, pitch: p.pitch, fov: p.fov, sampling: 'NEAREST', projection: 'TREATED_AS_EQUIRECTANGULAR_FOR_PREVIEW' },
        });
        view = store.registerAsset({ buffer, declaredMime: FORMAT_MIME.PNG, role: 'DERIVED', provenanceId: prov.id, displayName: `skybox-view-${pano.id.slice(0, 8)}` }).asset;
      }
    }
    const report = {
      kind: 'SKYBOX_PREVIEW', previewOnly: true, notASceneCamera: true, notACubemap: true, basedOnPanorama: pano.id,
      preview: { yaw: p.yaw, pitch: p.pitch, fov: p.fov, width: p.width, height: p.height, mapping: 'EQUIRECTANGULAR_SPHERE_PREVIEW', renderer: renderView ? SKYBOX_RENDERER : 'CLIENT_THREE_JS' },
      warnings: ['PREVIEW_ONLY', 'NOT_CERTIFIED_EQUIRECTANGULAR'],
    };
    return store.createEnvironmentRecord({ environment: { assetId: pano.assetId, type: 'SKYBOX_PREVIEW', basedOnEnvironmentId: pano.id }, report, previewAssetId: view?.id ?? null });
  }

  /** Environment + where its image comes from (asset, job, provider / engine, prompt, seed, operation, analysis). */
  function getEnvironment(environmentId) {
    const env = store.getEnvironmentAsset(environmentId);
    const a = store.getAsset(env.assetId);
    const prov = a.provenanceId ? store.getProvenance(a.provenanceId) : null;
    const job = a.sourceJobId ? store.getJob(a.sourceJobId) : null;
    return freezeDeep({
      ...env,
      asset: { assetId: a.id, role: a.role, format: a.actualFormat, width: a.width, height: a.height, dynamicRange: a.dynamicRange, sha256: a.sha256, sourceJobId: a.sourceJobId, createdAt: a.createdAt },
      provenance: prov ? { provider: prov.provider, model: prov.model, prompt: prov.prompt, seed: prov.seed, width: prov.width, height: prov.height, operation: job?.params?.operation ?? null, jobKind: job?.kind ?? null, derivedFrom: prov.derivedFrom, parameters: prov.parameters, createdAt: prov.createdAt } : null,
      seamAnalysis: env.report?.seamAnalysisId ? store.getSeamAnalysis(env.report.seamAnalysisId) : null,
    });
  }

  return Object.freeze({
    createBackground: (assetId) => createFlat('BACKGROUND', assetId),
    createSceneReference: (assetId) => createFlat('SCENE_REFERENCE', assetId),
    createPanorama, createSkyboxPreview, getEnvironment,
    /** Explicitly refused types (no fake support): HDRI, CERTIFIED_EQUIRECTANGULAR, CUBEMAP, 3D_SCENE. */
    create: (type, assetId) => { const t = assertEnvironmentType(type); return t === 'PANORAMA_REFERENCE' ? createPanorama(assetId) : t === 'SKYBOX_PREVIEW' ? fail('EETF_INVALID_ENVIRONMENT', 'use createSkyboxPreview') : createFlat(t, assetId); },
  });
}
