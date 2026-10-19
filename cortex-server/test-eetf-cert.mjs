// EETF-CERT — final certification checks not covered by the EETF-2…8 suites:
//   integrity gate on EVERY ingress path (truncated / damaged PNG, JPEG, WebP, TIFF, EXR, HDR), bounds of the FFmpeg
//   decode check (Root Policy, -max_pixels, timeout + tree kill, single slot, temp quota, disk guard), schema generations
//   (fresh, upgrade from v1 / v2 / v3 with data, atomic rollback, constraints), persistence across a NEW Node process,
//   path / id red team, metadata stripping, HDR honesty, concurrency / cancel races, HTTP red team, boot gate, network.
// Temporary stores only (never cortex-server/data), real FFmpeg, real Root Policy decisions, no provider installed.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import * as C from './src/lib/eetf-contracts.js';
import { EetfStore } from './src/lib/eetf-store.js';
import { hashFile, assertSafeRelativePath } from './src/lib/eetf-asset-store.js';
import { EETF_MIGRATIONS, runEetfMigrations, eetfSchemaVersion, EETF_SCHEMA_VERSION } from './src/lib/eetf-schema.js';
import { createEetfDerivationEngine } from './src/lib/eetf-derive.js';
import { createEetfRoute, createEetfRouteFromBoot, createEetfServices } from './src/routes/eetf.js';
import { createComfyUiProvider } from './src/lib/eetf-comfyui-provider.js';
import { openEetfAtBoot, EETF_CERTIFIED } from './src/lib/eetf-boot.js';
import { createImageGenerationRoute } from './src/routes/image-generation.js';
import { enforce as realEnforce } from './src/lib/root-policy/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf-cert-'));
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? hashFile(p) : 'absent');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-version'], { shell: false, windowsHide: true }).status === 0;
const skip = !HAS_FFMPEG && 'no FFmpeg';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (c) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`); return true; };
const J = async (res) => ({ status: res.status, body: await res.json() });
const clean = (b) => { const s = JSON.stringify(b); assert.equal(/\bat [\w.<>]+ \(|[A-Za-z]:\\|\/Users\/|\/tmp\/|SELECT |sqlite|stack|eetf-cert-/i.test(s), false, `no internals: ${s.slice(0, 200)}`); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const realFetch = globalThis.fetch;
const fetched = [];
let realDbBefore; const opened = [];

before(() => {
  realDbBefore = REAL_DB.map(fileHash);
  globalThis.fetch = (url, opts) => { fetched.push(String(url)); return realFetch(url, opts); };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const s of opened) s.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

let n = 0;
const fresh = (name = `s${++n}`) => { const s = EetfStore.open({ dbPath: path.join(TMP, name, 'eetf.sqlite'), assetRoot: path.join(TMP, name, 'root') }); opened.push(s); return s; };

// ── fixtures: REAL files from FFmpeg, then truncated / damaged copies ──
const FX = path.join(TMP, 'fx'); fs.mkdirSync(FX);
const FORMATS = { PNG: 'png', JPEG: 'jpg', WEBP: 'webp', TIFF: 'tiff', EXR: 'exr', HDR: 'hdr' };
const real = {}; const truncated = {};
if (HAS_FFMPEG) {
  const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { windowsHide: true });
  ff('-f', 'lavfi', '-i', 'testsrc=size=256x256', '-frames:v', '1', path.join(FX, 'a.png'));
  for (const [f, ext] of Object.entries(FORMATS)) {
    if (f !== 'PNG') ff('-i', path.join(FX, 'a.png'), ...(f === 'EXR' || f === 'HDR' ? ['-pix_fmt', 'gbrpf32le'] : []), path.join(FX, `a.${ext}`));
    real[f] = fs.readFileSync(path.join(FX, `a.${ext}`));
    truncated[f] = real[f].subarray(0, Math.floor(real[f].length * 0.6));
  }
}
const flip = (b) => { const c = Buffer.from(b); for (let i = Math.floor(b.length * 0.5); i < Math.floor(b.length * 0.5) + 64 && i < b.length; i++) c[i] ^= 0x5a; return c; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); }
function png(w, h, seed = 1, extra = []) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x * 5 + y * 3 + seed * 11) & 0xff;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const MIME = C.FORMAT_MIME;
const DR = (f) => (f === 'EXR' || f === 'HDR' ? 'LDR' : undefined);

/** spawn spy: records every process the engine starts (bin + argv) */
function spySpawn(list, override = null) {
  return (bin, args, opts) => { list.push({ bin, args: [...args], opts }); return override ? override(bin, args, opts) : spawn(bin, args, opts); };
}
const IMAGES = path.join(TMP, 'neuron-images'); fs.mkdirSync(IMAGES);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$/i;
const resolveNeuronImage = (id) => (ID_RE.test(id) ? path.join(IMAGES, id) : null);
const closedPort = await new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('integrity gate: a truncated file is refused on EVERY ingress path, all six formats; valid files accepted; no check file left', { skip }, async () => {
  const store = fresh('ingress');
  const spawned = [];
  const services = createEetfServices({ store, enforce: realEnforce, resolveNeuronImage, deriveOptions: { spawnImpl: spySpawn(spawned) }, providers: [createComfyUiProvider({ endpoint: `http://127.0.0.1:${closedPort}`, enforce: realEnforce, probeTimeoutMs: 500 })] });
  const api = createEetfRoute(services);
  const up = async (buf, mime) => J(await api.request('/assets?name=x', { method: 'POST', headers: { 'content-type': mime }, body: buf }));
  for (const f of Object.keys(FORMATS)) {
    // 1. the store itself (every internal path: derivations, provider outputs, imports end here)
    assert.throws(() => store.registerAsset({ buffer: truncated[f], declaredMime: MIME[f], role: 'SOURCE', contentDynamicRange: DR(f) }), code('EETF_MALFORMED_IMAGE'), `store ${f}`);
    // 2. HTTP upload (EETF-7 route)
    const t = await up(truncated[f], MIME[f]);
    assert.deepEqual([t.status, t.body.error_code], [400, 'MALFORMED_IMAGE'], `upload truncated ${f}`); clean(t.body);
    const ok = await up(real[f], MIME[f]);
    assert.equal(ok.status, 201, `upload valid ${f}: ${JSON.stringify(ok.body)}`);
    if (f === 'EXR' || f === 'HDR') assert.equal(ok.body.asset.dynamicRange, 'LDR_CONTENT_IN_HDR_CONTAINER');
  }
  // 3. Neurone import (EETF-8) and 4. Media Studio import (EETF-8)
  for (const f of ['PNG', 'JPEG', 'WEBP']) {
    const id = `${crypto.randomUUID()}.${{ PNG: 'png', JPEG: 'jpg', WEBP: 'webp' }[f]}`;
    fs.writeFileSync(path.join(IMAGES, id), truncated[f]);
    const r = await J(await api.request('/imports/neuron-image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ imageId: id }) }));
    assert.deepEqual([r.status, r.body.error_code], [415, 'UNSUPPORTED_MEDIA'], `neuron ${f}`);
    const q = new URLSearchParams({ projectId: crypto.randomUUID(), mediaAssetId: crypto.randomUUID(), sha256: sha(truncated[f]) });
    const m = await J(await api.request(`/imports/media-studio?${q}`, { method: 'POST', headers: { 'content-type': MIME[f] }, body: truncated[f] }));
    assert.deepEqual([m.status, m.body.error_code], [415, 'UNSUPPORTED_MEDIA'], `media studio ${f}`);
  }
  // damaged data inside a structurally complete TIFF: caught by the bounded FFmpeg decode check
  const tiffBad = await up(flip(real.TIFF), MIME.TIFF);
  assert.deepEqual([tiffBad.status, tiffBad.body.error_code], [400, 'MALFORMED_IMAGE'], 'damaged TIFF');
  assert.equal((await up(flip(real.PNG), MIME.PNG)).body.error_code, 'MALFORMED_IMAGE', 'damaged PNG (CRC)');
  assert.equal((await up(flip(real.HDR), MIME.HDR)).body.error_code, 'MALFORMED_IMAGE', 'damaged HDR (RLE walk)');
  // the decode check: MEDIA_TRANSCODE before the spawn, -max_pixels, -xerror, file: only, null muxer (no output file)
  const checks = spawned.filter(s => s.args.includes('null'));
  assert.ok(checks.length >= 6, 'one decode check per accepted candidate');
  for (const c of checks) {
    assert.equal(c.opts.shell, false);
    assert.ok(c.args.includes('-xerror') && c.args[c.args.indexOf('-max_pixels') + 1] === String(C.limit('maxPixels')));
    assert.ok(c.args[c.args.indexOf('-i') + 1].startsWith('file:') && c.args.includes('-protocol_whitelist'));
  }
  assert.equal(fs.readdirSync(path.join(store.files.root, 'tmp')).length, 0, 'no check file left');
  assert.equal(store.listAssets({ limit: 200 }).length, 6, 'only the six valid uploads exist');
});

test('integrity gate: provider output (ComfyUI path) truncated → OUTPUT_INVALID, no provenance, no asset', { skip }, async () => {
  const store = fresh('gen');
  const good = png(64, 64, 3);
  let output = good.subarray(0, good.length - 20);
  const provider = {
    providerId: 'fake-local', displayName: 'fake', locality: 'IN_PROCESS',
    probe: async () => ({ providerId: 'fake-local', displayName: 'fake', locality: 'IN_PROCESS', status: 'AVAILABLE', capabilities: ['TXT2IMG', 'SEED', 'NEGATIVE_PROMPT'], models: ['fake-model'], samplers: ['euler'], schedulers: ['normal'], vramTotalMb: 8151, engineVersion: 'fake-1' }),
    generate: async () => ({ promptId: 'p', images: [output] }),
    interrupt: async () => ({ queueDeleteAccepted: true, interruptAccepted: true }),
  };
  const s = createEetfServices({ store, enforce: realEnforce, providers: [provider] });
  const provBefore = store.db.prepare('SELECT COUNT(*) AS n FROM eetf_provenance').get().n;
  const job = await s.generation.submit({ prompt: '<script>alert(1)</script> pierre', width: 64, height: 64, target: 'TEXTURE', textureRole: 'BASE_COLOR', model: 'fake-model' });
  await s.generation.runNext();
  const done = store.getJob(job.id);
  assert.deepEqual([done.status, done.error.code], ['FAILED', 'OUTPUT_INVALID']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM eetf_provenance').get().n, provBefore, 'no orphan provenance');
  assert.equal(store.listAssets().length, 0);
  // a valid output with embedded prompt / workflow text chunks: stored stripped, the prompt lives only in the provenance
  output = png(64, 64, 4, [chunk('tEXt', Buffer.from('prompt\u0000{"secret":"workflow"}', 'latin1')), chunk('tEXt', Buffer.from('workflow\u0000{"nodes":[]}', 'latin1'))]);
  const job2 = await s.generation.submit({ prompt: 'pierre moussue', width: 64, height: 64, target: 'TEXTURE', textureRole: 'BASE_COLOR', model: 'fake-model' });
  await s.generation.runNext();
  const j2 = store.getJob(job2.id);
  assert.equal(j2.status, 'COMPLETED');
  const asset = store.getAsset(j2.outputAssetIds[0]);
  const bytes = fs.readFileSync(store.files.resolveAssetPath(asset.storagePath));
  assert.equal(/tEXt|workflow|secret|prompt/.test(bytes.toString('latin1')), false, 'no embedded prompt / workflow / text chunk');
  assert.equal(store.getProvenance(asset.provenanceId).prompt, 'pierre moussue');
  assert.equal(asset.role, 'GENERATED');
});

test('decode check bounds: Root Policy refusal spawns nothing, timeout kills the tree, single slot, temp quota, disk guard', { skip }, async () => {
  const store = fresh('bounds');
  const spawned = [];
  const deny = (req) => { if (req.action === 'MEDIA_TRANSCODE' && req.context?.stage === 'validate') throw Object.assign(new Error('denied by test policy'), { code: 'ROOT_POLICY_DENIED', rootPolicyDenied: true }); return realEnforce(req); };
  const denied = createEetfDerivationEngine({ store, enforce: deny, spawnImpl: spySpawn(spawned) });
  await assert.rejects(denied.validateDecodable(real.PNG), code('EETF_ROOT_POLICY_DENIED'));
  assert.equal(spawned.filter(s => s.args.includes('null')).length, 0, 'no decode process after a refusal');
  assert.equal(fs.readdirSync(path.join(store.files.root, 'tmp')).length, 0, 'no check file written after a refusal');
  const policies = [];
  const spyPolicy = (req) => { policies.push(req); return realEnforce(req); };
  const watched = createEetfDerivationEngine({ store, enforce: spyPolicy, spawnImpl: spySpawn(spawned) });
  await watched.validateDecodable(real.PNG);
  assert.ok(policies.some(p => p.action === 'MEDIA_TRANSCODE' && p.module === 'media' && p.context.stage === 'validate'), 'MEDIA_TRANSCODE module media before the decode check');
  // timeout: a decoder that hangs (with a grandchild) is killed as a tree
  const pids = [];
  const hang = (bin, args, opts) => {
    if (!args.includes('null')) return spawn(bin, args, opts);
    const p = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});setTimeout(()=>{},60000)"], { ...opts, stdio: ['ignore', 'ignore', 'pipe'] });
    pids.push(p.pid); return p;
  };
  const slow = createEetfDerivationEngine({ store, enforce: realEnforce, spawnImpl: hang, timeoutMs: 1500 });
  const t0 = Date.now();
  const pending = slow.validateDecodable(real.PNG);
  await new Promise(r => setTimeout(r, 200));
  await assert.rejects(slow.validateDecodable(real.PNG), code('EETF_ENGINE_BUSY'), 'single slot');
  await assert.rejects(pending, code('EETF_TIMEOUT'));
  assert.ok(Date.now() - t0 < 10_000);
  await new Promise(r => setTimeout(r, 800));
  assert.equal(pids.some(alive), false, 'decoder tree killed');
  assert.equal(fs.readdirSync(path.join(store.files.root, 'tmp')).length, 0, 'check file removed after a timeout');
  const quota = createEetfDerivationEngine({ store, enforce: realEnforce, tempQuotaBytes: 1000 });
  await assert.rejects(quota.validateDecodable(real.PNG), code('EETF_TEMP_QUOTA'));
  const full = createEetfDerivationEngine({ store, enforce: realEnforce, diskFree: () => 0 });
  await assert.rejects(full.validateDecodable(real.PNG), code('EETF_DISK_LIMIT'), 'disk full simulation');
  const bomb = png(1, 1); bomb.writeUInt32BE(30_000, 16); bomb.writeUInt32BE(30_000, 20);
  await assert.rejects(watched.validateDecodable(bomb), code('EETF_IMAGE_TOO_LARGE'), 'pixel bomb refused before any process');
});

test('schema generations: fresh v4; upgrade from v1 / v2 / v3 keeps data; failed migration rolls back atomically then converges; constraints', () => {
  assert.equal(EETF_SCHEMA_VERSION, 4);
  assert.deepEqual(EETF_MIGRATIONS.map(m => m.version), [1, 2, 3, 4]);
  const freshDb = new Database(':memory:');
  assert.deepEqual(runEetfMigrations(freshDb).applied, [1, 2, 3, 4]);
  const shapeOf = (db) => JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE 'eetf%' AND name <> 'eetf_schema_migrations' ORDER BY name").all()); // the migration ledger table is created by the test here
  const reference = shapeOf(freshDb);
  for (const from of [1, 2, 3]) {
    const file = path.join(TMP, `up-${from}.sqlite`);
    const db = new Database(file);
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE IF NOT EXISTS eetf_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of EETF_MIGRATIONS.filter(x => x.version <= from)) { db.exec(m.sql); db.prepare('INSERT INTO eetf_schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, '2026-10-01T00:00:00.000Z'); }
    db.prepare(`INSERT INTO eetf_assets (asset_id, sha256, mime, actual_format, declared_format, dynamic_range, width, height, has_alpha, size_bytes, storage_path, role, created_at)
      VALUES (?, ?, 'image/png', 'PNG', 'PNG', 'LDR', 4, 4, 0, 10, ?, 'SOURCE', '2026-10-01')`).run(crypto.randomUUID(), 'a'.repeat(64), `assets/aa/${'a'.repeat(64)}.png`);
    db.close();
    const s = EetfStore.open({ dbPath: file, assetRoot: path.join(TMP, `up-root-${from}`) }); opened.push(s);
    assert.equal(s.schemaVersion(), 4, `v${from} → v4`);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM eetf_assets').get().n, 1, `v${from} data kept`);
    assert.equal(shapeOf(s.db), reference, `v${from} upgraded schema identical to a fresh v4`);
    assert.equal(s.db.pragma('foreign_key_check').length, 0);
    assert.equal(s.db.pragma('integrity_check', { simple: true }), 'ok');
  }
  // rollback: an object in the way makes migration 4 fail → still v3, nothing of v4 left; removing it converges
  const file = path.join(TMP, 'rollback.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE eetf_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of EETF_MIGRATIONS.filter(x => x.version <= 3)) { db.exec(m.sql); db.prepare('INSERT INTO eetf_schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 'x'); }
  db.exec('CREATE TABLE eetf_asset_links_external (x)');
  assert.throws(() => runEetfMigrations(db));
  assert.equal(eetfSchemaVersion(db), 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'eetf_asset_links'").get().n, 0, 'migration 4 rolled back as a whole');
  db.exec('DROP TABLE eetf_asset_links_external');
  assert.deepEqual(runEetfMigrations(db).applied, [4]);
  assert.equal(eetfSchemaVersion(db), 4);
  // constraints: CHECK, FK, immutability triggers, indexes
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map(r => r.name);
  for (const t of ['eetf_assets', 'eetf_asset_variants', 'eetf_provenance', 'eetf_provenance_sources', 'eetf_texture_sets', 'eetf_texture_maps', 'eetf_environment_assets', 'eetf_job_outputs', 'eetf_seam_analyses', 'eetf_map_decisions', 'eetf_materials', 'eetf_environment_reports', 'eetf_asset_links']) {
    assert.ok(triggers.includes(`${t}_no_update`) && triggers.includes(`${t}_no_delete`), `${t} immutable`);
  }
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'eetf_asset_links_external'").get());
  db.pragma('foreign_keys = ON');
  assert.throws(() => db.prepare("INSERT INTO eetf_asset_links VALUES ('l', 'missing-asset', 'IMPORT', 'NEURON_IMAGE', 'k', '{}', ?, 'SERVER_RESOLVED', 'x')").run('a'.repeat(64)), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO eetf_assets (asset_id, sha256, mime, actual_format, declared_format, dynamic_range, width, height, size_bytes, storage_path, role, created_at) VALUES ('x', ?, 'm', 'PNG', 'PNG', 'TRUE_HDR', 1, 1, 1, 'p', 'SOURCE', 'x')").run('b'.repeat(64)), /CHECK/, 'TRUE_HDR refused by the schema');
  assert.throws(() => db.prepare("INSERT INTO eetf_assets (asset_id, sha256, mime, actual_format, declared_format, dynamic_range, width, height, size_bytes, storage_path, role, created_at) VALUES ('y', ?, 'm', 'SVG', 'PNG', 'LDR', 1, 1, 1, 'q', 'SOURCE', 'x')").run('c'.repeat(64)), /CHECK/);
  db.close();
});

test('persistence: data written by one Node process is read back by a NEW process — same rows, byte-identical assets, recovery, links, tmp purged', { skip }, () => {
  const dir = path.join(TMP, 'restart');
  const lib = (f) => pathToFileURL(path.join(HERE, 'src', 'lib', f)).href;
  const writer = path.join(TMP, 'writer.mjs');
  fs.writeFileSync(writer, `
    import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
    import { EetfStore } from '${lib('eetf-store.js')}';
    import { createEetfDerivationEngine } from '${lib('eetf-derive.js')}';
    import { createEetfMaterialPipeline } from '${lib('eetf-materials.js')}';
    import { createEetfEnvironmentPipeline } from '${lib('eetf-environments.js')}';
    import { enforce } from '${lib('root-policy/index.js')}';
    const dir = process.argv[2];
    const store = EetfStore.open({ dbPath: path.join(dir, 'eetf.sqlite'), assetRoot: path.join(dir, 'root') });
    const derive = createEetfDerivationEngine({ store, enforce });
    const materials = createEetfMaterialPipeline({ store, derive });
    const environments = createEetfEnvironmentPipeline({ store, derive, materials });
    const png = fs.readFileSync(process.argv[3]); const pano = fs.readFileSync(process.argv[4]);
    const a = store.registerAsset({ buffer: png, declaredMime: 'image/png', role: 'SOURCE', displayName: 'a.png' }).asset;
    const p = store.registerAsset({ buffer: pano, declaredMime: 'image/png', role: 'SOURCE', displayName: 'pano.png' }).asset;
    const done = await derive.run(derive.submit({ sourceAssetId: a.id, operation: 'THUMBNAIL', maxSide: 64 }).id);
    const mat = await materials.createMaterial({ name: 'm', baseColorAssetId: a.id, roughness: { value: 0.5 }, metallic: null, opacity: 'NONE', preview: false });
    const env = await environments.create('PANORAMA_REFERENCE', p.id);
    const link = store.createAssetLink({ assetId: a.id, direction: 'IMPORT', system: 'NEURON_IMAGE', ref: { imageId: '11111111-2222-4333-8444-555555555555.png' }, contentSha256: a.sha256, verification: 'SERVER_RESOLVED' });
    const running = derive.submit({ sourceAssetId: a.id, operation: 'THUMBNAIL', maxSide: 32 }); store.startJob(running.id);
    const queued = derive.submit({ sourceAssetId: a.id, operation: 'THUMBNAIL', maxSide: 16 });
    fs.writeFileSync(path.join(store.files.root, 'tmp', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.part'), 'x');
    fs.writeFileSync(path.join(store.files.root, 'tmp', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.check.png'), 'x');
    fs.writeFileSync(path.join(store.files.root, 'tmp', 'keep-me.txt'), 'not an EETF temp name');
    const assets = store.listAssets({ limit: 200 }).map(x => ({ id: x.id, sha256: x.sha256, path: x.storagePath }));
    console.log(JSON.stringify({ assets, linkAsset: a.id, done: done.status, material: mat.materialId, environment: env.id, link: link.link.id, running: running.id, queued: queued.id }));
    store.close();
  `);
  const reader = path.join(TMP, 'reader.mjs');
  fs.writeFileSync(reader, `
    import path from 'node:path'; import fs from 'node:fs';
    import { openEetfAtBoot } from '${lib('eetf-boot.js')}';
    import { hashFile } from '${lib('eetf-asset-store.js')}';
    const dir = process.argv[2];
    const { store, recovery } = openEetfAtBoot({ env: { DOCTEUR_EETF_DEV_DB: path.join(dir, 'eetf.sqlite'), DOCTEUR_EETF_DEV_ROOT: path.join(dir, 'root') } });
    const w = JSON.parse(process.argv[3]);
    const out = {
      pid: process.pid, version: store.schemaVersion(), recovery,
      assets: w.assets.map(a => ({ id: a.id, same: store.getAsset(a.id).sha256 === a.sha256, bytes: hashFile(store.files.resolveAssetPath(a.path)) === a.sha256 })),
      material: store.getMaterialRecord(w.material).id, environment: store.getEnvironmentAsset(w.environment).type,
      links: store.listAssetLinks(w.linkAsset).map(l => l.id), done: store.listJobs({ limit: 10 }).filter(j => j.status === 'COMPLETED').length,
      running: store.getJob(w.running), queued: store.getJob(w.queued).status, tmp: fs.readdirSync(path.join(dir, 'root', 'tmp')).sort(),
      fk: store.db.pragma('foreign_key_check').length, integrity: store.db.pragma('integrity_check', { simple: true }),
    };
    console.log(JSON.stringify(out));
    store.close();
  `);
  const panoFile = path.join(FX, 'pano.png');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=512x256', '-frames:v', '1', panoFile], { windowsHide: true });
  const w = spawnSync(process.execPath, [writer, dir, path.join(FX, 'a.png'), panoFile], { encoding: 'utf8', windowsHide: true });
  assert.equal(w.status, 0, w.stderr);
  const written = JSON.parse(w.stdout.trim().split('\n').pop());
  const r = spawnSync(process.execPath, [reader, dir, JSON.stringify(written)], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const read = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.notEqual(read.pid, w.pid);
  assert.equal(read.version, 4);
  assert.ok(read.assets.length >= 3 && read.assets.every(a => a.same && a.bytes), 'every asset byte-identical after restart');
  assert.deepEqual([read.material, read.environment, read.links, read.done >= 3], [written.material, 'PANORAMA_REFERENCE', [written.link], true]); // thumbnail + 2 normalisations
  assert.deepEqual([read.running.status, read.running.error.code], ['FAILED', 'PROCESS_RESTARTED'], 'RUNNING → FAILED PROCESS_RESTARTED');
  assert.equal(read.queued, 'QUEUED', 'QUEUED kept (no auto-resume)');
  assert.deepEqual(read.tmp, ['keep-me.txt'], 'EETF temp files purged (.part, .check), foreign names left alone');
  assert.deepEqual([read.fk, read.integrity], [0, 'ok']);
});

test('path / id red team: traversal, absolute, UNC, extended, NUL, reserved, encodings, junction escape — nothing written outside the root', async () => {
  const store = fresh('paths');
  const outside = path.join(TMP, 'paths-outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'marker.txt'), 'm');
  const listOutside = () => JSON.stringify(fs.readdirSync(outside).sort());
  const before = listOutside();
  for (const p of ['../x', '..\\x', 'assets/../../x', 'C:\\Windows\\x', 'c:/x', '\\\\srv\\share\\x', '//srv/share/x', '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', 'a\u0000b', 'CON', 'tmp/nul.txt', 'tmp/com1', 'tmp/x.', 'tmp/x ', 'tmp/a:stream', 'tmp\\..\\..\\x', '']) {
    assert.throws(() => store.files.resolveInside(p), (e) => /EETF_(UNSAFE_PATH|PATH_ESCAPE)/.test(e.code), JSON.stringify(p));
  }
  assert.throws(() => assertSafeRelativePath('assets/../../etc/passwd'), code('EETF_UNSAFE_PATH'));
  // percent-encodings are never decoded by the path layer: they stay literal names INSIDE the root
  for (const p of ['tmp/%2e%2e/x', 'tmp/..%5cx', 'tmp/%252e%252e']) assert.ok(store.files.resolveInside(p).startsWith(store.files.root), p);
  // junction / symlink planted inside the root
  let linked = false;
  try { fs.symlinkSync(outside, path.join(store.files.root, 'thumbs', 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); linked = true; } catch { /* no link permission */ }
  if (linked) {
    assert.throws(() => store.files.resolveInside('thumbs/escape/marker.txt'), code('EETF_SYMLINK_REFUSED'));
    fs.rmSync(path.join(store.files.root, 'thumbs', 'escape'), { recursive: false, force: true });
  }
  assert.throws(() => store.files.removeCheckFile(path.join(outside, 'marker.txt')), code('EETF_UNSAFE_PATH'), 'removeCheckFile confined to tmp/');
  assert.throws(() => store.files.removeCheckFile(path.join(store.files.root, 'tmp', '..', '..', 'paths-outside', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.check.png')), code('EETF_UNSAFE_PATH'));
  // HTTP: malicious ids / hashes / names never read or write a file
  const api = createEetfRoute(createEetfServices({ store, enforce: realEnforce, resolveNeuronImage, providers: [] }));
  for (const id of ['..%2F..%2Fcortex.sqlite', '%2e%2e%5c%2e%2e%5cx', 'C:%5CWindows', "1' OR '1'='1", 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa%00', `${crypto.randomUUID().toUpperCase()}`, '%252e%252e%252f']) {
    const r = await api.request(`/assets/${id}/file`);
    assert.ok([400, 404].includes(r.status), `${id} → ${r.status}`);
    clean(await r.json().catch(() => ({})));
  }
  for (const bad of ['', 'ABC', '../'.repeat(22), 'g'.repeat(64), `${'a'.repeat(64)}\\x`, `${'a'.repeat(63)}/`]) assert.throws(() => store.getAssetBySha(bad), code('EETF_INVALID_HASH'));
  if (HAS_FFMPEG) {
    const up = await J(await api.request(`/assets?name=${encodeURIComponent('..\\..\\CON\u0000<img src=x onerror=1>.png')}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: real.PNG }));
    assert.equal(up.status, 201);
    assert.equal(/[\\/<>\u0000]/.test(up.body.asset.displayName ?? ''), false, 'hostile file name reduced to a label');
    const stored = store.getAsset(up.body.asset.id).storagePath;
    assert.match(stored, /^assets\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/, 'stored by hash only');
  }
  assert.equal(listOutside(), before, '0 write outside the EETF root');
});

test('metadata / privacy: derived outputs carry no EXIF / GPS / comment / text; HDR honesty LDR → EXR / HDR', { skip }, async () => {
  const store = fresh('meta');
  const derive = createEetfDerivationEngine({ store, enforce: realEnforce });
  // JPEG with an EXIF APP1 (GPS tag text) and a COM segment, inserted after SOI
  const seg = (marker, text) => { const d = Buffer.from(text, 'latin1'); const len = Buffer.alloc(2); len.writeUInt16BE(d.length + 2); return Buffer.concat([Buffer.from([0xff, marker]), len, d]); };
  const exif = seg(0xe1, 'Exif\u0000\u0000GPSLatitude=48.85;secret'); const com = seg(0xfe, 'my comment!!!!');
  const jpg = Buffer.concat([real.JPEG.subarray(0, 2), exif, com, real.JPEG.subarray(2)]);
  const src = store.registerAsset({ buffer: jpg, declaredMime: 'image/jpeg', role: 'SOURCE' }).asset;
  assert.equal(src.sha256, sha(jpg), 'a SOURCE stays byte-identical (immutability)');
  for (const format of ['PNG', 'JPEG', 'WEBP', 'TIFF', 'EXR', 'HDR']) {
    const j = await derive.run(derive.submit({ sourceAssetId: src.id, operation: 'CONVERT', format }).id);
    assert.equal(j.status, 'COMPLETED', `${format}: ${JSON.stringify(j.error)}`);
    const out = store.getAsset(j.outputAssetIds[0]);
    const bytes = fs.readFileSync(store.files.resolveAssetPath(out.storagePath)).toString('latin1');
    assert.equal(/GPSLatitude|secret|my comment|Exif\u0000/.test(bytes), false, `${format}: metadata stripped`);
    assert.equal(out.role, 'DERIVED');
    assert.equal(out.dynamicRange, ['EXR', 'HDR'].includes(format) ? 'LDR_CONTENT_IN_HDR_CONTAINER' : 'LDR', `${format}: dynamic range honest`);
  }
  assert.equal(hashFile(store.files.resolveAssetPath(src.storagePath)), sha(jpg), 'source byte-identical after six derivations');
  assert.throws(() => store.registerAsset({ buffer: real.EXR, declaredMime: 'image/x-exr', role: 'SOURCE', contentDynamicRange: 'HDR' }), code('EETF_HDR_CONTENT_NOT_SUPPORTED_V1'));
  assert.equal(Object.values(C.ENVIRONMENT_TYPE).some(t => /HDRI|CUBEMAP|3D_SCENE|CERTIFIED/.test(t)), false, 'no false environment type in the V1 vocabulary');
});

test('concurrency: one FFmpeg slot, ENGINE_BUSY, cancel races and double cancel never corrupt the store', { skip }, async () => {
  const store = fresh('race');
  const derive = createEetfDerivationEngine({ store, enforce: realEnforce });
  const a = store.registerAsset({ buffer: real.PNG, declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const jobs = [32, 48, 64].map(m => derive.submit({ sourceAssetId: a.id, operation: 'THUMBNAIL', maxSide: m }));
  const [r1, r2] = await Promise.all([derive.runNext(), derive.runNext()]);
  assert.ok((r1 === null) !== (r2 === null) || [r1, r2].filter(Boolean).length === 1, 'never two jobs at once');
  const inFlight = derive.run(jobs[1].id);
  await assert.rejects(derive.validateDecodable(real.PNG), code('EETF_ENGINE_BUSY'), 'decode check refused while a derivation runs');
  assert.equal((await inFlight).status, 'COMPLETED');
  while (await derive.runNext()) { /* drain */ }
  // race: cancel while running, twice
  const racing = derive.submit({ sourceAssetId: a.id, operation: 'CONVERT', format: 'TIFF' });
  const running = derive.run(racing.id);
  const c1 = derive.cancel(racing.id).catch(e => e); const c2 = derive.cancel(racing.id).catch(e => e);
  const final = await running; await Promise.all([c1, c2]);
  const j = store.getJob(racing.id);
  assert.ok(['CANCELLED', 'COMPLETED'].includes(j.status), j.status);
  assert.equal(final.status, j.status, 'one terminal state');
  await assert.rejects(derive.cancel(racing.id), (e) => ['EETF_JOB_NOT_CANCELLABLE', 'EETF_INVALID_TRANSITION'].includes(e.code));
  assert.equal(store.listJobs({ limit: 50 }).filter(x => x.status === 'RUNNING').length, 0);
  assert.deepEqual([store.db.pragma('foreign_key_check').length, store.db.pragma('integrity_check', { simple: true })], [0, 'ok']);
  assert.equal(fs.readdirSync(path.join(store.files.root, 'tmp')).length, 0);
});

test('HTTP red team: SQL injection, malformed JSON, unknown / oversized params, NaN / Infinity, huge dimensions / batch, model path injection, hostile prompt', async () => {
  const store = fresh('redteam');
  const api = createEetfRoute(createEetfServices({ store, enforce: realEnforce, providers: [createComfyUiProvider({ endpoint: `http://127.0.0.1:${closedPort}`, enforce: realEnforce, probeTimeoutMs: 500 })] }));
  const post = (p, body, raw = false) => api.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) });
  const n0 = store.db.prepare("SELECT (SELECT COUNT(*) FROM eetf_assets) + (SELECT COUNT(*) FROM eetf_jobs) AS n").get().n;
  for (const id of ["' OR 1=1 --", '1; DROP TABLE eetf_assets', "x' UNION SELECT * FROM eetf_assets --"]) {
    for (const p of [`/assets/${encodeURIComponent(id)}`, `/jobs/${encodeURIComponent(id)}`, `/materials/${encodeURIComponent(id)}`, `/environments/${encodeURIComponent(id)}`]) {
      const r = await J(await api.request(p)); assert.ok([400, 404].includes(r.status), p); clean(r.body);
    }
  }
  const cases = [
    ['/derive', '{"sourceAssetId":', true, 'INVALID_PARAMS'],
    ['/derive', '[1,2]', true, 'INVALID_PARAMS'],
    ['/derive', JSON.stringify({ sourceAssetId: crypto.randomUUID(), operation: 'THUMBNAIL', maxSide: 64, shell: 'rm -rf /' }), true, null],
    ['/derive', JSON.stringify({ x: 'a'.repeat(70 * 1024) }), true, 'PARAMS_TOO_LARGE'],
    ['/derive', '{"sourceAssetId":"' + crypto.randomUUID() + '","operation":"RESIZE","width":1e999,"height":10}', true, null],
    ['/derive', JSON.stringify({ sourceAssetId: crypto.randomUUID(), operation: 'RESIZE', width: 'NaN', height: 10 }), true, null],
    ['/generate', JSON.stringify({ prompt: 'x', width: 100000, height: 100000, target: 'TEXTURE' }), true, null],
    ['/generate', JSON.stringify({ prompt: 'x', width: 512, height: 512, target: 'TEXTURE', batchSize: 99 }), true, null],
    ['/generate', JSON.stringify({ prompt: 'x', width: 512, height: 512, target: 'TEXTURE', model: '../../models/evil.ckpt' }), true, null],
    ['/generate', JSON.stringify({ prompt: '<script>alert(1)</script>'.repeat(10), width: 512, height: 512, target: 'TEXTURE' }), true, null],
    ['/generate', JSON.stringify({ prompt: 'x', width: 512, height: 512, target: 'TEXTURE', workflow: { 1: { class_type: 'ExecuteShell' } } }), true, null],
    ['/environments', JSON.stringify({ type: 'HDRI', assetId: crypto.randomUUID() }), true, null],
    ['/materials', JSON.stringify({ name: 'x', baseColorAssetId: crypto.randomUUID(), normal: { status: 'GENERATED' } }), true, null],
  ];
  for (const [p, body, raw, expect] of cases) {
    const r = await J(await post(p, body, raw));
    assert.ok(r.status >= 400 && r.status < 500, `${p} ${String(body).slice(0, 60)} → ${r.status}`);
    if (expect) assert.equal(r.body.error_code, expect);
    clean(r.body);
  }
  assert.equal(store.db.prepare("SELECT (SELECT COUNT(*) FROM eetf_assets) + (SELECT COUNT(*) FROM eetf_jobs) AS n").get().n, n0, 'refused requests created nothing');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'eetf_assets'").get().n, 1, 'no injected DDL');
});

test('boot gate: a normal start opens nothing — no EETF DB, no table, no folder, no process, no provider call; every route 503', async () => {
  assert.equal(EETF_CERTIFIED, false, 'certification ≠ activation: the constant stays false');
  const before = fetched.length;
  const boot = openEetfAtBoot({ env: {} });
  assert.deepEqual([boot.store, boot.decision.reason], [null, 'EETF_UNCERTIFIED_DISABLED']);
  for (const env of [{ DOCTEUR_EETF_DEV_DB: path.join(HERE, 'data', 'x.sqlite'), DOCTEUR_EETF_DEV_ROOT: path.join(TMP, 'r') }, { DOCTEUR_EETF_DEV_DB: 'relative.sqlite', DOCTEUR_EETF_DEV_ROOT: 'r' }, { DOCTEUR_EETF_DEV_DB: path.join(TMP, 'only.sqlite') }]) {
    assert.equal(openEetfAtBoot({ env }).store, null, JSON.stringify(env));
  }
  const route = createImageGenerationRoute({});
  assert.equal((await J(await route.request('/image-generation/eetf/status'))).body.enabled, false);
  for (const [m, p] of [['GET', '/assets'], ['POST', '/assets'], ['POST', '/derive'], ['POST', '/generate'], ['POST', '/imports/neuron-image'], ['POST', '/imports/media-studio'], ['GET', '/links'], ['POST', '/materials'], ['POST', '/environments'], ['GET', '/jobs']]) {
    assert.equal((await route.request(`/image-generation/eetf${p}`, { method: m })).status, 503, `${m} ${p}`);
  }
  const off = createEetfRouteFromBoot({ enforce: realEnforce, providerEndpoint: () => 'http://127.0.0.1:8188', env: {} });
  assert.equal((await off.request('/assets')).status, 503);
  assert.equal(fetched.length, before, 'no provider probe');
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'eetf')), false);
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'x.sqlite')), false, 'a dev DB inside the user data folder is refused, not created');
  assert.equal(/eetf/i.test(fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8')), false, 'server.js does not know EETF');
});

test('isolation: no network outside loopback, real user DB byte-identical, no Root Policy module "eetf"', () => {
  assert.deepEqual(fetched.filter(u => !/^http:\/\/127\.0\.0\.1:\d+\//.test(u)), []);
  assert.deepEqual(REAL_DB.map(fileHash), realDbBefore);
  const src = ['eetf-derive.js', 'eetf-comfyui-provider.js', 'eetf-integrations.js', 'eetf-materials.js', 'eetf-environments.js', 'eetf-generate.js'].map(f => fs.readFileSync(path.join(HERE, 'src', 'lib', f), 'utf8')).join('\n');
  assert.equal(/module:\s*'eetf'/.test(src), false);
  const actions = [...src.matchAll(/action:\s*'([A-Z_]+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(actions)].sort(), ['MEDIA_TRANSCODE'], 'EETF libs only ask for MEDIA_TRANSCODE (AI_LOCAL_REQUEST lives in the loopback client)');
  assert.match(fs.readFileSync(path.join(HERE, 'src', 'lib', 'providers', 'comfyui.js'), 'utf8'), /action: 'AI_LOCAL_REQUEST', module: 'ai'/);
});

test('defect fixed in EETF-CERT: a default-encoded FFmpeg PNG used as base colour gets a DERIVED normalised copy; the residual identical case is refused clearly', { skip }, async () => {
  const { createEetfMaterialPipeline } = await import('./src/lib/eetf-materials.js');
  const { createEetfEnvironmentPipeline } = await import('./src/lib/eetf-environments.js');
  const store = fresh('normalise');
  const derive = createEetfDerivationEngine({ store, enforce: realEnforce });
  const materials = createEetfMaterialPipeline({ store, derive });
  const src = store.registerAsset({ buffer: real.PNG, declaredMime: 'image/png', role: 'SOURCE' }).asset; // FFmpeg default (paeth) PNG
  const m = await materials.createMaterial({ name: 'ffmpeg-png', baseColorAssetId: src.id, roughness: { value: 0.5 }, metallic: null, opacity: 'NONE', preview: false });
  const view = materials.getMaterial(m.materialId);
  assert.equal(view.baseColor.status, 'DERIVED');
  assert.notEqual(view.baseColor.source.assetId, src.id, 'a distinct normalised asset');
  assert.deepEqual(view.baseColor.source.derivedFrom, [src.id]);
  // the normalised bytes imported as a SOURCE into ANOTHER store: normalising them changes nothing → explicit refusal
  const normalised = fs.readFileSync(store.files.resolveAssetPath(store.getAsset(view.baseColor.source.assetId).storagePath));
  const other = fresh('normalise-2');
  const d2 = createEetfDerivationEngine({ store: other, enforce: realEnforce });
  const m2 = createEetfMaterialPipeline({ store: other, derive: d2 });
  const e2 = createEetfEnvironmentPipeline({ store: other, derive: d2, materials: m2 });
  const again = other.registerAsset({ buffer: normalised, declaredMime: 'image/png', role: 'SOURCE' }).asset;
  await assert.rejects(m2.createMaterial({ name: 'x', baseColorAssetId: again.id, roughness: null, metallic: null, opacity: 'NONE', preview: false }), code('EETF_NORMALISATION_IDENTICAL'));
  const env = await e2.create('BACKGROUND', again.id);
  assert.equal(e2.getEnvironment(env.id).report.normalisedFrom, null, 'environment report does not claim a normalisation that changed nothing');
});

test('defect fixed in EETF-CERT: a job timer that fires during the readiness probe is reported as PROVIDER_TIMEOUT (not "not ready"); nothing is sent', async () => {
  const { createEetfGenerationEngine } = await import('./src/lib/eetf-generate.js');
  const { createProviderRegistry } = await import('./src/lib/eetf-providers.js');
  const store = fresh('probe-timeout');
  let generateCalls = 0;
  const slowProbe = {
    providerId: 'slow-local', displayName: 'slow', locality: 'IN_PROCESS',
    probe: () => new Promise(r => setTimeout(() => r({ providerId: 'slow-local', displayName: 'slow', locality: 'IN_PROCESS', status: 'AVAILABLE', capabilities: ['TXT2IMG', 'SEED', 'NEGATIVE_PROMPT'], models: ['m'], samplers: ['euler'], schedulers: ['normal'], vramTotalMb: 8151, engineVersion: 'x' }), 400)),
    generate: async () => { generateCalls++; return { promptId: 'p', images: [] }; },
    interrupt: async () => ({ queueDeleteAccepted: true, interruptAccepted: true }),
  };
  const registry = createProviderRegistry(); registry.register(slowProbe);
  const engine = createEetfGenerationEngine({ store, registry, providerId: 'slow-local', timeoutMs: 100, pollIntervalMs: 20 });
  const job = await engine.submit({ prompt: 'x', width: 64, height: 64, target: 'TEXTURE', textureRole: 'BASE_COLOR', model: 'm' });
  const r = await engine.run(job.id);
  assert.deepEqual([r.status, r.error.code], ['FAILED', 'PROVIDER_TIMEOUT']);
  assert.match(r.error.message, /no prompt was sent/);
  assert.equal(generateCalls, 0);
});
