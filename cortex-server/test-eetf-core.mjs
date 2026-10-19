// EETF-2 — core contracts + local stores.
// Temporary directories / databases only. No process, no network, no engine:
// the suite counts global fetch calls and scans the EETF sources for any
// process / network primitive. The user database files are hashed (read-only,
// never opened) before and after: they must not change.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

import * as C from './src/lib/eetf-contracts.js';
import { EetfAssetStore, assertSafeRelativePath, sniffImage, USER_DATA_DIR, hashFile } from './src/lib/eetf-asset-store.js';
import { EETF_MIGRATIONS, runEetfMigrations, assertAdditiveSql, eetfSchemaVersion } from './src/lib/eetf-schema.js';
import { EetfStore } from './src/lib/eetf-store.js';
import { resolveEetfBoot, openEetfAtBoot, EETF_CERTIFIED } from './src/lib/eetf-boot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf2-'));
const REAL_DB_FILES = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? hashFile(p) : 'absent');
let realDbBefore;
let fetchCalls = 0;
const realFetch = globalThis.fetch;

before(() => {
  realDbBefore = REAL_DB_FILES.map(fileHash);
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network is not allowed in EETF-2 tests'); };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const s of opened) s.close(); // a failing test may have left its store open
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { console.warn(`temp cleanup: ${e.message}`); }
});

let n = 0;
const opened = [];
const fresh = () => {
  const dir = path.join(TMP, `w${++n}`);
  fs.mkdirSync(dir);
  const store = EetfStore.open({ dbPath: path.join(dir, 'eetf.sqlite'), assetRoot: path.join(dir, 'root') });
  opened.push(store);
  return store;
};
// [EETF-CERT] the store refuses header-only files: registrations use REAL files produced by FFmpeg (test fixtures only;
// the store itself starts no process). The header-only fakes below stay for the pure sniffing assertions.
const HAS_FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-version'], { shell: false, windowsHide: true }).status === 0;
function realImage(format, width, height, { alpha = false } = {}) {
  const ext = { JPEG: 'jpg', WEBP: 'webp', TIFF: 'tiff', EXR: 'exr', HDR: 'hdr' }[format];
  const out = path.join(TMP, `real-${width}x${height}${alpha ? '-a' : ''}.${ext}`);
  if (!fs.existsSync(out)) {
    const pix = format === 'EXR' || format === 'HDR' ? ['-pix_fmt', 'gbrpf32le'] : alpha ? ['-pix_fmt', format === 'WEBP' ? 'yuva420p' : 'rgba'] : [];
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}`, '-frames:v', '1', ...(alpha ? ['-vf', 'format=rgba,colorchannelmixer=aa=0.5'] : []), ...pix, out], { windowsHide: true });
  }
  return fs.readFileSync(out);
}
const code = (c) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`); return true; };

// ── image fixtures ────────────────────────────────────────────────────────

/** A real, decodable PNG (pure JS: zlib + crc32). */
function makePng(width, height, { alpha = false, seed = 1 } = {}) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc((width * ch + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width * ch; x++) raw[y * (width * ch + 1) + 1 + x] = (x * 7 + y * 13 + seed * 31) & 0xff;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** PNG header claiming arbitrary dimensions (a decompression-bomb shape). */
function pngHeader(width, height) {
  const b = makePng(1, 1);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}
function makeJpegHeader(width, height) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
}
function makeWebpVp8x(width, height, alpha) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUInt32LE(10, 16);
  b[20] = alpha ? 0x10 : 0; b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}
function makeTiff(width, height) {
  const b = Buffer.alloc(8 + 2 + 2 * 12 + 4);
  b.write('II*\u0000', 0, 'latin1'); b.writeUInt32LE(8, 4); b.writeUInt16LE(2, 8);
  b.writeUInt16LE(256, 10); b.writeUInt16LE(4, 12); b.writeUInt32LE(1, 14); b.writeUInt32LE(width, 18);
  b.writeUInt16LE(257, 22); b.writeUInt16LE(4, 24); b.writeUInt32LE(1, 26); b.writeUInt32LE(height, 30);
  return b;
}
function makeExr(width, height) {
  const attr = (name, type, value) => Buffer.concat([Buffer.from(`${name}\u0000${type}\u0000`, 'latin1'), (() => { const s = Buffer.alloc(4); s.writeInt32LE(value.length); return s; })(), value]);
  const box = Buffer.alloc(16); box.writeInt32LE(0, 0); box.writeInt32LE(0, 4); box.writeInt32LE(width - 1, 8); box.writeInt32LE(height - 1, 12);
  const chlist = Buffer.concat(['B', 'G', 'R'].map(c => Buffer.concat([Buffer.from(`${c}\u0000`, 'latin1'), Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])])).concat([Buffer.from([0])]));
  const head = Buffer.alloc(8); head.writeUInt32LE(20000630, 0); head.writeUInt32LE(2, 4);
  return Buffer.concat([head, attr('channels', 'chlist', chlist), attr('dataWindow', 'box2i', box), Buffer.from([0]), Buffer.alloc(16)]);
}
const makeHdr = (width, height) => Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n\u0000\u0000\u0000\u0000`, 'latin1');

// ── tests ─────────────────────────────────────────────────────────────────

test('contracts: enums, explicit transitions, limits with basis, typed params, deterministic params hash', () => {
  assert.deepEqual(Object.keys(C.JOB_STATUS), ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
  assert.deepEqual(C.JOB_TRANSITIONS.QUEUED, ['RUNNING', 'CANCELLED']);
  assert.deepEqual(C.JOB_TRANSITIONS.RUNNING, ['COMPLETED', 'FAILED', 'CANCELLED']);
  for (const t of ['COMPLETED', 'FAILED', 'CANCELLED']) assert.deepEqual(C.JOB_TRANSITIONS[t], []);
  assert.ok(Object.isFrozen(C.JOB_TRANSITIONS) && Object.isFrozen(C.RESOURCE_LIMITS.concurrency.value));
  for (const [name, l] of Object.entries(C.RESOURCE_LIMITS)) {
    assert.ok(['PROVISIONAL', 'TO_MEASURE'].includes(l.status) && l.basis.length > 5, name);
    if (l.status === 'TO_MEASURE') assert.equal(l.value, null, `${name} has no invented value`);
  }
  for (const k of ['maxPixels', 'maxFileSize', 'maxBatch', 'timeoutMs', 'concurrency', 'tempQuota', 'vramRequirement']) assert.ok(C.RESOURCE_LIMITS[k], k);
  const a = C.validateJobParams('GENERATE', { prompt: 'stone wall', width: 512, height: 512, target: 'TEXTURE', textureRole: 'BASE_COLOR', seed: 7 });
  const b = C.validateJobParams('GENERATE', { seed: 7, textureRole: 'BASE_COLOR', target: 'TEXTURE', height: 512, width: 512, prompt: 'stone wall' });
  assert.equal(a.paramsHash, b.paramsHash);
  assert.match(a.paramsHash, /^[0-9a-f]{64}$/);
  assert.throws(() => C.validateJobParams('GENERATE', { prompt: 'x', width: 512, height: 512, target: 'IMAGE', command: 'rm -rf /' }), code('EETF_UNKNOWN_PARAM'));
  assert.throws(() => C.validateJobParams('GENERATE', { prompt: 'x', width: 2048, height: 4096, target: 'IMAGE' }), code('EETF_INVALID_NUMBER'));
  assert.throws(() => C.validateJobParams('SHELL', {}), code('EETF_INVALID_JOB_KIND'));
  assert.throws(() => C.validateJobParams('GENERATE', { prompt: 'x', width: 512, height: 512, target: 'ENVIRONMENT' }), code('EETF_REQUIRED_FIELD'));
  assert.throws(() => C.validateJobParams('GENERATE', JSON.parse('{"prompt":"x","width":512,"height":512,"target":"IMAGE","__proto__":{"a":1}}')), code('EETF_UNKNOWN_PARAM'));
});

test('schema: only eetf_* objects, additive DDL, version 4 (EETF-8), foreign tables untouched', () => {
  for (const m of EETF_MIGRATIONS) assert.doesNotThrow(() => assertAdditiveSql(m.sql));
  for (const sql of ['DROP TABLE eetf_jobs', 'ALTER TABLE pages ADD COLUMN x', 'DELETE FROM pages', 'UPDATE pages SET a = 1', 'CREATE TABLE IF NOT EXISTS pages (x)', 'INSERT INTO eetf_jobs VALUES (1)']) {
    assert.throws(() => assertAdditiveSql(sql), /not (additive|an additive)/, sql);
  }
  const db = new Database(':memory:');
  db.exec("CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT); INSERT INTO pages VALUES ('p1', 'kept'); CREATE TABLE metadata (key TEXT, value TEXT); INSERT INTO metadata VALUES ('k', 'v');");
  const fingerprint = () => JSON.stringify([db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name NOT LIKE 'eetf%' ORDER BY name").all(),db.prepare('SELECT * FROM pages').all(), db.prepare('SELECT * FROM metadata').all()]);
  const before = fingerprint();
  assert.deepEqual(runEetfMigrations(db).applied, [1, 2, 3, 4]);
  assert.equal(fingerprint(), before, 'non-EETF schema and rows identical');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT IN ('pages','metadata')").all().map(r => r.name);
  assert.ok(names.length > 10 && names.every(x => x.startsWith('eetf_')), names.join(','));
  for (const t of ['eetf_jobs', 'eetf_assets', 'eetf_asset_variants', 'eetf_provenance', 'eetf_provenance_sources', 'eetf_texture_sets', 'eetf_texture_maps', 'eetf_environment_assets', 'eetf_batches', 'eetf_job_outputs']) assert.ok(names.includes(t), t);
  assert.equal(eetfSchemaVersion(db), 4);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

test('migration: idempotent re-run, re-open no-op, failed migration rolled back then converges', () => {
  const dir = path.join(TMP, 'mig'); fs.mkdirSync(dir);
  const file = path.join(dir, 'm.sqlite');
  const shape = (d) => JSON.stringify(d.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'eetf%' ORDER BY name").all());
  const db = new Database(file);
  runEetfMigrations(db);
  const s1 = shape(db);
  assert.deepEqual(runEetfMigrations(db).applied, []);
  assert.equal(shape(db), s1);
  db.close();
  const store = EetfStore.open({ dbPath: file, assetRoot: path.join(dir, 'root') });
  assert.equal(store.schemaVersion(), 4);
  assert.equal(shape(store.db), s1);
  store.close();
  // crash mid-migration: a conflicting object makes migration 1 fail → nothing of it remains, version 0
  const broken = new Database(':memory:');
  broken.exec('CREATE TABLE eetf_jobs_status (x)');
  assert.throws(() => runEetfMigrations(broken), /already a table named eetf_jobs_status/);
  assert.equal(eetfSchemaVersion(broken), 0);
  assert.equal(broken.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('eetf_jobs','eetf_assets')").get().n, 0);
  broken.exec('DROP TABLE eetf_jobs_status'); // the operator removes the conflict (test fixture only)
  assert.deepEqual(runEetfMigrations(broken).applied, [1, 2, 3, 4]);
  broken.close();
});

test('jobs: every transition of the matrix is either the documented one or refused; transitions always read the current state', () => {
  const s = fresh();
  const p = { prompt: 'sand', width: 256, height: 256, target: 'IMAGE' };
  const make = (status) => {
    const j = s.createJob({ kind: 'GENERATE', params: p, provider: 'comfyui', model: 'sd15.safetensors' });
    if (status === 'QUEUED') return j.id;
    s.startJob(j.id);
    if (status === 'RUNNING') return j.id;
    if (status === 'COMPLETED') s.completeJob(j.id);
    if (status === 'FAILED') s.failJob(j.id, { code: 'GPU_MEMORY', message: 'out of memory' });
    if (status === 'CANCELLED') s.cancelJob(j.id);
    return j.id;
  };
  const ops = { RUNNING: (id) => s.startJob(id), COMPLETED: (id) => s.completeJob(id), FAILED: (id) => s.failJob(id, { code: 'X' }), CANCELLED: (id) => s.cancelJob(id) };
  let allowed = 0; let refused = 0;
  for (const from of Object.keys(C.JOB_STATUS)) {
    for (const to of ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']) {
      const id = make(from);
      if (C.JOB_TRANSITIONS[from].includes(to)) { ops[to](id); assert.equal(s.getJob(id).status, to); allowed++; }
      else { assert.throws(() => ops[to](id), (e) => ['EETF_INVALID_TRANSITION', 'EETF_JOB_NOT_CANCELLABLE'].includes(e.code)); assert.equal(s.getJob(id).status, from); refused++; }
    }
  }
  assert.equal(allowed, 5); assert.equal(refused, 15);
  const j = s.getJob(make('RUNNING'));
  assert.ok(j.startedAt && j.provider === 'comfyui' && j.model === 'sd15.safetensors' && j.paramsHash.length === 64 && j.retryOf === null);
  s.updateProgress(j.id, 0.5);
  assert.throws(() => s.updateProgress(j.id, 0.2), code('EETF_INVALID_PROGRESS'));
  assert.throws(() => s.updateProgress(j.id, 2), code('EETF_INVALID_PROGRESS'));
  const done = s.completeJob(j.id);
  assert.ok(done.completedAt && done.progress === 1);
  // another connection moved the job (fixture): the next operation acts on the CURRENT state, not a cached one
  const q = make('QUEUED');
  s.db.prepare("UPDATE eetf_jobs SET status = 'RUNNING' WHERE job_id = ?").run(q);
  assert.equal(s.cancelJob(q).interruptRequired, true);
  const q2 = make('QUEUED');
  s.db.prepare("UPDATE eetf_jobs SET status = 'CANCELLED' WHERE job_id = ?").run(q2);
  assert.throws(() => s.startJob(q2), code('EETF_INVALID_TRANSITION'));
  assert.throws(() => s.failJob(make('QUEUED'), { code: 'bad code!' }), code('EETF_INVALID_ERROR'));
  assert.throws(() => s.getJob('../etc/passwd'), code('EETF_INVALID_ID'));
  assert.throws(() => s.createJob({ kind: 'GENERATE', params: p, provider: 'comfyui', model: '..\\..\\models\\x.ckpt' }), code('EETF_INVALID_MODEL'));
  s.close();
});

test('cancellation contract: QUEUED / RUNNING cancel, terminal states refuse; nothing is killed here', () => {
  const s = fresh();
  const p = { prompt: 'fog', width: 256, height: 256, target: 'IMAGE' };
  const q = s.createJob({ kind: 'GENERATE', params: p });
  const r1 = s.cancelJob(q.id);
  assert.equal(r1.job.status, 'CANCELLED'); assert.equal(r1.interruptRequired, false); assert.ok(r1.job.cancelledAt);
  assert.equal(r1.job.error.code, 'CANCELLED_BY_USER');
  const r = s.startJob(s.createJob({ kind: 'GENERATE', params: p }).id);
  const r2 = s.cancelJob(r.id);
  assert.equal(r2.job.status, 'CANCELLED'); assert.equal(r2.interruptRequired, true);
  const c = s.startJob(s.createJob({ kind: 'GENERATE', params: p }).id); s.completeJob(c.id);
  const f = s.startJob(s.createJob({ kind: 'GENERATE', params: p }).id); s.failJob(f.id, { code: 'TIMEOUT' });
  assert.throws(() => s.cancelJob(c.id), code('EETF_JOB_NOT_CANCELLABLE'));
  assert.throws(() => s.cancelJob(f.id), code('EETF_JOB_NOT_CANCELLABLE'));
  assert.throws(() => s.cancelJob(q.id), code('EETF_JOB_NOT_CANCELLABLE'));
  assert.equal(s.getJob(c.id).status, 'COMPLETED'); assert.equal(s.getJob(f.id).status, 'FAILED');
  s.close();
});

test('retry: a new job with retryOf; the old job row is byte-identical; limits and non-retryable states', () => {
  const s = fresh();
  const p = { prompt: 'moss', width: 256, height: 256, target: 'IMAGE', seed: 3 };
  const j = s.startJob(s.createJob({ kind: 'GENERATE', params: p, provider: 'comfyui' }).id);
  s.failJob(j.id, { code: 'GPU_MEMORY' });
  const rowBefore = JSON.stringify(s.db.prepare('SELECT * FROM eetf_jobs WHERE job_id = ?').get(j.id));
  const r = s.retryJob(j.id);
  assert.notEqual(r.id, j.id);
  assert.equal(r.retryOf, j.id); assert.equal(r.attempt, 2); assert.equal(r.status, 'QUEUED');
  assert.equal(r.paramsHash, s.getJob(j.id).paramsHash); assert.equal(r.provider, 'comfyui');
  assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM eetf_jobs WHERE job_id = ?').get(j.id)), rowBefore);
  for (const id of [r.id]) assert.throws(() => s.retryJob(id), code('EETF_JOB_NOT_RETRYABLE'));
  let cur = r;
  for (let i = 0; i < 2; i++) { s.cancelJob(cur.id); cur = s.retryJob(cur.id); }
  assert.equal(cur.attempt, 4);
  s.cancelJob(cur.id);
  assert.throws(() => s.retryJob(cur.id), code('EETF_RETRY_LIMIT'));
  const done = s.startJob(s.createJob({ kind: 'GENERATE', params: p }).id); s.completeJob(done.id);
  assert.throws(() => s.retryJob(done.id), code('EETF_JOB_NOT_RETRYABLE'));
  s.close();
});

test('restart recovery: RUNNING → FAILED (PROCESS_RESTARTED), QUEUED kept, tmp purged, nothing resumed', () => {
  const dir = path.join(TMP, 'rec'); fs.mkdirSync(dir);
  const env = { DOCTEUR_EETF_DEV_DB: path.join(dir, 'e.sqlite'), DOCTEUR_EETF_DEV_ROOT: path.join(dir, 'root') };
  const first = openEetfAtBoot({ env });
  assert.ok(first.store);
  const s = first.store;
  const p = { prompt: 'dune', width: 256, height: 256, target: 'IMAGE' };
  const running = s.startJob(s.createJob({ kind: 'GENERATE', params: p }).id);
  const queued = s.createJob({ kind: 'GENERATE', params: p });
  const completed = s.startJob(s.createJob({ kind: 'GENERATE', params: p }).id); s.completeJob(completed.id);
  fs.writeFileSync(path.join(env.DOCTEUR_EETF_DEV_ROOT, 'tmp', 'orphan.part'), 'partial');
  s.close(); // the process "dies"
  const second = openEetfAtBoot({ env });
  assert.deepEqual({ ...second.recovery }, { interrupted: 1, queuedLeft: 1, tmpPurged: 1, resumed: 0 });
  const s2 = second.store;
  const r = s2.getJob(running.id);
  assert.equal(r.status, 'FAILED'); assert.equal(r.error.code, 'PROCESS_RESTARTED'); assert.ok(r.failedAt);
  assert.equal(s2.getJob(queued.id).status, 'QUEUED');
  assert.equal(s2.getJob(completed.id).status, 'COMPLETED');
  assert.equal(fs.readdirSync(path.join(env.DOCTEUR_EETF_DEV_ROOT, 'tmp')).length, 0);
  assert.equal(s2.recoverAfterRestart().interrupted, 0, 'idempotent');
  s2.close();
});

test('batch: validated as a whole, items isolated, counts per latest attempt, size bound', () => {
  const s = fresh();
  const item = (prompt) => ({ params: { prompt, width: 256, height: 256, target: 'IMAGE' }, provider: 'comfyui' });
  const b = s.createBatch({ kind: 'GENERATE', items: [item('a'), item('b'), item('c')], label: 'trois essais' });
  assert.equal(b.total, 3); assert.equal(b.queued, 3); assert.equal(b.outcome, 'IN_PROGRESS');
  const [j0, j1, j2] = b.items.map(i => i.jobId);
  s.startJob(j0); s.completeJob(j0);
  s.startJob(j1); s.failJob(j1, { code: 'GPU_MEMORY' });
  s.cancelJob(j2);
  const b2 = s.getBatch(b.id);
  assert.deepEqual([b2.completed, b2.failed, b2.cancelled, b2.total, b2.outcome], [1, 1, 1, 3, 'PARTIAL']);
  assert.equal(s.getJob(j0).status, 'COMPLETED', 'a failed item does not touch the others');
  const retry = s.retryJob(j1);
  s.startJob(retry.id); s.completeJob(retry.id);
  const b3 = s.getBatch(b.id);
  assert.equal(b3.items[1].jobId, retry.id); assert.equal(b3.items[1].attempt, 2);
  assert.deepEqual([b3.completed, b3.failed, b3.cancelled], [2, 0, 1]);
  const jobsBefore = s.db.prepare('SELECT COUNT(*) AS n FROM eetf_jobs').get().n;
  assert.throws(() => s.createBatch({ kind: 'GENERATE', items: [item('ok'), { params: { prompt: 'x', width: 1, height: 1, target: 'IMAGE' } }] }), code('EETF_INVALID_NUMBER'));
  assert.throws(() => s.createBatch({ kind: 'GENERATE', items: [1, 2, 3, 4, 5].map(i => item(String(i))) }), code('EETF_BATCH_TOO_LARGE'));
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM eetf_jobs').get().n, jobsBefore, 'a refused batch writes nothing');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM eetf_batches').get().n, 1);
  s.close();
});

test('content-addressed storage: path from sha256, idempotent duplicate, immutable file and row', () => {
  const s = fresh();
  const png = makePng(32, 16, { seed: 5 });
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  const { asset, existed } = s.registerAsset({ buffer: png, declaredMime: 'image/png', role: 'SOURCE', displayName: '../../evil<name>.png' });
  assert.equal(existed, false);
  assert.equal(asset.sha256, sha);
  assert.equal(asset.storagePath, `assets/${sha.slice(0, 2)}/${sha}.png`);
  assert.deepEqual([asset.width, asset.height, asset.sizeBytes, asset.mime, asset.actualFormat, asset.declaredFormat, asset.dynamicRange], [32, 16, png.length, 'image/png', 'PNG', 'PNG', 'LDR']);
  assert.equal(asset.displayName, 'evilname.png', 'a display name is a label, never a path');
  const abs = s.files.resolveAssetPath(asset.storagePath);
  assert.equal(hashFile(abs), sha);
  const mtime = fs.statSync(abs).mtimeMs;
  const again = s.registerAsset({ buffer: Buffer.from(png), declaredMime: 'image/png', role: 'SOURCE' });
  assert.equal(again.existed, true); assert.equal(again.asset.id, asset.id);
  assert.equal(fs.statSync(abs).mtimeMs, mtime, 'never rewritten');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM eetf_assets').get().n, 1);
  // immutable: the file is read-only, the row cannot be updated or deleted
  assert.throws(() => fs.writeFileSync(abs, 'x'), (e) => ['EPERM', 'EACCES'].includes(e.code));
  assert.throws(() => s.db.prepare('UPDATE eetf_assets SET width = 1 WHERE asset_id = ?').run(asset.id), /EETF_IMMUTABLE/);
  assert.throws(() => s.db.prepare('DELETE FROM eetf_assets WHERE asset_id = ?').run(asset.id), /EETF_IMMUTABLE/);
  // tampering is detected and never "repaired" by overwriting
  fs.chmodSync(abs, 0o644); fs.writeFileSync(abs, Buffer.concat([png, Buffer.from('x')])); fs.chmodSync(abs, 0o444);
  assert.equal(s.verifyAsset(asset.id), false);
  assert.throws(() => s.registerAsset({ buffer: png, declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_STORE_CORRUPTED'));
  assert.equal(fs.statSync(abs).size, png.length + 1, 'the tampered file is left for inspection, not overwritten');
  s.close();
});

test('formats: header sniffing for PNG / JPEG / WebP / TIFF / EXR / HDR; LDR content in HDR containers labelled', () => {
  const cases = [
    [makePng(20, 10, { alpha: true }), 'PNG', 20, 10, true],
    [makeJpegHeader(640, 480), 'JPEG', 640, 480, false],
    [makeWebpVp8x(300, 200, true), 'WEBP', 300, 200, true],
    [makeTiff(128, 64), 'TIFF', 128, 64, false],
    [makeExr(64, 32), 'EXR', 64, 32, false],
    [makeHdr(64, 32), 'HDR', 64, 32, false],
  ];
  for (const [buf, format, w, h, alpha] of cases) assert.deepEqual(sniffImage(buf), { format, width: w, height: h, hasAlpha: alpha }, format);
  const s = fresh();
  // [EETF-CERT] a header without image data is refused (no identity for a truncated file), every format
  for (const [buf, format] of cases.slice(1)) {
    assert.throws(() => s.registerAsset({ buffer: buf, declaredMime: C.FORMAT_MIME[format], role: 'SOURCE', contentDynamicRange: ['EXR', 'HDR'].includes(format) ? 'LDR' : undefined }), code('EETF_MALFORMED_IMAGE'), `header-only ${format}`);
  }
  if (!HAS_FFMPEG) { s.close(); return; }
  const real = [[cases[0][0], 'PNG'], ...['JPEG', 'WEBP', 'TIFF', 'EXR', 'HDR'].map(f => [realImage(f, 64, 32, { alpha: f === 'WEBP' }), f])];
  for (const [buf, format] of real) {
    const mime = C.FORMAT_MIME[format];
    if (format === 'EXR' || format === 'HDR') {
      assert.throws(() => s.registerAsset({ buffer: buf, declaredMime: mime, role: 'SOURCE' }), code('EETF_DYNAMIC_RANGE_REQUIRED'));
      assert.throws(() => s.registerAsset({ buffer: buf, declaredMime: mime, role: 'SOURCE', contentDynamicRange: 'HDR' }), code('EETF_HDR_CONTENT_NOT_SUPPORTED_V1'));
      const { asset } = s.registerAsset({ buffer: buf, declaredMime: mime, role: 'SOURCE', contentDynamicRange: 'LDR' });
      assert.equal(asset.dynamicRange, 'LDR_CONTENT_IN_HDR_CONTAINER');
    } else {
      const { asset } = s.registerAsset({ buffer: buf, declaredMime: mime, role: 'SOURCE' });
      assert.deepEqual([asset.actualFormat, asset.declaredFormat, asset.dynamicRange], [format, format, 'LDR']);
    }
  }
  s.close();
});

test('security: fake MIME, SVG, oversized dimensions (before any write), file size, invalid hash, malformed headers', () => {
  const s = fresh();
  const tmpDir = path.join(s.files.root, 'tmp');
  assert.throws(() => s.registerAsset({ buffer: makePng(4, 4), declaredMime: 'image/jpeg', role: 'SOURCE' }), code('EETF_MIME_MISMATCH'));
  assert.throws(() => s.registerAsset({ buffer: Buffer.from('<svg onload="alert(1)"/>'), declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_UNSUPPORTED_FORMAT'));
  assert.throws(() => s.registerAsset({ buffer: Buffer.from('<?xml version="1.0"?><svg/>'), declaredMime: 'image/svg+xml', role: 'SOURCE' }), code('EETF_UNSUPPORTED_MIME'));
  assert.throws(() => s.registerAsset({ buffer: pngHeader(100_000, 100_000), declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_IMAGE_TOO_LARGE'));
  assert.throws(() => s.registerAsset({ buffer: pngHeader(4096, 4097), declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_IMAGE_TOO_LARGE'));
  assert.throws(() => s.registerAsset({ buffer: pngHeader(0, 10), declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_MALFORMED_IMAGE'));
  assert.throws(() => s.registerAsset({ buffer: makeHdr(200_000, 2), declaredMime: 'image/vnd.radiance', role: 'SOURCE', contentDynamicRange: 'LDR' }), code('EETF_IMAGE_TOO_LARGE'));
  assert.throws(() => s.registerAsset({ buffer: Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\nnot a resolution\n', 'latin1'), declaredMime: 'image/vnd.radiance', role: 'SOURCE', contentDynamicRange: 'LDR' }), code('EETF_MALFORMED_IMAGE'));
  const big = Buffer.alloc(C.limit('maxFileSize') + 1); makePng(1, 1).copy(big);
  assert.throws(() => s.registerAsset({ buffer: big, declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_FILE_TOO_LARGE'));
  assert.throws(() => s.registerAsset({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), declaredMime: 'image/jpeg', role: 'SOURCE' }), code('EETF_MALFORMED_IMAGE'));
  assert.equal(fs.readdirSync(tmpDir).length, 0, 'refused inputs never reach the disk');
  assert.equal(fs.readdirSync(path.join(s.files.root, 'assets')).length, 0);
  for (const bad of ['', 'ABC', '../'.repeat(22), 'g'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\\x`]) {
    assert.throws(() => s.getAssetBySha(bad), code('EETF_INVALID_HASH'), bad);
    assert.throws(() => EetfAssetStore.storagePathFor(bad, 'PNG'), code('EETF_INVALID_HASH'));
  }
  assert.throws(() => s.registerAsset({ buffer: makePng(2, 2), declaredMime: 'image/png', role: 'GENERATED' }), code('EETF_PROVENANCE_REQUIRED'));
  assert.throws(() => s.registerAsset({ buffer: makePng(2, 2), declaredMime: 'image/png', role: 'SOURCE', displayName: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }), code('EETF_SECRET_FIELD_REFUSED'));
  s.close();
});

test('path safety: traversal, absolute, drive, UNC, device, reserved names, NUL, ADS, forged storage paths', () => {
  const s = fresh();
  const evil = ['../x', 'assets/../../x', '..\\..\\x', '/etc/passwd', 'C:\\Windows\\system32', 'c:x', 'D:/data', '\\\\server\\share\\x', '//server/share/x',
    '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', 'assets/CON', 'assets/nul.png', 'assets/COM1.txt', 'assets/lpt9', 'a\u0000b', 'assets/x. ', 'assets/x.', 'file.png:stream', 'assets//x', './x', ''];
  for (const p of evil) {
    assert.throws(() => assertSafeRelativePath(p), code('EETF_UNSAFE_PATH'), JSON.stringify(p));
    assert.throws(() => s.files.resolveInside(p), code('EETF_UNSAFE_PATH'), JSON.stringify(p));
  }
  const sha = 'ab'.padEnd(64, 'c');
  for (const forged of [`assets/cd/${sha}.png`, `assets/ab/${sha}.exe`, `assets/ab/../${sha}.png`, `tmp/${sha}.png`, `C:/assets/ab/${sha}.png`, `assets\\ab\\${sha}.png`]) {
    assert.throws(() => s.files.resolveAssetPath(forged), code('EETF_UNSAFE_PATH'), forged);
  }
  for (const id of ['../x', 'C:\\x', '\\\\srv\\x', 'a/b', '00000000-0000-4000-8000-00000000000\u0000']) {
    assert.throws(() => s.getAsset(id), code('EETF_INVALID_ID'));
    assert.throws(() => s.getJob(id), code('EETF_INVALID_ID'));
  }
  assert.throws(() => new EetfAssetStore({ root: 'relative/root' }), code('EETF_UNSAFE_ROOT'));
  assert.throws(() => new EetfAssetStore({ root: '\\\\server\\share\\eetf' }), code('EETF_UNSAFE_ROOT'));
  s.close();
});

test('symlink / junction escape: a linked shard, a linked tmp or a linked root is refused; nothing written outside', () => {
  const s = fresh();
  const outside = path.join(TMP, `outside-${n}`); fs.mkdirSync(outside);
  const png = makePng(6, 6, { seed: 42 });
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  fs.symlinkSync(outside, path.join(s.files.root, 'assets', sha.slice(0, 2)), 'junction');
  assert.throws(() => s.registerAsset({ buffer: png, declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_SYMLINK_REFUSED'));
  assert.equal(fs.readdirSync(outside).length, 0, 'nothing escaped');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM eetf_assets').get().n, 0);
  fs.rmSync(path.join(s.files.root, 'tmp'), { recursive: true });
  fs.symlinkSync(outside, path.join(s.files.root, 'tmp'), 'junction');
  assert.throws(() => s.files.purgeTmp(), code('EETF_SYMLINK_REFUSED'));
  assert.throws(() => s.registerAsset({ buffer: makePng(7, 7), declaredMime: 'image/png', role: 'SOURCE' }), code('EETF_SYMLINK_REFUSED'));
  assert.equal(fs.readdirSync(outside).length, 0);
  const linkedRoot = path.join(TMP, `linked-root-${n}`);
  fs.symlinkSync(outside, linkedRoot, 'junction');
  assert.throws(() => new EetfAssetStore({ root: linkedRoot }), code('EETF_UNSAFE_ROOT'));
  s.close();
});

test('provenance: every field kept, sources + derived-from, immutable, secrets / unknown fields refused', () => {
  const s = fresh();
  const src = s.registerAsset({ buffer: makePng(8, 8, { seed: 9 }), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const prov = s.createProvenance({
    provider: 'comfyui', model: 'v1-5-pruned-emaonly-fp16.safetensors', prompt: 'mossy cobblestones', negativePrompt: 'blurry', seed: 123456789,
    width: 512, height: 512, parameters: { steps: 20, cfg: 7, sampler: 'euler' }, sources: [{ assetId: src.id, relation: 'DERIVED_FROM' }], engineVersion: '0.3.x', strictLocal: true,
  });
  assert.deepEqual([prov.provider, prov.model, prov.prompt, prov.negativePrompt, prov.seed, prov.width, prov.height], ['comfyui', 'v1-5-pruned-emaonly-fp16.safetensors', 'mossy cobblestones', 'blurry', 123456789, 512, 512]);
  assert.deepEqual(prov.parameters, { cfg: 7, sampler: 'euler', steps: 20 });
  assert.deepEqual(prov.derivedFrom, [src.id]); assert.ok(prov.createdAt); assert.equal(prov.strictLocal, true);
  const derived = s.registerAsset({ buffer: makePng(8, 8, { seed: 10 }), declaredMime: 'image/png', role: 'DERIVED', provenanceId: prov.id }).asset;
  assert.equal(derived.provenanceId, prov.id);
  assert.throws(() => s.db.prepare('UPDATE eetf_provenance SET prompt = ? WHERE provenance_id = ?').run('x', prov.id), /EETF_IMMUTABLE/);
  assert.throws(() => s.db.prepare('DELETE FROM eetf_provenance_sources').run(), /EETF_IMMUTABLE/);
  const base = { provider: 'comfyui', prompt: 'x' };
  assert.throws(() => s.createProvenance({ ...base, apiKey: 'abc' }), code('EETF_UNKNOWN_FIELD'));
  assert.throws(() => s.createProvenance({ ...base, parameters: { api_key: 'abc' } }), code('EETF_SECRET_FIELD_REFUSED'));
  assert.throws(() => s.createProvenance({ ...base, parameters: { note: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456' } }), code('EETF_SECRET_FIELD_REFUSED'));
  assert.throws(() => s.createProvenance({ ...base, prompt: 'token: Bearer abcdefghijklmnopqrstuvwxyz0123' }), code('EETF_SECRET_FIELD_REFUSED'));
  assert.throws(() => s.createProvenance({ ...base, prompt: 'p'.repeat(C.limit('maxPromptChars') + 1) }), code('EETF_TEXT_TOO_LONG'));
  assert.throws(() => s.createProvenance({ ...base, parameters: { blob: 'x'.repeat(C.limit('maxParamsBytes')) } }), code('EETF_PARAMS_TOO_LARGE'));
  assert.throws(() => s.createProvenance({ ...base, sources: [{ assetId: crypto.randomUUID() }] }), code('EETF_ASSET_NOT_FOUND'));
  assert.throws(() => s.registerAsset({ buffer: makePng(3, 3), declaredMime: 'image/png', role: 'DERIVED', provenanceId: s.createProvenance(base).id }), code('EETF_PROVENANCE_REQUIRED'));
  s.close();
});

test('variants: logical records, idempotent, a new operation is a new record, never self', () => {
  const s = fresh();
  const a = s.registerAsset({ buffer: makePng(16, 16, { seed: 1 }), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const b = s.registerAsset({ buffer: makePng(8, 8, { seed: 1 }), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const v1 = s.createVariant({ sourceAssetId: a.id, variantAssetId: b.id, operation: 'RESIZE', params: { width: 8, height: 8 } });
  const v2 = s.createVariant({ sourceAssetId: a.id, variantAssetId: b.id, operation: 'RESIZE', params: { height: 8, width: 8 } });
  assert.equal(v1.existed, false); assert.equal(v2.existed, true); assert.equal(v2.variant.id, v1.variant.id);
  const v3 = s.createVariant({ sourceAssetId: a.id, variantAssetId: b.id, operation: 'THUMBNAIL', params: { side: 8 } });
  assert.notEqual(v3.variant.id, v1.variant.id);
  assert.equal(s.listVariants(a.id).length, 2);
  assert.throws(() => s.createVariant({ sourceAssetId: a.id, variantAssetId: a.id, operation: 'RESIZE' }), code('EETF_INVALID_VARIANT'));
  assert.throws(() => s.createVariant({ sourceAssetId: a.id, variantAssetId: b.id, operation: 'SHELL' }), code('EETF_INVALID_VARIANT'));
  assert.throws(() => s.db.prepare('UPDATE eetf_asset_variants SET operation = ?').run('CROP'), /EETF_IMMUTABLE/);
  s.close();
});

test('texture sets: 8 roles always reported, honest statuses, UNSUPPORTED has no asset, badge never over-claims', () => {
  // EETF-5 tightened the V1 table: NORMAL / HEIGHT / AO / EMISSIVE are UNSUPPORTED, OPACITY only FROM_SOURCE_ALPHA,
  // and a GENERATED / DERIVED claim must match the asset's real role.
  const s = fresh();
  const prov = s.createProvenance({ provider: 'fake', prompt: 'moss' });
  const base = s.registerAsset({ buffer: makePng(16, 16, { seed: 2 }), declaredMime: 'image/png', role: 'GENERATED', provenanceId: prov.id }).asset;
  const imported = s.registerAsset({ buffer: makePng(16, 16, { seed: 4 }), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const alpha = s.registerAsset({ buffer: makePng(16, 16, { seed: 3, alpha: true }), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const set = s.createTextureSet({
    name: 'Pavés moussus', tileable: { metric: 0.031 },
    maps: [
      { role: 'BASE_COLOR', status: 'GENERATED', assetId: base.id },
      { role: 'ROUGHNESS', status: 'USER_CONSTANT', constantValue: 0.8 },
      { role: 'OPACITY', status: 'FROM_SOURCE_ALPHA', assetId: alpha.id },
    ],
  });
  assert.deepEqual(set.maps.map(m => m.role), C.TEXTURE_ROLES);
  const by = Object.fromEntries(set.maps.map(m => [m.role, m]));
  for (const r of ['NORMAL', 'METALLIC', 'HEIGHT', 'AMBIENT_OCCLUSION', 'EMISSIVE']) assert.deepEqual([by[r].status, by[r].assetId, by[r].exists], ['UNSUPPORTED', null, false], r);
  assert.equal(by.ROUGHNESS.constantValue, 0.8); assert.equal(by.ROUGHNESS.assetId, null);
  assert.equal(set.badge, 'PARTIAL_MATERIAL'); assert.deepEqual(set.tileable, { checked: true, metric: 0.031 });
  const reject = [
    [{ role: 'NORMAL', status: 'GENERATED', assetId: base.id }, 'EETF_MAP_STATUS_NOT_SUPPORTED_V1'],
    [{ role: 'NORMAL', status: 'ESTIMATED', assetId: base.id }, 'EETF_MAP_STATUS_NOT_SUPPORTED_V1'],
    [{ role: 'HEIGHT', status: 'ESTIMATED', assetId: base.id }, 'EETF_MAP_STATUS_NOT_SUPPORTED_V1'],
    [{ role: 'AMBIENT_OCCLUSION', status: 'ESTIMATED', assetId: base.id }, 'EETF_MAP_STATUS_NOT_SUPPORTED_V1'],
    [{ role: 'EMISSIVE', status: 'USER_CONSTANT', constantValue: [1, 1, 1] }, 'EETF_MAP_STATUS_NOT_SUPPORTED_V1'],
    [{ role: 'OPACITY', status: 'USER_CONSTANT', constantValue: 0.5 }, 'EETF_MAP_STATUS_NOT_SUPPORTED_V1'],
    [{ role: 'METALLIC', status: 'DERIVED', assetId: base.id }, 'EETF_MAP_STATUS_NOT_SUPPORTED_V1'],
    [{ role: 'BASE_COLOR', status: 'GENERATED', assetId: imported.id }, 'EETF_MAP_ORIGIN_MISMATCH'],
    [{ role: 'BASE_COLOR', status: 'DERIVED', assetId: imported.id }, 'EETF_MAP_ORIGIN_MISMATCH'],
    [{ role: 'ROUGHNESS', status: 'UNSUPPORTED', assetId: base.id }, 'EETF_UNSUPPORTED_MAP_HAS_ASSET'],
    [{ role: 'OPACITY', status: 'FROM_SOURCE_ALPHA', assetId: base.id }, 'EETF_NO_SOURCE_ALPHA'],
    [{ role: 'GLOSSINESS', status: 'DERIVED', assetId: base.id }, 'EETF_UNKNOWN_TEXTURE_ROLE'],
    [{ role: 'BASE_COLOR', status: 'MAGIC', assetId: base.id }, 'EETF_UNKNOWN_MAP_STATUS'],
    [{ role: 'BASE_COLOR', status: 'GENERATED' }, 'EETF_INVALID_ID'],
    [{ role: 'ROUGHNESS', status: 'USER_CONSTANT', constantValue: 3 }, 'EETF_INVALID_CONSTANT'],
    [{ role: 'BASE_COLOR', status: 'USER_CONSTANT', constantValue: 0.5 }, 'EETF_INVALID_CONSTANT'],
  ];
  for (const [map, c] of reject) assert.throws(() => s.createTextureSet({ name: 't', maps: [map] }), code(c), JSON.stringify(map));
  assert.equal(s.createTextureSet({ name: 'vide' }).badge, 'EMPTY');
  assert.equal(s.createTextureSet({ name: 'albedo', maps: [{ role: 'BASE_COLOR', status: 'GENERATED', assetId: base.id }] }).badge, 'BASE_COLOR_ONLY');
  assert.equal(C.materialBadge(C.TEXTURE_ROLES.map(role => ({ role, status: 'GENERATED' }))), 'PBR_COMPLETE', 'the badge logic itself');
  assert.throws(() => s.db.prepare("UPDATE eetf_texture_maps SET status = 'GENERATED'").run(), /EETF_IMMUTABLE/);
  s.close();
});

test('environments: 4 V1 types; HDRI / certified equirectangular / cubemap / 3D scene refused; panorama honesty', () => {
  // EETF-6: panoramas are ≥ 512 px wide and 2:1 within a PROVISIONAL tolerance; a measured low seam is a
  // measurement label, never "verified"; every panorama says NOT_CERTIFIED_EQUIRECTANGULAR.
  const s = fresh();
  const flat = s.registerAsset({ buffer: makePng(64, 48), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const pano = s.registerAsset({ buffer: makePng(512, 256, { seed: 8 }), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const near = s.registerAsset({ buffer: makePng(512, 257, { seed: 9 }), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const small = s.registerAsset({ buffer: makePng(64, 32, { seed: 10 }), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const exr = HAS_FFMPEG ? s.registerAsset({ buffer: realImage('EXR', 512, 256), declaredMime: 'image/x-exr', role: 'SOURCE', contentDynamicRange: 'LDR' }).asset : null; // [EETF-CERT] real EXR
  assert.equal(s.createEnvironmentAsset({ assetId: flat.id, type: 'BACKGROUND' }).projection, 'FLAT');
  assert.equal(s.createEnvironmentAsset({ assetId: flat.id, type: 'SCENE_REFERENCE' }).labels.length, 0);
  const p = s.createEnvironmentAsset({ assetId: pano.id, type: 'PANORAMA_REFERENCE' });
  assert.deepEqual([p.projection, p.seamCheck, p.labels], ['PANORAMA_2_1_REFERENCE', 'NOT_CHECKED', ['NOT_SEAM_VERIFIED', 'NOT_CERTIFIED_EQUIRECTANGULAR']]);
  assert.deepEqual({ ...p.claims }, { hdri: false, trueHdr: false, certifiedEquirectangular: false, cubemap: false, scene3d: false });
  const checked = s.createEnvironmentAsset({ assetId: pano.id, type: 'PANORAMA_REFERENCE', seamCheck: 'PASSED', seamMetric: 0.004 });
  assert.deepEqual(checked.labels, ['LOW_HORIZONTAL_SEAM_MEASURED', 'NOT_CERTIFIED_EQUIRECTANGULAR']);
  assert.ok(s.createEnvironmentAsset({ assetId: near.id, type: 'PANORAMA_REFERENCE' }).labels.includes('NOT_EXACT_2_TO_1'), 'near-2:1 accepted and labelled');
  assert.throws(() => s.createEnvironmentAsset({ assetId: small.id, type: 'PANORAMA_REFERENCE' }), code('EETF_PANORAMA_TOO_SMALL'));
  const sky = s.createEnvironmentAsset({ assetId: pano.id, type: 'SKYBOX_PREVIEW', basedOnEnvironmentId: p.id });
  assert.equal(sky.basedOnEnvironmentId, p.id); assert.ok(sky.labels.includes('PREVIEW_ONLY'));
  if (exr) {
    const ldrInHdr = s.createEnvironmentAsset({ assetId: exr.id, type: 'PANORAMA_REFERENCE' });
    assert.deepEqual(ldrInHdr.labels, ['NOT_SEAM_VERIFIED', 'NOT_CERTIFIED_EQUIRECTANGULAR', 'LDR_CONTENT_IN_HDR_CONTAINER']);
  }
  for (const t of ['HDRI', 'CERTIFIED_EQUIRECTANGULAR', 'CUBEMAP', '3D_SCENE']) assert.throws(() => s.createEnvironmentAsset({ assetId: pano.id, type: t }), code('EETF_ENVIRONMENT_TYPE_UNSUPPORTED'), t);
  assert.throws(() => s.createEnvironmentAsset({ assetId: pano.id, type: 'WORLD' }), code('EETF_UNKNOWN_ENVIRONMENT_TYPE'));
  assert.throws(() => s.createEnvironmentAsset({ assetId: flat.id, type: 'PANORAMA_REFERENCE' }), code('EETF_PANORAMA_ASPECT'));
  assert.throws(() => s.createEnvironmentAsset({ assetId: pano.id, type: 'SKYBOX_PREVIEW', basedOnEnvironmentId: s.createEnvironmentAsset({ assetId: flat.id, type: 'BACKGROUND' }).id }), code('EETF_INVALID_ENVIRONMENT'));
  assert.throws(() => s.createEnvironmentAsset({ assetId: pano.id, type: 'PANORAMA_REFERENCE', seamCheck: 'PASSED' }), code('EETF_INVALID_ENVIRONMENT'));
  assert.throws(() => C.validateJobParams('GENERATE', { prompt: 'sky', width: 1024, height: 512, target: 'ENVIRONMENT', environmentType: 'HDRI' }), code('EETF_ENVIRONMENT_TYPE_UNSUPPORTED'));
  s.close();
});

test('provider descriptor: loopback-only local engine, no credentials, no secret-looking fields, model names not paths', () => {
  const d = C.validateProviderDescriptor({
    id: 'comfyui', kind: 'LOCAL', transport: 'LOOPBACK_HTTP', status: 'UNAVAILABLE', endpoint: 'http://127.0.0.1:8188/',
    capabilities: { txt2img: true, seed: true, negativePrompt: true, maxPixels: 4194304 }, models: [{ name: 'v1-5-pruned-emaonly-fp16.safetensors' }],
  });
  assert.equal(d.endpoint, 'http://127.0.0.1:8188');
  assert.deepEqual({ ...d.capabilities }, { txt2img: true, img2img: false, tiling: false, negativePrompt: true, seed: true, maxPixels: 4194304 });
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.models[0]));
  const base = { id: 'comfyui', kind: 'LOCAL', transport: 'LOOPBACK_HTTP', endpoint: 'http://127.0.0.1:8188' };
  const bad = [
    [{ ...base, endpoint: 'http://192.168.1.20:8188' }, 'EETF_PROVIDER_NOT_LOOPBACK'],
    [{ ...base, endpoint: 'https://127.0.0.1:8188' }, 'EETF_PROVIDER_NOT_LOOPBACK'],
    [{ ...base, endpoint: 'http://user:pass@127.0.0.1:8188' }, 'EETF_SECRET_FIELD_REFUSED'],
    [{ ...base, apiKey: 'x' }, 'EETF_UNKNOWN_FIELD'],
    [{ ...base, capabilities: { txt2img: true, token: 'x' } }, 'EETF_SECRET_FIELD_REFUSED'],
    [{ ...base, engineVersion: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, 'EETF_SECRET_FIELD_REFUSED'],
    [{ ...base, capabilities: { teleport: true } }, 'EETF_UNKNOWN_FIELD'],
    [{ ...base, models: [{ name: 'C:\\models\\x.ckpt' }] }, 'EETF_INVALID_MODEL'],
    [{ ...base, kind: 'CLOUD' }, 'EETF_INVALID_PROVIDER'],
    [{ id: 'Evil Provider', kind: 'LOCAL', transport: 'IN_PROCESS' }, 'EETF_INVALID_PROVIDER'],
    [{ id: 'comfyui', kind: 'LOCAL', transport: 'LOOPBACK_HTTP' }, 'EETF_INVALID_PROVIDER'],
  ];
  for (const [desc, c] of bad) assert.throws(() => C.validateProviderDescriptor(desc), code(c), JSON.stringify(desc));
});

test('boot gate: normal boot opens nothing; dev store only on a separate DB + root outside the user data directory', () => {
  assert.equal(EETF_CERTIFIED, false);
  const off = openEetfAtBoot({ env: {} });
  assert.equal(off.store, null); assert.equal(off.decision.reason, 'EETF_UNCERTIFIED_DISABLED');
  assert.equal(resolveEetfBoot({ env: { DOCTEUR_EETF_DEV_DB: path.join(TMP, 'x.sqlite') } }).reason, 'EETF_DEV_CONFIG_INCOMPLETE');
  assert.equal(resolveEetfBoot({ env: { DOCTEUR_EETF_DEV_DB: 'rel.sqlite', DOCTEUR_EETF_DEV_ROOT: 'rel' } }).reason, 'EETF_DEV_PATH_NOT_ABSOLUTE');
  for (const env of [
    { DOCTEUR_EETF_DEV_DB: path.join(USER_DATA_DIR, 'cortex.sqlite'), DOCTEUR_EETF_DEV_ROOT: path.join(TMP, 'r') },
    { DOCTEUR_EETF_DEV_DB: path.join(TMP, 'e.sqlite'), DOCTEUR_EETF_DEV_ROOT: path.join(USER_DATA_DIR, 'eetf') },
  ]) {
    assert.equal(resolveEetfBoot({ env }).reason, 'EETF_DEV_PATH_IN_USER_DATA');
    assert.equal(openEetfAtBoot({ env }).store, null);
  }
  assert.throws(() => EetfStore.open({ dbPath: path.join(USER_DATA_DIR, 'cortex.sqlite'), assetRoot: path.join(TMP, 'r2') }), code('EETF_DB_IN_USER_DATA'));
  assert.throws(() => new EetfAssetStore({ root: path.join(USER_DATA_DIR, 'eetf') }), code('EETF_ROOT_IN_USER_DATA'));
  assert.equal(fs.existsSync(path.join(USER_DATA_DIR, 'eetf')), false, 'no cortex-server/data/eetf folder');
  // the normal server boot does not even import EETF in EETF-2
  const server = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  assert.equal(/eetf/i.test(server), false);
});

test('isolation: no process / network primitive in EETF sources, no destructive public API, 0 fetch, user DB unchanged', () => {
  const files = ['eetf-contracts.js', 'eetf-asset-store.js', 'eetf-schema.js', 'eetf-store.js', 'eetf-boot.js'].map(f => [f, fs.readFileSync(path.join(HERE, 'src', 'lib', f), 'utf8')]);
  for (const [f, src] of files) {
    const code_ = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const re of [/child_process/, /\bspawn\b/, /\bexec(File|Sync)\b/,/\bfetch\s*\(/, /node:(http|https|net|dgram|tls)/, /ollama/i, /comfyui\.js/, /image-router/, /safeFetch/]) {
      assert.equal(re.test(code_), false, `${f} must not use ${re}`);
    }
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const i of imports) assert.ok(['node:crypto', 'node:fs', 'node:path', 'node:url', 'better-sqlite3', './notebook-security.js'].includes(i) || i.startsWith('./eetf-'), `${f} imports ${i}`);
  }
  const api = Object.getOwnPropertyNames(EetfStore.prototype);
  assert.equal(api.filter(m => /^(reset|drop|truncate|delete|remove|clear|wipe|purge|destroy)/i.test(m)).length, 0, api.join(','));
  assert.equal(fetchCalls, 0);
  assert.deepEqual(REAL_DB_FILES.map(fileHash), realDbBefore, 'user database files byte-identical');
});
