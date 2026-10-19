// EETF-6 — environments: backgrounds, scene references, panorama references, skybox previews.
// Real FFmpeg on local fixtures (EETF-3 engine, real Root Policy MEDIA_TRANSCODE decision), an in-process
// FAKE provider for the generated path (no ComfyUI, no model, no network), temporary store only.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EetfStore } from './src/lib/eetf-store.js';
import { hashFile } from './src/lib/eetf-asset-store.js';
import { createEetfDerivationEngine } from './src/lib/eetf-derive.js';
import { createEetfMaterialPipeline } from './src/lib/eetf-materials.js';
import { createEetfEnvironmentPipeline, renderSkyboxView, validatePreviewParams, poleRowDeviation, encodePng } from './src/lib/eetf-environments.js';
import { createProviderRegistry } from './src/lib/eetf-providers.js';
import { createEetfGenerationEngine } from './src/lib/eetf-generate.js';
import { enforce as realEnforce } from './src/lib/root-policy/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf6-'));
const REAL_DB_FILES = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? hashFile(p) : 'absent');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-version'], { shell: false, windowsHide: true }).status === 0;
const skip = HAS_FFMPEG ? false : 'FFmpeg is not installed on this machine';
let realDbBefore; let fetchCalls = 0; const realFetch = globalThis.fetch;
const opened = [];

before(() => { realDbBefore = REAL_DB_FILES.map(fileHash); globalThis.fetch = async () => { fetchCalls++; throw new Error('no network in EETF-6 tests'); }; });
after(() => {
  globalThis.fetch = realFetch;
  for (const s of opened) s.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { console.warn(`temp cleanup: ${e.message}`); }
});
const code = (c) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`); return true; };

// ── fixtures ───────────────────────────────────────────────────────────────

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function png(w, h, f, { alpha = false, extra = [] } = {}) {
  const ch = alpha ? 4 : 3; const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = f(x, y); for (let c = 0; c < ch; c++) raw[y * (w * ch + 1) + 1 + x * ch + c] = p[c]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const T = Math.PI * 2;
/** Wraps horizontally and fades to a uniform colour at both poles (what an equirectangular sky looks like). */
const skyLike = (w, h) => (x, y) => { const lat = Math.sin(Math.PI * (y + 0.5) / h); return [128 + Math.round(100 * Math.sin(T * x / w) * lat), 50 + Math.round(150 * y / h), 128 + Math.round(60 * Math.cos(T * x / w) * lat)]; };
const rampX = (w) => (x, y) => [Math.round(255 * x / (w - 1)), 80 + (y % 7), 40];
const EXIF_GPS = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x0e, 0, 2, 0, 0, 0, 8, 0, 0, 0, 26, 0, 0, 0, 0, ...Buffer.from('GPSDATA'), 0]);

let n = 0;
function setup({ dir = null, ...deriveOpts } = {}) {
  const d = dir ?? path.join(TMP, `w${++n}`); fs.mkdirSync(d, { recursive: true });
  const store = EetfStore.open({ dbPath: path.join(d, 'eetf.sqlite'), assetRoot: path.join(d, 'root') });
  opened.push(store);
  const derive = createEetfDerivationEngine({ store, enforce: realEnforce, ...deriveOpts });
  const materials = createEetfMaterialPipeline({ store, derive });
  return { store, derive, materials, env: createEetfEnvironmentPipeline({ store, derive, materials }), dir: d };
}
const source = (store, buf, mime = 'image/png') => store.registerAsset({ buffer: buf, declaredMime: mime, role: 'SOURCE' }).asset;
// [EETF-CERT] an asset accepted by a PRE-certification build (header-only sniff), stored exactly the way EETF-2..8 did:
// the store now refuses such bytes at ingest, but a store written earlier may still hold one → downstream must fail cleanly.
function legacyCorruptAsset(store, buf, { width, height }) {
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const rel = `assets/${sha.slice(0, 2)}/${sha}.png`;
  const abs = store.files.resolveInside(rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf);
  const id = crypto.randomUUID();
  store.db.prepare(`INSERT INTO eetf_assets (asset_id, sha256, mime, actual_format, declared_format, dynamic_range, width, height, has_alpha, size_bytes, storage_path, role, display_name, source_job_id, provenance_id, created_at)
    VALUES (?, ?, 'image/png', 'PNG', 'PNG', 'LDR', ?, ?, 0, ?, ?, 'SOURCE', NULL, NULL, NULL, ?)`).run(id, sha, width, height, buf.length, rel, new Date().toISOString());
  return store.getAsset(id);
}

const fileOf = (store, id) => fs.readFileSync(store.files.resolveAssetPath(store.getAsset(id).storagePath));

function fakeProvider(output) {
  const snap = { providerId: 'fake-local', displayName: 'Fake (tests)', locality: 'IN_PROCESS', status: 'AVAILABLE', capabilities: ['TXT2IMG', 'SEED', 'NEGATIVE_PROMPT'], models: ['fake-model'], samplers: ['euler'], schedulers: ['normal'], vramTotalMb: 8151, engineVersion: 'fake-1' };
  return { providerId: 'fake-local', displayName: 'Fake (tests)', locality: 'IN_PROCESS', probe: async () => snap, generate: async (req) => ({ promptId: 'p', images: [output(req)] }), interrupt: async () => ({ queueDeleteAccepted: false, interruptAccepted: false }) };
}

// ── tests ──────────────────────────────────────────────────────────────────

test('background + scene reference: environment IMAGES (no camera, no geometry), normalised local source, metadata stripped, source untouched', { skip }, async () => {
  const { store, env } = setup();
  const src = source(store, png(320, 180, skyLike(320, 180), { extra: [chunk('tEXt', Buffer.from('prompt\u0000secret castle', 'latin1')), chunk('eXIf', EXIF_GPS)] }));
  const srcHash = hashFile(store.files.resolveAssetPath(src.storagePath));
  const bg = env.getEnvironment((await env.createBackground(src.id)).id);
  assert.deepEqual([bg.type, bg.projection, bg.asset.role, bg.asset.format, bg.asset.width, bg.asset.height], ['BACKGROUND', 'FLAT', 'DERIVED', 'PNG', 320, 180]);
  assert.deepEqual([bg.report.kind, bg.report.notA3dEnvironment, bg.report.camera, bg.report.geometry, bg.report.normalisedFrom, bg.report.metadata], ['ENVIRONMENT_IMAGE', true, null, null, src.id, 'STRIPPED']);
  assert.equal(bg.provenance.operation, 'CONVERT'); assert.deepEqual(bg.provenance.derivedFrom, [src.id]);
  const bytes = fileOf(store, bg.assetId);
  assert.equal(bytes.includes(Buffer.from('castle')) || bytes.includes(Buffer.from('GPSDATA')), false);
  const sr = env.getEnvironment((await env.createSceneReference(src.id)).id);
  assert.deepEqual([sr.type, sr.projection, sr.report.camera, sr.report.geometry], ['SCENE_REFERENCE', 'FLAT', null, null]);
  assert.equal(sr.assetId, bg.assetId, 'the same normalised image is reused');
  assert.deepEqual({ ...sr.claims }, { hdri: false, trueHdr: false, certifiedEquirectangular: false, cubemap: false, scene3d: false });
  assert.equal(hashFile(store.files.resolveAssetPath(src.storagePath)), srcHash);
});

test('panorama reference: 2:1 accepted, near-2:1 tolerated + labelled, bad ratio / too small refused, report fields, never certified', { skip }, async () => {
  const { store, env } = setup();
  const p = env.getEnvironment((await env.createPanorama(source(store, png(512, 256, skyLike(512, 256))).id)).id);
  assert.deepEqual([p.type, p.projection], ['PANORAMA_REFERENCE', 'PANORAMA_2_1_REFERENCE']);
  const r = p.report;
  assert.deepEqual([r.aspectRatio, r.ratio2to1Deviation, r.horizontalSeamStatus, r.classification, r.seamMethod], [2, 0, 'LOW_SEAM', 'PANORAMA_REFERENCE', 'EETF-SEAM v1']);
  assert.ok(r.horizontalSeamScore <= 2);
  assert.ok(r.poleRowDeviation.top <= 12 && r.poleRowDeviation.bottom <= 12, JSON.stringify(r.poleRowDeviation));
  assert.deepEqual(r.warnings, ['NOT_CERTIFIED_EQUIRECTANGULAR']);
  assert.deepEqual(p.labels, ['LOW_HORIZONTAL_SEAM_MEASURED', 'NOT_CERTIFIED_EQUIRECTANGULAR']);
  assert.equal(p.claims.certifiedEquirectangular, false);
  const withoutNegations = JSON.stringify(r).replaceAll('NOT_CERTIFIED_EQUIRECTANGULAR', '');
  assert.equal(/seamless|certified|"HDRI"|TRUE_HDR/i.test(withoutNegations), false, 'only the NOT_CERTIFIED label mentions certification');
  const near = env.getEnvironment((await env.createPanorama(source(store, png(512, 257, skyLike(512, 257))).id)).id);
  assert.ok(near.report.ratio2to1Deviation > 0 && near.report.ratio2to1Deviation <= 0.01);
  assert.ok(near.report.warnings.includes('NOT_EXACT_2_TO_1') && near.labels.includes('NOT_EXACT_2_TO_1'));
  await assert.rejects(env.createPanorama(source(store, png(512, 512, skyLike(512, 512))).id), code('EETF_PANORAMA_ASPECT'));
  await assert.rejects(env.createPanorama(source(store, png(520, 256, skyLike(520, 256))).id), code('EETF_PANORAMA_ASPECT'));
  await assert.rejects(env.createPanorama(source(store, png(256, 128, skyLike(256, 128))).id), code('EETF_PANORAMA_TOO_SMALL'));
});

test('panorama seams and poles: low vs high horizontal seam, non-uniform poles flagged, transparent vs opaque', { skip }, async () => {
  const { store, env } = setup();
  const high = env.getEnvironment((await env.createPanorama(source(store, png(512, 256, rampX(512))).id)).id);
  assert.equal(high.report.horizontalSeamStatus, 'HIGH_SEAM'); assert.ok(high.report.horizontalSeamScore >= 4);
  assert.ok(high.report.warnings.includes('HIGH_HORIZONTAL_SEAM') && high.report.warnings.includes('POLE_ROWS_NOT_UNIFORM'));
  assert.deepEqual([high.seamCheck, high.labels[0]], ['FAILED', 'HORIZONTAL_SEAM_NOT_LOW']);
  const transparent = env.getEnvironment((await env.createPanorama(source(store, png(512, 256, (x, y) => [...skyLike(512, 256)(x, y), 40 + ((x + y) % 200)], { alpha: true })).id)).id);
  assert.equal(transparent.report.alphaClass, 'SEMI_TRANSPARENT'); assert.ok(transparent.report.warnings.includes('HAS_TRANSPARENCY'));
  const opaque = env.getEnvironment((await env.createPanorama(source(store, png(512, 256, (x, y) => [...skyLike(512, 256)(x, y), 255], { alpha: true })).id)).id);
  assert.equal(opaque.report.alphaClass, 'OPAQUE'); assert.equal(opaque.report.warnings.includes('HAS_TRANSPARENCY'), false);
  const rgba = Buffer.alloc(8 * 4 * 4); for (let i = 0; i < 8; i++) rgba.set([200, 0, 0, 255], i * 4);
  assert.deepEqual(poleRowDeviation(rgba, 8, 4), { top: 0, bottom: 0 });
});

test('LDR / HDR: PNG panorama is LDR; LDR → EXR / HDR containers labelled; true HDR, HDRI, certified equirectangular, cubemap, 3D scene impossible', { skip }, async () => {
  const { store, derive, env } = setup();
  const src = source(store, png(512, 256, skyLike(512, 256)));
  const ldr = env.getEnvironment((await env.createPanorama(src.id)).id);
  assert.equal(ldr.dynamicRange, 'LDR');
  for (const format of ['EXR', 'HDR']) {
    const job = await derive.run(derive.submit({ sourceAssetId: src.id, operation: 'CONVERT', format }).id);
    assert.equal(job.status, 'COMPLETED');
    const e = env.getEnvironment((await env.createPanorama(job.outputAssetIds[0])).id);
    assert.deepEqual([e.asset.format, e.dynamicRange], [format, 'LDR_CONTENT_IN_HDR_CONTAINER']);
    assert.ok(e.labels.includes('LDR_CONTENT_IN_HDR_CONTAINER') && e.report.warnings.includes('LDR_CONTENT_IN_HDR_CONTAINER'));
    assert.deepEqual([e.claims.hdri, e.claims.trueHdr], [false, false]);
  }
  assert.throws(() => store.registerAsset({ buffer: fileOf(store, ldr.assetId), declaredMime: 'image/x-exr', role: 'SOURCE', contentDynamicRange: 'HDR' }), (e) => /MIME_MISMATCH|HDR_CONTENT_NOT_SUPPORTED/.test(e.code));
  for (const t of ['HDRI', 'CERTIFIED_EQUIRECTANGULAR', 'CUBEMAP', '3D_SCENE']) {
    assert.throws(() => env.create(t, src.id), code('EETF_ENVIRONMENT_TYPE_UNSUPPORTED'), t);
    assert.throws(() => store.createEnvironmentAsset({ assetId: ldr.assetId, type: t }), code('EETF_ENVIRONMENT_TYPE_UNSUPPORTED'));
  }
  const all = JSON.stringify(store.db.prepare('SELECT * FROM eetf_environment_reports').all());
  assert.equal(/"(hdri|trueHdr|certifiedEquirectangular|cubemap|scene3d)":true/.test(all), false);
  assert.equal(/TRUE_HDR|HDR_GENERATED/.test(all), false);
});

test('skybox preview: PREVIEW_ONLY parameters (not a scene camera), rendered view correct + deterministic, no cubemap, NaN / extreme refused', { skip }, async () => {
  const a = setup(); const b = setup();
  const buf = png(512, 256, skyLike(512, 256));
  const pa = await a.env.createPanorama(source(a.store, buf).id);
  const sky = a.env.getEnvironment((await a.env.createSkyboxPreview(pa.id, { yaw: 30, pitch: 10, fov: 90, width: 256, height: 144 })).id);
  assert.deepEqual([sky.type, sky.basedOnEnvironmentId, sky.assetId], ['SKYBOX_PREVIEW', pa.id, pa.assetId]);
  assert.ok(sky.labels.includes('PREVIEW_ONLY') && sky.labels.includes('NOT_CERTIFIED_EQUIRECTANGULAR'));
  assert.deepEqual([sky.report.previewOnly, sky.report.notASceneCamera, sky.report.notACubemap], [true, true, true]);
  assert.deepEqual({ ...sky.report.preview }, { yaw: 30, pitch: 10, fov: 90, width: 256, height: 144, mapping: 'EQUIRECTANGULAR_SPHERE_PREVIEW', renderer: 'eetf-skybox-view-1' });
  const view = a.store.getAsset(sky.report.previewAssetId);
  assert.deepEqual([view.role, view.actualFormat, view.width, view.height], ['DERIVED', 'PNG', 256, 144]);
  const vp = a.store.getProvenance(view.provenanceId);
  assert.deepEqual([vp.parameters.operation, vp.parameters.previewOnly, vp.derivedFrom[0]], ['SKYBOX_VIEW', true, pa.assetId]);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) AS n FROM eetf_assets WHERE width = height AND role = \'DERIVED\'').get().n, 0, 'no cube faces produced');
  // same parameters in another store → same bytes; other parameters → other bytes
  const pb = await b.env.createPanorama(source(b.store, buf).id);
  const skyB = b.env.getEnvironment((await b.env.createSkyboxPreview(pb.id, { yaw: 30, pitch: 10, fov: 90, width: 256, height: 144 })).id);
  assert.equal(b.store.getAsset(skyB.report.previewAssetId).sha256, view.sha256);
  const other = a.env.getEnvironment((await a.env.createSkyboxPreview(pa.id, { yaw: -60, pitch: 0, fov: 60, width: 256, height: 144 })).id);
  assert.notEqual(a.store.getAsset(other.report.previewAssetId).sha256, view.sha256);
  // geometry of the pure renderer: looking forward (yaw 0, pitch 0) the centre samples the panorama centre; yaw 180 the wrap
  const W = 64; const H = 32; const pano = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pano.set([x * 4, y * 8, 0, 255], (y * W + x) * 4);
  const c = (r) => { const i = ((r.height / 2) * r.width + r.width / 2) * 4; return [r.rgba[i], r.rgba[i + 1]]; };
  const fwd = c(renderSkyboxView(pano, W, H, { yaw: 0, pitch: 0, fov: 60, width: 32, height: 16 }));
  assert.ok(Math.abs(fwd[0] / 4 - W / 2) <= 1 && Math.abs(fwd[1] / 8 - H / 2) <= 1, `forward centre ${fwd}`);
  const back = c(renderSkyboxView(pano, W, H, { yaw: 180, pitch: 0, fov: 60, width: 32, height: 16 }));
  assert.ok(back[0] / 4 <= 1 || back[0] / 4 >= W - 2, `backward centre at the wrap ${back}`);
  const up = c(renderSkyboxView(pano, W, H, { yaw: 0, pitch: 80, fov: 60, width: 32, height: 16 }));
  assert.ok(up[1] / 8 < 4, 'pitch up looks at the top rows');
  for (const bad of [{ fov: Number.NaN }, { fov: Infinity }, { fov: 10 }, { fov: 170 }, { yaw: 400 }, { pitch: -95 }, { width: 5000 }, { height: 4 }, { yaw: '30' }]) {
    assert.throws(() => validatePreviewParams(bad), code('EETF_INVALID_PREVIEW'), JSON.stringify(bad));
    await assert.rejects(a.env.createSkyboxPreview(pa.id, bad), code('EETF_INVALID_PREVIEW'));
  }
  await assert.rejects(a.env.createSkyboxPreview((await a.env.createBackground(source(a.store, png(64, 48, skyLike(64, 48))).id)).id), code('EETF_INVALID_ENVIRONMENT'));
  const meta = a.env.getEnvironment((await a.env.createSkyboxPreview(pa.id, { yaw: 0 }, { renderView: false })).id);
  assert.deepEqual([meta.report.previewAssetId, meta.report.preview.renderer], [null, 'CLIENT_THREE_JS']);
  const again = encodePng(Buffer.alloc(8 * 8 * 4, 7), 8, 8, { alpha: false });
  assert.ok(again.equals(encodePng(Buffer.alloc(8 * 8 * 4, 7), 8, 8, { alpha: false })), 'PNG encoder deterministic');
});

test('fake-provider environment: GENERATED panorama used as is, provenance (provider / model / prompt / seed / dims / analysis); invalid outputs refused', { skip }, async () => {
  const { store, env } = setup();
  const registry = createProviderRegistry();
  registry.register(fakeProvider((req) => png(req.width, req.height, skyLike(req.width, req.height))));
  const gen = createEetfGenerationEngine({ store, registry, providerId: 'fake-local', pollIntervalMs: 10 });
  const job = await gen.run((await gen.submit({ prompt: 'alpine sky at dawn', width: 512, height: 256, target: 'ENVIRONMENT', environmentType: 'PANORAMA_REFERENCE', model: 'fake-model', seed: 42 })).id);
  assert.equal(job.status, 'COMPLETED', JSON.stringify(job.error));
  const e = env.getEnvironment((await env.createPanorama(job.outputAssetIds[0])).id);
  assert.deepEqual([e.asset.role, e.assetId, e.report.normalisedFrom], ['GENERATED', job.outputAssetIds[0], null]);
  assert.deepEqual([e.provenance.provider, e.provenance.model, e.provenance.prompt, e.provenance.seed, e.provenance.width, e.provenance.height, e.provenance.jobKind], ['fake-local', 'fake-model', 'alpine sky at dawn', 42, 512, 256, 'GENERATE']);
  assert.equal(e.provenance.parameters.environmentType, 'PANORAMA_REFERENCE');
  assert.ok(e.seamAnalysis && e.seamAnalysis.method === 'EETF-SEAM' && e.createdAt);
  await assert.rejects(gen.submit({ prompt: 'x', width: 512, height: 512, target: 'ENVIRONMENT', environmentType: 'PANORAMA_REFERENCE', model: 'fake-model' }), code('EETF_WORKFLOW_INVALID'), 'a panorama is requested at exactly 2:1');
  for (const out of [(req) => png(req.width / 2, req.height, skyLike(req.width / 2, req.height)), () => Buffer.from('<svg onload="alert(1)"/>'), () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])]) {
    const s2 = setup(); const r2 = createProviderRegistry(); r2.register(fakeProvider(out));
    const g2 = createEetfGenerationEngine({ store: s2.store, registry: r2, providerId: 'fake-local', pollIntervalMs: 10 });
    const bad = await g2.run((await g2.submit({ prompt: 'x', width: 512, height: 256, target: 'ENVIRONMENT', environmentType: 'PANORAMA_REFERENCE', model: 'fake-model' })).id);
    assert.deepEqual([bad.status, bad.error.code], ['FAILED', 'OUTPUT_INVALID']);
    assert.equal(s2.store.db.prepare("SELECT COUNT(*) AS n FROM eetf_assets WHERE role = 'GENERATED'").get().n, 0);
  }
});

test('dedup, immutability, reload / restart, resource limits, security (malformed, fake MIME, SVG, invalid EXR / HDR, huge 2:1, URLs, traversal)', { skip }, async () => {
  const s = setup();
  const src = source(s.store, png(512, 256, skyLike(512, 256)));
  const e1 = await s.env.createPanorama(src.id); const e2 = await s.env.createPanorama(src.id);
  assert.notEqual(e1.id, e2.id); assert.equal(e1.assetId, e2.assetId, 'normalised image reused');
  assert.equal(e1.report.seamAnalysisId, e2.report.seamAnalysisId, 'analysis stored once');
  const v1 = await s.env.createSkyboxPreview(e1.id, { yaw: 5 }); const v2 = await s.env.createSkyboxPreview(e2.id, { yaw: 5 });
  assert.equal(v1.report.previewAssetId, v2.report.previewAssetId, 'same view bytes → same asset');
  for (const sql of ["UPDATE eetf_environment_reports SET report_json = '{}'", 'DELETE FROM eetf_environment_reports', "UPDATE eetf_environment_assets SET env_type = 'BACKGROUND'"]) assert.throws(() => s.store.db.prepare(sql).run(), /EETF_IMMUTABLE/, sql);
  const before = s.env.getEnvironment(v1.id);
  s.store.close();
  const again = setup({ dir: s.dir });
  assert.deepEqual(again.env.getEnvironment(v1.id), before, 'identical after restart');
  const st = again.store; const ev = again.env;
  assert.throws(() => st.registerAsset({ buffer: png(512, 256, skyLike(512, 256)), declaredMime: 'image/jpeg', role: 'SOURCE' }), code('EETF_MIME_MISMATCH'));
  assert.throws(() => st.registerAsset({ buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_UNSUPPORTED_FORMAT'));
  const hugePano = png(1, 1, () => [1, 2, 3]); hugePano.writeUInt32BE(8192, 16); hugePano.writeUInt32BE(4096, 20);
  assert.throws(() => st.registerAsset({ buffer: hugePano, declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_IMAGE_TOO_LARGE'));
  const badExr = Buffer.alloc(64); badExr.writeUInt32LE(20000630, 0); badExr.writeUInt32LE(2, 4);
  assert.throws(() => st.registerAsset({ buffer: badExr, declaredMime: 'image/x-exr', role: 'SOURCE', contentDynamicRange: 'LDR' }), code('EETF_MALFORMED_IMAGE'));
  assert.throws(() => st.registerAsset({ buffer: Buffer.from('#?RADIANCE\n\nno resolution\n'), declaredMime: 'image/vnd.radiance', role: 'SOURCE', contentDynamicRange: 'LDR' }), code('EETF_MALFORMED_IMAGE'));
  const good = png(512, 256, skyLike(512, 256)); const corrupt = Buffer.from(good); for (let k = 40; k < corrupt.length - 20; k++) corrupt[k] ^= 0x5a;
  assert.throws(() => source(st, corrupt), code('EETF_MALFORMED_IMAGE'), 'refused at ingest (EETF-CERT)');
  await assert.rejects(ev.createPanorama(legacyCorruptAsset(st, corrupt, { width: 512, height: 256 }).id), code('EETF_TRANSCODE_FAILED'));
  for (const id of ['javascript:alert(1)', 'http://example.com/pano.png', 'https://evil.test/x.hdr', '../../etc/passwd', 'C:\\Windows\\x.png', '\\\\srv\\share\\x']) {
    await assert.rejects(ev.createPanorama(id), code('EETF_INVALID_ID'), id);
    await assert.rejects(ev.createBackground(id), code('EETF_INVALID_ID'));
  }
  const big = source(st, png(2048, 1024, skyLike(2048, 1024)));
  const bigEnv = ev.getEnvironment((await ev.createPanorama(big.id)).id);
  assert.deepEqual([bigEnv.asset.width, bigEnv.asset.height], [2048, 1024]);
  const tight = setup({ tempQuotaBytes: 4096 });
  await assert.rejects(tight.env.createPanorama(source(tight.store, png(512, 256, skyLike(512, 256))).id), code('EETF_TEMP_QUOTA'));
  assert.equal(fetchCalls, 0, 'URLs are never fetched');
});

test('isolation: no network, no process primitive in the environment module, user DB unchanged', () => {
  assert.equal(fetchCalls, 0);
  const src = fs.readFileSync(path.join(HERE, 'src', 'lib', 'eetf-environments.js'), 'utf8');
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.deepEqual(imports.sort(), ['./eetf-contracts.js', 'node:crypto', 'node:zlib']);
  // Three.js lives client-side (src/lib/eetf/skybox-preview.ts); only the 'CLIENT_THREE_JS' label string appears here
  assert.equal(/fetch\s*\(|child_process|spawn|comfyui/i.test(src.replace(/\/\/.*$/gm, '')), false);
  assert.deepEqual(REAL_DB_FILES.map(fileHash), realDbBefore, 'user database files byte-identical');
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'eetf')), false);
});
