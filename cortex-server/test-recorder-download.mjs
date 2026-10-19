// REC-DL-1 (resumed after RECORDER-1) — download of a READY recording through the isolated Recorder route.
// Every download goes through service.openRecording(): the tests wrap it to observe the descriptor (its stream, its
// closing). Temporary roots and synthetic bytes only; a real loopback HTTP server (@hono/node-server, port 0) is used
// for streaming / abort / concurrency; any non-loopback fetch is counted as a failure. A sentinel OUTSIDE the root
// (REC_DL_SENTINEL_DO_NOT_EXPOSE) must never appear in any response.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { serve } from '@hono/node-server';

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc'); // measure RETAINED memory, not garbage the collector has not reached yet

import { RecorderStore } from './src/lib/recorder-store.js';
import { createRecorderService, contentDisposition, downloadFilenameFor } from './src/lib/recorder-service.js';
import { createRecorderRoute, RECORDER_ERROR_HEADER } from './src/routes/recorder.js';
import { containerOfMime } from './src/lib/recorder-contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recdl1-'));
const SENTINEL_DIR = path.join(TMP, 'outside');
const SENTINEL_TEXT = 'REC_DL_SENTINEL_DO_NOT_EXPOSE';
const SENTINEL = path.join(SENTINEL_DIR, SENTINEL_TEXT);
const REAL_DATA = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let realBefore; let externalFetch = 0; const realFetch = globalThis.fetch; const closers = [];
before(() => {
  realBefore = REAL_DATA.map(fileHash);
  globalThis.fetch = async (u, o) => { if (!/^http:\/\/127\.0\.0\.1:/.test(String(u))) { externalFetch++; throw new Error('no external network'); } return realFetch(u, o); };
  fs.mkdirSync(SENTINEL_DIR, { recursive: true }); fs.writeFileSync(SENTINEL, `${SENTINEL_TEXT}\n`);
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const c of closers.reverse()) { try { await c(); } catch { /* closed */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

const WEBM = (n = 200) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]), crypto.randomBytes(n)]);
const MP4 = (n = 200) => Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(4), crypto.randomBytes(n)]);
let n = 0;
/** Service + route; openRecording wrapped to observe every descriptor the route uses (same object the route gets). */
function fresh({ io } = {}) {
  const store = RecorderStore.open({ root: path.join(TMP, `root-${++n}`) }); closers.push(() => store.close());
  const service = createRecorderService({ store, io, limits: { minFreeBytes: 0 } });
  const opened = [];
  const observed = Object.freeze({
    ...service,
    async openRecording(id, opts) {
      const h = await service.openRecording(id, opts);
      const rec = { recordingId: id, fd: h.fd, streamed: false, closed: false };
      opened.push(rec);
      return Object.freeze({ ...h, stream(o) { rec.streamed = true; const s = h.stream(o); s.on('close', () => { rec.closed = true; }); return s; }, webStream(o) { rec.streamed = true; rec.web = true; return h.webStream(o); }, close() { rec.closed = true; h.close(); } });
    },
  });
  const app = createRecorderRoute({ service: observed });
  return { store, service, app, opened, root: store.root };
}
async function ready(service, { title, mimeType = 'video/webm;codecs=vp9,opus', chunks = [WEBM(3000), crypto.randomBytes(5000)] } = {}) {
  const s = service.createSession({ type: 'SCREEN', mimeType, title });
  service.markStarted(s);
  chunks.forEach((bytes, seq) => service.appendChunk({ ...s, seq, bytes }));
  const out = await service.finalize(s);
  assert.equal(out.status, 'READY');
  return { id: s.recordingId, bytes: Buffer.concat(chunks), recording: out.recording, s };
}
const fdClosed = (fd) => { try { fs.fstatSync(fd); return false; } catch (e) { return e.code === 'EBADF'; } };
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 10)); } return false; }
const noPathIn = (text, root) => { for (const needle of [root, root.replaceAll('\\', '\\\\'), os.tmpdir(), 'files/', 'partial/', 'storage_key', 'storageKey']) assert.equal(String(text).includes(needle), false, `leaks ${needle}`); };
async function startServer(app) {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  closers.push(() => new Promise(r => server.close(() => r())));
  return `http://127.0.0.1:${server.address().port}`;
}
/** Raw HTTP GET with backpressure-friendly reading; returns the request so a test can abort it. */
function httpGet(url, { onData } = {}) {
  let req;
  const done = new Promise((resolve, reject) => {
    req = http.get(url, (res) => {
      const h = crypto.createHash('sha256'); let size = 0;
      res.on('data', (c) => { h.update(c); size += c.length; onData?.(c, res, req); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, size, sha256: h.digest('hex') }));
      res.on('error', reject); res.on('aborted', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })));
    });
    req.on('error', reject);
  });
  return { req: () => req, done };
}

test('READY download through openRecording: original bytes (WebM and MP4), validated MIME, Content-Length of the open file, attachment, no-store; the descriptor is closed after the stream', async () => {
  const { service, app, opened } = fresh();
  const w = await ready(service, { title: 'Démo produit' });
  const res = await app.request(`/recorder/recordings/${w.id}/download`);
  assert.equal(res.status, 200);
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(w.bytes), 'byte-for-byte the recorded original');
  assert.deepEqual([res.headers.get('content-type'), res.headers.get('content-length'), res.headers.get('cache-control'), res.headers.get('x-content-type-options')],
    ['video/webm;codecs=vp9,opus', String(w.bytes.length), 'no-store', 'nosniff']);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Demo produit.webm"; filename*=UTF-8\'\'D%C3%A9mo%20produit.webm');
  assert.equal(opened.length, 1, 'one openRecording per download');
  assert.ok(opened[0].streamed, 'the body is the stream of the validated descriptor');
  assert.ok(opened[0].web, 'pull-only web stream of the handle');
  assert.ok(await until(() => fdClosed(opened[0].fd)), 'descriptor closed at the end of the stream');
  const m = await ready(service, { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', chunks: [MP4(4000)], title: 'Clip' });
  const r2 = await app.request(`/recorder/recordings/${m.id}/download`);
  assert.deepEqual([r2.headers.get('content-type'), /filename="Clip\.mp4"/.test(r2.headers.get('content-disposition'))], ['video/mp4;codecs=avc1,mp4a.40.2', true], 'an MP4 stays MP4');
  assert.ok(Buffer.from(await r2.arrayBuffer()).equals(m.bytes));
  // the route never opens by path: it has no fs import at all
  const src = fs.readFileSync(path.join(HERE, 'src', 'routes', 'recorder.js'), 'utf8');
  assert.equal(/node:fs|readFile|createReadStream\s*\(|statSync|\.arrayBuffer\(\)\s*;?\s*\/\/ download/.test(src.replace(/^\s*\/\/.*$/gm, '')), false, 'no second, path-based open in the route');
});

test('READY only: PREPARING, RECORDING, FINALIZING, FAILED, CANCELLED, DELETING, MISSING refused with a structured code; unknown / malformed ids refused; no path in any error', async () => {
  const { service, store, app, opened, root } = fresh();
  const call = async (id) => { const r = await app.request(`/recorder/recordings/${id}/download`); const t = await r.text(); noPathIn(t, root); return [r.status, JSON.parse(t).error.code, r.headers.get(RECORDER_ERROR_HEADER)]; };
  const fin = await ready(service); const del = await ready(service); const miss = await ready(service); // READY fixtures first: a FINALIZING row holds the single active slot
  const prep = service.createSession({ type: 'CAMERA', mimeType: 'video/webm' });
  assert.deepEqual(await call(prep.recordingId), [409, 'RECORDING_NOT_READY', 'RECORDING_NOT_READY'], 'PREPARING');
  service.markStarted(prep); service.appendChunk({ ...prep, seq: 0, bytes: WEBM() });
  assert.deepEqual(await call(prep.recordingId), [409, 'RECORDING_NOT_READY', 'RECORDING_NOT_READY'], 'RECORDING');
  service.cancel(prep);
  assert.deepEqual(await call(prep.recordingId), [409, 'RECORDING_NOT_READY', 'RECORDING_NOT_READY'], 'CANCELLED');
  const z = service.createSession({ type: 'CAMERA', mimeType: 'video/webm' }); await service.finalize(z);
  assert.deepEqual(await call(z.recordingId), [409, 'RECORDING_NOT_READY', 'RECORDING_NOT_READY'], 'FAILED');
  store.update(fin.id, { status: 'FINALIZING' });
  assert.deepEqual(await call(fin.id), [409, 'RECORDING_NOT_READY', 'RECORDING_NOT_READY'], 'FINALIZING');
  store.update(del.id, { status: 'DELETING' });
  assert.deepEqual(await call(del.id), [409, 'RECORDING_NOT_READY', 'RECORDING_NOT_READY'], 'DELETING');
  fs.unlinkSync(path.join(root, 'files', `${miss.id}.webm`));
  assert.deepEqual(await call(miss.id), [404, 'RECORDING_FILE_MISSING', 'RECORDING_FILE_MISSING'], 'READY row but file gone');
  assert.equal(service.getRecording(miss.id).status, 'MISSING', 'existing RECORDER-1 contract: marked MISSING');
  assert.deepEqual(await call(miss.id), [404, 'RECORDING_FILE_MISSING', 'RECORDING_FILE_MISSING'], 'MISSING');
  assert.deepEqual(await call(`rec_${'d'.repeat(32)}`), [404, 'RECORDING_NOT_FOUND', 'RECORDING_NOT_FOUND']);
  for (const bad of ['rec_zz', 'REC_' + 'a'.repeat(32), `rec_${'a'.repeat(33)}`, 'abc', '%20']) assert.deepEqual((await call(bad)).slice(0, 2), [400, 'INVALID_RECORDING_ID'], bad);
  const dots = await app.request('/recorder/recordings/%2e%2e/download'); // normalised by the router: no route matches
  assert.notEqual(dots.status, 200); noPathIn(await dots.text(), root);
  assert.equal(opened.length, 0, 'no descriptor was handed out for a refused download');
});

test('sentinel + path manipulation: no id / encoding / traversal / UNC / absolute path / redirected directory exposes REC_DL_SENTINEL_DO_NOT_EXPOSE', async () => {
  const { service, app, root } = fresh();
  const r = await ready(service);
  const attacks = ['..%2F..%2Foutside%2FREC_DL_SENTINEL_DO_NOT_EXPOSE', '%2e%2e%2f%2e%2e%2f', '%252e%252e%252f', '..%5C..%5Coutside', 'C:%5CWindows%5Cwin.ini', '%5C%5Cserver%5Cshare%5Cx', `${r.id}%00`, `${r.id}.`, `${r.id}%20`,
    `${r.id}%2F..%2F..%2Foutside`, encodeURIComponent(SENTINEL), 'file%3A%2F%2F%2FC%3A%2Fx'];
  for (const a of attacks) {
    const res = await app.request(`/recorder/recordings/${a}/download`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.includes(Buffer.from(SENTINEL_TEXT)), false, a);
    assert.notEqual(res.status, 200, a);
  }
  // query parameters (path / file / storageKey) are ignored: the response is still exactly this recording
  for (const q of [`path=${encodeURIComponent(SENTINEL)}`, 'storageKey=..%2F..%2Foutside', `file=${encodeURIComponent('C:\\Windows\\win.ini')}`]) {
    const res = await app.request(`/recorder/recordings/${r.id}/download?${q}`);
    assert.equal(res.status, 200, q);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(r.bytes), q);
  }
  for (const p of [`/recorder/download?path=${encodeURIComponent(SENTINEL)}`, `/recorder/files/${encodeURIComponent(SENTINEL)}`, `/recorder/recordings/download?file=${encodeURIComponent(SENTINEL)}`]) {
    const res = await app.request(p); assert.notEqual(res.status, 200, p); assert.equal((await res.text()).includes(SENTINEL_TEXT), false);
  }
  // redirected files/ directory holding a same-named copy of the sentinel
  fs.copyFileSync(SENTINEL, path.join(SENTINEL_DIR, `${r.id}.webm`));
  fs.renameSync(path.join(root, 'files'), path.join(root, 'files-real'));
  let junction = true;
  try { fs.symlinkSync(SENTINEL_DIR, path.join(root, 'files'), 'junction'); } catch { junction = false; }
  if (junction) {
    const res = await app.request(`/recorder/recordings/${r.id}/download`);
    const t = await res.text();
    assert.deepEqual([res.status, JSON.parse(t).error.code], [500, 'ROOT_ESCAPE']);
    assert.equal(t.includes(SENTINEL_TEXT), false);
    fs.rmSync(path.join(root, 'files'));
  }
  fs.renameSync(path.join(root, 'files-real'), path.join(root, 'files'));
  console.log(`# junction sub-case: ${junction ? 'RUN' : 'NOT_APPLICABLE'}`);
});

test('RECORDER-1 guarantees kept: FILE_CHANGED (swap between check and open), non-regular file, size tamper, opt-in checksum (?verify=1)', async () => {
  const base = fresh();
  const r = await ready(base.service);
  const final = path.join(base.root, 'files', `${r.id}.webm`);
  // a swap between the lstat and the open (same bytes, different file) → FILE_CHANGED, nothing streamed
  const swapIo = {
    open: (p, f) => { if (p === final) { fs.renameSync(final, `${final}.orig`); fs.writeFileSync(final, r.bytes); } return fs.openSync(p, f); },
    close: (fd) => fs.closeSync(fd), fstat: (fd) => fs.fstatSync(fd, { bigint: true }), lstat: (p) => fs.lstatSync(p, { bigint: true }), write: (...a) => fs.writeSync(...a), fsync: (fd) => fs.fsyncSync(fd),
    read: (fd, b, o, l, pos) => new Promise((res, rej) => fs.read(fd, b, o, l, pos, (e, k) => (e ? rej(e) : res(k)))), rename: (a, b) => fs.renameSync(a, b), unlink: (p) => fs.unlinkSync(p), statfs: (p) => fs.statfsSync(p),
  };
  const swapStore = RecorderStore.open({ root: base.root }); closers.push(() => swapStore.close());
  const swapped = createRecorderRoute({ service: createRecorderService({ store: swapStore, io: swapIo, limits: { minFreeBytes: 0 } }) });
  const res = await swapped.request(`/recorder/recordings/${r.id}/download`);
  assert.deepEqual([res.status, (await res.json()).error.code], [409, 'FILE_CHANGED']);
  fs.rmSync(final); fs.renameSync(`${final}.orig`, final);
  // checksum: default downloads do not re-hash (one read); ?verify=1 re-hashes through the descriptor first
  const fd = fs.openSync(final, 'r+'); fs.writeSync(fd, Buffer.from([0x00]), 0, 1, 4000); fs.closeSync(fd);
  assert.equal((await base.app.request(`/recorder/recordings/${r.id}/download`)).status, 200, 'policy: no per-download re-hash by default');
  assert.deepEqual(await base.app.request(`/recorder/recordings/${r.id}/download?verify=1`).then(async x => [x.status, (await x.json()).error.code]), [409, 'CHECKSUM_MISMATCH']);
  const ok = await ready(base.service);
  assert.equal((await base.app.request(`/recorder/recordings/${ok.id}/download?verify=1`)).status, 200);
  fs.appendFileSync(path.join(base.root, 'files', `${ok.id}.webm`), Buffer.from('x'));
  assert.deepEqual(await base.app.request(`/recorder/recordings/${ok.id}/download`).then(async x => [x.status, (await x.json()).error.code]), [409, 'SIZE_MISMATCH']);
  // a directory where the file should be
  const d = await ready(base.service);
  const df = path.join(base.root, 'files', `${d.id}.webm`); fs.rmSync(df); fs.mkdirSync(df);
  assert.deepEqual(await base.app.request(`/recorder/recordings/${d.id}/download`).then(async x => [x.status, (await x.json()).error.code]), [409, 'NOT_REGULAR_FILE']);
  fs.rmdirSync(df);
});

test('filenames: default deterministic name, Unicode kept in filename*, ASCII fallback, quotes / apostrophe / separators / reserved names neutralised, CRLF impossible', async () => {
  const { service, app } = fresh();
  const untitled = await ready(service);
  const cd = (await app.request(`/recorder/recordings/${untitled.id}/download`)).headers.get('content-disposition');
  assert.match(cd, new RegExp(`^attachment; filename="recording-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}-${untitled.id.slice(4, 12)}\\.webm"; filename\\*=UTF-8''recording-`));
  const uni = await ready(service, { title: 'Réunion d’équipe — été 🎥' });
  const cdu = (await app.request(`/recorder/recordings/${uni.id}/download`)).headers.get('content-disposition');
  const star = /filename\*=UTF-8''(.+)$/.exec(cdu)[1];
  assert.equal(decodeURIComponent(star), 'Réunion d’équipe — été 🎥.webm', 'Unicode preserved');
  assert.match(/filename="([^"]*)"/.exec(cdu)[1], /^[\x20-\x7e]+$/, 'ASCII fallback');
  assert.equal(/filename="Reunion d_equipe _ ete _\.webm"/.test(cdu), true, cdu);
  const nasty = await ready(service, { title: 'a"b\'c/d\\e:f*g?h<i>j|k%l;m' });
  const cdn = (await app.request(`/recorder/recordings/${nasty.id}/download`)).headers.get('content-disposition');
  const ascii = /filename="([^"]*)"/.exec(cdn)[1];
  assert.equal(/["\\/:*?<>|]/.test(ascii), false, ascii);
  assert.equal(/'/.test(/filename\*=UTF-8''(.*)$/.exec(cdn)[1]), false, "apostrophe percent-encoded in filename*");
  assert.throws(() => service.createSession({ type: 'SCREEN', mimeType: 'video/webm', title: 'x\r\nSet-Cookie: a=b' }), (e) => e.code === 'INVALID_TITLE', 'CRLF refused at the source');
  for (const name of ['a\r\nSet-Cookie: x=y.webm', 'a\u0000b.webm', 'x\nLocation: http://evil.webm']) assert.equal(/[\r\n\u0000]/.test(contentDisposition(name)), false, JSON.stringify(name));
  assert.equal(downloadFilenameFor({ ext: 'webm', title: 'CON', type: 'SCREEN', created_at: '2026-10-16T10:00:00.000Z', recording_id: `rec_${'a'.repeat(32)}` }), 'enregistrement.webm', 'reserved name');
  assert.equal(contentDisposition('ok.webm'), 'attachment; filename="ok.webm"; filename*=UTF-8\'\'ok.webm');
  // MIME honesty at the source: CR / LF / tabs can never reach Content-Type
  for (const m of ['video/webm;codecs=vp8\r\n', 'video/webm;\tcodecs=vp8', 'video/webm;codecs="vp8\nX: y"']) assert.equal(containerOfMime(m), null, JSON.stringify(m));
});

test('HEAD validates through openRecording and closes the descriptor at once (Hono runs GET handlers for HEAD); errors carry the code in a header', async () => {
  const { service, app, opened, root } = fresh();
  const r = await ready(service);
  const res = await app.request(`/recorder/recordings/${r.id}/download`, { method: 'HEAD' });
  assert.deepEqual([res.status, res.headers.get('content-length'), res.headers.get('content-type')], [200, String(r.bytes.length), 'video/webm;codecs=vp9,opus']);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
  assert.equal(opened.length, 1);
  assert.deepEqual([opened[0].streamed, opened[0].closed, fdClosed(opened[0].fd)], [false, true, true], 'HEAD never leaves a descriptor open');
  fs.unlinkSync(path.join(root, 'files', `${r.id}.webm`));
  const miss = await app.request(`/recorder/recordings/${r.id}/download`, { method: 'HEAD' });
  assert.deepEqual([miss.status, miss.headers.get(RECORDER_ERROR_HEADER)], [404, 'RECORDING_FILE_MISSING']);
});

test('real HTTP: 64 MiB download streamed with bounded memory; client abort closes the stream and the descriptor; two concurrent downloads identical, no global lock', async () => {
  const { service, app, opened } = fresh();
  const s = service.createSession({ type: 'SCREEN', mimeType: 'video/webm' }); service.markStarted(s);
  const h = crypto.createHash('sha256'); const chunk = crypto.randomBytes(1024 * 1024);
  for (let i = 0; i < 64; i++) { const b = i === 0 ? Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), chunk.subarray(4)]) : chunk; h.update(b); service.appendChunk({ ...s, seq: i, bytes: b }); }
  const expected = h.digest('hex');
  assert.equal((await service.finalize(s)).status, 'READY');
  const base = await startServer(app);
  const url = `${base}/recorder/recordings/${s.recordingId}/download`;
  // retained memory (forced GC while sampling): a SLOW client proves backpressure (the server reads only as fast as the
  // socket drains); a FAST in-process client shows a constant in-flight amount (loopback socket + client buffers),
  // measured ~25 MiB for 16, 64 and 128 MiB alike — never proportional to the file
  const measure = async (slowClient) => {
    gc(); const m0 = process.memoryUsage(); let peak = 0;
    const sampler = setInterval(() => { gc(); const m = process.memoryUsage(); peak = Math.max(peak, (m.heapUsed - m0.heapUsed) + (m.arrayBuffers - m0.arrayBuffers)); }, 25);
    const out = await httpGet(url, slowClient ? { onData: (c, res) => { res.pause(); setTimeout(() => res.resume(), 1); } } : {}).done;
    clearInterval(sampler);
    return { out, peak };
  };
  const slow = await measure(true);
  const fast = await measure(false);
  for (const { out } of [slow, fast]) assert.deepEqual([out.status, out.size, out.sha256, out.headers['content-length']], [200, 64 * 1024 * 1024, expected, String(64 * 1024 * 1024)]);
  assert.ok(slow.peak < 8 * 1024 * 1024, `slow client: retained ${Math.round(slow.peak / 1048576)} MiB for a 64 MiB download (backpressure)`);
  assert.ok(fast.peak < 40 * 1024 * 1024, `fast client: retained ${Math.round(fast.peak / 1048576)} MiB for a 64 MiB download`);
  console.log(`# retained peak for 64 MiB: slow client ${(slow.peak / 1048576).toFixed(1)} MiB, fast in-process client ${(fast.peak / 1048576).toFixed(1)} MiB`);
  assert.ok(await until(() => opened.every(o => fdClosed(o.fd))), 'descriptor closed after the full download');
  // client abort mid-transfer
  const before = opened.length;
  const g = httpGet(url, { onData: (c, res, req) => { if (!req.destroyed) req.destroy(); } });
  await g.done.catch(() => {});
  const aborted = opened[before];
  assert.ok(aborted?.streamed, 'the aborted download had started streaming');
  assert.ok(await until(() => fdClosed(aborted.fd)), 'abort → stream cancelled, descriptor closed (no leak)');
  // concurrency
  const [a, b] = await Promise.all([httpGet(url).done, httpGet(url).done]);
  assert.deepEqual([a.sha256, b.sha256, a.size], [expected, expected, 64 * 1024 * 1024]);
  assert.ok(await until(() => opened.every(o => fdClosed(o.fd))), 'every descriptor closed');
  console.log(`# descriptors opened: ${opened.length}, all closed`);
});

test('delete race: a download in progress keeps streaming the SAME file to the end; the delete answers honestly (DELETED, or DELETE_INCOMPLETE where the OS refuses); never another file', async () => {
  const { service, app, opened } = fresh();
  const big = crypto.randomBytes(8 * 1024 * 1024);
  const r = await ready(service, { chunks: [Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), big.subarray(0, 4 * 1024 * 1024)]), big.subarray(4 * 1024 * 1024)] });
  const base = await startServer(app);
  let delResult = null;
  const g = httpGet(`${base}/recorder/recordings/${r.id}/download`, { onData: (c, res) => { if (!delResult) { res.pause(); delResult = service.deleteRecording(r.id); setTimeout(() => res.resume(), 50); } } });
  const out = await g.done;
  assert.ok(['DELETED', 'DELETE_INCOMPLETE'].includes(delResult.status), delResult.status);
  assert.deepEqual([out.status, out.sha256], [200, sha(r.bytes)], 'the open descriptor delivered exactly the recorded bytes');
  console.log(`# delete during download on ${process.platform}: ${delResult.status}`);
  if (delResult.status === 'DELETED') {
    const again = await app.request(`/recorder/recordings/${r.id}/download`);
    assert.deepEqual([again.status, (await again.json()).error.code], [404, 'RECORDING_NOT_FOUND'], 'after the delete, nothing to download');
  }
  assert.ok(await until(() => opened.every(o => fdClosed(o.fd))));
});

test('product wiring + isolation: download route is mounted once; 0 external network, real user DB untouched, sentinel intact, route has no fs / process / network import', () => {
  assert.equal(externalFetch, 0);
  assert.deepEqual(REAL_DATA.map(fileHash), realBefore);
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'recordings')), false);
  assert.equal(fs.readFileSync(SENTINEL, 'utf8'), `${SENTINEL_TEXT}\n`);
  const src = fs.readFileSync(path.join(HERE, 'src', 'routes', 'recorder.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]).sort(), ['../lib/recorder-contracts.js', '../lib/recorder-service.js', 'hono']);
  assert.equal(/child_process|ffmpeg|\bfetch\s*\(|node:(http|https|net)/i.test(src.replace(/^\s*\/\/.*$/gm, '')), false);
  const server = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  assert.equal((server.match(/createRecorderRoute\(/g) ?? []).length, 1, 'one Recorder route factory mount');
  assert.match(server, /app\.route\('\/api', createRecorderRoute\(\{ service: recorderService, logger \}\)\)/, 'product route mounted under /api');
  assert.match(server, /X-Docteur-Recorder-Session/, 'session header allowed by product CORS');
});
