// EETF-8 — product integrations (Media Studio, Media Reader, Neurone) at the HTTP + service level.
// Temporary EETF store, temporary Neurone image folder (never cortex-server/data/images), in-memory SQLite for the
// Media Studio, real FFmpeg, real Root Policy decisions, ComfyUI unavailable (closed port). Outgoing fetch counted.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { EetfStore } from './src/lib/eetf-store.js';
import { hashFile } from './src/lib/eetf-asset-store.js';
import { runEetfMigrations, eetfSchemaVersion, EETF_MIGRATIONS, assertAdditiveSql } from './src/lib/eetf-schema.js';
import { createEetfRoute, createEetfRouteFromBoot, createEetfServices } from './src/routes/eetf.js';
import { createComfyUiProvider } from './src/lib/eetf-comfyui-provider.js';
import { enforce } from './src/lib/root-policy/index.js';
import { initSqlite } from './src/lib/sqlite.js';
import { createMediaStudioService, uploadSource } from './src/lib/media-studio.js';
import { createMediaStudioStore } from './src/lib/media-studio-store.js';
import { createMediaStudioRoute } from './src/routes/media-studio.js';

initSqlite(':memory:');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf8-int-'));
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const REAL_IMAGES = path.join(HERE, 'data', 'images');
const fileHash = (p) => (fs.existsSync(p) ? hashFile(p) : 'absent');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-version'], { shell: false, windowsHide: true }).status === 0;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let realDbBefore; let realImagesBefore; let store; let api; let services;
const fetchCalls = [];
const realFetch = globalThis.fetch;

function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); }
function png(w, h, seed = 1, f = null) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = f ? f(x, y) : [(x * 5 + y * 3 + seed * 11) & 0xff, (x * 3 + seed) & 0xff, (y * 7 + seed * 5) & 0xff];
    for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = p[c];
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A PNG whose header announces huge dimensions (budget check happens before any decode). */
function hugeHeaderPng(w, h) { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]); }
const T = Math.PI * 2;
const sky = (w, h) => (x, y) => [128 + Math.round(100 * Math.sin(T * x / w)), 50 + Math.round(150 * y / h), 128 + Math.round(60 * Math.cos(T * x / w))];

// ── temporary Neurone image store (same id rule as lib/image.js) ──
const IMAGES = path.join(TMP, 'images');
fs.mkdirSync(IMAGES, { recursive: true });
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$/i;
const resolveNeuronImage = (id) => (ID_RE.test(id) ? path.join(IMAGES, id) : null);
const neuronImage = (buf, ext = 'png') => { const id = `${crypto.randomUUID()}.${ext}`; fs.writeFileSync(path.join(IMAGES, id), buf); return id; };

const J = async (res) => ({ status: res.status, body: await res.json() });
const post = (p, data) => api.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
const clean = (b) => { const s = JSON.stringify(b); assert.equal(/\bat [\w.<>]+ \(|[A-Za-z]:\\|\/Users\/|\/tmp\/|SELECT |sqlite|stack|eetf8-int-/i.test(s), false, `no internals: ${s.slice(0, 200)}`); };
const assetFiles = () => { const dir = path.join(TMP, 'root', 'assets'); const out = []; if (!fs.existsSync(dir)) return out; for (const d of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, d))) out.push(f); return out; };

before(async () => {
  realDbBefore = REAL_DB.map(fileHash);
  realImagesBefore = fs.existsSync(REAL_IMAGES) ? fs.readdirSync(REAL_IMAGES).length : -1;
  globalThis.fetch = (...args) => { fetchCalls.push(String(args[0])); return realFetch(...args); };
  const closed = http.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const port = closed.address().port; await new Promise(r => closed.close(r));
  store = EetfStore.open({ dbPath: path.join(TMP, 'eetf.sqlite'), assetRoot: path.join(TMP, 'root') });
  services = createEetfServices({ store, enforce, resolveNeuronImage, providers: [createComfyUiProvider({ endpoint: `http://127.0.0.1:${port}`, enforce, probeTimeoutMs: 600 })] });
  api = createEetfRoute(services);
});
after(() => {
  globalThis.fetch = realFetch;
  store?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

test('schema v4: one additive immutable table (eetf_asset_links), idempotent, foreign tables untouched', () => {
  for (const m of EETF_MIGRATIONS) assert.doesNotThrow(() => assertAdditiveSql(m.sql));
  const db = new Database(':memory:');
  db.exec("CREATE TABLE pages (id TEXT PRIMARY KEY); INSERT INTO pages VALUES ('p');");
  assert.deepEqual(runEetfMigrations(db).applied, [1, 2, 3, 4]);
  assert.deepEqual(runEetfMigrations(db).applied, []);
  assert.equal(eetfSchemaVersion(db), 4);
  const cols = db.prepare("SELECT name FROM pragma_table_info('eetf_asset_links')").all().map(r => r.name);
  assert.deepEqual(cols, ['link_id', 'asset_id', 'direction', 'system', 'external_key', 'external_ref_json', 'content_sha256', 'verification', 'created_at']);
  assert.deepEqual(db.prepare('SELECT * FROM pages').all(), [{ id: 'p' }]);
  assert.equal(store.schemaVersion(), 4);
  db.close();
});

test('Neurone image → EETF: read by the server, content-addressed, one copy for the same bytes, links per origin, source unchanged', async () => {
  const bytes = png(64, 64, 3);
  const a = neuronImage(bytes); const b = neuronImage(bytes); // same content, two Neurone images
  const before = fs.statSync(path.join(IMAGES, a));
  const filesBefore = assetFiles().length;
  const r1 = await services.integrations.importNeuronImage({ imageId: a });
  assert.deepEqual([r1.existed, r1.asset.role, r1.asset.actualFormat, r1.asset.sha256, r1.link.verification, r1.link.direction], [false, 'SOURCE', 'PNG', sha(bytes), 'SERVER_RESOLVED', 'IMPORT']);
  const r1b = await services.integrations.importNeuronImage({ imageId: a });
  assert.deepEqual([r1b.existed, r1b.linkExisted, r1b.asset.id], [true, true, r1.asset.id], 'same origin twice: nothing new');
  const r2 = await services.integrations.importNeuronImage({ imageId: b.toUpperCase() });
  assert.deepEqual([r2.existed, r2.linkExisted, r2.asset.id], [true, false, r1.asset.id], 'same bytes from another origin: same asset, new link');
  assert.equal(assetFiles().length, filesBefore + 1, 'one physical copy');
  assert.equal(store.listAssetLinks(r1.asset.id).length, 2);
  const after = fs.statSync(path.join(IMAGES, a));
  assert.deepEqual([sha(fs.readFileSync(path.join(IMAGES, a))), after.mtimeMs, after.size], [sha(bytes), before.mtimeMs, before.size], 'Neurone source not modified');
  assert.throws(() => store.db.prepare('UPDATE eetf_asset_links SET system = ?').run('MEDIA_STUDIO'), /EETF_IMMUTABLE/);
  assert.throws(() => store.db.prepare('DELETE FROM eetf_asset_links').run(), /EETF_IMMUTABLE/);
});

test('Neurone import refusals: traversal / malformed ids, missing / deleted source, GIF, fake MIME, corrupt, pixel limit — stable codes, nothing stored', async () => {
  const count = () => store.listAssets({ limit: 200 }).length;
  const n0 = count();
  for (const imageId of ['../../cortex.sqlite', '..\\..\\x.png', 'C:\\Windows\\win.ini', '/etc/passwd', 'file:///c:/x.png', 'javascript:alert(1)', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png/../x', `${crypto.randomUUID()}.svg`, `${crypto.randomUUID()}.png%00.jpg`, '', 42, null]) {
    const r = await J(await post('/imports/neuron-image', { imageId }));
    assert.deepEqual([r.status, r.body.error_code], [400, 'INVALID_ID'], String(imageId)); clean(r.body);
  }
  const unknown = await J(await post('/imports/neuron-image', { imageId: `${crypto.randomUUID()}.png` }));
  assert.deepEqual([unknown.status, unknown.body.error_code], [404, 'SOURCE_UNAVAILABLE']); clean(unknown.body);
  const deleted = neuronImage(png(16, 16, 9)); fs.rmSync(path.join(IMAGES, deleted));
  assert.equal((await J(await post('/imports/neuron-image', { imageId: deleted }))).body.error_code, 'SOURCE_UNAVAILABLE');
  const gif = neuronImage(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), 'gif');
  assert.deepEqual(Object.values(await J(await post('/imports/neuron-image', { imageId: gif }))).map(v => v.error_code ?? v), [415, 'UNSUPPORTED_MEDIA']);
  const html = neuronImage(Buffer.from('<html><script>alert(1)</script></html>'));
  const h = await J(await post('/imports/neuron-image', { imageId: html }));
  assert.deepEqual([h.status, h.body.error_code], [415, 'UNSUPPORTED_MEDIA'], 'fake MIME (HTML named .png)'); clean(h.body);
  const jpegAsPng = neuronImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]));
  assert.equal((await J(await post('/imports/neuron-image', { imageId: jpegAsPng }))).body.error_code, 'UNSUPPORTED_MEDIA', 'extension never trusted');
  const corrupt = neuronImage(png(32, 32, 4).subarray(0, 40));
  assert.equal((await J(await post('/imports/neuron-image', { imageId: corrupt }))).body.error_code, 'UNSUPPORTED_MEDIA');
  const huge = neuronImage(hugeHeaderPng(20000, 20000));
  const hz = await J(await post('/imports/neuron-image', { imageId: huge }));
  assert.deepEqual([hz.status, hz.body.error_code], [413, 'PIXEL_LIMIT']);
  assert.equal(count(), n0, 'nothing stored');
  const notJson = await J(await api.request('/imports/neuron-image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' }));
  assert.equal(notJson.body.error_code, 'INVALID_PARAMS');
});

test('Media Studio → EETF (HTTP): bytes bound to the studio SHA-256, hostile name sanitised, fake MIME / mismatch / oversize refused', async () => {
  const bytes = png(48, 48, 21);
  const projectId = crypto.randomUUID(); const mediaAssetId = crypto.randomUUID();
  const q = (o) => `/imports/media-studio?${new URLSearchParams(o).toString()}`;
  const ok = await J(await api.request(q({ projectId, mediaAssetId, sha256: sha(bytes), name: '../../<img src=x onerror=alert(1)>pierre.png' }), { method: 'POST', headers: { 'content-type': 'image/png' }, body: bytes }));
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.asset.role, ok.body.link.system, ok.body.link.verification, ok.body.link.ref.projectId], ['SOURCE', 'MEDIA_STUDIO', 'CONTENT_SHA256_MATCH', projectId]);
  assert.equal(/[\\/<>]/.test(ok.body.asset.displayName), false, `display name: ${ok.body.asset.displayName}`);
  const again = await J(await api.request(q({ projectId, mediaAssetId, sha256: sha(bytes) }), { method: 'POST', headers: { 'content-type': 'image/png' }, body: bytes }));
  assert.deepEqual([again.status, again.body.existed, again.body.linkExisted, again.body.asset.id], [200, true, true, ok.body.asset.id]);
  const n0 = store.listAssets({ limit: 200 }).length;
  const other = png(48, 48, 22);
  const mismatch = await J(await api.request(q({ projectId, mediaAssetId, sha256: sha(bytes) }), { method: 'POST', headers: { 'content-type': 'image/png' }, body: other }));
  assert.deepEqual([mismatch.status, mismatch.body.error_code], [400, 'INVALID_SOURCE']); clean(mismatch.body);
  const html = Buffer.from('<svg onload=alert(1)>');
  const fake = await J(await api.request(q({ projectId, mediaAssetId, sha256: sha(html) }), { method: 'POST', headers: { 'content-type': 'image/png' }, body: html }));
  assert.deepEqual([fake.status, fake.body.error_code], [415, 'UNSUPPORTED_MEDIA']);
  const noSha = await J(await api.request(q({ projectId, mediaAssetId }), { method: 'POST', headers: { 'content-type': 'image/png' }, body: bytes }));
  assert.equal(noSha.body.error_code, 'INVALID_SOURCE');
  const badIds = await J(await api.request(q({ projectId: '../x', mediaAssetId, sha256: sha(bytes) }), { method: 'POST', headers: { 'content-type': 'image/png' }, body: bytes }));
  assert.equal(badIds.body.error_code, 'INVALID_ID');
  const big = await J(await api.request(q({ projectId, mediaAssetId, sha256: sha(bytes) }), { method: 'POST', headers: { 'content-type': 'image/png', 'content-length': String(65 * 1024 * 1024) }, body: bytes }));
  assert.deepEqual([big.status, big.body.error_code], [413, 'FILE_TOO_LARGE']);
  assert.equal(store.listAssets({ limit: 200 }).length, n0, 'refusals store nothing');
});

test('exports: Neurone copy re-read by the server (byte-identical or refused), Media Studio copy bound by hash; reverse lookup', async () => {
  const bytes = png(40, 40, 31);
  const asset = store.registerAsset({ buffer: bytes, declaredMime: 'image/png', role: 'SOURCE', displayName: 'export.png' }).asset;
  const copy = neuronImage(bytes);
  const r = await J(await post(`/assets/${asset.id}/exports`, { system: 'NEURON_IMAGE', ref: { imageId: copy } }));
  assert.deepEqual([r.status, r.body.link.direction, r.body.link.verification], [201, 'EXPORT', 'SERVER_RESOLVED']);
  const altered = neuronImage(png(40, 40, 32));
  assert.equal((await J(await post(`/assets/${asset.id}/exports`, { system: 'NEURON_IMAGE', ref: { imageId: altered } }))).body.error_code, 'INVALID_SOURCE');
  assert.equal((await J(await post(`/assets/${asset.id}/exports`, { system: 'NEURON_IMAGE', ref: { imageId: `${crypto.randomUUID()}.png` } }))).body.error_code, 'SOURCE_UNAVAILABLE');
  const ms = { projectId: crypto.randomUUID(), mediaAssetId: crypto.randomUUID() };
  assert.equal((await J(await post(`/assets/${asset.id}/exports`, { system: 'MEDIA_STUDIO', ref: ms, sha256: sha(Buffer.from('x')) }))).body.error_code, 'INVALID_SOURCE');
  assert.equal((await J(await post(`/assets/${asset.id}/exports`, { system: 'MEDIA_STUDIO', ref: ms, sha256: asset.sha256 }))).status, 201);
  assert.equal((await J(await post(`/assets/${asset.id}/exports`, { system: 'MEDIA_STUDIO', ref: { ...ms, path: 'C:\\x' }, sha256: asset.sha256 }))).body.error_code, 'UNKNOWN_FIELD');
  assert.equal((await J(await post(`/assets/${asset.id}/exports`, { system: 'NOTEBOOK', ref: {} }))).body.error_code, 'INVALID_LINK', 'no Notebook / KG link exists');
  assert.equal((await J(await post(`/assets/${crypto.randomUUID()}/exports`, { system: 'MEDIA_STUDIO', ref: ms, sha256: asset.sha256 }))).status, 404);
  const links = await J(await api.request(`/links?system=NEURON_IMAGE&imageId=${copy}`));
  assert.deepEqual(links.body.links.map(l => [l.assetId, l.direction]), [[asset.id, 'EXPORT']]);
  assert.equal((await J(await api.request('/links?system=NEURON_IMAGE&imageId=..%2F..%2Fx'))).body.error_code, 'INVALID_ID');
});

test('reader details: format / dimensions / role / provenance / links / classification; texture + environment rules unchanged for imported sources; EXR preview only through a DERIVE job', { skip: !HAS_FFMPEG && 'no FFmpeg' }, async () => {
  const tex = (await services.integrations.importNeuronImage({ imageId: neuronImage(png(128, 128, 41)) })).asset;
  const mat = await J(await post('/materials', { name: 'Depuis un neurone', baseColorAssetId: tex.id, roughness: { value: 0.6 }, metallic: null, opacity: 'NONE', preview: false }));
  assert.equal(mat.status, 201);
  assert.deepEqual(['normal', 'height', 'ao', 'emissive'].map(k => mat.body.material[k].status), ['UNSUPPORTED', 'UNSUPPORTED', 'UNSUPPORTED', 'UNSUPPORTED'], 'V1 rules not relaxed');
  assert.notEqual(mat.body.material.status, 'PBR_COMPLETE');
  const panoBytes = png(512, 256, 1, sky(512, 256));
  const pano = (await J(await api.request(`/imports/media-studio?${new URLSearchParams({ projectId: crypto.randomUUID(), mediaAssetId: crypto.randomUUID(), sha256: sha(panoBytes), name: 'ciel.png' })}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: panoBytes }))).body.asset;
  const env = await J(await post('/environments', { type: 'PANORAMA_REFERENCE', assetId: pano.id }));
  assert.equal(env.status, 201);
  assert.equal(env.body.environment.projection, 'PANORAMA_2_1_REFERENCE');
  assert.ok(env.body.environment.labels.includes('NOT_CERTIFIED_EQUIRECTANGULAR') || (env.body.environment.report?.warnings ?? []).includes('NOT_CERTIFIED_EQUIRECTANGULAR'), 'a 2:1 image stays a non-certified reference');
  for (const t of ['HDRI', 'CERTIFIED_EQUIRECTANGULAR', 'CUBEMAP', '3D_SCENE']) assert.equal((await J(await post('/environments', { type: t, assetId: pano.id }))).status, 400, t);

  const d = (await J(await api.request(`/assets/${tex.id}`))).body;
  assert.deepEqual([d.asset.format, d.asset.width, d.asset.height, d.asset.role, d.integration.preview.native], ['PNG', 128, 128, 'SOURCE', true]);
  assert.deepEqual(d.integration.classification, ['TEXTURE_BASE_COLOR']);
  assert.equal(d.integration.links[0].system, 'NEURON_IMAGE');
  assert.deepEqual((await J(await api.request(`/assets/${pano.id}`))).body.integration.classification, ['ENVIRONMENT_PANORAMA_REFERENCE']);
  clean(d);

  const exrJob = await services.derive.run(services.derive.submit({ sourceAssetId: pano.id, operation: 'CONVERT', format: 'EXR' }).id);
  const exrId = exrJob.outputAssetIds[0];
  const exr = (await J(await api.request(`/assets/${exrId}`))).body;
  assert.deepEqual([exr.asset.format, exr.asset.dynamicRange, exr.asset.role, exr.integration.preview.native, exr.integration.preview.variant], ['EXR', 'LDR_CONTENT_IN_HDR_CONTAINER', 'DERIVED', false, null]);
  assert.equal(exr.source.operation, 'CONVERT');
  assert.deepEqual(exr.source.derivedFrom, [pano.id]);
  const exrBytesBefore = hashFile(store.files.resolveAssetPath(store.getAsset(exrId).storagePath));
  const job = await J(await post('/derive', { sourceAssetId: exrId, operation: 'CONVERT', format: 'PNG' }));
  assert.equal(job.status, 202);
  const until = Date.now() + 30_000; let j = job.body.job;
  while (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.status) && Date.now() < until) { await new Promise(r => setTimeout(r, 100)); j = (await J(await api.request(`/jobs/${j.id}`))).body.job; }
  assert.equal(j.status, 'COMPLETED');
  const after = (await J(await api.request(`/assets/${exrId}`))).body.integration.preview.variant;
  assert.deepEqual([after.assetId, after.operation], [j.outputAssetIds[0], 'CONVERT']);
  assert.equal(store.getAsset(after.assetId).actualFormat, 'PNG');
  assert.equal(hashFile(store.files.resolveAssetPath(store.getAsset(exrId).storagePath)), exrBytesBefore, 'EXR source unchanged');
  assert.equal(JSON.stringify(exr).includes('HDRI'), false);
});

test('disabled gate: every EETF-8 route answers 503 EETF_DISABLED (no bypass), nothing opened', async () => {
  const off = createEetfRouteFromBoot({ enforce, providerEndpoint: () => 'http://127.0.0.1:8188', env: {} });
  const closedRoute = createEetfRoute(null);
  for (const r of [off, closedRoute]) {
    for (const [m, p, body] of [
      ['POST', '/imports/neuron-image', JSON.stringify({ imageId: `${crypto.randomUUID()}.png` })],
      ['POST', `/imports/media-studio?projectId=${crypto.randomUUID()}&mediaAssetId=${crypto.randomUUID()}&sha256=${'a'.repeat(64)}`, png(8, 8)],
      ['POST', `/assets/${crypto.randomUUID()}/exports`, JSON.stringify({ system: 'NEURON_IMAGE', ref: { imageId: `${crypto.randomUUID()}.png` } })],
      ['GET', `/links?system=NEURON_IMAGE&imageId=${crypto.randomUUID()}.png`],
      ['GET', `/assets/${crypto.randomUUID()}`],
      ['GET', `/assets/${crypto.randomUUID()}/file`],
    ]) {
      const res = await J(await r.request(p, { method: m, ...(body ? { body, headers: { 'content-type': 'application/json' } } : {}) }));
      assert.deepEqual([res.status, res.body.error_code], [503, 'EETF_DISABLED'], `${m} ${p}`);
    }
  }
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'eetf')), false);
});

test('Media Studio service: EETF origin validated, bytes re-hashed, same content not copied twice, legacy sources unchanged', { skip: !HAS_FFMPEG && 'no FFmpeg' }, async () => {
  const root = path.join(TMP, 'studio');
  const service = createMediaStudioService({ rootDir: root, store: createMediaStudioStore(), enforce });
  const ms = createMediaStudioRoute({ service });
  const bytes = png(64, 32, 51);
  const asset = store.registerAsset({ buffer: bytes, declaredMime: 'image/png', role: 'SOURCE', displayName: 'vers-studio.png' }).asset;
  const origin = { type: 'eetf', assetId: asset.id, sha256: asset.sha256, role: 'SOURCE', format: 'PNG', jobId: null, operation: null, createdAt: asset.createdAt, derivedFrom: [] };
  const { project } = service.createProject({ name: 'EETF' });
  const send = async (buf, o) => {
    const up = await J(await ms.request(`/media-studio/projects/${project.id}/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'vers-studio.png', size: buf.length, origin: o }) }));
    if (up.status !== 200) return up;
    await ms.request(`/media-studio/uploads/${up.body.uploadId}?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: buf });
    return J(await ms.request(`/media-studio/uploads/${up.body.uploadId}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: sha(buf) }) }));
  };
  const first = await send(bytes, origin);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.asset.sha256, first.body.asset.source.type, first.body.asset.source.assetId, first.body.asset.kind], [asset.sha256, 'eetf', asset.id, 'image']);
  const dir = path.join(root, 'projects', project.id, 'assets');
  const n = fs.readdirSync(dir).length;
  const second = await send(bytes, origin);
  assert.deepEqual([second.body.existed, second.body.asset.id, fs.readdirSync(dir).length, second.body.project.assets.length], [true, first.body.asset.id, n, 1], 'no second copy');
  const other = png(64, 32, 52);
  const mismatch = await send(other, origin);
  assert.deepEqual([mismatch.status, mismatch.body.error.code], [422, 'EETF_SOURCE_MISMATCH']);
  assert.equal(fs.readdirSync(dir).length, n);
  for (const bad of [{ ...origin, assetId: '../x' }, { ...origin, format: 'EXR' }, { ...origin, sha256: 'z' }, { ...origin, operation: 'C:\\evil' }, { ...origin, createdAt: 'never' }, { ...origin, derivedFrom: ['x'] }]) {
    const r = await send(bytes, bad);
    assert.deepEqual([r.status, r.body.error.code], [400, 'INVALID_ORIGIN'], JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual(uploadSource({ type: 'media-reader', url: 'https://x.org/a.mp4' }), { type: 'media-reader', url: 'https://x.org/a.mp4' });
  assert.deepEqual(uploadSource(null), { type: 'upload' });
  assert.equal(hashFile(store.files.resolveAssetPath(asset.storagePath)), asset.sha256, 'EETF source unchanged');
});

test('isolation: no network call, real user DB / real Neurone images untouched, nothing in the user data folder', () => {
  assert.deepEqual(fetchCalls.filter(u => !/^http:\/\/127\.0\.0\.1:/.test(u)), [], 'no fetch outside loopback (ComfyUI probe on a closed loopback port only)');
  assert.deepEqual(REAL_DB.map(fileHash), realDbBefore);
  assert.equal(fs.existsSync(REAL_IMAGES) ? fs.readdirSync(REAL_IMAGES).length : -1, realImagesBefore);
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'eetf')), false);
});
