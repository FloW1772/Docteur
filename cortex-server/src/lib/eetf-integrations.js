// EETF V1 — EETF-8 product integrations (Media Studio, Media Reader, Neurone).
//
// EETF stays an additive layer: Media Studio keeps its own project copies, the Neurone keeps its image store
// (data/images, one file per image block — deleting a block deletes its file, so a file is never shared), the
// Media Reader only reads. EETF keeps ONE content-addressed copy per content and records the exchanges as
// immutable links (eetf_asset_links): IMPORT = these bytes came from there, EXPORT = a byte-identical copy went
// there. A link is provenance only — it never grants an action.
//
// Sources are read by the server itself whenever it can (Neurone images: validated id → the image module's own
// folder; never a client path). Media Studio bytes arrive from the browser (the studio service lives in server.js,
// which EETF does not touch) and are bound to the studio record by their SHA-256. Content is always sniffed by the
// asset store (never the extension, the browser MIME or the name). Sources are never modified.

import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  EetfError, limit, isUuid, NEURON_IMAGE_ID_RE, NEURON_IMAGE_MIME, BROWSER_NATIVE_FORMATS, validateLinkRef, safeDisplayName, freezeDeep,
} from './eetf-contracts.js';

const fail = (code, message) => { throw new EetfError(code, message); };

/** Product error vocabulary of the integrations (EETF-8). Asset-store codes are folded into it. */
export const INTEGRATION_ERROR = Object.freeze({
  UNSUPPORTED_MEDIA: 'EETF_UNSUPPORTED_MEDIA', INVALID_SOURCE: 'EETF_INVALID_SOURCE', ASSET_NOT_FOUND: 'EETF_ASSET_NOT_FOUND',
  SOURCE_UNAVAILABLE: 'EETF_SOURCE_UNAVAILABLE', PIXEL_LIMIT: 'EETF_PIXEL_LIMIT', FORMAT_UNSUPPORTED: 'EETF_FORMAT_UNSUPPORTED',
});

const FOLD = {
  EETF_UNSUPPORTED_MIME: INTEGRATION_ERROR.UNSUPPORTED_MEDIA, EETF_UNSUPPORTED_FORMAT: INTEGRATION_ERROR.UNSUPPORTED_MEDIA,
  EETF_MIME_MISMATCH: INTEGRATION_ERROR.UNSUPPORTED_MEDIA, EETF_MALFORMED_IMAGE: INTEGRATION_ERROR.UNSUPPORTED_MEDIA, EETF_EMPTY_FILE: INTEGRATION_ERROR.UNSUPPORTED_MEDIA,
  EETF_IMAGE_TOO_LARGE: INTEGRATION_ERROR.PIXEL_LIMIT,
};
/** Re-labels an asset-store refusal with the product code; anything else passes through unchanged. */
function folded(e) {
  if (e instanceof EetfError && FOLD[e.code]) return new EetfError(FOLD[e.code], e.message);
  return e;
}

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * @param {{ store: import('./eetf-store.js').EetfStore, resolveNeuronImage?: ((imageId: string) => string | null) | null, validate?: ((buffer: Buffer) => Promise<unknown>) | null }} deps
 *   validate: the bounded FFmpeg decode check every external file passes before it becomes an asset (EETF-CERT).
 *   resolveNeuronImage: validated Neurone image id → absolute file path inside the image store (null = unknown id).
 */
export function createEetfIntegrations({ store, resolveNeuronImage = null, validate = null }) {
  /** Reads a Neurone image the server resolved itself: regular file only, bounded size. */
  function readNeuronImage(imageId) {
    if (typeof imageId !== 'string' || !NEURON_IMAGE_ID_RE.test(imageId)) fail('EETF_INVALID_ID', 'invalid Neurone image id');
    if (typeof resolveNeuronImage !== 'function') fail(INTEGRATION_ERROR.SOURCE_UNAVAILABLE, 'Neurone image store unavailable');
    let file = null;
    try { file = resolveNeuronImage(imageId); } catch { file = null; }
    if (!file) fail(INTEGRATION_ERROR.SOURCE_UNAVAILABLE, 'Neurone image not found');
    let st;
    try { st = fs.lstatSync(file); } catch { fail(INTEGRATION_ERROR.SOURCE_UNAVAILABLE, 'Neurone image not found'); }
    if (!st.isFile() || st.isSymbolicLink()) fail(INTEGRATION_ERROR.SOURCE_UNAVAILABLE, 'Neurone image is not a regular file');
    if (st.size > limit('maxFileSize')) fail('EETF_FILE_TOO_LARGE', 'file too large');
    return fs.readFileSync(file);
  }

  async function register({ buffer, declaredMime, displayName }) {
    try {
      if (typeof validate !== 'function') fail(INTEGRATION_ERROR.UNSUPPORTED_MEDIA, 'no decode check available: the file cannot be verified');
      await validate(buffer); // header + structure (pure) then a bounded FFmpeg decode — same check as a direct upload
      return store.registerAsset({ buffer, declaredMime, role: 'SOURCE', displayName });
    } catch (e) { throw folded(e); }
  }

  /** Same bytes, a second origin: the existing content-addressed asset gains a link, never a second copy. */
  function linked(assetResult, link) {
    return freezeDeep({ asset: assetResult.asset, existed: assetResult.existed, link: link.link, linkExisted: link.existed });
  }

  return {
    /** Neurone image → EETF source (read server-side from the Neurone image store). */
    async importNeuronImage({ imageId }) {
      const { ref } = validateLinkRef('NEURON_IMAGE', { imageId });
      const ext = ref.imageId.split('.').pop();
      const declaredMime = NEURON_IMAGE_MIME[ext];
      if (!declaredMime) fail(INTEGRATION_ERROR.UNSUPPORTED_MEDIA, 'GIF images are not an EETF format (PNG, JPEG, WebP, TIFF, EXR, HDR)');
      const buffer = readNeuronImage(ref.imageId);
      const result = await register({ buffer, declaredMime, displayName: `neurone-${ref.imageId.slice(0, 8)}.${ext}` });
      const link = store.createAssetLink({ assetId: result.asset.id, direction: 'IMPORT', system: 'NEURON_IMAGE', ref, contentSha256: result.asset.sha256, verification: 'SERVER_RESOLVED' });
      return linked(result, link);
    },

    /** Media Studio image → EETF source. The bytes must hash to the studio record's SHA-256 (declared by the caller). */
    async importMediaStudioBytes({ buffer, declaredMime, projectId, mediaAssetId, sha256, name = null }) {
      const { ref } = validateLinkRef('MEDIA_STUDIO', { projectId, mediaAssetId });
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) fail(INTEGRATION_ERROR.INVALID_SOURCE, 'the Media Studio record hash is required');
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) fail(INTEGRATION_ERROR.UNSUPPORTED_MEDIA, 'empty file');
      if (sha256Of(buffer) !== sha256) fail(INTEGRATION_ERROR.INVALID_SOURCE, 'the received bytes do not match the Media Studio record (altered or different media)');
      const result = await register({ buffer, declaredMime, displayName: name === null ? 'media-studio-image' : safeDisplayName(name, 'media-studio-image') });
      const link = store.createAssetLink({ assetId: result.asset.id, direction: 'IMPORT', system: 'MEDIA_STUDIO', ref, contentSha256: result.asset.sha256, verification: 'CONTENT_SHA256_MATCH' });
      return linked(result, link);
    },

    /**
     * A byte-identical copy of an asset was handed to another surface. Neurone images are re-read and re-hashed by the
     * server; a Media Studio copy is accepted when its recorded SHA-256 equals the asset's.
     */
    recordExport({ assetId, system, ref, sha256 = null }) {
      if (!isUuid(assetId)) fail('EETF_INVALID_ID', 'invalid asset id');
      const asset = store.getAsset(assetId);
      const { ref: clean } = validateLinkRef(system, ref);
      if (system === 'NEURON_IMAGE') {
        const target = readNeuronImage(clean.imageId);
        if (sha256Of(target) !== asset.sha256) fail(INTEGRATION_ERROR.INVALID_SOURCE, 'the Neurone image is not a byte-identical copy of the asset');
        return store.createAssetLink({ assetId, direction: 'EXPORT', system, ref: clean, contentSha256: asset.sha256, verification: 'SERVER_RESOLVED' });
      }
      if (sha256 !== asset.sha256) fail(INTEGRATION_ERROR.INVALID_SOURCE, 'the Media Studio copy is not byte-identical to the asset');
      return store.createAssetLink({ assetId, direction: 'EXPORT', system, ref: clean, contentSha256: asset.sha256, verification: 'CONTENT_SHA256_MATCH' });
    },

    /** Reverse lookup for a reader showing a Neurone image or a Media Studio asset. */
    findLinks(system, ref) { return store.findLinks(system, ref); },

    /** Everything a reader may show about an asset: no storage path, no SQL, no internal error. */
    describeAsset(assetId) {
      const a = store.getAsset(assetId);
      const native = BROWSER_NATIVE_FORMATS.includes(a.actualFormat);
      const usages = store.listAssetUsages(a.id);
      const classification = [
        ...new Set([
          ...usages.textureMaps.map(m => `TEXTURE_${m.role}`),
          ...usages.environments.map(e => `ENVIRONMENT_${e.type}`),
        ]),
      ];
      return freezeDeep({
        links: store.listAssetLinks(a.id).map(l => ({ id: l.id, direction: l.direction, system: l.system, ref: l.ref, verification: l.verification, createdAt: l.createdAt })),
        usages,
        classification,
        preview: { native, variant: native ? null : store.findPreviewVariant(a.id) },
      });
    },
  };
}
