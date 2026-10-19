// Native Recorder — RECORDER-1 suite: catalogue, capture protocol, confinement, safe open, recovery, route factory.
// Temporary roots only (os.tmpdir()); synthetic bytes only (a WebM / MP4 header + filler — never a real capture);
// a sentinel file OUTSIDE the Recorder root proves no write / delete / open can reach it. No network, no process
// except the crash child, no FFmpeg; the real user data directory is never opened.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as C from './src/lib/recorder-contracts.js';
import { RecorderStore, RECORDER_SCHEMA_VERSION } from './src/lib/recorder-store.js';
import { createRecorderService, downloadFilename } from './src/lib/recorder-service.js';
import { createRecorderRoute, RECORDER_SESSION_HEADER } from './src/routes/recorder.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder1-'));
const SENTINEL_DIR = path.join(TMP, 'outside');
const SENTINEL = path.join(SENTINEL_DIR, 'RECORDER_SENTINEL_DO_NOT_TOUCH');
const SENTINEL_BYTES = Buffer.from('RECORDER_SENTINEL_DO_NOT_TOUCH — secret bytes that must never be written, deleted or opened\n');
const REAL_DATA = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const code = (c) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`); return true; };
let realBefore; let fetchCalls = 0; const realFetch = globalThis.fetch; const opened = [];
before(() => {
  realBefore = REAL_DATA.map(fileHash);
  globalThis.fetch = async () => { fetchCalls++; throw new Error('no network in RECORDER-1 tests'); };
  fs.mkdirSync(SENTINEL_DIR, { recursive: true }); fs.writeFileSync(SENTINEL, SENTINEL_BYTES);
});
after(() => {
  globalThis.fetch = realFetch;
  for (const s of opened) { try { s.close(); } catch { /* closed */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

const WEBM = (n = 200) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]), crypto.randomBytes(n)]);
const MP4 = (n = 200) => Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(4), crypto.randomBytes(n)]);
let clockMs = Date.parse('2026-10-16T14:00:00.000Z');
const clock = () => clockMs;
let n = 0;
function fresh({ limits = {}, io = undefined, root = null } = {}) {
  const r = root ?? path.join(TMP, `root-${++n}`);
  const store = RecorderStore.open({ root: r, now: clock }); opened.push(store);
  const svc = createRecorderService({ store, io, limits: { minFreeBytes: 0, ...limits } });
  return { store, svc, root: store.root };
}
async function record(svc, { type = 'SCREEN', mimeType = 'video/webm;codecs=vp9,opus', chunks = [WEBM(), crypto.randomBytes(300)], title } = {}) {
  const s = svc.createSession({ type, mimeType, title });
  svc.markStarted(s);
  chunks.forEach((bytes, seq) => svc.appendChunk({ ...s, seq, bytes }));
  return { s, out: await svc.finalize({ ...s, durationMs: 1234, width: 1280, height: 720 }) };
}
const sentinelIntact = () => fs.existsSync(SENTINEL) && fs.readFileSync(SENTINEL).equals(SENTINEL_BYTES);
const noPath = (value, root) => {
  const s = JSON.stringify(value);
  for (const needle of [root, root.replaceAll('\\', '\\\\'), os.tmpdir(), 'partial/', 'files/', '.partial']) assert.equal(s.includes(needle), false, `leaks ${needle}`);
};

// ── model, ids, store ──

test('catalogue: schema v1, separate store (metadata only, no blob), statuses / types / transitions, limits PROVISIONAL', () => {
  const { store } = fresh();
  assert.equal(RECORDER_SCHEMA_VERSION, 1); assert.equal(store.schemaVersion(), 1);
  const cols = store.db.prepare('PRAGMA table_info(recorder_recordings)').all();
  assert.equal(cols.some(c => /BLOB/i.test(c.type)), false, 'no blob column');
  assert.deepEqual(fs.readdirSync(store.root).sort().filter(f => !f.startsWith('recorder.sqlite-')), ['files', 'partial', 'recorder.sqlite']);
  assert.deepEqual(C.RECORDING_TYPES, ['SCREEN', 'CAMERA', 'SCREEN_WITH_MIC', 'CAMERA_WITH_MIC']);
  assert.deepEqual(Object.keys(C.RECORDING_STATUS), ['PREPARING', 'RECORDING', 'FINALIZING', 'READY', 'FAILED', 'CANCELLED', 'DELETING', 'MISSING']);
  assert.equal(C.canTransition('FINALIZING', 'READY'), true);
  for (const from of ['PREPARING', 'RECORDING', 'FAILED', 'CANCELLED', 'DELETING', 'READY']) assert.equal(C.canTransition(from, 'READY'), false, `${from} → READY refused`);
  for (const [k, v] of Object.entries(C.RECORDER_LIMITS)) assert.ok(v.value > 0 && v.status === 'PROVISIONAL' && v.basis.length > 10, k);
  // the DB refuses a READY row without file, checksum or size
  assert.throws(() => store.db.prepare("INSERT INTO recorder_recordings (recording_id, type, status, title, declared_mime, created_at, updated_at, has_audio) VALUES (?, 'SCREEN', 'READY', 't', 'video/webm', 'x', 'x', 0)").run(`rec_${'a'.repeat(32)}`), /CHECK/);
  store.audit('RECORDING_CREATED', `rec_${'a'.repeat(32)}`, {});
  assert.throws(() => store.db.prepare('UPDATE recorder_audit SET event = event').run(), /REC_IMMUTABLE/);
  assert.throws(() => store.db.prepare('DELETE FROM recorder_audit').run(), /REC_IMMUTABLE/);
  assert.throws(() => store.audit('RECORDING_CREATED', 'x', { where: 'C:\\Users\\me\\video.webm' }), code('INTERNAL'), 'no private path in the audit');
});

test('recordingId: server-generated, unpredictable, unique; malformed / traversal / UNC / encoded ids refused everywhere', async () => {
  const { svc, store } = fresh({ limits: { maxActiveRecordings: 1 } });
  const ids = new Set();
  for (let i = 0; i < 20; i++) { const s = svc.createSession({ type: 'CAMERA', mimeType: 'video/webm' }); assert.match(s.recordingId, /^rec_[0-9a-f]{32}$/); ids.add(s.recordingId); svc.cancel(s); }
  assert.equal(ids.size, 20);
  const bad = ['../x', '..\\x', '%2e%2e%2f', '%252e%252e', 'C:\\Windows\\win.ini', 'C:/x', '\\\\server\\share\\x', '//server/share', `rec_${'a'.repeat(31)}`, `REC_${'a'.repeat(32)}`, `rec_${'A'.repeat(32)}`,
    `rec_${'a'.repeat(32)}\u0000`, `rec_${'a'.repeat(32)}.`, `rec_${'a'.repeat(32)} `, `rec_${'a'.repeat(30)}/..`, `rec_${'a'.repeat(32)}/../x`, '', null, 42, { id: 1 }, SENTINEL];
  for (const id of bad) {
    assert.throws(() => svc.getRecording(id), code('INVALID_RECORDING_ID'), String(id));
    assert.throws(() => svc.deleteRecording(id), code('INVALID_RECORDING_ID'));
    await assert.rejects(svc.openRecording(id), code('INVALID_RECORDING_ID'));
    assert.throws(() => svc.appendChunk({ recordingId: id, sessionToken: 'x', seq: 0, bytes: WEBM() }), code('INVALID_RECORDING_ID'));
    await assert.rejects(svc.finalize({ recordingId: id, sessionToken: 'x' }), code('INVALID_RECORDING_ID'));
    assert.throws(() => svc.cancel({ recordingId: id, sessionToken: 'x' }), code('INVALID_RECORDING_ID'));
  }
  for (const key of ['../outside/RECORDER_SENTINEL_DO_NOT_TOUCH', 'files/../../outside/x', SENTINEL, 'files/rec_x.webm', `files/rec_${'a'.repeat(32)}.exe`, `files\\rec_${'a'.repeat(32)}.webm`, `other/rec_${'a'.repeat(32)}.webm`]) {
    assert.throws(() => store.resolveKey(key), code('INVALID_KEY'), key);
  }
  assert.throws(() => svc.getRecording(`rec_${'b'.repeat(32)}`), code('RECORDING_NOT_FOUND'));
  assert.ok(sentinelIntact());
});

test('capture protocol: create → start → ordered chunks → finalize → READY original bytes (no transcode), metadata, SHA-256, public view without paths', async () => {
  const { svc, store, root } = fresh();
  const chunks = [WEBM(500), crypto.randomBytes(1000), crypto.randomBytes(10)];
  const s = svc.createSession({ type: 'SCREEN_WITH_MIC', mimeType: 'video/webm;codecs=vp8,opus', title: 'Démo écran — réunion 🎥' });
  assert.deepEqual(Object.keys(s).sort(), ['maxChunkBytes', 'maxDurationMs', 'maxRecordingBytes', 'recordingId', 'sessionToken', 'status']);
  assert.equal(svc.getRecording(s.recordingId).status, 'PREPARING');
  assert.throws(() => svc.appendChunk({ ...s, seq: 0, bytes: chunks[0] }), code('RECORDING_NOT_ACTIVE'), 'no data before start');
  assert.equal(svc.markStarted(s).status, 'RECORDING');
  assert.throws(() => svc.markStarted(s), code('ILLEGAL_TRANSITION'));
  assert.equal(fs.existsSync(path.join(root, 'partial', `${s.recordingId}.partial`)), true, 'partial file while recording');
  chunks.forEach((bytes, seq) => assert.equal(svc.appendChunk({ ...s, seq, bytes }).seq, seq));
  assert.notEqual(svc.getRecording(s.recordingId).status, 'READY', 'a partial is never READY');
  const out = await svc.finalize({ ...s, durationMs: 4200, width: 1920, height: 1080 });
  assert.equal(out.status, 'READY');
  const r = out.recording;
  const all = Buffer.concat(chunks);
  assert.deepEqual([r.type, r.source, r.hasAudio, r.mimeType, r.sizeBytes, r.durationMs, r.width, r.height, r.metadataSource, r.chunkCount],
    ['SCREEN_WITH_MIC', 'SCREEN', true, 'video/webm;codecs=vp8,opus', all.length, 4200, 1920, 1080, 'CLIENT_REPORTED', 3]);
  assert.equal(r.checksumSha256, crypto.createHash('sha256').update(all).digest('hex'));
  assert.equal(r.title, 'Démo écran — réunion 🎥', 'Unicode title kept');
  assert.equal(r.filename, 'Démo écran — réunion 🎥.webm');
  const final = path.join(root, 'files', `${s.recordingId}.webm`);
  assert.ok(fs.readFileSync(final).equals(all), 'the stored file is byte-for-byte the MediaRecorder output');
  assert.equal(fs.existsSync(path.join(root, 'partial', `${s.recordingId}.partial`)), false, 'partial renamed away (atomic rename)');
  noPath([s, out, svc.getRecording(s.recordingId), svc.listRecordings(), store.listAudit()], root);
  assert.deepEqual(store.listAudit(s.recordingId).map(a => a.event), ['RECORDING_CREATED', 'RECORDING_STARTED', 'RECORDING_FINALIZED']);
  // MP4 honesty: an MP4 MediaRecorder output stays .mp4 / video/mp4; a WebM never becomes .mp4
  const m = await record(svc, { type: 'CAMERA', mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', chunks: [MP4(400)] });
  assert.deepEqual([m.out.recording.mimeType, m.out.recording.filename.endsWith('.mp4')], ['video/mp4;codecs=avc1,mp4a.40.2', true]);
  const lie = svc.createSession({ type: 'CAMERA', mimeType: 'video/mp4' }); svc.markStarted(lie);
  assert.throws(() => svc.appendChunk({ ...lie, seq: 0, bytes: WEBM() }), code('MIME_MISMATCH'));
  assert.deepEqual([svc.getRecording(lie.recordingId).status, svc.getRecording(lie.recordingId).error], ['FAILED', 'MIME_MISMATCH']);
  for (const mt of ['video/x-matroska', 'audio/webm', 'video/webm; codecs=vp9"><script>', 'text/html', '', null, 'video/mp4\r\nX: y']) assert.throws(() => svc.createSession({ type: 'SCREEN', mimeType: mt }), code('UNSUPPORTED_MIME'), String(mt));
  assert.throws(() => svc.createSession({ type: 'MICROPHONE', mimeType: 'video/webm' }), code('INVALID_TYPE'));
  assert.throws(() => svc.createSession({ type: 'DEVICE_CAPTURE', mimeType: 'video/webm' }), code('INVALID_TYPE'));
});

test('chunks: session token required, strict sequence (gap / out-of-order refused, exact repeat of the last chunk acknowledged once), size limits', async () => {
  const { svc, root } = fresh({ limits: { maxChunkBytes: 1024, maxRecordingBytes: 4096 } });
  const s = svc.createSession({ type: 'CAMERA', mimeType: 'video/webm' }); svc.markStarted(s);
  assert.throws(() => svc.appendChunk({ ...s, sessionToken: 'wrong', seq: 0, bytes: WEBM() }), code('SESSION_TOKEN_INVALID'));
  assert.throws(() => svc.appendChunk({ recordingId: s.recordingId, seq: 0, bytes: WEBM() }), code('SESSION_TOKEN_INVALID'));
  assert.throws(() => svc.appendChunk({ ...s, seq: 1, bytes: WEBM() }), code('CHUNK_GAP'));
  const c0 = WEBM(100);
  svc.appendChunk({ ...s, seq: 0, bytes: c0 });
  assert.deepEqual(svc.appendChunk({ ...s, seq: 0, bytes: c0 }), { seq: 0, duplicate: true, received: c0.length }, 'exact repeat acknowledged, not written');
  assert.throws(() => svc.appendChunk({ ...s, seq: 0, bytes: crypto.randomBytes(10) }), code('CHUNK_OUT_OF_ORDER'), 'same seq, other bytes');
  svc.appendChunk({ ...s, seq: 1, bytes: crypto.randomBytes(100) });
  assert.throws(() => svc.appendChunk({ ...s, seq: 0, bytes: c0 }), code('CHUNK_OUT_OF_ORDER'), 'an old chunk is no duplicate any more');
  for (const [seq, bytes, c] of [[-1, WEBM(), 'INVALID_SEQUENCE'], [1.5, WEBM(), 'INVALID_SEQUENCE'], ['2', WEBM(), 'INVALID_SEQUENCE'], [2, Buffer.alloc(0), 'INVALID_CHUNK'], [2, 'text', 'INVALID_CHUNK'], [2, crypto.randomBytes(1025), 'CHUNK_TOO_LARGE']]) {
    assert.throws(() => svc.appendChunk({ ...s, seq, bytes }), code(c), `${seq}/${c}`);
  }
  assert.equal(fs.statSync(path.join(root, 'partial', `${s.recordingId}.partial`)).size, c0.length + 100, 'refused chunks wrote nothing');
  for (let i = 2; i < 5; i++) svc.appendChunk({ ...s, seq: i, bytes: crypto.randomBytes(1000) });
  assert.throws(() => svc.appendChunk({ ...s, seq: 5, bytes: crypto.randomBytes(1000) }), code('RECORDING_TOO_LARGE'));
  const r = svc.getRecording(s.recordingId);
  assert.deepEqual([r.status, r.error, r.recoverable], ['FAILED', 'RECORDING_TOO_LARGE', true], 'the bytes captured so far are kept, classified, never READY');
  assert.throws(() => svc.appendChunk({ ...s, seq: 5, bytes: crypto.randomBytes(10) }), code('SESSION_NOT_FOUND'));
  // duration limit
  const d = fresh({ limits: { maxDurationMs: 1000 } }).svc;
  const sd = d.createSession({ type: 'SCREEN', mimeType: 'video/webm' }); d.markStarted(sd);
  d.appendChunk({ ...sd, seq: 0, bytes: WEBM() });
  clockMs += 1500;
  assert.throws(() => d.appendChunk({ ...sd, seq: 1, bytes: crypto.randomBytes(10) }), code('RECORDING_TOO_LONG'));
});

test('zero-byte never READY; short valid recording READY; cancel removes the partial; one active recording at a time', async () => {
  const { svc, root } = fresh();
  const z = svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' }); svc.markStarted(z);
  const zr = await svc.finalize(z);
  assert.deepEqual([zr.status, zr.error, zr.recording.status, zr.recording.recoverable], ['FAILED', 'EMPTY_RECORDING', 'FAILED', false]);
  assert.equal(fs.readdirSync(path.join(root, 'partial')).length, 0, 'empty partial removed');
  const never = svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' });
  assert.equal((await svc.finalize(never)).error, 'EMPTY_RECORDING', 'finalize without start or data');
  const short = await record(svc, { chunks: [WEBM(20)] });
  assert.equal(short.out.status, 'READY');
  const a = svc.createSession({ type: 'CAMERA_WITH_MIC', mimeType: 'video/webm' });
  assert.throws(() => svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' }), code('RECORDER_BUSY'), 'second concurrent start refused');
  svc.markStarted(a); svc.appendChunk({ ...a, seq: 0, bytes: WEBM() });
  const c = svc.cancel(a);
  assert.deepEqual([c.status, c.sizeBytes], ['CANCELLED', 0]);
  assert.equal(fs.existsSync(path.join(root, 'partial', `${a.recordingId}.partial`)), false);
  assert.throws(() => svc.cancel(a), code('SESSION_NOT_FOUND'));
  const b = svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' }); svc.markStarted(b);
  assert.equal(b.status, 'PREPARING', 'a new recording after cancel');
  svc.appendChunk({ ...b, seq: 0, bytes: WEBM() });
  // the client vanished (tab closed): after the idle window the slot is released; the bytes are kept, never READY
  clockMs += C.RECORDER_LIMITS.sessionIdleMs.value + 1;
  const c2 = svc.createSession({ type: 'CAMERA', mimeType: 'video/webm' });
  const abandoned = svc.getRecording(b.recordingId);
  assert.deepEqual([abandoned.status, abandoned.error, abandoned.recoverable], ['FAILED', 'SESSION_ABANDONED', true]);
  assert.throws(() => svc.appendChunk({ ...b, seq: 1, bytes: WEBM() }), code('SESSION_NOT_FOUND'));
  svc.cancel(c2);
});

test('list (bounded, paginated, deterministic order), get, delete by id (metadata + file), DELETE_INCOMPLETE honest, missing file → MISSING', async () => {
  const { svc, store, root } = fresh();
  const ids = [];
  for (let i = 0; i < 5; i++) { clockMs += 1000; ids.push((await record(svc, { title: `Rec ${i}` })).s.recordingId); }
  const p1 = svc.listRecordings({ limit: 2 });
  assert.deepEqual([p1.total, p1.items.length, p1.nextOffset], [5, 2, 2]);
  assert.deepEqual(p1.items.map(i => i.recordingId), [ids[4], ids[3]], 'newest first');
  const p3 = svc.listRecordings({ limit: 2, offset: 4 });
  assert.deepEqual([p3.items.map(i => i.recordingId), p3.nextOffset], [[ids[0]], null]);
  assert.equal(svc.listRecordings({ status: 'READY', limit: 100 }).total, 5);
  for (const [o, c] of [[{ limit: 0 }, 'INVALID_LIMIT'], [{ limit: 101 }, 'INVALID_LIMIT'], [{ offset: -1 }, 'INVALID_OFFSET'], [{ status: 'DROP' }, 'INVALID_STATUS']]) assert.throws(() => svc.listRecordings(o), code(c));
  // delete
  const del = svc.deleteRecording(ids[0]);
  assert.deepEqual(del, { status: 'DELETED', recordingId: ids[0] });
  assert.equal(fs.existsSync(path.join(root, 'files', `${ids[0]}.webm`)), false);
  assert.throws(() => svc.getRecording(ids[0]), code('RECORDING_NOT_FOUND'), 'metadata removed');
  assert.ok(store.listAudit(ids[0]).some(a => a.event === 'RECORDING_DELETED'), 'audit keeps the id');
  // missing file
  fs.unlinkSync(path.join(root, 'files', `${ids[1]}.webm`));
  await assert.rejects(svc.openRecording(ids[1]), code('RECORDING_FILE_MISSING'));
  assert.equal(svc.getRecording(ids[1]).status, 'MISSING');
  assert.equal(svc.deleteRecording(ids[1]).status, 'DELETED', 'a MISSING recording can be deleted');
  // missing metadata: an orphan file is reported, never adopted or deleted silently
  const orphan = path.join(root, 'files', `rec_${'c'.repeat(32)}.webm`); fs.writeFileSync(orphan, WEBM());
  assert.equal((await svc.recoverAfterRestart()).orphanFiles, 1);
  assert.ok(fs.existsSync(orphan));
  // DELETE_INCOMPLETE: the file cannot be removed
  const failingIo = { ...ioDefault(), unlink: (p) => { if (p.includes(ids[2])) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); fs.unlinkSync(p); } };
  const s2 = createRecorderService({ store, io: failingIo, limits: { minFreeBytes: 0 } });
  const inc = s2.deleteRecording(ids[2]);
  assert.deepEqual([inc.status, inc.retryable, inc.remaining[0].store, inc.remaining[0].reason], ['DELETE_INCOMPLETE', true, 'files', 'EBUSY']);
  assert.deepEqual([svc.getRecording(ids[2]).status, svc.getRecording(ids[2]).error], ['DELETING', 'DELETE_INCOMPLETE']);
  assert.equal(svc.deleteRecording(ids[2]).status, 'DELETED', 'retry by the user completes');
  // an active recording cannot be deleted
  const act = svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' });
  assert.throws(() => svc.deleteRecording(act.recordingId), code('RECORDING_ACTIVE'));
  svc.cancel(act);
  noPath([p1, p3, inc, del], root);
});
function ioDefault() {
  return { open: (p, f) => fs.openSync(p, f), close: (fd) => fs.closeSync(fd), fstat: (fd) => fs.fstatSync(fd, { bigint: true }), lstat: (p) => fs.lstatSync(p, { bigint: true }),
    write: (fd, b, o, l, pos) => fs.writeSync(fd, b, o, l, pos), fsync: (fd) => fs.fsyncSync(fd), read: (fd, b, o, l, pos) => new Promise((res, rej) => fs.read(fd, b, o, l, pos, (e, k) => (e ? rej(e) : res(k)))),
    rename: (a, b) => fs.renameSync(a, b), unlink: (p) => fs.unlinkSync(p), statfs: (p) => fs.statfsSync(p) };
}

test('disk full / write failure / finalize failure: FAILED with an honest code, captured bytes kept and classified, never READY', async () => {
  // not enough space at start: nothing created
  let free = 100;
  const lowIo = { ...ioDefault(), statfs: () => ({ bavail: free, bsize: 1 }) };
  const { svc, root } = fresh({ io: lowIo, limits: { minFreeBytes: 1000 } });
  assert.throws(() => svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' }), code('DISK_FULL'));
  assert.equal(svc.listRecordings().total, 0);
  // space runs out during the capture
  free = 1_000_000;
  const s = svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' }); svc.markStarted(s);
  svc.appendChunk({ ...s, seq: 0, bytes: WEBM(500) });
  free = 1200;
  assert.throws(() => svc.appendChunk({ ...s, seq: 1, bytes: crypto.randomBytes(500) }), code('DISK_FULL'));
  assert.deepEqual([svc.getRecording(s.recordingId).status, svc.getRecording(s.recordingId).recoverable], ['FAILED', true]);
  // ENOSPC from the OS while writing
  const enospc = fresh({ io: { ...ioDefault(), write: () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); } } }).svc;
  const e1 = enospc.createSession({ type: 'SCREEN', mimeType: 'video/webm' }); enospc.markStarted(e1);
  assert.throws(() => enospc.appendChunk({ ...e1, seq: 0, bytes: WEBM() }), code('DISK_FULL'));
  assert.deepEqual([enospc.getRecording(e1.recordingId).status, enospc.getRecording(e1.recordingId).recoverable], ['FAILED', false], 'nothing written: empty partial removed');
  // generic write failure after some data
  let calls = 0;
  const eio = fresh({ io: { ...ioDefault(), write: (...a) => { if (++calls > 1) throw Object.assign(new Error('io'), { code: 'EIO' }); return fs.writeSync(...a); } } }).svc;
  const e2 = eio.createSession({ type: 'SCREEN', mimeType: 'video/webm' }); eio.markStarted(e2);
  eio.appendChunk({ ...e2, seq: 0, bytes: WEBM() });
  assert.throws(() => eio.appendChunk({ ...e2, seq: 1, bytes: crypto.randomBytes(9) }), code('WRITE_FAILED'));
  assert.deepEqual([eio.getRecording(e2.recordingId).error, eio.getRecording(e2.recordingId).recoverable], ['WRITE_FAILED', true]);
  // finalize failures: rename fails → FAILED, partial kept; fsync fails → FAILED
  const rn = fresh({ io: { ...ioDefault(), rename: () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } } });
  const { s: s3, out: o3 } = await record(rn.svc);
  assert.deepEqual([o3.status, o3.error, o3.recording.recoverable], ['FAILED', 'FINALIZE_FAILED', true]);
  assert.ok(fs.existsSync(path.join(rn.root, 'partial', `${s3.recordingId}.partial`)), 'partial kept for recovery');
  assert.equal(fs.readdirSync(path.join(rn.root, 'files')).length, 0, 'nothing half-final');
  const fy = fresh({ io: { ...ioDefault(), fsync: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } } }).svc;
  assert.equal((await record(fy)).out.error, 'FINALIZE_FAILED');
  void root;
});

test('crash: a real process dies mid-capture → after restart FAILED / INTERRUPTED_RECOVERY_REQUIRED, bytes kept, never READY; a crash after the rename is recovered only by checksum', async () => {
  const root = path.join(TMP, 'crash');
  const lib = (f) => pathToFileURL(path.join(HERE, 'src', 'lib', f)).href;
  const child = path.join(TMP, 'rec-crash-child.mjs');
  fs.writeFileSync(child, `
    import { RecorderStore } from '${lib('recorder-store.js')}';
    import { createRecorderService } from '${lib('recorder-service.js')}';
    const store = RecorderStore.open({ root: process.argv[2] });
    const svc = createRecorderService({ store, limits: { minFreeBytes: 0 } });
    const s = svc.createSession({ type: 'CAMERA', mimeType: 'video/webm' }); svc.markStarted(s);
    svc.appendChunk({ ...s, seq: 0, bytes: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4000, 1)]) });
    console.log(s.recordingId);
    process.exit(0); // dies without finalize / cancel / close`);
  const r = spawnSync(process.execPath, [child, root], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim().split('\n').pop();
  const { svc, store } = fresh({ root });
  assert.equal(svc.getRecording(id).status, 'RECORDING', 'before recovery the row still says RECORDING');
  const rec = await svc.recoverAfterRestart();
  assert.equal(rec.flagged, 1);
  const v = svc.getRecording(id);
  assert.deepEqual([v.status, v.error, v.recoverable, v.sizeBytes], ['FAILED', 'INTERRUPTED_RECOVERY_REQUIRED', true, 4004]);
  assert.ok(fs.existsSync(path.join(store.root, 'partial', `${id}.partial`)), 'the captured bytes are kept');
  await assert.rejects(svc.openRecording(id), code('RECORDING_NOT_READY'));
  assert.equal((await svc.recoverAfterRestart()).flagged, 0, 'idempotent');
  // crash after rename, before READY: FINALIZING row + final file + persisted checksum → READY only if the checksum matches
  const okBytes = WEBM(300);
  const mk = (bytes, checksum) => {
    const rid = `rec_${crypto.randomBytes(16).toString('hex')}`;
    store.insert({ recordingId: rid, type: 'SCREEN', title: 't', declaredMime: 'video/webm', at: store.at(), hasAudio: false, partialKey: `partial/${rid}.partial` });
    fs.writeFileSync(path.join(store.root, 'files', `${rid}.webm`), bytes);
    store.update(rid, { status: 'FINALIZING', storage_key: `files/${rid}.webm`, ext: 'webm', mime_type: 'video/webm', size_bytes: bytes.length, checksum_sha256: checksum });
    return rid;
  };
  const good = mk(okBytes, crypto.createHash('sha256').update(okBytes).digest('hex'));
  const tampered = mk(okBytes, 'f'.repeat(64));
  const rec2 = await svc.recoverAfterRestart();
  assert.deepEqual([rec2.recovered, svc.getRecording(good).status, svc.getRecording(tampered).status], [1, 'READY', 'FAILED']);
  assert.ok(store.listAudit(good).some(a => a.event === 'RECORDING_RECOVERED'));
  // READY with a vanished file → MISSING at boot
  fs.unlinkSync(path.join(store.root, 'files', `${good}.webm`));
  assert.equal((await svc.recoverAfterRestart()).missing, 1);
  assert.equal(svc.getRecording(good).status, 'MISSING');
  // graceful shutdown during a capture
  const s = svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' }); svc.markStarted(s); svc.appendChunk({ ...s, seq: 0, bytes: WEBM() });
  svc.shutdown();
  assert.deepEqual([svc.getRecording(s.recordingId).status, svc.getRecording(s.recordingId).error], ['FAILED', 'INTERRUPTED_RECOVERY_REQUIRED']);
});

test('safe open (REC-DL-1 primitive): READY only, by id, regular file, same dev+ino on the descriptor, catalogue size, optional checksum; streams from the descriptor', async () => {
  const { svc, root } = fresh();
  const bytes = [WEBM(5000), crypto.randomBytes(7000)];
  const { s } = await record(svc, { chunks: bytes, title: 'Cours\r\nSet-Cookie: x' .replace(/\r\n/g, ' ') });
  const h = await svc.openRecording(s.recordingId, { verifyChecksum: true });
  assert.deepEqual([h.mimeType, h.sizeBytes, typeof h.fd, h.filename], ['video/webm;codecs=vp9,opus', 12009, 'number', 'Cours Set-Cookie x.webm']);
  const parts = []; for await (const c of h.stream()) parts.push(c);
  assert.ok(Buffer.concat(parts).equals(Buffer.concat(bytes)));
  noPath(Object.fromEntries(Object.entries(h).filter(([k]) => typeof h[k] !== 'function')), root);
  // TOCTOU: the file is replaced between the check (lstat) and the open → the descriptor is not the checked file → refused
  const final = path.join(root, 'files', `${s.recordingId}.webm`);
  const swapIo = { ...ioDefault(), open: (p, f) => { if (p === final) { fs.renameSync(final, `${final}.orig`); fs.writeFileSync(final, Buffer.concat(bytes)); } return fs.openSync(p, f); } };
  const swapped = createRecorderService({ store: svcStore(svc, root), io: swapIo, limits: { minFreeBytes: 0 } });
  await assert.rejects(swapped.openRecording(s.recordingId), code('FILE_CHANGED'));
  fs.rmSync(final); fs.renameSync(`${final}.orig`, final);
  // integrity: size and checksum
  fs.appendFileSync(final, Buffer.from('x'));
  await assert.rejects(svc.openRecording(s.recordingId), code('SIZE_MISMATCH'));
  fs.truncateSync(final, 12009); const fd = fs.openSync(final, 'r+'); fs.writeSync(fd, Buffer.from([0x00]), 0, 1, 9000); fs.closeSync(fd);
  await svc.openRecording(s.recordingId).then(x => x.close());
  await assert.rejects(svc.openRecording(s.recordingId, { verifyChecksum: true }), code('CHECKSUM_MISMATCH'));
  // a directory where the file should be
  fs.rmSync(final); fs.mkdirSync(final);
  await assert.rejects(svc.openRecording(s.recordingId), code('NOT_REGULAR_FILE'));
  fs.rmdirSync(final);
  // not READY
  const act = svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' });
  await assert.rejects(svc.openRecording(act.recordingId), code('RECORDING_NOT_READY'));
  svc.cancel(act);
  // a file symlink at the key (when the OS allows creating one)
  const { s: s2 } = await record(svc);
  const f2 = path.join(root, 'files', `${s2.recordingId}.webm`);
  fs.rmSync(f2);
  let linked = true;
  try { fs.symlinkSync(SENTINEL, f2, 'file'); } catch { linked = false; }
  if (linked) {
    await assert.rejects(svc.openRecording(s2.recordingId), code('LINK_REFUSED'));
    assert.equal(svc.deleteRecording(s2.recordingId).status, 'DELETE_INCOMPLETE', 'a link is never followed for deletion');
    fs.rmSync(f2);
  }
  assert.ok(sentinelIntact());
  console.log(`# file symlink sub-case: ${linked ? 'RUN' : 'NOT_APPLICABLE (no symlink privilege)'}`);
});
const stores = new Map();
function svcStore(svc, root) { if (!stores.has(root)) { const st = RecorderStore.open({ root, now: clock }); opened.push(st); stores.set(root, st); } return stores.get(root); }

test('junction / redirected directory escape: Recorder never writes, opens or deletes through a redirected files/ or partial/ directory; sentinel intact', async () => {
  const { svc, root } = fresh();
  const { s } = await record(svc);
  // files/ replaced by a junction to the outside directory that holds a same-named copy of the sentinel
  fs.copyFileSync(SENTINEL, path.join(SENTINEL_DIR, `${s.recordingId}.webm`));
  fs.renameSync(path.join(root, 'files'), path.join(root, 'files-real'));
  let junction = true;
  try { fs.symlinkSync(SENTINEL_DIR, path.join(root, 'files'), 'junction'); } catch { junction = false; }
  if (junction) {
    await assert.rejects(svc.openRecording(s.recordingId), code('ROOT_ESCAPE'));
    const d = svc.deleteRecording(s.recordingId);
    assert.deepEqual([d.status, d.remaining[0].reason], ['DELETE_INCOMPLETE', 'ROOT_ESCAPE']);
    assert.ok(fs.existsSync(path.join(SENTINEL_DIR, `${s.recordingId}.webm`)), 'nothing deleted outside');
    assert.throws(() => RecorderStore.open({ root }), code('ROOT_ESCAPE'), 'opening a store with a redirected directory is refused');
    fs.rmSync(path.join(root, 'files')); // removes the junction only
    // partial/ redirected: a new session must not create its file outside
    fs.renameSync(path.join(root, 'partial'), path.join(root, 'partial-real'));
    fs.symlinkSync(SENTINEL_DIR, path.join(root, 'partial'), 'junction');
    const before = fs.readdirSync(SENTINEL_DIR).sort();
    assert.throws(() => svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' }), code('ROOT_ESCAPE'));
    assert.deepEqual(fs.readdirSync(SENTINEL_DIR).sort(), before, 'no file written outside');
    fs.rmSync(path.join(root, 'partial'));
    fs.renameSync(path.join(root, 'partial-real'), path.join(root, 'partial'));
  }
  fs.renameSync(path.join(root, 'files-real'), path.join(root, 'files'));
  assert.ok(sentinelIntact());
  console.log(`# junction sub-case: ${junction ? 'RUN' : 'NOT_APPLICABLE'}`);
});

test('memory stays bounded: 96 MiB recorded in 1 MiB chunks, heap growth small; read back streamed', async () => {
  const { svc } = fresh();
  const s = svc.createSession({ type: 'SCREEN', mimeType: 'video/webm' }); svc.markStarted(s);
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  const h = crypto.createHash('sha256');
  const chunk = crypto.randomBytes(1024 * 1024);
  for (let i = 0; i < 96; i++) { const b = i === 0 ? Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), chunk.subarray(4)]) : chunk; h.update(b); svc.appendChunk({ ...s, seq: i, bytes: b }); }
  const out = await svc.finalize(s);
  const heapGrowth = process.memoryUsage().heapUsed - heap0;
  assert.equal(out.status, 'READY');
  assert.equal(out.recording.sizeBytes, 96 * 1024 * 1024);
  assert.equal(out.recording.checksumSha256, h.digest('hex'));
  assert.ok(heapGrowth < 48 * 1024 * 1024, `heap grew ${Math.round(heapGrowth / 1048576)} MiB for a 96 MiB recording`);
  const hd = await svc.openRecording(s.recordingId);
  let total = 0; let maxPiece = 0;
  for await (const c of hd.stream()) { total += c.length; maxPiece = Math.max(maxPiece, c.length); }
  assert.deepEqual([total, maxPiece <= 64 * 1024], [96 * 1024 * 1024, true]);
  console.log(`# heap growth ${Math.round(heapGrowth / 1048576)} MiB for 96 MiB recorded`);
  svc.deleteRecording(s.recordingId);
});

test('route factory: token in a header, chunk size refused before reading, no path in any response, no generic file/path route', async () => {
  const { svc, root } = fresh({ limits: { maxChunkBytes: 4096 } });
  const app = createRecorderRoute({ service: svc });
  const req = (method, url, { body, headers = {} } = {}) => app.request(url, { method, headers, body });
  const j = async (res) => ({ status: res.status, body: await res.json() });
  const created = await j(await req('POST', '/recorder/sessions', { body: JSON.stringify({ type: 'SCREEN', mimeType: 'video/webm', title: 'Via HTTP', path: 'C:\\evil', recordingId: 'rec_x' }), headers: { 'content-type': 'application/json' } }));
  assert.equal(created.status, 200);
  const { recordingId, sessionToken } = created.body.session;
  const H = { [RECORDER_SESSION_HEADER]: sessionToken };
  assert.equal((await req('POST', `/recorder/sessions/${recordingId}/start`)).status, 403, 'no token');
  assert.equal((await req('POST', `/recorder/sessions/${recordingId}/start`, { headers: H })).status, 200);
  assert.equal((await req('PUT', `/recorder/sessions/${recordingId}/chunks/0`, { body: WEBM(100), headers: H })).status, 200);
  const big = await j(await req('PUT', `/recorder/sessions/${recordingId}/chunks/1`, { body: Buffer.alloc(5000), headers: { ...H, 'content-length': '5000' } }));
  assert.deepEqual([big.status, big.body.error.code], [413, 'CHUNK_TOO_LARGE']);
  assert.equal((await j(await req('PUT', `/recorder/sessions/${recordingId}/chunks/abc`, { body: Buffer.alloc(5), headers: H }))).body.error.code, 'INVALID_SEQUENCE');
  assert.equal((await j(await req('PUT', `/recorder/sessions/${recordingId}/chunks/5`, { body: Buffer.alloc(5), headers: H }))).body.error.code, 'CHUNK_GAP');
  const fin = await j(await req('POST', `/recorder/sessions/${recordingId}/finalize`, { body: JSON.stringify({ durationMs: 900 }), headers: { ...H, 'content-type': 'application/json' } }));
  assert.deepEqual([fin.status, fin.body.status, fin.body.recording.title], [200, 'READY', 'Via HTTP']);
  const list = await j(await req('GET', '/recorder/recordings?limit=10'));
  assert.equal(list.body.items.length, 1);
  for (const bad of ['..%2F..%2Foutside', '%2e%2e', 'C:%5Cx', '%5C%5Cserver%5Cshare', '%252e%252e%252f']) {
    const res = await req('GET', `/recorder/recordings/${bad}`);
    assert.notEqual(res.status, 200, bad);
    assert.equal((await res.text()).includes('SENTINEL'), false);
  }
  assert.equal((await j(await req('GET', '/recorder/recordings/rec_zz'))).body.error.code, 'INVALID_RECORDING_ID');
  // REC-DL-1 added /recordings/:id/download (tested in test-recorder-download.mjs); there is still no generic file / path route
  for (const url of [`/recorder/recordings/${recordingId}/file`, '/recorder/files?path=C:\\x', '/recorder/download?path=C:\\x']) assert.equal((await req('GET', url)).status, 404, `${url}: no file / path route`);
  noPath([created.body, fin.body, list.body], root);
  const del = await j(await req('DELETE', `/recorder/recordings/${recordingId}`));
  assert.equal(del.body.result.status, 'DELETED');
  const boom = createRecorderRoute({ service: { ...svc, getRecording: () => { throw new Error(`EACCES ${root}\\secret`); } } });
  const err = await j(await boom.request(`/recorder/recordings/${recordingId}`));
  assert.deepEqual([err.status, err.body.error.code, JSON.stringify(err.body).includes(root)], [500, 'INTERNAL_ERROR', false], 'no stack / path to the client');
});

test('product wiring + isolation: boot/recovery/route/shutdown are wired; 0 shell / process / network / FFmpeg; tests never touch user data or sentinel', () => {
  for (const f of ['src/lib/recorder-contracts.js', 'src/lib/recorder-store.js', 'src/lib/recorder-service.js', 'src/routes/recorder.js']) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    for (const i of [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])) assert.ok(['node:crypto', 'node:fs', 'node:path', 'node:stream', 'better-sqlite3', 'hono'].includes(i) || /^\.\.?\/(lib\/)?(recorder-|media-studio\.js)/.test(i), `${f} imports ${i}`);
    assert.equal(/child_process|(?<!\.)\b(spawn|exec|execFile|execSync|fork)\s*\(|powershell|cmd\.exe|ffmpeg|ffprobe|\bfetch\s*\(|node:(http|https|net|dns|tls)|\beval\s*\(|new\s+Function|companion|notebook|\bkg_|investigat/i.test(src), false, f);
  }
  const server = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  assert.match(server, /RecorderStore\.open\(\{ root: path\.join\(path\.dirname\(env\.SQLITE_PATH\), 'recordings'\) \}\)/, 'canonical data root');
  assert.match(server, /createRecorderService\(\{ store: recorderStore \}\)/, 'service created');
  assert.match(server, /await recorderService\.recoverAfterRestart\(\)/, 'boot recovery');
  assert.match(server, /createRecorderRoute\(\{ service: recorderService, logger \}\)/, 'route factory mounted');
  assert.match(server, /recorderService\?\.shutdown\(\).*recorderStore\?\.close\(\)/s, 'sessions and catalogue closed');
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'recordings')), false, 'no Recorder folder in the user data directory');
  assert.deepEqual(REAL_DATA.map(fileHash), realBefore, 'real user DB untouched');
  assert.ok(sentinelIntact(), 'RECORDER_SENTINEL_DO_NOT_TOUCH intact');
  assert.equal(fetchCalls, 0);
  assert.equal(downloadFilename('a/b\\c:d*e?f"g<h>i|j\r\nk', 'webm'), 'a b c d e f g h i j k.webm'.replace('j k', 'j k'));
  assert.equal(downloadFilename('CON', 'mp4'), 'enregistrement.mp4');
  assert.equal(downloadFilename('...', 'webm'), 'enregistrement.webm');
  assert.throws(() => C.cleanTitle('a\r\nb', 'SCREEN'), code('INVALID_TITLE'));
  assert.throws(() => C.cleanTitle('x'.repeat(121), 'SCREEN'), code('INVALID_TITLE'));
  assert.equal(C.cleanTitle('  ', 'CAMERA'), 'Enregistrement caméra');
});
