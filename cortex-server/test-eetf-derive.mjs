// EETF-3 — deterministic FFmpeg derivation engine.
// Real FFmpeg on locally generated fixtures, temporary store only, real Root
// Policy decision for MEDIA_TRANSCODE (module media). No network (fetch counted),
// no model, no cloud. Every spawned PID is checked dead at the end.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EetfStore } from './src/lib/eetf-store.js';
import { hashFile } from './src/lib/eetf-asset-store.js';
import { createEetfDerivationEngine, planDerivation } from './src/lib/eetf-derive.js';
import { enforce as realEnforce } from './src/lib/root-policy/index.js';
import * as C from './src/lib/eetf-contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf3-'));
const REAL_DB_FILES = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? hashFile(p) : 'absent');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-version'], { shell: false, windowsHide: true }).status === 0;
const skip = HAS_FFMPEG ? false : 'FFmpeg is not installed on this machine';
let realDbBefore; let fetchCalls = 0; const realFetch = globalThis.fetch;
const opened = []; const allPids = new Set();
// [EETF-CERT] Windows recycles PIDs quickly: a child whose 'exit' was observed is dead even if its PID now belongs to another
// process (seen in the full parallel backend run) — only children without an observed exit are checked by PID.
const exitedPids = new Set();

before(() => {
  realDbBefore = REAL_DB_FILES.map(fileHash);
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network is not allowed in EETF-3 tests'); };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const s of opened) s.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { console.warn(`temp cleanup: ${e.message}`); }
});

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const code = (c) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`); return true; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Spawn spy: every process start must be shell:false with a string argv; records calls. */
function spySpawn(impl = spawn) {
  const calls = [];
  const fn = (bin, args, opts) => {
    assert.equal(opts?.shell, false, 'shell:false');
    assert.ok(Array.isArray(args) && args.every(a => typeof a === 'string'), 'structured argv');
    calls.push({ bin, args: [...args] });
    const p = impl(bin, args, opts);
    if (p?.pid) { allPids.add(p.pid); p.once?.('exit', () => exitedPids.add(p.pid)); }
    return p;
  };
  fn.calls = calls;
  fn.transcodes = () => calls.filter(c => c.args.includes('-i'));
  return fn;
}

let n = 0;
function setup({ enforce = realEnforce, spawnImpl = spySpawn(), ...opts } = {}) {
  const dir = path.join(TMP, `w${++n}`); fs.mkdirSync(dir);
  const store = EetfStore.open({ dbPath: path.join(dir, 'eetf.sqlite'), assetRoot: path.join(dir, 'root') });
  opened.push(store);
  const engine = createEetfDerivationEngine({ store, enforce, spawnImpl, ...opts });
  return { store, engine, spawnImpl, dir };
}

// ── fixtures (generated locally) ───────────────────────────────────────────

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, { alpha = false, seed = 1, extraChunks = [] } = {}) {
  const ch = alpha ? 4 : 3; const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * ch; x++) raw[y * (w * ch + 1) + 1 + x] = (x * 7 + y * 13 + seed * 31) & 0xff;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extraChunks, pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
const pngChunks = (b) => { const out = []; let i = 8; while (i + 8 <= b.length) { const len = b.readUInt32BE(i); out.push(b.toString('latin1', i + 4, i + 8)); i += 12 + len; } return out; };
const jpegSegments = (b) => { const out = []; let i = 2; while (i + 4 <= b.length && b[i] === 0xff) { const m = b[i + 1]; if (m === 0xda) break; const len = b.readUInt16BE(i + 2); out.push({ marker: m, data: b.subarray(i + 4, i + 2 + len) }); i += 2 + len; } return out; };
const EXIF_GPS = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x0e, 0, 2, 0, 0, 0, 8, 0, 0, 0, 26, 0, 0, 0, 0, ...Buffer.from('GPSDATA'), 0]);

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced, all 5 filters) to compare pixels. */
function decodePng(b) {
  let i = 8; let w; let h; let ct; const idat = [];
  while (i < b.length) {
    const len = b.readUInt32BE(i); const type = b.toString('latin1', i + 4, i + 8); const d = b.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); assert.equal(d[8], 8); ct = d[9]; assert.equal(d[12], 0); }
    if (type === 'IDAT') idat.push(d);
    i += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : assert.fail(`color type ${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0; const up = y > 0 ? out[(y - 1) * stride + x] : 0; const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + up - c; const pa = Math.abs(p - a); const pb = Math.abs(p - up); const pc = Math.abs(p - c);
      const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f];
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { w, h, bpp, px: out };
}

const register = (store, buffer, extra = {}) => store.registerAsset({ buffer, declaredMime: 'image/png', role: 'SOURCE', ...extra }).asset;
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

const fileOf = (store, asset) => fs.readFileSync(store.files.resolveAssetPath(asset.storagePath));
async function derive(engine, store, req) {
  const job = engine.submit(req);
  const done = await engine.run(job.id);
  return { job: done, asset: done.outputAssetIds[0] ? store.getAsset(done.outputAssetIds[0]) : null };
}

// ── tests ──────────────────────────────────────────────────────────────────

test('formats: PNG → PNG / JPEG / WebP / TIFF / EXR / HDR, JPEG → PNG; output sniffed; HDR containers labelled LDR', { skip }, async () => {
  const { store, engine, spawnImpl } = setup();
  const src = register(store, makePng(64, 48, { seed: 2 }));
  const expected = { PNG: 'image/png', JPEG: 'image/jpeg', WEBP: 'image/webp', TIFF: 'image/tiff', EXR: 'image/x-exr', HDR: 'image/vnd.radiance' };
  const out = {};
  for (const format of Object.keys(expected)) {
    const { job, asset } = await derive(engine, store, { sourceAssetId: src.id, operation: 'CONVERT', format });
    assert.equal(job.status, 'COMPLETED', `${format}: ${job.error?.code} ${job.error?.message}`);
    assert.deepEqual([asset.actualFormat, asset.declaredFormat, asset.mime, asset.width, asset.height, asset.role], [format, format, expected[format], 64, 48, 'DERIVED']);
    assert.equal(asset.dynamicRange, format === 'EXR' || format === 'HDR' ? 'LDR_CONTENT_IN_HDR_CONTAINER' : 'LDR');
    const prov = store.getProvenance(asset.provenanceId);
    assert.deepEqual(prov.derivedFrom, [src.id]);
    assert.equal(prov.provider, 'ffmpeg'); assert.match(prov.engineVersion, /\S/); assert.equal(prov.strictLocal, true);
    if (format === 'EXR' || format === 'HDR') assert.equal(prov.parameters.values, 'SOURCE_ENCODED_VALUES_NOT_LINEARIZED');
    out[format] = asset;
  }
  const resized = await derive(engine, store, { sourceAssetId: src.id, operation: 'RESIZE', width: 32, height: 20 });
  assert.deepEqual([resized.asset.actualFormat, resized.asset.width, resized.asset.height], ['PNG', 32, 20]);
  const back = await derive(engine, store, { sourceAssetId: out.JPEG.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([back.job.status, back.asset.actualFormat, back.asset.width, back.asset.height], ['COMPLETED', 'PNG', 64, 48]);
  const fromExr = await derive(engine, store, { sourceAssetId: out.EXR.id, operation: 'CONVERT', format: 'PNG' });
  assert.equal(fromExr.asset.dynamicRange, 'LDR', 'EXR (LDR content) → PNG is plain LDR');
  const all = store.db.prepare('SELECT dynamic_range AS d FROM eetf_assets').all().map(r => r.d);
  assert.ok(!all.includes('HDR'), 'no asset claims true HDR');
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM eetf_provenance').all()).includes('HDR_GENERATED'), false);
  for (const c of spawnImpl.transcodes()) {
    assert.equal(c.args.includes('-protocol_whitelist') && c.args[c.args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.ok(c.args.includes('-max_pixels'));
    for (const a of c.args) assert.equal(/:\/\/|^https?:/i.test(a), false, `no URL in argv: ${a}`);
    for (const a of c.args.filter(x => x.startsWith('file:'))) assert.ok(path.resolve(a.slice(5)).startsWith(store.files.root), 'paths built under the EETF root');
  }
});

test('alpha preservation: RGBA kept by PNG / WebP / TIFF (alpha bytes identical) and EXR (float alpha within half an 8-bit step), refused for JPEG / HDR', { skip }, async () => {
  const { store, engine } = setup();
  const srcBuf = makePng(40, 30, { alpha: true, seed: 5 });
  const src = register(store, srcBuf);
  const srcPx = decodePng(srcBuf);
  for (const format of ['PNG', 'WEBP', 'TIFF', 'EXR']) {
    const { asset } = await derive(engine, store, { sourceAssetId: src.id, operation: 'CONVERT', format });
    assert.equal(asset.hasAlpha, true, format);
    if (format === 'EXR') {
      // the EXR stores alpha as float32: read it back as float (planes G, B, R, A) and compare to source/255 exactly
      const raw = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'exr_pipe', '-i', `file:${store.files.resolveAssetPath(asset.storagePath)}`, '-f', 'rawvideo', '-pix_fmt', 'gbrapf32le', '-'], { shell: false, windowsHide: true, maxBuffer: 1 << 24 }).stdout;
      const plane = 40 * 30;
      assert.equal(raw.length, plane * 16);
      let worst = 0;
      for (let k = 0; k < plane; k++) worst = Math.max(worst, Math.abs(raw.readFloatLE((3 * plane + k) * 4) - srcPx.px[k * 4 + 3] / 255));
      // FFmpeg's 8-bit → float conversion is not exactly a/255 (measured worst ≈ 4.6e-5 on this build), but every
      // stored value stays within half an 8-bit step, i.e. it rounds back to the exact source alpha
      assert.ok(worst < 0.5 / 255, `EXR alpha rounds to the source alpha (worst error ${worst})`);
      continue; // an 8-bit round trip of a float file quantises (±1 LSB) — documented, not asserted as identity
    }
    const png = format === 'PNG' ? asset : (await derive(engine, store, { sourceAssetId: asset.id, operation: 'CONVERT', format: 'PNG' })).asset;
    const px = decodePng(fileOf(store, png));
    assert.equal(px.bpp, 4, `${format} → PNG still RGBA`);
    let diff = 0;
    for (let k = 3; k < px.px.length; k += 4) if (px.px[k] !== srcPx.px[k]) diff++;
    assert.equal(diff, 0, `${format}: alpha bytes identical`);
  }
  for (const format of ['JPEG', 'HDR']) assert.throws(() => engine.submit({ sourceAssetId: src.id, operation: 'CONVERT', format }), code('EETF_ALPHA_NOT_SUPPORTED_BY_TARGET'));
});

test('crop / fit (CONTAIN) / pad / thumbnail: exact geometry and pixels', { skip }, async () => {
  const { store, engine } = setup();
  const srcBuf = makePng(64, 32, { seed: 9 });
  const src = register(store, srcBuf);
  const s = decodePng(srcBuf);
  const crop = await derive(engine, store, { sourceAssetId: src.id, operation: 'CROP', x: 10, y: 5, width: 20, height: 12 });
  const c = decodePng(fileOf(store, crop.asset));
  assert.deepEqual([c.w, c.h], [20, 12]);
  for (let y = 0; y < 12; y++) assert.ok(c.px.subarray(y * 60, y * 60 + 60).equals(s.px.subarray((y + 5) * 192 + 30, (y + 5) * 192 + 90)), `crop row ${y} identical`);
  const contain = await derive(engine, store, { sourceAssetId: src.id, operation: 'RESIZE', width: 100, height: 100, fit: 'CONTAIN' });
  assert.deepEqual([contain.asset.width, contain.asset.height], [100, 50]);
  const pad = await derive(engine, store, { sourceAssetId: src.id, operation: 'RESIZE', width: 100, height: 100, fit: 'PAD', background: '336699' });
  const p = decodePng(fileOf(store, pad.asset));
  assert.deepEqual([p.w, p.h, p.bpp], [100, 100, 3]);
  assert.deepEqual([...p.px.subarray(0, 3)], [0x33, 0x66, 0x99], 'pad colour in the corner');
  const padT = await derive(engine, store, { sourceAssetId: src.id, operation: 'RESIZE', width: 100, height: 100, fit: 'PAD' });
  const pt = decodePng(fileOf(store, padT.asset));
  assert.equal(padT.asset.hasAlpha, true); assert.equal(pt.px[3], 0, 'transparent padding');
  assert.equal(pt.px[(50 * 100 + 50) * 4 + 3], 255, 'image area opaque');
  const thumb = await derive(engine, store, { sourceAssetId: src.id, operation: 'THUMBNAIL', maxSide: 16 });
  assert.deepEqual([thumb.asset.actualFormat, thumb.asset.width, thumb.asset.height], ['WEBP', 16, 8]);
  const noUpscale = await derive(engine, store, { sourceAssetId: src.id, operation: 'THUMBNAIL', maxSide: 512, format: 'PNG' });
  assert.deepEqual([noUpscale.asset.width, noUpscale.asset.height], [64, 32], 'a thumbnail never upscales');
  const v = store.listVariants(src.id);
  assert.ok(v.length >= 5 && v.every(x => x.sourceAssetId === src.id));
});

test('metadata stripping: PNG tEXt (prompt) + eXIf (GPS), JPEG EXIF APP1 + COM — none survives', { skip }, async () => {
  const { store, engine } = setup();
  const meta = makePng(32, 32, { seed: 4, extraChunks: [pngChunk('tEXt', Buffer.from('prompt\u0000{"secret":"castle"}', 'latin1')), pngChunk('eXIf', EXIF_GPS)] });
  assert.deepEqual(pngChunks(meta), ['IHDR', 'tEXt', 'eXIf', 'IDAT', 'IEND']);
  const src = register(store, meta);
  for (const format of ['PNG', 'JPEG', 'WEBP', 'TIFF', 'EXR', 'HDR']) {
    const { asset } = await derive(engine, store, { sourceAssetId: src.id, operation: 'CONVERT', format });
    const b = fileOf(store, asset);
    assert.equal(b.includes(Buffer.from('castle')) || b.includes(Buffer.from('GPSDATA')) || b.includes(Buffer.from('Lavc')), false, `${format} carries no metadata`);
    if (format === 'PNG') assert.deepEqual(pngChunks(b).filter(t => /^(tEXt|iTXt|zTXt|eXIf|iCCP)$/.test(t)), []);
    if (format === 'JPEG') {
      // a JPEG SOURCE with EXIF (GPS) + a comment → JPEG output without them
      const segs = jpegSegments(b);
      assert.equal(segs.some(s => s.marker === 0xe1 || s.marker === 0xfe), false);
      const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 6 + 2 + EXIF_GPS.length]), Buffer.from('Exif\u0000\u0000', 'latin1'), EXIF_GPS]);
      const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 15]), Buffer.from('owner: alice!', 'latin1')]);
      const jIn = Buffer.concat([b.subarray(0, 2), exif, com, b.subarray(2)]);
      const jsrc = store.registerAsset({ buffer: jIn, declaredMime: 'image/jpeg', role: 'SOURCE' }).asset;
      const re = await derive(engine, store, { sourceAssetId: jsrc.id, operation: 'CONVERT', format: 'JPEG' });
      const out = fileOf(store, re.asset);
      assert.equal(jpegSegments(out).some(s => s.marker === 0xe1 || s.marker === 0xfe), false, 'EXIF / COM removed');
      assert.equal(out.includes(Buffer.from('GPSDATA')) || out.includes(Buffer.from('alice')), false);
    }
  }
});

test('determinism + content dedup: same source + params → same bytes (also in a fresh store); one asset, source unchanged', { skip }, async () => {
  const { store, engine } = setup();
  const srcBuf = makePng(48, 48, { alpha: true, seed: 7 });
  const src = register(store, srcBuf);
  const srcPath = store.files.resolveAssetPath(src.storagePath);
  const before = { hash: hashFile(srcPath), mtime: fs.statSync(srcPath).mtimeMs };
  const reqs = [{ operation: 'RESIZE', width: 24, height: 24 }, { operation: 'CONVERT', format: 'EXR' }, { operation: 'CONVERT', format: 'WEBP' }, { operation: 'THUMBNAIL', maxSide: 12, format: 'TIFF' }];
  const first = []; const second = [];
  for (const r of reqs) first.push((await derive(engine, store, { sourceAssetId: src.id, ...r })).asset);
  for (const r of reqs) second.push((await derive(engine, store, { sourceAssetId: src.id, ...r })).asset);
  assert.deepEqual(second.map(a => a.id), first.map(a => a.id), 'same output → the same content-addressed asset');
  const other = setup();
  const src2 = register(other.store, srcBuf);
  for (const [i, r] of reqs.entries()) assert.equal((await derive(other.engine, other.store, { sourceAssetId: src2.id, ...r })).asset.sha256, first[i].sha256, `${r.operation} ${r.format ?? ''} deterministic across stores`);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM eetf_assets WHERE role = 'DERIVED'").get().n, reqs.length);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM eetf_provenance').get().n, reqs.length, 'a reused output gets no second provenance');
  assert.equal(store.listVariants(src.id).length, reqs.length, 'variants idempotent');
  const jobs = store.listJobs({ status: 'COMPLETED', limit: 50 });
  assert.equal(jobs.length, 2 * reqs.length);
  assert.deepEqual({ hash: hashFile(srcPath), mtime: fs.statSync(srcPath).mtimeMs }, before, 'source never touched');
  assert.equal(store.verifyAsset(src.id), true);
});

test('invalid inputs: tampered / missing source, fake MIME, corrupt data, oversized dimensions, invalid params, path injection', { skip }, async () => {
  const { store, engine, spawnImpl } = setup();
  assert.throws(() => store.registerAsset({ buffer: makePng(8, 8), declaredMime: 'image/jpeg', role: 'SOURCE' }), code('EETF_MIME_MISMATCH'));
  // tampered source: bytes no longer match the sha256
  const t = register(store, makePng(16, 16, { seed: 11 }));
  const tp = store.files.resolveAssetPath(t.storagePath);
  fs.chmodSync(tp, 0o644); fs.writeFileSync(tp, makePng(16, 16, { seed: 12 })); fs.chmodSync(tp, 0o444);
  let r = await derive(engine, store, { sourceAssetId: t.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'INVALID_SOURCE']);
  // missing source file
  const m = register(store, makePng(16, 16, { seed: 13 }));
  const mp = store.files.resolveAssetPath(m.storagePath); fs.chmodSync(mp, 0o644); fs.rmSync(mp);
  r = await derive(engine, store, { sourceAssetId: m.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'INVALID_SOURCE']);
  // corrupt pixel data behind a valid header: refused at ingest since EETF-CERT; a pre-CERT stored copy → FFmpeg fails cleanly
  const good = makePng(16, 16, { seed: 14 });
  const corrupt = Buffer.from(good); for (let k = 40; k < corrupt.length - 20; k++) corrupt[k] ^= 0x5a;
  assert.throws(() => register(store, corrupt), (e) => e.code === 'EETF_MALFORMED_IMAGE');
  const cs = legacyCorruptAsset(store, corrupt, { width: 16, height: 16 });
  r = await derive(engine, store, { sourceAssetId: cs.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'TRANSCODE_FAILED']);
  const okSrc = register(store, makePng(32, 16, { seed: 15 }));
  const invalid = [
    [{ operation: 'RESIZE', width: 5000, height: 10 }, 'EETF_INVALID_NUMBER'],
    [{ operation: 'RESIZE', width: 4096, height: 4096, fit: 'STRETCH', format: 'EXR' }, null],
    [{ operation: 'CROP', x: 30, y: 0, width: 10, height: 10 }, 'EETF_INVALID_PARAMS'],
    [{ operation: 'RESIZE', width: 10, height: 10, background: '000000' }, 'EETF_INVALID_PARAMS'],
    [{ operation: 'RESIZE', width: 10, height: 10, fit: 'PAD', background: 'red; drawtext' }, 'EETF_INVALID_PARAMS'],
    [{ operation: 'CONVERT' }, 'EETF_INVALID_PARAMS'],
    [{ operation: 'THUMBNAIL', maxSide: 5000 }, 'EETF_INVALID_NUMBER'],
    [{ operation: 'DERIVE_MAP', textureRole: 'NORMAL' }, 'EETF_DERIVE_OPERATION_UNSUPPORTED'],
    [{ operation: 'TILE_PREVIEW', grid: 9 }, 'EETF_INVALID_NUMBER'],
    [{ operation: 'CONVERT', format: 'PNG', path: '../../evil.png' }, 'EETF_UNKNOWN_PARAM'],
    [{ operation: 'CONVERT', format: 'PNG', output: 'C:\\Windows\\x.png' }, 'EETF_UNKNOWN_PARAM'],
    [{ operation: 'CONVERT', format: 'GIF' }, 'EETF_INVALID_PARAMS'],
  ];
  const transcodesBefore = spawnImpl.transcodes().length;
  for (const [req, c] of invalid) {
    if (c === null) continue; // EXR 4096² is valid geometry but exceeds the temp quota: covered in the guards test
    assert.throws(() => engine.submit({ sourceAssetId: okSrc.id, ...req }), code(c), JSON.stringify(req));
  }
  for (const id of ['../x', 'C:\\x', '\\\\srv\\share']) assert.throws(() => engine.submit({ sourceAssetId: id, operation: 'CONVERT', format: 'PNG' }), code('EETF_INVALID_ID'));
  assert.equal(spawnImpl.transcodes().length, transcodesBefore, 'refused requests start nothing');
});

test('pixel guard: FFmpeg -max_pixels refuses the decode on its own (header check bypassed), budget refusals before spawn', { skip }, async () => {
  const { store, engine } = setup({ maxDecodePixels: 1000 });
  const src = register(store, makePng(64, 48, { seed: 16 })); // 3 072 px: accepted by the EETF header check
  const r = await derive(engine, store, { sourceAssetId: src.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'PIXEL_LIMIT']);
  assert.match(r.job.error.message, /max_pixels/);
  assert.throws(() => store.registerAsset({ buffer: (() => { const b = makePng(1, 1); b.writeUInt32BE(100_000, 16); b.writeUInt32BE(100_000, 20); return b; })(), declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_IMAGE_TOO_LARGE'));
  assert.equal(fs.readdirSync(path.join(store.files.root, 'tmp')).length, 0, 'no temporary output left');
});

test('disk and temp-quota guards refuse before FFmpeg starts; EXR 4096² exceeds the provisional temp quota', { skip }, async () => {
  const disk = setup({ diskFree: () => 1_000_000 });
  const s1 = register(disk.store, makePng(64, 64, { seed: 17 }));
  let r = await derive(disk.engine, disk.store, { sourceAssetId: s1.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'DISK_LIMIT']);
  assert.equal(disk.spawnImpl.transcodes().length, 0);
  const quota = setup({ tempQuotaBytes: 4096 });
  const s2 = register(quota.store, makePng(64, 64, { seed: 18 }));
  r = await derive(quota.engine, quota.store, { sourceAssetId: s2.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'TEMP_QUOTA']);
  // files already sitting in tmp count against the quota
  const q2 = setup({ tempQuotaBytes: 200_000 });
  const s3 = register(q2.store, makePng(32, 32, { seed: 19 }));
  fs.writeFileSync(path.join(q2.store.files.root, 'tmp', 'stale.part'), Buffer.alloc(199_000));
  r = await derive(q2.engine, q2.store, { sourceAssetId: s3.id, operation: 'CONVERT', format: 'PNG' });
  assert.equal(r.job.error.code, 'TEMP_QUOTA');
  const big = setup();
  const s4 = register(big.store, makePng(64, 64, { seed: 20 }));
  r = await derive(big.engine, big.store, { sourceAssetId: s4.id, operation: 'RESIZE', width: 4096, height: 4096, format: 'EXR' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'TEMP_QUOTA']);
  for (const e of [disk, quota, q2, big]) assert.equal(e.spawnImpl.transcodes().length, 0, 'no FFmpeg transcode started');
});

test('Root Policy: MEDIA_TRANSCODE enforced for module media before EVERY spawn; a refusal starts nothing', { skip }, async () => {
  const seen = [];
  const recording = setup({ enforce: (req) => { seen.push(req); return realEnforce(req); } });
  const src = register(recording.store, makePng(16, 16, { seed: 21 }));
  await derive(recording.engine, recording.store, { sourceAssetId: src.id, operation: 'CONVERT', format: 'PNG' });
  assert.ok(seen.length >= recording.spawnImpl.calls.length, 'one decision per process start at least');
  assert.ok(seen.every(r => r.action === 'MEDIA_TRANSCODE' && r.module === 'media' && r.trustDomain === 'MEDIA' && r.context.networkClass === 'none'));
  assert.equal(realEnforce({ action: 'MEDIA_TRANSCODE', module: 'media', trustDomain: 'MEDIA', context: { engine: 'ffmpeg', networkClass: 'none' } }).decision, 'ALLOW', 'the signed policy allows it');
  assert.throws(() => realEnforce({ action: 'MEDIA_TRANSCODE', module: 'eetf', trustDomain: 'MEDIA', context: {} }), /DENY_UNKNOWN_MODULE/, 'no eetf module exists (none was created)');
  const deny = () => { throw Object.assign(new Error('Action refusée par la Root Policy (DENY_TEST)'), { code: 'ROOT_POLICY_DENIED', rootPolicyDenied: true }); };
  const refused = setup({ enforce: deny });
  const s = register(refused.store, makePng(16, 16, { seed: 22 }));
  const r = await derive(refused.engine, refused.store, { sourceAssetId: s.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'ROOT_POLICY_DENIED']);
  assert.equal(refused.spawnImpl.calls.length, 0, 'FFmpeg never spawned');
});

const FAKE = path.join(TMP, 'slow-ffmpeg.cjs');
fs.writeFileSync(FAKE, `const { spawn } = require('node:child_process'); const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.EETF_FAKE_PIDS, JSON.stringify({ parent: process.pid, child: child.pid }));
setTimeout(() => {}, 60000);\n`);
/** Probes go to the real FFmpeg; the transcode goes to a slow stand-in with a grandchild (to prove tree kill). */
function slowSpawn(pidFile) {
  return spySpawn((bin, args, opts) => (args.includes('-i')
    ? spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, EETF_FAKE_PIDS: pidFile } })
    : spawn(bin, args, opts)));
}
async function waitFor(fn, ms = 10_000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) assert.fail('timeout waiting'); await sleep(25); } }

test('cancellation: QUEUED cancel starts nothing; RUNNING cancel kills the FFmpeg process TREE (no orphan), tmp cleaned', { skip }, async () => {
  const { store, engine, spawnImpl } = setup();
  const src = register(store, makePng(16, 16, { seed: 23 }));
  const queued = engine.submit({ sourceAssetId: src.id, operation: 'CONVERT', format: 'PNG' });
  const c1 = await engine.cancel(queued.id);
  assert.deepEqual([c1.job.status, c1.interruptRequired], ['CANCELLED', false]);
  await assert.rejects(engine.run(queued.id), code('EETF_INVALID_TRANSITION'));
  assert.equal(spawnImpl.transcodes().length, 0);
  const pidFile = path.join(TMP, `pids-${n}.json`);
  const slow = setup({ spawnImpl: slowSpawn(pidFile) });
  const s2 = register(slow.store, makePng(16, 16, { seed: 24 }));
  const job = slow.engine.submit({ sourceAssetId: s2.id, operation: 'CONVERT', format: 'PNG' });
  const running = slow.engine.run(job.id);
  await waitFor(() => fs.existsSync(pidFile));
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(isAlive(pids.parent) && isAlive(pids.child), 'stand-in and its child are running');
  assert.equal(slow.store.getJob(job.id).status, 'RUNNING');
  const c2 = await slow.engine.cancel(job.id);
  assert.equal(c2.interruptRequired, true);
  const final = await running;
  assert.deepEqual([final.status, final.error.code], ['CANCELLED', 'CANCELLED_BY_USER']);
  await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000);
  assert.equal(fs.readdirSync(path.join(slow.store.files.root, 'tmp')).length, 0, 'tmp cleaned');
  assert.equal(slow.store.db.prepare("SELECT COUNT(*) AS n FROM eetf_assets WHERE role = 'DERIVED'").get().n, 0);
  assert.equal(slow.engine.isRunning(), null);
});

test('timeout: the process tree is stopped and the job FAILS with TIMEOUT (stand-in and real FFmpeg)', { skip }, async () => {
  const pidFile = path.join(TMP, `pids-t-${n}.json`);
  const slow = setup({ spawnImpl: slowSpawn(pidFile), timeoutMs: 400 });
  const s = register(slow.store, makePng(16, 16, { seed: 25 }));
  const t0 = Date.now();
  const r = await derive(slow.engine, slow.store, { sourceAssetId: s.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'TIMEOUT']);
  assert.ok(Date.now() - t0 < 10_000);
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000);
  const real = setup({ timeoutMs: 1 });
  await real.engine.detect(); // probes outside the 1 ms budget
  const s2 = register(real.store, makePng(16, 16, { seed: 26 }));
  const r2 = await derive(real.engine, real.store, { sourceAssetId: s2.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r2.job.status, r2.job.error.code], ['FAILED', 'TIMEOUT']);
  assert.equal(fs.readdirSync(path.join(real.store.files.root, 'tmp')).length, 0);
});

test('engine errors: FFmpeg unavailable, busy slot, forged output rejected by sniffing, junction on tmp refused', { skip }, async () => {
  const missing = setup({ ffmpegBin: 'eetf-no-such-ffmpeg-binary' });
  const s = register(missing.store, makePng(16, 16, { seed: 27 }));
  let r = await derive(missing.engine, missing.store, { sourceAssetId: s.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'FFMPEG_UNAVAILABLE']);
  // the output is checked by content: an FFmpeg run whose file is swapped afterwards is refused
  const forge = setup({ spawnImpl: spySpawn((bin, args, opts) => {
    const p = spawn(bin, args, opts);
    if (args.includes('-i')) p.on('exit', () => { const out = args.at(-1).slice(5); if (fs.existsSync(out)) fs.writeFileSync(out, makePng(5, 5, { seed: 99 })); });
    return p;
  }) });
  const s2 = register(forge.store, makePng(16, 16, { seed: 28 }));
  r = await derive(forge.engine, forge.store, { sourceAssetId: s2.id, operation: 'CONVERT', format: 'WEBP' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'OUTPUT_INVALID']);
  // single slot
  const pidFile = path.join(TMP, `pids-b-${n}.json`);
  const busy = setup({ spawnImpl: slowSpawn(pidFile) });
  const s3 = register(busy.store, makePng(16, 16, { seed: 29 }));
  const j1 = busy.engine.submit({ sourceAssetId: s3.id, operation: 'CONVERT', format: 'PNG' });
  const j2 = busy.engine.submit({ sourceAssetId: s3.id, operation: 'CONVERT', format: 'TIFF' });
  const p1 = busy.engine.run(j1.id);
  await waitFor(() => fs.existsSync(pidFile));
  await assert.rejects(busy.engine.run(j2.id), code('EETF_ENGINE_BUSY'));
  assert.equal(busy.store.getJob(j2.id).status, 'QUEUED');
  await busy.engine.cancel(j1.id); await p1;
  // a junction swapped onto tmp/ → refused, nothing written outside
  const jn = setup();
  const s4 = register(jn.store, makePng(16, 16, { seed: 30 }));
  const outside = path.join(TMP, `outside-${n}`); fs.mkdirSync(outside);
  fs.rmSync(path.join(jn.store.files.root, 'tmp'), { recursive: true });
  fs.symlinkSync(outside, path.join(jn.store.files.root, 'tmp'), 'junction');
  r = await derive(jn.engine, jn.store, { sourceAssetId: s4.id, operation: 'CONVERT', format: 'PNG' });
  assert.deepEqual([r.job.status, r.job.error.code], ['FAILED', 'PATH_REFUSED']);
  assert.equal(fs.readdirSync(outside).length, 0, '0 write outside the EETF root');
  assert.equal(jn.spawnImpl.transcodes().length, 0);
});

test('runNext processes the oldest queued derivation; recovery purges an orphaned FFmpeg output', { skip }, async () => {
  const { store, engine } = setup();
  const s = register(store, makePng(16, 16, { seed: 31 }));
  const a = engine.submit({ sourceAssetId: s.id, operation: 'CONVERT', format: 'PNG' });
  const b = engine.submit({ sourceAssetId: s.id, operation: 'CONVERT', format: 'TIFF' });
  assert.equal((await engine.runNext()).id, a.id);
  assert.equal((await engine.runNext()).id, b.id);
  assert.equal(await engine.runNext(), null);
  fs.writeFileSync(path.join(store.files.root, 'tmp', `${crypto.randomUUID()}.out.png`), 'half-written');
  assert.equal(store.recoverAfterRestart().tmpPurged, 1);
  assert.equal(planDerivation({ operation: 'CONVERT', sourceAssetIds: [s.id], format: 'PNG' }, s).filters.length, 0);
});

test('isolation: no network, no model, no cloud; every spawned process ended; user DB unchanged', { skip }, async () => {
  await sleep(200);
  const alive = [...allPids].filter(pid => !exitedPids.has(pid) && isAlive(pid));
  assert.deepEqual(alive, [], 'no orphan process (every spawned child observed exiting)');
  assert.equal(exitedPids.size, allPids.size, 'every spawned child emitted exit');
  assert.equal(fetchCalls, 0);
  const src = fs.readFileSync(path.join(HERE, 'src', 'lib', 'eetf-derive.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const re of [/fetch\s*\(/, /node:(http|https|net|tls|dgram)/, /ollama/i, /comfyui/i, /image-router/, /shell:\s*true/]) assert.equal(re.test(src), false, String(re));
  assert.equal(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/.exec(src)?.[1].trim(), 'spawn', 'only spawn (no exec / execFile / shell helpers)');
  assert.deepEqual(REAL_DB_FILES.map(fileHash), realDbBefore, 'user database files byte-identical');
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'eetf')), false);
  assert.ok(C.RESOURCE_LIMITS.tempQuota.value > 0 && C.RESOURCE_LIMITS.vramRequirement.value === null);
});
