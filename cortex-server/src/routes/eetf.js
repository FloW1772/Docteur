// EETF V1 — HTTP routes (EETF-7). Mounted under /api/image-generation/eetf by routes/image-generation.js
// (no change to server.js). While EETF is uncertified the boot gate keeps it closed: every route answers
// 503 EETF_DISABLED and nothing is opened. With the dev gate (DOCTEUR_EETF_DEV_DB + DOCTEUR_EETF_DEV_ROOT)
// the routes work on that separate store.
//
// Errors are stable codes ({ error_code, message }) — never a stack trace, an internal path, SQL or a
// Root Policy internal. Asset bytes are only served by validated id from the content-addressed store,
// with nosniff and a sandboxing CSP. Jobs run in the background (one FFmpeg slot, one GPU slot).

import { Hono } from 'hono';
import { EetfError, limit, isUuid, formatFromMime, MAP_STATUS_ALLOWED_V1, ENVIRONMENT_TYPE, ENVIRONMENT_TYPE_UNSUPPORTED_V1, FORMAT_MIME } from '../lib/eetf-contracts.js';
import { createEetfDerivationEngine } from '../lib/eetf-derive.js';
import { createEetfMaterialPipeline } from '../lib/eetf-materials.js';
import { createEetfEnvironmentPipeline } from '../lib/eetf-environments.js';
import { createProviderRegistry } from '../lib/eetf-providers.js';
import { createEetfGenerationEngine } from '../lib/eetf-generate.js';
import { createComfyUiProvider } from '../lib/eetf-comfyui-provider.js';
import { openEetfAtBoot } from '../lib/eetf-boot.js';
import { eetfEnforce } from '../lib/eetf-policy.js'; // [EETF-CERT]
import { createEetfIntegrations } from '../lib/eetf-integrations.js';
import { validateImageId, getImagePath } from '../lib/image.js';

const JSON_BODY_MAX = 64 * 1024;
const STATUS_CACHE_MS = 5_000;

/** Builds the EETF services around an open store. `providers` overrides the default loopback ComfyUI adapter (tests). */
export function createEetfServices({ store, enforce, ffmpegBin, providerEndpoint, providers = null, deriveOptions = {}, resolveNeuronImage = null }) {
  const derive = createEetfDerivationEngine({ store, enforce, ...(ffmpegBin ? { ffmpegBin } : {}), ...deriveOptions });
  const materials = createEetfMaterialPipeline({ store, derive });
  const environments = createEetfEnvironmentPipeline({ store, derive, materials });
  const registry = createProviderRegistry();
  for (const p of providers ?? [createComfyUiProvider({ endpoint: providerEndpoint, enforce })]) registry.register(p);
  const providerId = registry.list()[0];
  const generation = createEetfGenerationEngine({ store, registry, providerId });
  const integrations = createEetfIntegrations({ store, resolveNeuronImage, validate: (buffer) => derive.validateDecodable(buffer) }); // [EETF-8] + [EETF-CERT] decode check
  return { store, derive, materials, environments, registry, generation, providerId, integrations };
}

const HTTP_FOR = (code) => {
  if (/NOT_FOUND$/.test(code)) return 404;
  if (/^(ENGINE_BUSY|PROVIDER_|CAPABILITY_UNSUPPORTED|MODEL_NOT_FOUND|VRAM_GUARD|WORKFLOW_INVALID|JOB_NOT_|INVALID_TRANSITION|RETRY_LIMIT)/.test(code)) return 409;
  if (code === 'FILE_TOO_LARGE' || code === 'PIXEL_LIMIT') return 413;
  if (code === 'UNSUPPORTED_MEDIA' || code === 'FORMAT_UNSUPPORTED') return 415; // [EETF-8] integration vocabulary
  if (code === 'SOURCE_UNAVAILABLE') return 404;
  if (code === 'LINK_CONTENT_MISMATCH') return 422;
  return 400;
};
/** User-safe message: drops anything that looks like a filesystem path or a URL with credentials. */
const safeMessage = (m) => String(m ?? '').replace(/[A-Za-z]:\\[^\s'"]*|\\\\[^\s'"]+|\/(?:Users|home|tmp|var)\/[^\s'"]*/g, '[path]').slice(0, 300);

function errorResponse(c, e) {
  if (e instanceof EetfError || (typeof e?.code === 'string' && e.code.startsWith('EETF_'))) {
    const code = e.code.replace(/^EETF_/, '');
    return c.json({ error_code: code, message: safeMessage(e.message) }, HTTP_FOR(code));
  }
  return c.json({ error_code: 'INTERNAL', message: 'Erreur interne EETF.' }, 500);
}

async function jsonBody(c) {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > JSON_BODY_MAX) throw new EetfError('EETF_PARAMS_TOO_LARGE', 'request body too large');
  const text = await c.req.text();
  if (text.length > JSON_BODY_MAX) throw new EetfError('EETF_PARAMS_TOO_LARGE', 'request body too large');
  try { const v = text ? JSON.parse(text) : {}; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('x'); return v; } catch { throw new EetfError('EETF_INVALID_PARAMS', 'body must be a JSON object'); }
}

const publicAsset = (a) => ({
  id: a.id, role: a.role, format: a.actualFormat, mime: a.mime, width: a.width, height: a.height, hasAlpha: a.hasAlpha,
  dynamicRange: a.dynamicRange, sizeBytes: a.sizeBytes, displayName: a.displayName, sourceJobId: a.sourceJobId, createdAt: a.createdAt, sha256: a.sha256,
});

/**
 * @param {ReturnType<typeof createEetfServices> | null} services  null → every route answers 503 EETF_DISABLED
 */
export function createEetfRoute(services, { disabledReason = 'EETF_UNCERTIFIED_DISABLED', logger = null } = {}) {
  const route = new Hono();
  if (!services) {
    route.get('/status', (c) => c.json({ enabled: false, reason: disabledReason }));
    route.all('*', (c) => c.json({ error_code: 'EETF_DISABLED', message: 'EETF est désactivé tant qu’il n’est pas certifié.', reason: disabledReason }, 503));
    return route;
  }
  const { store, derive, materials, environments, registry, generation, providerId, integrations } = services;
  let statusCache = null;

  // ── background runners (one FFmpeg slot, one GPU slot) ──
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (let guard = 0; guard < 1000; guard++) {
        const a = derive.isRunning() ? null : await derive.runNext().catch((e) => { logger?.warn?.({ err: e.message }, 'EETF derive runner'); return null; });
        const b = generation.isRunning() ? null : await generation.runNext().catch((e) => { logger?.warn?.({ err: e.message }, 'EETF generation runner'); return null; });
        if (!a && !b) break;
      }
    } finally { pumping = false; }
  };
  const kick = () => { setImmediate(() => { void pump(); }); };

  route.get('/status', async (c) => {
    try {
      if (!statusCache || Date.now() - statusCache.at > STATUS_CACHE_MS || c.req.query('refresh') === '1') {
        const snap = await registry.refresh(providerId);
        const ff = await derive.detect().catch(() => ({ available: false }));
        statusCache = { at: Date.now(), snap, ff };
      }
      const { snap, ff } = statusCache;
      const genOk = snap.status === 'AVAILABLE' && snap.capabilities.includes('TXT2IMG');
      return c.json({
        enabled: true,
        provider: {
          id: snap.providerId, displayName: snap.displayName, locality: snap.locality, status: snap.status, reason: snap.reason ? safeMessage(snap.reason) : null,
          capabilities: snap.capabilities, models: snap.models, engineVersion: snap.health.engineVersion,
        },
        generation: { available: genOk, reason: genOk ? null : (snap.status === 'AVAILABLE' ? 'CAPABILITY_UNSUPPORTED' : 'LOCAL_PROVIDER_UNAVAILABLE') },
        local: { ffmpeg: { available: Boolean(ff.available), version: ff.version ?? null } },
        contract: {
          mapStatuses: MAP_STATUS_ALLOWED_V1, environmentTypes: Object.keys(ENVIRONMENT_TYPE), unsupportedEnvironmentTypes: ENVIRONMENT_TYPE_UNSUPPORTED_V1,
          pbrCompleteReachable: false, seamlessClaims: false,
        },
        limits: {
          maxFileSize: limit('maxFileSize'), maxImportSide: limit('maxImportSide'), maxGenerationSide: limit('maxGenerationSide'),
          previewFov: [limit('previewFovMinDeg'), limit('previewFovMaxDeg')], panoramaMinWidth: limit('panoramaMinWidth'), panoramaRatioTolerance: limit('panoramaRatioTolerance'),
        },
      });
    } catch (e) { return errorResponse(c, e); }
  });

  // ── assets ──
  route.get('/assets', (c) => {
    try { return c.json({ assets: store.listAssets({ limit: Number(c.req.query('limit') ?? 50) }).map(publicAsset) }); } catch (e) { return errorResponse(c, e); }
  });
  route.post('/assets', async (c) => {
    try {
      const declared = Number(c.req.header('content-length'));
      if (Number.isFinite(declared) && declared > limit('maxFileSize')) throw new EetfError('EETF_FILE_TOO_LARGE', 'file too large');
      const mime = String(c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const buffer = Buffer.from(await c.req.arrayBuffer());
      // name in the query string: the API CORS policy only allows Content-Type / Authorization headers
      const name = typeof c.req.query('name') === 'string' ? c.req.query('name').slice(0, 300) : null;
      const contentDynamicRange = ['image/x-exr', 'image/vnd.radiance'].includes(mime) ? 'LDR' : undefined;
      formatFromMime(mime); // unsupported MIME refused before any process starts
      await derive.validateDecodable(buffer); // [EETF-CERT] same integrity gate as every other ingress
      const { asset, existed } = store.registerAsset({ buffer, declaredMime: mime, contentDynamicRange, role: 'SOURCE', displayName: name });
      return c.json({ asset: publicAsset(asset), existed }, existed ? 200 : 201);
    } catch (e) { return errorResponse(c, e); }
  });
  route.get('/assets/:id', (c) => {
    try { const id = c.req.param('id'); return c.json({ asset: publicAsset(store.getAsset(id)), source: materials.explainAsset(id), integration: integrations.describeAsset(id) }); } catch (e) { return errorResponse(c, e); }
  });
  route.get('/assets/:id/file', (c) => {
    try {
      const id = c.req.param('id');
      if (!isUuid(id)) throw new EetfError('EETF_INVALID_ID', 'invalid asset id');
      const a = store.getAsset(id);
      if (!store.verifyAsset(id)) throw new EetfError('EETF_INVALID_SOURCE', 'asset file unavailable');
      const bytes = store.files.readAsset(a.storagePath); // storage path re-validated, no link followed
      return new Response(bytes, { status: 200, headers: {
        'Content-Type': FORMAT_MIME[a.actualFormat], 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Disposition': 'inline',
      } });
    } catch (e) { return errorResponse(c, e); }
  });

  // ── integrations (EETF-8): Media Studio, Neurone images; the Media Reader only reads ──
  // Neurone image → EETF: the server reads the image store itself (validated id, never a client path).
  route.post('/imports/neuron-image', async (c) => {
    try {
      const { imageId } = await jsonBody(c);
      const r = await integrations.importNeuronImage({ imageId });
      return c.json({ asset: publicAsset(r.asset), existed: r.existed, link: r.link, linkExisted: r.linkExisted }, r.existed ? 200 : 201);
    } catch (e) { return errorResponse(c, e); }
  });
  // Media Studio image → EETF: raw bytes, bound to the studio record by its SHA-256 (query string: CORS allows no custom header).
  route.post('/imports/media-studio', async (c) => {
    try {
      const declared = Number(c.req.header('content-length'));
      if (Number.isFinite(declared) && declared > limit('maxFileSize')) throw new EetfError('EETF_FILE_TOO_LARGE', 'file too large');
      const mime = String(c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const buffer = Buffer.from(await c.req.arrayBuffer());
      if (buffer.length > limit('maxFileSize')) throw new EetfError('EETF_FILE_TOO_LARGE', 'file too large');
      const q = (k) => (typeof c.req.query(k) === 'string' ? c.req.query(k).slice(0, 300) : null);
      const r = await integrations.importMediaStudioBytes({ buffer, declaredMime: mime, projectId: q('projectId'), mediaAssetId: q('mediaAssetId'), sha256: q('sha256'), name: q('name') });
      return c.json({ asset: publicAsset(r.asset), existed: r.existed, link: r.link, linkExisted: r.linkExisted }, r.existed ? 200 : 201);
    } catch (e) { return errorResponse(c, e); }
  });
  // A byte-identical copy of an asset was handed to Media Studio / a Neurone image block.
  route.post('/assets/:id/exports', async (c) => {
    try {
      const { system, ref, sha256 = null } = await jsonBody(c);
      const r = integrations.recordExport({ assetId: c.req.param('id'), system, ref, sha256 });
      return c.json({ link: r.link, existed: r.existed }, r.existed ? 200 : 201);
    } catch (e) { return errorResponse(c, e); }
  });
  // Reverse lookup (readers): ?system=NEURON_IMAGE&imageId=… | ?system=MEDIA_STUDIO&projectId=…&mediaAssetId=…
  route.get('/links', (c) => {
    try {
      const system = c.req.query('system');
      const ref = system === 'MEDIA_STUDIO' ? { projectId: c.req.query('projectId'), mediaAssetId: c.req.query('mediaAssetId') } : { imageId: c.req.query('imageId') };
      const links = integrations.findLinks(system, ref).map(l => ({ id: l.id, assetId: l.assetId, direction: l.direction, system: l.system, ref: l.ref, verification: l.verification, createdAt: l.createdAt }));
      return c.json({ links });
    } catch (e) { return errorResponse(c, e); }
  });

  // ── jobs ──
  route.get('/jobs', (c) => { try { return c.json({ jobs: store.listJobs({ limit: Number(c.req.query('limit') ?? 30) }) }); } catch (e) { return errorResponse(c, e); } });
  route.get('/jobs/:id', (c) => { try { return c.json({ job: store.getJob(c.req.param('id')) }); } catch (e) { return errorResponse(c, e); } });
  route.post('/jobs/:id/cancel', async (c) => {
    try {
      const id = c.req.param('id');
      const job = store.getJob(id);
      const r = job.kind === 'GENERATE' ? await generation.cancel(id) : await derive.cancel(id);
      return c.json({ job: r.job, interruptRequired: r.interruptRequired, gpuStopGuaranteed: job.kind === 'GENERATE' ? false : null, note: r.note ?? null });
    } catch (e) { return errorResponse(c, e); }
  });
  route.post('/derive', async (c) => {
    try { const job = derive.submit(await jsonBody(c)); kick(); return c.json({ job }, 202); } catch (e) { return errorResponse(c, e); }
  });
  route.post('/generate', async (c) => {
    try { const job = await generation.submit(await jsonBody(c)); kick(); return c.json({ job }, 202); } catch (e) { return errorResponse(c, e); }
  });

  // ── materials / environments (synchronous local operations) ──
  route.post('/materials', async (c) => { try { return c.json({ material: await materials.createMaterial(await jsonBody(c)) }, 201); } catch (e) { return errorResponse(c, e); } });
  route.get('/materials/:id', (c) => { try { return c.json({ material: materials.getMaterial(c.req.param('id')) }); } catch (e) { return errorResponse(c, e); } });
  route.post('/environments', async (c) => {
    try { const { type, assetId } = await jsonBody(c); const env = await environments.create(type, assetId); return c.json({ environment: environments.getEnvironment(env.id) }, 201); } catch (e) { return errorResponse(c, e); }
  });
  route.post('/environments/:id/skybox', async (c) => {
    try {
      const { renderView = true, ...params } = await jsonBody(c);
      const env = await environments.createSkyboxPreview(c.req.param('id'), params, { renderView: renderView !== false });
      return c.json({ environment: environments.getEnvironment(env.id) }, 201);
    } catch (e) { return errorResponse(c, e); }
  });
  route.get('/environments/:id', (c) => { try { return c.json({ environment: environments.getEnvironment(c.req.param('id')) }); } catch (e) { return errorResponse(c, e); } });

  route.all('*', (c) => c.json({ error_code: 'NOT_FOUND', message: 'Route EETF inconnue.' }, 404));
  return route;
}

/** Production mount: boot gate first; closed → 503 routes, nothing opened. */
export function createEetfRouteFromBoot({ enforce = eetfEnforce, providerEndpoint, logger = null, env = process.env }) {
  const { store, decision } = openEetfAtBoot({ env, logger });
  if (!store) return createEetfRoute(null, { disabledReason: decision.reason, logger });
  // [EETF-8] Neurone images are resolved by the image module itself (strict id, inside its own folder)
  const resolveNeuronImage = (id) => (validateImageId(id) ? getImagePath(id) : null);
  return createEetfRoute(createEetfServices({ store, enforce, providerEndpoint: providerEndpoint(), resolveNeuronImage }), { logger });
}
