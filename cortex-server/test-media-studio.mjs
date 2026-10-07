// Media Studio V1 — project model, timeline edits, chunked import, REAL FFmpeg export (synthetic media),
// cancel without orphan, failure, queue, Root Policy MEDIA_TRANSCODE gate, real process restart, HTTP route.
// Temp folders + in-memory SQLite: never the real database, never the real data folder.
import './test-setup.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initSqlite } from './src/lib/sqlite.js';
import { enforce as realEnforce } from './src/lib/root-policy/index.js';
import {
  LIMITS, sniffMedia, safeDisplayName, uploadSource, applyEdit, computeTimeline, buildExportArgs, createMediaStudioService, defaultProject, parseProbe,
} from './src/lib/media-studio.js';
import { createMediaStudioStore } from './src/lib/media-studio-store.js';
import { createMediaStudioRoute } from './src/routes/media-studio.js';

initSqlite(':memory:');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-media-studio-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
const FX = {
  clip: path.join(TMP, 'clip.mp4'), tone: path.join(TMP, 'tone.wav'), still: path.join(TMP, 'still.png'), silent: path.join(TMP, 'silent.webm'),
};
ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', FX.clip);
ff('-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', FX.tone);
ff('-f', 'lavfi', '-i', 'testsrc=size=400x300', '-frames:v', '1', FX.still);
ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=1', '-c:v', 'libvpx', FX.silent);

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true }).toString();
  const j = JSON.parse(out);
  return { duration: Number(j.format.duration), streams: j.streams.map(s => ({ type: s.codec_type, codec: s.codec_name, w: s.width, h: s.height })) };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 60_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

function makeService({ enforce = realEnforce, spawnImpl = spawn, root = fs.mkdtempSync(path.join(TMP, 'root-')), resolveDocteurImage = null } = {}) {
  return { root, service: createMediaStudioService({ rootDir: root, store: createMediaStudioStore(), enforce, spawnImpl, resolveDocteurImage }) };
}
async function upload(service, projectId, file, name = path.basename(file)) {
  const bytes = fs.readFileSync(file);
  const { uploadId } = service.startUpload(projectId, { name, size: bytes.length });
  for (let off = 0; off < bytes.length; off += LIMITS.chunkBytes) service.appendChunk(uploadId, off, bytes.subarray(off, off + LIMITS.chunkBytes));
  return service.completeUpload(uploadId, { sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
async function projectWithMedia(svc) {
  const { project } = svc.createProject({ name: 'Projet test' });
  const clip = (await upload(svc, project.id, FX.clip)).asset;
  const tone = (await upload(svc, project.id, FX.tone)).asset;
  const still = (await upload(svc, project.id, FX.still)).asset;
  return { id: project.id, clip, tone, still };
}

// ── Pure model ────────────────────────────────────────────────────────────────

test('content sniffing and safe names (type never decided by the client name)', () => {
  assert.deepEqual(sniffMedia(fs.readFileSync(FX.clip).subarray(0, 64)), { kind: 'video', ext: 'mp4' });
  assert.deepEqual(sniffMedia(fs.readFileSync(FX.tone).subarray(0, 64)), { kind: 'audio', ext: 'wav' });
  assert.deepEqual(sniffMedia(fs.readFileSync(FX.still).subarray(0, 64)), { kind: 'image', ext: 'png' });
  assert.deepEqual(sniffMedia(fs.readFileSync(FX.silent).subarray(0, 64)), { kind: 'video', ext: 'webm' });
  assert.equal(sniffMedia(Buffer.from('#!/bin/sh\nrm -rf /')), null);
  assert.equal(safeDisplayName('../../etc/passwd.mp4'), 'passwd.mp4');
  assert.equal(safeDisplayName('C:\\Windows\\System32\\cmd.exe'), 'cmd.exe');
  assert.equal(safeDisplayName('CON.mp4'), 'média');
  assert.equal(safeDisplayName('a<b>|c?.wav'), 'abc.wav');
  assert.deepEqual(uploadSource(null), { type: 'upload' });
  assert.deepEqual(uploadSource({ type: 'media-reader', url: 'https://ex.org/a.mp4' }), { type: 'media-reader', url: 'https://ex.org/a.mp4' });
  for (const url of ['javascript:alert(1)', 'file:///C:/secret.mp4', 'https://u:p@ex.org/a.mp4', `https://ex.org/${'a'.repeat(3000)}`, 42]) {
    assert.deepEqual(uploadSource({ type: 'media-reader', url }), { type: 'media-reader' }, String(url).slice(0, 40));
  }
  assert.deepEqual(uploadSource({ type: 'admin', url: 'https://ex.org' }), { type: 'upload' });
  assert.throws(() => parseProbe('{"streams":[],"format":{}}', { kind: 'video' }), (e) => e.code === 'CORRUPT_MEDIA');
});

test('timeline edits: add, trim, split, reorder, move, audio controls, delete — validated, non-destructive', () => {
  let p = defaultProject({ id: crypto.randomUUID(), name: 'x' });
  const video = { id: crypto.randomUUID(), kind: 'video', durationMs: 4000, hasAudio: true, hasVideo: true, file: 'v.mp4' };
  const image = { id: crypto.randomUUID(), kind: 'image', durationMs: null, hasAudio: false, hasVideo: true, file: 'i.png' };
  const audio = { id: crypto.randomUUID(), kind: 'audio', durationMs: 3000, hasAudio: true, hasVideo: false, file: 'a.wav' };
  p.assets = [video, image, audio];
  const before = JSON.stringify(p);
  p = applyEdit(p, { op: 'add', assetId: video.id });
  p = applyEdit(p, { op: 'add', assetId: image.id });
  p = applyEdit(p, { op: 'add', assetId: audio.id, trackId: 'A1', startMs: 500 });
  assert.equal(JSON.parse(before).clips.length, 0, 'edits return a new project');
  const [v, i, a] = p.clips;
  assert.deepEqual(computeTimeline(p).durationMs, 4000 + LIMITS.defaultImageMs);
  p = applyEdit(p, { op: 'trim', clipId: v.id, inMs: 500, outMs: 3500 });
  p = applyEdit(p, { op: 'split', clipId: v.id, atMs: 1000 });
  const video2 = p.clips.filter(c => c.trackId === 'V1');
  assert.deepEqual(video2.map(c => [c.inMs, c.outMs]), [[500, 1500], [1500, 3500], [0, LIMITS.defaultImageMs]]);
  p = applyEdit(p, { op: 'reorder', clipId: i.id, toIndex: 0 });
  assert.equal(p.clips.filter(c => c.trackId === 'V1')[0].id, i.id);
  p = applyEdit(p, { op: 'move', clipId: a.id, startMs: 1200 });
  p = applyEdit(p, { op: 'update', clipId: a.id, volume: 0.5, fadeInMs: 300, fadeOutMs: 400, muted: false });
  p = applyEdit(p, { op: 'update', clipId: i.id, durationMs: 2000 });
  p = applyEdit(p, { op: 'track', trackId: 'A1', volume: 1.5 });
  const timeline = computeTimeline(p);
  assert.deepEqual(timeline.video.map(c => c.startMs), [0, 2000, 3000]);
  assert.equal(timeline.durationMs, 5000);
  assert.equal(timeline.audio[0].startMs, 1200);
  for (const [bad, code] of [
    [{ op: 'trim', clipId: a.id, inMs: 0, outMs: 9000 }, 'INVALID_TRIM'],
    [{ op: 'trim', clipId: a.id, inMs: 100, outMs: 150 }, 'INVALID_TRIM'],
    [{ op: 'split', clipId: a.id, atMs: 20 }, 'INVALID_SPLIT'],
    [{ op: 'reorder', clipId: a.id, toIndex: 0 }, 'INVALID_REORDER'],
    [{ op: 'move', clipId: i.id, startMs: 10 }, 'INVALID_MOVE'],
    [{ op: 'update', clipId: a.id, volume: 5 }, 'INVALID_VOLUME'],
    [{ op: 'update', clipId: a.id, fadeInMs: 2000, fadeOutMs: 2000 }, 'INVALID_FADE'],
    [{ op: 'add', assetId: audio.id, trackId: 'V1' }, 'INVALID_TRACK'],
    [{ op: 'add', assetId: image.id, trackId: 'A1' }, 'INVALID_TRACK'],
    [{ op: 'settings', resolution: '7680x4320' }, 'INVALID_SETTINGS'],
    [{ op: 'format_c' }, 'UNKNOWN_EDIT'],
  ]) assert.throws(() => applyEdit(p, bad), (e) => e.code === code, JSON.stringify(bad));
  p = applyEdit(p, { op: 'delete', clipId: a.id });
  assert.equal(p.clips.filter(c => c.trackId === 'A1').length, 0);
});

test('export plan: argv only, internal paths, numeric filters, image loop, silence, mix', () => {
  let p = defaultProject({ id: crypto.randomUUID(), name: 'nom "hostile" ; rm -rf /' });
  const video = { id: crypto.randomUUID(), name: '$(calc).mp4', kind: 'video', durationMs: 2000, hasAudio: true, hasVideo: true, file: 'v.mp4' };
  const image = { id: crypto.randomUUID(), name: 'x', kind: 'image', durationMs: null, hasAudio: false, hasVideo: true, file: 'i.png' };
  const audio = { id: crypto.randomUUID(), name: 'y', kind: 'audio', durationMs: 3000, hasAudio: true, hasVideo: false, file: 'a.wav' };
  p.assets = [video, image, audio];
  assert.throws(() => buildExportArgs(p, { assetPath: a => `/studio/${a.file}`, outputPath: '/studio/out.mp4' }), (e) => e.code === 'EMPTY_TIMELINE');
  p = applyEdit(applyEdit(applyEdit(p, { op: 'add', assetId: video.id }), { op: 'add', assetId: image.id }), { op: 'add', assetId: audio.id, trackId: 'A1', startMs: 250 });
  p = applyEdit(p, { op: 'update', clipId: p.clips[0].id, muted: true });
  const { args, durationMs } = buildExportArgs(p, { assetPath: a => `/studio/${a.file}`, outputPath: '/studio/out.mp4' });
  assert.equal(durationMs, 2000 + LIMITS.defaultImageMs);
  assert.ok(Array.isArray(args) && args.every(x => typeof x === 'string'));
  const joined = args.join(' ');
  assert.ok(!joined.includes('$(calc)') && !joined.includes('rm -rf') && !joined.includes('hostile'), 'no user string reaches FFmpeg');
  assert.deepEqual(args.filter((x, k) => args[k - 1] === '-i'), ['/studio/v.mp4', 'anullsrc=channel_layout=stereo:sample_rate=48000', '/studio/i.png', 'anullsrc=channel_layout=stereo:sample_rate=48000', '/studio/a.wav'], 'muted / image clips get silence; inputs are internal paths');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /concat=n=2:v=1:a=1\[vseq\]\[aseq\]/);
  assert.match(graph, /adelay=250\|250\[b0\]/);
  assert.match(graph, /amix=inputs=2:duration=first/);
  assert.ok(args.includes('-loop') && args.at(-1) === '/studio/out.mp4');
});

// ── Real FFmpeg ───────────────────────────────────────────────────────────────

test('import (chunked, checksum) + real export video+audio with trim/split/reorder/image/fade: streams and duration verified', async () => {
  const { service: svc } = makeService();
  const m = await projectWithMedia(svc);
  assert.equal(m.clip.kind, 'video'); assert.equal(m.clip.hasAudio, true); assert.ok(Math.abs(m.clip.durationMs - 2000) < 100);
  assert.equal(m.tone.kind, 'audio'); assert.equal(m.still.kind, 'image'); assert.equal(m.still.width, 400);
  assert.equal(m.clip.name, 'clip.mp4');
  svc.edit(m.id, { op: 'add', assetId: m.clip.id });
  let view = svc.edit(m.id, { op: 'add', assetId: m.still.id });
  const clip = view.project.clips[0];
  svc.edit(m.id, { op: 'trim', clipId: clip.id, inMs: 200, outMs: 1800 });
  svc.edit(m.id, { op: 'split', clipId: clip.id, atMs: 800 });
  view = svc.edit(m.id, { op: 'reorder', clipId: view.project.clips[1].id, toIndex: 0 });
  view = svc.edit(m.id, { op: 'update', clipId: view.project.clips.find(c => c.assetId === m.still.id).id, durationMs: 1000 });
  view = svc.edit(m.id, { op: 'add', assetId: m.tone.id, trackId: 'A1', startMs: 300 });
  svc.edit(m.id, { op: 'update', clipId: view.project.clips.at(-1).id, volume: 0.6, fadeInMs: 200, fadeOutMs: 200 });
  const expected = computeTimeline(svc.getProject(m.id).project).durationMs;
  assert.equal(expected, 1000 + 800 + 800);
  const job = svc.requestExport(m.id);
  assert.equal(job.status, 'QUEUED');
  assert.ok(await until(() => ['COMPLETED', 'FAILED'].includes(svc.getJob(job.id).status)), 'export ends');
  const done = svc.getJob(job.id);
  assert.equal(done.status, 'COMPLETED', done.error ?? '');
  assert.equal(done.progress, 100);
  const out = probe(svc.exportFile(job.id).file);
  assert.ok(Math.abs(out.duration - expected / 1000) < 0.2, `duration ${out.duration}`);
  assert.deepEqual(out.streams.map(s => s.type).sort(), ['audio', 'video']);
  const v = out.streams.find(s => s.type === 'video');
  assert.deepEqual([v.codec, v.w, v.h], ['h264', 1280, 720]);
  assert.equal(out.streams.find(s => s.type === 'audio').codec, 'aac');
  // Sources untouched (non-destructive).
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(svc.assetFile(m.id, m.clip.id).file))).digest('hex'), m.clip.sha256);
});

test('real export video + image only (no audio track): silent audio stream, exact duration', async () => {
  const { service: svc } = makeService();
  const { project } = svc.createProject({ name: 'image' });
  const still = (await upload(svc, project.id, FX.still)).asset;
  const silent = (await upload(svc, project.id, FX.silent)).asset;
  assert.equal(silent.hasAudio, false);
  svc.edit(project.id, { op: 'add', assetId: silent.id });
  const v = svc.edit(project.id, { op: 'add', assetId: still.id });
  svc.edit(project.id, { op: 'update', clipId: v.project.clips[1].id, durationMs: 1500 });
  svc.edit(project.id, { op: 'settings', resolution: '640x360', fps: 25 });
  const job = svc.requestExport(project.id);
  assert.ok(await until(() => ['COMPLETED', 'FAILED'].includes(svc.getJob(job.id).status)));
  assert.equal(svc.getJob(job.id).status, 'COMPLETED', svc.getJob(job.id).error ?? '');
  const out = probe(svc.exportFile(job.id).file);
  assert.ok(Math.abs(out.duration - 2.5) < 0.2, `duration ${out.duration}`);
  assert.deepEqual(out.streams.find(s => s.type === 'video').w, 640);
  assert.ok(out.streams.some(s => s.type === 'audio'), 'audio stream present (silence) for player compatibility');
});

test('cancel a running export: FFmpeg tree killed (no orphan), no partial file; queue continues', async () => {
  const spawned = [];
  const { service: svc, root } = makeService({ spawnImpl: (bin, args, opts) => { const p = spawn(bin, args, opts); if (bin === 'ffmpeg') spawned.push(p); return p; } });
  const { project } = svc.createProject({ name: 'long' });
  const still = (await upload(svc, project.id, FX.still)).asset;
  const v = svc.edit(project.id, { op: 'add', assetId: still.id });
  svc.edit(project.id, { op: 'update', clipId: v.project.clips[0].id, durationMs: 15 * 60_000 });
  svc.edit(project.id, { op: 'settings', resolution: '1920x1080' });
  const job = svc.requestExport(project.id);
  const queued = svc.requestExport(project.id);
  assert.ok(await until(() => svc.getJob(job.id).status === 'RUNNING' && spawned.length === 1));
  assert.equal(svc.getJob(queued.id).status, 'QUEUED', 'one export at a time');
  assert.ok(await until(() => svc.getJob(job.id).progress > 0, 30_000), 'progress reported');
  const pid = spawned[0].pid;
  await svc.cancelExport(job.id);
  assert.ok(await until(() => svc.getJob(job.id).status === 'CANCELLED'));
  assert.ok(await until(() => !alive(pid), 10_000), 'no orphan FFmpeg process');
  assert.equal(fs.existsSync(path.join(root, 'projects', project.id, 'exports', `${job.id}.mp4`)), false, 'partial output removed');
  // The queued one starts next; cancel it too (QUEUED → CANCELLED or RUNNING → CANCELLED).
  await until(() => svc.getJob(queued.id).status === 'RUNNING');
  await svc.cancelExport(queued.id);
  assert.ok(await until(() => svc.getJob(queued.id).status === 'CANCELLED'));
  assert.ok(await until(() => spawned.every(p => !alive(p.pid)), 10_000));
  await assert.rejects(svc.cancelExport(job.id), (e) => e.code === 'JOB_FINISHED');
});

test('server stop during an export: FFmpeg killed, job reported interrupted (not "cancelled by user"), nothing new starts', async () => {
  const spawned = [];
  const { service: svc } = makeService({ spawnImpl: (bin, args, opts) => { const p = spawn(bin, args, opts); if (bin === 'ffmpeg') spawned.push(p); return p; } });
  const { project } = svc.createProject({ name: 'stop' });
  const still = (await upload(svc, project.id, FX.still)).asset;
  const v = svc.edit(project.id, { op: 'add', assetId: still.id });
  svc.edit(project.id, { op: 'update', clipId: v.project.clips[0].id, durationMs: 15 * 60_000 });
  const job = svc.requestExport(project.id);
  const next = svc.requestExport(project.id);
  assert.ok(await until(() => svc.getJob(job.id).status === 'RUNNING' && spawned.length === 1));
  await svc.shutdown();
  assert.equal(svc.getJob(job.id).status, 'FAILED');
  assert.equal(svc.getJob(job.id).error, 'interrupted_by_restart');
  assert.ok(await until(() => !alive(spawned[0].pid), 10_000), 'no orphan FFmpeg after server stop');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(svc.getJob(next.id).status, 'QUEUED', 'queued export not started while stopping');
  assert.equal(spawned.length, 1);
  assert.equal(svc.getJob(job.id).error, 'interrupted_by_restart', 'late close handler keeps the interrupted status');
});

test('export failure is explicit (missing source), Root Policy denial blocks before any process, corrupt/unsupported imports refused', async () => {
  const { service: svc } = makeService();
  const m = await projectWithMedia(svc);
  svc.edit(m.id, { op: 'add', assetId: m.clip.id });
  fs.rmSync(svc.assetFile(m.id, m.clip.id).file);
  const job = svc.requestExport(m.id);
  assert.ok(await until(() => ['COMPLETED', 'FAILED'].includes(svc.getJob(job.id).status)));
  const failed = svc.getJob(job.id);
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error, /FFmpeg a échoué/);
  assert.ok(!failed.error.includes(os.tmpdir()), 'internal paths not leaked');

  const calls = [];
  const denied = makeService({
    enforce: () => { throw Object.assign(new Error('Action refusée par la Root Policy (DENY_TEST)'), { name: 'RootPolicyDeniedError', code: 'ROOT_POLICY_DENIED' }); },
    spawnImpl: (...a) => { calls.push(a[0]); return spawn(...a); },
  }).service;
  const { project } = denied.createProject({ name: 'p' });
  await assert.rejects(upload(denied, project.id, FX.clip), (e) => e.name === 'RootPolicyDeniedError');
  assert.equal(calls.length, 0, 'no ffprobe started when the policy refuses');

  const garbage = path.join(TMP, 'garbage.mp4');
  fs.writeFileSync(garbage, Buffer.concat([fs.readFileSync(FX.clip).subarray(0, 32), Buffer.alloc(4096, 7)]));
  await assert.rejects(upload(svc, m.id, garbage), (e) => e.code === 'CORRUPT_MEDIA');
  const script = path.join(TMP, 'evil.mp4');
  fs.writeFileSync(script, '#!/bin/sh\necho pwned');
  await assert.rejects(upload(svc, m.id, script), (e) => e.code === 'UNSUPPORTED_MEDIA' && e.status === 415);
  const { uploadId } = svc.startUpload(m.id, { name: 'x.wav', size: 10 });
  assert.throws(() => svc.appendChunk(uploadId, 5, Buffer.alloc(5)), (e) => e.code === 'INVALID_OFFSET');
  assert.throws(() => svc.appendChunk(uploadId, 0, Buffer.alloc(11)), (e) => e.code === 'INVALID_CHUNK');
  svc.appendChunk(uploadId, 0, Buffer.alloc(4));
  await assert.rejects(svc.completeUpload(uploadId), (e) => e.code === 'INCOMPLETE_UPLOAD');
  assert.throws(() => svc.startUpload(m.id, { name: 'big.mp4', size: LIMITS.maxAssetBytes + 1 }), (e) => e.code === 'FILE_TOO_LARGE');
  const bytes = fs.readFileSync(FX.tone);
  const u2 = svc.startUpload(m.id, { name: 'tone.wav', size: bytes.length }).uploadId;
  svc.appendChunk(u2, 0, bytes);
  await assert.rejects(svc.completeUpload(u2, { sha256: 'f'.repeat(64) }), (e) => e.code === 'CHECKSUM_MISMATCH');
  assert.throws(() => svc.removeAsset(m.id, m.clip.id), (e) => e.code === 'ASSET_IN_USE');
});

test('persistence across a REAL process restart: identical project; running export reported, not resumed', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'restart-'));
  const dbFile = path.join(dir, 'studio.db').replace(/\\/g, '/');
  const root = path.join(dir, 'root').replace(/\\/g, '/');
  const lib = (p) => JSON.stringify(new URL(`./src/lib/${p}`, `file:///${HERE.replace(/\\/g, '/')}/`).href);
  const head = `
    import { initSqlite, getDatabase } from ${lib('sqlite.js')};
    import { createMediaStudioService } from ${lib('media-studio.js')};
    import { createMediaStudioStore } from ${lib('media-studio-store.js')};
    initSqlite(${JSON.stringify(dbFile)});
    const svc = createMediaStudioService({ rootDir: ${JSON.stringify(root)}, store: createMediaStudioStore(), enforce: () => ({ decision: 'ALLOW' }) });`;
  const run = (code) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: HERE, env: { ...process.env, DOCTEUR_TEST_MODE: '1' }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  };
  const first = run(`${head}
    const { project } = svc.createProject({ name: 'Persistant' });
    const p = { ...project, assets: [{ id: '11111111-1111-4111-8111-111111111111', name: 'v', file: 'v.mp4', kind: 'video', durationMs: 4000, hasAudio: true, hasVideo: true }] };
    getDatabase().prepare('UPDATE media_projects SET data = ? WHERE id = ?').run(JSON.stringify(p), p.id);
    let v = svc.edit(p.id, { op: 'add', assetId: p.assets[0].id });
    v = svc.edit(p.id, { op: 'split', clipId: v.project.clips[0].id, atMs: 1500 });
    getDatabase().prepare("INSERT INTO media_export_jobs (id, project_id, status, created_at) VALUES ('22222222-2222-4222-8222-222222222222', ?, 'RUNNING', ?)").run(p.id, new Date().toISOString());
    console.log(JSON.stringify({ id: p.id, project: svc.getProject(p.id).project }));
    process.exit(0);`);
  const second = run(`${head}
    const rec = svc.recoverAfterRestart();
    console.log(JSON.stringify({ rec, project: svc.getProject(${JSON.stringify(first.id)}).project, job: svc.getJob('22222222-2222-4222-8222-222222222222') }));
    process.exit(0);`);
  assert.deepEqual(second.project, first.project, 'state identical after restart');
  assert.equal(second.project.clips.length, 2);
  assert.equal(second.rec.interrupted, 1);
  assert.equal(second.job.status, 'FAILED');
  assert.equal(second.job.error, 'interrupted_by_restart');
});

test('route: chunked upload, Range playback, export download, Docteur image import, clear errors', async () => {
  const docteurImage = path.join(TMP, 'docteur-image.png');
  fs.copyFileSync(FX.still, docteurImage);
  const { service } = makeService({ resolveDocteurImage: (id) => (id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png' ? docteurImage : null) });
  const app = createMediaStudioRoute({ service });
  const json = (method, url, body) => app.request(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const { project } = await (await json('POST', '/media-studio/projects', { name: 'Route' })).json();
  const bytes = fs.readFileSync(FX.clip);
  const { uploadId } = await (await json('POST', `/media-studio/projects/${project.id}/uploads`, { name: '../evil/clip.mp4', size: bytes.length, origin: { type: 'media-reader', url: 'https://example.org/clip.mp4' } })).json();
  const put = await app.request(`/media-studio/uploads/${uploadId}?offset=0`, { method: 'PUT', body: bytes });
  assert.equal((await put.json()).received, bytes.length);
  const done = await (await json('POST', `/media-studio/uploads/${uploadId}/complete`, { sha256: crypto.createHash('sha256').update(bytes).digest('hex') })).json();
  assert.equal(done.asset.name, 'clip.mp4');
  assert.deepEqual(done.asset.source, { type: 'media-reader', url: 'https://example.org/clip.mp4' });
  const ranged = await app.request(`/media-studio/projects/${project.id}/assets/${done.asset.id}/file`, { headers: { range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-99/${bytes.length}`);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  const img = await (await json('POST', `/media-studio/projects/${project.id}/import-image`, { imageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png' })).json();
  assert.equal(img.asset.kind, 'image');
  assert.equal(img.asset.source.type, 'docteur-image');
  assert.equal((await json('POST', `/media-studio/projects/${project.id}/import-image`, { imageId: '../../secret.png' })).status, 404);
  await json('POST', `/media-studio/projects/${project.id}/edits`, { op: 'add', assetId: done.asset.id });
  const bad = await json('POST', `/media-studio/projects/${project.id}/edits`, { op: 'trim', clipId: 'nope', inMs: 0, outMs: 1 });
  assert.equal(bad.status, 404);
  const { job } = await (await json('POST', `/media-studio/projects/${project.id}/exports`)).json();
  assert.ok(await until(async () => (await (await json('GET', `/media-studio/exports/${job.id}`)).json()).job.status === 'COMPLETED'));
  const dl = await app.request(`/media-studio/exports/${job.id}/file?download=1`);
  assert.equal(dl.headers.get('content-type'), 'video/mp4');
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="export-/);
  assert.equal((await dl.arrayBuffer()).byteLength, fs.statSync(service.exportFile(job.id).file).size);
  // A file removed between stat and read fails that response only — never an uncaught process error.
  const racy = await app.request(`/media-studio/exports/${job.id}/file`);
  fs.rmSync(service.exportFile(job.id).file);
  await assert.rejects(racy.arrayBuffer());
  assert.equal((await app.request(`/media-studio/exports/${job.id}/file`)).status, 404, 'missing export → clear 404');
  assert.equal((await json('GET', '/media-studio/projects/../../etc')).status, 404);
  assert.equal((await json('GET', '/media-studio/projects/not-an-id')).status, 400);
  const empty = await (await json('POST', '/media-studio/projects', { name: 'Vide' })).json();
  const noTimeline = await json('POST', `/media-studio/projects/${empty.project.id}/exports`);
  assert.equal(noTimeline.status, 400);
  assert.equal((await noTimeline.json()).error.code, 'EMPTY_TIMELINE');
});

test('static audit: fixed binaries, argv, shell:false, Root Policy before every spawn, no network', () => {
  const src = fs.readFileSync(path.join(HERE, 'src/lib/media-studio.js'), 'utf8');
  assert.doesNotMatch(src, /shell:\s*true|\bexec\(|execSync|\bfetch\(|require\(['"]https?['"]\)/);
  const spawns = [...src.matchAll(/spawnImpl\((\w+),/g)].map(m => m[1]);
  assert.deepEqual([...new Set(spawns)].sort(), ['bin', 'ffmpegBin'], 'only the two fixed binaries (probe goes through runProcess(ffprobeBin))');
  assert.match(src, /transcodeAllowed\('ffprobe'\); \/\/ Root Policy before any process start\n\s+const out = await runProcess\(spawnImpl, ffprobeBin/);
  assert.match(src, /transcodeAllowed\('ffmpeg'\); \/\/ Root Policy before any process start/);
  assert.match(src, /action: 'MEDIA_TRANSCODE', module: 'media'/);
  for (const m of src.matchAll(/spawnImpl\([^)]*\{([^}]*)\}/g)) assert.match(m[1], /shell: false/);
});
