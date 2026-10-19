// EETF-7 — HTTP contract of /api/image-generation/eetf: boot gate (503 while uncertified), mount inside the
// image-generation route (server.js untouched), uploads, safe file serving, jobs, cancellation, error model
// (stable codes, no stack / path / SQL). Temporary store, real FFmpeg, ComfyUI unavailable (closed port).
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

import { EetfStore } from './src/lib/eetf-store.js';
import { hashFile } from './src/lib/eetf-asset-store.js';
import { createEetfRoute, createEetfRouteFromBoot, createEetfServices } from './src/routes/eetf.js';
import { createComfyUiProvider } from './src/lib/eetf-comfyui-provider.js';
import { createImageGenerationRoute } from './src/routes/image-generation.js';
import { enforce } from './src/lib/root-policy/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf7-route-'));
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? hashFile(p) : 'absent');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-version'], { shell: false, windowsHide: true }).status === 0;
let realDbBefore; let store; let api; const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); }
function png(w, h, seed = 1) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x * 5 + y * 3 + seed * 11) & 0xff;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const J = async (res) => ({ status: res.status, body: await res.json() });
const post = (p, data) => api.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
const clean = (b) => { const s = JSON.stringify(b); assert.equal(/\bat [\w.<>]+ \(|[A-Za-z]:\\|\/Users\/|SELECT |sqlite|stack/i.test(s), false, `no internals: ${s.slice(0, 200)}`); };

before(async () => {
  realDbBefore = REAL_DB.map(fileHash);
  const closed = http.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const port = closed.address().port; await new Promise(r => closed.close(r));
  store = EetfStore.open({ dbPath: path.join(TMP, 'eetf.sqlite'), assetRoot: path.join(TMP, 'root') });
  api = createEetfRoute(createEetfServices({ store, enforce, providers: [createComfyUiProvider({ endpoint: `http://127.0.0.1:${port}`, enforce, probeTimeoutMs: 800 })] }));
});
after(() => { store?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ } });

test('boot gate: uncertified → /status says disabled, every other route 503 EETF_DISABLED; mounted inside image-generation (server.js untouched)', async () => {
  const off = createEetfRouteFromBoot({ enforce, providerEndpoint: () => 'http://127.0.0.1:8188', env: {} });
  assert.deepEqual(await J(await off.request('/status')), { status: 200, body: { enabled: false, reason: 'EETF_UNCERTIFIED_DISABLED' } });
  for (const [m, p] of [['GET', '/assets'], ['POST', '/derive'], ['POST', '/generate'], ['GET', '/jobs'], ['POST', '/materials']]) {
    const r = await J(await off.request(p, { method: m }));
    assert.deepEqual([r.status, r.body.error_code], [503, 'EETF_DISABLED'], `${m} ${p}`);
  }
  const legacy = createImageGenerationRoute({});
  assert.equal((await J(await legacy.request('/image-generation/eetf/status'))).body.enabled, false, 'mounted at /image-generation/eetf');
  assert.equal((await legacy.request('/image-generation/eetf/assets')).status, 503);
  assert.equal(/eetf/i.test(fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8')), false, 'server.js does not mention EETF');
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'eetf')), false, 'nothing created in the user data directory');
});

test('status: provider UNAVAILABLE (normal state), generation disabled with LOCAL_PROVIDER_UNAVAILABLE, local FFmpeg reported, V1 contract', async () => {
  const s = (await J(await api.request('/status'))).body;
  assert.equal(s.enabled, true);
  assert.deepEqual([s.provider.status, s.generation.available, s.generation.reason], ['UNAVAILABLE', false, 'LOCAL_PROVIDER_UNAVAILABLE']);
  assert.equal(s.local.ffmpeg.available, HAS_FFMPEG);
  assert.deepEqual(s.contract.mapStatuses.NORMAL, ['UNSUPPORTED']);
  assert.deepEqual([s.contract.pbrCompleteReachable, s.contract.seamlessClaims], [false, false]);
  assert.deepEqual(s.contract.unsupportedEnvironmentTypes, ['HDRI', 'CERTIFIED_EQUIRECTANGULAR', 'CUBEMAP', '3D_SCENE']);
});

test('uploads + file serving: content-addressed, idempotent, fake MIME / SVG / oversized refused, nosniff + sandbox CSP, ids validated', { skip: !HAS_FFMPEG && 'no FFmpeg' }, async () => {
  const buf = png(64, 48);
  const up = await J(await api.request('/assets?name=%3Cimg%20src%3Dx%20onerror%3D1%3Epierre.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: buf }));
  assert.equal(up.status, 201);
  assert.equal(up.body.asset.displayName.includes('<'), false, 'display name sanitised');
  const again = await J(await api.request('/assets', { method: 'POST', headers: { 'content-type': 'image/png' }, body: buf }));
  assert.deepEqual([again.status, again.body.existed, again.body.asset.id], [200, true, up.body.asset.id]);
  const fakeMime = await J(await api.request('/assets', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: buf }));
  assert.deepEqual([fakeMime.status, fakeMime.body.error_code], [400, 'MIME_MISMATCH']);
  const svg = await J(await api.request('/assets', { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from('<svg onload="alert(1)"/>') }));
  assert.equal(svg.body.error_code, 'UNSUPPORTED_FORMAT');
  const big = await J(await api.request('/assets', { method: 'POST', headers: { 'content-type': 'image/png', 'content-length': String(65 * 1024 * 1024) }, body: buf }));
  assert.deepEqual([big.status, big.body.error_code], [413, 'FILE_TOO_LARGE']);
  const file = await api.request(`/assets/${up.body.asset.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.match(file.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'), up.body.asset.sha256);
  for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'javascript:alert(1)', 'C:%5CWindows', 'http%3A%2F%2Fevil.test%2Fx.png']) {
    const r = await J(await api.request(`/assets/${bad}/file`));
    assert.deepEqual([r.status, r.body.error_code], [400, 'INVALID_ID'], bad); clean(r.body);
  }
  assert.equal((await J(await api.request(`/assets/${crypto.randomUUID()}/file`))).status, 404);
});

test('jobs: derive queued → COMPLETED in the background; cancel of a finished job refused; generation refused while the provider is unavailable', { skip: !HAS_FFMPEG && 'no FFmpeg' }, async () => {
  const a = store.registerAsset({ buffer: png(96, 64, 2), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const sub = await J(await post('/derive', { sourceAssetId: a.id, operation: 'THUMBNAIL', maxSide: 32 }));
  assert.deepEqual([sub.status, sub.body.job.status], [202, 'QUEUED']);
  let job;
  for (let i = 0; i < 100; i++) { job = (await J(await api.request(`/jobs/${sub.body.job.id}`))).body.job; if (job.status === 'COMPLETED' || job.status === 'FAILED') break; await sleep(50); }
  assert.equal(job.status, 'COMPLETED', JSON.stringify(job.error));
  const cancel = await J(await post(`/jobs/${job.id}/cancel`, {}));
  assert.deepEqual([cancel.status, cancel.body.error_code], [409, 'JOB_NOT_CANCELLABLE']);
  const queued = (await J(await post('/derive', { sourceAssetId: a.id, operation: 'CONVERT', format: 'TIFF' }))).body.job;
  const c2 = await J(await post(`/jobs/${queued.id}/cancel`, {}));
  assert.ok([200, 409].includes(c2.status), 'a queued job cancels immediately (or had already finished)');
  const gen = await J(await post('/generate', { prompt: 'x', width: 512, height: 512, target: 'IMAGE', model: 'm' }));
  assert.deepEqual([gen.status, gen.body.error_code], [409, 'PROVIDER_UNAVAILABLE']);
  clean(gen.body);
  assert.equal((await J(await api.request('/jobs'))).body.jobs.length >= 2, true);
});

test('materials / environments / skybox over HTTP; error model: stable codes, no internals; JSON limits; unknown route', { skip: !HAS_FFMPEG && 'no FFmpeg' }, async () => {
  const tex = store.registerAsset({ buffer: png(64, 64, 3), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const m = await J(await post('/materials', { name: 'M', baseColorAssetId: tex.id, roughness: { value: 0.5 } }));
  assert.deepEqual([m.status, m.body.material.status, m.body.material.normal.status, m.body.material.claims.pbrComplete], [201, 'PARTIAL_MATERIAL', 'UNSUPPORTED', false]);
  const pano = store.registerAsset({ buffer: png(512, 256, 4), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const e = await J(await post('/environments', { type: 'PANORAMA_REFERENCE', assetId: pano.id }));
  assert.equal(e.status, 201); assert.ok(e.body.environment.labels.includes('NOT_CERTIFIED_EQUIRECTANGULAR'));
  const sky = await J(await post(`/environments/${e.body.environment.id}/skybox`, { yaw: 10, pitch: 0, fov: 80, width: 128, height: 72 }));
  assert.deepEqual([sky.status, sky.body.environment.type], [201, 'SKYBOX_PREVIEW']);
  for (const [body, code] of [[{ type: 'HDRI', assetId: pano.id }, 'ENVIRONMENT_TYPE_UNSUPPORTED'], [{ type: 'CUBEMAP', assetId: pano.id }, 'ENVIRONMENT_TYPE_UNSUPPORTED'], [{ type: 'PANORAMA_REFERENCE', assetId: tex.id }, 'PANORAMA_ASPECT']]) {
    const r = await J(await post('/environments', body)); assert.deepEqual([r.status, r.body.error_code], [400, code]); clean(r.body);
  }
  const fovBad = await J(await post(`/environments/${e.body.environment.id}/skybox`, { fov: 500 }));
  assert.deepEqual([fovBad.status, fovBad.body.error_code], [400, 'INVALID_PREVIEW']);
  const nan = await J(await post('/materials', { name: 'x', baseColorAssetId: tex.id, metallic: { value: null } }));
  assert.equal(nan.body.error_code, 'INVALID_CONSTANT');
  const huge = await J(await api.request('/materials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(70_000) }) }));
  assert.equal(huge.body.error_code, 'PARAMS_TOO_LARGE');
  const bad = await J(await api.request('/materials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }));
  assert.equal(bad.body.error_code, 'INVALID_PARAMS');
  const nf = await J(await api.request('/nope'));
  assert.deepEqual([nf.status, nf.body.error_code], [404, 'NOT_FOUND']);
  assert.deepEqual(REAL_DB.map(fileHash), realDbBefore, 'user database files byte-identical');
});
