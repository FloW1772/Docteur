// EETF-5 — textures + materials pipeline.
// Real FFmpeg (local fixtures only) through the EETF-3 engine with the real Root Policy decision,
// an in-process FAKE provider for the generated path (no ComfyUI, no model, no network), temporary
// store only. Global fetch is replaced by a counter; the user DB is hashed before / after.
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
import { createEetfMaterialPipeline, analyzeSeams, analyzeAlpha } from './src/lib/eetf-materials.js';
import { createProviderRegistry } from './src/lib/eetf-providers.js';
import { createEetfGenerationEngine } from './src/lib/eetf-generate.js';
import { enforce as realEnforce } from './src/lib/root-policy/index.js';
import * as C from './src/lib/eetf-contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf5-'));
const REAL_DB_FILES = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? hashFile(p) : 'absent');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-version'], { shell: false, windowsHide: true }).status === 0;
const skip = HAS_FFMPEG ? false : 'FFmpeg is not installed on this machine';
let realDbBefore; let fetchCalls = 0; const realFetch = globalThis.fetch;
const opened = [];

before(() => { realDbBefore = REAL_DB_FILES.map(fileHash); globalThis.fetch = async () => { fetchCalls++; throw new Error('no network in EETF-5 tests'); }; });
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
/** PNG from a pixel function (x, y) → [r, g, b] or [r, g, b, a]. */
function png(w, h, f, { alpha = false, extra = [] } = {}) {
  const ch = alpha ? 4 : 3; const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = f(x, y); for (let c = 0; c < ch; c++) raw[y * (w * ch + 1) + 1 + x * ch + c] = p[c]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const T = Math.PI * 2;
const periodic = (w, h) => (x, y) => [128 + Math.round(100 * Math.sin(T * x / w)), 128 + Math.round(100 * Math.cos(T * y / h)), 128 + Math.round(50 * Math.sin(T * (x / w + y / h)))];
const rampXY = (w, h) => (x, y) => [Math.round(255 * x / (w - 1)), Math.round(255 * y / (h - 1)), 128];
const rampX = (w) => (x) => [Math.round(255 * x / (w - 1)), 90, 40];
const rampY = (h) => (x, y) => [70, Math.round(255 * y / (h - 1)), 200];
const EXIF_GPS = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x0e, 0, 2, 0, 0, 0, 8, 0, 0, 0, 26, 0, 0, 0, 0, ...Buffer.from('GPSDATA'), 0]);

let n = 0;
function setup({ dir = null, ...deriveOpts } = {}) {
  const d = dir ?? path.join(TMP, `w${++n}`); fs.mkdirSync(d, { recursive: true });
  const store = EetfStore.open({ dbPath: path.join(d, 'eetf.sqlite'), assetRoot: path.join(d, 'root') });
  opened.push(store);
  const derive = createEetfDerivationEngine({ store, enforce: realEnforce, ...deriveOpts });
  return { store, derive, pipeline: createEetfMaterialPipeline({ store, derive }), dir: d };
}
const source = (store, buf) => store.registerAsset({ buffer: buf, declaredMime: 'image/png', role: 'SOURCE' }).asset;
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

const fileOf = (store, a) => fs.readFileSync(store.files.resolveAssetPath(a.storagePath));

/** In-process FAKE provider: TXT2IMG only (no SEAMLESS_TEXTURE), returns a PNG carrying ComfyUI-like metadata. */
function fakeProvider() {
  const snapshot = { providerId: 'fake-local', displayName: 'Fake (tests)', locality: 'IN_PROCESS', status: 'AVAILABLE', capabilities: ['TXT2IMG', 'SEED', 'NEGATIVE_PROMPT'], models: ['fake-model'], samplers: ['euler'], schedulers: ['normal'], vramTotalMb: 8151, engineVersion: 'fake-1' };
  return {
    providerId: 'fake-local', displayName: 'Fake (tests)', locality: 'IN_PROCESS',
    probe: async () => snapshot,
    generate: async (req) => ({ promptId: 'fake-prompt', images: [png(req.width, req.height, periodic(req.width, req.height), { extra: [chunk('tEXt', Buffer.from('prompt\u0000{"secret":"castle"}', 'latin1'))] })] }),
    interrupt: async () => ({ queueDeleteAccepted: false, interruptAccepted: false }),
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

test('material from a local image: DERIVED base colour (normalised, metadata stripped, sRGB assumed), USER constants, UNSUPPORTED maps, explained provenance', { skip }, async () => {
  const { store, pipeline } = setup();
  const meta = [chunk('tEXt', Buffer.from('prompt\u0000secret castle prompt', 'latin1')), chunk('eXIf', EXIF_GPS)];
  const src = source(store, png(64, 48, periodic(64, 48), { extra: meta }));
  const srcPath = store.files.resolveAssetPath(src.storagePath); const srcHash = hashFile(srcPath);
  const m = await pipeline.createMaterial({ name: 'Pierre', baseColorAssetId: src.id, roughness: { value: 0.7, reason: 'matte stone' }, metallic: { value: 0 } });
  assert.equal(m.status, 'PARTIAL_MATERIAL');
  assert.equal(m.baseColor.status, 'DERIVED');
  assert.notEqual(m.baseColor.source.assetId, src.id, 'the imported image is never used as-is nor called GENERATED');
  assert.deepEqual([m.baseColor.source.role, m.baseColor.source.format, m.baseColor.source.width, m.baseColor.source.height], ['DERIVED', 'PNG', 64, 48]);
  assert.deepEqual([m.baseColor.source.operation, m.baseColor.source.provider, m.baseColor.source.jobKind], ['CONVERT', 'ffmpeg', 'DERIVE']);
  assert.deepEqual(m.baseColor.source.derivedFrom, [src.id]); assert.match(m.baseColor.source.engineVersion, /\S/);
  assert.equal(m.baseColor.colorSpace, 'SRGB_ASSUMED_PROFILE_STRIPPED');
  const baseBytes = fileOf(store, store.getAsset(m.baseColor.source.assetId));
  assert.equal(baseBytes.includes(Buffer.from('castle')) || baseBytes.includes(Buffer.from('GPSDATA')), false, 'malicious metadata removed');
  assert.deepEqual([m.roughness.status, m.roughness.value, m.roughness.decidedBy, m.roughness.reason], ['USER_CONSTANT', 0.7, 'USER', 'matte stone']);
  assert.ok(m.roughness.decidedAt); assert.equal(m.roughness.source, undefined, 'a constant is not an image');
  assert.deepEqual([m.metallic.status, m.metallic.value, m.metallic.decidedBy], ['USER_CONSTANT', 0, 'USER']);
  for (const k of ['normal', 'height', 'ao', 'emissive', 'opacity']) assert.deepEqual([m[k].status, m[k].exists, m[k].source], ['UNSUPPORTED', false, undefined], k);
  assert.deepEqual({ ...m.claims }, { pbrComplete: false, seamless: false, seamlessTextureCapability: false });
  assert.ok(m.preview && m.preview.purpose === 'VISUAL_INSPECTION_ONLY');
  assert.deepEqual([m.preview.source.width, m.preview.source.height, m.preview.source.operation], [128, 96, 'TILE_PREVIEW']);
  assert.ok(m.baseColor.variants.some(v => v.operation === 'TILE_PREVIEW'));
  assert.equal(hashFile(srcPath), srcHash, 'source untouched');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM eetf_assets WHERE asset_id = ?').get(src.id).n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM eetf_assets WHERE width = 1 AND height = 1").get().n, 0, 'no 1×1 image for constants');
});

test('fake-provider path: GENERATED base colour used as is; SEAMLESS_TEXTURE is never available or claimed', { skip }, async () => {
  const { store, pipeline } = setup();
  const registry = createProviderRegistry();
  registry.register(fakeProvider());
  const gen = createEetfGenerationEngine({ store, registry, providerId: 'fake-local', pollIntervalMs: 10 });
  const snap = await registry.refresh('fake-local');
  assert.equal(snap.capabilities.includes('SEAMLESS_TEXTURE'), false);
  const job = await gen.run((await gen.submit({ prompt: 'mossy stone', width: 64, height: 64, target: 'TEXTURE', textureRole: 'BASE_COLOR', model: 'fake-model', seed: 5 })).id);
  assert.equal(job.status, 'COMPLETED', JSON.stringify(job.error));
  const generated = store.getAsset(job.outputAssetIds[0]);
  assert.equal(generated.role, 'GENERATED');
  const m = await pipeline.createMaterial({ name: 'Mousse', baseColorAssetId: generated.id, roughness: { value: 0.9 } });
  assert.deepEqual([m.baseColor.status, m.baseColor.source.assetId, m.baseColor.source.provider, m.baseColor.source.model], ['GENERATED', generated.id, 'fake-local', 'fake-model']);
  assert.equal(fileOf(store, generated).includes(Buffer.from('castle')), false);
  assert.equal(m.claims.seamlessTextureCapability, false);
  assert.ok(['LOW_SEAM', 'MEASURED', 'HIGH_SEAM'].includes(m.baseColor.tile.status));
});

test('opacity: FROM_SOURCE_ALPHA only for measured transparency (semi / cutout / fully transparent); opaque or no channel → UNSUPPORTED', { skip }, async () => {
  const { store, pipeline } = setup();
  const cases = [
    ['SEMI_TRANSPARENT', png(32, 32, (x, y) => [200, 100, 50, 1 + ((x * 7 + y * 3) % 254)], { alpha: true }), true],
    ['BINARY_CUTOUT', png(32, 32, (x, y) => [10, 20, 30, (x + y) % 2 ? 255 : 0], { alpha: true }), true],
    ['FULLY_TRANSPARENT', png(32, 32, () => [9, 9, 9, 0], { alpha: true }), true],
    ['OPAQUE', png(32, 32, (x, y) => [x * 4, y * 4, 90, 255], { alpha: true }), false],
    ['NO_ALPHA_CHANNEL', png(32, 32, (x, y) => [x * 3, y * 3, 60]), false],
  ];
  for (const [cls, buf, allowed] of cases) {
    const a = source(store, buf);
    if (allowed) {
      const m = await pipeline.createMaterial({ name: cls, baseColorAssetId: a.id, opacity: 'FROM_SOURCE_ALPHA', preview: false });
      assert.deepEqual([m.opacity.status, m.opacity.channel, m.opacity.source.assetId], ['FROM_SOURCE_ALPHA', 'ALPHA_OF_BASE_COLOR', m.baseColor.source.assetId], cls);
      assert.equal(m.baseColor.alpha.alphaClass, cls);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM eetf_assets WHERE role = 'DERIVED' AND asset_id = ?").get(m.opacity.source.assetId).n, 1, 'no separate opacity file');
    } else {
      await assert.rejects(pipeline.createMaterial({ name: cls, baseColorAssetId: a.id, opacity: 'FROM_SOURCE_ALPHA', preview: false }), code('EETF_NO_SOURCE_ALPHA'), cls);
      const m = await pipeline.createMaterial({ name: `${cls}-ok`, baseColorAssetId: a.id, preview: false });
      assert.equal(m.opacity.status, 'UNSUPPORTED');
      assert.equal(m.baseColor.alpha.alphaClass, cls);
    }
  }
  assert.equal(analyzeAlpha(Buffer.from([1, 2, 3, 128, 4, 5, 6, 255]), true).alphaClass, 'SEMI_TRANSPARENT');
});

test('PBR_COMPLETE is unreachable: every combination of the V1 table, forbidden options, raw DB insert', { skip }, async () => {
  const roles = C.TEXTURE_ROLES;
  let combos = 0;
  const walk = (i, acc) => {
    if (i === roles.length) { combos++; assert.notEqual(C.materialBadge(acc), 'PBR_COMPLETE', JSON.stringify(acc)); return; }
    for (const status of C.MAP_STATUS_ALLOWED_V1[roles[i]]) walk(i + 1, [...acc, { role: roles[i], status }]);
  };
  walk(0, []);
  assert.equal(combos, 4 * 1 * 2 * 2 * 1 * 1 * 2 * 1);
  for (const r of ['NORMAL', 'HEIGHT', 'AMBIENT_OCCLUSION', 'EMISSIVE']) assert.deepEqual(C.MAP_STATUS_ALLOWED_V1[r], ['UNSUPPORTED'], r);
  const { store, pipeline } = setup();
  const a = source(store, png(16, 16, periodic(16, 16)));
  for (const opt of [{ normal: { status: 'GENERATED' } }, { height: 1 }, { ambientOcclusion: true }, { emissive: [1, 1, 1] }]) {
    await assert.rejects(pipeline.createMaterial({ name: 'x', baseColorAssetId: a.id, ...opt }), code('EETF_MAP_STATUS_NOT_SUPPORTED_V1'), JSON.stringify(opt));
  }
  await pipeline.createMaterial({ name: 'ok', baseColorAssetId: a.id, preview: false });
  const freeSet = store.createTextureSet({ name: 'raw' });
  assert.throws(() => store.db.prepare("INSERT INTO eetf_materials (material_id, texture_set_id, name, status, color_space, created_at) VALUES (?, ?, 'x', 'PBR_COMPLETE', 'x', 'now')").run(crypto.randomUUID(), freeSet.id), /CHECK constraint failed/, 'the database itself refuses the status');
  const json = JSON.stringify(store.db.prepare('SELECT * FROM eetf_materials').all()) + JSON.stringify(store.db.prepare('SELECT * FROM eetf_texture_sets').all());
  assert.equal(json.includes('PBR_COMPLETE'), false);
});

test('seam analysis: periodic fixture LOW_SEAM, obvious seam HIGH_SEAM, horizontal-only, vertical-only; never "seamless"', { skip }, async () => {
  const { store, pipeline } = setup();
  const w = 64; const h = 48;
  const fixtures = {
    periodic: png(w, h, periodic(w, h)), obvious: png(w, h, rampXY(w, h)), horizontalOnly: png(w, h, rampX(w)), verticalOnly: png(w, h, rampY(h)),
  };
  const r = {};
  for (const [k, buf] of Object.entries(fixtures)) r[k] = await pipeline.analyze(source(store, buf).id);
  assert.equal(r.periodic.status, 'LOW_SEAM'); assert.ok(r.periodic.seamScore <= 2, JSON.stringify(r.periodic));
  // a smooth periodic signal has its steepest step right at the wrap, so the ratio sits a little above 1 — still a neighbour-like step
  assert.ok(r.periodic.horizontalScore <= 2 && r.periodic.verticalScore <= 2, 'the wrap edges look like neighbour pairs');
  assert.equal(r.obvious.status, 'HIGH_SEAM'); assert.ok(r.obvious.horizontalScore >= 4 && r.obvious.verticalScore >= 4);
  assert.equal(r.horizontalOnly.status, 'HIGH_SEAM'); assert.ok(r.horizontalOnly.horizontalScore >= 4); assert.equal(r.horizontalOnly.verticalScore, 0);
  assert.equal(r.verticalOnly.status, 'HIGH_SEAM'); assert.ok(r.verticalOnly.verticalScore >= 4); assert.equal(r.verticalOnly.horizontalScore, 0);
  for (const a of Object.values(r)) { assert.deepEqual([a.method, a.version], ['EETF-SEAM', 1]); assert.equal(/seamless/i.test(JSON.stringify(a)), false); }
  // pure function on the same pixels = the stored scores (the FFmpeg decode of a PNG is exact)
  const px = (() => { const out = Buffer.alloc(w * h * 4); const f = rampXY(w, h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = f(x, y); out.set([p[0], p[1], p[2], 255], (y * w + x) * 4); } return out; })();
  const pure = analyzeSeams(px, w, h);
  assert.deepEqual([pure.horizontalScore, pure.verticalScore, pure.seamScore], [r.obvious.horizontalScore, r.obvious.verticalScore, r.obvious.seamScore]);
  assert.throws(() => analyzeSeams(Buffer.alloc(10), 4, 4), code('EETF_INVALID_ANALYSIS'));
});

test('determinism + dedup: same asset → same scores (stored once), same preview bytes across stores, base colour reused', { skip }, async () => {
  const buf = png(64, 48, periodic(64, 48));
  const a = setup(); const b = setup();
  const sa = source(a.store, buf); const sb = source(b.store, buf);
  const r1 = await a.pipeline.analyze(sa.id); const r2 = await a.pipeline.analyze(sa.id);
  assert.equal(r1.id, r2.id, 'stored once');
  const rb = await b.pipeline.analyze(sb.id);
  assert.deepEqual([rb.horizontalScore, rb.verticalScore, rb.seamScore, rb.status], [r1.horizontalScore, r1.verticalScore, r1.seamScore, r1.status]);
  const pa = await a.pipeline.tilingPreview(sa.id, { grid: 3, maxSide: 300 });
  const pb = await b.pipeline.tilingPreview(sb.id, { grid: 3, maxSide: 300 });
  assert.equal(pa.sha256, pb.sha256, 'preview bytes identical on the same toolchain');
  const m1 = await a.pipeline.createMaterial({ name: 'one', baseColorAssetId: sa.id });
  const m2 = await a.pipeline.createMaterial({ name: 'two', baseColorAssetId: sa.id });
  assert.notEqual(m1.materialId, m2.materialId);
  assert.equal(m1.baseColor.source.assetId, m2.baseColor.source.assetId, 'normalised base colour reused (content-addressed)');
  assert.equal(m1.preview.assetId, m2.preview.assetId);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) AS n FROM eetf_seam_analyses').get().n, 2, 'source + normalised base colour');
});

test('tiling preview: exact repetition (pixels), downscaled to the budget, never upscaled, source unchanged, budget refusals', { skip }, async () => {
  const { store, derive, pipeline } = setup();
  const src = source(store, png(64, 48, rampXY(64, 48)));
  const srcHash = hashFile(store.files.resolveAssetPath(src.storagePath));
  const p3 = await pipeline.tilingPreview(src.id, { grid: 3, maxSide: 300 });
  assert.deepEqual([p3.width, p3.height, p3.role], [192, 144, 'DERIVED'], 'tile kept at 64×48 (no upscale), 3 × 3');
  const s = await derive.decodeRgba(src.id); const t = await derive.decodeRgba(p3.id);
  for (const [ty, tx] of [[0, 0], [1, 2], [2, 1]]) for (const [x, y] of [[0, 0], [63, 47], [10, 20]]) {
    const a = (y * 64 + x) * 4; const b = ((ty * 48 + y) * 192 + tx * 64 + x) * 4;
    assert.ok(s.rgba.subarray(a, a + 4).equals(t.rgba.subarray(b, b + 4)), `tile ${tx},${ty} pixel ${x},${y}`);
  }
  const p2 = await pipeline.tilingPreview(src.id, { grid: 2, maxSide: 64 });
  assert.deepEqual([p2.width, p2.height], [64, 48], 'tile downscaled to 32×24 so the preview fits 64 px');
  const big = source(store, png(2048, 1024, (x, y) => [x & 255, y & 255, 7]));
  const pb = await pipeline.tilingPreview(big.id, { grid: 2, maxSide: 1024 });
  assert.deepEqual([pb.width, pb.height], [1024, 512]);
  await assert.rejects(pipeline.tilingPreview(src.id, { grid: 3, maxSide: 5000 }), code('EETF_INVALID_NUMBER'));
  await assert.rejects(pipeline.tilingPreview(src.id, { grid: 4 }), code('EETF_INVALID_NUMBER'));
  assert.equal(hashFile(store.files.resolveAssetPath(src.storagePath)), srcHash);
});

test('immutability, reload / restart, invalid constants and statuses, malformed / fake / oversized inputs, resource limits', { skip }, async () => {
  const env = setup();
  const { store, pipeline } = env;
  const a = source(store, png(32, 32, periodic(32, 32)));
  const m = await pipeline.createMaterial({ name: 'Immuable', baseColorAssetId: a.id, roughness: { value: 0.25, reason: 'polished' }, metallic: { value: 1 } });
  for (const sql of ["UPDATE eetf_materials SET name = 'x'", 'DELETE FROM eetf_materials', "UPDATE eetf_map_decisions SET reason = 'x'", 'UPDATE eetf_seam_analyses SET seam_score = 0', "UPDATE eetf_texture_maps SET status = 'UNSUPPORTED'"]) {
    assert.throws(() => store.db.prepare(sql).run(), /EETF_IMMUTABLE/, sql);
  }
  // reload in a new connection
  store.close();
  const again = setup({ dir: env.dir });
  assert.deepEqual(again.pipeline.getMaterial(m.materialId), m, 'identical after restart');
  const p = again.pipeline;
  for (const bad of [{ value: Number.NaN }, { value: Infinity }, { value: -0.01 }, { value: 1.01 }, { value: '0.5' }, {}, [0.5], 0.5]) {
    await assert.rejects(p.createMaterial({ name: 'x', baseColorAssetId: a.id, roughness: bad }), code('EETF_INVALID_CONSTANT'), JSON.stringify(bad));
    await assert.rejects(p.createMaterial({ name: 'x', baseColorAssetId: a.id, metallic: bad }), code('EETF_INVALID_CONSTANT'));
  }
  await assert.rejects(p.createMaterial({ name: 'x', baseColorAssetId: a.id, opacity: 'MAGIC' }), code('EETF_INVALID_PARAMS'));
  await assert.rejects(p.createMaterial({ name: 'x', baseColorAssetId: '../../etc/passwd' }), code('EETF_INVALID_ID'));
  const s2 = again.store;
  assert.throws(() => s2.createMaterialRecord({ name: 'x', maps: [{ role: 'ROUGHNESS', status: 'USER_CONSTANT', constantValue: 0.5 }], colorSpace: 'x' }), code('EETF_DECISION_REQUIRED'));
  assert.throws(() => s2.createMaterialRecord({ name: 'x', maps: [{ role: 'BASE_COLOR', status: 'GENERATED', assetId: a.id }], colorSpace: 'x' }), code('EETF_MAP_ORIGIN_MISMATCH'), 'false GENERATED map');
  assert.throws(() => s2.createMaterialRecord({ name: 'x', maps: [{ role: 'SPECULAR', status: 'DERIVED', assetId: a.id }], colorSpace: 'x' }), code('EETF_UNKNOWN_TEXTURE_ROLE'));
  assert.throws(() => s2.createMaterialRecord({ name: 'x', maps: [{ role: 'ROUGHNESS', status: 'ESTIMATED', assetId: a.id }], colorSpace: 'x' }), code('EETF_MAP_STATUS_NOT_SUPPORTED_V1'));
  assert.throws(() => s2.registerAsset({ buffer: png(8, 8, periodic(8, 8)), declaredMime: 'image/jpeg', role: 'SOURCE' }), code('EETF_MIME_MISMATCH'));
  const bomb = png(1, 1, () => [1, 2, 3]); bomb.writeUInt32BE(100_000, 16); bomb.writeUInt32BE(100_000, 20);
  assert.throws(() => s2.registerAsset({ buffer: bomb, declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_IMAGE_TOO_LARGE'));
  const good = png(16, 16, periodic(16, 16)); const corrupt = Buffer.from(good); for (let k = 40; k < corrupt.length - 20; k++) corrupt[k] ^= 0x5a;
  assert.throws(() => source(s2, corrupt), code('EETF_MALFORMED_IMAGE'), 'refused at ingest (EETF-CERT)');
  const c = legacyCorruptAsset(s2, corrupt, { width: 16, height: 16 });
  const before = s2.db.prepare('SELECT COUNT(*) AS n FROM eetf_materials').get().n;
  await assert.rejects(p.createMaterial({ name: 'broken', baseColorAssetId: c.id }), code('EETF_TRANSCODE_FAILED'));
  assert.equal(s2.db.prepare('SELECT COUNT(*) AS n FROM eetf_materials').get().n, before, 'nothing created for a malformed image');
  // resource limits: the derivation guards also apply to previews / normalisation
  const tight = setup({ tempQuotaBytes: 4096 });
  await assert.rejects(tight.pipeline.createMaterial({ name: 'q', baseColorAssetId: source(tight.store, png(64, 64, periodic(64, 64))).id }), code('EETF_TEMP_QUOTA'));
  const busy = setup();
  const b1 = source(busy.store, png(16, 16, periodic(16, 16)));
  const first = busy.derive.decodeRgba(b1.id);
  await assert.rejects(busy.derive.decodeRgba(b1.id), code('EETF_ENGINE_BUSY'), 'one FFmpeg process at a time');
  await first;
});

test('isolation: no network, no provider / model execution beyond the in-process fake, user DB unchanged', { skip }, () => {
  assert.equal(fetchCalls, 0);
  const src = fs.readFileSync(path.join(HERE, 'src', 'lib', 'eetf-materials.js'), 'utf8');
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.deepEqual(imports, ['./eetf-contracts.js'], 'the pipeline itself has no I/O dependency (store / engines are injected)');
  assert.equal(/fetch\s*\(|child_process|spawn|comfyui/i.test(src.replace(/\/\/.*$/gm, '')), false);
  assert.deepEqual(REAL_DB_FILES.map(fileHash), realDbBefore, 'user database files byte-identical');
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'eetf')), false);
});
